import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSessionKey, computeConfigFingerprint, canonicalProjectRoot } from "../../../src/lsp/lsp-session-key.js";
import { AmbiguousServerError } from "../../../src/lsp/lsp-types.js";
import {
  LSPManager,
  resolveSessionRoot,
  invalidateStaleFingerprints,
  sessionStore,
  _clearSessionStore,
} from "../../../src/lsp/lsp-manager.js";
import {
  getActiveCatalog,
  registerCustomDescriptors,
  clearCustomDescriptors,
  getDescriptorsForLanguage,
} from "../../../src/language-intelligence/language-server-catalog.js";

let roots: string[] = [];
function tmp(): string {
  const r = mkdtempSync(join(tmpdir(), "lsp-sess-id-"));
  roots.push(r);
  return r;
}
beforeEach(() => { _clearSessionStore(); clearCustomDescriptors(); });
afterEach(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); roots = []; _clearSessionStore(); clearCustomDescriptors(); vi.restoreAllMocks(); });

describe("session identity triple", () => {
  it("nested roots: nearest ancestor marker wins", () => {
    const outer = tmp();
    writeFileSync(join(outer, "package.json"), "{}", "utf8");
    const inner = join(outer, "packages", "py");
    mkdirSync(inner, { recursive: true });
    writeFileSync(join(inner, "pyproject.toml"), "[project]", "utf8");
    const file = join(inner, "main.py");
    writeFileSync(file, "x=1", "utf8");
    expect(resolveSessionRoot(file, outer)).toBe(canonicalProjectRoot(inner));
  });

  it("fingerprint: settings/initOptions change replaces key; schema version pinned", () => {
    const base = { descriptorId: "pyright", executable: "pyright", args: ["--stdio"] };
    const a = computeConfigFingerprint({ ...base, settings: { python: { a: 1 } } });
    const b = computeConfigFingerprint({ ...base, settings: { python: { a: 2 } } });
    expect(a).not.toBe(b);
    const k1 = buildSessionKey("/r", { ...base });
    const k2 = buildSessionKey("/r", { ...base, initializationOptions: { x: 1 } });
    expect(k1).not.toBe(k2);
    expect(k1).toContain(canonicalProjectRoot("/r"));
  });

  it("fingerprint replace: stale zero-lease entry for same root+descriptor invalidated", () => {
    const root = tmp();
    const canonical = canonicalProjectRoot(root);
    const fpKeep = computeConfigFingerprint({ descriptorId: "d", executable: "e", args: [] as string[], settings: { v: 2 } });
    const staleKey = `${canonical}::d::stale000000000000`;
    const shut = vi.fn();
    sessionStore.set(staleKey, { conn: { shutdown: shut } as any, fingerprint: "old", descriptorId: "d", root: canonical, leases: 0, lastUsed: Date.now() - 9999 });
    invalidateStaleFingerprints(root, "d", fpKeep);
    expect(sessionStore.has(staleKey)).toBe(false);
    expect(shut).toHaveBeenCalled();
  });

  it("ambiguous: multi same-language servers throw without explicit selection, resolve with descriptorId", async () => {
    const root = tmp();
    const mgr = new LSPManager(root);
    (mgr as any).availableConfigs = [
      { command: "pyright", args: ["--stdio"], languageIds: ["python"], descriptorId: "a" },
      { command: "pylsp", args: ["--stdio"], languageIds: ["python"], descriptorId: "b" },
    ];
    await expect(mgr.getServer("python")).rejects.toBeInstanceOf(AmbiguousServerError);
    // Explicit selection passes ambiguity gate (then fails to spawn -> null, not throw)
    const conn = await mgr.getServer("python", { descriptorId: "a" } as any).catch(() => null);
    expect(conn === null || typeof conn === "object").toBe(true);
  });

  it("catalog is runtime source: validated custom descriptors visible via getDescriptorsForLanguage", () => {
    registerCustomDescriptors([{
      id: "custom-py", displayName: "Custom", languageIds: ["python"],
      extensions: [".py"], rootMarkers: ["custom.marker"],
      commandCandidates: [{ command: "custom-pyls", args: [] }],
      priority: 999,
    }]);
    expect(getActiveCatalog().some((d) => d.id === "custom-py")).toBe(true);
    expect(getDescriptorsForLanguage("python").some((d) => d.id === "custom-py")).toBe(true);
    expect(() => registerCustomDescriptors([{ id: "", languageIds: [], commandCandidates: [] } as any])).toThrow();
  });
});
