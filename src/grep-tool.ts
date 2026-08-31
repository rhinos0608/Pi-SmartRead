/**
 * Wrapped grep tool — primary code search with BM25 + AST symbol cascade.
 *
 * literal:true → direct lexical grep.
 * Otherwise: Layer1 BM25 + Layer2 AST symbol → RRF fusion → dedup →
 * exact lexical safeguard → semantic vector fallback.
 */

import { realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import type { ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import {
    PROTOCOL_SCHEMA_VERSION,
    hashSessionFilePath,
    inspectionIdFor,
    resourceIdFor,
    canonicalizeWorkspaceRoot,
    type WorkspaceEvidenceEnvelope,
    type InspectedResource,
} from "@rhinos0608/pi-workspace-protocol";
import { handleGrep } from "./search-tool.js";
import { handleSymbol } from "./find-symbol-tool.js";
import { getSemanticIndex } from "./semantic-index-registry.js";
import { pathPrefixForDirectory } from "./semantic-index.js";
import type { ContextGraph } from "./context-graph.js";
import { applyGraphFilter, parseGraphFilter } from "./graph-filter.js";
import { sessionFileFromContext } from "./inspect-tool.js";
import { recordDegradation } from "./runtime-health.js";
import { structuralSearch, resolveStructuralLang, STRUCTURAL_SEARCH_MAX_LIMIT, STRUCTURAL_SEARCH_RAW_CEILING } from "./structural-search.js";
export const GREP_STRUCTURAL_FETCH_SIZE = STRUCTURAL_SEARCH_MAX_LIMIT;
export const GREP_STRUCTURAL_MAX_ITERATIONS = 20000;
import type { StructuralSearchMatch } from "./structural-search.js";
import { tokenize, compileBm25Corpus, type Bm25Corpus } from "./scoring.js";
import { findCodeFiles } from "./file-discovery.js";
import { LruCache } from "./utils.js";

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
    literal: Type.Optional(Type.Boolean({ description: "Exact substring match — skip regex detection and BM25/semantic (default: false)." })),
    limit: Type.Optional(Type.Number({ description: "Max results (default: 20, max: 100).", default: 20, minimum: 1, maximum: 100 })),
    contextLines: Type.Optional(Type.Number({ description: "Lines of context per match (default: 2, max: 10).", default: 2, minimum: 0, maximum: 10 })),
    graphFilter: Type.Optional(Type.String({ description: 'Filter results by graph relationship. Format: "EDGE_TYPE->target" e.g. "CALLS->auth.login" or "IMPORTED_BY->src/core".' })),
    structural: Type.Optional(StructuralSchema),
};
// Top-level skip routes into structural.skip (WP-SR4 fix: wiring for pagination when combined with graphFilter)
const TopLevelSkipProperty = {
    skip: Type.Optional(Type.Number({ description: "Matches to skip (pagination) for structural search — routes into structural.skip.", minimum: 0 })),
};

const GrepQuerySchema = Type.Object({
    pattern: Type.String({ description: "Text, symbol name, or concept to search for.", minLength: 1 }),
    ...GrepOptionProperties,
    ...TopLevelSkipProperty,
});

const GrepSchema = Type.Object({
    pattern: Type.Optional(Type.String({ description: "Single text, symbol name, or concept to search for. Provide pattern or queries, not both.", minLength: 1 })),
    queries: Type.Optional(Type.Array(GrepQuerySchema, {
        description: "Multiple searches to run in one call. Top-level options are shared defaults; per-query options override them.",
        minItems: 1,
        maxItems: 10,
    })),
    ...GrepOptionProperties,
    ...TopLevelSkipProperty,
});

type GrepInput = Static<typeof GrepSchema>;
type GrepQueryInput = Static<typeof GrepQuerySchema>;

export const GREP_DESCRIPTION = `Search code for one or more text patterns, symbol names, or concepts. Use as your primary code-search tool — handles exact matches, symbol lookups, and conceptual queries automatically. Returns ranked, deduplicated file/line hits. In Pi, use \`read({ query })\` for semantic/fused multi-channel retrieval or \`read({ symbol })\` for a known symbol; use \`inspect({ path })\` for structural facts in a known file. In MCP, conceptual matches use embeddings when semantic indexing is available.`;

// ── Types ───────────────────────────────────────────────────────────

interface GrepHit {
    file: string;
    relFile: string;
    line: number;
    endLine: number;
    name: string;
    kind: string;
    snippet: string;
    engines: string[];
    score: number;
}

interface GrepExecutionResult {
    pattern: string;
    shown: GrepHit[];
    totalHits: number;
    engines: string[];
    truncated: boolean;
    elapsedMs: number;
    graphFilterNotes: string[];
    degradation?: GrepDegradation[];
    structuralSearch?: StructuralDetails;
}

export interface StructuralDetails {
    schemaVersion: 1;
    status: "ok" | "unavailable";
    skip: number;
    groupByFile: boolean;
    totalMatches: number;
    shownMatches: number;
    truncated: boolean;
    matches: Array<StructuralSearchMatch & { read: { path: string; offset: number; limit: number } }>;
    groupedByFile?: Record<string, Array<StructuralSearchMatch & { read: { path: string; offset: number; limit: number } }>>;
    reason?: string;
}

/** Structured, non-secret per-query degradation reason. */
export interface GrepDegradation {
    backend: "bm25" | "symbol" | "semantic" | "lexical" | "lsp";
    code: string;
}

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
}

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
            // Only spread keys explicitly set at top level — per-query schema defaults must not be overridden.
            const shared: Record<string, unknown> = {};
            if (params.path !== undefined) shared.path = params.path;
            if (params.glob !== undefined) shared.glob = params.glob;
            if (params.ignoreCase !== undefined) shared.ignoreCase = params.ignoreCase;
            if (params.literal !== undefined) shared.literal = params.literal;
            if (params.limit !== undefined) shared.limit = params.limit;
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
            const queryResults: GrepExecutionResult[] = [];
            for (const query of queries) {
                queryResults.push(await executeGrepQuery(query, cwd, opts, signal));
            }

            const shownHits = queryResults.flatMap((result) => result.shown);
            const sessionFilePath = opts.getSessionFilePath?.() ?? sessionFileFromContext(ctx);
            const evidence = buildEvidence(shownHits, cwd, sessionFilePath);
            publishEvidence(evidence, opts, sessionFilePath);

            if (!hasQueries) {
                const result = queryResults[0]!;
                return {
                    content: [{ type: "text" as const, text: formatExecutionOutput(result) }],
                    details: {
                        workspaceEvidence: evidence,
                        mode: "query",
                        toolCallId,
                        totalHits: result.totalHits,
                        shownHits: result.shown.length,
                        truncated: result.truncated,
                        engines: result.engines,
                        ...(result.degradation ? { degradation: result.degradation } : {}),
                        ...(result.structuralSearch ? { structuralSearch: result.structuralSearch } : {}),
                    },
                };
            }

            return {
                content: [{ type: "text" as const, text: formatBatchOutput(queryResults) }],
                details: {
                    workspaceEvidence: evidence,
                    mode: "query",
                    toolCallId,
                    totalHits: queryResults.reduce((sum, result) => sum + result.totalHits, 0),
                    shownHits: shownHits.length,
                    truncated: queryResults.some((result) => result.truncated),
                    engines: unique(queryResults.flatMap((result) => result.engines)),
                    queryResults: queryResults.map((result) => ({
                        pattern: result.pattern,
                        totalHits: result.totalHits,
                        shownHits: result.shown.length,
                        truncated: result.truncated,
                        engines: result.engines,
                        elapsedMs: result.elapsedMs,
                        ...(result.degradation ? { degradation: result.degradation } : {}),
                        ...(result.structuralSearch ? { structuralSearch: result.structuralSearch } : {}),
                    })),
                },
            };
        },
    };
}

async function executeStructuralQuery(
    params: GrepQueryInput & { structural: { language?: string; skip?: number; groupByFile?: boolean } },
    cwd: string,
    opts: GrepToolOptions,
): Promise<GrepExecutionResult> {
    const structural = params.structural;
    if (params.literal) throw new Error("structural search cannot be combined with literal: choose one");
    if (params.ignoreCase) throw new Error("structural search cannot be combined with ignoreCase");
    if (structural.language !== undefined) {
        const resolved = resolveStructuralLang(structural.language);
        if (!resolved) throw new Error(`unsupported language: ${structural.language}`);
    }
    const topK = clamp(params.limit ?? 20, 1, 100);
    const skip = (structural.skip ?? (params as any).skip ?? 0) as number;
    if (!Number.isInteger(skip) || skip < 0) throw new Error("structural.skip must be an integer >= 0");
    const groupByFile = Boolean(structural.groupByFile);
    const hasGraphFilter = params.graphFilter !== undefined;
    const startTime = Date.now();
    const MAX_STRUCTURAL_FETCH = GREP_STRUCTURAL_FETCH_SIZE;
    const MAX_STRUCTURAL_ITERATIONS = GREP_STRUCTURAL_MAX_ITERATIONS;
    // When graphFilter present, fetch full raw match set first then filter — otherwise cap at 1000 before filtering loses hits.
    let matches: StructuralSearchMatch[];
    let totalMatches: number;
    let truncated: boolean;
    let graphFilterNotes: string[] = [];
    if (hasGraphFilter) {
        if (!parseGraphFilter(params.graphFilter!)) throw new Error('Invalid graphFilter: expected "EDGE_TYPE->target" format');
        const contextGraph: any = typeof opts.contextGraph === "function" ? await (opts.contextGraph as any)(cwd) : opts.contextGraph;
        if (!contextGraph) throw new Error("graphFilter requires an indexed context graph");
        const allRaw: StructuralSearchMatch[] = [];
        let offset = 0;
        let iterations = 0;
        let rawCeilingHit = false;
        // MAX_STRUCTURAL_ITERATIONS already defined above — hard cap prevents hang
        // STRUCTURAL_SEARCH_RAW_CEILING prevents skip-clamp repetition above ~10M raw matches
        while (true) {
            if (iterations++ >= MAX_STRUCTURAL_ITERATIONS) break;
            if (offset >= STRUCTURAL_SEARCH_RAW_CEILING) { rawCeilingHit = true; break; }
            if (allRaw.length >= STRUCTURAL_SEARCH_RAW_CEILING) { rawCeilingHit = true; break; }
            const chunk = await structuralSearch({
                pattern: params.pattern,
                language: structural.language,
                skip: offset,
                limit: MAX_STRUCTURAL_FETCH,
                groupByFile: false,
                cwd,
                path: params.path,
                glob: params.glob,
            });
            if (chunk.status === "unavailable") {
                const details: StructuralDetails = {
                    schemaVersion: 1,
                    status: "unavailable",
                    skip,
                    groupByFile,
                    totalMatches: 0,
                    shownMatches: 0,
                    truncated: false,
                    matches: [],
                    reason: chunk.reason,
                };
                return {
                    pattern: params.pattern,
                    shown: [],
                    totalHits: 0,
                    engines: ["structural"],
                    truncated: false,
                    elapsedMs: Date.now() - startTime,
                    graphFilterNotes: [],
                    structuralSearch: details,
                };
            }
            // Hard ceiling: structuralSearch clamps skip to MAX_SKIP, so above ceiling same page repeats.
            // Detect clamp/ceiling and terminate with truncated:true instead of looping.
            if ((chunk as any).skip !== undefined && (chunk as any).skip !== offset) { rawCeilingHit = true; break; }
            if (chunk.truncated && chunk.totalMatches >= STRUCTURAL_SEARCH_RAW_CEILING) rawCeilingHit = true; // hint: total beyond ceiling, but keep paginating until allRaw hits ceiling
            allRaw.push(...chunk.matches);
            if (allRaw.length >= STRUCTURAL_SEARCH_RAW_CEILING) {
                allRaw.length = STRUCTURAL_SEARCH_RAW_CEILING;
                rawCeilingHit = true;
                break;
            }
            // Do not break on hint alone — continue paginating until allRaw reaches ceiling
            if (!chunk.truncated) break;
            if (chunk.matches.length === 0) break;
            // always advance by fixed fetch size — guarantees forward progress even
            // when clamp or truncated logic mis-reports; never re-scan same window
            const nextOffset = offset + MAX_STRUCTURAL_FETCH;
            if (nextOffset <= offset) break;
            if (nextOffset > STRUCTURAL_SEARCH_RAW_CEILING) { rawCeilingHit = true; break; }
            offset = nextOffset;
        }
        const hitsForFilter: GrepHit[] = allRaw.map((m) => ({
            file: m.path,
            relFile: relative(cwd, m.path).replace(/\\/g, "/"),
            line: m.line,
            endLine: m.endLine,
            name: "",
            kind: "structural",
            snippet: m.text,
            engines: ["structural"],
            score: 0,
        }));
        const filtered = await applyGraphFilter(hitsForFilter, params.graphFilter!, contextGraph);
        graphFilterNotes = filtered.notes;
        const kept = new Set(filtered.hits.map((h) => `${h.file}:${h.line}:${h.endLine}`));
        const keptSimple = new Set(filtered.hits.map((h) => `${h.file}:${h.line}`));
        const filteredMatches = allRaw.filter((m) => kept.has(`${m.path}:${m.line}:${m.endLine}`) || keptSimple.has(`${m.path}:${m.line}`));
        totalMatches = filteredMatches.length;
        const paged = filteredMatches.slice(skip, skip + topK);
        truncated = rawCeilingHit ? true : skip + paged.length < totalMatches;
        matches = paged;
    } else {
        const result = await structuralSearch({
            pattern: params.pattern,
            language: structural.language,
            skip,
            limit: topK,
            groupByFile,
            cwd,
            path: params.path,
            glob: params.glob,
        });
        if (result.status === "unavailable") {
            const details: StructuralDetails = {
                schemaVersion: 1,
                status: "unavailable",
                skip,
                groupByFile,
                totalMatches: 0,
                shownMatches: 0,
                truncated: false,
                matches: [],
                reason: result.reason,
            };
            return {
                pattern: params.pattern,
                shown: [],
                totalHits: 0,
                engines: ["structural"],
                truncated: false,
                elapsedMs: Date.now() - startTime,
                graphFilterNotes: [],
                structuralSearch: details,
            };
        }
        matches = result.matches;
        totalMatches = result.totalMatches;
        truncated = result.truncated;
    }
    const enriched: Array<StructuralSearchMatch & { read: { path: string; offset: number; limit: number } }> = matches.map((m) => {
        const rel = relative(cwd, m.path).replace(/\\/g, "/");
        const limit = Math.max(1, m.endLine - m.line + 1);
        return { ...m, path: rel, read: { path: rel, offset: m.line, limit } };
    });
    const groupedByFile = groupByFile ? (() => {
        const g: Record<string, typeof enriched> = {};
        for (const e of enriched) (g[e.path] ??= []).push(e);
        return g;
    })() : undefined;
    const details: StructuralDetails = {
        schemaVersion: 1,
        status: "ok",
        skip,
        groupByFile,
        totalMatches,
        shownMatches: enriched.length,
        truncated,
        matches: enriched,
        ...(groupedByFile ? { groupedByFile } : {}),
    };
    const hits: GrepHit[] = enriched.map((m) => ({
        file: tryCanonical(resolve(cwd, m.path)),
        relFile: m.path,
        line: m.line,
        endLine: m.endLine,
        name: m.text.slice(0, 80),
        kind: "structural",
        snippet: m.text,
        engines: ["structural"],
        score: 0,
    }));
    return {
        pattern: params.pattern,
        shown: hits,
        totalHits: totalMatches,
        engines: ["structural"],
        truncated,
        elapsedMs: Date.now() - startTime,
        graphFilterNotes,
        structuralSearch: details,
    };
}

async function executeGrepQuery(
    params: GrepQueryInput & { structural?: { language?: string; skip?: number; groupByFile?: boolean } },
    cwd: string,
    opts: GrepToolOptions,
    signal: AbortSignal | undefined,
): Promise<GrepExecutionResult> {
    // Structural branch — validate combos before any IO
    if ((params as any).structural !== undefined) {
        return executeStructuralQuery(params as any, cwd, opts);
    }
    const { searchDir, scopedFile } = resolveSearchScope(cwd, params.path);
    const topK = clamp(params.limit ?? 20, 1, 100);
    const contextLines = clamp(params.contextLines ?? 2, 0, 10);
    const caseSensitive = !(params.ignoreCase ?? false);
    const startTime = Date.now();

    const regexPattern = params.literal ? null : detectRegexPattern(params.pattern);
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
    for (;;) {
        const searchResult = params.literal || regexPattern === null
            ? params.literal
                ? await runLiteralGrep(params.pattern, searchDir, gatherK, contextLines, caseSensitive, cwd, signal, scopedFile, fileGlob)
                : await runSmartCascade(
                    params.pattern,
                    searchDir,
                    gatherK,
                    contextLines,
                    caseSensitive,
                    cwd,
                    signal,
                    scopedFile,
                    fileGlob,
                    opts,
                    // Graph filtering needs a larger candidate pool: exact
                    // lexical hits can all be filtered out, so keep the
                    // fallback layers available in that mode.
                    !hasGraphFilter,
                )
            : await runRegexGrep(regexPattern, searchDir, gatherK, contextLines, caseSensitive, cwd, signal, scopedFile, fileGlob);
        let current = searchResult.hits;
        engines = searchResult.engines;
        degradation = searchResult.degradation;

        if (params.glob) {
            const { minimatch } = await import("minimatch");
            current = current.filter((hit) => minimatch(hit.relFile, params.glob!));
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

    return {
        pattern: params.pattern,
        shown: hits.slice(0, topK),
        totalHits: hits.length,
        engines,
        truncated: hits.length > topK,
        elapsedMs: Date.now() - startTime,
        graphFilterNotes,
        ...(degradation ? { degradation } : {}),
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

// ── Helpers ──────────────────────────────────────────────────────────

function tryCanonical(filePath: string): string {
    try { return realpathSync(filePath); } catch { return filePath; }
}

function resolveSearchScope(cwd: string, inputPath: string | undefined): { searchDir: string; scopedFile?: string } {
    const target = inputPath ? resolve(cwd, inputPath) : cwd;
    try {
        if (statSync(target).isFile()) {
            const scopedFile = tryCanonical(target);
            return { searchDir: dirname(scopedFile), scopedFile };
        }
    } catch { /* missing paths fall through to directory discovery */ }
    return { searchDir: target };
}

const REGEX_SYNTAX = /(^|[^\\])(?:\||\^|\$|\.\*|\.\+|\[[^\]]+\]|\([^)]*\)|\{\d+(?:,\d*)?\}|\\[bBdDsSwW])/;

function detectRegexPattern(pattern: string): string | null {
    if (!REGEX_SYNTAX.test(pattern)) return null;
    try {
        new RegExp(pattern);
        return pattern;
    } catch {
        return null;
    }
}

// ── Smart cascade ───────────────────────────────────────────────────

const GREP_MIN_SEMANTIC_SCORE = 0.3;

async function runSmartCascade(
    pattern: string,
    searchDir: string,
    gatherK: number,
    contextLines: number,
    caseSensitive: boolean,
    cwd: string,
    signal: AbortSignal | undefined,
    scopedFile?: string,
    fileGlob?: string,
    opts?: GrepToolOptions,
    allowExactShortCircuit = true,
): Promise<{ hits: GrepHit[]; engines: string[]; degradation?: GrepDegradation[] }> {
    const bigK = gatherK;
    const root = canonicalizeWorkspaceRoot(cwd);
    const degradation: GrepDegradation[] = [];
    const semanticIndex = getSemanticIndex(searchDir);
    const exactResult = await runLiteralGrep(
        pattern,
        searchDir,
        bigK,
        contextLines,
        caseSensitive,
        cwd,
        signal,
        scopedFile,
        fileGlob,
    );
    if (!semanticIndex?.isAvailable()) {
        degradation.push({ backend: "semantic", code: "index_unavailable" });
        recordDegradation("index_unavailable", "semantic");
        // Exact lexical results already satisfy the caller's requested
        // result limit. Avoid the full AST scan and BM25 corpus build in the
        // common path where exact results are sufficient. `gatherK` is at
        // least twice the requested limit (capped at 200), so this preserves
        // the same number of displayed exact results while eliminating the
        // expensive fallback work. Graph-filtered queries opt out above so
        // they can over-fetch candidates that survive graph filtering.
        const requestedLimit = Math.max(1, Math.ceil(gatherK / 2));
        if (allowExactShortCircuit && exactResult.hits.length >= requestedLimit) {
            return { hits: exactResult.hits, engines: ["lexical-passthrough"], degradation };
        }
        // No semantic index: keep grep useful by fusing exact lexical, a real
        // in-memory BM25 ranker (token overlap over the discovered source
        // corpus), and AST symbol search. Exact hits stay prepended at front.
        const symbolHits = new Map<string, GrepHit>();
        let symbolOk = false;
        // Reuse the shared structural index for a simple exact symbol when a
        // graph is already built — avoids a full AST workspace scan. handleSymbol
        // remains the fallback for qualified/partial identifiers, an unavailable
        // graph, or when the symbol is absent from the index.
        const builtGraph = opts?.getSharedContextGraphIfBuilt?.(root) ?? null;
        const isSimpleIdentifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(pattern);
        if (isSimpleIdentifier && builtGraph) {
            const def = builtGraph.findExactSymbolDef(pattern);
            if (def) {
                const absPath = tryCanonical(def.file);
                if (!scopedFile || absPath === scopedFile) {
                    const key = `${absPath}:${def.line}`;
                    symbolHits.set(key, {
                        file: absPath,
                        relFile: relative(cwd, absPath).replace(/\\/g, "/"),
                        line: def.line,
                        endLine: def.line,
                        name: def.name,
                        kind: def.kind,
                        snippet: "",
                        engines: ["symbol"],
                        score: 1,
                    });
                    symbolOk = true;
                }
            }
        }
        if (!symbolOk) {
            try {
                const symResult = await handleSymbol(pattern, bigK, false, searchDir, cwd, signal, fileGlob);
                for (const m of symResult.matches) {
                    const absPath = tryCanonical(resolve(cwd, m.relative_path));
                    if (scopedFile && absPath !== scopedFile) continue;
                    const relFile = m.relative_path;
                    const line = m.line;
                    const key = `${absPath}:${line}`;
                    if (!symbolHits.has(key)) {
                        symbolHits.set(key, {
                            file: absPath,
                            relFile,
                            line,
                            endLine: m.end_line ?? line,
                            name: m.name,
                            kind: "symbol",
                            snippet: m.body ?? "",
                            engines: ["symbol"],
                            score: 1,
                        });
                    }
                }
                if (symbolHits.size > 0) symbolOk = true;
            } catch {
                degradation.push({ backend: "symbol", code: "symbol_failed" });
                recordDegradation("symbol_failed", "symbol");
            }
        }
        const bm25Hits = await runFallbackBm25(pattern, searchDir, bigK, contextLines, cwd, signal, scopedFile, fileGlob, opts, root);

        let combined = fuseAndDedup(bm25Hits, symbolHits);
        if (exactResult.hits.length > 0) {
            combined = prependExactHits(exactResult.hits, combined);
        }

        const engines: string[] = [];
        if (exactResult.hits.length > 0) engines.push("lexical");
        if (bm25Hits.size > 0) engines.push("bm25");
        if (symbolOk) engines.push("symbol");
        if (engines.length === 0) engines.push("lexical-passthrough");
        return { hits: combined, engines, degradation };
    }

    const bm25Hits = new Map<string, GrepHit>();
    const symbolHits = new Map<string, GrepHit>();
    const engines: string[] = [];

    // ── Layer 1: BM25 lexical ───────────────────────────────────────
    if (semanticIndex.isAvailable()) {
        try {
            const prefix = pathPrefixForDirectory(semanticIndex.root, scopedFile ?? searchDir);
            const results = await semanticIndex.search(pattern, { topK: bigK, pathPrefix: prefix, mode: "lexical", fileGlob });
            for (const r of results) {
                const absPath = tryCanonical(resolve(semanticIndex.root, r.filePath));
                if (scopedFile && absPath !== scopedFile) continue;
                const relFile = relative(cwd, absPath).replace(/\\/g, "/");
                const line = r.lineStart;
                const key = `${absPath}:${line}`;
                bm25Hits.set(key, {
                    file: absPath,
                    relFile,
                    line,
                    endLine: r.lineEnd,
                    name: r.symbolKind,
                    kind: "bm25",
                    snippet: r.codeSnippet,
                    engines: ["bm25"],
                    score: r.score,
                });
            }
            if (bm25Hits.size > 0) engines.push("bm25");
        } catch {
            degradation.push({ backend: "bm25", code: "bm25_unavailable" });
            recordDegradation("bm25_unavailable", "bm25");
        }
    }

    if (signal?.aborted) throw new Error("Operation aborted");

    // ── Layer 2: AST symbol match ───────────────────────────────────
    try {
        const symResult = await handleSymbol(pattern, bigK, false, searchDir, cwd, signal, fileGlob);
        for (const m of symResult.matches) {
            const absPath = tryCanonical(resolve(cwd, m.relative_path));
            if (scopedFile && absPath !== scopedFile) continue;
            const relFile = m.relative_path;
            const key = `${absPath}:${m.line}`;
            if (!symbolHits.has(key)) {
                symbolHits.set(key, {
                    file: absPath,
                    relFile,
                    line: m.line,
                    endLine: m.end_line ?? m.line,
                    name: m.name,
                    kind: m.kind,
                    snippet: m.body ?? "",
                    engines: ["symbol"],
                    score: 0,
                });
            }
        }
        if (symbolHits.size > 0) engines.push("symbol");
    } catch {
        degradation.push({ backend: "symbol", code: "symbol_failed" });
        recordDegradation("symbol_failed", "symbol");
    }

    if (signal?.aborted) throw new Error("Operation aborted");

    // ── RRF fusion + exact-match priority + dedup ───────────────────
    let fused = fuseAndDedup(bm25Hits, symbolHits);
    if (exactResult.hits.length > 0) {
        if (fused.length === 0) {
            return { hits: exactResult.hits, engines: ["lexical-passthrough"], degradation };
        }
        fused = prependExactHits(exactResult.hits, fused);
        engines.unshift("lexical");
    }

    // ── Fallback: semantic vector search (wider topK) ───────────────
    if (fused.length === 0 && semanticIndex?.isAvailable()) {
        try {
            const prefix = pathPrefixForDirectory(semanticIndex.root, scopedFile ?? searchDir);
            const results = await semanticIndex.search(pattern, {
                topK: bigK * 3,
                pathPrefix: prefix,
                mode: "semantic",
                minScore: GREP_MIN_SEMANTIC_SCORE,
                fileGlob,
            });
            const retryHits = new Map<string, GrepHit>();
            for (const r of results) {
                const absPath = tryCanonical(resolve(semanticIndex.root, r.filePath));
                if (scopedFile && absPath !== scopedFile) continue;
                const relFile = relative(cwd, absPath).replace(/\\/g, "/");
                const line = r.lineStart;
                const key = `${absPath}:${line}`;
                retryHits.set(key, {
                    file: absPath,
                    relFile,
                    line,
                    endLine: r.lineEnd,
                    name: r.symbolKind,
                    kind: "semantic",
                    snippet: r.codeSnippet,
                    engines: ["semantic"],
                    score: r.score,
                });
            }
            if (retryHits.size > 0) {
                fused = [...retryHits.values()];
                engines.push("semantic");
            }
        } catch {
            degradation.push({ backend: "semantic", code: "semantic_failed" });
            recordDegradation("semantic_failed", "semantic");
        }
    }

    if (signal?.aborted) throw new Error("Operation aborted");

    if (fused.length === 0) {
        // Genuine zero results are NOT a backend failure — do not emit a
        // degradation code. Real failures (index_unavailable, bm25_unavailable,
        // symbol_failed, semantic_failed) are already recorded above.
        return { hits: [], engines: ["lexical-passthrough"], degradation };
    }

    // Fill snippet for hits missing one (symbol hits often lack snippet).
    await enrichSnippets(fused, contextLines);

    return { hits: fused, engines, degradation };
}

// ── Literal grep passthrough ────────────────────────────────────────

async function runLiteralGrep(
    pattern: string,
    searchDir: string,
    topK: number,
    contextLines: number,
    caseSensitive: boolean,
    cwd: string,
    signal: AbortSignal | undefined,
    scopedFile?: string,
    fileGlob?: string,
): Promise<{ hits: GrepHit[]; engines: string[]; degradation?: GrepDegradation[] }> {
    return runTextGrep(pattern, "literal", searchDir, topK, contextLines, caseSensitive, cwd, signal, scopedFile, fileGlob);
}

async function runRegexGrep(
    pattern: string,
    searchDir: string,
    topK: number,
    contextLines: number,
    caseSensitive: boolean,
    cwd: string,
    signal: AbortSignal | undefined,
    scopedFile?: string,
    fileGlob?: string,
): Promise<{ hits: GrepHit[]; engines: string[]; degradation?: GrepDegradation[] }> {
    return runTextGrep(pattern, "regex", searchDir, topK, contextLines, caseSensitive, cwd, signal, scopedFile, fileGlob);
}

async function runTextGrep(
    pattern: string,
    matchMode: "literal" | "regex",
    searchDir: string,
    topK: number,
    contextLines: number,
    caseSensitive: boolean,
    cwd: string,
    signal: AbortSignal | undefined,
    scopedFile?: string,
    fileGlob?: string,
): Promise<{ hits: GrepHit[]; engines: string[]; degradation?: GrepDegradation[] }> {
    const directFileOptions = scopedFile
        ? {
            preDiscoveredFiles: [scopedFile],
            sharedSummary: {
                profile: "text" as const,
                root: searchDir,
                directoriesVisited: 0,
                filesConsidered: 1,
                filesMatched: 1,
                filesSkippedIgnored: 0,
                dirsSkippedHardDenied: 0,
                filesSkippedBinary: 0,
                filesSkippedUnsupported: 0,
                ignoredDetails: [],
                ignoredDetailsTruncated: 0,
                workspaceRootsSearched: [searchDir],
            },
        }
        : undefined;
    const grepOptions = { ...(directFileOptions ?? {}), ...(fileGlob ? { fileGlob } : {}) };
    const result = await handleGrep(
        `grep-${matchMode}:${pattern}`,
        {
            query: pattern,
            directory: searchDir,
            maxResults: topK,
            matchMode,
            caseSensitive,
            contextLines,
        } as never,
        searchDir,
        signal,
        grepOptions,
    );
    const rawMatches: Array<{
        file?: unknown;
        relFile?: unknown;
        line?: unknown;
        endLine?: unknown;
        name?: unknown;
        kind?: unknown;
        snippet?: unknown;
    }> = (((result.details as Record<string, unknown> | undefined)?.matches) as never) ?? [];

    const engine = matchMode === "literal" ? "lexical" : "regex";
    const hits: GrepHit[] = [];
    for (const m of rawMatches) {
        if (typeof m.file !== "string") continue;
        const absPath = tryCanonical(m.file as string);
        hits.push({
            file: absPath,
            relFile: relative(cwd, absPath).replace(/\\/g, "/"),
            line: typeof m.line === "number" ? m.line : 1,
            endLine: typeof m.endLine === "number" ? m.endLine : (typeof m.line === "number" ? m.line : 1),
            name: typeof m.name === "string" ? m.name : "(text match)",
            kind: typeof m.kind === "string" ? m.kind : "text",
            snippet: typeof m.snippet === "string" ? m.snippet : "",
            engines: [engine],
            score: 0,
        });
    }
    return { hits, engines: [engine] };
}

// ── RRF fusion + dedup ─────────────────────────────────────────────

function prependExactHits(exactHits: GrepHit[], rankedHits: GrepHit[]): GrepHit[] {
    const merged = new Map<string, GrepHit>();
    for (const hit of exactHits) {
        merged.set(`${hit.file}:${hit.line}`, { ...hit, engines: unique([...hit.engines, "lexical"]) });
    }
    for (const hit of rankedHits) {
        const key = `${hit.file}:${hit.line}`;
        const existing = merged.get(key);
        if (existing) {
            existing.engines = unique([...existing.engines, ...hit.engines]);
        } else {
            merged.set(key, hit);
        }
    }
    return [...merged.values()];
}

/**
 * In-memory BM25 fallback for the no-semantic-index path. Enumerates
 * ignore-aware source files via file-discovery, reads them (bounded and
 * cancellation-aware), scores with the shared bm25Scores scorer, and emits
 * per-file hits with the best query-token-overlap line snippet. No caches or
 * external dependencies. Returns an empty map when nothing ranks.
 */
const MAX_BM25_CANDIDATES = 1000; // ponytail: hard cap on corpus reads; raise if big-repo recall suffers
// Per-file size cap for the BM25 fallback corpus (matches semantic-index's 2MB limit).
const MAX_BM25_FILE_BYTES = 2 * 1024 * 1024;

// ── Per-workspace-revision BM25 corpus cache ──────────────────────────────
// Bounds repeated no-index fallback cost: same workspace + same revision ⇒
// reuse the compiled corpus instead of re-reading/re-tokenizing up to
// MAX_BM25_CANDIDATES files on every query. Correctness is anchored on the
// injected monotonic workspace revision (any mutation bumps it), so a cached
// entry is only ever served for an unchanged workspace.
interface CorpusEntry {
    fileList: string[];
    contents: string[];
    corpus: Bm25Corpus;
}
const MAX_CORPUS_CACHE_ENTRIES = 3; // ponytail: small bounded LRU; raise if multi-glob working sets thrash
const corpusCache = new LruCache<CorpusEntry>(MAX_CORPUS_CACHE_ENTRIES);
const pendingCorpusBuilds = new Map<string, Promise<CorpusEntry | null>>();
let corpusBuildCount = 0; // test instrumentation

function corpusKeyString(root: string, revision: number, searchDir: string, cwd: string, fileGlob: string): string {
    return `${root}\u0000${revision}\u0000${searchDir}\u0000${cwd}\u0000${fileGlob}`;
}

function isWithinWorkspace(root: string, dir: string): boolean {
    const rel = relative(root, dir);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function buildCorpus(
    searchDir: string,
    scopedFile: string | undefined,
    cwd: string,
    fileGlob: string | undefined,
): Promise<CorpusEntry> {
    corpusBuildCount++;
    const fs = await import("node:fs/promises");
    const { minimatch } = await import("minimatch");
    // Apply fileGlob during discovery (before the candidate cap) so matching
    // files beyond the first MAX_BM25_CANDIDATES discovered are still considered.
    const discoveryCap = fileGlob ? 10_000 : MAX_BM25_CANDIDATES;
    let files = scopedFile ? [scopedFile] : await findCodeFiles(searchDir, discoveryCap);
    if (fileGlob) {
        files = files.filter((f) => minimatch(relative(cwd, f).replace(/\\/g, "/"), fileGlob));
    }
    files = files.slice(0, MAX_BM25_CANDIDATES);

    const fileList: string[] = [];
    const contents: string[] = [];
    for (const f of files) {
        try {
            const st = await fs.stat(f);
            if (st.size > MAX_BM25_FILE_BYTES) continue; // skip oversized files
            contents.push(await fs.readFile(f, "utf-8"));
            fileList.push(f);
        } catch {
            // skip unreadable files
        }
    }
    return { fileList, contents, corpus: compileBm25Corpus(contents) };
}

/**
 * Return a corpus for the search scope, caching it per (root, revision).
 * Scoped single-file searches and searches outside the tracked workspace (or
 * without an injected revision source) are never cached. Concurrent callers
 * coalesce onto a single in-flight build; a build that finished after the
 * workspace revision changed is discarded (never published) and rebuilt.
 */
async function getSearchCorpus(
    searchDir: string,
    scopedFile: string | undefined,
    cwd: string,
    fileGlob: string | undefined,
    root: string,
    getWorkspaceRevision: (() => number) | undefined,
): Promise<{ entry: CorpusEntry; cached: boolean }> {
    // Uncacheable scope: single-file target, no revision source, or a search
    // that leaves the tracked workspace (revision doesn't reflect it).
    const cacheable =
        !scopedFile &&
        getWorkspaceRevision !== undefined &&
        isWithinWorkspace(root, searchDir);
    if (!cacheable) {
        return { entry: await buildCorpus(searchDir, scopedFile, cwd, fileGlob), cached: false };
    }
    const glob = fileGlob ?? "";
    for (let attempt = 0; attempt < 5; attempt++) {
        const revision = getWorkspaceRevision();
        const key = corpusKeyString(root, revision, searchDir, cwd, glob);
        const hit = corpusCache.get(key);
        if (hit) return { entry: hit, cached: true };
        let pending = pendingCorpusBuilds.get(key);
        if (!pending) {
            // Builder must not inherit any caller abort signal: a coalesced
            // build serves all concurrent callers, so cancellation is handled
            // by the caller before/after the await, never inside the build.
            pending = buildCorpus(searchDir, scopedFile, cwd, fileGlob).then((entry) => {
                if (getWorkspaceRevision() !== revision) return null; // stale — don't publish
                corpusCache.set(key, entry);
                return entry;
            });
            pendingCorpusBuilds.set(key, pending);
        }
        try {
            const result = await pending;
            if (result) return { entry: result, cached: false };
            // Revision changed mid-build → loop to rebuild at the new revision.
        } catch (err) {
            pendingCorpusBuilds.delete(key);
            throw err;
        } finally {
            pendingCorpusBuilds.delete(key);
        }
    }
    // Safety net: loop exited without a fresh build (revision churn).
    return { entry: await buildCorpus(searchDir, scopedFile, cwd, fileGlob), cached: false };
}

async function runFallbackBm25(
    pattern: string,
    searchDir: string,
    topK: number,
    contextLines: number,
    cwd: string,
    signal: AbortSignal | undefined,
    scopedFile: string | undefined,
    fileGlob: string | undefined,
    opts: GrepToolOptions | undefined,
    root: string,
): Promise<Map<string, GrepHit>> {
    const hits = new Map<string, GrepHit>();
    if (signal?.aborted) throw new Error("Operation aborted");

    const { entry } = await getSearchCorpus(
        searchDir,
        scopedFile,
        cwd,
        fileGlob,
        root,
        opts?.getWorkspaceRevision,
    );
    // Cancellation is honored around (not inside) the shared corpus build.
    if (signal?.aborted) throw new Error("Operation aborted");

    const { fileList, contents, corpus } = entry;
    if (fileList.length === 0) return hits;

    const scores = corpus.score(pattern);
    const queryTokens = tokenize(pattern);

    const ranked: Array<{ file: string; score: number; content: string }> = [];
    for (let i = 0; i < fileList.length; i++) {
        const score = scores[i] ?? 0;
        if (score > 0) ranked.push({ file: fileList[i]!, score, content: contents[i]! });
    }
    ranked.sort((a, b) => b.score - a.score);

    for (const item of ranked.slice(0, topK)) {
        const absPath = tryCanonical(item.file);
        const lines = item.content.split(/\r?\n/);
        let bestLine = 1;
        let bestCount = -1;
        for (let i = 0; i < lines.length; i++) {
            const lower = lines[i]!.toLowerCase();
            let count = 0;
            for (const tok of queryTokens) if (lower.includes(tok)) count++;
            if (count > bestCount) {
                bestCount = count;
                bestLine = i + 1;
            }
        }
        const start = Math.max(0, bestLine - 1 - contextLines);
        const end = Math.min(lines.length - 1, bestLine - 1 + contextLines);
        const snippetLines: string[] = [];
        for (let i = start; i <= end; i++) {
            snippetLines.push(`    ${String(i + 1).padStart(4, " ")} | ${lines[i] ?? ""}`);
        }
        hits.set(`${absPath}:${bestLine}`, {
            file: absPath,
            relFile: relative(cwd, absPath).replace(/\\/g, "/"),
            line: bestLine,
            endLine: bestLine,
            name: "(bm25 match)",
            kind: "bm25",
            snippet: snippetLines.join("\n"),
            engines: ["bm25"],
            score: item.score,
        });
    }
    return hits;
}

function fuseAndDedup(
    bm25Hits: Map<string, GrepHit>,
    symbolHits: Map<string, GrepHit>,
): GrepHit[] {
    const merged = new Map<string, GrepHit>();

    let rank = 0;
    for (const [key, hit] of bm25Hits) {
        rank++;
        const existing = merged.get(key);
        if (existing) {
            existing.score += 1 / (60 + rank);
            if (!existing.engines.includes("bm25")) existing.engines.push("bm25");
        } else {
            merged.set(key, { ...hit, score: 1 / (60 + rank) });
        }
    }

    rank = 0;
    for (const [key, hit] of symbolHits) {
        rank++;
        const existing = merged.get(key);
        if (existing) {
            existing.score += 1 / (60 + rank);
            if (!existing.engines.includes("symbol")) existing.engines.push("symbol");
        } else {
            merged.set(key, { ...hit, score: 1 / (60 + rank) });
        }
    }

    const results = [...merged.values()];
    results.sort((a, b) => b.score - a.score);
    return results;
}

// ── Enrich snippets for hits missing one ───────────────────────────

async function enrichSnippets(hits: GrepHit[], contextLines: number): Promise<void> {
    const fs = await import("node:fs/promises");
    for (const hit of hits) {
        if (hit.snippet) continue;
        try {
            const content = await fs.readFile(hit.file, "utf-8");
            const lines = content.split(/\r?\n/);
            const start = Math.max(0, hit.line - 1 - contextLines);
            const end = Math.min(lines.length - 1, hit.line - 1 + contextLines);
            const snippetLines: string[] = [];
            for (let i = start; i <= end; i++) {
                snippetLines.push(`    ${String(i + 1).padStart(4, " ")} | ${lines[i] ?? ""}`);
            }
            hit.snippet = snippetLines.join("\n");
        } catch { /* file unreadable */ }
    }
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
                resourceId: resourceIdFor({ canonicalPath: canonical, kind: "range", range }),
                canonicalPath: canonical,
                kind: "range",
                coverage: "search-match",
                allowedRanges: [range],
                fresh: false,
            });
        }
    }

    const resources = [...resourcesByPath.values()];
    const inspectionId = inspectionIdFor({
        sessionId,
        workspaceRoot: canonicalRoot,
        resources: resources.map((r) => ({
            canonicalPath: r.canonicalPath,
            ...(r.allowedRanges[0] ? { range: r.allowedRanges[0] } : {}),
        })),
    });

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

function formatExecutionOutput(result: GrepExecutionResult): string {
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

function formatBatchOutput(results: GrepExecutionResult[]): string {
    return results.map((result, index) => [
        `Query ${index + 1}: "${result.pattern}"`,
        formatExecutionOutput(result),
    ].join("\n")).join("\n\n");
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
): string {
    const engineStr = engines.join(" + ");
    const lines: string[] = [
        `${totalHits} result(s) for "${pattern}" (${engineStr}, ${(elapsedMs / 1000).toFixed(1)}s)`,
        "",
    ];

    for (const hit of shown) {
        const symbolPart = hit.name ? `  ${hit.name}` : "";
        const lineRange = hit.endLine > hit.line ? `L${hit.line}-${hit.endLine}` : `L${hit.line}`;
        lines.push(`${hit.relFile}  ${lineRange}${symbolPart}`);
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

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, Math.trunc(value)));
}

// ── Test instrumentation ────────────────────────────────────────────────────
// Exported so focused tests can assert cache reuse/invalidation deterministically
// without wall-clock timing. Production callers never need these.
export function _bm25CorpusCacheForTests(): { size: number; builds: number } {
    return { size: corpusCache.size, builds: corpusBuildCount };
}
export function _resetBm25CorpusCacheForTests(): void {
    corpusCache.clear();
    pendingCorpusBuilds.clear();
    corpusBuildCount = 0;
}

/**
 * Deterministic corpus-cache benchmark (test instrumentation). Builds an
 * n-file synthetic repo, measures cold vs warm getSearchCorpus elapsed time
 * and corpus build counts. No wall-clock threshold — asserts cache-hit and
 * build-count determinism, not timing. Isolates the corpus cache from the
 * full grep path (which also runs an AST symbol scan that would dominate).
 */
export async function _bm25CacheBenchmark(
    n: number,
): Promise<{ coldMs: number; warmMs: number; coldBuilds: number; warmBuilds: number; cachedWarm: boolean }> {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const pm = await import("node:path");
    const dir = fs.realpathSync(fs.mkdtempSync(pm.join(os.tmpdir(), "grep-bench-")));
    fs.mkdirSync(pm.join(dir, "src"), { recursive: true });
    for (let i = 0; i < n; i++) {
        fs.writeFileSync(pm.join(dir, "src", `f${i}.ts`), `export function fn${i}(x:number){return tokenize("alpha${i}")+x;}\n`, "utf8");
    }
    _resetBm25CorpusCacheForTests();
    const getRevision = () => 0;
    const src = pm.join(dir, "src");
    const t0 = Date.now();
    await getSearchCorpus(src, undefined, dir, undefined, dir, getRevision);
    const coldMs = Date.now() - t0;
    const coldBuilds = _bm25CorpusCacheForTests().builds;
    const t1 = Date.now();
    const warm = await getSearchCorpus(src, undefined, dir, undefined, dir, getRevision);
    const warmMs = Date.now() - t1;
    const warmBuilds = _bm25CorpusCacheForTests().builds;
    fs.rmSync(dir, { recursive: true, force: true });
    return { coldMs, warmMs, coldBuilds, warmBuilds, cachedWarm: warm.cached };
}
