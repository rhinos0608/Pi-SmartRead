import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLspTool } from "../../../src/lsp/lsp-tool.js";
import { AFFORDANCE_BOUNDS } from "../../../src/lsp/affordance-contract.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function envelope(operation: string, result: unknown, status = "ok") {
  return {
    status, operation, method: "test/method",
    server: { descriptorId: "exact-server", name: "test", languageId: "ts", projectRoot: "/tmp", positionEncoding: "utf-16" },
    result, meta: { truncated: false },
  };
}

describe("LSP affordance bundle", () => {
  it("adds only the opt-in affordance schema", () => {
    const schema = createLspTool({ affordances: true }).parameters as any;
    expect(schema.properties.operation.enum).toContain("investigate");
    expect(schema.properties.symbol).toBeDefined();
    expect(schema.properties.task).toBeDefined();
    expect((createLspTool().parameters as any).properties.operation.enum).not.toContain("investigate");
    expect((createLspTool().parameters as any).properties).not.toHaveProperty("symbol");
  });

  it("executes an investigate recipe and preserves its strict envelope", async () => {
    const root = mkdtempSync(join(tmpdir(), "lsp-affordance-"));
    roots.push(root);
    const calls: unknown[] = [];
    const tool = createLspTool({
      affordances: true,
      getCwd: () => root,
      executeOperation: async (request) => {
        calls.push(request);
        return envelope("hover", { contents: "number" }) as any;
      },
    });
    const result = await (tool.execute as Function)("call", {
      operation: "investigate", task: "type", path: "file.ts", position: { line: 2, character: 4 },
    }, undefined, undefined, { cwd: root });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ operation: "hover", position: { line: 2, character: 4 } });
    expect(result.details.investigation.steps[0].envelope).toEqual(envelope("hover", { contents: "number" }));
    expect(result.details.envelope.status).toBe("ok");
  });

  it("resolves a symbol anchor before dispatch and keeps both strict envelopes", async () => {
    const root = mkdtempSync(join(tmpdir(), "lsp-anchor-tool-"));
    roots.push(root);
    const file = join(root, "file.ts");
    writeFileSync(file, "function run() {}\n");
    const calls: unknown[] = [];
    const tool = createLspTool({
      affordances: true,
      getCwd: () => root,
      executeOperation: async (request) => {
        calls.push(request);
        if ((request as any).operation === "documentSymbols") {
          return envelope("documentSymbols", [{ name: "run", selectionRange: { start: { line: 3, character: 2 }, end: { line: 3, character: 5 } }, selectionProvenance: "explicit", children: [] }]) as any;
        }
        return envelope("goToDefinition", [{ uri: "file:///definition.ts" }]) as any;
      },
    });
    const result = await (tool.execute as Function)("call", { operation: "goToDefinition", symbol: "run", path: file }, undefined, undefined, { cwd: root });
    expect(calls.map((request: any) => request.operation)).toEqual(["documentSymbols", "goToDefinition"]);
    expect(calls[1]).toMatchObject({ path: realpathSync(file), position: { line: 3, character: 2 }, server: "exact-server" });
    expect(result.details.investigation.steps.map((step: any) => step.envelope.operation)).toEqual(["documentSymbols", "goToDefinition"]);
  });

  it("refuses a symbol dispatch when the anchor file changes during lookup", async () => {
    const root = mkdtempSync(join(tmpdir(), "lsp-stale-anchor-"));
    roots.push(root);
    const file = join(root, "file.ts");
    writeFileSync(file, "function run() {}\n");
    const calls: unknown[] = [];
    const tool = createLspTool({
      affordances: true,
      getCwd: () => root,
      executeOperation: async (request) => {
        calls.push(request);
        writeFileSync(file, "function run() { return 1; }\n");
        return envelope("documentSymbols", [{ name: "run", selectionRange: { start: { line: 0, character: 9 }, end: { line: 0, character: 12 } }, selectionProvenance: "explicit", children: [] }]) as any;
      },
    });
    const result = await (tool.execute as Function)("call", { operation: "goToDefinition", symbol: "run", path: file }, undefined, undefined, { cwd: root });
    expect(calls).toHaveLength(1);
    expect(result.details.envelope.error.code).toBe("stale_anchor");
  });

  it("bounds oversized affordance content while retaining full step envelopes", async () => {
    const root = mkdtempSync(join(tmpdir(), "lsp-output-bound-"));
    roots.push(root);
    const file = join(root, "file.ts");
    writeFileSync(file, "function run() {}\n");
    const large = "x".repeat(AFFORDANCE_BOUNDS.outputBytes * 2);
    const anchoredTool = createLspTool({
      affordances: true,
      getCwd: () => root,
      executeOperation: async (request) => (request as any).operation === "documentSymbols"
        ? envelope("documentSymbols", [{ name: "run", selectionRange: { start: { line: 0, character: 9 }, end: { line: 0, character: 12 } }, selectionProvenance: "explicit", children: [] }]) as any
        : envelope("goToDefinition", [{ detail: large }]) as any,
    });
    const anchored = await (anchoredTool.execute as Function)("call", { operation: "goToDefinition", symbol: "run", path: file }, undefined, undefined, { cwd: root });
    expect(Buffer.byteLength(anchored.content[0].text, "utf8")).toBeLessThanOrEqual(AFFORDANCE_BOUNDS.outputBytes);
    expect(JSON.parse(anchored.content[0].text).error.code).toBe("output-limit");
    expect(JSON.parse(anchored.content[0].text).meta.truncated).toBe(true);
    expect(anchored.details.investigation.steps[1].envelope.result[0].detail).toBe(large);

    const investigateTool = createLspTool({
      affordances: true,
      executeOperation: async () => envelope("workspaceSymbols", [{ name: large, uri: "file:///tmp/known.ts" }]) as any,
    });
    const investigated = await (investigateTool.execute as Function)("call", {
      operation: "investigate", task: "references", symbol: "run",
    }, undefined, undefined, { cwd: root });
    expect(Buffer.byteLength(investigated.content[0].text, "utf8")).toBeLessThanOrEqual(AFFORDANCE_BOUNDS.outputBytes);
    expect(JSON.parse(investigated.content[0].text).meta.truncated).toBe(true);
    expect(investigated.details.investigation.steps[0].envelope.result[0].name).toBe(large);
  });

  it("rejects malformed anchor paths instead of treating them as pathless discovery", async () => {
    let calls = 0;
    const tool = createLspTool({ affordances: true, executeOperation: async () => { calls += 1; return envelope("workspaceSymbols", []) as any; } });
    const runError = async (path: unknown) => {
      try { await (tool.execute as Function)("call", { operation: "goToDefinition", symbol: "run", path }, undefined, undefined, { cwd: process.cwd() }); }
      catch (error) { return (error as Error).message; }
      throw new Error("expected path validation error");
    };
    for (const path of [42, null, ""]) expect(await runError(path)).toMatch(/path/);
    const investigateError = async (path: unknown) => {
      try {
        await (tool.execute as Function)("call", { operation: "investigate", task: "type", symbol: "run", path }, undefined, undefined, { cwd: process.cwd() });
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error("expected investigate path validation error");
    };
    for (const path of [42, null, ""]) expect(await investigateError(path)).toMatch(/path/);
    expect(calls).toBe(0);
  });

  it("returns cancellation status when aborted after anchor resolution", async () => {
    const root = mkdtempSync(join(tmpdir(), "lsp-cancel-anchor-"));
    roots.push(root);
    const file = join(root, "file.ts");
    writeFileSync(file, "function run() {}\n");
    const controller = new AbortController();
    const calls: unknown[] = [];
    const tool = createLspTool({
      affordances: true,
      getCwd: () => root,
      executeOperation: async (request) => {
        calls.push(request);
        controller.abort();
        return envelope("documentSymbols", [{ name: "run", selectionRange: { start: { line: 0, character: 9 }, end: { line: 0, character: 12 } }, selectionProvenance: "explicit", children: [] }]) as any;
      },
    });
    const result = await (tool.execute as Function)("call", { operation: "goToDefinition", symbol: "run", path: file }, controller.signal, undefined, { cwd: root });
    expect(calls).toHaveLength(1);
    expect(result.details.envelope.status).toBe("cancelled");
    expect(result.details.envelope.error.code).toBe("cancelled");
  });

  it("rejects foreign fields and invalid target XOR before dispatch", async () => {
    let calls = 0;
    const tool = createLspTool({ affordances: true, executeOperation: async () => { calls += 1; return envelope("hover", null) as any; } });
    const runError = async (params: Record<string, unknown>) => {
      try { await (tool.execute as Function)("call", params, undefined, undefined, { cwd: process.cwd() }); }
      catch (error) { return (error as Error).message; }
      throw new Error("expected validation error");
    };
    expect(await runError({ operation: "investigate", task: "unknown", path: "x", position: { line: 0, character: 0 } })).toMatch(/unknown task/);
    expect(await runError({ operation: "investigate", task: "type", path: "x", position: { line: 0, character: 0 }, extra: true })).toMatch(/foreign field/);
    expect(calls).toBe(0);
  });
});
