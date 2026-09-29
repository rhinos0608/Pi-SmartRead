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
import type { ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import {
  STRICT_LSP_OPERATIONS,
  validateStrictRequest,
  type StrictOperation,
} from "./lsp-strict-contract.js";
import { executeLspOperation, type ExecutorDeps } from "./lsp-executor.js";

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
  },
  {
    // additionalProperties left open so foreign fields reach execute(),
    // where validateStrictRequest rejects them via the tool error path.
    description:
      "Strict read-only compiler/language-server semantics. Use this tool for exact definitions, references, implementations, hover, symbols, type/call hierarchy, diagnostics, completion/signature/inlay information, semantic tokens, and refactor proposals. Use inspect instead for aggregate structural or architectural analysis such as dependency/call-graph summaries, impact, dead code, routes, repo maps, clusters, layers, or service boundaries. Use only the enumerated operation values. Global fields: operation/workspace/server/timeoutMs/limit/cursor. All other fields are operation-specific; foreign fields are rejected. In particular workspaceSymbols is { operation: \"workspaceSymbols\", query } and must not include path.",
  },
);

type LspInput = Static<typeof LspSchema>;

export const LSP_DESCRIPTION = `Read-only compiler/language-server semantic intelligence. Use LSP for exact definitions, declarations, references, implementations, hover, document/workspace symbols, type/call hierarchy, diagnostics, completion/signature/inlay information, semantic tokens, and refactor/code-action proposals. Use inspect instead for aggregate structural or architectural analysis such as dependency and call-graph summaries, blast radius, dead code, routes, repository maps, clusters, layers, service boundaries, hotspots, and quality signals. Use grep for broad/textual discovery and read for source content at already-known paths. The operation field is an explicit enum; do not invent discovery operations such as listOperations. Use workspaceSymbols with { operation: "workspaceSymbols", query } and no path. Position-based operations such as findReferences use { path, position: { line, character } } with 0-based coordinates in the server's negotiated encoding. Hierarchy/resolve follow-ups consume the exact returned item. The server field routes to one exact server descriptor only, with no fuzzy or silent fallback. Rename/format/codeAction results are proposals, never mutations. Foreign fields and missing required fields are tool errors; an "unavailable" envelope is a valid routing outcome.`;

export interface LspToolOptions {
  readonly executorDeps?: ExecutorDeps;
  readonly getCwd?: () => string;
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
      const deps: ExecutorDeps = {
        ...opts.executorDeps,
        cwd: opts.executorDeps?.cwd ?? opts.getCwd?.() ?? ctx?.cwd ?? process.cwd(),
        signal: opts.executorDeps?.signal ?? _signal,
      };
      const envelope = await executeLspOperation(validation.value, deps);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(envelope, null, 2) }],
        details: { envelope },
      };
    },
  } as unknown as ToolDefinition;
}
