/**
 * Strict LSP contract — Wave 4 stage 1: TYPES + PURE CLASSIFICATION ONLY.
 *
 * Dependency-free module: no imports from connection/manager/bridge.
 * No transport, no executor wiring, no MCP/tool registration.
 *
 * NOTE: `isRawMethodAllowed` below reuses the semantics of
 * `lsp-raw-method-policy.ts` WITHOUT importing it (kept dependency-free
 * by design). The Wave 4 executor will converge the two later.
 */

export type StrictStatus =
  | "ok"
  | "empty"
  | "unsupported"
  | "unavailable"
  | "not_ready"
  | "timeout"
  | "cancelled"
  | "error"
  | "ambiguous";

export type StrictOperation =
  | "goToDefinition"
  | "goToDeclaration"
  | "goToTypeDefinition"
  | "goToImplementation"
  | "findReferences"
  | "hover"
  | "documentHighlights"
  | "documentSymbols"
  | "workspaceSymbols"
  | "prepareCallHierarchy"
  | "incomingCalls"
  | "outgoingCalls"
  | "prepareTypeHierarchy"
  | "supertypes"
  | "subtypes"
  | "diagnostics"
  | "workspaceDiagnostics"
  | "publishedDiagnostics"
  | "capabilities"
  | "sessionStatus"
  | "prepareRename"
  | "rename"
  | "codeActions"
  | "resolveCodeAction"
  | "formatDocument"
  | "formatRange"
  | "formatOnType"
  | "completion"
  | "resolveCompletion"
  | "signatureHelp"
  | "inlayHints"
  | "resolveInlayHint"
  | "semanticTokens"
  | "foldingRanges"
  | "selectionRanges"
  | "request";

export interface StrictPosition {
  readonly line: number;
  readonly character: number;
}

export interface StrictRange {
  readonly start: StrictPosition;
  readonly end: StrictPosition;
}

export interface StrictRequest {
  readonly operation: StrictOperation;
  readonly workspace?: string;
  readonly server?: string;
  readonly path?: string;
  readonly position?: StrictPosition;
  readonly range?: StrictRange;
  readonly query?: string;
  readonly identifier?: string;
  readonly includeDeclaration?: boolean;
  readonly item?: Record<string, unknown>;
  readonly newName?: string;
  readonly context?: Record<string, unknown>;
  readonly codeAction?: Record<string, unknown>;
  readonly formatting?: { tabSize: number; insertSpaces: boolean };
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly limit?: number;
  readonly cursor?: string;
  readonly timeoutMs?: number;
}

export type ReadinessState = "confirmed" | "settling" | "unknown";
export type ReadinessBasis =
  | "progress"
  | "diagnostic-receipt"
  | "request-completion"
  | "server-specific"
  | "none";

export interface Readiness {
  readonly state: ReadinessState;
  readonly basis: ReadinessBasis;
}

export type FreshnessState = "fresh" | "stale" | "unknown";

export interface Freshness {
  readonly state: FreshnessState;
  readonly documentVersion?: number;
  readonly resultId?: string;
}

export type PositionEncoding = "utf-8" | "utf-16" | "utf-32";

export interface StrictServerInfo {
  readonly descriptorId: string;
  readonly name: string;
  readonly languageId: string;
  readonly projectRoot: string;
  readonly positionEncoding: PositionEncoding;
}

export interface StrictMeta {
  readonly documentVersion?: number;
  readonly freshness?: Freshness;
  readonly readiness?: Readiness;
  readonly source?: string;
  readonly truncated: boolean;
  readonly nextCursor?: string;
}

export interface StrictError {
  readonly code?: string;
  readonly message: string;
  readonly data?: unknown;
}

export interface StrictEnvelope<T = unknown> {
  readonly status: StrictStatus;
  readonly operation: StrictOperation;
  readonly method: string;
  readonly server: StrictServerInfo;
  readonly result: T | null;
  readonly meta: StrictMeta;
  readonly error?: StrictError;
}

const OPERATIONS: ReadonlySet<string> = new Set([
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
]);

/** Globally allowed on every operation (never foreign). */
const GLOBAL_FIELDS: ReadonlySet<string> = new Set([
  "operation",
  "workspace",
  "server",
  "timeoutMs",
  "limit",
  "cursor",
]);

/** Per-operation allowed fields beyond the global set. */
const FIELD_MATRIX: Readonly<Record<StrictOperation, ReadonlySet<string>>> = {
  goToDefinition: new Set(["path", "position"]),
  goToDeclaration: new Set(["path", "position"]),
  goToTypeDefinition: new Set(["path", "position"]),
  goToImplementation: new Set(["path", "position"]),
  findReferences: new Set(["path", "position", "includeDeclaration"]),
  hover: new Set(["path", "position"]),
  documentHighlights: new Set(["path", "position"]),
  documentSymbols: new Set(["path"]),
  workspaceSymbols: new Set(["query"]),
  prepareCallHierarchy: new Set(["path", "position"]),
  incomingCalls: new Set(["item"]),
  outgoingCalls: new Set(["item"]),
  prepareTypeHierarchy: new Set(["path", "position"]),
  supertypes: new Set(["item"]),
  subtypes: new Set(["item"]),
  diagnostics: new Set(["path"]),
  workspaceDiagnostics: new Set(["identifier"]),
  publishedDiagnostics: new Set(["path"]),
  capabilities: new Set([]),
  sessionStatus: new Set([]),
  prepareRename: new Set(["path", "position"]),
  rename: new Set(["path", "position", "newName"]),
  codeActions: new Set(["path", "range", "context"]),
  resolveCodeAction: new Set(["codeAction"]),
  formatDocument: new Set(["path", "formatting"]),
  formatRange: new Set(["path", "range", "formatting"]),
  formatOnType: new Set(["path", "position", "formatting"]),
  completion: new Set(["path", "position", "context"]),
  resolveCompletion: new Set(["item"]),
  signatureHelp: new Set(["path", "position", "context"]),
  inlayHints: new Set(["path", "range"]),
  resolveInlayHint: new Set(["item"]),
  semanticTokens: new Set(["path", "range"]),
  foldingRanges: new Set(["path"]),
  selectionRanges: new Set(["path", "position"]),
  request: new Set(["method", "params"]),
};

/** Required fields per operation (beyond `operation` itself). */
const REQUIRED_FIELDS: Readonly<Record<StrictOperation, readonly string[]>> = {
  goToDefinition: ["path", "position"],
  goToDeclaration: ["path", "position"],
  goToTypeDefinition: ["path", "position"],
  goToImplementation: ["path", "position"],
  findReferences: ["path", "position"],
  hover: ["path", "position"],
  documentHighlights: ["path", "position"],
  documentSymbols: ["path"],
  workspaceSymbols: ["query"],
  prepareCallHierarchy: ["path", "position"],
  incomingCalls: ["item"],
  outgoingCalls: ["item"],
  prepareTypeHierarchy: ["path", "position"],
  supertypes: ["item"],
  subtypes: ["item"],
  diagnostics: ["path"],
  workspaceDiagnostics: [],
  publishedDiagnostics: ["path"],
  capabilities: [],
  sessionStatus: [],
  prepareRename: ["path", "position"],
  rename: ["path", "position", "newName"],
  codeActions: ["path", "range"],
  resolveCodeAction: ["codeAction"],
  formatDocument: ["path"],
  formatRange: ["path", "range"],
  formatOnType: ["path", "position"],
  completion: ["path", "position"],
  resolveCompletion: ["item"],
  signatureHelp: ["path", "position"],
  inlayHints: ["path", "range"],
  resolveInlayHint: ["item"],
  semanticTokens: ["path"],
  foldingRanges: ["path"],
  selectionRanges: ["path", "position"],
  request: ["method"],
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isValidFormatting(v: unknown): v is { tabSize: number; insertSpaces: boolean } {
  if (!isRecord(v)) return false;
  const rec = v as { tabSize?: unknown; insertSpaces?: unknown };
  return (
    typeof rec.tabSize === "number" &&
    Number.isInteger(rec.tabSize) &&
    rec.tabSize > 0 &&
    typeof rec.insertSpaces === "boolean"
  );
}

function isValidPosition(v: unknown): v is StrictPosition {
  if (!isRecord(v)) return false;
  const { line, character } = v as { line?: unknown; character?: unknown };
  return (
    typeof line === "number" &&
    Number.isInteger(line) &&
    line >= 0 &&
    typeof character === "number" &&
    Number.isInteger(character) &&
    character >= 0
  );
}

function isValidRange(v: unknown): v is StrictRange {
  if (!isRecord(v)) return false;
  const { start, end } = v as { start?: unknown; end?: unknown };
  if (!isValidPosition(start) || !isValidPosition(end)) return false;
  if (end.line < start.line) return false;
  if (end.line === start.line && end.character < start.character) return false;
  return true;
}

export type StrictRequestValidation =
  | { ok: true; value: StrictRequest }
  | { ok: false; error: string };

export function validateStrictRequest(req: unknown): StrictRequestValidation {
  if (!isRecord(req)) return { ok: false, error: "request must be an object" };
  const { operation } = req as { operation?: unknown };
  if (typeof operation !== "string" || !OPERATIONS.has(operation)) {
    return { ok: false, error: `unknown operation: ${String(operation)}` };
  }
  const op = operation as StrictOperation;
  const allowed = new Set<string>([...GLOBAL_FIELDS, ...FIELD_MATRIX[op]]);
  for (const key of Object.keys(req)) {
    if (!allowed.has(key)) {
      return { ok: false, error: `foreign field "${key}" not allowed for operation "${op}"` };
    }
  }
  for (const field of REQUIRED_FIELDS[op]) {
    if ((req as Record<string, unknown>)[field] === undefined) {
      return { ok: false, error: `operation "${op}" requires field "${field}"` };
    }
  }
  const r = req as Record<string, unknown>;
  if (r.workspace !== undefined && !isNonEmptyString(r.workspace)) {
    return { ok: false, error: `operation "${op}": workspace must be a non-empty string` };
  }
  if (r.server !== undefined && !isNonEmptyString(r.server)) {
    return { ok: false, error: `operation "${op}": server must be a non-empty string` };
  }
  if (r.path !== undefined && !isNonEmptyString(r.path)) {
    return { ok: false, error: `operation "${op}": path must be a non-empty string` };
  }
  if (r.cursor !== undefined && !isNonEmptyString(r.cursor)) {
    return { ok: false, error: `operation "${op}": cursor must be a non-empty string` };
  }
  if (r.includeDeclaration !== undefined && typeof r.includeDeclaration !== "boolean") {
    return { ok: false, error: `operation "${op}": includeDeclaration must be a boolean` };
  }
  if (r.item !== undefined && !isRecord(r.item)) {
    return { ok: false, error: `operation "${op}": item must be a record` };
  }
  if (r.context !== undefined && !isRecord(r.context)) {
    return { ok: false, error: `operation "${op}": context must be a record` };
  }
  if (r.codeAction !== undefined && !isRecord(r.codeAction)) {
    return { ok: false, error: `operation "${op}": codeAction must be a record` };
  }
  if (r.formatting !== undefined && !isValidFormatting(r.formatting)) {
    return { ok: false, error: `operation "${op}": invalid formatting {tabSize, insertSpaces}` };
  }
  if (r.params !== undefined && !isRecord(r.params)) {
    return { ok: false, error: `operation "${op}": params must be a record` };
  }
  if (r.position !== undefined && !isValidPosition(r.position)) {
    return { ok: false, error: `operation "${op}": invalid 0-based position {line, character}` };
  }
  if (r.range !== undefined && !isValidRange(r.range)) {
    return { ok: false, error: `operation "${op}": invalid range {start, end}` };
  }
  if (r.query !== undefined && (typeof r.query !== "string" || r.query.length === 0)) {
    return { ok: false, error: `operation "${op}": query must be a non-empty string` };
  }
  if (r.identifier !== undefined && (typeof r.identifier !== "string" || r.identifier.length === 0)) {
    return { ok: false, error: `operation "${op}": identifier must be a non-empty string (diagnostic-provider identifier)` };
  }
  if (r.method !== undefined && (typeof r.method !== "string" || r.method.length === 0)) {
    return { ok: false, error: `operation "${op}": method must be a non-empty string` };
  }
  if (r.newName !== undefined && (typeof r.newName !== "string" || r.newName.length === 0)) {
    return { ok: false, error: `operation "${op}": newName must be a non-empty string` };
  }
  if (r.limit !== undefined && (typeof r.limit !== "number" || !Number.isInteger(r.limit) || r.limit <= 0)) {
    return { ok: false, error: `operation "${op}": limit must be a positive integer` };
  }
  if (r.timeoutMs !== undefined && (typeof r.timeoutMs !== "number" || !Number.isInteger(r.timeoutMs) || r.timeoutMs <= 0)) {
    return { ok: false, error: `operation "${op}": timeoutMs must be a positive integer` };
  }
  return { ok: true, value: req as unknown as StrictRequest };
}

export type TransportEventKind =
  | "success-value"
  | "success-empty"
  | "unsupported"
  | "no-session"
  | "state-missing"
  | "timeout"
  | "cancelled"
  | "transport-error"
  | "ambiguous";

export interface TransportEvent {
  readonly kind: TransportEventKind;
  readonly detail?: string;
}

/**
 * Pure executor-outcome → status mapping.
 * ok: non-empty success; empty: null/empty success; unsupported: live server
 * lacks capability; unavailable: no routable session; not_ready: required
 * doc/session state missing; timeout: deadline; cancelled: caller abort won;
 * error: server/transport/protocol/normalization error; ambiguous:
 * multi-candidate exact-selection.
 */
export function classifyStatus(event: TransportEvent): StrictStatus {
  switch (event.kind) {
    case "success-value":
      return "ok";
    case "success-empty":
      return "empty";
    case "unsupported":
      return "unsupported";
    case "no-session":
      return "unavailable";
    case "state-missing":
      return "not_ready";
    case "timeout":
      return "timeout";
    case "cancelled":
      return "cancelled";
    case "transport-error":
      return "error";
    case "ambiguous":
      return "ambiguous";
  }
}

// NOTE: local copy of the observational allowlist semantics from
// lsp-raw-method-policy.ts (NOT imported — this module stays dependency-free;
// the Wave 4 executor will converge them later). Fail-closed: anything not
// listed, including workspace/executeCommand, workspace/applyEdit, and
// unknown custom methods, is rejected.
const OBSERVATIONAL_METHODS: ReadonlySet<string> = new Set([
  "textDocument/declaration",
  "textDocument/definition",
  "textDocument/typeDefinition",
  "textDocument/implementation",
  "textDocument/references",
  "textDocument/hover",
  "textDocument/documentHighlight",
  "textDocument/documentSymbol",
  "workspace/symbol",
  "workspaceSymbol/resolve",
  "textDocument/prepareRename",
  "textDocument/rename",
  "textDocument/codeAction",
  "codeAction/resolve",
  "textDocument/formatting",
  "textDocument/rangeFormatting",
  "textDocument/onTypeFormatting",
  "textDocument/completion",
  "completionItem/resolve",
  "textDocument/signatureHelp",
  "textDocument/documentLink",
  "documentLink/resolve",
  "textDocument/codeLens",
  "codeLens/resolve",
  "textDocument/inlayHint",
  "inlayHint/resolve",
  "textDocument/foldingRange",
  "textDocument/selectionRange",
  "textDocument/semanticTokens/full",
  "textDocument/semanticTokens/full/delta",
  "textDocument/semanticTokens/range",
  "textDocument/prepareCallHierarchy",
  "callHierarchy/incomingCalls",
  "callHierarchy/outgoingCalls",
  "textDocument/prepareTypeHierarchy",
  "typeHierarchy/supertypes",
  "typeHierarchy/subtypes",
  "textDocument/diagnostic",
  "workspace/diagnostic",
]);

export function isRawMethodAllowed(method: string): boolean {
  if (typeof method !== "string" || method.length === 0) return false;
  const segment = method.includes("/") ? method.slice(method.lastIndexOf("/") + 1) : method;
  if (segment === "executeCommand") return false;
  if (segment === "applyEdit") return false;
  return OBSERVATIONAL_METHODS.has(method);
}
