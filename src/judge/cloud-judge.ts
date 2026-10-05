/**
 * Cloud judge: TypeSafe Jev via OpenRouter `POST {base}/decisions`.
 *
 * Strategy: item states are nested under `shared.units.<id>`; questions are
 * packed into as few requests as fit a ~24k estimated-token budget
 * (chars/4) for state+questions; overflow splits into multiple requests run
 * with concurrency <= 4. `usage.cost` maps to `costUsd`.
 */
import { JudgeCache, JUDGE_CACHE_CANONICAL_REF, judgeCacheKey } from "./judge-cache.js";
import { postSystemOneDecisions, type FetchFn, type SleepFn } from "./systemone-client.js";
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

        // Cache pass: build per-item questions with the cloud state ref so
        // instructions reference the right path (`units.<id>`).
        const pending: Array<{ id: string; question: NoulQuestion; cacheKey: string }> = [];
        for (const item of input.items) {
            const question = item.question(`units.${item.id}`);
            const key = this.cache
                ? judgeCacheKey({
                    model: this.info.model,
                    shared: input.shared,
                    state: item.state,
                    question: item.question(JUDGE_CACHE_CANONICAL_REF),
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

        // Pack pending questions: shared state + per-item states under
        // shared.units.<id>, splitting when the budget is exceeded.
        const sharedTokens = estimateTokens(input.shared);
        const batches: Array<typeof pending> = [];
        let current: typeof pending = [];
        let currentTokens = sharedTokens;
        const statesById = new Map(input.items.map((i) => [i.id, i.state]));
        for (const entry of pending) {
            const entryTokens =
                estimateTokens({ [entry.id]: statesById.get(entry.id) }) + estimateTokens(entry.question);
            if (current.length > 0 && currentTokens + entryTokens > CLOUD_JUDGE_TOKEN_BUDGET) {
                batches.push(current);
                current = [];
                currentTokens = sharedTokens;
            }
            current.push(entry);
            currentTokens += entryTokens;
        }
        if (current.length > 0) batches.push(current);

        const tasks = batches.map((batch) => async () => {
            const units: Record<string, JsonValue> = {};
            const questions: Record<string, NoulQuestion> = {};
            for (const entry of batch) {
                units[entry.id] = statesById.get(entry.id) ?? {};
                questions[entry.id] = entry.question;
            }
            const state: Record<string, JsonValue> = { ...input.shared, units };
            const res = await postSystemOneDecisions({
                baseUrl: this.info.baseUrl,
                route: CLOUD_JUDGE_ROUTE,
                model: this.info.model,
                state,
                questions,
                apiKey: this.apiKey,
                signal,
                fetchFn: this.fetchFn,
                sleepFn: this.sleepFn,
            });
            return { batch, res };
        });
        const settled = await runWithLimit(tasks, CLOUD_JUDGE_CONCURRENCY);
        for (const { batch, res } of settled) {
            usage.requests += 1;
            usage.inputTokens += res.usage.inputTokens;
            if (res.usage.costUsd !== undefined) usage.costUsd = (usage.costUsd ?? 0) + res.usage.costUsd;
            for (const entry of batch) {
                const v = res.answers[entry.id];
                const prob = v === undefined ? undefined : answerProbability(v, false);
                if (prob === undefined) {
                    unjudged.push({ id: entry.id, code: "bad_response" });
                } else {
                    p.set(entry.id, prob);
                    if (entry.cacheKey) this.cache?.set(entry.cacheKey, prob);
                }
            }
        }
        const outUsage: JudgeNoulResult["usage"] =
            usage.costUsd === undefined
                ? { inputTokens: usage.inputTokens, requests: usage.requests }
                : { inputTokens: usage.inputTokens, costUsd: usage.costUsd, requests: usage.requests };
        return { p, unjudged, usage: outUsage, cacheHits };
    }
}
