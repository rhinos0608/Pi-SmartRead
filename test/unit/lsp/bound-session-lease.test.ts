import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LSPConnection } from "../../../src/lsp/lsp-connection.js";
import { acquireBoundSession, cachedManager, sessionStore, _clearSessionStore, type SessionEntry } from "../../../src/lsp/lsp-manager.js";
import { canonicalProjectRoot } from "../../../src/lsp/lsp-session-key.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  _clearSessionStore();
  vi.restoreAllMocks();
});

function rootFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "bound-lease-"));
  roots.push(root);
  return root;
}

function makeEntry(conn: LSPConnection, root: string): SessionEntry {
  return { conn, fingerprint: "fp", descriptorId: "typescript-server", root, leases: 0, lastUsed: Date.now() };
}

function connection(root: string, key: string): LSPConnection {
  const conn = new LSPConnection();
  Reflect.set(conn, "sessionKey", key);
  conn.descriptorId = "typescript-server";
  conn.name = "TypeScript Server";
  conn.projectRoot = canonicalProjectRoot(root);
  conn.languageIds = ["typescript"];
  vi.spyOn(conn, "getNegotiatedEncoding").mockReturnValue("utf-16");
  vi.spyOn(conn, "shutdown").mockImplementation(() => {});
  return conn;
}

describe("identity-bound manager leases", () => {
  it("uses a mocked manager lookup and real unstarted connections to refuse a key replacement", async () => {
    const root = rootFixture();
    const key = `${canonicalProjectRoot(root)}::typescript-server::session`;
    const returned = connection(root, key);
    const replacement = connection(root, key);
    const oldEntry = { conn: replacement, fingerprint: "replacement", descriptorId: "typescript-server", root: canonicalProjectRoot(root), leases: 7, lastUsed: Date.now() };
    sessionStore.set(key, oldEntry);
    vi.spyOn(cachedManager(root), "getServer").mockResolvedValue(returned);

    const result = await acquireBoundSession(root, "typescript");
    expect(result).toBeNull();
    expect(oldEntry.leases).toBe(7);
    expect(returned.shutdown).not.toHaveBeenCalled();
  });
});

describe("bound lease release behavior", () => {
  it("captures immutable registration and releases independent shared leases without shutting down", async () => {
    const root = rootFixture();
    const key = `${canonicalProjectRoot(root)}::typescript-server::shared`;
    const conn = connection(root, key);
    const entry = { conn, fingerprint: "fp", descriptorId: "typescript-server", root: canonicalProjectRoot(root), leases: 0, lastUsed: Date.now() };
    sessionStore.set(key, entry);
    vi.spyOn(cachedManager(root), "getServer").mockResolvedValue(conn);

    const first = await acquireBoundSession(root, "typescript");
    const second = await acquireBoundSession(root, "typescript");
    expect(entry.leases).toBe(2);
    expect(first).not.toBeNull();
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first!.registration)).toBe(true);
    expect(Object.isFrozen(first!.registration.languageIds)).toBe(true);
    const sourceLanguages = conn.languageIds;
    sourceLanguages.push("python");
    expect(first!.registration.languageIds).toEqual(["typescript"]);
    sourceLanguages.pop();
    expect(Reflect.set(first!.registration.languageIds, "0", "python")).toBe(false);
    expect(first!.registration.languageIds).toEqual(["typescript"]);
    first!.release();
    first!.release();
    expect(entry.leases).toBe(1);
    expect(second!.isCurrent()).toBe(true);
    second!.release();
    expect(entry.leases).toBe(0);
    expect(second!.isCurrent()).toBe(false);
    expect(conn.shutdown).not.toHaveBeenCalled();
  });

  it("release decrements only its captured entry after replacement or removal", async () => {
    const root = rootFixture();
    const key = `${canonicalProjectRoot(root)}::typescript-server::replace`;
    const conn = connection(root, key);
    const original = { conn, fingerprint: "fp", descriptorId: "typescript-server", root: canonicalProjectRoot(root), leases: 3, lastUsed: Date.now() };
    sessionStore.set(key, original);
    vi.spyOn(cachedManager(root), "getServer").mockResolvedValue(conn);
    const lease = await acquireBoundSession(root, "typescript");
    const replacement = { ...original, conn: connection(root, key), leases: 9 };
    sessionStore.set(key, replacement);
    expect(lease!.isCurrent()).toBe(false);
    lease!.release();
    expect(original.leases).toBe(3);
    expect(replacement.leases).toBe(9);
    expect(replacement.conn.shutdown).not.toHaveBeenCalled();

    sessionStore.set(key, original);
    const second = await acquireBoundSession(root, "typescript");
    sessionStore.delete(key);
    second!.release();
    expect(original.leases).toBe(3);
  });
});

describe("bound lease acquisition validation", () => {
  it("rejects missing registrations, keyless connections, and invalid acquisition metadata", async () => {
    const root = rootFixture();
    const canonicalRoot = canonicalProjectRoot(root);
    const mgr = cachedManager(root);
    const getServer = vi.spyOn(mgr, "getServer");
    const keyless = connection(root, "");
    getServer.mockResolvedValueOnce(connection(root, "unregistered"));
    getServer.mockResolvedValueOnce(keyless);
    expect(await acquireBoundSession(root, "typescript")).toBeNull();
    expect(await acquireBoundSession(root, "typescript")).toBeNull();
    expect(keyless.shutdown).not.toHaveBeenCalled();

    const invalids: Array<{ label: string; prepare: (conn: LSPConnection, entry: ReturnType<typeof makeEntry>) => void }> = [
      { label: "empty descriptor", prepare: (conn) => { conn.descriptorId = ""; } },
      { label: "missing descriptor", prepare: (conn) => { conn.descriptorId = undefined; } },
      { label: "empty name", prepare: (conn) => { conn.name = ""; } },
      { label: "missing name", prepare: (conn) => { conn.name = undefined; } },
      { label: "wrong connection root", prepare: (conn) => { conn.projectRoot = `${canonicalRoot}-wrong`; } },
      { label: "wrong entry root", prepare: (_conn, entry) => { entry.root = `${canonicalRoot}-wrong`; } },
      { label: "wrong entry descriptor", prepare: (_conn, entry) => { entry.descriptorId = "other-server"; } },
      { label: "empty fingerprint", prepare: (_conn, entry) => { entry.fingerprint = ""; } },
      { label: "wrong language", prepare: (conn) => { conn.languageIds = ["python"]; } },
      { label: "unsupported encoding", prepare: (conn) => { Reflect.set(conn, "getNegotiatedEncoding", () => "unsupported"); } },
      { label: "non-string key", prepare: (conn) => { Reflect.set(conn, "sessionKey", 42); } },
    ];
    for (const { label, prepare } of invalids) {
      const key = `${canonicalRoot}::typescript-server::${label.replaceAll(" ", "-")}`;
      const conn = connection(root, key);
      const entry = makeEntry(conn, canonicalRoot);
      entry.leases = 4;
      prepare(conn, entry);
      sessionStore.set(key, entry);
      getServer.mockResolvedValueOnce(conn);
      expect(await acquireBoundSession(root, "typescript"), label).toBeNull();
      expect(entry.leases, label).toBe(4);
      expect(conn.shutdown, label).not.toHaveBeenCalled();
      sessionStore.delete(key);
    }

    getServer.mockResolvedValueOnce(null);
    expect(await acquireBoundSession(root, "typescript")).toBeNull();
  });
});

describe("bound lease currentness", () => {
  it("invalidates currentness when connection registration metadata drifts", async () => {
    const root = rootFixture();
    const key = `${canonicalProjectRoot(root)}::typescript-server::drift`;
    const conn = connection(root, key);
    const entry = { conn, fingerprint: "fp", descriptorId: "typescript-server", root: canonicalProjectRoot(root), leases: 0, lastUsed: Date.now() };
    sessionStore.set(key, entry);
    vi.spyOn(cachedManager(root), "getServer").mockResolvedValue(conn);
    const lease = await acquireBoundSession(root, "typescript");
    conn.languageIds = ["python"];
    expect(lease!.isCurrent()).toBe(false);
    conn.languageIds = ["typescript"];
    entry.fingerprint = "changed";
    expect(lease!.isCurrent()).toBe(false);
    entry.fingerprint = "fp";
    vi.mocked(conn.getNegotiatedEncoding).mockReturnValue("utf-8");
    expect(lease!.isCurrent()).toBe(false);
    vi.mocked(conn.getNegotiatedEncoding).mockReturnValue("utf-16");
    conn.projectRoot = `${canonicalProjectRoot(root)}-drift`;
    expect(lease!.isCurrent()).toBe(false);
    conn.projectRoot = canonicalProjectRoot(root);
    conn.descriptorId = "other-server";
    expect(lease!.isCurrent()).toBe(false);
    conn.descriptorId = "typescript-server";
    conn.name = "Other Server";
    expect(lease!.isCurrent()).toBe(false);
    conn.name = "TypeScript Server";
    entry.descriptorId = "other-server";
    expect(lease!.isCurrent()).toBe(false);
    lease!.release();
  });
});
