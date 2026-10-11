/**
 * Strict LSP tool — Wave 5a model-facing registration.
 *
 * Flat TypeBox contract (NO anyOf): operation required, everything else
 * optional. Per-operation shape enforced at runtime by
 * validateStrictRequest inside execute (throws → tool error path).
 * Execute renders the StrictEnvelope as Pi tool-result text and preserves
 * the envelope verbatim under details.envelope — provenance intact, with no
 * fallback substitution anywhere.
 */
import { Type, type Static } from "@sinclair/typebox";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import {
  STRICT_LSP_OPERATIONS,
  validateStrictRequest,
  type StrictOperation,
} from "./lsp-strict-contract.js";
import {
  AFFORDANCE_ANCHOR_OPS,
  AFFORDANCE_BOUNDS,
  type AffordanceExecContext,
  type AffordanceInvestigateInput,
} from "./affordance-contract.js";
import { resolveAffordanceAnchor } from "./affordance-anchor.js";
import { investigateAffordanceTarget, renderBounded } from "./affordance-investigate.js";
import { executeLspActionDetailed, executeLspOperation, type ExecutorDeps } from "./lsp-executor.js";
import { createBoundActionStageRequester } from "./lsp-action-stage-rpc.js";
import { executeBoundAction, type BoundActionOutcome } from "./lsp-action-adapter.js";
import { createBoundActionBudget } from "./lsp-action-origin.js";
import { executeBoundSemanticEdit } from "./lsp-semantic-edit-origin.js";
import { detectLanguageFromExtension } from "./lsp-types.js";
import type { StrictEnvelope, StrictRequest } from "./lsp-strict-contract.js";
import { sessionFileFromCtx } from "../evidence/read-evidence.js";
import {
  applyStagedProposal,
  getWorkspaceEditBus,
  invalidateCachesForPaths,
  type BusLike,
} from "./lsp-workspace-edit.js";

const PositionSchema = Type.Object(
  {
    line: Type.Integer({ minimum: 0, description: "0-based line (negotiated encoding)." }),
    character: Type.Integer({ minimum: 0, description: "0-based character (negotiated encoding)." }),
  },
  { description: "0-based position in negotiated encoding." },
);

const RangeSchema = Type.Object(
  {
    start: PositionSchema,
    end: PositionSchema,
  },
  {
    description:
      "0-based range. Used only by range-aware operations such as codeActions, resolveCodeAction, formatRange, inlayHints, and semanticTokens.",
  },
);

const FormattingSchema = Type.Object(
  {
    tabSize: Type.Integer({ minimum: 1, description: "Formatting tab width." }),
    insertSpaces: Type.Boolean({ description: "Use spaces instead of tabs." }),
  },
  { description: "Formatting options for formatDocument, formatRange, and formatOnType." },
);

const OperationSchema = Type.Unsafe<StrictOperation>({
  type: "string",
  enum: [...STRICT_LSP_OPERATIONS],
  description:
    "Strict operation. Allowed values: " +
    STRICT_LSP_OPERATIONS.join(", ") +
    ". There is no listOperations discovery operation; use this schema as the operation inventory.",
});

const LspSchema = Type.Object(
  {
    operation: OperationSchema,
    workspace: Type.Optional(Type.String({
      description: "Workspace root override. Global field valid on every operation.",
    })),
    server: Type.Optional(Type.String({
      description: "Exact server descriptor id. Global field; routes only to that server, with no fuzzy fallback.",
    })),
    path: Type.Optional(Type.String({
      description:
        "Target file path for document/position operations. Not valid for workspaceSymbols, hierarchy follow-ups, capabilities, sessionStatus, or raw request.",
    })),
    position: Type.Optional(Type.Object(
      PositionSchema.properties,
      {
        description:
          "0-based position for navigation, hierarchy prepare, rename, completion, signatureHelp, formatOnType, and selectionRanges.",
      },
    )),
    range: Type.Optional(RangeSchema),
    ch: Type.Optional(Type.String({
      minLength: 1,
      description: "Required trigger character for formatOnType; pass the character typed by the user.",
    })),
    query: Type.Optional(Type.String({
      minLength: 1,
      description: "Required by workspaceSymbols. workspaceSymbols accepts query, not path.",
    })),
    identifier: Type.Optional(Type.String({
      minLength: 1,
      description: "Optional diagnostic-provider identifier for workspaceDiagnostics only.",
    })),
    item: Type.Optional(Type.Record(Type.String(), Type.Unknown(), {
      description:
        "Exact returned item for incomingCalls/outgoingCalls, supertypes/subtypes, resolveCompletion, or resolveInlayHint.",
    })),
    newName: Type.Optional(Type.String({
      minLength: 1,
      description: "Required new symbol name for rename only.",
    })),
    method: Type.Optional(Type.String({
      minLength: 1,
      description:
        "Required raw LSP method when operation is request. Subject to the observational read-only allowlist.",
    })),
    params: Type.Optional(Type.Record(Type.String(), Type.Unknown(), {
      description: "Raw params for operation request only.",
    })),
    includeDeclaration: Type.Optional(Type.Boolean({
      description: "Optional findReferences flag.",
    })),
    context: Type.Optional(Type.Record(Type.String(), Type.Unknown(), {
      description: "Optional context for codeActions and resolveCodeAction (the same full discovery query), completion, or signatureHelp only.",
    })),
    selection: Type.Optional(Type.Object({
      actionId: Type.String({ minLength: 1, description: "Opaque action identity returned by codeActions." }),
      sourceSha256: Type.String({ pattern: "^[0-9a-f]{64}$", description: "Lowercase SHA-256 of the exact source bytes at discovery." }),
    }, { description: "Selection identity returned by codeActions; required for resolveCodeAction." })),
    formatting: Type.Optional(FormattingSchema),
    limit: Type.Optional(Type.Integer({
      minimum: 1,
      description: "Global pagination page size for list results.",
    })),
    cursor: Type.Optional(Type.String({
      minLength: 1,
      description: "Global pagination cursor returned by a previous LSP envelope.",
    })),
    timeoutMs: Type.Optional(Type.Integer({
      minimum: 1,
      description: "Global per-request timeout in ms.",
    })),
    proposalId: Type.Optional(Type.String({
      minLength: 1,
      description:
        "Proposal id returned by rename, resolveCodeAction, or formatting results; required for applyProposal only.",
    })),
  },
  {
    // additionalProperties left open so foreign fields reach execute(),
    // where validateStrictRequest rejects them via the tool error path.
    description:
      "Strict compiler/language-server semantics (read-only except applyProposal). Use this tool for exact definitions, references, implementations, hover, symbols, type/call hierarchy, diagnostics, completion/signature/inlay information, semantic tokens, and refactor proposals. Use inspect instead for aggregate structural or architectural analysis such as dependency/call-graph summaries, impact, dead code, routes, repo maps, clusters, layers, or service boundaries. Use only the enumerated operation values. Global fields: operation/workspace/server/timeoutMs/limit/cursor. All other fields are operation-specific; foreign fields are rejected. In particular workspaceSymbols is { operation: \"workspaceSymbols\", query } and must not include path.",
  },
);

const AffordanceOperationSchema = Type.Unsafe<string>({
  type: "string",
  enum: [...STRICT_LSP_OPERATIONS, "investigate"],
  description: "Strict LSP operations plus opt-in investigate.",
});

const LspAffordanceSchema = Type.Object(
  {
    ...LspSchema.properties,
    operation: AffordanceOperationSchema,
    symbol: Type.Optional(Type.String({ minLength: 1, description: "Exact declaration name or /-separated hierarchy; only anchor operations and investigate." })),
    task: Type.Optional(Type.String({ enum: ["definition", "type", "references", "implementations", "callers"] })),
    scope: Type.Optional(Type.String({ minLength: 1, description: "Canonical file or directory filter within the selected workspace; investigate only." })),
  },
  { description: "Opt-in strict LSP affordance bundle. Symbol anchors are exact and path-qualified for dispatch." },
);

type LspInput = Static<typeof LspSchema>;

export const LSP_DESCRIPTION = `Compiler/language-server semantic intelligence, read-only except applyProposal. Use LSP for exact definitions, declarations, references, implementations, hover, document/workspace symbols, type/call hierarchy, diagnostics, completion/signature/inlay information, semantic tokens, and refactor/code-action proposals. Use inspect instead for aggregate structural or architectural analysis such as dependency and call-graph summaries, blast radius, dead code, routes, repository maps, clusters, layers, service boundaries, hotspots, and quality signals. Use grep for broad/textual discovery and read for source content at already-known paths. The operation field is an explicit enum; do not invent discovery operations such as listOperations. Use workspaceSymbols with { operation: "workspaceSymbols", query } and no path. Position-based operations such as findReferences use { path, position: { line, character } } with 0-based coordinates in the server's negotiated encoding. Hierarchy/resolve follow-ups consume the exact returned item. The server field routes to one exact server descriptor only, with no fuzzy or silent fallback. Rename, formatting, and resolved code-action (resolveCodeAction) results are proposals; when SmartEdit is loaded they include a proposalId, and applyProposal is the only mutating operation — it applies that staged proposal through SmartEdit's evidence-checked edit path. Foreign fields and missing required fields are tool errors; an "unavailable" envelope is a valid routing outcome.`;

export const LSP_AFFORDANCE_DESCRIPTION = `${LSP_DESCRIPTION} Opt-in affordances add exact declaration-name anchors on supported navigation operations and the investigate recipe (definition, type, references, implementations, callers). Pathless symbol targets are discovery-only and never dispatched.`;

export function getLspToolSchema(affordances = false): Record<string, unknown> {
  return (affordances ? LspAffordanceSchema : LspSchema) as unknown as Record<string, unknown>;
}

export function getLspToolDescription(affordances = false): string {
  return affordances ? LSP_AFFORDANCE_DESCRIPTION : LSP_DESCRIPTION;
}

/** Proposal-bearing semantic operations staged through the bound producer. */
const SEMANTIC_METHODS = {
  rename: "textDocument/rename",
  formatDocument: "textDocument/formatting",
  formatRange: "textDocument/rangeFormatting",
  formatOnType: "textDocument/onTypeFormatting",
} as const;

type SemanticToolOperation = keyof typeof SEMANTIC_METHODS;

function isSemanticToolOperation(operation: string): operation is SemanticToolOperation {
  return Object.hasOwn(SEMANTIC_METHODS, operation);
}

function resolveBus(opts: LspToolOptions, _ctx: ExtensionContext): BusLike | null {
  try {
    const fromOpts = opts.getBus?.();
    if (fromOpts) return fromOpts;
  } catch {
    /* fall through to shared bus */
  }
  return getWorkspaceEditBus();
}

function resolveSessionFilePath(opts: LspToolOptions, ctx: ExtensionContext): string | null {
  try {
    const fromOpts = opts.getSessionFilePath?.();
    if (fromOpts) return fromOpts;
  } catch {
    /* fall through to ctx */
  }
  return sessionFileFromCtx(ctx);
}

function unavailableApplyEnvelope(cwd: string) {
  return {
    status: "unavailable",
    operation: "applyProposal",
    method: "workspaceEdit/apply",
    server: {
      descriptorId: "unknown",
      name: "unknown",
      languageId: "unknown",
      projectRoot: cwd,
      positionEncoding: "utf-16",
    },
    result: null,
    meta: { truncated: false },
  };
}

function resolveExecuteCwd(opts: LspToolOptions, ctx: ExtensionContext): string {
  return opts.executorDeps?.cwd ?? opts.getCwd?.() ?? ctx?.cwd ?? process.cwd();
}

function resolveExecutorDeps(opts: LspToolOptions, cwd: string, signal: AbortSignal | undefined): ExecutorDeps {
  return { ...opts.executorDeps, cwd, signal: opts.executorDeps?.signal ?? signal };
}

function unstagedResult(envelope: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(envelope, null, 2) }],
    details: { envelope },
  };
}

function stagedResult(envelope: unknown, staged: { proposalId: string; files: string[]; diff: string }) {
  const plural = staged.files.length === 1 ? "" : "s";
  const diffSuffix = staged.diff ? `\n${staged.diff}` : "";
  const text =
    `${JSON.stringify(envelope, null, 2)}\n\nStaged proposal ${staged.proposalId} ` +
    `(${staged.files.length} file${plural}: ${staged.files.join(", ")}). ` +
    `Run { operation: "applyProposal", proposalId: "${staged.proposalId}" } to apply it through SmartEdit.` +
    diffSuffix;
  return {
    content: [{ type: "text" as const, text }],
    details: { envelope, proposal: staged },
  };
}

interface ApplyProposalArgs {
  toolCallId: string;
  proposalId: string;
  cwd: string;
  opts: LspToolOptions;
  ctx: ExtensionContext;
}

async function applyProposalResult(args: ApplyProposalArgs) {
  const { proposalId } = args;
  const { cwd } = args;
  const outcome = await applyStagedProposal({
    bus: resolveBus(args.opts, args.ctx),
    proposalId: args.proposalId,
    toolCallId: args.toolCallId,
    sessionFilePath: resolveSessionFilePath(args.opts, args.ctx),
    cwd: args.cwd,
  });
  if (outcome.kind === "unavailable") {
    const envelope = unavailableApplyEnvelope(cwd);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(envelope, null, 2) }],
      details: { envelope },
    };
  }
  if (outcome.kind === "unknown") {
    return {
      content: [{
        type: "text" as const,
        text: `apply outcome unknown: SmartEdit did not confirm proposal ${proposalId} (${outcome.reason}). The change may already be on disk; re-read the affected files before retrying.`,
      }],
      details: { apply: { proposalId, status: "unknown" as const, reason: outcome.reason } },
    };
  }
  const applied = outcome.payload;
  if (applied.status === "applied" && applied.changedFiles.length > 0) {
    invalidateCachesForPaths(applied.changedFiles);
  }
  return {
    content: [{ type: "text" as const, text: applied.text }],
    details: {
      apply: {
        proposalId,
        status: applied.status,
        diagnostics: applied.diagnostics,
        changedFiles: applied.changedFiles,
      },
    },
  };
}

/** Shared bound-producer discipline for proposal-bearing operations (actions and semantic edits).
 *
 * Captures the schedule and dependencies before any context callback runs, dispatches exactly one
 * bound producer call with staging available only when bus+sessionFilePath resolve, then publishes
 * the outcome through the same candidate/projection guards: a staged proposal keeps its public
 * shape, a preview stays read-only, and a refusal publishes a status envelope with result null.
 */
async function executeBoundToolOperation(args: {
  readonly operation: StrictOperation;
  readonly method: string;
  readonly validated: StrictRequest;
  readonly opts: LspToolOptions;
  readonly ctx: ExtensionContext;
  readonly signal: AbortSignal | undefined;
  readonly dispatch: (dispatchArgs: {
    readonly stage: ReturnType<typeof createBoundActionStageRequester> | undefined;
    readonly deps: ExecutorDeps;
    readonly actionCwd: string;
    readonly scheduledNow: () => number;
    readonly deadlineMs: number;
  }) => Promise<BoundActionOutcome>;
}) {
  const { operation, method, validated, opts, ctx, signal: originalSignal, dispatch } = args;
  const actionOpts: LspToolOptions = {
    ...opts,
    ...(opts.executorDeps ? { executorDeps: { ...opts.executorDeps } } : {}),
  };
  const executorDeps = actionOpts.executorDeps ?? {};
  const scheduledNow = executorDeps.now ?? Date.now;
  const timeoutMs = validated.timeoutMs ?? executorDeps.defaultTimeoutMs ?? 15000;
  let started: number;
  try {
    started = scheduledNow();
  } catch {
    started = Number.NaN;
  }
  const deadlineMs = started + timeoutMs;
  const budget = createBoundActionBudget(deadlineMs, originalSignal, scheduledNow);
  const knownUnsupportedEntry = !Number.isFinite(started) || !Number.isFinite(deadlineMs);
  let outcome: BoundActionOutcome | undefined;
  let failure: unknown;
  let candidateEnvelope: StrictEnvelope = {
    status: "unavailable",
    operation,
    method,
    result: null,
    meta: { truncated: false },
  };
  let failed = false;
  let candidate: ReturnType<typeof unstagedResult> | undefined;
  const stopped = (): StrictEnvelope["status"] | null => {
    if (originalSignal?.aborted) return "cancelled";
    if (outcome?.kind === "refusal" && outcome.status === "timeout") return "timeout";
    if (candidateEnvelope.status === "timeout") return "timeout";
    if (knownUnsupportedEntry) return "unsupported";
    const stop = budget.check();
    if (stop === "cancelled") return "cancelled";
    if (stop === "timeout") return "timeout";
    if (stop) return "unavailable";
    return null;
  };
  const stoppedEnvelope = (status: StrictEnvelope["status"]): StrictEnvelope => ({
    ...candidateEnvelope,
    status,
    result: null,
    ...(status === "cancelled" ? { error: { code: "cancelled", message: "Aborted" } } : {}),
  });
  try {
    const entryStop = originalSignal?.aborted ? "cancelled" : knownUnsupportedEntry ? "unsupported" : stopped();
    if (entryStop) {
      candidateEnvelope = stoppedEnvelope(entryStop);
    } else {
      const actionCwd = resolveExecuteCwd(actionOpts, ctx);
      const afterCwd = stopped();
      if (afterCwd) {
        candidateEnvelope = stoppedEnvelope(afterCwd);
      } else {
        const deps = resolveExecutorDeps(actionOpts, actionCwd, originalSignal);
        const bus = resolveBus(actionOpts, ctx);
        const afterBus = stopped();
        if (afterBus) {
          candidateEnvelope = stoppedEnvelope(afterBus);
        } else {
          const sessionFilePath = resolveSessionFilePath(actionOpts, ctx);
          const afterSession = stopped();
          if (afterSession) {
            candidateEnvelope = stoppedEnvelope(afterSession);
          } else {
            const stage = bus && sessionFilePath
              ? createBoundActionStageRequester({ bus, sessionFilePath, cwd: actionCwd })
              : undefined;
            outcome = await dispatch({ stage, deps, actionCwd, scheduledNow, deadlineMs });
            void outcome.cleanup.catch(() => undefined);
            if (outcome.kind === "result") {
              candidateEnvelope = outcome.envelope;
            } else {
              candidateEnvelope = {
                status: outcome.status,
                operation,
                method,
                ...(outcome.server ? { server: outcome.server } : {}),
                result: null,
                meta: { truncated: false },
              };
            }
            const stop = stopped();
            if (stop) candidateEnvelope = stoppedEnvelope(stop);
            candidate = unstagedResult(candidateEnvelope);
            if (!stop && outcome.kind === "result" && outcome.proposal) {
              const { proposalId, files, diff } = outcome.proposal;
              candidate = stagedResult(candidateEnvelope, { proposalId, files: [...files], diff });
            }
          }
        }
      }
    }
  } catch (error) {
    failed = true;
    failure = error;
    candidateEnvelope = stoppedEnvelope(stopped() ?? "unavailable");
  } finally {
    budget.dispose();
  }
  const finalStop = stopped();
  if (finalStop) return unstagedResult(stoppedEnvelope(finalStop));
  if (failed) throw failure;
  return candidate ?? unstagedResult(candidateEnvelope);
}

export interface LspToolOptions {
  readonly executorDeps?: ExecutorDeps;
  readonly getCwd?: () => string;
  /** Event bus for SmartEdit workspace-edit RPC. Defaults to the shared activation bus; null keeps read-only behavior. */
  readonly getBus?: () => BusLike | null;
  /** Session file path override. Defaults to ctx.sessionManager at execute time. */
  readonly getSessionFilePath?: () => string | null;
  /**
   * Executor override, primarily a test seam: module-namespace spies on
   * executeLspOperation are unreliable across platforms (dual module
   * instances under Windows path casing), so tests inject the envelope
   * producer here instead. Production callers omit it.
   */
  readonly executeOperation?: typeof executeLspOperation;
  /** Construction-time opt-in; absent/false preserves the legacy tool surface. */
  readonly affordances?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strictEnvelopeResult(envelope: unknown, steps?: Array<{ id: string; args: Record<string, unknown>; envelope: unknown }>) {
  const { projection, truncated } = renderBounded([envelope]);
  const original = isRecord(envelope) ? envelope : {};
  const boundedEnvelope = truncated
    ? {
        status: "error",
        operation: original.operation,
        result: null,
        error: { code: "output-limit", message: "affordance response exceeds output limit" },
        meta: { truncated: true },
      }
    : projection[0];
  return {
    content: [{ type: "text" as const, text: JSON.stringify(boundedEnvelope) }],
    details: { envelope: boundedEnvelope, ...(steps ? { investigation: { steps } } : {}) },
  };
}

function affordanceContext(opts: LspToolOptions, cwd: string, signal?: AbortSignal, params?: Record<string, unknown>): AffordanceExecContext {
  return {
    root: cwd,
    ...(typeof params?.workspace === "string" ? { workspace: params.workspace } : {}),
    ...(typeof params?.server === "string" ? { server: params.server } : {}),
    budget: { maxCandidates: AFFORDANCE_BOUNDS.discoveryCandidates, maxRequests: AFFORDANCE_BOUNDS.underlyingRequests, deadlineMs: AFFORDANCE_BOUNDS.aggregateDeadlineMs, signal },
    exec: (request, deps) => {
      const validation = validateStrictRequest(request);
      if (!validation.ok) throw new Error(validation.error);
      return (opts.executeOperation ?? executeLspOperation)(validation.value, { ...resolveExecutorDeps(opts, cwd, signal), ...deps, cwd, signal: deps?.signal ?? signal });
    },
  };
}

async function executeInvestigation(params: Record<string, unknown>, opts: LspToolOptions, signal: AbortSignal | undefined, ctx: ExtensionContext) {
  const cwd = resolveExecuteCwd(opts, ctx);
  const output = await investigateAffordanceTarget(params as unknown as AffordanceInvestigateInput, affordanceContext(opts, cwd, signal, params));
  const envelope = {
    status: output.status,
    operation: "investigate",
    result: output.result,
    meta: {
      truncated: Boolean(isRecord(output.result) && output.result.truncated === true)
        || output.steps.some((step) => step.envelope.meta.truncated),
    },
  };
  return strictEnvelopeResult(envelope, output.steps);
}

function hashAnchorFile(path: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

async function executeAnchoredOperation(params: Record<string, unknown>, opts: LspToolOptions, signal: AbortSignal | undefined, ctx: ExtensionContext) {
  const started = Date.now();
  const allowed = new Set(["operation", "workspace", "server", "timeoutMs", "limit", "cursor", "path", "position", "symbol"]);
  for (const key of Object.keys(params)) if (!allowed.has(key)) throw new Error(`foreign field "${key}" not allowed for affordance anchor`);
  for (const field of ["workspace", "server", "cursor"] as const) {
    if (params[field] !== undefined && (typeof params[field] !== "string" || params[field].length === 0)) {
      throw new Error(`operation "${String(params.operation)}": ${field} must be a non-empty string`);
    }
  }
  for (const field of ["timeoutMs", "limit"] as const) {
    if (params[field] !== undefined && (typeof params[field] !== "number" || !Number.isInteger(params[field]) || (params[field] as number) <= 0)) {
      throw new Error(`operation "${String(params.operation)}": ${field} must be a positive integer`);
    }
  }
  if (typeof params.symbol !== "string" || params.symbol.length === 0) throw new Error('anchor: "symbol" must be a non-empty string');
  if (params.path !== undefined && (typeof params.path !== "string" || params.path.length === 0)) {
    throw new Error('anchor: "path" must be a non-empty string');
  }
  if (params.position !== undefined) throw new Error('anchor: "position" and "symbol" are mutually exclusive');
  const cwd = resolveExecuteCwd(opts, ctx);
  const initialHash = typeof params.path === "string" ? hashAnchorFile(resolve(params.workspace as string || cwd, params.path)) : null;
  const resolution = await resolveAffordanceAnchor({ symbol: params.symbol, ...(typeof params.path === "string" ? { path: params.path } : {}) }, affordanceContext(opts, cwd, signal, params));
  if (resolution.kind === "unresolved") {
    const envelope = { status: resolution.status, operation: params.operation, result: null, error: { code: resolution.code, message: resolution.message, data: { candidates: resolution.candidates, ...(resolution.retry ? { retry: resolution.retry } : {}) } }, meta: { truncated: false } };
    return strictEnvelopeResult(envelope, resolution.envelopes.map((stepEnvelope) => ({ id: "anchor.resolve", args: { symbol: params.symbol, ...(params.path ? { path: params.path } : {}) }, envelope: stepEnvelope })));
  }
  const elapsedMs = Date.now() - started;
  if (signal?.aborted) {
    const envelope = { status: "cancelled", operation: params.operation, result: null, error: { code: "cancelled", message: "anchor dispatch cancelled" }, meta: { truncated: false } };
    return strictEnvelopeResult(envelope, [{ id: "anchor.resolve", args: { symbol: params.symbol, ...(params.path ? { path: params.path } : {}) }, envelope: resolution.resolutionEnvelope }]);
  }
  if (elapsedMs >= AFFORDANCE_BOUNDS.aggregateDeadlineMs) {
    const envelope = { status: "timeout", operation: params.operation, result: null, error: { code: "timeout", message: "anchor aggregate deadline exceeded" }, meta: { truncated: false } };
    return strictEnvelopeResult(envelope, [{ id: "anchor.resolve", args: { symbol: params.symbol, ...(params.path ? { path: params.path } : {}) }, envelope: resolution.resolutionEnvelope }]);
  }
  if (resolution.resolutionEnvelope.meta?.freshness?.state === "stale" || (initialHash !== null && hashAnchorFile(resolution.path) !== initialHash)) {
    const envelope = { status: "error", operation: params.operation, result: null, error: { code: "stale_anchor", message: "anchor source changed between resolution and dispatch; re-read and retry" }, meta: { truncated: false } };
    return strictEnvelopeResult(envelope, [{ id: "anchor.resolve", args: { symbol: params.symbol, ...(params.path ? { path: params.path } : {}) }, envelope: resolution.resolutionEnvelope }]);
  }
  const translated: Record<string, unknown> = {
    ...params,
    ...(!params.server && resolution.server.descriptorId !== "unknown" ? { server: resolution.server.descriptorId } : {}),
    path: resolution.path,
    position: resolution.position,
    timeoutMs: Math.min(typeof params.timeoutMs === "number" ? params.timeoutMs : AFFORDANCE_BOUNDS.aggregateDeadlineMs, AFFORDANCE_BOUNDS.aggregateDeadlineMs - elapsedMs),
  };
  delete translated.symbol;
  const validation = validateStrictRequest(translated);
  if (!validation.ok) throw new Error(validation.error);
  const envelope = await (opts.executeOperation ?? executeLspOperation)(validation.value, resolveExecutorDeps(opts, cwd, signal));
  return strictEnvelopeResult(envelope, [
    { id: "anchor.resolve", args: { symbol: params.symbol, ...(params.path ? { path: params.path } : {}) }, envelope: resolution.resolutionEnvelope },
    { id: `anchor.${params.operation}`, args: validation.value as unknown as Record<string, unknown>, envelope },
  ]);
}

export function createLspTool(opts: LspToolOptions = {}): ToolDefinition {
  return {
    name: "LSP",
    label: "LSP",
    description: getLspToolDescription(opts.affordances),
    parameters: getLspToolSchema(opts.affordances),
    async execute(
      _toolCallId: string,
      params: LspInput & Record<string, unknown>,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      if (opts.affordances && isRecord(params) && (params as Record<string, unknown>).operation === "investigate") {
        return executeInvestigation(params, opts, _signal, ctx);
      }
      if (opts.affordances && isRecord(params) && typeof params.operation === "string" && AFFORDANCE_ANCHOR_OPS.includes(params.operation as typeof AFFORDANCE_ANCHOR_OPS[number]) && params.symbol !== undefined) {
        return executeAnchoredOperation(params, opts, _signal, ctx);
      }
      const validation = validateStrictRequest(params as unknown);
      if (!validation.ok) throw new Error(validation.error);
      if (validation.value.operation === "applyProposal") {
        const cwd = resolveExecuteCwd(opts, ctx);
        return applyProposalResult({ toolCallId: _toolCallId, proposalId: validation.value.proposalId as string, cwd, opts, ctx });
      }
      if (validation.value.operation === "codeActions" || validation.value.operation === "resolveCodeAction") {
        const operation = validation.value.operation;
        const method = operation === "codeActions" ? "textDocument/codeAction" : "codeAction/resolve";
        return executeBoundToolOperation({
          operation,
          method,
          validated: validation.value,
          opts,
          ctx,
          signal: _signal,
          dispatch: async ({ stage, deps, scheduledNow, deadlineMs }) => {
            const baseExecuteBoundAction = deps.executeBoundAction ?? executeBoundAction;
            const detailed = await executeLspActionDetailed(validation.value, {
              ...deps,
              ...(stage ? {
                executeBoundAction: (request, route, adapterDeps) => baseExecuteBoundAction(request, route, { ...adapterDeps, stage }),
              } : {}),
              now: scheduledNow,
              signal: _signal,
              actionDeadlineMs: deadlineMs,
            });
            return detailed.outcome;
          },
        });
      }
      if (isSemanticToolOperation(validation.value.operation)) {
        const operation = validation.value.operation;
        return executeBoundToolOperation({
          operation,
          method: SEMANTIC_METHODS[operation],
          validated: validation.value,
          opts,
          ctx,
          signal: _signal,
          dispatch: async ({ stage, actionCwd, scheduledNow, deadlineMs }) => {
            const root = resolve(validation.value.workspace ?? actionCwd);
            const path = typeof validation.value.path === "string" ? resolve(root, validation.value.path) : "";
            const languageId = path ? detectLanguageFromExtension(path) : null;
            if (!languageId) {
              return {
                kind: "refusal",
                status: "unavailable",
                cleanup: Promise.resolve({ state: "not-acquired" as const }),
              };
            }
            return executeBoundSemanticEdit(
              { ...validation.value, path },
              { projectRoot: root, languageId, ...(validation.value.server ? { server: validation.value.server } : {}) },
              {
                deadlineMs,
                ...(_signal ? { signal: _signal } : {}),
                now: scheduledNow,
                ...(stage ? { stage } : {}),
              },
            );
          },
        });
      }
      const cwd = resolveExecuteCwd(opts, ctx);
      const runOperation = opts.executeOperation ?? executeLspOperation;
      const envelope = await runOperation(validation.value, resolveExecutorDeps(opts, cwd, _signal));
      return unstagedResult(envelope);
    },
  } as unknown as ToolDefinition;
}
