/**
 * Typed LSP operation registry — Wave 4 leaf module.
 *
 * DATA + lookup only. Executor enforces (capability gating, retry policy).
 * Dependency rule: type-only imports from lsp-strict-contract and
 * lsp-capability-registry. No runtime imports from
 * connection/manager/bridge/broker.
 */

import type { StrictOperation } from "./lsp-strict-contract.js";
import type { LspFeatureId } from "./lsp-capability-registry.js";

export type OperationRequiredField =
  | "path"
  | "position"
  | "range"
  | "query"
  | "item"
  | "newName"
  | "context"
  | "codeAction"
  | "formatting"
  | "method"
  | "params";

export interface OperationDef {
  readonly operation: StrictOperation;
  /** Wire method, or null for local-only ops and `request` (method per call). */
  readonly method: string | null;
  /** Mirrors REQUIRED_FIELDS in lsp-strict-contract.ts. */
  readonly required: readonly OperationRequiredField[];
  /** Registry gate, or null only for local-only trio + `request` (raw policy). */
  readonly capability: LspFeatureId | null;
  /** True = capability maps exactly to server-advertised key; false = approx or N/A (never pre-gate). */
  readonly capabilityExact: boolean;
  /** False = never auto-retry. True = pure observational read. */
  readonly idempotent: boolean;
  readonly summary: string;
}

const REGISTRY: Record<StrictOperation, OperationDef> = {
  goToDefinition: {
    operation: "goToDefinition",
    method: "textDocument/definition",
    required: ["path", "position"],
    capability: "definition",
    capabilityExact: true,
    idempotent: true,
    summary: "Jump to definition of symbol at position.",
  },
  goToDeclaration: {
    operation: "goToDeclaration",
    method: "textDocument/declaration",
    required: ["path", "position"],
    capability: "declaration",
    capabilityExact: true,
    idempotent: true,
    summary: "Jump to declaration of symbol at position.",
  },
  goToTypeDefinition: {
    operation: "goToTypeDefinition",
    method: "textDocument/typeDefinition",
    required: ["path", "position"],
    capability: "typeDefinition",
    capabilityExact: true,
    idempotent: true,
    summary: "Jump to type definition of symbol at position.",
  },
  goToImplementation: {
    operation: "goToImplementation",
    method: "textDocument/implementation",
    required: ["path", "position"],
    capability: "implementation",
    capabilityExact: true,
    idempotent: true,
    summary: "Jump to implementations of interface/abstract symbol at position.",
  },
  findReferences: {
    operation: "findReferences",
    method: "textDocument/references",
    required: ["path", "position"],
    capability: "references",
    capabilityExact: true,
    idempotent: true,
    summary: "Find all references to symbol at position.",
  },
  hover: {
    operation: "hover",
    method: "textDocument/hover",
    required: ["path", "position"],
    capability: "hover",
    capabilityExact: true,
    idempotent: true,
    summary: "Hover documentation and type info at position.",
  },
  documentHighlights: {
    operation: "documentHighlights",
    method: "textDocument/documentHighlight",
    required: ["path", "position"],
    capability: "references",
    capabilityExact: false,
    idempotent: true,
    summary: "Highlight occurrences in document. Capability approx: gated on references (no dedicated highlight feature in registry).",
  },
  documentSymbols: {
    operation: "documentSymbols",
    method: "textDocument/documentSymbol",
    required: ["path"],
    capability: "documentSymbol",
    capabilityExact: true,
    idempotent: true,
    summary: "List symbols defined in document.",
  },
  workspaceSymbols: {
    operation: "workspaceSymbols",
    method: "workspace/symbol",
    required: ["query"],
    capability: "workspaceSymbol",
    capabilityExact: true,
    idempotent: true,
    summary: "Search symbols across workspace by query.",
  },
  prepareCallHierarchy: {
    operation: "prepareCallHierarchy",
    method: "textDocument/prepareCallHierarchy",
    required: ["path", "position"],
    capability: "callHierarchy",
    capabilityExact: true,
    idempotent: true,
    summary: "Prepare call-hierarchy items at position for incoming/outgoing calls.",
  },
  incomingCalls: {
    operation: "incomingCalls",
    method: "callHierarchy/incomingCalls",
    required: ["item"],
    capability: "callHierarchy",
    capabilityExact: true,
    idempotent: true,
    summary: "Callers of prepared hierarchy item. Pass exact item, never re-prepare.",
  },
  outgoingCalls: {
    operation: "outgoingCalls",
    method: "callHierarchy/outgoingCalls",
    required: ["item"],
    capability: "callHierarchy",
    capabilityExact: true,
    idempotent: true,
    summary: "Callees of prepared hierarchy item. Pass exact item, never re-prepare.",
  },
  prepareTypeHierarchy: {
    operation: "prepareTypeHierarchy",
    method: "textDocument/prepareTypeHierarchy",
    required: ["path", "position"],
    capability: "typeDefinition",
    capabilityExact: false,
    idempotent: true,
    summary: "Prepare type-hierarchy items at position. Capability approx: gated on typeDefinition (no dedicated type-hierarchy feature in registry).",
  },
  supertypes: {
    operation: "supertypes",
    method: "typeHierarchy/supertypes",
    required: ["item"],
    capability: "typeDefinition",
    capabilityExact: false,
    idempotent: true,
    summary: "Supertypes of prepared type-hierarchy item. Capability approx: gated on typeDefinition.",
  },
  subtypes: {
    operation: "subtypes",
    method: "typeHierarchy/subtypes",
    required: ["item"],
    capability: "typeDefinition",
    capabilityExact: false,
    idempotent: true,
    summary: "Subtypes of prepared type-hierarchy item. Capability approx: gated on typeDefinition.",
  },
  diagnostics: {
    operation: "diagnostics",
    method: "textDocument/diagnostic",
    required: ["path"],
    capability: "diagnostics",
    capabilityExact: true,
    idempotent: true,
    summary: "Strongest file-scoped diagnostic answer available (pull/push).",
  },
  workspaceDiagnostics: {
    operation: "workspaceDiagnostics",
    method: "workspace/diagnostic",
    required: [],
    capability: "workspaceDiagnostics",
    capabilityExact: true,
    idempotent: true,
    summary: "Explicit workspace diagnostic pull when supported.",
  },
  publishedDiagnostics: {
    operation: "publishedDiagnostics",
    method: null,
    required: ["path"],
    capability: null,
    capabilityExact: false,
    idempotent: true,
    summary: "Local-only: inspect current push cache without claiming freshness.",
  },
  capabilities: {
    operation: "capabilities",
    method: null,
    required: [],
    capability: null,
    capabilityExact: false,
    idempotent: true,
    summary: "Local-only: snapshot of static + dynamic capability registry.",
  },
  sessionStatus: {
    operation: "sessionStatus",
    method: null,
    required: [],
    capability: null,
    capabilityExact: false,
    idempotent: true,
    summary: "Local-only: session/routing introspection for operator debugging.",
  },
  prepareRename: {
    operation: "prepareRename",
    method: "textDocument/prepareRename",
    required: ["path", "position"],
    capability: "prepareRename",
    capabilityExact: true,
    idempotent: true,
    summary: "Validate rename target. Pure read; returns proposal range only.",
  },
  rename: {
    operation: "rename",
    method: "textDocument/rename",
    required: ["path", "position", "newName"],
    capability: "rename",
    capabilityExact: true,
    idempotent: false,
    summary: "Rename proposal only. Never auto-retry; SmartEdit applies.",
  },
  codeActions: {
    operation: "codeActions",
    method: "textDocument/codeAction",
    required: ["path", "range"],
    capability: "codeAction",
    capabilityExact: true,
    idempotent: false,
    summary: "Code-action proposals for range. Never auto-retry.",
  },
  resolveCodeAction: {
    operation: "resolveCodeAction",
    method: "codeAction/resolve",
    required: ["codeAction"],
    capability: "codeAction",
    capabilityExact: true,
    idempotent: false,
    summary: "Resolve deferred code-action edit. Never auto-retry.",
  },
  formatDocument: {
    operation: "formatDocument",
    method: "textDocument/formatting",
    required: ["path"],
    capability: "formatting",
    capabilityExact: true,
    idempotent: false,
    summary: "Whole-document formatting proposal. Never auto-retry.",
  },
  formatRange: {
    operation: "formatRange",
    method: "textDocument/rangeFormatting",
    required: ["path", "range"],
    capability: "formatting",
    capabilityExact: true,
    idempotent: false,
    summary: "Range formatting proposal. Never auto-retry.",
  },
  formatOnType: {
    operation: "formatOnType",
    method: "textDocument/onTypeFormatting",
    required: ["path", "position"],
    capability: "formatting",
    capabilityExact: true,
    idempotent: false,
    summary: "On-type formatting proposal. Never auto-retry.",
  },
  completion: {
    operation: "completion",
    method: "textDocument/completion",
    required: ["path", "position"],
    capability: "documentSymbol",
    capabilityExact: false,
    idempotent: true,
    summary: "Completion items at position. Capability approx: gated on documentSymbol (no dedicated completion feature in registry).",
  },
  resolveCompletion: {
    operation: "resolveCompletion",
    method: "completionItem/resolve",
    required: ["item"],
    capability: "documentSymbol",
    capabilityExact: false,
    idempotent: true,
    summary: "Resolve deferred completion item. Capability approx: gated on documentSymbol.",
  },
  signatureHelp: {
    operation: "signatureHelp",
    method: "textDocument/signatureHelp",
    required: ["path", "position"],
    capability: "hover",
    capabilityExact: false,
    idempotent: true,
    summary: "Signature help at position. Capability approx: gated on hover (no dedicated signature feature in registry).",
  },
  inlayHints: {
    operation: "inlayHints",
    method: "textDocument/inlayHint",
    required: ["path", "range"],
    capability: "hover",
    capabilityExact: false,
    idempotent: true,
    summary: "Inlay hints for range. Capability approx: gated on hover (no dedicated inlay feature in registry).",
  },
  resolveInlayHint: {
    operation: "resolveInlayHint",
    method: "inlayHint/resolve",
    required: ["item"],
    capability: "hover",
    capabilityExact: false,
    idempotent: true,
    summary: "Resolve deferred inlay hint. Capability approx: gated on hover.",
  },
  semanticTokens: {
    operation: "semanticTokens",
    method: "textDocument/semanticTokens/full",
    required: ["path"],
    capability: "documentSymbol",
    capabilityExact: false,
    idempotent: true,
    summary: "Semantic tokens full; range selects full/range variant, cursor selects delta. Capability approx: gated on documentSymbol.",
  },
  foldingRanges: {
    operation: "foldingRanges",
    method: "textDocument/foldingRange",
    required: ["path"],
    capability: "documentSymbol",
    capabilityExact: false,
    idempotent: true,
    summary: "Folding ranges for document. Capability approx: gated on documentSymbol.",
  },
  selectionRanges: {
    operation: "selectionRanges",
    method: "textDocument/selectionRange",
    required: ["path", "position"],
    capability: "documentSymbol",
    capabilityExact: false,
    idempotent: true,
    summary: "Selection ranges at positions. Capability approx: gated on documentSymbol.",
  },
  request: {
    operation: "request",
    method: null,
    required: ["method"],
    capability: null,
    capabilityExact: false,
    idempotent: false,
    summary: "Raw escape hatch: exact method + params per call. Raw policy gates, not capability. Never auto-retry.",
  },
};

/** Lookup single operation def; null for unknown operation names. */
export function getOperationDef(op: StrictOperation | string): OperationDef | null {
  return (REGISTRY as Record<string, OperationDef>)[op] ?? null;
}

/** All registered operation defs in canonical order. */
export function listOperations(): OperationDef[] {
  return Object.values(REGISTRY);
}
