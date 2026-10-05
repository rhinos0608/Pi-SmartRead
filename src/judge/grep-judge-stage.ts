/**
 * Grep judgment stage (WS1) — optional calibrated relevance filter on top of
 * the smart cascade. Never replaces retrieval; only filters fused candidates
 * for natural-language queries when judging is enabled.
 *
 * Spec: docs/plans/2026-10-05-grep-judge-design.md.
 *
 * Seam note (J2 owns runtime wiring): Pi/MCP startup code injects a
 * `GrepJudgeProvider` into the grep tool options. The stage calls
 * `provider.resolveJudge()` (which owns settings-file/env/auth-store reads
 * and sidecar lifecycle) and `provider.getGraphIfBuilt()` (sync peek only —
 * the stage never triggers a graph build). No Pi `ExtensionContext`, sidecar,
 * or settings-file access happens here; if that wiring is absent the caller
 * simply omits the provider and grep behaves exactly as before.
 */

import { readFile } from "node:fs/promises";
import type { ContextGraph } from "../context-graph.js";
import type { GrepHit } from "../search/grep-cascade.js";
import { resolveGrepUnitMode } from "../search/grep-units.js";
import { isNaturalLanguageQuery } from "../search/query-intent.js";
import type { ResolveJudgeResult } from "./judge-resolver.js";
import { existsQuestion, unitRelevanceQuestion } from "./questions.js";
import { JudgeError, type Judge } from "./types.js";

// ── Thresholds / caps (spec §Decisions on results, §Units, §Pointers) ──

/** Keep units with p >= τ. Cloud multi-run eval selects 0.40 as the recall-biased operating point. */
export const GREP_JUDGE_THRESHOLD = 0.40;
/** Env override for the keep threshold (e2e threshold sweep). Non-network knob. */
export const GREP_JUDGE_THRESHOLD_ENV_VAR = "PI_SMARTREAD_JUDGE_GREP_THRESHOLD";

/**
 * Resolve the effective keep threshold: a finite value strictly inside
 * (0, 1) from the environment wins; anything absent or invalid falls back
 * to GREP_JUDGE_THRESHOLD (fail-closed).
 */
export function resolveGrepJudgeThreshold(env: Record<string, string | undefined> = process.env): number {
    const raw = env[GREP_JUDGE_THRESHOLD_ENV_VAR];
    if (raw === undefined || raw.trim() === "") return GREP_JUDGE_THRESHOLD;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 1) return GREP_JUDGE_THRESHOLD;
    return parsed;
}
/** Abstain when nothing passes and `exists` p < this. */
export const GREP_JUDGE_EXISTS_ABSENT = 0.35;
/** Pointer wave keep threshold (signature-only cards). */
export const GREP_JUDGE_POINTER_THRESHOLD = 0.45;
/** Judge at most this many units per query (top of the fused order). */
export const GREP_JUDGE_MAX_UNITS = 40;
/** Graph-neighbour pointer candidates per query. */
export const GREP_JUDGE_MAX_POINTER_CANDIDATES = 12;
/** Emitted `next:` pointers per query. */
export const GREP_JUDGE_MAX_POINTERS = 3;
/** Per-unit text cap (characters). */
export const GREP_JUDGE_UNIT_MAX_CHARS = 3500;

// ── Provider seam (injected by J2 runtime wiring) ─────────────────────

/** Sync-only view of an already-built graph used for pointer candidates. */
export type GrepJudgeGraphPeek = Pick<ContextGraph, "getMutationNeighbours" | "getImportDependents">;

export interface GrepJudgeProvider {
    /** Resolve the active backend. `{ unavailable: "aborted" }` means mode off. */
    resolveJudge(workspaceRoot?: string, runtimeContext?: unknown): Promise<ResolveJudgeResult>;
    /** Sync peek at an already-built graph; null when not built. Never builds. */
    getGraphIfBuilt?(root: string): GrepJudgeGraphPeek | null;
    /** File reader for unit text; defaults to node:fs. */
    readFile?(path: string): Promise<string>;
}

// ── Types ─────────────────────────────────────────────────────────────

export interface GrepJudgeStageInput {
    query: string;
    /** Fused/deduped hits in fused-rank order. */
    hits: GrepHit[];
    contextLines: number;
    literal: boolean;
    regex: boolean;
    structural: boolean;
    /** Workspace root anchor for the graph peek and per-workspace judge cache. */
    cwd: string;
    /** Pi tool context used only to read the OpenRouter auth-store key. */
    runtimeContext?: unknown;
    provider: GrepJudgeProvider;
    /**
     * Keep-threshold override. Absent → resolveGrepJudgeThreshold()
     * (env override, fail-closed to GREP_JUDGE_THRESHOLD).
     */
    threshold?: number;
}

export interface JudgedGrepHit extends GrepHit {
    judgeP?: number;
}

export interface GrepJudgePointer {
    path: string;
    line: number;
    symbol: string;
    p: number;
}

export interface GrepJudgeDetails {
    backend: "cloud" | "local";
    model: string;
    judged: number;
    kept: number;
    belowThreshold: number;
    threshold: number;
    cacheHits: number;
    costUsd?: number;
    abstained: boolean;
    pointers: GrepJudgePointer[];
    hits: Array<{ path: string; line: number; endLine: number; p: number }>;
    /** Active BM25 result-unit mode (D31 seam; additive for reports). */
    unitMode: "anchor" | "symbol";
}

export interface GrepJudgeStageResult {
    /** True when the judge ran and filtered. False = bypass or failure. */
    judged: boolean;
    /** Hits to render / build evidence from. */
    hits: JudgedGrepHit[];
    /** Full unjudged candidate list (for abstain pointers / failure fallback). */
    unjudged: GrepHit[];
    judge?: GrepJudgeDetails;
    /** Stable non-secret failure code; caller appends to the degradation line. */
    degradation?: { backend: "judge"; code: string };
    abstained: boolean;
    abstainMessage?: string;
}

// ── Gate ──────────────────────────────────────────────────────────────

export interface GrepJudgeGateInput {
    pattern: string;
    literal: boolean;
    regex: boolean;
    structural: boolean;
    hitCount: number;
}

/**
 * Judge only the smart-cascade path for natural-language queries with
 * >= 2 candidates. Everything else bypasses completely (byte-identical).
 */
export function shouldJudgeGrep(input: GrepJudgeGateInput): boolean {
    if (input.literal || input.regex || input.structural) return false;
    if (input.hitCount < 2) return false;
    return isNaturalLanguageQuery(input.pattern);
}

// ── Stage ─────────────────────────────────────────────────────────────

export async function runGrepJudgeStage(input: GrepJudgeStageInput): Promise<GrepJudgeStageResult> {
    const idle = (hits: GrepHit[]): GrepJudgeStageResult => ({
        judged: false,
        hits,
        unjudged: hits,
        abstained: false,
    });
    if (!shouldJudgeGrep({
        pattern: input.query,
        literal: input.literal,
        regex: input.regex,
        structural: input.structural,
        hitCount: input.hits.length,
    })) {
        return idle(input.hits);
    }

    let resolved: ResolveJudgeResult;
    try {
        resolved = await input.provider.resolveJudge(input.cwd, input.runtimeContext);
    } catch (err) {
        return { ...idle(input.hits), degradation: { backend: "judge", code: judgeCodeOf(err) } };
    }
    if (!("judge" in resolved)) {
        // Mode off ("aborted") bypasses with zero output change — no
        // degradation line, no details. Other unavailable codes (no_key,
        // sidecar_unavailable, …) keep unjudged results plus a stable code.
        if (resolved.unavailable === "aborted") return idle(input.hits);
        return { ...idle(input.hits), degradation: { backend: "judge", code: resolved.unavailable } };
    }
    const judge = resolved.judge;
    const threshold = input.threshold ?? resolveGrepJudgeThreshold();

    const units = await buildJudgeUnits(input.hits.slice(0, GREP_JUDGE_MAX_UNITS), input.contextLines, input.provider.readFile ?? defaultReadFile);
    if (units.length === 0) return idle(input.hits);

    let unitProbs: Map<string, number>;
    let cacheHits = 0;
    let costUsd: number | undefined;
    try {
        const unitResult = await judge.judgeNouls({
            shared: { query: input.query },
            items: units.map((u) => ({
                id: u.id,
                state: { path: u.path, symbol: u.symbol, text: u.text },
                question: (ref: string) => unitRelevanceQuestion(input.query, ref),
            })),
        });
        unitProbs = unitResult.p;
        cacheHits += unitResult.cacheHits ?? 0;
        costUsd = addCost(costUsd, unitResult.usage.costUsd);
    } catch (err) {
        return { ...idle(input.hits), degradation: { backend: "judge", code: judgeCodeOf(err) } };
    }

    // Per-query existence noul. A failed exists check must not fail grep:
    // abstention simply stays disabled (existsP undefined).
    let existsP: number | undefined;
    try {
        const existsResult = await judge.judgeNouls({
            shared: { query: input.query },
            items: [{
                id: "exists",
                state: { candidateCount: units.length },
                question: () => existsQuestion(input.query),
            }],
        });
        existsP = existsResult.p.get("exists");
        cacheHits += existsResult.cacheHits ?? 0;
        costUsd = addCost(costUsd, existsResult.usage.costUsd);
    } catch { existsP = undefined; }

    const ranked = units
        .map((u, fusedRank) => ({ unit: u, p: unitProbs.get(u.id) ?? 0, fusedRank }))
        .filter((r) => r.p >= threshold)
        .sort((a, b) => b.p - a.p || a.fusedRank - b.fusedRank);
    const merged = mergeKeptRanges(ranked.map((r) => ({ hit: r.unit.hit, p: r.p })));
    const belowThreshold = units.length - new Set(ranked.map((r) => r.unit.id)).size;

    if (merged.length === 0 && existsP !== undefined && existsP < GREP_JUDGE_EXISTS_ABSENT) {
        return {
            judged: true,
            hits: [],
            unjudged: input.hits,
            abstained: true,
            abstainMessage:
                `no confident match for "${input.query}" (judge ${judge.info.backend}, τ ${threshold.toFixed(2)})`,
            judge: {
                backend: judge.info.backend,
                model: judge.info.model,
                judged: units.length,
                kept: 0,
                belowThreshold: units.length,
                threshold,
                cacheHits,
                ...(costUsd !== undefined ? { costUsd } : {}),
                abstained: true,
                pointers: [],
                hits: [],
                unitMode: resolveGrepUnitMode(),
            },
        };
    }

    const judgedHits: JudgedGrepHit[] = merged.map((m) => ({ ...m.hit, judgeP: m.p }));
    const pointers = await judgePointers(judge, input, judgedHits, input.hits);
    if (pointers.result) {
        cacheHits += pointers.cacheHits;
        costUsd = addCost(costUsd, pointers.costUsd);
    }
    return {
        judged: true,
        hits: judgedHits,
        unjudged: input.hits,
        abstained: false,
        judge: {
            backend: judge.info.backend,
            model: judge.info.model,
            judged: units.length,
            kept: judgedHits.length,
            belowThreshold,
            threshold,
            cacheHits,
            ...(costUsd !== undefined ? { costUsd } : {}),
            abstained: false,
            pointers: pointers.pointers,
            hits: judgedHits.map((h) => ({ path: h.relFile, line: h.line, endLine: h.endLine, p: h.judgeP ?? 0 })),
            unitMode: resolveGrepUnitMode(),
        },
    };
}

function judgeCodeOf(err: unknown): string {
    if (err instanceof JudgeError) return err.code;
    return "network";
}

function addCost(a: number | undefined, b: number | undefined): number | undefined {
    if (a === undefined) return b;
    if (b === undefined) return a;
    return a + b;
}

async function defaultReadFile(path: string): Promise<string> {
    return readFile(path, "utf-8");
}

// ── Units ─────────────────────────────────────────────────────────────

interface JudgeUnit {
    id: string;
    hit: GrepHit;
    path: string;
    symbol: string;
    text: string;
}

async function buildJudgeUnits(
    hits: GrepHit[],
    contextLines: number,
    read: (path: string) => Promise<string>,
): Promise<JudgeUnit[]> {
    const seen = new Set<string>();
    const units: JudgeUnit[] = [];
    for (let i = 0; i < hits.length; i++) {
        const hit = hits[i]!;
        const key = `${hit.file}:${hit.line}-${hit.endLine}`;
        if (seen.has(key)) continue;
        seen.add(key);
        units.push({
            id: `u${i}`,
            hit,
            path: hit.relFile,
            symbol: hit.name || "(text match)",
            text: await buildUnitText(hit, contextLines, read),
        });
    }
    return units;
}

async function buildUnitText(
    hit: GrepHit,
    contextLines: number,
    read: (path: string) => Promise<string>,
): Promise<string> {
    if (resolveGrepUnitMode() === "symbol" && hit.kind === "bm25" && hit.snippet.trim().length > 0) {
        const symbolLine = hit.name ? `${hit.relFile} symbol ${hit.name}\n` : "";
        return `${hit.relFile} lines ${hit.line}-${hit.endLine} (nearest use)\n${symbolLine}${hit.snippet}`.slice(
            0, GREP_JUDGE_UNIT_MAX_CHARS,
        );
    }
    try {
        const content = await read(hit.file);
        const lines = content.split(/\r?\n/);
        const start = Math.max(1, hit.line - contextLines);
        const end = Math.min(lines.length, Math.max(hit.endLine, hit.line) + contextLines);
        const slice = lines.slice(start - 1, end)
            .map((text, index) => `${start + index} | ${text}`)
            .join("\n");
        const text = `${hit.relFile} lines ${start}-${end}${hit.name ? ` symbol ${hit.name}` : ""}\n${slice}`;
        return text.length > GREP_JUDGE_UNIT_MAX_CHARS ? text.slice(0, GREP_JUDGE_UNIT_MAX_CHARS) : text;
    } catch {
        const fallback = hit.snippet || `${hit.relFile}:${hit.line}`;
        return fallback.length > GREP_JUDGE_UNIT_MAX_CHARS ? fallback.slice(0, GREP_JUDGE_UNIT_MAX_CHARS) : fallback;
    }
}

/** Merge adjacent or overlapping kept ranges in the same file; max p wins. */
export function mergeKeptRanges(
    kept: Array<{ hit: GrepHit; p: number }>,
): Array<{ hit: GrepHit; p: number }> {
    const byFile = new Map<string, Array<{ hit: GrepHit; p: number }>>();
    for (const k of kept) {
        const list = byFile.get(k.hit.file) ?? [];
        list.push(k);
        byFile.set(k.hit.file, list);
    }
    const out: Array<{ hit: GrepHit; p: number }> = [];
    for (const list of byFile.values()) {
        list.sort((a, b) => a.hit.line - b.hit.line);
        let cur: { hit: GrepHit; p: number } | undefined;
        for (const k of list) {
            if (cur && k.hit.line <= cur.hit.endLine + 1) {
                const endLine = Math.max(cur.hit.endLine, k.hit.endLine);
                const winner = k.p > cur.p ? k : cur;
                cur = {
                    hit: { ...winner.hit, line: Math.min(cur.hit.line, k.hit.line), endLine },
                    p: Math.max(cur.p, k.p),
                };
            } else {
                if (cur) out.push(cur);
                cur = k;
            }
        }
        if (cur) out.push(cur);
    }
    // Restore probability order (merge above grouped by file).
    out.sort((a, b) => b.p - a.p);
    return out;
}

// ── Pointers ──────────────────────────────────────────────────────────

async function judgePointers(
    judge: Judge,
    input: GrepJudgeStageInput,
    kept: JudgedGrepHit[],
    unjudged: GrepHit[],
): Promise<{ pointers: GrepJudgePointer[]; result: boolean; cacheHits: number; costUsd?: number }> {
    const none = { pointers: [] as GrepJudgePointer[], result: false, cacheHits: 0, costUsd: undefined as number | undefined };
    if (kept.length === 0 || !input.provider.getGraphIfBuilt) return none;
    let graph: GrepJudgeGraphPeek | null = null;
    try {
        graph = input.provider.getGraphIfBuilt(input.cwd);
    } catch { return none; }
    // Graph not built → skip. Never triggers a build.
    if (!graph) return none;

    let candidates: Array<{ path: string; symbol: string }>;
    try {
        candidates = collectPointerCandidates(graph, kept, shownFilesFor(kept, unjudged));
    } catch { return none; }
    if (candidates.length === 0) return none;

    try {
        const result = await judge.judgeNouls({
            shared: { query: input.query },
            items: candidates.map((c, i) => ({
                id: `n${i}`,
                state: { path: c.path, symbol: c.symbol },
                question: (ref: string) => unitRelevanceQuestion(input.query, ref),
            })),
        });
        const pointers = candidates
            .map((c, i) => ({ path: c.path, line: 1, symbol: c.symbol, p: result.p.get(`n${i}`) ?? 0 }))
            .filter((p) => p.p >= GREP_JUDGE_POINTER_THRESHOLD)
            .sort((a, b) => b.p - a.p)
            .slice(0, GREP_JUDGE_MAX_POINTERS);
        return { pointers, result: true, cacheHits: result.cacheHits ?? 0, costUsd: result.usage.costUsd };
    } catch { return none; }
}

function shownFilesFor(kept: JudgedGrepHit[], unjudged: GrepHit[]): Set<string> {
    return new Set([...kept, ...unjudged].map((h) => h.file));
}

/** Sync neighbour collection from an already-built graph; throws on graph errors. */
function collectPointerCandidates(
    graph: GrepJudgeGraphPeek,
    kept: JudgedGrepHit[],
    shownFiles: Set<string>,
): Array<{ path: string; symbol: string }> {
    const candidates: Array<{ path: string; symbol: string }> = [];
    const seen = new Set<string>();
    const offer = (path: string): void => {
        if (candidates.length >= GREP_JUDGE_MAX_POINTER_CANDIDATES) return;
        if (seen.has(path) || shownFiles.has(path)) return;
        seen.add(path);
        candidates.push({ path, symbol: symbolOfPath(path) });
    };
    for (const hit of kept) {
        for (const n of graph.getMutationNeighbours(hit.file)) offer(n.path);
        for (const dep of graph.getImportDependents(hit.file)) offer(dep);
        if (candidates.length >= GREP_JUDGE_MAX_POINTER_CANDIDATES) break;
    }
    return candidates;
}

function symbolOfPath(path: string): string {
    const base = path.split("/").pop() ?? path;
    return base.replace(/\.[^.]+$/, "") || base;
}
