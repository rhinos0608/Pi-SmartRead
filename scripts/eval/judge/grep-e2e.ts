#!/usr/bin/env node
/**
 * Grep end-to-end experiment: judge-off vs cloud judge at keep-thresholds
 * 0.35 / 0.40 / 0.45. ROUND-1 measurement-fidelity revision.
 *
 * Method (honest production path): every query goes through production
 * createGrepTool().execute() — the same entry the registered `grep` tool
 * calls — with identical routing, caps, renderer, and output guard.
 * Judge-off passes no `judge` provider (stage bypassed, byte-identical to
 * production mode-off). Judged configs inject a GrepJudgeProvider that
 * resolves a CloudJudge (CLOUD_JUDGE_DEFAULT_BASE_URL, key ONLY from
 * PI_SMARTREAD_JUDGE_API_KEY, cache: null). The keep threshold rides the
 * PI_SMARTREAD_JUDGE_GREP_THRESHOLD env seam; pointer (.45) and exists
 * (.35) gates are untouched constants. No graph provider is injected, so the
 * pointer wave is skipped exactly as in production when no graph is built.
 *
 * Per query the harness records: exact guarded text, full shown hit cards
 * plus the top-5 slice, renderedChars with ceil(/4) as renderedTokenEstimate
 * alongside the legacy top-5-only estimate (explicitly named), pre-judge
 * fused candidates via the additive opt-in trace seam, judge inputs/outputs
 * via a judgeNouls wrapper (no reimplemented judging), and full
 * GrepJudgeDetails. A note/abstention message is output, never zero tokens.
 *
 * Corpus: default is a frozen git-archive snapshot of pinned sourceRef
 * 18f6463 (extracted to a managed temp dir; reports live outside it).
 * --root selects an explicit mutable worktree root instead (manifested, drift
 * is rejected rather than ignored). No network, no clone/checkout/rebase.
 *
 * Metric definitions: see scripts/eval/judge/grep-e2e-metrics.ts. Known-gold
 * overlap Recall@5 is a LOWER-BOUND diagnostic over incomplete labels, not
 * universal true recall. q02 is answerable_without_gold: declared
 * answerable (36) and evaluable-with-gold (35) coverage are reported
 * separately; q02 is never dropped or relabeled.
 *
 * Usage:
 *   npx tsx scripts/eval/judge/grep-e2e.ts --config off|t035|t040|t045|all
 *     [--queries q01,q02] [--limit-queries N] [--root PATH]
 *     [--data-dir PATH] [--timeout-ms N] [--resume]
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    appendFileSync,
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CLOUD_JUDGE_DEFAULT_BASE_URL, CLOUD_JUDGE_DEFAULT_MODEL, CloudJudge } from "../../../src/judge/cloud-judge.js";
import { GREP_JUDGE_THRESHOLD_ENV_VAR } from "../../../src/judge/grep-judge-stage.js";
import type { GrepJudgeProvider } from "../../../src/judge/grep-judge-stage.js";
import type {
    Judge,
    JudgeNoulInput,
    JudgeNoulResult,
    JudgeUsage,
} from "../../../src/judge/types.js";
import { createGrepTool, type GrepTraceEvent } from "../../../src/search/grep-tool.js";
import { disposeSemanticIndexes } from "../../../src/indexing/semantic-index-registry.js";
import { shutdownAllManagers } from "../../../src/lsp/lsp-manager.js";
import { resetLSPBridge } from "../../../src/lsp/lsp-bridge.js";
import {
    GATE_CONSTANTS,
    classifyGoldRow,
    goldCovered,
    goldFileHit,
    legacyTop5TokenEstimate,
    renderedTokenEstimate,
    summarizeQueries,
    validateFixture,
    type ClassifyEvidence,
    type EvalRow,
    type QueryOutcome,
    type QueryOutcomeLabel,
    type QuerySummary,
} from "./grep-e2e-metrics.js";
import {
    ALLOWED_LABELS,
    CHECKPOINT_SCHEMA_VERSION,
    checkPrivateExisting,
    computeRunFingerprint,
    errorStatus,
    hashEngineSources,
    isConsistentDuplicate,
    isHardError,
    isKnownSourceHash,
    validateCheckpointRow,
    canonicalizeCorpusRoot,
    type CheckpointRow,
    type RunIdentityInput,
} from "./grep-e2e-contract.js";

/** Pinned benchmark source revision; gold spans are labeled against it. */
const SOURCE_REF = "18f6463caa78e6657b1af6c7eb86b711bc2364f8";

const DEFAULT_DATA_DIR = join(homedir(), ".cache/pi-smartread-judge-spike/eval");
const OUTPUT_DIR = join(homedir(), ".cache/pi-smartread-judge-spike/bench/grep-e2e");

type ConfigName = "off" | "t035" | "t040" | "t045";
const CONFIG_THRESHOLD: Record<Exclude<ConfigName, "off">, string> = {
    t035: "0.35",
    t040: "0.40",
    t045: "0.45",
};

interface JudgeCallRecord {
    /** Inferred wave from item ids: units | exists | pointers. */
    wave: string;
    itemCount: number;
    /** Per-item input states (corpus text slices); prompts captured on invocation. */
    states: Array<Record<string, unknown>>;
    prompts: Array<{ id: string; prompt: unknown }>;
    scores: Record<string, number>;
    unjudged: Array<{ id: string; code: string }>;
    usage: JudgeUsage;
    cacheHits: number;
}

interface QueryTrace {
    qid: string;
    query: string;
    answerable: boolean;
    goldRows: number;
    text: string;
    renderedChars: number;
    renderedTokens: number;
    legacyTop5Tokens: number;
    shown: Array<Record<string, unknown>>;
    top5: Array<{ relFile: string; line: number; endLine: number; name: string; snippet: string }>;
    preJudgeCount: number;
    // Null = UNKNOWN: the pre-cascade upstream count is unobservable at this
    // seam, so a truncated pre-judge pool must never be reported as false.
    preJudgeTruncatedPool: boolean | null;
    // Complete copied pre-judge candidates and post-judge shown cards as
    // faithful full hit records (all fields preserved, never reconstructed
    // from formatted text). Recall is computed from post-judge cards after
    // the actual topK cap; the output guard may truncate text independently.
    preJudgeCandidates: Array<Record<string, unknown>>;
    postJudgeShown: Array<Record<string, unknown>>;
    postJudgeTotal: number;
    postJudgePoolCapped: boolean;
    outputTruncated: boolean;
    judged: boolean;
    abstained: boolean;
    judgeDetails: unknown;
    judgeCalls: JudgeCallRecord[];
    degradation: string;
    coveredGoldRows: number;
    covered: boolean;
    fileHit: boolean;
    goldOutcomes: Array<{ file: string; startLine: number; endLine: number; outcome: string }>;
    status: string;
    elapsedMs: number;
    timedOut: boolean;
}

function parseArgs(argv: string[]): {
    configs: ConfigName[];
    onlyQueries: Set<string> | null;
    limit: number | null;
    root: string | null;
    dataDir: string;
    timeoutMs: number;
    resume: boolean;
} {
    let configArg = "all";
    let queriesArg: string | null = null;
    let limitArg: string | null = null;
    let root: string | null = null;
    let dataDir = DEFAULT_DATA_DIR;
    let timeoutMs = 60000;
    let resume = false;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--config") configArg = argv[++i] ?? "";
        else if (arg === "--queries") queriesArg = argv[++i] ?? "";
        else if (arg === "--limit" || arg === "--limit-queries") limitArg = argv[++i] ?? "";
        else if (arg === "--root") root = canonicalizeCorpusRoot(resolve(argv[++i] ?? ""));
        else if (arg === "--data-dir") dataDir = resolve(argv[++i] ?? "");
        else if (arg === "--timeout-ms") timeoutMs = Number(argv[++i] ?? "");
        else if (arg === "--resume") resume = true;
        else if (arg === "--help" || arg === "-h") {
            console.log("Usage: npx tsx scripts/eval/judge/grep-e2e.ts [--config off|t035|t040|t045|all] [--queries q01,q02] [--limit-queries N] [--root PATH] [--data-dir PATH] [--timeout-ms N] [--resume]");
            console.log(`Defaults: frozen git-archive snapshot of ${SOURCE_REF}; per-query timeout ${timeoutMs}ms.`);
            process.exit(0);
        } else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }
    const all: ConfigName[] = ["off", "t035", "t040", "t045"];
    if (configArg !== "all" && !(all as string[]).includes(configArg)) {
        throw new Error("--config must be off|t035|t040|t045|all");
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("--timeout-ms must be a positive number");
    const configs = configArg === "all" ? all : [configArg as ConfigName];
    return {
        configs,
        onlyQueries: queriesArg ? new Set(queriesArg.split(",").map((q) => q.trim()).filter(Boolean)) : null,
        limit: limitArg !== null ? Number(limitArg) : null,
        root,
        dataDir,
        timeoutMs,
        resume,
    };
}

function loadRows(path: string): EvalRow[] {
    const rows = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).map((line, index) => {
        let value: unknown;
        try {
            value = JSON.parse(line);
        } catch {
            throw new Error(`${path}:${index + 1}: invalid JSON`);
        }
        if (!isEvalRow(value)) throw new Error(`${path}:${index + 1}: invalid evaluation row`);
        return value;
    });
    if (rows.length === 0) throw new Error(`No evaluation rows in ${path}`);
    return rows;
}

// Label allowlist: unknown labels (e.g. a misspelled "gold") fail closed at
// load instead of silently vanishing from gold denominators.
function isAllowedLabel(value: unknown): boolean {
    return typeof value === "string" && (ALLOWED_LABELS as readonly string[]).includes(value);
}

function isEvalRow(value: unknown): value is EvalRow {
    if (!value || typeof value !== "object") return false;
    const row = value as Record<string, unknown>;
    return typeof row.qid === "string" && row.qid.length > 0 && typeof row.query === "string" &&
        row.query.length > 0 &&
        typeof row.answerable === "boolean" && typeof row.file === "string" && row.file.length > 0 &&
        Number.isInteger(row.startLine) && Number.isInteger(row.endLine) &&
        (typeof row.symbol === "string" || row.symbol === null) && isAllowedLabel(row.label) &&
        typeof row.why === "string";
}

function sha256File(path: string): string {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function inventoryHash(root: string): { files: number; hash: string } {
    const entries: string[] = [];
    const walk = (dir: string): void => {
        for (const name of readdirSync(dir).sort()) {
            if (name === ".git") continue;
            const full = join(dir, name);
            const rel = relative(root, full).split(sep).join("/");
            if (statSync(full).isDirectory()) walk(full);
            else entries.push(`${rel}:${sha256File(full)}`);
        }
    };
    walk(root);
    return { files: entries.length, hash: createHash("sha256").update(entries.join("\n")).digest("hex") };
}

/** Git root derived from this script's location, never from an arbitrary cwd. */
function gitRootFromScript(): string | null {
    try {
        const scriptDir = dirname(fileURLToPath(import.meta.url));
        const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
            cwd: scriptDir,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        return root.length > 0 ? root : null;
    } catch {
        return null;
    }
}

/** Engine source content identity lives in the import-safe contract helper
 * (tracked plus untracked non-ignored sources); see hashEngineSources. */
function engineSourceHash(gitRoot: string | null): string {
    if (!gitRoot) return "unknown:no-git-root";
    return hashEngineSources(gitRoot);
}

/** Frozen benchmark corpus: git archive of the pinned ref into a new managed temp dir. No network. */
function createSnapshotCorpus(ref: string): string {
    const dir = mkdtempSync(join(tmpdir(), "smartread-grep-corpus-"));
    const repoRoot = gitRootFromScript() ?? resolve(process.cwd());
    const archive: Buffer = execFileSync("git", ["archive", ref], { cwd: repoRoot, maxBuffer: 256 * 1024 * 1024 });
    execFileSync("tar", ["-x", "-C", dir], { input: archive });
    // mkdtemp on macOS lands under symlinked /var: canonicalize so hit
    // display paths and gold matching share one root (defense in depth
    // with the production canonical-display-root fix).
    return canonicalizeCorpusRoot(dir);
}

function codeUnderTest(): { head: string; dirty: string[] } {
    const cwd = resolve(process.cwd());
    let head = "unknown";
    let dirty: string[] = [];
    try {
        head = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
    } catch { /* record unknown, never fail the manifest */ }
    try {
        dirty = execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" })
            .split("\n").map((l) => l.trim()).filter(Boolean);
    } catch { /* record empty */ }
    return { head, dirty };
}

/** Records judge inputs/outputs without reimplementing judging; never touches keys. */
function wrapJudge(inner: Judge, calls: JudgeCallRecord[]): Judge {
    return {
        info: inner.info,
        judgeNouls: async (input: JudgeNoulInput, signal?: AbortSignal): Promise<JudgeNoulResult> => {
            const firstId = input.items[0]?.id ?? "";
            const wave = firstId === "exists" ? "exists" : firstId.startsWith("n") ? "pointers" : "units";
            const prompts: Array<{ id: string; prompt: unknown }> = [];
            const proxied: JudgeNoulInput = {
                shared: input.shared,
                items: input.items.map((item) => ({
                    id: item.id,
                    state: item.state,
                    question: (ref: string) => {
                        const prompt = item.question(ref);
                        prompts.push({ id: item.id, prompt });
                        return prompt;
                    },
                })),
            };
            const result = await inner.judgeNouls(proxied, signal);
            calls.push({
                wave,
                itemCount: input.items.length,
                states: input.items.map((item) => item.state as Record<string, unknown>),
                prompts,
                scores: Object.fromEntries(result.p),
                unjudged: result.unjudged,
                usage: result.usage,
                cacheHits: result.cacheHits ?? 0,
            });
            return result;
        },
    };
}

function createProvider(config: ConfigName, calls: JudgeCallRecord[]): GrepJudgeProvider | undefined {
    if (config === "off") return undefined;
    const apiKey = process.env.PI_SMARTREAD_JUDGE_API_KEY;
    if (!apiKey) {
        throw new Error(
            `Refusing judged config "${config}": PI_SMARTREAD_JUDGE_API_KEY is absent. ` +
            "Set it to run cloud-judged configs; no local fallback is used.",
        );
    }
    const inner = new CloudJudge({
        apiKey,
        baseUrl: CLOUD_JUDGE_DEFAULT_BASE_URL,
        model: process.env.PI_SMARTREAD_JUDGE_MODEL,
        cache: null,
    });
    const judge = wrapJudge(inner, calls);
    return { resolveJudge: async () => ({ judge }) };
}

async function runQuery(input: {
    qid: string;
    query: string;
    answerable: boolean;
    golds: EvalRow[];
    root: string;
    judge: GrepJudgeProvider | undefined;
    timeoutMs: number;
}): Promise<{ trace: QueryTrace; outcome: QueryOutcome }> {
    const { qid, query, answerable, golds, root, judge, timeoutMs } = input;
    const started = performance.now();
    const events: GrepTraceEvent[] = [];
    const judgeCalls: JudgeCallRecord[] = [];
    // Wrap the provider so judgeNouls inputs/outputs are recorded per query.
    const recordingJudge = judge
        ? {
            resolveJudge: async (...args: Parameters<NonNullable<GrepJudgeProvider["resolveJudge"]>>) => {
                const resolved = await judge.resolveJudge(...args);
                if (!("judge" in resolved)) return resolved;
                return { judge: wrapJudge(resolved.judge, judgeCalls) };
            },
        }
        : undefined;
    const opts = recordingJudge
        ? {
            judge: recordingJudge,
            getWorkspaceRevision: () => 0,
            onTraceGrepQuery: (e: GrepTraceEvent) => { events.push(e); },
        }
        : { getWorkspaceRevision: () => 0, onTraceGrepQuery: (e: GrepTraceEvent) => { events.push(e); } };
    let timedOut = false;
    let status = "ok";
    let text = "";
    try {
        const tool = createGrepTool(opts);
        const signal = AbortSignal.timeout(timeoutMs);
        const result = await tool.execute(
            qid,
            { pattern: query },
            signal,
            undefined,
            { cwd: root } as Parameters<ReturnType<typeof createGrepTool>["execute"]>[4],
        );
        const first = result.content[0] as { text?: string } | undefined;
        text = typeof first?.text === "string" ? first.text : "";
        const degradation = ((result.details as { degradation?: Array<{ backend: string; code: string }> } | undefined)?.degradation ?? [])
            .map((d) => `${d.backend}_${d.code}`).join(",");
        const judgeDegraded = degradation.split(",").find((c) => c.startsWith("judge_"));
        if (judgeDegraded) status = `judge_degraded:${judgeDegraded}`;
    } catch (error) {
        // Sanitized codes only: raw external text (prompts, paths, keys) never
        // enters logs, checkpoints, or reports.
        timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
        status = errorStatus(error);
    }
    const elapsedMs = performance.now() - started;
    const preJudge = events.find((e) => e.stage === "pre-judge");
    const postJudge = events.find((e) => e.stage === "post-judge");
    const postCap = events.find((e) => e.stage === "post-cap");
    // post-cap guarded text is authoritative; fall back to execute content.
    // The guard may truncate text independently of the metadata cards.
    const renderedText = postCap?.stage === "post-cap" ? postCap.text : text;
    const outputTruncated = postCap?.stage === "post-cap" ? postCap.outputTruncated : false;
    // Faithful full-record copies from stage snapshots: no field is
    // projected away (name/kind/engines preserved), nothing is
    // reconstructed by parsing formatted text.
    const preJudgeCandidates: Array<Record<string, unknown>> = preJudge?.stage === "pre-judge"
        ? preJudge.candidates.map((h) => ({ ...h, engines: [...h.engines] }))
        : [];
    const postJudgeShown: Array<Record<string, unknown>> = postJudge?.stage === "post-judge"
        ? postJudge.shown.map((h) => ({ ...h, engines: [...h.engines] }))
        : [];
    const postJudgeTotal = postJudge?.stage === "post-judge" ? postJudge.totalHits : postJudgeShown.length;
    const postJudgePoolCapped = postJudgeShown.length < postJudgeTotal;
    const shownCards = postJudge?.stage === "post-judge" ? postJudge.shown : [];
    const top5 = shownCards.slice(0, 5).map((h) => ({
        relFile: h.relFile,
        line: h.line,
        endLine: h.endLine,
        name: h.name,
        snippet: h.snippet,
    }));
    const preJudgeFiles = preJudge?.stage === "pre-judge" ? preJudge.candidates.map((c) => c.relFile) : undefined;
    const shownRest = shownCards.slice(5).map((h) => ({ relFile: h.relFile, line: h.line, endLine: h.endLine }));
    const judged = postJudge?.stage === "post-judge" ? postJudge.judged : false;
    const abstained = postJudge?.stage === "post-judge" ? postJudge.abstained : false;
    const judgeDetails = postJudge?.stage === "post-judge" ? (postJudge.judge ?? null) : null;
    // Actual judge states/questions/results per call, with unjudged IDs and
    // usage preserved. No claim is made about missing scores below
    // threshold, and unjudged IDs are never mapped to gold rows.
    const goldOutcomes = golds.map((g) => {
        const evidence: ClassifyEvidence = {
            judged,
            abstained,
            ...(preJudgeFiles !== undefined ? { preJudgeFiles } : {}),
            ...(preJudge?.stage === "pre-judge"
                ? {
                    preJudgeCovered: goldCovered(
                        g,
                        preJudge.candidates.map((c) => ({ relFile: c.relFile, line: c.line, endLine: c.endLine })),
                    ),
                }
                : {}),
            shownCovered: goldCovered(g, shownRest),
            // Raw status: the classifier keys on the "error:" prefix, so hard
            // errors classify execution_error; judge_degraded keeps coverage.
            executionStatus: status,
        };
        return { file: g.file, startLine: g.startLine, endLine: g.endLine, outcome: classifyGoldRow(g, top5, evidence) };
    });
    const coveredGoldRows = golds.filter((g) => goldCovered(g, top5)).length;
    const covered = answerable && golds.length > 0 ? coveredGoldRows > 0 : false;
    const fileHit = golds.some((g) => goldFileHit(g, top5));
    // Completed judge_degraded runs keep genuine measured coverage with a
    // coverage-based outcome; only hard errors force "error". Actual error
    // queries retain denominators with zero coverage (never a correct
    // abstention when golds exist). No claim about missing scores below
    // threshold; unjudged IDs are never mapped to gold rows.
    const outcomeLabel: QueryOutcomeLabel = isHardError(status)
        ? "error"
        : !answerable
          ? (abstained || top5.length === 0 ? "unanswerable_ok" : "unanswerable_miss")
          : golds.length === 0
            ? "label_unknown"
            : covered
              ? "covered"
              : "mixed";
    const outcome: QueryOutcome = {
        qid,
        query,
        answerable,
        goldRows: golds.length,
        coveredGoldRows,
        covered,
        fileHit,
        renderedChars: renderedText.length,
        renderedTokens: renderedTokenEstimate(renderedText),
        legacyTop5Tokens: legacyTop5TokenEstimate(top5),
        top5: top5.length,
        abstained,
        abstentionCorrect: answerable ? null : abstained || top5.length === 0,
        outcome: outcomeLabel,
        status,
        elapsedMs,
    };
    const trace: QueryTrace = {
        qid,
        query,
        answerable,
        goldRows: golds.length,
        text: renderedText,
        renderedChars: renderedText.length,
        renderedTokens: renderedTokenEstimate(renderedText),
        legacyTop5Tokens: legacyTop5TokenEstimate(top5),
        shown: postJudgeShown,
        top5,
        preJudgeCount: preJudge?.stage === "pre-judge" ? preJudge.candidates.length : -1,
        preJudgeTruncatedPool: null,
        preJudgeCandidates,
        postJudgeShown,
        postJudgeTotal,
        postJudgePoolCapped,
        outputTruncated,
        judged,
        abstained,
        judgeDetails,
        judgeCalls,
        degradation: status,
        coveredGoldRows,
        covered,
        fileHit,
        goldOutcomes,
        status,
        elapsedMs,
        timedOut,
    };
    return { trace, outcome };
}

function checkpointPath(config: ConfigName, fingerprint: string): string {
    return join(OUTPUT_DIR, `checkpoint-${config}-${fingerprint}.jsonl`);
}

interface ResumeResult {
    reused: Map<string, { trace: QueryTrace; outcome: QueryOutcome }>;
    stats: Record<string, number>;
    refused: string | null;
}

/**
 * Fail-closed resume: the existing checkpoint must be private and owned
 * (never mutated into compliance), and every row must validate against the
 * versioned schema and the current full run fingerprint. Stale,
 * incompatible, malformed, unknown-qid, and inconsistent-duplicate rows
 * rerun; only compatible complete query evidence is reused.
 */
function loadCheckpointValidated(
    path: string,
    fingerprint: string,
    knownQids: Set<string>,
): ResumeResult {
    const reused = new Map<string, { trace: QueryTrace; outcome: QueryOutcome }>();
    const stats: Record<string, number> = {
        reused: 0,
        staleFingerprint: 0,
        incompatibleSchema: 0,
        malformed: 0,
        unknownQid: 0,
        inconsistentDuplicate: 0,
    };
    const empty = (): ResumeResult => ({ reused, stats, refused: null });
    if (!existsSync(path)) return { reused, stats, refused: null };
    let lst: ReturnType<typeof lstatSync>;
    try {
        lst = lstatSync(path);
    } catch {
        return { reused, stats, refused: "unstatable" };
    }
    const getuid = typeof process.getuid === "function" ? process.getuid() : null;
    const verdict = getuid === null
        ? ((lst as unknown as { isSymbolicLink(): boolean }).isSymbolicLink()
            ? { ok: false as const, reason: "refuses-symlink" }
            : { ok: true as const })
        : checkPrivateExisting(
            { isSymbolicLink: () => lst.isSymbolicLink(), mode: lst.mode, uid: lst.uid },
            getuid,
        );
    if (!verdict.ok) return { reused, stats, refused: verdict.reason };
    const seen = new Map<string, CheckpointRow>();
    for (const line of readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean)) {
        const rowVerdict = validateCheckpointRow(line, fingerprint, knownQids);
        if (!rowVerdict.ok) {
            const key = rowVerdict.reason === "stale-fingerprint"
                ? "staleFingerprint"
                : rowVerdict.reason === "incompatible-schema"
                  ? "incompatibleSchema"
                  : rowVerdict.reason === "unknown-qid"
                    ? "unknownQid"
                    : "malformed";
            stats[key] = (stats[key] ?? 0) + 1;
            continue;
        }
        const qid = (rowVerdict.row.trace as { qid: string }).qid;
        const prev = seen.get(qid);
        if (prev) {
            if (isConsistentDuplicate(prev, rowVerdict.row)) continue;
            seen.delete(qid);
            reused.delete(qid);
            stats.inconsistentDuplicate = (stats.inconsistentDuplicate ?? 0) + 1;
            continue;
        }
        seen.set(qid, rowVerdict.row);
        reused.set(qid, {
            trace: rowVerdict.row.trace as unknown as QueryTrace,
            outcome: rowVerdict.row.outcome as unknown as QueryOutcome,
        });
        stats.reused = (stats.reused ?? 0) + 1;
    }
    return empty();
}

/** Exclusive-create 0600 for new checkpoint files; appends reuse the owned handle. */
function appendCheckpointRow(path: string, entry: CheckpointRow): void {
    const line = `${JSON.stringify(entry)}\n`;
    try {
        writeFileSync(path, line, { flag: "wx", mode: 0o600 });
    } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
        appendFileSync(path, line);
    }
}

const args = parseArgs(process.argv.slice(2));
const rows = ["set-a", "set-b"].flatMap((set) => loadRows(join(args.dataDir, `${set}.jsonl`)));
const byQuery = new Map<string, EvalRow[]>();
for (const row of rows) {
    const group = byQuery.get(row.qid) ?? [];
    group.push(row);
    byQuery.set(row.qid, group);
}
let qids = [...byQuery.keys()].sort();
if (args.onlyQueries) {
    const unknown = [...args.onlyQueries].filter((q) => !byQuery.has(q));
    if (unknown.length > 0) throw new Error(`Unknown qids: ${unknown.join(", ")}`);
    qids = qids.filter((q) => args.onlyQueries!.has(q));
}
if (args.limit !== null) qids = qids.slice(0, args.limit);
if (qids.length === 0) throw new Error("No queries selected");

// ── Corpus: frozen snapshot by default; explicit --root is marked mutable. ──
let corpusRoot = args.root;
let managedCorpus = false;
if (!corpusRoot) {
    corpusRoot = createSnapshotCorpus(SOURCE_REF);
    managedCorpus = true;
}
const root = corpusRoot;
const existingFiles = new Set<string>();
{
    const walk = (dir: string): void => {
        for (const name of readdirSync(dir).sort()) {
            if (name === ".git") continue;
            const full = join(dir, name);
            if (statSync(full).isDirectory()) walk(full);
            else existingFiles.add(relative(root, full).split(sep).join("/"));
        }
    };
    walk(root);
}
const fixtureValidation = validateFixture(rows, existingFiles);
// Fail BEFORE retrieval/network on fixture validation errors: invalid rows
// must never silently vanish from denominators. q02
// answerable-without-gold remains allowed (validateFixture never errors on
// it) and stays visible via fixtureCounts/q02 disposition.
if (fixtureValidation.errors.length > 0) {
    throw new Error(`fixture validation failed closed: ${fixtureValidation.errors.join("; ").slice(0, 500)}`);
}
// Query strings, golds, and flags ship as-is; the harness never edits them.
const manifestBefore = inventoryHash(root);
const fixtureSha = createHash("sha256")
    .update(readFileSync(join(args.dataDir, "set-a.jsonl")))
    .update(readFileSync(join(args.dataDir, "set-b.jsonl")))
    .digest("hex");
const code = codeUnderTest();
// Full run identity: HEAD+dirty list below is disclosure only. Content
// identity is the engine source hash over actual source bytes under the git
// root derived from this script's location. The temp absolute corpus path
// never feeds identity (corpus content hash does); a runtime-alias version
// limitation is explicit in retrievalConditions.
const scriptGitRoot = gitRootFromScript();
const manifest = {
    sourceRef: managedCorpus ? SOURCE_REF : null,
    corpusKind: managedCorpus ? "frozen-git-archive-snapshot" : "explicit-mutable-root",
    corpusRoot: root,
    corpusRootIdentityNote: "absolute temp path excluded from run identity; corpus content hash binds the run",
    inventoryFiles: manifestBefore.files,
    inventoryHashBefore: manifestBefore.hash,
    fixtureSha,
    fixtureCounts: {
        rows: fixtureValidation.totalRows,
        queries: fixtureValidation.totalQueries,
        declaredAnswerable: fixtureValidation.declaredAnswerableCount,
        evaluableAnswerable: fixtureValidation.evaluableAnswerableCount,
        unanswerable: fixtureValidation.unanswerableCount,
        goldRows: fixtureValidation.totalGoldRows,
        q02: fixtureValidation.q02Disposition,
    },
    codeUnderTest: code,
    codeDisclosureNote: "HEAD+dirty list is disclosure only; engineSourceHash is the content identity",
    engineSourceHash: engineSourceHash(scriptGitRoot),
    retrievalConditions: {
        semanticIndex: "none — no-index path (exact lexical + in-memory BM25 + AST symbol)",
        graphProvider: "none — pointer wave skipped",
        symbolChannel: "symbol channel uses default AST + ambient LSP bridge; server/runtime not frozen",
        perQueryLimit: 20,
        topKWindow: 20,
        topKMetricWindow: 5,
        contextLines: 2,
        workspaceRevision: "frozen 0 within process",
    },
    nodeVersion: process.version,
    gateConstants: { ...GATE_CONSTANTS },
    queryCount: qids.length,
    timeoutMs: args.timeoutMs,
};
const manifestBase = manifest;

mkdirSync(OUTPUT_DIR, { recursive: true });
const generatedAt = new Date().toISOString();
const knownQids = new Set(qids);
// Per-config full run identity (replaces the old qids-only fingerprint):
// ordered qids, fixture bytes, corpus content/inventory, SOURCE_REF, actual
// engine source bytes, Node version, model/origin alias, gate constants +
// applied override, params/context/timeout. Temp corpus paths excluded.
function fingerprintFor(config: ConfigName): string {
    const appliedKeepOverride = config === "off" ? null : CONFIG_THRESHOLD[config];
    const identity: RunIdentityInput = {
        orderedQids: [...qids].sort(),
        fixtureSha,
        corpusInventoryHash: manifestBefore.hash,
        corpusInventoryFiles: manifestBefore.files,
        corpusKind: managedCorpus ? "frozen-git-archive-snapshot" : "explicit-mutable-root",
        sourceRef: managedCorpus ? SOURCE_REF : null,
        engineSourceHash: manifestBase.engineSourceHash,
        nodeVersion: process.version,
        modelAlias: config === "off" ? "off" : (process.env.PI_SMARTREAD_JUDGE_MODEL ?? CLOUD_JUDGE_DEFAULT_MODEL),
        judgeOrigin: config === "off" ? "off" : "cloud-openrouter",
        gateConstants: { ...GATE_CONSTANTS },
        appliedKeepOverride,
        params: {
            perQueryLimit: 20,
            topKWindow: 20,
            topKMetricWindow: 5,
            contextLines: 2,
            workspaceRevision: "frozen 0 within process",
            queryCount: qids.length,
        },
        timeoutMs: args.timeoutMs,
    };
    return computeRunFingerprint(identity);
}
const tableRows: Array<QuerySummary & { config: ConfigName; declaredQueryCoverage: string; evaluableQueryCoverage: string }> = [];
let failed = false;
try {
    for (const config of args.configs) {
        let provider: GrepJudgeProvider | undefined;
        try {
            provider = createProvider(config, []);
        } catch (error) {
            console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
            failed = true;
            continue;
        }
        if (config === "off") delete process.env[GREP_JUDGE_THRESHOLD_ENV_VAR];
        else process.env[GREP_JUDGE_THRESHOLD_ENV_VAR] = CONFIG_THRESHOLD[config];
        const fingerprint = fingerprintFor(config);
        const cpPath = checkpointPath(config, fingerprint);
        const resume = args.resume && isKnownSourceHash(manifestBase.engineSourceHash)
            ? loadCheckpointValidated(cpPath, fingerprint, knownQids)
            : null;
        if (args.resume && !isKnownSourceHash(manifestBase.engineSourceHash)) {
            console.error(`[${config}] resume refused (unknown-code-identity); checkpoint left untouched, all queries rerun`);
        }
        if (resume?.refused) {
            console.error(`[${config}] resume refused (${resume.refused}); checkpoint left untouched, all queries rerun`);
        }
        const resumed = resume?.reused ?? new Map();
        const resumeStats = resume?.stats ?? null;
        const traces: QueryTrace[] = [];
        const outcomes: QueryOutcome[] = [];
        let resumedQueries = 0;
        let newQueries = 0;
        const sumUsage = (list: QueryTrace[]): JudgeUsage => ({
            inputTokens: list.reduce((a, t) => a + t.judgeCalls.reduce((x, c) => x + c.usage.inputTokens, 0), 0),
            requests: list.reduce((a, t) => a + t.judgeCalls.reduce((x, c) => x + c.usage.requests, 0), 0),
            costUsd: list.reduce((a, t) => a + t.judgeCalls.reduce((x, c) => x + (c.usage.costUsd ?? 0), 0), 0),
        });
        const resumedTraces: QueryTrace[] = [];
        for (const qid of qids) {
            const group = byQuery.get(qid)!;
            const golds = group.filter((r) => r.label === "gold" && r.answerable);
            const prior = resumed.get(qid);
            if (prior && prior.trace && prior.outcome && typeof prior.outcome.status === "string") {
                traces.push(prior.trace);
                outcomes.push(prior.outcome);
                resumedTraces.push(prior.trace);
                resumedQueries++;
                process.stdout.write(`[${config}] ${qid} ... resumed ${prior.outcome.status}\n`);
                continue;
            }
            process.stdout.write(`[${config}] ${qid} ... `);
            const { trace, outcome } = await runQuery({ qid, query: group[0]!.query, answerable: group[0]!.answerable, golds, root, judge: provider, timeoutMs: args.timeoutMs });
            traces.push(trace);
            outcomes.push(outcome);
            newQueries++;
            appendCheckpointRow(cpPath, { v: CHECKPOINT_SCHEMA_VERSION, fingerprint, trace, outcome } as CheckpointRow);
            console.log(`${outcome.status} recall=${outcome.goldRows > 0 ? `${outcome.coveredGoldRows}/${outcome.goldRows}` : "n/a"} renderedTok=${outcome.renderedTokens} legacyTok=${outcome.legacyTop5Tokens} ${Math.round(outcome.elapsedMs)}ms`);
        }
        const summary = summarizeQueries(outcomes);
        // Errors/degradation stay in the denominator: coverage over ALL
        // answerable queries (including error rows), never ok-only silently.
        const answerableAll = outcomes.filter((q) => q.answerable);
        const evaluableAll = answerableAll.filter((q) => q.goldRows > 0);
        const declaredCoverage = `${answerableAll.filter((q) => q.covered).length}/${answerableAll.length}`;
        const evaluableCoverage = `${evaluableAll.filter((q) => q.covered).length}/${evaluableAll.length}`;
        const degradedCount = summary.degraded;
        // knownGoldRecallAt5 is a known-fixture diagnostic, not a lower bound
        // of true recall (unknown positives can expand the denominator).
        // Drift is detected BEFORE publishing: an after-drift rejected status
        // lives IN the report/manifest, not just stderr. The report is still
        // written (preserved artifact), marked rejected, exit code 2.
        const manifestAfterConfig = inventoryHash(root);
        const drifted = manifestAfterConfig.hash !== manifestBefore.hash;
        if (drifted) failed = true;
        const report = {
            generatedAt,
            config,
            status: drifted ? "rejected:corpus-drift" : "complete",
            threshold: config === "off" ? null : CONFIG_THRESHOLD[config],
            appliedKeepOverrideOnly: config === "off" ? null : CONFIG_THRESHOLD[config],
            model: {
                alias: config === "off" ? "off" : (process.env.PI_SMARTREAD_JUDGE_MODEL ?? CLOUD_JUDGE_DEFAULT_MODEL),
                origin: config === "off" ? "off" : "cloud-openrouter",
            },
            runFingerprint: fingerprint,
            manifest: {
                ...manifestBase,
                inventoryHashAfter: manifestAfterConfig.hash,
                inventoryFilesAfter: manifestAfterConfig.files,
                corpusDrift: drifted
                    ? `drift ${manifestBefore.hash.slice(0, 12)} -> ${manifestAfterConfig.hash.slice(0, 12)}; results rejected`
                    : null,
            },
            fixtureValidation,
            resume: resumeStats ? { ...resumeStats, resumedQueries, newQueries } : { resumedQueries, newQueries },
            judgeUsage: {
                // Resumed usage is distinct from newly billed calls: never
                // silently counted as new, never dropped.
                resumed: sumUsage(resumedTraces),
                newlyBilled: sumUsage(traces.filter((t) => !resumedTraces.includes(t))),
            },
            degradedQueries: degradedCount,
            metricDefinitions: {
                renderedTokens: "ceil(renderedChars/4) over the EXACT guarded tool text (headers, notes, pointers, degradation lines included)",
                legacyTop5Tokens: "ceil(chars/4) over concatenated top-5 units rendered as '<relFile>:<line>-<endLine> <name>\\n<snippet>' (prior-harness scope, kept for comparison)",
                overlap: "same repo-relative file AND unit.line <= gold.endLine && unit.endLine >= gold.startLine",
                knownGoldRecallAt5: "known-fixture diagnostic: sum(covered known gold rows)/sum(known gold rows) over evaluable answerable queries (q02 has no gold rows). NOT a lower bound of true recall.",
                declaredQueryCoverage: "answerable qids with >=1 covered gold / ALL declared answerable qids (incl. q02, errors count as uncovered)",
                evaluableQueryCoverage: "answerable qids with >=1 covered gold / answerable qids with >=1 gold row (errors count as uncovered)",
                fileHitAt5: "evaluable qids with >=1 same-file top-5 hit / evaluable qids",
                abstentionCorrect: "unanswerable qids with (abstained || top-5 empty) / unanswerable qids",
            },
            summary: { ...summary, declaredQueryCoverage: declaredCoverage, evaluableQueryCoverage: evaluableCoverage },
            queries: traces,
        };
        if (drifted) {
            console.error(`error: corpus drift detected during run (${manifestBefore.hash.slice(0, 12)} -> ${manifestAfterConfig.hash.slice(0, 12)}); results rejected in report`);
        }
        const outputPath = join(OUTPUT_DIR, `grep-e2e-${config}-${generatedAt.replace(/[:.]/g, "-")}-p${process.pid}.json`);
        writeFileSync(outputPath, JSON.stringify(report, null, 2), { mode: 0o600 });
        console.log(`[${config}] report: ${relative(process.cwd(), outputPath).split(sep).join("/")} status=${report.status}`);
        tableRows.push({ config, ...summary, declaredQueryCoverage: declaredCoverage, evaluableQueryCoverage: evaluableCoverage });
    }
} catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    failed = true;
} finally {
    // Tear down language-server processes before leaving: without this
    // the harness hangs on live LSP child handles after the report.
    // Harness-only cleanup; production manager lifecycle is untouched.
    await shutdownAllManagers().catch((error) => {
        console.error(`warning: lsp shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    try {
        resetLSPBridge();
    } catch (error) {
        console.error(`warning: lsp bridge reset failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    disposeSemanticIndexes();
}

if (managedCorpus) {
    // Cleanup owns ONLY the temp dir created by this invocation; reports persist.
    rmSync(root, { recursive: true, force: true });
}

console.log("\nconfig | n | renderedTok/q | legacyTok/q | knownGoldR@5 | covered/total | declared | evaluable | fileHit | abstCorrect | errors");
for (const row of tableRows) {
    console.log(
        `${row.config} | ${row.queries} | ${Number(row.meanRenderedTokensPerQuery).toFixed(1)} | ` +
        `${Number(row.meanLegacyTop5TokensPerQuery).toFixed(1)} | ` +
        `${row.knownGoldRecallAt5 === null || row.knownGoldRecallAt5 === undefined ? "n/a" : Number(row.knownGoldRecallAt5).toFixed(4)} ` +
        `(${row.coveredGoldRows}/${row.totalGoldRows}) | ${row.declaredQueryCoverage} | ${row.evaluableQueryCoverage} | ` +
        `${row.fileHitAt5} | ${row.abstentionCorrect} | ${row.errors}`,
    );
}
if (failed) process.exitCode = 2;
