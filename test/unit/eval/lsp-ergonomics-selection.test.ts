import { createHash } from "node:crypto";
import { AFFORDANCE_BOUNDS } from "../../../src/lsp/affordance-contract.js";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { selectCurrentDiagnosticAction } from "../../../scripts/eval/lsp-ergonomics/action-selection.js";
import type { StrictEnvelope, StrictRequest } from "../../../src/lsp/lsp-strict-contract.js";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const server: NonNullable<StrictEnvelope["server"]> = { descriptorId: "selection-server", name: "fixture", languageId: "typescript", projectRoot: "/workspace", positionEncoding: "utf-16" };
function fixture(text = "const x = 1;\n") { const cwd = mkdtempSync(join(tmpdir(), "action-selection-")); roots.push(cwd); const path = join(cwd, "sample.ts"); const bytes = Buffer.from(text); writeFileSync(path, bytes); return { cwd, path: realpathSync(path), bytes }; }
function envelope(request: StrictRequest, result: unknown, meta: StrictEnvelope["meta"] = { truncated: false, freshness: { state: "fresh" } }): StrictEnvelope { return { status: request.operation === "diagnostics" && Array.isArray(result) && result.length === 0 ? "empty" : "ok", operation: request.operation, method: request.operation === "diagnostics" ? "textDocument/diagnostic" : "textDocument/codeAction", server, result, meta }; }
const action = { title: "Fix", kind: "quickfix", edit: { changes: { "/workspace/sample.ts": [{ newText: "ok" }] } }, data: { retained: true } };
const actionId = "Returned:ChoiceA";
function returned(actionValue: Record<string, unknown>, sourceSha256: string) { return { ...actionValue, actionId, sourceSha256 }; }
async function choose(overrides: { actions?: unknown[]; actionMeta?: StrictEnvelope["meta"]; text?: string; now?: () => number; signal?: AbortSignal; missingActionServer?: boolean } = {}) {
  const f = fixture(overrides.text);
  const sourceSha256 = createHash("sha256").update(f.bytes).digest("hex");
  const row = returned(action, sourceSha256);
  const execute = vi.fn(async (request: StrictRequest) => {
    const response = envelope(request, request.operation === "diagnostics" ? [] : overrides.actions ?? [row], request.operation === "codeActions" ? overrides.actionMeta : undefined);
    if (request.operation === "codeActions" && overrides.missingActionServer) {
      const { server: _server, ...withoutServer } = response;
      return withoutServer as StrictEnvelope;
    }
    return response;
  });
  const result = await selectCurrentDiagnosticAction({ path: f.path, selection: { actionId, sourceSha256 } }, { cwd: f.cwd, execute, now: overrides.now, signal: overrides.signal });
  return { result, execute, f, actionId, sourceSha256 };
}
describe("current diagnostic action selection", () => {
  it("returns the exact re-discovered action and actual action envelope", async () => { const { result, sourceSha256 } = await choose(); expect(result.status).toBe("selected"); if (result.status === "selected") { expect(result.action).toEqual(returned(action, sourceSha256)); expect(result.envelope.server).toMatchObject({ ...server }); expect(result.envelope.server?.projectRoot).toBe("/workspace"); expect(result.details.details.candidates).toEqual([returned(action, sourceSha256)]); } });
  it("rejects changed source before any semantic callback", async () => { const f = fixture("changed\n"); const execute = vi.fn(async (request: StrictRequest) => envelope(request, [])); const result = await selectCurrentDiagnosticAction({ path: f.path, selection: { actionId: "a".repeat(64), sourceSha256: "0".repeat(64) } }, { cwd: f.cwd, execute }); expect(result.status === "refused" && result.code).toBe("stale"); expect(execute).not.toHaveBeenCalled(); });
  it("rejects a nonmatching/tampered opaque action ID", async () => { const x = await choose(); const result = await selectCurrentDiagnosticAction({ path: x.f.path, selection: { actionId: "Returned:Tampered", sourceSha256: x.sourceSha256 } }, { cwd: x.f.cwd, execute: vi.fn(async (request: StrictRequest) => envelope(request, request.operation === "diagnostics" ? [] : [returned(action, x.sourceSha256)])) }); expect(result.status === "refused" && result.code).toBe("no-match"); });
  it("refuses repeated matching candidates rather than deduplicating", async () => { const x0 = await choose(); const x = await choose({ actions: [returned(action, x0.sourceSha256), returned(action, x0.sourceSha256)] }); expect(x.result.status === "refused" && ["ambiguous", "coverage-unconfirmed"].includes(x.result.code)).toBe(true); });
  it("refuses an ok action envelope without server metadata before issuing an action identity", async () => { const x = await choose({ missingActionServer: true }); expect(x.result.status === "refused" && x.result.code).toBe("coverage-unconfirmed"); });
  it("refuses truncated action coverage", async () => { const x = await choose({ actionMeta: { truncated: true, freshness: { state: "fresh" } } }); expect(x.result.status === "refused" && x.result.code).toBe("coverage-unconfirmed"); });
  it("rejects unknown fields without invoking callbacks", async () => { const f = fixture(); const execute = vi.fn(async (request: StrictRequest) => envelope(request, [])); const result = await selectCurrentDiagnosticAction({ path: f.path, extra: true, selection: { actionId: "a".repeat(64), sourceSha256: "b".repeat(64) } }, { cwd: f.cwd, execute }); expect(result.status === "refused" && result.code).toBe("invalid-input"); expect(execute).not.toHaveBeenCalled(); });
  it("accepts opaque IDs exactly and rejects uppercase source hashes", async () => { const x = await choose(); const caller = { path: x.f.path, selection: { actionId, sourceSha256: x.sourceSha256 } }; const execute = vi.fn(async (request: StrictRequest) => envelope(request, request.operation === "diagnostics" ? [] : [returned(action, x.sourceSha256)])); expect((await selectCurrentDiagnosticAction(caller, { cwd: x.f.cwd, execute })).status).toBe("selected"); const uppercase = await selectCurrentDiagnosticAction({ ...caller, selection: { actionId: actionId.toLowerCase(), sourceSha256: x.sourceSha256.toUpperCase() } }, { cwd: x.f.cwd, execute }); expect(uppercase.status === "refused" && uppercase.code).toBe("invalid-input"); });
  it("carries full JSON keys including own __proto__ unchanged", async () => { const odd = JSON.parse('{"title":"Fix","kind":"quickfix","edit":{"changes":{}},"__proto__":{"x":1},"constructor":2,"prototype":3}') as Record<string, unknown>; const f = fixture(); const sourceSha256 = createHash("sha256").update(f.bytes).digest("hex"); const row = returned(odd, sourceSha256); const execute = vi.fn(async (request: StrictRequest) => envelope(request, request.operation === "diagnostics" ? [] : [row])); const result = await selectCurrentDiagnosticAction({ path: f.path, selection: { actionId, sourceSha256 } }, { cwd: f.cwd, execute }); expect(result.status).toBe("selected"); if (result.status === "selected") { expect(Object.keys(result.action)).toContain("__proto__"); expect(Object.getPrototypeOf(result.action)).toBe(Object.prototype); expect(result.action.constructor).toBe(2); expect(result.action.prototype).toBe(3); } expect(Object.prototype).not.toHaveProperty("x"); });
  it("refuses pre-aborted contexts", async () => { const f = fixture(); const controller = new AbortController(); controller.abort(); const execute = vi.fn(async (request: StrictRequest) => envelope(request, [])); const result = await selectCurrentDiagnosticAction({ path: f.path, selection: { actionId: "a".repeat(64), sourceSha256: "b".repeat(64) } }, { cwd: f.cwd, signal: controller.signal, execute }); expect(result.status === "refused" && result.code).toBe("cancelled"); expect(execute).not.toHaveBeenCalled(); });
  it("uses one logical deadline origin", async () => { const clock = vi.fn(() => 100); const x = await choose({ now: clock }); expect(x.result.status).toBe("selected"); expect(x.result.status === "selected" && x.result.deadlineMs).toBe(100 + AFFORDANCE_BOUNDS.aggregateDeadlineMs); });
  it("refuses when the final source recheck changes bytes", async () => { const x = await choose(); writeFileSync(x.f.path, "mutated\n"); const result = await selectCurrentDiagnosticAction({ path: x.f.path, selection: { actionId, sourceSha256: x.sourceSha256 } }, { cwd: x.f.cwd, execute: vi.fn(async (request: StrictRequest) => envelope(request, request.operation === "diagnostics" ? [] : [action])) }); expect(result.status === "refused" && result.code).toBe("stale"); });
});
