/**
 * Method-aware record contract for the judge method-selection pilot
 * (plan §3 "Reuse frozen DTOs without corrupting their meaning", Stage C).
 *
 * This is a SEPARATELY VERSIONED contract (`METHOD_COMPARISON_CONTRACT_VERSION`,
 * "method-comparison/v1"). It does not modify, weaken, or reinterpret the
 * frozen §4.4 DTOs in `model-comparison-types.ts`; it imports their
 * validators/constants (served-model allowlist, cost shapes, model-id and
 * error-class guards) and reuses them wherever the same rule applies.
 *
 * Four record layers:
 *
 * 1. `MethodRecordEnvelope` — the versioned identity of one method-aware
 *    report: method ('M0'|'M1'|'M2'), arm, phase
 *    ('pilot'|'confirmation'|'reference'), the declared replica count
 *    (pilot = 2; confirmation/reference ∈ {5,4,3}), and the sealed
 *    manifest hash.
 * 2. `MethodWireRecord` — ONE record per HTTP request. A single request
 *    may cover many candidates (M0 packed, M2 forward/reverse legs); it
 *    carries payloadSha256, served identity, cost
 *    (known | unknown+reserve), attempt index, the ordered candidate id
 *    list, batch membership (query group/direction/replica), latency and
 *    timestamp, plus per-candidate wire answers
 *    (`probability | null` from that request).
 * 3. `MethodDerivedScore` — the DERIVED per-candidate score. M0/M1: the
 *    wire probability. M2: `(forward + reverse) / 2`, where the forward
 *    leg IS the M0 forward request (recorded once, as method M0, and
 *    reused — never re-issued) and the reverse leg is the reversed-order
 *    request (method M2). A derived score carries no cost: cost lives
 *    only on wire records, so no per-candidate duplication is possible.
 * 4. `MethodPlannedCandidate` — the sealed planned candidate set the
 *    binder checks coverage against (declared, never inferred from
 *    records, so dropping a candidate cannot pass silently).
 *
 * `bindMethodComparisonReport` is the fail-closed binder. It counts each
 * wire request's cost exactly once, recomputes derived scores from wire
 * answers (forged M2 averages are rejected), rejects cross-method /
 * cross-arm / cross-phase links, requires complete coverage for every
 * replica in [0, declared replicaCount), validates payload hash format
 * and served-identity rules consistently with
 * `model-comparison-types.ts`, requires a reverse request's candidate
 * order to be the exact reverse of the forward request, and enforces
 * payload/order agreement plus a gapless attemptIndex ledger within each
 * request component (method+arm+phase+group+direction; hashes must agree
 * across replicas/retries WITHIN a component, not between forward and
 * reverse).
 *
 * Campaign-level spend: report totals MUST NOT be summed across
 * envelopes (the reused M0 forward request appears in both the M0 and
 * M2 envelope tables); `aggregateCampaignWireCosts` is the only
 * supported campaign aggregation — it unions the bound wire tables,
 * deduplicates by `wireId`, and fails closed on conflicting content.
 *
 * Legacy projection: `projectMethodWireToComparisonAttempt` and
 * `projectMethodDerivedToScoredOutcome` project ONLY method M1 (one
 * candidate per request, so one wire probability maps 1:1 onto one
 * frozen attempt/outcome). M0 and M2 deliberately do NOT project 1:1 —
 * a packed M0/M2 request is one HTTP attempt with N answers, and an M2
 * derived score is an average, not a wire probability; projecting either
 * would forge a wire attempt the §4.4 report binder forbids
 * (`outcome probability must equal its linked successful attempt`).
 * The projections return null for M0/M2. Projections are record-level
 * only: they pass the frozen per-record validators, while the frozen
 * full-report gate still binds to the frozen 314-unit five-replica
 * corpus and will (correctly) refuse pilot records.
 */

import { INCUMBENT_ARM } from "./model-comparison-stats.js";
import {
    COMPARISON_SERVED_MODEL_ALLOWLIST,
    FROZEN_REPLICA_COUNT,
    isComparisonAttemptCost,
    isComparisonAttemptRecord,
    isComparisonModelId,
    isComparisonScoredOutcome,
    isJudgeErrorCode,
    type ComparisonAttemptCost,
    type ComparisonAttemptRecord,
    type ComparisonErrorClass,
    type ComparisonModelId,
    type ComparisonScoredOutcome,
    type ComparisonTruthClass,
} from "./model-comparison-types.js";

/* ──────────────────────────────────────────────────────────────────
 * Versioned envelope, phases, directions, replica parameterization
 * ────────────────────────────────────────────────────────────────── */

/** Contract version stamped on every method-aware envelope. */
export const METHOD_COMPARISON_CONTRACT_VERSION = "method-comparison/v1";

/**
 * Capture-rule ruleset stamp (protocol Amendment A3, 2026-10-09,
 * PROSPECTIVE). Wire records produced by the current executor carry
 * `rulesetVersion: "A3"`; records without the field are A1/A2-era and
 * keep the original capture rules byte-for-byte. The stamp is the era
 * boundary: the A3 classification (a received NON-2xx response without
 * a served model is a transport-class `http_<status>` failure, never a
 * `capture_gap`) applies ONLY to stamped records. A records file mixed
 * across eras, or carrying any other stamp value, fails closed in the
 * pilot glue — A3 rules can never be applied to pre-A3 artifacts
 * (protocol §12.A3.4).
 */
export const METHOD_CAPTURE_RULESET_VERSION_A3 = "A3" as const;
export type MethodCaptureRulesetVersion = typeof METHOD_CAPTURE_RULESET_VERSION_A3;

export const METHOD_IDS = Object.freeze(["M0", "M1", "M2"] as const);
export type MethodId = (typeof METHOD_IDS)[number];

export const METHOD_PHASES = Object.freeze(["pilot", "confirmation", "reference"] as const);
export type MethodPhase = (typeof METHOD_PHASES)[number];

export const METHOD_DIRECTIONS = Object.freeze(["forward", "reverse", "isolated"] as const);
export type MethodDirection = (typeof METHOD_DIRECTIONS)[number];

/** Pilot replicas are sealed at 2 (plan §3 / inherited decisions). */
export const PILOT_REPLICA_COUNT = 2;
/** Confirmation (and its deployed reference) replica count: 5, reduced to 4 then 3 only via the measured-projection rule. */
export const CONFIRMATION_REPLICA_COUNTS = Object.freeze([5, 4, 3] as const);

/**
 * Replica-count rule per phase: pilot is exactly 2; confirmation and
 * reference are parameterized over the sealed set {5,4,3} (Stage G owns
 * which one a given confirmation run seals).
 */
export function isValidPhaseReplicaCount(phase: MethodPhase, replicaCount: number): boolean {
    if (phase === "pilot") return replicaCount === PILOT_REPLICA_COUNT;
    return (CONFIRMATION_REPLICA_COUNTS as readonly number[]).includes(replicaCount);
}

/**
 * Directions a wire record of each method may carry. M2 records are the
 * REVERSE leg only: the M2 forward leg is the M0 forward request itself
 * (recorded as method M0 and reused), never a second forward request.
 */
const METHOD_ALLOWED_DIRECTIONS: Readonly<Record<MethodId, readonly MethodDirection[]>> = Object.freeze({
    M0: Object.freeze(["forward"] as const),
    M1: Object.freeze(["isolated"] as const),
    M2: Object.freeze(["reverse"] as const),
});

/**
 * Wire methods admissible inside one envelope. The M2 envelope admits
 * the reused M0 forward records plus its own M2 reverse records; any
 * other method (e.g. an M1 isolated record) is a cross-method link.
 */
const ENVELOPE_ALLOWED_WIRE_METHODS: Readonly<Record<MethodId, readonly MethodId[]>> = Object.freeze({
    M0: Object.freeze(["M0"] as const),
    M1: Object.freeze(["M1"] as const),
    M2: Object.freeze(["M0", "M2"] as const),
});

/** Identity + declared replica count of one method-aware report. */
export interface MethodRecordEnvelope {
    contractVersion: typeof METHOD_COMPARISON_CONTRACT_VERSION;
    method: MethodId;
    arm: ComparisonModelId;
    phase: MethodPhase;
    /** Pilot: 2. Confirmation/reference: one of 5, 4, 3. */
    replicaCount: number;
    /** Sealed manifest hash (lowercase hex SHA-256). */
    manifestSha256: string;
}

/* ──────────────────────────────────────────────────────────────────
 * Wire records: one per HTTP request
 * ────────────────────────────────────────────────────────────────── */

/**
 * One candidate's answer as returned by ONE request. `probability` is
 * null exactly when the request itself did not produce a usable answer
 * (transport failure, non-2xx, or a poisoned batch recorded with an
 * error class); a successful request carries a numeric probability for
 * EVERY candidate it covered.
 */
export interface MethodWireAnswer {
    candidateId: string;
    /** [0,1] from this request, or null when this request yielded no answer. */
    probability: number | null;
}

/**
 * One dispatched HTTP request. Capture rules mirror the frozen
 * `ComparisonAttemptRecord` (§4.4):
 *
 * - A received response (any HTTP status) must carry a non-empty served
 *   identity; identity is never inferred from the requested slug. The ONE
 *   absent-identity exception on a received 2xx is a capture gap: a 2xx
 *   response whose served identity could not be captured keeps its REAL
 *   `httpStatus` and records `errorClass: "capture_gap"` with null identity
 *   and null provider (valid IFF that exact shape; any other
 *   status/identity combination rejects). Amendment A3 (PROSPECTIVE,
 *   `rulesetVersion: "A3"` records only) adds a second absent-identity
 *   shape: a received NON-2xx whose body carried no served model is a
 *   transport-class failure — REAL `httpStatus` + `errorClass:
 *   "http_<status>"` + null identity/provider. A1/A2-era records (no
 *   stamp) admit neither shape. Only a transport failure (`httpStatus`
 *   null, with an error class) may otherwise record `servedModel: null`.
 * - `payloadSha256` is the lowercase hex SHA-256 over the exact request
 *   bytes. Retries and all replicas of one request component must hash
 *   identically (enforced by the binder, not here).
 * - Cost is NEVER omitted: `known` settles `usd ≥ 0`, `unknown` retains
 *   `reserveUsd > 0` (same shapes as `isComparisonAttemptCost`).
 * - Answers align positionally with `candidateIds`; missing, extra, or
 *   reordered answers poison the record (fail-closed).
 * - M1 is exactly one candidate per request; a method/direction
 *   mismatch (e.g. an M0 reverse record) is rejected outright.
 * - Token counts preserve absence as `null` (never zero-filled), and a
 *   successful request (no error class) must be 2xx with numeric
 *   answers for every candidate.
 */
export interface MethodWireRecord {
    /** Stable wire-attempt id (globally unique across envelopes for the physical request). */
    wireId: string;
    method: MethodId;
    arm: ComparisonModelId;
    phase: MethodPhase;
    /** 0-based; valid range is bounded by the envelope's declared replicaCount (binder), and by 0..4 here (frozen projection range). */
    replica: number;
    /** Warmups count for spend/availability, never for coverage or scores. */
    warmup: boolean;
    direction: MethodDirection;
    /** `set:qid`-style group; null only for warmups (same rule as the frozen attempt record). */
    queryGroup: string | null;
    /** Ordered candidate ids submitted in this request (the batch membership). */
    candidateIds: string[];
    /** Absent on A1/A2-era records; `"A3"` on records produced under Amendment A3 capture rules (protocol §12). */
    rulesetVersion?: MethodCaptureRulesetVersion;
    /** 1-based dispatch attempt for this request; retries increment. */
    attemptIndex: number;
    requestBytes: number;
    payloadSha256: string;
    httpStatus: number | null;
    servedModel: string | null;
    provider: string | null;
    inputTokens: number | null;
    outputTokens: number | null;
    cost: ComparisonAttemptCost;
    errorClass: ComparisonErrorClass | null;
    requestTimestamp: string;
    latencyMs: number;
    answers: MethodWireAnswer[];
}

/**
 * DERIVED per-candidate score (never a wire probability in disguise):
 * M0/M1 equal the wire probability of their single request; M2 equals
 * `(forward + reverse) / 2`. `wireIds` links every wire record of the
 * required component(s) for this candidate/replica (retries included),
 * mirroring the frozen `ComparisonScoredOutcome.attemptIds` rule. The
 * record carries no cost field — cost exists only on wire records.
 */
export interface MethodDerivedScore {
    method: MethodId;
    arm: ComparisonModelId;
    phase: MethodPhase;
    replica: number;
    queryGroup: string;
    candidateId: string;
    /** Derived probability in [0,1], or null when a required component is unjudged. Never a convention value. */
    probability: number | null;
    wireIds: string[];
}

/** One sealed planned candidate; the binder's declared coverage universe. */
export interface MethodPlannedCandidate {
    queryGroup: string;
    candidateId: string;
}

/* ──────────────────────────────────────────────────────────────────
 * Fail-closed runtime validators
 * ────────────────────────────────────────────────────────────────── */

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

function isIntegerInRange(value: unknown, min: number, max: number): value is number {
    return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

/**
 * Canonical payload hash: lowercase hex SHA-256 digest (64 chars).
 * Mirrors the (module-private) `SHA256_HEX` in
 * `model-comparison-types.ts`, which exports no standalone hash guard.
 */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Token counts: integer ≥ 0 or null. `0` and `null` are distinct states (same rule as the frozen attempt record). */
function isTokenCount(value: unknown): value is number | null {
    return value === null || (typeof value === "number" && Number.isInteger(value) && value >= 0);
}

function isProbabilityOrNull(value: unknown): value is number | null {
    return value === null || (isFiniteNumber(value) && value >= 0 && value <= 1);
}

function isNonEmptyStringList(value: unknown): value is string[] {
    if (!Array.isArray(value) || value.length === 0) return false;
    const seen = new Set<string>();
    for (const item of value) {
        if (!isNonEmptyString(item) || seen.has(item)) return false;
        seen.add(item);
    }
    return true;
}

function isMethodId(value: unknown): value is MethodId {
    return typeof value === "string" && (METHOD_IDS as readonly string[]).includes(value);
}

function isMethodPhase(value: unknown): value is MethodPhase {
    return typeof value === "string" && (METHOD_PHASES as readonly string[]).includes(value);
}

function isMethodDirection(value: unknown): value is MethodDirection {
    return typeof value === "string" && (METHOD_DIRECTIONS as readonly string[]).includes(value);
}

function isDirectionAllowedForMethod(method: MethodId, direction: MethodDirection): boolean {
    return (METHOD_ALLOWED_DIRECTIONS[method] as readonly string[]).includes(direction);
}

function hasValidQueryGroup(queryGroup: unknown, warmup: boolean): boolean {
    if (queryGroup === null) return warmup === true;
    return warmup === false && isNonEmptyString(queryGroup);
}

const ANSWER_KEYS = ["candidateId", "probability"] as const;

/** Answers must be exactly one entry per candidate id, positionally aligned. */
function hasAlignedAnswers(answers: unknown, candidateIds: readonly string[]): answers is MethodWireAnswer[] {
    if (!Array.isArray(answers) || answers.length !== candidateIds.length) return false;
    for (let i = 0; i < answers.length; i += 1) {
        const answer: unknown = answers[i];
        if (!isPlainObject(answer) || !hasExactKeys(answer, ANSWER_KEYS)) return false;
        if (answer.candidateId !== candidateIds[i]) return false;
        if (!isProbabilityOrNull(answer.probability)) return false;
    }
    return true;
}

/**
 * Cross-field capture invariants (mirror §4.4 attempt records): a
 * received status carries a non-empty served identity — the sole
 * A1/A2-era exception being error class `capture_gap`, which marks a
 * RECEIVED response with an un-capturable served identity (valid IFF
 * exactly that shape: real status kept, null identity/provider).
 * Amendment A3 (`rulesetVersion: "A3"` records only) additionally
 * admits a received NON-2xx with absent identity when its error class
 * is the transport class `http_<status>` (never a 2xx — a 2xx without
 * identity remains a capture gap). Only a transport failure (null
 * status + error class) may otherwise omit identity/provider; an
 * `http_*` error class must match the status; a successful request
 * (no error class) is 2xx with a numeric answer for every candidate;
 * any error class means this request produced no answers.
 */
function hasStatusIdentityShape(
    httpStatus: unknown,
    servedModel: unknown,
    provider: unknown,
    errorClass: ComparisonErrorClass | null,
    ruleset: unknown,
): boolean {
    if (httpStatus !== null && !isIntegerInRange(httpStatus, 100, 599)) return false;
    if (provider !== null && !isNonEmptyString(provider)) return false;
    const captureGap = errorClass === "capture_gap";
    if (httpStatus === null) {
        // No response arrived: transport-failure shape only — never a capture gap.
        return !captureGap && servedModel === null && provider === null;
    }
    if (captureGap) {
        // Received response with an un-capturable served identity: the real
        // status is kept and identity/provider are absent (valid IFF this
        // exact shape — a captured identity alongside `capture_gap` rejects).
        // Under A3 a capture gap is reserved for a 2xx; a non-2xx without
        // identity is the `http_<status>` transport class instead.
        if (ruleset === METHOD_CAPTURE_RULESET_VERSION_A3 && !isIntegerInRange(httpStatus, 200, 299)) return false;
        return servedModel === null && provider === null;
    }
    if (ruleset === METHOD_CAPTURE_RULESET_VERSION_A3
        && servedModel === null && provider === null) {
        // Amendment A3 transport class: a received NON-2xx whose body
        // carried no served model records `http_<status>` with absent
        // identity — never a 2xx (that remains a capture gap).
        return !isIntegerInRange(httpStatus, 200, 299)
            && typeof errorClass === "string" && errorClass.startsWith("http_");
    }
    // Non-capture-gap capture rule (§4.4): a received status needs identity.
    return isNonEmptyString(servedModel);
}

function hasErrorAnswerAgreement(
    httpStatus: unknown,
    errorClass: ComparisonErrorClass | null,
    answers: readonly MethodWireAnswer[],
): boolean {
    if (typeof errorClass === "string" && errorClass.startsWith("http_")) {
        if (httpStatus !== Number(errorClass.slice("http_".length))) return false;
    }
    if (errorClass === null) {
        if (!isIntegerInRange(httpStatus, 200, 299)) return false;
        return answers.every((answer) => answer.probability !== null);
    }
    return answers.every((answer) => answer.probability === null);
}

function hasWireCaptureConsistency(
    httpStatus: unknown,
    servedModel: unknown,
    provider: unknown,
    errorClass: ComparisonErrorClass | null,
    answers: readonly MethodWireAnswer[],
    ruleset: unknown,
): boolean {
    if (!hasStatusIdentityShape(httpStatus, servedModel, provider, errorClass, ruleset)) return false;
    return hasErrorAnswerAgreement(httpStatus, errorClass, answers);
}

const ENVELOPE_KEYS = ["contractVersion", "method", "arm", "phase", "replicaCount", "manifestSha256"] as const;

/**
 * The reference phase IS the deployed Jev/M0 configuration (plan §3,
 * A1.3: "Default reference is deployed Jev/M0"): `phase: 'reference'`
 * is valid exactly for the incumbent arm under method 'M0'. Other
 * phases may carry any arm under any method — the pilot runs every
 * arm under M0/M1/M2 (A1.1's equally averaged three-model S_m), and
 * the pilot's Jev/M0 cell is a two-replica pilot report, never a
 * reference report (reference replicas are 5/4/3).
 */
function isReferenceIdentity(method: MethodId, arm: ComparisonModelId, phase: MethodPhase): boolean {
    // Reverse implication intentionally absent: Jev/M0 must stay valid in
    // pilot/confirmation phases — A1.1's S_0 needs the Jev M0 baseline
    // (2 pilot replicas; reference itself only accepts 5/4/3).
    if (phase !== "reference") return true;
    return method === "M0" && arm === INCUMBENT_ARM;
}

/** Fail-closed envelope guard: exact version, frozen slugs, phase-appropriate replica count, sealed-hash format, reference phase bound to the deployed Jev/M0 configuration. */
export function isMethodRecordEnvelope(value: unknown): value is MethodRecordEnvelope {
    if (!isPlainObject(value) || !hasExactKeys(value, ENVELOPE_KEYS)) return false;
    if (value.contractVersion !== METHOD_COMPARISON_CONTRACT_VERSION) return false;
    if (!isMethodId(value.method)) return false;
    if (!isComparisonModelId(value.arm)) return false;
    if (!isMethodPhase(value.phase)) return false;
    if (!isIntegerInRange(value.replicaCount, 1, FROZEN_REPLICA_COUNT)) return false;
    if (typeof value.manifestSha256 !== "string" || !SHA256_HEX.test(value.manifestSha256)) return false;
    if (!isReferenceIdentity(value.method, value.arm, value.phase)) return false;
    return isValidPhaseReplicaCount(value.phase, value.replicaCount);
}

const WIRE_RECORD_KEYS = [
    "wireId",
    "method",
    "arm",
    "phase",
    "replica",
    "warmup",
    "direction",
    "queryGroup",
    "candidateIds",
    "attemptIndex",
    "requestBytes",
    "payloadSha256",
    "httpStatus",
    "servedModel",
    "provider",
    "inputTokens",
    "outputTokens",
    "cost",
    "errorClass",
    "requestTimestamp",
    "latencyMs",
    "answers",
] as const;

/** Identity/leg shape: slugs, method↔direction agreement, warmup/query-group rule (same warmup rule as the frozen attempt record). */
function hasWireIdentityShape(value: Record<string, unknown>): boolean {
    if (!isNonEmptyString(value.wireId)) return false;
    if (!isMethodId(value.method) || !isComparisonModelId(value.arm) || !isMethodPhase(value.phase)) return false;
    if (!isMethodDirection(value.direction) || !isDirectionAllowedForMethod(value.method, value.direction)) return false;
    if (typeof value.warmup !== "boolean") return false;
    return hasValidQueryGroup(value.queryGroup, value.warmup);
}

/** Dispatch/provenance shape: ranges, payload hash format, token nullability, cost shape, timing capture. */
function hasWireDispatchShape(value: Record<string, unknown>): boolean {
    if (!isIntegerInRange(value.replica, 0, FROZEN_REPLICA_COUNT - 1)) return false;
    if (!isIntegerInRange(value.attemptIndex, 1, Number.MAX_SAFE_INTEGER)) return false;
    if (!isIntegerInRange(value.requestBytes, 0, Number.MAX_SAFE_INTEGER)) return false;
    if (typeof value.payloadSha256 !== "string" || !SHA256_HEX.test(value.payloadSha256)) return false;
    if (!isTokenCount(value.inputTokens) || !isTokenCount(value.outputTokens)) return false;
    if (!isComparisonAttemptCost(value.cost)) return false;
    if (!isNonEmptyString(value.requestTimestamp)) return false;
    return isFiniteNumber(value.latencyMs) && value.latencyMs >= 0;
}

/** Fail-closed wire-record guard (see `MethodWireRecord` capture rules). Accepts the exact A1/A2-era key set, or that set plus the A3 `rulesetVersion` stamp; any other key shape, or an unknown stamp value, rejects. */
export function isMethodWireRecord(value: unknown): value is MethodWireRecord {
    if (!isPlainObject(value)) return false;
    let ruleset: unknown = undefined;
    if (Object.keys(value).length === WIRE_RECORD_KEYS.length + 1 && Object.hasOwn(value, "rulesetVersion")) {
        ruleset = value.rulesetVersion;
        const base: Record<string, unknown> = { ...value };
        delete base.rulesetVersion;
        if (!hasExactKeys(base, WIRE_RECORD_KEYS)) return false;
    } else if (!hasExactKeys(value, WIRE_RECORD_KEYS)) {
        return false;
    }
    if (ruleset !== undefined && ruleset !== METHOD_CAPTURE_RULESET_VERSION_A3) return false;
    if (!hasWireIdentityShape(value)) return false;
    if (!hasWireDispatchShape(value)) return false;
    if (value.errorClass !== null && !isJudgeErrorCode(value.errorClass)) return false;
    if (!isNonEmptyStringList(value.candidateIds)) return false;
    // M1 is one request per candidate (plan §3 method builders).
    if (value.method === "M1" && value.candidateIds.length !== 1) return false;
    if (!hasAlignedAnswers(value.answers, value.candidateIds)) return false;
    return hasWireCaptureConsistency(value.httpStatus, value.servedModel, value.provider, value.errorClass, value.answers, ruleset);
}

const DERIVED_SCORE_KEYS = ["method", "arm", "phase", "replica", "queryGroup", "candidateId", "probability", "wireIds"] as const;

/** Fail-closed derived-score guard: exact shape, no cost field, non-empty unique link list. */
export function isMethodDerivedScore(value: unknown): value is MethodDerivedScore {
    if (!isPlainObject(value) || !hasExactKeys(value, DERIVED_SCORE_KEYS)) return false;
    if (!isMethodId(value.method) || !isComparisonModelId(value.arm) || !isMethodPhase(value.phase)) return false;
    if (!isIntegerInRange(value.replica, 0, FROZEN_REPLICA_COUNT - 1)) return false;
    if (!isNonEmptyString(value.queryGroup) || !isNonEmptyString(value.candidateId)) return false;
    if (!isProbabilityOrNull(value.probability)) return false;
    return isNonEmptyStringList(value.wireIds);
}

const PLANNED_CANDIDATE_KEYS = ["queryGroup", "candidateId"] as const;

export function isMethodPlannedCandidate(value: unknown): value is MethodPlannedCandidate {
    if (!isPlainObject(value) || !hasExactKeys(value, PLANNED_CANDIDATE_KEYS)) return false;
    return isNonEmptyString(value.queryGroup) && isNonEmptyString(value.candidateId);
}

/* ──────────────────────────────────────────────────────────────────
 * Binder
 * ────────────────────────────────────────────────────────────────── */

/** Failure codes `bindMethodComparisonReport` can report (fail-closed; multiple may apply). */
export const METHOD_BIND_FAILURES = Object.freeze([
    "invalid_envelope",
    "invalid_planned_candidates",
    "invalid_wire_record",
    "cross_method_link",
    "cross_arm_link",
    "cross_phase_link",
    "replica_out_of_range",
    "duplicate_wire_id",
    "served_identity_drift",
    "candidate_set_mismatch",
    "attempt_index_gap",
    "payload_drift",
    "reverse_order_mismatch",
    "missing_wire_coverage",
    "invalid_derived_score",
    "duplicate_derived_score",
    "missing_derived_coverage",
    "invalid_derived_link",
    "forged_derived_score",
    "inconsistent_wire_answers",
    "non_finite_total",
] as const);
export type MethodBindFailure = (typeof METHOD_BIND_FAILURES)[number];

/** Per-wire-request accounting derived from the envelope's wire table (each request counted exactly once). */
export interface MethodBindingTotals {
    /** Distinct wire requests (each HTTP request exactly once — never per candidate). */
    wireRequestCount: number;
    warmupRequests: number;
    /** Requests that returned 2xx with a parseable envelope (no error class). */
    successfulResponses: number;
    knownCostRequests: number;
    unknownCostRequests: number;
    knownCostUsd: number;
    unknownCostReserveUsd: number;
    costComplete: boolean;
}

export interface MethodComparisonReportInput {
    envelope: unknown;
    plannedCandidates: readonly unknown[];
    wireRecords: readonly unknown[];
    derivedScores: readonly unknown[];
}

export type MethodReportBinding =
    | { ok: true; totals: MethodBindingTotals; wireRecords: readonly MethodWireRecord[] }
    | { ok: false; failures: MethodBindFailure[] };

/**
 * Module-private authenticity brand: members are exactly the ok
 * bindings `bindMethodComparisonReport` returned. Campaign
 * aggregation accepts only branded bindings, so a forged
 * `{ ok: true, wireRecords: [...] }` object can never inject wire
 * records into campaign spend totals.
 */
const AUTHENTIC_REPORT_BINDINGS = new WeakMap<object, readonly MethodWireRecord[]>();

function deepFreeze<T>(value: T): T {
    if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
        for (const child of Object.values(value)) deepFreeze(child);
        Object.freeze(value);
    }
    return value;
}

/** Component identity: one request component across replicas and retries (method+arm+phase+scope+direction[+isolated candidate]). */
interface ComponentIdentity {
    method: MethodId;
    arm: ComparisonModelId;
    phase: MethodPhase;
    /** Query group, or `"warmup"` for warmup requests. */
    scope: string;
    direction: MethodDirection;
    /** Single candidate id for the isolated (M1) leg. */
    isolatedCandidate?: string;
}

function componentKey(identity: ComponentIdentity): string {
    const parts = [identity.method, identity.arm, identity.phase, identity.scope, identity.direction];
    if (identity.direction === "isolated") parts.push(identity.isolatedCandidate ?? "");
    return parts.join("\u0000");
}

function componentKeyOf(record: MethodWireRecord): string {
    return componentKey({
        method: record.method,
        arm: record.arm,
        phase: record.phase,
        scope: record.queryGroup ?? "warmup",
        direction: record.direction,
        isolatedCandidate: record.direction === "isolated" ? record.candidateIds.join("\u0000") : undefined,
    });
}

function sameSequence(a: readonly string[], b: readonly string[]): boolean {
    return a.length === b.length && a.every((item, index) => item === b[index]);
}

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
    if (a.size !== b.size) return false;
    for (const item of a) {
        if (!b.has(item)) return false;
    }
    return true;
}

/** Binding tolerance for derived-probability comparison (double rounding of `(f+r)/2`). */
const DERIVED_PROBABILITY_TOLERANCE = 1e-12;

function probabilitiesEqual(a: number | null, b: number | null): boolean {
    if (a === null || b === null) return a === b;
    return Math.abs(a - b) <= DERIVED_PROBABILITY_TOLERANCE;
}

/** Ordered planned candidates per query group; null on any invalid/duplicate/empty entry. */
function bindPlannedCandidates(raw: readonly unknown[], failures: Set<MethodBindFailure>): Map<string, string[]> | null {
    if (raw.length === 0) {
        failures.add("invalid_planned_candidates");
        return null;
    }
    const planned = new Map<string, string[]>();
    const seen = new Set<string>();
    for (const entry of raw) {
        if (!isMethodPlannedCandidate(entry)) {
            failures.add("invalid_planned_candidates");
            return null;
        }
        const pairKey = `${entry.queryGroup}\u0000${entry.candidateId}`;
        if (seen.has(pairKey)) {
            failures.add("invalid_planned_candidates");
            return null;
        }
        seen.add(pairKey);
        const group = planned.get(entry.queryGroup);
        if (group === undefined) planned.set(entry.queryGroup, [entry.candidateId]);
        else group.push(entry.candidateId);
    }
    return planned;
}

function checkPlannedMembership(
    record: MethodWireRecord,
    planned: ReadonlyMap<string, string[]>,
    plannedSet: ReadonlySet<string>,
    failures: Set<MethodBindFailure>,
): void {
    if (record.warmup) return;
    const group = record.queryGroup;
    if (group === null) {
        // Unreachable for a validator-passing record; fail closed anyway.
        failures.add("candidate_set_mismatch");
        return;
    }
    const expected = planned.get(group);
    if (expected === undefined) {
        failures.add("candidate_set_mismatch");
        return;
    }
    if (record.direction === "forward") {
        // The forward leg must submit exactly the sealed candidate order.
        if (!sameSequence(record.candidateIds, expected)) failures.add("candidate_set_mismatch");
    } else if (record.direction === "isolated") {
        const candidate = record.candidateIds[0];
        if (record.candidateIds.length !== 1
            || candidate === undefined
            || !plannedSet.has(`${group}\u0000${candidate}`)) {
            failures.add("candidate_set_mismatch");
        }
    }
    // Reverse legs are bound to the forward leg's order below
    // (reverse_order_mismatch); their query group is planned by here.
}

interface WireBinding {
    byId: Map<string, MethodWireRecord>;
    components: Map<string, MethodWireRecord[]>;
}

function bindWireRecords(
    envelope: MethodRecordEnvelope,
    planned: ReadonlyMap<string, string[]>,
    plannedSet: ReadonlySet<string>,
    raws: readonly unknown[],
    failures: Set<MethodBindFailure>,
): WireBinding {
    const byId = new Map<string, MethodWireRecord>();
    const components = new Map<string, MethodWireRecord[]>();
    const allowedMethods = ENVELOPE_ALLOWED_WIRE_METHODS[envelope.method];
    for (const raw of raws) {
        if (!isMethodWireRecord(raw)) {
            failures.add("invalid_wire_record");
            continue;
        }
        if (!allowedMethods.includes(raw.method)) failures.add("cross_method_link");
        if (raw.arm !== envelope.arm) failures.add("cross_arm_link");
        if (raw.phase !== envelope.phase) failures.add("cross_phase_link");
        if (raw.replica >= envelope.replicaCount) failures.add("replica_out_of_range");
        if (byId.has(raw.wireId)) {
            failures.add("duplicate_wire_id");
            continue;
        }
        byId.set(raw.wireId, raw);
        const allowedServed = COMPARISON_SERVED_MODEL_ALLOWLIST[raw.arm];
        if (raw.servedModel !== null && raw.servedModel !== allowedServed) failures.add("served_identity_drift");
        checkPlannedMembership(raw, planned, plannedSet, failures);
        const key = componentKeyOf(raw);
        const bucket = components.get(key);
        if (bucket === undefined) components.set(key, [raw]);
        else bucket.push(raw);
    }
    return { byId, components };
}

/**
 * Within each component: payload hash and candidate order must agree
 * across replicas and retries (forward and reverse are separate
 * components, so they may — and do — hash differently), and each
 * replica's attemptIndex ledger must be a gapless 1..n.
 */
function checkComponents(components: ReadonlyMap<string, MethodWireRecord[]>, failures: Set<MethodBindFailure>): void {
    for (const records of components.values()) {
        const first = records[0];
        if (first === undefined) continue;
        for (const record of records) {
            if (record.payloadSha256 !== first.payloadSha256) failures.add("payload_drift");
            if (!sameSequence(record.candidateIds, first.candidateIds)) failures.add("payload_drift");
        }
        const byReplica = new Map<number, number[]>();
        for (const record of records) {
            const ledger = byReplica.get(record.replica);
            if (ledger === undefined) byReplica.set(record.replica, [record.attemptIndex]);
            else ledger.push(record.attemptIndex);
        }
        for (const indices of byReplica.values()) {
            indices.sort((a, b) => a - b);
            for (let i = 0; i < indices.length; i += 1) {
                if (indices[i] !== i + 1) {
                    failures.add("attempt_index_gap");
                    break;
                }
            }
        }
    }
}

/** A reverse request must carry exactly the reverse of the forward request's candidate order. */
function checkReverseOrder(components: ReadonlyMap<string, MethodWireRecord[]>, failures: Set<MethodBindFailure>): void {
    for (const records of components.values()) {
        const reverse = records[0];
        if (reverse === undefined || reverse.direction !== "reverse") continue;
        const forwardKey = componentKey({
            method: "M0",
            arm: reverse.arm,
            phase: reverse.phase,
            scope: reverse.queryGroup ?? "warmup",
            direction: "forward",
        });
        const forward = components.get(forwardKey)?.[0];
        // A missing forward leg is reported by wire coverage, not here.
        if (forward === undefined) continue;
        if (!sameSequence([...forward.candidateIds].reverse(), reverse.candidateIds)) {
            failures.add("reverse_order_mismatch");
        }
    }
}

function componentHasReplica(components: ReadonlyMap<string, MethodWireRecord[]>, key: string, replica: number): boolean {
    const records = components.get(key);
    if (records === undefined) return false;
    return records.some((record) => record.replica === replica);
}

/** True when one planned group's wire requests exist for this replica (per the envelope method's legs). */
function groupCoveredAtReplica(
    envelope: MethodRecordEnvelope,
    components: ReadonlyMap<string, MethodWireRecord[]>,
    queryGroup: string,
    candidates: readonly string[],
    replica: number,
): boolean {
    if (envelope.method === "M1") {
        for (const candidateId of candidates) {
            const key = componentKey({
                method: "M1",
                arm: envelope.arm,
                phase: envelope.phase,
                scope: queryGroup,
                direction: "isolated",
                isolatedCandidate: candidateId,
            });
            if (!componentHasReplica(components, key, replica)) return false;
        }
        return true;
    }
    const forwardKey = componentKey({
        method: "M0",
        arm: envelope.arm,
        phase: envelope.phase,
        scope: queryGroup,
        direction: "forward",
    });
    if (!componentHasReplica(components, forwardKey, replica)) return false;
    if (envelope.method !== "M2") return true;
    const reverseKey = componentKey({
        method: "M2",
        arm: envelope.arm,
        phase: envelope.phase,
        scope: queryGroup,
        direction: "reverse",
    });
    return componentHasReplica(components, reverseKey, replica);
}

/** Every planned candidate must be covered by its method's wire requests for EVERY declared replica. */
function checkWireCoverage(
    envelope: MethodRecordEnvelope,
    planned: ReadonlyMap<string, string[]>,
    components: ReadonlyMap<string, MethodWireRecord[]>,
    failures: Set<MethodBindFailure>,
): void {
    for (const [queryGroup, candidates] of planned) {
        for (let replica = 0; replica < envelope.replicaCount; replica += 1) {
            if (!groupCoveredAtReplica(envelope, components, queryGroup, candidates, replica)) {
                failures.add("missing_wire_coverage");
            }
        }
    }
}

function derivedKey(queryGroup: string, candidateId: string, replica: number): string {
    return `${queryGroup}\u0000${candidateId}\u0000${replica}`;
}

function bindDerivedScores(
    envelope: MethodRecordEnvelope,
    plannedSet: ReadonlySet<string>,
    raws: readonly unknown[],
    failures: Set<MethodBindFailure>,
): Map<string, MethodDerivedScore> {
    const byKey = new Map<string, MethodDerivedScore>();
    for (const raw of raws) {
        if (!isMethodDerivedScore(raw)) {
            failures.add("invalid_derived_score");
            continue;
        }
        if (raw.method !== envelope.method) failures.add("cross_method_link");
        if (raw.arm !== envelope.arm) failures.add("cross_arm_link");
        if (raw.phase !== envelope.phase) failures.add("cross_phase_link");
        if (raw.replica >= envelope.replicaCount) failures.add("replica_out_of_range");
        if (!plannedSet.has(`${raw.queryGroup}\u0000${raw.candidateId}`)) failures.add("candidate_set_mismatch");
        const key = derivedKey(raw.queryGroup, raw.candidateId, raw.replica);
        if (byKey.has(key)) {
            failures.add("duplicate_derived_score");
            continue;
        }
        byKey.set(key, raw);
    }
    return byKey;
}

/** Exactly one derived score per planned candidate per declared replica (missing or duplicate both fail). */
function checkDerivedCoverage(
    envelope: MethodRecordEnvelope,
    planned: ReadonlyMap<string, string[]>,
    derivedByKey: ReadonlyMap<string, MethodDerivedScore>,
    failures: Set<MethodBindFailure>,
): void {
    for (const [queryGroup, candidates] of planned) {
        for (const candidateId of candidates) {
            for (let replica = 0; replica < envelope.replicaCount; replica += 1) {
                if (!derivedByKey.has(derivedKey(queryGroup, candidateId, replica))) {
                    failures.add("missing_derived_coverage");
                }
            }
        }
    }
}

/** Wire records a derived score MUST link: the full component ledger(s) at its replica (retries included). */
function expectedLinkedWireIds(score: MethodDerivedScore, components: ReadonlyMap<string, MethodWireRecord[]>): Set<string> {
    const ids = new Set<string>();
    const collect = (method: MethodId, direction: MethodDirection, isolatedCandidate?: string): void => {
        const key = componentKey({
            method,
            arm: score.arm,
            phase: score.phase,
            scope: score.queryGroup,
            direction,
            isolatedCandidate,
        });
        for (const record of components.get(key) ?? []) {
            if (record.replica === score.replica) ids.add(record.wireId);
        }
    };
    if (score.method === "M0") collect("M0", "forward");
    else if (score.method === "M1") collect("M1", "isolated", score.candidateId);
    else {
        // M2 reuses the M0 forward leg and adds its own reverse leg.
        collect("M0", "forward");
        collect("M2", "reverse");
    }
    return ids;
}

type ComponentProbability = { ok: true; probability: number | null } | { ok: false };

/**
 * Probability this component produced for one candidate: null when no
 * request of the component succeeded; a disagreement between
 * successful retries (identical payloads must answer identically) is
 * `ok: false`.
 */
function componentProbability(records: readonly MethodWireRecord[], candidateId: string): ComponentProbability {
    let probability: number | null = null;
    for (const record of records) {
        if (record.errorClass !== null) continue; // failed attempt: this request answered nothing
        const answer = record.answers.find((entry) => entry.candidateId === candidateId);
        if (answer === undefined || answer.probability === null) return { ok: false };
        if (probability === null) probability = answer.probability;
        else if (probability !== answer.probability) return { ok: false };
    }
    return { ok: true, probability };
}

/** Recompute a derived score from its linked wire records: M0/M1 = wire probability; M2 = (forward+reverse)/2. */
function recomputeDerived(score: MethodDerivedScore, linked: readonly MethodWireRecord[]): ComponentProbability {
    if (score.method !== "M2") return componentProbability(linked, score.candidateId);
    const forward = componentProbability(linked.filter((record) => record.direction === "forward"), score.candidateId);
    if (!forward.ok) return forward;
    const reverse = componentProbability(linked.filter((record) => record.direction === "reverse"), score.candidateId);
    if (!reverse.ok) return reverse;
    // A missing leg (either direction unjudged) never falls back to the
    // surviving direction: the derived score is null (plan §3).
    if (forward.probability === null || reverse.probability === null) return { ok: true, probability: null };
    return { ok: true, probability: (forward.probability + reverse.probability) / 2 };
}

/**
 * Bind each derived score to its component ledger and RECOMPUTE it:
 * a wrong link set, a forged average, or disagreeing retry answers
 * fail closed.
 */
function checkDerivedDerivations(
    components: ReadonlyMap<string, MethodWireRecord[]>,
    wireById: ReadonlyMap<string, MethodWireRecord>,
    derivedByKey: ReadonlyMap<string, MethodDerivedScore>,
    failures: Set<MethodBindFailure>,
): void {
    for (const score of derivedByKey.values()) {
        const expected = expectedLinkedWireIds(score, components);
        if (!setsEqual(expected, new Set(score.wireIds))) {
            failures.add("invalid_derived_link");
            continue;
        }
        const linked: MethodWireRecord[] = [];
        let resolved = true;
        for (const wireId of score.wireIds) {
            const record = wireById.get(wireId);
            if (record === undefined) {
                resolved = false;
                break;
            }
            linked.push(record);
        }
        if (!resolved) {
            failures.add("invalid_derived_link");
            continue;
        }
        const recomputed = recomputeDerived(score, linked);
        if (!recomputed.ok) failures.add("inconsistent_wire_answers");
        else if (!probabilitiesEqual(recomputed.probability, score.probability)) failures.add("forged_derived_score");
    }
}

/**
 * Sum a wire table's counts and costs. Returns null when any running
 * sum or final total is non-finite: the frozen cost guard makes every
 * record cost individually finite, but individually finite costs can
 * still overflow their aggregate (`Number.MAX_VALUE + Number.MAX_VALUE`
 * is `Infinity`, which would serialize as `null` downstream), so the
 * binder fails closed instead of returning an overflowed total.
 */
function computeTotals(records: Iterable<MethodWireRecord>): MethodBindingTotals | null {
    const totals: MethodBindingTotals = {
        wireRequestCount: 0,
        warmupRequests: 0,
        successfulResponses: 0,
        knownCostRequests: 0,
        unknownCostRequests: 0,
        knownCostUsd: 0,
        unknownCostReserveUsd: 0,
        costComplete: true,
    };
    for (const record of records) {
        totals.wireRequestCount += 1;
        if (record.warmup) totals.warmupRequests += 1;
        if (record.errorClass === null) totals.successfulResponses += 1;
        if (record.cost.status === "known") {
            totals.knownCostRequests += 1;
            totals.knownCostUsd += record.cost.usd;
            if (!Number.isFinite(totals.knownCostUsd)) return null;
        } else {
            totals.unknownCostRequests += 1;
            totals.unknownCostReserveUsd += record.cost.reserveUsd;
            if (!Number.isFinite(totals.unknownCostReserveUsd)) return null;
        }
    }
    const finalTotals: readonly number[] = [
        totals.wireRequestCount,
        totals.warmupRequests,
        totals.successfulResponses,
        totals.knownCostRequests,
        totals.unknownCostRequests,
        totals.knownCostUsd,
        totals.unknownCostReserveUsd,
    ];
    if (!finalTotals.every((value) => Number.isFinite(value))) return null;
    totals.costComplete = totals.unknownCostRequests === 0;
    return totals;
}

/**
 * End-to-end method-aware report binder (plan §3 Stage C). Fail-closed:
 * every rule below rejects rather than repairs.
 *
 * - Envelope must be a valid `method-comparison/v1` record with a
 *   phase-appropriate replica count.
 * - Planned candidates must be a non-empty, duplicate-free declared
 *   set; coverage is checked against it, never inferred from records.
 * - Wire records must be valid, belong to the envelope's
 *   method/arm/phase (M2 additionally admits the reused M0 forward
 *   records — the sanctioned forward reuse, nothing else), sit within
 *   the declared replica range, have unique wireIds, carry the
 *   allowlisted served identity, and submit exactly the sealed
 *   candidate set/order for their group.
 * - Per component: payload hash and candidate order agree across
 *   replicas/retries; per replica: attemptIndex is a gapless 1..n.
 * - A reverse request's order must be the exact reverse of forward.
 * - Every planned candidate has wire coverage and exactly one derived
 *   score for every replica in [0, replicaCount).
 * - Every derived score links exactly its component ledger(s) and
 *   equals the recomputation from wire answers — forged M2 averages,
 *   substituted surviving directions, and retry disagreements fail.
 *
 * On success, `totals` counts each wire request exactly once within
 * this report (cost is never attached to candidates or derived
 * scores), `wireRecords` exposes the bound, wire-id-unique wire table
 * for campaign accounting, and individually finite costs that would
 * overflow their aggregate fail with `non_finite_total` instead of
 * returning an overflowed total.
 *
 * Campaign totals MUST NOT be produced by summing report totals:
 * across envelopes `wireId` identifies the physical request (the
 * reused M0 forward request appears in both the M0 and M2 envelope
 * tables), so campaign-level accounting MUST go through
 * `aggregateCampaignWireCosts`, which unions bound wire tables from
 * authentic binder output only, deduplicates by `wireId`, and rejects
 * a `wireId` whose canonical record content (any field — answers,
 * status, order, timing, cost, identity) differs between reports.
 */
export function bindMethodComparisonReport(input: MethodComparisonReportInput): MethodReportBinding {
    const failures = new Set<MethodBindFailure>();
    if (!isMethodRecordEnvelope(input.envelope)) {
        return { ok: false, failures: ["invalid_envelope"] };
    }
    const envelope = input.envelope;
    const planned = bindPlannedCandidates(input.plannedCandidates, failures);
    if (planned === null) return { ok: false, failures: [...failures] };
    const plannedSet = new Set<string>();
    for (const [queryGroup, candidates] of planned) {
        for (const candidateId of candidates) plannedSet.add(`${queryGroup}\u0000${candidateId}`);
    }
    const wire = bindWireRecords(envelope, planned, plannedSet, input.wireRecords, failures);
    checkComponents(wire.components, failures);
    checkReverseOrder(wire.components, failures);
    checkWireCoverage(envelope, planned, wire.components, failures);
    const derived = bindDerivedScores(envelope, plannedSet, input.derivedScores, failures);
    checkDerivedCoverage(envelope, planned, derived, failures);
    checkDerivedDerivations(wire.components, wire.byId, derived, failures);
    if (failures.size > 0) return { ok: false, failures: [...failures] };
    const totals = computeTotals(wire.byId.values());
    if (totals === null) return { ok: false, failures: ["non_finite_total"] };
    // Aggregation reads a private deep-frozen snapshot, so later mutation of
    // the caller's input records or of the returned binding cannot alter it.
    const snapshot = deepFreeze(structuredClone([...wire.byId.values()]));
    const binding: MethodReportBinding = Object.freeze({ ok: true, totals: Object.freeze({ ...totals }), wireRecords: snapshot });
    AUTHENTIC_REPORT_BINDINGS.set(binding, snapshot);
    return binding;
}

/* ──────────────────────────────────────────────────────────────────
 * Campaign-level wire-cost aggregation
 * ────────────────────────────────────────────────────────────────── */

/** Failure codes `aggregateCampaignWireCosts` can report (fail-closed). */
export const CAMPAIGN_WIRE_COST_FAILURES = Object.freeze([
    "campaign_unbound_report",
    "campaign_wire_conflict",
    "non_finite_total",
] as const);
export type CampaignWireCostFailure = (typeof CAMPAIGN_WIRE_COST_FAILURES)[number];

/** Campaign spend over the union of bound wire tables (each physical HTTP request counted exactly once). */
export interface CampaignWireCostTotals {
    /** Distinct wire requests across all bound reports (deduplicated by `wireId`). */
    uniqueWireRequestCount: number;
    /** Sum of `known` costs over the unique wire requests. */
    knownCostUsd: number;
    /** Unique wire requests whose cost is still `unknown`. */
    unknownCostRequests: number;
    /** Sum of retained `unknown` reservations over the unique wire requests. */
    unknownCostReserveUsd: number;
}

export type CampaignWireCostBinding =
    | { ok: true; totals: CampaignWireCostTotals }
    | { ok: false; failures: CampaignWireCostFailure[] };

/**
 * Deterministic canonical JSON of a bound wire record: object keys
 * sorted recursively, array order (candidateIds, answers) preserved,
 * primitives JSON-encoded. Serialization walks own enumerable values
 * only — `JSON.stringify` is never applied to an object as a whole —
 * so a prototype `toJSON` cannot canonicalize two different captures
 * to the same string. Two captures of one `wireId` are identical
 * exactly when their canonical forms match, so ANY content difference
 * — answers, status, order, timing, cost, identity — is a conflict
 * instead of only the accounting-selected fields.
 */
function canonicalWireJson(record: MethodWireRecord): string {
    const canonicalize = (value: unknown): string => {
        if (value === null || typeof value !== "object") return JSON.stringify(value);
        if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
        const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`).join(",")}}`;
    };
    return canonicalize(record);
}

/**
 * Authenticity gate: true only for an ok binding this module itself
 * returned from `bindMethodComparisonReport` (module-private brand).
 * A forged `{ ok: true, wireRecords }` object — and any non-object
 * junk in the array — never passes.
 */
function isAuthenticReportBinding(binding: MethodReportBinding): binding is Extract<MethodReportBinding, { ok: true }> {
    return typeof binding === "object" && binding !== null && binding.ok === true && AUTHENTIC_REPORT_BINDINGS.has(binding);
}

/**
 * Campaign-level wire-cost aggregation — the ONLY supported way to
 * produce campaign spend totals. Report `totals` MUST NOT be summed
 * across envelopes: `wireId` identifies the physical request, so the
 * reused M0 forward request appears in both the M0 and M2 report
 * tables and naive summing double-counts the request and its cost.
 *
 * Fail-closed rules:
 * - every input must be an authentic successful
 *   `bindMethodComparisonReport` result — the module-private brand
 *   rejects forged `{ ok: true }` objects, and each wire record is
 *   re-validated with `isMethodWireRecord` so post-bind mutation
 *   rejects; an empty campaign, an unbound/forged report, or an
 *   invalid record fails with `campaign_unbound_report`;
 * - wire records are unioned across reports and deduplicated by
 *   `wireId`; two captures of one `wireId` must have identical
 *   canonical record content (every field, answers included), and any
 *   difference rejects with `campaign_wire_conflict`;
 * - every running sum and the final totals must be finite
 *   (`non_finite_total`).
 */
export function aggregateCampaignWireCosts(bindings: readonly MethodReportBinding[]): CampaignWireCostBinding {
    if (bindings.length === 0) return { ok: false, failures: ["campaign_unbound_report"] };
    const byId = new Map<string, { record: MethodWireRecord; canonical: string }>();
    for (const binding of bindings) {
        if (!isAuthenticReportBinding(binding)) return { ok: false, failures: ["campaign_unbound_report"] };
        for (const record of AUTHENTIC_REPORT_BINDINGS.get(binding) ?? []) {
            // Private frozen snapshot taken at bind time; re-validated anyway.
            if (!isMethodWireRecord(record)) return { ok: false, failures: ["campaign_unbound_report"] };
            const canonical = canonicalWireJson(record);
            const seen = byId.get(record.wireId);
            if (seen === undefined) byId.set(record.wireId, { record, canonical });
            else if (seen.canonical !== canonical) return { ok: false, failures: ["campaign_wire_conflict"] };
        }
    }
    const totals: CampaignWireCostTotals = {
        uniqueWireRequestCount: 0,
        knownCostUsd: 0,
        unknownCostRequests: 0,
        unknownCostReserveUsd: 0,
    };
    for (const { record } of byId.values()) {
        totals.uniqueWireRequestCount += 1;
        if (record.cost.status === "known") {
            totals.knownCostUsd += record.cost.usd;
        } else {
            totals.unknownCostRequests += 1;
            totals.unknownCostReserveUsd += record.cost.reserveUsd;
        }
        if (!Number.isFinite(totals.knownCostUsd) || !Number.isFinite(totals.unknownCostReserveUsd)) {
            return { ok: false, failures: ["non_finite_total"] };
        }
    }
    const finalTotals: readonly number[] = [
        totals.uniqueWireRequestCount,
        totals.knownCostUsd,
        totals.unknownCostRequests,
        totals.unknownCostReserveUsd,
    ];
    if (!finalTotals.every((value) => Number.isFinite(value))) return { ok: false, failures: ["non_finite_total"] };
    return { ok: true, totals };
}

/* ──────────────────────────────────────────────────────────────────
 * Legacy frozen-DTO projection — M1 ONLY
 * ────────────────────────────────────────────────────────────────── */

/**
 * Project one M1 wire record onto the frozen `ComparisonAttemptRecord`
 * (one candidate per request ⇒ one wire probability maps 1:1). The
 * returned record passes `isComparisonAttemptRecord`; anything that
 * cannot (invalid input, or a non-M1 record) projects to null.
 *
 * M0/M2 DO NOT PROJECT 1:1 and are rejected: a packed M0/M2 request is
 * a single HTTP attempt carrying N candidate answers, and an M2 derived
 * score is an average of two requests — either projected would claim a
 * per-candidate wire attempt that never existed on the wire, which the
 * §4.4 report binder forbids (`outcome probability must equal its
 * linked successful attempt probability`). The wire record remains the
 * only spend/attempt truth for those methods.
 */
export function projectMethodWireToComparisonAttempt(wire: unknown): ComparisonAttemptRecord | null {
    if (!isMethodWireRecord(wire) || wire.method !== "M1") return null;
    // The frozen §4.4 attempt record has no capture-gap representation
    // (fail-closed capture rejection): a capture-gap wire record never projects.
    if (wire.errorClass === "capture_gap") return null;
    const candidateId = wire.candidateIds[0];
    const answer = wire.answers[0];
    if (candidateId === undefined || answer === undefined) return null;
    const attempt: ComparisonAttemptRecord = {
        attemptId: wire.wireId,
        arm: wire.arm,
        servedModel: wire.servedModel,
        provider: wire.provider,
        queryGroup: wire.queryGroup,
        unitId: candidateId,
        replica: wire.replica,
        attemptIndex: wire.attemptIndex,
        warmup: wire.warmup,
        requestBytes: wire.requestBytes,
        payloadSha256: wire.payloadSha256,
        httpStatus: wire.httpStatus,
        probability: answer.probability,
        inputTokens: wire.inputTokens,
        outputTokens: wire.outputTokens,
        cost: wire.cost,
        errorClass: wire.errorClass,
    };
    return isComparisonAttemptRecord(attempt) ? attempt : null;
}

/**
 * Project one M1 derived score onto the frozen
 * `ComparisonScoredOutcome`. The score's `wireIds` become the
 * outcome's `attemptIds` (the M1 component ledger for that
 * candidate/replica — bind the report first so the links are proven).
 * Fixture identity (`file`, `truth`) is supplied by the caller because
 * it lives in the sealed fixture, not on the wire. M0/M2 and anything
 * invalid project to null (see the wire projection above: an averaged
 * or multi-candidate score is not a scored-outcome probability).
 */
export function projectMethodDerivedToScoredOutcome(
    score: unknown,
    identity: { file: string; truth: ComparisonTruthClass },
): ComparisonScoredOutcome | null {
    if (!isMethodDerivedScore(score) || score.method !== "M1") return null;
    const outcome: ComparisonScoredOutcome = {
        arm: score.arm,
        queryGroup: score.queryGroup,
        unitId: score.candidateId,
        file: identity.file,
        replica: score.replica,
        truth: identity.truth,
        probability: score.probability,
        attemptIds: [...score.wireIds],
    };
    return isComparisonScoredOutcome(outcome) ? outcome : null;
}
