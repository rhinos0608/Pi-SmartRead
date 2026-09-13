/**
 * Grep cascade engines — lexical/BM25/symbol/semantic fusion.
 *
 * Extracted from grep-tool.ts (P2.3). Owns the smart cascade
 * (exact lexical safeguard → in-memory BM25 / index BM25 + AST symbol →
 * RRF fusion → semantic fallback), the literal/regex passthrough engines,
 * and the per-workspace-revision BM25 corpus cache. The tool facade in
 * grep-tool.ts keeps schema/dispatch/evidence/format.
 */

import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { canonicalizeWorkspaceRoot } from "@rhinos0608/pi-workspace-protocol";
import type { ContextGraph } from "./context-graph.js";
import { handleGrep } from "./search-tool.js";
import { handleSymbol } from "./find-symbol-tool.js";
import { getSemanticIndex } from "./semantic-index-registry.js";
import { pathPrefixForDirectory } from "./semantic-index.js";
import { recordDegradation } from "./runtime-health.js";
import { tokenize, compileBm25Corpus, type Bm25Corpus } from "./scoring.js";
import { findCodeFiles } from "./file-discovery.js";
import { LruCache } from "./utils.js";
import type { StructuralSearchMatch } from "./structural-search.js";

// ── Shared grep types ─────────────────────────────────────────────

export interface GrepHit {
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

export interface GrepExecutionResult {
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

/** Subset of GrepToolOptions the cascade needs (avoids a facade import cycle). */
export interface GrepCascadeDeps {
    readonly getWorkspaceRevision?: () => number;
    readonly getSharedContextGraphIfBuilt?: (root: string) => ContextGraph | null;
}

/** Single param object for the smart cascade (P2.3). */
export interface GrepCascadeInput {
    pattern: string;
    searchDir: string;
    gatherK: number;
    contextLines: number;
    caseSensitive: boolean;
    cwd: string;
    signal: AbortSignal | undefined;
    scopedFile?: string;
    fileGlob?: string;
    deps?: GrepCascadeDeps;
    allowExactShortCircuit?: boolean;
}

/** Param object for the literal/regex text engines. */
export interface GrepTextInput {
    pattern: string;
    searchDir: string;
    topK: number;
    contextLines: number;
    caseSensitive: boolean;
    cwd: string;
    signal: AbortSignal | undefined;
    scopedFile?: string;
    fileGlob?: string;
}

// ── Shared path helpers ───────────────────────────────────────────

export function tryCanonical(filePath: string): string {
    try { return realpathSync(filePath); } catch { return filePath; }
}

// Scoped-file predicate: true when a canonical hit path falls outside the
// single-file scope. Local to grep cascade so fallback scoping stays exact.
export function isScopedOut(absPath: string, scopedFile: string | undefined): boolean {
    return scopedFile !== undefined && absPath !== scopedFile;
}

export function relativeToSearchDir(searchDir: string, file: string): string {
    return relative(searchDir, file).replace(/\\/g, "/");
}

interface SymbolMatchLike {
    line: number;
    end_line?: number;
    name: string;
    kind: string;
    body?: string;
}

// Normalize a symbol match into a GrepHit. Engine label/score defaults keep
// Layer-2 semantics (kind from match, score 0); callers override per layer.
export function symbolHitFromMatch(
    absPath: string,
    relFile: string,
    m: SymbolMatchLike,
    overrides?: { kind?: string; score?: number },
): GrepHit {
    const line = m.line;
    return {
        file: absPath,
        relFile,
        line,
        endLine: m.end_line ?? line,
        name: m.name,
        kind: overrides?.kind ?? m.kind,
        snippet: m.body ?? "",
        engines: ["symbol"],
        score: overrides?.score ?? 0,
    };
}

// Dedup insert: first hit wins, preserving discovery order.
export function insertHitOnce(hits: Map<string, GrepHit>, key: string, hit: GrepHit): void {
    if (!hits.has(key)) hits.set(key, hit);
}

// ── Smart cascade ─────────────────────────────────────────────────

export const GREP_MIN_SEMANTIC_SCORE = 0.3;

// ── Smart-cascade helpers (guardrail splits; behavior preserved) ──

type AvailableSemanticIndex = NonNullable<ReturnType<typeof getSemanticIndex>>;

function throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) throw new Error("Operation aborted");
}

interface NoIndexCascadeCtx {
    pattern: string;
    searchDir: string;
    bigK: number;
    contextLines: number;
    caseSensitive: boolean;
    cwd: string;
    signal: AbortSignal | undefined;
    scopedFile: string | undefined;
    fileGlob: string | undefined;
    opts: GrepCascadeDeps | undefined;
    allowExactShortCircuit: boolean;
    root: string;
    degradation: GrepDegradation[];
    exactHits: GrepHit[];
}

interface IndexedCascadeCtx extends NoIndexCascadeCtx {
    semanticIndex: AvailableSemanticIndex;
}

interface SymbolCollectInput {
    pattern: string;
    bigK: number;
    searchDir: string;
    cwd: string;
    signal: AbortSignal | undefined;
    fileGlob: string | undefined;
    scopedFile: string | undefined;
    overrides?: { kind?: string; score?: number };
}

interface GraphExactSymbolInput {
    pattern: string;
    root: string;
    opts: GrepCascadeDeps | undefined;
    cwd: string;
    scopedFile: string | undefined;
}

function tryGraphExactSymbol(
    input: GraphExactSymbolInput,
    hits: Map<string, GrepHit>,
): boolean {
    const { pattern, root, opts, cwd, scopedFile } = input;
    const builtGraph = opts?.getSharedContextGraphIfBuilt?.(root) ?? null;
    if (!builtGraph) return false;
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(pattern)) return false;
    const def = builtGraph.findExactSymbolDef(pattern);
    if (!def) return false;
    const absPath = tryCanonical(def.file);
    if (isScopedOut(absPath, scopedFile)) return false;
    insertHitOnce(hits, `${absPath}:${def.line}`, symbolHitFromMatch(
        absPath,
        relative(cwd, absPath).replace(/\\/g, "/"),
        { line: def.line, name: def.name, kind: def.kind },
        { score: 1 },
    ));
    return true;
}

// Shared handleSymbol fallback for both cascade paths. Callers pass per-path
// overrides: no-index pins kind/score, indexed keeps match defaults for RRF.
async function collectSymbolSearchHits(
    input: SymbolCollectInput,
    hits: Map<string, GrepHit>,
    degradation: GrepDegradation[],
): Promise<boolean> {
    try {
        const symResult = await handleSymbol(input.pattern, input.bigK, false, input.searchDir, input.cwd, input.signal, input.fileGlob);
        for (const m of symResult.matches) {
            const absPath = tryCanonical(resolve(input.cwd, m.relative_path));
            if (isScopedOut(absPath, input.scopedFile)) continue;
            insertHitOnce(hits, `${absPath}:${m.line}`, symbolHitFromMatch(absPath, m.relative_path, m, input.overrides));
        }
        return hits.size > 0;
    } catch {
        degradation.push({ backend: "symbol", code: "symbol_failed" });
        recordDegradation("symbol_failed", "symbol");
        return false;
    }
}

function buildNoIndexEngines(exactCount: number, bm25Size: number, symbolOk: boolean): string[] {
    const engines: string[] = [];
    if (exactCount > 0) engines.push("lexical");
    if (bm25Size > 0) engines.push("bm25");
    if (symbolOk) engines.push("symbol");
    if (engines.length === 0) engines.push("lexical-passthrough");
    return engines;
}

// No-semantic-index path: exact lexical + in-memory BM25 + AST symbol fusion.
async function runNoIndexCascade(
    ctx: NoIndexCascadeCtx,
): Promise<{ hits: GrepHit[]; engines: string[]; degradation?: GrepDegradation[] }> {
    // Exact lexical results already satisfy the requested limit: skip the AST
    // scan and BM25 corpus build. gatherK is >= 2x the requested limit
    // (capped at 200), so this preserves displayed exact results.
    const requestedLimit = Math.max(1, Math.ceil(ctx.bigK / 2));
    if (ctx.allowExactShortCircuit && ctx.exactHits.length >= requestedLimit) {
        return { hits: ctx.exactHits, engines: ["lexical-passthrough"], degradation: ctx.degradation };
    }
    const symbolHits = new Map<string, GrepHit>();
    const graphOk = tryGraphExactSymbol({ pattern: ctx.pattern, root: ctx.root, opts: ctx.opts, cwd: ctx.cwd, scopedFile: ctx.scopedFile }, symbolHits);
    const searchedOk = graphOk || await collectSymbolSearchHits(
        { pattern: ctx.pattern, bigK: ctx.bigK, searchDir: ctx.searchDir, cwd: ctx.cwd, signal: ctx.signal, fileGlob: ctx.fileGlob, scopedFile: ctx.scopedFile, overrides: { kind: "symbol", score: 1 } },
        symbolHits,
        ctx.degradation,
    );
    const bm25Hits = await runFallbackBm25(
        { pattern: ctx.pattern, searchDir: ctx.searchDir, topK: ctx.bigK, contextLines: ctx.contextLines, cwd: ctx.cwd, signal: ctx.signal, scopedFile: ctx.scopedFile, fileGlob: ctx.fileGlob, deps: ctx.opts, root: ctx.root },
    );
    let combined = fuseAndDedup(bm25Hits, symbolHits);
    if (ctx.exactHits.length > 0) combined = prependExactHits(ctx.exactHits, combined);
    return { hits: combined, engines: buildNoIndexEngines(ctx.exactHits.length, bm25Hits.size, searchedOk), degradation: ctx.degradation };
}

async function searchIndexedBm25(
    ctx: IndexedCascadeCtx,
    degradation: GrepDegradation[],
): Promise<Map<string, GrepHit>> {
    const hits = new Map<string, GrepHit>();
    try {
        const prefix = pathPrefixForDirectory(ctx.semanticIndex.root, ctx.scopedFile ?? ctx.searchDir);
        const results = await ctx.semanticIndex.search(ctx.pattern, { topK: ctx.bigK, pathPrefix: prefix, mode: "lexical", fileGlob: ctx.fileGlob });
        for (const r of results) {
            const absPath = tryCanonical(resolve(ctx.semanticIndex.root, r.filePath));
            if (isScopedOut(absPath, ctx.scopedFile)) continue;
            hits.set(`${absPath}:${r.lineStart}`, {
                file: absPath,
                relFile: relative(ctx.cwd, absPath).replace(/\\/g, "/"),
                line: r.lineStart,
                endLine: r.lineEnd,
                name: r.symbolKind,
                kind: "bm25",
                snippet: r.codeSnippet,
                engines: ["bm25"],
                score: r.score,
            });
        }
    } catch {
        degradation.push({ backend: "bm25", code: "bm25_unavailable" });
        recordDegradation("bm25_unavailable", "bm25");
    }
    return hits;
}

// Semantic retry only fires on genuine zero fused results. Mutates engines.
async function searchSemanticRetry(ctx: IndexedCascadeCtx, engines: string[]): Promise<GrepHit[]> {
    if (!ctx.semanticIndex?.isAvailable()) return [];
    try {
        const prefix = pathPrefixForDirectory(ctx.semanticIndex.root, ctx.scopedFile ?? ctx.searchDir);
        const results = await ctx.semanticIndex.search(ctx.pattern, {
            topK: ctx.bigK * 3,
            pathPrefix: prefix,
            mode: "semantic",
            minScore: GREP_MIN_SEMANTIC_SCORE,
            fileGlob: ctx.fileGlob,
        });
        const retryHits = new Map<string, GrepHit>();
        for (const r of results) {
            const absPath = tryCanonical(resolve(ctx.semanticIndex.root, r.filePath));
            if (isScopedOut(absPath, ctx.scopedFile)) continue;
            retryHits.set(`${absPath}:${r.lineStart}`, {
                file: absPath,
                relFile: relative(ctx.cwd, absPath).replace(/\\/g, "/"),
                line: r.lineStart,
                endLine: r.lineEnd,
                name: r.symbolKind,
                kind: "semantic",
                snippet: r.codeSnippet,
                engines: ["semantic"],
                score: r.score,
            });
        }
        if (retryHits.size === 0) return [];
        engines.push("semantic");
        return [...retryHits.values()];
    } catch {
        ctx.degradation.push({ backend: "semantic", code: "semantic_failed" });
        recordDegradation("semantic_failed", "semantic");
        return [];
    }
}

async function runIndexedCascade(
    ctx: IndexedCascadeCtx,
): Promise<{ hits: GrepHit[]; engines: string[]; degradation?: GrepDegradation[] }> {
    const bm25Hits = await searchIndexedBm25(ctx, ctx.degradation);
    const symbolHits = new Map<string, GrepHit>();
    const engines: string[] = [];
    if (bm25Hits.size > 0) engines.push("bm25");
    throwIfAborted(ctx.signal);
    const symbolOk = await collectSymbolSearchHits(
        { pattern: ctx.pattern, bigK: ctx.bigK, searchDir: ctx.searchDir, cwd: ctx.cwd, signal: ctx.signal, fileGlob: ctx.fileGlob, scopedFile: ctx.scopedFile },
        symbolHits,
        ctx.degradation,
    );
    if (symbolOk) engines.push("symbol");
    throwIfAborted(ctx.signal);
    let fused = fuseAndDedup(bm25Hits, symbolHits);
    if (ctx.exactHits.length > 0) {
        if (fused.length === 0) {
            return { hits: ctx.exactHits, engines: ["lexical-passthrough"], degradation: ctx.degradation };
        }
        fused = prependExactHits(ctx.exactHits, fused);
        engines.unshift("lexical");
    }
    if (fused.length === 0) fused = await searchSemanticRetry(ctx, engines);
    throwIfAborted(ctx.signal);
    if (fused.length === 0) {
        // Genuine zero results are NOT a backend failure — no degradation code.
        return { hits: [], engines: ["lexical-passthrough"], degradation: ctx.degradation };
    }
    // Fill snippet for hits missing one (symbol hits often lack snippet).
    await enrichSnippets(fused, ctx.contextLines);
    return { hits: fused, engines, degradation: ctx.degradation };
}

export async function runSmartCascade(
    input: GrepCascadeInput,
): Promise<{ hits: GrepHit[]; engines: string[]; degradation?: GrepDegradation[] }> {
    const {
        pattern,
        searchDir,
        gatherK,
        contextLines,
        caseSensitive,
        cwd,
        signal,
        scopedFile,
        fileGlob,
        deps: opts,
        allowExactShortCircuit = true,
    } = input;
    const bigK = gatherK;
    const root = canonicalizeWorkspaceRoot(cwd);
    const degradation: GrepDegradation[] = [];
    const semanticIndex = getSemanticIndex(searchDir);
    const exactResult = await runLiteralGrep(
        { pattern, searchDir, topK: bigK, contextLines, caseSensitive, cwd, signal, scopedFile, fileGlob },
    );
    if (!semanticIndex?.isAvailable()) {
        degradation.push({ backend: "semantic", code: "index_unavailable" });
        recordDegradation("index_unavailable", "semantic");
        return runNoIndexCascade({
            pattern, searchDir, bigK, contextLines, caseSensitive, cwd, signal,
            scopedFile, fileGlob, opts, allowExactShortCircuit, root,
            degradation, exactHits: exactResult.hits,
        });
    }

    return runIndexedCascade({
        pattern, searchDir, bigK, contextLines, caseSensitive, cwd, signal,
        scopedFile, fileGlob, opts, allowExactShortCircuit, root,
        degradation, semanticIndex, exactHits: exactResult.hits,
    });
}

// ── Literal grep passthrough ────────────────────────────────────────

export async function runLiteralGrep(
    input: GrepTextInput,
): Promise<{ hits: GrepHit[]; engines: string[]; degradation?: GrepDegradation[] }> {
    return runTextGrep({ ...input, matchMode: "literal" });
}

export async function runRegexGrep(
    input: GrepTextInput,
): Promise<{ hits: GrepHit[]; engines: string[]; degradation?: GrepDegradation[] }> {
    return runTextGrep({ ...input, matchMode: "regex" });
}

async function runTextGrep(
    input: GrepTextInput & { matchMode: "literal" | "regex" },
): Promise<{ hits: GrepHit[]; engines: string[]; degradation?: GrepDegradation[] }> {
    const { pattern, matchMode, searchDir, topK, contextLines, caseSensitive, cwd, signal, scopedFile, fileGlob } = input;
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

export function prependExactHits(exactHits: GrepHit[], rankedHits: GrepHit[]): GrepHit[] {
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

function unique<T>(items: T[]): T[] {
    return [...new Set(items)];
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
        files = files.filter((f) => minimatch(relativeToSearchDir(searchDir, f), fileGlob));
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
export interface GetSearchCorpusInput {
    searchDir: string;
    scopedFile: string | undefined;
    cwd: string;
    fileGlob: string | undefined;
    root: string;
    getWorkspaceRevision: (() => number) | undefined;
}

export async function getSearchCorpus(
    input: GetSearchCorpusInput,
): Promise<{ entry: CorpusEntry; cached: boolean }> {
    const { searchDir, scopedFile, cwd, fileGlob, root, getWorkspaceRevision } = input;
    // Uncacheable scope: single-file target, no revision source, or a search
    // that leaves the tracked workspace (revision doesn't reflect it).
    const cacheable =
        !scopedFile &&
        getWorkspaceRevision !== undefined &&
        isWithinWorkspace(root, searchDir);
    if (!cacheable) {
        return { entry: await buildCorpus(searchDir, scopedFile, fileGlob), cached: false };
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
            pending = buildCorpus(searchDir, scopedFile, fileGlob).then((entry) => {
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
    return { entry: await buildCorpus(searchDir, scopedFile, fileGlob), cached: false };
}

export interface FallbackBm25Input {
    pattern: string;
    searchDir: string;
    topK: number;
    contextLines: number;
    cwd: string;
    signal: AbortSignal | undefined;
    scopedFile: string | undefined;
    fileGlob: string | undefined;
    deps: GrepCascadeDeps | undefined;
    root: string;
}

function findBestLine(lines: string[], queryTokens: string[]): number {
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
    return bestLine;
}

function formatSnippetLines(lines: string[], centerLine: number, contextLines: number): string {
    const start = Math.max(0, centerLine - 1 - contextLines);
    const end = Math.min(lines.length - 1, centerLine - 1 + contextLines);
    const snippetLines: string[] = [];
    for (let i = start; i <= end; i++) {
        snippetLines.push(`    ${String(i + 1).padStart(4, " ")} | ${lines[i] ?? ""}`);
    }
    return snippetLines.join("\n");
}

function rankCorpusFiles(entry: CorpusEntry, pattern: string): Array<{ file: string; score: number; content: string }> {
    const { fileList, contents, corpus } = entry;
    const scores = corpus.score(pattern);
    const ranked: Array<{ file: string; score: number; content: string }> = [];
    for (let i = 0; i < fileList.length; i++) {
        const score = scores[i] ?? 0;
        if (score > 0) ranked.push({ file: fileList[i]!, score, content: contents[i]! });
    }
    ranked.sort((a, b) => b.score - a.score);
    return ranked;
}

export async function runFallbackBm25(
    input: FallbackBm25Input,
): Promise<Map<string, GrepHit>> {
    const { pattern, searchDir, topK, contextLines, cwd, signal, scopedFile, fileGlob, deps: opts, root } = input;
    const hits = new Map<string, GrepHit>();
    if (signal?.aborted) throw new Error("Operation aborted");

    const { entry } = await getSearchCorpus(
        { searchDir, scopedFile, cwd, fileGlob, root, getWorkspaceRevision: opts?.getWorkspaceRevision },
    );
    // Cancellation is honored around (not inside) the shared corpus build.
    if (signal?.aborted) throw new Error("Operation aborted");


    if (entry.fileList.length === 0) return hits;
    const queryTokens = tokenize(pattern);
    const ranked = rankCorpusFiles(entry, pattern);

    for (const item of ranked.slice(0, topK)) {
        const absPath = tryCanonical(item.file);
        const lines = item.content.split(/\r?\n/);
        const bestLine = findBestLine(lines, queryTokens);
        hits.set(`${absPath}:${bestLine}`, {
            file: absPath,
            relFile: relative(cwd, absPath).replace(/\\/g, "/"),
            line: bestLine,
            endLine: bestLine,
            name: "(bm25 match)",
            kind: "bm25",
            snippet: formatSnippetLines(lines, bestLine, contextLines),
            engines: ["bm25"],
            score: item.score,
        });
    }
    return hits;
}

export function fuseAndDedup(
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

export async function enrichSnippets(hits: GrepHit[], contextLines: number): Promise<void> {
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
    await getSearchCorpus({ searchDir: src, scopedFile: undefined, cwd: dir, fileGlob: undefined, root: dir, getWorkspaceRevision: getRevision });
    const coldMs = Date.now() - t0;
    const coldBuilds = _bm25CorpusCacheForTests().builds;
    const t1 = Date.now();
    const warm = await getSearchCorpus({ searchDir: src, scopedFile: undefined, cwd: dir, fileGlob: undefined, root: dir, getWorkspaceRevision: getRevision });
    const warmMs = Date.now() - t1;
    const warmBuilds = _bm25CorpusCacheForTests().builds;
    fs.rmSync(dir, { recursive: true, force: true });
    return { coldMs, warmMs, coldBuilds, warmBuilds, cachedWarm: warm.cached };
}
