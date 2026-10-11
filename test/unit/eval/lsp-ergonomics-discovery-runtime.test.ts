import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discoverDiagnosticActions } from "../../../scripts/eval/lsp-ergonomics/diagnostic-actions.js";
import type { StrictEnvelope, StrictRequest } from "../../../src/lsp/lsp-strict-contract.js";

const reader = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("node:fs/promises", async () => {
  const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return { ...original, open: reader.open };
});
const roots: string[] = [];
beforeEach(async () => {
  const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  reader.open.mockImplementation(original.open);
});
afterEach(() => { vi.restoreAllMocks(); reader.open.mockReset(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const server: StrictEnvelope["server"] = { descriptorId: "fixture-server", name: "fixture", languageId: "typescript", projectRoot: "/", positionEncoding: "utf-16" };
const sourceSha256 = createHash("sha256").update("const target = 1;\n").digest("hex");
function envelope(request: StrictRequest, result: unknown = [], status: "ok" | "empty" = "ok"): StrictEnvelope {
  const bound = request.operation === "codeActions" && Array.isArray(result) ? result.map((row, index) => row && typeof row === "object" ? { ...row, actionId: `Fixture:Row:${index}`, sourceSha256 } : row) : result;
  return { status, operation: request.operation, method: request.operation === "diagnostics" ? "textDocument/diagnostic" : "textDocument/codeAction", server, result: bound, meta: { truncated: false, freshness: { state: "fresh" } } };
}
function fixture(text = "const target = 1;\n") {
  const dir = mkdtempSync(join(tmpdir(), "diagnostic-runtime-")); roots.push(dir);
  const path = join(dir, "sample.ts"); writeFileSync(path, text);
  return { dir, path };
}
describe("diagnostic action discovery runtime admission and output", () => {
  it.each([
    { stage: "read", stop: "cancelled" }, { stage: "read", stop: "timeout" },
    { stage: "close", stop: "cancelled" }, { stage: "close", stop: "timeout" },
    { stage: "final", stop: "cancelled" }, { stage: "final", stop: "timeout" },
  ] as const)("honors $stop during the controlled $stage snapshot wait", async ({ stage, stop }) => {
    const { dir, path } = fixture();
    const controller = new AbortController();
    let entered!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const resume = new Promise<void>((resolve) => { release = resolve; });
    const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let opened = 0;
    let closed = 0;
    reader.open.mockImplementation(async (file: string, flags: number) => {
      const handle = await original.open(file, flags);
      const index = ++opened;
      const close = handle.close.bind(handle);
      const read = handle.read.bind(handle);
      vi.spyOn(handle, "close").mockImplementation(async () => {
        if ((stage === "close" && index === 2) || (stage === "final" && index === 6)) { entered(); await resume; }
        await close();
        closed += 1;
      });
      if (stage === "read" && index === 2) {
        vi.spyOn(handle, "read").mockImplementation(async (...args) => { entered(); await resume; return read(...args); });
      }
      return handle;
    });
    const start = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(start);
    const action = { title: "Safe fix", kind: "quickfix", edit: { changes: [] } };
    const execute = vi.fn(async (request: StrictRequest) => request.operation === "diagnostics"
      ? envelope(request, [], "empty") : envelope(request, [action]));
    const pending = discoverDiagnosticActions({ path }, { cwd: dir, signal: controller.signal, execute });
    try {
      await waiting;
      if (stop === "cancelled") controller.abort();
      else clock.mockReturnValue(start + 60_000);
      release();
      const result = await pending;
      expect(execute).toHaveBeenCalledTimes(stage === "final" ? 2 : 0);
      expect(stage === "final" ? result.actions.status : result.diagnostics.status).toBe(stop);
      expect(result.options).toEqual([]);
      expect(result.details.envelopes).toHaveLength(stage === "final" ? 2 : 0);
    } finally {
      release();
      await pending;
      expect(closed).toBe(opened);
    }
  });

  it("retains completed action envelope but withholds options when terminal cancellation follows", async () => {
    const { dir, path } = fixture(); const controller = new AbortController();
    const action = { title: "Safe fix", kind: "quickfix", edit: { changes: [] } };
    const execute = vi.fn(async (request: StrictRequest) => { if (request.operation === "codeActions") controller.abort(); return envelope(request, request.operation === "codeActions" ? [action] : [], request.operation === "codeActions" ? "ok" : "empty"); });
    const result = await discoverDiagnosticActions({ path }, { cwd: dir, signal: controller.signal, execute });
    expect(result.actions.status).toBe("cancelled");
    expect(result.details.envelopes).toHaveLength(2);
    expect(result.options).toEqual([]);
  });

  it("checks the final budget synchronously before a queued cancellation", async () => {
    const { dir, path } = fixture();
    const controller = new AbortController();
    const start = Date.now();
    let rendered = false;
    let synchronousChecks = 0;
    const stringify = JSON.stringify.bind(JSON);
    vi.spyOn(JSON, "stringify").mockImplementation((value: unknown) => {
      const text = stringify(value);
      if (typeof value === "object" && value !== null && "fingerprint" in value && "options" in value) {
        rendered = true;
        queueMicrotask(() => controller.abort());
      }
      return text;
    });
    const now = () => {
      if (rendered && !controller.signal.aborted) synchronousChecks += 1;
      return start;
    };
    const execute = vi.fn(async (request: StrictRequest) => envelope(request, [], "empty"));
    const result = await discoverDiagnosticActions({ path }, { cwd: dir, signal: controller.signal, now, execute });
    expect(synchronousChecks).toBeGreaterThan(0);
    expect(result.actions.status).toBe("cancelled");
    expect(result.options).toEqual([]);
    expect(result.details.envelopes).toHaveLength(2);
  });

  it("recomputes timeout for each dispatch using an epoch clock", async () => {
    const { dir, path } = fixture();
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const requests: StrictRequest[] = [];
    const execute = vi.fn(async (request: StrictRequest) => { requests.push(request); if (requests.length === 1) now += 4_000; return envelope(request, [], "empty"); });
    const result = await discoverDiagnosticActions({ path }, { cwd: dir, execute });
    expect(result.steps).toHaveLength(2);
    expect(requests[1]?.timeoutMs).toBeLessThanOrEqual(11_000);
  });

  it("returns bounded output-limit failure with completed raw envelopes", async () => {
    const { dir, path } = fixture();
    const actions = Array.from({ length: 60 }, (_, index) => ({ title: `${index}: ${"x".repeat(1_000)}`, kind: "quickfix", edit: { changes: [] } }));
    const identifiedActions = actions.map((action, index) => ({ ...action, actionId: `Fixture:Row:${index}`, sourceSha256 }));
    const execute = vi.fn(async (request: StrictRequest) => request.operation === "diagnostics"
      ? envelope(request, [], "empty") : envelope(request, identifiedActions));
    const result = await discoverDiagnosticActions({ path }, { cwd: dir, execute });
    expect(result.actions.status).toBe("error");
    expect(result.truncated).toBe(true);
    expect(result.options).toEqual([]);
    expect(result.details.envelopes).toHaveLength(2);
    expect(result.details.candidates).toEqual(identifiedActions);
    expect(result.details.envelopes[1]?.result).toEqual(identifiedActions);
    expect((result.details.envelopes[1]?.result as typeof identifiedActions).map(({ actionId: _actionId, sourceSha256: _sourceSha256, ...action }) => action)).toEqual(actions);
    expect(Buffer.byteLength(JSON.stringify({ diagnostics: result.diagnostics, actions: result.actions, fingerprint: result.fingerprint, range: result.range, server: result.server, options: result.options, truncated: result.truncated }), "utf8")).toBeLessThanOrEqual(48 * 1024);
  });

  it("supports a supplied clock with a different origin", async () => {
    const { dir, path } = fixture(); let now = 10_000;
    const requests: StrictRequest[] = [];
    const execute = vi.fn(async (request: StrictRequest) => { requests.push(request); if (requests.length === 1) now += 40; return envelope(request, [], "empty"); });
    const result = await discoverDiagnosticActions({ path, timeoutMs: 100 }, { cwd: dir, now: () => now, execute });
    expect(result.steps).toHaveLength(2);
    expect(requests[0]?.timeoutMs).toBeLessThanOrEqual(100);
    expect(requests[1]?.timeoutMs).toBeLessThanOrEqual(60);
    expect(result.diagnostics.status).toBe("confirmed-empty");
  });
});
