/**
 * WP-SR5: lazy-start contract — plain inspect with no navigation/diagnostics
 * must never spawn an LSP server. Module load must not spawn either.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let workdir: string;

beforeEach(() => {
  workdir = realpathSync(mkdtempSync(join(tmpdir(), "lsp-lazy-")));
  mkdirSync(workdir, { recursive: true });
  writeFileSync(join(workdir, "hello.ts"), "export const x = 1;\n", "utf8");
  mkdirSync(join(workdir, "src"), { recursive: true });
  writeFileSync(join(workdir, "src", "a.ts"), "export const a = 1;\n", "utf8");
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("WP-SR5 lazy LSP start", () => {
  it("importing lsp-bridge does not call spawn", async () => {
    vi.resetModules();
    const spawnMock = vi.fn((..._args: any[]) => {
      throw new Error("spawn should not be called on import");
    });
    vi.doMock("node:child_process", async () => {
      const actual: any = await vi.importActual("node:child_process");
      return { ...actual, spawn: spawnMock };
    });
    await import("../../src/lsp-bridge.js");
    await new Promise((r) => setTimeout(r, 50));
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("plain file inspect with no navigation/diagnostics does NOT trigger LSP bridge", async () => {
    vi.resetModules();
    const getLSPBridgeMock = vi.fn(async () => {
      throw new Error("getLSPBridge should not be called for plain inspect");
    });
    vi.doMock("../../src/lsp-bridge.js", () => ({
      getLSPBridge: getLSPBridgeMock,
      getProjectLSPInfo: vi.fn(() => ({ supportedLanguages: [], servers: [] })),
      resetLSPBridge: vi.fn(),
    }));
    const { executeInspectV4 } = await import("../../src/inspect.js");
    const result = await executeInspectV4({
      path: "hello.ts",
      cwd: workdir,
      sessionFilePath: "/sessions/abc.jsonl",
    });
    expect(result.mode).toBe("file");
    expect(getLSPBridgeMock).not.toHaveBeenCalled();
  });

  it("plain directory inspect with no navigation/diagnostics does NOT trigger navigation/diagnostics LSP", async () => {
    // Directory plain inspect may still trigger repomap's optional LSP symbol fallback
    // (augmentWithLspSymbols) — that path is out of scope for WP-SR5's eager-block fix.
    // This test proves the WP-SR3 navigation/diagnostics gate is not hit on plain inspect.
    const { createInspectV4Tool } = await import("../../src/inspect-tool.js");
    const provider = {
      inspectNavigation: vi.fn(async () => ({ status: "empty" as const, operation: "documentSymbols" as const, items: [], truncated: false })),
      inspectDiagnostics: vi.fn(async () => ({ status: "empty" as const, diagnostics: [], truncated: false })),
    };
    const tool = createInspectV4Tool({
      getSessionFilePath: () => "/sessions/abc.jsonl",
      lspInspectionProvider: provider as any,
    });
    const ctx = { cwd: workdir, sessionManager: undefined } as any;
    const result: any = await tool.execute("c-plain-dir", { path: "src" } as any, undefined, undefined, ctx);
    expect(result.details.mode).toBe("directory");
    expect(provider.inspectNavigation).not.toHaveBeenCalled();
    expect(provider.inspectDiagnostics).not.toHaveBeenCalled();
  });

  it("inspect with navigation DOES attempt LSP (spawn or bridged)", async () => {
    // This test proves the lazy gate is not over-blocked: navigation still reaches LSP.
    // We provide an injected provider so no real spawn is needed — just verify the provider is called.
    const { createInspectV4Tool } = await import("../../src/inspect-tool.js");
    const provider = {
      inspectNavigation: vi.fn(async () => ({ status: "empty" as const, operation: "documentSymbols" as const, items: [], truncated: false })),
      inspectDiagnostics: vi.fn(async () => ({ status: "empty" as const, diagnostics: [], truncated: false })),
    };
    const tool = createInspectV4Tool({
      getSessionFilePath: () => "/sessions/abc.jsonl",
      lspInspectionProvider: provider as any,
    });
    const ctx = { cwd: workdir, sessionManager: undefined } as any;
    await tool.execute("c-nav", { path: "hello.ts", navigation: { operation: "documentSymbols" } } as any, undefined, undefined, ctx);
    expect(provider.inspectNavigation).toHaveBeenCalledTimes(1);
  });
});
