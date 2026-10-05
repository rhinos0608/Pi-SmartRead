/**
 * Minimal HTTP client for the shared SystemOne wire shape.
 *
 * POST {model, state, questions} to baseUrl+route with an optional bearer
 * key, per-attempt timeout, retries, and redacted errors (never the key or
 * request body).
 */
import type { JudgeAnswers, JudgeErrorCode, JudgeQuestion, JsonValue } from "./types.js";
import { JudgeError } from "./types.js";

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;
export type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>;

export interface SystemOneRequest {
    baseUrl: string;
    route: string;
    model: string;
    state: Record<string, JsonValue>;
    questions: Record<string, JudgeQuestion>;
    apiKey?: string;
    signal?: AbortSignal;
    fetchFn?: FetchFn;
    sleepFn?: SleepFn;
}

export interface SystemOneResponse {
    answers: JudgeAnswers;
    usage: { inputTokens: number; costUsd?: number };
}

const PER_ATTEMPT_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;
const MAX_BACKOFF_MS = 5000;

const defaultSleep: SleepFn = (ms, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) {
        reject(new JudgeError("aborted", "aborted"));
        return;
    }
    const onAbort = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(new JudgeError("aborted", "aborted"));
    };
    const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
});

function backoffMs(attempt: number): number {
    return Math.min(500 * 2 ** attempt, MAX_BACKOFF_MS);
}

function retryAfterMs(headers: Headers): number | undefined {
    const raw = headers.get("retry-after") ?? headers.get("retry-after-ms");
    if (raw == null) return undefined;
    const n = Number(raw.trim().split(",")[0]);
    if (!Number.isFinite(n) || n < 0) return undefined;
    // retry-after is seconds; retry-after-ms is milliseconds. Distinguish by header name.
    const isMs = headers.has("retry-after-ms") && !headers.has("retry-after");
    const ms = isMs ? n : n * 1000;
    return Math.min(Math.max(ms, 0), MAX_BACKOFF_MS);
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

function validateAnswers(raw: unknown): JudgeAnswers {
    if (!isJsonObject(raw)) throw new JudgeError("bad_response", "bad_response: answers missing");
    const out: JudgeAnswers = {};
    for (const [k, v] of Object.entries(raw)) {
        if (typeof v === "string") {
            out[k] = v;
            continue;
        }
        if (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1) {
            out[k] = v;
            continue;
        }
        // Von detail objects: { noul, noul_raw? } plus extra fields (type,
        // confidence, legend). Only noul/noul_raw are consumed.
        if (isJsonObject(v) && typeof v.noul === "number" && Number.isFinite(v.noul) && v.noul >= 0 && v.noul <= 1) {
            const raw = v.noul_raw;
            if (Object.hasOwn(v, "noul_raw") &&
                (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > 1)) {
                throw new JudgeError("bad_response", `bad_response: invalid raw answer for question "${k}"`);
            }
            out[k] = typeof raw === "number" ? { noul: v.noul, noul_raw: raw } : { noul: v.noul };
            continue;
        }
        throw new JudgeError("bad_response", `bad_response: invalid answer for question "${k}"`);
    }
    return out;
}

function errorCodeForStatus(status: number): JudgeErrorCode {
    return `http_${status}` as JudgeErrorCode;
}

export async function postSystemOneDecisions(req: SystemOneRequest): Promise<SystemOneResponse> {
    const fetchFn: FetchFn = req.fetchFn ?? fetch;
    const sleepFn: SleepFn = req.sleepFn ?? defaultSleep;
    const url = req.baseUrl.replace(/\/+$/, "") + req.route;
    const body = JSON.stringify({ model: req.model, state: req.state, questions: req.questions });

    let lastError: JudgeError | undefined;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        if (req.signal?.aborted) throw new JudgeError("aborted", "aborted");
        const controller = new AbortController();
        const onAbort = () => controller.abort();
        req.signal?.addEventListener("abort", onAbort, { once: true });
        const timer = setTimeout(() => controller.abort(), PER_ATTEMPT_TIMEOUT_MS);
        // Combine caller signal with per-attempt timeout where supported.
        const combined: AbortSignal | undefined =
            typeof AbortSignal.any === "function" && req.signal
                ? AbortSignal.any([req.signal, controller.signal])
                : undefined;
        try {
            // Build headers without leaking the key into error paths: the
            // actual Authorization value is set here and never stringified.
            const sendHeaders: Record<string, string> = { "content-type": "application/json" };
            if (req.apiKey) sendHeaders.authorization = `Bearer ${req.apiKey}`;
            const res = await fetchFn(url, {
                method: "POST",
                headers: sendHeaders,
                body,
                signal: combined ?? controller.signal,
            });
            if (res.status === 408 || res.status === 429 || res.status >= 500) {
                const wait = retryAfterMs(res.headers) ?? backoffMs(attempt);
                lastError = new JudgeError(errorCodeForStatus(res.status), `${errorCodeForStatus(res.status)}`);
                if (attempt === MAX_ATTEMPTS - 1) break;
                try {
                    await sleepFn(wait, req.signal);
                } catch (e) {
                    throw e instanceof JudgeError ? e : new JudgeError("aborted", "aborted");
                }
                continue;
            }
            if (!res.ok) throw new JudgeError(errorCodeForStatus(res.status), `${errorCodeForStatus(res.status)}`);
            let parsed: unknown;
            try {
                parsed = await res.json();
            } catch {
                throw new JudgeError("bad_response", "bad_response: invalid JSON");
            }
            if (!isJsonObject(parsed)) throw new JudgeError("bad_response", "bad_response: invalid envelope");
            const answers = validateAnswers(parsed.answers);
            const usageRaw = isJsonObject(parsed.usage) ? parsed.usage : {};
            const toNum = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
            const inputTokens = toNum(usageRaw.input_tokens) ?? toNum(usageRaw.inputTokens) ?? 0;
            const costUsd = toNum(usageRaw.cost);
            return { answers, usage: costUsd === undefined ? { inputTokens } : { inputTokens, costUsd } };
        } catch (err) {
            if (err instanceof JudgeError) {
                // Retryable codes loop; terminal codes throw immediately.
                if (err.code === "aborted") throw err;
                if (err.code === "bad_response" || err.code.startsWith("http_")) {
                    // http_408/429/5xx were handled above; other http_* are terminal.
                    if ((err.code === "http_408" || err.code === "http_429") && attempt < MAX_ATTEMPTS - 1) {
                        lastError = err;
                        await sleepFn(backoffMs(attempt), req.signal);
                        continue;
                    }
                    throw err;
                }
                lastError = err;
                throw err;
            }
            const name = (err as { name?: string })?.name ?? "";
            if (name === "AbortError" || (err as Error)?.message?.includes("aborted")) {
                if (req.signal?.aborted) throw new JudgeError("aborted", "aborted");
                lastError = new JudgeError("timeout", "timeout");
                if (attempt < MAX_ATTEMPTS - 1) {
                    await sleepFn(backoffMs(attempt), req.signal);
                    continue;
                }
                throw lastError;
            }
            lastError = new JudgeError("network", "network");
            if (attempt < MAX_ATTEMPTS - 1) {
                await sleepFn(backoffMs(attempt));
                continue;
            }
            throw lastError;
        } finally {
            clearTimeout(timer);
            req.signal?.removeEventListener("abort", onAbort);
        }
    }
    throw lastError ?? new JudgeError("network", "network");
}
