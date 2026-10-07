/**
 * Find candidate discovery, glob matching, and natural-language fusion.
 *
 * Discovery flows through discoverFiles (ignore-aware) with a traversal
 * budget: on timeout the partial file list is kept and the caller adds
 * a steering notice. Directories are derived from discovered files.
 * Git-dirty state comes from a single best-effort `git status` call.
 */
import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { basename, dirname, relative } from "node:path";
import { scorePathByQuery } from "./resolver.js";
import { scoreFuzzyPath } from "./fuzzy-path-score.js";
import { FIND_TRAVERSAL_BUDGET_MS } from "./find-modes.js";

export interface FindDiscoveredFile {
    absPath: string;
    relPath: string;
    mtimeMs: number;
    dirty: boolean;
}

export interface FindDiscoveryResult {
    files: FindDiscoveredFile[];
    /** Workspace-relative directory paths (posix) derived from discovered files. */
    directories: string[];
    timedOut: boolean;
    dirtyFiles: Set<string>;
}

export interface FindDiscoveryDeps {
    /** Injectable walker for tests; default is discoverFiles with a "text" profile. */
    discover?: (root: string, signal?: AbortSignal) => Promise<string[]>;
    /** Injectable git reader for tests; default shells out once per call. */
    readGitDirty?: (root: string) => Promise<Set<string>>;
    traversalBudgetMs?: number;
    discoveryCap?: number;
    sleep?: (ms: number) => Promise<void>;
    /** Caller abort: aborts the traversal walker alongside the budget timer. */
    signal?: AbortSignal;
}

function defaultSleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function defaultDiscover(root: string, signal?: AbortSignal): Promise<string[]> {
    const { discoverFiles } = await import("../file-discovery.js");
    return (await discoverFiles(root, "text", 10_000, signal)).files;
}

function parsePorcelain(output: string): Set<string> {
    const dirty = new Set<string>();
    for (const line of output.split("\n")) {
        if (line.length < 4) continue;
        if (line.slice(0, 2).trim().length === 0) continue;
        let path = line.slice(3).trim().replace(/^"|"$/g, "");
        const arrow = path.indexOf(" -> ");
        if (arrow >= 0) path = path.slice(arrow + 4);
        if (path.length > 0) dirty.add(path);
    }
    return dirty;
}

export function defaultReadGitDirty(root: string): Promise<Set<string>> {
    return new Promise((resolve) => {
        execFile("git", ["status", "--porcelain=v1", "--untracked-files=no"], { cwd: root, timeout: 5_000 }, (error, stdout) => {
            if (error) {
                resolve(new Set());
                return;
            }
            try {
                resolve(parsePorcelain(String(stdout)));
            } catch {
                resolve(new Set());
            }
        });
    });
}

function toPosix(value: string): string {
    return value.replace(/\\/g, "/");
}

function mtimeOf(absPath: string): number {
    try {
        return statSync(absPath).mtimeMs;
    } catch {
        return 0;
    }
}

function collectAncestorDirs(rel: string, dirSet: Set<string>): void {
    let dir = dirname(rel);
    while (dir !== "." && dir !== "/" && dir !== "") {
        dirSet.add(toPosix(dir));
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
}

function buildFileEntries(root: string, absFiles: string[], cap: number): { files: FindDiscoveredFile[]; dirSet: Set<string> } {
    const files: FindDiscoveredFile[] = [];
    const dirSet = new Set<string>();
    for (const abs of absFiles.slice(0, cap)) {
        const rel = toPosix(relative(root, abs));
        if (rel === "" || rel.startsWith("..")) continue;
        files.push({ absPath: abs, relPath: rel, mtimeMs: mtimeOf(abs), dirty: false });
        collectAncestorDirs(rel, dirSet);
    }
    return { files, dirSet };
}

async function readDirtyFiles(root: string, readGitDirty: (root: string) => Promise<Set<string>>): Promise<Set<string>> {
    try {
        return await readGitDirty(root);
    } catch {
        return new Set();
    }
}

/**
 * Discover files under root with a traversal budget. The budget abort
 * lets the walker return its partial list; timedOut flags the notice.
 */
export async function discoverFindCandidates(
    root: string,
    deps: FindDiscoveryDeps = {},
): Promise<FindDiscoveryResult> {
    const discover = deps.discover ?? defaultDiscover;
    const budget = deps.traversalBudgetMs ?? FIND_TRAVERSAL_BUDGET_MS;
    const sleep = deps.sleep ?? defaultSleep;
    const controller = new AbortController();
    let timedOut = false;
    const parentSignal = deps.signal;
    if (parentSignal?.aborted) throw new Error("Operation aborted");
    const onParentAbort = (): void => controller.abort();
    parentSignal?.addEventListener("abort", onParentAbort, { once: true });
    if (budget > 0) {
        void sleep(budget).then(() => {
            timedOut = true;
            controller.abort();
        }).catch(() => undefined);
    }
    let absFiles: string[] = [];
    try {
        absFiles = await discover(root, controller.signal);
    } catch {
        absFiles = [];
    } finally {
        parentSignal?.removeEventListener("abort", onParentAbort);
    }
    const { files, dirSet } = buildFileEntries(root, absFiles, deps.discoveryCap ?? 10_000);
    const dirtyFiles = await readDirtyFiles(root, deps.readGitDirty ?? defaultReadGitDirty);
    for (const file of files) {
        if (dirtyFiles.has(file.relPath)) file.dirty = true;
    }
    return { files, directories: [...dirSet].sort(), timedOut, dirtyFiles };
}

// ── Glob matching (pi-builtin compatible) ───────────────────────────

export interface MinimatchLike {
    (path: string, pattern: string, options?: { dot?: boolean }): boolean;
}

async function loadMinimatch(): Promise<MinimatchLike> {
    const mod = await import("minimatch") as unknown as {
        minimatch?: MinimatchLike;
        default?: MinimatchLike;
    };
    const fn = mod.minimatch ?? mod.default;
    if (typeof fn !== "function") throw new Error("minimatch unavailable");
    return fn;
}

/**
 * Builtin-compatible glob match: a pattern without "/" matches the
 * basename; a pattern with "/" matches the full relative path (with
 * an implicit "**\/" prefix, mirroring fd --full-path behaviour).
 * Hidden files are matchable (dot:true).
 */
export async function matchFindGlob(
    pattern: string,
    relPath: string,
    minimatch?: MinimatchLike,
): Promise<boolean> {
    const match = minimatch ?? await loadMinimatch();
    if (!pattern.includes("/")) {
        return match(basename(relPath), pattern, { dot: true });
    }
    if (match(relPath, pattern, { dot: true })) return true;
    if (!pattern.startsWith("/") && !pattern.startsWith("**/") && pattern !== "**") {
        return match(relPath, `**/${pattern}`, { dot: true });
    }
    return false;
}

/**
 * Split discovered files + directories into glob matches.
 */
export async function matchGlobCandidates(
    pattern: string,
    discovered: FindDiscoveryResult,
    minimatch?: MinimatchLike,
): Promise<{ files: FindDiscoveredFile[]; directories: string[] }> {
    const match = minimatch ?? await loadMinimatch();
    const files: FindDiscoveredFile[] = [];
    for (const file of discovered.files) {
        if (await matchFindGlob(pattern, file.relPath, match)) files.push(file);
    }
    const directories: string[] = [];
    for (const dir of discovered.directories) {
        if (await matchFindGlob(pattern, dir, match)) directories.push(dir);
    }
    return { files, directories };
}

/** Glob ranking: git-dirty first, then mtime desc, then path. */
export function sortGlobFiles(files: FindDiscoveredFile[]): FindDiscoveredFile[] {
    return [...files].sort((a, b) => {
        if (a.dirty !== b.dirty) return a.dirty ? -1 : 1;
        if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs;
        return a.relPath.localeCompare(b.relPath);
    });
}

// ── Fuzzy matching ──────────────────────────────────────────────────

export interface FuzzyScoredFile extends FindDiscoveredFile {
    fuzzyScore: number;
}

/** Fuzzy ranking: score desc, then shorter path, then mtime desc. */
export function matchFuzzyCandidates(
    pattern: string,
    discovered: FindDiscoveryResult,
): { files: FuzzyScoredFile[]; directories: Array<{ relPath: string; fuzzyScore: number }> } {
    const files: FuzzyScoredFile[] = [];
    for (const file of discovered.files) {
        const fuzzyScore = scoreFuzzyPath(pattern, file.relPath);
        if (fuzzyScore >= 0) files.push({ ...file, fuzzyScore });
    }
    files.sort((a, b) => {
        if (b.fuzzyScore !== a.fuzzyScore) return b.fuzzyScore - a.fuzzyScore;
        if (a.relPath.length !== b.relPath.length) return a.relPath.length - b.relPath.length;
        return b.mtimeMs - a.mtimeMs;
    });
    const directories: Array<{ relPath: string; fuzzyScore: number }> = [];
    for (const dir of discovered.directories) {
        const fuzzyScore = scoreFuzzyPath(pattern, dir);
        if (fuzzyScore >= 0) directories.push({ relPath: dir, fuzzyScore });
    }
    directories.sort((a, b) => {
        if (b.fuzzyScore !== a.fuzzyScore) return b.fuzzyScore - a.fuzzyScore;
        return a.relPath.length - b.relPath.length;
    });
    return { files, directories };
}

// ── Natural-language fusion (unjudged, Phase A) ─────────────────────

export interface NlDeps {
    semanticFileScores?: (root: string, query: string) => Promise<Map<string, number>>;
    symbolFileRanks?: (root: string, query: string) => Promise<string[]> | string[];
    pagerankFileRanks?: (root: string) => Promise<string[]> | string[];
}

export interface FusedNlEntry {
    relPath: string;
    fusedScore: number;
}

const NL_RRF_K = 60;
const NL_CANDIDATE_CAP = 128;

function reciprocalRankFuse(rankedLists: string[][]): Map<string, number> {
    const scores = new Map<string, number>();
    for (const list of rankedLists) {
        const seen = new Set<string>();
        list.forEach((relPath, index) => {
            if (seen.has(relPath)) return;
            seen.add(relPath);
            scores.set(relPath, (scores.get(relPath) ?? 0) + 1 / (NL_RRF_K + index + 1));
        });
    }
    return scores;
}

function rankByScoreDesc(scores: Map<string, number>): string[] {
    return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([relPath]) => relPath);
}

function identifierTokens(query: string): string[] {
    const tokens = query.split(/[^A-Za-z0-9_$]+/).filter((token) => token.length >= 3);
    return [...new Set(tokens)];
}

async function defaultSemanticFileScores(root: string, query: string): Promise<Map<string, number>> {
    const scores = new Map<string, number>();
    try {
        const { getSemanticIndex } = await import("../indexing/semantic-index-registry.js");
        const index = getSemanticIndex(root);
        // Never triggers a build: only an already-available index is read.
        if (!index?.isAvailable()) return scores;
        const results = await index.search(query, { topK: NL_CANDIDATE_CAP });
        for (const result of results) {
            const rel = toPosix(result.filePath);
            const prior = scores.get(rel) ?? Number.NEGATIVE_INFINITY;
            if (result.score > prior) scores.set(rel, result.score);
        }
    } catch {
        // Semantic backend missing/unavailable: path + tags + graph still fuse.
    }
    return scores;
}

export interface BuiltGraphPeek {
    findExactSymbolDef: (name: string) => { file: string } | null;
    getProvenanceEdges: () => Array<{ from: string; to: string }>;
}

async function defaultSymbolFileRanks(root: string, query: string): Promise<string[]> {
    try {
        const { getSharedContextGraphIfBuilt } = await import("../graph/shared-context-graph.js");
        const graph = getSharedContextGraphIfBuilt(root) as unknown as BuiltGraphPeek | null;
        if (!graph) return [];
        const ranked: string[] = [];
        for (const token of identifierTokens(query)) {
            try {
                const def = graph.findExactSymbolDef(token);
                if (def) {
                    const rel = toPosix(relative(root, def.file));
                    if (rel !== "" && !rel.startsWith("..") && !ranked.includes(rel)) ranked.push(rel);
                }
            } catch {
                continue;
            }
        }
        return ranked;
    } catch {
        return [];
    }
}

async function defaultPagerankFileRanks(root: string): Promise<string[]> {
    try {
        const { getSharedContextGraphIfBuilt } = await import("../graph/shared-context-graph.js");
        const graph = getSharedContextGraphIfBuilt(root) as unknown as BuiltGraphPeek | null;
        if (!graph) return [];
        // Weak prior from already-built import adjacency (in+out degree).
        const degree = new Map<string, number>();
        for (const edge of graph.getProvenanceEdges()) {
            degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
            degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
        }
        const rels: string[] = [];
        for (const [absPath] of [...degree.entries()].sort((a, b) => b[1] - a[1])) {
            const rel = toPosix(relative(root, absPath));
            if (rel !== "" && !rel.startsWith("..")) rels.push(rel);
        }
        return rels;
    } catch {
        return [];
    }
}

/**
 * Fuse candidate signals by reciprocal rank (k=60): token overlap over
 * discovered paths always runs; the semantic file aggregate, cached
 * symbol names, and the PageRank prior only contribute when their
 * backends are already available (never built on demand).
 */
export async function fuseNaturalLanguageCandidates(
    query: string,
    files: FindDiscoveredFile[],
    root: string,
    deps: NlDeps = {},
): Promise<FusedNlEntry[]> {
    const pathScores = new Map<string, number>();
    for (const file of files) {
        const score = scorePathByQuery(file.relPath, query);
        if (score > 0) pathScores.set(file.relPath, score);
    }
    const semanticScores = await (deps.semanticFileScores?.(root, query) ?? defaultSemanticFileScores(root, query));
    const symbolRanked = await (deps.symbolFileRanks?.(root, query) ?? defaultSymbolFileRanks(root, query));
    const pagerankRanked = await (deps.pagerankFileRanks?.(root) ?? defaultPagerankFileRanks(root));
    const fused = reciprocalRankFuse([
        rankByScoreDesc(pathScores),
        rankByScoreDesc(semanticScores),
        symbolRanked,
        pagerankRanked,
    ].filter((list) => list.length > 0));
    return [...fused.entries()]
        .map(([relPath, fusedScore]) => ({ relPath, fusedScore }))
        .sort((a, b) => b.fusedScore - a.fusedScore)
        .slice(0, NL_CANDIDATE_CAP);
}

export interface NlFinalEntry {
    relPath: string;
    /** Fused score normalized to (0, 1] against the top candidate. */
    score: number;
}

/**
 * Phase-B seam: the judge adjudication step slots in between candidate
 * fusion and output — fused entries in, kept entries out. Phase A
 * returns the fused ranking directly, labelled unjudged.
 */
export function finalizeNaturalLanguageResults(
    fused: FusedNlEntry[],
    limit: number,
): NlFinalEntry[] {
    const top = fused.length > 0 ? fused[0]!.fusedScore : 1;
    const scale = top > 0 ? top : 1;
    return fused.slice(0, Math.max(0, limit)).map((entry) => ({
        relPath: entry.relPath,
        score: Math.round((entry.fusedScore / scale) * 100) / 100,
    }));
}
