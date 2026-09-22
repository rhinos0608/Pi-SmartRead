/**
 * SmartRead `inspect` tool — four explicit modes sharing one entry point.
 *
 * file → artifact inspection (structural facts + quality signals).
 * directory → ranked repo map + architecture. navigate → LSP-backed symbol
 * navigation + diagnostics. script → bounded read-only multi-hop composition.
 * Query/symbol/action params removed — use grep for code search.
 */
import { Type } from "@sinclair/typebox";
import type { ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { executeInspectV4 } from "./inspect.js";
import type {
    DiagnosticsParams,
    InspectParams,
    InspectV4Input,
    InspectV4Result,
    NavigationParams,
} from "./inspect-types.js";
import type { ContextGraph } from "../context-graph.js";

const SignalsSchema = Type.Array(
    Type.Union([
        Type.Literal("complexity"),
        Type.Literal("public-api"),
        Type.Literal("reuse"),
        Type.Literal("recency"),
        Type.Literal("tests"),
        Type.Literal("deprecation"),
    ]),
    { description: "Signals to compute (default: all)." },
);

const DiffSchema = Type.Union([Type.Literal("unstaged"), Type.Literal("staged"), Type.Literal("HEAD")], {
    description: "Map git diff to affected symbols with risk classification.",
});

const FileAnalysisSchema = Type.Object(
    {
        signals: Type.Optional(SignalsSchema),
        compact: Type.Optional(Type.Boolean({ description: "Compact output (default false for file)." })),
        callDepth: Type.Optional(
            Type.Number({ minimum: 1, maximum: 5, description: "BFS call graph traversal depth (1-5, default 1)." }),
        ),
        callDirection: Type.Optional(
            Type.Union([Type.Literal("callers"), Type.Literal("callees"), Type.Literal("both")], {
                description: "Call graph traversal direction. Requires callDepth.",
            }),
        ),
        deadCode: Type.Optional(Type.Boolean({ description: "Return zero-caller functions in scope." })),
        impact: Type.Optional(Type.Boolean({ description: "Blast radius: files/symbols reachable from target." })),
        diff: Type.Optional(DiffSchema),
        graphSchema: Type.Optional(
            Type.Boolean({ description: "Return graph structure summary (node/edge counts, sample names)." }),
        ),
        hotspots: Type.Optional(Type.Boolean({ description: "Top-N functions by fan-in." })),
        routes: Type.Optional(Type.Boolean({ description: "Extract HTTP route → handler mappings." })),
    },
    { additionalProperties: false },
);

const DirectoryAnalysisSchema = Type.Object(
    {
        mapTokens: Type.Optional(
            Type.Number({ description: "Token budget for directory mode (256-32768, default 4096)." }),
        ),
        focus: Type.Optional(Type.Array(Type.String(), { description: "Files/symbols to boost in directory mode." })),
        compact: Type.Optional(Type.Boolean({ description: "Compact output (default true for directory)." })),
        signals: Type.Optional(SignalsSchema),
        deadCode: Type.Optional(Type.Boolean({ description: "Return zero-caller functions in scope." })),
        impact: Type.Optional(Type.Boolean({ description: "Blast radius: files/symbols reachable from target." })),
        diff: Type.Optional(DiffSchema),
        graphSchema: Type.Optional(
            Type.Boolean({ description: "Return graph structure summary (node/edge counts, sample names)." }),
        ),
        hotspots: Type.Optional(Type.Boolean({ description: "Top-N functions by fan-in." })),
        routes: Type.Optional(Type.Boolean({ description: "Extract HTTP route → handler mappings." })),
        clusters: Type.Optional(Type.Boolean({ description: "Run community detection on import graph." })),
        layers: Type.Optional(Type.Boolean({ description: "Derive architectural layers." })),
        boundaries: Type.Optional(Type.Boolean({ description: "Detect service boundaries from monorepo config." })),
    },
    { additionalProperties: false },
);

const NavigationSchema = Type.Object(
    {
        operation: Type.Union(
            [
                Type.Literal("definition"),
                Type.Literal("references"),
                Type.Literal("implementation"),
                Type.Literal("hover"),
                Type.Literal("documentSymbols"),
                Type.Literal("workspaceSymbols"),
                Type.Literal("prepareCallHierarchy"),
                Type.Literal("incomingCalls"),
                Type.Literal("outgoingCalls"),
            ],
            { description: "LSP navigation operation" },
        ),
        line: Type.Optional(Type.Number({ minimum: 1, description: "1-based line; file-target ops" })),
        character: Type.Optional(Type.Number({ minimum: 1, description: "1-based character; file-target ops" })),
        query: Type.Optional(Type.String({ description: "workspaceSymbols only" })),
        maxResults: Type.Optional(Type.Number({ minimum: 1, maximum: 100, description: "default 20, max 100" })),
    },
    { description: "LSP navigation", additionalProperties: false },
);

const DiagnosticsSchema = Type.Object(
    {
        waitMs: Type.Optional(Type.Number({ minimum: 0, description: "waitMs default 1500" })),
        maxPerFile: Type.Optional(Type.Number({ minimum: 1, description: "max per file default 12" })),
        maxFiles: Type.Optional(Type.Number({ minimum: 1, description: "max files default 20, dir only" })),
    },
    { description: "LSP diagnostics", additionalProperties: false },
);

const ScriptBranchDescription = `WHEN:
- running a multi-hop investigation where each call's arguments depend on the previous call's result (grep a symbol, then LSP references on the hit, then graph impact on those files) that would otherwise cost 3+ sequential round trips

WHEN NOT:
- answering a single lookup that one grep, read, or inspect call already covers
- reading full file prose directly (use plain read; script mode returns a synthesized JSON result, not raw file text)

RETURNS: the script's JSON return value plus a bounded per-call audit log naming each op, its args, the path or resource touched, and its status.

EXAMPLE: { mode: "script", script: "const g = await grep(\\"handleAuth\\", { literal: true }); const r = await read(\\"src/auth.ts\\"); return { hits: g.totalHits, lines: r.totalLines };" }`;

// Flattened schema — providers (e.g. Console Go upstream) require a root
// JSON Schema of type "object" and reject anyOf unions at the top level.
// The four-mode XOR is enforced at runtime in execute() + rejectForeignKeys.
const InspectSchema = Type.Object(
    {
        mode: Type.Union([Type.Literal("file"), Type.Literal("directory"), Type.Literal("navigate"), Type.Literal("script")], {
            description: "Inspect mode to run.",
        }),
        path: Type.Optional(Type.String({ description: "File, directory, or navigation target path. Required for file/directory/navigate; optional cwd anchor for script." })),
        analysis: Type.Optional(Type.Union([FileAnalysisSchema, DirectoryAnalysisSchema], {
            description: "Mode-specific analysis options: file signals/call-graph or directory map/architecture. Must match mode.",
        })),
        navigation: Type.Optional(NavigationSchema),
        diagnostics: Type.Optional(DiagnosticsSchema),
        script: Type.Optional(
            Type.String({
                minLength: 1,
                description: ScriptBranchDescription,
            }),
        ),
    },
    {
        additionalProperties: false,
        description:
            "Inspect modes: file (artifact facts + signals), directory (repo map + architecture), navigate (LSP navigation + diagnostics), script (bounded multi-hop composition).",
    },
);

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

const INSPECT_V4_DESCRIPTION = `Inspect code via explicit modes. { mode: "file", path, analysis? }: structural facts (dependents, dependencies, call sites, parent/children, overrides, re-exports) + quality signals. { mode: "directory", path, analysis? }: ranked repository map + architecture. { mode: "navigate", path, navigation?, diagnostics? }: LSP symbol navigation + diagnostics. { mode: "script", script, path? }: compose a multi-hop investigation where each call's arguments depend on the previous result in one bounded read-only call.`;

function legacyParamError(params: Record<string, unknown>): string | undefined {
    if (params.query !== undefined) return "inspect no longer supports query mode. Use grep('pattern').";
    if (params.symbol !== undefined)
        return "inspect no longer supports symbol mode. Symbol lookup folded into wrapped grep's AST layer.";
    if (params.action !== undefined)
        return 'inspect action param removed. Use { mode: "directory", path: "some/dir" } for repo map.';
    return undefined;
}

/** Reject keys that do not belong to this branch — the runtime half of the discriminated union. */
function rejectForeignKeys(
    raw: Record<string, unknown>,
    mode: string,
    allowed: ReadonlySet<string>,
): string | undefined {
    for (const key of Object.keys(raw)) {
        if (!allowed.has(key)) {
            return `Error: inspect param "${key}" cannot be combined with mode "${mode}"`;
        }
    }
    return undefined;
}

/** Reject unknown option keys inside a branch option bag. */
function rejectUnknownOptions(
    bag: Record<string, unknown>,
    allowed: ReadonlySet<string>,
    what: string,
): string | undefined {
    for (const key of Object.keys(bag)) {
        if (!allowed.has(key)) {
            return `Error: inspect ${what} has no option "${key}"`;
        }
    }
    return undefined;
}

const FILE_MODE_KEYS: ReadonlySet<string> = new Set(["mode", "path", "analysis"]);
const DIRECTORY_MODE_KEYS: ReadonlySet<string> = new Set(["mode", "path", "analysis"]);
const NAVIGATE_MODE_KEYS: ReadonlySet<string> = new Set(["mode", "path", "navigation", "diagnostics"]);
const SCRIPT_MODE_KEYS: ReadonlySet<string> = new Set(["mode", "path", "script"]);

const FILE_ANALYSIS_KEYS: ReadonlySet<string> = new Set([
    "signals",
    "compact",
    "callDepth",
    "callDirection",
    "deadCode",
    "impact",
    "diff",
    "graphSchema",
    "hotspots",
    "routes",
]);

const DIRECTORY_ANALYSIS_KEYS: ReadonlySet<string> = new Set([
    "mapTokens",
    "focus",
    "compact",
    "signals",
    "deadCode",
    "impact",
    "diff",
    "graphSchema",
    "hotspots",
    "routes",
    "clusters",
    "layers",
    "boundaries",
]);

function asObject(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

// ── WP-SR3 navigation/diagnostics validation (decision §1 §2 verbatim matrix) ──
function validateNavigation(
    nav: Record<string, unknown> | undefined,
    mode: "file" | "directory",
): string | undefined {
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
    const fileOps = new Set([
        "definition",
        "references",
        "implementation",
        "hover",
        "prepareCallHierarchy",
        "incomingCalls",
        "outgoingCalls",
    ]);
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

function validateDiagnostics(
    d: Record<string, unknown> | undefined,
    mode: "file" | "directory",
): string | undefined {
    if (!d) return undefined;
    if (mode === "file" && d.maxFiles !== undefined)
        return "Error: inspect diagnostics.maxFiles requires a directory target";
    return undefined;
}

/**
 * Whether this branch actually consumes ContextGraph and therefore justifies
 * awaiting the async `opts.contextGraph` getter. Only directory
 * clusters/layers/graphSchema and file impact/graphSchema read the graph.
 */
function branchNeedsContextGraph(kind: "file" | "directory", bag: Record<string, unknown>): boolean {
    if (kind === "directory") {
        return bag.clusters === true || bag.layers === true || bag.graphSchema === true;
    }
    return bag.impact === true || bag.graphSchema === true;
}

export function createInspectV4Tool(opts: InspectToolOptions): ToolDefinition {
    return {
        name: "inspect",
        label: "inspect",
        description: INSPECT_V4_DESCRIPTION,
        parameters: InspectSchema as unknown as Record<string, unknown>,
        async execute(
            toolCallId: string,
            params: InspectParams & Record<string, unknown>,
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

            const raw = params as Record<string, unknown>;
            const respond = (details: InspectV4Result) => {
                publish(details);
                const navDetails = details.navigation;
                const diagDetails = details.diagnostics;
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
                        ...(Object.keys(extraUpstream).length > 0
                            ? { upstreamDetails: extraUpstream }
                            : details.upstreamDetails !== undefined
                              ? { upstreamDetails: details.upstreamDetails }
                              : {}),
                        ...(navDetails ? { navigation: navDetails } : {}),
                        ...(diagDetails ? { diagnostics: diagDetails } : {}),
                    },
                };
            };

            const resolveGraph = async (): Promise<ContextGraph | undefined> =>
                typeof opts.contextGraph === "function" ? opts.contextGraph(ctx.cwd) : opts.contextGraph;

            switch (raw.mode) {
                case "script": {
                    const foreignErr = rejectForeignKeys(raw, "script", SCRIPT_MODE_KEYS);
                    if (foreignErr) throw new Error(foreignErr);
                    if (typeof raw.script !== "string" || raw.script.length === 0) {
                        throw new Error('Error: inspect param "script" must be a non-empty string');
                    }
                    // `path` is optional in script mode: omitted anchors at cwd.
                    // It acts only as the cwd/default-path anchor for host calls
                    // (reserved slot for a future engine default-dir channel).
                    // Per-call relative paths resolve against cwd exactly as
                    // direct calls do (host bindings use ctx.cwd), so the anchor
                    // is recorded on upstreamDetails.script.anchorPath and never
                    // stat()'d: a script anchored at a nonexistent path still runs.
                    const anchorPath =
                        typeof raw.path === "string" && raw.path.length > 0 ? raw.path : ".";
                    const scriptInput: InspectV4Input = {
                        path: anchorPath,
                        cwd: ctx.cwd,
                        sessionFilePath,
                        signal,
                        script: raw.script,
                    };
                    // Script mode may call any binding, so its needs are unknowable
                    // upfront: pass a lazy no-arg getter and let the engine
                    // resolve/cache it on the first graph.*, impact, or
                    // graphSchema host call. Nothing is built when opts carry no graph.
                    if (typeof opts.contextGraph === "function") {
                        const getGraph = opts.contextGraph;
                        scriptInput.contextGraphGetter = () => getGraph(ctx.cwd);
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
                    const scriptUpstream =
                        ((scriptDetails.upstreamDetails ?? {}) as Record<string, unknown>).script ?? {};
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

                case "file":
                case "directory": {
                    const kind = raw.mode as "file" | "directory";
                    if (kind === "directory" && raw.architecture !== undefined) {
                        throw new Error(
                            'Error: inspect directory option "architecture" removed. Use "analysis" instead: { mode: "directory", path, analysis: { ... } }',
                        );
                    }
                    const foreignErr = rejectForeignKeys(
                        raw,
                        kind,
                        kind === "file" ? FILE_MODE_KEYS : DIRECTORY_MODE_KEYS,
                    );
                    if (foreignErr) throw new Error(foreignErr);
                    if (typeof raw.path !== "string" || raw.path.length === 0) {
                        throw new Error(`Error: inspect mode "${kind}" requires "path"`);
                    }
                    const bagKey = "analysis";
                    const bagRaw = raw[bagKey] ?? {};
                    const bag = asObject(bagRaw);
                    if (!bag) {
                        throw new Error(`Error: inspect mode "${kind}" option "${bagKey}" must be an object`);
                    }
                    const unknownErr = rejectUnknownOptions(
                        bag,
                        kind === "file" ? FILE_ANALYSIS_KEYS : DIRECTORY_ANALYSIS_KEYS,
                        `mode "${kind}" ${bagKey}`,
                    );
                    if (unknownErr) throw new Error(unknownErr);
                    if (kind === "file" && bag.callDirection !== undefined && bag.callDepth === undefined) {
                        throw new Error("Error: inspect callDirection requires callDepth to be set");
                    }

                    const { resolveInspectV4Mode } = await import("./inspect.js");
                    const probe: InspectV4Input = {
                        path: raw.path,
                        cwd: ctx.cwd,
                        sessionFilePath,
                        signal,
                    };
                    const resolvedMode = resolveInspectV4Mode(probe);
                    if (resolvedMode !== kind) {
                        throw new Error(
                            `Error: inspect mode "${kind}" requires a ${kind} target (got ${resolvedMode}: ${raw.path})`,
                        );
                    }

                    // Build input WITHOUT resolving the async contextGraph getter yet —
                    // only graph-dependent options pay for the shared graph build.
                    // Invalid option requests return their error above without
                    // invoking the graph getter.
                    const inspectInput: InspectV4Input = {
                        path: raw.path,
                        cwd: ctx.cwd,
                        sessionFilePath,
                        signal,
                        ...(bag as Record<string, never>),
                    };
                    if (branchNeedsContextGraph(kind, bag)) {
                        // WP-5: resolve contextGraph from DI (await getter so a registered
                        // runtime tool never receives an unbuilt graph).
                        inspectInput.contextGraph = await resolveGraph();
                    }
                    const details = await executeInspectV4(inspectInput);
                    return respond(details);
                }

                case "navigate": {
                    const foreignErr = rejectForeignKeys(raw, "navigate", NAVIGATE_MODE_KEYS);
                    if (foreignErr) throw new Error(foreignErr);
                    if (typeof raw.path !== "string" || raw.path.length === 0) {
                        throw new Error('Error: inspect mode "navigate" requires "path"');
                    }
                    const nav = raw.navigation === undefined ? undefined : asObject(raw.navigation);
                    if (raw.navigation !== undefined && !nav) {
                        throw new Error('Error: inspect mode "navigate" option "navigation" must be an object');
                    }
                    const diag = raw.diagnostics === undefined ? undefined : asObject(raw.diagnostics);
                    if (raw.diagnostics !== undefined && !diag) {
                        throw new Error('Error: inspect mode "navigate" option "diagnostics" must be an object');
                    }
                    const { resolveInspectV4Mode } = await import("./inspect.js");
                    const probe: InspectV4Input = {
                        path: raw.path,
                        cwd: ctx.cwd,
                        sessionFilePath,
                        signal,
                    };
                    const resolvedMode = resolveInspectV4Mode(probe);
                    const navErr = validateNavigation(nav, resolvedMode);
                    if (navErr) throw new Error(navErr);
                    const diagErr = validateDiagnostics(diag, resolvedMode);
                    if (diagErr) throw new Error(diagErr);
                    const navigateInput: InspectV4Input = {
                        path: raw.path,
                        cwd: ctx.cwd,
                        sessionFilePath,
                        signal,
                        ...(nav ? { navigation: nav as unknown as NavigationParams } : {}),
                        ...(diag ? { diagnostics: diag as unknown as DiagnosticsParams } : {}),
                    };
                    if (opts.lspInspectionProvider) {
                        // WP-SR5: thread shared LSP provider — lazy, no server start unless navigation/diagnostics used
                        navigateInput.lspInspectionProvider = opts.lspInspectionProvider;
                    }
                    const details = await executeInspectV4(navigateInput);
                    return respond(details);
                }

                default:
                    throw new Error(
                        'Error: inspect requires "mode" to be one of "file" | "directory" | "navigate" | "script"',
                    );
            }
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
