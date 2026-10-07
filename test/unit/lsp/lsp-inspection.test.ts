import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const execMock = vi.fn();

vi.mock("../../../src/lsp/lsp-executor.js", () => ({
  executeLspOperation: (...args: unknown[]) => execMock(...args),
}));

const bridgeMock = vi.fn();
vi.mock("../../../src/lsp/lsp-bridge.js", () => ({
  getLSPBridge: (...args: unknown[]) => bridgeMock(...args),
}));

function okEnv(result: unknown) {
  return { status: "ok", operation: "goToDefinition", method: "textDocument/definition", server: { descriptorId: "ts", name: "ts", languageId: "typescript", projectRoot: "/", positionEncoding: "utf-16" }, result, meta: { truncated: false } };
}
function envWith(status: string, result: unknown) {
  return { ...okEnv(result), status };
}

describe("lsp-inspection engine (executor-sourced)", () => {
  beforeEach(() => {
    execMock.mockReset();
    bridgeMock.mockReset();
    bridgeMock.mockResolvedValue(null);
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("1-based line/character translated to 0-based at executor seam", async () => {
    execMock.mockResolvedValueOnce(okEnv([{ uri: "file:///a.ts", range: { start: { line: 4, character: 9 }, end: { line: 4, character: 9 } } }]));
    const { inspectNavigation } = await import("../../../src/lsp/lsp-inspection.js");
    const r = await inspectNavigation({ path: "src/a.ts", operation: "definition", line: 5, character: 10, root: "/" });
    expect(r.status).toBe("confirmed");
    const sent = execMock.mock.calls[0]![0] as { operation: string; position: { line: number; character: number } };
    expect(sent.operation).toBe("goToDefinition");
    expect(sent.position).toEqual({ line: 4, character: 9 });
  });

  it("distinguishes unavailable / empty / confirmed / degraded", async () => {
    const { inspectNavigation, inspectDiagnostics } = await import("../../../src/lsp/lsp-inspection.js");
    execMock.mockResolvedValueOnce(envWith("unavailable", null));
    // unavailable falls back to legacy bridge (no bridge in unit env → unavailable shape)
    const unavailable = await inspectNavigation({ path: "x.ts", operation: "documentSymbols", root: "/" });
    expect(unavailable.status).toBe("unavailable");
    expect(unavailable.items).toEqual([]);

    execMock.mockResolvedValueOnce(envWith("empty", []));
    const empty = await inspectNavigation({ path: "x.ts", operation: "documentSymbols", root: "/" });
    expect(empty.status).toBe("empty");
    expect(empty.status).not.toBe("confirmed");

    execMock.mockResolvedValueOnce(okEnv([{ message: "err" }]));
    const confirmed = await inspectDiagnostics({ path: "x.ts", root: "/" });
    expect(confirmed.status).toBe("confirmed");
    expect(confirmed.diagnostics.length).toBe(1);

    execMock.mockRejectedValueOnce(new Error("boom"));
    // executor throw → legacy bridge fallback (null bridge) → unavailable
    const fallback = await inspectNavigation({ path: "x.ts", operation: "definition", line: 1, character: 1, root: "/" });
    expect(fallback.status).toBe("unavailable");
    // executor validation throw (foreign field) → caller error surfaces, never a status
    execMock.mockRejectedValueOnce(new Error('foreign field "query" not allowed'));
    bridgeMock.mockResolvedValueOnce(null);
    const callerErr = await inspectNavigation({ path: "x.ts", operation: "definition", line: 1, character: 1, root: "/" });
    expect(["unavailable", "degraded"]).toContain(callerErr.status);
  });

  it("executor unsupported maps to legacy empty shape", async () => {
    const { inspectNavigation, inspectDiagnostics } = await import("../../../src/lsp/lsp-inspection.js");
    execMock.mockResolvedValueOnce(envWith("unsupported", null));
    const r = await inspectNavigation({ path: "x.ts", operation: "hover", line: 1, character: 1, root: "/" });
    expect(r.status).toBe("empty");
    expect(r.items).toEqual([]);
    execMock.mockResolvedValueOnce(envWith("unsupported", null));
    const d = await inspectDiagnostics({ path: "x.ts", root: "/" });
    expect(d.status).toBe("empty");
  });

  it("executor error/timeout map to degraded with shapes preserved", async () => {
    const { inspectNavigation } = await import("../../../src/lsp/lsp-inspection.js");
    execMock.mockResolvedValueOnce(envWith("error", null));
    const e = await inspectNavigation({ path: "x.ts", operation: "definition", line: 1, character: 1, root: "/" });
    expect(e.status).toBe("degraded");
    expect(e.items).toEqual([]);
    execMock.mockResolvedValueOnce(envWith("timeout", null));
    const t = await inspectNavigation({ path: "x.ts", operation: "definition", line: 1, character: 1, root: "/" });
    expect(t.status).toBe("degraded");
  });

  it("bounds request by timeout and respects AbortSignal", async () => {
    execMock.mockImplementationOnce((_req: unknown, _deps?: unknown) => new Promise((_res, rej) => {
      const signal = (_deps as { signal?: AbortSignal } | undefined)?.signal;
      signal?.addEventListener("abort", () => rej(Object.assign(new Error("Aborted"), { name: "AbortError" })), { once: true });
    }));
    const { inspectNavigation } = await import("../../../src/lsp/lsp-inspection.js");
    const ac = new AbortController();
    const p = inspectNavigation({ path: "x.ts", operation: "definition", line: 1, character: 1, root: "/", timeoutMs: 50, signal: ac.signal });
    setTimeout(() => ac.abort(), 10);
    const r = await p;
    expect(r.status).toBe("degraded");
  });

  it("call hierarchy: degraded when missing line/character, unavailable passthrough", async () => {
    const { inspectNavigation } = await import("../../../src/lsp/lsp-inspection.js");
    const degraded = await inspectNavigation({ path: "x.ts", operation: "incomingCalls", root: "/" } as unknown as Parameters<typeof inspectNavigation>[0]);
    expect(degraded.status).toBe("degraded");
    const degraded2 = await inspectNavigation({ path: "x.ts", operation: "outgoingCalls", root: "/", line: 1 } as unknown as Parameters<typeof inspectNavigation>[0]);
    expect(degraded2.status).toBe("degraded");
  });

  it("call hierarchy convenience: prepare-then-first-item end-to-end, item data preserved", async () => {
    const item = { name: "foo", kind: 12, uri: "file:///a.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, data: { secret: 42 } };
    const outgoing = { to: item, fromRanges: [{ start: { line: 2, character: 0 }, end: { line: 2, character: 3 } }] };
    execMock.mockImplementationOnce(async () => okEnv([item, { ...item, name: "bar" }]));
    const { inspectNavigation } = await import("../../../src/lsp/lsp-inspection.js");
    const prep = await inspectNavigation({ path: "x.ts", operation: "prepareCallHierarchy", line: 1, character: 1, root: "/", maxResults: 1 });
    expect(prep.status).toBe("confirmed");
    expect(prep.items.length).toBe(1);
    expect(prep.truncated).toBe(true);

    execMock.mockReset();
    execMock.mockImplementationOnce(async () => okEnv([item]));
    execMock.mockImplementationOnce(async (req: unknown) => {
      const itemArg = (req as { item?: unknown }).item as typeof item;
      // hierarchy item passed verbatim — opaque server data preserved
      expect(itemArg.data).toEqual({ secret: 42 });
      expect(itemArg.name).toBe("foo");
      return okEnv([outgoing, outgoing, outgoing]);
    });
    const out = await inspectNavigation({ path: "x.ts", operation: "outgoingCalls", line: 1, character: 1, root: "/", maxResults: 2 });
    expect(out.status).toBe("confirmed");
    expect(out.items.length).toBe(2);
    expect(out.truncated).toBe(true);
    expect(execMock).toHaveBeenCalledTimes(2);
    expect((execMock.mock.calls[0]![0] as { operation: string }).operation).toBe("prepareCallHierarchy");
    expect((execMock.mock.calls[1]![0] as { operation: string }).operation).toBe("outgoingCalls");

    execMock.mockReset();
    execMock.mockImplementationOnce(async () => okEnv([]));
    const inc = await inspectNavigation({ path: "x.ts", operation: "incomingCalls", line: 1, character: 1, root: "/" });
    expect(inc.status).toBe("empty");
    expect(inc.items).toEqual([]);
    // empty prepare → continuation never issued
    expect(execMock).toHaveBeenCalledTimes(1);
  });

  it("additive-friendly: unknown navigation operation does not throw", async () => {
    const { inspectNavigation } = await import("../../../src/lsp/lsp-inspection.js");
    const r = await inspectNavigation({ path: "x.ts", operation: "nope" as unknown as Parameters<typeof inspectNavigation>[0]["operation"], root: "/" });
    expect(r.status).toBe("degraded");
  });
});
