import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalProjectRoot } from "../../../src/lsp/lsp-session-key.js";
import {
  LSPManager,
  sessionStore,
  managerCache,
  acquireLease,
  releaseLease,
  reapZeroLeaseSessions,
  _clearSessionStore,
  shutdownAllManagers,
  cachedManager,
  evictManagerForRoot,
  isManagerEvictionPending,
} from "../../../src/lsp/lsp-manager.js";

let roots: string[] = [];
beforeEach(() => { _clearSessionStore(); });
afterEach(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); roots = []; _clearSessionStore(); vi.restoreAllMocks(); });

function put(key: string, leases: number, lastUsed: number, root: string, descriptorId = "d"): { shut: ReturnType<typeof vi.fn> } {
  const shut = vi.fn();
  sessionStore.set(key, { conn: { shutdown: shut } as any, fingerprint: `fp-${key}`, descriptorId, root: canonicalProjectRoot(root), leases, lastUsed });
  return { shut };
}

describe("session leases", () => {
  it("lease survival: leased session survives reap, zero-lease idle reaped", () => {
    const root = mkdtempSync(join(tmpdir(), "lsp-lease-")); roots.push(root);
    const now = Date.now();
    const leasedKey = `${canonicalProjectRoot(root)}::d::leased0000000000`;
    const idleKey = `${canonicalProjectRoot(root)}::d::idle000000000000`;
    put(leasedKey, 1, now - 3600_000, root);
    const { shut } = put(idleKey, 0, now - 3600_000, root);
    const reaped = reapZeroLeaseSessions(60_000, now);
    expect(reaped).toContain(idleKey);
    expect(reaped).not.toContain(leasedKey);
    expect(sessionStore.has(leasedKey)).toBe(true);
    expect(sessionStore.has(idleKey)).toBe(false);
    expect(shut).toHaveBeenCalled();
    // release then reap
    releaseLease(leasedKey);
    const reaped2 = reapZeroLeaseSessions(0, Date.now() + 1);
    expect(reaped2).toContain(leasedKey);
  });

  it("zero-lease reap: fresh entries survive, acquire/release counts leases", () => {
    const root = mkdtempSync(join(tmpdir(), "lsp-lease2-")); roots.push(root);
    const key = `${canonicalProjectRoot(root)}::d::fresh000000000000`;
    put(key, 0, Date.now(), root);
    expect(reapZeroLeaseSessions(60_000)).not.toContain(key);
    acquireLease(key);
    expect(sessionStore.get(key)!.leases).toBe(1);
    releaseLease(key);
    expect(sessionStore.get(key)!.leases).toBe(0);
    releaseLease(key);
    expect(sessionStore.get(key)!.leases).toBe(0);
  });

  it("strict requests never reuse a keyless eager connection", async () => {
    const root = mkdtempSync(join(tmpdir(), "lsp-strict-eager-")); roots.push(root);
    const mgr = new LSPManager(root);
    const config = { command: "fake-ts", args: ["--stdio"], languageIds: ["typescript"] };
    (mgr as any).availableConfigs = [config];
    const eager = { closed: false, marker: "eager" };
    const strict = { closed: false, marker: "strict" };
    (mgr as any).connections.set("typescript", eager);
    const startSession = vi.spyOn(mgr as any, "startSession").mockResolvedValue(strict);

    const got = await mgr.getServer("typescript", { allowInstall: false, purpose: "request" } as any);

    expect(got).toBe(strict);
    expect(got).not.toBe(eager);
    expect(startSession).toHaveBeenCalledTimes(1);
  });

  it("strict no-install: allowInstall:false returns null without installer", async () => {
    const root = mkdtempSync(join(tmpdir(), "lsp-noinstall-")); roots.push(root);
    const mgr = new LSPManager(root);
    (mgr as any).availableConfigs = [];
    const conn = await mgr.getServer("python", { allowInstall: false, purpose: "request" } as any);
    expect(conn).toBeNull();
  });

  it("exactly-once retry: dead-connection retries idempotent method once, non-idempotent rethrows", async () => {
    const { withServer } = await import("../../../src/lsp/lsp-server-operation.js");
    const root = mkdtempSync(join(tmpdir(), "lsp-retry-")); roots.push(root);
    cachedManager(root);
    let calls = 0;
    const spy = vi.spyOn(LSPManager.prototype, "getServer").mockImplementation(async () => ({ request: async () => { calls++; throw new Error("LSP server exited"); } }) as any);
    try {
      await expect(withServer("python", root, async (s: any) => s.request("x", {}), { method: "textDocument/hover", timeoutMs: 2000 } as any)).rejects.toThrow("LSP server exited");
      expect(calls).toBe(2);
      calls = 0;
      await expect(withServer("python", root, async (s: any) => s.request("x", {}), { timeoutMs: 2000 } as any)).rejects.toThrow("LSP server exited");
      expect(calls).toBe(1);
      calls = 0;
      await expect(withServer("python", root, async (s: any) => s.request("x", {}), { method: "textDocument/rename", timeoutMs: 2000 } as any)).rejects.toThrow("LSP server exited");
      expect(calls).toBe(1);
    } finally { spy.mockRestore(); }
  });

  it("manager eviction never evicts a leased manager; all-leased refuses eviction", async () => {
    await shutdownAllManagers();
    const leasedRoots: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = mkdtempSync(join(tmpdir(), `lsp-evict-${i}-`)); roots.push(r); leasedRoots.push(r);
      cachedManager(r);
      put(`${canonicalProjectRoot(r)}::d::leased${i}`, 1, Date.now(), r);
    }
    expect(managerCache.size).toBe(5);
    const extra = mkdtempSync(join(tmpdir(), "lsp-evict-extra-")); roots.push(extra);
    cachedManager(extra);
    // No leased victim evicted: all five leased managers survive.
    for (const r of leasedRoots) expect(managerCache.has(r)).toBe(true);
    await shutdownAllManagers();
  });

  it("explicit eviction on a leased manager refuses and defers until leases drain", async () => {
    await shutdownAllManagers();
    const root = mkdtempSync(join(tmpdir(), "lsp-evict-leased-")); roots.push(root);
    const mgr = cachedManager(root);
    const shut = vi.spyOn(mgr, "shutdown");
    const key = `${canonicalProjectRoot(root)}::d::leased-explicit`;
    put(key, 1, Date.now(), root);
    // Refuse: in-flight manager survives, shutdown never called.
    await expect(evictManagerForRoot(root)).resolves.toBe(false);
    expect(managerCache.has(root)).toBe(true);
    expect(shut).not.toHaveBeenCalled();
    expect(isManagerEvictionPending(root)).toBe(true);
    // Lease release runs the deferred eviction: manager gone, no longer pending.
    releaseLease(key);
    await vi.waitFor(() => expect(managerCache.has(root)).toBe(false));
    expect(shut).toHaveBeenCalled();
    expect(isManagerEvictionPending(root)).toBe(false);
    await shutdownAllManagers();
  });
});
