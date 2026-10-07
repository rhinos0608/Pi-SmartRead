/** Strict LSP tool tests — Wave 5a. Hermetic: no servers, no IO. */
import { describe, expect, it } from "vitest";
import { createLspTool, LSP_DESCRIPTION } from "../../../src/lsp/lsp-tool.js";
import { ToolRegistry, ToolCategory } from "../../../src/tool-registry.js";

const ctx = { cwd: "/tmp/lsp-tool-test" } as never;

async function run(params: Record<string, unknown>) {
  const tool = createLspTool();
  return (tool.execute as Function)("call-1", params, undefined, undefined, ctx);
}

async function runError(params: Record<string, unknown>): Promise<string> {
  try {
    await run(params);
  } catch (err) {
    return String((err as Error).message);
  }
  throw new Error("expected tool error, got success");
}

describe("lsp-tool", () => {
  it("unknown operation → tool error", async () => {
    expect(await runError({ operation: "nopeNotAnOp" })).toMatch(/unknown operation/);
  });

  it("missing operation → tool error", async () => {
    expect(await runError({})).toMatch(/unknown operation/);
  });

  it("foreign field (hover+query) → error", async () => {
    expect(
      await runError({ operation: "hover", path: "a.ts", position: { line: 0, character: 0 }, query: "x" }),
    ).toMatch(/foreign field "query"/);
  });

  it("request-without-method → error", async () => {
    expect(await runError({ operation: "request", params: {} })).toMatch(/requires field "method"/);
  });

  it("negative position → error", async () => {
    expect(
      await runError({ operation: "hover", path: "a.ts", position: { line: -1, character: 0 } }),
    ).toMatch(/invalid 0-based position/);
  });

  it("negative character → error", async () => {
    expect(
      await runError({ operation: "hover", path: "a.ts", position: { line: 0, character: -2 } }),
    ).toMatch(/invalid 0-based position/);
  });

  it("missing required path (hover) → error", async () => {
    expect(await runError({ operation: "hover", position: { line: 0, character: 0 } })).toMatch(
      /requires field "path"/,
    );
  });

  it("empty path with valid op → unavailable envelope, not throw", async () => {
    const env = await run({ operation: "documentSymbols", path: "missing-file-xyz.ts" });
    expect(env.status).toBe("unavailable");
    expect(env.operation).toBe("documentSymbols");
    expect(env.server.positionEncoding).toBe("utf-16");
  });

  it("missing explicit server → unavailable envelope with intact provenance", async () => {
    const env = await run({
      operation: "workspaceSymbols",
      query: "foo",
      server: "__missing_lsp_server__",
    });
    expect(env.status).toBe("unavailable");
    expect(env.operation).toBe("workspaceSymbols");
    expect(env.server).toMatchObject({ projectRoot: expect.any(String) });
    expect(env.meta).toMatchObject({ truncated: false });
  });

  it("envelope returned verbatim (operation/method/server/result/meta keys)", async () => {
    const env = await run({ operation: "capabilities" });
    expect(Object.keys(env).sort()).toEqual(
      expect.arrayContaining(["status", "operation", "method", "server", "result", "meta"]),
    );
    expect(env.operation).toBe("capabilities");
  });

  it("description mentions read-only + 0-based", () => {
    expect(LSP_DESCRIPTION).toMatch(/read-only/i);
    expect(LSP_DESCRIPTION).toMatch(/0-based/);
  });

  it("description mentions exact server routing + proposals-not-mutations", () => {
    expect(LSP_DESCRIPTION).toMatch(/exact server/i);
    expect(LSP_DESCRIPTION).toMatch(/proposal/i);
  });

  it("tool factory shape: name LSP + parameters object", () => {
    const tool = createLspTool();
    expect(tool.name).toBe("LSP");
    expect(typeof tool.parameters).toBe("object");
  });

  it("registers via ToolRegistry registerOrReplace as READ", () => {
    const tool = createLspTool();
    ToolRegistry.getInstance().registerOrReplace({
      name: "LSP",
      description: tool.description,
      inputSchema: tool.parameters as Record<string, unknown>,
      execute: tool.execute,
      category: ToolCategory.READ,
    });
    const reg = ToolRegistry.getInstance().get("LSP");
    expect(reg?.category).toBe(ToolCategory.READ);
    ToolRegistry.getInstance().registerOrReplace({
      name: "LSP",
      description: tool.description,
      inputSchema: tool.parameters as Record<string, unknown>,
      execute: tool.execute,
      category: ToolCategory.READ,
    });
  });
});
