/**
 * Stage D — method request builders + instrumented wire executor for the
 * preregistered method-selection pilot (design plan §3 "Method builders"
 * and the Stage D row; protocol Amendment A1).
 *
 * Builders (pure): reproduce `CloudJudge.judgeNouls` request packing byte
 * for byte without touching `src/**` — shared `{ query }` state, per-unit
 * states under `shared.units`, `unitRelevanceQuestion` over `units.<id>`,
 * and the same greedy ~24k estimated-token split
 * (`CLOUD_JUDGE_TOKEN_BUDGET`, chars/4). `buildM0Request` is the forward
 * packed request; `buildM2Reverse` runs the identical builder over the
 * exact reversed order (the M2 forward leg IS the M0 forward request,
 * recorded once and reused — never re-sent); `buildM1Request` packs one
 * unit. Unit tests prove byte equality against a captured production
 * send for all three shapes.
 *
 * Executor: dispatches ONE built request per call through an INJECTED
 * transport (no real network, no credentials in this module), mirroring
 * the §4.4 probe loop (`capturingFetch` / `probeOneModel`):
 *
 * - campaign admission (`admitCampaignAttempt`, frozen reserve tables)
 *   BEFORE the transport call; an admission refusal propagates before
 *   anything is sent;
 * - exactly ONE settlement per admission: known actual when the
 *   response reports `usage.cost`, otherwise UNKNOWN with the frozen
 *   context-window reserve retained;
 * - bounded retries (`METHOD_WIRE_MAX_ATTEMPTS` = 3), each attempt
 *   separately admitted/settled, yielding one `MethodWireRecord` per
 *   physical request so the binder's gapless attemptIndex ledger holds;
 * - served identity/provider captured verbatim from the response body,
 *   never inferred from the requested slug; a received 2xx response
 *   without a served model is a capture gap that settles UNKNOWN,
 *   emits a durable capture-gap wire record (REAL `httpStatus` +
 *   `errorClass: "capture_gap"` + null identity) via `onWireRecord` —
 *   and, when no sink is provided, on `MethodCaptureGapError.records` —
 *   and then halts (`MethodCaptureGapError`), per plan §3. Amendment
 *   A3 (prospective, protocol §12): a received NON-2xx response
 *   without a served model is a TRANSPORT-CLASS failure — REAL
 *   `httpStatus` + `errorClass: "http_<status>"` + null identity —
 *   retried per the frozen status policy like any other transport
 *   failure, never a capture gap and never a halt; every record this
 *   executor emits carries `rulesetVersion: "A3"`;
 * - answers parsed with production `validateAnswers` semantics
 *   (that function is module-private in `systemone-client.ts`, so its
 *   rules are replicated here): any malformed, missing, or extra answer
 *   poisons the whole request as `bad_response` (plan §3 / protocol §4.3).
 *
 * URL construction is origin-pinned to the https OpenRouter decisions
 * origin with redirects refused (`redirect: "error"`), like
 * `capturingFetch`. No API key lives here — the injected transport owns
 * authentication, and this module never logs headers, bodies, or
 * credentials. Every produced record is self-checked against
 * `isMethodWireRecord` before it is returned, so outputs bind via
 * `bindMethodComparisonReport`.
 *
 * Documented divergences from production behavior (plan-mandated):
 * - missing/extra answers poison the WHOLE request here, while
 *   `CloudJudge.judgeNouls` marks only the affected entry unjudged and
 *   keeps the other answers;
 * - missing identity on a 2xx emits a durable capture-gap wire record
 *   with the REAL response status and error class `capture_gap` and
 *   then halts (`MethodCaptureGapError`), while the §4.4 probe
 *   records `"unavailable"` — inference is forbidden here (on a
 *   non-2xx, Amendment A3 records the transport class instead and
 *   keeps retrying);
 * - absent usage token counts stay `null` (never zero-filled like
 *   `postSystemOneDecisions`).
 */
import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";
import {
    CLOUD_JUDGE_DEFAULT_BASE_URL,
    CLOUD_JUDGE_ROUTE,
    CLOUD_JUDGE_TOKEN_BUDGET,
    estimateTokens,
} from "../../../src/judge/cloud-judge.js";
import { unitRelevanceQuestion } from "../../../src/judge/questions.js";
import type { FetchFn } from "../../../src/judge/systemone-client.js";
import {
    JudgeError,
    answerProbability,
    type JudgeAnswers,
    type JudgeErrorCode,
    type JsonValue,
    type NoulQuestion,
} from "../../../src/judge/types.js";
import {
    METHOD_CAPTURE_RULESET_VERSION_A3,
    METHOD_IDS,
    METHOD_PHASES,
    isMethodWireRecord,
    type MethodDirection,
    type MethodId,
    type MethodPhase,
    type MethodWireAnswer,
    type MethodWireRecord,
} from "./method-comparison-contract.js";
import { TRUSTED_DECISIONS_ORIGIN } from "./model-comparison.js";
import { admitCampaignAttempt, requestReserveUsd, settleCampaignAttempt } from "./model-comparison-budget.js";
import {
    FROZEN_REPLICA_COUNT,
    isComparisonModelId,
    type ComparisonAttemptCost,
    type ComparisonErrorClass,
    type ComparisonModelId,
} from "./model-comparison-types.js";

/* ──────────────────────────────────────────────────────────────────
 * Builders
 * ────────────────────────────────────────────────────────────────── */

/** One candidate to submit: stable id plus its per-unit state (as production's `toItems` materializes `{ path, symbol, text }`). */
export interface MethodRequestCandidate {
    candidateId: string;
    state: Record<string, JsonValue>;
}

/**
 * ONE packed request's exact wire form. `payloadSha256` is the SHA-256
 * over `body` — the exact bytes that would be sent.
 */
export interface MethodWireRequest {
    /** Exact request body bytes (production `postSystemOneDecisions` serialization). */
    body: string;
    /** Ordered candidate ids submitted in this request. */
    candidateIds: string[];
    /** Lowercase hex SHA-256 over `body`. */
    payloadSha256: string;
    /** UTF-8 byte length of `body`. */
    requestBytes: number;
}

function sha256Hex(value: string): string {
    return createHash("sha256").update(value, "utf-8").digest("hex");
}

function byteLength(value: string): number {
    return Buffer.byteLength(value, "utf-8");
}

function validateBuildInputs(model: string, query: string, candidates: readonly MethodRequestCandidate[]): void {
    if (typeof model !== "string" || model.length === 0) throw new Error("buildRequest: model must be a non-empty string");
    if (typeof query !== "string" || query.length === 0) throw new Error("buildRequest: query must be a non-empty string");
    const seen = new Set<string>();
    for (const candidate of candidates) {
        if (typeof candidate.candidateId !== "string" || candidate.candidateId.length === 0) {
            throw new Error("buildRequest: candidateId must be a non-empty string");
        }
        if (seen.has(candidate.candidateId)) {
            throw new Error(`buildRequest: duplicate candidateId "${candidate.candidateId}"`);
        }
        seen.add(candidate.candidateId);
    }
}

/**
 * Shared packing core: mirrors `CloudJudge.judgeNouls`
 * (`src/judge/cloud-judge.ts`) exactly — per-entry question over
 * `units.<id>`, greedy token-budget batching with the shared state
 * re-seeded per batch, and the production body serialization
 * `JSON.stringify({ model, state, questions })`. Splitting reproduces
 * production whenever a payload would exceed `CLOUD_JUDGE_TOKEN_BUDGET`;
 * the pilot corpus must fit one request per query (plan §3 acceptance),
 * which the tests assert for pilot-sized excerpts.
 */
function packMethodRequests(
    model: string,
    query: string,
    candidates: readonly MethodRequestCandidate[],
): MethodWireRequest[] {
    validateBuildInputs(model, query, candidates);
    const shared: Record<string, JsonValue> = { query };
    const pending = candidates.map((candidate) => ({
        id: candidate.candidateId,
        state: candidate.state,
        question: unitRelevanceQuestion(query, `units.${candidate.candidateId}`),
    }));
    const sharedTokens = estimateTokens(shared);
    const batches: typeof pending[] = [];
    let current: typeof pending = [];
    let currentTokens = sharedTokens;
    for (const entry of pending) {
        const entryTokens = estimateTokens({ [entry.id]: entry.state }) + estimateTokens(entry.question);
        if (current.length > 0 && currentTokens + entryTokens > CLOUD_JUDGE_TOKEN_BUDGET) {
            batches.push(current);
            current = [];
            currentTokens = sharedTokens;
        }
        current.push(entry);
        currentTokens += entryTokens;
    }
    if (current.length > 0) batches.push(current);

    return batches.map((batch) => {
        const units: Record<string, JsonValue> = {};
        const questions: Record<string, NoulQuestion> = {};
        for (const entry of batch) {
            units[entry.id] = entry.state;
            questions[entry.id] = entry.question;
        }
        const state: Record<string, JsonValue> = { ...shared, units };
        const body = JSON.stringify({ model, state, questions });
        return {
            body,
            candidateIds: batch.map((entry) => entry.id),
            payloadSha256: sha256Hex(body),
            requestBytes: byteLength(body),
        };
    });
}

/**
 * M0: shared query plus all candidates in the given (canonical) order —
 * byte-identical to what `CloudJudge.judgeNouls` would send for the same
 * inputs, including its token-budget split (one `MethodWireRequest` per
 * split; each split is dispatched and recorded as its own wire request).
 * Returns `[]` exactly when production would send nothing (no candidates).
 */
export function buildM0Request(
    model: string,
    query: string,
    candidates: readonly MethodRequestCandidate[],
): MethodWireRequest[] {
    return packMethodRequests(model, query, candidates);
}

/**
 * M1: shared query plus exactly ONE candidate — the same question
 * template and packing as M0 over a singleton (one request/candidate;
 * a singleton never splits, matching production's split-only-when-nonempty rule).
 */
export function buildM1Request(
    model: string,
    query: string,
    candidate: MethodRequestCandidate,
): MethodWireRequest {
    const requests = packMethodRequests(model, query, [candidate]);
    const [request] = requests;
    if (request === undefined || requests.length !== 1) {
        throw new Error(`buildM1Request: expected exactly one packed request, got ${requests.length}`);
    }
    return request;
}

/**
 * M2 reverse leg: the M0 builder over the EXACT reversed candidate
 * order (reversing insertion order of both units and questions — one
 * order drives both, as in production). The M2 forward leg is NOT built
 * here: it IS the M0 forward request itself, recorded once as method M0
 * and reused — never re-sent (the binder rejects a duplicate forward
 * `wireId`).
 */
export function buildM2Reverse(
    model: string,
    query: string,
    candidates: readonly MethodRequestCandidate[],
): MethodWireRequest[] {
    return packMethodRequests(model, query, [...candidates].reverse());
}

/** Wire direction each method dispatches (contract: M0 forward, M1 isolated, M2 reverse only). */
export const METHOD_WIRE_DIRECTION: Readonly<Record<MethodId, MethodDirection>> = Object.freeze({
    M0: "forward",
    M1: "isolated",
    M2: "reverse",
});

/* ──────────────────────────────────────────────────────────────────
 * Executor
 * ────────────────────────────────────────────────────────────────── */

/** Bounded dispatch attempts per request (production client ceiling: 3). */
export const METHOD_WIRE_MAX_ATTEMPTS = 3;

/** Retry sleep; default honors production-style backoff with `retry-after` support. */
export type MethodSleepFn = (ms: number) => Promise<void>;

/**
 * A received response carried no served model: the admission is
 * settled UNKNOWN first (reserve retained) and a durable capture-gap
 * wire record is built with the response's REAL `httpStatus` (identity
 * absent, `errorClass: "capture_gap"` — the contract's explicit
 * representation for a received-but-unsuccessful capture gap), then
 * `executeWireRequest` delivers it via `onWireRecord` (when provided)
 * and halts — plan §3 forbids inferring served identity. The settled
 * records of this call are attached as `records` so no record is lost
 * even when no `onWireRecord` sink exists.
 */
export class MethodCaptureGapError extends Error {
    readonly code = "capture_gap" as const;
    /** Every record this call captured before the halt — durable regardless of the `onWireRecord` sink. */
    readonly records: readonly MethodWireRecord[];
    constructor(records: readonly MethodWireRecord[]) {
        super("capture_gap: received response carried no served model; served identity is never inferred");
        this.name = "MethodCaptureGapError";
        this.records = Object.freeze([...records]);
    }
}

/** Escape wrapper for a thrown value that cannot carry records directly;
 *  the original — Error or not, even a hostile proxy or primitive — is
 *  always preserved as `cause`. */

class MethodAttemptRecordsError extends Error {
    readonly records: readonly MethodWireRecord[];
    constructor(original: unknown, records: readonly MethodWireRecord[]) {
        // Defensive extraction: the original may be a proxy whose
        // message/String conversion throws — never lose the records to it.
        let message: string;
        try {
            message = original instanceof Error && typeof original.message === "string"
                ? original.message
                : String(original);
        } catch {
            message = "executeWireRequest: thrown value is not stringifiable";
        }
        super(message, { cause: original });
        // Guarded separately: a hostile `name` getter (or getPrototypeOf
        // trap) must never make construction itself throw and lose records.
        let name = "MethodAttemptRecordsError";
        try {
            if (original instanceof Error && typeof original.name === "string" && original.name !== "Error") {
                name = original.name;
            }
        } catch {
            // keep the default name
        }
        this.name = name;
        this.records = Object.freeze([...records]);
    }
}

/** Recursively freeze a wire record: exposed receipts are immutable from birth. */
function deepFreezeValue(value: unknown): void {
    if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
        for (const child of Object.values(value)) deepFreezeValue(child);
        Object.freeze(value);
    }
}

/**
 * Attach settled attempt records to ANY error escaping the attempt loop,
 * so a record survives even when no `onWireRecord` sink was provided:
 * `MethodCaptureGapError` already carries them; other object errors get a
 * non-enumerable `records` property (original class/message/identity
 * preserved); non-object throws are wrapped with `cause` kept.
 */
function attachAttemptRecords(error: unknown, records: readonly MethodWireRecord[]): unknown {
    if (records.length === 0) return error;
    if (error instanceof MethodCaptureGapError) return error;
    // Proxies can lie: a silent `defineProperty` trap can report success
    // without defining `records`, and a `get` trap can serve different
    // values per read — never attach through one, wrap instead.
    if (typeof error === "object" && error !== null && !utilTypes.isProxy(error)) {
        try {
            // Read inside the guard: a throwing foreign `records` getter must
            // not escape attachment and mask this call's settled snapshot.
            const existing = "records" in error ? (error as { records?: unknown }).records : undefined;
            if (Array.isArray(existing) && !utilTypes.isProxy(existing)
                && records.every((record) => existing.includes(record))) {
                // Already carries THIS call's snapshot: keep identity, but
                // freeze it in place so the exposed records stay immutable.
                Object.freeze(existing);
                for (const record of records) deepFreezeValue(record);
                return error;
            }
            Object.defineProperty(error, "records", {
                value: Object.freeze([...records]), enumerable: false, configurable: false, writable: false,
            });
            // Read-back verification: a definition that silently did not take
            // effect must not win — confirm the snapshot is observable.
            const back = (error as { records?: unknown }).records;
            if (Array.isArray(back) && records.every((record) => back.includes(record))) return error;
        } catch {
            // Unreadable or unredefinable foreign property: wrap below so the
            // snapshot stays exposed with the original preserved as `cause`.
        }
    }
    return new MethodAttemptRecordsError(error, records);
}

/** Read settled attempt records off a caught `executeWireRequest` error (empty when none settled). */
export function attemptRecordsOf(error: unknown): readonly MethodWireRecord[] {
    if (typeof error === "object" && error !== null && "records" in error) {
        try {
            const value = (error as { records?: unknown }).records;
            if (Array.isArray(value)) return value as readonly MethodWireRecord[];
        } catch {
            // Throwing foreign getter: fall through (attachment wrapped instead).
        }
    }
    return [];
}

export interface ExecuteWireRequestOptions {
    method: MethodId;
    arm: ComparisonModelId;
    phase: MethodPhase;
    /** 0-based replica index (0..4); the envelope's declared replica count is bound later. */
    replica: number;
    /** `set:qid`-style group; MUST be null exactly for warmups. */
    queryGroup: string | null;
    warmup: boolean;
    /** Built request (use the builders above; the exact body bytes are what gets hashed and sent). */
    request: MethodWireRequest;
    /** Injected transport: receives the exact URL/body; owns authentication. Never provided by this module. */
    transport: FetchFn;
    /** Campaign ledger root (budget module); admissions reserve per its frozen tables. */
    campaignRoot: string;
    /** Defaults to the production cloud-judge endpoint (origin-pinned). */
    baseUrl?: string;
    route?: string;
    signal?: AbortSignal;
    /** Deterministic timestamps for tests. */
    now?: () => Date;
    /** Retry sleep; defaults to production-style backoff. Inject a no-op in tests. */
    sleep?: MethodSleepFn;
    /** Ledger hook: fires exactly once per settled attempt, before any subsequent throw, so records survive a later halt. Optional: when absent, a capture-gap halt still exposes every record on `MethodCaptureGapError.records`. */
    onWireRecord?: (record: MethodWireRecord) => void;
    /** First attemptIndex (resume support; default 1). */
    attemptIndexStart?: number;
}

interface ResolvedExecuteSpec {
    url: string;
    method: MethodId;
    arm: ComparisonModelId;
    phase: MethodPhase;
    direction: MethodDirection;
    replica: number;
    warmup: boolean;
    queryGroup: string | null;
    body: string;
    candidateIds: string[];
    payloadSha256: string;
    requestBytes: number;
    transport: FetchFn;
    campaignRoot: string;
    reserveUsd: number;
    signal: AbortSignal | undefined;
    now: () => Date;
    sleep: MethodSleepFn;
    onWireRecord: ((record: MethodWireRecord) => void) | undefined;
    attemptIndexStart: number;
}

interface AttemptOutcome {
    record: MethodWireRecord;
    retryable: boolean;
    retryDelayMs: number;
    reserveBreached: boolean;
    /** True only for the capture-gap outcome: `executeWireRequest` must halt with `MethodCaptureGapError` after emitting the record. */
    captureGap: boolean;
}

interface CapturedResponse {
    servedModel: string;
    provider: string | null;
    envelope: Record<string, unknown>;
}

const MAX_BACKOFF_MS = 5000;

const defaultBackoffSleep: MethodSleepFn = (ms) => new Promise((resolve) => {
    setTimeout(resolve, ms);
});

function isJsonObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveIdentityFields(spec: ExecuteWireRequestOptions): {
    method: MethodId;
    arm: ComparisonModelId;
    phase: MethodPhase;
    direction: MethodDirection;
} {
    if (!(METHOD_IDS as readonly string[]).includes(spec.method)) {
        throw new Error(`executeWireRequest: unknown method ${String(spec.method)}`);
    }
    if (!isComparisonModelId(spec.arm)) {
        throw new Error(`executeWireRequest: unknown arm ${String(spec.arm)}`);
    }
    if (!(METHOD_PHASES as readonly string[]).includes(spec.phase)) {
        throw new Error(`executeWireRequest: unknown phase ${String(spec.phase)}`);
    }
    return { method: spec.method, arm: spec.arm, phase: spec.phase, direction: METHOD_WIRE_DIRECTION[spec.method] };
}

function resolveRequestShape(spec: ExecuteWireRequestOptions): {
    body: string;
    candidateIds: string[];
    payloadSha256: string;
    requestBytes: number;
} {
    const { body, candidateIds, payloadSha256, requestBytes } = spec.request;
    if (typeof body !== "string" || body.length === 0) throw new Error("executeWireRequest: request.body must be non-empty");
    if (!Array.isArray(candidateIds) || candidateIds.length === 0) {
        throw new Error("executeWireRequest: request.candidateIds must be a non-empty array");
    }
    const seen = new Set<string>();
    for (const id of candidateIds) {
        if (typeof id !== "string" || id.length === 0 || seen.has(id)) {
            throw new Error(`executeWireRequest: invalid or duplicate candidateId ${String(id)}`);
        }
        seen.add(id);
    }
    if (spec.method === "M1" && candidateIds.length !== 1) {
        throw new Error("executeWireRequest: M1 submits exactly one candidate per request");
    }
    // The record's payload hash is SHA-256 over the exact bytes sent: a
    // request object whose declared hash/size disagrees with its body is
    // rejected before any admission.
    if (payloadSha256 !== sha256Hex(body)) throw new Error("executeWireRequest: request.payloadSha256 does not match request.body");
    if (requestBytes !== byteLength(body)) throw new Error("executeWireRequest: request.requestBytes does not match request.body");
    return { body, candidateIds: [...candidateIds], payloadSha256, requestBytes };
}

/** Origin pin + redirect refusal, mirroring `capturingFetch` (model-comparison.ts). */
function resolvePinnedUrl(baseUrl: string | undefined, route: string | undefined): string {
    const url = (baseUrl ?? CLOUD_JUDGE_DEFAULT_BASE_URL).replace(/\/+$/, "") + (route ?? CLOUD_JUDGE_ROUTE);
    let target: URL;
    try {
        target = new URL(url);
    } catch {
        throw new JudgeError("endpoint_not_allowed", "endpoint_not_allowed: invalid decisions URL");
    }
    if (target.protocol !== "https:" || target.origin !== TRUSTED_DECISIONS_ORIGIN) {
        throw new JudgeError("endpoint_not_allowed", "endpoint_not_allowed: decisions URL outside the pinned origin");
    }
    return url;
}

function resolveExecuteOptions(opts: ExecuteWireRequestOptions): ResolvedExecuteSpec {
    const identity = resolveIdentityFields(opts);
    const shape = resolveRequestShape(opts);
    if (!Number.isInteger(opts.replica) || opts.replica < 0 || opts.replica >= FROZEN_REPLICA_COUNT) {
        throw new Error(`executeWireRequest: replica must be an integer in 0..${FROZEN_REPLICA_COUNT - 1}`);
    }
    if (typeof opts.warmup !== "boolean") throw new Error("executeWireRequest: warmup must be a boolean");
    if (opts.warmup) {
        if (opts.queryGroup !== null) throw new Error("executeWireRequest: warmup records carry queryGroup null");
    } else if (typeof opts.queryGroup !== "string" || opts.queryGroup.length === 0) {
        throw new Error("executeWireRequest: non-warmup records require a non-empty queryGroup");
    }
    if (typeof opts.transport !== "function") throw new Error("executeWireRequest: transport must be a function");
    if (typeof opts.campaignRoot !== "string" || opts.campaignRoot.length === 0) {
        throw new Error("executeWireRequest: campaignRoot must be a non-empty string");
    }
    const attemptIndexStart = opts.attemptIndexStart ?? 1;
    if (!Number.isInteger(attemptIndexStart) || attemptIndexStart < 1) {
        throw new Error("executeWireRequest: attemptIndexStart must be an integer >= 1");
    }
    if (opts.onWireRecord !== undefined && typeof opts.onWireRecord !== "function") {
        throw new Error("executeWireRequest: onWireRecord must be a function");
    }
    return {
        url: resolvePinnedUrl(opts.baseUrl, opts.route),
        ...identity,
        replica: opts.replica,
        warmup: opts.warmup,
        queryGroup: opts.queryGroup,
        ...shape,
        transport: opts.transport,
        campaignRoot: opts.campaignRoot,
        reserveUsd: requestReserveUsd(opts.arm),
        signal: opts.signal,
        now: opts.now ?? (() => new Date()),
        sleep: opts.sleep ?? defaultBackoffSleep,
        onWireRecord: opts.onWireRecord,
        attemptIndexStart,
    };
}

/** Deterministic id for one physical request (component + replica + attempt + payload); a re-send collides and is rejected as `duplicate_wire_id`. */
function deriveWireId(spec: ResolvedExecuteSpec, attemptIndex: number): string {
    return sha256Hex([
        spec.method,
        spec.arm,
        spec.phase,
        String(spec.replica),
        String(spec.warmup),
        spec.direction,
        spec.queryGroup ?? "warmup",
        String(attemptIndex),
        spec.payloadSha256,
        ...spec.candidateIds,
    ].join("\u0000"));
}

function nullAnswers(candidateIds: readonly string[]): MethodWireAnswer[] {
    return candidateIds.map((candidateId) => ({ candidateId, probability: null }));
}

interface RecordCapture {
    httpStatus: number | null;
    servedModel: string | null;
    provider: string | null;
    inputTokens: number | null;
    outputTokens: number | null;
    cost: ComparisonAttemptCost;
    errorClass: ComparisonErrorClass | null;
    answers: MethodWireAnswer[];
    latencyMs: number;
    requestTimestamp: string;
}

/** Build the wire record and fail closed if it would not pass the Stage C guard. */
function buildWireRecord(spec: ResolvedExecuteSpec, attemptIndex: number, capture: RecordCapture): MethodWireRecord {
    const record: MethodWireRecord = {
        wireId: deriveWireId(spec, attemptIndex),
        method: spec.method,
        arm: spec.arm,
        phase: spec.phase,
        replica: spec.replica,
        warmup: spec.warmup,
        direction: spec.direction,
        queryGroup: spec.queryGroup,
        candidateIds: [...spec.candidateIds],
        attemptIndex,
        requestBytes: spec.requestBytes,
        payloadSha256: spec.payloadSha256,
        // Amendment A3 (protocol §12): every record this executor emits is
        // stamped as A3-era; the stamp is what makes A3 capture rules
        // applicable downstream (pre-A3 artifacts carry no stamp).
        rulesetVersion: METHOD_CAPTURE_RULESET_VERSION_A3,
        ...capture,
    };
    if (!isMethodWireRecord(record)) {
        throw new Error("executeWireRequest: internal error — produced record fails isMethodWireRecord");
    }
    return record;
}

/**
 * Exact mirror of production `validateAnswers`
 * (`src/judge/systemone-client.ts`, module-private): strings, finite
 * numbers in [0,1], and von detail objects `{ noul, noul_raw? }` with a
 * range-checked `noul_raw`; anything else throws `bad_response`.
 */
function validateAnswersLikeProduction(raw: unknown): JudgeAnswers {
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
        if (isJsonObject(v) && typeof v.noul === "number" && Number.isFinite(v.noul) && v.noul >= 0 && v.noul <= 1) {
            const rawDetail = v.noul_raw;
            if (Object.hasOwn(v, "noul_raw") &&
                (typeof rawDetail !== "number" || !Number.isFinite(rawDetail) || rawDetail < 0 || rawDetail > 1)) {
                throw new JudgeError("bad_response", `bad_response: invalid raw answer for question "${k}"`);
            }
            out[k] = typeof rawDetail === "number" ? { noul: v.noul, noul_raw: rawDetail } : { noul: v.noul };
            continue;
        }
        throw new JudgeError("bad_response", `bad_response: invalid answer for question "${k}"`);
    }
    return out;
}

/**
 * Parse the response answers for this request: production validation,
 * then the plan §3 batch rules — every submitted candidate must be
 * answered numerically and NOTHING extra may be answered, so a
 * malformed/missing/extra answer poisons the whole request.
 */
function parseWireAnswers(raw: unknown, candidateIds: readonly string[]): MethodWireAnswer[] {
    const validated = validateAnswersLikeProduction(raw);
    const expected = new Set(candidateIds);
    const extracted = new Map<string, number>();
    for (const [key, value] of Object.entries(validated)) {
        if (!expected.has(key)) {
            throw new JudgeError("bad_response", `bad_response: unexpected answer for question "${key}"`);
        }
        const probability = answerProbability(value, false);
        if (probability === undefined || !Number.isFinite(probability) || probability < 0 || probability > 1) {
            throw new JudgeError("bad_response", `bad_response: non-numeric answer for question "${key}"`);
        }
        extracted.set(key, probability);
    }
    const answers: MethodWireAnswer[] = [];
    for (const id of candidateIds) {
        const probability = extracted.get(id);
        if (probability === undefined) {
            throw new JudgeError("bad_response", `bad_response: missing answer for question "${id}"`);
        }
        answers.push({ candidateId: id, probability });
    }
    return answers;
}

function isRetryableStatus(status: number): boolean {
    return status === 408 || status === 429 || status >= 500;
}

/** Production retry delay semantics: `retry-after` / `retry-after-ms` header, else exponential backoff (`systemone-client.ts`). */
function retryDelayFor(res: Response, attemptIndex: number): number {
    const raw = res.headers.get("retry-after") ?? res.headers.get("retry-after-ms");
    if (raw !== null) {
        const n = Number(raw.trim().split(",")[0]);
        if (Number.isFinite(n) && n >= 0) {
            const isMs = res.headers.has("retry-after-ms") && !res.headers.has("retry-after");
            const ms = isMs ? n : n * 1000;
            return Math.min(Math.max(ms, 0), MAX_BACKOFF_MS);
        }
    }
    return backoffMs(attemptIndex);
}

function backoffMs(attemptIndex: number): number {
    return Math.min(500 * 2 ** (attemptIndex - 1), MAX_BACKOFF_MS);
}

function classifyTransportFailure(spec: ResolvedExecuteSpec, err: unknown): { code: JudgeErrorCode; retryable: boolean } {
    if (spec.signal?.aborted) return { code: "aborted", retryable: false };
    if (err instanceof JudgeError) {
        if (err.code === "timeout" || err.code === "network") return { code: err.code, retryable: true };
        return { code: err.code, retryable: false };
    }
    const name = (err as { name?: string } | null)?.name;
    if (name === "AbortError") return { code: "timeout", retryable: true };
    return { code: "network", retryable: true };
}

/**
 * Capture served identity verbatim from a RECEIVED response (any
 * status), like `capturingFetch`'s cloned-body capture. Returns null
 * on a capture gap (no usable `model` in the body): the caller settles
 * the admission UNKNOWN and builds the durable capture-gap record that
 * `executeWireRequest` emits before halting.
 */
async function captureServedResponse(res: Response): Promise<CapturedResponse | null> {
    let raw: string | undefined;
    try {
        raw = await res.text();
    } catch {
        raw = undefined;
    }
    let parsed: unknown;
    try {
        parsed = raw === undefined ? undefined : JSON.parse(raw);
    } catch {
        parsed = undefined;
    }
    if (!isJsonObject(parsed) || typeof parsed.model !== "string" || parsed.model.length === 0) {
        return null;
    }
    const provider = typeof parsed.provider === "string" && parsed.provider.length > 0 ? parsed.provider : null;
    return { servedModel: parsed.model, provider, envelope: parsed };
}

function tokenCount(value: unknown): number | null {
    return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * A reported `usage.cost` is usable as a known actual only when it is
 * finite AND >= 0; negative / NaN / non-finite reports are invalid and
 * must settle UNKNOWN (reserve retained) — `settleCampaignAttempt`
 * rejects them, which would strand the admitted attempt in-flight with
 * no record.
 */
function usableReportedCostUsd(value: unknown): number | undefined {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
    return value;
}

function transportFailed(
    spec: ResolvedExecuteSpec,
    attemptId: string,
    requestTimestamp: string,
    startedAt: number,
    attemptIndex: number,
    err: unknown,
): AttemptOutcome {
    // The transport was invoked: the request may have reached the wire, so
    // the admission settles UNKNOWN (reserve retained) — probe semantics.
    const ledger = settleCampaignAttempt(spec.campaignRoot, attemptId, undefined);
    const { code, retryable } = classifyTransportFailure(spec, err);
    const record = buildWireRecord(spec, attemptIndex, {
        httpStatus: null,
        servedModel: null,
        provider: null,
        inputTokens: null,
        outputTokens: null,
        cost: { status: "unknown", reserveUsd: spec.reserveUsd },
        errorClass: code,
        answers: nullAnswers(spec.candidateIds),
        latencyMs: performance.now() - startedAt,
        requestTimestamp,
    });
    return { record, retryable, retryDelayMs: backoffMs(attemptIndex), reserveBreached: ledger.reserveBreached, captureGap: false };
}

function statusFailure(
    spec: ResolvedExecuteSpec,
    attemptId: string,
    requestTimestamp: string,
    latencyMs: number,
    attemptIndex: number,
    res: Response,
    captured: CapturedResponse | null,
): AttemptOutcome {
    // Non-2xx: production throws before parsing usage, so no cost is known —
    // the admission settles UNKNOWN and the reserve is retained. Amendment
    // A3 (protocol §12): when the non-2xx body carried no served model
    // (`captured === null`), this is still a TRANSPORT-CLASS failure —
    // `http_<status>` with absent identity, retried per the frozen status
    // policy — never a capture gap and never a halt; capture_gap is
    // reserved for a 2xx whose served identity cannot be captured.
    const ledger = settleCampaignAttempt(spec.campaignRoot, attemptId, undefined);
    const retryable = isRetryableStatus(res.status);
    const record = buildWireRecord(spec, attemptIndex, {
        httpStatus: res.status,
        servedModel: captured?.servedModel ?? null,
        provider: captured?.provider ?? null,
        inputTokens: null,
        outputTokens: null,
        cost: { status: "unknown", reserveUsd: spec.reserveUsd },
        errorClass: `http_${res.status}`,
        answers: nullAnswers(spec.candidateIds),
        latencyMs,
        requestTimestamp,
    });
    return { record, retryable, retryDelayMs: retryDelayFor(res, attemptIndex), reserveBreached: ledger.reserveBreached, captureGap: false };
}

/**
 * Capture gap on a RECEIVED 2xx response: settle the admission UNKNOWN
 * first (reserve retained), then build the durable wire record. The
 * record keeps the response's REAL `httpStatus` and marks the gap with
 * the contract's explicit absent-identity class: `errorClass:
 * "capture_gap"` + null identity/provider + all-null answers (the
 * received-but-unsuccessful shape `isMethodWireRecord` accepts iff
 * exactly that) — it binds via `bindMethodComparisonReport` and counts
 * in the availability denominator but never as a success. Amendment A3
 * (protocol §12): this outcome is reached ONLY for a received 2xx; a
 * received non-2xx without a served model settles as the transport
 * class `http_<status>` instead and keeps retrying.
 * `executeWireRequest` throws `MethodCaptureGapError` only after
 * `onWireRecord` has delivered the record (and always carries it on
 * `.records`) — the attempt is never left in-flight and never loses its
 * record.
 */
function captureGapOutcome(
    spec: ResolvedExecuteSpec,
    attemptId: string,
    requestTimestamp: string,
    latencyMs: number,
    attemptIndex: number,
    status: number,
): AttemptOutcome {
    const ledger = settleCampaignAttempt(spec.campaignRoot, attemptId, undefined);
    const record = buildWireRecord(spec, attemptIndex, {
        httpStatus: status,
        servedModel: null,
        provider: null,
        inputTokens: null,
        outputTokens: null,
        cost: { status: "unknown", reserveUsd: spec.reserveUsd },
        errorClass: "capture_gap",
        answers: nullAnswers(spec.candidateIds),
        latencyMs,
        requestTimestamp,
    });
    return { record, retryable: false, retryDelayMs: 0, reserveBreached: ledger.reserveBreached, captureGap: true };
}

function poisonedResponse(
    spec: ResolvedExecuteSpec,
    attemptId: string,
    requestTimestamp: string,
    latencyMs: number,
    attemptIndex: number,
    status: number,
    captured: CapturedResponse,
): AttemptOutcome {
    // Malformed/missing/extra answers poison the batch: production throws
    // before usage parsing, so cost settles UNKNOWN (reserve retained).
    const ledger = settleCampaignAttempt(spec.campaignRoot, attemptId, undefined);
    const record = buildWireRecord(spec, attemptIndex, {
        httpStatus: status,
        servedModel: captured.servedModel,
        provider: captured.provider,
        inputTokens: null,
        outputTokens: null,
        cost: { status: "unknown", reserveUsd: spec.reserveUsd },
        errorClass: "bad_response",
        answers: nullAnswers(spec.candidateIds),
        latencyMs,
        requestTimestamp,
    });
    return { record, retryable: false, retryDelayMs: 0, reserveBreached: ledger.reserveBreached, captureGap: false };
}

async function responseReceived(
    spec: ResolvedExecuteSpec,
    attemptId: string,
    requestTimestamp: string,
    startedAt: number,
    attemptIndex: number,
    res: Response,
): Promise<AttemptOutcome> {
    const captured = await captureServedResponse(res);
    const latencyMs = performance.now() - startedAt;
    // Amendment A3 (protocol §12): a received NON-2xx without a served
    // model is a transport-class failure (`http_<status>`, retried per
    // the frozen status policy); capture_gap is reserved for a received
    // 2xx whose served identity cannot be captured.
    if (!res.ok) return statusFailure(spec, attemptId, requestTimestamp, latencyMs, attemptIndex, res, captured);
    if (captured === null) return captureGapOutcome(spec, attemptId, requestTimestamp, latencyMs, attemptIndex, res.status);

    let answers: MethodWireAnswer[];
    try {
        answers = parseWireAnswers(captured.envelope.answers, spec.candidateIds);
    } catch {
        return poisonedResponse(spec, attemptId, requestTimestamp, latencyMs, attemptIndex, res.status, captured);
    }

    const usage = isJsonObject(captured.envelope.usage) ? captured.envelope.usage : {};
    // Usable actual iff finite AND >= 0: an invalid reported cost settles
    // UNKNOWN (reserve retained). Passing it through would make
    // settleCampaignAttempt reject an admitted attempt before settlement,
    // stranding it in-flight with no record.
    const costUsd = usableReportedCostUsd(usage.cost);
    const ledger = settleCampaignAttempt(spec.campaignRoot, attemptId, costUsd);
    const cost: ComparisonAttemptCost = costUsd === undefined
        ? { status: "unknown", reserveUsd: spec.reserveUsd }
        : { status: "known", usd: costUsd };
    const record = buildWireRecord(spec, attemptIndex, {
        httpStatus: res.status,
        servedModel: captured.servedModel,
        provider: captured.provider,
        inputTokens: tokenCount(usage.input_tokens) ?? tokenCount(usage.inputTokens),
        outputTokens: tokenCount(usage.output_tokens) ?? tokenCount(usage.outputTokens),
        cost,
        errorClass: null,
        answers,
        latencyMs,
        requestTimestamp,
    });
    return { record, retryable: false, retryDelayMs: 0, reserveBreached: ledger.reserveBreached, captureGap: false };
}

/**
 * Derive the attempt timestamp BEFORE admission: a throwing or
 * invalid clock must fail while nothing is in flight — no admission
 * record, no transport call.
 */
function deriveRequestTimestamp(now: () => Date): string {
    const value = now();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
        throw new Error("executeWireRequest: now() returned an invalid Date");
    }
    return value.toISOString();
}

/** One admitted, settled dispatch attempt. Admission refusal throws BEFORE the transport call (no record exists — nothing was sent). */
async function dispatchAttempt(spec: ResolvedExecuteSpec, attemptIndex: number): Promise<AttemptOutcome> {
    // Timestamp first: an invalid clock throws BEFORE admission, so nothing strands in flight.
    const requestTimestamp = deriveRequestTimestamp(spec.now);
    const { attemptId } = admitCampaignAttempt(spec.campaignRoot, spec.arm);
    const startedAt = performance.now();
    let res: Response;
    try {
        res = await spec.transport(spec.url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: spec.body,
            redirect: "error",
            signal: spec.signal,
        });
    } catch (err) {
        return transportFailed(spec, attemptId, requestTimestamp, startedAt, attemptIndex, err);
    }
    return responseReceived(spec, attemptId, requestTimestamp, startedAt, attemptIndex, res);
}

/**
 * Execute ONE built request: up to `METHOD_WIRE_MAX_ATTEMPTS` attempts,
 * each admitted before its transport call and settled exactly once.
 * Returns one `MethodWireRecord` per dispatched attempt, in dispatch
 * order with gapless `attemptIndex` — the binder counts every attempt,
 * so failed attempts are records too (all-null answers, error class).
 *
 * Throws without returning this call's records when a later step fails:
 * every escaping error carries all records settled so far (`records`,
 * read via `attemptRecordsOf`) regardless of the `onWireRecord` sink;
 * admission refusal before anything settled throws unchanged.
 */
export async function executeWireRequest(opts: ExecuteWireRequestOptions): Promise<MethodWireRecord[]> {
    const spec = resolveExecuteOptions(opts);
    const records: MethodWireRecord[] = [];
    try {
        for (let i = 0; i < METHOD_WIRE_MAX_ATTEMPTS; i += 1) {
            const attemptIndex = spec.attemptIndexStart + i;
            const outcome = await dispatchAttempt(spec, attemptIndex);
            records.push(outcome.record);
            // Frozen at birth: every exposed receipt (sink, attached snapshot,
            // return value) is immutable from the moment it exists.
            deepFreezeValue(outcome.record);
            // The record reaches the ledger hook BEFORE any halt below: a
            // settled attempt can never disappear without a durable record.
            spec.onWireRecord?.(outcome.record);
            if (outcome.reserveBreached) {
                throw new JudgeError("aborted", "campaign_halted_reserve_breached");
            }
            if (outcome.captureGap) {
                throw new MethodCaptureGapError(records);
            }
            if (!outcome.retryable) break;
            if (i + 1 < METHOD_WIRE_MAX_ATTEMPTS) await spec.sleep(outcome.retryDelayMs);
        }
    } catch (error) {
        throw attachAttemptRecords(error, records);
    }
    Object.freeze(records);
    return records;
}
