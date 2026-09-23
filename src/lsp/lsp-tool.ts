/**
 * Strict LSP tool — Wave 5a model-facing registration.
 *
 * Flat TypeBox contract (NO anyOf): operation required, everything else
 * optional. Per-operation shape enforced at runtime by
 * validateStrictRequest inside execute (throws → tool error path).
 * Execute returns the StrictEnvelope verbatim — provenance intact,
 * no fallback substitution anywhere.
 */
import { Type, type Static } from "@sinclair/typebox";
import type { ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { validateStrictRequest } from "./lsp-strict-contract.js";
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
  { description: "Range with 0-based start/end positions." },
);

const LspSchema = Type.Object(
  {
    operation: Type.String({ description: "Strict LSP operation (e.g. goToDefinition, hover, workspaceSymbols, diagnostics, request)." }),
    workspace: Type.Optional(Type.String({ description: "Workspace root override." })),
    server: Type.Optional(Type.String({ description: "Exact server descriptor id — routes to that server only." })),
    path: Type.Optional(Type.String({ description: "Target file path." })),
    position: Type.Optional(PositionSchema),
    range: Type.Optional(RangeSchema),
    query: Type.Optional(Type.String({ description: "Query string (workspaceSymbols only)." })),
    identifier: Type.Optional(Type.String({ minLength: 1, description: "Diagnostic-provider identifier (workspaceDiagnostics only)." })),
    item: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Hierarchy/resolve item payload." })),
    newName: Type.Optional(Type.String({ description: "New name (rename)." })),
    method: Type.Optional(Type.String({ description: "Raw LSP method (operation \"request\" only)." })),
    params: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Raw LSP params (operation \"request\" only)." })),
    includeDeclaration: Type.Optional(Type.Boolean({ description: "Include declaration in findReferences." })),
    context: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    codeAction: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    formatting: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    limit: Type.Optional(Type.Integer({ minimum: 1, description: "Page size for list results." })),
    cursor: Type.Optional(Type.String({ description: "Pagination cursor." })),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1, description: "Per-request timeout in ms." })),
  },
  {
    // additionalProperties left open so foreign fields reach execute(),
    // where validateStrictRequest rejects them via the tool error path.
    description: "Strict LSP request. Flat contract — per-operation shape validated at runtime.",
  },
);

type LspInput = Static<typeof LspSchema>;

export const LSP_DESCRIPTION = `Read-only LSP access over the strict contract. Positions are 0-based in the server's negotiated encoding (see envelope server.positionEncoding). The server field routes to an exact server only — no fuzzy matching, no silent fallback. Rename/format/codeAction results are proposals (workspace edits), not mutations — this tool never writes files. Unknown operations, foreign fields, and missing required fields are tool errors. Unroutable requests return an "unavailable" envelope, not an error.`;

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
      return executeLspOperation(validation.value, deps);
    },
  } as unknown as ToolDefinition;
}
