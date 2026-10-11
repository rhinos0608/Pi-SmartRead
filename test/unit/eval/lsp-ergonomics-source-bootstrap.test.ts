import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createSourceRoutingExecutor } from "../../../scripts/eval/lsp-ergonomics/source-routing.js";
import { createLspTool } from "../../../src/lsp/lsp-tool.js";
import type { ExecutorDeps } from "../../../src/lsp/lsp-executor.js";
import { validateStrictRequest, type StrictEnvelope, type StrictRequest } from "../../../src/lsp/lsp-strict-contract.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

function makeEnvelope(request: StrictRequest, overrides: Partial<StrictEnvelope> = {}): StrictEnvelope {
  return {
    status: "ok", operation: request.operation, method: request.operation === "documentSymbols" ? "textDocument/documentSymbol" : "textDocument/hover",
    server: { descriptorId: "server-A", name: "test", languageId: "typescript", projectRoot: "/", positionEncoding: "utf-16" },
    result: [], meta: { truncated: false }, ...overrides,
  };
}
function context(cwd: string): ExtensionContext { return { cwd } as ExtensionContext; }
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "source-bootstrap-")); dirs.push(dir);
  const file = join(dir, "sample.ts"); await writeFile(file, "function target() {}\n");
  return { dir, file };
}
function executeWith(bootstrap: StrictEnvelope, later?: StrictEnvelope) {
  const calls: StrictRequest[] = [];
  const fake = async (request: unknown, _deps?: ExecutorDeps): Promise<StrictEnvelope> => {
    const validated = validateStrictRequest(request);
    if (!validated.ok) throw new Error(validated.error);
    calls.push(validated.value);
    return validated.value.operation === "documentSymbols" ? bootstrap : later ?? makeEnvelope(validated.value);
  };
  const tool = createLspTool({ executeOperation: fake });
  const execute = createSourceRoutingExecutor(tool.execute, { executeOperation: fake });
  return { execute, calls };
}
function rendered(result: Awaited<ReturnType<ReturnType<typeof createLspTool>["execute"]>>) {
  const text = result.content[0];
  if (!text || text.type !== "text") throw new Error("expected text output");
  if (typeof result.details !== "object" || result.details === null) throw new Error("expected details output");
  return { text: text.text, details: result.details as { envelope?: StrictEnvelope; steps?: Array<{ envelope: StrictEnvelope }> } };
}

describe("source router bootstrap admission", () => {
  it("does not navigate on plausible metadata from a failed bootstrap, and preserves it", async () => {
    const { dir, file } = await fixture();
    const request: StrictRequest = { operation: "documentSymbols", path: await realpath(file) };
    const failed = makeEnvelope(request, { status: "unavailable", error: { code: "no-server", message: "not acquired" } });
    const { execute, calls } = executeWith(failed);
    const result = await execute("id", { operation: "hover", source: { path: file, line: 1, identifier: "target" } }, undefined, undefined, context(dir));
    expect(calls).toHaveLength(1);
    const output = rendered(result);
    expect(output.details).toMatchObject({ steps: [{ envelope: failed }] });
    expect(JSON.parse(output.text)).toMatchObject({ status: "unavailable", operation: "hover", error: { code: "no-server" } });
  });

  it("admits empty initialized symbols and preserves bootstrap and semantic envelopes", async () => {
    const { dir, file } = await fixture();
    const request: StrictRequest = { operation: "documentSymbols", path: await realpath(file) };
    const bootstrap = makeEnvelope(request, { status: "empty", result: null });
    const semantic = makeEnvelope({ operation: "hover", path: file, position: { line: 0, character: 9 } });
    const { execute, calls } = executeWith(bootstrap, semantic);
    const result = await execute("id", { operation: "hover", source: { path: file, line: 1, identifier: "target" } }, undefined, undefined, context(dir));
    expect(calls.map((call) => call.operation)).toEqual(["documentSymbols", "hover"]);
    const output = rendered(result);
    expect(output.details.steps?.map((step) => step.envelope)).toEqual([bootstrap, semantic]);
    expect(output.details.envelope).toEqual(semantic);
  });

  it.each([
    ["unknown descriptor", { server: { descriptorId: "unknown", name: "test", languageId: "typescript", projectRoot: "/", positionEncoding: "utf-16" } }, "error", "source-bootstrap"],
    ["invalid encoding", { server: { descriptorId: "server-A", name: "test", languageId: "typescript", projectRoot: "/", positionEncoding: "latin-1" } }, "error", "source-bootstrap"],
    ["stale document", { meta: { truncated: false, freshness: { state: "stale" } } }, "not_ready", "source-stale"],
  ])("rejects %s before navigation", async (_name, overrides, status, code) => {
    const { dir, file } = await fixture();
    const request: StrictRequest = { operation: "documentSymbols", path: await realpath(file) };
    const bootstrap = makeEnvelope(request, overrides as Partial<StrictEnvelope>);
    const { execute, calls } = executeWith(bootstrap);
    const result = await execute("id", { operation: "hover", source: { path: file, line: 1, identifier: "target" } }, undefined, undefined, context(dir));
    expect(calls).toHaveLength(1);
    expect(JSON.parse(rendered(result).text)).toMatchObject({ status, error: { code } });
  });

  it("routes from successful truncated metadata without treating symbols as complete", async () => {
    const { dir, file } = await fixture();
    const request: StrictRequest = { operation: "documentSymbols", path: await realpath(file) };
    const bootstrap = makeEnvelope(request, { result: [], meta: { truncated: true } });
    const { execute, calls } = executeWith(bootstrap);
    await execute("id", { operation: "hover", source: { path: file, line: 1, identifier: "target" } }, undefined, undefined, context(dir));
    expect(calls.map((call) => call.operation)).toEqual(["documentSymbols", "hover"]);
    expect(bootstrap.meta.truncated).toBe(true);
  });

  it("rejects an exact-server conflict before navigation", async () => {
    const { dir, file } = await fixture();
    const request: StrictRequest = { operation: "documentSymbols", path: await realpath(file) };
    const { execute, calls } = executeWith(makeEnvelope(request));
    const result = await execute("id", { operation: "hover", server: "server-B", source: { path: file, line: 1, identifier: "target" } }, undefined, undefined, context(dir));
    expect(calls).toHaveLength(1);
    expect(JSON.parse(rendered(result).text)).toMatchObject({ status: "error", error: { code: "source-bootstrap" } });
  });

  it("bounds oversized bootstrap failure JSON while retaining the original envelope", async () => {
    const { dir, file } = await fixture();
    const request: StrictRequest = { operation: "documentSymbols", path: await realpath(file) };
    const bootstrap = makeEnvelope(request, { status: "error", error: { code: "large", message: "x".repeat(60_000) } });
    const { execute } = executeWith(bootstrap);
    const result = await execute("id", { operation: "hover", source: { path: file, line: 1, identifier: "target" } }, undefined, undefined, context(dir));
    const output = rendered(result);
    expect(Buffer.byteLength(output.text, "utf8")).toBeLessThanOrEqual(48 * 1024);
    expect(JSON.parse(output.text)).toMatchObject({ status: "error", error: { code: "output-limit" } });
    expect(output.details.steps?.[0]!.envelope).toEqual(bootstrap);
  });
});
