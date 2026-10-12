import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AFFORDANCE_BOUNDS, type AffordanceExecContext } from "../../../src/lsp/affordance-contract.js";
import { investigateAffordanceTarget } from "../../../src/lsp/affordance-investigate.js";
import { createLspTool } from "../../../src/lsp/lsp-tool.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "r2-inv-")));
  roots.push(root);
  for (const [rel, text] of Object.entries(files)) writeFileSync(join(root, rel), text);
  return root;
}

function envelope(operation: string, result: unknown, status = "ok") {
  return {
    status, operation, method: "test/method",
    server: { descriptorId: "s", name: "s", languageId: "typescript", projectRoot: "/tmp", positionEncoding: "utf-16" as const },
    result, meta: { truncated: false },
  };
}

function loc(abs: string, line: number, character: number) {
  return {
    uri: pathToFileURL(abs).href,
    range: { start: { line, character }, end: { line, character: character + 3 } },
  };
}

function ctxFor(root: string, symbolsByBase: Record<string, unknown[]>, opts?: { r2?: boolean; maxRequests?: number }) {
  const calls: unknown[] = [];
  const ctx: AffordanceExecContext = {
    root,
    budget: { maxCandidates: 100, maxRequests: opts?.maxRequests ?? 6, deadlineMs: 15000 },
    ...(opts?.r2 === true ? { r2: true as const } : {}),
    exec: (async (req: unknown) => {
      calls.push(req);
      const op = (req as { operation: string }).operation;
      if (op === "findReferences") {
        return envelope("findReferences", [
          loc(join(root, "a.ts"), 0, 17),
          loc(join(root, "b.ts"), 0, 9),
        ]);
      }
      if (op === "documentSymbols") {
        const p = (req as { path: string }).path;
        return envelope("documentSymbols", symbolsByBase[basename(p)] ?? []);
      }
      throw new Error(`unexpected ${op}`);
    }) as AffordanceExecContext["exec"],
  };
  return { ctx, calls };
}

describe("investigate references in r2", () => {
  it("returns the shaped reference result with the task wrapper", async () => {
    const root = makeRoot({
      "a.ts": `export function foo() { return 1; }\n`,
      "b.ts": `import { foo } from "./a";\n`,
    });
    const { ctx } = ctxFor(root, {
      "a.ts": [{ name: "foo", kind: 12, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 38 } }, selectionRange: { start: { line: 0, character: 16 }, end: { line: 0, character: 19 } } }],
    }, { r2: true });
    const out = await investigateAffordanceTarget(
      { operation: "investigate", task: "references", path: "a.ts", position: { line: 0, character: 17 } },
      ctx,
    );
    expect(out.status).toBe("ok");
    const result = out.result as { task: string; total: number; returned: number; files: Array<{ path: string; refs: Array<{ role: string }> }> };
    expect(result.task).toBe("references");
    expect(result.total).toBe(2);
    expect(result.returned).toBe(2);
    expect(result.files.map((f) => f.path)).toEqual(["a.ts", "b.ts"]);
    expect(result.files[0]!.refs[0]).toMatchObject({ role: "declaration" });
    expect(result.files[1]!.refs[0]).toMatchObject({ role: "import" });
    // Every strict envelope stays verbatim in steps.
    expect(out.steps.map((s) => s.id)).toEqual(["investigate.references", "references.symbols", "references.symbols"]);
  });

  it("keeps the legacy references projection without the r2 flag", async () => {
    const root = makeRoot({ "a.ts": `export function foo() { return 1; }\n` });
    const { ctx } = ctxFor(root, {});
    const out = await investigateAffordanceTarget(
      { operation: "investigate", task: "references", path: "a.ts", position: { line: 0, character: 17 } },
      ctx,
    );
    const result = out.result as { task: string; count: number; items: unknown[] };
    expect(result.task).toBe("references");
    expect(result.count).toBe(2);
    expect(Array.isArray(result.items)).toBe(true);
    expect(result).not.toHaveProperty("files");
  });

  it("applies scope in r2 and reports the echo and filtered count", async () => {
    const root = makeRoot({
      "a.ts": `export function foo() { return 1; }\n`,
      "b.ts": `import { foo } from "./a";\n`,
    });
    const { ctx } = ctxFor(root, {}, { r2: true });
    const out = await investigateAffordanceTarget(
      { operation: "investigate", task: "references", path: "a.ts", position: { line: 0, character: 17 }, scope: "b.ts" },
      ctx,
    );
    const result = out.result as { scope?: string; filteredOutByScope?: number; returned: number; files: Array<{ path: string }> };
    expect(result.scope).toBe("b.ts");
    expect(result.filteredOutByScope).toBe(1);
    expect(result.returned).toBe(1);
    expect(result.files.map((f) => f.path)).toEqual(["b.ts"]);
  });

  it("marks enclosingIncomplete when the shared request budget runs out", async () => {
    const root = makeRoot({
      "a.ts": `export function foo() { return 1; }\n`,
      "b.ts": `import { foo } from "./a";\n`,
    });
    // findReferences (1) + one documentSymbols (1) exhaust maxRequests 2.
    const { ctx, calls } = ctxFor(root, { "a.ts": [], "b.ts": [] }, { r2: true, maxRequests: 2 });
    const out = await investigateAffordanceTarget(
      { operation: "investigate", task: "references", path: "a.ts", position: { line: 0, character: 17 } },
      ctx,
    );
    expect(calls).toHaveLength(2);
    const result = out.result as { returned: number; enclosingIncomplete?: boolean };
    expect(result.returned).toBe(2);
    expect(result.enclosingIncomplete).toBe(true);
  });

  it("shrinks an over-bound page instead of truncating mid-object", async () => {
    // 100 files fill the default page; long names, full 200-char texts, and
    // long enclosing names push the projection past 48 KiB so the byte
    // bound (not the count) truncates.
    const bigName = `F${"n".repeat(1500)}`;
    const files: Record<string, string> = {};
    for (let i = 0; i < 100; i += 1) {
      const name = `f${i}-` + "x".repeat(140) + ".ts";
      const prefix = `v${i}(); // `;
      files[name] = prefix + "y".repeat(200 - prefix.length) + "\n";
    }
    const root = makeRoot(files);
    const rels = Object.keys(files);
    const calls: unknown[] = [];
    const ctx: AffordanceExecContext = {
      root,
      budget: { maxCandidates: 100, maxRequests: 6, deadlineMs: 15000 },
      r2: true,
      exec: (async (req: unknown) => {
        calls.push(req);
        const op = (req as { operation: string }).operation;
        if (op === "findReferences") {
          return envelope("findReferences", rels.map((rel) => loc(join(root, rel), 0, 0)));
        }
        if (op === "documentSymbols") {
          return envelope("documentSymbols", [{
            name: bigName, kind: 12,
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 250 } },
            selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
          }]);
        }
        throw new Error(`unexpected ${op}`);
      }) as AffordanceExecContext["exec"],
    };
    const out = await investigateAffordanceTarget(
      { operation: "investigate", task: "references", path: rels[0]!, position: { line: 0, character: 0 } },
      ctx,
    );
    const result = out.result as {
      total: number; returned: number; truncated: boolean; nextCursor?: string;
      files: Array<{ path: string; refs: Array<{ line: number; character: number; role: string; enclosing: null; text: string }> }>;
    };
    expect(result.total).toBe(100);
    expect(result.returned).toBeGreaterThan(0);
    expect(result.returned).toBeLessThan(100);
    expect(result.truncated).toBe(true);
    expect(typeof result.nextCursor).toBe("string");
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(AFFORDANCE_BOUNDS.outputBytes);
    for (const group of result.files) {
      expect(typeof group.path).toBe("string");
      expect(group.refs.length).toBeGreaterThan(0);
      for (const ref of group.refs) {
        expect(ref).toHaveProperty("line");
        expect(ref).toHaveProperty("character");
        expect(ref).toHaveProperty("role");
        expect(ref).toHaveProperty("enclosing");
        expect(ref).toHaveProperty("text");
      }
    }
  });

  it("serves investigate references through the r2 tool with raw dispatches", async () => {
    const root = makeRoot({
      "a.ts": `export function foo() { return 1; }\n`,
      "b.ts": `import { foo } from "./a";\n`,
    });
    const calls: unknown[] = [];
    const tool = createLspTool({
      r2: true,
      getCwd: () => root,
      executeOperation: (async (req: unknown) => {
        calls.push(req);
        const op = (req as { operation: string }).operation;
        if (op === "findReferences") {
          return envelope("findReferences", [loc(join(root, "a.ts"), 0, 17), loc(join(root, "b.ts"), 0, 9)]);
        }
        if (op === "documentSymbols") return envelope("documentSymbols", []);
        throw new Error(`unexpected ${op}`);
      }) as never,
    });
    const out = await (tool.execute as (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }>)(
      "call",
      { operation: "investigate", task: "references", path: "a.ts", position: { line: 0, character: 17 } },
      undefined, undefined, { cwd: root },
    );
    const body = JSON.parse(out.content[0]!.text) as { result: { task: string; total: number; files: Array<{ path: string }> } };
    expect(body.result.task).toBe("references");
    expect(body.result.total).toBe(2);
    expect(body.result.files.map((f) => f.path)).toEqual(["a.ts", "b.ts"]);
    // Internal dispatches stay raw arrays under the shared budget; the
    // recipe shapes the projection itself.
    expect((calls[0] as { operation: string }).operation).toBe("findReferences");
    expect(calls.map((c) => (c as { operation: string }).operation)).toContain("documentSymbols");
  });
});
