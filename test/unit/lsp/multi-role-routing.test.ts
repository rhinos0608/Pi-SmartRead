import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LSPManager,
  _clearSessionStore,
} from "../../../src/lsp/lsp-manager.js";
import { AmbiguousServerError } from "../../../src/lsp/lsp-types.js";
import {
  registerCustomDescriptors,
  clearCustomDescriptors,
} from "../../../src/language-intelligence/language-server-catalog.js";
import { resolveLanguageServer, resolveAllLanguageServers } from "../../../src/language-intelligence/language-intelligence-runtime.js";
import { resetLanguageIntelligenceCaches as resetConfigCaches } from "../../../src/language-intelligence/language-intelligence-config.js";

let roots: string[] = [];
function tmp(prefix: string): string {
  const r = mkdtempSync(join(tmpdir(), prefix));
  roots.push(r);
  return r;
}

function twoRoleConfigs() {
  return [
    { command: "fake-semantic", args: ["--stdio"], languageIds: ["python"], descriptorId: "py-semantic", role: "semantic" },
    { command: "fake-linter", args: ["--stdio"], languageIds: ["python"], descriptorId: "py-linter", role: "linter" },
  ];
}

beforeEach(() => { _clearSessionStore(); clearCustomDescriptors(); resetConfigCaches(); });
afterEach(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots = [];
  _clearSessionStore();
  clearCustomDescriptors();
  resetConfigCaches();
  vi.restoreAllMocks();
});

describe("R5 multi-role routing", () => {
  it("ambiguous: two same-language role-tagged configs throw without explicit selection", async () => {
    const root = tmp("lsp-roles-");
    const mgr = new LSPManager(root);
    (mgr as any).availableConfigs = twoRoleConfigs();
    await expect(mgr.getServer("python")).rejects.toBeInstanceOf(AmbiguousServerError);
  });

  it("exact selection: role picks the matching config (semantic vs linter)", async () => {
    const root = tmp("lsp-roles-exact-");
    const mgr = new LSPManager(root);
    (mgr as any).availableConfigs = twoRoleConfigs();
    const seen: string[] = [];
    vi.spyOn(mgr as any, "startSession").mockImplementation(async (...args: any[]) => {
      const cfg = args[1];
      seen.push(cfg.descriptorId);
      return { marker: cfg.descriptorId, closed: false };
    });
    const sem = await mgr.getServer("python", { role: "semantic" } as any);
    const lin = await mgr.getServer("python", { role: "linter" } as any);
    expect((sem as any).marker).toBe("py-semantic");
    expect((lin as any).marker).toBe("py-linter");
    expect(sem).not.toBe(lin);
    expect(seen).toEqual(["py-semantic", "py-linter"]);
  });

  it("exact selection: descriptorId still selects the exact server", async () => {
    const root = tmp("lsp-roles-desc-");
    const mgr = new LSPManager(root);
    (mgr as any).availableConfigs = twoRoleConfigs();
    vi.spyOn(mgr as any, "startSession").mockImplementation(async (...args: any[]) => ({ marker: (args[1] as any).descriptorId, closed: false }));
    const conn = await mgr.getServer("python", { descriptorId: "py-linter" } as any);
    expect((conn as any).marker).toBe("py-linter");
  });

  it("session separation: role selections map to distinct session keys", () => {
    const root = tmp("lsp-roles-keys-");
    const mgr = new LSPManager(root);
    const kSem = (mgr as any).sessionLangKey("python", { role: "semantic" });
    const kLin = (mgr as any).sessionLangKey("python", { role: "linter" });
    expect(kSem).not.toBe(kLin);
    expect(kSem).toContain("semantic");
    expect(kLin).toContain("linter");
  });

  it("ambiguous within one role: two descriptors sharing a role throw on role selection", async () => {
    const root = tmp("lsp-roles-samerole-");
    const mgr = new LSPManager(root);
    (mgr as any).availableConfigs = [
      { command: "fake-sem-a", args: ["--stdio"], languageIds: ["python"], descriptorId: "py-sem-a", role: "semantic" },
      { command: "fake-sem-b", args: ["--stdio"], languageIds: ["python"], descriptorId: "py-sem-b", role: "semantic" },
      { command: "fake-linter", args: ["--stdio"], languageIds: ["python"], descriptorId: "py-linter", role: "linter" },
    ];
    // No silent first-match fallback inside the role: still ambiguous.
    await expect(mgr.getServer("python", { role: "semantic" } as any)).rejects.toBeInstanceOf(AmbiguousServerError);
    // Exact descriptorId within the role resolves.
    vi.spyOn(mgr as any, "startSession").mockImplementation(async (...args: any[]) => ({ marker: (args[1] as any).descriptorId, closed: false }));
    const conn = await mgr.getServer("python", { role: "semantic", descriptorId: "py-sem-b" } as any);
    expect((conn as any).marker).toBe("py-sem-b");
  });

  it("resolver preserves descriptor role metadata into the resolution result", () => {
    const home = tmp("pi-li-home-");
    const cwd = tmp("pi-li-cwd-");
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    registerCustomDescriptors([{
      id: "custom-semantic-py",
      displayName: "Custom Semantic",
      languageIds: ["python"],
      extensions: [".py"],
      rootMarkers: ["custom.marker"],
      commandCandidates: [{ command: "custom-semantic-pyls", args: ["--stdio"] }],
      priority: 999,
      roles: ["semantic"],
    }]);
    const file = join(cwd, "a.py");
    writeFileSync(file, "x=1");
    const res = resolveLanguageServer(file, cwd, {
      homedir: home,
      checkExecutable: (c) => c === "custom-semantic-pyls",
    });
    expect(res.status).toBe("available");
    if (res.status === "available") {
      expect(res.descriptorId).toBe("custom-semantic-py");
      expect(res.role).toBe("semantic");
    }
  });

  it("resolver\u2192manager: resolveAll preserves both roles and setup routes role:linter", async () => {
    const root = tmp("lsp-roles-e2e-");
    writeFileSync(join(root, "pyproject.toml"), "[project]\nname=\"e2e\"\n");
    const file = join(root, "a.py");
    writeFileSync(file, "x=1");
    registerCustomDescriptors([
      {
        id: "e2e-semantic-py",
        displayName: "E2E Semantic",
        languageIds: ["python"],
        extensions: [".py"],
        rootMarkers: ["pyproject.toml"],
        commandCandidates: [{ command: "e2e-sem-py", args: ["--stdio"] }],
        priority: 999,
        roles: ["semantic"],
      },
      {
        id: "e2e-linter-py",
        displayName: "E2E Linter",
        languageIds: ["python"],
        extensions: [".py"],
        rootMarkers: ["pyproject.toml"],
        commandCandidates: [{ command: "e2e-lint-py", args: ["--stdio"] }],
        priority: 998,
        roles: ["linter"],
      },
    ]);
    // Fake both binaries on PATH so the REAL resolver\u2192cache\u2192setup path
    // runs (no manual cache seeding, no availableConfigs override).
    const binDir = tmp("lsp-roles-bin-");
    for (const bin of ["e2e-sem-py", "e2e-lint-py"]) {
      writeFileSync(join(binDir, bin), "#!/bin/sh\nexit 0\n");
      try { (await import("node:fs")).chmodSync(join(binDir, bin), 0o755); } catch {}
    }
    const origPath = process.env.PATH ?? "";
    process.env.PATH = `${binDir}${(await import("node:path")).delimiter}${origPath}`;
    const { resolvedServerCache, resolvedServerListCache } = await import("../../../src/lsp/lsp-types.js");
    for (const k of [...resolvedServerCache.keys()]) if (k.startsWith(`${root}:`)) resolvedServerCache.delete(k);
    for (const k of [...resolvedServerListCache.keys()]) if (k.startsWith(`${root}:`)) resolvedServerListCache.delete(k);
    try {
      // Resolver preserves every eligible role-tagged descriptor (not first-match).
      const all = resolveAllLanguageServers(file, root);
      expect(all.map((r) => r.descriptorId).sort()).toEqual(["e2e-linter-py", "e2e-semantic-py"]);
      expect(all.map((r) => r.role).sort()).toEqual(["linter", "semantic"]);
      // Single-result contract still serves the first (priority order).
      const one = resolveLanguageServer(file, root);
      expect(one.status).toBe("available");
      if (one.status === "available") expect(one.descriptorId).toBe(all[0]!.descriptorId);
      // Real manager setup path: constructor re-resolves via PATH, populates
      // the list cache, and builds one config per role.
      const mgr = new LSPManager(root);
      const pyConfigs = mgr.getAvailableConfigs().filter((c: any) => c.languageIds.includes("python"));
      expect(pyConfigs.map((c: any) => c.descriptorId).sort()).toEqual(["e2e-linter-py", "e2e-semantic-py"]);
      expect(pyConfigs.map((c: any) => c.role).sort()).toEqual(["linter", "semantic"]);
      vi.spyOn(mgr as any, "startSession").mockImplementation(async (...args: any[]) => ({ marker: (args[1] as any).descriptorId, closed: false }));
      const conn = await mgr.getServer("python", { role: "linter" } as any);
      expect((conn as any).marker).toBe("e2e-linter-py");
    } finally {
      process.env.PATH = origPath;
      for (const k of [...resolvedServerCache.keys()]) if (k.startsWith(`${root}:`)) resolvedServerCache.delete(k);
      for (const k of [...resolvedServerListCache.keys()]) if (k.startsWith(`${root}:`)) resolvedServerListCache.delete(k);
    }
  });
});
