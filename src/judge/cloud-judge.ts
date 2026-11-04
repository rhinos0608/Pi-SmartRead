/**
 * Cloud judge: TypeSafe Jev via OpenRouter `POST {base}/decisions`.
 *
 * Strategy: item states are nested under `shared.units.<id>`; questions are
 * packed into as few requests as fit a ~24k estimated-token budget
 * (chars/4) for state+questions; overflow splits into multiple requests run
 * with concurrency <= 4. `usage.cost` maps to `costUsd`.
 *
 * Per-model methods (owner ruling D-80): the request shape is selected by
 * `judgeMethodForModel` on the exact model id. M0 keeps this packed
 * behavior; M1 sends one singleton request per candidate; M2 sends the
 * packed forward request plus the exact-reverse packed request and scores
 * `(forward + reverse) / 2` per candidate. Unknown models fail safe to M0.
 */
import { JudgeCache, JUDGE_CACHE_CANONICAL_REF, judgeCacheKey } from "./judge-cache.js";
import { judgeMethodForModel } from "./judge-method.js";
import { postSystemOneDecisions, type FetchFn, type SleepFn, type SystemOneResponse } from "./systemone-client.js";
import type {
    Judge,
    JudgeBackendInfo,
    JudgeNoulInput,
    JudgeNoulResult,
    JsonValue,
    NoulQuestion,
} from "./types.js";
import { answerProbability } from "./types.js";

export const CLOUD_JUDGE_DEFAULT_BASE_URL = "https://openrouter.ai/api/alpha";
export const CLOUD_JUDGE_DEFAULT_MODEL = "~typesafe/jev-latest";
export const CLOUD_JUDGE_ROUTE = "/decisions";
export const CLOUD_JUDGE_TOKEN_BUDGET = 24_000;
const CLOUD_JUDGE_CONCURRENCY = 4;

export interface CloudJudgeOptions {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    cacheDir?: string;
    cache?: JudgeCache | null;
    fetchFn?: FetchFn;
    sleepFn?: SleepFn;
}

export interface CloudJudgePendingEntry {
    id: string;
    question: NoulQuestion;
    cacheKey: string;
}

interface CloudJudgeUsageAccum {
    inputTokens: number;
    costUsd: number | undefined;
    requests: number;
}

/** Shared per-call context threaded through the packed/isolated/forward-reverse paths. */
interface CloudJudgeBatchCtx {
    shared: Record<string, JsonValue>;
    statesById: Map<string, Record<string, JsonValue>>;
    p: Map<string, number>;
    unjudged: Array<{ id: string; code: string }>;
    usage: CloudJudgeUsageAccum;
    signal?: AbortSignal;
}

export function estimateTokens(value: unknown): number {
    const len = JSON.stringify(value)?.length ?? 0;
    return Math.ceil(len / 4);
}

export function estimateTokensChars(chars: number): number {
    return Math.ceil(chars / 4);
}

async function runWithLimit<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
    const results: T[] = new Array(tasks.length);
    let next = 0;
    const workers = new Array(Math.min(limit, tasks.length)).fill(0).map(async () => {
        while (next < tasks.length) {
            const i = next++;
            results[i] = await tasks[i]!();
        }
    });
    await Promise.all(workers);
    return results;
}

export class CloudJudge implements Judge {
    readonly info: JudgeBackendInfo;
    private readonly apiKey?: string;
    private readonly cache: JudgeCache | null;
    private readonly fetchFn?: FetchFn;
    private readonly sleepFn?: SleepFn;

    constructor(opts: CloudJudgeOptions = {}) {
        const baseUrl = opts.baseUrl ?? CLOUD_JUDGE_DEFAULT_BASE_URL;
        const model = opts.model ?? CLOUD_JUDGE_DEFAULT_MODEL;
        this.info = { backend: "cloud", model, baseUrl };
        this.apiKey = opts.apiKey;
        this.cache = opts.cache === null ? null : (opts.cache ?? (opts.cacheDir ? new JudgeCache(opts.cacheDir) : null));
        this.fetchFn = opts.fetchFn;
        this.sleepFn = opts.sleepFn;
    }

    async judgeNouls(input: JudgeNoulInput, signal?: AbortSignal): Promise<JudgeNoulResult> {
        const p = new Map<string, number>();
        const unjudged: Array<{ id: string; code: string }> = [];
        const usage = { inputTokens: 0, costUsd: undefined as number | undefined, requests: 0 };
        let cacheHits = 0;

        // Per-model methods (D-80): M0 keeps the packed behavior; M1/M2
        // reuse the same client, token-budget packing, and failure
        // semantics; only the request shape, score aggregation, and the
        // cache-key method component differ.
        const method = judgeMethodForModel(this.info.model);

        // Cache pass: build per-item questions with the cloud state ref so
        // instructions reference the right path (`units.<id>`).
        const pending: Array<{ id: string; question: NoulQuestion; cacheKey: string }> = [];
        for (const item of input.items) {
            const question = item.question(`units.${item.id}`);
            const key = this.cache
                ? judgeCacheKey({
                    backend: this.info.backend,
                    baseUrl: this.info.baseUrl,
                    model: this.info.model,
                    shared: input.shared,
                    state: item.state,
                    question: item.question(JUDGE_CACHE_CANONICAL_REF),
                    method,
                })
                : "";
            const hit = key ? this.cache?.get(key) : undefined;
            if (hit !== undefined) {
                p.set(item.id, hit);
                cacheHits++;
            } else {
                pending.push({ id: item.id, question, cacheKey: key });
            }
        }

        const statesById = new Map(input.items.map((i) => [i.id, i.state]));
        const ctx: CloudJudgeBatchCtx = { shared: input.shared, statesById, p, unjudged, usage, signal };
        if (method === "M1") {
            await this.judgeIsolated(ctx, pending);
        } else if (method === "M2") {
            await this.judgeForwardReverse(ctx, pending);
        } else {
            await this.judgePacked(ctx, pending);
        }
        const outUsage: JudgeNoulResult["usage"] =
            usage.costUsd === undefined
                ? { inputTokens: usage.inputTokens, requests: usage.requests }
                : { inputTokens: usage.inputTokens, costUsd: usage.costUsd, requests: usage.requests };
        return { p, unjudged, usage: outUsage, cacheHits };
    }

    /**
     * M0: pack pending questions — shared state + per-item states under
     * `shared.units.<id>`, splitting when the token budget is exceeded.
     * Unchanged production behavior; the per-model dispatch calls it for
     * Jev and unknown models.
     */
    private async judgePacked(
        ctx: CloudJudgeBatchCtx,
        pending: CloudJudgePendingEntry[],
    ): Promise<void> {
        const batches = this.packEntries(ctx, pending);
        const tasks = batches.map((batch) => () => this.postPackedBatch(ctx, batch));
        const settled = await runWithLimit(tasks, CLOUD_JUDGE_CONCURRENCY);
        for (const { batch, res } of settled) {
            this.accumulateUsage(ctx.usage, res);
            for (const entry of batch) {
                const v = res.answers[entry.id];
                const prob = v === undefined ? undefined : answerProbability(v, false);
                if (prob === undefined) {
                    ctx.unjudged.push({ id: entry.id, code: "bad_response" });
                } else {
                    ctx.p.set(entry.id, prob);
                    if (entry.cacheKey) this.cache?.set(entry.cacheKey, prob);
                }
            }
        }
    }

    /**
     * M1: one singleton request per candidate — the same question
     * template and packing as M0 over a singleton (a singleton never
     * splits), matching the study's `buildM1Request`. Concurrency stays
     * within the existing limit and the caller signal is honored per
     * request. A failing sub-request rejects the whole call, matching
     * today's single-request failure semantics (the caller falls back to
     * unjudged); a non-numeric answer marks only that candidate unjudged.
     */
    private async judgeIsolated(
        ctx: CloudJudgeBatchCtx,
        pending: CloudJudgePendingEntry[],
    ): Promise<void> {
        const tasks = pending.map((entry) => () => this.postPackedBatch(ctx, [entry]));
        const settled = await runWithLimit(tasks, CLOUD_JUDGE_CONCURRENCY);
        for (const { batch, res } of settled) {
            this.accumulateUsage(ctx.usage, res);
            const entry = batch[0]!;
            const v = res.answers[entry.id];
            const prob = v === undefined ? undefined : answerProbability(v, false);
            if (prob === undefined) {
                ctx.unjudged.push({ id: entry.id, code: "bad_response" });
            } else {
                ctx.p.set(entry.id, prob);
                if (entry.cacheKey) this.cache?.set(entry.cacheKey, prob);
            }
        }
    }

    /**
     * M2: the packed forward request over the canonical pending order
     * plus the packed reverse request over the exact reversed order (one
     * order drives units and questions in each leg, as the study's
     * `buildM0Request`/`buildM2Reverse` pair). Per-candidate score is
     * `(forward + reverse) / 2`; a candidate missing a usable answer on
     * either leg is unjudged, never filled from the surviving leg. A
     * failing leg rejects the whole call — never a silent forward-only
     * fallback. At most twice the M0 request count, legs sequential
     * within the existing concurrency limit.
     */
    private async judgeForwardReverse(
        ctx: CloudJudgeBatchCtx,
        pending: CloudJudgePendingEntry[],
    ): Promise<void> {
        const forwardProbs = await this.judgePackedLeg(ctx, this.packEntries(ctx, pending));
        const reverseProbs = await this.judgePackedLeg(ctx, this.packEntries(ctx, [...pending].reverse()));
        for (const entry of pending) {
            const forward = forwardProbs.get(entry.id);
            const reverse = reverseProbs.get(entry.id);
            if (forward === undefined || reverse === undefined) {
                ctx.unjudged.push({ id: entry.id, code: "bad_response" });
            } else {
                const prob = (forward + reverse) / 2;
                ctx.p.set(entry.id, prob);
                if (entry.cacheKey) this.cache?.set(entry.cacheKey, prob);
            }
        }
    }

    /** Run one packed leg (M0 batch list or one M2 direction), returning per-candidate wire probabilities. */
    private async judgePackedLeg(
        ctx: CloudJudgeBatchCtx,
        batches: CloudJudgePendingEntry[][],
    ): Promise<Map<string, number | undefined>> {
        const probs = new Map<string, number | undefined>();
        const tasks = batches.map((batch) => () => this.postPackedBatch(ctx, batch));
        const settled = await runWithLimit(tasks, CLOUD_JUDGE_CONCURRENCY);
        for (const { batch, res } of settled) {
            this.accumulateUsage(ctx.usage, res);
            for (const entry of batch) {
                const v = res.answers[entry.id];
                probs.set(entry.id, v === undefined ? undefined : answerProbability(v, false));
            }
        }
        return probs;
    }

    /**
     * Greedy token-budget packing: per-entry question over `units.<id>`,
     * shared state re-seeded per batch. One entry order drives both
     * units and questions, so packing the reversed pending list yields
     * the exact-reverse request.
     */
    private packEntries(
        ctx: CloudJudgeBatchCtx,
        entries: CloudJudgePendingEntry[],
    ): CloudJudgePendingEntry[][] {
        const sharedTokens = estimateTokens(ctx.shared);
        const batches: CloudJudgePendingEntry[][] = [];
        let current: CloudJudgePendingEntry[] = [];
        let currentTokens = sharedTokens;
        for (const entry of entries) {
            const entryTokens =
                estimateTokens({ [entry.id]: ctx.statesById.get(entry.id) }) + estimateTokens(entry.question);
            if (current.length > 0 && currentTokens + entryTokens > CLOUD_JUDGE_TOKEN_BUDGET) {
                batches.push(current);
                current = [];
                currentTokens = sharedTokens;
            }
            current.push(entry);
            currentTokens += entryTokens;
        }
        if (current.length > 0) batches.push(current);
        return batches;
    }

    /** Post one packed batch: `units`/`questions` keyed by candidate id under the shared state. */
    private postPackedBatch(
        ctx: CloudJudgeBatchCtx,
        batch: CloudJudgePendingEntry[],
    ): Promise<{ batch: CloudJudgePendingEntry[]; res: SystemOneResponse }> {
        const units: Record<string, JsonValue> = {};
        const questions: Record<string, NoulQuestion> = {};
        for (const entry of batch) {
            units[entry.id] = ctx.statesById.get(entry.id) ?? {};
            questions[entry.id] = entry.question;
        }
        const state: Record<string, JsonValue> = { ...ctx.shared, units };
        return postSystemOneDecisions({
            baseUrl: this.info.baseUrl,
            route: CLOUD_JUDGE_ROUTE,
            model: this.info.model,
            state,
            questions,
            apiKey: this.apiKey,
            signal: ctx.signal,
            fetchFn: this.fetchFn,
            sleepFn: this.sleepFn,
        }).then((res) => ({ batch, res }));
    }

    private accumulateUsage(usage: CloudJudgeUsageAccum, res: SystemOneResponse): void {
        usage.requests += 1;
        usage.inputTokens += res.usage.inputTokens;
        if (res.usage.costUsd !== undefined) usage.costUsd = (usage.costUsd ?? 0) + res.usage.costUsd;
    }
}
