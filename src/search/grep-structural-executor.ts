/**
 * Grep structural executor — ast-grep pagination/graph-filter/details.
 *
 * Extracted from grep-tool.ts (P2.3). Owns executeStructuralQuery:
 * structural validation, paginated raw-match fetching, graph-filtered
 * full-set pagination with raw ceiling, StructuralDetails assembly, and
 * GrepHit conversion. The tool facade in grep-tool.ts keeps
 * schema/dispatch/evidence/format.
 */

import { relative, resolve } from "node:path";
import type { ContextGraph } from "../context-graph.js";
import { applyGraphFilter, parseGraphFilter } from "./graph-filter.js";
import { structuralSearch, resolveStructuralLang, STRUCTURAL_SEARCH_MAX_LIMIT, STRUCTURAL_SEARCH_RAW_CEILING } from "../structural/structural-search.js";
import type { StructuralSearchMatch } from "../structural/structural-search.js";
import { tryCanonical, type GrepExecutionResult, type GrepHit, type StructuralDetails } from "./grep-cascade.js";

export const GREP_STRUCTURAL_FETCH_SIZE = STRUCTURAL_SEARCH_MAX_LIMIT;
export const GREP_STRUCTURAL_MAX_ITERATIONS = 20000;

/** Query shape the structural executor accepts (mirrors GrepQueryInput). */
export interface StructuralQueryParams {
    pattern: string;
    limit?: number;
    path?: string;
    glob?: string;
    literal?: boolean;
    ignoreCase?: boolean;
    graphFilter?: string;
    skip?: number;
    structural: { language?: string; skip?: number; groupByFile?: boolean };
}

/** Deps the structural executor needs (subset of GrepToolOptions). */
export interface StructuralExecutorDeps {
    readonly contextGraph?: ContextGraph | ((cwd: string) => ContextGraph | Promise<ContextGraph>);
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, Math.trunc(value)));
}

interface ValidatedStructuralQuery {
    topK: number;
    skip: number;
    groupByFile: boolean;
    hasGraphFilter: boolean;
}

function validateStructuralParams(params: StructuralQueryParams): ValidatedStructuralQuery {
    const structural = params.structural;
    if (params.literal) throw new Error("structural search cannot be combined with literal: choose one");
    if (params.ignoreCase) throw new Error("structural search cannot be combined with ignoreCase");
    if (structural.language !== undefined) {
        const resolved = resolveStructuralLang(structural.language);
        if (!resolved) throw new Error(`unsupported language: ${structural.language}`);
    }
    const skip = structural.skip ?? params.skip ?? 0;
    if (!Number.isInteger(skip) || skip < 0) throw new Error("structural.skip must be an integer >= 0");
    return {
        topK: clamp(params.limit ?? 20, 1, 100),
        skip,
        groupByFile: Boolean(structural.groupByFile),
        hasGraphFilter: params.graphFilter !== undefined,
    };
}

function buildUnavailableResult(args: {
    pattern: string;
    skip: number;
    groupByFile: boolean;
    reason: string | undefined;
    startTime: number;
}): GrepExecutionResult {
    const details: StructuralDetails = {
        schemaVersion: 1,
        status: "unavailable",
        skip: args.skip,
        groupByFile: args.groupByFile,
        totalMatches: 0,
        shownMatches: 0,
        truncated: false,
        matches: [],
        reason: args.reason,
    };
    return {
        pattern: args.pattern,
        shown: [],
        totalHits: 0,
        engines: ["structural"],
        truncated: false,
        elapsedMs: Date.now() - args.startTime,
        graphFilterNotes: [],
        structuralSearch: details,
    };
}

async function requireContextGraph(
    params: StructuralQueryParams,
    cwd: string,
    deps: StructuralExecutorDeps,
): Promise<ContextGraph> {
    if (!parseGraphFilter(params.graphFilter!)) throw new Error('Invalid graphFilter: expected "EDGE_TYPE->target" format');
    const contextGraph = typeof deps.contextGraph === "function" ? await deps.contextGraph(cwd) : deps.contextGraph;
    if (!contextGraph) throw new Error("graphFilter requires an indexed context graph");
    return contextGraph;
}

function shouldStopFetching(args: { iterations: number; offset: number; rawCount: number }): boolean {
    if (args.iterations >= GREP_STRUCTURAL_MAX_ITERATIONS) return true;
    if (args.offset >= STRUCTURAL_SEARCH_RAW_CEILING) return true;
    if (args.rawCount >= STRUCTURAL_SEARCH_RAW_CEILING) return true;
    return false;
}

type RawFetchOutcome =
    | { status: "unavailable"; reason: string | undefined }
    | { status: "ok"; allRaw: StructuralSearchMatch[]; rawCeilingHit: boolean };

async function fetchAllRawMatches(args: { params: StructuralQueryParams; cwd: string }): Promise<RawFetchOutcome> {
    const { params, cwd } = args;
    const structural = params.structural;
    const allRaw: StructuralSearchMatch[] = [];
    let offset = 0;
    let iterations = 0;
    let rawCeilingHit = false;
    // GREP_STRUCTURAL_MAX_ITERATIONS hard cap prevents hang;
    // STRUCTURAL_SEARCH_RAW_CEILING prevents skip-clamp repetition above ~10M raw matches.
    while (true) {
        if (shouldStopFetching({ iterations: iterations++, offset, rawCount: allRaw.length })) {
            rawCeilingHit = rawCeilingHit || offset >= STRUCTURAL_SEARCH_RAW_CEILING || allRaw.length >= STRUCTURAL_SEARCH_RAW_CEILING;
            break;
        }
        const chunk = await structuralSearch({
            pattern: params.pattern,
            language: structural.language,
            skip: offset,
            limit: GREP_STRUCTURAL_FETCH_SIZE,
            groupByFile: false,
            cwd,
            path: params.path,
            glob: params.glob,
        });
        if (chunk.status === "unavailable") return { status: "unavailable", reason: chunk.reason };
        // Hard ceiling: structuralSearch clamps skip to MAX_SKIP, so above ceiling same page repeats.
        // Detect clamp/ceiling and terminate with truncated:true instead of looping.
        if ((chunk as any).skip !== undefined && (chunk as any).skip !== offset) {
            rawCeilingHit = true;
            break;
        }
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
        const nextOffset = offset + GREP_STRUCTURAL_FETCH_SIZE;
        if (nextOffset <= offset) break;
        if (nextOffset > STRUCTURAL_SEARCH_RAW_CEILING) {
            rawCeilingHit = true;
            break;
        }
        offset = nextOffset;
    }
    return { status: "ok", allRaw, rawCeilingHit };
}

async function applyGraphFilterToMatches(args: {
    allRaw: StructuralSearchMatch[];
    graphFilter: string;
    contextGraph: ContextGraph;
    cwd: string;
    skip: number;
    topK: number;
    rawCeilingHit: boolean;
}): Promise<{ matches: StructuralSearchMatch[]; totalMatches: number; truncated: boolean; graphFilterNotes: string[] }> {
    const hitsForFilter: GrepHit[] = args.allRaw.map((m) => ({
        file: m.path,
        relFile: relative(args.cwd, m.path).replace(/\\/g, "/"),
        line: m.line,
        endLine: m.endLine,
        name: "",
        kind: "structural",
        snippet: m.text,
        engines: ["structural"],
        score: 0,
    }));
    const filtered = await applyGraphFilter(hitsForFilter, args.graphFilter, args.contextGraph);
    const kept = new Set(filtered.hits.map((h) => `${h.file}:${h.line}:${h.endLine}`));
    const keptSimple = new Set(filtered.hits.map((h) => `${h.file}:${h.line}`));
    const filteredMatches = args.allRaw.filter((m) => kept.has(`${m.path}:${m.line}:${m.endLine}`) || keptSimple.has(`${m.path}:${m.line}`));
    const paged = filteredMatches.slice(args.skip, args.skip + args.topK);
    return {
        matches: paged,
        totalMatches: filteredMatches.length,
        truncated: args.rawCeilingHit ? true : args.skip + paged.length < filteredMatches.length,
        graphFilterNotes: filtered.notes,
    };
}

type SimpleQueryOutcome =
    | { status: "unavailable"; reason: string | undefined }
    | { status: "ok"; matches: StructuralSearchMatch[]; totalMatches: number; truncated: boolean };

async function runSimpleStructuralQuery(args: {
    params: StructuralQueryParams;
    cwd: string;
    skip: number;
    topK: number;
    groupByFile: boolean;
}): Promise<SimpleQueryOutcome> {
    const result = await structuralSearch({
        pattern: args.params.pattern,
        language: args.params.structural.language,
        skip: args.skip,
        limit: args.topK,
        groupByFile: args.groupByFile,
        cwd: args.cwd,
        path: args.params.path,
        glob: args.params.glob,
    });
    if (result.status === "unavailable") return { status: "unavailable", reason: result.reason };
    return { status: "ok", matches: result.matches, totalMatches: result.totalMatches, truncated: result.truncated };
}

type EnrichedStructuralMatch = StructuralSearchMatch & { read: { path: string; offset: number; limit: number } };

function enrichStructuralMatches(matches: StructuralSearchMatch[], cwd: string): EnrichedStructuralMatch[] {
    return matches.map((m) => {
        const rel = relative(cwd, m.path).replace(/\\/g, "/");
        const limit = Math.max(1, m.endLine - m.line + 1);
        return { ...m, path: rel, read: { path: rel, offset: m.line, limit } };
    });
}

function groupEnrichedByFile(enriched: EnrichedStructuralMatch[]): Record<string, EnrichedStructuralMatch[]> {
    const grouped: Record<string, EnrichedStructuralMatch[]> = {};
    for (const entry of enriched) (grouped[entry.path] ??= []).push(entry);
    return grouped;
}

function buildOkResult(args: {
    params: StructuralQueryParams;
    cwd: string;
    enriched: EnrichedStructuralMatch[];
    totalMatches: number;
    truncated: boolean;
    skip: number;
    groupByFile: boolean;
    graphFilterNotes: string[];
    startTime: number;
}): GrepExecutionResult {
    const groupedByFile = args.groupByFile ? groupEnrichedByFile(args.enriched) : undefined;
    const details: StructuralDetails = {
        schemaVersion: 1,
        status: "ok",
        skip: args.skip,
        groupByFile: args.groupByFile,
        totalMatches: args.totalMatches,
        shownMatches: args.enriched.length,
        truncated: args.truncated,
        matches: args.enriched,
        ...(groupedByFile ? { groupedByFile } : {}),
    };
    const hits: GrepHit[] = args.enriched.map((m) => ({
        file: tryCanonical(resolve(args.cwd, m.path)),
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
        pattern: args.params.pattern,
        shown: hits,
        totalHits: args.totalMatches,
        engines: ["structural"],
        truncated: args.truncated,
        elapsedMs: Date.now() - args.startTime,
        graphFilterNotes: args.graphFilterNotes,
        structuralSearch: details,
    };
}

async function executeGraphFilteredQuery(args: {
    params: StructuralQueryParams;
    cwd: string;
    deps: StructuralExecutorDeps;
    topK: number;
    skip: number;
}): Promise<{ matches: StructuralSearchMatch[]; totalMatches: number; truncated: boolean; graphFilterNotes: string[] } | { unavailableReason: string | undefined }> {
    // When graphFilter present, fetch full raw match set first then filter — otherwise cap at 1000 before filtering loses hits.
    const contextGraph = await requireContextGraph(args.params, args.cwd, args.deps);
    const fetched = await fetchAllRawMatches({ params: args.params, cwd: args.cwd });
    if (fetched.status === "unavailable") return { unavailableReason: fetched.reason };
    return applyGraphFilterToMatches({
        allRaw: fetched.allRaw,
        graphFilter: args.params.graphFilter!,
        contextGraph,
        cwd: args.cwd,
        skip: args.skip,
        topK: args.topK,
        rawCeilingHit: fetched.rawCeilingHit,
    });
}

export async function executeStructuralQuery(
    params: StructuralQueryParams,
    cwd: string,
    deps: StructuralExecutorDeps,
): Promise<GrepExecutionResult> {
    const { topK, skip, groupByFile, hasGraphFilter } = validateStructuralParams(params);
    const startTime = Date.now();
    let matches: StructuralSearchMatch[];
    let totalMatches: number;
    let truncated: boolean;
    let graphFilterNotes: string[] = [];
    if (hasGraphFilter) {
        const outcome = await executeGraphFilteredQuery({ params, cwd, deps, topK, skip });
        if ("unavailableReason" in outcome) {
            return buildUnavailableResult({ pattern: params.pattern, skip, groupByFile, reason: outcome.unavailableReason, startTime });
        }
        matches = outcome.matches;
        totalMatches = outcome.totalMatches;
        truncated = outcome.truncated;
        graphFilterNotes = outcome.graphFilterNotes;
    } else {
        const outcome = await runSimpleStructuralQuery({ params, cwd, skip, topK, groupByFile });
        if (outcome.status === "unavailable") {
            return buildUnavailableResult({ pattern: params.pattern, skip, groupByFile, reason: outcome.reason, startTime });
        }
        matches = outcome.matches;
        totalMatches = outcome.totalMatches;
        truncated = outcome.truncated;
    }
    const enriched = enrichStructuralMatches(matches, cwd);
    return buildOkResult({
        params,
        cwd,
        enriched,
        totalMatches,
        truncated,
        skip,
        groupByFile,
        graphFilterNotes,
        startTime,
    });
}
