/**
 * Tests for the frozen §4.4 model-comparison statistics module
 * (`scripts/eval/judge/model-comparison-stats.ts`).
 *
 * Fixtures are hand-computed (arithmetic shown in comments) and every
 * qualification output is cross-checked against the fail-closed
 * validators in `model-comparison-types.ts`.
 *
 * Deterministic counter-cases where a NAIVE implementation would pass
 * a gate incorrectly (each marked "counter-case" inline):
 *  1. Threshold equality at p = 0.40 (naive `>` drops a TP → wrong recall/FN gates).
 *  2. AUROC tie credit (naive 0/1 credit inflates ΔAUROC → passes `auroc_ni`).
 *  3. ECE bin boundaries 0 / 0.1 / 1.0 (naive right-closed or floor(p*10) at p=1).
 *  4. Zero-selection precision (naive convention 1.0/0 → evaluates the gate instead of blocking).
 *  5. Null replica propagation (naive partial mean fabricates a score).
 *  6. Availability denominator includes retries/warmups (naive first-attempt-only passes ≥ .995).
 *  7. Unjudged denominator = 314 (naive /1570 passes ≤ 1%).
 *  8. Net-FN boundary: ≤ 1 passes at exactly 1 (naive `< 1` or `≤ 0` mis-gates).
 *  9. Loss FP over ALL negatives (naive hard-only FP passes `loss`).
 * 10. Utility gain denominator = query-group count (naive /314 passes the −.05 harm stop).
 * 11. Paired joint resampling (naive per-arm independent resampling widens/fabricates CIs).
 * 12. Degenerate draws redrawn, exhaustion blocks (naive NaN-skip fabricates a CI).
 * 13. costComplete:false blocks selection even for a lone passer (naive reservation fallback).
 * 14. Incumbent ECE > .30 harm stop blocks selection of an otherwise qualified arm.
 * 15. Blocked arm is never selected, even as the only candidate.
 * 16. Exact tie at every tie-break step keeps Jev (naive first-wins order).
 * 17. ECE > .30 on ANY challenger arm — qualified or not — forces no
 *     selection (§4.4 parent-frozen decision 5; naive filtering to the
 *     qualified candidates first misses the hot unqualified arm).
 * 18. Undefined descriptive gold-vs-hard AUROC (a non-governing metric)
 *     never blocks with missing_probability (§4.4 decisions 1 + 2;
 *     naive inclusion of every computed metric over-blocks the arm).
 * 19. The final report gate binds quality-gate VALUES: a report whose
 *     scores are all 0.99 yet claims passing AUROC/precision/Brier/
 *     loss and ECE 0.13 (and a mutated CI bound or loss threshold)
 *     passes `isComparisonReportConsistent` but is rejected by
 *     `verifyComparisonReport` (reviewer P1; naive per-gate
 *     self-consistency accepts the forgery).
 * 20. Selection requires the exact frozen challenger roster: a lone
 *     qualified challenger throws instead of selecting, so omitting a
 *     challenger can never bypass the any-challenger ECE harm stop
 *     (reviewer P1; naive partial-roster acceptance bypasses it).
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
    FROZEN_BOOTSTRAP_ITERATIONS,
    FROZEN_BOOTSTRAP_MAX_ATTEMPTS_FACTOR,
    FROZEN_BOOTSTRAP_SEED,
    FROZEN_CHALLENGER_ARMS,
    FROZEN_KEEP_THRESHOLD,
    FROZEN_PLANNED_JUDGMENTS,
    INCUMBENT_ARM,
    averageComparisonReplicas,
    computeComparisonArmMetrics,
    costPerThousandJudgments,
    evaluateComparisonQualification,
    pairedComparisonBootstrap,
    selectComparisonArm,
    verifyComparisonReport,
    type ComparisonBootstrapRequest,
    type ComparisonQualificationInput,
    type ComparisonReportVerificationInput,
    type ComparisonSelectionCandidate,
} from "../../../scripts/eval/judge/model-comparison-stats.js";
import {
    COMPARISON_GATE_IDS,
    COMPARISON_SERVED_MODEL_ALLOWLIST,
    FROZEN_CORPUS_UNITS,
    FROZEN_PLANNED_UNITS_DIGEST,
    FROZEN_REPLICA_COUNT,
    isComparisonArmRunSummary,
    isComparisonGateResult,
    isComparisonQualificationConsistentWith,
    isComparisonQualificationResult,
    isComparisonReportConsistent,
    isComparisonUnitAverage,
    isComparisonUnitAverageDerivedFrom,
    plannedUnitsDigest,
    truthClassFromFixtureLabel,
    type ComparisonArmRunSummary,
    type ComparisonAttemptRecord,
    type ComparisonGateId,
    type ComparisonGateResult,
    type ComparisonModelId,
    type ComparisonPlannedUnit,
    type ComparisonQualificationResult,
    type ComparisonScoredOutcome,
    type ComparisonTruthClass,
    type ComparisonUnitAverage,
} from "../../../scripts/eval/judge/model-comparison-types.js";
import { COMPARISON_MODELS } from "../../../scripts/eval/judge/model-comparison.js";
import {
    PLAN_DATA_DIR,
    loadSetRows,
    type PlanFixtureRow,
} from "../../../scripts/eval/judge/model-comparison-plan.js";

const CHAL: ComparisonModelId = "perplexity/pplx-decider-v1.1-27b";
const LUNA: ComparisonModelId = "openai/gpt-6-luna-decisions";

/* ── fixture helpers ────────────────────────────────────────────── */

function makeOutcome(
    arm: ComparisonModelId,
    queryGroup: string,
    unitId: string,
    replica: number,
    truth: ComparisonTruthClass,
    probability: number | null,
): ComparisonScoredOutcome {
    return {
        arm,
        queryGroup,
        unitId,
        file: `src/${unitId}.ts`,
        replica,
        truth,
        probability,
        attemptIds: [`att-${arm}-${queryGroup}-${unitId}-${replica}`],
    };
}

interface UnitSpec {
    truth: ComparisonTruthClass;
    probabilities: (number | null)[];
}

type GroupsSpec = Record<string, Record<string, UnitSpec>>;

function constant(probability: number): (number | null)[] {
    return [probability, probability, probability, probability, probability];
}

function buildAverages(arm: ComparisonModelId, groups: GroupsSpec): ComparisonUnitAverage[] {
    const outcomes: ComparisonScoredOutcome[] = [];
    for (const [queryGroup, units] of Object.entries(groups)) {
        for (const [unitId, spec] of Object.entries(units)) {
            spec.probabilities.forEach((probability, replica) => {
                outcomes.push(makeOutcome(arm, queryGroup, unitId, replica, spec.truth, probability));
            });
        }
    }
    return averageComparisonReplicas(outcomes);
}

/**
 * Passing corpus: 2 groups / 5 units. Challenger is near-perfect,
 * baseline sits just at/above the keep threshold (q2 gold = 0.40
 * exercises threshold equality on the baseline side).
 *
 * Challenger Brier = (0.05² + 0.10² + 0.02² + 0.01² ... over 5 units):
 *   (1−0.95)² + (1−0.90)² + 0.05² + 0.02² + 0.01²
 *   = 0.0025 + 0.01 + 0.0025 + 0.0004 + 0.0001 = 0.0155 → /5 = 0.0031
 * Baseline Brier = (1−0.45)² + (1−0.40)² + 0.05² + 0.02² + 0.01²
 *   = 0.3025 + 0.36 + 0.0025 + 0.0004 + 0.0001 = 0.6655 → /5 = 0.1331
 * ΔBrier point = 0.0031 − 0.1331 = −0.13 (non-inferior; every unit is
 * at least as calibrated as the baseline, so every draw's Δ ≤ 0).
 *
 * ECE challenger: bin9 {0.95, 0.90}: |0.925 − 1| × 2/5 = 0.075 × 0.4 = 0.03;
 * bin0 {0.05, 0.02, 0.01}: |0.0266̄ − 0| × 3/5 = 0.0266̄ × 0.6 = 0.016 → 0.046.
 * ECE baseline: bin4 {0.45, 0.40}: |0.425 − 1| × 2/5 = 0.575 × 0.4 = 0.23;
 * bin0 {0.05, 0.02, 0.01}: 0.016 → 0.246 (both < 0.30 harm stop).
 */
function passingGroups(variant: "chal" | "jev"): GroupsSpec {
    if (variant === "chal") {
        return {
            "a:q1": {
                u0: { truth: "gold", probabilities: constant(0.95) },
                u1: { truth: "hard-negative", probabilities: constant(0.05) },
            },
            "a:q2": {
                u0: { truth: "gold", probabilities: constant(0.9) },
                u1: { truth: "hard-negative", probabilities: constant(0.02) },
                u2: { truth: "other-negative", probabilities: constant(0.01) },
            },
        };
    }
    return {
        "a:q1": {
            u0: { truth: "gold", probabilities: constant(0.45) },
            u1: { truth: "hard-negative", probabilities: constant(0.05) },
        },
        "a:q2": {
            u0: { truth: "gold", probabilities: constant(0.4) },
            u1: { truth: "hard-negative", probabilities: constant(0.02) },
            u2: { truth: "other-negative", probabilities: constant(0.01) },
        },
    };
}

/**
 * 8-group corpus whose per-group recalls differ between the arms, so
 * bootstrap replicate values (and therefore percentile endpoints)
 * genuinely vary across draws and seeds.
 */
function variableGroups(variant: "chal" | "jev"): GroupsSpec {
    const groups: GroupsSpec = {};
    for (let i = 1; i <= 8; i += 1) {
        const goldProbability = variant === "chal"
            ? (i % 3 === 0 ? 0.3 : 0.9)
            : (i % 2 === 0 ? 0.45 : 0.2);
        groups[`a:q${i}`] = {
            u0: { truth: "gold", probabilities: constant(goldProbability) },
            u1: { truth: "hard-negative", probabilities: constant(0.02) },
            u2: { truth: "other-negative", probabilities: constant(0.01) },
        };
    }
    return groups;
}

/** Valid healthy run summary (passes `isComparisonArmRunSummary`). */
function healthySummary(arm: ComparisonModelId, overrides: Partial<ComparisonArmRunSummary> = {}): ComparisonArmRunSummary {
    return {
        arm,
        replicasPlanned: 5,
        replicasObserved: 5,
        unitsPlanned: 314,
        unitsWithValidAverage: 314,
        unitsUnjudged: 0,
        attemptedRequests: 1000,
        successfulResponses: 1000,
        warmupAttempts: 5,
        knownCostAttempts: 1000,
        unknownCostAttempts: 0,
        knownCostUsd: 0.5,
        unknownCostReserveUsd: 0,
        costComplete: true,
        runCompleted: true,
        blockedReasons: [],
        ...overrides,
    };
}

function qualificationInput(
    arm: ComparisonModelId,
    challengerAverages: readonly ComparisonUnitAverage[],
    baselineAverages: readonly ComparisonUnitAverage[],
    overrides: Partial<ComparisonQualificationInput> = {},
): ComparisonQualificationInput {
    return {
        arm,
        baseline: INCUMBENT_ARM,
        challengerAverages,
        baselineAverages,
        challengerSummary: healthySummary(arm),
        bootstrap: { iterations: 100 },
        ...overrides,
    };
}

function passingQualification(arm: ComparisonModelId, overrides: Partial<ComparisonQualificationInput> = {}): ComparisonQualificationResult {
    const variant = arm === CHAL ? "chal" : "jev";
    return evaluateComparisonQualification(qualificationInput(
        arm,
        buildAverages(arm, passingGroups(variant)),
        buildAverages(INCUMBENT_ARM, passingGroups("jev")),
        overrides,
    ));
}

function gate(qualification: ComparisonQualificationResult, id: (typeof COMPARISON_GATE_IDS)[number]) {
    const found = qualification.gates.find((entry) => entry.gate === id);
    if (found === undefined) throw new Error(`missing gate ${id}`);
    return found;
}

/**
 * Re-point a qualification's `ece_harm_stop` gate value, recomputing
 * `pass` and `qualified` exactly as the validators require, so
 * selection tests exercise the DERIVED selection ECE (there is no
 * free `ece` field on `ComparisonSelectionCandidate`).
 */
function withEceGate(qualification: ComparisonQualificationResult, value: number): ComparisonQualificationResult {
    const gates = qualification.gates.map((entry) =>
        entry.gate === "ece_harm_stop"
            ? { ...entry, value, pass: value <= entry.threshold }
            : entry,
    );
    const updated: ComparisonQualificationResult = {
        ...qualification,
        gates,
        qualified: gates.every((entry) => entry.pass === true) && !qualification.blocked,
    };
    if (!isComparisonQualificationResult(updated)) throw new Error("withEceGate: invalid qualification");
    return updated;
}

function candidate(
    qualification: ComparisonQualificationResult,
    overrides: Partial<ComparisonSelectionCandidate> = {},
): ComparisonSelectionCandidate {
    return {
        qualification,
        costComplete: true,
        costPer1000Usd: 1,
        p95LatencyMs: 300,
        ...overrides,
    };
}

/** Test-local mirror of the documented mulberry32 PRNG (ir-metrics.ts:317). */
function mulberry32Mirror(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** §4.2 pairwise AUROC reference (naive direct double sum). */
function referenceAuroc(positives: number[], negatives: number[]): number {
    let credit = 0;
    for (const p of positives) {
        for (const n of negatives) {
            if (p > n) credit += 1;
            else if (p === n) credit += 0.5;
        }
    }
    return credit / (positives.length * negatives.length);
}

/* ── fixture-gated end-to-end corpus (§4.4 report binding) ──────── */

/**
 * Fixture reads are gated: CI has no `~/.cache` eval fixture, and fixture
 * access here is strictly read-only. Tests reading either fixture file run
 * only when BOTH exist (`fixtureIt`); every other test stays unconditional.
 */
const FIXTURE_AVAILABLE = existsSync(join(PLAN_DATA_DIR, "set-a.jsonl"))
    && existsSync(join(PLAN_DATA_DIR, "set-b.jsonl"));

/** `it.runIf` over both fixture files; each gated test says so in its name. */
const fixtureIt = it.runIf(FIXTURE_AVAILABLE);

/**
 * The frozen corpus's planned units, rebuilt from the fixture through the
 * plan module's `loadSetRows` loader and `deriveFullRunPlan`'s grouping
 * (`set:qid` in file order; packed unit ids `u0…u{n-1}` per group — unit ids
 * repeat across groups, so group + id is identity).
 */
function fixturePlannedUnits(): ComparisonPlannedUnit[] {
    const rows = [
        ...loadSetRows("a", PLAN_DATA_DIR).rows,
        ...loadSetRows("b", PLAN_DATA_DIR).rows,
    ];
    const groups = new Map<string, PlanFixtureRow[]>();
    for (const row of rows) {
        const key = `${row.set}:${row.qid}`;
        const group = groups.get(key);
        if (group === undefined) groups.set(key, [row]);
        else group.push(row);
    }
    const units: ComparisonPlannedUnit[] = [];
    for (const [queryGroup, groupRows] of groups) {
        groupRows.forEach((row, index) => {
            units.push({
                queryGroup,
                unitId: `u${index}`,
                file: row.file,
                truth: truthClassFromFixtureLabel(row.label)!,
            });
        });
    }
    return units;
}

/** One arm's full synthetic report material: attempts, outcomes, averages, summary. */
interface E2eArmRun {
    attempts: ComparisonAttemptRecord[];
    outcomes: ComparisonScoredOutcome[];
    unitAverages: ComparisonUnitAverage[];
    summary: ComparisonArmRunSummary;
}

interface E2eAttemptIdentity {
    attemptId: string;
    queryGroup: string | null;
    unitId: string;
    replica: number;
    attemptIndex: number;
    warmup: boolean;
    payloadSha256: string;
}

/** `provider` verbatim when the response returned one (never inferred from the slug). */
function e2eProvider(arm: ComparisonModelId): string {
    return arm === INCUMBENT_ARM ? "TypeSafe" : "Perplexity";
}

/**
 * Payload hash per unit: retries and all five replicas of one
 * (query group, unit) must be byte-identical, while distinct units are
 * separate payload units under `detectComparisonAttemptDrift`.
 */
function e2ePayloadHash(queryGroup: string, unitId: string): string {
    return createHash("sha256").update(`${queryGroup}\u0000${unitId}`, "utf-8").digest("hex");
}

/** §4.4 estimand score: truth-class base + symmetric per-replica jitter (mean = base). */
function e2eReplicaProbability(truth: ComparisonTruthClass, replica: number): number {
    const base = truth === "gold" ? 0.9 : 0.05;
    return base + (replica - 2) * 0.01;
}

/** One wire attempt: a 200 success with a parseable envelope, or a transport failure. */
function e2eAttempt(
    arm: ComparisonModelId,
    identity: E2eAttemptIdentity,
    kind: "success" | "transport-failure",
    probability: number | null,
): ComparisonAttemptRecord {
    if (kind === "transport-failure") {
        return {
            ...identity,
            arm,
            servedModel: null,
            provider: null,
            requestBytes: 2048,
            httpStatus: null,
            probability: null,
            inputTokens: null,
            outputTokens: null,
            cost: { status: "known", usd: 0 },
            errorClass: "network",
        };
    }
    return {
        ...identity,
        arm,
        servedModel: COMPARISON_SERVED_MODEL_ALLOWLIST[arm],
        provider: e2eProvider(arm),
        requestBytes: 2048,
        httpStatus: 200,
        probability,
        inputTokens: 729,
        outputTokens: 70,
        cost: { status: "known", usd: 0.00003062 },
        errorClass: null,
    };
}

/**
 * Run summary derived from the concrete attempt list (counts/cost) and the
 * averages (unjudged); coverage is claimed at the frozen 314-unit campaign
 * scale required by `isComparisonArmRunSummary`.
 */
function e2eSummary(
    arm: ComparisonModelId,
    attempts: readonly ComparisonAttemptRecord[],
    unitAverages: readonly ComparisonUnitAverage[],
): ComparisonArmRunSummary {
    let warmupAttempts = 0;
    let successfulResponses = 0;
    let knownCostAttempts = 0;
    let unknownCostAttempts = 0;
    let knownCostUsd = 0;
    let unknownCostReserveUsd = 0;
    const observedReplicas = new Set<number>();
    for (const record of attempts) {
        observedReplicas.add(record.replica);
        if (record.warmup) warmupAttempts += 1;
        if (record.httpStatus !== null && record.httpStatus >= 200
            && record.httpStatus <= 299 && record.errorClass === null) {
            successfulResponses += 1;
        }
        if (record.cost.status === "known") {
            knownCostAttempts += 1;
            knownCostUsd += record.cost.usd;
        } else {
            unknownCostAttempts += 1;
            unknownCostReserveUsd += record.cost.reserveUsd;
        }
    }
    const unitsUnjudged = unitAverages.filter((average) => average.averageProbability === null).length;
    // The summary validator requires unitsPlanned = 314 and valid + unjudged
    // = planned: exact for the fixture run (314 units), while the
    // reduced-scale pipeline test claims frozen-campaign coverage — the
    // coverage ↔ records cross-check exists only in the fixture-gated full
    // report gate (`isComparisonReportConsistent`).
    return {
        arm,
        replicasPlanned: FROZEN_REPLICA_COUNT,
        replicasObserved: observedReplicas.size,
        unitsPlanned: FROZEN_CORPUS_UNITS,
        unitsWithValidAverage: FROZEN_CORPUS_UNITS - unitsUnjudged,
        unitsUnjudged,
        attemptedRequests: attempts.length,
        successfulResponses,
        warmupAttempts,
        knownCostAttempts,
        unknownCostAttempts,
        knownCostUsd,
        unknownCostReserveUsd,
        costComplete: unknownCostAttempts === 0,
        runCompleted: true,
        blockedReasons: [],
    };
}

/**
 * Build one arm's full synthetic report material over the planned corpus:
 * a warmup plus one attempt per unit/replica, outcomes linked by attempt id,
 * replica averages via `averageComparisonReplicas`, and a run summary derived
 * from those attempt records. `faults` injects capture realism:
 * `unjudgedUnitIndex` fails all five replicas of one unit (recorded unjudged,
 * never imputed), and `retryUnitIndex` adds a failed-then-succeeded retry on
 * that unit's replica 2.
 */
function buildE2eArmRun(
    arm: ComparisonModelId,
    plannedUnits: readonly ComparisonPlannedUnit[],
    faults: { unjudgedUnitIndex?: number; retryUnitIndex?: number } = {},
    scorer: (truth: ComparisonTruthClass, replica: number) => number = e2eReplicaProbability,
): E2eArmRun {
    const warmupHash = createHash("sha256").update(`${arm}#warmup`, "utf-8").digest("hex");
    const attempts: ComparisonAttemptRecord[] = [e2eAttempt(arm, {
        attemptId: `${arm}#warmup`,
        queryGroup: null,
        unitId: "u0",
        replica: 0,
        attemptIndex: 1,
        warmup: true,
        payloadSha256: warmupHash,
    }, "success", null)];
    const outcomes: ComparisonScoredOutcome[] = [];

    plannedUnits.forEach((unit, unitIndex) => {
        const payloadSha256 = e2ePayloadHash(unit.queryGroup, unit.unitId);
        for (let replica = 0; replica < FROZEN_REPLICA_COUNT; replica += 1) {
            const baseId = `${arm}#${unitIndex}-${replica}`;
            const identity = { queryGroup: unit.queryGroup, unitId: unit.unitId, replica, payloadSha256 };
            const scored = {
                arm,
                queryGroup: unit.queryGroup,
                unitId: unit.unitId,
                file: unit.file,
                replica,
                truth: unit.truth,
            };
            if (faults.unjudgedUnitIndex === unitIndex) {
                const attemptId = `${baseId}-x`;
                attempts.push(e2eAttempt(arm, { ...identity, attemptId, attemptIndex: 1, warmup: false }, "transport-failure", null));
                outcomes.push({ ...scored, probability: null, attemptIds: [attemptId] });
                continue;
            }
            const probability = scorer(unit.truth, replica);
            if (faults.retryUnitIndex === unitIndex && replica === 2) {
                const failedId = `${baseId}-f`;
                attempts.push(e2eAttempt(arm, { ...identity, attemptId: failedId, attemptIndex: 1, warmup: false }, "transport-failure", null));
                attempts.push(e2eAttempt(arm, { ...identity, attemptId: baseId, attemptIndex: 2, warmup: false }, "success", probability));
                outcomes.push({ ...scored, probability, attemptIds: [failedId, baseId] });
            } else {
                attempts.push(e2eAttempt(arm, { ...identity, attemptId: baseId, attemptIndex: 1, warmup: false }, "success", probability));
                outcomes.push({ ...scored, probability, attemptIds: [baseId] });
            }
        }
    });

    const unitAverages = averageComparisonReplicas(outcomes);
    return { attempts, outcomes, unitAverages, summary: e2eSummary(arm, attempts, unitAverages) };
}

/* ── tests ──────────────────────────────────────────────────────── */

describe("frozen constants", () => {
    it("freezes the §4.4 statistics constants", () => {
        expect(FROZEN_BOOTSTRAP_SEED).toBe(20261008);
        expect(FROZEN_BOOTSTRAP_ITERATIONS).toBe(10000);
        expect(FROZEN_BOOTSTRAP_MAX_ATTEMPTS_FACTOR).toBe(100);
        expect(FROZEN_KEEP_THRESHOLD).toBe(0.4);
        expect(FROZEN_PLANNED_JUDGMENTS).toBe(1570);
        expect(INCUMBENT_ARM).toBe("~typesafe/jev-latest");
    });
});

describe("replica averaging", () => {
    it("averages the five replicas in ascending order (hand arithmetic)", () => {
        // (0.88 + 0.89 + 0.90 + 0.91 + 0.92) = 4.50 → 4.50 / 5 = 0.90
        const averages = buildAverages(CHAL, {
            "a:q1": { u0: { truth: "gold", probabilities: [0.88, 0.89, 0.9, 0.91, 0.92] } },
        });
        expect(averages).toHaveLength(1);
        const record = averages[0]!;
        expect(record.replicasAveraged).toBe(5);
        expect(record.averageProbability).toBe(0.9);
        expect(isComparisonUnitAverage(record)).toBe(true);
    });

    it("null iff any replica is null or missing — never coerced to 0 or a partial mean", () => {
        const withNull = buildAverages(CHAL, {
            "a:q1": { u0: { truth: "gold", probabilities: [0.95, 0.95, null, 0.95, 0.95] } },
        })[0]!;
        expect(withNull.averageProbability).toBeNull();
        expect(withNull.replicasAveraged).toBe(4);
        expect(isComparisonUnitAverage(withNull)).toBe(true);

        const missingReplica = buildAverages(CHAL, {
            "a:q1": { u0: { truth: "gold", probabilities: [0.95, 0.95, 0.95] } },
        })[0]!;
        expect(missingReplica.averageProbability).toBeNull();
        expect(missingReplica.replicasAveraged).toBe(3);
    });

    it("rejects duplicate replicas, inconsistent identity, and out-of-range probabilities", () => {
        const duplicate = [
            makeOutcome(CHAL, "a:q1", "u0", 0, "gold", 0.9),
            makeOutcome(CHAL, "a:q1", "u0", 0, "gold", 0.8),
        ];
        expect(() => averageComparisonReplicas(duplicate)).toThrow(/duplicate replica/);

        const mixedTruth = [
            makeOutcome(CHAL, "a:q1", "u0", 0, "gold", 0.9),
            makeOutcome(CHAL, "a:q1", "u0", 1, "hard-negative", 0.1),
        ];
        expect(() => averageComparisonReplicas(mixedTruth)).toThrow(/inconsistent identity/);

        const invalid = [makeOutcome(CHAL, "a:q1", "u0", 0, "gold", 1.5)];
        expect(() => averageComparisonReplicas(invalid)).toThrow(/invalid scored outcome/);
    });

    it("counter-case: a naive mean-of-four record fails the frozen derived-record validator", () => {
        // 4 valid replicas of 0.9: naive partial mean = 0.9 (or sum/4). The frozen
        // record shape requires average ⇔ replicasAveraged === 5, so fabricating a
        // score from a partial mean is rejected, not propagated into gates.
        const rows = [0.9, 0.9, 0.9, 0.9].map((p, replica) => makeOutcome(CHAL, "a:q1", "u0", replica, "gold", p));
        const tampered: ComparisonUnitAverage = {
            arm: CHAL,
            queryGroup: "a:q1",
            unitId: "u0",
            file: "src/u0.ts",
            truth: "gold",
            replicasAveraged: 4,
            averageProbability: 0.9,
        };
        expect(isComparisonUnitAverage(tampered)).toBe(false);
        expect(isComparisonUnitAverageDerivedFrom(rows, tampered)).toBe(false);
    });
});

describe("per-arm metrics at frozen thresholds", () => {
    it("recall/precision/loss with threshold equality selecting (counter-case)", () => {
        const metrics = computeComparisonArmMetrics(buildAverages(CHAL, {
            "a:q1": {
                g1: { truth: "gold", probabilities: constant(0.4) },   // p == τ → selected
                g2: { truth: "gold", probabilities: constant(0.41) },  // selected
                g3: { truth: "gold", probabilities: constant(0.3999) },// NOT selected
                h1: { truth: "hard-negative", probabilities: constant(0.4) }, // selected (equality)
                h2: { truth: "hard-negative", probabilities: constant(0.1) },
                e1: { truth: "other-negative", probabilities: constant(0.05) },
            },
        }));
        // tp = 2 (0.40, 0.41), fn = 1 (0.3999) → recall = 2/3
        expect(metrics.tp).toBe(2);
        expect(metrics.fn).toBe(1);
        expect(metrics.recall).toBeCloseTo(2 / 3, 12);
        // hard subset: selected = tp 2 + selected hard 1 = 3 → precision = 2/3
        expect(metrics.hardNegativePrecision).toBeCloseTo(2 / 3, 12);
        // fp = 1 (h1 at 0.40; h2 and e1 below τ), tn = 2
        expect(metrics.fp).toBe(1);
        expect(metrics.tn).toBe(2);
        // loss = 6·FN + FP = 6·1 + 1 = 7
        expect(metrics.loss).toBe(7);
        expect(metrics.selectedCount).toBe(3);
        expect(metrics.goldCount).toBe(3);
        expect(metrics.negativeCount).toBe(3);
        // A naive `p > τ` implementation drops both equality TPs:
        // tp=1, fn=2 → recall 1/3 and loss 13 — wrong net-FN and loss gates.
    });

    it("zero selections ⇒ precision null, never 0 or 1 (counter-case)", () => {
        const metrics = computeComparisonArmMetrics(buildAverages(CHAL, {
            "a:q1": {
                g1: { truth: "gold", probabilities: constant(0.3) },
                h1: { truth: "hard-negative", probabilities: constant(0.1) },
            },
        }));
        expect(metrics.recall).toBe(0); // recall is defined (0 gold selected / 1 gold)
        expect(metrics.hardNegativePrecision).toBeNull(); // zero selections → undefined, not 0/1
        expect(metrics.loss).toBe(6); // 6·1 + 0
    });

    it("AUROC gives 0.5 tie credit and matches the §4.2 pairwise formula (counter-case)", () => {
        const metrics = computeComparisonArmMetrics(buildAverages(CHAL, {
            "a:q1": {
                g1: { truth: "gold", probabilities: constant(0.5) },
                g2: { truth: "gold", probabilities: constant(0.8) },
                h1: { truth: "hard-negative", probabilities: constant(0.5) },
                h2: { truth: "other-negative", probabilities: constant(0.3) },
            },
        }));
        // pairs: (0.5,0.5)=0.5, (0.5,0.3)=1, (0.8,0.5)=1, (0.8,0.3)=1 → 3.5/4 = 0.875
        expect(metrics.aurocGoldVsAll).toBeCloseTo(0.875, 12);
        expect(metrics.aurocGoldVsAll).toBe(referenceAuroc([0.5, 0.8], [0.5, 0.3]));
        // hard-only: golds vs {0.5}: (0.5,0.5)=0.5, (0.8,0.5)=1 → 1.5/2 = 0.75
        expect(metrics.aurocGoldVsHard).toBeCloseTo(0.75, 12);
        expect(metrics.aurocGoldVsHard).toBe(referenceAuroc([0.5, 0.8], [0.5]));
    });

    it("Brier is the mean squared error on replica-averaged scores (hand arithmetic)", () => {
        const metrics = computeComparisonArmMetrics(buildAverages(CHAL, passingGroups("chal")));
        // (0.05² + 0.10² + 0.02² + 0.01² + 0.0025 already listed above):
        // 0.0025 + 0.01 + 0.0025 + 0.0004 + 0.0001 = 0.0155 → /5 = 0.0031
        expect(metrics.brier).toBeCloseTo(0.0031, 12);
        const baseline = computeComparisonArmMetrics(buildAverages(INCUMBENT_ARM, passingGroups("jev")));
        // 0.3025 + 0.36 + 0.0025 + 0.0004 + 0.0001 = 0.6655 → /5 = 0.1331
        expect(baseline.brier).toBeCloseTo(0.1331, 12);
    });

    it("ECE uses the frozen 10-bin left-closed/right-open binning (counter-case)", () => {
        const metrics = computeComparisonArmMetrics(buildAverages(CHAL, {
            "a:q1": {
                g1: { truth: "gold", probabilities: constant(1.0) },      // final bin [.9,1.0] incl. 1.0
                e1: { truth: "other-negative", probabilities: constant(0.1) }, // bin1 [.1,.2) — NOT bin0
                e2: { truth: "other-negative", probabilities: constant(0.0) }, // bin0
            },
        }));
        // bin0 {0.0}: |0 − 0| = 0; bin1 {0.1}: |0.1 − 0| = 0.1; bin9 {1.0}: |1 − 1| = 0
        // ECE = (1/3)·0 + (1/3)·0.1 + (1/3)·0 = 0.1/3
        expect(metrics.ece).toBeCloseTo(0.1 / 3, 12);
        // A naive right-closed binning would group 0.1 with 0.0 (bin0 mean 0.05,
        // frac 0 → weight 2/3 · 0.05 = 0.0333 while bin9 gives 0.3333·0 = 0,
        // total 0.0333 — coincidentally close here but with a different bin
        // structure; floor(p*10) at p = 1.0 would index out of range entirely).
    });

    it("units without a valid average are excluded, never coerced (counter-case)", () => {
        const metrics = computeComparisonArmMetrics(buildAverages(CHAL, {
            "a:q1": {
                g1: { truth: "gold", probabilities: constant(0.9) },
                g2: { truth: "gold", probabilities: [0.9, 0.9, null, 0.9, 0.9] }, // unjudged unit
                h1: { truth: "hard-negative", probabilities: constant(0.1) },
            },
        }));
        // Only g1 and h1 are scored: goldCount = 1 (not 2), recall = 1/1 (the
        // unjudged gold is neither selected nor missed — it counts against the
        // unjudged/availability gates instead of being coerced to 0 or 1).
        expect(metrics.scoredUnits).toBe(2);
        expect(metrics.goldCount).toBe(1);
        expect(metrics.recall).toBe(1);
        expect(metrics.fn).toBe(0);
    });

    it("loss counts FP over ALL negatives, including other-negatives", () => {
        const metrics = computeComparisonArmMetrics(buildAverages(CHAL, {
            "a:q1": {
                g1: { truth: "gold", probabilities: constant(0.9) },
                h1: { truth: "hard-negative", probabilities: constant(0.45) },
                e1: { truth: "other-negative", probabilities: constant(0.42) },
            },
        }));
        // fp = 2 (hard 0.45 ≥ 0.40 AND easy 0.42 ≥ 0.40) → loss = 6·0 + 2 = 2
        expect(metrics.fp).toBe(2);
        expect(metrics.loss).toBe(2);
        // A naive hard-only FP counter would compute loss = 1.
    });
});

describe("paired cluster bootstrap", () => {
    const challenger = () => buildAverages(CHAL, variableGroups("chal"));
    const baseline = () => buildAverages(INCUMBENT_ARM, variableGroups("jev"));

    it("is deterministic: same seed ⇒ identical CIs; input order does not matter", () => {
        const request: ComparisonBootstrapRequest = { challenger: challenger(), baseline: baseline(), options: { iterations: 300 } };
        const first = pairedComparisonBootstrap(request);
        const second = pairedComparisonBootstrap({ ...request, challenger: challenger(), baseline: baseline() });
        expect(first).toEqual(second);

        const shuffled = pairedComparisonBootstrap({
            ...request,
            challenger: [...request.challenger].reverse(),
            baseline: [...request.baseline].reverse(),
        });
        expect(shuffled).toEqual(first);
        expect(first.recallDelta).not.toBeNull();
        expect(first.recallDelta!.attempts).toBeGreaterThanOrEqual(300);
    });

    it("different seed ⇒ different CIs", () => {
        const request: ComparisonBootstrapRequest = { challenger: challenger(), baseline: baseline(), options: { iterations: 300 } };
        const frozenSeed = pairedComparisonBootstrap(request);
        const otherSeed = pairedComparisonBootstrap({ ...request, options: { iterations: 300, seed: 424242 } });
        expect(JSON.stringify(otherSeed)).not.toBe(JSON.stringify(frozenSeed));
    });

    it("resamples whole query groups — first draw hand-derived from the documented PRNG (counter-case)", () => {
        // Two groups with different sizes: a:q1 = 3 units, a:q2 = 1 unit.
        // Challenger recalls are 1 on every draw; incumbent recalls:
        //   draws (q1,q1) → 1, (q1,q2)/(q2,q1) → 1/2, (q2,q2) → 0
        // so Δ ∈ {0, 0.5, 1} under WHOLE-GROUP resampling. Unit-level
        // resampling could produce values off this grid (e.g. 0.25).
        const splitChallenger = buildAverages(CHAL, {
            "a:q1": {
                u0: { truth: "gold", probabilities: constant(0.9) },
                u1: { truth: "hard-negative", probabilities: constant(0.1) },
                u2: { truth: "other-negative", probabilities: constant(0.05) },
            },
            "a:q2": { u0: { truth: "gold", probabilities: constant(0.9) } },
        });
        const splitBaseline = buildAverages(INCUMBENT_ARM, {
            "a:q1": {
                u0: { truth: "gold", probabilities: constant(0.9) },
                u1: { truth: "hard-negative", probabilities: constant(0.1) },
                u2: { truth: "other-negative", probabilities: constant(0.05) },
            },
            "a:q2": { u0: { truth: "gold", probabilities: constant(0.2) } },
        });
        const rand = mulberry32Mirror(FROZEN_BOOTSTRAP_SEED);
        const pick1 = Math.floor(rand() * 2); // first group index of draw 1
        const pick2 = Math.floor(rand() * 2); // second group index of draw 1
        const expectedFirstDraw = pick1 === 1 && pick2 === 1
            ? 1
            : pick1 + pick2 === 1
                ? 0.5
                : 0;
        const result = pairedComparisonBootstrap({
            challenger: splitChallenger,
            baseline: splitBaseline,
            options: { iterations: 1 },
        });
        // iterations = 1 → nearest-rank CI index ceil(0.025·1) − 1 = 0 = the first draw.
        expect(result.recallDelta).not.toBeNull();
        expect(result.recallDelta!.ciLow).toBe(expectedFirstDraw);
        expect(result.recallDelta!.ciHigh).toBe(expectedFirstDraw);
        expect([0, 0.5, 1]).toContain(result.recallDelta!.ciLow);
    });

    it("never splits units across groups: no degenerate draws on the passing corpus (counter-case)", () => {
        // Every query group contains a selected gold for both arms, so
        // whole-group resampling can never produce a gold-less draw:
        // attempts === iterations exactly. Naive unit-level resampling draws
        // 5 units from {2 gold, 3 neg} per draw → P(no gold) = (3/5)^5 ≈ 0.0778
        // → ≈23 redraws in 300 draws, i.e. attempts ≈ 323 ≠ 300.
        const result = pairedComparisonBootstrap({
            challenger: buildAverages(CHAL, passingGroups("chal")),
            baseline: buildAverages(INCUMBENT_ARM, passingGroups("jev")),
            options: { iterations: 300 },
        });
        expect(result.recallDelta!.attempts).toBe(300);
        expect(result.hardNegativePrecisionDelta!.attempts).toBe(300);
        expect(result.aurocGoldVsAllDelta!.attempts).toBe(300);
        expect(result.aurocGoldVsHardDelta!.attempts).toBe(300);
        expect(result.brierDelta!.attempts).toBe(300);
        expect(result.utilityGainPerQuery!.attempts).toBe(300);
    });

    it("applies the SAME draw to both arms: identical arms ⇒ CI exactly [0, 0] (counter-case)", () => {
        // Same probabilities on both arms: every joint draw cancels to Δ = 0,
        // so all CIs are exactly [0, 0]. Naive independent per-arm resampling
        // would fabricate a non-zero spread from the group-to-group variance.
        const shared = variableGroups("chal");
        const result = pairedComparisonBootstrap({
            challenger: buildAverages(CHAL, shared),
            baseline: buildAverages(INCUMBENT_ARM, shared),
            options: { iterations: 300 },
        });
        for (const interval of [
            result.recallDelta,
            result.hardNegativePrecisionDelta,
            result.aurocGoldVsAllDelta,
            result.aurocGoldVsHardDelta,
            result.brierDelta,
            result.utilityGainPerQuery,
        ]) {
            expect(interval).not.toBeNull();
            expect(interval!.ciLow).toBe(0);
            expect(interval!.ciHigh).toBe(0);
        }
    });

    it("redraws degenerate draws (counter-case: naive NaN-skip fabricates a CI)", () => {
        // a:q1 holds the only selections and the only hard negative; a:q2 has
        // an unselected gold. Draws of (q2,q2) — probability 1/4 — leave
        // precision and hard-negative AUROC undefined, so those draws are
        // redrawn: attempts must exceed iterations while CIs stay defined.
        const degenerateChallenger = buildAverages(CHAL, {
            "a:q1": { u0: { truth: "gold", probabilities: constant(0.9) }, u1: { truth: "hard-negative", probabilities: constant(0.1) } },
            "a:q2": { u0: { truth: "gold", probabilities: constant(0.3) }, u1: { truth: "other-negative", probabilities: constant(0.02) } },
        });
        const degenerateBaseline = buildAverages(INCUMBENT_ARM, {
            "a:q1": { u0: { truth: "gold", probabilities: constant(0.45) }, u1: { truth: "hard-negative", probabilities: constant(0.1) } },
            "a:q2": { u0: { truth: "gold", probabilities: constant(0.35) }, u1: { truth: "other-negative", probabilities: constant(0.02) } },
        });
        const result = pairedComparisonBootstrap({
            challenger: degenerateChallenger,
            baseline: degenerateBaseline,
            options: { iterations: 200 },
        });
        expect(result.hardNegativePrecisionDelta).not.toBeNull();
        expect(result.hardNegativePrecisionDelta!.attempts).toBeGreaterThan(200);
        expect(result.recallDelta!.attempts).toBeGreaterThan(200);
    });

    it("blocks a metric when degenerate redraws exhaust the attempt cap (per metric)", () => {
        const degenerateChallenger = buildAverages(CHAL, {
            "a:q1": { u0: { truth: "gold", probabilities: constant(0.9) }, u1: { truth: "hard-negative", probabilities: constant(0.1) } },
            "a:q2": { u0: { truth: "gold", probabilities: constant(0.3) }, u1: { truth: "other-negative", probabilities: constant(0.02) } },
        });
        const degenerateBaseline = buildAverages(INCUMBENT_ARM, {
            "a:q1": { u0: { truth: "gold", probabilities: constant(0.45) }, u1: { truth: "hard-negative", probabilities: constant(0.1) } },
            "a:q2": { u0: { truth: "gold", probabilities: constant(0.35) }, u1: { truth: "other-negative", probabilities: constant(0.02) } },
        });
        // maxAttemptsFactor = 1 → cap = B; any degenerate draw makes precision
        // fall short, while recall (never degenerate) still fills B replicates.
        const result = pairedComparisonBootstrap({
            challenger: degenerateChallenger,
            baseline: degenerateBaseline,
            options: { iterations: 50, maxAttemptsFactor: 1 },
        });
        expect(result.recallDelta).not.toBeNull();
        expect(result.hardNegativePrecisionDelta).toBeNull();
    });

    it("fails closed on structural mismatch between arms", () => {
        const complete = buildAverages(CHAL, passingGroups("chal"));
        const incomplete = buildAverages(INCUMBENT_ARM, {
            "a:q1": passingGroups("jev")["a:q1"]!,
        });
        expect(() => pairedComparisonBootstrap({ challenger: complete, baseline: incomplete }))
            .toThrow(/query groups differ/);
        expect(() => pairedComparisonBootstrap({ challenger: complete, baseline: complete }))
            .toThrow(/different arms/);
    });
});

describe("qualification gates", () => {
    it("qualifies a passing challenger and emits validator-passing gates in frozen order", () => {
        const qualification = passingQualification(CHAL);
        expect(isComparisonQualificationResult(qualification)).toBe(true);
        expect(qualification.blocked).toBe(false);
        expect(qualification.blockedReasons).toEqual([]);
        expect(qualification.qualified).toBe(true);
        expect(qualification.gates.map((entry) => entry.gate)).toEqual([...COMPARISON_GATE_IDS]);
        for (const entry of qualification.gates) {
            expect(isComparisonGateResult(entry)).toBe(true);
            expect(entry.pass).toBe(true);
        }
        // Thresholds come from the frozen table; loss threshold = baseline loss.
        expect(gate(qualification, "recall_ci").threshold).toBe(-0.02);
        expect(gate(qualification, "availability").threshold).toBe(0.995);
        expect(gate(qualification, "unjudged").threshold).toBe(0.01);
        expect(gate(qualification, "ece_harm_stop").threshold).toBe(0.3);
        expect(gate(qualification, "utility_harm_stop").threshold).toBe(-0.05);
        expect(gate(qualification, "loss").threshold).toBe(0); // baseline loss = 6·0 + 0
        expect(gate(qualification, "net_fn").value).toBe(0);
        // Hand arithmetic: ECE challenger = 0.03 + 0.016 = 0.046 (< 0.30 harm stop).
        expect(gate(qualification, "ece_harm_stop").value).toBeCloseTo(0.046, 12);
    });

    it("sets `qualified` exactly to (all gates pass && not blocked) — the contract's two-way rule", () => {
        // Direction 1: everything passes, nothing blocked ⇒ qualified true.
        const passing = passingQualification(CHAL);
        expect(passing.qualified).toBe(passing.gates.every((entry) => entry.pass === true) && !passing.blocked);
        expect(passing.qualified).toBe(true);

        // Direction 2a: every gate passes but a completeness block is present
        // ⇒ qualified must be false (blocked wins), never true.
        const blocked = evaluateComparisonQualification(qualificationInput(
            CHAL,
            buildAverages(CHAL, passingGroups("chal")),
            buildAverages(INCUMBENT_ARM, passingGroups("jev")),
            { challengerSummary: healthySummary(CHAL, { blockedReasons: ["missing_probability"] }) },
        ));
        expect(isComparisonQualificationResult(blocked)).toBe(true);
        expect(blocked.blocked).toBe(true);
        expect(blocked.gates.every((entry) => entry.pass === true)).toBe(true);
        expect(blocked.qualified).toBe(false);
        expect(blocked.qualified).toBe(blocked.gates.every((entry) => entry.pass === true) && !blocked.blocked);

        // Direction 2b: one gate fails, nothing blocked (e.g. a fired harm
        // stop lives among the gates, not in blockedReasons) ⇒ qualified false.
        const gateFailed = evaluateComparisonQualification(qualificationInput(
            CHAL,
            buildAverages(CHAL, passingGroups("chal")),
            buildAverages(INCUMBENT_ARM, passingGroups("jev")),
            { challengerSummary: healthySummary(CHAL, { unitsWithValidAverage: 310, unitsUnjudged: 4 }) },
        ));
        expect(isComparisonQualificationResult(gateFailed)).toBe(true);
        expect(gateFailed.blocked).toBe(false);
        expect(gateFailed.qualified).toBe(false);
        expect(gateFailed.qualified).toBe(gateFailed.gates.every((entry) => entry.pass === true) && !gateFailed.blocked);
    });

    it("uses the frozen seed/B/attempt-cap by default (§4.4 points 6–7)", () => {
        const challengerAverages = buildAverages(CHAL, passingGroups("chal"));
        const baselineAverages = buildAverages(INCUMBENT_ARM, passingGroups("jev"));
        const withoutOverrides = evaluateComparisonQualification(qualificationInput(
            CHAL, challengerAverages, baselineAverages, { bootstrap: undefined },
        ));
        const withFrozenExplicitly = evaluateComparisonQualification(qualificationInput(
            CHAL, challengerAverages, baselineAverages,
            {
                bootstrap: {
                    seed: FROZEN_BOOTSTRAP_SEED,
                    iterations: FROZEN_BOOTSTRAP_ITERATIONS,
                    maxAttemptsFactor: FROZEN_BOOTSTRAP_MAX_ATTEMPTS_FACTOR,
                },
            },
        ));
        expect(withoutOverrides).toEqual(withFrozenExplicitly);
        expect(withoutOverrides.qualified).toBe(true);
    });

    it("counter-case: zero-selection precision blocks with undefined_precision (naive 1.0 would pass)", () => {
        const zeroSelections = buildAverages(CHAL, {
            "a:q1": {
                u0: { truth: "gold", probabilities: constant(0.39) },
                u1: { truth: "hard-negative", probabilities: constant(0.1) },
            },
            "a:q2": {
                u0: { truth: "gold", probabilities: constant(0.38) },
                u1: { truth: "hard-negative", probabilities: constant(0.1) },
                u2: { truth: "other-negative", probabilities: constant(0.05) },
            },
        });
        const qualification = evaluateComparisonQualification(qualificationInput(
            CHAL, zeroSelections, buildAverages(INCUMBENT_ARM, passingGroups("jev")),
        ));
        expect(isComparisonQualificationResult(qualification)).toBe(true);
        const precisionGate = gate(qualification, "hard_negative_precision_ni");
        // Point estimate and CI are null, pass is null — never 0 or 1, never a
        // convention that could clear the −0.03 margin.
        expect(precisionGate.value).toBeNull();
        expect(precisionGate.ciLow).toBeNull();
        expect(precisionGate.ciHigh).toBeNull();
        expect(precisionGate.pass).toBeNull();
        expect(qualification.blocked).toBe(true);
        expect(qualification.blockedReasons).toEqual(["undefined_precision"]);
        expect(qualification.qualified).toBe(false);
    });

    it("null propagation: a completeness block blocks even when every gate passes", () => {
        const qualification = evaluateComparisonQualification(qualificationInput(
            CHAL,
            buildAverages(CHAL, passingGroups("chal")),
            buildAverages(INCUMBENT_ARM, passingGroups("jev")),
            { challengerSummary: healthySummary(CHAL, { blockedReasons: ["missing_probability"] }) },
        ));
        expect(isComparisonQualificationResult(qualification)).toBe(true);
        // Every gate passes…
        expect(qualification.gates.every((entry) => entry.pass === true)).toBe(true);
        // …but the arm is blocked and can never qualify: no coercion, no dropping.
        expect(qualification.blocked).toBe(true);
        expect(qualification.blockedReasons).toEqual(["missing_probability"]);
        expect(qualification.qualified).toBe(false);
    });

    it("null propagation: all-gold-unjudged derives missing_probability and null gates", () => {
        const allGoldUnjudged = buildAverages(CHAL, {
            "a:q1": {
                u0: { truth: "gold", probabilities: [null, null, null, null, null] },
                u1: { truth: "hard-negative", probabilities: constant(0.1) },
            },
        });
        const baseline = buildAverages(INCUMBENT_ARM, {
            "a:q1": {
                u0: { truth: "gold", probabilities: constant(0.9) },
                u1: { truth: "hard-negative", probabilities: constant(0.1) },
            },
        });
        const qualification = evaluateComparisonQualification(qualificationInput(CHAL, allGoldUnjudged, baseline));
        expect(isComparisonQualificationResult(qualification)).toBe(true);
        expect(qualification.blocked).toBe(true);
        expect(qualification.blockedReasons).toContain("missing_probability");
        expect(gate(qualification, "recall_ci").value).toBeNull();
        expect(gate(qualification, "recall_ci").pass).toBeNull();
        expect(gate(qualification, "auroc_ni").pass).toBeNull();
        expect(qualification.qualified).toBe(false);
    });

    it("counter-case: availability divides by ALL dispatched attempts (naive first-attempt-only passes)", () => {
        const challengerAverages = buildAverages(CHAL, passingGroups("chal"));
        const baselineAverages = buildAverages(INCUMBENT_ARM, passingGroups("jev"));
        // 995 successes over 1,001 dispatched attempts (retries/warmups included):
        // 995/1001 = 0.994006 < 0.995 → gate FAILS. A naive denominator that
        // counts only eventual logical successes (995/995 = 1.0) would pass.
        const failing = evaluateComparisonQualification(qualificationInput(CHAL, challengerAverages, baselineAverages, {
            challengerSummary: healthySummary(CHAL, {
                attemptedRequests: 1001,
                successfulResponses: 995,
                knownCostAttempts: 1001,
            }),
        }));
        expect(gate(failing, "availability").value).toBeCloseTo(995 / 1001, 12);
        expect(gate(failing, "availability").pass).toBe(false);
        expect(failing.qualified).toBe(false);
        // Boundary: 995/1000 = 0.995 exactly → passes (≥ convention).
        const boundary = evaluateComparisonQualification(qualificationInput(CHAL, challengerAverages, baselineAverages, {
            challengerSummary: healthySummary(CHAL, { successfulResponses: 995 }),
        }));
        expect(gate(boundary, "availability").value).toBe(0.995);
        expect(gate(boundary, "availability").pass).toBe(true);
    });

    it("counter-case: unjudged divides by 314 planned units (naive /1570 passes)", () => {
        const qualification = evaluateComparisonQualification(qualificationInput(
            CHAL,
            buildAverages(CHAL, passingGroups("chal")),
            buildAverages(INCUMBENT_ARM, passingGroups("jev")),
            {
                challengerSummary: healthySummary(CHAL, {
                    unitsWithValidAverage: 310,
                    unitsUnjudged: 4, // 4/314 = 0.012739 > 0.01 → fails; 4/1570 = 0.002547 would pass
                }),
            },
        ));
        expect(gate(qualification, "unjudged").value).toBeCloseTo(4 / 314, 12);
        expect(gate(qualification, "unjudged").pass).toBe(false);
        expect(qualification.qualified).toBe(false);
    });

    it("frozen decision 3: degenerate bootstrap exhaustion blocks with degenerate_bootstrap", () => {
        // Same degenerate corpora as the paired-bootstrap test above: the
        // precision interval is undefined on gold-less draws, so a tight
        // attempt cap (50 × factor 1) exhausts exactly the precision
        // interval while its point estimate stays defined ⇒ the arm is
        // blocked with `degenerate_bootstrap`, never a fabricated CI.
        const degenerateChallenger = buildAverages(CHAL, {
            "a:q1": {
                u0: { truth: "gold", probabilities: constant(0.9) },
                u1: { truth: "hard-negative", probabilities: constant(0.1) },
            },
            "a:q2": {
                u0: { truth: "gold", probabilities: constant(0.3) },
                u1: { truth: "other-negative", probabilities: constant(0.02) },
            },
        });
        const degenerateBaseline = buildAverages(INCUMBENT_ARM, {
            "a:q1": {
                u0: { truth: "gold", probabilities: constant(0.45) },
                u1: { truth: "hard-negative", probabilities: constant(0.1) },
            },
            "a:q2": {
                u0: { truth: "gold", probabilities: constant(0.35) },
                u1: { truth: "other-negative", probabilities: constant(0.02) },
            },
        });
        const qualification = evaluateComparisonQualification(qualificationInput(
            CHAL, degenerateChallenger, degenerateBaseline,
            { bootstrap: { iterations: 50, maxAttemptsFactor: 1 } },
        ));
        expect(isComparisonQualificationResult(qualification)).toBe(true);
        const precisionGate = gate(qualification, "hard_negative_precision_ni");
        expect(precisionGate.value).not.toBeNull(); // point estimate defined …
        expect(precisionGate.ciLow).toBeNull();     // … but the interval exhausted
        expect(precisionGate.pass).toBeNull();
        expect(qualification.blockedReasons).toEqual(["degenerate_bootstrap"]);
        expect(qualification.blocked).toBe(true);
        expect(qualification.qualified).toBe(false);
    });

    it("counter-case: net FN ≤ 1 passes at exactly 1 and fails at 2", () => {
        const baseline = buildAverages(INCUMBENT_ARM, {
            "a:q1": {
                g1: { truth: "gold", probabilities: constant(0.9) },
                g2: { truth: "gold", probabilities: constant(0.9) },
                g3: { truth: "gold", probabilities: constant(0.9) },
                h1: { truth: "hard-negative", probabilities: constant(0.1) },
            },
        });
        // Challenger misses exactly one gold: fn = 1, baseline fn = 0 → net 1 → pass.
        const netOne = evaluateComparisonQualification(qualificationInput(CHAL, buildAverages(CHAL, {
            "a:q1": {
                g1: { truth: "gold", probabilities: constant(0.9) },
                g2: { truth: "gold", probabilities: constant(0.9) },
                g3: { truth: "gold", probabilities: constant(0.3) },
                h1: { truth: "hard-negative", probabilities: constant(0.1) },
            },
        }), baseline));
        expect(gate(netOne, "net_fn").value).toBe(1);
        expect(gate(netOne, "net_fn").pass).toBe(true);
        // Challenger misses two golds: fn = 2 → net 2 → fail.
        const netTwo = evaluateComparisonQualification(qualificationInput(CHAL, buildAverages(CHAL, {
            "a:q1": {
                g1: { truth: "gold", probabilities: constant(0.9) },
                g2: { truth: "gold", probabilities: constant(0.3) },
                g3: { truth: "gold", probabilities: constant(0.3) },
                h1: { truth: "hard-negative", probabilities: constant(0.1) },
            },
        }), baseline));
        expect(gate(netTwo, "net_fn").value).toBe(2);
        expect(gate(netTwo, "net_fn").pass).toBe(false);
        expect(isComparisonQualificationResult(netTwo)).toBe(true);
    });

    it("counter-case: loss counts easy-negative FPs (naive hard-only passes) and passes on equality", () => {
        const baseline = buildAverages(INCUMBENT_ARM, {
            "a:q1": {
                g1: { truth: "gold", probabilities: constant(0.9) },
                h1: { truth: "hard-negative", probabilities: constant(0.5) },
                e1: { truth: "other-negative", probabilities: constant(0.05) },
            },
        });
        // Challenger: hard 0.50 selected AND easy 0.42 selected → fp = 2 →
        // loss = 2 > baseline loss = 1 → gate fails. Naive hard-only FP gives
        // loss 1 ≤ 1 → would pass.
        const overLoss = evaluateComparisonQualification(qualificationInput(CHAL, buildAverages(CHAL, {
            "a:q1": {
                g1: { truth: "gold", probabilities: constant(0.9) },
                h1: { truth: "hard-negative", probabilities: constant(0.5) },
                e1: { truth: "other-negative", probabilities: constant(0.42) },
            },
        }), baseline));
        expect(gate(overLoss, "loss").value).toBe(2);
        expect(gate(overLoss, "loss").threshold).toBe(1);
        expect(gate(overLoss, "loss").pass).toBe(false);
        // Equal loss (fp = 1 both arms) → pass (≤ convention).
        const equalLoss = evaluateComparisonQualification(qualificationInput(CHAL, buildAverages(CHAL, {
            "a:q1": {
                g1: { truth: "gold", probabilities: constant(0.9) },
                h1: { truth: "hard-negative", probabilities: constant(0.5) },
                e1: { truth: "other-negative", probabilities: constant(0.05) },
            },
        }), baseline));
        expect(gate(equalLoss, "loss").value).toBe(1);
        expect(gate(equalLoss, "loss").pass).toBe(true);
    });

    it("counter-case: auroc_ni uses tie-credited gold-vs-all AUROC (naive credit-1 would pass)", () => {
        const tieChallenger = buildAverages(CHAL, {
            "a:q1": {
                g1: { truth: "gold", probabilities: constant(0.5) },
                h1: { truth: "hard-negative", probabilities: constant(0.5) },
                e1: { truth: "other-negative", probabilities: constant(0.3) },
            },
        });
        const perfectBaseline = buildAverages(INCUMBENT_ARM, {
            "a:q1": {
                g1: { truth: "gold", probabilities: constant(0.9) },
                h1: { truth: "hard-negative", probabilities: constant(0.1) },
                e1: { truth: "other-negative", probabilities: constant(0.1) },
            },
        });
        const metrics = computeComparisonArmMetrics(tieChallenger);
        // 1 pos × 2 negs: (0.5,0.5)=0.5 + (0.5,0.3)=1 → 1.5/2 = 0.75;
        // baseline = 1.0 → Δ = −0.25 < −0.02 → gate FAILS.
        // A naive tie policy crediting 1.0 gives Δ = 0 → gate would pass.
        expect(metrics.aurocGoldVsAll).toBeCloseTo(0.75, 12);
        const qualification = evaluateComparisonQualification(qualificationInput(CHAL, tieChallenger, perfectBaseline));
        const aurocGate = gate(qualification, "auroc_ni");
        expect(aurocGate.value).toBeCloseTo(-0.25, 12);
        expect(aurocGate.ciLow).toBeCloseTo(-0.25, 12);
        expect(aurocGate.pass).toBe(false);
        expect(isComparisonQualificationResult(qualification)).toBe(true);
    });

    it("decisions 1+2 exactness: an undefined descriptive gold-vs-hard AUROC never gates or blocks", () => {
        // Metric inputs with gold + other-negative units but no scored hard
        // negative: aurocGoldVsHard is null on both arms, yet it feeds no
        // frozen gate (decision 1: descriptive only, never gated) and is not
        // a governing metric (decision 2 blocks only undefined GOVERNING
        // metrics with missing_probability). A naive implementation that
        // lumps every computed metric into governingMetricMissing blocks the
        // arm here.
        const noHard = (variant: "chal" | "jev"): GroupsSpec => ({
            "a:q1": {
                g1: { truth: "gold", probabilities: constant(variant === "chal" ? 0.9 : 0.45) },
                e1: { truth: "other-negative", probabilities: constant(0.05) },
            },
            "a:q2": {
                g1: { truth: "gold", probabilities: constant(variant === "chal" ? 0.9 : 0.4) },
                e1: { truth: "other-negative", probabilities: constant(0.02) },
            },
        });
        const challengerAverages = buildAverages(CHAL, noHard("chal"));
        const baselineAverages = buildAverages(INCUMBENT_ARM, noHard("jev"));
        expect(computeComparisonArmMetrics(challengerAverages).aurocGoldVsHard).toBeNull();
        // Descriptive CI stays null alongside its point estimate — and a null
        // point is skipped by the degeneracy scan, so no degenerate block either.
        expect(pairedComparisonBootstrap({ challenger: challengerAverages, baseline: baselineAverages })
            .aurocGoldVsHardDelta).toBeNull();
        const qualification = evaluateComparisonQualification(
            qualificationInput(CHAL, challengerAverages, baselineAverages),
        );
        expect(isComparisonQualificationResult(qualification)).toBe(true);
        expect(qualification.blocked).toBe(false);
        expect(qualification.blockedReasons).toEqual([]);
        // The gated gold-vs-ALL AUROC is defined and passes.
        expect(gate(qualification, "auroc_ni").pass).toBe(true);
        expect(qualification.qualified).toBe(true);
    });

    it("counter-case: utility gain divides by query groups, not corpus units (naive /314 passes)", () => {
        // 4 query groups; challenger misses exactly one gold → loss = 6·1 = 0 FP.
        // Gain = (0 − 6)/4 = −1.5/query → CI lower < −0.05 → harm stop FAILS.
        // A naive per-corpus denominator computes −6/314 = −0.0191 ≥ −0.05 → pass.
        const groups = (goldProbability: number): GroupsSpec => {
            const spec: GroupsSpec = {};
            for (let i = 1; i <= 4; i += 1) {
                spec[`a:q${i}`] = {
                    g1: { truth: "gold", probabilities: constant(i === 1 ? goldProbability : 0.9) },
                    h1: { truth: "hard-negative", probabilities: constant(0.1) },
                };
            }
            return spec;
        };
        const qualification = evaluateComparisonQualification(qualificationInput(
            CHAL, buildAverages(CHAL, groups(0.3)), buildAverages(INCUMBENT_ARM, groups(0.9)),
        ));
        const utilityGate = gate(qualification, "utility_harm_stop");
        expect(utilityGate.value).toBeCloseTo(-1.5, 12);
        expect(utilityGate.ciLow).toBeLessThan(-0.05);
        expect(utilityGate.pass).toBe(false);
        expect(isComparisonQualificationResult(qualification)).toBe(true);
    });

    it("ECE harm stop: an arm with ECE > 0.30 fails even when everything else is fine", () => {
        // 3 golds at 0.41 (bin4, |0.41 − 1| = 0.59) + 1 hard at 0.05 (bin0, |0.05 − 0| = 0.05):
        // ECE = (3/4)·0.59 + (1/4)·0.05 = 0.4425 + 0.0125 = 0.455 > 0.30.
        const hotArm = buildAverages(CHAL, {
            "a:q1": {
                g1: { truth: "gold", probabilities: constant(0.41) },
                g2: { truth: "gold", probabilities: constant(0.41) },
                g3: { truth: "gold", probabilities: constant(0.41) },
                h1: { truth: "hard-negative", probabilities: constant(0.05) },
            },
        });
        const coolBaseline = buildAverages(INCUMBENT_ARM, {
            "a:q1": {
                g1: { truth: "gold", probabilities: constant(0.9) },
                g2: { truth: "gold", probabilities: constant(0.9) },
                g3: { truth: "gold", probabilities: constant(0.9) },
                h1: { truth: "hard-negative", probabilities: constant(0.05) },
            },
        });
        const qualification = evaluateComparisonQualification(qualificationInput(CHAL, hotArm, coolBaseline));
        const eceGate = gate(qualification, "ece_harm_stop");
        expect(eceGate.value).toBeCloseTo(0.455, 12);
        expect(eceGate.threshold).toBe(0.3);
        expect(eceGate.pass).toBe(false);
        expect(qualification.blocked).toBe(false); // not a block — a failed gate
        expect(qualification.qualified).toBe(false);
    });

    it("fails closed on invalid operational inputs", () => {
        const challengerAverages = buildAverages(CHAL, passingGroups("chal"));
        const baselineAverages = buildAverages(INCUMBENT_ARM, passingGroups("jev"));
        // Non-incumbent baseline is rejected.
        expect(() => evaluateComparisonQualification({
            ...qualificationInput(CHAL, challengerAverages, baselineAverages),
            baseline: LUNA,
        })).toThrow(/frozen incumbent/);
        // Summary for a different arm is rejected.
        expect(() => evaluateComparisonQualification(qualificationInput(
            CHAL, challengerAverages, baselineAverages,
            { challengerSummary: healthySummary(LUNA) },
        ))).toThrow(/summary arm mismatch/);
        // Zero dispatched attempts cannot define availability.
        expect(() => evaluateComparisonQualification(qualificationInput(
            CHAL, challengerAverages, baselineAverages,
            {
                challengerSummary: healthySummary(CHAL, {
                    attemptedRequests: 0,
                    successfulResponses: 0,
                    knownCostAttempts: 0,
                    warmupAttempts: 0,
                }),
            },
        ))).toThrow(/zero dispatched attempts/);
        // Empty average inputs are rejected.
        expect(() => evaluateComparisonQualification(qualificationInput(CHAL, [], baselineAverages)))
            .toThrow(/no unit averages/);
    });
});

describe("selection (Gate 4)", () => {
    /** A validator-valid but UNQUALIFIED qualification (availability 995/1001 < .995). */
    function unqualifiedQualification(arm: ComparisonModelId): ComparisonQualificationResult {
        return evaluateComparisonQualification(qualificationInput(
            arm,
            buildAverages(arm, arm === CHAL ? passingGroups("chal") : passingGroups("jev")),
            buildAverages(INCUMBENT_ARM, passingGroups("jev")),
            { challengerSummary: healthySummary(arm, { attemptedRequests: 1001, successfulResponses: 995, knownCostAttempts: 1001 }) },
        ));
    }

    it("requires the exact frozen challenger roster — structural roster errors throw (reviewer P1)", () => {
        // The roster is pinned to the two frozen challenger slugs and to
        // COMPARISON_MODELS minus the incumbent.
        expect([...FROZEN_CHALLENGER_ARMS]).toEqual(["perplexity/pplx-decider-v1.1-27b", "openai/gpt-6-luna-decisions"]);
        expect([...FROZEN_CHALLENGER_ARMS]).toEqual(COMPARISON_MODELS.filter((model) => model !== INCUMBENT_ARM));
        const chal = candidate(withEceGate(passingQualification(CHAL), 0.05));
        const luna = candidate(withEceGate(passingQualification(LUNA), 0.05));
        // The complete roster is accepted (identical metrics — ECE gate
        // values equalised — tie → keep Jev).
        expect(selectComparisonArm([chal, luna], 0.1)).toBeNull();
        // Incomplete, empty, and duplicate rosters fail closed with a throw:
        // an omitted challenger could otherwise bypass the any-challenger
        // ECE harm stop by simply being left off the candidate list.
        expect(() => selectComparisonArm([], 0.1)).toThrow(/frozen challenger roster/);
        expect(() => selectComparisonArm([chal], 0.1)).toThrow(/frozen challenger roster/);
        expect(() => selectComparisonArm([luna], 0.1)).toThrow(/frozen challenger roster/);
        expect(() => selectComparisonArm([chal, chal], 0.1)).toThrow(/duplicate candidate arm/);
        // Unknown arms are rejected (the qualification guard fails closed).
        const unknownArm = {
            ...chal,
            qualification: { ...chal.qualification, arm: "unknown/model" as unknown as ComparisonModelId },
        } as ComparisonSelectionCandidate;
        expect(() => selectComparisonArm([unknownArm, luna], 0.1)).toThrow(/invalid qualification/);
        // "No qualified challenger" is expressed with the full roster of
        // unqualified qualifications — never by omitting an arm.
        const unqualified = candidate(unqualifiedQualification(LUNA));
        expect(selectComparisonArm([unqualified, candidate(unqualifiedQualification(CHAL))], 0.1)).toBeNull();
    });

    it("selects the single qualified challenger from the exact frozen roster (recommendation, never automatic)", () => {
        const qualification = passingQualification(CHAL);
        expect(qualification.qualified).toBe(true);
        const lunaUnqualified = candidate(unqualifiedQualification(LUNA));
        expect(selectComparisonArm([candidate(qualification), lunaUnqualified], 0.1)).toBe(CHAL);
        expect(selectComparisonArm([lunaUnqualified, candidate(unqualifiedQualification(CHAL))], 0.1)).toBeNull();
    });

    it("counter-case: exact tie at every step keeps Jev; each step needs strict improvement", () => {
        // Selection ECE is DERIVED from each qualification's validated
        // `ece_harm_stop` gate value, so ties/strict improvements are
        // set on the gate itself.
        const chalQual = withEceGate(passingQualification(CHAL), 0.05);
        const lunaQual = withEceGate(passingQualification(LUNA), 0.05);
        const chal = candidate(chalQual, { costPer1000Usd: 1, p95LatencyMs: 300 });
        const luna = candidate(lunaQual, { costPer1000Usd: 1, p95LatencyMs: 300 });
        // Full tie → keep Jev (a naive first-wins order would pick CHAL).
        expect(selectComparisonArm([chal, luna], 0.1)).toBeNull();
        // Strict cost improvement decides.
        expect(selectComparisonArm([chal, { ...luna, costPer1000Usd: 0.9 }], 0.1)).toBe(LUNA);
        // Cost tied → p95 decides strictly.
        expect(selectComparisonArm([chal, { ...luna, p95LatencyMs: 250 }], 0.1)).toBe(LUNA);
        // Cost and p95 tied → gate-derived ECE decides strictly.
        expect(selectComparisonArm([
            chal,
            candidate(withEceGate(lunaQual, 0.04), { costPer1000Usd: 1, p95LatencyMs: 300 }),
        ], 0.1)).toBe(LUNA);
        // Cost, p95, and ECE all tied again → keep Jev.
        expect(selectComparisonArm([chal, luna], 0.1)).toBeNull();
    });

    it("counter-case: costComplete:false blocks selection even for a lone passer (naive reservation fallback)", () => {
        const qualification = passingQualification(CHAL);
        const lunaUnqualified = candidate(unqualifiedQualification(LUNA));
        expect(selectComparisonArm([candidate(qualification, { costComplete: false }), lunaUnqualified], 0.1)).toBeNull();
        expect(selectComparisonArm([candidate(qualification, { costComplete: true }), lunaUnqualified], 0.1)).toBe(CHAL);
    });

    it("counter-case: incumbent ECE > 0.30 harm stop blocks any selection", () => {
        const qualification = passingQualification(CHAL);
        // Luna deliberately costlier so CHAL wins every tie-break when the stops do not fire.
        const lunaCool = candidate(passingQualification(LUNA), { costPer1000Usd: 2 });
        expect(selectComparisonArm([candidate(qualification), lunaCool], 0.3)).toBe(CHAL); // equality is not a stop
        expect(selectComparisonArm([candidate(qualification), lunaCool], 0.31)).toBeNull(); // > .30 stops
        // A hot ECE gate cannot ride on a `qualified` label: a value > .30
        // forces `pass: false` ⇒ ¬qualified, and the derived harm stop
        // vetoes selection across all candidates anyway.
        const hotEce = candidate(withEceGate(qualification, 0.31));
        expect(hotEce.qualification.qualified).toBe(false);
        expect(selectComparisonArm([hotEce, lunaCool], 0.1)).toBeNull();
    });

    it("counter-case: ECE > 0.30 on ANY challenger arm — qualified or not — forces no selection (frozen decision 5)", () => {
        // Reviewer's P1 counterexample: a qualified arm A paired with an
        // unqualified arm B whose ECE is .31 must NOT select A — the harm
        // stop runs across ALL challenger candidates before the
        // qualification filter (§4.4 parent-frozen decision 5).
        const qualifiedCool = candidate(passingQualification(CHAL));
        const unqualifiedQual = evaluateComparisonQualification(qualificationInput(
            LUNA,
            buildAverages(LUNA, passingGroups("chal")),
            buildAverages(INCUMBENT_ARM, passingGroups("jev")),
            // Availability 995/1001 < 99.5% ⇒ valid, unblocked, UNQUALIFIED.
            { challengerSummary: healthySummary(LUNA, { attemptedRequests: 1001, successfulResponses: 995, knownCostAttempts: 1001 }) },
        ));
        // The hot ECE lives in the qualification's gate value — the
        // selection ECE is derived from it, not from a free field.
        const unqualifiedHot = candidate(withEceGate(unqualifiedQual, 0.31));
        expect(isComparisonQualificationResult(unqualifiedHot.qualification)).toBe(true);
        expect(unqualifiedHot.qualification.blocked).toBe(false);
        expect(unqualifiedHot.qualification.qualified).toBe(false);
        expect(gate(unqualifiedHot.qualification, "ece_harm_stop").value).toBe(0.31);
        // Pre-fix behaviour (filter to qualified first) selected CHAL here.
        expect(selectComparisonArm([qualifiedCool, unqualifiedHot], 0.1)).toBeNull();
        // A lone candidate is a structural roster error, not a bypass: the
        // omitted challenger's ECE would be unknowable, so selection throws
        // instead of continuing with an incomplete roster.
        expect(() => selectComparisonArm([unqualifiedHot], 0.1)).toThrow(/frozen challenger roster/);
        // Control: the same unqualified arm with its natural cool
        // gate-derived ECE does not veto.
        const unqualifiedCool = candidate(unqualifiedQual);
        expect(gate(unqualifiedCool.qualification, "ece_harm_stop").value).toBeLessThan(0.3);
        expect(selectComparisonArm([qualifiedCool, unqualifiedCool], 0.1)).toBe(CHAL);
    });

    it("counter-case: a blocked arm is never selected, even as the only qualified candidate", () => {
        const blocked = evaluateComparisonQualification(qualificationInput(
            CHAL,
            buildAverages(CHAL, passingGroups("chal")),
            buildAverages(INCUMBENT_ARM, passingGroups("jev")),
            { challengerSummary: healthySummary(CHAL, { blockedReasons: ["missing_probability"] }) },
        ));
        expect(blocked.blocked).toBe(true);
        expect(blocked.qualified).toBe(false);
        // Full roster: blocked CHAL + unqualified LUNA → no qualified challenger.
        expect(selectComparisonArm([candidate(blocked), candidate(unqualifiedQualification(LUNA))], 0.1)).toBeNull();
    });

    it("costPerThousandJudgments uses the frozen 1,570-judgment denominator", () => {
        // 1.57 / 1570 × 1000 = 1.0
        expect(costPerThousandJudgments(1.57)).toBeCloseTo(1, 12);
        expect(costPerThousandJudgments(0)).toBe(0);
        expect(() => costPerThousandJudgments(-1)).toThrow(/non-negative/);
    });
});

describe("end-to-end: synthetic fixture report vs the report gate", () => {
    fixtureIt("averaging → metrics → bootstrap → qualification → isComparisonReportConsistent (frozen digest, unrounded gates) — fixture-gated", () => {
        const plannedUnits = fixturePlannedUnits();
        expect(plannedUnits).toHaveLength(FROZEN_CORPUS_UNITS);
        expect(plannedUnitsDigest(plannedUnits)).toBe(FROZEN_PLANNED_UNITS_DIGEST);

        const unjudgedUnitIndex = plannedUnits.findIndex((unit) => unit.truth === "hard-negative");
        const retryUnitIndex = plannedUnits.findIndex((unit) => unit.truth === "gold");
        expect(unjudgedUnitIndex).toBeGreaterThanOrEqual(0);
        expect(retryUnitIndex).toBeGreaterThanOrEqual(0);

        // Challenger: one wholly-unjudged hard negative (5 transport failures,
        // recorded null — never imputed), one retried gold replica (failure →
        // success on attemptIndex 2), every other attempt a 200 success.
        const challenger = buildE2eArmRun(CHAL, plannedUnits, { unjudgedUnitIndex, retryUnitIndex });
        const baseline = buildE2eArmRun(INCUMBENT_ARM, plannedUnits);
        // Hand counts: 1 warmup + 1564 plain successes + 5 failed + 1 failed +
        // 1 retried = 1572 dispatched; 1 + 1564 + 1 = 1566 succeeded.
        expect(challenger.summary.attemptedRequests).toBe(1572);
        expect(challenger.summary.successfulResponses).toBe(1566);
        expect(challenger.summary.warmupAttempts).toBe(1);
        expect(challenger.summary.unitsWithValidAverage).toBe(313);
        expect(challenger.summary.unitsUnjudged).toBe(1);
        expect(challenger.summary.costComplete).toBe(true);

        // Metrics on replica-averaged scores (frozen 78/148/88 composition).
        const challengerMetrics = computeComparisonArmMetrics(challenger.unitAverages);
        const baselineMetrics = computeComparisonArmMetrics(baseline.unitAverages);
        expect(challengerMetrics.scoredUnits).toBe(313);
        expect(challengerMetrics.goldCount).toBe(78);
        expect(challengerMetrics.recall).toBe(1);
        expect(challengerMetrics.fn).toBe(0);
        expect(challengerMetrics.fp).toBe(0);
        expect(challengerMetrics.loss).toBe(0);
        expect(challengerMetrics.hardNegativePrecision).toBe(1);
        expect(challengerMetrics.aurocGoldVsAll).toBe(1);
        expect(challengerMetrics.ece).toBeLessThan(0.3);
        expect(baselineMetrics.scoredUnits).toBe(FROZEN_CORPUS_UNITS);
        expect(baselineMetrics.recall).toBe(1);
        expect(baselineMetrics.loss).toBe(0);

        // Frozen §4.4 bootstrap: B = 10,000, seed 20261008, no overrides.
        const bootstrap = pairedComparisonBootstrap({
            challenger: challenger.unitAverages,
            baseline: baseline.unitAverages,
        });
        expect(bootstrap.recallDelta?.ciLow).toBe(0);
        expect(bootstrap.recallDelta?.ciHigh).toBe(0);
        expect(bootstrap.hardNegativePrecisionDelta?.ciLow).toBe(0);
        expect(bootstrap.aurocGoldVsAllDelta?.ciLow).toBe(0);
        expect(bootstrap.brierDelta).not.toBeNull();
        expect(bootstrap.utilityGainPerQuery?.ciLow).toBe(0);

        // Full gate evaluation with the frozen bootstrap defaults (no override).
        const qualification = evaluateComparisonQualification({
            arm: CHAL,
            baseline: INCUMBENT_ARM,
            challengerAverages: challenger.unitAverages,
            baselineAverages: baseline.unitAverages,
            challengerSummary: challenger.summary,
        });
        expect(isComparisonQualificationResult(qualification)).toBe(true);
        expect(qualification.blocked).toBe(false);
        expect(qualification.blockedReasons).toEqual([]);
        expect(qualification.qualified).toBe(true);
        expect(qualification.qualified).toBe(
            qualification.gates.every((entry) => entry.pass === true) && !qualification.blocked,
        );
        for (const entry of qualification.gates) {
            expect(entry.pass).toBe(true);
        }
        // Coverage-derived gate values are the exact unrounded fractions: the
        // report gate re-derives them with a 1e-12 tolerance, so rounding
        // (e.g. a 3-decimal availability) fails isComparisonReportConsistent.
        expect(gate(qualification, "availability").value).toBe(1566 / 1572);
        expect(gate(qualification, "unjudged").value).toBe(1 / FROZEN_CORPUS_UNITS);
        expect(gate(qualification, "loss").value).toBe(0);
        expect(gate(qualification, "loss").threshold).toBe(0); // baseline loss = 6·0 + 0
        expect(gate(qualification, "net_fn").value).toBe(0);

        // End-to-end binding: the full report must pass the types module's gate,
        // then the stats module's final report gate (quality-gate value binding).
        const report: ComparisonReportVerificationInput = {
            qualification,
            attempts: challenger.attempts,
            summaries: [challenger.summary, baseline.summary],
            outcomes: challenger.outcomes,
            unitAverages: challenger.unitAverages,
            plannedUnits,
            baselineOutcomes: baseline.outcomes,
            baselineUnitAverages: baseline.unitAverages,
        };
        expect(isComparisonReportConsistent(report)).toBe(true);
        expect(verifyComparisonReport(report)).toBe(true);
    });

    /** Honest full-scale pipeline output shared by the report-gate counter-cases. */
    function honestFixtureReport(): { report: ComparisonReportVerificationInput; qualification: ComparisonQualificationResult } {
        const plannedUnits = fixturePlannedUnits();
        const challenger = buildE2eArmRun(CHAL, plannedUnits);
        const baseline = buildE2eArmRun(INCUMBENT_ARM, plannedUnits);
        const qualification = evaluateComparisonQualification({
            arm: CHAL,
            baseline: INCUMBENT_ARM,
            challengerAverages: challenger.unitAverages,
            baselineAverages: baseline.unitAverages,
            challengerSummary: challenger.summary,
        });
        const report: ComparisonReportVerificationInput = {
            qualification,
            attempts: challenger.attempts,
            summaries: [challenger.summary, baseline.summary],
            outcomes: challenger.outcomes,
            unitAverages: challenger.unitAverages,
            plannedUnits,
            baselineOutcomes: baseline.outcomes,
            baselineUnitAverages: baseline.unitAverages,
        };
        return { report, qualification };
    }

    fixtureIt("rejects the reviewer's counterexample: 314 scores all 0.99 claiming passing AUROC/precision/Brier/loss and ECE 0.13 — fixture-gated", () => {
        const plannedUnits = fixturePlannedUnits();
        // Every score 0.99, bound properly (outcomes ↔ attempts ↔ averages),
        // so the types gate's coverage/identity/cost checks all hold.
        const hot = buildE2eArmRun(CHAL, plannedUnits, {}, () => 0.99);
        const baseline = buildE2eArmRun(INCUMBENT_ARM, plannedUnits);
        // A forged qualification whose claims are self-consistent per
        // isComparisonGateResult (pass agrees with the claimed numbers;
        // frozen thresholds held) yet do not follow from the outcomes.
        const claims: Record<ComparisonGateId, Pick<ComparisonGateResult, "value" | "ciLow" | "ciHigh" | "threshold" | "pass">> = {
            recall_ci: { value: 0.99, ciLow: 0.99, ciHigh: 0.99, threshold: -0.02, pass: true },
            net_fn: { value: 0, ciLow: null, ciHigh: null, threshold: 1, pass: true },
            availability: { value: 1, ciLow: null, ciHigh: null, threshold: 0.995, pass: true },
            unjudged: { value: 0, ciLow: null, ciHigh: null, threshold: 0.01, pass: true },
            auroc_ni: { value: 0.99, ciLow: 0.99, ciHigh: 0.99, threshold: -0.02, pass: true },
            hard_negative_precision_ni: { value: 0.99, ciLow: 0.99, ciHigh: 0.99, threshold: -0.03, pass: true },
            brier_ni: { value: -0.99, ciLow: -0.99, ciHigh: -0.99, threshold: 0.02, pass: true },
            loss: { value: 0, ciLow: null, ciHigh: null, threshold: 0, pass: true },
            ece_harm_stop: { value: 0.13, ciLow: null, ciHigh: null, threshold: 0.3, pass: true },
            utility_harm_stop: { value: 0.1, ciLow: 0.1, ciHigh: 0.1, threshold: -0.05, pass: true },
        };
        const forged: ComparisonQualificationResult = {
            arm: CHAL,
            baseline: INCUMBENT_ARM,
            gates: COMPARISON_GATE_IDS.map((id) => ({ gate: id, ...claims[id] })),
            blocked: false,
            blockedReasons: [],
            qualified: true,
        };
        expect(isComparisonQualificationResult(forged)).toBe(true);
        const report: ComparisonReportVerificationInput = {
            qualification: forged,
            attempts: hot.attempts,
            summaries: [hot.summary, baseline.summary],
            outcomes: hot.outcomes,
            unitAverages: hot.unitAverages,
            plannedUnits,
            baselineOutcomes: baseline.outcomes,
            baselineUnitAverages: baseline.unitAverages,
        };
        // The types gate alone accepts the forgery (the reviewer's P1: it
        // binds coverage/identity/cost but not quality-gate VALUES)…
        expect(isComparisonReportConsistent(report)).toBe(true);
        // …while the final report gate recomputes every value from the bound
        // outcomes and rejects it: actual ECE ≈ 0.75 (claimed 0.13), AUROC
        // Δ = 0.5 − 1 (claimed +0.99), loss = 236·0 + 6·0 + 236 (claimed 0),
        // Brier Δ ≈ +0.73 (claimed −0.99), utility = −236/44 (claimed +0.1).
        expect(verifyComparisonReport(report)).toBe(false);
    });

    fixtureIt("rejects a mutated single CI bound that keeps per-gate self-consistency — fixture-gated", () => {
        const { report, qualification } = honestFixtureReport();
        // The honest recall CI is exactly [0, 0] (both arms recall 1 on every
        // draw); +1e-6 on ciHigh alone keeps ciLow ≤ ciHigh and leaves the
        // governing input (ciLow) and pass untouched, so the types gate still
        // accepts — only the recomputed frozen-seed bootstrap bound catches it.
        const mutated: ComparisonQualificationResult = {
            ...qualification,
            gates: qualification.gates.map((entry) =>
                entry.gate === "recall_ci" ? { ...entry, ciHigh: (entry.ciHigh as number) + 1e-6 } : entry),
        };
        expect(gate(mutated, "recall_ci").ciHigh).toBe(1e-6);
        expect(isComparisonQualificationResult(mutated)).toBe(true);
        const mutatedReport = { ...report, qualification: mutated };
        expect(isComparisonReportConsistent(mutatedReport)).toBe(true);
        expect(verifyComparisonReport(mutatedReport)).toBe(false);
    });

    fixtureIt("rejects a tampered Jev-derived loss threshold (nonnegative alone is not enough) — fixture-gated", () => {
        const { report, qualification } = honestFixtureReport();
        // 999 ≥ 0 survives isComparisonGateResult's only loss-threshold check
        // and pass (0 ≤ 999) stays self-consistent, so the types gate accepts…
        const mutated: ComparisonQualificationResult = {
            ...qualification,
            gates: qualification.gates.map((entry) =>
                entry.gate === "loss" ? { ...entry, threshold: 999 } : entry),
        };
        expect(isComparisonQualificationResult(mutated)).toBe(true);
        const mutatedReport = { ...report, qualification: mutated };
        expect(isComparisonReportConsistent(mutatedReport)).toBe(true);
        // …but the recomputed threshold is Jev's observed loss (0 here).
        expect(verifyComparisonReport(mutatedReport)).toBe(false);
    });

    fixtureIt("fail-closes on baseline-arm binding gaps (missing, dropped, tampered) — fixture-gated", () => {
        const { report } = honestFixtureReport();
        expect(verifyComparisonReport(report)).toBe(true);
        expect(verifyComparisonReport({ ...report, baselineOutcomes: [] })).toBe(false);
        expect(verifyComparisonReport({ ...report, baselineOutcomes: report.baselineOutcomes.slice(1) })).toBe(false);
        expect(verifyComparisonReport({ ...report, baselineUnitAverages: [] })).toBe(false);
        // Fixture identity: a tampered candidate path leaves the planned corpus.
        const tamperedFile = report.baselineOutcomes.map((outcome, index) =>
            index === 0 ? { ...(outcome as ComparisonScoredOutcome), file: "src/forged.ts" } : outcome);
        expect(verifyComparisonReport({ ...report, baselineOutcomes: tamperedFile })).toBe(false);
        // Derived average: a tampered mean breaks isComparisonUnitAverageDerivedFrom.
        const tamperedAverage = report.baselineUnitAverages.map((average, index) =>
            index === 0 ? { ...(average as ComparisonUnitAverage), averageProbability: 0.123456789 } : average);
        expect(verifyComparisonReport({ ...report, baselineUnitAverages: tamperedAverage })).toBe(false);
    });
});

/** Reduced-scale planned corpus: 3 query groups × 3 units, one of each frozen truth class. */
function smallPlannedUnits(): ComparisonPlannedUnit[] {
    const units: ComparisonPlannedUnit[] = [];
    for (let group = 1; group <= 3; group += 1) {
        const queryGroup = `a:q${group}`;
        units.push(
            { queryGroup, unitId: "u0", file: `src/q${group}/gold.ts`, truth: "gold" },
            { queryGroup, unitId: "u1", file: `src/q${group}/hard.ts`, truth: "hard-negative" },
            { queryGroup, unitId: "u2", file: `src/q${group}/easy.ts`, truth: "other-negative" },
        );
    }
    return units;
}

describe("end-to-end pipeline at reduced scale (unconditional — no fixture required)", () => {
    it("averaging → metrics → bootstrap → qualification → pure binder (clean run qualifies)", () => {
        const plannedUnits = smallPlannedUnits();
        const challenger = buildE2eArmRun(CHAL, plannedUnits);
        const baseline = buildE2eArmRun(INCUMBENT_ARM, plannedUnits);

        // Wire material: 1 warmup + 9 units × 5 replicas, every attempt a 200 success.
        expect(challenger.attempts).toHaveLength(46);
        expect(challenger.summary.attemptedRequests).toBe(46);
        expect(challenger.summary.successfulResponses).toBe(46);
        expect(challenger.summary.warmupAttempts).toBe(1);
        expect(isComparisonArmRunSummary(challenger.summary)).toBe(true);

        // Averaging: five replicas per unit; the gold mean is hand-computed
        // from the symmetric jitter (0.88 + 0.89 + 0.90 + 0.91 + 0.92)/5.
        expect(challenger.unitAverages).toHaveLength(9);
        expect(challenger.unitAverages.every((unit) => unit.averageProbability !== null)).toBe(true);
        const gold = challenger.unitAverages.find((unit) => unit.truth === "gold");
        expect(gold?.replicasAveraged).toBe(5);
        expect(gold?.averageProbability).toBe(0.9);

        // Metrics on replica-averaged scores.
        const metrics = computeComparisonArmMetrics(challenger.unitAverages);
        expect(metrics.scoredUnits).toBe(9);
        expect(metrics.goldCount).toBe(3);
        expect(metrics.negativeCount).toBe(6);
        expect(metrics.recall).toBe(1);
        expect(metrics.aurocGoldVsAll).toBe(1);
        expect(metrics.loss).toBe(0);

        // Frozen bootstrap (seed 20261008, B = 10,000): identical arms ⇒ Δ = 0
        // on every draw, and each group carries gold + negatives, so no
        // degenerate draws — attempts equal B exactly.
        const bootstrap = pairedComparisonBootstrap({
            challenger: challenger.unitAverages,
            baseline: baseline.unitAverages,
        });
        expect(bootstrap.recallDelta?.attempts).toBe(FROZEN_BOOTSTRAP_ITERATIONS);
        expect(bootstrap.recallDelta?.ciLow).toBe(0);

        // Qualification over the derived summary with the frozen bootstrap defaults.
        const qualification = evaluateComparisonQualification({
            arm: CHAL,
            baseline: INCUMBENT_ARM,
            challengerAverages: challenger.unitAverages,
            baselineAverages: baseline.unitAverages,
            challengerSummary: challenger.summary,
        });
        expect(isComparisonQualificationResult(qualification)).toBe(true);
        expect(qualification.blocked).toBe(false);
        expect(qualification.blockedReasons).toEqual([]);
        for (const entry of qualification.gates) {
            expect(entry.pass).toBe(true);
        }
        expect(qualification.qualified).toBe(true);
        expect(qualification.qualified).toBe(
            qualification.gates.every((entry) => entry.pass === true) && !qualification.blocked,
        );
        // Gate CIs come from the same frozen-seed draws as the direct call,
        // and coverage gates recompute the exact unrounded fractions.
        expect(gate(qualification, "recall_ci").ciLow).toBe(bootstrap.recallDelta?.ciLow);
        expect(gate(qualification, "availability").value).toBe(1); // 46/46
        expect(gate(qualification, "unjudged").value).toBe(0);

        // Pure binder (fixture-free half of the report binding): the summary's
        // attempt-derived counts agree with the actual attempt records.
        expect(isComparisonQualificationConsistentWith(
            qualification,
            challenger.attempts,
            [challenger.summary, baseline.summary],
        )).toBe(true);
    });

    it("a recorded unjudged unit counts only against the unjudged/availability gates — never a block (§4.4 decision 2)", () => {
        const plannedUnits = smallPlannedUnits();
        const unjudgedUnitIndex = plannedUnits.findIndex((unit) => unit.truth === "other-negative");
        expect(unjudgedUnitIndex).toBeGreaterThanOrEqual(0);
        const challenger = buildE2eArmRun(CHAL, plannedUnits, { unjudgedUnitIndex });
        const baseline = buildE2eArmRun(INCUMBENT_ARM, plannedUnits);

        // Five transport failures on the unjudged unit: recorded null, never imputed.
        expect(challenger.summary.unitsUnjudged).toBe(1);
        expect(challenger.summary.attemptedRequests).toBe(46); // 1 warmup + 45 unit attempts
        expect(challenger.summary.successfulResponses).toBe(41); // 1 warmup + 40 scored successes
        expect(challenger.unitAverages[unjudgedUnitIndex]?.averageProbability).toBeNull();
        expect(isComparisonArmRunSummary(challenger.summary)).toBe(true);

        const qualification = evaluateComparisonQualification({
            arm: CHAL,
            baseline: INCUMBENT_ARM,
            challengerAverages: challenger.unitAverages,
            baselineAverages: baseline.unitAverages,
            challengerSummary: challenger.summary,
        });
        expect(isComparisonQualificationResult(qualification)).toBe(true);
        // Recorded unjudged outcomes are complete observations: gate-counted,
        // never a completeness block — no missing_probability, no coercion.
        expect(qualification.blocked).toBe(false);
        expect(qualification.blockedReasons).toEqual([]);
        // Availability over ALL dispatched attempts fails: 41/46 < .995 …
        expect(gate(qualification, "availability").value).toBe(41 / 46);
        expect(gate(qualification, "availability").pass).toBe(false);
        // …while unjudged is measured against the frozen 314-unit denominator.
        expect(gate(qualification, "unjudged").value).toBe(1 / FROZEN_CORPUS_UNITS);
        expect(gate(qualification, "unjudged").pass).toBe(true);
        // Quality metrics exclude the unjudged unit rather than imputing it.
        const metrics = computeComparisonArmMetrics(challenger.unitAverages);
        expect(metrics.scoredUnits).toBe(8);
        expect(metrics.negativeCount).toBe(5);
        // Gate failure (not blocking) keeps the arm unqualified.
        expect(qualification.qualified).toBe(false);
        expect(qualification.qualified).toBe(
            qualification.gates.every((entry) => entry.pass === true) && !qualification.blocked,
        );
        expect(isComparisonQualificationConsistentWith(
            qualification,
            challenger.attempts,
            [challenger.summary, baseline.summary],
        )).toBe(true);
    });

    it("report-gate ordering: verifyComparisonReport requires isComparisonReportConsistent first (fail-closed)", () => {
        const plannedUnits = smallPlannedUnits();
        const challenger = buildE2eArmRun(CHAL, plannedUnits);
        const baseline = buildE2eArmRun(INCUMBENT_ARM, plannedUnits);
        const qualification = evaluateComparisonQualification(qualificationInput(
            CHAL,
            challenger.unitAverages,
            baseline.unitAverages,
            { challengerSummary: challenger.summary },
        ));
        const report: ComparisonReportVerificationInput = {
            qualification,
            attempts: challenger.attempts,
            summaries: [challenger.summary, baseline.summary],
            outcomes: challenger.outcomes,
            unitAverages: challenger.unitAverages,
            plannedUnits,
            baselineOutcomes: baseline.outcomes,
            baselineUnitAverages: baseline.unitAverages,
        };
        // The reduced corpus can never pass the frozen-corporum types gate
        // (composition + digest), so full acceptance is fixture-gated above;
        // what is unconditional is the fail-closed ordering itself: the
        // consistency gate runs FIRST, and its rejection short-circuits.
        expect(isComparisonReportConsistent(report)).toBe(false);
        expect(verifyComparisonReport(report)).toBe(false);
    });
});
