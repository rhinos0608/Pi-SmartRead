import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getOperationDef, listOperations } from "../../../src/lsp/lsp-operation-registry.js";
import type { StrictOperation } from "../../../src/lsp/lsp-strict-contract.js";

const ALL_OPERATIONS: StrictOperation[] = [
  "goToDefinition",
  "goToDeclaration",
  "goToTypeDefinition",
  "goToImplementation",
  "findReferences",
  "hover",
  "documentHighlights",
  "documentSymbols",
  "workspaceSymbols",
  "prepareCallHierarchy",
  "incomingCalls",
  "outgoingCalls",
  "prepareTypeHierarchy",
  "supertypes",
  "subtypes",
  "diagnostics",
  "workspaceDiagnostics",
  "publishedDiagnostics",
  "capabilities",
  "sessionStatus",
  "prepareRename",
  "rename",
  "codeActions",
  "resolveCodeAction",
  "formatDocument",
  "formatRange",
  "formatOnType",
  "completion",
  "resolveCompletion",
  "signatureHelp",
  "inlayHints",
  "resolveInlayHint",
  "semanticTokens",
  "foldingRanges",
  "selectionRanges",
  "request",
];

describe("operation registry", () => {
  it("resolves every StrictOperation", () => {
    for (const op of ALL_OPERATIONS) {
      expect(getOperationDef(op), op).not.toBeNull();
    }
  });

  it("lists all operations with no duplicates", () => {
    const list = listOperations();
    expect(list).toHaveLength(ALL_OPERATIONS.length);
    const names = list.map((d) => d.operation);
    expect(new Set(names).size).toBe(ALL_OPERATIONS.length);
    for (const op of ALL_OPERATIONS) expect(names).toContain(op);
  });

  it("local-only trio has method null", () => {
    for (const op of ["publishedDiagnostics", "capabilities", "sessionStatus"] as const) {
      expect(getOperationDef(op)?.method).toBeNull();
    }
  });

  it("request has method null (method supplied per call)", () => {
    expect(getOperationDef("request")?.method).toBeNull();
  });

  it("every remote operation has a non-null wire method", () => {
    for (const def of listOperations()) {
      if (def.operation === "publishedDiagnostics" || def.operation === "capabilities" ||
          def.operation === "sessionStatus" || def.operation === "request") continue;
      expect(typeof def.method, def.operation).toBe("string");
    }
  });

  it("request bypasses capability gating", () => {
    expect(getOperationDef("request")?.capability).toBeNull();
  });

  it("capability is null only for local-only trio + request", () => {
    const nullCaps = listOperations()
      .filter((d) => d.capability === null)
      .map((d) => d.operation)
      .sort();
    expect(nullCaps).toEqual(["capabilities", "publishedDiagnostics", "request", "sessionStatus"]);
  });

  it("non-idempotent set is exact", () => {
    const nonIdem = listOperations()
      .filter((d) => !d.idempotent)
      .map((d) => d.operation)
      .sort();
    expect(nonIdem).toEqual([
      "codeActions",
      "formatDocument",
      "formatOnType",
      "formatRange",
      "rename",
      "request",
      "resolveCodeAction",
    ]);
  });

  it("pure reads are idempotent", () => {
    for (const op of ["hover", "goToDefinition", "findReferences", "diagnostics",
      "prepareRename", "completion", "signatureHelp", "semanticTokens"] as const) {
      expect(getOperationDef(op)?.idempotent, op).toBe(true);
    }
  });

  it("prepareRename stays idempotent (proposal read, not mutation)", () => {
    expect(getOperationDef("prepareRename")?.idempotent).toBe(true);
  });

  it("required: hover needs path + position", () => {
    expect(getOperationDef("hover")?.required).toEqual(["path", "position"]);
  });

  it("required: rename needs path + position + newName", () => {
    expect(getOperationDef("rename")?.required).toEqual(["path", "position", "newName"]);
  });

  it("required: incomingCalls needs item (exact prepared item)", () => {
    expect(getOperationDef("incomingCalls")?.required).toEqual(["item"]);
  });

  it("required: request needs method", () => {
    expect(getOperationDef("request")?.required).toEqual(["method"]);
  });

  it("required: codeActions needs path + range, formatRange needs path + range", () => {
    expect(getOperationDef("codeActions")?.required).toEqual(["path", "range"]);
    expect(getOperationDef("formatRange")?.required).toEqual(["path", "range"]);
  });

  it("methods match LSP 3.17 wire names", () => {
    expect(getOperationDef("goToDefinition")?.method).toBe("textDocument/definition");
    expect(getOperationDef("goToDeclaration")?.method).toBe("textDocument/declaration");
    expect(getOperationDef("goToTypeDefinition")?.method).toBe("textDocument/typeDefinition");
    expect(getOperationDef("goToImplementation")?.method).toBe("textDocument/implementation");
    expect(getOperationDef("findReferences")?.method).toBe("textDocument/references");
    expect(getOperationDef("hover")?.method).toBe("textDocument/hover");
    expect(getOperationDef("workspaceSymbols")?.method).toBe("workspace/symbol");
    expect(getOperationDef("incomingCalls")?.method).toBe("callHierarchy/incomingCalls");
    expect(getOperationDef("outgoingCalls")?.method).toBe("callHierarchy/outgoingCalls");
    expect(getOperationDef("supertypes")?.method).toBe("typeHierarchy/supertypes");
    expect(getOperationDef("subtypes")?.method).toBe("typeHierarchy/subtypes");
    expect(getOperationDef("diagnostics")?.method).toBe("textDocument/diagnostic");
    expect(getOperationDef("workspaceDiagnostics")?.method).toBe("workspace/diagnostic");
    expect(getOperationDef("resolveCodeAction")?.method).toBe("codeAction/resolve");
    expect(getOperationDef("formatRange")?.method).toBe("textDocument/rangeFormatting");
    expect(getOperationDef("formatOnType")?.method).toBe("textDocument/onTypeFormatting");
    expect(getOperationDef("resolveCompletion")?.method).toBe("completionItem/resolve");
    expect(getOperationDef("resolveInlayHint")?.method).toBe("inlayHint/resolve");
  });

  it("core capabilities map to dedicated features", () => {
    expect(getOperationDef("goToDefinition")?.capability).toBe("definition");
    expect(getOperationDef("findReferences")?.capability).toBe("references");
    expect(getOperationDef("hover")?.capability).toBe("hover");
    expect(getOperationDef("rename")?.capability).toBe("rename");
    expect(getOperationDef("prepareRename")?.capability).toBe("prepareRename");
    expect(getOperationDef("codeActions")?.capability).toBe("codeAction");
    expect(getOperationDef("diagnostics")?.capability).toBe("diagnostics");
  });

  it("returns null for unknown operation", () => {
    expect(getOperationDef("goToMars")).toBeNull();
    expect(getOperationDef("")).toBeNull();
  });

  it("every def carries a non-empty summary", () => {
    for (const def of listOperations()) {
      expect(def.summary.length, def.operation).toBeGreaterThan(0);
    }
  });

  it("module has no runtime imports from connection/manager/bridge/broker", () => {
    const src = readFileSync("src/lsp/lsp-operation-registry.ts", "utf8");
    expect(src).toContain("import type");
    for (const banned of ["lsp-connection", "lsp-manager", "lsp-bridge", "diagnostics-broker"]) {
      expect(src, banned).not.toContain(banned);
    }
  });

  it("exact capabilities are flagged true (gate on live capability)", () => {
    const exactOps = [
      "goToDefinition", "goToDeclaration", "goToTypeDefinition", "goToImplementation",
      "findReferences", "hover", "documentSymbols", "workspaceSymbols",
      "prepareCallHierarchy", "incomingCalls", "outgoingCalls", "diagnostics",
      "workspaceDiagnostics", "prepareRename", "rename", "codeActions",
      "resolveCodeAction", "formatDocument", "formatRange", "formatOnType",
    ] as const;
    for (const op of exactOps) {
      expect(getOperationDef(op)?.capabilityExact, op).toBe(true);
    }
  });

  it("approximate capabilities are flagged false (issue request, classify result)", () => {
    const approx: Array<[StrictOperation, string]> = [
      ["documentHighlights", "shares references gate, no dedicated documentHighlight key"],
      ["prepareTypeHierarchy", "shares typeHierarchy gate, prepare step has no own key"],
      ["supertypes", "shares typeHierarchy gate, direction step has no own key"],
      ["subtypes", "shares typeHierarchy gate, direction step has no own key"],
      ["completion", "shares completion gate, trigger kinds vary by server"],
      ["resolveCompletion", "shares completion/resolve gate, resolve support varies"],
      ["signatureHelp", "shares signatureHelp gate, trigger chars vary by server"],
      ["inlayHints", "shares inlayHint gate, resolve/range support varies"],
      ["resolveInlayHint", "shares inlayHint/resolve gate, resolve support varies"],
      ["semanticTokens", "shares semanticTokens gate, full/delta/range varies"],
      ["foldingRanges", "shares foldingRange gate, no per-kind key"],
      ["selectionRanges", "shares selectionRange gate, no per-kind key"],
    ];
    for (const [op, _why] of approx) {
      expect(getOperationDef(op)?.capabilityExact, op).toBe(false);
    }
  });

  it("request + local-only trio are flagged false (gating N/A, never pre-gate)", () => {
    for (const op of ["request", "publishedDiagnostics", "capabilities", "sessionStatus"] as const) {
      expect(getOperationDef(op)?.capability, op).toBeNull();
      expect(getOperationDef(op)?.capabilityExact, op).toBe(false);
    }
  });
});
