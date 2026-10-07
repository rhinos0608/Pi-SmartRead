/**
 * Raw LSP method policy — static fail-closed gate for the raw `request`
 * escape hatch (plan § Raw `request` escape hatch, Side-effect policy).
 *
 * Contract:
 * - Exact observational allowlist. Anything not listed is rejected — unknown
 *   custom methods included. No name inference, no capability lookups.
 * - Known side-effect classes get explicit rejections: executeCommand,
 *   applyEdit, did-style and will-style sync notifications/requests,
 *   publishDiagnostics.
 * - `params` must be a JSON object (plain object, fully JSON-serializable).
 * - No self-authorization: the policy accepts only (method, params). Caller
 *   attestation (readOnly/confirmedSafe/…) is not part of the signature and
 *   cannot influence the decision, whether passed as extra arguments or
 *   smuggled inside params.
 */

export type RawMethodPolicyReason =
  /** Method is on the observational allowlist and params are a JSON object. */
  | "allowed"
  | "invalid-method"
  | "execute-command"
  | "apply-edit"
  | "did-notification"
  | "will-request"
  | "publish-diagnostics"
  | "unknown-method"
  | "params-not-object"
  | "params-not-json";

export interface RawMethodPolicyDecision {
  readonly allowed: boolean;
  readonly reason: RawMethodPolicyReason;
}

/**
 * Exact observational allowlist. Every entry is a client→server request whose
 * result is read-only observation or edit-proposal JSON: proposals never write
 * files (SmartEdit remains the sole mutation authority), and resolve/
 * continuation methods only refine or extend a prior observational answer.
 * Lifecycle (initialize/shutdown/exit) is intentionally absent — transport
 * owns it, the raw escape hatch does not.
 */
const ALLOWED_METHODS: ReadonlySet<string> = new Set([
  // Core navigation / discovery
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
  // Semantic edit proposals (proposal JSON only; no server-side effect)
  "textDocument/prepareRename",
  "textDocument/rename",
  "textDocument/codeAction",
  "codeAction/resolve",
  "textDocument/formatting",
  "textDocument/rangeFormatting",
  "textDocument/onTypeFormatting",
  // Completion + resolve
  "textDocument/completion",
  "completionItem/resolve",
  "textDocument/signatureHelp",
  // Link / lens / hint chains incl. resolve continuations
  "textDocument/documentLink",
  "documentLink/resolve",
  "textDocument/codeLens",
  "codeLens/resolve",
  "textDocument/inlayHint",
  "inlayHint/resolve",
  // Structural ranges
  "textDocument/foldingRange",
  "textDocument/selectionRange",
  // Semantic tokens incl. delta continuation
  "textDocument/semanticTokens/full",
  "textDocument/semanticTokens/full/delta",
  "textDocument/semanticTokens/range",
  // Hierarchy prepare + item continuations (call and type hierarchy share shape)
  "textDocument/prepareCallHierarchy",
  "callHierarchy/incomingCalls",
  "callHierarchy/outgoingCalls",
  "textDocument/prepareTypeHierarchy",
  "typeHierarchy/supertypes",
  "typeHierarchy/subtypes",
  // Pull diagnostics (read-only)
  "textDocument/diagnostic",
  "workspace/diagnostic",
]);

/**
 * Fresh copy of the allowlist for inspection. Callers cannot mutate the
 * policy through this array; there is no exported mutation seam.
 */
export function observationalRawMethods(): string[] {
  return [...ALLOWED_METHODS];
}

function finalSegment(method: string): string {
  const idx = method.lastIndexOf("/");
  return idx === -1 ? method : method.slice(idx + 1);
}

function isJsonObject(params: unknown): params is Record<string, unknown> {
  return typeof params === "object" && params !== null && !Array.isArray(params);
}

/**
 * True only when `params` serializes as strict JSON: circular references,
 * bigint, functions, symbols, undefined-valued properties, and non-finite
 * numbers all fail. JSON.stringify would otherwise silently drop or mangle
 * them, so the replacer rejects instead of normalizing.
 */
function isStrictJson(value: unknown): boolean {
  try {
    JSON.stringify(value, (_key: string, v: unknown) => {
      if (v === undefined || typeof v === "function" || typeof v === "symbol" || typeof v === "bigint") {
        throw new Error("non-JSON value");
      }
      if (typeof v === "number" && !Number.isFinite(v)) {
        throw new Error("non-finite number");
      }
      return v;
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Evaluate a raw method + params pair. Static: the decision is a pure
 * function of the method string and params shape — no server state, no
 * capability registry, no caller-supplied trust signal.
 *
 * Check order (contract; tests assert it): method validity → side-effect
 * class → allowlist → params shape. A rejected class reports its class
 * reason even when params are also malformed.
 */
export function evaluateRawMethodPolicy(method: unknown, params: unknown): RawMethodPolicyDecision {
  if (typeof method !== "string" || method.length === 0) {
    return { allowed: false, reason: "invalid-method" };
  }
  const segment = finalSegment(method);
  if (segment === "executeCommand") {
    return { allowed: false, reason: "execute-command" };
  }
  if (segment === "applyEdit") {
    return { allowed: false, reason: "apply-edit" };
  }
  if (segment.startsWith("did")) {
    return { allowed: false, reason: "did-notification" };
  }
  if (segment.startsWith("will")) {
    return { allowed: false, reason: "will-request" };
  }
  if (segment === "publishDiagnostics") {
    return { allowed: false, reason: "publish-diagnostics" };
  }
  if (!ALLOWED_METHODS.has(method)) {
    return { allowed: false, reason: "unknown-method" };
  }
  if (!isJsonObject(params)) {
    return { allowed: false, reason: "params-not-object" };
  }
  if (!isStrictJson(params)) {
    return { allowed: false, reason: "params-not-json" };
  }
  return { allowed: true, reason: "allowed" };
}

/** Boolean view of {@link evaluateRawMethodPolicy}. Same fail-closed rules. */
export function isRawMethodAllowed(method: unknown, params: unknown): boolean {
  return evaluateRawMethodPolicy(method, params).allowed;
}
