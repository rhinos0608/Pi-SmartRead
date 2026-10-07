/**
 * Local judge: von sidecar `POST {baseUrl}/v1/systemone`.
 *
 * Strategy: one request per item with state `{...shared, unit: item.state}`
 * and `question("unit")`; items whose estimated size exceeds ~7000 tokens
 * are skipped with `unit_too_large` (never rely on server truncation).
 * Requests are serialized per endpoint (at most one in-flight request per
 * baseUrl, process-wide): von's MPS backend aborts the whole server process
 * on overlapping inference. The endpoint baseUrl is supplied by the caller
 * (the sidecar manager comes later).
 */
import { JudgeCache, JUDGE_CACHE_CANONICAL_REF, judgeCacheKey } from "./judge-cache.js";
import { estimateTokens } from "./cloud-judge.js";
import { postSystemOneDecisions, type FetchFn, type SleepFn } from "./systemone-client.js";
import type { Judge, JudgeBackendInfo, JudgeNoulInput, JudgeNoulResult, JsonValue } from "./types.js";
import { answerProbability } from "./types.js";

export const LOCAL_JUDGE_ROUTE = "/v1/systemone";
export const LOCAL_JUDGE_DEFAULT_MODEL = "von";
export const LOCAL_JUDGE_MAX_TOKENS = 7000;

/**
 * Process-wide per-endpoint serialization: at most one in-flight request per
 * baseUrl across all calls and LocalJudge instances. A rejected request
 * rejects its own caller, but the stored tail swallows the rejection so
 * queued requests still run. Settled tails are removed so the map does not
 * grow; different baseUrls proceed independently.
 */
const endpointTails = new Map<string, Promise<unknown>>();

function runSerialized<T>(baseUrl: string, task: () => Promise<T>): Promise<T> {
    const prev = endpointTails.get(baseUrl) ?? Promise.resolve();
    const next = prev.then(task);
    const tail = next.catch(() => {});
    endpointTails.set(baseUrl, tail);
    const release = () => {
        if (endpointTails.get(baseUrl) === tail) endpointTails.delete(baseUrl);
    };
    next.then(release, release);
    return next;
}

export interface LocalJudgeOptions {
    baseUrl: string;
    model?: string;
    cacheDir?: string;
    cache?: JudgeCache | null;
    fetchFn?: FetchFn;
    sleepFn?: SleepFn;
}

export class LocalJudge implements Judge {
    readonly info: JudgeBackendInfo;
    private readonly cache: JudgeCache | null;
    private readonly fetchFn?: FetchFn;
    private readonly sleepFn?: SleepFn;

    constructor(opts: LocalJudgeOptions) {
        const model = opts.model ?? LOCAL_JUDGE_DEFAULT_MODEL;
        this.info = { backend: "local", model, baseUrl: opts.baseUrl };
        this.cache = opts.cache === null ? null : (opts.cache ?? (opts.cacheDir ? new JudgeCache(opts.cacheDir) : null));
        this.fetchFn = opts.fetchFn;
        this.sleepFn = opts.sleepFn;
    }

    async judgeNouls(input: JudgeNoulInput, signal?: AbortSignal): Promise<JudgeNoulResult> {
        const p = new Map<string, number>();
        const unjudged: Array<{ id: string; code: string }> = [];
        const usage = { inputTokens: 0, requests: 0 };
        let cacheHits = 0;

        const tasks: Array<() => Promise<{ id: string; value: number | undefined; cacheKey: string }>> = [];
        for (const item of input.items) {
            const question = item.question("unit");
            const cacheKey = this.cache
                ? judgeCacheKey({
                    model: this.info.model,
                    shared: input.shared,
                    state: item.state,
                    question: item.question(JUDGE_CACHE_CANONICAL_REF),
                })
                : "";
            const hit = cacheKey ? this.cache?.get(cacheKey) : undefined;
            if (hit !== undefined) {
                p.set(item.id, hit);
                cacheHits++;
                continue;
            }
            const state: Record<string, JsonValue> = { ...input.shared, unit: item.state };
            if (estimateTokens(state) + estimateTokens(question) > LOCAL_JUDGE_MAX_TOKENS) {
                unjudged.push({ id: item.id, code: "unit_too_large" });
                continue;
            }
            tasks.push(async () => {
                const res = await postSystemOneDecisions({
                    baseUrl: this.info.baseUrl,
                    route: LOCAL_JUDGE_ROUTE,
                    model: this.info.model,
                    state,
                    questions: { q: question },
                    signal,
                    fetchFn: this.fetchFn,
                    sleepFn: this.sleepFn,
                });
                const v = res.answers.q;
                // Gates consume the pre-band posterior, never the banded commit.
                return { id: item.id, value: v === undefined ? undefined : answerProbability(v, true), cacheKey };
            });
        }
        const settled = await Promise.all(tasks.map((task) => runSerialized(this.info.baseUrl, task)));
        for (const { id, value, cacheKey } of settled) {
            usage.requests += 1;
            if (value === undefined) {
                unjudged.push({ id, code: "bad_response" });
            } else {
                p.set(id, value);
                if (cacheKey) this.cache?.set(cacheKey, value);
            }
        }
        return { p, unjudged, usage, cacheHits };
    }
}
