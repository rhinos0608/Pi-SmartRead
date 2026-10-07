/**
 * SmartRead `find` tool — overrides pi's builtin `find` with the same
 * schema ({pattern, path?, limit?}).
 *
 * Locates files and directories only — never line ranges (those stay
 * in grep). Three modes from the pattern: glob, fuzzy name, and
 * natural language (unjudged in Phase A).
 */
import { statSync, realpathSync } from "node:fs";
import { dirname, parse, resolve } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import type { ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import {
    PROTOCOL_SCHEMA_VERSION,
    canonicalizeWorkspaceRoot,
    hashSessionFilePath,
    inspectionIdFor,
    type WorkspaceEvidenceEnvelope,
} from "@rhinos0608/pi-workspace-protocol";
import { sessionFileFromContext } from "../inspect/inspect-tool.js";
import { detectFindMode, resolveFindLimit, type FindMode } from "./find-modes.js";
import {
    discoverFindCandidates,
    finalizeNaturalLanguageResults,
    fuseNaturalLanguageCandidates,
    matchFuzzyCandidates,
    matchGlobCandidates,
    sortGlobFiles,
    type FindDiscoveredFile,
    type FindDiscoveryResult,
    type FusedNlEntry,
} from "./find-candidates.js";
import { formatFindOutput, type FindEntry } from "./find-format.js";
import { findFileQuestion } from "../judge/questions.js";
import type { ResolveJudgeResult } from "../judge/judge-resolver.js";
import {
    answerProbability,
    JudgeError,
    type Judge,
    type JsonValue,
} from "../judge/types.js";

const FindSchema = Type.Object({
    pattern: Type.String({
        description: "Glob pattern, file/dir name fragment, or natural-language description, e.g. '*.ts', 'auth', or 'files that configure the embedding endpoint'",
    }),
    path: Type.Optional(Type.String({ description: "Directory to search in (default: current directory)" })),
    limit: Type.Optional(Type.Number({ description: "Maximum number of results (default: 100, 20 for natural language; max 500)" })),
});

type FindInput = Static<typeof FindSchema>;

export const FIND_DESCRIPTION = `Find files and directories by glob pattern, name fragment, or natural-language description. Returns matching paths grouped by directory, relative to the search root. Respects .gitignore. For line-level content search inside files use grep instead.`;

export interface FindToolOptions {
    readonly resolver?: {
        publishInspection(envelope: unknown, sessionFilePath: string, workspaceRoot: string): void;
    };
    readonly getSessionFilePath?: () => string | null | undefined;
    /**
     * Optional Phase-B judge wave. Only natural-language mode consults
     * it; glob and fuzzy modes never do. Injectable so the tool stays
     * usable when Pi-context judge wiring is unavailable.
     */
    readonly judge?: Judge;
    /** Resolve the user-selected backend for this workspace and invocation. */
    readonly resolveJudge?: (root: string, context: ExtensionContext, signal?: AbortSignal) => Promise<ResolveJudgeResult>;
    /**
     * Injectable top-level symbol names per workspace-relative path for
     * judge tree cards (at most 8 per file are rendered). The default
     * reads nothing — symbol lookup must never build indexes or graphs.
     */
    readonly getFileSymbols?: (relPath: string) => string[] | Promise<string[]>;
}

/** Minimum judge probability for a file to survive the NL judge wave. */
export const FIND_JUDGE_KEEP_PROBABILITY = 0.4;
/** Maximum symbol names rendered per file on a judge tree card. */
export const FIND_JUDGE_MAX_SYMBOLS_PER_FILE = 8;

interface FindRequest {
    pattern: string;
    mode: FindMode;
    root: string;
    limit: number;
}

function tryCanonical(filePath: string): string {
    try { return realpathSync(filePath); } catch { return filePath; }
}

function buildDiscoveryEvidence(cwd: string, sessionFilePath: string | null | undefined): WorkspaceEvidenceEnvelope {
    const canonicalRoot = canonicalizeWorkspaceRoot(tryCanonical(cwd));
    const sessionId = typeof sessionFilePath === "string" && sessionFilePath.length > 0
        ? hashSessionFilePath(sessionFilePath)
        : "0".repeat(64);
    return {
        schemaVersion: PROTOCOL_SCHEMA_VERSION,
        inspectionId: inspectionIdFor({ sessionId, workspaceRoot: canonicalRoot, resources: [] }),
        sessionId,
        workspaceRoot: cwd,
        canonicalWorkspaceRoot: canonicalRoot,
        createdAt: new Date().toISOString(),
        resources: [],
        mode: "query",
    };
}

function resolveSearchRoot(cwd: string, inputPath: string | undefined): string {
    if (inputPath === "/") {
        throw new Error('find: path "/" is rejected — search a workspace directory instead');
    }
    const target = inputPath ? resolve(cwd, inputPath) : cwd;
    let stat: ReturnType<typeof statSync>;
    try {
        stat = statSync(target);
    } catch {
        throw new Error(`Path not found: ${target}`);
    }
    if (!stat.isDirectory()) {
        throw new Error(`find path must be a directory: ${inputPath}`);
    }
    const canonicalTarget = tryCanonical(target);
    if (canonicalTarget === parse(canonicalTarget).root) {
        throw new Error('find: path "/" is rejected — search a workspace directory instead');
    }
    return canonicalTarget;
}

/** Validate raw params into a mode-resolved request (throws on misuse). */
function parseFindRequest(params: FindInput, cwd: string): FindRequest {
    const pattern = params.pattern;
    if (typeof pattern !== "string" || pattern.length === 0) {
        throw new Error("find requires a non-empty pattern");
    }
    const inputPath = typeof params.path === "string" ? params.path : undefined;
    const root = resolveSearchRoot(cwd, inputPath);
    const mode = detectFindMode(pattern);
    const limit = resolveFindLimit(typeof params.limit === "number" ? params.limit : undefined, mode);
    return { pattern, mode, root, limit };
}

function fileEntry(path: string, dirty: boolean): FindEntry {
    if (dirty) return { path, type: "file", dirty: true };
    return { path, type: "file" };
}

async function buildGlobEntries(pattern: string, discovered: FindDiscoveryResult, limit: number): Promise<{ entries: FindEntry[]; total: number }> {
    const matched = await matchGlobCandidates(pattern, discovered);
    const ranked = sortGlobFiles(matched.files);
    const shownFiles = ranked.slice(0, limit);
    const dirRoom = Math.max(0, limit - shownFiles.length);
    return {
        entries: [
            ...shownFiles.map((file) => fileEntry(file.relPath, file.dirty)),
            ...matched.directories.slice(0, dirRoom).map((dir) => ({ path: dir, type: "directory" as const })),
        ],
        total: ranked.length + matched.directories.length,
    };
}

function buildFuzzyEntries(pattern: string, discovered: FindDiscoveryResult, limit: number): { entries: FindEntry[]; total: number } {
    const matched = matchFuzzyCandidates(pattern, discovered);
    const shownFiles = matched.files.slice(0, limit);
    const dirRoom = Math.max(0, limit - shownFiles.length);
    return {
        entries: [
            ...shownFiles.map((file) => fileEntry(file.relPath, file.dirty)),
            ...matched.directories.slice(0, dirRoom).map((dir) => ({ path: dir.relPath, type: "directory" as const })),
        ],
        total: matched.files.length + matched.directories.length,
    };
}

export interface FindJudgeDetails {
    readonly backend: string;
    readonly model: string;
    readonly threshold: number;
    readonly kept: number;
    readonly dropped: number;
    /** Candidates the judge did not answer (missing probability), preserved without a score. */
    readonly unjudged: number;
    readonly degraded: string[];
}

export interface FindJudgeCard {
    readonly key: string;
    readonly relPath: string;
    readonly sizeBytes: number;
    readonly symbols: string[];
}

/**
 * Render judged candidates as a tagged directory tree: files only are
 * tagged, folders are untagged headers. At most
 * {@link FIND_JUDGE_MAX_SYMBOLS_PER_FILE} symbols render per file.
 */
export function buildFindJudgeTree(cards: FindJudgeCard[]): string {
    const groups = new Map<string, FindJudgeCard[]>();
    for (const card of cards) {
        const dir = dirname(card.relPath);
        const key = dir === "." ? "." : dir;
        const list = groups.get(key);
        if (list) list.push(card);
        else groups.set(key, [card]);
    }
    const dirs = [...groups.keys()].sort((a, b) => {
        if (a === ".") return -1;
        if (b === ".") return 1;
        return a.localeCompare(b);
    });
    const lines: string[] = [];
    for (const dir of dirs) {
        lines.push(dir === "." ? "./" : `${dir}/`);
        for (const card of groups.get(dir)!) {
            const base = card.relPath.slice(card.relPath.lastIndexOf("/") + 1);
            const symbols = card.symbols.slice(0, FIND_JUDGE_MAX_SYMBOLS_PER_FILE);
            const symbolSuffix = symbols.length > 0 ? ` symbols: ${symbols.join(", ")}` : "";
            lines.push(`  [${card.key}] ${base} (${card.sizeBytes} bytes)${symbolSuffix}`);
        }
    }
    return lines.join("\n");
}

function sizeOf(absPath: string): number {
    try {
        const size = statSync(absPath).size;
        return Number.isFinite(size) ? size : 0;
    } catch {
        return 0;
    }
}

function roundJudgeScore(p: number): number {
    return Math.round(p * 100) / 100;
}

interface NaturalLanguageOutcome {
    readonly entries: FindEntry[];
    readonly total: number;
    readonly unjudged: boolean;
    readonly judge?: FindJudgeDetails;
    readonly degraded: string[];
}

async function buildNaturalLanguageEntries(
    pattern: string,
    discovered: FindDiscoveryResult,
    root: string,
    limit: number,
    opts: FindToolOptions,
    context: ExtensionContext,
    signal?: AbortSignal,
): Promise<NaturalLanguageOutcome> {
    const fused = await fuseNaturalLanguageCandidates(pattern, discovered.files, root);
    const byPath = new Map(discovered.files.map((file) => [file.relPath, file]));
    let judge = opts.judge;
    if (!judge && opts.resolveJudge) {
        try {
            const resolved = await opts.resolveJudge(root, context, signal);
            if ("unavailable" in resolved) {
                const degraded = resolved.unavailable === "aborted" ? [] : [`judge_${resolved.unavailable}`];
                return unjudgedNaturalLanguageOutcome(fused, byPath, limit, degraded);
            }
            judge = resolved.judge;
        } catch (error) {
            if (signal?.aborted) throw error;
            const code = error instanceof JudgeError ? error.code : "error";
            return unjudgedNaturalLanguageOutcome(fused, byPath, limit, [`judge_${code}`]);
        }
    }
    if (!judge) return unjudgedNaturalLanguageOutcome(fused, byPath, limit);
    return judgeNaturalLanguage({
        query: pattern,
        fused,
        byPath,
        limit,
        judge,
        getFileSymbols: opts.getFileSymbols,
        signal,
    });
}

function unjudgedNaturalLanguageOutcome(
    fused: FusedNlEntry[],
    byPath: Map<string, FindDiscoveredFile>,
    limit: number,
    degraded: string[] = [],
): NaturalLanguageOutcome {
    const final = finalizeNaturalLanguageResults(fused, limit);
    return {
        entries: final.map((item) => ({
            path: item.relPath,
            type: "file" as const,
            score: item.score,
            dirty: byPath.get(item.relPath)?.dirty,
        })),
        total: fused.length,
        unjudged: true,
        degraded,
    };
}

interface JudgeWaveInput {
    readonly query: string;
    readonly fused: FusedNlEntry[];
    readonly byPath: Map<string, FindDiscoveredFile>;
    readonly limit: number;
    readonly judge: Judge;
    readonly getFileSymbols?: (relPath: string) => string[] | Promise<string[]>;
    readonly signal?: AbortSignal;
}

/**
 * Phase-B judge wave: the fused shortlist (already capped at 128) is
 * rendered as a directory tree and judged file-by-file. Files only are
 * judged; a directory entry is reported when at least two kept files
 * share it (score = max of its children). Any judge failure falls back
 * to the unchanged unjudged ranking with a `judge_<code>` degradation.
 * Never builds indexes or graphs: symbols come only from the injected
 * reader (default: none).
 */
async function judgeNaturalLanguage(input: JudgeWaveInput): Promise<NaturalLanguageOutcome> {
    const { query, fused, byPath, limit, judge, getFileSymbols, signal } = input;
    const cards: FindJudgeCard[] = [];
    for (let index = 0; index < fused.length; index++) {
        const relPath = fused[index]!.relPath;
        let symbols: string[] = [];
        try {
            symbols = (await getFileSymbols?.(relPath)) ?? [];
        } catch {
            symbols = [];
        }
        cards.push({
            key: `f${index}`,
            relPath,
            sizeBytes: sizeOf(byPath.get(relPath)?.absPath ?? ""),
            symbols,
        });
    }
    const tree = buildFindJudgeTree(cards);
    const units: Record<string, JsonValue> = {};
    for (const card of cards) {
        units[card.key] = {
            path: card.relPath,
            symbols: card.symbols.slice(0, FIND_JUDGE_MAX_SYMBOLS_PER_FILE),
        };
    }
    let judged: { p: Map<string, number>; unjudged: Array<{ id: string; code: string }> };
    try {
        judged = await judge.judgeNouls(
            {
                shared: { query, tree, units },
                items: cards.map((card) => ({
                    id: card.key,
                    state: { path: card.relPath },
                    question: () => findFileQuestion(query, card.key, card.relPath),
                })),
            },
            signal,
        );
    } catch (error) {
        if (signal?.aborted) throw error;
        return unjudgedFallback(fused, byPath, limit, judge, error);
    }
    const preferRaw = judge.info.backend === "local";
    const scored: Array<{ relPath: string; p: number }> = [];
    const unjudgedCodes = new Map(judged.unjudged.map((entry) => [entry.id, entry.code]));
    const unjudgedCards: FindJudgeCard[] = [];
    for (const card of cards) {
        const raw = judged.p.get(card.key);
        // A missing (or non-finite) probability is a per-item judge
        // non-answer: preserve the candidate with degradation instead of
        // silently dropping it. Only below-threshold answers are dropped.
        if (raw === undefined) {
            unjudgedCards.push(card);
            continue;
        }
        const p = answerProbability(raw, preferRaw) ?? raw;
        if (!Number.isFinite(p)) {
            unjudgedCards.push(card);
            continue;
        }
        scored.push({ relPath: card.relPath, p });
    }
    if (scored.length === 0) {
        return unjudgedFallback(fused, byPath, limit, judge, new JudgeError("bad_response", "empty judge result"));
    }
    const kept = scored
        .filter((entry) => entry.p >= FIND_JUDGE_KEEP_PROBABILITY)
        .sort((a, b) => b.p - a.p || a.relPath.localeCompare(b.relPath));
    const fileEntries: FindEntry[] = kept.map((entry) => ({
        path: entry.relPath,
        type: "file" as const,
        score: roundJudgeScore(entry.p),
        dirty: byPath.get(entry.relPath)?.dirty,
    }));
    const dirEntries = buildJudgeDirectoryEntries(kept);
    // Preserve judge-unanswered candidates after the kept entries in fused
    // order, without a judge score, so a partial judge response degrades
    // instead of silently dropping them. Below-threshold answers stay out.
    const preservedEntries: FindEntry[] = unjudgedCards.map((card) => ({
        path: card.relPath,
        type: "file" as const,
        dirty: byPath.get(card.relPath)?.dirty,
    }));
    const total = fileEntries.length + preservedEntries.length + dirEntries.length;
    const entries = [...fileEntries, ...preservedEntries, ...dirEntries].slice(0, limit);
    const degraded = [...new Set([
        ...judged.unjudged.map((entry) => `judge_${entry.code}`),
        ...unjudgedCards.map((card) => `judge_${unjudgedCodes.get(card.key) ?? "bad_response"}`),
    ])];
    return {
        entries,
        total,
        unjudged: false,
        judge: {
            backend: judge.info.backend,
            model: judge.info.model,
            threshold: FIND_JUDGE_KEEP_PROBABILITY,
            kept: kept.length,
            dropped: scored.length - kept.length,
            unjudged: unjudgedCards.length,
            degraded,
        },
        degraded,
    };
}

/** Directory entries for judged results: only dirs with >= 2 kept files. */
function buildJudgeDirectoryEntries(kept: Array<{ relPath: string; p: number }>): FindEntry[] {
    const best = new Map<string, number>();
    const counts = new Map<string, number>();
    for (const entry of kept) {
        const dir = dirname(entry.relPath);
        if (dir === "." || dir === "/" || dir === "") continue;
        counts.set(dir, (counts.get(dir) ?? 0) + 1);
        best.set(dir, Math.max(best.get(dir) ?? 0, entry.p));
    }
    return [...best.entries()]
        .filter(([dir]) => (counts.get(dir) ?? 0) >= 2)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([dir, p]) => ({ path: dir, type: "directory" as const, score: roundJudgeScore(p) }));
}

function unjudgedFallback(
    fused: FusedNlEntry[],
    byPath: Map<string, FindDiscoveredFile>,
    limit: number,
    judge: Judge,
    error: unknown,
): NaturalLanguageOutcome {
    const code = error instanceof JudgeError ? error.code : "error";
    const degraded = [`judge_${code}`];
    const final = finalizeNaturalLanguageResults(fused, limit);
    return {
        entries: final.map((entry) => ({
            path: entry.relPath,
            type: "file" as const,
            score: entry.score,
            dirty: byPath.get(entry.relPath)?.dirty,
        })),
        total: fused.length,
        unjudged: true,
        judge: {
            backend: judge.info.backend,
            model: judge.info.model,
            threshold: FIND_JUDGE_KEEP_PROBABILITY,
            kept: 0,
            dropped: fused.length,
            unjudged: fused.length,
            degraded,
        },
        degraded,
    };
}

async function collectRankedEntries(
    request: FindRequest,
    discovered: FindDiscoveryResult,
    opts: FindToolOptions,
    context: ExtensionContext,
    signal?: AbortSignal,
): Promise<NaturalLanguageOutcome | { entries: FindEntry[]; total: number }> {
    if (request.mode === "glob") return buildGlobEntries(request.pattern, discovered, request.limit);
    if (request.mode === "fuzzy") return buildFuzzyEntries(request.pattern, discovered, request.limit);
    return buildNaturalLanguageEntries(request.pattern, discovered, request.root, request.limit, opts, context, signal);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) throw new Error("Operation aborted");
}

function publishDiscoveryEvidence(
    opts: FindToolOptions,
    evidence: WorkspaceEvidenceEnvelope,
    sessionFilePath: string | null | undefined,
): void {
    if (!opts.resolver || typeof sessionFilePath !== "string" || sessionFilePath.length === 0) return;
    try {
        opts.resolver.publishInspection(evidence, sessionFilePath, evidence.canonicalWorkspaceRoot);
    } catch {
        // Best-effort publish; the envelope in details is authoritative.
    }
}

export function createFindTool(opts: FindToolOptions = {}): ToolDefinition {
    return {
        name: "find",
        label: "find",
        description: FIND_DESCRIPTION,
        parameters: FindSchema as unknown as Record<string, unknown>,
        async execute(
            toolCallId: string,
            params: FindInput & Record<string, unknown>,
            signal: AbortSignal | undefined,
            _onUpdate: unknown,
            ctx: ExtensionContext,
        ) {
            throwIfAborted(signal);
            const request = parseFindRequest(params, ctx.cwd);
            const started = Date.now();
            const discovered = await discoverFindCandidates(request.root, { signal });
            throwIfAborted(signal);
            const ranked = await collectRankedEntries(request, discovered, opts, ctx, signal);
            throwIfAborted(signal);
            const { entries, total } = ranked;
            const unjudged = request.mode === "natural-language" ? (ranked as NaturalLanguageOutcome).unjudged !== false : false;
            const text = formatFindOutput({
                pattern: request.pattern,
                mode: request.mode,
                entries,
                total,
                elapsedMs: Date.now() - started,
                timedOut: discovered.timedOut,
                unjudged,
            });
            const sessionFilePath = opts.getSessionFilePath?.() ?? sessionFileFromContext(ctx);
            const evidence = buildDiscoveryEvidence(ctx.cwd, sessionFilePath);
            publishDiscoveryEvidence(opts, evidence, sessionFilePath);
            return {
                content: [{ type: "text" as const, text }],
                details: {
                    workspaceEvidence: evidence,
                    mode: request.mode,
                    root: request.root,
                    total,
                    shown: entries.length,
                    truncated: entries.length < total,
                    toolCallId,
                    entries,
                    ...("judge" in ranked && ranked.judge !== undefined ? { judge: ranked.judge } : {}),
                    ...("degraded" in ranked && ranked.degraded.length > 0 ? { degraded: ranked.degraded } : {}),
                },
            };
        },
    };
}
