/**
 * SmartRead `inspect` tool — single-file additive inspect.
 *
 * Reuses the existing read engine (via `createReadTool`) to get the file text,
 * then computes the durable `workspaceEvidence` envelope in `details`.
 */
import { Type, type Static } from "@sinclair/typebox";
import type { ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { computeInspectDetails } from "./inspect.js";

const InspectSchema = Type.Object({
    path: Type.String({ description: "File path to inspect (relative or absolute)." }),
    offset: Type.Optional(Type.Number({ minimum: 1, description: "1-based start line." })),
    limit: Type.Optional(Type.Number({ minimum: 1, description: "Maximum number of lines to read." })),
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

export function createInspectTool(opts: InspectToolOptions): ToolDefinition {
    return {
        name: "inspect",
        label: "inspect",
        description:
            "Inspect a single file. Returns a structured `details.workspaceEvidence` envelope (schemaVersion 1) with the canonical path, allowed ranges, and a full-file SHA-256 freshness hash. Use this to authorize subsequent patch calls.",
        parameters: InspectSchema as unknown as Record<string, unknown>,
        async execute(
            toolCallId: string,
            params: InspectInput,
            _signal: AbortSignal | undefined,
            _onUpdate: unknown,
            ctx: ExtensionContext,
        ) {
            const sessionFilePath = opts.getSessionFilePath() ?? sessionFileFromContext(ctx);
            if (typeof sessionFilePath !== "string" || sessionFilePath.length === 0) {
                throw new Error("inspect: no real session file (in-memory/ephemeral identity rejected)");
            }
            const details = computeInspectDetails({
                path: params.path,
                offset: params.offset,
                limit: params.limit,
                cwd: ctx.cwd,
                sessionFilePath,
            });

            // Publish into the resolver so patch can request it via RPC.
            if (opts.resolver) {
                opts.resolver.publishInspection(
                    details.workspaceEvidence,
                    sessionFilePath,
                    details.workspaceEvidence.canonicalWorkspaceRoot,
                );
            }

            return {
                content: [{ type: "text" as const, text: details.contentText }],
                details: {
                    workspaceEvidence: details.workspaceEvidence,
                    lineCount: details.lineCount,
                    byteLength: details.byteLength,
                    truncated: details.truncated,
                    toolCallId,
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
