/**
 * Preregistered method-selection selector for the judge method pilot
 * (protocol §9 Amendment A1.1 — `docs/plans/2026-10-08-judge-decider-protocol.md`
 * lines 480–500; design plan §1). Pure, deterministic, no I/O: every
 * function is a total function over the validated input shape below.
 *
 * The selector returns ONE common method for all three frozen arms —
 * per-model method choice is impossible by construction — and the
 * keep threshold, the 6:1 penalty, the .10 margin, the bootstrap
 * policy, and the tie rule are frozen constants, never parameters
 * (A1.1 "Prohibited", line 500).
 *
 * Frozen rules implemented exactly:
 *
 * - Score per candidate/model/method: M0/M1 = mean of its two pilot
 *   replica probabilities; M2 replica score = (forward + reverse)/2,
 *   then the mean over the two replicas. Keep iff score >= .40
 *   (equality keeps); gold is positive, both negative classes are
 *   negative (A1.1 lines 484–485).
 * - L_{a,m} = 6·FN + FP; S_m = (Σ_a L_{a,m}) / (3·Q) with Q taken
 *   from the verified sealed roster (Stage B `loadVerifiedPilotCorpus`):
 *   the query count, the candidate universe, and every gold label come
 *   only from that roster — never a caller-supplied count (line 486).
 *   The production entry point additionally fails closed unless that
 *   roster carries Stage B's runtime verification brand
 *   (`isVerifiedPilotCorpusRoster`) AND its query count equals the
 *   frozen A1.1 value Q = `PILOT_EXPECTED_QUERY_COUNT` (40; lines
 *   486/489/494: every bootstrap draw resamples 40 query clusters).
 *   D_m = S_0 − S_m.
 * - Qualification requires ALL of (lines 490–494):
 *   1. D_m >= 0.10 weighted errors/query;
 *   2. the Bonferroni-adjusted one-sided 97.5% paired query-cluster
 *      bootstrap lower bound of D_m strictly > 0 — B = 10,000 draws,
 *      seed 20261008, mulberry32, query ids sorted lexicographically,
 *      each draw resamples Q query clusters with replacement, the same
 *      sampled queries are used for every method and model, replicas
 *      and models are not independent samples, nearest-rank .025
 *      percentile (the .025 tail IS the Bonferroni correction for the
 *      two comparisons M1 vs M0 and M2 vs M0);
 *   3. no model has more than one additional FN versus that model's
 *      own M0 result;
 *   4. complete numeric coverage — every roster candidate, both
 *      replicas, all three models; any null/missing cell makes THAT
 *      method ineligible, never a partial average and never a
 *      dropped candidate;
 *   5. no served-identity drift, payload drift, capture gap, or
 *      aborted run.
 * - Selection and default (line 498): default M0; neither alternative
 *   qualifies → M0; exactly one → it; both → the lower S_m; exact
 *   alternative tie → M2 (fixed preference for fewer requests than
 *   M1); invalid/incomplete M0 baseline → report the pilot
 *   inconclusive and retain M0; an incomplete alternative is
 *   ineligible and its missing candidates are never dropped.
 *
 * `mulberry32` and `percentileSorted` replicate the private helpers in
 * `model-comparison-stats.ts` (lines 215/231) byte-for-byte — neither
 * is exported there; `test/unit/judge/method-pilot-selector.test.ts`
 * pins byte-equivalence against independent references
 * (`scripts/eval/d46/sample-second-label.ts` and
 * `scripts/eval/judge/metrics.ts`).
 */

import { METHOD_IDS, PILOT_REPLICA_COUNT, type MethodId } from "./method-comparison-contract.js";
import {
    isVerifiedPilotCorpusRoster,
    PILOT_EXPECTED_QUERY_COUNT,
    type PilotCorpusRoster,
    type PilotLabel,
} from "./method-pilot-fixture.js";
import {
    FROZEN_BOOTSTRAP_ITERATIONS,
    FROZEN_BOOTSTRAP_SEED,
    FROZEN_CHALLENGER_ARMS,
    FROZEN_KEEP_THRESHOLD,
    INCUMBENT_ARM,
} from "./model-comparison-stats.js";
import type { ComparisonModelId } from "./model-comparison-types.js";

/* ──────────────────────────────────────────────────────────────────
 * Frozen policy constants (protocol §9 A1.1).
 * ──────────────────────────────────────────────────────────────── */

/**
 * The three frozen pilot arms (A1.1: "equally averaged over the three
 * models"): the §4.4 incumbent plus the frozen challenger roster.
 * Cross-checked against `mapArms`'s literal keys in `normalizeInput`
 * so roster drift fails closed at runtime, and against
 * `Record<ComparisonModelId, …>` at compile time.
 */
const FROZEN_PILOT_ARMS: readonly ComparisonModelId[] = Object.freeze([
    INCUMBENT_ARM,
    ...FROZEN_CHALLENGER_ARMS,
]);

/** A1.1 line 486: L_{a,m} = 6·FN + FP (the preregistered 6:1 penalty). */
const WEIGHTED_FN_PENALTY = 6;

/** A1.1 qualification 1 (line 490): D_m ≥ 0.10 weighted errors/query. */
const MIN_IMPROVEMENT_MARGIN = 0.1;

/** A1.1 qualification 2 (line 491): nearest-rank .025 percentile lower bound. */
const BOOTSTRAP_LOWER_BOUND_QUANTILE = 0.025;

/** A1.1 qualification 3 (line 492): at most +1 FN per model versus its own M0. */
const MAX_ADDITIONAL_FN_PER_MODEL = 1;

/** The two selectable alternatives (A1.1 lines 498–500). */
const ALTERNATIVE_METHODS = Object.freeze(["M1", "M2"] as const);
type MethodPilotAlternativeMethod = (typeof ALTERNATIVE_METHODS)[number];

/**
 * Three-class candidate label (A1.2 vocabulary); only `gold` is
 * positive. One spelling per concept: this IS the sealed roster's
 * `PilotLabel` — the roster owns the vocabulary and scored rows must
 * match it.
 */
export type MethodPilotLabel = PilotLabel;

const METHOD_PILOT_LABELS: readonly MethodPilotLabel[] = Object.freeze([
    "gold",
    "hard_negative",
    "easy_negative",
]);

/* ──────────────────────────────────────────────────────────────────
 * Validated input shape. The roster type is imported from
 * `method-pilot-fixture.ts` (Stage B's seal/verification module);
 * everything else is locally defined with no dependency on the
 * in-flux method-comparison report contract beyond stable constants.
 * ──────────────────────────────────────────────────────────────── */

/**
 * One candidate's probability components for one model × method ×
 * pilot replica. `probability` carries the single request score for
 * M0 (forward) and M1 (isolated); M2 rows carry `forward` (the reused
 * M0 forward leg) and `reverse` instead — the selector derives every
 * score itself (A1.1 line 484) and never trusts an upstream average.
 * `null` is a valid "no usable answer" value: it marks the method
 * incomplete (qualification 4), never a partial mean.
 */
export interface MethodPilotProbabilityRow {
    model: ComparisonModelId;
    method: MethodId;
    /** Sealed `set:qid`-style query id (the bootstrap cluster). */
    queryGroup: string;
    candidateId: string;
    /** Must equal the sealed roster label for this candidate. */
    label: MethodPilotLabel;
    /** 0-based; valid range 0..PILOT_REPLICA_COUNT-1. */
    replica: number;
    /** M0/M1 only: the single request probability in [0,1], or null. */
    probability: number | null;
    /** M2 only: forward component in [0,1], or null. */
    forward: number | null;
    /** M2 only: reverse component in [0,1], or null. */
    reverse: number | null;
}

/**
 * Integrity attestation for one model × method run (A1.1
 * qualification 5, line 494). Exactly one entry per frozen arm ×
 * method is required; any `true` flag blocks that method for that
 * arm (the M0 baseline turns the whole pilot inconclusive).
 */
export interface MethodPilotIntegrityFlags {
    model: ComparisonModelId;
    method: MethodId;
    servedIdentityDrift: boolean;
    payloadDrift: boolean;
    captureGap: boolean;
    abortedRun: boolean;
    /**
     * Amendment A3 (PROSPECTIVE, protocol §12): some planned
     * component × replica's FINAL attempt (highest attemptIndex) is
     * not a verified success — a 2xx with no error class and a served
     * model on the arm's allowlist. An earlier transport error with a
     * later verified success for the same planned payload (RECOVERED)
     * does NOT set this flag. A1/A2-era derivations always set it
     * false (the rule did not exist then); a true flag disqualifies
     * exactly like any other integrity flag.
     */
    finalAttemptUnverified: boolean;
}

/**
 * Sealed selector input. Q, the candidate universe, and every gold
 * label come from `roster` only — never from a caller count and
 * never from the scored rows (A1.1 line 486 and qualification 4).
 * The roster must carry Stage B's verification brand, and the
 * production entry requires its query count to equal the frozen
 * A1.1 Q = `PILOT_EXPECTED_QUERY_COUNT` (40).
 */
export interface MethodPilotSelectorInput {
    /** Verified sealed corpus roster (Stage B `loadVerifiedPilotCorpus`). */
    roster: PilotCorpusRoster;
    /** One row per model × method × query × roster candidate × replica. */
    rows: readonly MethodPilotProbabilityRow[];
    /** Exactly one entry per frozen arm × method. */
    integrity: readonly MethodPilotIntegrityFlags[];
}

export type MethodPilotBaselineBlockReason = "incomplete_coverage" | "integrity_failed";

export type MethodPilotAlternativeReason =
    | MethodPilotBaselineBlockReason
    | "invalid_baseline"
    | "margin_failed"
    | "bootstrap_failed"
    | "fn_guard_failed";

/** Per-method pooled metrics; null exactly when coverage is incomplete (never partial). */
export interface MethodPilotMethodMetrics {
    method: MethodId;
    /** L_{a,m} per frozen arm; null when coverage incomplete. */
    lossByModel: Readonly<Record<ComparisonModelId, number>> | null;
    /** FN_{a,m} per frozen arm; null when coverage incomplete. */
    fnByModel: Readonly<Record<ComparisonModelId, number>> | null;
    /** S_m; null when coverage incomplete. */
    s: number | null;
}

export interface MethodPilotAlternativeAssessment {
    method: MethodPilotAlternativeMethod;
    /** S_m (own coverage); null when the alternative is incomplete. */
    s: number | null;
    /** D_m = S_0 − S_m; null unless baseline and alternative are both numeric. */
    d: number | null;
    /** D_m >= 0.10; null when not evaluated. */
    marginPass: boolean | null;
    /** Bonferroni-adjusted one-sided lower bound of D_m; null when not evaluated. */
    bootstrapLowerBound: number | null;
    /** Lower bound strictly > 0; null when not evaluated. */
    bootstrapPass: boolean | null;
    /** FN_{a,m} − FN_{a,0} per frozen arm; null when not evaluated. */
    fnDeltaByModel: Readonly<Record<ComparisonModelId, number>> | null;
    /** Every model's FN delta ≤ +1; null when not evaluated. */
    fnGuardPass: boolean | null;
    /** True iff every A1.1 condition holds — the only qualification path. */
    qualified: boolean;
    /** Ordered, machine-readable reasons (empty iff `qualified`). */
    reasons: readonly MethodPilotAlternativeReason[];
}

export interface MethodPilotSelectionResult {
    /** ONE common method for all three frozen arms (per-model choice impossible). */
    selected: MethodId;
    /** True when the M0 baseline was invalid/incomplete → pilot inconclusive, M0 retained. */
    inconclusive: boolean;
    /** Why the M0 baseline is invalid (empty when valid). */
    baselineBlockReasons: readonly MethodPilotBaselineBlockReason[];
    /** Q used in S_m and the bootstrap: the sealed roster query count. */
    queryCount: number;
    /** Fixed order M0, M1, M2. */
    methods: readonly [MethodPilotMethodMetrics, MethodPilotMethodMetrics, MethodPilotMethodMetrics];
    /** Fixed order M1, M2. */
    alternatives: readonly [MethodPilotAlternativeAssessment, MethodPilotAlternativeAssessment];
}

/* ──────────────────────────────────────────────────────────────────
 * Deterministic primitives (byte-identical replicas of the private
 * helpers in `model-comparison-stats.ts`; exported for the
 * byte-equivalence tests only).
 * ──────────────────────────────────────────────────────────────── */

/**
 * Seeded deterministic PRNG (mulberry32). Byte-identical to the
 * private helpers in `model-comparison-stats.ts:215` and
 * `ir-metrics.ts:317`; A1.1 line 491 names this PRNG family for the
 * frozen seed. The selector's own bootstrap never accepts a seed
 * override — this export exists so the test can pin byte-equivalence
 * against `scripts/eval/d46/sample-second-label.ts`.
 */
export function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Nearest-rank percentile over an ascending array: index
 * `ceil(q·len) − 1`, clamped — the convention of `percentileSorted`
 * in `ir-metrics.ts:346` referenced by A1.1 line 491 ("nearest-rank
 * .025 percentile"). Exported so the test can pin byte-equivalence
 * against `percentile` in `metrics.ts` (same convention).
 */
export function percentileSorted(sorted: readonly number[], q: number): number {
    const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1));
    return sorted[index]!;
}

function compareStrings(a: string, b: string): number {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
}

/** Per-arm record builder with literal keys (compile-checked against `ComparisonModelId`). */
function mapArms<T>(fn: (arm: ComparisonModelId) => T): Record<ComparisonModelId, T> {
    return {
        "~typesafe/jev-latest": fn("~typesafe/jev-latest"),
        "perplexity/pplx-decider-v1.1-27b": fn("perplexity/pplx-decider-v1.1-27b"),
        "openai/gpt-6-luna-decisions": fn("openai/gpt-6-luna-decisions"),
    };
}

/* ──────────────────────────────────────────────────────────────────
 * Input validation (fail-closed; throws on any structural defect).
 * ──────────────────────────────────────────────────────────────── */

interface NormalizedInput {
    arms: readonly ComparisonModelId[];
    /** Q = sealed roster query count (never caller-supplied). */
    queryCount: number;
    /** Roster query ids sorted lexicographically (A1.1 line 491). */
    sortedQueryIds: readonly string[];
    /** Flat roster candidate universe (queryGroup, candidateId), sorted. */
    candidateKeys: readonly { queryGroup: string; candidateId: string }[];
    /** Roster candidate ids per query, sorted. */
    candidatesByQuery: ReadonlyMap<string, readonly string[]>;
    /** gold = (sealed roster label === "gold") per (queryGroup, candidateId). */
    goldByKey: ReadonlyMap<string, boolean>;
    /** Full key (model, method, qid, cid, replica) → row; duplicates rejected. */
    rows: ReadonlyMap<string, MethodPilotProbabilityRow>;
    /** Full key (model, method) → all four integrity flags false. */
    integrityOk: ReadonlyMap<string, boolean>;
}

const ROW_KEYS = Object.freeze([
    "model",
    "method",
    "queryGroup",
    "candidateId",
    "label",
    "replica",
    "probability",
    "forward",
    "reverse",
]);

const INTEGRITY_KEYS = Object.freeze([
    "model",
    "method",
    "servedIdentityDrift",
    "payloadDrift",
    "captureGap",
    "abortedRun",
    "finalAttemptUnverified",
]);

/* Exact-key sets: foreign or extra keys fail closed at every level —
 * selector input, roster, roster entries, rows, integrity entries. */
const INPUT_KEYS = Object.freeze(["roster", "rows", "integrity"]);
const ROSTER_KEYS = Object.freeze(["queries", "candidates", "sourceRef", "manifestSha256"]);
const ROSTER_QUERY_KEYS = Object.freeze(["qid", "answerable"]);
const ROSTER_CANDIDATE_KEYS = Object.freeze(["cid", "qid", "file", "startLine", "endLine", "label"]);

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

function isStringIn<T extends string>(values: readonly T[], value: unknown): value is T {
    return typeof value === "string" && (values as readonly string[]).includes(value);
}

function isProbabilityOrNull(value: unknown): boolean {
    return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1);
}

function rowKey(model: string, method: string, queryGroup: string, candidateId: string, replica: number): string {
    return [model, method, queryGroup, candidateId, replica].join(" ");
}

function candidateKey(queryGroup: string, candidateId: string): string {
    return `${queryGroup} ${candidateId}`;
}

function integrityKey(model: string, method: string): string {
    return `${model} ${method}`;
}

function validateRowShape(row: unknown): void {
    if (!isPlainObject(row)) throw new Error("method-pilot-selector: row is not an object");
    if (!hasExactKeys(row, ROW_KEYS)) throw new Error("method-pilot-selector: row has foreign or missing keys");
    validateRowIdentity(row);
    validateRowProbabilityFields(row);
}

function validateRowIdentity(row: Record<string, unknown>): void {
    if (!isNonEmptyString(row.queryGroup)) throw new Error("method-pilot-selector: row.queryGroup must be a non-empty string");
    if (!isNonEmptyString(row.candidateId)) throw new Error("method-pilot-selector: row.candidateId must be a non-empty string");
    if (!isStringIn(FROZEN_PILOT_ARMS as readonly string[], row.model)) throw new Error("method-pilot-selector: row.model is not a frozen pilot arm");
    if (!isStringIn(METHOD_IDS, row.method)) throw new Error("method-pilot-selector: row.method is not M0/M1/M2");
    if (!isStringIn(METHOD_PILOT_LABELS, row.label)) throw new Error("method-pilot-selector: row.label must be gold/hard_negative/easy_negative");
    if (typeof row.replica !== "number" || !Number.isInteger(row.replica) || row.replica < 0 || row.replica >= PILOT_REPLICA_COUNT) {
        throw new Error(`method-pilot-selector: row.replica must be an integer in 0..${PILOT_REPLICA_COUNT - 1}`);
    }
}

function validateRowProbabilityFields(row: Record<string, unknown>): void {
    if (!isProbabilityOrNull(row.probability)) throw new Error("method-pilot-selector: row.probability must be null or in [0,1]");
    if (!isProbabilityOrNull(row.forward)) throw new Error("method-pilot-selector: row.forward must be null or in [0,1]");
    if (!isProbabilityOrNull(row.reverse)) throw new Error("method-pilot-selector: row.reverse must be null or in [0,1]");
    if (row.method === "M2") {
        if (row.probability !== null) throw new Error("method-pilot-selector: M2 rows carry forward/reverse components, not a single probability");
    } else if (row.forward !== null || row.reverse !== null) {
        throw new Error("method-pilot-selector: M0/M1 rows carry a single probability only");
    }
}

function validateIntegrityShape(entry: unknown): void {
    if (!isPlainObject(entry)) throw new Error("method-pilot-selector: integrity entry is not an object");
    if (!hasExactKeys(entry, INTEGRITY_KEYS)) throw new Error("method-pilot-selector: integrity entry has foreign or missing keys");
    if (!isStringIn(FROZEN_PILOT_ARMS as readonly string[], entry.model)) throw new Error("method-pilot-selector: integrity.model is not a frozen pilot arm");
    if (!isStringIn(METHOD_IDS, entry.method)) throw new Error("method-pilot-selector: integrity.method is not M0/M1/M2");
    for (const flag of ["servedIdentityDrift", "payloadDrift", "captureGap", "abortedRun", "finalAttemptUnverified"] as const) {
        if (typeof entry[flag] !== "boolean") throw new Error(`method-pilot-selector: integrity.${flag} must be a boolean`);
    }
}

/* ──────────────────────────────────────────────────────────────────
 * Sealed roster binding (A1.1 review findings): Q, the candidate
 * universe, and every gold label come from the verified roster only;
 * a row outside it — or a row label disagreeing with it — is rejected.
 * ──────────────────────────────────────────────────────────────── */

/** Roster-derived candidate universe, labels, and membership set. */
interface RosterCandidateIndex {
    /** Flat roster candidate universe (queryGroup, candidateId), sorted. */
    candidateKeys: readonly { queryGroup: string; candidateId: string }[];
    /** Roster candidate ids per query, sorted. */
    candidatesByQuery: ReadonlyMap<string, readonly string[]>;
    /** "qid cid" → (roster label === "gold"). */
    goldByKey: ReadonlyMap<string, boolean>;
    /** "qid cid" → the sealed roster label. */
    labelByKey: ReadonlyMap<string, MethodPilotLabel>;
    /** "qid cid" membership; rows outside it are rejected. */
    candidatePairs: ReadonlySet<string>;
}

/** Normalized roster: the single source of Q, candidates, and labels. */
interface NormalizedRoster extends RosterCandidateIndex {
    /** Q = roster.queries.length (never a caller-supplied count). */
    queryCount: number;
    /** Query ids sorted lexicographically (A1.1 line 491). */
    sortedQueryIds: readonly string[];
}

function normalizeRosterQueries(value: unknown): { qidSet: Set<string>; sortedQueryIds: readonly string[] } {
    if (!Array.isArray(value) || value.length === 0) {
        throw new Error("method-pilot-selector: roster.queries must contain at least one sealed query");
    }
    const qidSet = new Set<string>();
    value.forEach((raw, index) => {
        if (!isPlainObject(raw) || !hasExactKeys(raw, ROSTER_QUERY_KEYS)) {
            throw new Error(`method-pilot-selector: roster.queries[${index}] has foreign or missing keys`);
        }
        const { qid, answerable } = raw;
        if (!isNonEmptyString(qid)) throw new Error(`method-pilot-selector: roster.queries[${index}].qid must be a non-empty string`);
        if (typeof answerable !== "boolean") throw new Error(`method-pilot-selector: roster.queries[${index}].answerable must be a boolean`);
        if (qidSet.has(qid)) throw new Error(`method-pilot-selector: duplicate roster query ${qid}`);
        qidSet.add(qid);
    });
    return { qidSet, sortedQueryIds: [...qidSet].sort(compareStrings) };
}

/** Exact-key + typed field check for one roster candidate entry. */
function parseRosterCandidate(raw: unknown, index: number): { cid: string; qid: string; label: MethodPilotLabel } {
    if (!isPlainObject(raw) || !hasExactKeys(raw, ROSTER_CANDIDATE_KEYS)) {
        throw new Error(`method-pilot-selector: roster.candidates[${index}] has foreign or missing keys`);
    }
    const { cid, qid, file, label, startLine, endLine } = raw;
    if (!isNonEmptyString(cid) || !isNonEmptyString(qid) || !isNonEmptyString(file)) {
        throw new Error(`method-pilot-selector: roster.candidates[${index}] must carry non-empty cid/qid/file`);
    }
    if (!isStringIn(METHOD_PILOT_LABELS, label)) {
        throw new Error(`method-pilot-selector: roster.candidates[${index}].label must be gold/hard_negative/easy_negative`);
    }
    if (typeof startLine !== "number" || typeof endLine !== "number" ||
        !Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) {
        throw new Error(`method-pilot-selector: roster.candidates[${index}] must carry a valid 1-based inclusive line range`);
    }
    return { cid, qid, label };
}

function normalizeRosterCandidates(
    value: unknown,
    sortedQueryIds: readonly string[],
    qidSet: ReadonlySet<string>,
): RosterCandidateIndex {
    if (!Array.isArray(value) || value.length === 0) {
        throw new Error("method-pilot-selector: roster.candidates must contain at least one sealed candidate");
    }
    const labelByKey = new Map<string, MethodPilotLabel>();
    const byQuery = new Map<string, Set<string>>();
    value.forEach((raw, index) => {
        const { cid, qid, label } = parseRosterCandidate(raw, index);
        if (!qidSet.has(qid)) {
            throw new Error(`method-pilot-selector: roster candidate ${cid} references query ${qid} missing from roster.queries`);
        }
        const key = candidateKey(qid, cid);
        if (labelByKey.has(key)) throw new Error(`method-pilot-selector: duplicate roster candidate ${cid} for query ${qid}`);
        labelByKey.set(key, label);
        const perQuery = byQuery.get(qid) ?? new Set<string>();
        perQuery.add(cid);
        byQuery.set(qid, perQuery);
    });
    const candidatesByQuery = new Map<string, readonly string[]>();
    const candidateKeys: { queryGroup: string; candidateId: string }[] = [];
    for (const qid of sortedQueryIds) {
        const ids = [...(byQuery.get(qid) ?? [])].sort(compareStrings);
        candidatesByQuery.set(qid, ids);
        for (const cid of ids) candidateKeys.push({ queryGroup: qid, candidateId: cid });
    }
    const goldByKey = new Map<string, boolean>();
    for (const [key, label] of labelByKey) goldByKey.set(key, label === "gold");
    return { candidateKeys, candidatesByQuery, goldByKey, labelByKey, candidatePairs: new Set(labelByKey.keys()) };
}

function normalizeRoster(value: unknown): NormalizedRoster {
    if (!isPlainObject(value)) throw new Error("method-pilot-selector: roster is not an object");
    if (!hasExactKeys(value, ROSTER_KEYS)) throw new Error("method-pilot-selector: roster has foreign or missing keys");
    if (!isNonEmptyString(value.sourceRef)) throw new Error("method-pilot-selector: roster.sourceRef must be a non-empty string");
    if (!isNonEmptyString(value.manifestSha256)) throw new Error("method-pilot-selector: roster.manifestSha256 must be a non-empty string");
    const { qidSet, sortedQueryIds } = normalizeRosterQueries(value.queries);
    const index = normalizeRosterCandidates(value.candidates, sortedQueryIds, qidSet);
    return { queryCount: sortedQueryIds.length, sortedQueryIds, ...index };
}

function accumulateRows(rawRows: readonly unknown[], roster: NormalizedRoster): Map<string, MethodPilotProbabilityRow> {
    const rows = new Map<string, MethodPilotProbabilityRow>();
    for (const raw of rawRows) {
        validateRowShape(raw);
        const row = raw as MethodPilotProbabilityRow;
        const cKey = candidateKey(row.queryGroup, row.candidateId);
        if (!roster.candidatePairs.has(cKey)) {
            throw new Error(`method-pilot-selector: row for ${row.queryGroup}/${row.candidateId} is not in the sealed roster`);
        }
        const rosterLabel = roster.labelByKey.get(cKey)!;
        if (row.label !== rosterLabel) {
            throw new Error(`method-pilot-selector: row label for ${row.queryGroup}/${row.candidateId} disagrees with the sealed roster`);
        }
        const rKey = rowKey(row.model, row.method, row.queryGroup, row.candidateId, row.replica);
        if (rows.has(rKey)) throw new Error(`method-pilot-selector: duplicate row for ${rKey}`);
        rows.set(rKey, row);
    }
    return rows;
}

function accumulateIntegrity(rawEntries: readonly unknown[]): Map<string, boolean> {
    const ok = new Map<string, boolean>();
    for (const raw of rawEntries) {
        validateIntegrityShape(raw);
        const entry = raw as MethodPilotIntegrityFlags;
        const key = integrityKey(entry.model, entry.method);
        if (ok.has(key)) throw new Error(`method-pilot-selector: duplicate integrity entry for ${key}`);
        const clean = !entry.servedIdentityDrift && !entry.payloadDrift && !entry.captureGap && !entry.abortedRun
            && !entry.finalAttemptUnverified;
        ok.set(key, clean);
    }
    for (const arm of FROZEN_PILOT_ARMS) {
        for (const method of METHOD_IDS) {
            const key = integrityKey(arm, method);
            if (!ok.has(key)) throw new Error(`method-pilot-selector: missing integrity entry for ${key}`);
        }
    }
    return ok;
}

function normalizeInput(input: MethodPilotSelectorInput, enforceFixedQueryCount: boolean): NormalizedInput {
    if (!isPlainObject(input)) throw new Error("method-pilot-selector: input is not an object");
    if (!hasExactKeys(input, INPUT_KEYS)) throw new Error("method-pilot-selector: input has foreign or missing keys");
    if (!Array.isArray(input.rows)) throw new Error("method-pilot-selector: rows must be an array");
    if (!Array.isArray(input.integrity)) throw new Error("method-pilot-selector: integrity must be an array");
    if (FROZEN_PILOT_ARMS.length !== 3) throw new Error("method-pilot-selector: frozen pilot roster must be exactly three arms (A1.1)");
    const armKeys = Object.keys(mapArms(() => 0)).sort(compareStrings);
    const rosterKeys = [...FROZEN_PILOT_ARMS].sort(compareStrings);
    if (armKeys.join() !== rosterKeys.join()) {
        throw new Error("method-pilot-selector: frozen pilot roster drifted from the ComparisonModelId union");
    }

    // Reviewer P1 (Stage E): structural equality with PilotCorpusRoster
    // proves nothing — only Stage B's runtime brand (or the documented
    // test seam that writes the same brand) is accepted, so hand-built
    // structural fakes fail closed here.
    if (!isVerifiedPilotCorpusRoster(input.roster)) {
        throw new Error(
            "method-pilot-selector: roster is not a verified pilot corpus roster " +
            "(brand from Stage B loadVerifiedPilotCorpus required)",
        );
    }
    const roster = normalizeRoster(input.roster);
    // A1.1 fixed Q (protocol lines 486/489/494): the production entry
    // refuses any roster count other than the frozen 40 — wrong-Q
    // rosters fail closed instead of silently rescaling S_m and the
    // bootstrap denominator. The count still comes from the roster
    // (never a caller-supplied value); this only pins it to the frozen Q.
    if (enforceFixedQueryCount && roster.queryCount !== PILOT_EXPECTED_QUERY_COUNT) {
        throw new Error(
            `method-pilot-selector: roster query count ${roster.queryCount} violates A1.1 fixed Q = ` +
            `${PILOT_EXPECTED_QUERY_COUNT}`,
        );
    }
    return {
        arms: FROZEN_PILOT_ARMS,
        queryCount: roster.queryCount,
        sortedQueryIds: roster.sortedQueryIds,
        candidateKeys: roster.candidateKeys,
        candidatesByQuery: roster.candidatesByQuery,
        goldByKey: roster.goldByKey,
        rows: accumulateRows(input.rows, roster),
        integrityOk: accumulateIntegrity(input.integrity),
    };
}

/* ──────────────────────────────────────────────────────────────────
 * Coverage, scoring, and pooled metrics.
 * ──────────────────────────────────────────────────────────────── */

function requiredComponentPresent(row: MethodPilotProbabilityRow | undefined, method: MethodId): boolean {
    if (row === undefined) return false;
    if (method === "M2") return row.forward !== null && row.reverse !== null;
    return row.probability !== null;
}

/**
 * Qualification 4 (line 493): every candidate of every frozen arm
 * must carry both replicas with non-null required components for this
 * method. A missing row and a null component are equally blocking.
 */
function hasCompleteCoverage(n: NormalizedInput, method: MethodId): boolean {
    for (const arm of n.arms) {
        for (const key of n.candidateKeys) {
            for (let replica = 0; replica < PILOT_REPLICA_COUNT; replica += 1) {
                const row = n.rows.get(rowKey(arm, method, key.queryGroup, key.candidateId, replica));
                if (!requiredComponentPresent(row, method)) return false;
            }
        }
    }
    return true;
}

/**
 * A1.1 line 484: M0/M1 score = mean of the two replica probabilities;
 * M2 replica score = (forward + reverse)/2, then the mean over the two
 * replicas. Coverage must be complete before calling (never partial).
 */
function candidateScore(
    n: NormalizedInput,
    arm: ComparisonModelId,
    method: MethodId,
    queryGroup: string,
    candidateId: string,
): number {
    const r0 = n.rows.get(rowKey(arm, method, queryGroup, candidateId, 0))!;
    const r1 = n.rows.get(rowKey(arm, method, queryGroup, candidateId, 1))!;
    if (method === "M2") {
        const replica0 = (r0.forward! + r0.reverse!) / 2;
        const replica1 = (r1.forward! + r1.reverse!) / 2;
        return (replica0 + replica1) / 2;
    }
    return (r0.probability! + r1.probability!) / 2;
}

interface MethodPilotComputedMetrics {
    lossByModel: Record<ComparisonModelId, number>;
    fnByModel: Record<ComparisonModelId, number>;
    s: number;
    /** lossByQuery[qidIndex][armIndex] = L_{a,m,q} (the bootstrap cluster totals). */
    lossByQuery: number[][];
    /** Arm-summed per-query loss for the bootstrap. */
    lossPerQuery: number[];
}

/** Pooled per-model loss at the frozen threshold; requires complete coverage. */
function computeMetrics(n: NormalizedInput, method: MethodId): MethodPilotComputedMetrics {
    const lossByModel = mapArms(() => 0);
    const fnByModel = mapArms(() => 0);
    const armIndex = new Map(n.arms.map((arm, index) => [arm, index]));
    const lossByQuery: number[][] = n.sortedQueryIds.map(() => new Array<number>(n.arms.length).fill(0));
    let total = 0;
    for (const arm of n.arms) {
        const index = armIndex.get(arm)!;
        let armLoss = 0;
        let armFn = 0;
        n.sortedQueryIds.forEach((qid, qIndex) => {
            let queryLoss = 0;
            for (const cid of n.candidatesByQuery.get(qid) ?? []) {
                const score = candidateScore(n, arm, method, qid, cid);
                const keep = score >= FROZEN_KEEP_THRESHOLD;
                const gold = n.goldByKey.get(candidateKey(qid, cid))!;
                if (gold && !keep) {
                    armFn += 1;
                    queryLoss += WEIGHTED_FN_PENALTY;
                } else if (!gold && keep) {
                    queryLoss += 1;
                }
            }
            lossByQuery[qIndex]![index] = queryLoss;
            armLoss += queryLoss;
        });
        lossByModel[arm] = armLoss;
        fnByModel[arm] = armFn;
        total += armLoss;
    }
    const s = total / (n.arms.length * n.queryCount);
    return {
        lossByModel,
        fnByModel,
        s,
        lossByQuery,
        lossPerQuery: lossByQuery.map((row) => row.reduce((a, b) => a + b, 0)),
    };
}

/* ──────────────────────────────────────────────────────────────────
 * Paired query-cluster bootstrap (A1.1 line 491).
 * ──────────────────────────────────────────────────────────────── */

interface BootstrapPair {
    method: MethodPilotAlternativeMethod;
    baseline: MethodPilotComputedMetrics;
    alternative: MethodPilotComputedMetrics;
}

/**
 * One shared draw stream (seed 20261008, B = 10,000, mulberry32):
 * each draw resamples Q lexicographically sorted query clusters with
 * replacement and applies the SAME picks to the baseline and every
 * alternative, for every model — replicas and models are never
 * independent samples. Returns the nearest-rank .025 percentile of
 * each alternative's D_m replicate distribution (the Bonferroni-
 * adjusted one-sided 97.5% lower bound for the two comparisons).
 * No seed/B/percentile knobs exist: retuning is impossible by API.
 */
function pairedBootstrapLowerBounds(
    n: NormalizedInput,
    pairs: readonly BootstrapPair[],
): Map<MethodPilotAlternativeMethod, number> {
    const bounds = new Map<MethodPilotAlternativeMethod, number>();
    if (pairs.length === 0) return bounds;
    const q = n.queryCount;
    const denominator = n.arms.length * q;
    const replicates = pairs.map(() => new Array<number>(FROZEN_BOOTSTRAP_ITERATIONS));
    const alternativeAcc = new Array<number>(pairs.length).fill(0);
    const rand = mulberry32(FROZEN_BOOTSTRAP_SEED);
    for (let draw = 0; draw < FROZEN_BOOTSTRAP_ITERATIONS; draw += 1) {
        let baselineAcc = 0;
        alternativeAcc.fill(0);
        for (let i = 0; i < q; i += 1) {
            const pick = Math.floor(rand() * q);
            baselineAcc += pairs[0]!.baseline.lossPerQuery[pick]!;
            for (let j = 0; j < pairs.length; j += 1) {
                alternativeAcc[j] = alternativeAcc[j]! + pairs[j]!.alternative.lossPerQuery[pick]!;
            }
        }
        for (let j = 0; j < pairs.length; j += 1) {
            replicates[j]![draw] = (baselineAcc - alternativeAcc[j]!) / denominator;
        }
    }
    pairs.forEach((pair, index) => {
        const sorted = [...replicates[index]!].sort((a, b) => a - b);
        bounds.set(pair.method, percentileSorted(sorted, BOOTSTRAP_LOWER_BOUND_QUANTILE));
    });
    return bounds;
}

/* ──────────────────────────────────────────────────────────────────
 * Assessment and selection (A1.1 line 498).
 * ──────────────────────────────────────────────────────────────── */

interface AlternativeStage {
    method: MethodPilotAlternativeMethod;
    reasons: MethodPilotAlternativeReason[];
    s: number | null;
    /** Present iff every precondition holds (own coverage + own integrity + valid baseline). */
    metrics: MethodPilotComputedMetrics | null;
    baseline: MethodPilotComputedMetrics | null;
}

function buildStage(
    n: NormalizedInput,
    method: MethodPilotAlternativeMethod,
    coverage: Record<MethodId, boolean>,
    metrics: Record<MethodId, MethodPilotComputedMetrics | null>,
    baselineBlockReasons: readonly MethodPilotBaselineBlockReason[],
): AlternativeStage {
    const reasons: MethodPilotAlternativeReason[] = [];
    const ownCoverage = coverage[method];
    if (!ownCoverage) reasons.push("incomplete_coverage");
    const integrityOk = n.arms.every((arm) => n.integrityOk.get(integrityKey(arm, method)) === true);
    if (!integrityOk) reasons.push("integrity_failed");
    if (reasons.length === 0 && baselineBlockReasons.length > 0) reasons.push("invalid_baseline");
    const ownMetrics = ownCoverage ? metrics[method] : null;
    const numeric = reasons.length === 0;
    return {
        method,
        reasons,
        s: ownMetrics !== null ? ownMetrics.s : null,
        metrics: numeric ? ownMetrics : null,
        baseline: numeric ? metrics.M0 : null,
    };
}

function finalizeStage(
    stage: AlternativeStage,
    bounds: ReadonlyMap<MethodPilotAlternativeMethod, number>,
): MethodPilotAlternativeAssessment {
    let d: number | null = null;
    let marginPass: boolean | null = null;
    let bootstrapLowerBound: number | null = null;
    let bootstrapPass: boolean | null = null;
    let fnDeltaByModel: Readonly<Record<ComparisonModelId, number>> | null = null;
    let fnGuardPass: boolean | null = null;

    if (stage.metrics !== null && stage.baseline !== null) {
        const baseline = stage.baseline;
        const metrics = stage.metrics;
        d = baseline.s - metrics.s;
        marginPass = d >= MIN_IMPROVEMENT_MARGIN;
        bootstrapLowerBound = bounds.get(stage.method) ?? null;
        bootstrapPass = bootstrapLowerBound !== null && bootstrapLowerBound > 0;
        fnDeltaByModel = mapArms((arm) => metrics.fnByModel[arm] - baseline.fnByModel[arm]);
        fnGuardPass = Object.values(fnDeltaByModel).every((delta) => delta <= MAX_ADDITIONAL_FN_PER_MODEL);
        if (!marginPass) stage.reasons.push("margin_failed");
        if (!bootstrapPass) stage.reasons.push("bootstrap_failed");
        if (!fnGuardPass) stage.reasons.push("fn_guard_failed");
    }

    return {
        method: stage.method,
        s: stage.s,
        d,
        marginPass,
        bootstrapLowerBound,
        bootstrapPass,
        fnDeltaByModel,
        fnGuardPass,
        qualified: stage.reasons.length === 0,
        reasons: [...stage.reasons],
    };
}

/**
 * A1.1 line 498: neither qualifies → M0; exactly one → it; both → the
 * lower S_m; exact alternative tie → M2 (fixed preference for fewer
 * requests than M1). An invalid/incomplete baseline short-circuits to
 * M0 with `inconclusive` set before qualification is ever consulted.
 */
function resolveSelection(
    baselineValid: boolean,
    alternatives: readonly [MethodPilotAlternativeAssessment, MethodPilotAlternativeAssessment],
): MethodId {
    if (!baselineValid) return "M0";
    const [first, second] = alternatives;
    if (first.qualified && second.qualified) {
        if (first.s !== null && second.s !== null && first.s < second.s) return "M1";
        return "M2";
    }
    if (first.qualified) return "M1";
    if (second.qualified) return "M2";
    return "M0";
}

/**
 * Select ONE common method for all three frozen arms per A1.1.
 * Production entry point: the roster must carry Stage B's runtime
 * verification brand (`isVerifiedPilotCorpusRoster`) and must have
 * exactly `PILOT_EXPECTED_QUERY_COUNT` (40) queries — structural fakes
 * and wrong-Q rosters fail closed with explicit errors. Also throws on
 * structurally invalid input (foreign keys, duplicate rows, rows or
 * labels outside the sealed roster, roster structure defects).
 * Q, the candidate universe, and the gold labels come only from the
 * roster; threshold, margin, penalty, seed, draw count, and tie rule
 * are NOT parameters.
 */
export function selectMethodPilotMethod(input: MethodPilotSelectorInput): MethodPilotSelectionResult {
    return runSelection(input, true);
}

/**
 * Test-only seam (mirrors Stage B's `__test__sealPilotCorpusFromRoot`):
 * identical to the production entry EXCEPT the A1.1 fixed-Q = 40
 * precondition. The verification-brand gate, every structural check,
 * and all A1.1 semantics (metric, margin, bootstrap, FN guard, tie →
 * M2, default M0) are byte-identical to production. Exists solely so
 * the hand-computed small-fixture tests can exercise the shared core;
 * production callers must use `selectMethodPilotMethod`.
 */
export function __test__selectMethodPilotMethodUnfixedQueryCount(
    input: MethodPilotSelectorInput,
): MethodPilotSelectionResult {
    return runSelection(input, false);
}

function runSelection(input: MethodPilotSelectorInput, enforceFixedQueryCount: boolean): MethodPilotSelectionResult {
    const n = normalizeInput(input, enforceFixedQueryCount);

    const coverage: Record<MethodId, boolean> = {
        M0: hasCompleteCoverage(n, "M0"),
        M1: hasCompleteCoverage(n, "M1"),
        M2: hasCompleteCoverage(n, "M2"),
    };
    const metrics: Record<MethodId, MethodPilotComputedMetrics | null> = {
        M0: coverage.M0 ? computeMetrics(n, "M0") : null,
        M1: coverage.M1 ? computeMetrics(n, "M1") : null,
        M2: coverage.M2 ? computeMetrics(n, "M2") : null,
    };

    const baselineBlockReasons: MethodPilotBaselineBlockReason[] = [];
    if (!coverage.M0) baselineBlockReasons.push("incomplete_coverage");
    const baselineIntegrityOk = n.arms.every((arm) => n.integrityOk.get(integrityKey(arm, "M0")) === true);
    if (!baselineIntegrityOk) baselineBlockReasons.push("integrity_failed");

    const stages = ALTERNATIVE_METHODS.map((method) => buildStage(n, method, coverage, metrics, baselineBlockReasons));
    const pairs: BootstrapPair[] = [];
    for (const stage of stages) {
        if (stage.metrics !== null && stage.baseline !== null) {
            pairs.push({ method: stage.method, baseline: stage.baseline, alternative: stage.metrics });
        }
    }
    const bounds = pairedBootstrapLowerBounds(n, pairs);
    const alternatives: [MethodPilotAlternativeAssessment, MethodPilotAlternativeAssessment] = [
        finalizeStage(stages[0]!, bounds),
        finalizeStage(stages[1]!, bounds),
    ];

    const methods: [MethodPilotMethodMetrics, MethodPilotMethodMetrics, MethodPilotMethodMetrics] = [
        buildMethodMetrics("M0", metrics.M0),
        buildMethodMetrics("M1", metrics.M1),
        buildMethodMetrics("M2", metrics.M2),
    ];

    return {
        selected: resolveSelection(baselineBlockReasons.length === 0, alternatives),
        inconclusive: baselineBlockReasons.length > 0,
        baselineBlockReasons,
        queryCount: n.queryCount,
        methods,
        alternatives,
    };
}

function buildMethodMetrics(
    method: MethodId,
    computed: MethodPilotComputedMetrics | null,
): MethodPilotMethodMetrics {
    return {
        method,
        lossByModel: computed !== null ? computed.lossByModel : null,
        fnByModel: computed !== null ? computed.fnByModel : null,
        s: computed !== null ? computed.s : null,
    };
}
