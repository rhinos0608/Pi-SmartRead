import { mkdtemp, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSourceRoutingExecutor } from "../../../scripts/eval/lsp-ergonomics/source-routing.js";
import { createLspTool } from "../../../src/lsp/lsp-tool.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

function envelope(request: Record<string, unknown>, server = "server-A", encoding = "utf-32") {
  return { status: "ok", operation: request.operation, method: request.operation === "documentSymbols" ? "textDocument/documentSymbol" : `textDocument/${request.operation}`, result: [], server: { descriptorId: server, name: "test", languageId: "typescript", projectRoot: "/", positionEncoding: encoding }, meta: { truncated: false } };
}

describe("source-address routing", () => {
  it("composes with the real LSP factory execute type", () => {
    const tool = createLspTool();
    tool.execute = createSourceRoutingExecutor(tool.execute);
    expect(typeof tool.execute).toBe("function");
  });
  it("bootstraps actual encoding, routes located UTF-16 source position, and pins descriptor", async () => {
    const dir = await mkdtemp(join(tmpdir(), "source-routing-")); dirs.push(dir);
    const file = join(dir, "sample.ts"); await writeFile(file, "const face = '😀';\r\nfunction target() {}\n");
    const calls: Record<string, unknown>[] = [];
    const original = vi.fn(async (_id, request) => envelope(request));
    const executeOperation = vi.fn(async (request: Record<string, unknown>) => { calls.push(request); return envelope(request); });
    const execute = createSourceRoutingExecutor(original as never, { executeOperation: executeOperation as never });
    await execute("id", { operation: "goToDefinition", source: { path: file, line: 2, identifier: "target" } }, undefined, undefined, { cwd: dir } as never);
    expect(calls.map((call) => call.operation)).toEqual(["documentSymbols", "goToDefinition"]);
    expect(calls[1]).toMatchObject({ path: await realpath(file), position: { line: 1, character: 9 }, server: "server-A" });
  });

  it("rejects a source replaced during bootstrap before deriving an LSP position", async () => {
    const dir = await mkdtemp(join(tmpdir(), "source-routing-")); dirs.push(dir);
    const file = join(dir, "sample.ts"); await writeFile(file, "function target() {}\n");
    const original = vi.fn(async (_id, request) => envelope(request));
    const executeOperation = vi.fn(async (request: Record<string, unknown>) => {
      if (request.operation === "documentSymbols") await writeFile(file, "function changed() {}\n");
      return envelope(request);
    });
    const execute = createSourceRoutingExecutor(original as never, { executeOperation: executeOperation as never });
    const result = await execute("id", { operation: "hover", source: { path: file, line: 1, identifier: "target" } }, undefined, undefined, { cwd: dir } as never) as { content: Array<{ text: string }>; details: Record<string, unknown> };
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ status: "not_ready", result: null, error: { code: "source-stale" } });
    expect(result.details).toHaveProperty("bootstrap");
    expect(executeOperation).toHaveBeenCalledTimes(1);
  });

  it("returns bounded output metadata and full details for a single oversized envelope", async () => {
    const dir = await mkdtemp(join(tmpdir(), "source-routing-")); dirs.push(dir);
    const file = join(dir, "sample.ts"); await writeFile(file, "function target() {}\n");
    const original = vi.fn(async (_id, request) => envelope(request));
    const executeOperation = vi.fn(async (request: Record<string, unknown>) => ({ ...envelope(request), result: "x".repeat(60_000) }));
    const execute = createSourceRoutingExecutor(original as never, { executeOperation: executeOperation as never });
    const result = await execute("id", { operation: "hover", source: { path: file, line: 1, identifier: "target" } }, undefined, undefined, { cwd: dir } as never) as { content: Array<{ text: string }>; details: { envelope: unknown } };
    const rendered = JSON.parse(result.content[0]!.text);
    expect(rendered).toMatchObject({ status: "error", result: null, error: { code: "output-limit" }, meta: { truncated: true } });
    expect(result.details.envelope).toMatchObject({ status: "ok", result: "x".repeat(60_000) });
  });

  it("forwards includeDeclaration only for findReferences source requests", async () => {
    const dir = await mkdtemp(join(tmpdir(), "source-routing-")); dirs.push(dir);
    const file = join(dir, "sample.ts"); await writeFile(file, "function target() {}\n");
    const original = vi.fn(async (_id, request) => envelope(request));
    const executeOperation = vi.fn(async (request: Record<string, unknown>) => envelope(request));
    const execute = createSourceRoutingExecutor(original as never, { executeOperation: executeOperation as never });
    await execute("id", { operation: "findReferences", source: { path: file, line: 1, identifier: "target" }, includeDeclaration: false }, undefined, undefined, { cwd: dir } as never);
    expect(executeOperation).toHaveBeenLastCalledWith(expect.objectContaining({ operation: "findReferences", includeDeclaration: false }), expect.anything());
  });

  it("rejects operation-inappropriate source fields before bootstrap", async () => {
    const dir = await mkdtemp(join(tmpdir(), "source-routing-")); dirs.push(dir);
    const file = join(dir, "sample.ts"); await writeFile(file, "function target() {}\\n");
    const original = vi.fn(async (_id, request) => envelope(request));
    const executeOperation = vi.fn(async (request: Record<string, unknown>) => envelope(request));
    const execute = createSourceRoutingExecutor(original as never, { executeOperation: executeOperation as never });
    await expect(execute("id", { operation: "hover", source: { path: file, line: 1, identifier: "target" }, includeDeclaration: true }, undefined, undefined, { cwd: dir } as never)).rejects.toThrow(/field/i);
    expect(executeOperation).not.toHaveBeenCalled();
  });

  it("returns all displayed ambiguous candidates and rejects malformed targets before dispatch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "source-routing-")); dirs.push(dir);
    const file = join(dir, "sample.ts"); await writeFile(file, "const x = 1; x();\n");
    const original = vi.fn(async (_id, request) => envelope(request));
    const executeOperation = vi.fn(async (request: Record<string, unknown>) => envelope(request));
    const execute = createSourceRoutingExecutor(original as never, { executeOperation: executeOperation as never });
    const ambiguous = await execute("id", { operation: "hover", source: { path: file, line: 1, identifier: "x" } }, undefined, undefined, { cwd: dir } as never) as { content: Array<{ text: string }> };
    expect(JSON.parse(ambiguous.content[0]!.text)).toMatchObject({ status: "ambiguous", result: { totalMatches: 2, displayedMatches: [{ character: 6 }, { character: 13 }] }, error: { message: expect.stringMatching(/occurrence/i) } });
    const missing = await execute("id", { operation: "hover", source: { path: file, line: 1, identifier: "x", occurrence: 3 } }, undefined, undefined, { cwd: dir } as never) as { content: Array<{ text: string }> };
    expect(JSON.parse(missing.content[0]!.text)).toMatchObject({ status: "empty", result: null });
    expect(executeOperation).not.toHaveBeenCalled();
    await expect(execute("id", { operation: "hover", source: { path: file, line: 0, identifier: "x" } }, undefined, undefined, { cwd: dir } as never)).rejects.toThrow(/source/i);
    expect(executeOperation).not.toHaveBeenCalled();
    expect(original).not.toHaveBeenCalled();
  });

  it("returns the bootstrap refusal envelope without throwing when server metadata is absent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "source-routing-")); dirs.push(dir);
    const file = join(dir, "sample.ts"); await writeFile(file, "function target() {}");
    const executeOperation = vi.fn(async (request: Record<string, unknown>) => {
      const { server: _server, ...withoutServer } = envelope(request);
      return withoutServer;
    });
    const execute = createSourceRoutingExecutor(vi.fn() as never, { executeOperation: executeOperation as never });
    const result = await execute("id", { operation: "hover", source: { path: file, line: 1, identifier: "target" } }, undefined, undefined, { cwd: dir } as never) as { content: Array<{ text: string }> };
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ status: "error", result: null, error: { code: "source-bootstrap" } });
    expect(executeOperation).toHaveBeenCalledTimes(1);
  });

  it("preserves a pre-acquisition unavailable refusal without server metadata", async () => {
    const dir = await mkdtemp(join(tmpdir(), "source-routing-")); dirs.push(dir);
    const file = join(dir, "sample.ts"); await writeFile(file, "function target() {}");
    const executeOperation = vi.fn(async (request: Record<string, unknown>) => {
      const { server: _server, ...withoutServer } = envelope(request);
      return { ...withoutServer, status: "unavailable", error: { code: "no-session", message: "no session" } };
    });
    const execute = createSourceRoutingExecutor(vi.fn() as never, { executeOperation: executeOperation as never });
    const result = await execute("id", { operation: "hover", source: { path: file, line: 1, identifier: "target" } }, undefined, undefined, { cwd: dir } as never) as { content: Array<{ text: string }> };
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ status: "unavailable", result: null, error: { code: "no-session" } });
    expect(executeOperation).toHaveBeenCalledTimes(1);
  });

  it("returns unsupported for unsupported source extensions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "source-routing-")); dirs.push(dir);
    const executeOperation = vi.fn(async (request: Record<string, unknown>) => envelope(request));
    const execute = createSourceRoutingExecutor(vi.fn() as never, { executeOperation: executeOperation as never });
    const result = await execute("id", { operation: "hover", source: { path: join(dir, "file.txt"), line: 1, identifier: "target" } }, undefined, undefined, { cwd: dir } as never) as { content: Array<{ text: string }> };
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ status: "unsupported", result: null, error: { code: "source-unsupported" } });
  });

  it("returns cancelled when the signal is already aborted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "source-routing-")); dirs.push(dir);
    const file = join(dir, "sample.ts"); await writeFile(file, "function target() {}\\n");
    const executeOperation = vi.fn(async (request: Record<string, unknown>) => envelope(request));
    const execute = createSourceRoutingExecutor(vi.fn() as never, { executeOperation: executeOperation as never });
    const controller = new AbortController(); controller.abort();
    const result = await execute("id", { operation: "hover", source: { path: file, line: 1, identifier: "target" } }, controller.signal, undefined, { cwd: dir } as never) as { content: Array<{ text: string }> };
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ status: "cancelled", result: null });
    expect(executeOperation).not.toHaveBeenCalled();
  });
});
