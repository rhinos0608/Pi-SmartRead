import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { sessionStore } from "../../../src/lsp/lsp-manager.js";
import { canonicalProjectRoot } from "../../../src/lsp/lsp-session-key.js";
import { executeLspOperation, type ExecutorConnection } from "../../../src/lsp/lsp-executor.js";
import { LspCursorStore } from "../../../src/lsp/lsp-cursor-store.js";
import { shapeR2IncomingCalls } from "../../../src/lsp/lsp-r2-shaping.js";

const roots: string[] = [];
const testSessionKeys: string[] = [];
afterEach(() => {
  for (const k of testSessionKeys.splice(0)) sessionStore.delete(k);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "r2-callers-")));
  roots.push(root);
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
  }
  return root;
}

function callerItem(abs: string, name: string, line: number) {
  return {
    name, kind: 12, uri: pathToFileURL(abs).href,
    range: { start: { line, character: 0 }, end: { line: line + 2, character: 1 } },
    selectionRange: { start: { line, character: 9 }, end: { line, character: 9 + name.length } },
  };
}

function site(line: number) {
  return { start: { line, character: 2 }, end: { line, character: 8 } };
}

function readLines(absPath: string): string[] | null {
  try {
    return readFileSync(absPath, "utf8").split("\n");
  } catch {
    return null;
  }
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

function liveSession(root: string, descriptorId: string, c: ExecutorConnection): void {
  const key = `test::${descriptorId}::${testSessionKeys.length}`;
  sessionStore.set(key, { conn: c as never, fingerprint: "test", descriptorId, root: canonicalProjectRoot(root), leases: 0, lastUsed: Date.now() });
  testSessionKeys.push(key);
}

describe("shapeR2IncomingCalls bounds", () => {
  it("pages at 100 callers by default with cursor continuation", () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 3; i += 1) files[`f${i}.ts`] = `function c${i}() {\n  target();\n}\n`;
    const root = makeRoot(files);
    const calls = Array.from({ length: 150 }, (_, i) => {
      const abs = join(root, `f${i % 3}.ts`);
      return { from: callerItem(abs, `caller${i}`, 0), fromRanges: [site(1)] };
    });
    const cursors = new LspCursorStore();
    const first = shapeR2IncomingCalls({ calls, root, readLines, cursors });
    expect(first.result.callers).toHaveLength(100);
    expect(first.truncated).toBe(true);
    expect(typeof first.nextCursor).toBe("string");
    const second = shapeR2IncomingCalls({ calls, root, readLines, cursors, cursor: first.nextCursor });
    expect(second.result.callers).toHaveLength(50);
    expect(second.truncated).toBe(false);
    expect(second.nextCursor).toBeUndefined();
  });

  it("shrinks under the byte bound without cutting mid-object", () => {
    const root = makeRoot({ "a.ts": `function caller() {\n  target();\n  target();\n  target();\n  target();\n}\n` });
    const calls = Array.from({ length: 20 }, (_, i) => ({
      from: callerItem(join(root, "a.ts"), `caller${i}`, 0),
      fromRanges: [site(1), site(2), site(3), site(4), site(1), site(2), site(3), site(4)],
    }));
    const cursors = new LspCursorStore();
    const out = shapeR2IncomingCalls({ calls, root, readLines, cursors, outputBytes: 3000 });
    expect(out.result.callers.length).toBeGreaterThan(0);
    expect(out.result.callers.length).toBeLessThan(20);
    expect(out.truncated).toBe(true);
    expect(typeof out.nextCursor).toBe("string");
    expect(Buffer.byteLength(JSON.stringify(out.result), "utf8")).toBeLessThanOrEqual(3000);
    for (const caller of out.result.callers) {
      expect(caller).toHaveProperty("name");
      expect(caller).toHaveProperty("path");
      expect(caller).toHaveProperty("item");
      expect(Array.isArray(caller.callSites)).toBe(true);
      for (const callSite of caller.callSites) {
        expect(callSite).toHaveProperty("line");
        expect(callSite).toHaveProperty("character");
        expect(callSite).toHaveProperty("text");
      }
    }
    // The cursor continues the same caller list.
    const rest = shapeR2IncomingCalls({ calls, root, readLines, cursors, cursor: out.nextCursor });
    expect(rest.result.callers.length).toBe(20 - out.result.callers.length);
  });

  it("never loses call sites when a page shrinks at a caller boundary", () => {
    const root = makeRoot({ "a.ts": `function a() {\n  target();\n}\nfunction b() {\n  target();\n  target();\n}\n` });
    const abs = join(root, "a.ts");
    const calls = [
      { from: callerItem(abs, "callerA", 0), fromRanges: [site(1)] },
      { from: callerItem(abs, "callerB", 3), fromRanges: [4, 5, 4, 5, 4, 5, 4, 5].map(site) },
    ];
    const full = shapeR2IncomingCalls({ calls, root, readLines, cursors: new LspCursorStore(), outputBytes: 1_000_000 });
    const fullBytes = Buffer.byteLength(JSON.stringify(full.result), "utf8");
    const onlyB = Buffer.byteLength(JSON.stringify({ callers: [full.result.callers[1]], nextCursor: "x".repeat(64) }), "utf8");
    // Each caller fits on a page by itself, but A plus all of B does not, so
    // page 1 must stop at a caller boundary instead of trimming B's call sites.
    const bound = onlyB + 50;
    expect(fullBytes).toBeGreaterThan(bound);
    const cursors = new LspCursorStore();
    const seen: Array<{ name: string; sites: number }> = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const out = shapeR2IncomingCalls({ calls, root, readLines, cursors, outputBytes: bound, ...(cursor ? { cursor } : {}) });
      expect(Buffer.byteLength(JSON.stringify(out.result), "utf8")).toBeLessThanOrEqual(bound);
      for (const c of out.result.callers) {
        expect(c.callSitesOmitted).toBeUndefined();
        seen.push({ name: c.name, sites: c.callSites.length });
      }
      cursor = out.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toEqual([{ name: "callerA", sites: 1 }, { name: "callerB", sites: 8 }]);
  });

  it("states how many call sites were omitted when one caller alone exceeds the bound", () => {
    const root = makeRoot({ "a.ts": `function a() {\n  target();\n  target();\n}\n` });
    const calls = [{
      from: callerItem(join(root, "a.ts"), "callerA", 0),
      fromRanges: Array.from({ length: 40 }, (_, i) => site(1 + (i % 2))),
    }];
    const out = shapeR2IncomingCalls({ calls, root, readLines, cursors: new LspCursorStore(), outputBytes: 1200 });
    expect(Buffer.byteLength(JSON.stringify(out.result), "utf8")).toBeLessThanOrEqual(1200);
    expect(out.result.callers).toHaveLength(1);
    const [only] = out.result.callers;
    expect(only!.callSites.length).toBeGreaterThan(0);
    expect(only!.callSites.length + (only!.callSitesOmitted ?? 0)).toBe(40);
    expect(only!.callSitesOmitted).toBeGreaterThan(0);
  });

  it("rejects continuations bound to a different item", () => {
    const root = makeRoot({ "a.ts": `function caller() {\n  target();\n}\n` });
    const calls = Array.from({ length: 5 }, (_, i) => ({
      from: callerItem(join(root, "a.ts"), `caller${i}`, 0),
      fromRanges: [site(1)],
    }));
    const cursors = new LspCursorStore();
    const first = shapeR2IncomingCalls({
      calls, root, readLines, cursors, limit: 2,
      cursorIdentity: JSON.stringify(["incomingCalls", pathToFileURL(join(root, "a.ts")).href, 5, 9]),
    });
    expect(first.nextCursor).toBeDefined();
    expect(() => shapeR2IncomingCalls({
      calls, root, readLines, cursors, cursor: first.nextCursor,
      cursorIdentity: JSON.stringify(["incomingCalls", pathToFileURL(join(root, "b.ts")).href, 5, 9]),
    })).toThrow("invalid cursor");
  });
});

describe("executor r2 incomingCalls bounds", () => {
  it("applies the default 100-caller page through the executor", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 3; i += 1) files[`f${i}.ts`] = `function c${i}() {\n  target();\n}\n`;
    const root = makeRoot(files);
    const raw = Array.from({ length: 150 }, (_, i) => {
      const abs = join(root, `f${i % 3}.ts`);
      return { from: callerItem(abs, `caller${i}`, 0), fromRanges: [site(1)] };
    });
    const c = conn({
      projectRoot: root,
      getCapabilityRegistry: () => ({ can: () => true }),
      requestImpl: async () => raw,
    });
    liveSession(root, "ts", c);
    const target = callerItem(join(root, "f0.ts"), "target", 0);
    const cursors = new LspCursorStore();
    const first = await executeLspOperation(
      { operation: "incomingCalls", item: target },
      { getManager: () => ({ getServer: async () => null }), cwd: root, cursors, r2: true },
    );
    expect(first.status).toBe("ok");
    const r1 = first.result as { callers: unknown[] };
    expect(r1.callers).toHaveLength(100);
    expect(first.meta.truncated).toBe(true);
    expect(typeof first.meta.nextCursor).toBe("string");
    const second = await executeLspOperation(
      { operation: "incomingCalls", item: target, cursor: first.meta.nextCursor },
      { getManager: () => ({ getServer: async () => null }), cwd: root, cursors, r2: true },
    );
    expect((second.result as { callers: unknown[] }).callers).toHaveLength(50);
    // A different item cannot continue the page.
    await expect(executeLspOperation(
      { operation: "incomingCalls", item: callerItem(join(root, "f1.ts"), "other", 0), cursor: first.meta.nextCursor },
      { getManager: () => ({ getServer: async () => null }), cwd: root, cursors, r2: true },
    )).rejects.toThrow(/invalid cursor/);
  });
});
