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
import { resolve } from "node:path";
import type { ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import {
  STRICT_LSP_OPERATIONS,
  validateStrictRequest,
  type StrictOperation,
} from "./lsp-strict-contract.js";
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

type LspInput = Static<typeof LspSchema>;

export const LSP_DESCRIPTION = `Compiler/language-server semantic intelligence, read-only except applyProposal. Use LSP for exact definitions, declarations, references, implementations, hover, document/workspace symbols, type/call hierarchy, diagnostics, completion/signature/inlay information, semantic tokens, and refactor/code-action proposals. Use inspect instead for aggregate structural or architectural analysis such as dependency and call-graph summaries, blast radius, dead code, routes, repository maps, clusters, layers, service boundaries, hotspots, and quality signals. Use grep for broad/textual discovery and read for source content at already-known paths. The operation field is an explicit enum; do not invent discovery operations such as listOperations. Use workspaceSymbols with { operation: "workspaceSymbols", query } and no path. Position-based operations such as findReferences use { path, position: { line, character } } with 0-based coordinates in the server's negotiated encoding. Hierarchy/resolve follow-ups consume the exact returned item. The server field routes to one exact server descriptor only, with no fuzzy or silent fallback. Rename, formatting, and resolved code-action (resolveCodeAction) results are proposals; when SmartEdit is loaded they include a proposalId, and applyProposal is the only mutating operation — it applies that staged proposal through SmartEdit's evidence-checked edit path. Foreign fields and missing required fields are tool errors; an "unavailable" envelope is a valid routing outcome.`;

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

async function applyProposalResult(
  toolCallId: string,
  proposalId: string,
  cwd: string,
  opts: LspToolOptions,
  ctx: ExtensionContext,
) {
  const outcome = await applyStagedProposal({
    bus: resolveBus(opts, ctx),
    proposalId,
    toolCallId,
    sessionFilePath: resolveSessionFilePath(opts, ctx),
    cwd,
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

/** Stage proposal-bearing results with SmartEdit. Null keeps today's read-only result. Never throws. */
async function maybeStageProposal(
  request: { operation: string; path?: unknown },
  envelope: { status: string; result: unknown; server?: { descriptorId?: unknown; positionEncoding?: unknown } },
  cwd: string,
  opts: LspToolOptions,
  ctx: ExtensionContext,
): Promise<{ proposalId: string; files: string[]; diff: string } | null> {
  try {
    if (!STAGEABLE_OPERATIONS.has(request.operation)) return null;
    if (envelope.status !== "ok" || envelope.result == null) return null;
    // Protocol accepts utf-16 only: fail closed on any other negotiated encoding.
    if (
      typeof envelope.server?.positionEncoding === "string" &&
      envelope.server.positionEncoding !== "utf-16"
    ) {
      return null;
    }
    const fallback = typeof request.path === "string" ? resolve(cwd, request.path) : undefined;
    const workspaceEdit = envelopeResultToWorkspaceEdit(envelope.result, fallback);
    if (!workspaceEdit) return null;
    const serverDescriptorId =
      typeof envelope.server?.descriptorId === "string" ? envelope.server.descriptorId : undefined;
    const staged = await stageWorkspaceEdit({
      bus: resolveBus(opts, ctx),
      workspaceEdit,
      operation: request.operation,
      ...(serverDescriptorId ? { serverDescriptorId } : {}),
      sessionFilePath: resolveSessionFilePath(opts, ctx),
      cwd,
    });
    if (!staged || !staged.ok) return null;
    return { proposalId: staged.proposalId, files: staged.files, diff: staged.diff };
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
}

export function createLspTool(opts: LspToolOptions = {}): ToolDefinition {
  return {
    name: "LSP",
    label: "LSP",
    description: LSP_DESCRIPTION,
    parameters: LspSchema as unknown as Record<string, unknown>,
    async execute(
      _toolCallId: string,
      params: LspInput & Record<string, unknown>,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      const validation = validateStrictRequest(params as unknown);
      if (!validation.ok) throw new Error(validation.error);
      const cwd = opts.executorDeps?.cwd ?? opts.getCwd?.() ?? ctx?.cwd ?? process.cwd();
      if (validation.value.operation === "applyProposal") {
        return applyProposalResult(_toolCallId, validation.value.proposalId as string, cwd, opts, ctx);
      }
      const deps: ExecutorDeps = {
        ...opts.executorDeps,
        cwd,
        signal: opts.executorDeps?.signal ?? _signal,
      };
      const envelope = await executeLspOperation(validation.value, deps);
      const staged = await maybeStageProposal(validation.value, envelope, cwd, opts, ctx);
      if (!staged) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify(envelope, null, 2) }],
          details: { envelope },
        };
      }
      const text =
        `${JSON.stringify(envelope, null, 2)}\n\nStaged proposal ${staged.proposalId} ` +
        `(${staged.files.length} file${staged.files.length === 1 ? "" : "s"}: ${staged.files.join(", ")}). ` +
        `Run { operation: "applyProposal", proposalId: "${staged.proposalId}" } to apply it through SmartEdit.` +
        (staged.diff ? `\n${staged.diff}` : "");
      return {
        content: [{ type: "text" as const, text }],
        details: { envelope, proposal: staged },
      };
    },
  } as unknown as ToolDefinition;
}
