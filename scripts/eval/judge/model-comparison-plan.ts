/**
 * Offline full-run plan derivation for the judge model comparison.
 *
 * Unlike the heuristic `estimateFullRun()` (which assumes one batch per
 * query group), this module exercises the ACTUAL `CloudJudge` packing
 * code (`judgeNouls` batching over the ~24k-token budget) over ALL 44
 * query groups of the real corpus plus the planned warmup, for each of
 * the 3 requested model IDs — WITHOUT any network. A capturing stub
 * fetch returns well-formed fake answers (constant `p = 0.01`, explicitly
 * NOT performance gold: no fixture scores are consulted and no quality
 * metric is computed here) and records every wire request's bytes,
 * token heuristic, and question/state hashes.
 *
 * Set A and set B already use disjoint qid namespaces (`q01..q22` vs
 * `B*`/`U*`); groups are keyed `set:qid` regardless, so a future qid
 * collision could never silently merge groups.
 *
 * Frozen dimensions (not score-chosen): 5 replicates max, exactly the 3
 * requested models, all 314 items. Retry upper bound: the client ceiling
 * of 3 attempts per wire request.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CloudJudge } from "../../../src/judge/cloud-judge.js";
import { unitRelevanceQuestion } from "../../../src/judge/questions.js";
import type { JudgeNoulItem } from "../../../src/judge/types.js";
import { COMPARISON_MODELS, type ComparisonModel } from "./model-comparison.js";

export const PLAN_SOURCE_REF = "18f6463caa78e6657b1af6c7eb86b711bc2364f8";
export const PLAN_MAX_REPLICATES = 5;
export const PLAN_CLIENT_ATTEMPTS_PER_REQUEST = 3;
export const PLAN_QUESTION_BUILDER = "unitRelevanceQuestion";
/** Code SDK whose packing is exercised (import specifier, not a version guess). */
export const PLAN_PACKING_SDK = "../../../src/judge/cloud-judge.js#CloudJudge.judgeNouls";
export const PLAN_DATA_DIR = join(homedir(), ".cache/pi-smartread-judge-spike/eval");

/**
 * Served snapshot pins (identity facts): Jev/Luna recorded 2026-10-07;
 * the PPLX arm pin re-pinned to the v1.1 snapshot re-verified
 * 2026-10-09 under protocol Amendment A2 (pre-data model switch).
 */
export const PLAN_SERVED_PINS: Record<ComparisonModel, string> = {
    "~typesafe/jev-latest": "typesafe/jev-1.13-20260917",
    "perplexity/pplx-decider-v1.1-27b": "perplexity/pplx-decider-v1.1-27b-20261006",
    "openai/gpt-6-luna-decisions": "openai/gpt-6-luna-decisions-20261006",
};

export interface PlanFixtureRow {
    set: "a" | "b";
    qid: string;
    query: string;
    file: string;
    startLine: number;
    endLine: number;
    symbol: string | null;
    label: "gold" | "hard_negative" | "easy_negative";
}

export interface PlanWireObservation {
    groupKey: string;
    model: ComparisonModel;
    requestBytes: number;
    estimatedTokens: number;
    questionCount: number;
    questionHash: string;
    stateHash: string;
}

export interface DerivedFullRunPlan {
    fixtureSha: string;
    fixtureSets: Array<{ set: string; rows: number; queries: number }>;
    totalUnits: number;
    totalQueryGroups: number;
    labelCounts: Record<PlanFixtureRow["label"], number>;
    questionBuilder: typeof PLAN_QUESTION_BUILDER;
    packingSdk: typeof PLAN_PACKING_SDK;
    codeRef: typeof PLAN_SOURCE_REF;
    servedPins: typeof PLAN_SERVED_PINS;
    models: ComparisonModel[];
    maxReplicates: number;
    /** Measured wire requests for one full single-replicate run (warmups + groups). */
    plannedWireRequestsSingleRun: number;
    warmupRequestsSingleRun: number;
    groupWireRequestsSingleRun: number;
    groupsRequiringSplit: string[];
    maxRequestBytes: number;
    maxEstimatedTokensPerRequest: number;
    /** 5-replicate planned total (measured single-run x 5). */
    fiveReplicatePlannedRequests: number;
    /** Upper bound incl. client retry ceiling (x3 attempts each) + 6 historical attempts. */
    attemptUpperBound: number;
    observations: PlanWireObservation[];
}

function sha256Hex(value: string): string {
    return createHash("sha256").update(value, "utf-8").digest("hex");
}

export function loadSetRows(set: "a" | "b", dataDir: string): { rows: PlanFixtureRow[]; rawBytes: string } {
    const path = join(dataDir, `set-${set}.jsonl`);
    const rawBytes = readFileSync(path, "utf-8");
    const rows = rawBytes.split(/\r?\n/).filter(Boolean).map((line, index) => {
        let value: unknown;
        try {
            value = JSON.parse(line);
        } catch {
            throw new Error(`${path}:${index + 1}: invalid JSON`);
        }
        const row = value as Record<string, unknown>;
        if (typeof row.qid !== "string" || typeof row.query !== "string" || typeof row.file !== "string" ||
            !Number.isInteger(row.startLine) || !Number.isInteger(row.endLine) ||
            !["gold", "hard_negative", "easy_negative"].includes(String(row.label))) {
            throw new Error(`${path}:${index + 1}: invalid evaluation row`);
        }
        return {
            set, qid: row.qid as string, query: row.query as string, file: row.file as string,
            startLine: row.startLine as number, endLine: row.endLine as number,
            symbol: (row.symbol as string | null) ?? null, label: row.label as PlanFixtureRow["label"],
        };
    });
    if (rows.length === 0) throw new Error(`No evaluation rows in ${path}`);
    return { rows, rawBytes };
}

function sourceRange(repoRoot: string, file: string, startLine: number, endLine: number, symbol: string | null): string {
    if (file.startsWith("/") || file.split(/[\\/]/).includes("..") || !(file.startsWith("src/") || file.startsWith("test/"))) {
        throw new Error(`Refusing non-repository eval path: ${file}`);
    }
    const source = execFileSync("git", ["show", `${PLAN_SOURCE_REF}:${file}`], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
    });
    const lines = source.split(/\r?\n/);
    if (endLine > lines.length || endLine - startLine + 1 > 120) {
        throw new Error(`Invalid pinned source range ${file}:${startLine}-${endLine}`);
    }
    const code = lines.slice(startLine - 1, endLine).map((line, index) => `${startLine + index}|${line}`).join("\n");
    return `${file}:${startLine}-${endLine}${symbol ? ` ${symbol}` : ""}\n${code}`.slice(0, 3500);
}

function toItems(rows: PlanFixtureRow[], repoRoot: string): { query: string; items: JudgeNoulItem[] } {
    const query = rows[0]!.query;
    const items: JudgeNoulItem[] = rows.map((row, index) => ({
        id: `u${index}`,
        state: { path: row.file, symbol: row.symbol ?? "", text: sourceRange(repoRoot, row.file, row.startLine, row.endLine, row.symbol) },
        question: (stateRef: string) => unitRelevanceQuestion(query, stateRef),
    }));
    return { query, items };
}

/**
 * Derive the exact full-run wire plan offline. `repoRoot` anchors the
 * `git show` source materialization (same as the scored runner).
 */
export async function deriveFullRunPlan(
    opts: { repoRoot: string; dataDir?: string; models?: ComparisonModel[] } ,
): Promise<DerivedFullRunPlan> {
    const dataDir = opts.dataDir ?? PLAN_DATA_DIR;
    const models = opts.models ?? [...COMPARISON_MODELS];
    if (models.length !== COMPARISON_MODELS.length || !COMPARISON_MODELS.every((m) => models.includes(m))) {
        throw new Error("Plan derivation requires exactly the 3 requested models (no score-chosen subset)");
    }
    const a = loadSetRows("a", dataDir);
    const b = loadSetRows("b", dataDir);
    const fixtureSha = sha256Hex(a.rawBytes + b.rawBytes);
    const allRows = [...a.rows, ...b.rows];

    const groups = new Map<string, PlanFixtureRow[]>();
    for (const row of allRows) {
        const key = `${row.set}:${row.qid}`;
        const group = groups.get(key) ?? [];
        group.push(row);
        groups.set(key, group);
    }

    const labelCounts: Record<PlanFixtureRow["label"], number> = { gold: 0, hard_negative: 0, easy_negative: 0 };
    for (const row of allRows) labelCounts[row.label] += 1;

    const observations: PlanWireObservation[] = [];
    let groupWire = 0;
    let warmupWire = 0;
    let maxRequestBytes = 0;
    let maxEstimatedTokensPerRequest = 0;
    const groupsRequiringSplit: string[] = [];

    // Planned warmup mirrors the scored runner: first row, single item.
    const warmRow = allRows[0]!;
    const warmBuilt = toItems([{ ...warmRow }], opts.repoRoot);

    for (const model of models) {
        // Warmup requests (one per model arm per single run).
        {
            let n = 0;
            const stub = capturingStub(() => { n += 1; });
            const judge = new CloudJudge({ apiKey: "offline-plan", model, cache: null, fetchFn: stub, sleepFn: async () => { throw new Error("offline-plan: no retries"); } });
            await judge.judgeNouls({ shared: { query: warmBuilt.query }, items: warmBuilt.items });
            warmupWire += n;
        }
        for (const [groupKey, rows] of groups) {
            const { query, items } = toItems(rows, opts.repoRoot);
            let n = 0;
            const stub = capturingStub((obs) => {
                n += 1;
                maxRequestBytes = Math.max(maxRequestBytes, obs.requestBytes);
                maxEstimatedTokensPerRequest = Math.max(maxEstimatedTokensPerRequest, obs.estimatedTokens);
                observations.push({ groupKey, model, ...obs });
            });
            const judge = new CloudJudge({ apiKey: "offline-plan", model, cache: null, fetchFn: stub, sleepFn: async () => { throw new Error("offline-plan: no retries"); } });
            await judge.judgeNouls({ shared: { query }, items });
            groupWire += n;
            if (n > 1 && !groupsRequiringSplit.includes(groupKey)) groupsRequiringSplit.push(groupKey);
        }
    }

    const singleRun = warmupWire + groupWire;
    const fiveReplicatePlannedRequests = singleRun * PLAN_MAX_REPLICATES;
    // Upper bound: every planned wire request billed at the retry ceiling,
    // plus the 6 historical paid attempts already on the campaign books.
    const attemptUpperBound = fiveReplicatePlannedRequests * PLAN_CLIENT_ATTEMPTS_PER_REQUEST + VERIFIED_PRIOR_SEED_ATTEMPTS;

    return {
        fixtureSha,
        fixtureSets: [
            { set: "a", rows: a.rows.length, queries: new Set(a.rows.map((r) => r.qid)).size },
            { set: "b", rows: b.rows.length, queries: new Set(b.rows.map((r) => r.qid)).size },
        ],
        totalUnits: allRows.length,
        totalQueryGroups: groups.size,
        labelCounts,
        questionBuilder: PLAN_QUESTION_BUILDER,
        packingSdk: PLAN_PACKING_SDK,
        codeRef: PLAN_SOURCE_REF,
        servedPins: { ...PLAN_SERVED_PINS },
        models: [...models],
        maxReplicates: PLAN_MAX_REPLICATES,
        plannedWireRequestsSingleRun: singleRun,
        warmupRequestsSingleRun: warmupWire,
        groupWireRequestsSingleRun: groupWire,
        groupsRequiringSplit,
        maxRequestBytes,
        maxEstimatedTokensPerRequest,
        fiveReplicatePlannedRequests,
        attemptUpperBound,
        observations,
    };
}

const VERIFIED_PRIOR_SEED_ATTEMPTS = 6;

/**
 * Capturing stub fetch: returns well-formed fake answers (constant
 * `p = 0.01` for every submitted question) and records wire metadata.
 * The constant is explicitly NOT performance gold — it carries no
 * fixture information and no quality metric may be computed from it.
 */
function capturingStub(onRequest: (obs: { requestBytes: number; estimatedTokens: number; questionCount: number; questionHash: string; stateHash: string }) => void) {
    return async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { questions?: Record<string, unknown>; state?: unknown };
        const questions = body.questions ?? {};
        const questionHash = sha256Hex(JSON.stringify(questions));
        const stateHash = sha256Hex(JSON.stringify(body.state ?? null));
        const requestBytes = String(init?.body ?? "").length;
        const estimatedTokens = Math.ceil(requestBytes / 4);
        onRequest({ requestBytes, estimatedTokens, questionCount: Object.keys(questions).length, questionHash, stateHash });
        const answers: Record<string, number> = {};
        for (const key of Object.keys(questions)) answers[key] = 0.01;
        return new Response(
            JSON.stringify({ id: "gen-offline-plan", model: "offline/stub", provider: "offline", answers, usage: { input_tokens: 0, cost: 0 } }),
            { status: 200, headers: { "content-type": "application/json" } },
        );
    };
}

/** Pure helper: replicate/attempt arithmetic over measured batch counts. */
export function scalePlannedRequests(singleRunWireRequests: number, replicates: number, attemptsPerRequest: number): number {
    if (!Number.isInteger(singleRunWireRequests) || singleRunWireRequests <= 0) throw new Error("singleRunWireRequests must be a positive integer");
    if (!Number.isInteger(replicates) || replicates < 1 || replicates > PLAN_MAX_REPLICATES) {
        throw new Error(`replicates must be 1..${PLAN_MAX_REPLICATES}`);
    }
    if (!Number.isInteger(attemptsPerRequest) || attemptsPerRequest < 1) throw new Error("attemptsPerRequest must be a positive integer");
    return singleRunWireRequests * replicates * attemptsPerRequest;
}
