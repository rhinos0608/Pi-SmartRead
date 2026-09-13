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
import type { ContextGraph } from "../context-graph.js";

const InspectV4Schema = Type.Object({
    path: Type.Optional(Type.String({ description: "File or directory path. Directory → repo map. File → structural facts + signals. Optional with script (omitted anchors at cwd)." })),
    script: Type.Optional(Type.String({
        minLength: 1,
        description: `WHEN:
- running a multi-hop investigation where each call's arguments depend on the previous call's result (grep a symbol, then LSP references on the hit, then graph impact on those files) that would otherwise cost 3+ sequential round trips

WHEN NOT:
- answering a single lookup that one grep, read, or inspect call already covers
- reading full file prose directly (use plain read; script mode returns a synthesized JSON result, not raw file text)

RETURNS: the script's JSON return value plus a bounded per-call audit log naming each op, its args, the path or resource touched, and its status.

EXAMPLE: { script: "const g = await grep(\\"handleAuth\\", { literal: true }); const r = await read(\\"src/auth.ts\\"); return { hits: g.totalHits, lines: r.totalLines };" }`,
    }) ) ,
    signals: Type.Optional(Type.Array(
        Type.Union([Type.Literal("complexity"), Type.Literal("public-api"), Type.Literal("reuse"), Type.Literal("recency"), Type.Literal("tests"), Type.Literal("deprecation")]),
        { description: "Signals to compute (default: all)." },
    )),
    mapTokens: Type.Optional(Type.Number({ description: "Token budget for directory mode (256-32768, default 4096)." })),
    focus: Type.Optional(Type.Array(Type.String(), { description: "Files/symbols to boost in directory mode." })),
    compact: Type.Optional(Type.Boolean({ description: "Compact output (default true for directory, false for file)." })),

    // ── WP-4 new params ──────────────────────────────────────────
    callDepth: Type.Optional(Type.Number({
        minimum: 1,
        maximum: 5,
        description: "BFS call graph traversal depth (1-5, default 1). File mode.",
    })),
    callDirection: Type.Optional(Type.Union([
        Type.Literal("callers"),
        Type.Literal("callees"),
        Type.Literal("both"),
    ], { description: "Call graph traversal direction. File mode." })),
    deadCode: Type.Optional(Type.Boolean({
        description: "Return zero-caller functions in scope. File or directory mode.",
    })),
    impact: Type.Optional(Type.Boolean({
        description: "Compute blast radius: files/symbols reachable via call+import graph from target.",
    })),
    diff: Type.Optional(Type.Union([
        Type.Literal("unstaged"),
        Type.Literal("staged"),
        Type.Literal("HEAD"),
    ], { description: "Map git diff to affected symbols with risk classification." })),
    clusters: Type.Optional(Type.Boolean({
        description: "Run community detection on import graph. Directory mode only.",
    })),
    graphSchema: Type.Optional(Type.Boolean({
        description: "Return graph structure summary (node/edge counts, sample names).",
    })),
    hotspots: Type.Optional(Type.Boolean({
        description: "Top-N functions by fan-in. File or directory mode.",
    })),
    boundaries: Type.Optional(Type.Boolean({
        description: "Detect service boundaries from monorepo config. Directory mode only.",
    })),
    routes: Type.Optional(Type.Boolean({
        description: "Extract HTTP route → handler mappings. File or directory mode.",
    })),
    layers: Type.Optional(Type.Boolean({
        description: "Derive architectural layers. Directory mode only.",
    })),
    // ── WP-SR3 LSP params (decision §1 §2 verbatim) ─────────────────
    navigation: Type.Optional(Type.Object({
        operation: Type.Union([
            Type.Literal("definition"),
            Type.Literal("references"),
            Type.Literal("implementation"),
            Type.Literal("hover"),
            Type.Literal("documentSymbols"),
            Type.Literal("workspaceSymbols"),
            Type.Literal("prepareCallHierarchy"),
            Type.Literal("incomingCalls"),
            Type.Literal("outgoingCalls"),
        ], { description: "LSP navigation operation" }),
        line: Type.Optional(Type.Number({ minimum: 1, description: "1-based line; file-target ops" })),
        character: Type.Optional(Type.Number({ minimum: 1, description: "1-based character; file-target ops" })),
        query: Type.Optional(Type.String({ description: "workspaceSymbols only" })),
        maxResults: Type.Optional(Type.Number({ minimum: 1, maximum: 100, description: "default 20, max 100" })),
    }, { description: "LSP navigation" })),
    diagnostics: Type.Optional(Type.Object({
        waitMs: Type.Optional(Type.Number({ minimum: 0, description: "waitMs default 1500" })),
        maxPerFile: Type.Optional(Type.Number({ minimum: 1, description: "max per file default 12" })),
        maxFiles: Type.Optional(Type.Number({ minimum: 1, description: "max files default 20, dir only" })),
    }, { description: "LSP diagnostics" })),
});

type InspectV4ToolInput = Static<typeof InspectV4Schema>;

export interface InspectToolOptions {
    /** Resolver to publish envelopes into on successful execution. */
    readonly resolver?: {
        publishInspection(envelope: unknown, sessionFilePath: string, workspaceRoot: string): void;
    };
    /** Returns the canonical session file path for the current session, or null if ephemeral. */
    readonly getSessionFilePath: () => string | null | undefined;
    /** ContextGraph instance or getter for graph-dependent inspect params (WP-5 DI). */
    readonly contextGraph?: ContextGraph | ((cwd: string) => ContextGraph | Promise<ContextGraph>);
    /** Shared LSP inspection provider — injected by runtime, threaded lazily to inspect (WP-SR5 DI). */
    readonly lspInspectionProvider?: import("../lsp/lsp-inspection.js").LspInspectionProvider;
}

const INSPECT_V4_DESCRIPTION = `Inspect a file or directory to understand code structure and quality. Pass a directory for a ranked repository map with key symbols and architecture; pass a file for structural facts (dependents, dependencies, call sites, parent/children, overrides, re-exports) and quality signals. Analysis modes are set via schema params. For a multi-hop investigation where each call's arguments depend on the previous result, use the script param to compose the chain in one call.`;

function legacyParamError(params: Record<string, unknown>): string | undefined {
    if (params.query !== undefined) return "inspect no longer supports query mode. Use grep('pattern').";
    if (params.symbol !== undefined) return "inspect no longer supports symbol mode. Symbol lookup folded into wrapped grep's AST layer.";
    if (params.action !== undefined) return "inspect action param removed. Use inspect { path: 'some/dir' } for repo map.";
    return undefined;
}

/**
 * Validate dir-only params are not used in file mode.
 * Returns error message or undefined.
 */
function validateDirOnlyParams(
    params: InspectV4ToolInput,
    mode: "file" | "directory",
    filePath: string,
): string | undefined {
    if (mode === "file") {
        const dirOnlyParams = ["clusters", "boundaries", "layers"];
        for (const p of dirOnlyParams) {
            if ((params as Record<string, unknown>)[p] === true) {
                return `Error: inspect param "${p}" requires a directory target (got file: ${filePath})`;
            }
        }
    }
    // callDepth + callDirection are file-mode only
    if (mode === "directory") {
        if (params.callDepth !== undefined) {
            return "Error: inspect callDepth requires a file target";
        }
        if (params.callDirection !== undefined) {
            return "Error: inspect callDirection requires a file target";
        }
    }
    return undefined;
}

/**
 * Validate cross-param constraints (spec §4).
 */
function validateCrossParams(params: InspectV4ToolInput): string | undefined {
    if (params.callDirection !== undefined && params.callDepth === undefined) {
        return "Error: inspect callDirection requires callDepth to be set";
    }
    return undefined;
}

/**
 * Script mode composes its own host calls inside the script, so every
 * mode-specific param is rejected when `script` is present — same
 * "Error: inspect param X ..." style as the dir-only validators.
 */
const SCRIPT_FORBIDDEN_PARAMS = [
    "signals",
    "mapTokens",
    "focus",
    "compact",
    "callDepth",
    "callDirection",
    "deadCode",
    "impact",
    "diff",
    "clusters",
    "graphSchema",
    "hotspots",
    "boundaries",
    "routes",
    "layers",
    "navigation",
    "diagnostics",
] as const;

function validateScriptParams(params: InspectV4ToolInput): string | undefined {
    for (const p of SCRIPT_FORBIDDEN_PARAMS) {
        if ((params as Record<string, unknown>)[p] !== undefined) {
            return `Error: inspect param "${p}" cannot be combined with script (compose that call inside the script instead)`;
        }
    }
    return undefined;
}

// ── WP-SR3 navigation/diagnostics validation (decision §1 §2 verbatim matrix) ──
function validateNavigation(params: Record<string, unknown>, mode: "file" | "directory"): string | undefined {
    const nav = params.navigation as Record<string, unknown> | undefined;
    if (!nav) return undefined;
    const op = nav.operation as string;
    const hasLine = nav.line !== undefined;
    const hasChar = nav.character !== undefined;
    const hasQuery = nav.query !== undefined;
    const hasMax = nav.maxResults !== undefined;
    if (hasMax) {
        const v = nav.maxResults as number;
        if (typeof v !== "number" || v < 1 || v > 100) return "Error: inspect navigation.maxResults must be 1..100";
    }
    const fileOps = new Set(["definition", "references", "implementation", "hover", "prepareCallHierarchy", "incomingCalls", "outgoingCalls"]);
    const docOps = new Set(["documentSymbols"]);
    const wsOps = new Set(["workspaceSymbols"]);
    if (fileOps.has(op)) {
        if (mode !== "file") return `Error: inspect navigation operation "${op}" requires a file target`;
        if (!hasLine || !hasChar) return `Error: inspect navigation operation "${op}" requires line and character`;
        if (hasQuery) return `Error: inspect navigation operation "${op}" forbids query`;
        return undefined;
    }
    if (docOps.has(op)) {
        if (mode !== "file") return `Error: inspect navigation operation "${op}" requires a file target`;
        if (hasLine || hasChar) return `Error: inspect navigation operation "${op}" forbids line/character`;
        if (hasQuery) return `Error: inspect navigation operation "${op}" forbids query`;
        return undefined;
    }
    if (wsOps.has(op)) {
        if (mode !== "directory") return `Error: inspect navigation operation "${op}" requires a directory target`;
        if (!hasQuery) return `Error: inspect navigation operation "${op}" requires query`;
        if (hasLine || hasChar) return `Error: inspect navigation operation "${op}" forbids line/character`;
        return undefined;
    }
    // unknown operation — let inspect handle as degraded rather than throw
    return undefined;
}
function validateDiagnostics(params: Record<string, unknown>, mode: "file" | "directory"): string | undefined {
    const d = params.diagnostics as Record<string, unknown> | undefined;
    if (!d) return undefined;
    if (mode === "file" && d.maxFiles !== undefined) return "Error: inspect diagnostics.maxFiles requires a directory target";
    return undefined;
}

/**
 * Whether this request actually consumes ContextGraph and therefore justifies
 * awaiting the async `opts.contextGraph` getter. Only directory
 * clusters/layers/graphSchema and file impact/graphSchema read the graph;
 * ordinary inspect, signals, call traversal, deadCode, hotspots, diff, routes
 * and boundaries all have non-graph fallbacks.
 */
function needsContextGraph(
    mode: "file" | "directory",
    params: InspectV4ToolInput,
): boolean {
    if (mode === "directory") {
        return params.clusters === true || params.layers === true || params.graphSchema === true;
    }
    return params.impact === true || params.graphSchema === true;
}

function needsLspInspection(params: InspectV4ToolInput): boolean {
    return params.navigation !== undefined || params.diagnostics !== undefined;
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

            // Single best-effort publish path shared by all branches: the
            // merged envelope is published EXACTLY once per outer tool call.
            // The engine itself never publishes (publish stays exclusively
            // in this wrapper per repo convention).
            const publish = (details: { workspaceEvidence: { canonicalWorkspaceRoot: string } }): void => {
                if (opts.resolver) {
                    try {
                        opts.resolver.publishInspection(
                            details.workspaceEvidence as unknown,
                            sessionFilePath,
                            details.workspaceEvidence.canonicalWorkspaceRoot,
                        );
                    } catch {
                        // best-effort; swallow
                    }
                }
            };

            // Script mode: own branch checked BEFORE mode resolution — it
            // never touches the file/dir machinery.
            if (params.script !== undefined) {
                if (typeof params.script !== "string" || params.script.length === 0) {
                    throw new Error('Error: inspect param "script" must be a non-empty string');
                }
                const scriptErr = validateScriptParams(params);
                if (scriptErr) throw new Error(scriptErr);
                // `path` is optional in script mode: omitted anchors at cwd.
                // It acts only as the cwd/default-path anchor for host calls
                // (reserved slot for a future engine default-dir channel).
                // Per-call relative paths resolve against cwd exactly as
                // direct calls do (host bindings use ctx.cwd), so the anchor
                // is recorded on upstreamDetails.script.anchorPath and never
                // stat()'d: a script anchored at a nonexistent path still runs.
                const anchorPath = params.path ?? ".";
                const scriptInput: InspectV4Input = {
                    path: anchorPath,
                    cwd: ctx.cwd,
                    sessionFilePath,
                    signal,
                    script: params.script,
                };
                // Script mode may call any binding (grep/read/inspect/lsp.*/
                // graph.*), so its needs are unknowable upfront: resolve the
                // shared graph getter and LSP provider whenever present in
                // opts (same await-getter mechanism as the lazy path below).
                // Nothing is built when opts carry no graph/provider.
                if (typeof opts.contextGraph === "function") {
                    scriptInput.contextGraph = await opts.contextGraph(ctx.cwd);
                } else if (opts.contextGraph !== undefined) {
                    scriptInput.contextGraph = opts.contextGraph;
                }
                if (opts.lspInspectionProvider) {
                    scriptInput.lspInspectionProvider = opts.lspInspectionProvider;
                }
                const scriptDetails = await executeInspectV4(scriptInput);
                publish(scriptDetails);
                // The engine's contentText already renders the return value
                // plus a compact call-log summary; the bounded call log rides
                // along under upstreamDetails.script so one script call never
                // hides what it inspected.
                const scriptUpstream = ((scriptDetails.upstreamDetails ?? {}) as Record<string, unknown>).script ?? {};
                return {
                    content: [{ type: "text" as const, text: scriptDetails.contentText }],
                    details: {
                        workspaceEvidence: scriptDetails.workspaceEvidence,
                        mode: "query",
                        lineCount: scriptDetails.lineCount,
                        byteLength: scriptDetails.byteLength,
                        truncated: scriptDetails.truncated,
                        toolCallId,
                        upstreamDetails: { script: scriptUpstream },
                    },
                };
            }

            // Path is required without script (schema keeps it optional only
            // so script mode may omit it).
            const targetPath = params.path;
            if (typeof targetPath !== "string" || targetPath.length === 0) {
                throw new Error('Error: inspect param "path" is required without script');
            }

            // Cross-param validation (spec §4)
            const crossErr = validateCrossParams(params);
            if (crossErr) throw new Error(crossErr);

            // Build input WITHOUT resolving the async contextGraph getter yet —
            // only graph-dependent params pay for the shared graph build.
            const inspectInput: InspectV4Input = {
                path: targetPath,
                signals: params.signals,
                mapTokens: params.mapTokens,
                focus: params.focus,
                compact: params.compact,
                cwd: ctx.cwd,
                sessionFilePath,
                signal,
                // WP-4 new params
                callDepth: params.callDepth,
                callDirection: params.callDirection,
                deadCode: params.deadCode,
                impact: params.impact,
                diff: params.diff,
                clusters: params.clusters,
                graphSchema: params.graphSchema,
                hotspots: params.hotspots,
                boundaries: params.boundaries,
                routes: params.routes,
                layers: params.layers,
                // WP-SR3
                navigation: params.navigation as any,
                diagnostics: params.diagnostics as any,
            };

            // Resolve the target mode and run mode-specific validation BEFORE
            // touching the graph. Invalid path / invalid mode-param requests
            // return their existing error without invoking the graph getter.
            const { resolveInspectV4Mode } = await import("./inspect.js");
            const resolvedMode = resolveInspectV4Mode(inspectInput);
            const modeErr = validateDirOnlyParams(params, resolvedMode, targetPath);
            if (modeErr) throw new Error(modeErr);
            const navErr = validateNavigation(params as Record<string, unknown>, resolvedMode);
            if (navErr) throw new Error(navErr);
            const diagErr = validateDiagnostics(params as Record<string, unknown>, resolvedMode);
            if (diagErr) throw new Error(diagErr);

            // Only params that actually consume ContextGraph justify awaiting the
            // async getter: directory clusters/layers/graphSchema and file
            // impact/graphSchema. Ordinary file/directory inspect, signals, call
            // traversal, deadCode, hotspots, diff, routes, boundaries do not.
            if (needsContextGraph(resolvedMode, params)) {
                // WP-5: resolve contextGraph from DI (await getter so a registered
                // runtime tool never receives an unbuilt graph).
                inspectInput.contextGraph =
                    typeof opts.contextGraph === "function"
                        ? await opts.contextGraph(ctx.cwd)
                        : opts.contextGraph;
            }
            if (needsLspInspection(params) && opts.lspInspectionProvider) {
                // WP-SR5: thread shared LSP provider — lazy, no server start unless navigation/diagnostics used
                inspectInput.lspInspectionProvider = opts.lspInspectionProvider;
            }

            const details = await executeInspectV4(inspectInput);

            // Publish into the resolver so patch can request it via RPC.
            // Publishing is best-effort: a resolver failure must not prevent
            // the model from seeing the inspect content (the durable evidence
            // is the returned `details.workspaceEvidence`, not the resolver
            // cache — patch's auto-inspect fallback works even if this fails).
            publish(details);

            // expose WP-SR3 structured details additively (do not close off future status values)
            const navDetails = (details as any).navigation;
            const diagDetails = (details as any).diagnostics;
            const extraUpstream: Record<string, unknown> = { ...(details.upstreamDetails ?? {}) };
            if (navDetails) extraUpstream.navigation = navDetails;
            if (diagDetails) extraUpstream.diagnostics = diagDetails;
            return {
                content: [{ type: "text" as const, text: details.contentText }],
                details: {
                    workspaceEvidence: details.workspaceEvidence,
                    mode: details.mode,
                    lineCount: details.lineCount,
                    byteLength: details.byteLength,
                    truncated: details.truncated,
                    toolCallId,
                    ...(Object.keys(extraUpstream).length > 0 ? { upstreamDetails: extraUpstream } : details.upstreamDetails !== undefined ? { upstreamDetails: details.upstreamDetails } : {}),
                    ...(navDetails ? { navigation: navDetails } : {}),
                    ...(diagDetails ? { diagnostics: diagDetails } : {}),
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
