import { describe, expect, it } from "vitest";
import { createLspTool } from "../../../src/lsp/lsp-tool.js";
import { validateStrictRequest } from "../../../src/lsp/lsp-strict-contract.js";

describe("findReferences scope gating (stage A, r2 only)", () => {
  const base = {
    operation: "findReferences",
    path: "src/a.ts",
    position: { line: 1, character: 2 },
  } as const;

  it("rejects scope as a foreign field on the baseline surface", () => {
    const out = validateStrictRequest({ ...base, scope: "src" });
    expect(out.ok).toBe(false);
    expect(out.ok ? "" : out.error).toMatch(/foreign field "scope"/);
  });

  it("rejects scope on round-1-equivalent validation (no variant flag)", () => {
    const out = validateStrictRequest({ ...base, scope: "src" }, {});
    expect(out.ok).toBe(false);
    expect(out.ok ? "" : out.error).toMatch(/foreign field "scope"/);
  });

  it("accepts scope on findReferences only in r2", () => {
    const out = validateStrictRequest({ ...base, scope: "src" }, { r2: true });
    expect(out).toEqual({ ok: true, value: { ...base, scope: "src" } });
  });

  it("still rejects scope on other operations in r2", () => {
    const hover = validateStrictRequest(
      { operation: "hover", path: "src/a.ts", position: { line: 0, character: 0 }, scope: "src" },
      { r2: true },
    );
    expect(hover.ok).toBe(false);
    expect(hover.ok ? "" : hover.error).toMatch(/foreign field "scope"/);
  });

  it("rejects an empty scope in r2", () => {
    const out = validateStrictRequest({ ...base, scope: "" }, { r2: true });
    expect(out.ok).toBe(false);
    expect(out.ok ? "" : out.error).toMatch(/scope must be a non-empty string/);
  });
});

describe("r2 tool surface", () => {
  it("carries the stage-B description while round-1 stays byte-identical", () => {
    const r1 = createLspTool({ affordances: true });
    const r2 = createLspTool({ affordances: true, r2: true });
    expect(r2.description).not.toBe(r1.description);
    expect(r2.description).toContain("grouped by file");
    const r2scope = (r2.parameters as { properties: { scope: { description: string } } }).properties.scope;
    const r1scope = (r1.parameters as { properties: { scope: { description: string } } }).properties.scope;
    expect(r2scope.description).toMatch(/findReferences/);
    expect(r1scope.description).toContain("investigate only");
  });

  it("rejects scope at the tool boundary without r2 and dispatches with r2", async () => {
    let calls = 0;
    const envelope = {
      status: "ok", operation: "findReferences", method: "textDocument/references",
      server: { descriptorId: "s", name: "s", languageId: "typescript", projectRoot: "/tmp", positionEncoding: "utf-16" },
      result: [], meta: { truncated: false },
    };
    const runError = async (tool: { execute: unknown }, params: Record<string, unknown>) => {
      try {
        await (tool.execute as (...args: unknown[]) => Promise<unknown>)("call", params, undefined, undefined, { cwd: process.cwd() });
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error("expected validation error");
    };
    const legacy = createLspTool({
      affordances: true,
      executeOperation: (async () => { calls += 1; return envelope; }) as never,
    });
    expect(await runError(legacy, { ...{ operation: "findReferences", path: "a.ts", position: { line: 0, character: 0 } }, scope: "src" }))
      .toMatch(/foreign field "scope"/);
    expect(calls).toBe(0);
    const r2 = createLspTool({
      r2: true,
      executeOperation: (async () => { calls += 1; return envelope; }) as never,
    });
    await (r2.execute as (...args: unknown[]) => Promise<unknown>)("call", {
      operation: "findReferences", path: "a.ts", position: { line: 0, character: 0 }, scope: "src",
    }, undefined, undefined, { cwd: process.cwd() });
    expect(calls).toBe(1);
  });
});
