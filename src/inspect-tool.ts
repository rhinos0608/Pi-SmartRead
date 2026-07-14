/**
 * SmartRead `inspect` tool — multi-mode v3.
 *
 * Modes (one per call, dispatched by input shape):
 *  - path  (default): `{ path }` or `{ path, offset, limit }` — single file + evidence
 *  - query:          `{ query }` or `{ query, depth: "deep" }` — intent-based search + evidence
 *  - symbol:         `{ symbol }` — symbol lookup + evidence
 *  - map:            `{ action: "map" }` — repo structure + evidence
 *
 * Every mode returns a `details.workspaceEvidence` envelope (schema v3)
 * with the appropriate `mode` field. Use this envelope to authorize
 * subsequent patch calls. Query/symbol modes carry weak ("search-match")
 * coverage that patch will reject — the model must path-mode inspect a
 * file before mutating it.
 */
import { Type, type Static } from "@sinclair/typebox";
import type { ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { executeInspectDetails } from "./inspect.js";

const InspectSchema = Type.Object({
    path: Type.Optional(Type.String({ description: 'Regular file path to inspect (relative or absolute). For a directory, use { action: "map", directory: "<path>" } instead.' })),
    offset: Type.Optional(Type.Number({ minimum: 1, description: "1-based start line. Path mode only." })),
    limit: Type.Optional(Type.Number({ minimum: 1, description: "Maximum number of lines to read. Path mode only." })),
    query: Type.Optional(Type.String({ description: "Search intent. Query mode when set (use depth: \"deep\" for multi-channel evidence)." })),
    depth: Type.Optional(Type.Union([Type.Literal("quick"), Type.Literal("deep")], {
        description: "Query depth. \"quick\" (default): grep + AST. \"deep\": grep + AST + semantic + symbol + graph + LSP. Query mode only.",
    })),
    symbol: Type.Optional(Type.String({ description: "Symbol name or qualified path. Symbol mode when set." })),
    action: Type.Optional(Type.Union([Type.Literal("map")], { description: "Specialised action. action: \"map\" produces a repo map (map mode)." })),
    directory: Type.Optional(Type.String({ description: "Optional directory scope (relative to cwd). Used by map mode, and narrows the search root for query mode (both quick and deep depth) and symbol mode." })),
});

type InspectInput = Static<typeof InspectSchema>;

export interface InspectToolOptions {
    /** Resolver to publish envelopes into on successful execution. */
    readonly resolver?: {
        publishInspection(envelope: unknown, sessionFilePath: string, workspaceRoot: string): void;
    };
    /** Returns the canonical session file path for the current session, or null if ephemeral. */
    readonly getSessionFilePath: () => string | null | undefined;
}

const INSPECT_DESCRIPTION =
    "Multi-mode inspect. " +
    "Path mode: { path: \"src/auth.ts\" } or { path, offset, limit } — full/range file read + evidence. " +
    "Query mode: { query: \"refreshToken\" } (default quick: grep + AST) or { query, depth: \"deep\" } (grep + AST + semantic + symbol + graph + LSP). " +
    "Symbol mode: { symbol: \"AuthService.login\" } — symbol lookup + evidence. " +
    "Map mode: { action: \"map\" } — repository structure + evidence. " +
    "Every mode returns a details.workspaceEvidence envelope (schemaVersion 3) with the canonical path, allowed ranges, coverage kind, and (for path mode) SHA-256 freshness. " +
    "Path mode produces strong evidence that authorizes patch. Query and symbol modes produce weak (search-match) evidence — they help you find files, but you must path-mode inspect a file before patch will accept edits to it.";

export function createInspectTool(opts: InspectToolOptions): ToolDefinition {
    return {
        name: "inspect",
        label: "inspect",
        description: INSPECT_DESCRIPTION,
        parameters: InspectSchema as unknown as Record<string, unknown>,
        async execute(
            toolCallId: string,
            params: InspectInput,
            signal: AbortSignal | undefined,
            _onUpdate: unknown,
            ctx: ExtensionContext,
        ) {
            const sessionFilePath = opts.getSessionFilePath() ?? sessionFileFromContext(ctx);
            if (typeof sessionFilePath !== "string" || sessionFilePath.length === 0) {
                throw new Error("inspect: no real session file (in-memory/ephemeral identity rejected)");
            }
            const details = await executeInspectDetails({
                path: params.path,
                query: params.query,
                symbol: params.symbol,
                action: params.action,
                offset: params.offset,
                limit: params.limit,
                depth: params.depth,
                directory: params.directory,
                cwd: ctx.cwd,
                sessionFilePath,
                signal,
            });

            // Publish into the resolver so patch can request it via RPC.
            // Publishing is best-effort: a resolver failure must not prevent
            // the model from seeing the inspect content (the durable evidence
            // is the returned `details.workspaceEvidence`, not the resolver
            // cache — patch's auto-inspect fallback works even if this fails).
            if (opts.resolver) {
                try {
                    opts.resolver.publishInspection(
                        details.workspaceEvidence,
                        sessionFilePath,
                        details.workspaceEvidence.canonicalWorkspaceRoot,
                    );
                } catch {
                    // best-effort; swallow
                }
            }

            return {
                content: [{ type: "text" as const, text: details.contentText }],
                details: {
                    workspaceEvidence: details.workspaceEvidence,
                    mode: details.mode,
                    lineCount: details.lineCount,
                    byteLength: details.byteLength,
                    truncated: details.truncated,
                    toolCallId,
                    ...(details.upstreamDetails !== undefined
                        ? { upstreamDetails: details.upstreamDetails }
                        : {}),
                },
            };
        },
    };
}

/**
 * Default factory: get session file path from a ExtensionAPI + ctx.
 * The actual session file path is available on `ctx.sessionManager.getSessionFile()`.
 */
export function sessionFileFromContext(ctx: ExtensionContext): string | null {
    try {
        const sm = (ctx as { sessionManager?: { getSessionFile?: () => string | undefined } }).sessionManager;
        if (!sm || typeof sm.getSessionFile !== "function") return null;
        const p = sm.getSessionFile();
        if (typeof p !== "string" || p.length === 0) return null;
        return p;
    } catch {
        return null;
    }
}
