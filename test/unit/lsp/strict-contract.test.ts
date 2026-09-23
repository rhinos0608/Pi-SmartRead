import { describe, expect, it } from "vitest";
import {
  classifyStatus,
  isRawMethodAllowed,
  validateStrictRequest,
  type StrictEnvelope,
  type StrictStatus,
  type TransportEventKind,
} from "../../../src/lsp/lsp-strict-contract.js";

const KINDS: TransportEventKind[] = [
  "success-value",
  "success-empty",
  "unsupported",
  "no-session",
  "state-missing",
  "timeout",
  "cancelled",
  "transport-error",
  "ambiguous",
];

const EXPECTED: Record<TransportEventKind, StrictStatus> = {
  "success-value": "ok",
  "success-empty": "empty",
  unsupported: "unsupported",
  "no-session": "unavailable",
  "state-missing": "not_ready",
  timeout: "timeout",
  cancelled: "cancelled",
  "transport-error": "error",
  ambiguous: "ambiguous",
};

describe("classifyStatus", () => {
  for (const kind of KINDS) {
    it(`maps ${kind} to ${EXPECTED[kind]}`, () => {
      expect(classifyStatus({ kind })).toBe(EXPECTED[kind]);
    });
  }
  it("all 9 statuses reachable and distinct", () => {
    const got = new Set(KINDS.map((k) => classifyStatus({ kind: k })));
    expect(got.size).toBe(9);
    expect([...got].sort()).toEqual(
      ["ambiguous", "cancelled", "empty", "error", "not_ready", "ok", "timeout", "unavailable", "unsupported"].sort(),
    );
  });
});

describe("validateStrictRequest field matrix", () => {
  it("accepts valid hover", () => {
    const r = validateStrictRequest({ operation: "hover", path: "src/a.ts", position: { line: 0, character: 5 } });
    expect(r.ok).toBe(true);
  });
  it("rejects hover+query foreign field", () => {
    const r = validateStrictRequest({ operation: "hover", path: "a.ts", position: { line: 0, character: 0 }, query: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/query.*hover|hover.*query|foreign field "query"/);
  });
  it("rejects workspaceSymbols+position foreign field", () => {
    const r = validateStrictRequest({ operation: "workspaceSymbols", query: "foo", position: { line: 0, character: 0 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/foreign field "position"/);
  });
  it("rejects documentSymbols+position foreign field", () => {
    const r = validateStrictRequest({ operation: "documentSymbols", path: "a.ts", position: { line: 1, character: 2 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/foreign field "position"/);
  });
  it("rejects incomingCalls+position foreign field", () => {
    const r = validateStrictRequest({ operation: "incomingCalls", item: { a: 1 }, position: { line: 0, character: 0 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/foreign field "position"/);
  });
  it("rejects rename+query foreign field", () => {
    const r = validateStrictRequest({ operation: "rename", path: "a.ts", position: { line: 0, character: 0 }, newName: "b", query: "z" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/foreign field "query"/);
  });
  it("rejects diagnostics+newName foreign field", () => {
    const r = validateStrictRequest({ operation: "diagnostics", path: "a.ts", newName: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/foreign field "newName"/);
  });
  it("rejects unknown operation", () => {
    const r = validateStrictRequest({ operation: "teleport" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unknown operation/);
  });
  it("rejects request without method", () => {
    const r = validateStrictRequest({ operation: "request", server: "ts" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/requires field "method"/);
  });
  it("accepts valid raw request", () => {
    const r = validateStrictRequest({ operation: "request", method: "textDocument/hover", params: { a: 1 } });
    expect(r.ok).toBe(true);
  });
  it("rejects missing required position", () => {
    const r = validateStrictRequest({ operation: "hover", path: "a.ts" });
    expect(r.ok).toBe(false);
  });
  it("rejects null path", () => {
    const r = validateStrictRequest({ operation: "hover", path: null, position: { line: 0, character: 0 } });
    expect(r.ok).toBe(false);
  });
  it("rejects numeric path", () => {
    const r = validateStrictRequest({ operation: "hover", path: 42, position: { line: 0, character: 0 } });
    expect(r.ok).toBe(false);
  });
  it("rejects malformed position (missing character)", () => {
    const r = validateStrictRequest({ operation: "hover", path: "a.ts", position: { line: 0 } });
    expect(r.ok).toBe(false);
  });
  it("rejects array params", () => {
    const r = validateStrictRequest({ operation: "request", method: "textDocument/hover", params: [1, 2] });
    expect(r.ok).toBe(false);
  });
  it("rejects non-boolean includeDeclaration", () => {
    const r = validateStrictRequest({ operation: "findReferences", path: "a.ts", position: { line: 0, character: 0 }, includeDeclaration: "yes" });
    expect(r.ok).toBe(false);
  });
  it("rejects malformed formatting", () => {
    const r = validateStrictRequest({ operation: "formatDocument", path: "a.ts", formatting: { tabSize: "4", insertSpaces: 1 } });
    expect(r.ok).toBe(false);
  });
  it("rejects documentSymbols+query foreign field", () => {
    const r = validateStrictRequest({ operation: "documentSymbols", path: "a.ts", query: "foo" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/foreign field "query"/);
  });
  it("rejects raw request+path foreign field", () => {
    const r = validateStrictRequest({ operation: "request", method: "textDocument/hover", path: "a.ts" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/foreign field "path"/);
  });
  it("rejects raw request+query foreign field", () => {
    const r = validateStrictRequest({ operation: "request", method: "textDocument/hover", query: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/foreign field "query"/);
  });
  it("rejects negative position", () => {
    const r = validateStrictRequest({ operation: "hover", path: "a.ts", position: { line: -1, character: 0 } });
    expect(r.ok).toBe(false);
  });
  it("rejects null item", () => {
    const r = validateStrictRequest({ operation: "incomingCalls", item: null });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/item must be a record/);
  });
  it("rejects array item", () => {
    const r = validateStrictRequest({ operation: "incomingCalls", item: [1, 2] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/item must be a record/);
  });
  it("rejects primitive item", () => {
    const r = validateStrictRequest({ operation: "incomingCalls", item: "foo" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/item must be a record/);
  });
  it("rejects range with end line before start line", () => {
    const r = validateStrictRequest({
      operation: "formatRange",
      path: "a.ts",
      range: { start: { line: 5, character: 0 }, end: { line: 3, character: 0 } },
    });
    expect(r.ok).toBe(false);
  });
  it("rejects range with end character before start on same line", () => {
    const r = validateStrictRequest({
      operation: "formatRange",
      path: "a.ts",
      range: { start: { line: 2, character: 10 }, end: { line: 2, character: 4 } },
    });
    expect(r.ok).toBe(false);
  });
  it("accepts zero-length range", () => {
    const r = validateStrictRequest({
      operation: "formatRange",
      path: "a.ts",
      range: { start: { line: 2, character: 4 }, end: { line: 2, character: 4 } },
    });
    expect(r.ok).toBe(true);
  });
});

describe("envelope shape vocabularies", () => {
  it("holds readiness + freshness vocabularies", () => {
    const env: StrictEnvelope<string> = {
      status: "empty",
      operation: "findReferences",
      method: "textDocument/references",
      server: { descriptorId: "ts", name: "ts", languageId: "typescript", projectRoot: "/", positionEncoding: "utf-16" },
      result: null,
      meta: {
        freshness: { state: "unknown" },
        readiness: { state: "unknown", basis: "none" },
        truncated: false,
      },
    };
    expect(env.meta.readiness?.state).toBe("unknown");
    expect(env.meta.freshness?.state).toBe("unknown");
    expect(["confirmed", "settling", "unknown"]).toContain(env.meta.readiness?.state);
    expect(["progress", "diagnostic-receipt", "request-completion", "server-specific", "none"]).toContain(
      env.meta.readiness?.basis,
    );
    expect(["fresh", "stale", "unknown"]).toContain(env.meta.freshness?.state);
  });
});

describe("workspaceDiagnostics identifier surface", () => {
  it("accepts bare workspaceDiagnostics", () => {
    expect(validateStrictRequest({ operation: "workspaceDiagnostics" }).ok).toBe(true);
  });
  it("accepts workspaceDiagnostics with identifier", () => {
    const r = validateStrictRequest({ operation: "workspaceDiagnostics", identifier: "diag-1" });
    expect(r.ok).toBe(true);
  });
  it("rejects workspaceDiagnostics+query foreign field", () => {
    const r = validateStrictRequest({ operation: "workspaceDiagnostics", query: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/foreign field "query"/);
  });
  it("rejects empty identifier", () => {
    const r = validateStrictRequest({ operation: "workspaceDiagnostics", identifier: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/identifier must be a non-empty string/);
  });
});

describe("isRawMethodAllowed", () => {
  it("rejects workspace/executeCommand", () => {
    expect(isRawMethodAllowed("workspace/executeCommand")).toBe(false);
  });
  it("rejects workspace/applyEdit", () => {
    expect(isRawMethodAllowed("workspace/applyEdit")).toBe(false);
  });
  it("rejects unknown custom method", () => {
    expect(isRawMethodAllowed("rust-analyzer/expandMacro")).toBe(false);
  });
  it("allows known observational textDocument/hover", () => {
    expect(isRawMethodAllowed("textDocument/hover")).toBe(true);
  });
  it("allows known observational textDocument/definition", () => {
    expect(isRawMethodAllowed("textDocument/definition")).toBe(true);
  });
  it("rejects empty method", () => {
    expect(isRawMethodAllowed("")).toBe(false);
  });
});
