import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverDiagnosticActions } from "../../../scripts/eval/lsp-ergonomics/diagnostic-actions.js";
import type { StrictEnvelope, StrictRequest, StrictStatus } from "../../../src/lsp/lsp-strict-contract.js";

const server: NonNullable<StrictEnvelope["server"]> = {
  descriptorId: "fixture-server",
  name: "fixture",
  languageId: "typescript",
  projectRoot: "/",
  positionEncoding: "utf-16",
};
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function response(request: StrictRequest, status: StrictStatus, withMetadata: boolean): StrictEnvelope {
  const envelope: StrictEnvelope = {
    status,
    operation: request.operation,
    method: request.operation === "diagnostics" ? "textDocument/diagnostic" : "textDocument/codeAction",
    result: null,
    meta: { truncated: false, freshness: { state: "fresh" } },
  };
  return withMetadata ? { ...envelope, server } : envelope;
}

async function fixture(execute: (request: StrictRequest) => Promise<StrictEnvelope>) {
  const cwd = await mkdtemp(join(tmpdir(), "lsp-discovery-status-"));
  roots.push(cwd);
  const path = join(cwd, "sample.ts");
  await writeFile(path, "const target = 1;\n", "utf8");
  const start = Date.now();
  const now = vi.fn(() => start);
  const controller = new AbortController();
  const result = await discoverDiagnosticActions({
    path,
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
  }, { cwd, execute, now, signal: controller.signal });
  return { result, now, controller };
}

describe("diagnostic action discovery envelope failure status", () => {
  it.each([
    { status: "timeout" as const, withMetadata: true },
    { status: "timeout" as const, withMetadata: false },
    { status: "cancelled" as const, withMetadata: true },
    { status: "cancelled" as const, withMetadata: false },
  ])("preserves diagnostics $status from the envelope (metadata: $withMetadata)", async ({ status, withMetadata }) => {
    const execute = vi.fn(async (request: StrictRequest) => request.operation === "diagnostics"
      ? response(request, status, withMetadata)
      : { ...response(request, "empty", true), result: [] });
    const { result, now, controller } = await fixture(execute);

    expect(now).toHaveBeenCalled();
    expect(controller.signal.aborted).toBe(false);
    expect(result.diagnostics.status).toBe(status);
    expect(result.actions.status).toBe("confirmed-empty");
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1]?.[0].server).toBeUndefined();
  });

  it.each([
    { status: "timeout" as const, withMetadata: true },
    { status: "timeout" as const, withMetadata: false },
    { status: "cancelled" as const, withMetadata: true },
    { status: "cancelled" as const, withMetadata: false },
  ])("preserves code-action $status and rejects payload as options (metadata: $withMetadata)", async ({ status, withMetadata }) => {
    const candidate = { title: "Must not escape", kind: "quickfix", edit: { changes: [] } };
    const execute = vi.fn(async (request: StrictRequest) => request.operation === "diagnostics"
      ? { ...response(request, "empty", true), result: [] }
      : { ...response(request, status, withMetadata), result: [candidate] });
    const { result, now, controller } = await fixture(execute);

    expect(now).toHaveBeenCalled();
    expect(controller.signal.aborted).toBe(false);
    expect(result.actions.status).toBe(status);
    expect(result.options).toEqual([]);
    expect(result.details.candidates).toEqual([]);
    expect(result.server).toBeNull();
    expect(result.details.envelopes).toHaveLength(2);
  });
});
