/**
 * SmartRead `inspect` tool — v4 path-based mode detection.
 *
 * Directory → ranked repo map. File → structural facts + quality signals.
 * Query/symbol/action params removed — use grep for code search.
 */
import { Type, type Static } from "@sinclair/typebox";
import type { ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { executeInspectV4 } from "./inspect.js";
import type { InspectV4Input } from "./inspect-types.js";

const InspectV4Schema = Type.Object({
    path: Type.String({ description: "File or directory path. Directory → repo map. File → structural facts + signals." }),
    signals: Type.Optional(Type.Array(
        Type.Union([Type.Literal("complexity"), Type.Literal("public-api"), Type.Literal("reuse"), Type.Literal("recency"), Type.Literal("tests"), Type.Literal("deprecation")]),
        { description: "Signals to compute (default: all)." },
    )),
    mapTokens: Type.Optional(Type.Number({ description: "Token budget for directory mode (256-32768, default 4096)." })),
    focus: Type.Optional(Type.Array(Type.String(), { description: "Files/symbols to boost in directory mode." })),
    compact: Type.Optional(Type.Boolean({ description: "Compact output (default true for directory, false for file)." })),
});

type InspectV4ToolInput = Static<typeof InspectV4Schema>;

export interface InspectToolOptions {
    /** Resolver to publish envelopes into on successful execution. */
    readonly resolver?: {
        publishInspection(envelope: unknown, sessionFilePath: string, workspaceRoot: string): void;
    };
    /** Returns the canonical session file path for the current session, or null if ephemeral. */
    readonly getSessionFilePath: () => string | null | undefined;
}

const INSPECT_V4_DESCRIPTION = `Inspect a file or directory to understand code structure and quality.
- Pass a directory to get a ranked repository map with key symbols and architecture.
- Pass a file to get structural facts: callers, parent class, children, base classes, overrides, re-exports, plus quality signals (complexity, public API, deprecation, test presence, reuse breadth, recency).

Every mode returns a details.workspaceEvidence envelope (schemaVersion 3).
File mode produces weak (search-match) evidence — you must read a file before editing it. Map mode produces no file authorization.`;

function legacyParamError(params: Record<string, unknown>): string | undefined {
    if (params.query !== undefined) return "inspect no longer supports query mode. Use grep('pattern').";
    if (params.symbol !== undefined) return "inspect no longer supports symbol mode. Symbol lookup folded into wrapped grep's AST layer.";
    if (params.action !== undefined) return "inspect action param removed. Use inspect { path: 'some/dir' } for repo map.";
    return undefined;
}

export function createInspectV4Tool(opts: InspectToolOptions): ToolDefinition {
    return {
        name: "inspect",
        label: "inspect",
        description: INSPECT_V4_DESCRIPTION,
        parameters: InspectV4Schema as unknown as Record<string, unknown>,
        async execute(
            toolCallId: string,
            params: InspectV4ToolInput & Record<string, unknown>,
            signal: AbortSignal | undefined,
            _onUpdate: unknown,
            ctx: ExtensionContext,
        ) {
            // Migration errors for legacy params
            const legacyErr = legacyParamError(params);
            if (legacyErr) throw new Error(legacyErr);

            const sessionFilePath = opts.getSessionFilePath() ?? sessionFileFromContext(ctx);
            if (typeof sessionFilePath !== "string" || sessionFilePath.length === 0) {
                throw new Error("inspect: no real session file (in-memory/ephemeral identity rejected)");
            }
            const inspectInput: InspectV4Input = {
                path: params.path,
                signals: params.signals,
                mapTokens: params.mapTokens,
                focus: params.focus,
                compact: params.compact,
                cwd: ctx.cwd,
                sessionFilePath,
                signal,
            };
            const details = await executeInspectV4(inspectInput);

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

/** @deprecated Use createInspectV4Tool. Kept for backward compat until callers update. */
export const createInspectTool = createInspectV4Tool;

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
