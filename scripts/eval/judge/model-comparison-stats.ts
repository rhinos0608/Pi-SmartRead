/**
 * Pure, deterministic statistics for the frozen judge model-comparison
 * policy (protocol §4.4, "Statistics policy (frozen 2026-10-08,
 * pre-data)"). No I/O, no wall clock, no randomness beyond the seeded
 * bootstrap PRNG: every function is a total function over validated
 * DTOs from `model-comparison-types.ts`.
 *
 * Frozen conventions implemented here:
 *
 * - Selection at `p >= FROZEN_KEEP_THRESHOLD` (equality selects), the
 *   repo-wide keep-gate convention (`metrics.ts` counts `p >= t`, the
 *   grep/find judge stages keep `p >= 0.40`).
 * - Every metric is computed on replica-averaged scores
 *   (`averageComparisonReplicas`), never on pooled repeated rows.
 *   A unit whose average is null is never coerced to 0 or 0.5: it is
 *   excluded from quality metrics and surfaced through the
 *   unjudged/availability gates (`ComparisonArmRunSummary`) and,
 *   when a governing metric becomes undefined, through the
 *   `missing_probability` block reason.
 * - Paired cluster bootstrap: 44 `set:qid` groups resampled jointly
 *   for challenger and incumbent with one seeded draw stream
 *   (mulberry32 — byte-identical to the private helper in
 *   `ir-metrics.ts:317`, which does not export it), B = 10,000, seed
 *   20261008, two-sided percentile 95% CI by the nearest-rank
 *   convention of `percentileSorted` in `ir-metrics.ts:346`
 *   (index `ceil(q·B) − 1`, q = .025/.975). Degenerate draws (a
 *   metric undefined on the resample) are redrawn per metric within
 *   one shared draw loop capped at 100·B total attempts; exhaustion
 *   blocks the arm with `degenerate_bootstrap` (§4.4 points 5–7).
 *
 * Interpretation notes (reported to the protocol owner):
 *
 * - The single `auroc_ni` gate uses the gold-vs-ALL-negatives AUROC
 *   (§4.4 point 2 defines both populations; the protocol's headline
 *   AUROC — §3.1 "AUROC: 0.9592" — is gold vs all negatives, and the
 *   hard-negative population is separately represented by the
 *   `hard_negative_precision_ni` gate). Both AUROC populations and
 *   both bootstrap CIs are computed and exposed either way.
 * - Loss `6·FN + 1·FP` counts FP over ALL negatives ("pooled … over
 *   the corpus", §4.4 estimand point 4), not hard negatives only.
 * - Baseline must be the frozen incumbent (`~typesafe/jev-latest`);
 *   all Δ gates are defined against it.
 */

import {
    COMPARISON_GATE_IDS,
    COMPARISON_GATE_THRESHOLDS,
    FROZEN_CORPUS_UNITS,
    FROZEN_REPLICA_COUNT,
    isComparisonArmRunSummary,
    isComparisonGateResult,
    isComparisonModelId,
    isComparisonPlannedUnit,
    isComparisonQualificationResult,
    isComparisonReportConsistent,
    isComparisonScoredOutcome,
    isComparisonUnitAverage,
    isComparisonUnitAverageDerivedFrom,
    type ComparisonArmRunSummary,
    type ComparisonBlockedReason,
    type ComparisonGateId,
    type ComparisonGateResult,
    type ComparisonModelId,
    type ComparisonPlannedUnit,
    type ComparisonQualificationResult,
    type ComparisonScoredOutcome,
    type ComparisonTruthClass,
    type ComparisonUnitAverage,
} from "./model-comparison-types.js";
import { expectedCalibrationError } from "./ir-metrics.js";

/* ──────────────────────────────────────────────────────────────────
 * Frozen policy constants (protocol §4.1/§4.4).
 * ──────────────────────────────────────────────────────────────── */

/** Frozen keep gate τ_keep = 0.40; a unit is selected at `p >= 0.40`. */
export const FROZEN_KEEP_THRESHOLD = 0.4;

/** Frozen incumbent arm: all Δ gates are challenger − incumbent. */
export const INCUMBENT_ARM: ComparisonModelId = "~typesafe/jev-latest";

/**
 * §4.4 frozen challenger roster (parent-frozen pre-data): every Gate 4
 * selection input must carry exactly these arms, each exactly once.
 * Fail-closed by construction: an omitted challenger could otherwise
 * bypass the any-challenger ECE harm stop simply by being left off the
 * candidate list. Pinned by test to `COMPARISON_MODELS` minus the
 * incumbent; changing it requires a new pre-data freeze.
 */
export const FROZEN_CHALLENGER_ARMS: readonly ComparisonModelId[] = Object.freeze([
    "perplexity/pplx-decider-v1.1-27b",
    "openai/gpt-6-luna-decisions",
]);

/** §4.4 point 6 (parent-frozen): bootstrap seed. */
export const FROZEN_BOOTSTRAP_SEED = 20261008;
/** §4.4 point 6 (parent-frozen): B draws (supersedes §4.2's 2,000). */
export const FROZEN_BOOTSTRAP_ITERATIONS = 10_000;
/** §4.4 point 7 (parent-frozen): degenerate draws redrawn up to 100·B attempts. */
export const FROZEN_BOOTSTRAP_MAX_ATTEMPTS_FACTOR = 100;
/** §4.4 tie-break denominator: 314 units × 5 replicas = 1,570 planned judgments. */
export const FROZEN_PLANNED_JUDGMENTS = FROZEN_CORPUS_UNITS * FROZEN_REPLICA_COUNT;

/* ──────────────────────────────────────────────────────────────────
 * Local input/output types (the frozen types module does not define
 * these; reported as locally defined).
 * ──────────────────────────────────────────────────────────────── */

/**
 * Bootstrap controls. Defaults are the frozen §4.4 constants;
 * overrides exist so tests can exercise determinism and the
 * degenerate-draw rules cheaply — production callers must omit them.
 */
export interface ComparisonBootstrapOptions {
    seed: number;
    iterations: number;
    /** Max total draw attempts per bootstrap as a factor of B (frozen: 100). */
    maxAttemptsFactor: number;
}

/** Per-arm metrics computed on replica-averaged scores at τ_keep = 0.40. */
export interface ComparisonArmMetrics {
    /** Units with a valid replica-averaged probability (unjudged units excluded). */
    scoredUnits: number;
    goldCount: number;
    hardNegativeCount: number;
    /** All scored negatives: hard-negative + other-negative. */
    negativeCount: number;
    selectedCount: number;
    tp: number;
    /** False positives over ALL negatives (loss counts `6·FN + 1·FP` over the corpus). */
    fp: number;
    fn: number;
    tn: number;
    /** tp / scored gold; null iff no scored gold unit. */
    recall: number | null;
    /** tp / predicted positives within gold + hard negatives; null iff zero selections. */
    hardNegativePrecision: number | null;
    aurocGoldVsAll: number | null;
    aurocGoldVsHard: number | null;
    brier: number | null;
    ece: number | null;
    /** Pooled `6·FN + 1·FP` at the frozen threshold. */
    loss: number;
}

/** Percentile CI over bootstrap replicates (nearest-rank convention). */
export interface ComparisonBootstrapInterval {
    ciLow: number;
    ciHigh: number;
    iterations: number;
    /** Draw attempts consumed (equals `iterations` when nothing was degenerate). */
    attempts: number;
}

/**
 * Paired Δ CIs (challenger − incumbent; utility as incumbent loss −
 * challenger loss per query). `null` when the point estimate is
 * undefined for either arm (qualification records the matching block
 * reason) or when degenerate draws exhausted the attempt cap
 * (block reason `degenerate_bootstrap`).
 */
export interface ComparisonBootstrapResult {
    recallDelta: ComparisonBootstrapInterval | null;
    hardNegativePrecisionDelta: ComparisonBootstrapInterval | null;
    aurocGoldVsAllDelta: ComparisonBootstrapInterval | null;
    aurocGoldVsHardDelta: ComparisonBootstrapInterval | null;
    brierDelta: ComparisonBootstrapInterval | null;
    utilityGainPerQuery: ComparisonBootstrapInterval | null;
}

/** Input to the paired cluster bootstrap (§4.4 points 5–7). */
export interface ComparisonBootstrapRequest {
    challenger: readonly ComparisonUnitAverage[];
    baseline: readonly ComparisonUnitAverage[];
    /** Test-only overrides of the frozen seed/B/attempt cap. */
    options?: Partial<ComparisonBootstrapOptions>;
}

/** Input to full gate evaluation + qualification for one challenger arm. */
export interface ComparisonQualificationInput {
    arm: ComparisonModelId;
    /** Must equal `INCUMBENT_ARM` (frozen incumbent). */
    baseline: ComparisonModelId;
    challengerAverages: readonly ComparisonUnitAverage[];
    baselineAverages: readonly ComparisonUnitAverage[];
    /** Operational gates (availability, unjudged) + completeness block reasons. */
    challengerSummary: ComparisonArmRunSummary;
    /** Test-only overrides of the frozen seed/B/attempt cap. */
    bootstrap?: Partial<ComparisonBootstrapOptions>;
}

/**
 * One contender at Gate 4 selection (§4.4 tie-break rules).
 *
 * The selection ECE is intentionally NOT a field here: the harm stop
 * and the ECE tie-break derive it from `qualification`'s validated
 * `ece_harm_stop` gate value (see `selectionCandidateEce`), so a
 * caller cannot present an ECE that disagrees with the arm's own
 * qualification. `costComplete`, `costPer1000Usd`, and `p95LatencyMs`
 * remain caller-supplied: this shape carries no
 * `ComparisonArmRunSummary` to derive them from.
 */
export interface ComparisonSelectionCandidate {
    /** Validated via `isComparisonQualificationResult` before use. */
    qualification: ComparisonQualificationResult;
    /** False when any attempt cost remains `{status:'unknown'}` — blocks ranking. */
    costComplete: boolean;
    /** Measured campaign spend per 1,570 planned judgments × 1,000 (see `costPerThousandJudgments`). */
    costPer1000Usd: number;
    /** Nearest-rank p95 over non-warmup attempt latencies including retries. */
    p95LatencyMs: number;
}

/* ──────────────────────────────────────────────────────────────────
 * Deterministic primitives.
 * ──────────────────────────────────────────────────────────────── */

/**
 * Seeded deterministic PRNG (mulberry32). Byte-identical to the
 * private helper in `scripts/eval/judge/ir-metrics.ts` (not exported
 * there); §4.4 point 6 names this PRNG family for the frozen seed.
 */
function mulberry32(seed: number): () => number {
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
 * in `ir-metrics.ts:346` referenced by §4.4 point 6.
 */
function percentileSorted(sorted: readonly number[], q: number): number {
    const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1));
    return sorted[index]!;
}

function compareStrings(a: string, b: string): number {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
}

function resolveBootstrapOptions(options?: Partial<ComparisonBootstrapOptions>): ComparisonBootstrapOptions {
    const resolved: ComparisonBootstrapOptions = {
        seed: options?.seed ?? FROZEN_BOOTSTRAP_SEED,
        iterations: options?.iterations ?? FROZEN_BOOTSTRAP_ITERATIONS,
        maxAttemptsFactor: options?.maxAttemptsFactor ?? FROZEN_BOOTSTRAP_MAX_ATTEMPTS_FACTOR,
    };
    if (!Number.isInteger(resolved.seed)) throw new Error("bootstrap seed must be an integer");
    if (!Number.isInteger(resolved.iterations) || resolved.iterations <= 0) {
        throw new Error("bootstrap iterations must be a positive integer");
    }
    if (!Number.isInteger(resolved.maxAttemptsFactor) || resolved.maxAttemptsFactor <= 0) {
        throw new Error("bootstrap maxAttemptsFactor must be a positive integer");
    }
    return resolved;
}

/* ──────────────────────────────────────────────────────────────────
 * Replica averaging.
 * ──────────────────────────────────────────────────────────────── */

/**
 * Derive the replica-averaged record for every distinct
 * arm × query-group × unit in `outcomes` (§4.4 estimand point 1):
 * the mean is taken in ascending replica order over the five frozen
 * replicas and is null unless ALL five replicas carry a valid
 * probability — any missing or null replica yields `null`, never a
 * partial mean and never 0/0.5. Fail-closed: invalid outcome rows,
 * duplicate replica indices, or inconsistent identity (file/truth)
 * across replicas throw; every emitted record is verified with
 * `isComparisonUnitAverageDerivedFrom` before returning.
 */
export function averageComparisonReplicas(outcomes: readonly ComparisonScoredOutcome[]): ComparisonUnitAverage[] {
    const byUnit = new Map<string, ComparisonScoredOutcome[]>();
    for (const row of outcomes) {
        if (!isComparisonScoredOutcome(row)) {
            throw new Error("averageComparisonReplicas: invalid scored outcome");
        }
        const key = `${row.arm}\u0000${row.queryGroup}\u0000${row.unitId}`;
        const bucket = byUnit.get(key);
        if (bucket === undefined) byUnit.set(key, [row]);
        else bucket.push(row);
    }

    const result: ComparisonUnitAverage[] = [];
    for (const rows of byUnit.values()) {
        const first = rows[0]!;
        for (const row of rows) {
            if (row.file !== first.file || row.truth !== first.truth) {
                throw new Error(`averageComparisonReplicas: inconsistent identity for ${first.queryGroup}/${first.unitId}`);
            }
        }
        const ordered = [...rows].sort((a, b) => a.replica - b.replica);
        const seenReplicas = new Set<number>();
        let replicasAveraged = 0;
        let sum = 0;
        for (const row of ordered) {
            if (seenReplicas.has(row.replica)) {
                throw new Error(`averageComparisonReplicas: duplicate replica ${row.replica} for ${first.queryGroup}/${first.unitId}`);
            }
            seenReplicas.add(row.replica);
            if (row.probability !== null) {
                replicasAveraged += 1;
                sum += row.probability;
            }
        }
        const record: ComparisonUnitAverage = {
            arm: first.arm,
            queryGroup: first.queryGroup,
            unitId: first.unitId,
            file: first.file,
            truth: first.truth,
            replicasAveraged,
            averageProbability: replicasAveraged === FROZEN_REPLICA_COUNT ? sum / FROZEN_REPLICA_COUNT : null,
        };
        if (!isComparisonUnitAverage(record) || !isComparisonUnitAverageDerivedFrom(ordered, record)) {
            throw new Error(`averageComparisonReplicas: derived record failed validation for ${first.queryGroup}/${first.unitId}`);
        }
        result.push(record);
    }
    result.sort((a, b) => compareStrings(a.arm, b.arm)
        || compareStrings(a.queryGroup, b.queryGroup)
        || compareStrings(a.unitId, b.unitId));
    return result;
}

/* ──────────────────────────────────────────────────────────────────
 * Per-arm metrics on replica-averaged scores.
 * ──────────────────────────────────────────────────────────────── */

interface ScoredUnit {
    truth: ComparisonTruthClass;
    /** Replica-averaged probability, or null for a unit with no valid average. */
    score: number | null;
}

/**
 * AUROC with exact tie handling: for every positive/negative pair the
 * credit is `1[p_i > p_j] + 0.5·1[p_i = p_j]` (§4.2). Computed via
 * ascending tie groups, which is algebraically identical to the
 * pairwise sum. Null when either class is empty.
 */
function aurocGoldVs(positives: readonly number[], negatives: readonly number[]): number | null {
    if (positives.length === 0 || negatives.length === 0) return null;
    const items = [
        ...positives.map((p) => ({ p, positive: true })),
        ...negatives.map((p) => ({ p, positive: false })),
    ].sort((a, b) => a.p - b.p);
    let credit = 0;
    let negativesSeen = 0;
    let index = 0;
    while (index < items.length) {
        const score = items[index]!.p;
        let positivesInTie = 0;
        let negativesInTie = 0;
        while (index < items.length && items[index]!.p === score) {
            if (items[index]!.positive) positivesInTie += 1;
            else negativesInTie += 1;
            index += 1;
        }
        credit += positivesInTie * (negativesSeen + 0.5 * negativesInTie);
        negativesSeen += negativesInTie;
    }
    return credit / (positives.length * negatives.length);
}

/**
 * Core metric computation over scored units. Units with a null score
 * are skipped entirely: unjudged units are counted by the
 * unjudged/availability gates, never imputed into quality metrics
 * (§4.4 missing-data rule: recorded unjudged units "are counted by
 * the unjudged/availability gates"). `hardNegativePrecision` is null
 * iff the gold + hard-negative subset has zero predicted positives
 * (§4.4 zero-selection precision: null, never 0 or 1).
 */
function computeUnitMetrics(units: readonly ScoredUnit[]): ComparisonArmMetrics {
    let goldCount = 0;
    let hardCount = 0;
    let otherCount = 0;
    let tp = 0;
    let fp = 0;
    let fn = 0;
    let tn = 0;
    let selectedHard = 0;
    let brierSum = 0;
    const goldScores: number[] = [];
    const allNegativeScores: number[] = [];
    const hardScores: number[] = [];
    const probabilities: number[] = [];
    const labels: boolean[] = [];

    for (const unit of units) {
        if (unit.score === null) continue;
        const isGold = unit.truth === "gold";
        const selected = unit.score >= FROZEN_KEEP_THRESHOLD;
        probabilities.push(unit.score);
        labels.push(isGold);
        brierSum += (unit.score - (isGold ? 1 : 0)) ** 2;
        if (isGold) {
            goldCount += 1;
            goldScores.push(unit.score);
            if (selected) tp += 1;
            else fn += 1;
            continue;
        }
        allNegativeScores.push(unit.score);
        if (unit.truth === "hard-negative") {
            hardCount += 1;
            hardScores.push(unit.score);
            if (selected) selectedHard += 1;
        } else {
            otherCount += 1;
        }
        if (selected) fp += 1;
        else tn += 1;
    }

    const scoredUnits = goldCount + hardCount + otherCount;
    const selectedInSubset = tp + selectedHard;
    return {
        scoredUnits,
        goldCount,
        hardNegativeCount: hardCount,
        negativeCount: hardCount + otherCount,
        selectedCount: tp + fp,
        tp,
        fp,
        fn,
        tn,
        recall: goldCount === 0 ? null : tp / goldCount,
        hardNegativePrecision: selectedInSubset === 0 ? null : tp / selectedInSubset,
        aurocGoldVsAll: aurocGoldVs(goldScores, allNegativeScores),
        aurocGoldVsHard: aurocGoldVs(goldScores, hardScores),
        brier: scoredUnits === 0 ? null : brierSum / scoredUnits,
        ece: scoredUnits === 0 ? null : expectedCalibrationError(probabilities, labels, 10).ece,
        loss: 6 * fn + fp,
    };
}

/**
 * Validate one arm's replica-averaged records: exact-shape records,
 * a single arm, no duplicate (query group, unit) pairs. Returns the
 * records ordered by (query group, unit) so all downstream sums are
 * order-deterministic regardless of input order.
 */
function validateAndOrderAverages(
    averages: readonly ComparisonUnitAverage[],
    expectedArm: ComparisonModelId | null,
    side: string,
): ComparisonUnitAverage[] {
    if (averages.length === 0) throw new Error(`${side}: no unit averages`);
    const ordered = [...averages].sort((a, b) => compareStrings(a.queryGroup, b.queryGroup)
        || compareStrings(a.unitId, b.unitId));
    const arm = expectedArm ?? ordered[0]!.arm;
    const seen = new Set<string>();
    for (const record of ordered) {
        if (!isComparisonUnitAverage(record)) throw new Error(`${side}: invalid unit average`);
        if (record.arm !== arm) throw new Error(`${side}: mixed or mismatched arms`);
        const key = `${record.queryGroup}\u0000${record.unitId}`;
        if (seen.has(key)) throw new Error(`${side}: duplicate unit average for ${record.queryGroup}/${record.unitId}`);
        seen.add(key);
    }
    return ordered;
}

function toScoredUnits(averages: readonly ComparisonUnitAverage[]): ScoredUnit[] {
    return averages.map((record) => ({ truth: record.truth, score: record.averageProbability }));
}

/**
 * Per-arm metrics at the frozen threshold on replica-averaged scores
 * (§4.4 estimand points 1–4). Records without a valid average are
 * excluded (never coerced); metrics that become undefined return
 * null instead of a convention value.
 */
export function computeComparisonArmMetrics(averages: readonly ComparisonUnitAverage[]): ComparisonArmMetrics {
    const ordered = validateAndOrderAverages(averages, null, "arm metrics");
    return computeUnitMetrics(toScoredUnits(ordered));
}

/* ──────────────────────────────────────────────────────────────────
 * Paired cluster bootstrap (§4.4 points 5–7).
 * ──────────────────────────────────────────────────────────────── */

type BootstrapFieldKey = keyof ComparisonBootstrapResult;

const BOOTSTRAP_FIELDS: readonly BootstrapFieldKey[] = [
    "recallDelta",
    "hardNegativePrecisionDelta",
    "aurocGoldVsAllDelta",
    "aurocGoldVsHardDelta",
    "brierDelta",
    "utilityGainPerQuery",
];

interface GroupedAverages {
    arm: ComparisonModelId;
    /** Ascending `set:qid` keys — the bootstrap's independence units. */
    groupKeys: string[];
    groups: Map<string, ScoredUnit[]>;
}

function groupComparisonAverages(
    averages: readonly ComparisonUnitAverage[],
    expectedArm: ComparisonModelId | null,
    side: string,
): GroupedAverages {
    const ordered = validateAndOrderAverages(averages, expectedArm, side);
    const byGroup = new Map<string, Map<string, ComparisonUnitAverage>>();
    for (const record of ordered) {
        let units = byGroup.get(record.queryGroup);
        if (units === undefined) {
            units = new Map();
            byGroup.set(record.queryGroup, units);
        }
        units.set(record.unitId, record);
    }
    const groupKeys = [...byGroup.keys()].sort(compareStrings);
    const groups = new Map<string, ScoredUnit[]>();
    for (const key of groupKeys) {
        const units = byGroup.get(key)!;
        const unitIds = [...units.keys()].sort(compareStrings);
        groups.set(key, unitIds.map((id) => {
            const record = units.get(id)!;
            return { truth: record.truth, score: record.averageProbability };
        }));
    }
    return { arm: ordered[0]!.arm, groupKeys, groups };
}

/** Per-draw differences: challenger − incumbent, except utility gain. */
function drawDeltas(
    challenger: ComparisonArmMetrics,
    baseline: ComparisonArmMetrics,
    groupCount: number,
): Record<BootstrapFieldKey, number | null> {
    const paired = (a: number | null, b: number | null): number | null => (a === null || b === null ? null : a - b);
    return {
        recallDelta: paired(challenger.recall, baseline.recall),
        hardNegativePrecisionDelta: paired(challenger.hardNegativePrecision, baseline.hardNegativePrecision),
        aurocGoldVsAllDelta: paired(challenger.aurocGoldVsAll, baseline.aurocGoldVsAll),
        aurocGoldVsHardDelta: paired(challenger.aurocGoldVsHard, baseline.aurocGoldVsHard),
        brierDelta: paired(challenger.brier, baseline.brier),
        utilityGainPerQuery: (baseline.loss - challenger.loss) / groupCount,
    };
}

function flattenGroups(grouped: GroupedAverages): ScoredUnit[] {
    const units: ScoredUnit[] = [];
    for (const key of grouped.groupKeys) units.push(...grouped.groups.get(key)!);
    return units;
}

/** Fail-closed pairing checks: arms differ, group/unit structure matches exactly. */
function assertPairedStructure(challenger: GroupedAverages, baseline: GroupedAverages): void {
    if (challenger.arm === baseline.arm) {
        throw new Error("paired bootstrap: challenger and baseline must be different arms");
    }
    if (challenger.groupKeys.length !== baseline.groupKeys.length
        || challenger.groupKeys.some((key, index) => key !== baseline.groupKeys[index])) {
        throw new Error("paired bootstrap: query groups differ between arms");
    }
    for (const key of challenger.groupKeys) {
        const challengerUnits = challenger.groups.get(key)!;
        const baselineUnits = baseline.groups.get(key)!;
        if (challengerUnits.length !== baselineUnits.length) {
            throw new Error(`paired bootstrap: unit count differs for ${key}`);
        }
        for (let i = 0; i < challengerUnits.length; i += 1) {
            if (challengerUnits[i]!.truth !== baselineUnits[i]!.truth) {
                throw new Error(`paired bootstrap: truth labels differ for ${key}`);
            }
        }
    }
}

/**
 * Paired query-cluster bootstrap (§4.4 points 5–7): each draw samples
 * `groupCount` query groups with replacement and applies the SAME
 * draw to both arms (one shared mulberry32 stream seeded from
 * `options.seed`); pooled metrics are recomputed on each arm's
 * resampled unit multiset and the per-draw difference is challenger
 * − incumbent (utility: incumbent loss − challenger loss per query,
 * denominator = number of query groups — 44 in the frozen corpus).
 *
 * Degenerate draws are redrawn per metric inside one shared loop
 * capped at `iterations × maxAttemptsFactor` total attempts (frozen
 * 100·B); a metric still short of B replicates at the cap returns
 * null (block reason `degenerate_bootstrap` at qualification).
 * Structural mismatches between arms (different query groups, unit
 * counts, or truth labels) throw — pairing is never silently zipped.
 */
export function pairedComparisonBootstrap(request: ComparisonBootstrapRequest): ComparisonBootstrapResult {
    const options = resolveBootstrapOptions(request.options);
    const challenger = groupComparisonAverages(request.challenger, null, "challenger");
    const baseline = groupComparisonAverages(request.baseline, null, "baseline");
    assertPairedStructure(challenger, baseline);

    const groupCount = challenger.groupKeys.length;

    const pointDeltas = drawDeltas(
        computeUnitMetrics(flattenGroups(challenger)),
        computeUnitMetrics(flattenGroups(baseline)),
        groupCount,
    );

    const values: Record<BootstrapFieldKey, number[]> = {
        recallDelta: [],
        hardNegativePrecisionDelta: [],
        aurocGoldVsAllDelta: [],
        aurocGoldVsHardDelta: [],
        brierDelta: [],
        utilityGainPerQuery: [],
    };
    const skipped = new Set<BootstrapFieldKey>();
    for (const field of BOOTSTRAP_FIELDS) {
        if (pointDeltas[field] === null) skipped.add(field);
    }

    const rand = mulberry32(options.seed);
    const maxAttempts = options.iterations * options.maxAttemptsFactor;
    let attempts = 0;
    const needsMore = (): boolean => BOOTSTRAP_FIELDS.some(
        (field) => !skipped.has(field) && values[field].length < options.iterations,
    );
    while (attempts < maxAttempts && needsMore()) {
        attempts += 1;
        const picks: number[] = [];
        for (let g = 0; g < groupCount; g += 1) {
            picks.push(Math.floor(rand() * groupCount));
        }
        const challengerUnits: ScoredUnit[] = [];
        const baselineUnits: ScoredUnit[] = [];
        for (const pick of picks) {
            challengerUnits.push(...challenger.groups.get(challenger.groupKeys[pick]!)!);
            baselineUnits.push(...baseline.groups.get(baseline.groupKeys[pick]!)!);
        }
        const deltas = drawDeltas(computeUnitMetrics(challengerUnits), computeUnitMetrics(baselineUnits), groupCount);
        for (const field of BOOTSTRAP_FIELDS) {
            if (skipped.has(field) || values[field].length >= options.iterations) continue;
            const delta = deltas[field];
            if (delta !== null) values[field].push(delta);
        }
    }

    const finalize = (field: BootstrapFieldKey): ComparisonBootstrapInterval | null => {
        if (skipped.has(field)) return null;
        const replicates = values[field];
        if (replicates.length < options.iterations) return null;
        const sorted = [...replicates].sort((a, b) => a - b);
        return {
            ciLow: percentileSorted(sorted, 0.025),
            ciHigh: percentileSorted(sorted, 0.975),
            iterations: options.iterations,
            attempts,
        };
    };
    return {
        recallDelta: finalize("recallDelta"),
        hardNegativePrecisionDelta: finalize("hardNegativePrecisionDelta"),
        aurocGoldVsAllDelta: finalize("aurocGoldVsAllDelta"),
        aurocGoldVsHardDelta: finalize("aurocGoldVsHardDelta"),
        brierDelta: finalize("brierDelta"),
        utilityGainPerQuery: finalize("utilityGainPerQuery"),
    };
}

/* ──────────────────────────────────────────────────────────────────
 * Gate evaluation + qualification (§4.4 decision rule order).
 * ──────────────────────────────────────────────────────────────── */

/** Recompute the frozen pass rule from a gate's governing input. */
function governingPass(
    gate: ComparisonGateId,
    value: number | null,
    ciLow: number | null,
    ciHigh: number | null,
    threshold: number,
): boolean | null {
    if (value === null) return null;
    switch (gate) {
        case "recall_ci":
        case "auroc_ni":
        case "hard_negative_precision_ni":
        case "utility_harm_stop":
            return ciLow === null ? null : ciLow >= threshold;
        case "brier_ni":
            return ciHigh === null ? null : ciHigh <= threshold;
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

function makeGateResult(
    gate: ComparisonGateId,
    value: number | null,
    ciLow: number | null,
    ciHigh: number | null,
    threshold: number,
): ComparisonGateResult {
    const result: ComparisonGateResult = {
        gate,
        value,
        ciLow,
        ciHigh,
        threshold,
        pass: governingPass(gate, value, ciLow, ciHigh, threshold),
    };
    if (!isComparisonGateResult(result)) {
        throw new Error(`evaluateComparisonQualification: internal invalid gate result for ${gate}`);
    }
    return result;
}

function intervalBounds(interval: ComparisonBootstrapInterval | null): { ciLow: number | null; ciHigh: number | null } {
    return interval === null ? { ciLow: null, ciHigh: null } : { ciLow: interval.ciLow, ciHigh: interval.ciHigh };
}

function collectBlockedReasons(
    summaryReasons: readonly ComparisonBlockedReason[],
    pointDeltas: Record<BootstrapFieldKey, number | null>,
    bootstrap: ComparisonBootstrapResult,
    challengerMetrics: ComparisonArmMetrics,
    baselineMetrics: ComparisonArmMetrics,
): ComparisonBlockedReason[] {
    const reasons = new Set<ComparisonBlockedReason>(summaryReasons);
    // §4.4 parent-frozen decision 2: only metrics GOVERNING a frozen gate
    // carry `missing_probability` when undefined — recall Δ (recall_ci),
    // gold-vs-all AUROC Δ (auroc_ni), Brier Δ (brier_ni), ECE
    // (ece_harm_stop). The gold-vs-hard AUROC is descriptive and never
    // gated (decision 1), so its undefinedity must not block the arm;
    // precision gets its own `undefined_precision` reason below.
    const governingMetricMissing = challengerMetrics.recall === null || baselineMetrics.recall === null
        || challengerMetrics.aurocGoldVsAll === null || baselineMetrics.aurocGoldVsAll === null
        || challengerMetrics.brier === null || baselineMetrics.brier === null
        || challengerMetrics.ece === null || baselineMetrics.ece === null;
    if (governingMetricMissing) reasons.add("missing_probability");
    if (pointDeltas.hardNegativePrecisionDelta === null) reasons.add("undefined_precision");
    for (const field of BOOTSTRAP_FIELDS) {
        if (pointDeltas[field] !== null && bootstrap[field] === null) reasons.add("degenerate_bootstrap");
    }
    return [...reasons];
}

interface GateEvaluationContext {
    pointDeltas: Record<BootstrapFieldKey, number | null>;
    bootstrap: ComparisonBootstrapResult;
    challengerMetrics: ComparisonArmMetrics;
    baselineMetrics: ComparisonArmMetrics;
    availability: number;
    unjudgedRate: number;
}

function buildGateResults(context: GateEvaluationContext): Record<ComparisonGateId, ComparisonGateResult> {
    const { pointDeltas, bootstrap, challengerMetrics, baselineMetrics, availability, unjudgedRate } = context;
    const recall = intervalBounds(bootstrap.recallDelta);
    const precision = intervalBounds(bootstrap.hardNegativePrecisionDelta);
    const auroc = intervalBounds(bootstrap.aurocGoldVsAllDelta);
    const brier = intervalBounds(bootstrap.brierDelta);
    const utility = intervalBounds(bootstrap.utilityGainPerQuery);
    return {
        recall_ci: makeGateResult(
            "recall_ci", pointDeltas.recallDelta, recall.ciLow, recall.ciHigh,
            COMPARISON_GATE_THRESHOLDS.recall_ci,
        ),
        net_fn: makeGateResult(
            "net_fn", challengerMetrics.fn - baselineMetrics.fn, null, null,
            COMPARISON_GATE_THRESHOLDS.net_fn,
        ),
        availability: makeGateResult(
            "availability", availability, null, null,
            COMPARISON_GATE_THRESHOLDS.availability,
        ),
        unjudged: makeGateResult(
            "unjudged", unjudgedRate, null, null,
            COMPARISON_GATE_THRESHOLDS.unjudged,
        ),
        auroc_ni: makeGateResult(
            "auroc_ni", pointDeltas.aurocGoldVsAllDelta, auroc.ciLow, auroc.ciHigh,
            COMPARISON_GATE_THRESHOLDS.auroc_ni,
        ),
        hard_negative_precision_ni: makeGateResult(
            "hard_negative_precision_ni", pointDeltas.hardNegativePrecisionDelta,
            precision.ciLow, precision.ciHigh,
            COMPARISON_GATE_THRESHOLDS.hard_negative_precision_ni,
        ),
        brier_ni: makeGateResult(
            "brier_ni", pointDeltas.brierDelta, brier.ciLow, brier.ciHigh,
            COMPARISON_GATE_THRESHOLDS.brier_ni,
        ),
        loss: makeGateResult(
            "loss", challengerMetrics.loss, null, null, baselineMetrics.loss,
        ),
        ece_harm_stop: makeGateResult(
            "ece_harm_stop", challengerMetrics.ece, null, null,
            COMPARISON_GATE_THRESHOLDS.ece_harm_stop,
        ),
        utility_harm_stop: makeGateResult(
            "utility_harm_stop", pointDeltas.utilityGainPerQuery, utility.ciLow, utility.ciHigh,
            COMPARISON_GATE_THRESHOLDS.utility_harm_stop,
        ),
    };
}

/**
 * Evaluate all ten frozen gates for one challenger and emit the
 * validated `ComparisonQualificationResult` (§4.4 decision rule
 * order, gates reported in `COMPARISON_GATE_IDS` order).
 *
 * - Operational gates read the challenger's `ComparisonArmRunSummary`
 *   (availability over ALL dispatched attempts; unjudged over the 314
 *   planned units).
 * - Completeness block reasons from the summary pass through; the
 *   evaluation derives `undefined_precision` (precision point
 *   estimate null — validator-mandated), `missing_probability` (a
 *   governing quality metric undefined because scored units are
 *   missing), and `degenerate_bootstrap` (a CI exhausted the
 *   attempt cap).
 * - `pass` is recomputed from the governing CI bound / value exactly
 *   as the frozen validator does; a null governing input yields
 *   `pass: null` and blocks the arm — never a coerced pass/fail.
 * - `qualified` is true only when the arm is unblocked and every
 *   gate passed.
 *
 * Fail-closed throws: unknown arms, non-incumbent baseline, invalid
 * or mismatched summary, empty/mismatched averages, or a run with
 * zero dispatched attempts (availability undefined).
 */
export function evaluateComparisonQualification(input: ComparisonQualificationInput): ComparisonQualificationResult {
    const { arm, baseline } = input;
    if (!isComparisonModelId(arm) || !isComparisonModelId(baseline)) {
        throw new Error("evaluateComparisonQualification: unknown arm");
    }
    if (baseline !== INCUMBENT_ARM) {
        throw new Error(`evaluateComparisonQualification: baseline must be the frozen incumbent ${INCUMBENT_ARM}`);
    }
    if (arm === baseline) throw new Error("evaluateComparisonQualification: arm must differ from baseline");
    if (!isComparisonArmRunSummary(input.challengerSummary)) {
        throw new Error("evaluateComparisonQualification: invalid challenger arm run summary");
    }
    const summary = input.challengerSummary;
    if (summary.arm !== arm) throw new Error("evaluateComparisonQualification: summary arm mismatch");
    if (summary.attemptedRequests <= 0) {
        throw new Error("evaluateComparisonQualification: cannot evaluate availability with zero dispatched attempts");
    }

    const challengerAverages = validateAndOrderAverages(input.challengerAverages, arm, "challenger");
    const baselineAverages = validateAndOrderAverages(input.baselineAverages, baseline, "baseline");
    const challengerMetrics = computeUnitMetrics(toScoredUnits(challengerAverages));
    const baselineMetrics = computeUnitMetrics(toScoredUnits(baselineAverages));

    const bootstrap = pairedComparisonBootstrap({
        challenger: challengerAverages,
        baseline: baselineAverages,
        options: input.bootstrap,
    });

    const groupCount = new Set(challengerAverages.map((record) => record.queryGroup)).size;
    const availability = summary.successfulResponses / summary.attemptedRequests;
    const unjudgedRate = summary.unitsUnjudged / summary.unitsPlanned;
    const pointDeltas = drawDeltas(challengerMetrics, baselineMetrics, groupCount);
    const blockedReasons = collectBlockedReasons(
        summary.blockedReasons, pointDeltas, bootstrap, challengerMetrics, baselineMetrics,
    );
    const gates = buildGateResults({
        pointDeltas, bootstrap, challengerMetrics, baselineMetrics, availability, unjudgedRate,
    });

    const gateResults = COMPARISON_GATE_IDS.map((id) => gates[id]);
    const blocked = blockedReasons.length > 0;
    const allPass = gateResults.every((gate) => gate.pass === true);
    const qualification: ComparisonQualificationResult = {
        arm,
        baseline,
        gates: gateResults,
        blocked,
        blockedReasons,
        qualified: allPass && !blocked,
    };
    if (!isComparisonQualificationResult(qualification)) {
        throw new Error("evaluateComparisonQualification: internal invalid qualification result");
    }
    return qualification;
}

/* ──────────────────────────────────────────────────────────────────
 * §4.4 final report gate — quality-gate value binding. The types
 * module's `isComparisonReportConsistent` binds coverage, identity,
 * cost, and per-gate self-consistency but stays metric-free by
 * design; the gate below extends it by deterministically recomputing
 * every reported gate value from the bound scored data (reviewer P1:
 * a report whose 314 scores are all 0.99 could claim passing
 * AUROC/precision/Brier/loss and ECE 0.13 while passing only
 * self-consistency).
 * ──────────────────────────────────────────────────────────────── */

/**
 * Input to {@link verifyComparisonReport}: the full
 * `isComparisonReportConsistent` report shape (the qualification
 * arm's records) plus the frozen incumbent arm's metric inputs. The
 * types report shape is single-arm, but every Δ gate and the
 * Jev-derived `loss` threshold are defined against the baseline arm,
 * so the baseline's scored outcomes and replica averages are
 * required here — extending this verifier's input rather than the
 * types module (no types-module change).
 */
export interface ComparisonReportVerificationInput {
    qualification: unknown;
    attempts: readonly unknown[];
    summaries: readonly unknown[];
    outcomes: readonly unknown[];
    unitAverages: readonly unknown[];
    plannedUnits: readonly unknown[];
    /** The incumbent arm's scored outcomes over the frozen planned corpus (`arm === INCUMBENT_ARM`). */
    baselineOutcomes: readonly unknown[];
    /** The incumbent arm's replica averages, each derived from `baselineOutcomes`. */
    baselineUnitAverages: readonly unknown[];
}

/** Packed planned-unit identity (unit ids repeat across query groups). */
function plannedReportUnitKey(queryGroup: string, unitId: string): string {
    return `${queryGroup}\u0000${unitId}`;
}

/**
 * Bind the incumbent arm's report-side metric inputs to the frozen
 * planned corpus (fail-closed, mirroring the types-module binder for
 * the qualification arm): every planned unit must carry exactly
 * `FROZEN_REPLICA_COUNT` distinct-replica outcomes with the planned
 * unit's fixture `file`/`truth`, and exactly one
 * `ComparisonUnitAverage` derived from those outcomes
 * (`isComparisonUnitAverageDerivedFrom`). Returns the averages, or
 * null on any gap, foreign-arm, unplanned, or tampered record.
 *
 * Baseline records are bound to the planned corpus (fixture identity)
 * and to each other, but not to attempt records: the types-module
 * attempt-ledger binder is single-arm (qualification arm only), and
 * extending it would be a types-module change.
 */
function bindBaselineReportArm(
    plannedUnits: readonly unknown[],
    outcomes: readonly unknown[],
    unitAverages: readonly unknown[],
): ComparisonUnitAverage[] | null {
    const planned = new Map<string, ComparisonPlannedUnit>();
    for (const raw of plannedUnits) {
        if (!isComparisonPlannedUnit(raw)) return null;
        const key = plannedReportUnitKey(raw.queryGroup, raw.unitId);
        if (planned.has(key)) return null;
        planned.set(key, raw);
    }
    if (planned.size !== FROZEN_CORPUS_UNITS) return null;

    const outcomesByUnit = new Map<string, ComparisonScoredOutcome[]>();
    for (const raw of outcomes) {
        if (!isComparisonScoredOutcome(raw) || raw.arm !== INCUMBENT_ARM) return null;
        const key = plannedReportUnitKey(raw.queryGroup, raw.unitId);
        const unit = planned.get(key);
        if (unit === undefined || raw.file !== unit.file || raw.truth !== unit.truth) return null;
        const bucket = outcomesByUnit.get(key);
        if (bucket === undefined) outcomesByUnit.set(key, [raw]);
        else bucket.push(raw);
    }

    const averages = new Map<string, ComparisonUnitAverage>();
    for (const raw of unitAverages) {
        if (!isComparisonUnitAverage(raw) || raw.arm !== INCUMBENT_ARM) return null;
        const key = plannedReportUnitKey(raw.queryGroup, raw.unitId);
        if (!planned.has(key) || averages.has(key)) return null;
        averages.set(key, raw);
    }

    for (const key of planned.keys()) {
        const unitOutcomes = outcomesByUnit.get(key);
        if (unitOutcomes === undefined || unitOutcomes.length !== FROZEN_REPLICA_COUNT) return null;
        const replicas = new Set<number>();
        for (const outcome of unitOutcomes) {
            if (replicas.has(outcome.replica)) return null;
            replicas.add(outcome.replica);
        }
        const average = averages.get(key);
        if (average === undefined || !isComparisonUnitAverageDerivedFrom(unitOutcomes, average)) return null;
    }
    return [...averages.values()];
}

/**
 * Exact equality between the reported and recomputed qualifications:
 * arm/baseline, every gate's `value`/`ciLow`/`ciHigh`/`threshold`/`pass`
 * (looked up by gate id, so array order cannot mask a mismatch),
 * `blocked`/`qualified`, and `blockedReasons` as an ordered array —
 * the reported qualification is produced by
 * `evaluateComparisonQualification`, so its reason order is part of
 * the exact output. Floats compare with `===`: both sides are the
 * IEEE values produced by the same deterministic code path over the
 * same inputs, so bitwise equality is expected and no tolerance is
 * used — a tolerance would re-open the tampering window this gate
 * closes. `null === null` holds for undecided gate inputs.
 */
function qualificationsExactlyMatch(
    reported: ComparisonQualificationResult,
    recomputed: ComparisonQualificationResult,
): boolean {
    if (reported.arm !== recomputed.arm || reported.baseline !== recomputed.baseline) return false;
    if (reported.blocked !== recomputed.blocked || reported.qualified !== recomputed.qualified) return false;
    if (reported.blockedReasons.length !== recomputed.blockedReasons.length) return false;
    for (let i = 0; i < recomputed.blockedReasons.length; i += 1) {
        if (reported.blockedReasons[i] !== recomputed.blockedReasons[i]) return false;
    }
    if (reported.gates.length !== recomputed.gates.length) return false;
    for (const expected of recomputed.gates) {
        const actual = reported.gates.find((entry) => entry.gate === expected.gate);
        if (actual === undefined) return false;
        if (actual.value !== expected.value
            || actual.ciLow !== expected.ciLow
            || actual.ciHigh !== expected.ciHigh
            || actual.threshold !== expected.threshold
            || actual.pass !== expected.pass) {
            return false;
        }
    }
    return true;
}

/**
 * Final report gate (§4.4 "End-to-end report binding"): a report is
 * valid only when `isComparisonReportConsistent` passes FIRST and
 * this verifier's deterministic recomputation of the reported
 * qualification matches it exactly. The types module stays
 * metric-free; this gate binds the quality-gate VALUES:
 *
 * 1. `isComparisonReportConsistent` must pass (coverage, fixture
 *    identity, attempt links, cost, availability/unjudged binding).
 * 2. The incumbent arm's metric inputs must bind to the frozen
 *    planned corpus (`bindBaselineReportArm`) — fixture `file`/`truth`
 *    per unit, five distinct-replica outcomes, one derived average.
 * 3. Every gate is recomputed from the bound challenger and baseline
 *    unit averages by `evaluateComparisonQualification` with the
 *    frozen bootstrap seed 20261008 / B = 10,000 and no override:
 *    point estimates, CI bounds, thresholds (including the
 *    Jev-derived `loss` threshold), `pass`, the harm-stop values
 *    (`ece_harm_stop`, `utility_harm_stop`), and
 *    `blocked`/`blockedReasons`/`qualified`.
 * 4. The recomputed qualification must equal the reported one
 *    exactly (`qualificationsExactlyMatch`) — no tolerance.
 *
 * Fail-closed: any binding or equality failure returns false. For
 * input that passes step 1 the recomputation path is total (both arms
 * are bound to the same frozen corpus, so the paired-bootstrap
 * structure checks always hold); an unexpected throw would be an
 * internal inconsistency and propagates loudly rather than being
 * swallowed.
 *
 * Stage G / Amendment A1 (deferred — documented, not implemented
 * here): `verifyComparisonReport` binds the challenger arm to attempt
 * records; incumbent/baseline attempt binding and all-arm
 * recomputation from wire records are required in the Stage G
 * confirmation verifier (Amendment A1) before any result is treated
 * as qualified. Under Amendment A1 the reference arm is Jev/M0
 * (packed requests), which the legacy one-unit-per-attempt DTOs
 * cannot represent, so that verifier must be rooted in the
 * method-aware wire records (`method-comparison-contract.ts`) for
 * ALL arms and recompute outcomes, averages, summaries,
 * qualifications, and selection from them.
 */
export function verifyComparisonReport(input: ComparisonReportVerificationInput): boolean {
    // Step 1: the consistency gate first — this verifier extends it, never replaces it.
    if (!isComparisonReportConsistent(input)) return false;

    const qualification = input.qualification;
    if (!isComparisonQualificationResult(qualification)) return false;
    const arm = qualification.arm;

    let summary: ComparisonArmRunSummary | null = null;
    for (const raw of input.summaries) {
        if (!isComparisonArmRunSummary(raw)) return false;
        if (raw.arm === arm) summary = raw;
    }
    if (summary === null) return false;

    const challengerAverages: ComparisonUnitAverage[] = [];
    for (const raw of input.unitAverages) {
        if (!isComparisonUnitAverage(raw) || raw.arm !== arm) return false;
        challengerAverages.push(raw);
    }
    if (challengerAverages.length === 0) return false;

    const baselineAverages = bindBaselineReportArm(
        input.plannedUnits,
        input.baselineOutcomes,
        input.baselineUnitAverages,
    );
    if (baselineAverages === null) return false;

    // Frozen seed/B (no bootstrap override): the recomputation must
    // reproduce the exact CI bounds the report claims.
    const recomputed = evaluateComparisonQualification({
        arm,
        baseline: qualification.baseline,
        challengerAverages,
        baselineAverages,
        challengerSummary: summary,
    });
    return qualificationsExactlyMatch(qualification, recomputed);
}

/* ──────────────────────────────────────────────────────────────────
 * Gate 4 selection (§4.4 tie-break rules).
 * ──────────────────────────────────────────────────────────────── */

/**
 * Cost per 1,000 judgments (§4.4 tie-break cost denominator):
 * campaign-attributed spend (known + unknown at retained reserve)
 * over the 1,570 planned judgments × 1,000. The caller must only
 * invoke this with settled spend — an unresolved unknown cost keeps
 * `costComplete: false`, which blocks ranking at selection time.
 */
export function costPerThousandJudgments(campaignSpendUsd: number): number {
    if (!Number.isFinite(campaignSpendUsd) || campaignSpendUsd < 0) {
        throw new Error("costPerThousandJudgments: campaignSpendUsd must be a finite non-negative number");
    }
    return (campaignSpendUsd / FROZEN_PLANNED_JUDGMENTS) * 1000;
}

function assertFiniteIn(value: number, min: number, max: number, label: string): void {
    if (!Number.isFinite(value) || value < min || value > max) {
        throw new Error(`${label} must be a finite number in [${min}, ${max}]`);
    }
}

/**
 * Selection ECE (§4.4 any-challenger harm stop + final tie-break),
 * DERIVED from the candidate's qualification — never a caller-supplied
 * field. The qualification must already have passed
 * `isComparisonQualificationResult` (which guarantees full gate
 * coverage, the frozen threshold, and `pass` consistency). `null`
 * means the gate's governing input was missing, which forces
 * `blocked ⇒ ¬qualified`, so such an arm can never be selected.
 */
function selectionCandidateEce(candidate: ComparisonSelectionCandidate): number | null {
    const eceGate = candidate.qualification.gates.find((entry) => entry.gate === "ece_harm_stop");
    if (eceGate === undefined) {
        throw new Error("selectComparisonArm: qualification missing the ece_harm_stop gate");
    }
    return eceGate.value;
}

/**
 * Fail-closed input validation for {@link selectComparisonArm}.
 * Structural roster errors — a missing, extra, or duplicate arm —
 * THROW rather than returning null: an incomplete roster could
 * bypass the any-challenger ECE harm stop by omitting a hot arm, so
 * "no qualified challenger" must be expressed by passing the full
 * frozen roster with unqualified qualifications.
 */
function validateSelectionCandidates(
    candidates: readonly ComparisonSelectionCandidate[],
    incumbentEce: number,
): void {
    assertFiniteIn(incumbentEce, 0, 1, "selectComparisonArm: incumbentEce");
    // §4.4 frozen challenger roster: exactly FROZEN_CHALLENGER_ARMS, each once.
    if (candidates.length !== FROZEN_CHALLENGER_ARMS.length) {
        throw new Error(
            `selectComparisonArm: roster must be exactly the frozen challenger roster [${FROZEN_CHALLENGER_ARMS.join(", ")}]; got ${candidates.length} candidate(s)`,
        );
    }
    const seen = new Set<ComparisonModelId>();
    for (const candidate of candidates) {
        if (!isComparisonQualificationResult(candidate.qualification)) {
            throw new Error("selectComparisonArm: invalid qualification");
        }
        const { arm, baseline } = candidate.qualification;
        if (baseline !== INCUMBENT_ARM) throw new Error("selectComparisonArm: baseline must be the frozen incumbent");
        if (arm === INCUMBENT_ARM) throw new Error("selectComparisonArm: the incumbent cannot be a candidate");
        if (seen.has(arm)) throw new Error(`selectComparisonArm: duplicate candidate arm ${arm}`);
        seen.add(arm);
        if (typeof candidate.costComplete !== "boolean") throw new Error("selectComparisonArm: costComplete must be a boolean");
        assertFiniteIn(candidate.costPer1000Usd, 0, Number.MAX_VALUE, "selectComparisonArm: costPer1000Usd");
        assertFiniteIn(candidate.p95LatencyMs, 0, Number.MAX_VALUE, "selectComparisonArm: p95LatencyMs");
        // The ECE used at selection is derived from the validated
        // qualification's gate value; only a present (non-null) value is
        // range-checked (null ⇒ blocked ⇒ ¬qualified, never selected).
        const ece = selectionCandidateEce(candidate);
        if (ece !== null) assertFiniteIn(ece, 0, 1, "selectComparisonArm: qualification ece_harm_stop value");
    }
    // Length + no-duplicates + every roster arm present ⇒ exact roster.
    // (Belt-and-braces: if a future campaign model outgrows the frozen
    // roster, selection fails closed here instead of silently narrowing.)
    for (const arm of FROZEN_CHALLENGER_ARMS) {
        if (!seen.has(arm)) {
            throw new Error(
                `selectComparisonArm: roster incomplete — frozen challenger ${arm} missing (an omitted challenger could bypass the any-challenger ECE harm stop)`,
            );
        }
    }
}

/**
 * Deterministic winner selection (§4.4 decision rule step 5 + frozen
 * tie-break rules). Returns the selected challenger arm, or null for
 * keep-Jev (no selection). The candidate list must be exactly the
 * frozen challenger roster (`FROZEN_CHALLENGER_ARMS` — both
 * challengers, each exactly once); a missing, duplicate, or unknown
 * arm is a structural roster error and THROWS, so an omitted
 * challenger can never bypass the any-challenger ECE harm stop.
 * Keep-Jev cases covered here:
 *
 * - no qualified challenger, or any qualification blocked
 *   (`blocked ⇒ ¬qualified` — a blocked arm is never selected);
 * - ECE harm stop for ANY arm — the incumbent's ECE > 0.30 or ANY
 *   challenger candidate's ECE > 0.30, qualified or not (§4.4
 *   parent-frozen decision 5: the harm stop is evaluated across all
 *   challenger candidates BEFORE filtering to qualified ones, so an
 *   unqualified hot arm vetoes selection of a qualified cool arm).
 *   Candidate ECEs are DERIVED from each qualification's validated
 *   `ece_harm_stop` gate value — never a caller-supplied field;
 *   the utility harm stop is the challenger's own gate and already
 *   blocks its qualification;
 * - any qualified contender with `costComplete: false` — an
 *   unresolved unknown cost means no ranking and no selection, even
 *   for a lone passer (reservation-fallback ranking is not
 *   authorized);
 * - ordered tie-break cost/1,000 → p95 → ECE, each step requiring
 *   STRICT improvement (exact float equality, no tolerance); any
 *   remaining exact tie keeps Jev.
 *
 * Promotion is never automatic: a returned arm is a recommendation
 * subject to owner confirmation (§4.2 Gate 4 / §4.4 step 5).
 */
export function selectComparisonArm(
    candidates: readonly ComparisonSelectionCandidate[],
    incumbentEce: number,
): ComparisonModelId | null {
    validateSelectionCandidates(candidates, incumbentEce);

    // §4.4 safety harm stops (parent-frozen decision 5): ECE > .30 for
    // ANY arm — the incumbent or ANY challenger candidate, qualified
    // or not — forces no selection, so these checks run across all
    // candidates BEFORE the qualification filter.
    if (incumbentEce > COMPARISON_GATE_THRESHOLDS.ece_harm_stop) return null;
    for (const candidate of candidates) {
        const ece = selectionCandidateEce(candidate);
        if (ece !== null && ece > COMPARISON_GATE_THRESHOLDS.ece_harm_stop) return null;
    }

    const qualified = candidates.filter(
        (candidate) => candidate.qualification.qualified && !candidate.qualification.blocked,
    );
    if (qualified.length === 0) return null;
    if (qualified.some((candidate) => !candidate.costComplete)) return null;
    if (qualified.length === 1) return qualified[0]!.qualification.arm;

    let pool = qualified;
    const tieBreakSteps: ReadonlyArray<(candidate: ComparisonSelectionCandidate) => number> = [
        (candidate) => candidate.costPer1000Usd,
        (candidate) => candidate.p95LatencyMs,
        (candidate) => {
            // Derived from the qualification's own validated ece_harm_stop
            // gate value, never a caller-supplied field.
            const ece = selectionCandidateEce(candidate);
            if (ece === null) {
                // Unreachable for a qualified arm: a null governing input
                // forces blocked ⇒ ¬qualified.
                throw new Error("selectComparisonArm: qualified candidate without an ece_harm_stop value");
            }
            return ece;
        },
    ];
    for (const step of tieBreakSteps) {
        let min = step(pool[0]!);
        for (const candidate of pool) {
            const value = step(candidate);
            if (value < min) min = value;
        }
        pool = pool.filter((candidate) => step(candidate) === min);
        if (pool.length === 1) return pool[0]!.qualification.arm;
    }
    // Exact tie on cost, p95, and ECE: keep Jev ("Exact ties keep Jev").
    return null;
}
