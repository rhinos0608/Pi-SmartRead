/**
 * Stable DTOs for the judge model-comparison campaign.
 *
 * These types are the handoff API for the next stats/execution worker:
 * score rows carry their full identity (set/query/candidate/replicate/
 * model) with an optional probability plus ground truth, and HTTP events
 * carry wire metadata with cost, reserve, request, status, timing, and the
 * served model identity. No synthetic probabilities: a missing or
 * non-numeric answer is `undefined` here and `unjudged` downstream, never
 * `p = 0.5`.
 *
 * The frozen §4.4 campaign records add validated scored-outcome and
 * replica-average records, per-attempt provenance (attempt id,
 * provider, payload hash), a served-identity allowlist, and
 * `Object.freeze`d policy constants that validators read only in
 * their frozen state. `isComparisonQualificationConsistentWith`
 * binds a qualification end-to-end to its attempt records and run
 * summary, and `isComparisonReportConsistent` extends that binding
 * to the planned unit set (composition plus the frozen-fixture digest
 * `FROZEN_PLANNED_UNITS_DIGEST`), scored outcomes, attempt links, and
 * replica averages: the final report must pass both, not just the
 * per-record validators.
 */

import { createHash } from "node:crypto";
import type { JudgeErrorCode } from "../../../src/judge/types.js";
import { requestReserveUsd } from "./model-comparison-budget.js";
import { COMPARISON_MODELS } from "./model-comparison.js";

export type ComparisonModelId = (typeof COMPARISON_MODELS)[number];

/** Identity of one scored judgment. All fields are required. */
export interface ScoreRowIdentity {
    /** Fixture set namespace (`"a"` or `"b"`); sets never share qids. */
    set: string;
    /** Query-group id within the set. */
    query: string;
    /** Candidate id within the query group (e.g. `u0`). */
    candidate: string;
    /** Replicate index (0-based). Frozen maximum is 4 (5 replicates). */
    replicate: number;
    /** Requested model slug. */
    model: string;
}

/** Ground truth for one candidate. */
export type TruthKind = "gold" | "hard_negative" | "easy_negative";

/** Per-item judgment status. */
export type ScoreStatus = "ok" | "unjudged";

/**
 * One scored row: identity plus optional outcome.
 *
 * @deprecated Legacy-only: no in-repo consumer exists and none may be
 * added. The frozen §4.4 metric input is `ComparisonScoredOutcome`
 * (plus its replica-averaged `ComparisonUnitAverage`); this row keeps
 * its broad optional fields only for archive compatibility.
 */
export interface ScoreRow {
    identity: ScoreRowIdentity;
    /** Probability in [0,1]; `undefined` when unjudged (never 0.5). */
    p?: number;
    truth?: TruthKind;
    status: ScoreStatus;
    /** Failure code when unjudged (e.g. `bad_response`, `http_502`). */
    code?: string;
}

/** One actual HTTP attempt on the wire. */
export interface HttpEvent {
    /** Requested model slug. */
    requestedModel: string;
    /** Served snapshot id from the response body (`"unavailable"` if absent). */
    servedModel: string;
    /** Provider string from the response body (`"unavailable"` if absent). */
    provider: string;
    /** Pre-attempt cost reservation held for this attempt (USD). */
    reserveUsd: number;
    /** Reported `usage.cost` for this attempt; `undefined` means UNKNOWN. */
    actualCostUsd?: number;
    /** Reported `usage.input_tokens` for this attempt. */
    inputTokens: number;
    /** Request body size in bytes. */
    requestBytes: number;
    /** Outcome status code (`ok`, `bad_response`, `http_*`, ...). */
    status: string;
    /** Round-trip latency in milliseconds. */
    latencyMs: number;
    /** ISO timestamp taken before the attempt. */
    requestTimestamp: string;
    /** Number of wire fetches consumed by this attempt. */
    httpAttempts: number;
}

/* ──────────────────────────────────────────────────────────────────
 * Full-comparison DTOs — protocol §4.4 "Statistics policy (frozen
 * 2026-10-08, pre-data)". Runtime validators are pure type guards
 * that fail closed: unknown arms, foreign keys, malformed costs,
 * missing capture fields, and internally inconsistent records are
 * all rejected rather than repaired.
 * ──────────────────────────────────────────────────────────────── */

/** Frozen campaign shape: five cache-disabled replicas per arm. */
export const FROZEN_REPLICA_COUNT = 5;
/** Frozen corpus size: every arm must cover 314 scored units. */
export const FROZEN_CORPUS_UNITS = 314;

/**
 * Frozen per-arm served-model allowlist (§4.4 identity/provenance,
 * parent-frozen 2026-10-08 pre-data). Keyed by the exact requested
 * slug; the value is the served snapshot recorded verbatim from the
 * pre-data probe (equal to `PLAN_SERVED_PINS` in
 * `model-comparison-plan.ts`, enforced by test): Jev/Luna from the
 * 2026-10-07 probe, the PPLX arm the v1.1 snapshot re-verified
 * 2026-10-09 under protocol Amendment A2 (pre-data). A recorded served
 * identity that differs from the allowlisted value for its arm blocks
 * the arm with reason `served_identity_drift` — no in-run waiver; a
 * provider-side re-pin requires a new pre-data freeze.
 */
export const COMPARISON_SERVED_MODEL_ALLOWLIST: Readonly<Record<ComparisonModelId, string>> = Object.freeze({
    "~typesafe/jev-latest": "typesafe/jev-1.13-20260917",
    "perplexity/pplx-decider-v1.1-27b": "perplexity/pplx-decider-v1.1-27b-20261006",
    "openai/gpt-6-luna-decisions": "openai/gpt-6-luna-decisions-20261006",
});

/**
 * Per-attempt cost. `known` is a settled reported amount; `unknown`
 * retains the pre-request reservation and keeps the run
 * `costComplete: false`. Missing cost is NEVER recorded as $0 and a
 * cost field that is neither variant is a capture gap (§4.4).
 */
export type ComparisonAttemptCost =
    | { status: "known"; usd: number }
    | { status: "unknown"; reserveUsd: number };

/**
 * One dispatched wire attempt of the full comparison (§4.4). One
 * record per attempt: client retries produce additional records with
 * a higher `attemptIndex`.
 *
 * Capture rules enforced by `isComparisonAttemptRecord`:
 * - Warmups are flagged (`warmup: true`) and carry no query group —
 *   the packed unit id `u0` alone never distinguishes a warmup from
 *   the scored unit `u0`.
 * - Token counts are `null` when not reported (never zero-filled);
 *   an explicit `0` from the provider is a real reported value.
 * - `errorClass` is a class only — never response bodies, headers,
 *   prompts, or credentials.
 * - `attemptId` is this record's link target for
 *   `ComparisonScoredOutcome.attemptIds`; `provider` is recorded only
 *   when the response returned it and is never inferred; every
 *   dispatched attempt carries a `payloadSha256` over the exact bytes
 *   sent (retries/replicas of one unit must hash identically).
 */
export interface ComparisonAttemptRecord {
    /** Stable id of this attempt record; scored outcomes link to it via `attemptIds`. */
    attemptId: string;
    /** Requested arm slug (exact frozen campaign slug). */
    arm: ComparisonModelId;
    /**
     * `model` string exactly as returned in the response body. Null only
     * when no response arrived (`httpStatus` null); a received status must
     * carry a non-empty served identity — missing identity on a response
     * is rejected by the validator (fail-closed capture rejection, §4.4).
     */
    servedModel: string | null;
    /** `provider` string as returned in the response body; null when not returned. Never inferred from the requested slug. */
    provider: string | null;
    /** `set:qid` query group scored by this attempt; null only for warmups. */
    queryGroup: string | null;
    /** Unit id as packed into the request body (e.g. `u0`). Not a warmup discriminator. */
    unitId: string;
    /** Replica index 0-based, valid range 0..4 (five cache-disabled replicas). */
    replica: number;
    /** 1-based wire attempt for this unit/replica; client retries increment (1, 2, 3, ...). */
    attemptIndex: number;
    /** True for the per-arm warmup request; warmups never enter scored metrics. */
    warmup: boolean;
    /**
     * Exact serialized request-body size in UTF-8 bytes as sent:
     * `Buffer.byteLength(body, "utf8")` — never `String.length`
     * (JS characters are not bytes for non-ASCII payloads).
     */
    requestBytes: number;
    /**
     * Lowercase hex SHA-256 (64 chars) over the exact request bytes
     * sent — the same bytes `requestBytes` counts. Retries and all
     * five replicas of the same unit must carry an identical hash.
     */
    payloadSha256: string;
    /** HTTP status actually received; null when no response arrived (transport failure/timeout). */
    httpStatus: number | null;
    /** Valid probability in [0,1], or null when unjudged — never a synthetic 0.5. */
    probability: number | null;
    /** Reported input token count; null when not reported. Never zero-filled. */
    inputTokens: number | null;
    /** Reported output token count; null when not reported. Never zero-filled. */
    outputTokens: number | null;
    cost: ComparisonAttemptCost;
    /** Failure class only (`JudgeErrorCode`); null on success. No bodies, headers, or credentials. */
    errorClass: JudgeErrorCode | null;
}

/** Why an arm cannot qualify (frozen §4.4 policy point 3 + identity/precision blocks). */
export const COMPARISON_BLOCKED_REASONS = Object.freeze([
    "missing_probability",
    "incomplete_cost_record",
    "aborted_run",
    "degenerate_bootstrap",
    "served_identity_drift",
    "payload_drift",
    "undefined_precision",
] as const);
export type ComparisonBlockedReason = (typeof COMPARISON_BLOCKED_REASONS)[number];

/**
 * Per-arm run summary derived from attempt records. Invariants
 * (fail-closed): `unitsWithValidAverage + unitsUnjudged = 314`,
 * `knownCostAttempts + unknownCostAttempts = attemptedRequests`,
 * `costComplete ⇔ unknownCostAttempts = 0`, `runCompleted = false`
 * ⇔ blocked reason `aborted_run`, and (parent-frozen 2026-10-08
 * pre-data) `unknownCostAttempts > 0` ⇒ `unknownCostReserveUsd > 0`
 * and `unknownCostReserveUsd ≥ unknownCostAttempts ×
 * requestReserveUsd(arm)` — the frozen per-attempt reserve from
 * `model-comparison-budget.ts`.
 */
export interface ComparisonArmRunSummary {
    arm: ComparisonModelId;
    /** Frozen at 5. */
    replicasPlanned: number;
    /** Distinct replica indices (0..4) with at least one attempt record. */
    replicasObserved: number;
    /** Frozen at 314. */
    unitsPlanned: number;
    /** Units with a valid replica-averaged probability (all five replicas numeric). */
    unitsWithValidAverage: number;
    /** Units with no valid replica-averaged probability (policy §4.4 point 7). */
    unitsUnjudged: number;
    /** Availability denominator: dispatched wire attempts including retries and warmups. */
    attemptedRequests: number;
    /** Availability numerator: attempts returning HTTP 2xx with a parseable envelope. */
    successfulResponses: number;
    /** Warmup attempts among `attemptedRequests`. */
    warmupAttempts: number;
    /** Attempts whose cost settled as `{status:'known'}`. */
    knownCostAttempts: number;
    /** Attempts still `{status:'unknown'}` (reservation retained). */
    unknownCostAttempts: number;
    /** Sum of known costs (USD). */
    knownCostUsd: number;
    /** Sum of retained reservations on unknown-cost attempts (USD). */
    unknownCostReserveUsd: number;
    /** True only when every attempt cost settled to `known`. Blocks cost ranking at selection. */
    costComplete: boolean;
    /** False only when the run halted before planned completion (always with reason `aborted_run`). */
    runCompleted: boolean;
    /** Completeness blocks that stop this arm from qualifying (§4.4). */
    blockedReasons: ComparisonBlockedReason[];
}

/** The ten frozen qualification gates (§4.4 decision rule order). */
export const COMPARISON_GATE_IDS = Object.freeze([
    "recall_ci",
    "net_fn",
    "availability",
    "unjudged",
    "auroc_ni",
    "hard_negative_precision_ni",
    "brier_ni",
    "loss",
    "ece_harm_stop",
    "utility_harm_stop",
] as const);
export type ComparisonGateId = (typeof COMPARISON_GATE_IDS)[number];

/**
 * Frozen per-gate thresholds. The `loss` gate threshold is Jev's
 * observed loss (data-dependent) and is therefore not in this table.
 * Governing input per gate: `ciLow` for recall/auroc/precision/utility,
 * `ciHigh` for brier, `value` for the rest.
 *
 * `Object.freeze`d with a readonly type (§4.4): validators read these
 * values only in their frozen state; mutation attempts throw in
 * strict-mode code and have no effect otherwise.
 */
export const COMPARISON_GATE_THRESHOLDS: Readonly<Record<Exclude<ComparisonGateId, "loss">, number>> = Object.freeze({
    recall_ci: -0.02,
    net_fn: 1,
    availability: 0.995,
    unjudged: 0.01,
    auroc_ni: -0.02,
    hard_negative_precision_ni: -0.03,
    brier_ni: 0.02,
    ece_harm_stop: 0.3,
    utility_harm_stop: -0.05,
});

/**
 * One gate's outcome for one challenger arm. `pass` is null only when
 * the governing input is missing (blocked); validators recompute
 * `pass` from `threshold` and the governing input, so a recorded
 * `pass` that disagrees with its numbers is rejected.
 */
export interface ComparisonGateResult {
    gate: ComparisonGateId;
    /** Point estimate (challenger − Jev for Δ gates); null when not computable. */
    value: number | null;
    /** 95% CI lower bound (percentile bootstrap); null when not computable or not applicable. */
    ciLow: number | null;
    /** 95% CI upper bound; null when not computable or not applicable. */
    ciHigh: number | null;
    /** Frozen threshold for this gate (`loss` = Jev's observed loss). */
    threshold: number;
    pass: boolean | null;
}

/**
 * Qualification verdict for one challenger arm against the incumbent
 * baseline. `qualified` may be true only when the arm is not blocked
 * and every gate passed; a gate with `pass: null` forces `blocked`.
 */
export interface ComparisonQualificationResult {
    arm: ComparisonModelId;
    /** Incumbent arm, `~typesafe/jev-latest`. */
    baseline: ComparisonModelId;
    /** Exactly one result per frozen gate id. */
    gates: ComparisonGateResult[];
    /** True ⇔ `blockedReasons` non-empty; a blocked arm can never qualify. */
    blocked: boolean;
    blockedReasons: ComparisonBlockedReason[];
    qualified: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Fail-closed exact-shape check: foreign/extra keys reject the record. */
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
    const actual = Object.keys(value);
    if (actual.length !== keys.length) return false;
    const allowed = new Set(keys);
    return actual.every((key) => allowed.has(key));
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
}

function isFiniteOrNull(value: unknown): value is number | null {
    return value === null || isFiniteNumber(value);
}

function isIntegerInRange(value: unknown, min: number, max: number): value is number {
    return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

/** Token counts: integer ≥ 0 or null. `0` and `null` are distinct states. */
function isTokenCount(value: unknown): value is number | null {
    return value === null || (typeof value === "number" && Number.isInteger(value) && value >= 0);
}

/**
 * Error classes the comparison record contracts may carry: the
 * production `JudgeErrorCode` classes plus `capture_gap`, the additive
 * class for a RECEIVED response whose served identity could not be
 * captured (real `httpStatus`, null identity/provider — method wire
 * records only; the frozen §4.4 attempt record keeps its fail-closed
 * capture rejection and admits no capture-gap shape).
 */
export type ComparisonErrorClass = JudgeErrorCode | "capture_gap";

const JUDGE_ERROR_CLASS_CODES = new Set<string>([
    "no_key",
    "endpoint_not_allowed",
    "oauth_only",
    "timeout",
    "network",
    "bad_response",
    "sidecar_unavailable",
    "warming",
    // Additive: received response with an un-capturable served identity
    // (method wire records keep their real httpStatus; see
    // `ComparisonErrorClass`).
    "capture_gap",
]);
const HTTP_ERROR_CLASS = /^http_\d+$/;
/** Canonical payload hash: lowercase hex SHA-256 digest (64 chars). */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Runtime check for the `ComparisonErrorClass` union — the production `JudgeErrorCode` classes plus the additive `capture_gap` (fail-closed on unknown classes). */
export function isJudgeErrorCode(value: unknown): value is ComparisonErrorClass {
    if (typeof value !== "string") return false;
    return JUDGE_ERROR_CLASS_CODES.has(value) || HTTP_ERROR_CLASS.test(value);
}

/** Exact frozen arm slugs only — any other string is rejected. */
export function isComparisonModelId(value: unknown): value is ComparisonModelId {
    return typeof value === "string" && (COMPARISON_MODELS as readonly string[]).includes(value);
}

export function isComparisonBlockedReason(value: unknown): value is ComparisonBlockedReason {
    return typeof value === "string" && (COMPARISON_BLOCKED_REASONS as readonly string[]).includes(value);
}

function isBlockedReasonArray(value: unknown): value is ComparisonBlockedReason[] {
    if (!Array.isArray(value)) return false;
    const seen = new Set<string>();
    for (const item of value) {
        if (!isComparisonBlockedReason(item) || seen.has(item)) return false;
        seen.add(item);
    }
    return true;
}

const ATTEMPT_COST_KEYS_KNOWN = ["status", "usd"] as const;
const ATTEMPT_COST_KEYS_UNKNOWN = ["status", "reserveUsd"] as const;

/** Cost guard: `unknown` MUST carry a positive reserve; anything else is rejected. */
export function isComparisonAttemptCost(value: unknown): value is ComparisonAttemptCost {
    if (!isPlainObject(value)) return false;
    if (value.status === "known") {
        return hasExactKeys(value, ATTEMPT_COST_KEYS_KNOWN)
            && isFiniteNumber(value.usd) && value.usd >= 0;
    }
    if (value.status === "unknown") {
        return hasExactKeys(value, ATTEMPT_COST_KEYS_UNKNOWN)
            && isFiniteNumber(value.reserveUsd) && value.reserveUsd > 0;
    }
    return false;
}

const ATTEMPT_RECORD_KEYS = [
    "attemptId",
    "arm",
    "servedModel",
    "provider",
    "queryGroup",
    "unitId",
    "replica",
    "attemptIndex",
    "warmup",
    "requestBytes",
    "payloadSha256",
    "httpStatus",
    "probability",
    "inputTokens",
    "outputTokens",
    "cost",
    "errorClass",
] as const;

/** Fail-closed attempt-record guard (§4.4 capture rules, see `ComparisonAttemptRecord`). */
export function isComparisonAttemptRecord(value: unknown): value is ComparisonAttemptRecord {
    if (!isPlainObject(value) || !hasExactKeys(value, ATTEMPT_RECORD_KEYS)) return false;
    if (!isNonEmptyString(value.attemptId)) return false;
    if (!isComparisonModelId(value.arm)) return false;
    if (value.servedModel !== null && !isNonEmptyString(value.servedModel)) return false;
    if (value.provider !== null && !isNonEmptyString(value.provider)) return false;
    if (typeof value.payloadSha256 !== "string" || !SHA256_HEX.test(value.payloadSha256)) return false;
    if (typeof value.warmup !== "boolean") return false;
    if (!isNonEmptyString(value.unitId)) return false;
    // queryGroup: a warmup carries none; a scored attempt always carries one.
    if (value.queryGroup === null) {
        if (value.warmup !== true) return false;
    } else if (value.warmup !== false || !isNonEmptyString(value.queryGroup)) {
        return false;
    }
    if (!isIntegerInRange(value.replica, 0, FROZEN_REPLICA_COUNT - 1)) return false;
    if (!isIntegerInRange(value.attemptIndex, 1, Number.MAX_SAFE_INTEGER)) return false;
    if (!isIntegerInRange(value.requestBytes, 0, Number.MAX_SAFE_INTEGER)) return false;
    if (value.httpStatus !== null && !isIntegerInRange(value.httpStatus, 100, 599)) return false;
    // A received response (any HTTP status, including a 2xx with a
    // parseable envelope) must carry the served identity verbatim;
    // only a transport failure (httpStatus null, cross-checked below)
    // may omit it. Missing identity on a response is a capture
    // rejection at validation — no record, no downstream block reason.
    if (value.httpStatus !== null && !isNonEmptyString(value.servedModel)) return false;
    if (value.probability !== null
        && !(typeof value.probability === "number" && Number.isFinite(value.probability)
            && value.probability >= 0 && value.probability <= 1)) {
        return false;
    }
    if (!isTokenCount(value.inputTokens) || !isTokenCount(value.outputTokens)) return false;
    if (!isComparisonAttemptCost(value.cost)) return false;
    if (value.errorClass !== null && !isJudgeErrorCode(value.errorClass)) return false;
    // `capture_gap` is admitted by the method wire contract only; the frozen
    // §4.4 attempt record keeps its fail-closed capture rejection, so its
    // acceptance set is unchanged by the additive class.
    if (value.errorClass === "capture_gap") return false;

    // Cross-field capture invariants.
    if (value.probability !== null) {
        if (value.errorClass !== null) return false;
        if (typeof value.httpStatus !== "number" || value.httpStatus < 200 || value.httpStatus > 299) return false;
    }
    // A scored unit without a probability must name a failure class (capture gap otherwise).
    if (value.probability === null && value.errorClass === null && value.warmup !== true) return false;
    if (value.httpStatus === null) {
        if (value.errorClass === null) return false;
        if (value.servedModel !== null) return false;
        if (value.provider !== null) return false;
    }
    if (typeof value.errorClass === "string" && value.errorClass.startsWith("http_")) {
        if (value.httpStatus !== Number(value.errorClass.slice("http_".length))) return false;
    }
    if (typeof value.httpStatus === "number" && value.httpStatus >= 400 && value.errorClass === null) return false;
    return true;
}

/**
 * Cross-record identity/provenance drift scan (§4.4,
 * parent-frozen 2026-10-08 pre-data) over attempt records. Returns
 * the frozen blocked reasons implied by the records:
 *
 * - `served_identity_drift`: a recorded served identity that differs
 *   from `COMPARISON_SERVED_MODEL_ALLOWLIST` for its arm (recorded
 *   verbatim, no waiver; a `null` served identity can only accompany
 *   a transport failure — `isComparisonAttemptRecord` rejects a null
 *   identity on any received response — so it is not drift).
 * - `payload_drift`: two records for the same unit — same arm and
 *   same query group (or both warmups) — carrying different payload
 *   hashes. Retries and all five replicas of one unit must send
 *   byte-identical request bodies.
 *
 * Fail-closed: an invalid attempt record throws instead of being
 * skipped, and an empty input yields no reasons only because there
 * is nothing to scan.
 */
export function detectComparisonAttemptDrift(records: readonly ComparisonAttemptRecord[]): ComparisonBlockedReason[] {
    let identityDrift = false;
    let payloadDrift = false;
    const unitPayloads = new Map<string, string>();
    for (const record of records) {
        if (!isComparisonAttemptRecord(record)) {
            throw new Error("detectComparisonAttemptDrift: invalid attempt record");
        }
        if (record.servedModel !== null) {
            const allowed: string | undefined = COMPARISON_SERVED_MODEL_ALLOWLIST[record.arm];
            if (record.servedModel !== allowed) identityDrift = true;
        }
        const unitKey = `${record.arm}\u0000${record.warmup ? "warmup" : record.queryGroup}\u0000${record.unitId}`;
        const prior = unitPayloads.get(unitKey);
        if (prior === undefined) unitPayloads.set(unitKey, record.payloadSha256);
        else if (prior !== record.payloadSha256) payloadDrift = true;
    }
    const reasons: ComparisonBlockedReason[] = [];
    if (identityDrift) reasons.push("served_identity_drift");
    if (payloadDrift) reasons.push("payload_drift");
    return reasons;
}

const ARM_RUN_SUMMARY_KEYS = [
    "arm",
    "replicasPlanned",
    "replicasObserved",
    "unitsPlanned",
    "unitsWithValidAverage",
    "unitsUnjudged",
    "attemptedRequests",
    "successfulResponses",
    "warmupAttempts",
    "knownCostAttempts",
    "unknownCostAttempts",
    "knownCostUsd",
    "unknownCostReserveUsd",
    "costComplete",
    "runCompleted",
    "blockedReasons",
] as const;

/** Fail-closed per-arm summary guard; see `ComparisonArmRunSummary` invariants. */
export function isComparisonArmRunSummary(value: unknown): value is ComparisonArmRunSummary {
    if (!isPlainObject(value) || !hasExactKeys(value, ARM_RUN_SUMMARY_KEYS)) return false;
    if (!isComparisonModelId(value.arm)) return false;
    if (value.replicasPlanned !== FROZEN_REPLICA_COUNT) return false;
    if (value.unitsPlanned !== FROZEN_CORPUS_UNITS) return false;
    if (!isIntegerInRange(value.replicasObserved, 0, FROZEN_REPLICA_COUNT)) return false;
    if (!isIntegerInRange(value.unitsWithValidAverage, 0, FROZEN_CORPUS_UNITS)) return false;
    if (!isIntegerInRange(value.unitsUnjudged, 0, FROZEN_CORPUS_UNITS)) return false;
    if (value.unitsWithValidAverage + value.unitsUnjudged !== value.unitsPlanned) return false;
    if (!isIntegerInRange(value.attemptedRequests, 0, Number.MAX_SAFE_INTEGER)) return false;
    if (!isIntegerInRange(value.successfulResponses, 0, value.attemptedRequests)) return false;
    if (!isIntegerInRange(value.warmupAttempts, 0, value.attemptedRequests)) return false;
    if (!isIntegerInRange(value.knownCostAttempts, 0, value.attemptedRequests)) return false;
    if (!isIntegerInRange(value.unknownCostAttempts, 0, value.attemptedRequests)) return false;
    if (value.knownCostAttempts + value.unknownCostAttempts !== value.attemptedRequests) return false;
    if (!isFiniteNumber(value.knownCostUsd) || value.knownCostUsd < 0) return false;
    if (!isFiniteNumber(value.unknownCostReserveUsd) || value.unknownCostReserveUsd < 0) return false;
    if (typeof value.costComplete !== "boolean") return false;
    if (value.costComplete !== (value.unknownCostAttempts === 0)) return false;
    if (typeof value.runCompleted !== "boolean") return false;
    // Unknown costs must retain a real reservation, covering every
    // unknown attempt at the frozen per-attempt reserve (§4.4,
    // parent-frozen 2026-10-08 pre-data; never $0).
    if (value.unknownCostAttempts > 0) {
        if (value.unknownCostReserveUsd <= 0) return false;
        const perAttemptReserve = requestReserveUsd(value.arm);
        if (value.unknownCostReserveUsd < value.unknownCostAttempts * perAttemptReserve) return false;
    }
    if (!isBlockedReasonArray(value.blockedReasons)) return false;
    return value.blockedReasons.includes("aborted_run") === (value.runCompleted === false);
}

function isGateId(value: unknown): value is ComparisonGateId {
    return typeof value === "string" && (COMPARISON_GATE_IDS as readonly string[]).includes(value);
}

type GateGoverningInput = "value" | "ciLow" | "ciHigh";

function gateGoverningInput(gate: ComparisonGateId): GateGoverningInput {
    switch (gate) {
        case "recall_ci":
        case "auroc_ni":
        case "hard_negative_precision_ni":
        case "utility_harm_stop":
            return "ciLow";
        case "brier_ni":
            return "ciHigh";
        default:
            return "value";
    }
}

/** Recompute the frozen pass rule for one gate (used by the validator to reject tampered records). */
function gatePass(
    gate: ComparisonGateId,
    value: number,
    ciLow: number | null,
    ciHigh: number | null,
    threshold: number,
): boolean {
    switch (gate) {
        case "recall_ci":
        case "auroc_ni":
        case "hard_negative_precision_ni":
        case "utility_harm_stop":
            return (ciLow as number) >= threshold;
        case "brier_ni":
            return (ciHigh as number) <= threshold;
        case "availability":
            return value >= threshold;
        case "net_fn":
        case "unjudged":
        case "loss":
        case "ece_harm_stop":
            return value <= threshold;
        default: {
            const exhaustive: never = gate;
            return exhaustive;
        }
    }
}

const GATE_RESULT_KEYS = ["gate", "value", "ciLow", "ciHigh", "threshold", "pass"] as const;

/** Fail-closed gate guard: frozen thresholds enforced, `pass` must match its own numbers. */
export function isComparisonGateResult(value: unknown): value is ComparisonGateResult {
    if (!isPlainObject(value) || !hasExactKeys(value, GATE_RESULT_KEYS)) return false;
    const gate = value.gate;
    if (!isGateId(gate)) return false;
    if (!isFiniteOrNull(value.value) || !isFiniteOrNull(value.ciLow) || !isFiniteOrNull(value.ciHigh)) return false;
    if (!isFiniteNumber(value.threshold)) return false;
    if (value.pass !== null && typeof value.pass !== "boolean") return false;
    if (typeof value.ciLow === "number" && typeof value.ciHigh === "number" && value.ciLow > value.ciHigh) return false;

    if (gate === "loss") {
        if (value.threshold < 0) return false;
    } else if (value.threshold !== COMPARISON_GATE_THRESHOLDS[gate]) {
        return false;
    }

    const governing = gateGoverningInput(gate);
    const inputsComplete = value.value !== null
        && (governing === "value"
            || (governing === "ciLow" ? value.ciLow !== null : value.ciHigh !== null));
    if (value.pass !== null) {
        if (!inputsComplete) return false;
        const expected = gatePass(gate, value.value as number, value.ciLow as number | null, value.ciHigh as number | null, value.threshold);
        return expected === value.pass;
    }
    // pass: null is only valid when the governing input is missing (blocked).
    return !inputsComplete;
}

const QUALIFICATION_RESULT_KEYS = ["arm", "baseline", "gates", "blocked", "blockedReasons", "qualified"] as const;

/** Fail-closed qualification guard: full gate coverage, blocked/qualified consistency, undefined precision must carry its specific reason. */
export function isComparisonQualificationResult(value: unknown): value is ComparisonQualificationResult {
    if (!isPlainObject(value) || !hasExactKeys(value, QUALIFICATION_RESULT_KEYS)) return false;
    if (!isComparisonModelId(value.arm) || !isComparisonModelId(value.baseline)) return false;
    if (value.arm === value.baseline) return false;
    if (typeof value.blocked !== "boolean" || typeof value.qualified !== "boolean") return false;
    if (!isBlockedReasonArray(value.blockedReasons)) return false;
    if (!Array.isArray(value.gates) || value.gates.length !== COMPARISON_GATE_IDS.length) return false;

    const seen = new Set<ComparisonGateId>();
    let allPass = true;
    let anyUndecided = false;
    let precisionUndefined = false;
    for (const entry of value.gates) {
        if (!isComparisonGateResult(entry)) return false;
        if (seen.has(entry.gate)) return false;
        seen.add(entry.gate);
        if (entry.gate === "hard_negative_precision_ni" && entry.value === null) precisionUndefined = true;
        if (entry.pass === null) anyUndecided = true;
        else if (entry.pass === false) allPass = false;
    }
    if (seen.size !== COMPARISON_GATE_IDS.length) return false;
    if (value.blocked !== (value.blockedReasons.length > 0)) return false;
    if (anyUndecided && !value.blocked) return false;
    // Zero-selection precision (§4.4) must carry its specific block
    // reason: blocking for an unrelated reason alone is not enough.
    if (precisionUndefined && !value.blockedReasons.includes("undefined_precision")) return false;
    if (value.blocked && value.qualified) return false;
    // `qualified` must EQUAL the gate outcome in both directions (§4.4:
    // every gate `pass === true` with no blocked reasons ⇔ `qualified`).
    // Rejecting `qualified: false` while everything passes is as
    // load-bearing as the inverse above: a passing unblocked arm is
    // qualified — selection (not qualification) is where cost,
    // tie-breaks, and cross-arm harm stops apply. Harm-stop gates are
    // among the frozen gates, so a fired harm stop fails `allPass` here.
    return value.qualified === (allPass && !value.blocked);
}

/** Absolute tolerance for summing per-record USD amounts in the binders. */
const COST_SUM_TOLERANCE_USD = 1e-9;

/** Drift reasons recomputable from attempt records by `detectComparisonAttemptDrift`. */
const DRIFT_BLOCKED_REASONS: readonly ComparisonBlockedReason[] = [
    "served_identity_drift",
    "payload_drift",
];

/**
 * End-to-end report binder (§4.4): the final report must pass this,
 * not just the per-record validators. Fail-closed — every check
 * rejects on invalid, foreign-arm, missing, or mismatched input.
 *
 * - Each attempt must be a valid record for the qualification's arm.
 *   `detectComparisonAttemptDrift` is recomputed from them: every
 *   detected reason must appear in both the qualification's and the
 *   arm run summary's `blockedReasons`, and neither may declare a
 *   drift reason the records do not produce. A blocked arm can never
 *   be selected (`blocked ⇒ ¬qualified`, via the qualification guard).
 * - The summaries must be valid with unique arms and include exactly
 *   one for the qualification's arm, whose counts are bound to the
 *   attempt records: `attemptedRequests`, `warmupAttempts`,
 *   `successfulResponses` (2xx with a parseable envelope), the
 *   known/unknown cost partition, and `unknownCostReserveUsd` as the
 *   sum of the unknown records' retained `reserveUsd`.
 *
 * This binder does NOT bind planned scored-outcome coverage: an
 * empty attempt list can accompany a validator-valid summary.
 * `isComparisonReportConsistent` calls this binder first and then
 * binds the planned unit set, outcomes, attempt links, and replica
 * averages; a final report must pass that gate as well.
 */
export function isComparisonQualificationConsistentWith(
    qualification: unknown,
    attempts: readonly unknown[],
    summaries: readonly unknown[],
): boolean {
    if (!isComparisonQualificationResult(qualification)) return false;
    const arm = qualification.arm;

    const armAttempts: ComparisonAttemptRecord[] = [];
    for (const raw of attempts) {
        if (!isComparisonAttemptRecord(raw) || raw.arm !== arm) return false;
        armAttempts.push(raw);
    }

    let armSummary: ComparisonArmRunSummary | null = null;
    const summaryArms = new Set<ComparisonModelId>();
    for (const raw of summaries) {
        if (!isComparisonArmRunSummary(raw)) return false;
        if (summaryArms.has(raw.arm)) return false;
        summaryArms.add(raw.arm);
        if (raw.arm === arm) armSummary = raw;
    }
    if (armSummary === null) return false;
    const summary = armSummary;

    let warmupAttempts = 0;
    let successfulResponses = 0;
    let knownCostAttempts = 0;
    let unknownCostAttempts = 0;
    let reserveSumUsd = 0;
    for (const record of armAttempts) {
        if (record.warmup) warmupAttempts += 1;
        if (record.httpStatus !== null && record.httpStatus >= 200
            && record.httpStatus <= 299 && record.errorClass === null) {
            successfulResponses += 1;
        }
        if (record.cost.status === "known") {
            knownCostAttempts += 1;
        } else {
            unknownCostAttempts += 1;
            reserveSumUsd += record.cost.reserveUsd;
        }
    }
    if (summary.attemptedRequests !== armAttempts.length) return false;
    if (summary.warmupAttempts !== warmupAttempts) return false;
    if (summary.successfulResponses !== successfulResponses) return false;
    if (summary.knownCostAttempts !== knownCostAttempts) return false;
    if (summary.unknownCostAttempts !== unknownCostAttempts) return false;
    if (Math.abs(summary.unknownCostReserveUsd - reserveSumUsd) > COST_SUM_TOLERANCE_USD) return false;

    const detectedDrift = detectComparisonAttemptDrift(armAttempts);
    for (const reason of detectedDrift) {
        if (!qualification.blockedReasons.includes(reason)) return false;
        if (!summary.blockedReasons.includes(reason)) return false;
    }
    for (const reasons of [qualification.blockedReasons, summary.blockedReasons]) {
        for (const reason of reasons) {
            if (DRIFT_BLOCKED_REASONS.includes(reason) && !detectedDrift.includes(reason)) return false;
        }
    }
    return true;
}

/* ──────────────────────────────────────────────────────────────────
 * Scored-outcome records — frozen §4.4 metric inputs
 * (parent-frozen 2026-10-08 pre-data). The legacy `ScoreRow` above
 * is legacy-only; these validated records are the machine-readable
 * metric inputs the statistics stage must consume.
 * ──────────────────────────────────────────────────────────────── */

/**
 * Truth classes at the policy level: the three frozen corpus classes
 * (78 gold / 148 hard-negative / 88 other negatives, §4.4). Fixture
 * labels map 1:1 via `truthClassFromFixtureLabel`.
 */
export const COMPARISON_TRUTH_CLASSES = Object.freeze([
    "gold",
    "hard-negative",
    "other-negative",
] as const);
export type ComparisonTruthClass = (typeof COMPARISON_TRUTH_CLASSES)[number];

/**
 * Map a fixture row label (`PlanFixtureRow.label` in
 * `model-comparison-plan.ts`: `gold` / `hard_negative` /
 * `easy_negative`) to the frozen policy truth class. Unknown labels
 * return null so callers fail closed; truth is never inferred from
 * any non-fixture source.
 */
export function truthClassFromFixtureLabel(label: unknown): ComparisonTruthClass | null {
    if (label === "gold") return "gold";
    if (label === "hard_negative") return "hard-negative";
    if (label === "easy_negative") return "other-negative";
    return null;
}

export function isComparisonTruthClass(value: unknown): value is ComparisonTruthClass {
    return typeof value === "string" && (COMPARISON_TRUTH_CLASSES as readonly string[]).includes(value);
}

/**
 * One validated scored outcome: arm × unit × replica.
 *
 * `file` is the fixture's candidate identity field (the source path
 * of the candidate range, `PlanFixtureRow.file`); `queryGroup` is the
 * `set:qid` group; `attemptIds` links the
 * `ComparisonAttemptRecord.attemptId`s that produced this outcome
 * (every attempt for this unit/replica, so retries stay auditable).
 * `probability` is null only for a recorded unjudged outcome — a
 * capture gap blocks at the summary level and is never synthesized.
 */
export interface ComparisonScoredOutcome {
    arm: ComparisonModelId;
    queryGroup: string;
    unitId: string;
    /** Fixture candidate identity: `PlanFixtureRow.file` (candidate source path). */
    file: string;
    /** Replica index 0..4. */
    replica: number;
    /** Fixture-derived truth class (see `truthClassFromFixtureLabel`). */
    truth: ComparisonTruthClass;
    /** Valid probability in [0,1], or null when recorded unjudged — never 0.5. */
    probability: number | null;
    /** Linked attempt ids (`ComparisonAttemptRecord.attemptId`), non-empty and unique. */
    attemptIds: string[];
}

const SCORED_OUTCOME_KEYS = [
    "arm",
    "queryGroup",
    "unitId",
    "file",
    "replica",
    "truth",
    "probability",
    "attemptIds",
] as const;

function isProbabilityOrNull(value: unknown): value is number | null {
    return value === null || (isFiniteNumber(value) && value >= 0 && value <= 1);
}

function isAttemptIdList(value: unknown): value is string[] {
    if (!Array.isArray(value) || value.length === 0) return false;
    const seen = new Set<string>();
    for (const item of value) {
        if (!isNonEmptyString(item) || seen.has(item)) return false;
        seen.add(item);
    }
    return true;
}

/** Fail-closed scored-outcome guard: exact shape, frozen replica range, fixture-derived truth. */
export function isComparisonScoredOutcome(value: unknown): value is ComparisonScoredOutcome {
    if (!isPlainObject(value) || !hasExactKeys(value, SCORED_OUTCOME_KEYS)) return false;
    if (!isComparisonModelId(value.arm)) return false;
    if (!isNonEmptyString(value.queryGroup) || !isNonEmptyString(value.unitId) || !isNonEmptyString(value.file)) return false;
    if (!isIntegerInRange(value.replica, 0, FROZEN_REPLICA_COUNT - 1)) return false;
    if (!isComparisonTruthClass(value.truth)) return false;
    if (!isProbabilityOrNull(value.probability)) return false;
    if (!isAttemptIdList(value.attemptIds)) return false;
    return true;
}

/**
 * Replica-averaged record for one unit (§4.4 estimand point 1): the
 * per-unit score is the mean probability across the five replicas. A
 * non-null average therefore requires exactly `FROZEN_REPLICA_COUNT`
 * contributing replicas; any missing replica leaves the average
 * null (the unit counts as unjudged at the summary level).
 * `isComparisonUnitAverageDerivedFrom` binds the record to its
 * outcome rows.
 */
export interface ComparisonUnitAverage {
    arm: ComparisonModelId;
    queryGroup: string;
    unitId: string;
    /** Fixture candidate identity: `PlanFixtureRow.file` (candidate source path). */
    file: string;
    /** Fixture-derived truth class (see `truthClassFromFixtureLabel`). */
    truth: ComparisonTruthClass;
    /** Replicas with a valid probability contributing to this record (0..5). */
    replicasAveraged: number;
    /** Mean across the five replicas; null unless all five contributed. Never a convention value. */
    averageProbability: number | null;
}

const UNIT_AVERAGE_KEYS = [
    "arm",
    "queryGroup",
    "unitId",
    "file",
    "truth",
    "replicasAveraged",
    "averageProbability",
] as const;

/** Fail-closed replica-average guard: non-null average ⇔ all five replicas contributed. */
export function isComparisonUnitAverage(value: unknown): value is ComparisonUnitAverage {
    if (!isPlainObject(value) || !hasExactKeys(value, UNIT_AVERAGE_KEYS)) return false;
    if (!isComparisonModelId(value.arm)) return false;
    if (!isNonEmptyString(value.queryGroup) || !isNonEmptyString(value.unitId) || !isNonEmptyString(value.file)) return false;
    if (!isComparisonTruthClass(value.truth)) return false;
    if (!isIntegerInRange(value.replicasAveraged, 0, FROZEN_REPLICA_COUNT)) return false;
    if (!isProbabilityOrNull(value.averageProbability)) return false;
    return (value.averageProbability !== null) === (value.replicasAveraged === FROZEN_REPLICA_COUNT);
}

/**
 * Bind a `ComparisonUnitAverage` to its outcome rows (fail-closed):
 * every outcome must share the average's identity, no replica index
 * may repeat, `replicasAveraged` must equal the count of non-null
 * outcome probabilities, and a non-null average must equal the mean
 * of the five probabilities summed in ascending replica order
 * (absolute tolerance 1e-12 for double rounding). Empty outcome
 * sets, mixed identities, duplicate replicas, or a tampered mean
 * reject.
 */
export function isComparisonUnitAverageDerivedFrom(outcomes: readonly unknown[], average: unknown): boolean {
    if (!isComparisonUnitAverage(average)) return false;
    if (outcomes.length === 0 || outcomes.length > FROZEN_REPLICA_COUNT) return false;
    const records: ComparisonScoredOutcome[] = [];
    const seenReplicas = new Set<number>();
    let nonNull = 0;
    for (const raw of outcomes) {
        if (!isComparisonScoredOutcome(raw)) return false;
        if (raw.arm !== average.arm || raw.queryGroup !== average.queryGroup
            || raw.unitId !== average.unitId || raw.file !== average.file
            || raw.truth !== average.truth) {
            return false;
        }
        if (seenReplicas.has(raw.replica)) return false;
        seenReplicas.add(raw.replica);
        if (raw.probability !== null) nonNull += 1;
        records.push(raw);
    }
    if (average.replicasAveraged !== nonNull) return false;
    if (average.averageProbability === null) return nonNull !== FROZEN_REPLICA_COUNT;
    records.sort((a, b) => a.replica - b.replica);
    const probabilities = records.map((record) => record.probability).filter((p): p is number => p !== null);
    const mean = probabilities.reduce((sum, p) => sum + p, 0) / FROZEN_REPLICA_COUNT;
    return Math.abs(mean - average.averageProbability) <= 1e-12;
}

/* -----------------------------------------------------------------
 * Full report gate — planned scored-outcome coverage binding
 * (§4.4 "End-to-end report binding").
 * `isComparisonQualificationConsistentWith` binds qualification ↔
 * attempts ↔ summaries; the gate below additionally binds the
 * planned unit set, scored outcomes, attempt links, replica
 * averages, and the summary's coverage/cost claims, so a report
 * can never validate with coverage its records do not show (e.g.
 * zero attempts behind a 313-unit valid-average claim).
 * ----------------------------------------------------------------- */

/**
 * Identity of one planned scored unit: the fixture row's query
 * group plus its packed unit id — the unit id set produced by
 * `toItems` in `model-comparison-plan.ts` (`u0…u{n-1}` per
 * `set:qid` group, so unit ids repeat across groups) — plus the
 * fixture identity every outcome and average for the unit must
 * carry.
 */
export interface ComparisonPlannedUnit {
    /** `set:qid` query group, as packed into attempt records. */
    queryGroup: string;
    /** Packed unit id within the group (e.g. `u0`); unique per group only. */
    unitId: string;
    /** Fixture candidate identity: `PlanFixtureRow.file`. */
    file: string;
    /** Fixture-derived truth class (via `truthClassFromFixtureLabel`). */
    truth: ComparisonTruthClass;
}

const PLANNED_UNIT_KEYS = ["queryGroup", "unitId", "file", "truth"] as const;

/** Fail-closed planned-unit guard: exact shape and fixture-derived truth. */
export function isComparisonPlannedUnit(value: unknown): value is ComparisonPlannedUnit {
    if (!isPlainObject(value) || !hasExactKeys(value, PLANNED_UNIT_KEYS)) return false;
    return isNonEmptyString(value.queryGroup) && isNonEmptyString(value.unitId)
        && isNonEmptyString(value.file) && isComparisonTruthClass(value.truth);
}

/**
 * Frozen planned-unit identity digest (§4.4 report binding): the report's
 * planned unit list must hash to this value. Composition checks alone
 * (314 units / 44 groups / 78/148/88 truth classes) accept a corpus of
 * renamed groups and fabricated paths; the digest binds identity to the
 * real fixture.
 *
 * Derived once, pre-data 2026-10-08, from the real fixture loaded through
 * `loadSetRows` in `model-comparison-plan.ts` (`PLAN_DATA_DIR`:
 * `set-a.jsonl` + `set-b.jsonl`): rows grouped by `set:qid` in file order,
 * packed unit ids `u0…u{n-1}` per group (the `toItems` assignment), truth
 * mapped by `truthClassFromFixtureLabel`.
 *
 * Canonical serialization — exactly this, recomputable independently:
 * 1. Each unit becomes the 4-string tuple `[queryGroup, unitId, file,
 *    truth]` — field order is `PLANNED_UNIT_KEYS`.
 * 2. Tuples are sorted ascending by tuple: fields compared pairwise as
 *    UTF-16 code-unit strings (`<`) in tuple order — queryGroup first,
 *    then unitId, then file, then truth.
 * 3. The sorted tuple array is serialized with `JSON.stringify` (compact
 *    array-of-arrays form) and hashed over its UTF-8 bytes with SHA-256,
 *    lowercase hex digest.
 *
 * Proven by `test/unit/judge/model-comparison-types.test.ts`, which
 * recomputes the value from the fixture file through `loadSetRows`.
 */
export const FROZEN_PLANNED_UNITS_DIGEST = "ac30e32d446e8a22ff5bd67f31e05acee7cc2f3902d880b55eeea9e6db4b8fa1";

/**
 * Canonical serialization of a planned unit list (see
 * `FROZEN_PLANNED_UNITS_DIGEST`): sorted `[queryGroup, unitId, file,
 * truth]` tuples as compact JSON. Sorting makes the digest independent
 * of the caller's input order.
 */
export function canonicalPlannedUnitsSerialization(units: readonly ComparisonPlannedUnit[]): string {
    const sorted = [...units].sort((a, b) => compareCodeUnits(a.queryGroup, b.queryGroup)
        || compareCodeUnits(a.unitId, b.unitId)
        || compareCodeUnits(a.file, b.file)
        || compareCodeUnits(a.truth, b.truth));
    return JSON.stringify(sorted.map((unit) => [unit.queryGroup, unit.unitId, unit.file, unit.truth]));
}

/** UTF-16 code-unit string order (never locale-dependent). */
function compareCodeUnits(a: string, b: string): number {
    return a === b ? 0 : a < b ? -1 : 1;
}

/** SHA-256 hex digest of `canonicalPlannedUnitsSerialization`. */
export function plannedUnitsDigest(units: readonly ComparisonPlannedUnit[]): string {
    return createHash("sha256").update(canonicalPlannedUnitsSerialization(units), "utf-8").digest("hex");
}

/** The frozen decision rule compares every challenger against the incumbent (§4.4). */
const INCUMBENT_BASELINE: ComparisonModelId = "~typesafe/jev-latest";
/** Frozen corpus composition (§4.4 frozen inputs): 44 query groups, 78/148/88 truth classes. */
const FROZEN_QUERY_GROUP_COUNT = 44;
const FROZEN_TRUTH_CLASS_COUNTS: Readonly<Record<ComparisonTruthClass, number>> = Object.freeze({
    gold: 78,
    "hard-negative": 148,
    "other-negative": 88,
});
/** Coverage-derived gate point estimates must match the recomputation (§4.4 estimand formulas). */
const GATE_VALUE_TOLERANCE = 1e-12;

/** Packed unit ids repeat across query groups, so group + id is the unit identity. */
function plannedUnitKey(queryGroup: string, unitId: string): string {
    return `${queryGroup}\u0000${unitId}`;
}

/** HTTP 2xx with a parseable envelope (§4.4 reliability numerator). */
function isSuccessfulAttempt(record: ComparisonAttemptRecord): boolean {
    return record.httpStatus !== null && record.httpStatus >= 200
        && record.httpStatus <= 299 && record.errorClass === null;
}

/** The planned unit set must be exactly the frozen corpus: 314 unique units, 44 groups, 78/148/88 truth classes, hashing to `FROZEN_PLANNED_UNITS_DIGEST`. */
function bindPlannedUnits(raw: readonly unknown[]): Map<string, ComparisonPlannedUnit> | null {
    if (raw.length !== FROZEN_CORPUS_UNITS) return null;
    const planned = new Map<string, ComparisonPlannedUnit>();
    const groups = new Set<string>();
    const truthCounts: Record<ComparisonTruthClass, number> = { gold: 0, "hard-negative": 0, "other-negative": 0 };
    for (const unit of raw) {
        if (!isComparisonPlannedUnit(unit)) return null;
        const key = plannedUnitKey(unit.queryGroup, unit.unitId);
        if (planned.has(key)) return null;
        planned.set(key, unit);
        groups.add(unit.queryGroup);
        truthCounts[unit.truth] += 1;
    }
    if (groups.size !== FROZEN_QUERY_GROUP_COUNT) return null;
    for (const truth of COMPARISON_TRUTH_CLASSES) {
        if (truthCounts[truth] !== FROZEN_TRUTH_CLASS_COUNTS[truth]) return null;
    }
    // Identity, not just composition: the canonical digest must equal the
    // frozen fixture digest, so a report whose groups or paths are renamed
    // fails even when its attempts, outcomes, and averages are internally
    // consistent (§4.4 end-to-end report binding).
    if (plannedUnitsDigest([...planned.values()]) !== FROZEN_PLANNED_UNITS_DIGEST) return null;
    return planned;
}

interface ComparisonAttemptBinding {
    records: ComparisonAttemptRecord[];
    byId: Map<string, ComparisonAttemptRecord>;
    /** Non-warmup attempts by planned-unit key + replica: the dispatched-record ledger per scored unit/replica. */
    ledgers: Map<string, ComparisonAttemptRecord[]>;
}

/** Unique attempt ids, planned scored membership, and an `attemptIndex` 1..n ledger per unit/replica. */
function bindArmAttempts(
    arm: ComparisonModelId,
    planned: ReadonlyMap<string, ComparisonPlannedUnit>,
    raw: readonly unknown[],
): ComparisonAttemptBinding | null {
    const binding: ComparisonAttemptBinding = { records: [], byId: new Map(), ledgers: new Map() };
    for (const value of raw) {
        if (!isComparisonAttemptRecord(value) || value.arm !== arm) return null;
        if (binding.byId.has(value.attemptId)) return null;
        binding.byId.set(value.attemptId, value);
        binding.records.push(value);
        if (value.warmup) continue;
        const queryGroup = value.queryGroup;
        if (queryGroup === null) return null;
        const unitKey = plannedUnitKey(queryGroup, value.unitId);
        if (!planned.has(unitKey)) return null;
        const ledgerKey = `${unitKey}\u0000${value.replica}`;
        const ledger = binding.ledgers.get(ledgerKey);
        if (ledger === undefined) binding.ledgers.set(ledgerKey, [value]);
        else ledger.push(value);
    }
    // A gap or duplicate means a dropped or double-counted dispatched
    // record: the availability denominator and cost sum would lie.
    for (const ledger of binding.ledgers.values()) {
        const indices = ledger.map((record) => record.attemptIndex).sort((a, b) => a - b);
        for (let i = 0; i < indices.length; i += 1) {
            if (indices[i] !== i + 1) return null;
        }
    }
    return binding;
}

/**
 * Every `attemptIds` entry must be an existing, non-warmup attempt
 * of this outcome's group/unit/replica; together they must be
 * exactly that unit/replica's attempt ledger (retries stay
 * auditable, no dispatched record goes unlinked); and `probability`
 * must equal every linked successful attempt's probability, `null`
 * exactly when none succeeded.
 */
function outcomeLinksAttemptLedger(
    outcome: ComparisonScoredOutcome,
    attempts: ComparisonAttemptBinding,
    unitKey: string,
): boolean {
    const ledger = attempts.ledgers.get(`${unitKey}\u0000${outcome.replica}`);
    if (ledger === undefined || ledger.length !== outcome.attemptIds.length) return false;
    let successful = 0;
    for (const attemptId of outcome.attemptIds) {
        const record = attempts.byId.get(attemptId);
        if (record === undefined || record.warmup) return false;
        if (record.queryGroup !== outcome.queryGroup || record.unitId !== outcome.unitId
            || record.replica !== outcome.replica) {
            return false;
        }
        if (isSuccessfulAttempt(record)) {
            successful += 1;
            if (outcome.probability === null || record.probability !== outcome.probability) return false;
        }
    }
    return successful > 0 || outcome.probability === null;
}

/** Outcomes must be the qualification arm's, match the planned unit's identity, and link its ledger. */
function bindOutcomes(
    arm: ComparisonModelId,
    planned: ReadonlyMap<string, ComparisonPlannedUnit>,
    attempts: ComparisonAttemptBinding,
    raw: readonly unknown[],
): Map<string, ComparisonScoredOutcome[]> | null {
    const outcomesByUnit = new Map<string, ComparisonScoredOutcome[]>();
    for (const value of raw) {
        if (!isComparisonScoredOutcome(value) || value.arm !== arm) return null;
        const unitKey = plannedUnitKey(value.queryGroup, value.unitId);
        const unit = planned.get(unitKey);
        if (unit === undefined) return null;
        if (value.file !== unit.file || value.truth !== unit.truth) return null;
        if (!outcomeLinksAttemptLedger(value, attempts, unitKey)) return null;
        const outcomes = outcomesByUnit.get(unitKey);
        if (outcomes === undefined) outcomesByUnit.set(unitKey, [value]);
        else outcomes.push(value);
    }
    return outcomesByUnit;
}

/** Exactly one qualification-arm average per planned unit; no foreign-arm or unplanned extras. */
function bindUnitAverages(
    arm: ComparisonModelId,
    planned: ReadonlyMap<string, ComparisonPlannedUnit>,
    raw: readonly unknown[],
): Map<string, ComparisonUnitAverage> | null {
    const averages = new Map<string, ComparisonUnitAverage>();
    for (const value of raw) {
        if (!isComparisonUnitAverage(value) || value.arm !== arm) return null;
        const unitKey = plannedUnitKey(value.queryGroup, value.unitId);
        if (!planned.has(unitKey) || averages.has(unitKey)) return null;
        averages.set(unitKey, value);
    }
    return averages;
}

interface ComparisonCoverage {
    unitsWithValidAverage: number;
    unitsUnjudged: number;
}

/** Per planned unit: exactly `FROZEN_REPLICA_COUNT` distinct-replica outcomes plus one derived average. */
function deriveUnitCoverage(
    planned: ReadonlyMap<string, ComparisonPlannedUnit>,
    outcomesByUnit: ReadonlyMap<string, ComparisonScoredOutcome[]>,
    averages: ReadonlyMap<string, ComparisonUnitAverage>,
): ComparisonCoverage | null {
    let unitsWithValidAverage = 0;
    let unitsUnjudged = 0;
    for (const unitKey of planned.keys()) {
        const outcomes = outcomesByUnit.get(unitKey);
        if (outcomes === undefined || outcomes.length !== FROZEN_REPLICA_COUNT) return null;
        const replicas = new Set<number>();
        for (const outcome of outcomes) {
            if (replicas.has(outcome.replica)) return null;
            replicas.add(outcome.replica);
        }
        const average = averages.get(unitKey);
        if (average === undefined) return null;
        if (!isComparisonUnitAverageDerivedFrom(outcomes, average)) return null;
        if (average.averageProbability === null) unitsUnjudged += 1;
        else unitsWithValidAverage += 1;
    }
    return { unitsWithValidAverage, unitsUnjudged };
}

/**
 * The arm summary's coverage/cost claims and the coverage-derived
 * gate point estimates must equal values recomputed from the bound
 * records: `unitsWithValidAverage`, `unitsUnjudged`,
 * `replicasObserved`, `knownCostUsd`, availability = successful /
 * attempted, and unjudged = unjudged units / 314 (§4.4 estimand).
 */
function reportClaimsAgree(
    qualification: ComparisonQualificationResult,
    summaries: readonly unknown[],
    attempts: readonly ComparisonAttemptRecord[],
    coverage: ComparisonCoverage,
): boolean {
    let summary: ComparisonArmRunSummary | null = null;
    for (const raw of summaries) {
        if (isComparisonArmRunSummary(raw) && raw.arm === qualification.arm) summary = raw;
    }
    if (summary === null) return false;
    if (!summaryCoverageClaimsAgree(summary, attempts, coverage)) return false;
    return coverageGatesAgree(qualification, summary, coverage);
}

/** Summary coverage/cost counts must equal the recomputation from averages and attempt records. */
function summaryCoverageClaimsAgree(
    summary: ComparisonArmRunSummary,
    attempts: readonly ComparisonAttemptRecord[],
    coverage: ComparisonCoverage,
): boolean {
    if (summary.unitsWithValidAverage !== coverage.unitsWithValidAverage) return false;
    if (summary.unitsUnjudged !== coverage.unitsUnjudged) return false;
    const observedReplicas = new Set<number>();
    let knownCostUsd = 0;
    for (const record of attempts) {
        observedReplicas.add(record.replica);
        if (record.cost.status === "known") knownCostUsd += record.cost.usd;
    }
    if (summary.replicasObserved !== observedReplicas.size) return false;
    return Math.abs(summary.knownCostUsd - knownCostUsd) <= COST_SUM_TOLERANCE_USD;
}

/** Coverage-derived gate point estimates must equal the §4.4 estimand formulas over the bound records. */
function coverageGatesAgree(
    qualification: ComparisonQualificationResult,
    summary: ComparisonArmRunSummary,
    coverage: ComparisonCoverage,
): boolean {
    const availability = qualification.gates.find((gate) => gate.gate === "availability");
    const unjudged = qualification.gates.find((gate) => gate.gate === "unjudged");
    if (availability === undefined || availability.value === null) return false;
    if (unjudged === undefined || unjudged.value === null) return false;
    const expectedAvailability = summary.successfulResponses / summary.attemptedRequests;
    const expectedUnjudged = coverage.unitsUnjudged / FROZEN_CORPUS_UNITS;
    return Math.abs(availability.value - expectedAvailability) <= GATE_VALUE_TOLERANCE
        && Math.abs(unjudged.value - expectedUnjudged) <= GATE_VALUE_TOLERANCE;
}

/**
 * Full report gate (§4.4 "End-to-end report binding"): a final
 * report must pass this on top of the per-record validators and
 * `isComparisonQualificationConsistentWith` (called first) before
 * the arm may be treated as qualified. Fail-closed throughout:
 *
 * - The planned unit set must be exactly the frozen corpus — 314
 *   unique `set:qid` × packed-unit-id entries across 44 query
 *   groups with the frozen 78/148/88 truth-class composition, hashing
 *   to `FROZEN_PLANNED_UNITS_DIGEST` (identity with the real fixture,
 *   not just matching shape) — and
 *   the qualification's `baseline` must be the incumbent.
 * - Every planned unit must have exactly `FROZEN_REPLICA_COUNT`
 *   scored outcomes for the qualification's arm (replicas 0..4,
 *   fixture `file`/`truth` equal to the planned unit; no unplanned
 *   or foreign-arm outcomes), each linked by `attemptIds` to
 *   exactly that unit/replica's non-warmup attempt records with
 *   unique `attemptId`s and an `attemptIndex` 1..n ledger, and
 *   `probability` equal to the linked successful attempt's
 *   probability — `null` exactly when no linked attempt succeeded.
 * - Each planned unit must have exactly one unit average derived
 *   from those outcomes (`isComparisonUnitAverageDerivedFrom`).
 * - The arm summary's coverage/cost claims and the
 *   availability/unjudged gate values must equal the recomputed
 *   values (`reportClaimsAgree`).
 *
 * Any capture gap — a missing outcome, replica, attempt link, or
 * average, or a coverage, cost, or identity disagreement — returns
 * false, so a report cannot claim coverage its records do not show
 * (§4.4 missing data: capture gaps block). `attempts`, `outcomes`,
 * and `unitAverages` follow the same single-arm contract as
 * `isComparisonQualificationConsistentWith`: the qualification
 * arm's records; other arms' summaries are checked for internal
 * consistency only.
 */
export function isComparisonReportConsistent(input: {
    qualification: unknown;
    attempts: readonly unknown[];
    summaries: readonly unknown[];
    outcomes: readonly unknown[];
    unitAverages: readonly unknown[];
    plannedUnits: readonly unknown[];
}): boolean {
    if (!isComparisonQualificationResult(input.qualification)) return false;
    const arm = input.qualification.arm;
    if (input.qualification.baseline !== INCUMBENT_BASELINE) return false;
    if (!isComparisonQualificationConsistentWith(input.qualification, input.attempts, input.summaries)) return false;

    const planned = bindPlannedUnits(input.plannedUnits);
    if (planned === null) return false;
    const attempts = bindArmAttempts(arm, planned, input.attempts);
    if (attempts === null) return false;
    const outcomesByUnit = bindOutcomes(arm, planned, attempts, input.outcomes);
    if (outcomesByUnit === null) return false;
    const averages = bindUnitAverages(arm, planned, input.unitAverages);
    if (averages === null) return false;
    const coverage = deriveUnitCoverage(planned, outcomesByUnit, averages);
    if (coverage === null) return false;
    return reportClaimsAgree(input.qualification, input.summaries, attempts.records, coverage);
}
