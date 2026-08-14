/**
 * Wrapped grep tool — primary code search with BM25 + AST symbol cascade.
 *
 * literal:true → direct lexical grep.
 * Otherwise: Layer1 BM25 + Layer2 AST symbol → RRF fusion → dedup →
 * exact lexical safeguard → semantic vector fallback.
 */

import { realpathSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
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

// ── Schema ──────────────────────────────────────────────────────────

const GrepOptionProperties = {
    path: Type.Optional(Type.String({ description: "Directory or file to search in (default: cwd)." })),
    glob: Type.Optional(Type.String({ description: "File filter, e.g. '*.ts' or 'src/**/*.py'." })),
    ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)." })),
    literal: Type.Optional(Type.Boolean({ description: "Exact substring match — skip regex detection and BM25/semantic (default: false)." })),
    limit: Type.Optional(Type.Number({ description: "Max results (default: 20, max: 100).", default: 20, minimum: 1, maximum: 100 })),
    contextLines: Type.Optional(Type.Number({ description: "Lines of context per match (default: 2, max: 10).", default: 2, minimum: 0, maximum: 10 })),
    graphFilter: Type.Optional(Type.String({ description: 'Filter results by graph relationship. Format: "EDGE_TYPE->target" e.g. "CALLS->auth.login" or "IMPORTED_BY->src/core".' })),
};

const GrepQuerySchema = Type.Object({
    pattern: Type.String({ description: "Text, symbol name, or concept to search for.", minLength: 1 }),
    ...GrepOptionProperties,
});

const GrepSchema = Type.Object({
    pattern: Type.Optional(Type.String({ description: "Single text, symbol name, or concept to search for. Provide pattern or queries, not both.", minLength: 1 })),
    queries: Type.Optional(Type.Array(GrepQuerySchema, {
        description: "Multiple searches to run in one call. Top-level options are shared defaults; per-query options override them.",
        minItems: 1,
        maxItems: 10,
    })),
    ...GrepOptionProperties,
});

type GrepInput = Static<typeof GrepSchema>;
type GrepQueryInput = Static<typeof GrepQuerySchema>;

export const GREP_DESCRIPTION = `Search code for one or more text patterns, symbol names, or concepts.
Use this as your primary tool for finding code — it handles exact matches,
symbol lookups, and conceptual queries automatically.
Example: grep('auth middleware') finds authentication code even if the
function is named validateToken. Valid regex syntax such as 'TODO|FIXME' is
auto-detected; set literal:true to search regex metacharacters as plain text.

Provide exactly one of pattern (single search) or queries (1-10 search objects).
Top-level options are shared defaults for batch queries; per-query options override them.
Parameters: path (scope directory/file), glob (file filter), ignoreCase, literal,
limit, contextLines, graphFilter. Results are ranked and deduplicated.

graphFilter: filter results by graph relationship. Format "EDGE_TYPE->target",
e.g. "CALLS->auth.login" (only files that call auth.login) or
"IMPORTED_BY->src/core" (only files imported by src/core).`;

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
    readonly contextGraph?: ContextGraph | (() => ContextGraph);
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
            const queries: GrepQueryInput[] = hasQueries
                ? params.queries!.map((query) => ({ ...shared, ...query }))
                : [{ ...shared, pattern: params.pattern! }];
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
                    })),
                },
            };
        },
    };
}

async function executeGrepQuery(
    params: GrepQueryInput,
    cwd: string,
    opts: GrepToolOptions,
    signal: AbortSignal | undefined,
): Promise<GrepExecutionResult> {
    const { searchDir, scopedFile } = resolveSearchScope(cwd, params.path);
    const topK = clamp(params.limit ?? 20, 1, 100);
    const gatherK = Math.min(topK * 2, 200);
    const contextLines = clamp(params.contextLines ?? 2, 0, 10);
    const caseSensitive = !(params.ignoreCase ?? false);
    const startTime = Date.now();

    const regexPattern = params.literal ? null : detectRegexPattern(params.pattern);
    const fileGlob = params.glob;
    const searchResult = params.literal || regexPattern === null
        ? params.literal
            ? await runLiteralGrep(params.pattern, searchDir, gatherK, contextLines, caseSensitive, cwd, signal, scopedFile, fileGlob)
            : await runSmartCascade(params.pattern, searchDir, gatherK, contextLines, caseSensitive, cwd, signal, scopedFile, fileGlob)
        : await runRegexGrep(regexPattern, searchDir, gatherK, contextLines, caseSensitive, cwd, signal, scopedFile, fileGlob);
    let hits = searchResult.hits;

    if (params.glob) {
        const { minimatch } = await import("minimatch");
        hits = hits.filter((hit) => minimatch(hit.relFile, params.glob!));
    }

    let graphFilterNotes: string[] = [];
    if (params.graphFilter !== undefined) {
        if (!parseGraphFilter(params.graphFilter)) {
            throw new Error('Invalid graphFilter: expected "EDGE_TYPE->target" format');
        }
        const contextGraph = typeof opts.contextGraph === "function" ? opts.contextGraph() : opts.contextGraph;
        if (!contextGraph) throw new Error("graphFilter requires an indexed context graph");
        const filtered = await applyGraphFilter(hits, params.graphFilter, contextGraph);
        hits = filtered.hits;
        graphFilterNotes = filtered.notes;
    }

    return {
        pattern: params.pattern,
        shown: hits.slice(0, topK),
        totalHits: hits.length,
        engines: searchResult.engines,
        truncated: hits.length > topK,
        elapsedMs: Date.now() - startTime,
        graphFilterNotes,
        ...(searchResult.degradation ? { degradation: searchResult.degradation } : {}),
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
): Promise<{ hits: GrepHit[]; engines: string[]; degradation?: GrepDegradation[] }> {
    const bigK = gatherK;
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
        return { hits: exactResult.hits, engines: ["lexical-passthrough"], degradation };
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
