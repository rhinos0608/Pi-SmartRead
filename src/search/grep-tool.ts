/**
 * Wrapped grep tool — primary code search with BM25 + AST symbol cascade.
 *
 * Facade: schema/dispatch/evidence/format. Engines live in
 * grep-cascade.ts (lexical/BM25/symbol/semantic fusion + corpus cache)
 * and grep-structural-executor.ts (structural pagination/graph/details).
 *
 * literal:true → direct lexical grep.
 * Otherwise: Layer1 BM25 + Layer2 AST symbol → RRF fusion → dedup →
 * exact lexical safeguard → semantic vector fallback.
 */

import { statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import type { ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import {
    PROTOCOL_SCHEMA_VERSION,
    hashSessionFilePath,
    resourceIdFor,
    sha256OfString,
    canonicalizeWorkspaceRoot,
    type WorkspaceEvidenceEnvelope,
    type InspectedResource,
} from "@rhinos0608/pi-workspace-protocol";
import type { ContextGraph } from "../context-graph.js";
import { runGrepJudgeStage, type GrepJudgeDetails, type GrepJudgeProvider, type JudgedGrepHit } from "../judge/grep-judge-stage.js";
import { applyGraphFilter, parseGraphFilter } from "./graph-filter.js";
import { sessionFileFromContext } from "../inspect/inspect-tool.js";
import {
    resolveGrepUnitExcerptLines,
    resolveGrepUnitMaxPerFile,
    resolveGrepUnitMode,
    type GrepUnitMode,
} from "./grep-units.js";
import { executeStructuralQuery } from "./grep-structural-executor.js";
export { GREP_STRUCTURAL_FETCH_SIZE, GREP_STRUCTURAL_MAX_ITERATIONS } from "./grep-structural-executor.js";
import {
    runLiteralGrep,
    runRegexGrep,
    runSmartCascade,
    relativeToSearchDir,
    tryCanonical,
    type GrepDegradation,
    type GrepExecutionResult,
    type GrepHit,
    type GrepRouting,
} from "./grep-cascade.js";
export type { GrepDegradation, StructuralDetails } from "./grep-cascade.js";
export { _bm25CorpusCacheForTests, _resetBm25CorpusCacheForTests, _bm25CacheBenchmark } from "./grep-cascade.js";

// ── Schema ──────────────────────────────────────────────────────────

const StructuralSchema = Type.Object({
    language: Type.Optional(Type.String({ description: "Structural language override (e.g. 'typescript', 'python')." })),
    skip: Type.Optional(Type.Number({ description: "Matches to skip (pagination).", minimum: 0 })),
    groupByFile: Type.Optional(Type.Boolean({ description: "Group matches by file." })),
}, { description: "Structural search options (ast-grep)." });

const GrepOptionProperties = {
    path: Type.Optional(Type.String({ description: "Directory or file to search in (default: cwd)." })),
    glob: Type.Optional(Type.String({ description: "File filter, e.g. '*.ts' or 'src/**/*.py'." })),
    ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)." })),
    literal: Type.Optional(Type.Boolean({ description: "Force exact substring. Disables regex auto-detect, BM25, and semantic (default: false)." })),
    regex: Type.Optional(Type.Boolean({ description: "Force regex matching. Pattern must be a valid regex; conflicts with literal:true." })),
    limit: Type.Optional(Type.Number({ description: "Deprecated alias for per-query limit (default: 20, max: 100). Use perQueryLimit instead; perQueryLimit wins when both are given.", default: 20, minimum: 1, maximum: 100 })),
    perQueryLimit: Type.Optional(Type.Number({ description: "Max results per query (default: 20, max: 50). Wins over deprecated limit when both are given.", minimum: 1, maximum: 50 })),
    contextLines: Type.Optional(Type.Number({ description: "Lines of context per match (default: 2, max: 20). Applies after the global output cap.", default: 2, minimum: 0, maximum: 20 })),
    graphFilter: Type.Optional(Type.String({ description: 'Filter results by graph relationship. Format: "EDGE_TYPE->target" e.g. "CALLS->auth.login" or "IMPORTED_BY->src/core".' })),
    structural: Type.Optional(StructuralSchema),
};
// Top-level skip routes into structural.skip (WP-SR4 fix: wiring for pagination when combined with graphFilter)
const TopLevelSkipProperty = {
    skip: Type.Optional(Type.Number({ description: "Matches to skip (pagination) for structural search — routes into structural.skip.", minimum: 0 })),
};

const PATTERN_DESCRIPTION = "Literal substring by default. Compact regex syntax (|, ^, $, [class], {n}, \\d/\\w/\\s/\\b, \\. or compact foo.*bar / (group) without inner spaces) auto-routes to regex. Multi-line patterns, prose with parenthesised asides, and isolated .* / .+ in multi-word text stay on the smart cascade. Set regex:true to force regex (must be valid) or literal:true to force substring.";

const GrepQuerySchema = Type.Object({
    pattern: Type.String({ description: PATTERN_DESCRIPTION, minLength: 1 }),
    ...GrepOptionProperties,
    ...TopLevelSkipProperty,
});

const GrepSchema = Type.Object({
    pattern: Type.Optional(Type.String({ description: `${PATTERN_DESCRIPTION} Provide pattern or queries, not both.`, minLength: 1 })),
    queries: Type.Optional(Type.Array(GrepQuerySchema, {
        description: "Multiple searches to run in one call. Top-level options are shared defaults; per-query options override them.",
        minItems: 1,
        maxItems: 10,
    })),
    maxResults: Type.Optional(Type.Number({ description: "Global max rendered hits across all queries after cross-query dedup (default: 100, max: 200).", minimum: 1, maximum: 200 })),
    ...GrepOptionProperties,
    ...TopLevelSkipProperty,
}, {
    description: "Primary textual/code discovery search. Provide exactly one of pattern or queries. Narrow with path/glob/literal/regex/perQueryLimit/contextLines; use graphFilter for graph-constrained hits and structural for ast-grep queries. Use LSP instead when exact semantic symbol resolution, references, types, hierarchy, or diagnostics are required.",
});

type GrepInput = Static<typeof GrepSchema>;
export type GrepQueryInput = Static<typeof GrepQuerySchema>;

export const GREP_DESCRIPTION = `Search code for one or more text patterns, symbol names, or concepts. This is the primary broad/textual discovery tool. Provide exactly one of pattern or queries; queries batches up to 10 full searches. Narrow with path, glob, literal, perQueryLimit, contextLines, and maxResults; graphFilter uses "EDGE_TYPE->target"; structural enables ast-grep search. Pattern matching is literal unless compact regex syntax is detected (multi-line patterns and prose with parenthesised asides stay on the smart cascade), literal:true always forces substring matching, and regex:true forces regex matching (pattern must be a valid regex). After discovery, use read for source content at known paths. Use LSP for exact compiler-backed semantics such as definitions, references, types, hierarchy, diagnostics, and refactor safety. Use inspect for aggregate structural or architectural analysis of a known file/directory, and inspect script only for dependent multi-hop chases.`;

// ── Factory ─────────────────────────────────────────────────────────

export interface GrepToolOptions {
    readonly resolver?: {
        publishInspection(envelope: unknown, sessionFilePath: string, workspaceRoot: string): void;
    };
    readonly getSessionFilePath?: () => string | null | undefined;
    /** ContextGraph instance or getter for graphFilter edge checks (WP-5 DI). */
    readonly contextGraph?: ContextGraph | ((cwd: string) => ContextGraph | Promise<ContextGraph>);
    /**
     * Monotonic workspace revision provider. When present, the no-index BM25
     * fallback caches its corpus per (workspace root, revision) and skips
     * re-reading/re-tokenizing the candidate set on unchanged workspaces.
     * Absent → the fallback stays uncached. Injected by runtime registrations
     * (never imported here to avoid an mcp-registry dependency cycle).
     */
    readonly getWorkspaceRevision?: () => number;
    /**
     * Synchronous peek at an already-built shared ContextGraph (null if not
     * built). Lets no-index grep resolve simple symbols from the structural
     * index without triggering a graph build; handleSymbol remains the
     * fallback when the graph is unavailable or the match is absent.
     */
    readonly getSharedContextGraphIfBuilt?: (root: string) => ContextGraph | null;
    /**
     * Optional WS1 grep judgment stage (spec
     * docs/plans/2026-10-05-grep-judge-design.md). Narrow injected seam for
     * J2 runtime wiring: the provider resolves the active judge backend and
     * peeks at an already-built graph. Absent (or mode off) → grep output
     * and details are byte-identical to unjudged runs.
     */
    readonly judge?: GrepJudgeProvider;
    /**
     * Additive opt-in diagnostic observer for measurement harnesses.
     * Receives copied per-query snapshots (pre-judge candidates, post-judge
     * hits, post-cap guarded text). Copies are detached from production
     * state, so observer mutation cannot affect results. Absent → no
     * overhead beyond a single conditional branch and no logging. Observer
     * errors propagate to the caller; production errors are never swallowed.
     */
    readonly onTraceGrepQuery?: (event: GrepTraceEvent) => void;
}

/** Per-query diagnostic snapshot stages (observer receives copies only). */
export type GrepTraceEvent =
    | { stage: "pre-judge"; pattern: string; candidates: GrepHit[] }
    | {
        stage: "post-judge"; pattern: string; shown: GrepHit[]; totalHits: number;
        judged: boolean; abstained: boolean; judge?: GrepJudgeDetails;
    }
    | { stage: "post-cap"; pattern: string; text: string; outputTruncated: boolean };

export function createGrepTool(opts: GrepToolOptions): ToolDefinition {
    return {
        name: "grep",
        label: "grep",
        description: GREP_DESCRIPTION,
        parameters: GrepSchema as unknown as Record<string, unknown>,

        async execute(
            toolCallId: string,
            params: GrepInput & Record<string, unknown>,
            signal: AbortSignal | undefined,
            _onUpdate: unknown,
            ctx: ExtensionContext,
        ) {
            const hasPattern = typeof params.pattern === "string";
            const hasQueries = Array.isArray(params.queries);
            if (hasPattern === hasQueries) {
                throw new Error("Provide exactly one of: pattern or queries");
            }
            if (hasQueries && (params.queries!.length < 1 || params.queries!.length > 10)) {
                throw new Error("queries must contain between 1 and 10 search objects");
            }

            const cwd = ctx.cwd;
            const sessionFilePath = opts.getSessionFilePath?.() ?? sessionFileFromContext(ctx);
            // Only spread keys explicitly set at top level — per-query schema defaults must not be overridden.
            const shared: Record<string, unknown> = {};
            if (params.path !== undefined) shared.path = params.path;
            if (params.glob !== undefined) shared.glob = params.glob;
            if (params.ignoreCase !== undefined) shared.ignoreCase = params.ignoreCase;
            if (params.literal !== undefined) shared.literal = params.literal;
            if ((params as any).regex !== undefined) shared.regex = (params as any).regex;
            if (params.limit !== undefined) shared.limit = params.limit;
            if (params.perQueryLimit !== undefined) shared.perQueryLimit = (params as any).perQueryLimit;
            if (params.contextLines !== undefined) shared.contextLines = params.contextLines;
            if (params.graphFilter !== undefined) shared.graphFilter = params.graphFilter;
            if ((params as any).structural !== undefined) (shared as any).structural = (params as any).structural;
            if ((params as any).skip !== undefined) (shared as any).skip = (params as any).skip;
            // Route top-level skip into structural.skip when structural present and structural.skip not already set
            if ((shared as any).skip !== undefined && (shared as any).structural !== undefined && (shared as any).structural.skip === undefined) {
                (shared as any).structural = { ...(shared as any).structural, skip: (shared as any).skip };
            }
            function mergeQueryWithShared(shared: Record<string, unknown>, query: Record<string, unknown>): GrepQueryInput {
                const merged: Record<string, unknown> = { ...shared, ...query };
                // Route top-level skip into structural.skip for batch queries too
                const qSkip = (query as any).skip;
                const sSkip = (shared as any).skip;
                const effectiveSkip = qSkip !== undefined ? qSkip : sSkip;
                if (effectiveSkip !== undefined) {
                    const existing = (merged as any).structural ?? {};
                    if (existing.skip === undefined) (merged as any).structural = { ...existing, skip: effectiveSkip };
                    // keep top-level skip for fallback in executeStructuralQuery as well
                    (merged as any).skip = effectiveSkip;
                }
                return merged as unknown as GrepQueryInput;
            }
            const queries: GrepQueryInput[] = hasQueries
                ? params.queries!.map((query) => mergeQueryWithShared(shared, query as unknown as Record<string, unknown>))
                : [{ ...shared, pattern: params.pattern! }] as unknown as GrepQueryInput[];
            // Single-query evidence comes straight from the per-call helper (identical
            // to building from the combined hits when there is one query). Batch
            // queries skip per-query envelope construction (it would be discarded)
            // and rebuild one combined envelope so multi-query range merging
            // and inspectionId stay exactly as before.
            const queryResults: GrepExecutionResult[] = [];
            let evidence: WorkspaceEvidenceEnvelope;
            // maxResults is a global merged-render cap: it applies to the
            // single-query path too (slice before evidence/render).
            const globalCap = resolveMaxResults(params as { maxResults?: number });
            if (!hasQueries) {
                const single = await runGrepQueryWithEvidence(queries[0]!, cwd, opts, signal, sessionFilePath, ctx);
                let result = single.result;
                evidence = single.evidence;
                if (result.shown.length > globalCap) {
                    const cappedShown = result.shown.slice(0, globalCap);
                    const cappedStructural = result.structuralSearch?.status === "ok"
                        ? { ...result.structuralSearch, matches: result.structuralSearch.matches.slice(0, globalCap), shownMatches: cappedShown.length, truncated: true }
                        : result.structuralSearch;
                    result = { ...result, shown: cappedShown, truncated: true, ...(cappedStructural ? { structuralSearch: cappedStructural } : {}) };
                    evidence = buildEvidence(cappedShown, cwd, sessionFilePath);
                }
                queryResults.push(result);
            } else {
                for (const query of queries) {
                    queryResults.push(await executeGrepQuery(query, cwd, opts, signal, ctx));
                }
                // Batch cardinality: tag per-query provenance, dedup overlapping
                // file+range hits across queries, then apply the global cap.
                // NOTE: per-query gather runs before the global merge (pre-render
                // work is not budgeted); the cap bounds render + evidence only.
                const candidates: GrepHit[] = [];
                for (const result of queryResults) {
                    for (const hit of result.shown) {
                        candidates.push({ ...hit, matchedQueries: [result.pattern] } as GrepHit);
                    }
                }
                const deduped = dedupGrepHits(candidates);
                const perQueryTruncated = queryResults.some((r) => r.truncated);
                const globalTruncated = perQueryTruncated || deduped.length > globalCap;
                const shownHits = deduped.slice(0, globalCap);
                (queryResults as any).globalShown = shownHits;
                (queryResults as any).globalTotal = deduped.length;
                // globalTotal counts only already-sliced per-query hits: when any
                // per-query result truncated, the true total is unknown and the
                // reported total is a lower bound (rendered with a "+" suffix).
                (queryResults as any).globalTotalIsLowerBound = perQueryTruncated;
                (queryResults as any).globalTruncated = globalTruncated;
                evidence = buildEvidence(shownHits, cwd, sessionFilePath);
            }
            publishEvidence(evidence, opts, sessionFilePath);

            if (!hasQueries) {
                const result = queryResults[0]!;
                const guarded = applyOutputGuard(formatExecutionOutput(result));
                opts.onTraceGrepQuery?.({
                    stage: "post-cap",
                    pattern: result.pattern,
                    text: guarded.text,
                    outputTruncated: guarded.outputTruncated,
                });
                return {
                    content: [{ type: "text" as const, text: guarded.text }],
                    details: {
                        workspaceEvidence: evidence,
                        mode: "query",
                        toolCallId,
                        totalHits: result.totalHits,
                        shownHits: result.shown.length,
                        truncated: result.truncated,
                        maxResults: globalCap,
                        engines: result.engines,
                        unitMode: result.unitMode ?? resolveGrepUnitMode(),
                        unitMaxPerFile: resolveGrepUnitMaxPerFile(),
                        unitExcerptLines: resolveGrepUnitExcerptLines(),
                        ...(result.routing ? { routing: result.routing } : {}),
                        ...(result.degradation ? { degradation: result.degradation } : {}),
                        ...(result.rankingKnobs && result.rankingKnobs.length > 0 ? { rankingKnobs: result.rankingKnobs } : {}),
                        ...(result.structuralSearch ? { structuralSearch: result.structuralSearch } : {}),
                        ...("judge" in result && result.judge ? { judge: result.judge } : {}),
                    },
                };
            }

            return {
                content: [{ type: "text" as const, text: applyOutputGuard(formatBatchOutput(queryResults)).text }],
                details: {
                    workspaceEvidence: evidence,
                    mode: "query",
                    toolCallId,
                    totalHits: (queryResults as any).globalTotal as number,
                    totalHitsIsLowerBound: (queryResults as any).globalTotalIsLowerBound as boolean,
                    shownHits: ((queryResults as any).globalShown as GrepHit[]).length,
                    truncated: (queryResults as any).globalTruncated as boolean,
                    maxResults: resolveMaxResults(params as { maxResults?: number }),
                    engines: unique(queryResults.flatMap((result) => result.engines)),
                    unitMode: resolveGrepUnitMode(),
                    unitMaxPerFile: resolveGrepUnitMaxPerFile(),
                    unitExcerptLines: resolveGrepUnitExcerptLines(),
                    queryResults: queryResults.map((result) => ({
                        pattern: result.pattern,
                        totalHits: result.totalHits,
                        shownHits: result.shown.length,
                        truncated: result.truncated,
                        engines: result.engines,
                        unitMode: result.unitMode ?? resolveGrepUnitMode(),
                        unitMaxPerFile: resolveGrepUnitMaxPerFile(),
                        unitExcerptLines: resolveGrepUnitExcerptLines(),
                        ...(result.routing ? { routing: result.routing } : {}),
                        elapsedMs: result.elapsedMs,
                        ...(result.degradation ? { degradation: result.degradation } : {}),
                        ...(result.rankingKnobs && result.rankingKnobs.length > 0 ? { rankingKnobs: result.rankingKnobs } : {}),
                        ...(result.structuralSearch ? { structuralSearch: result.structuralSearch } : {}),
                    })),
                },
            };
        },
    };
}

/**
 * Run one grep query and build its per-call evidence envelope.
 *
 * Pure compute layer: no resolver publish, no tool-protocol formatting.
 * Publish stays owned by the registered `grep` tool's `execute()` wrapper,
 * which must publish once per real tool_result event.
 */
export async function runGrepQueryWithEvidence(
    params: GrepQueryInput,
    cwd: string,
    opts: GrepToolOptions,
    signal: AbortSignal | undefined,
    sessionFilePath: string | null | undefined,
    runtimeContext?: unknown,
): Promise<{ result: GrepExecutionResult; evidence: WorkspaceEvidenceEnvelope }> {
    const result = await executeGrepQuery(params, cwd, opts, signal, runtimeContext);
    const evidence = buildEvidence(result.shown, cwd, sessionFilePath);
    return { result, evidence };
}

/** Additive judged fields on a grep result. Absent unless the WS1 judge ran. */
export interface GrepJudgeResultExtras {
    judge?: GrepJudgeDetails;
    judgeNote?: string;
    judgeFallback?: GrepHit[];
}

/**
 * Invoke the WS1 judgment stage for a smart-cascade result. Returns the
 * input hits untouched (judged: false, no details, no degradation) unless
 * the provider resolves an enabled backend and the gate accepts the query.
 */
async function maybeJudgeGrepHits(args: {
    query: string;
    hits: GrepHit[];
    literal: boolean;
    regex: boolean;
    structural: boolean;
    contextLines: number;
    cwd: string;
    runtimeContext?: unknown;
    provider: GrepJudgeProvider | undefined;
}): Promise<{
    judged: boolean;
    hits: JudgedGrepHit[];
    unjudged: GrepHit[];
    details?: GrepJudgeDetails;
    degradation?: { backend: "judge"; code: string };
    abstained: boolean;
    abstainMessage?: string;
}> {
    const idle = { judged: false, hits: args.hits, unjudged: args.hits, abstained: false as const };
    if (!args.provider) return idle;
    const staged = await runGrepJudgeStage({
        query: args.query,
        hits: args.hits,
        contextLines: args.contextLines,
        literal: args.literal,
        regex: args.regex,
        structural: args.structural,
        cwd: args.cwd,
        runtimeContext: args.runtimeContext,
        provider: args.provider,
    });
    return {
        judged: staged.judged,
        hits: staged.hits,
        unjudged: staged.unjudged,
        ...(staged.judge ? { details: staged.judge } : {}),
        ...(staged.degradation ? { degradation: staged.degradation } : {}),
        abstained: staged.abstained,
        ...(staged.abstainMessage ? { abstainMessage: staged.abstainMessage } : {}),
    };
}

async function executeGrepQuery(
    params: GrepQueryInput & { structural?: { language?: string; skip?: number; groupByFile?: boolean } },
    cwd: string,
    opts: GrepToolOptions,
    signal: AbortSignal | undefined,
    runtimeContext?: unknown,
): Promise<GrepExecutionResult & GrepJudgeResultExtras> {
    // Structural branch — validate combos before any IO
    if ((params as any).structural !== undefined) {
        return executeStructuralQuery(params as any, cwd, opts);
    }
    const { searchDir, scopedFile } = resolveSearchScope(cwd, params.path);
    const topK = resolvePerQueryLimit(params);
    const contextLines = clamp(params.contextLines ?? 2, 0, 20);
    const caseSensitive = !(params.ignoreCase ?? false);
    const startTime = Date.now();

    const routing = decideGrepRouting(params.pattern, { literal: (params as any).literal, regex: (params as any).regex });
    const fileGlob = params.glob;
    const hasGraphFilter = params.graphFilter !== undefined;
    if (hasGraphFilter && !parseGraphFilter(params.graphFilter!)) {
        throw new Error('Invalid graphFilter: expected "EDGE_TYPE->target" format');
    }

    // Resolve the context graph once (await getter so a registered runtime
    // tool never receives an unbuilt graph — the shared async getter builds
    // with the call graph and coalesces concurrent callers).
    let contextGraph: ContextGraph | undefined;
    if (hasGraphFilter) {
        contextGraph = typeof opts.contextGraph === "function" ? await opts.contextGraph(cwd) : opts.contextGraph;
        if (!contextGraph) throw new Error("graphFilter requires an indexed context graph");
    }

    // Bounded over-fetch: when graphFilter is present, filtering can starve
    // the candidate pool below topK, so gather up to MAX_GATHER in one pass.
    // The graph filter is applied once to that bounded candidate set; without
    // graphFilter this starts with the smaller gatherK and may expand below.
    const MAX_GATHER = 2000;
    let gatherK = hasGraphFilter ? MAX_GATHER : Math.min(topK * 2, 200);
    let hits: GrepHit[] = [];
    let engines: string[] = [];
    let degradation: GrepDegradation[] | undefined;
    let graphFilterNotes: string[] = [];
    let unitMode: GrepUnitMode | undefined;
    let rankingKnobs: string[] | undefined;
    for (;;) {
        const textInput = { pattern: params.pattern, searchDir, topK: gatherK, contextLines, caseSensitive, cwd, signal, scopedFile, fileGlob };
        const searchResult = routing.mode === "regex"
            ? await runRegexGrep({ ...textInput, pattern: params.pattern })
            : routing.mode === "literal"
                ? await runLiteralGrep(textInput)
                : await runSmartCascade(
                    {
                        pattern: params.pattern,
                        searchDir,
                        gatherK,
                        contextLines,
                        caseSensitive,
                        cwd,
                        signal,
                        scopedFile,
                        fileGlob,
                        deps: opts,
                        // Graph filtering needs a larger candidate pool: exact
                        // lexical hits can all be filtered out, so keep the
                        // fallback layers available in that mode.
                        allowExactShortCircuit: !hasGraphFilter,
                    },
                );
        let current = searchResult.hits;
        engines = searchResult.engines;
        degradation = searchResult.degradation;
        const cascadeExtras = searchResult as Partial<Pick<GrepExecutionResult, "unitMode" | "rankingKnobs">>;
        if (cascadeExtras.unitMode !== undefined) unitMode = cascadeExtras.unitMode;
        if (cascadeExtras.rankingKnobs !== undefined) rankingKnobs = cascadeExtras.rankingKnobs;

        if (params.glob) {
            const { minimatch } = await import("minimatch");
            current = current.filter((hit) =>
                minimatch(relativeToSearchDir(searchDir, hit.file), params.glob!),
            );
        }

        if (hasGraphFilter) {
            const filtered = await applyGraphFilter(current, params.graphFilter!, contextGraph!);
            current = filtered.hits;
            graphFilterNotes = filtered.notes;
        }

        hits = current;
        if (!hasGraphFilter || hits.length >= topK || gatherK >= MAX_GATHER) break;
        gatherK = Math.min(gatherK * 2, MAX_GATHER);
    }

    // WS1 judgment stage (smart cascade + NL queries only). Without a
    // provider, or when the gate/mode says off, hits pass through untouched.
    // The opt-in trace observer sees detached copies only; observer errors
    // propagate and production errors are never swallowed.
    opts.onTraceGrepQuery?.({ stage: "pre-judge", pattern: params.pattern, candidates: copyGrepHits(hits) });
    const staged = await maybeJudgeGrepHits({
        query: params.pattern,
        hits,
        literal: routing.mode === "literal",
        regex: routing.mode === "regex",
        structural: false,
        contextLines,
        cwd,
        runtimeContext,
        provider: opts.judge,
    });
    if (staged.degradation) {
        degradation = [...(degradation ?? []), staged.degradation as unknown as GrepDegradation];
    }
    const finalHits = staged.judged || staged.abstained ? staged.hits : hits;
    const shownHits = staged.abstained ? [] : finalHits.slice(0, topK);
    const totalHits = staged.abstained ? staged.unjudged.length : finalHits.length;
    opts.onTraceGrepQuery?.({
        stage: "post-judge",
        pattern: params.pattern,
        shown: copyGrepHits(shownHits),
        totalHits,
        judged: staged.judged,
        abstained: staged.abstained,
        ...(staged.details ? { judge: structuredCloneDetails(staged.details) } : {}),
    });

    return {
        pattern: params.pattern,
        routing,
        shown: shownHits,
        totalHits,
        engines,
        truncated: finalHits.length > topK,
        elapsedMs: Date.now() - startTime,
        graphFilterNotes,
        ...(unitMode ? { unitMode } : {}),
        ...(rankingKnobs && rankingKnobs.length > 0 ? { rankingKnobs } : {}),
        ...(degradation ? { degradation } : {}),
        ...(staged.details ? { judge: staged.details } : {}),
        ...(staged.abstainMessage ? { judgeNote: staged.abstainMessage } : {}),
        ...(staged.abstained ? { judgeFallback: staged.unjudged.slice(0, 3) } : {}),
    };
}

function publishEvidence(evidence: WorkspaceEvidenceEnvelope, opts: GrepToolOptions, sessionFilePath: string | null | undefined): void {
    if (!opts.resolver) return;
    if (typeof sessionFilePath !== "string" || sessionFilePath.length === 0) return;
    try {
        opts.resolver.publishInspection(evidence, sessionFilePath, evidence.canonicalWorkspaceRoot);
    } catch { /* best-effort */ }
}

function unique<T>(items: T[]): T[] {
    return [...new Set(items)];
}

/** Detached per-hit copies for the opt-in trace observer. */
function copyGrepHits(hits: GrepHit[]): GrepHit[] {
    return hits.map((h) => ({ ...h, engines: [...h.engines], ...(h.matchedQueries ? { matchedQueries: [...h.matchedQueries] } : {}) }));
}

/** Detached judge-details copy for the opt-in trace observer. */
function structuredCloneDetails(details: GrepJudgeDetails): GrepJudgeDetails {
    return {
        ...details,
        pointers: details.pointers.map((p) => ({ ...p })),
        hits: details.hits.map((h) => ({ ...h })),
    };
}

// ── Helpers ──────────────────────────────────────────────────────────

function resolveSearchScope(cwd: string, inputPath: string | undefined): { searchDir: string; scopedFile?: string } {
    const target = inputPath ? resolve(cwd, inputPath) : cwd;
    try {
        if (statSync(target).isFile()) {
            const scopedFile = tryCanonical(target);
            return { searchDir: dirname(scopedFile), scopedFile };
        }
    } catch { /* missing paths fall through to directory discovery */ }
    // Canonicalize so hit files (canonicalized via tryCanonical/realpath)
    // and the search dir share one root: a symlinked cwd otherwise breaks
    // relative display paths and the glob pre-filter.
    return { searchDir: tryCanonical(target) };
}

export function decideGrepRouting(pattern: string, flags?: { literal?: boolean; regex?: boolean }): GrepRouting {
    if (flags?.regex === true && flags?.literal === true) {
        throw new Error("regex:true cannot be combined with literal:true; choose one");
    }
    if (flags?.regex === true) {
        try {
            new RegExp(pattern);
        } catch {
            throw new Error(`regex:true but pattern is not a valid regex: ${pattern}`);
        }
        return { mode: "regex", reason: "forced_regex" };
    }
    if (flags?.literal === true) return { mode: "literal", reason: "forced_literal" };
    if (pattern.includes("\n")) {
        return { mode: "smart", reason: "auto_declined_newline", note: "Multi-line pattern: regex auto-detect declined; using smart cascade. Set regex:true to force regex." };
    }
    if (!isValidGrepRegex(pattern)) {
        if (hasStrongRegexSyntax(pattern)) {
            return { mode: "smart", reason: "auto_declined_invalid_regex", note: "Pattern looks like regex but is invalid; using smart cascade." };
        }
        return { mode: "smart", reason: "auto_literal" };
    }
    if (hasStrongRegexSyntax(pattern)) {
        if (hasBracketClassOnly(pattern)) {
            return { mode: "smart", reason: "auto_declined_prose_class", note: "Bracketed prefix looks like prose; regex auto-detect declined. Set regex:true to force regex." };
        }
        return { mode: "regex", reason: "auto_regex" };
    }
    if (hasWhitespaceParenGroup(pattern)) {
        return { mode: "smart", reason: "auto_declined_prose_group", note: "Parenthesised aside looks like prose; regex auto-detect declined. Set regex:true to force regex." };
    }
    if (hasIsolatedProseWildcard(pattern)) {
        return { mode: "smart", reason: "auto_declined_prose_wildcard", note: "Isolated .* / .+ in multi-word text is ambiguous; regex auto-detect declined. Set regex:true to force regex." };
    }
    if (COMPACT_GREP_REGEX.test(pattern)) return { mode: "regex", reason: "auto_regex" };
    return { mode: "smart", reason: "auto_literal" };
}

/** A trailing `$` is an end anchor only with even backslash parity (odd = escaped). */
function hasUnescapedTerminalDollar(pattern: string): boolean {
    if (!pattern.endsWith("$")) return false;
    let backslashes = 0;
    for (let i = pattern.length - 2; i >= 0 && pattern[i] === "\\"; i--) backslashes++;
    return backslashes % 2 === 0;
}

function hasUnescapedGrep(text: string, char: string): boolean {
    for (let i = 0; i < text.length; i++) {
        if (text[i] !== char) continue;
        let backslashes = 0;
        for (let j = i - 1; j >= 0 && text[j] === "\\"; j--) backslashes++;
        if (backslashes % 2 === 0) return true;
    }
    return false;
}

function hasStrongRegexSyntax(pattern: string): boolean {
    if (hasUnescapedGrep(pattern, "|")) return true;
    if (pattern.startsWith("^") || hasUnescapedTerminalDollar(pattern)) return true;
    if (/\[[^\]]+\]/.test(pattern)) return true;
    if (/\{\d+(,\d*)?\}/.test(pattern)) return true;
    if (/\\[bBdDsSwW.]/.test(pattern)) return true;
    const group = /\(([^()]*)\)/.exec(pattern);
    if (group && (group[1] ?? "").length > 0 && !/\s/.test(group[1] ?? "")) return true;
    if (/\w\.\*\w|\w\.\+\w/.test(pattern)) return true;
    return false;
}

function hasWhitespaceParenGroup(pattern: string): boolean {
    const m = /\(([^()]*)\)/.exec(pattern);
    return !!m && /\s/.test(m[1] ?? "");
}

/** D22 extension: a bracket class alone is not strong syntax in multi-word prose. */
function hasBracketClassOnly(pattern: string): boolean {
    if (!/\[[^\]]+\]/.test(pattern)) return false;
    if (pattern.trim().split(/\s+/).length < 3) return false;
    const withoutBrackets = pattern.replace(/\[[^\]]*\]/g, " ");
    return !hasStrongRegexSyntax(withoutBrackets);
}

function hasIsolatedProseWildcard(pattern: string): boolean {
    if (!/\.\*|\.\+/.test(pattern)) return false;
    if (/\w\.\*\w|\w\.\+\w/.test(pattern)) return false;
    return /\s/.test(pattern);
}

function isValidGrepRegex(pattern: string): boolean {
    try {
        new RegExp(pattern);
        return true;
    } catch {
        return false;
    }
}

const COMPACT_GREP_REGEX = /(\||\[|\{\d|\\[bBdDsSwW.]|\(\S+\))/;

/**
 * Multi-range resource identity: resourceId and inspectionId hash the FULL
 * sorted range set per file, so [10-12,80-82] vs [10-12,300-302] never
 * collide. Single-range resources keep the protocol resourceIdFor digest.
 */
export function resourceIdForRanges(canonicalPath: string, ranges: Array<{ startLine: number; endLine: number }>): string {
    const sorted = [...ranges].sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
    if (sorted.length === 1) {
        return resourceIdFor({ canonicalPath, kind: "range", range: sorted[0] });
    }
    const rangePart = sorted.map((r) => `${r.startLine}-${r.endLine}`).join(",");
    return sha256OfString(`resource|range|${canonicalPath}|${rangePart}`);
}

export function inspectionIdForRanges(
    sessionId: string,
    workspaceRoot: string,
    entries: Array<{ canonicalPath: string; ranges: Array<{ startLine: number; endLine: number }> }>,
): string {
    const resourceKey = entries.map((e) => {
        const sorted = [...e.ranges].sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
        const rangePart = sorted.map((r) => `:${r.startLine}-${r.endLine}`).join(",");
        return `${e.canonicalPath}${rangePart}`;
    }).sort().join("\n");
    return sha256OfString(`inspection|${sessionId}|${workspaceRoot}\n${resourceKey}`);
}

// ── Evidence envelope ───────────────────────────────────────────────

function buildEvidence(
    hits: GrepHit[],
    cwd: string,
    sessionFilePath: string | null | undefined,
): WorkspaceEvidenceEnvelope {
    const canonicalRoot = canonicalizeWorkspaceRoot(cwd);
    const sessionId = typeof sessionFilePath === "string" && sessionFilePath.length > 0
        ? hashSessionFilePath(sessionFilePath)
        : "0".repeat(64);

    const resourcesByPath = new Map<string, InspectedResource>();
    for (const hit of hits) {
        const canonical = tryCanonical(hit.file);
        const existing = resourcesByPath.get(canonical);
        const range = { startLine: hit.line, endLine: hit.endLine };
        if (existing) {
            const merged = mergeRanges([...existing.allowedRanges, range]);
            resourcesByPath.set(canonical, { ...existing, allowedRanges: merged });
        } else {
            resourcesByPath.set(canonical, {
                resourceId: "pending",
                canonicalPath: canonical,
                kind: "range",
                coverage: "search-match",
                allowedRanges: [range],
                fresh: false,
            });
        }
    }
    // Identity fix: resourceId + inspectionId hash the FULL sorted range set
    // per file, so [10-12,80-82] vs [10-12,300-302] never collide.
    for (const resource of resourcesByPath.values()) {
        (resource as { resourceId: string }).resourceId = resourceIdForRanges(
            resource.canonicalPath,
            [...(resource.allowedRanges ?? [])].sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine),
        );
    }

    const resources = [...resourcesByPath.values()];
    const inspectionId = inspectionIdForRanges(sessionId, canonicalRoot, resources.map((r) => ({
        canonicalPath: r.canonicalPath,
        ranges: [...(r.allowedRanges ?? [])],
    })));

    return {
        schemaVersion: PROTOCOL_SCHEMA_VERSION,
        inspectionId,
        sessionId,
        workspaceRoot: cwd,
        canonicalWorkspaceRoot: canonicalRoot,
        createdAt: new Date().toISOString(),
        resources,
        mode: "query" as any,
    };
}

// ── Output formatting ──────────────────────────────────────────────

function formatExecutionOutput(result: GrepExecutionResult & GrepJudgeResultExtras): string {
    if (result.structuralSearch) {
        return formatStructuralOutput(result);
    }
    return formatOutput(
        result.pattern,
        result.shown,
        result.totalHits,
        result.engines,
        result.truncated,
        result.elapsedMs,
        result.graphFilterNotes,
        result.degradation,
        result.routing,
        result.judge
            ? {
                judge: result.judge,
                abstainMessage: result.judgeNote,
                abstainPointers: result.judgeFallback,
            }
            : undefined,
    );
}

function formatStructuralOutput(result: GrepExecutionResult): string {
    const d = result.structuralSearch!;
    const engineStr = result.engines.join(" + ");
    const lines: string[] = [
        `${result.totalHits} result(s) for "${result.pattern}" (${engineStr}, ${(result.elapsedMs / 1000).toFixed(1)}s) [structural]`,
        `structural: status=${d.status} skip=${d.skip} groupByFile=${d.groupByFile} total=${d.totalMatches} shown=${d.shownMatches} truncated=${d.truncated}`,
        "",
    ];
    if (d.status === "unavailable") {
        lines.push(`structural search unavailable: ${d.reason ?? "@ast-grep/napi not available"}`);
        if (result.graphFilterNotes.length > 0) for (const n of result.graphFilterNotes) lines.push(`graphFilter note: ${n}`);
        return lines.join("\n");
    }
    for (const m of d.matches) {
        lines.push(`${m.path}:${m.line}:${m.character}-${m.endLine}:${m.endCharacter} ${JSON.stringify(m.text)} read={path:"${m.read.path}",offset:${m.read.offset},limit:${m.read.limit}}`);
    }
    if (d.matches.length === 0) lines.push("(no structural matches)");
    lines.push("");
    if (d.truncated) lines.push(`(truncated: ${d.shownMatches} of ${d.totalMatches}, use skip for more)`);
    if (result.graphFilterNotes.length > 0) for (const n of result.graphFilterNotes) lines.push(`graphFilter note: ${n}`);
    if (result.degradation && result.degradation.length > 0) lines.push(`degraded: ${result.degradation.map((x) => `${x.backend}_${x.code}`).join(", ")}`);
    return lines.join("\n");
}

/** Render guard alias used by the execute paths. */
function applyOutputGuard(text: string): { text: string; outputTruncated: boolean } {
    return enforceGrepOutputGuard(text);
}

function formatBatchOutput(results: GrepExecutionResult[]): string {
    const header: string[] = [];
    for (let i = 0; i < results.length; i++) {
        const result = results[i]!;
        header.push(`Query ${i + 1}: "${result.pattern}" (${result.totalHits} hits, ${result.elapsedMs}ms, ${result.routing ? `${result.routing.mode}/${result.routing.reason}` : result.engines.join("+")})`);
    }
    header.push("");
    // D67: batch abstentions render the abstain message and ZERO location
    // pointers. Abstained per-query hits are already sliced to [] upstream;
    // filter them here as well so merged provenance can never reintroduce
    // an abstained query preserved candidates, and render each abstained
    // query message before the merged view.
    const abstainedPatterns = new Set(
        results
            .filter((r) => (r as GrepJudgeResultExtras).judge?.abstained)
            .map((r) => r.pattern),
    );
    for (let i = 0; i < results.length; i++) {
        const extras = results[i]! as GrepExecutionResult & GrepJudgeResultExtras;
        if (extras.judge?.abstained && extras.judgeNote) {
            header.push(`Query ${i + 1} abstained: ${extras.judgeNote}`);
        }
    }
    if (abstainedPatterns.size > 0) header.push("");
    // Merged global view: duplicates render once with matched-query provenance.
    // D67: drop any hit whose provenance is an abstained query.
    const rawShown: GrepHit[] = (results as any).globalShown
        ?? dedupGrepHits(results.flatMap((r) => r.shown.map((h) => ({ ...h, matchedQueries: [r.pattern] }) as GrepHit)));
    const shown: GrepHit[] = abstainedPatterns.size === 0
        ? rawShown
        : rawShown.filter((h) => !((h as { matchedQueries?: string[] }).matchedQueries ?? []).some((q) => abstainedPatterns.has(q)));
    const total: number = (results as any).globalTotal ?? shown.length;
    const totalIsLowerBound: boolean = (results as any).globalTotalIsLowerBound
        ?? results.some((r) => r.truncated);
    const truncated: boolean = (results as any).globalTruncated
        ?? results.some((r) => r.truncated);
    if (shown.length === 0) header.push("(no matches for any query)");
    else {
        for (const hit of shown) {
            const matched = (hit as { matchedQueries?: string[] }).matchedQueries;
            const range = hit.endLine > hit.line ? `L${hit.line}-${hit.endLine}` : `L${hit.line}`;
            const suffix = matched && matched.length > 0
                ? `  matched queries: ${matched.map((q) => `"${q}"`).join(", ")}`
                : "";
            header.push(`${hit.relFile}  ${range}  ${hit.name}${suffix}`);
            if (hit.snippet) header.push(hit.snippet);
        }
    }
    if (truncated) header.push(`(truncated: showing ${shown.length} of ${total}${totalIsLowerBound ? "+" : ""} deduplicated hits; reduce maxResults, contextLines, or queries for more)`);
    return header.join("\n");
}

function enginesKey(engines: string[]): string {
    return [...engines].sort().join("+");
}

function shouldShowPerHitEngines(shown: GrepHit[]): boolean {
    if (shown.length === 0) return false;
    // Informative when any hit has multiple engines (confidence signal)
    if (shown.some((h) => h.engines.length > 1)) return true;
    // Or when hits diverge (different engine combos across hits)
    const first = enginesKey(shown[0]!.engines);
    return shown.some((h) => enginesKey(h.engines) !== first);
}

function formatOutput(
    pattern: string,
    shown: GrepHit[],
    totalHits: number,
    engines: string[],
    truncated: boolean,
    elapsedMs: number,
    graphFilterNotes?: string[],
    degradation?: GrepDegradation[],
    routing?: GrepRouting,
    judgeExtra?: {
        judge: GrepJudgeDetails;
        abstainMessage?: string;
        abstainPointers?: GrepHit[];
    },
): string {
    const engineStr = engines.join(" + ");
    const judgedSuffix = judgeExtra ? ", judged" : "";
    const routingSuffix = routing ? `, ${routing.mode}/${routing.reason}` : "";
    const lines: string[] = [
        `${totalHits} result(s) for "${pattern}" (${engineStr}${judgedSuffix}${routingSuffix}, ${(elapsedMs / 1000).toFixed(1)}s)`,
        "",
    ];
    if (routing?.note) {
        lines.push(routing.note);
        lines.push("");
    }

    if (judgeExtra?.abstainMessage) {
        // D67: an abstention renders ZERO location pointers. The abstain
        // message stays; the former `maybe: file:line name` fallback lines
        // are removed from rendered output in every format path.
        lines.push(judgeExtra.abstainMessage);
        lines.push("");
    }

    const showProvenance = shouldShowPerHitEngines(shown);
    for (const hit of shown) {
        const symbolPart = hit.name ? `  ${hit.name}` : "";
        const lineRange = hit.endLine > hit.line ? `L${hit.line}-${hit.endLine}` : `L${hit.line}`;
        const provenance = showProvenance && hit.engines.length > 0 ? `  [${hit.engines.join("+")}]` : "";
        const judgeP = typeof (hit as JudgedGrepHit).judgeP === "number"
            ? `  p=${((hit as JudgedGrepHit).judgeP as number).toFixed(2)}`
            : "";
        lines.push(`${hit.relFile}  ${lineRange}${symbolPart}${provenance}${judgeP}`);
        if (hit.snippet) {
            lines.push(hit.snippet);
        }
        lines.push("");
    }

    if (truncated) {
        lines.push(`(truncated: ${shown.length} of ${totalHits}, narrow search for more)`);
    }

    if (degradation && degradation.length > 0) {
        lines.push(`degraded: ${degradation.map((d) => `${d.backend}_${d.code}`).join(", ")}`);
    }

    if (judgeExtra) {
        const j = judgeExtra.judge;
        const costPart = j.costUsd !== undefined ? ` · $${j.costUsd.toFixed(4)}` : "";
        lines.push(
            `judge: ${j.backend} ${j.model} · ${j.judged} judged · ${j.belowThreshold} below τ ${j.threshold.toFixed(2)} · cache ${j.cacheHits}/${j.judged}${costPart}`,
        );
        if (j.pointers.length > 0) {
            const next = j.pointers.map((p) => `${p.path}:${p.line} ${p.symbol} (${p.p.toFixed(2)})`).join(" · ");
            lines.push(`next: ${next}`);
        }
    }

    if (graphFilterNotes && graphFilterNotes.length > 0) {
        for (const note of graphFilterNotes) {
            lines.push(`graphFilter note: ${note}`);
        }
    }

    return lines.join("\n");
}

// ── Range merge ─────────────────────────────────────────────────────

function mergeRanges(ranges: Array<{ startLine: number; endLine: number }>): Array<{ startLine: number; endLine: number }> {
    if (ranges.length <= 1) return ranges;
    const sorted = [...ranges].sort((a, b) => a.startLine - b.startLine);
    const out: Array<{ startLine: number; endLine: number }> = [];
    for (const r of sorted) {
        const last = out[out.length - 1];
        if (last && r.startLine <= last.endLine + 1) {
            last.endLine = Math.max(last.endLine, r.endLine);
        } else {
            out.push({ ...r });
        }
    }
    return out;
}

// ── Helpers ─────────────────────────────────────────────────────────

export const GREP_DEFAULT_PER_QUERY_LIMIT = 20;
export const GREP_MAX_PER_QUERY_LIMIT = 50;
export const GREP_DEFAULT_MAX_RESULTS = 100;
export const GREP_MAX_MAX_RESULTS = 200;
/** Max rendered grep output: byte + line guard applied after the global cap. */
export const GREP_MAX_OUTPUT_BYTES = 200 * 1024;
export const GREP_MAX_OUTPUT_LINES = 2000;

/** Resolve per-query cap: perQueryLimit wins over the deprecated limit alias. */
export function resolvePerQueryLimit(params: { limit?: number; perQueryLimit?: number }): number {
    if (params.perQueryLimit !== undefined) return clamp(Math.floor(params.perQueryLimit), 1, GREP_MAX_PER_QUERY_LIMIT);
    if (params.limit !== undefined) return clamp(Math.floor(params.limit), 1, 100);
    return GREP_DEFAULT_PER_QUERY_LIMIT;
}

/** Resolve global merged-render cap for batch calls. */
export function resolveMaxResults(params: { maxResults?: number }): number {
    if (params.maxResults !== undefined) return clamp(Math.floor(params.maxResults), 1, GREP_MAX_MAX_RESULTS);
    return GREP_DEFAULT_MAX_RESULTS;
}

/** Byte + line guard on formatted grep text; appends a recovery hint on cut. */
export function enforceGrepOutputGuard(text: string): { text: string; outputTruncated: boolean } {
    const lines = text.split("\n");
    let lineCut = lines.length;
    let bytes = 0;
    for (let i = 0; i < lines.length; i++) {
        bytes += Buffer.byteLength(lines[i]!, "utf-8") + 1;
        if (bytes > GREP_MAX_OUTPUT_BYTES) { lineCut = i; break; }
    }
    const cut = Math.min(lineCut, GREP_MAX_OUTPUT_LINES);
    if (cut >= lines.length) return { text, outputTruncated: false };
    const hint = `\n...output truncated by size guard (showing ${cut} of ${lines.length} lines). Reduce maxResults, contextLines, or queries to recover full results.`;
    return { text: lines.slice(0, cut).join("\n") + hint, outputTruncated: true };
}

/** Canonical cross-query hit identity: canonical file + full line range. */
export function grepHitKey(hit: GrepHit): string {
    return `${tryCanonical(hit.file)}:${hit.line}-${hit.endLine}`;
}

/** Cross-query dedup: same file+range renders once, merging engines + matched queries. */
export function dedupGrepHits(hits: GrepHit[]): GrepHit[] {
    const merged = new Map<string, GrepHit>();
    for (const hit of hits) {
        const key = grepHitKey(hit);
        const existing = merged.get(key);
        if (existing) {
            for (const e of hit.engines) if (!existing.engines.includes(e)) existing.engines.push(e);
            const prior = (existing as { matchedQueries?: string[] }).matchedQueries ?? [];
            const next = (hit as { matchedQueries?: string[] }).matchedQueries ?? [];
            const set = new Set([...prior, ...next]);
            (existing as { matchedQueries?: string[] }).matchedQueries = [...set];
            if (hit.score > existing.score) existing.score = hit.score;
        } else {
            merged.set(key, { ...hit, engines: [...hit.engines] });
        }
    }
    const out = [...merged.values()];
    out.sort((a, b) => b.score - a.score);
    return out;
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, Math.trunc(value)));
}

export function _dedupGrepHitsForTests(hits: GrepHit[]): GrepHit[] {
    return dedupGrepHits(hits);
}

export function _enforceGrepOutputGuardForTests(text: string): { text: string; outputTruncated: boolean } {
    return enforceGrepOutputGuard(text);
}

export function _shouldShowPerHitEnginesForTests(shown: GrepHit[]): boolean {
    return shouldShowPerHitEngines(shown);
}

export function _formatOutputForTests(
    pattern: string,
    shown: GrepHit[],
    totalHits: number,
    engines: string[],
    truncated: boolean,
    elapsedMs: number,
): string {
    return formatOutput(pattern, shown, totalHits, engines, truncated, elapsedMs);
}
