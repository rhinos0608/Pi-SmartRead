import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverDiagnosticActions } from "../../../scripts/eval/lsp-ergonomics/diagnostic-actions.js";
import { selectCurrentDiagnosticAction } from "../../../scripts/eval/lsp-ergonomics/action-selection.js";
import type { StrictEnvelope, StrictRequest } from "../../../src/lsp/lsp-strict-contract.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function fixture(actions: unknown[], codeActionMeta: StrictEnvelope["meta"] = { truncated: false }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bound-consumer-")));
  roots.push(root);
  const file = join(root, "sample.ts");
  const bytes = Buffer.from("const sample = 1;\n", "utf8");
  await writeFile(file, bytes);
  const path = await realpath(file);
  const sourceSha256 = createHash("sha256").update(bytes).digest("hex");
  const descriptorId = "Fixture-TypeScript-Opaque";
  const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } };
  const server: NonNullable<StrictEnvelope["server"]> = {
    descriptorId, name: "Fixture TypeScript", languageId: "typescript", projectRoot: root, positionEncoding: "utf-16",
  };
  const actionId = "Fixture:Opaque/CaseSensitive";
  const validAction = { title: "Apply fixture", kind: "quickfix", edit: { changes: {} }, actionId, sourceSha256 };
  const execute = vi.fn(async (request: StrictRequest): Promise<StrictEnvelope> => {
    if (request.operation === "diagnostics") {
      return { status: "empty", operation: "diagnostics", method: "textDocument/diagnostic", server, result: [], meta: { truncated: false, freshness: { state: "fresh" } } };
    }
    expect(request).toMatchObject({ operation: "codeActions", path, workspace: root, server: descriptorId, range, context: { diagnostics: [], only: ["quickfix"] } });
    return { status: "ok", operation: "codeActions", method: "textDocument/codeAction", server, result: actions, meta: codeActionMeta };
  });
  return { root, path, bytes, sourceSha256, descriptorId, actionId, range, server, validAction, execute,
    input: { path, workspace: root, server: descriptorId, range, kind: "quickfix" as const }, context: { cwd: root, execute } };
}

describe("bound diagnostic-action consumers refuse incomplete authority", () => {
  it("withholds otherwise valid actions when the producer explicitly marks them stale", async () => {
    const f = await fixture([], { truncated: false, freshness: { state: "stale" } });
    const row = { ...f.validAction };
    f.execute.mockImplementation(async (request) => request.operation === "diagnostics"
      ? { status: "empty", operation: "diagnostics", method: "textDocument/diagnostic", server: f.server, result: [], meta: { truncated: false, freshness: { state: "fresh" } } }
      : { status: "ok", operation: "codeActions", method: "textDocument/codeAction", server: f.server, result: [row], meta: { truncated: false, freshness: { state: "stale" } } });
    const result = await discoverDiagnosticActions(f.input, f.context);
    expect(result.actions.status).toBe("coverage-unconfirmed");
    expect(result.actions.coverage).toBe("incomplete");
    expect(result.options).toEqual([]);
  });

  it("accepts valid identity rows when action freshness metadata is absent", async () => {
    const f = await fixture([]);
    const action = { ...f.validAction };
    f.execute.mockImplementation(async (request) => request.operation === "diagnostics"
      ? { status: "empty", operation: "diagnostics", method: "textDocument/diagnostic", server: f.server, result: [], meta: { truncated: false, freshness: { state: "fresh" } } }
      : { status: "ok", operation: "codeActions", method: "textDocument/codeAction", server: f.server, result: [action], meta: { truncated: false } });
    const result = await discoverDiagnosticActions(f.input, f.context);
    expect(result.actions).toMatchObject({ status: "confirmed", coverage: "complete", count: 1 });
    expect(result.options).toHaveLength(1);
    expect(result.options[0]?.actionId).toBe(f.actionId);
    expect(result.options[0]?.provenance.descriptorId).toBe(f.descriptorId);
    expect(result.fingerprint?.sourceSha256).toBe(f.sourceSha256);
    expect(await readFile(f.path)).toEqual(f.bytes);
  });

  it.each([
    ["missing", (action: Record<string, unknown>) => { delete action.actionId; }],
    ["mismatched", (action: Record<string, unknown>) => { action.sourceSha256 = "0".repeat(64); }],
  ])("withholds the full option set when one row has a %s identity", async (_label, corrupt) => {
    const f = await fixture([]);
    const good = { ...f.validAction };
    const bad: Record<string, unknown> = { ...f.validAction };
    corrupt(bad);
    f.execute.mockImplementation(async (request) => request.operation === "diagnostics"
      ? { status: "empty", operation: "diagnostics", method: "textDocument/diagnostic", server: f.server, result: [], meta: { truncated: false, freshness: { state: "fresh" } } }
      : { status: "ok", operation: "codeActions", method: "textDocument/codeAction", server: f.server, result: [good, bad], meta: { truncated: false } });
    const result = await discoverDiagnosticActions(f.input, f.context);
    expect(result.actions.status).toBe("coverage-unconfirmed");
    expect(result.actions.coverage).toBe("incomplete");
    expect(result.actions.count).toBe(2);
    expect(result.options).toEqual([]);
  });

  it.each([
    { label: "disabled", extra: { disabled: { reason: "unavailable" } } },
    { label: "command", extra: { command: "fixture.command" } },
    { label: "wrong kind", extra: { kind: "source.fixAll" } },
    { label: "malformed title", extra: { title: "" } },
  ])("withholds the whole duplicate group when one row is $label", async ({ extra }) => {
    const actions: unknown[] = [];
    const f = await fixture(actions);
    actions.push(f.validAction, { ...f.validAction, ...extra }, { ...f.validAction, actionId: "Fixture:Unrelated", title: "Unrelated" });
    const result = await discoverDiagnosticActions(f.input, f.context);
    const selected = await selectCurrentDiagnosticAction({ ...f.input, selection: { actionId: f.actionId, sourceSha256: f.sourceSha256 } }, f.context);
    expect(selected).toMatchObject({ status: "refused", code: "coverage-unconfirmed" });
    expect(result.options.map((option) => option.actionId)).toEqual(["Fixture:Unrelated"]);
    expect(result.actions).toMatchObject({ count: 3, coverage: "incomplete", omitted: { "duplicate-identity": 2 } });
    expect(result.details.candidates).toEqual(actions);
  });

  it("withholds options for a malformed identity on a disabled row", async () => {
    const f = await fixture([]);
    const good = { ...f.validAction };
    const disabled = { title: f.validAction.title, kind: f.validAction.kind, sourceSha256: f.sourceSha256, disabled: { reason: "unavailable" } };
    f.execute.mockImplementation(async (request) => request.operation === "diagnostics"
      ? { status: "empty", operation: "diagnostics", method: "textDocument/diagnostic", server: f.server, result: [], meta: { truncated: false, freshness: { state: "fresh" } } }
      : { status: "ok", operation: "codeActions", method: "textDocument/codeAction", server: f.server, result: [good, disabled], meta: { truncated: false } });
    const result = await discoverDiagnosticActions(f.input, f.context);
    expect(result.actions).toMatchObject({ status: "coverage-unconfirmed", coverage: "incomplete", count: 2 });
    expect(result.actions.omitted).toEqual({ "malformed-identity": 1 });
    expect(result.options).toEqual([]);
    expect(result.details.candidates).toHaveLength(2);
  });

  it("rejects non-plain input with an otherwise valid path, query and selection", async () => {
    const f = await fixture([]);
    class NonPlainInput {
      path = f.path;
      workspace = f.root;
      server = f.descriptorId;
      range = f.range;
      kind = "quickfix";
      selection = { actionId: f.actionId, sourceSha256: f.sourceSha256 };
    }
    const result = await selectCurrentDiagnosticAction(new NonPlainInput(), f.context);
    expect(result).toMatchObject({ status: "refused", code: "invalid-input" });
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("rejects nested selector getters before reading them or dispatching", async () => {
    const f = await fixture([]);
    let invoked = false;
    const selection = Object.defineProperties({}, {
      actionId: { enumerable: true, get() { invoked = true; return f.actionId; } },
      sourceSha256: { enumerable: true, value: f.sourceSha256 },
    });
    const result = await selectCurrentDiagnosticAction({ ...f.input, selection }, f.context);
    expect(result).toMatchObject({ status: "refused", code: "invalid-input" });
    expect(invoked).toBe(false);
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("rejects non-plain and inherited selector fields before dispatch", async () => {
    const f = await fixture([]);
    const nonPlain = Object.assign(new (class { actionId = f.actionId; sourceSha256 = f.sourceSha256; })(), {});
    const inherited = Object.create({ actionId: f.actionId });
    Object.defineProperty(inherited, "sourceSha256", { enumerable: true, value: f.sourceSha256 });
    for (const selection of [nonPlain, inherited]) {
      const result = await selectCurrentDiagnosticAction({ ...f.input, selection }, f.context);
      expect(result).toMatchObject({ status: "refused", code: "invalid-input" });
    }
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("accepts plain null-prototype root and selector records", async () => {
    const f = await fixture([]);
    const selection = Object.assign(Object.create(null), { actionId: f.actionId, sourceSha256: f.sourceSha256 });
    const input = Object.assign(Object.create(null), f.input, { selection });
    f.execute.mockImplementation(async (request) => request.operation === "diagnostics"
      ? { status: "empty", operation: "diagnostics", method: "textDocument/diagnostic", server: f.server, result: [], meta: { truncated: false, freshness: { state: "fresh" } } }
      : { status: "ok", operation: "codeActions", method: "textDocument/codeAction", server: f.server, result: [f.validAction], meta: { truncated: false } });
    const result = await selectCurrentDiagnosticAction(input, f.context);
    expect(result).toMatchObject({ status: "selected", selection: { actionId: f.actionId, sourceSha256: f.sourceSha256 } });
  });

  it("rejects an own prototype-looking unknown field without dropping it during capture", async () => {
    const actions: unknown[] = [];
    const f = await fixture(actions);
    actions.push(f.validAction);
    const input = { ...f.input, selection: { actionId: f.actionId, sourceSha256: f.sourceSha256 } };
    Object.defineProperty(input, "__proto__", { enumerable: true, value: {} });
    const result = await selectCurrentDiagnosticAction(input, f.context);
    expect(result).toMatchObject({ status: "refused", code: "invalid-input" });
    expect(f.execute).not.toHaveBeenCalled();
    expect(Object.getPrototypeOf(input)).toBe(Object.prototype);
  });

  it("rejects selector getters before reading them or dispatching", async () => {
    const f = await fixture([]);
    let invoked = false;
    const input = { path: f.path, workspace: f.root, server: f.descriptorId, range: f.range, kind: "quickfix",
      get selection() { invoked = true; return { actionId: f.actionId, sourceSha256: f.sourceSha256 }; } };
    const result = await selectCurrentDiagnosticAction(input, f.context);
    expect(result).toMatchObject({ status: "refused", code: "invalid-input" });
    expect(invoked).toBe(false);
    expect(f.execute).not.toHaveBeenCalled();
  });
});
