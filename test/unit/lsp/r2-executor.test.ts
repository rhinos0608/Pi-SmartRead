import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { sessionStore } from "../../../src/lsp/lsp-manager.js";
import { canonicalProjectRoot } from "../../../src/lsp/lsp-session-key.js";
import { executeLspOperation, fetchR2SymbolsBatch, R2_SYMBOL_CONCURRENCY, type ExecutorConnection } from "../../../src/lsp/lsp-executor.js";
import { LspCursorStore } from "../../../src/lsp/lsp-cursor-store.js";

const roots: string[] = [];
const testSessionKeys: string[] = [];
afterEach(() => {
  for (const k of testSessionKeys.splice(0)) sessionStore.delete(k);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "r2-exec-")));
  roots.push(root);
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
  }
  return root;
}

function conn(over: Partial<ExecutorConnection> & { requestImpl?: (m: string, p: unknown) => Promise<unknown> } = {}): ExecutorConnection {
  const { requestImpl, ...rest } = over;
  return {
    descriptorId: "ts",
    name: "ts-server",
    languageId: "typescript",
    languageIds: ["typescript"],
    getNegotiatedEncoding: () => "utf-16",
    prepareDocument: async (filePath?: string) => ({
      canonicalPath: filePath ?? "/repo/a.ts",
      uri: `file://${filePath ?? "/repo/a.ts"}`,
      version: 1,
      textHash: "test-hash",
      mutationGeneration: 1,
      submissionStamp: 1,
      syncConfig: { openClose: true, change: "full" as const },
      connectionId: "conn-test",
      transportId: "trans-test",
      storeId: "store-test",
      stateId: "state-test",
      positionEncoding: "utf-16" as const,
    }),
    request: (m, p) => (requestImpl ? requestImpl(m, p) : Promise.resolve(null)),
    ...rest,
  };
}

function mgr(c: ExecutorConnection | null) {
  return { getServer: async () => c };
}

function liveSession(root: string, descriptorId: string, c: ExecutorConnection): void {
  const key = `test::${descriptorId}::${testSessionKeys.length}`;
  sessionStore.set(key, { conn: c as never, fingerprint: "test", descriptorId, root: canonicalProjectRoot(root), leases: 0, lastUsed: Date.now() });
  testSessionKeys.push(key);
}

function loc(abs: string, line: number, character: number) {
  return {
    uri: pathToFileURL(abs).href,
    range: { start: { line, character }, end: { line, character: character + 3 } },
  };
}

function refsConn(root: string, locations: unknown[], symbols: Record<string, unknown[]> = {}) {
  return conn({
    projectRoot: root,
    getCapabilityRegistry: () => ({ can: () => true }),
    requestImpl: async (method, params) => {
      if (method === "textDocument/references") return locations;
      if (method === "textDocument/documentSymbol") {
        const uri = (params as { textDocument: { uri: string } }).textDocument.uri;
        const base = basename(fileURLToPath(uri));
        if (!(base in symbols)) throw new Error(`no symbols for ${base}`);
        return symbols[base];
      }
      throw new Error(`unexpected method ${method}`);
    },
  });
}

describe("executor r2 findReferences", () => {
  it("shapes grouped references with roles, enclosing, and text", async () => {
    const root = makeRoot({
      "a.ts": `export function foo() { return 1; }\n`,
      "b.ts": `import { foo } from "./a";\nfoo();\n`,
    });
    const c = refsConn(root,
      [loc(join(root, "a.ts"), 0, 17), loc(join(root, "b.ts"), 0, 9), loc(join(root, "b.ts"), 1, 0)],
      {
        "a.ts": [{ name: "foo", kind: 12, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 38 } }, selectionRange: { start: { line: 0, character: 16 }, end: { line: 0, character: 19 } } }],
        "b.ts": [],
      });
    const env = await executeLspOperation(
      { operation: "findReferences", path: "b.ts", position: { line: 1, character: 0 } },
      { getManager: () => mgr(c), cwd: root, cursors: new LspCursorStore(), r2: true },
    );
    expect(env.status).toBe("ok");
    expect(env.operation).toBe("findReferences");
    const result = env.result as { total: number; returned: number; truncated: boolean; files: Array<{ path: string; refs: unknown[] }> };
    expect(result.total).toBe(3);
    expect(result.returned).toBe(3);
    expect(result.truncated).toBe(false);
    expect(result.files.map((f) => f.path)).toEqual(["a.ts", "b.ts"]);
    expect(result.files[0]!.refs).toEqual([{
      line: 0, character: 17, role: "declaration",
      enclosing: { name: "foo", kind: 12 },
      text: "export function foo() { return 1; }",
    }]);
    expect(result.files[1]!.refs).toMatchObject([
      { line: 0, character: 9, role: "import" },
      { line: 1, character: 0, role: "use" },
    ]);
    expect(env.meta.truncated).toBe(false);
  });

  it("leaves the baseline result a byte-identical bare location array", async () => {
    const root = makeRoot({ "a.ts": `foo();\n` });
    const locations = [loc(join(root, "a.ts"), 0, 0)];
    const c = refsConn(root, locations, { "a.ts": [] });
    const env = await executeLspOperation(
      { operation: "findReferences", path: "a.ts", position: { line: 0, character: 0 } },
      { getManager: () => mgr(c), cwd: root, cursors: new LspCursorStore() },
    );
    expect(env.status).toBe("ok");
    expect(env.result).toEqual(locations);
  });

  it("rejects scope on baseline but filters by scope in r2 with the full total", async () => {
    const root = makeRoot({ "sub/a.ts": `a();\n`, "top.ts": `b();\n` });
    const locations = [loc(join(root, "top.ts"), 0, 0), loc(join(root, "sub/a.ts"), 0, 0)];
    const c = refsConn(root, locations, { "a.ts": [], "top.ts": [] });
    await expect(executeLspOperation(
      { operation: "findReferences", path: "top.ts", position: { line: 0, character: 0 }, scope: "sub" },
      { getManager: () => mgr(c), cwd: root, cursors: new LspCursorStore() },
    )).rejects.toThrow(/foreign field "scope"/);
    const env = await executeLspOperation(
      { operation: "findReferences", path: "top.ts", position: { line: 0, character: 0 }, scope: "sub" },
      { getManager: () => mgr(c), cwd: root, cursors: new LspCursorStore(), r2: true },
    );
    const result = env.result as { total: number; returned: number; scope: string; filteredOutByScope: number; files: Array<{ path: string }> };
    expect(result.total).toBe(2);
    expect(result.returned).toBe(1);
    expect(result.scope).toBe("sub");
    expect(result.filteredOutByScope).toBe(1);
    expect(result.files.map((f) => f.path)).toEqual(["sub/a.ts"]);
  });

  it("reports scope validation failures as caller errors in r2", async () => {
    const root = makeRoot({ "a.ts": `a();\n` });
    const c = refsConn(root, [loc(join(root, "a.ts"), 0, 0)], { "a.ts": [] });
    const deps = { getManager: () => mgr(c), cwd: root, cursors: new LspCursorStore(), r2: true as const };
    await expect(executeLspOperation(
      { operation: "findReferences", path: "a.ts", position: { line: 0, character: 0 }, scope: "missing-dir" },
      deps,
    )).rejects.toThrow(/scope/);
    await expect(executeLspOperation(
      { operation: "findReferences", path: "a.ts", position: { line: 0, character: 0 }, scope: ".." },
      deps,
    )).rejects.toThrow(/scope/);
  });

  it("paginates r2 pages at 100 by default with cursor continuation", async () => {
    const lines = Array.from({ length: 105 }, (_, i) => `use${i}();`).join("\n");
    const root = makeRoot({ "a.ts": `${lines}\n` });
    const locations = Array.from({ length: 105 }, (_, i) => loc(join(root, "a.ts"), i, 0));
    const c = refsConn(root, locations, { "a.ts": [] });
    const cursors = new LspCursorStore();
    const first = await executeLspOperation(
      { operation: "findReferences", path: "a.ts", position: { line: 0, character: 0 } },
      { getManager: () => mgr(c), cwd: root, cursors, r2: true },
    );
    const r1 = first.result as { total: number; returned: number; truncated: boolean; nextCursor?: string };
    expect(r1.total).toBe(105);
    expect(r1.returned).toBe(100);
    expect(r1.truncated).toBe(true);
    expect(typeof r1.nextCursor).toBe("string");
    expect(first.meta.nextCursor).toBe(r1.nextCursor);
    const second = await executeLspOperation(
      { operation: "findReferences", path: "a.ts", position: { line: 0, character: 0 }, cursor: r1.nextCursor },
      { getManager: () => mgr(c), cwd: root, cursors, r2: true },
    );
    const r2 = second.result as { total: number; returned: number; truncated: boolean };
    expect(r2.total).toBe(105);
    expect(r2.returned).toBe(5);
    expect(r2.truncated).toBe(false);
  });

  it("rejects continuations that change the scope or the query", async () => {
    const lines = Array.from({ length: 105 }, (_, i) => `use${i}();`).join("\n");
    const root = makeRoot({ "a.ts": `${lines}\n`, "sub/b.ts": "use();\n" });
    const locations = Array.from({ length: 105 }, (_, i) => loc(join(root, "a.ts"), i, 0));
    const c = refsConn(root, locations, { "a.ts": [] });
    const cursors = new LspCursorStore();
    const first = await executeLspOperation(
      { operation: "findReferences", path: "a.ts", position: { line: 0, character: 0 } },
      { getManager: () => mgr(c), cwd: root, cursors, r2: true },
    );
    const cursor = (first.result as { nextCursor?: string }).nextCursor!;
    expect(typeof cursor).toBe("string");
    // Same cursor, different scope: caller error, never a silent offset reuse.
    await expect(executeLspOperation(
      { operation: "findReferences", path: "a.ts", position: { line: 0, character: 0 }, scope: "sub", cursor },
      { getManager: () => mgr(c), cwd: root, cursors, r2: true },
    )).rejects.toThrow(/invalid cursor/);
    // Same cursor, different query path: caller error.
    await expect(executeLspOperation(
      { operation: "findReferences", path: "sub/b.ts", position: { line: 0, character: 0 }, cursor },
      { getManager: () => mgr(c), cwd: root, cursors, r2: true },
    )).rejects.toThrow(/invalid cursor/);
    // Same cursor, different position: caller error.
    await expect(executeLspOperation(
      { operation: "findReferences", path: "a.ts", position: { line: 1, character: 0 }, cursor },
      { getManager: () => mgr(c), cwd: root, cursors, r2: true },
    )).rejects.toThrow(/invalid cursor/);
    // Same query continues fine.
    const second = await executeLspOperation(
      { operation: "findReferences", path: "a.ts", position: { line: 0, character: 0 }, cursor },
      { getManager: () => mgr(c), cwd: root, cursors, r2: true },
    );
    expect((second.result as { returned: number }).returned).toBe(5);
  });

  it("propagates cancellation from symbol enrichment as cancelled", async () => {
    const root = makeRoot({ "a.ts": `foo();\nbar();\n` });
    const aborted = conn({
      projectRoot: root,
      getCapabilityRegistry: () => ({ can: () => true }),
      requestImpl: async (method) => {
        if (method === "textDocument/references") {
          return [loc(join(root, "a.ts"), 0, 0), loc(join(root, "a.ts"), 1, 0)];
        }
        throw Object.assign(new Error("request cancelled"), { name: "AbortError" });
      },
    });
    const env = await executeLspOperation(
      { operation: "findReferences", path: "a.ts", position: { line: 0, character: 0 } },
      { getManager: () => mgr(aborted), cwd: root, cursors: new LspCursorStore(), r2: true },
    );
    expect(env.status).toBe("cancelled");
    expect(env.result).toBeNull();
  });

  it("propagates a mid-flight abort during enrichment as cancelled", async () => {
    const root = makeRoot({ "a.ts": `foo();\nbar();\n` });
    const ctl = new AbortController();
    const c = conn({
      projectRoot: root,
      getCapabilityRegistry: () => ({ can: () => true }),
      requestImpl: async (method) => {
        if (method === "textDocument/references") {
          return [loc(join(root, "a.ts"), 0, 0), loc(join(root, "a.ts"), 1, 0)];
        }
        ctl.abort();
        throw new Error("socket closed");
      },
    });
    const env = await executeLspOperation(
      { operation: "findReferences", path: "a.ts", position: { line: 0, character: 0 } },
      { getManager: () => mgr(c), cwd: root, cursors: new LspCursorStore(), r2: true, signal: ctl.signal },
    );
    expect(env.status).toBe("cancelled");
    expect(env.result).toBeNull();
  });

  it("never drops hits when documentSymbol fails, marking enclosingIncomplete", async () => {
    const root = makeRoot({ "a.ts": `foo();\nbar();\n` });
    const c = conn({
      projectRoot: root,
      getCapabilityRegistry: () => ({ can: () => true }),
      requestImpl: async (method) => {
        if (method === "textDocument/references") {
          return [loc(join(root, "a.ts"), 0, 0), loc(join(root, "a.ts"), 1, 0)];
        }
        throw new Error("symbols down");
      },
    });
    const env = await executeLspOperation(
      { operation: "findReferences", path: "a.ts", position: { line: 0, character: 0 } },
      { getManager: () => mgr(c), cwd: root, cursors: new LspCursorStore(), r2: true },
    );
    const result = env.result as { total: number; returned: number; enclosingIncomplete: boolean; files: Array<{ refs: Array<{ enclosing: null; role: string }> }> };
    expect(env.status).toBe("ok");
    expect(result.total).toBe(2);
    expect(result.returned).toBe(2);
    expect(result.enclosingIncomplete).toBe(true);
    expect(result.files[0]!.refs.map((r) => [r.role, r.enclosing])).toEqual([["use", null], ["use", null]]);
  });

  it("caps enrichment fan-out at 4 in flight with a fake connection", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 10; i += 1) files[`f${String(i).padStart(2, "0")}.ts`] = `v${i}();\n`;
    const root = makeRoot(files);
    const rels = Object.keys(files);
    const locations = rels.map((rel) => loc(join(root, rel), 0, 0));
    let inFlight = 0;
    let maxInFlight = 0;
    const c = conn({
      projectRoot: root,
      getCapabilityRegistry: () => ({ can: () => true }),
      requestImpl: async (method) => {
        if (method === "textDocument/references") return locations;
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return [];
      },
    });
    const env = await executeLspOperation(
      { operation: "findReferences", path: rels[0], position: { line: 0, character: 0 } },
      { getManager: () => mgr(c), cwd: root, cursors: new LspCursorStore(), r2: true },
    );
    expect(env.status).toBe("ok");
    expect((env.result as { returned: number }).returned).toBe(10);
    expect(maxInFlight).toBeLessThanOrEqual(R2_SYMBOL_CONCURRENCY);
    expect(maxInFlight).toBeGreaterThan(1);
  });
});

describe("executor r2 incomingCalls", () => {
  function callerItem(abs: string, name: string, line: number, data?: unknown) {
    return {
      name, kind: 12, uri: pathToFileURL(abs).href,
      range: { start: { line, character: 0 }, end: { line: line + 2, character: 1 } },
      selectionRange: { start: { line, character: 9 }, end: { line, character: 9 + name.length } },
      ...(data === undefined ? {} : { data }),
    };
  }

  it("dedupes callers, orders by path, and keeps the exact item", async () => {
    const root = makeRoot({
      "b.ts": `function second() {\n  target();\n  target();\n}\n`,
      "a.ts": `function first() {\n  target();\n}\n`,
    });
    const second = callerItem(join(root, "b.ts"), "second", 0, { backend: 1 });
    const first = callerItem(join(root, "a.ts"), "first", 0);
    const c = conn({
      projectRoot: root,
      getCapabilityRegistry: () => ({ can: () => true }),
      requestImpl: async () => [
        { from: second, fromRanges: [{ start: { line: 1, character: 2 }, end: { line: 1, character: 8 } }] },
        { from: { ...second }, fromRanges: [{ start: { line: 2, character: 2 }, end: { line: 2, character: 8 } }] },
        { from: first, fromRanges: [{ start: { line: 1, character: 2 }, end: { line: 1, character: 8 } }] },
      ],
    });
    liveSession(root, "ts", c);
    const target = { name: "target", kind: 12, uri: pathToFileURL(join(root, "a.ts")).href, range: { start: { line: 5, character: 0 }, end: { line: 5, character: 9 } }, selectionRange: { start: { line: 5, character: 9 }, end: { line: 5, character: 15 } } };
    const env = await executeLspOperation(
      { operation: "incomingCalls", item: target },
      { getManager: () => mgr(null), cwd: root, cursors: new LspCursorStore(), r2: true },
    );
    expect(env.status).toBe("ok");
    const result = env.result as {
      callers: Array<{ name: string; kind: number; path: string; line: number; character: number; callSites: Array<{ line: number; character: number; text: string }>; item: unknown }>;
    };
    expect(result.callers.map((caller) => caller.name)).toEqual(["first", "second"]);
    expect(result.callers[0]).toMatchObject({ path: "a.ts", line: 0, character: 9, kind: 12 });
    expect(result.callers[0]!.callSites).toEqual([{ line: 1, character: 2, text: "target();" }]);
    expect(result.callers[1]!.callSites).toEqual([
      { line: 1, character: 2, text: "target();" },
      { line: 2, character: 2, text: "target();" },
    ]);
    expect(result.callers[1]!.item).toEqual(second);
  });

  it("leaves the baseline incomingCalls result raw", async () => {
    const root = makeRoot({ "a.ts": `function first() {\n  target();\n}\n` });
    const from = callerItem(join(root, "a.ts"), "first", 0);
    const raw = [{ from, fromRanges: [{ start: { line: 1, character: 2 }, end: { line: 1, character: 8 } }] }];
    const c = conn({
      projectRoot: root,
      getCapabilityRegistry: () => ({ can: () => true }),
      requestImpl: async () => raw,
    });
    liveSession(root, "ts", c);
    const target = { name: "target", kind: 12, uri: pathToFileURL(join(root, "a.ts")).href, range: { start: { line: 5, character: 0 }, end: { line: 5, character: 9 } }, selectionRange: { start: { line: 5, character: 9 }, end: { line: 5, character: 15 } } };
    const env = await executeLspOperation(
      { operation: "incomingCalls", item: target },
      { getManager: () => mgr(null), cwd: root, cursors: new LspCursorStore() },
    );
    expect(env.status).toBe("ok");
    expect(env.result).toEqual(raw);
  });
});

describe("fetchR2SymbolsBatch", () => {
  it("caps in-flight enrichment at 4 and resolves every file", async () => {
    const paths = Array.from({ length: 10 }, (_, i) => `/repo/f${i}.ts`);
    let inFlight = 0;
    let maxInFlight = 0;
    const seen: string[] = [];
    const out = await fetchR2SymbolsBatch({
      paths,
      timeoutMs: 5000,
      started: 0,
      now: () => 0,
      fetchOne: async (absPath) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        seen.push(absPath);
        return [];
      },
    });
    expect(maxInFlight).toBeLessThanOrEqual(R2_SYMBOL_CONCURRENCY);
    expect(maxInFlight).toBeGreaterThan(1);
    expect([...out.keys()].sort()).toEqual([...paths].sort());
    expect(seen.sort()).toEqual([...paths].sort());
  });

  it("passes the remaining deadline, floored at 1ms", async () => {
    const remaining: number[] = [];
    let now = 1000;
    await fetchR2SymbolsBatch({
      paths: ["/repo/a.ts", "/repo/b.ts", "/repo/c.ts"],
      timeoutMs: 100,
      started: 1000,
      now: () => now,
      fetchOne: async (_absPath, remainingMs) => {
        remaining.push(remainingMs);
        now += 60;
        return [];
      },
    });
    expect(remaining).toEqual([100, 40, 1]);
  });

  it("rethrows AbortError and records anything else as null", async () => {
    const abort = Object.assign(new Error("gone"), { name: "AbortError" });
    await expect(fetchR2SymbolsBatch({
      paths: ["/repo/a.ts"],
      timeoutMs: 1000,
      started: 0,
      now: () => 0,
      fetchOne: async () => { throw abort; },
    })).rejects.toBe(abort);
    const ctl = new AbortController();
    const pending = fetchR2SymbolsBatch({
      paths: ["/repo/a.ts", "/repo/b.ts"],
      timeoutMs: 1000,
      started: 0,
      now: () => 0,
      signal: ctl.signal,
      fetchOne: async () => {
        ctl.abort();
        throw new Error("socket closed");
      },
    });
    // Whoever observes the abort first wins; both outcomes are AbortErrors.
    const settled = await pending.then((): unknown => "resolved", (err: unknown) => err);
    expect((settled as { name?: string })?.name).toBe("AbortError");
    const mixed = await fetchR2SymbolsBatch({
      paths: ["/repo/a.ts", "/repo/b.ts"],
      timeoutMs: 1000,
      started: 0,
      now: () => 0,
      fetchOne: async (absPath) => {
        if (absPath.endsWith("b.ts")) throw new Error("flaky file");
        return [];
      },
    });
    expect(mixed.get("/repo/a.ts")).toEqual([]);
    expect(mixed.get("/repo/b.ts")).toBeNull();
  });
});
