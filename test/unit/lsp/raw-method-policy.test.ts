import { describe, expect, it } from "vitest";
import {
  evaluateRawMethodPolicy,
  isRawMethodAllowed,
  observationalRawMethods,
} from "../../../src/lsp/lsp-raw-method-policy.js";

describe("raw method policy — exact observational allowlist", () => {
  it("permits every allowlisted method with JSON-object params", () => {
    const methods = observationalRawMethods();
    expect(methods.length).toBeGreaterThan(0);
    for (const method of methods) {
      expect(evaluateRawMethodPolicy(method, {})).toEqual({ allowed: true, reason: "allowed" });
    }
  });

  it("includes all resolve continuation names", () => {
    for (const method of [
      "completionItem/resolve",
      "codeAction/resolve",
      "workspaceSymbol/resolve",
      "documentLink/resolve",
      "codeLens/resolve",
      "inlayHint/resolve",
    ]) {
      expect(isRawMethodAllowed(method, {})).toBe(true);
    }
  });

  it("includes hierarchy and semantic-token continuation names", () => {
    for (const method of [
      "callHierarchy/incomingCalls",
      "callHierarchy/outgoingCalls",
      "typeHierarchy/supertypes",
      "typeHierarchy/subtypes",
      "textDocument/semanticTokens/full/delta",
    ]) {
      expect(isRawMethodAllowed(method, {})).toBe(true);
    }
  });

  it("allows nested JSON-object params", () => {
    expect(
      evaluateRawMethodPolicy("textDocument/definition", {
        textDocument: { uri: "file:///a.ts" },
        position: { line: 1, character: 2 },
      }),
    ).toEqual({ allowed: true, reason: "allowed" });
  });

  it("returns a fresh array that cannot mutate the policy", () => {
    const copy = observationalRawMethods();
    copy.push("evil/custom");
    expect(evaluateRawMethodPolicy("evil/custom", {})).toEqual({
      allowed: false,
      reason: "unknown-method",
    });
    expect(observationalRawMethods()).not.toContain("evil/custom");
  });
});

describe("raw method policy — side-effect class rejections", () => {
  it("rejects executeCommand in any namespace", () => {
    for (const method of ["workspace/executeCommand", "myext/executeCommand"]) {
      expect(evaluateRawMethodPolicy(method, {})).toEqual({ allowed: false, reason: "execute-command" });
    }
  });

  it("rejects applyEdit in any namespace", () => {
    for (const method of ["workspace/applyEdit", "myext/applyEdit"]) {
      expect(evaluateRawMethodPolicy(method, {})).toEqual({ allowed: false, reason: "apply-edit" });
    }
  });

  it("rejects did-style document/workspace sync methods", () => {
    for (const method of [
      "textDocument/didOpen",
      "textDocument/didChange",
      "textDocument/didClose",
      "textDocument/didSave",
      "workspace/didChangeConfiguration",
      "workspace/didChangeWatchedFiles",
      "workspace/didCreateFiles",
      "workspace/didRenameFiles",
      "workspace/didDeleteFiles",
      "notebookDocument/didOpen",
    ]) {
      expect(evaluateRawMethodPolicy(method, {})).toEqual({ allowed: false, reason: "did-notification" });
    }
  });

  it("rejects will-style file-operation requests", () => {
    for (const method of [
      "textDocument/willSave",
      "textDocument/willSaveWaitUntil",
      "workspace/willCreateFiles",
      "workspace/willRenameFiles",
      "workspace/willDeleteFiles",
    ]) {
      expect(evaluateRawMethodPolicy(method, {})).toEqual({ allowed: false, reason: "will-request" });
    }
  });

  it("rejects publishDiagnostics", () => {
    expect(evaluateRawMethodPolicy("textDocument/publishDiagnostics", { uri: "file:///a.ts" })).toEqual({
      allowed: false,
      reason: "publish-diagnostics",
    });
  });

  it("rejects unknown methods, including custom and lifecycle methods", () => {
    for (const method of [
      "rust-analyzer/expandMacro",
      "myext/customQuery",
      "initialize",
      "initialized",
      "shutdown",
      "exit",
      "$/customRequest",
      "workspace/executeCommandWithArgs",
    ]) {
      expect(evaluateRawMethodPolicy(method, {})).toEqual({ allowed: false, reason: "unknown-method" });
    }
  });

  it("reports the method class before checking params", () => {
    expect(evaluateRawMethodPolicy("workspace/executeCommand", 5)).toEqual({
      allowed: false,
      reason: "execute-command",
    });
    expect(evaluateRawMethodPolicy("textDocument/didOpen", "not-an-object")).toEqual({
      allowed: false,
      reason: "did-notification",
    });
    expect(evaluateRawMethodPolicy("evil/custom", 5)).toEqual({ allowed: false, reason: "unknown-method" });
  });
});

describe("raw method policy — method validation", () => {
  it("rejects non-string and empty methods", () => {
    for (const method of [42, null, undefined, {}, [], true, ""]) {
      expect(evaluateRawMethodPolicy(method, {})).toEqual({ allowed: false, reason: "invalid-method" });
    }
  });
});

describe("raw method policy — params must be a JSON object", () => {
  it("rejects non-object params", () => {
    for (const params of [null, undefined, "text", 42, true, [1, 2]]) {
      expect(evaluateRawMethodPolicy("textDocument/definition", params)).toEqual({
        allowed: false,
        reason: "params-not-object",
      });
    }
  });

  it("rejects params JSON.stringify would silently mangle", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const rejected: unknown[] = [
      circular,
      { fn: () => 1 },
      { n: NaN },
      { n: Infinity },
      { big: 10n },
      { gone: undefined },
      { sym: Symbol("x") },
    ];
    for (const params of rejected) {
      expect(evaluateRawMethodPolicy("textDocument/definition", params)).toEqual({
        allowed: false,
        reason: "params-not-json",
      });
    }
  });

  it("accepts an empty params object", () => {
    expect(evaluateRawMethodPolicy("textDocument/definition", {})).toEqual({
      allowed: true,
      reason: "allowed",
    });
  });
});

describe("raw method policy — no self-authorization", () => {
  it("ignores attestation passed as extra arguments", () => {
    const loose = isRawMethodAllowed as unknown as (...args: unknown[]) => boolean;
    expect(loose("workspace/executeCommand", {}, { readOnly: true, confirmedSafe: true })).toBe(false);
    expect(loose("evil/custom", {}, { authorize: true })).toBe(false);
  });

  it("ignores attestation smuggled inside params", () => {
    expect(evaluateRawMethodPolicy("workspace/executeCommand", { readOnly: true, confirmedSafe: true })).toEqual({
      allowed: false,
      reason: "execute-command",
    });
    expect(evaluateRawMethodPolicy("evil/custom", { readOnly: true })).toEqual({
      allowed: false,
      reason: "unknown-method",
    });
  });

  it("exposes no mutation seam on the decision", () => {
    const decision = evaluateRawMethodPolicy("evil/custom", {});
    expect(decision.allowed).toBe(false);
    expect(isRawMethodAllowed("textDocument/definition", {})).toBe(true);
    expect(isRawMethodAllowed("workspace/applyEdit", {})).toBe(false);
  });
});
