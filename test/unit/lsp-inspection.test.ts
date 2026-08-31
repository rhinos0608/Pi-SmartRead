import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

describe("lsp-inspection engine", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.clearAllMocks());

  it("1-based line/character translated to 0-based internally", async () => {
    const goToDefinition = vi.fn(async (_p: string, line: number, ch: number) => ({ uri: "file:///a.ts", range: { start: { line, character: ch }, end: { line, character: ch } } }));
    vi.doMock("../../src/lsp-bridge.js", () => ({
      getLSPBridge: vi.fn(async () => ({
        isAvailable: () => true,
        goToDefinition,
        findReferences: vi.fn(async () => []),
        getDocumentSymbols: vi.fn(async () => []),
        goToImplementation: vi.fn(async () => []),
        workspaceSymbol: vi.fn(async () => []),
        hover: vi.fn(async () => null),
        getDiagnostics: vi.fn(async () => []),
        goToDefinitionOutcome: vi.fn(async (p: string, line1: number, ch1: number) => {
          // simulate bridge's own translation: if it receives 1-based, it converts
          goToDefinition(p, line1 - 1, ch1 - 1);
          return { status: "confirmed", location: { uri: "file:///a.ts", range: { start: { line: line1 - 1, character: ch1 - 1 }, end: { line: 0, character: 0 } } } };
        }),
      })),
    }));
    const { inspectNavigation } = await import("../../src/lsp-inspection.js");
    const r = await inspectNavigation({ path: "src/a.ts", operation: "definition", line: 5, character: 10, root: "/" });
    expect(r.status).toBe("confirmed");
    // verify underlying bridge received 0-based conversion path
    expect(goToDefinition).toHaveBeenCalledWith("src/a.ts", 4, 9);
  });

  it("distinguishes unavailable / empty / confirmed / degraded", async () => {
    vi.doMock("../../src/lsp-bridge.js", () => ({
      getLSPBridge: vi.fn(async () => null),
    }));
    const { inspectNavigation: nav1 } = await import("../../src/lsp-inspection.js");
    const unavailable = await nav1({ path: "x.ts", operation: "documentSymbols", root: "/" });
    expect(unavailable.status).toBe("unavailable");
    expect(unavailable.items).toEqual([]);

    vi.resetModules();
    vi.doMock("../../src/lsp-bridge.js", () => ({
      getLSPBridge: vi.fn(async () => ({
        isAvailable: () => true,
        getDocumentSymbols: vi.fn(async () => []),
        getDocumentSymbolsOutcome: vi.fn(async () => ({ status: "empty", symbols: [] })),
      })),
    }));
    const { inspectNavigation: nav2 } = await import("../../src/lsp-inspection.js");
    const empty = await nav2({ path: "x.ts", operation: "documentSymbols", root: "/" });
    expect(empty.status).toBe("empty");
    // empty must not be confirmed — explicit check
    expect(empty.status).not.toBe("confirmed");

    vi.resetModules();
    vi.doMock("../../src/lsp-bridge.js", () => ({
      getLSPBridge: vi.fn(async () => ({
        isAvailable: () => true,
        getDiagnostics: vi.fn(async () => [{ message: "err" }]),
        getFreshDiagnosticsOutcome: vi.fn(async () => ({ status: "confirmed", diagnostics: [{ message: "err" }] })),
      })),
    }));
    const { inspectDiagnostics } = await import("../../src/lsp-inspection.js");
    const confirmed = await inspectDiagnostics({ path: "x.ts", root: "/" });
    expect(confirmed.status).toBe("confirmed");
    expect(confirmed.diagnostics.length).toBe(1);

    vi.resetModules();
    vi.doMock("../../src/lsp-bridge.js", () => ({
      getLSPBridge: vi.fn(async () => ({
        isAvailable: () => true,
        goToDefinitionOutcome: vi.fn(async () => { throw new Error("boom"); }),
      })),
    }));
    const { inspectNavigation: nav3 } = await import("../../src/lsp-inspection.js");
    const degraded = await nav3({ path: "x.ts", operation: "definition", line: 1, character: 1, root: "/" });
    expect(degraded.status).toBe("degraded");
  });

  it("bounds request by timeout and respects AbortSignal", async () => {
    vi.doMock("../../src/lsp-bridge.js", () => ({
      getLSPBridge: vi.fn(async () => ({
        isAvailable: () => true,
        goToDefinitionOutcome: vi.fn(async (_p: string, _l: number, _c: number, _r: string, opts?: any) => {
          // hang until aborted
          await new Promise<void>((_resolve, reject) => {
            opts?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("Aborted"), { name: "AbortError" })), { once: true });
          });
          return { status: "confirmed", location: null };
        }),
      })),
    }));
    const { inspectNavigation } = await import("../../src/lsp-inspection.js");
    const ac = new AbortController();
    const p = inspectNavigation({ path: "x.ts", operation: "definition", line: 1, character: 1, root: "/", timeoutMs: 50, signal: ac.signal });
    setTimeout(() => ac.abort(), 10);
    const r = await p;
    expect(r.status).toBe("degraded");
  });

  it("additive-friendly: unknown status like needs-triage does not throw closed switch", async () => {
    vi.doMock("../../src/lsp-bridge.js", () => ({
      getLSPBridge: vi.fn(async () => ({
        isAvailable: () => true,
        getDocumentSymbolsOutcome: vi.fn(async () => ({ status: "needs-triage", symbols: [{ name: "x" }] })),
      })),
    }));
    const { inspectNavigation } = await import("../../src/lsp-inspection.js");
    const r = await inspectNavigation({ path: "x.ts", operation: "documentSymbols", root: "/" });
    // should propagate unknown status without throwing
    expect(r.status).toBe("needs-triage");
    expect(r.items.length).toBe(1);
  });
});
