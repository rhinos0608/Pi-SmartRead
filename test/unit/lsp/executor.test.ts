import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { cachedManager, evictManagerForRoot, sessionStore } from "../../../src/lsp/lsp-manager.js";
import { canonicalProjectRoot } from "../../../src/lsp/lsp-session-key.js";
import { executeLspOperation, type ExecutorConnection } from "../../../src/lsp/lsp-executor.js";
import { LspAffinity } from "../../../src/lsp/lsp-affinity.js";
import { LspCursorStore } from "../../../src/lsp/lsp-cursor-store.js";
import { AmbiguousServerError } from "../../../src/lsp/lsp-types.js";
import { LspServerExitError } from "../../../src/lsp/lsp-connection.js";
import { sha256OfText } from "../../../src/lsp/lsp-document-store.js";

function conn(over: Partial<ExecutorConnection> & { requestImpl?: (m: string, p: unknown) => Promise<unknown> } = {}): ExecutorConnection {
  const { requestImpl, ...rest } = over;
  // Production shape: real LSPConnection exposes plural languageIds; keep
  // singular for back-compat and derive plural when not overridden.
  const languageId = (rest as { languageId?: string }).languageId ?? "typescript";
  const languageIds = (rest as { languageIds?: string[] }).languageIds ?? [languageId];
  return {
    descriptorId: "ts",
    name: "ts-server",
    languageId,
    languageIds,
    projectRoot: "/repo",
    getNegotiatedEncoding: () => "utf-16",
    prepareDocument: async () => {},
    request: (m, p) => (requestImpl ? requestImpl(m, p) : Promise.resolve(null)),
    ...rest,
  };
}
function mgr(c: ExecutorConnection | null | Error) {
  return {
    getServer: async () => {
      if (c instanceof Error) throw c;
      return c;
    },
  };
}
const ROOT = "/repo";

// Live-session helper for explicit-server pathless routing (server-direct
// lookup scans sessionStore; keys are test-namespaced and cleaned up).
const testSessionKeys: string[] = [];
function liveSession(descriptorId: string, c: ExecutorConnection): string {
  const key = `test::${descriptorId}::${testSessionKeys.length}`;
  sessionStore.set(key, { conn: c as never, fingerprint: "test", descriptorId, root: canonicalProjectRoot(ROOT), leases: 0, lastUsed: Date.now() });
  testSessionKeys.push(key);
  return key;
}
afterEach(() => {
  for (const k of testSessionKeys.splice(0)) sessionStore.delete(k);
});

describe("executor", () => {
  it("validation throw: unknown op", async () => {
    await expect(executeLspOperation({ operation: "nope" }, { cwd: ROOT })).rejects.toThrow(/unknown operation/);
  });
  it("validation throw: foreign field", async () => {
    await expect(executeLspOperation({ operation: "hover", path: "a.ts", position: { line: 0, character: 0 }, query: "x" }, { cwd: ROOT })).rejects.toThrow(/foreign field/);
  });
  it("validation throw: missing required", async () => {
    await expect(executeLspOperation({ operation: "hover", path: "a.ts" }, { cwd: ROOT })).rejects.toThrow(/requires field/);
  });
  it("validation throw: request without method", async () => {
    await expect(executeLspOperation({ operation: "request" }, { cwd: ROOT })).rejects.toThrow(/requires field/);
  });
  it("unsupported vs empty: capability absent -> unsupported", async () => {
    const c = conn({ getCapabilityRegistry: () => ({ can: () => false }) });
    const env = await executeLspOperation({ operation: "hover", path: "a.ts", position: { line: 0, character: 0 } }, { getManager: () => mgr(c), cwd: ROOT });
    expect(env.status).toBe("unsupported");
    expect(env.result).toBeNull();
  });
  it("empty: supported but null -> empty", async () => {
    const c = conn({ getCapabilityRegistry: () => ({ can: () => true }), requestImpl: async () => null });
    const env = await executeLspOperation({ operation: "hover", path: "a.ts", position: { line: 0, character: 0 } }, { getManager: () => mgr(c), cwd: ROOT });
    expect(env.status).toBe("empty");
  });
  it("ok: locations returned", async () => {
    const c = conn({
      getCapabilityRegistry: () => ({ can: () => true }),
      requestImpl: async () => [{ uri: "file:///a.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }],
    });
    const env = await executeLspOperation({ operation: "goToDefinition", path: "a.ts", position: { line: 0, character: 0 } }, { getManager: () => mgr(c), cwd: ROOT });
    expect(env.status).toBe("ok");
    expect((env.result as unknown[]).length).toBe(1);
    expect(env.server.descriptorId).toBe("ts");
    expect(env.server.positionEncoding).toBe("utf-16");
  });
  it("relative paths resolve against the request workspace before prepare/issue", async () => {
    let preparedPath = "";
    let requestUri = "";
    const c = conn({
      getCapabilityRegistry: () => ({ can: () => true }),
      prepareDocument: async (p) => { preparedPath = p; },
      requestImpl: async (_m, p) => {
        requestUri = ((p as { textDocument: { uri: string } }).textDocument.uri);
        return { contents: "x" };
      },
    });
    const workspace = join(tmpdir(), "lsp-executor-workspace");
    const env = await executeLspOperation(
      { operation: "hover", path: "src/a.ts", position: { line: 0, character: 0 }, workspace },
      { getManager: () => mgr(c), cwd: "/" },
    );
    expect(env.status).toBe("ok");
    expect(preparedPath).toBe(join(workspace, "src", "a.ts"));
    expect(requestUri).toBe(pathToFileURL(join(workspace, "src", "a.ts")).href);
  });

  it("path result metadata reports fresh vs stale synchronized content", async () => {
    const root = mkdtempSync(join(tmpdir(), "lsp-executor-fresh-"));
    const file = join(root, "a.ts");
    const original = "const x = 1;\n";
    writeFileSync(file, original, "utf-8");
    const state = { version: 7, lastHash: sha256OfText(original) };
    let makeStale = false;
    const c = conn({
      getCapabilityRegistry: () => ({ can: () => true }),
      getDocumentStore: () => ({ get: () => state }),
      requestImpl: async () => {
        if (makeStale) writeFileSync(file, "const x = 2;\n", "utf-8");
        return [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "" }];
      },
    });
    try {
      const fresh = await executeLspOperation(
        { operation: "formatDocument", path: file, workspace: root },
        { getManager: () => mgr(c), cwd: root },
      );
      expect(fresh.status).toBe("ok");
      expect(fresh.meta.documentVersion).toBe(7);
      expect(fresh.meta.freshness).toEqual({ state: "fresh", documentVersion: 7 });

      makeStale = true;
      const stale = await executeLspOperation(
        { operation: "formatDocument", path: file, workspace: root },
        { getManager: () => mgr(c), cwd: root },
      );
      expect(stale.status).toBe("ok");
      expect(stale.meta.freshness?.state).toBe("stale");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ambiguous: multi-candidate", async () => {
    const env = await executeLspOperation({ operation: "hover", path: "a.ts", position: { line: 0, character: 0 } }, { getManager: () => mgr(new AmbiguousServerError("typescript", ["a", "b"])), cwd: ROOT });
    expect(env.status).toBe("ambiguous");
    expect(env.error?.code).toBe("ambiguous");
  });
  it("unavailable: no session", async () => {
    const env = await executeLspOperation({ operation: "hover", path: "a.ts", position: { line: 0, character: 0 } }, { getManager: () => mgr(null), cwd: ROOT });
    expect(env.status).toBe("unavailable");
  });
  it("production default acquisition uses the real leased manager seam", async () => {
    const c = conn({
      descriptorId: "prod-ts",
      getCapabilityRegistry: () => ({ can: () => true }),
      requestImpl: async () => ({ contents: "production hover" }),
    });
    const key = `${canonicalProjectRoot(ROOT)}::prod-ts::test-fingerprint`;
    (c as unknown as { sessionKey: string }).sessionKey = key;
    sessionStore.set(key, {
      conn: c as never,
      fingerprint: "test-fingerprint",
      descriptorId: "prod-ts",
      root: canonicalProjectRoot(ROOT),
      leases: 0,
      lastUsed: Date.now(),
    });
    // Executor resolves cwd before cachedManager; use the same spelling or the
    // spy lands on a different manager (drive-letter root on Windows).
    const manager = cachedManager(resolve(ROOT));
    const getServer = vi.spyOn(manager, "getServer").mockResolvedValue(c as never);

    try {
      const env = await executeLspOperation(
        { operation: "hover", path: "a.ts", position: { line: 0, character: 0 } },
        { cwd: ROOT },
      );
      expect(env.status).toBe("ok");
      expect(getServer).toHaveBeenCalledWith(
        "typescript",
        expect.objectContaining({ allowInstall: false, purpose: "request" }),
      );
      expect(sessionStore.get(key)?.leases).toBe(0);
    } finally {
      getServer.mockRestore();
      sessionStore.delete(key);
      await evictManagerForRoot(resolve(ROOT));
    }
  });

  it("unavailable passes allowInstall:false", async () => {
    const getServer = vi.fn(async () => null);
    await executeLspOperation({ operation: "hover", path: "a.ts", position: { line: 0, character: 0 } }, { getManager: () => ({ getServer }), cwd: ROOT });
    expect(getServer).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ allowInstall: false, purpose: "request" }));
  });
  it("explicit server selection forwarded", async () => {
    const getServer = vi.fn(async () => null);
    await executeLspOperation({ operation: "hover", path: "a.ts", position: { line: 0, character: 0 }, server: "pyright" }, { getManager: () => ({ getServer }), cwd: ROOT });
    expect(getServer).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ descriptorId: "pyright" }));
  });
  it("timeout: slow request", async () => {
    const c = conn({ getCapabilityRegistry: () => ({ can: () => true }), requestImpl: async () => new Promise(() => {}) });
    const env = await executeLspOperation({ operation: "hover", path: "a.ts", position: { line: 0, character: 0 }, timeoutMs: 20 }, { getManager: () => mgr(c), cwd: ROOT });
    expect(env.status).toBe("timeout");
  });
  it("timeout aborts the underlying LSP request", async () => {
    let observedAbort = false;
    const c = conn({
      getCapabilityRegistry: () => ({ can: () => true }),
      request: async (_m, _p, opts) => new Promise((_, reject) => {
        opts?.signal?.addEventListener("abort", () => {
          observedAbort = true;
          reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
        }, { once: true });
      }),
    });
    const env = await executeLspOperation(
      { operation: "hover", path: "a.ts", position: { line: 0, character: 0 }, timeoutMs: 20 },
      { getManager: () => mgr(c), cwd: ROOT },
    );
    expect(env.status).toBe("timeout");
    expect(observedAbort).toBe(true);
  });

  it("cancelled: pre-aborted signal wins", async () => {
    const ctl = new AbortController();
    ctl.abort();
    const c = conn({ getCapabilityRegistry: () => ({ can: () => true }), requestImpl: async () => [{ uri: "file:///a.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }] });
    const env = await executeLspOperation({ operation: "hover", path: "a.ts", position: { line: 0, character: 0 } }, { getManager: () => mgr(c), cwd: ROOT, signal: ctl.signal });
    expect(env.status).toBe("cancelled");
  });
  it("cancelled: pre-aborted with explicit server keeps unknown provenance", async () => {
    const ctl = new AbortController();
    ctl.abort();
    const getServer = vi.fn(async () => null);
    const env = await executeLspOperation({ operation: "hover", path: "a.ts", position: { line: 0, character: 0 }, server: "pyright" }, { getManager: () => ({ getServer }), cwd: ROOT, signal: ctl.signal });
    expect(env.status).toBe("cancelled");
    expect(env.server.descriptorId).toBe("unknown");
    expect(env.server.name).toBe("unknown");
    expect(getServer).not.toHaveBeenCalled();
  });
  it("cancelled: abort during request", async () => {
    const ctl = new AbortController();
    const c = conn({
      getCapabilityRegistry: () => ({ can: () => true }),
      request: async (_m, _p, o) => new Promise((_, rej) => {
        o?.signal?.addEventListener("abort", () => rej(Object.assign(new Error("Aborted"), { name: "AbortError" })));
      }),
    });
    setTimeout(() => ctl.abort(), 10);
    const env = await executeLspOperation({ operation: "hover", path: "a.ts", position: { line: 0, character: 0 }, timeoutMs: 2000 }, { getManager: () => mgr(c), cwd: ROOT, signal: ctl.signal });
    expect(env.status).toBe("cancelled");
  });
  it("retry-once on crash for idempotent read", async () => {
    let n = 0;
    const dead = conn({
      descriptorId: "dead",
      getCapabilityRegistry: () => ({ can: () => true }),
      requestImpl: async () => {
        n++;
        throw Object.assign(new Error("LSP server exited"), { name: "LspServerExitError" });
      },
    });
    const live = conn({
      descriptorId: "live",
      getCapabilityRegistry: () => ({ can: () => true }),
      requestImpl: async () => {
        n++;
        return [{ uri: "file:///a.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }];
      },
    });
    let acquisitions = 0;
    const getServer = vi.fn(async () => {
      acquisitions++;
      return acquisitions === 1 ? dead : live;
    });
    const released: unknown[] = [];
    const env = await executeLspOperation({ operation: "goToDefinition", path: "a.ts", position: { line: 0, character: 0 } }, {
      getManager: () => ({ getServer }),
      cwd: ROOT,
      acquire: async () => {
        const c = await getServer();
        return { conn: c, key: `k${acquisitions}` };
      },
      release: (k: string | null) => { released.push(k); },
    });
    expect(env.status).toBe("ok");
    expect(n).toBe(2);
    // Reacquisition proven: dead lease released, fresh session acquired.
    expect(acquisitions).toBe(2);
    expect(released).toContain("k1");
    expect(env.server.descriptorId).toBe("live");
  });
  it("retry escape: second-attempt transport error becomes error envelope", async () => {
    const dead = conn({
      getCapabilityRegistry: () => ({ can: () => true }),
      requestImpl: async () => { throw Object.assign(new Error("LSP server exited"), { name: "LspServerExitError" }); },
    });
    const broken = conn({
      getCapabilityRegistry: () => ({ can: () => true }),
      requestImpl: async () => { throw new Error("boom-wire"); },
    });
    let acquisitions = 0;
    const getServer = async () => {
      acquisitions++;
      return acquisitions === 1 ? dead : broken;
    };
    const env = await executeLspOperation({ operation: "goToDefinition", path: "a.ts", position: { line: 0, character: 0 } }, {
      getManager: () => ({ getServer }),
      cwd: ROOT,
      acquire: async () => ({ conn: await getServer(), key: `k${acquisitions}` }),
      release: () => {},
    });
    expect(env.status).toBe("error");
    expect(env.error?.message).toMatch(/boom-wire/);
  });
  it("no-retry for rename (non-idempotent)", async () => {
    let n = 0;
    const c = conn({
      getCapabilityRegistry: () => ({ can: () => true }),
      requestImpl: async () => {
        n++;
        throw Object.assign(new Error("LSP server exited"), { name: "LspServerExitError" });
      },
    });
    const env = await executeLspOperation({ operation: "rename", path: "a.ts", position: { line: 0, character: 0 }, newName: "b" }, { getManager: () => mgr(c), cwd: ROOT });
    expect(env.status).toBe("error");
    expect(n).toBe(1);
  });
  it("hintless pathless request is unavailable", async () => {
    const env = await executeLspOperation({ operation: "request", method: "textDocument/hover", params: {} }, { getManager: () => mgr(null), cwd: ROOT });
    expect(env.status).toBe("unavailable");
    expect(env.server.descriptorId).toBe("unknown");
  });
  it("raw request rejects non-JSON params through the canonical policy", async () => {
    const params: Record<string, unknown> = {};
    params.self = params;
    await expect(executeLspOperation(
      { operation: "request", method: "textDocument/hover", params },
      { cwd: ROOT },
    )).rejects.toThrow(/params-not-json/);
  });

  it("no-retry for raw request even on crash", async () => {
    let n = 0;
    const c = conn({
      descriptorId: "raw-ts",
      requestImpl: async () => {
        n++;
        throw Object.assign(new Error("LSP server exited"), { name: "LspServerExitError" });
      },
    });
    liveSession("raw-ts", c);
    const env = await executeLspOperation({ operation: "request", method: "textDocument/hover", params: {}, server: "raw-ts" }, { getManager: () => mgr(null), cwd: ROOT });
    expect(env.status).toBe("error");
    expect(n).toBe(1);
  });
  it("hierarchy passthrough: exact item + data preserved, no re-prepare", async () => {
    const prep = vi.fn(async () => {});
    const item = { name: "f", kind: 12, uri: "file:///a.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, data: { secret: 42 } };
    let seenParams: unknown = null;
    const c = conn({
      prepareDocument: prep,
      getCapabilityRegistry: () => ({ can: () => true }),
      requestImpl: async (_m, p) => {
        seenParams = p;
        return [{ from: item, fromRanges: [{ start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }] }];
      },
    });
    // Advisory item.uri routing reuses a live session only: register it.
    liveSession("ts", c);
    const env = await executeLspOperation({ operation: "incomingCalls", item }, { getManager: () => mgr(null), cwd: ROOT });
    expect(env.status).toBe("ok");
    expect(prep).not.toHaveBeenCalled();
    expect((seenParams as { item: typeof item }).item).toBe(item);
    expect((env.result as Array<{ from: { data: unknown } }>)[0]?.from.data).toEqual({ secret: 42 });
  });
  it("raw allow: observational method issues", async () => {
    const c = conn({ descriptorId: "raw-ts", requestImpl: async () => ({ x: 1 }) });
    liveSession("raw-ts", c);
    const env = await executeLspOperation({ operation: "request", method: "textDocument/hover", params: {}, server: "raw-ts" }, { getManager: () => mgr(null), cwd: ROOT });
    expect(env.status).toBe("ok");
    expect(env.result).toEqual({ x: 1 });
  });
  it("raw deny: executeCommand throws caller error", async () => {
    const c = conn({});
    await expect(executeLspOperation({ operation: "request", method: "workspace/executeCommand", params: {} }, { getManager: () => mgr(c), cwd: ROOT })).rejects.toThrow(/not allowed/);
  });
  it("raw deny: unknown custom method throws", async () => {
    const c = conn({});
    await expect(executeLspOperation({ operation: "request", method: "custom/mutate", params: {} }, { getManager: () => mgr(c), cwd: ROOT })).rejects.toThrow(/not allowed/);
  });
  it("codeActions always supplies the protocol-required diagnostics array", async () => {
    let seen: unknown = null;
    const c = conn({
      getCapabilityRegistry: () => ({ can: () => true }),
      requestImpl: async (_m, p) => {
        seen = p;
        return [];
      },
    });
    const env = await executeLspOperation(
      {
        operation: "codeActions",
        path: "a.ts",
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        context: { only: ["source.organizeImports"] },
      },
      { getManager: () => mgr(c), cwd: ROOT },
    );
    expect(env.status).toBe("empty");
    expect((seen as { context: unknown }).context).toEqual({
      diagnostics: [],
      only: ["source.organizeImports"],
    });
  });

  it("capabilityExact=false issues without gate", async () => {
    const c = conn({
      getCapabilityRegistry: () => ({ can: () => false }),
      requestImpl: async () => [{ uri: "file:///a.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }],
    });
    const env = await executeLspOperation({ operation: "documentHighlights", path: "a.ts", position: { line: 0, character: 0 } }, { getManager: () => mgr(c), cwd: ROOT });
    expect(env.status).toBe("ok");
  });
  it("not_ready: prepareDocument missing state", async () => {
    const c = conn({
      getCapabilityRegistry: () => ({ can: () => true }),
      prepareDocument: async () => { throw Object.assign(new Error("document not prepared"), { code: "NOT_READY" }); },
    });
    const env = await executeLspOperation({ operation: "hover", path: "a.ts", position: { line: 0, character: 0 } }, { getManager: () => mgr(c), cwd: ROOT });
    expect(env.status).toBe("not_ready");
  });
  it("diagnostics: source/readiness in meta", async () => {
    const c = conn({
      getCapabilityRegistry: () => ({ can: () => true }),
      getDiagnosticsBroker: () => ({
        pullDocument: async () => ({ source: "pull", diagnostics: [{ message: "e" }], receipt: null, resultId: "r1", version: null, confirmed: true }),
        readPush: () => ({ source: "push", diagnostics: [], receipt: null, resultId: null, version: null, confirmed: false }),
      }),
      readiness: () => ({ state: "settling", basis: "progress" }),
    });
    const env = await executeLspOperation({ operation: "diagnostics", path: "a.ts" }, { getManager: () => mgr(c), cwd: ROOT });
    expect(env.status).toBe("ok");
    expect(env.meta.source).toBe("pull");
    expect(env.meta.readiness?.state).toBe("settling");
    expect(env.meta.freshness?.state).toBe("fresh");
  });
  it("diagnostics: caller cancellation wins over pull fallback", async () => {
    const ctl = new AbortController();
    const c = conn({
      getCapabilityRegistry: () => ({ can: () => true }),
      getDiagnosticsBroker: () => ({
        pullDocument: async () => new Promise(() => {}),
        readPush: () => ({ source: "push", diagnostics: [], receipt: 1, resultId: null, version: 1, confirmed: true }),
      }),
    });
    setTimeout(() => ctl.abort(), 10);
    const env = await executeLspOperation(
      { operation: "diagnostics", path: "a.ts", timeoutMs: 2000 },
      { getManager: () => mgr(c), cwd: ROOT, signal: ctl.signal },
    );
    expect(env.status).toBe("cancelled");
  });

  it("diagnostics: pull continuity passes previousResultId only with cache", async () => {
    const seen: unknown[] = [];
    const mk = (pullState: { resultId: string | null } | null) => conn({
      getCapabilityRegistry: () => ({ can: () => true }),
      getDiagnosticsBroker: () => ({
        pullDocument: async (...a: unknown[]) => { seen.push(a[1]); return { source: "pull", diagnostics: [], receipt: null, resultId: "r2", version: null, confirmed: true }; },
        readPush: () => ({ source: "push", diagnostics: [], receipt: null, resultId: null, version: null, confirmed: false }),
        getPullState: () => pullState,
      }),
    });
    await executeLspOperation({ operation: "diagnostics", path: "a.ts" }, { getManager: () => mgr(mk({ resultId: "r1" })), cwd: ROOT });
    expect(seen[0]).toEqual({ previousResultId: "r1" });
    seen.length = 0;
    await executeLspOperation({ operation: "diagnostics", path: "a.ts" }, { getManager: () => mgr(mk(null)), cwd: ROOT });
    expect(seen[0]).toBeUndefined();
  });
  it("publishedDiagnostics: push-state only, unknown freshness", async () => {
    const c = conn({
      getDiagnosticsBroker: () => ({
        readPush: () => ({ source: "push", diagnostics: [], receipt: 7, resultId: null, version: 3, confirmed: true }),
      }),
    });
    const env = await executeLspOperation({ operation: "publishedDiagnostics", path: "a.ts" }, { getManager: () => mgr(c), cwd: ROOT });
    expect(env.status).toBe("empty");
    expect(env.meta.source).toBe("push");
    expect(env.meta.freshness?.state).toBe("unknown");
  });
  it("cursor pagination round-trip", async () => {
    const items = [0, 1, 2, 3].map((i) => ({ uri: `file:///f${i}.ts`, range: { start: { line: i, character: 0 }, end: { line: i, character: 1 } } }));
    const c = conn({ getCapabilityRegistry: () => ({ can: () => true }), requestImpl: async () => items });
    const cursors = new LspCursorStore();
    const p1 = await executeLspOperation({ operation: "findReferences", path: "a.ts", position: { line: 0, character: 0 }, limit: 2 }, { getManager: () => mgr(c), cwd: ROOT, cursors });
    expect(p1.status).toBe("ok");
    expect(p1.meta.truncated).toBe(true);
    expect(p1.meta.nextCursor).toBeTruthy();
    const p2 = await executeLspOperation({ operation: "findReferences", path: "a.ts", position: { line: 0, character: 0 }, limit: 2, cursor: p1.meta.nextCursor }, { getManager: () => mgr(c), cwd: ROOT, cursors });
    expect((p2.result as unknown[] | null)?.length).toBe(2);
    expect(p2.meta.truncated).toBe(false);
  });
  it("invalid cursor throws caller error", async () => {
    const c = conn({ getCapabilityRegistry: () => ({ can: () => true }), requestImpl: async () => [{ uri: "file:///a.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }] });
    await expect(executeLspOperation({ operation: "findReferences", path: "a.ts", position: { line: 0, character: 0 }, cursor: "bogus!!!" }, { getManager: () => mgr(c), cwd: ROOT })).rejects.toThrow(/invalid cursor/);
  });
  it("affinity tiebreak advisory only: ambiguity remains", async () => {
    const affinity = new LspAffinity();
    affinity.noteSuccess(`${ROOT}::typescript`, "preferred-ts");
    const env = await executeLspOperation({ operation: "hover", path: "a.ts", position: { line: 0, character: 0 } }, { getManager: () => mgr(new AmbiguousServerError("typescript", ["a", "b"])), cwd: ROOT, affinity });
    expect(env.status).toBe("ambiguous");
  });
  it("affinity notes success after ok", async () => {
    const affinity = new LspAffinity();
    // Platform-round-trippable URI: drive-less file:///a.ts is unresolvable on
    // Windows and fail-closed canonicalization would drop it (no ok, no note).
    const locUri = pathToFileURL(join(tmpdir(), "affinity-note.ts")).href;
    const c = conn({ getCapabilityRegistry: () => ({ can: () => true }), requestImpl: async () => [{ uri: locUri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }] });
    await executeLspOperation({ operation: "goToDefinition", path: "a.ts", position: { line: 0, character: 0 } }, { getManager: () => mgr(c), cwd: ROOT, affinity });
    // Executor scope-keys on the resolved root (drive-letter root on Windows).
    expect(affinity.preferred(`${resolve(ROOT)}::typescript`, ["ts", "other"])).toBe("ts");
  });
  it("error status with code/message on transport failure", async () => {
    const c = conn({ getCapabilityRegistry: () => ({ can: () => true }), requestImpl: async () => { throw new Error("boom-wire"); } });
    const env = await executeLspOperation({ operation: "hover", path: "a.ts", position: { line: 0, character: 0 } }, { getManager: () => mgr(c), cwd: ROOT });
    expect(env.status).toBe("error");
    expect(env.error?.message).toMatch(/boom-wire/);
  });
  it("malformed normalization -> error", async () => {
    const c = conn({ getCapabilityRegistry: () => ({ can: () => true }), requestImpl: async () => [{ garbage: true }] });
    const env = await executeLspOperation({ operation: "goToDefinition", path: "a.ts", position: { line: 0, character: 0 } }, { getManager: () => mgr(c), cwd: ROOT });
    expect(env.status).toBe("error");
  });
  it("rename returns proposal, zero disk writes (no fs access)", async () => {
    const edit = { changes: { "file:///a.ts": [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "b" }] } };
    const c = conn({ getCapabilityRegistry: () => ({ can: () => true }), requestImpl: async () => edit });
    const env = await executeLspOperation({ operation: "rename", path: "a.ts", position: { line: 0, character: 0 }, newName: "b" }, { getManager: () => mgr(c), cwd: ROOT });
    expect(env.status).toBe("ok");
    expect(env.result).toMatchObject({ changes: expect.any(Array) });
  });
  it("provenance names server on every envelope", async () => {
    const c = conn({ getCapabilityRegistry: () => ({ can: () => true }), requestImpl: async () => null });
    const env = await executeLspOperation({ operation: "hover", path: "a.ts", position: { line: 0, character: 0 } }, { getManager: () => mgr(c), cwd: ROOT });
    expect(env.server).toMatchObject({ descriptorId: "ts", name: "ts-server", languageId: "typescript", projectRoot: "/repo", positionEncoding: "utf-16" });
  });
  it("lease released via deps.release", async () => {
    const release = vi.fn();
    const c = conn({ getCapabilityRegistry: () => ({ can: () => true }), requestImpl: async () => null });
    await executeLspOperation({ operation: "hover", path: "a.ts", position: { line: 0, character: 0 } }, {
      cwd: ROOT,
      acquire: async () => ({ conn: c, key: "k1" }),
      release,
    });
    expect(release).toHaveBeenCalledWith("k1");
  });
  it("pathless workspaceSymbols fans out at manager level (no typescript fallback)", async () => {
    const getServer = vi.fn(async () => { throw new Error("must not route pathless via getServer"); });
    const workspaceSymbol = vi.fn(async () => [{ name: "foo", kind: 12, location: { uri: "file:///b.py", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } } }]);
    const env = await executeLspOperation({ operation: "workspaceSymbols", query: "foo" }, { getManager: () => ({ getServer, workspaceSymbol }), cwd: ROOT });
    expect(workspaceSymbol).toHaveBeenCalledWith("foo");
    expect(getServer).not.toHaveBeenCalled();
    expect(env.status).toBe("ok");
    expect(env.server.descriptorId).toBe("unknown");
  });
  it("pathless workspaceDiagnostics is ambiguous (single-server envelope cannot aggregate)", async () => {
    const getServer = vi.fn(async () => null);
    const env = await executeLspOperation({ operation: "workspaceDiagnostics" }, { getManager: () => ({ getServer }), cwd: ROOT });
    expect(env.status).toBe("ambiguous");
    expect(env.server.descriptorId).toBe("unknown");
  });
  it("acquisition failure becomes error envelope with unknown provenance", async () => {
    const env = await executeLspOperation({ operation: "hover", path: "a.ts", position: { line: 0, character: 0 } }, { getManager: () => mgr(new Error("spawn ENOENT")), cwd: ROOT });
    expect(env.status).toBe("error");
    expect(env.error?.message).toMatch(/spawn ENOENT/);
    expect(env.server.descriptorId).toBe("unknown");
  });
  it("hintless pathless capabilities is unavailable", async () => {
    const env = await executeLspOperation({ operation: "capabilities" }, { getManager: () => mgr(null), cwd: ROOT });
    expect(env.status).toBe("unavailable");
  });
  it("capabilities local op snapshots registry", async () => {
    const c = conn({ descriptorId: "cap-ts", getCapabilityRegistry: () => ({ can: () => true, snapshot: () => ({ static: ["hover"], dynamic: [] }) } as never) });
    liveSession("cap-ts", c);
    const env = await executeLspOperation({ operation: "capabilities", server: "cap-ts" }, { getManager: () => mgr(null), cwd: ROOT });
    expect(env.status).toBe("ok");
    expect(env.result).toEqual({ static: ["hover"], dynamic: [] });
  });
  it("pathless workspaceSymbols never touches generic acquire", async () => {
    const acquire = vi.fn(async () => { throw new Error("must not acquire before pathless routing"); });
    const workspaceSymbol = vi.fn(async () => []);
    const env = await executeLspOperation({ operation: "workspaceSymbols", query: "foo" }, {
      getManager: () => ({ getServer: vi.fn(), workspaceSymbol }),
      acquire,
      cwd: ROOT,
    });
    expect(env.status).toBe("empty");
    expect(workspaceSymbol).toHaveBeenCalledWith("foo");
    expect(acquire).not.toHaveBeenCalled();
  });
  it("explicit-server pathless scan precedes generic acquire", async () => {
    const c = conn({ descriptorId: "scan-ts", requestImpl: async () => ({ syms: ["x"] }) });
    liveSession("scan-ts", c);
    const acquire = vi.fn(async () => { throw new Error("generic acquire must not run for pathless explicit-server"); });
    const env = await executeLspOperation(
      { operation: "request", server: "scan-ts", method: "workspace/symbol", params: { query: "x" } },
      { getManager: () => mgr(null), acquire, cwd: ROOT },
    );
    expect(env.status).toBe("ok");
    expect(acquire).not.toHaveBeenCalled();
  });
  it("dead-conn retry with null reacquire → unavailable, never re-issues on dead handle", async () => {
    let n = 0;
    const dead = conn({ requestImpl: async () => { n += 1; throw new LspServerExitError(); } });
    const acquire = vi.fn()
      .mockResolvedValueOnce({ conn: dead, key: "dead" })
      .mockResolvedValueOnce(null);
    const env = await executeLspOperation({ operation: "hover", path: "a.ts", position: { line: 1, character: 1 } }, {
      cwd: ROOT, acquire, release: () => {},
    });
    expect(env.status).toBe("unavailable");
    expect(n).toBe(1);
    expect(acquire).toHaveBeenCalledTimes(2);
  });
  it("dead-conn retry with throwing reacquire → error envelope", async () => {
    let n = 0;
    const dead = conn({ requestImpl: async () => { n += 1; throw new LspServerExitError(); } });
    const acquire = vi.fn()
      .mockResolvedValueOnce({ conn: dead, key: "dead" })
      .mockRejectedValueOnce(new Error("reacquire transport boom"));
    const env = await executeLspOperation({ operation: "hover", path: "a.ts", position: { line: 1, character: 1 } }, {
      cwd: ROOT, acquire, release: () => {},
    });
    expect(env.status).toBe("error");
    expect(env.error?.message).toMatch(/reacquire transport boom/);
    expect(n).toBe(1);
  });
  it("closed session + explicit server → unavailable (not transport-error)", async () => {
    const c = conn({ descriptorId: "closed-ts", requestImpl: async () => null });
    (c as unknown as Record<string, unknown>).closed = true;
    liveSession("closed-ts", c);
    const getServer = vi.fn(async () => { throw new Error("must not spawn for closed scan match"); });
    const env = await executeLspOperation({ operation: "capabilities", server: "closed-ts" }, {
      getManager: () => ({ getServer }),
      acquire: async () => { throw new Error("must not acquire for closed scan match"); },
      cwd: ROOT,
    });
    expect(env.status).toBe("unavailable");
    expect(getServer).not.toHaveBeenCalled();
  });
  it("explicit-server scan holds a lease during the request", async () => {
    const c = conn({ descriptorId: "leased-ts", requestImpl: async () => {
      const leases = [...sessionStore.values()].find((e) => e.descriptorId === "leased-ts")?.leases;
      return { observedLeases: leases };
    } });
    const k = liveSession("leased-ts", c);
    const env = await executeLspOperation({ operation: "request", server: "leased-ts", method: "workspace/symbol", params: { query: "x" } }, { getManager: () => mgr(null), cwd: ROOT });
    expect(env.status).toBe("ok");
    expect((env.result as { observedLeases: unknown }).observedLeases).toBe(1);
    expect(sessionStore.get(k)?.leases).toBe(0);
  });
  it("spoofed item.uri never wins over explicit server (ambiguous, no python spawn)", async () => {
    const rust = conn({ descriptorId: "rust-analyzer", languageId: "rust", requestImpl: async () => null });
    liveSession("rust-analyzer", rust);
    const acquire = vi.fn(async () => { throw new Error("must not spawn from spoofed item.uri"); });
    const getServer = vi.fn(async () => { throw new Error("must not spawn from spoofed item.uri"); });
    const env = await executeLspOperation({
      operation: "incomingCalls",
      server: "rust-analyzer",
      item: { uri: "file:///evil/x.py", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } },
    }, { getManager: () => ({ getServer }), acquire, cwd: ROOT });
    expect(env.status).toBe("ambiguous");
    expect(acquire).not.toHaveBeenCalled();
    expect(getServer).not.toHaveBeenCalled();
  });
  it("no-server item.uri reuses live only, else unavailable without spawning", async () => {
    const getServer = vi.fn(async () => { throw new Error("must not spawn from caller URI"); });
    const acquire = vi.fn(async () => { throw new Error("must not spawn from caller URI"); });
    const env = await executeLspOperation({
      operation: "incomingCalls",
      item: { uri: "file:///nowhere/q.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } },
    }, { getManager: () => ({ getServer }), acquire, cwd: ROOT });
    expect(env.status).toBe("unavailable");
    expect(getServer).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
  });
  it("unknown extension never reaches injected acquire (unavailable)", async () => {
    const acquire = vi.fn(async () => { throw new Error("must not acquire with null language"); });
    const getServer = vi.fn(async () => { throw new Error("must not spawn for unknown extension"); });
    const env = await executeLspOperation({ operation: "hover", path: "a.unknownext", position: { line: 0, character: 0 } }, {
      getManager: () => ({ getServer }), acquire, cwd: ROOT,
    });
    expect(env.status).toBe("unavailable");
    expect(acquire).not.toHaveBeenCalled();
    expect(getServer).not.toHaveBeenCalled();
  });
  it("pathless dead-retry reuses scan mechanism, never generic acquire", async () => {
    let n = 0;
    const c = conn({ descriptorId: "scan-dead", languageId: "typescript", requestImpl: async () => { n += 1; throw new LspServerExitError(); } });
    liveSession("scan-dead", c);
    const acquire = vi.fn(async () => { throw new Error("generic acquire must not run on pathless retry"); });
    const env = await executeLspOperation(
      {
        operation: "incomingCalls", server: "scan-dead",
        item: { uri: "file:///a.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } },
      },
      { getManager: () => mgr(null), acquire, cwd: ROOT },
    );
    expect(acquire).not.toHaveBeenCalled();
    expect(n).toBe(2);
    expect(env.status).toBe("error");
  });
  it("multi-language connection matches via second languageId with matched provenance", async () => {
    const item = { uri: "file:///x.js", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } };
    const rng = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
    const from = { name: "f", kind: 12, uri: "file:///x.js", range: rng, selectionRange: rng };
    const c = conn({
      descriptorId: "multi",
      languageId: "typescript",
      languageIds: ["typescript", "javascript"],
      getCapabilityRegistry: () => ({ can: () => true }),
      requestImpl: async (m: string) => m === "textDocument/prepareCallHierarchy" ? [from] : [{ from, fromRanges: [rng] }],
    });
    liveSession("multi", c);
    const acquire = vi.fn(async () => { throw new Error("must not spawn on advisory match"); });
    const env = await executeLspOperation({ operation: "incomingCalls", item }, {
      getManager: () => ({ getServer: vi.fn(async () => { throw new Error("must not spawn"); }) }), acquire, cwd: ROOT,
    });
    expect(env.status).toBe("ok");
    expect(env.server.languageId).toBe("javascript");
    expect(acquire).not.toHaveBeenCalled();
  });
  it("explicit-server workspaceSymbols scan MISS is unavailable (no fanout)", async () => {
    const getServer = vi.fn(async () => { throw new Error("must not spawn for explicit-server miss"); });
    const workspaceSymbol = vi.fn(async () => { throw new Error("must not fan out on explicit-server miss"); });
    const acquire = vi.fn(async () => { throw new Error("must not acquire on explicit-server miss"); });
    const env = await executeLspOperation({ operation: "workspaceSymbols", query: "foo", server: "missing-ts" }, {
      getManager: () => ({ getServer, workspaceSymbol }), acquire, cwd: ROOT,
    });
    expect(env.status).toBe("unavailable");
    expect(workspaceSymbol).not.toHaveBeenCalled();
    expect(getServer).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
  });
  it("explicit-server workspaceDiagnostics scan MISS is unavailable (not ambiguous)", async () => {
    const getServer = vi.fn(async () => { throw new Error("must not spawn for explicit-server miss"); });
    const acquire = vi.fn(async () => { throw new Error("must not acquire on explicit-server miss"); });
    const env = await executeLspOperation({ operation: "workspaceDiagnostics", server: "missing-ts" }, {
      getManager: () => ({ getServer }), acquire, cwd: ROOT,
    });
    expect(env.status).toBe("unavailable");
    expect(getServer).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
  });
  it("explicit server agrees with item.uri hint → proceeds on explicit session", async () => {
    const item = { name: "g", kind: 12, uri: "file:///ok/a.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, data: { d: 1 } };
    const rng = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
    const ts = conn({ descriptorId: "agree-ts", languageId: "typescript", requestImpl: async (m: string) => m === "textDocument/prepareCallHierarchy" ? [item] : [{ from: item, fromRanges: [rng] }] });
    liveSession("agree-ts", ts);
    const acquire = vi.fn(async () => { throw new Error("must not spawn on agreement"); });
    const env = await executeLspOperation({
      operation: "incomingCalls",
      server: "agree-ts",
      item: { uri: "file:///ok/a.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } },
    }, { getManager: () => mgr(null), acquire, cwd: ROOT });
    expect(env.status).toBe("ok");
    expect(acquire).not.toHaveBeenCalled();
  });
  it("diagnostics: pull-unconfirmed falls back to unconfirmed push → not_ready", async () => {
    const c = conn({
      getCapabilityRegistry: () => ({ can: () => true }),
      getDiagnosticsBroker: () => ({
        pullDocument: async () => ({ source: "pull", diagnostics: [], receipt: null, resultId: null, version: null, confirmed: false }),
        readPush: () => ({ source: "push", diagnostics: [], receipt: null, resultId: null, version: null, confirmed: false }),
        getPullState: () => null,
      }),
    });
    const env = await executeLspOperation({ operation: "diagnostics", path: "a.ts" }, { getManager: () => mgr(c), cwd: ROOT });
    expect(env.status).toBe("not_ready");
    expect(env.result).toBeNull();
  });
  it("publishedDiagnostics: unconfirmed push → not_ready (not empty)", async () => {
    const c = conn({
      getDiagnosticsBroker: () => ({
        readPush: () => ({ source: "push", diagnostics: [], receipt: null, resultId: null, version: null, confirmed: false }),
      }),
    });
    const env = await executeLspOperation({ operation: "publishedDiagnostics", path: "a.ts" }, { getManager: () => mgr(c), cwd: ROOT });
    expect(env.status).toBe("not_ready");
    expect(env.result).toBeNull();
  });
  it("workspaceDiagnostics: unconfirmed via explicit server → not_ready", async () => {
    const c = conn({
      descriptorId: "ts",
      getCapabilityRegistry: () => ({ can: () => true }),
      getDiagnosticsBroker: () => ({
        pullWorkspace: async () => ({ source: "workspace-pull", diagnostics: [], receipt: null, resultId: null, version: null, confirmed: false, reports: [], resultIds: [] }),
      }),
    });
    liveSession("ts", c);
    const env = await executeLspOperation({ operation: "workspaceDiagnostics", server: "ts" }, { getManager: () => mgr(c), cwd: ROOT });
    expect(env.status).toBe("not_ready");
    expect(env.result).toBeNull();
  });
  it("diagnostics (file): confirmed-empty pull → empty+fresh; absent/null/unsupported-pull → not_ready+null+unknown", async () => {
    const d = { message: "e", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } };
    const emptyC = conn({
      getCapabilityRegistry: () => ({ can: () => true }),
      getDiagnosticsBroker: () => ({
        pullDocument: async () => ({ source: "pull", diagnostics: [], receipt: null, resultId: "r1", version: null, confirmed: true }),
        readPush: () => null,
        getPullState: () => null,
      }),
    });
    const emptyEnv = await executeLspOperation({ operation: "diagnostics", path: "a.ts" }, { getManager: () => mgr(emptyC), cwd: ROOT });
    expect(emptyEnv.status).toBe("empty");
    expect(emptyEnv.result).toEqual([]);
    expect((emptyEnv.meta as { freshness: { state: string } }).freshness.state).toBe("fresh");
    const okC = conn({
      getCapabilityRegistry: () => ({ can: () => true }),
      getDiagnosticsBroker: () => ({
        pullDocument: async () => ({ source: "pull", diagnostics: [d], receipt: null, resultId: "r1", version: null, confirmed: true }),
        readPush: () => null,
        getPullState: () => null,
      }),
    });
    const okEnv = await executeLspOperation({ operation: "diagnostics", path: "a.ts" }, { getManager: () => mgr(okC), cwd: ROOT });
    expect(okEnv.status).toBe("ok");
    expect(okEnv.result).toEqual([d]);
    const cases: Array<{ name: string; broker: unknown }> = [
      { name: "null-pull", broker: { pullDocument: async () => ({ source: "pull", diagnostics: [], receipt: null, resultId: null, version: null, confirmed: false }), readPush: () => null, getPullState: () => null } },
      { name: "unsupported-pull", broker: { readPush: () => ({ source: "push", diagnostics: [], receipt: null, resultId: null, version: null, confirmed: false }) } },
      { name: "absent-broker", broker: null },
    ];
    for (const cs of cases) {
      const c = conn({
        getCapabilityRegistry: () => ({ can: () => true }),
        ...(cs.broker ? { getDiagnosticsBroker: () => cs.broker } : { getDiagnosticsBroker: () => null }),
        getDiagnostics: () => [],
      });
      const env = await executeLspOperation({ operation: "diagnostics", path: "a.ts" }, { getManager: () => mgr(c), cwd: ROOT });
      expect(env.status, cs.name).toBe("not_ready");
      expect(env.result, cs.name).toBeNull();
      expect((env.meta as { freshness: { state: string } }).freshness.state, cs.name).toBe("unknown");
    }
  });
  it("workspaceDiagnostics via explicit server: confirmed-empty stays empty, items stay ok with reports", async () => {
    const mk = (id: string, diags: unknown[], reports: unknown[]) => conn({
      descriptorId: id,
      getCapabilityRegistry: () => ({ can: () => true }),
      getDiagnosticsBroker: () => ({
        pullWorkspace: async () => ({ source: "workspace-pull", diagnostics: diags, receipt: null, resultId: "w1", version: null, confirmed: true, reports, resultIds: [] }),
      }),
    });
    const depsFor = (id: string, c: ExecutorConnection) => {
      liveSession(id, c);
      return { getManager: () => mgr(c), cwd: ROOT };
    };
    const emptyC = mk("ts-ws-empty", [], []);
    const emptyEnv = await executeLspOperation({ operation: "workspaceDiagnostics", server: "ts-ws-empty" }, depsFor("ts-ws-empty", emptyC));
    expect(emptyEnv.status).toBe("empty");
    const d = { message: "e", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } };
    const okC = mk("ts-ws-ok", [d], [{ uri: "file:///a.ts", version: 3, resultId: "r1", kind: "full", diagnostics: [d] }]);
    const okEnv = await executeLspOperation({ operation: "workspaceDiagnostics", server: "ts-ws-ok" }, depsFor("ts-ws-ok", okC));
    expect(okEnv.status).toBe("ok");
    expect((okEnv.result as { diagnostics: unknown[] }).diagnostics).toEqual([d]);
    expect((okEnv.result as { reports: unknown[] }).reports).toEqual([
      { uri: "file:///a.ts", version: 3, resultId: "r1", kind: "full", diagnostics: [d] },
    ]);
  });
  it("workspaceDiagnostics threads identifier; omits when absent", async () => {
    const seen: unknown[] = [];
    const c = conn({
      descriptorId: "ts-ws-id",
      getCapabilityRegistry: () => ({ can: () => true }),
      getDiagnosticsBroker: () => ({
        pullWorkspace: async (opts?: unknown) => {
          seen.push(opts);
          return { source: "workspace-pull", diagnostics: [], receipt: null, resultId: null, version: null, confirmed: true, reports: [], resultIds: [] };
        },
      }),
    });
    liveSession("ts-ws-id", c);
    const deps = { getManager: () => mgr(c), cwd: ROOT };
    await executeLspOperation({ operation: "workspaceDiagnostics", server: "ts-ws-id", identifier: "diag-1" }, deps);
    expect(seen[0]).toEqual({ identifier: "diag-1" });
    await executeLspOperation({ operation: "workspaceDiagnostics", server: "ts-ws-id" }, deps);
    expect(seen[1]).toBeUndefined();
  });
  it("workspaceDiagnostics rejects query (identifier surface only)", async () => {
    await expect(
      executeLspOperation({ operation: "workspaceDiagnostics", query: "x" }, { cwd: ROOT }),
    ).rejects.toThrow(/foreign field "query"/);
  });
  it("raw bounds: deep payload pruned with marker and truncated flag", async () => {
    let deep: unknown = { leaf: "x" };
    for (let i = 0; i < 25; i++) deep = { nest: deep };
    const c = conn({ descriptorId: "raw-deep", requestImpl: async () => deep });
    liveSession("raw-deep", c);
    const env = await executeLspOperation({ operation: "request", method: "textDocument/hover", params: {}, server: "raw-deep" }, { getManager: () => mgr(null), cwd: ROOT });
    expect(env.status).toBe("ok");
    expect(env.meta.truncated).toBe(true);
    expect(JSON.stringify(env.result)).toContain("[truncated]");
  });
  it("raw bounds: huge payload becomes output-limit error envelope", async () => {
    const c = conn({ descriptorId: "raw-huge", requestImpl: async () => ({ blob: "x".repeat(2 * 1024 * 1024) }) });
    liveSession("raw-huge", c);
    const env = await executeLspOperation({ operation: "request", method: "textDocument/hover", params: {}, server: "raw-huge" }, { getManager: () => mgr(null), cwd: ROOT });
    expect(env.status).toBe("error");
    expect(env.result).toBeNull();
    expect(env.error?.message).toMatch(/raw result exceeds output limit/);
  });
  it("raw bounds: normal payload unaffected", async () => {
    const c = conn({ descriptorId: "raw-normal", requestImpl: async () => ({ a: { b: [1, 2, 3] } }) });
    liveSession("raw-normal", c);
    const env = await executeLspOperation({ operation: "request", method: "textDocument/hover", params: {}, server: "raw-normal" }, { getManager: () => mgr(null), cwd: ROOT });
    expect(env.status).toBe("ok");
    expect(env.meta.truncated).toBe(false);
    expect(env.result).toEqual({ a: { b: [1, 2, 3] } });
  });
  it("re-gate after reacquire: capability withdrawn → unsupported, no request issued", async () => {
    let liveRequests = 0;
    const dead = conn({
      getCapabilityRegistry: () => ({ can: () => true }),
      requestImpl: async () => { throw Object.assign(new Error("LSP server exited"), { name: "LspServerExitError" }); },
    });
    const live = conn({
      descriptorId: "live",
      getCapabilityRegistry: () => ({ can: () => false }),
      request: async () => { liveRequests++; return null; },
    });
    let acquisitions = 0;
    const getServer = async () => { acquisitions++; return acquisitions === 1 ? dead : live; };
    const env = await executeLspOperation({ operation: "hover", path: "a.ts", position: { line: 0, character: 0 } }, {
      getManager: () => ({ getServer }),
      cwd: ROOT,
      acquire: async () => ({ conn: await getServer(), key: `k${acquisitions}` }),
      release: () => {},
    });
    expect(env.status).toBe("unsupported");
    expect(env.result).toBeNull();
    expect(acquisitions).toBe(2);
    expect(liveRequests).toBe(0);
  });
});
