/**
 * Affordance bundle shared contract — Lane P (WP-A foundation only).
 *
 * Frozen types for declaration-anchor resolution. Mechanism borrows B7
 * (Serena declaration name-path addressing) and B8 (pi-lens discovery
 * funnel) are mechanism-only; no source copied.
 *
 * Reviewer-confirmed corrections (frozen here):
 * - Only a genuine `DocumentSymbol.selectionRange` may anchor dispatch.
 *   A collapsed `SymbolInformation.location.range` is NEVER an identifier
 *   selection (see `selectionProvenance` in `lsp-response-normalizer.ts`).
 * - A resolved anchor carries its lookup envelope(s) verbatim so later
 *   recipes (WP-A2) can preserve every strict envelope in
 *   `details.investigation.steps[]`.
 * - An explicit target path must resolve to an existing regular file,
 *   otherwise a distinct `anchor_invalid_path` failure precedes any
 *   symbol lookup (never a false file-scoped `anchor_not_found`).
 */
import type {
  StrictEnvelope,
  StrictServerInfo,
  StrictStatus,
} from "./lsp-strict-contract.js";
import type { ExecutorDeps } from "./lsp-executor.js";

export type AffordanceAnchorTarget =
  | { path: string; position: { line: number; character: number } }
  | { symbol: string; path?: string };

/** Symbol-only anchor target accepted by `resolveAffordanceAnchor`. */
export interface AffordanceSymbolTarget {
  readonly symbol: string;
  readonly path?: string;
}

export type InvestigateTask = "definition" | "type" | "references" | "implementations" | "callers";

export interface AffordanceInvestigateInput {
  operation: "investigate";
  task: InvestigateTask;
  path?: string;
  position?: { line: number; character: number };
  symbol?: string;
  scope?: string;
  workspace?: string;
  server?: string;
  timeoutMs?: number;
}

export type AnchorErrorCode =
  | "ambiguous_anchor"
  | "anchor_not_found"
  | "anchor_invalid_path"
  | "stale_anchor"
  | "anchor_search_incomplete";

export interface AffordanceAction {
  tool: "LSP" | "read" | "inspect" | "grep";
  arguments: Record<string, unknown>;
  reason: string;
}

export const AFFORDANCE_ANCHOR_OPS = [
  "goToDefinition",
  "goToTypeDefinition",
  "goToImplementation",
  "findReferences",
  "hover",
  "prepareCallHierarchy",
] as const;

export const AFFORDANCE_BOUNDS = {
  discoveryCandidates: 100,
  underlyingRequests: 6,
  ambiguityCandidates: 10,
  aggregateDeadlineMs: 15000,
  perStepResults: 100,
  outputBytes: 48 * 1024,
  hintChars: 140,
  maxActions: 2,
  combinedRenderChars: 800,
  classifyChars: 256,
} as const;

export function isAffordancesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PI_SMARTREAD_AFFORDANCES === "1";
}

// Resolver + execution seams (exact exported signatures):
export interface AffordanceBudget {
  maxCandidates: number;
  maxRequests: number;
  deadlineMs: number;
  signal?: AbortSignal;
}

export interface AffordanceExecContext {
  root: string;
  server?: string;
  workspace?: string;
  budget: AffordanceBudget;
  /**
   * Injected strict dispatch seam. Defaults to the real
   * `executeLspOperation`; tests inject a deterministic fake. Strict
   * requests only — never a raw policy bypass.
   */
  exec?: (req: unknown, deps?: ExecutorDeps) => Promise<StrictEnvelope>;
  now?: () => number;
}

export interface AnchorCandidate {
  path: string;
  name: string;
}

export type AnchorResolution =
  | {
      kind: "resolved";
      path: string;
      position: { line: number; character: number };
      server: StrictServerInfo;
      /**
       * The exact `documentSymbols` lookup envelope that produced this
       * anchor, verbatim. Coordinates are in the envelope server's
       * negotiated `positionEncoding`; a recipe (WP-A2) must dispatch
       * without transcoding and must re-check document freshness
       * immediately before dispatch — this envelope proves freshness at
       * resolution time only, never post-dispatch freshness.
       */
      resolutionEnvelope: StrictEnvelope;
    }
  | {
      kind: "unresolved";
      status: StrictStatus;
      /**
       * Anchor conditions use `AnchorErrorCode`; underlying strict
       * failures (`unavailable`, `unsupported`, `timeout`, `cancelled`,
       * `normalization`, admission) propagate with their own code.
       */
      code: AnchorErrorCode | string;
      message: string;
      candidates: AnchorCandidate[];
      /** Every strict lookup envelope behind this outcome, verbatim. */
      envelopes: StrictEnvelope[];
      retry?: string;
    };

export interface InvestigationStep {
  id: string;
  args: Record<string, unknown>;
  envelope: StrictEnvelope;
}

export interface InvestigationOutput {
  status: StrictStatus;
  result: unknown;
  steps: InvestigationStep[];
}
