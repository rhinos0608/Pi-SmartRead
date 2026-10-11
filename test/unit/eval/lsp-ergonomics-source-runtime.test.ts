import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSourceRoutingExecutor } from "../../../scripts/eval/lsp-ergonomics/source-routing.js";
import { createLspTool } from "../../../src/lsp/lsp-tool.js";
import type { ExecutorDeps } from "../../../src/lsp/lsp-executor.js";
import { AFFORDANCE_BOUNDS } from "../../../src/lsp/affordance-contract.js";
import { validateStrictRequest, type StrictEnvelope, type StrictRequest } from "../../../src/lsp/lsp-strict-contract.js";

const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

function context(cwd: string): ExtensionContext { return { cwd } as ExtensionContext; }
function envelope(request: StrictRequest, options: { server?: string; encoding?: "utf-8" | "utf-16" | "utf-32"; result?: unknown; meta?: StrictEnvelope["meta"] } = {}): StrictEnvelope {
  const method: Record<string, string> = {
    documentSymbols: "textDocument/documentSymbol", goToDefinition: "textDocument/definition", goToDeclaration: "textDocument/declaration",
    goToTypeDefinition: "textDocument/typeDefinition", goToImplementation: "textDocument/implementation", findReferences: "textDocument/references",
    hover: "textDocument/hover", prepareCallHierarchy: "textDocument/prepareCallHierarchy", incomingCalls: "callHierarchy/incomingCalls",
    outgoingCalls: "callHierarchy/outgoingCalls", prepareTypeHierarchy: "textDocument/prepareTypeHierarchy", supertypes: "typeHierarchy/supertypes",
    subtypes: "typeHierarchy/subtypes",
  };
  return { status: "ok", operation: request.operation, method: method[request.operation] ?? `test/${request.operation}`, server: { descriptorId: options.server ?? "server-A", name: "fake", languageId: "typescript", projectRoot: "/", positionEncoding: options.encoding ?? "utf-16" }, result: options.result ?? [], meta: options.meta ?? { truncated: false } };
}
function output(result: { content: Array<{ type: string; text?: string }>; details: unknown }) {
  const text = result.content[0];
  if (!text || text.type !== "text" || typeof text.text !== "string") throw new Error("expected JSON text result");
  return { text: text.text, json: JSON.parse(text.text) as Record<string, unknown>, details: result.details as Record<string, unknown> & { envelope?: StrictEnvelope; steps?: Array<{ id: string; args: Record<string, unknown>; envelope: StrictEnvelope }>; investigation?: { steps: Array<{ id: string; args: Record<string, unknown>; envelope: StrictEnvelope }> } } };
}
async function fixture(source = "function target() {}\n") {
  const dir = await mkdtemp(join(tmpdir(), "source-runtime-")); dirs.push(dir);
  const file = join(dir, "sample.ts"); await writeFile(file, source);
  return { dir, file };
}
function harness(resolveEnvelope: (request: StrictRequest, index: number) => StrictEnvelope | Promise<StrictEnvelope> = (request) => envelope(request)) {
  const admitted: StrictRequest[] = [];
  const executor = async (request: unknown, _deps?: ExecutorDeps): Promise<StrictEnvelope> => {
    const checked = validateStrictRequest(request);
    if (!checked.ok) throw new Error(checked.error);
    admitted.push(checked.value);
    return resolveEnvelope(checked.value, admitted.length - 1);
  };
  const tool = createLspTool({ executeOperation: executor });
  const execute = createSourceRoutingExecutor(tool.execute, { executeOperation: executor });
  return { execute, admitted };
}
const sourceRequest = (file: string, operation: string, extras: Record<string, unknown> = {}) => ({ operation, source: { path: file, line: 1, identifier: "target" }, ...extras });

describe("source routing runtime contract", () => {
  it("installs around the actual factory execute and preserves the ordinary five-argument legacy call unchanged", async () => {
    const { dir } = await fixture();
    const tool = createLspTool();
    const calls: unknown[][] = [];
    const original = async (...args: Parameters<typeof tool.execute>) => { calls.push(args); return { content: [{ type: "text" as const, text: "legacy" }], details: { envelope: "REFERENCE" } }; };
    tool.execute = original;
    tool.execute = createSourceRoutingExecutor(tool.execute);
    const params = { operation: "capabilities" } as const;
    const signal = new AbortController().signal;
    const onUpdate = () => undefined;
    const ctx = context(dir);
    const result = await tool.execute("tool-id", params, signal, onUpdate, ctx);
    expect(calls).toEqual([["tool-id", params, signal, onUpdate, ctx]]);
    expect(result).toMatchObject({ content: [{ text: "legacy" }], details: { envelope: "REFERENCE" } });
  });

  it.each([
    ["goToDefinition", "textDocument/definition"], ["goToTypeDefinition", "textDocument/typeDefinition"],
    ["goToImplementation", "textDocument/implementation"], ["findReferences", "textDocument/references"], ["hover", "textDocument/hover"], ["prepareCallHierarchy", "textDocument/prepareCallHierarchy"],
  ])("routes source %s with strict envelope and details", async (operation, method) => {
    const { dir, file } = await fixture(); const { execute, admitted } = harness();
    const result = output(await execute("id", sourceRequest(file, operation), undefined, undefined, context(dir)));
    expect(admitted.map((request) => request.operation)).toEqual(["documentSymbols", operation]);
    expect(result.json).toMatchObject({ status: "ok", operation, method, server: { descriptorId: "server-A", positionEncoding: "utf-16" }, meta: { truncated: false } });
    expect(result.details.steps?.map((step) => step.envelope.operation)).toEqual(["documentSymbols", operation]);
    expect(result.details.envelope).toEqual(result.details.steps?.[1]?.envelope);
  });

  it("independently converts same-line UTF-8/16/32 columns after emoji and handles BOM, CRLF, and bare CR", async () => {
    const source = "\uFEFFconst face = '😀'; const target = 1;\r\nconst other = 2;\rconst tail = 3;\r";
    const { dir, file } = await fixture(source);
    const line = source.split("\r\n")[0]!;
    const prefix = line.slice(0, line.indexOf("target"));
    const expectedColumns = { "utf-8": Buffer.byteLength(prefix, "utf8"), "utf-16": prefix.length, "utf-32": Array.from(prefix).length };
    for (const encoding of ["utf-8", "utf-16", "utf-32"] as const) {
      const { execute, admitted } = harness((request) => envelope(request, { encoding }));
      await execute("id", sourceRequest(file, "hover"), undefined, undefined, context(dir));
      expect(admitted[1]?.position).toEqual({ line: 0, character: expectedColumns[encoding] });
    }
    const bareCrSource = "const before = 1;\rfunction target() {}\r";
    const bareCr = await fixture(bareCrSource);
    const { execute, admitted } = harness();
    await execute("id", { operation: "hover", source: { path: bareCr.file, line: 2, identifier: "target" } }, undefined, undefined, context(bareCr.dir));
    expect(admitted[1]?.position).toEqual({ line: 1, character: 9 });
  });

  it("resolves relative source paths against cwd and allows canonical explicit files outside cwd", async () => {
    const { dir, file } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "source-outside-")); dirs.push(outside);
    const outsideFile = join(outside, "outside.ts"); await writeFile(outsideFile, "function target() {}\n");
    const { execute, admitted } = harness();
    await execute("id", sourceRequest(relative(dir, file), "hover"), undefined, undefined, context(dir));
    await execute("id", sourceRequest(outsideFile, "hover"), undefined, undefined, context(dir));
    expect(admitted.filter((item) => item.operation === "hover").map((item) => item.path)).toEqual([await realpath(file), await realpath(outsideFile)]);
  });

  it("routes type investigation through hover and bounds callers with actual admitted callbacks", async () => {
    const { dir, file } = await fixture();
    const { execute, admitted } = harness((request) => {
      if (request.operation === "prepareCallHierarchy") return envelope(request, { result: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }] });
      return envelope(request);
    });
    const typeResult = output(await execute("id", sourceRequest(file, "investigate", { task: "type" }), undefined, undefined, context(dir)));
    expect(admitted.map((request) => request.operation)).toEqual(["documentSymbols", "hover"]);
    expect(typeResult.json).toMatchObject({ status: "ok", operation: "investigate" });

    admitted.length = 0;
    const callers = output(await execute("id", sourceRequest(file, "investigate", { task: "callers" }), undefined, undefined, context(dir)));
    expect(admitted[0]?.operation).toBe("documentSymbols");
    expect(admitted.some((request) => request.operation === "prepareCallHierarchy")).toBe(true);
    expect(admitted.some((request) => request.operation === "incomingCalls")).toBe(true);
    expect(admitted.length).toBeLessThanOrEqual(AFFORDANCE_BOUNDS.underlyingRequests);
    expect(admitted.filter((request) => request.operation === "incomingCalls")).toHaveLength(3);
    expect(admitted.filter((request) => request.operation === "incomingCalls").map((request) => request.item)).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    const steps = callers.details.investigation?.steps ?? [];
    expect(steps[0]?.id).toBe("source.bootstrap");
    expect(steps.length).toBeGreaterThan(1);
    expect(callers.json.meta).toMatchObject({ truncated: true });
    expect(callers.json.result).toMatchObject({ prepared: 4, queried: 3, omittedPrepared: 1, partial: true, omission: expect.stringMatching(/only 3 of 4/) });
  });

  it.each(["bad-include", "bad-scope", "ignored"] as const)("rejects malformed or inappropriate source fields (%s) before executor admission", async (kind) => {
    const { dir, file } = await fixture(); const { execute, admitted } = harness();
    const request = kind === "bad-include" ? sourceRequest(file, "findReferences", { includeDeclaration: "yes" })
      : kind === "bad-scope" ? sourceRequest(file, "investigate", { task: "callers", scope: 42 })
        : sourceRequest(file, "hover", { query: "ignored" });
    await expect(execute("id", request, undefined, undefined, context(dir))).rejects.toThrow();
    expect(admitted).toHaveLength(0);
  });

  it.each([{ limit: 1 }, { cursor: "unused" }, { scope: "" }, { scope: "missing-directory" }])("rejects invalid or ignored recipe fields before bootstrap: %j", async (extras) => {
    const { dir, file } = await fixture();
    const { execute, admitted } = harness();
    await expect(execute("id", sourceRequest(file, "investigate", { task: "callers", ...extras }), undefined, undefined, context(dir))).rejects.toThrow();
    expect(admitted).toHaveLength(0);
  });

  it("preserves strict validation failures as complete source envelopes and locator metadata", async () => {
    const { dir, file } = await fixture();
    const { execute, admitted } = harness((request) => request.operation === "documentSymbols"
      ? envelope(request, { meta: { truncated: false, freshness: { state: "stale" } } }) : envelope(request));
    const result = output(await execute("id", sourceRequest(file, "hover"), undefined, undefined, context(dir)));
    expect(admitted).toHaveLength(1);
    expect(result.json).toMatchObject({ status: "not_ready", operation: "hover", result: null, error: { code: "source-stale" } });
    expect(result.details.bootstrap).toMatchObject({ operation: "documentSymbols", meta: { freshness: { state: "stale" } } });
    expect(result.details.locator).toMatchObject({ status: "found", sourcePositionUtf16: { line: 0 } });
  });

  it("checks source freshness after final semantic call and withholds usable main result", async () => {
    const { dir, file } = await fixture();
    const { execute, admitted } = harness(async (request, index) => {
      if (index === 1) await writeFile(file, "function changed() {}\n");
      return envelope(request, { result: "semantic-answer" });
    });
    const result = output(await execute("id", sourceRequest(file, "hover"), undefined, undefined, context(dir)));
    expect(admitted.map((request) => request.operation)).toEqual(["documentSymbols", "hover"]);
    expect(result.json).toMatchObject({ status: "not_ready", result: null, error: { code: "source-stale" } });
    expect(result.details.envelope).toBeUndefined();
    expect(result.details.output).toBeDefined();
  });

  it("bounds 48 KiB model-facing output but retains truncation metadata and full step envelopes", async () => {
    const { dir, file } = await fixture();
    const { execute } = harness((request) => envelope(request, { result: "x".repeat(60_000), meta: { truncated: true } }));
    const result = output(await execute("id", sourceRequest(file, "hover"), undefined, undefined, context(dir)));
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(48 * 1024);
    expect(result.json).toMatchObject({ status: "error", error: { code: "output-limit" }, meta: { truncated: true } });
    expect(result.details.steps?.[1]?.envelope.result).toBe("x".repeat(60_000));
    expect(result.details.steps?.[1]?.envelope.meta.truncated).toBe(true);
  });

  it.each(["hover", "investigate"] as const)("refuses a semantic response from changed server metadata for %s", async (operation) => {
    const { dir, file } = await fixture();
    for (const mismatch of [{ server: "server-B", encoding: "utf-16" }, { server: "server-A", encoding: "utf-8" }] as const) {
      const { execute } = harness((request, index) => envelope(request, index === 0 ? { encoding: "utf-16" } : mismatch));
      const result = output(await execute("id", sourceRequest(file, operation, operation === "investigate" ? { task: "type" } : {}), undefined, undefined, context(dir)));
      expect(result.json.status).not.toBe("ok");
      expect(result.json.result).toBeNull();
    }
  });

  it("retains the completed semantic envelope when its callback aborts", async () => {
    const { dir, file } = await fixture();
    const controller = new AbortController();
    const rawReply = envelope({ operation: "hover" }, { result: "completed reply" });
    const { execute } = harness((request, index) => {
      if (index === 1) { controller.abort(); return rawReply; }
      return envelope(request);
    });
    const result = output(await execute("id", sourceRequest(file, "hover"), controller.signal, undefined, context(dir)));
    expect(result.json.status).toBe("cancelled");
    expect(result.details.steps?.map((step) => step.envelope)).toContainEqual(rawReply);
  });

  it("stops admitting recipe calls immediately after server metadata changes", async () => {
    const { dir, file } = await fixture();
    const { execute, admitted } = harness((request, index) => envelope(request, index === 0 ? {} : { server: "server-B", result: [{ id: 1 }] }));
    const result = output(await execute("id", sourceRequest(file, "investigate", { task: "callers" }), undefined, undefined, context(dir)));
    expect(result.json).toMatchObject({ status: "not_ready", result: null });
    expect(admitted.map((request) => request.operation)).toEqual(["documentSymbols", "prepareCallHierarchy"]);
    expect(result.details.steps?.[1]?.envelope.server?.descriptorId).toBe("server-B");
  });

  it.each([
    { server: "server-B", encoding: "utf-16" as const, stop: true },
    { server: "server-A", encoding: "utf-8" as const, stop: true },
    { server: "server-A", encoding: "utf-16" as const, stop: false },
    { server: "unknown", encoding: "utf-8" as const, stop: false },
  ])("handles failed incoming metadata conservatively: %j", async ({ server, encoding, stop }) => {
    const { dir, file } = await fixture();
    const { execute, admitted } = harness((request, index) => {
      if (request.operation === "prepareCallHierarchy") return envelope(request, { result: [{ id: 1 }, { id: 2 }, { id: 3 }] });
      if (index === 2) return { ...envelope(request, { server, encoding }), status: "error", result: null, error: { code: "test-failure", message: "incoming failed" } };
      return envelope(request);
    });
    const result = output(await execute("id", sourceRequest(file, "investigate", { task: "callers" }), undefined, undefined, context(dir)));
    expect(admitted.filter((request) => request.operation === "incomingCalls")).toHaveLength(stop ? 1 : 3);
    if (stop) {
      expect(result.json).toMatchObject({ status: "not_ready", result: null });
      expect(result.details.steps?.[2]?.envelope).toMatchObject({ status: "error", server: { descriptorId: server, positionEncoding: encoding } });
    }
  });

  it.each(["hover", "investigate"] as const)("rethrows unrelated executor errors mentioning stale source for %s", async (operation) => {
    const { dir, file } = await fixture();
    const fault = new Error("remote fault: stale source was mentioned by server");
    const { execute } = harness((_request, index) => { if (index === 1) throw fault; return envelope({ operation: "documentSymbols" }); });
    await expect(execute("id", sourceRequest(file, operation, operation === "investigate" ? { task: "type" } : {}), undefined, undefined, context(dir))).rejects.toBe(fault);
  });

  it("uses Date.now deadlines without timers and returns complete cancellation envelopes during bootstrap and semantic calls", async () => {
    const { dir, file } = await fixture();
    for (const cancelAt of [0, 1]) {
      const controller = new AbortController();
      const { execute, admitted } = harness((request, index) => {
        if (index === cancelAt) controller.abort();
        return envelope(request);
      });
      const result = output(await execute("id", sourceRequest(file, "hover"), controller.signal, undefined, context(dir)));
      expect(result.json).toMatchObject({ status: "cancelled", operation: "hover", result: null });
      expect(result.details.locator).toMatchObject({ status: "found" });
      expect(result.details.bootstrap).toBeDefined();
      if (cancelAt === 1) expect(admitted).toHaveLength(2);
    }

    const clock = vi.spyOn(Date, "now");
    let now = 100;
    clock.mockImplementation(() => now);
    const { execute: timed, admitted } = harness((request, index) => {
      if (index === 0 || index === 1) now += 20_000;
      return envelope(request);
    });
    const timeout = output(await timed("id", sourceRequest(file, "hover", { timeoutMs: 30 }), undefined, undefined, context(dir)));
    expect(timeout.json.status).toBe("timeout");
    expect(admitted.length).toBeLessThanOrEqual(2);
    clock.mockRestore();
  });
});
