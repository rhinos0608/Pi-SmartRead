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
import { executeLspOperation, type ExecutorDeps } from "./lsp-executor.js";
import { sessionFileFromCtx } from "../evidence/read-evidence.js";
import {
  applyStagedProposal,
  envelopeResultToWorkspaceEdit,
  getWorkspaceEditBus,
  invalidateCachesForPaths,
  stageWorkspaceEdit,
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
      "0-based range. Used only by range-aware operations such as codeActions, formatRange, inlayHints, and semanticTokens.",
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
      description: "Optional context for codeActions, completion, or signatureHelp only.",
    })),
    codeAction: Type.Optional(Type.Record(Type.String(), Type.Unknown(), {
      description: "Exact code action returned by codeActions, for resolveCodeAction only.",
    })),
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

/** Proposal-bearing operations whose results are staged with SmartEdit when it answers. */
const STAGEABLE_OPERATIONS = new Set(["rename", "resolveCodeAction", "formatDocument", "formatRange", "formatOnType"]);

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

type StageableRequest = { operation: string; path?: unknown };
type StageableEnvelope = {
  status: string;
  result: unknown;
  server?: { descriptorId?: unknown; positionEncoding?: unknown };
};
interface StageArgs {
  request: StageableRequest;
  envelope: StageableEnvelope;
  cwd: string;
  opts: LspToolOptions;
  ctx: ExtensionContext;
}

function isStageableEnvelope(request: StageableRequest, envelope: StageableEnvelope): boolean {
  if (!STAGEABLE_OPERATIONS.has(request.operation)) return false;
  if (envelope.status !== "ok" || envelope.result == null) return false;
  return true;
}

/** Protocol accepts utf-16 only: fail closed on any other negotiated encoding. */
function hasSupportedEncoding(envelope: StageableEnvelope): boolean {
  const encoding = envelope.server?.positionEncoding;
  if (typeof encoding !== "string") return true;
  return encoding === "utf-16";
}

/** Pure: convert a stageable envelope result into a workspace edit. Null when nothing actionable. */
function buildWorkspaceEditFromEnvelope(
  request: StageableRequest,
  envelope: StageableEnvelope,
  cwd: string,
) {
  const fallback = typeof request.path === "string" ? resolve(cwd, request.path) : undefined;
  return envelopeResultToWorkspaceEdit(envelope.result, fallback);
}

function serverDescriptorOf(envelope: StageableEnvelope): string | undefined {
  const id = envelope.server?.descriptorId;
  return typeof id === "string" ? id : undefined;
}

/** Perform the SmartEdit stage RPC for an already-converted edit. Null on any failure. */
async function stageConvertedEdit(
  args: StageArgs & { workspaceEdit: NonNullable<ReturnType<typeof envelopeResultToWorkspaceEdit>> },
): Promise<{ proposalId: string; files: string[]; diff: string } | null> {
  try {
    const serverDescriptorId = serverDescriptorOf(args.envelope);
    const staged = await stageWorkspaceEdit({
      bus: resolveBus(args.opts, args.ctx),
      workspaceEdit: args.workspaceEdit,
      operation: args.request.operation,
      ...(serverDescriptorId ? { serverDescriptorId } : {}),
      sessionFilePath: resolveSessionFilePath(args.opts, args.ctx),
      cwd: args.cwd,
    });
    if (!staged || !staged.ok) return null;
    return { proposalId: staged.proposalId, files: staged.files, diff: staged.diff };
  } catch {
    return null;
  }
}

/** Stage proposal-bearing results with SmartEdit. Null keeps the read-only result. Never throws. */
async function maybeStageProposal(args: StageArgs): Promise<{ proposalId: string; files: string[]; diff: string } | null> {
  try {
    if (!isStageableEnvelope(args.request, args.envelope)) return null;
    if (!hasSupportedEncoding(args.envelope)) return null;
    const workspaceEdit = buildWorkspaceEditFromEnvelope(args.request, args.envelope, args.cwd);
    if (!workspaceEdit) return null;
    return await stageConvertedEdit({ ...args, workspaceEdit });
  } catch {
    return null;
  }
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
      const cwd = resolveExecuteCwd(opts, ctx);
      if (validation.value.operation === "applyProposal") {
        return applyProposalResult({ toolCallId: _toolCallId, proposalId: validation.value.proposalId as string, cwd, opts, ctx });
      }
      const runOperation = opts.executeOperation ?? executeLspOperation;
      const envelope = await runOperation(validation.value, resolveExecutorDeps(opts, cwd, _signal));
      const staged = await maybeStageProposal({ request: validation.value, envelope, cwd, opts, ctx });
      if (!staged) return unstagedResult(envelope);
      return stagedResult(envelope, staged);
    },
  } as unknown as ToolDefinition;
}
