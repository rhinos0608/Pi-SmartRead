/**
 * Fail-closed runtime validators for the full-comparison DTOs
 * (protocol §4.4, "Statistics policy (frozen 2026-10-08, pre-data)").
 *
 * Every malformed record must be REJECTED, never repaired: missing
 * probability fields stay missing (capture gap), token `0` and `null`
 * remain distinct states, unknown cost must retain its reserve,
 * warmups are never confused with the scored unit `u0`, and only the
 * three exact frozen arm slugs are accepted. Provenance (attempt id,
 * provider, payload hash), the served-identity allowlist, the scored-
 * outcome/replica-average records, and the `Object.freeze`d policy
 * constants are covered the same way.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
    COMPARISON_BLOCKED_REASONS,
    COMPARISON_GATE_IDS,
    COMPARISON_GATE_THRESHOLDS,
    COMPARISON_SERVED_MODEL_ALLOWLIST,
    COMPARISON_TRUTH_CLASSES,
    FROZEN_CORPUS_UNITS,
    FROZEN_PLANNED_UNITS_DIGEST,
    FROZEN_REPLICA_COUNT,
    canonicalPlannedUnitsSerialization,
    detectComparisonAttemptDrift,
    isComparisonArmRunSummary,
    isComparisonAttemptCost,
    isComparisonAttemptRecord,
    isComparisonGateResult,
    isComparisonModelId,
    isComparisonPlannedUnit,
    isComparisonQualificationConsistentWith,
    isComparisonQualificationResult,
    isComparisonReportConsistent,
    isComparisonScoredOutcome,
    isComparisonUnitAverage,
    isComparisonUnitAverageDerivedFrom,
    plannedUnitsDigest,
    truthClassFromFixtureLabel,
    type ComparisonArmRunSummary,
    type ComparisonAttemptRecord,
    type ComparisonGateResult,
    type ComparisonPlannedUnit,
    type ComparisonQualificationResult,
    type ComparisonScoredOutcome,
    type ComparisonUnitAverage,
} from "../../../scripts/eval/judge/model-comparison-types.js";
import { requestReserveUsd } from "../../../scripts/eval/judge/model-comparison-budget.js";
import {
    PLAN_DATA_DIR,
    PLAN_SERVED_PINS,
    loadSetRows,
    type PlanFixtureRow,
} from "../../../scripts/eval/judge/model-comparison-plan.js";

/** Frozen per-attempt reserve for the fixture arm (budget module tables). */
const PPLX_PER_ATTEMPT_RESERVE = requestReserveUsd("perplexity/pplx-decider-v1.1-27b");

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
 * plan module's `loadSetRows` loader, `deriveFullRunPlan`'s grouping
 * (`set:qid` in file order), and `toItems`' packed unit ids (`u0…u{n-1}`
 * per group — unit ids repeat across groups, so group + id is identity).
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

function validAttempt(overrides: Partial<ComparisonAttemptRecord> = {}): ComparisonAttemptRecord {
    return {
        attemptId: "att-r0-0001",
        arm: "perplexity/pplx-decider-v1.1-27b",
        servedModel: "perplexity/pplx-decider-v1.1-27b-20261006",
        provider: "Perplexity",
        queryGroup: "a:q01",
        unitId: "u0",
        replica: 0,
        attemptIndex: 1,
        warmup: false,
        requestBytes: 2048,
        payloadSha256: "ab".repeat(32),
        httpStatus: 200,
        probability: 0.96,
        inputTokens: 729,
        outputTokens: 70,
        cost: { status: "known", usd: 0.00003062 },
        errorClass: null,
        ...overrides,
    };
}

/** A dispatched attempt whose response never arrived: no served identity, no provider. */
function transportFailureAttempt(overrides: Partial<ComparisonAttemptRecord> = {}): ComparisonAttemptRecord {
    return validAttempt({
        httpStatus: null,
        servedModel: null,
        provider: null,
        probability: null,
        errorClass: "network",
        inputTokens: null,
        outputTokens: null,
        cost: { status: "unknown", reserveUsd: PPLX_PER_ATTEMPT_RESERVE },
        ...overrides,
    });
}

function passingGates(): ComparisonGateResult[] {
    return [
        { gate: "recall_ci", value: 0.01, ciLow: -0.01, ciHigh: 0.03, threshold: -0.02, pass: true },
        { gate: "net_fn", value: 0, ciLow: null, ciHigh: null, threshold: 1, pass: true },
        { gate: "availability", value: 0.999, ciLow: null, ciHigh: null, threshold: 0.995, pass: true },
        { gate: "unjudged", value: 0, ciLow: null, ciHigh: null, threshold: 0.01, pass: true },
        { gate: "auroc_ni", value: 0.001, ciLow: -0.01, ciHigh: 0.02, threshold: -0.02, pass: true },
        { gate: "hard_negative_precision_ni", value: 0, ciLow: -0.02, ciHigh: 0.01, threshold: -0.03, pass: true },
        { gate: "brier_ni", value: 0.001, ciLow: -0.01, ciHigh: 0.01, threshold: 0.02, pass: true },
        { gate: "loss", value: 10, ciLow: null, ciHigh: null, threshold: 12, pass: true },
        { gate: "ece_harm_stop", value: 0.13, ciLow: null, ciHigh: null, threshold: 0.3, pass: true },
        { gate: "utility_harm_stop", value: 0.05, ciLow: -0.01, ciHigh: 0.1, threshold: -0.05, pass: true },
    ];
}

function validQualification(): ComparisonQualificationResult {
    return {
        arm: "perplexity/pplx-decider-v1.1-27b",
        baseline: "~typesafe/jev-latest",
        gates: passingGates(),
        blocked: false,
        blockedReasons: [],
        qualified: true,
    };
}

function validSummary(): ComparisonArmRunSummary {
    return {
        arm: "perplexity/pplx-decider-v1.1-27b",
        replicasPlanned: 5,
        replicasObserved: 5,
        unitsPlanned: 314,
        unitsWithValidAverage: 313,
        unitsUnjudged: 1,
        attemptedRequests: 675,
        successfulResponses: 674,
        warmupAttempts: 15,
        knownCostAttempts: 674,
        unknownCostAttempts: 1,
        knownCostUsd: 0.0072,
        unknownCostReserveUsd: PPLX_PER_ATTEMPT_RESERVE,
        costComplete: false,
        runCompleted: true,
        blockedReasons: [],
    };
}

/** A run summary whose counts are derived from a concrete attempt list. */
function summaryFromAttempts(
    attempts: readonly ComparisonAttemptRecord[],
    overrides: Partial<ComparisonArmRunSummary> = {},
): ComparisonArmRunSummary {
    let warmupAttempts = 0;
    let successfulResponses = 0;
    let knownCostAttempts = 0;
    let unknownCostAttempts = 0;
    let unknownCostReserveUsd = 0;
    for (const record of attempts) {
        if (record.warmup) warmupAttempts += 1;
        if (record.httpStatus !== null && record.httpStatus >= 200
            && record.httpStatus <= 299 && record.errorClass === null) {
            successfulResponses += 1;
        }
        if (record.cost.status === "known") {
            knownCostAttempts += 1;
        } else {
            unknownCostAttempts += 1;
            unknownCostReserveUsd += record.cost.reserveUsd;
        }
    }
    return {
        ...validSummary(),
        attemptedRequests: attempts.length,
        successfulResponses,
        warmupAttempts,
        knownCostAttempts,
        unknownCostAttempts,
        unknownCostReserveUsd,
        costComplete: unknownCostAttempts === 0,
        ...overrides,
    };
}

function validOutcome(overrides: Partial<ComparisonScoredOutcome> = {}): ComparisonScoredOutcome {
    return {
        arm: "perplexity/pplx-decider-v1.1-27b",
        queryGroup: "a:q01",
        unitId: "u0",
        file: "src/search/grep-cascade.ts",
        replica: 0,
        truth: "gold",
        probability: 0.96,
        attemptIds: ["att-r0-0001"],
        ...overrides,
    };
}

function validAverage(overrides: Partial<ComparisonUnitAverage> = {}): ComparisonUnitAverage {
    return {
        arm: "perplexity/pplx-decider-v1.1-27b",
        queryGroup: "a:q01",
        unitId: "u0",
        file: "src/search/grep-cascade.ts",
        truth: "gold",
        replicasAveraged: 5,
        averageProbability: 0.8,
        ...overrides,
    };
}

describe("frozen campaign shape", () => {
    it("pins five replicas and 314 units", () => {
        expect(FROZEN_REPLICA_COUNT).toBe(5);
        expect(FROZEN_CORPUS_UNITS).toBe(314);
        expect([...COMPARISON_GATE_IDS]).toHaveLength(10);
    });
});

describe("isComparisonModelId (unknown arm slug rejected)", () => {
    it("accepts exactly the three frozen slugs", () => {
        expect(isComparisonModelId("~typesafe/jev-latest")).toBe(true);
        expect(isComparisonModelId("perplexity/pplx-decider-v1.1-27b")).toBe(true);
        expect(isComparisonModelId("openai/gpt-6-luna-decisions")).toBe(true);
    });

    it("rejects unknown, truncated, and non-string arm identities", () => {
        expect(isComparisonModelId("openai/gpt-6-luna")).toBe(false);
        expect(isComparisonModelId("jev-latest")).toBe(false);
        expect(isComparisonModelId("")).toBe(false);
        expect(isComparisonModelId(null)).toBe(false);
        expect(isComparisonModelId(42)).toBe(false);
    });
});

describe("isComparisonAttemptCost (unknown cost requires reserve)", () => {
    it("accepts known cost, including an explicitly reported zero", () => {
        expect(isComparisonAttemptCost({ status: "known", usd: 0 })).toBe(true);
        expect(isComparisonAttemptCost({ status: "known", usd: 0.00003062 })).toBe(true);
    });

    it("rejects unknown cost without a positive reserve (never $0)", () => {
        expect(isComparisonAttemptCost({ status: "unknown" })).toBe(false);
        expect(isComparisonAttemptCost({ status: "unknown", reserveUsd: 0 })).toBe(false);
        expect(isComparisonAttemptCost({ status: "unknown", reserveUsd: -0.001 })).toBe(false);
        expect(isComparisonAttemptCost({ status: "unknown", reserveUsd: "0.001" })).toBe(false);
        expect(isComparisonAttemptCost({ status: "unknown", usd: 0.001 })).toBe(false);
    });

    it("rejects malformed and foreign variants", () => {
        expect(isComparisonAttemptCost({ status: "known" })).toBe(false);
        expect(isComparisonAttemptCost({ status: "assumed", usd: 0 })).toBe(false);
        expect(isComparisonAttemptCost({ status: "known", usd: Number.NaN })).toBe(false);
        expect(isComparisonAttemptCost(null)).toBe(false);
    });
});

describe("isComparisonAttemptRecord (fail-closed capture rules)", () => {
    it("accepts a well-formed scored record", () => {
        expect(isComparisonAttemptRecord(validAttempt())).toBe(true);
    });

    it("missing probability stays null: recorded unjudged passes, absent field is rejected", () => {
        const recordedUnjudged = validAttempt({ probability: null, errorClass: "bad_response" });
        expect(isComparisonAttemptRecord(recordedUnjudged)).toBe(true);
        expect(recordedUnjudged.probability).toBeNull();

        const absent = { ...validAttempt() } as Partial<ComparisonAttemptRecord>;
        delete absent.probability;
        expect(isComparisonAttemptRecord(absent)).toBe(false);

        // A scored unit with no probability AND no failure class is a capture gap.
        expect(isComparisonAttemptRecord(validAttempt({ probability: null, errorClass: null }))).toBe(false);

        // Never a synthetic value: out-of-range or non-numeric probabilities reject.
        expect(isComparisonAttemptRecord(validAttempt({ probability: 1.2 }))).toBe(false);
        expect(isComparisonAttemptRecord(validAttempt({ probability: -0.1 }))).toBe(false);
        expect(isComparisonAttemptRecord(validAttempt({ probability: Number.NaN }))).toBe(false);
    });

    it("zero tokens vs null are distinct valid states; absent or negative tokens reject", () => {
        expect(isComparisonAttemptRecord(validAttempt({ inputTokens: 0, outputTokens: 0 }))).toBe(true);
        expect(isComparisonAttemptRecord(validAttempt({ inputTokens: null, outputTokens: null }))).toBe(true);

        const noTokens = { ...validAttempt() } as Partial<ComparisonAttemptRecord>;
        delete noTokens.outputTokens;
        expect(isComparisonAttemptRecord(noTokens)).toBe(false);

        expect(isComparisonAttemptRecord(validAttempt({ outputTokens: -1 }))).toBe(false);
        expect(isComparisonAttemptRecord(validAttempt({ inputTokens: 12.5 }))).toBe(false);
    });

    it("warmup is not confused with the scored unit u0", () => {
        const warmup = validAttempt({
            warmup: true,
            queryGroup: null,
            unitId: "u0",
            probability: null,
            inputTokens: null,
            outputTokens: null,
        });
        const scoredU0 = validAttempt({ warmup: false, unitId: "u0", queryGroup: "a:q01" });
        expect(isComparisonAttemptRecord(warmup)).toBe(true);
        expect(isComparisonAttemptRecord(scoredU0)).toBe(true);
        expect(warmup.unitId).toBe(scoredU0.unitId);
        expect(warmup.queryGroup).toBeNull();
        expect(scoredU0.queryGroup).toBe("a:q01");

        // The flag/query-group pairing is what discriminates; either mismatch rejects.
        expect(isComparisonAttemptRecord(validAttempt({ warmup: true, queryGroup: "a:q01" }))).toBe(false);
        expect(isComparisonAttemptRecord(validAttempt({ warmup: false, queryGroup: null, unitId: "u0" }))).toBe(false);
        expect(isComparisonAttemptRecord(validAttempt({ warmup: "u0" as never }))).toBe(false);
    });

    it("rejects unknown arm slugs on attempt records", () => {
        expect(isComparisonAttemptRecord(validAttempt({ arm: "openai/gpt-6-luna" as never }))).toBe(false);
        expect(isComparisonAttemptRecord(validAttempt({ arm: "gpt-6-luna-decisions" as never }))).toBe(false);
        expect(isComparisonAttemptRecord(validAttempt({ arm: "~typesafe/jev-latest" }))).toBe(true);
    });

    it("rejects foreign keys (no bodies, headers, or credentials smuggled in)", () => {
        expect(isComparisonAttemptRecord({
            ...validAttempt(),
            apiKey: "sk-not-allowed",
        })).toBe(false);
        expect(isComparisonAttemptRecord({
            ...validAttempt(),
            responseBody: "{\"p\":0.96}",
        })).toBe(false);
    });

    it("enforces status/identity/error-class cross invariants", () => {
        // Success requires 2xx + no error class; failure requires a class.
        expect(isComparisonAttemptRecord(validAttempt({ httpStatus: 500, errorClass: null }))).toBe(false);
        expect(isComparisonAttemptRecord(validAttempt({ httpStatus: null, errorClass: null }))).toBe(false);
        expect(isComparisonAttemptRecord(validAttempt({ probability: 0.96, errorClass: "bad_response" }))).toBe(false);
        expect(isComparisonAttemptRecord(validAttempt({ httpStatus: 400, errorClass: null, probability: null }))).toBe(false);
        // http_N class must match the observed status; no response ⇒ no served identity.
        expect(isComparisonAttemptRecord(validAttempt({
            httpStatus: 502,
            probability: null,
            errorClass: "http_502",
            inputTokens: null,
            outputTokens: null,
            cost: { status: "unknown", reserveUsd: 0.001344 },
        }))).toBe(true);
        expect(isComparisonAttemptRecord(validAttempt({
            httpStatus: 500,
            probability: null,
            errorClass: "http_502",
            inputTokens: null,
            outputTokens: null,
        }))).toBe(false);
        expect(isComparisonAttemptRecord(transportFailureAttempt())).toBe(true);
        expect(isComparisonAttemptRecord(transportFailureAttempt({ servedModel: "perplexity/pplx-decider-v1.1-27b" }))).toBe(false);
        expect(isComparisonAttemptRecord(transportFailureAttempt({ provider: "Perplexity" }))).toBe(false);
        // Unknown error classes and out-of-range statuses reject.
        expect(isComparisonAttemptRecord(validAttempt({ errorClass: "provider_on_fire" as never }))).toBe(false);
        expect(isComparisonAttemptRecord(validAttempt({ httpStatus: 99 }))).toBe(false);
    });

    it("enforces frozen replica and attempt-index ranges", () => {
        expect(isComparisonAttemptRecord(validAttempt({ replica: 4 }))).toBe(true);
        expect(isComparisonAttemptRecord(validAttempt({ replica: 5 }))).toBe(false);
        expect(isComparisonAttemptRecord(validAttempt({ replica: -1 }))).toBe(false);
        expect(isComparisonAttemptRecord(validAttempt({ attemptIndex: 3 }))).toBe(true);
        expect(isComparisonAttemptRecord(validAttempt({ attemptIndex: 0 }))).toBe(false);
        expect(isComparisonAttemptRecord(validAttempt({ requestBytes: -1 }))).toBe(false);
    });

    it("rejects a response attempt without a served identity (fail closed)", () => {
        // HTTP 200 with servedModel null: a successful response must be verifiable.
        expect(isComparisonAttemptRecord(validAttempt({ servedModel: null }))).toBe(false);
        // Any received status requires identity, including recorded HTTP failures.
        expect(isComparisonAttemptRecord(validAttempt({
            httpStatus: 502,
            probability: null,
            errorClass: "http_502",
            servedModel: null,
            inputTokens: null,
            outputTokens: null,
        }))).toBe(false);
        expect(isComparisonAttemptRecord(validAttempt({ servedModel: "" }))).toBe(false);
        // No response ⇒ no identity is still the valid transport-failure shape.
        expect(isComparisonAttemptRecord(transportFailureAttempt())).toBe(true);
    });
});

describe("isComparisonArmRunSummary", () => {
    it("accepts a consistent summary", () => {
        expect(isComparisonArmRunSummary(validSummary())).toBe(true);
    });

    it("rejects broken partitions and inconsistent flags", () => {
        expect(isComparisonArmRunSummary({ ...validSummary(), unitsPlanned: 313 })).toBe(false);
        expect(isComparisonArmRunSummary({ ...validSummary(), unitsUnjudged: 2 })).toBe(false);
        expect(isComparisonArmRunSummary({ ...validSummary(), replicasPlanned: 4 })).toBe(false);
        expect(isComparisonArmRunSummary({
            ...validSummary(),
            costComplete: true, // unknownCostAttempts is 1
        })).toBe(false);
        expect(isComparisonArmRunSummary({
            ...validSummary(),
            knownCostAttempts: 675, // + unknownCostAttempts must equal attemptedRequests
        })).toBe(false);
        expect(isComparisonArmRunSummary({
            ...validSummary(),
            successfulResponses: 676, // exceeds attemptedRequests
        })).toBe(false);
    });

    it("ties aborted runs to the aborted_run blocked reason", () => {
        expect(isComparisonArmRunSummary({
            ...validSummary(),
            runCompleted: false,
            blockedReasons: ["aborted_run"],
        })).toBe(true);
        expect(isComparisonArmRunSummary({ ...validSummary(), runCompleted: false })).toBe(false);
        expect(isComparisonArmRunSummary({
            ...validSummary(),
            runCompleted: true,
            blockedReasons: ["aborted_run"],
        })).toBe(false);
        expect(isComparisonArmRunSummary({
            ...validSummary(),
            blockedReasons: ["mystery_block"],
        })).toBe(false);
    });

    it("requires unknown-cost attempts to retain a real reserve", () => {
        expect(isComparisonArmRunSummary(validSummary())).toBe(true);
        // $0 or a shortfall against the frozen per-attempt reserve rejects.
        expect(isComparisonArmRunSummary({ ...validSummary(), unknownCostReserveUsd: 0 })).toBe(false);
        expect(isComparisonArmRunSummary({
            ...validSummary(),
            unknownCostReserveUsd: PPLX_PER_ATTEMPT_RESERVE - 1e-9,
        })).toBe(false);
        expect(isComparisonArmRunSummary({
            ...validSummary(),
            knownCostAttempts: 673,
            unknownCostAttempts: 2,
            unknownCostReserveUsd: 2 * PPLX_PER_ATTEMPT_RESERVE,
        })).toBe(true);
        // Zero unknown attempts require no reserve at all.
        expect(isComparisonArmRunSummary({
            ...validSummary(),
            knownCostAttempts: 675,
            unknownCostAttempts: 0,
            unknownCostReserveUsd: 0,
            costComplete: true,
        })).toBe(true);
    });
});

describe("isComparisonGateResult", () => {
    it("accepts every gate at its frozen threshold", () => {
        for (const gate of passingGates()) {
            expect(isComparisonGateResult(gate), gate.gate).toBe(true);
        }
    });

    it("rejects threshold tampering and pass/number mismatches", () => {
        expect(isComparisonGateResult({
            gate: "recall_ci",
            value: 0.01,
            ciLow: -0.01,
            ciHigh: 0.03,
            threshold: -0.01, // frozen is -0.02
            pass: true,
        })).toBe(false);
        // ciLow below threshold but recorded as pass — recomputation rejects it.
        expect(isComparisonGateResult({
            gate: "recall_ci",
            value: -0.01,
            ciLow: -0.03,
            ciHigh: 0.01,
            threshold: -0.02,
            pass: true,
        })).toBe(false);
        // Governing bound missing while pass is decided — rejected.
        expect(isComparisonGateResult({
            gate: "recall_ci",
            value: 0.01,
            ciLow: null,
            ciHigh: 0.03,
            threshold: -0.02,
            pass: true,
        })).toBe(false);
        // Brier is governed by ciHigh.
        expect(isComparisonGateResult({
            gate: "brier_ni",
            value: 0.025,
            ciLow: -0.01,
            ciHigh: 0.03,
            threshold: 0.02,
            pass: true,
        })).toBe(false);
    });

    it("allows a data-dependent loss threshold but never a negative one", () => {
        expect(isComparisonGateResult({
            gate: "loss",
            value: 42,
            ciLow: null,
            ciHigh: null,
            threshold: 42,
            pass: true,
        })).toBe(true);
        expect(isComparisonGateResult({
            gate: "loss",
            value: 42,
            ciLow: null,
            ciHigh: null,
            threshold: -1,
            pass: true,
        })).toBe(false);
    });

    it("requires pass: null only when the governing input is missing", () => {
        expect(isComparisonGateResult({
            gate: "utility_harm_stop",
            value: null,
            ciLow: null,
            ciHigh: null,
            threshold: -0.05,
            pass: null,
        })).toBe(true);
        expect(isComparisonGateResult({
            gate: "utility_harm_stop",
            value: 0.05,
            ciLow: -0.01,
            ciHigh: 0.1,
            threshold: -0.05,
            pass: null, // inputs complete but undecided — rejected
        })).toBe(false);
    });

    it("zero-selection precision: undefined ⇒ value null ⇒ pass null (never 1.0/0)", () => {
        const undefinedPrecision = {
            gate: "hard_negative_precision_ni",
            value: null,
            ciLow: null,
            ciHigh: null,
            threshold: -0.03,
            pass: null,
        };
        expect(isComparisonGateResult(undefinedPrecision)).toBe(true);
        expect(isComparisonGateResult({ ...undefinedPrecision, pass: false })).toBe(false);
        expect(isComparisonGateResult({ ...undefinedPrecision, pass: true })).toBe(false);
        // A convention point estimate (e.g. 1.0 with no governing CI) still forces pass null.
        expect(isComparisonGateResult({ ...undefinedPrecision, value: 1, pass: true })).toBe(false);
        expect(isComparisonGateResult({ ...undefinedPrecision, value: 1, pass: null })).toBe(true);
        // A real value with a real governing CI may still pass.
        expect(isComparisonGateResult({
            gate: "hard_negative_precision_ni",
            value: 0.9,
            ciLow: -0.01,
            ciHigh: 0.02,
            threshold: -0.03,
            pass: true,
        })).toBe(true);
    });
});

describe("isComparisonQualificationResult", () => {
    it("accepts a fully qualified, unblocked arm", () => {
        expect(isComparisonQualificationResult(validQualification())).toBe(true);
    });

    it("requires complete, unique gate coverage", () => {
        const missing = passingGates().filter((g) => g.gate !== "loss");
        expect(isComparisonQualificationResult({ ...validQualification(), gates: missing })).toBe(false);

        const duplicate = [...passingGates()];
        duplicate[1] = { ...duplicate[0]! };
        expect(isComparisonQualificationResult({ ...validQualification(), gates: duplicate })).toBe(false);
    });

    it("enforces blocked/qualified/reason consistency", () => {
        // Blocked with no reasons is contradictory.
        expect(isComparisonQualificationResult({
            ...validQualification(),
            blocked: true,
            blockedReasons: [],
            qualified: false,
        })).toBe(false);
        // Blocked arms can never qualify.
        expect(isComparisonQualificationResult({
            ...validQualification(),
            blocked: true,
            blockedReasons: ["missing_probability"],
            qualified: true,
        })).toBe(false);
        // Everything passes and the arm is unblocked ⇒ qualified must be
        // true: recording qualified:false while passing is rejected too
        // (the P1b reviewer counterexample, in both directions).
        expect(isComparisonQualificationResult({ ...validQualification(), qualified: false })).toBe(false);
        // A failed gate forbids qualified: true.
        const vetoed = passingGates().map((g) =>
            g.gate === "ece_harm_stop" ? { ...g, value: 0.31, pass: false } : g,
        );
        expect(isComparisonQualificationResult({
            ...validQualification(),
            gates: vetoed,
            qualified: true,
        })).toBe(false);
        // An undecided gate forces blocked.
        const undecided = passingGates().map((g) =>
            g.gate === "recall_ci" ? { ...g, value: null, ciLow: null, ciHigh: null, pass: null } : g,
        );
        expect(isComparisonQualificationResult({
            ...validQualification(),
            gates: undecided,
            blocked: false,
            qualified: false,
        })).toBe(false);
        // Challenger must differ from the baseline.
        expect(isComparisonQualificationResult({
            ...validQualification(),
            arm: "~typesafe/jev-latest",
        })).toBe(false);
    });

    it("blocks the arm with undefined_precision when precision is undecided", () => {
        const gates = passingGates().map((g) =>
            g.gate === "hard_negative_precision_ni"
                ? { ...g, value: null, ciLow: null, ciHigh: null, pass: null }
                : g,
        );
        expect(isComparisonQualificationResult({
            ...validQualification(),
            gates,
            blocked: true,
            blockedReasons: ["undefined_precision"],
            qualified: false,
        })).toBe(true);
        // An undecided precision gate without a block is rejected.
        expect(isComparisonQualificationResult({
            ...validQualification(),
            gates,
            blocked: false,
            qualified: false,
        })).toBe(false);
        // A blocked arm can never qualify, even with only this reason.
        expect(isComparisonQualificationResult({
            ...validQualification(),
            gates,
            blocked: true,
            blockedReasons: ["undefined_precision"],
            qualified: true,
        })).toBe(false);
    });

    it("requires undefined_precision specifically when the precision gate value is null", () => {
        const gates = passingGates().map((g) =>
            g.gate === "hard_negative_precision_ni"
                ? { ...g, value: null, ciLow: null, ciHigh: null, pass: null }
                : g,
        );
        // Blocked for an unrelated reason only: the required reason is missing ⇒ rejected.
        expect(isComparisonQualificationResult({
            ...validQualification(),
            gates,
            blocked: true,
            blockedReasons: ["missing_probability"],
            qualified: false,
        })).toBe(false);
        // The specific reason alongside an unrelated one: accepted.
        expect(isComparisonQualificationResult({
            ...validQualification(),
            gates,
            blocked: true,
            blockedReasons: ["missing_probability", "undefined_precision"],
            qualified: false,
        })).toBe(true);
        // A defined precision gate needs no undefined_precision reason.
        expect(isComparisonQualificationResult({
            ...validQualification(),
            blocked: true,
            blockedReasons: ["missing_probability"],
            qualified: false,
        })).toBe(true);
    });
});

describe("isComparisonQualificationConsistentWith (end-to-end report binder)", () => {
    function binderAttempts(): ComparisonAttemptRecord[] {
        return [
            validAttempt({
                attemptId: "bnd-warmup",
                warmup: true,
                queryGroup: null,
                unitId: "u0",
                probability: null,
                inputTokens: null,
                outputTokens: null,
            }),
            validAttempt({ attemptId: "bnd-r0", replica: 0 }),
            validAttempt({ attemptId: "bnd-r1", replica: 1, attemptIndex: 2 }),
            transportFailureAttempt({ attemptId: "bnd-r2", replica: 2, attemptIndex: 3 }),
        ];
    }

    it("accepts a report whose qualification, summary, and attempts agree", () => {
        const attempts = binderAttempts();
        const summary = summaryFromAttempts(attempts);
        expect(isComparisonArmRunSummary(summary)).toBe(true);
        expect(isComparisonQualificationConsistentWith(validQualification(), attempts, [summary])).toBe(true);
    });

    it("rejects a qualification or summary that omits a detected drift reason", () => {
        const attempts = [validAttempt({ attemptId: "drift-1", servedModel: "other/snapshot-1" })];
        const summary = summaryFromAttempts(attempts);
        expect(detectComparisonAttemptDrift(attempts)).toEqual(["served_identity_drift"]);
        // Clean qualification + unblocked summary while records show drift ⇒ rejected.
        expect(isComparisonQualificationConsistentWith(validQualification(), attempts, [summary])).toBe(false);
        // Qualification carries the reason but the summary omits it ⇒ rejected.
        const blockedQual: ComparisonQualificationResult = {
            ...validQualification(),
            blocked: true,
            blockedReasons: ["served_identity_drift"],
            qualified: false,
        };
        expect(isComparisonQualificationConsistentWith(blockedQual, attempts, [summary])).toBe(false);
        // Both carry it ⇒ accepted, and a blocked arm never selects.
        const blockedSummary = summaryFromAttempts(attempts, { blockedReasons: ["served_identity_drift"] });
        expect(isComparisonQualificationConsistentWith(blockedQual, attempts, [blockedSummary])).toBe(true);
        expect(isComparisonQualificationConsistentWith(
            { ...blockedQual, qualified: true },
            attempts,
            [blockedSummary],
        )).toBe(false);
    });

    it("rejects a declared drift reason the attempt records do not produce", () => {
        const attempts = [validAttempt({ attemptId: "clean-1" })];
        const qual: ComparisonQualificationResult = {
            ...validQualification(),
            blocked: true,
            blockedReasons: ["payload_drift"],
            qualified: false,
        };
        const summary = summaryFromAttempts(attempts, { blockedReasons: ["payload_drift"] });
        expect(detectComparisonAttemptDrift(attempts)).toEqual([]);
        expect(isComparisonQualificationConsistentWith(qual, attempts, [summary])).toBe(false);
    });

    it("binds summary counts to the attempt records", () => {
        const attempts = binderAttempts();
        const summary = summaryFromAttempts(attempts);
        expect(summary.attemptedRequests).toBe(4);
        expect(summary.warmupAttempts).toBe(1);
        expect(summary.successfulResponses).toBe(3);
        expect(isComparisonQualificationConsistentWith(validQualification(), attempts, [summary])).toBe(true);

        // Validator-valid on their own, but disagreeing with the records ⇒ rejected.
        expect(isComparisonArmRunSummary({ ...summary, warmupAttempts: 0 })).toBe(true);
        expect(isComparisonQualificationConsistentWith(validQualification(), attempts, [{ ...summary, warmupAttempts: 0 }])).toBe(false);
        expect(isComparisonQualificationConsistentWith(validQualification(), attempts, [{ ...summary, successfulResponses: 4 }])).toBe(false);
        expect(isComparisonQualificationConsistentWith(validQualification(), attempts, [{ ...summary, attemptedRequests: 5 }])).toBe(false);

        // Unknown-cost partition and retained reserve must match the records.
        const swapped: ComparisonArmRunSummary = {
            ...summary,
            knownCostAttempts: 2,
            unknownCostAttempts: 2,
            unknownCostReserveUsd: 2 * PPLX_PER_ATTEMPT_RESERVE,
        };
        expect(isComparisonArmRunSummary(swapped)).toBe(true);
        expect(isComparisonQualificationConsistentWith(validQualification(), attempts, [swapped])).toBe(false);
        expect(isComparisonQualificationConsistentWith(
            validQualification(),
            attempts,
            [{ ...summary, unknownCostReserveUsd: 2 * PPLX_PER_ATTEMPT_RESERVE }],
        )).toBe(false);
    });

    it("rejects invalid records, foreign arms, missing/duplicate summaries, and invalid qualifications", () => {
        const attempts = binderAttempts();
        const summary = summaryFromAttempts(attempts);
        expect(isComparisonQualificationConsistentWith(validQualification(), attempts, [])).toBe(false);
        expect(isComparisonQualificationConsistentWith(validQualification(), attempts, [summary, { ...summary }])).toBe(false);
        expect(isComparisonQualificationConsistentWith(validQualification(), [...attempts, validAttempt({
            attemptId: "foreign-1",
            arm: "~typesafe/jev-latest",
        })], [summary])).toBe(false);
        expect(isComparisonQualificationConsistentWith(validQualification(), [...attempts, {
            ...validAttempt({ attemptId: "smuggled-1" }),
            apiKey: "sk-not-allowed",
        }], [summary])).toBe(false);
        expect(isComparisonQualificationConsistentWith({ ...validQualification(), gates: [] }, attempts, [summary])).toBe(false);
        // A blocked arm can never be selected, even when everything else agrees.
        expect(isComparisonQualificationConsistentWith({
            ...validQualification(),
            blocked: true,
            blockedReasons: ["missing_probability"],
            qualified: true,
        }, attempts, [summary])).toBe(false);
    });
});

describe("FROZEN_PLANNED_UNITS_DIGEST (frozen fixture identity)", () => {
    fixtureIt("recomputes the frozen digest from the fixture file through loadSetRows — fixture-gated", () => {
        const units = fixturePlannedUnits();
        expect(units).toHaveLength(FROZEN_CORPUS_UNITS);
        expect(plannedUnitsDigest(units)).toBe(FROZEN_PLANNED_UNITS_DIGEST);
        // The canonical form sorts, so input order cannot move the digest.
        expect(plannedUnitsDigest([...units].reverse())).toBe(FROZEN_PLANNED_UNITS_DIGEST);
        expect(canonicalPlannedUnitsSerialization(units))
            .toBe(canonicalPlannedUnitsSerialization([...units].reverse()));
    });

    fixtureIt("verifies the fixture file sha256 (set-a ∥ set-b raw bytes via loadSetRows) is the frozen 2e9fa411… value — fixture-gated", () => {
        const rawBytes = loadSetRows("a", PLAN_DATA_DIR).rawBytes + loadSetRows("b", PLAN_DATA_DIR).rawBytes;
        expect(createHash("sha256").update(rawBytes, "utf-8").digest("hex"))
            .toBe("2e9fa4117b7003e50581ec1c32d2b17c9c211b655bd9a9002a47961f2b871f9b");
    });
});

describe("isComparisonReportConsistent (planned coverage / outcomes / averages)", () => {
    const REPORT_ARM = "perplexity/pplx-decider-v1.1-27b";

    function unitPayloadHash(unitIndex: number): string {
        return unitIndex.toString(16).padStart(8, "0").repeat(8);
    }

    function reportProbability(unitIndex: number, replica: number): number {
        return ((unitIndex * 5 + replica) % 89 + 1) / 100;
    }

    type FullReport = {
        qualification: ComparisonQualificationResult;
        attempts: ComparisonAttemptRecord[];
        summaries: ComparisonArmRunSummary[];
        outcomes: ComparisonScoredOutcome[];
        unitAverages: ComparisonUnitAverage[];
        plannedUnits: ComparisonPlannedUnit[];
    };

    function reportSummary(
        attempts: readonly ComparisonAttemptRecord[],
        unitsWithValidAverage: number,
        unitsUnjudged: number,
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
            if (record.httpStatus !== null && record.httpStatus >= 200 && record.httpStatus <= 299 && record.errorClass === null) {
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
        return {
            arm: REPORT_ARM,
            replicasPlanned: 5,
            replicasObserved: observedReplicas.size,
            unitsPlanned: 314,
            unitsWithValidAverage,
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

    /** Coverage-derived gates must match the records: availability = successful/attempted, unjudged = units/314. */
    function reportQualification(): ComparisonQualificationResult {
        const gates = passingGates().map((gate) =>
            gate.gate === "availability" ? { ...gate, value: 1 } : gate);
        return { ...validQualification(), gates };
    }

    function withGates(
        qualification: ComparisonQualificationResult,
        overrides: { availability?: number; unjudged?: number },
    ): ComparisonQualificationResult {
        return {
            ...qualification,
            gates: qualification.gates.map((gate) => {
                const value = overrides[gate.gate as "availability" | "unjudged"];
                return value === undefined ? gate : { ...gate, value };
            }),
        };
    }

    function fullReport(): FullReport {
        const plannedUnits = fixturePlannedUnits();
        const attempts: ComparisonAttemptRecord[] = [validAttempt({
            attemptId: "rep-warmup",
            warmup: true,
            queryGroup: null,
            probability: null,
            payloadSha256: "ff".repeat(32),
            inputTokens: null,
            outputTokens: null,
        })];
        const outcomes: ComparisonScoredOutcome[] = [];
        const unitAverages: ComparisonUnitAverage[] = [];
        plannedUnits.forEach((unit, unitIndex) => {
            const probabilities: number[] = [];
            for (let replica = 0; replica < FROZEN_REPLICA_COUNT; replica += 1) {
                const probability = reportProbability(unitIndex, replica);
                probabilities.push(probability);
                attempts.push(validAttempt({
                    attemptId: `rep-${unitIndex}-${replica}`,
                    queryGroup: unit.queryGroup,
                    unitId: unit.unitId,
                    replica,
                    payloadSha256: unitPayloadHash(unitIndex),
                    probability,
                    cost: { status: "known", usd: 0.00001 },
                }));
                outcomes.push({
                    arm: REPORT_ARM,
                    queryGroup: unit.queryGroup,
                    unitId: unit.unitId,
                    file: unit.file,
                    replica,
                    truth: unit.truth,
                    probability,
                    attemptIds: [`rep-${unitIndex}-${replica}`],
                });
            }
            unitAverages.push({
                arm: REPORT_ARM,
                queryGroup: unit.queryGroup,
                unitId: unit.unitId,
                file: unit.file,
                truth: unit.truth,
                replicasAveraged: FROZEN_REPLICA_COUNT,
                averageProbability: probabilities.reduce((sum, p) => sum + p, 0) / FROZEN_REPLICA_COUNT,
            });
        });
        return {
            qualification: reportQualification(),
            attempts,
            summaries: [reportSummary(attempts, plannedUnits.length, 0)],
            outcomes,
            unitAverages,
            plannedUnits,
        };
    }

    /** Rebuild the arm summary from the current attempt list after attempt mutations. */
    function resummarize(report: FullReport): void {
        const unjudged = report.unitAverages.filter((average) => average.averageProbability === null).length;
        report.summaries = [reportSummary(report.attempts, report.unitAverages.length - unjudged, unjudged)];
    }

    function reportConsistent(mutate?: (report: FullReport) => void): boolean {
        const report = fullReport();
        mutate?.(report);
        return isComparisonReportConsistent(report);
    }

    function successCount(report: FullReport): number {
        return report.attempts.filter((attempt) => attempt.httpStatus !== null && attempt.httpStatus >= 200
            && attempt.httpStatus <= 299 && attempt.errorClass === null).length;
    }

    fixtureIt("accepts a fully bound report; exposes the empty-attempt hole in the attempt-level binder alone — fixture-gated", () => {
        const report = fullReport();
        expect(isComparisonReportConsistent(report)).toBe(true);
        // P1: the attempt-level binder does not bind planned coverage — zero
        // attempts accompany a validator-valid summary claiming 313 valid units.
        const emptySummary = summaryFromAttempts([]);
        expect(isComparisonArmRunSummary(emptySummary)).toBe(true);
        expect(isComparisonQualificationConsistentWith(validQualification(), [], [emptySummary])).toBe(true);
        // The full gate fails closed on that same report.
        expect(isComparisonReportConsistent({
            ...report,
            attempts: [],
            summaries: [emptySummary],
            outcomes: [],
            unitAverages: [],
        })).toBe(false);
    });

    fixtureIt("rejects any missing scored outcome (unit or replica capture gap) — fixture-gated", () => {
        // One replica missing for the last planned unit.
        expect(reportConsistent((r) => { r.outcomes.pop(); })).toBe(false);
        // Every replica missing for one planned unit.
        expect(reportConsistent((r) => {
            r.outcomes = r.outcomes.filter((outcome) =>
                !(outcome.queryGroup === "a:q01" && outcome.unitId === "u0"));
        })).toBe(false);
        // A sixth outcome (duplicate replica) for one planned unit.
        expect(reportConsistent((r) => {
            const duplicate = r.outcomes.find((outcome) =>
                outcome.queryGroup === "a:q01" && outcome.unitId === "u0" && outcome.replica === 4)!;
            r.outcomes.push({ ...duplicate });
        })).toBe(false);
    });

    fixtureIt("rejects outcomes outside the planned corpus or for a foreign arm — fixture-gated", () => {
        expect(reportConsistent((r) => {
            r.outcomes.push({ ...r.outcomes[0]!, queryGroup: "a:q99" });
        })).toBe(false); // unplanned query group
        expect(reportConsistent((r) => {
            r.outcomes.push({ ...r.outcomes[0]!, unitId: "u99" });
        })).toBe(false); // unit id outside the group's packed unit set
        expect(reportConsistent((r) => { r.outcomes[0]!.arm = "~typesafe/jev-latest"; })).toBe(false);
        expect(reportConsistent((r) => { r.unitAverages[0]!.arm = "~typesafe/jev-latest"; })).toBe(false);
    });

    fixtureIt("rejects outcome identity that disagrees with the planned unit — fixture-gated", () => {
        // Planned-unit file swapped: outcomes and averages stay self-consistent,
        // so only the planned-identity binding can reject.
        expect(reportConsistent((r) => {
            r.plannedUnits[0] = { ...r.plannedUnits[0]!, file: "src/gen/swapped.ts" };
        })).toBe(false);
        // Truth swapped between two units: group count and the frozen
        // 78/148/88 composition both hold, so only identity binding rejects.
        expect(reportConsistent((r) => {
            const goldIndex = r.plannedUnits.findIndex((unit) => unit.truth === "gold");
            const hardIndex = r.plannedUnits.findIndex((unit) => unit.truth === "hard-negative");
            const gold = r.plannedUnits[goldIndex]!;
            const hard = r.plannedUnits[hardIndex]!;
            r.plannedUnits[goldIndex] = { ...gold, truth: "hard-negative" };
            r.plannedUnits[hardIndex] = { ...hard, truth: "gold" };
        })).toBe(false);
    });

    fixtureIt("rejects attempt links that are missing, ghost, warmup, foreign, or incomplete — fixture-gated", () => {
        // Ghost attempt id.
        expect(reportConsistent((r) => { r.outcomes[0]!.attemptIds = ["ghost-attempt"]; })).toBe(false);
        // Warmup record instead of the scored attempt.
        expect(reportConsistent((r) => { r.outcomes[0]!.attemptIds = ["rep-warmup"]; })).toBe(false);
        // Another replica's attempt.
        expect(reportConsistent((r) => { r.outcomes[0]!.attemptIds = ["rep-0-1"]; })).toBe(false);
        // An attempt from a different query group with the same packed unit id
        // (unit ids repeat across groups, so the group check is load-bearing).
        expect(reportConsistent((r) => { r.outcomes[0]!.attemptIds = ["rep-8-0"]; })).toBe(false);
        // A retry dispatched but not linked by the outcome.
        expect(reportConsistent((r) => {
            r.attempts.push(validAttempt({
                attemptId: "rep-0-0-retry",
                queryGroup: "a:q01",
                unitId: "u0",
                replica: 0,
                attemptIndex: 2,
                payloadSha256: unitPayloadHash(0),
                probability: reportProbability(0, 0),
            }));
            resummarize(r);
        })).toBe(false);
    });

    fixtureIt("accepts a linked retry carrying the same probability — fixture-gated", () => {
        expect(reportConsistent((r) => {
            r.attempts.push(validAttempt({
                attemptId: "rep-0-0-retry",
                queryGroup: "a:q01",
                unitId: "u0",
                replica: 0,
                attemptIndex: 2,
                payloadSha256: unitPayloadHash(0),
                probability: reportProbability(0, 0),
            }));
            r.outcomes[0]!.attemptIds = ["rep-0-0", "rep-0-0-retry"];
            resummarize(r);
        })).toBe(true);
    });

    fixtureIt("rejects a probability that disagrees with the linked successful attempts — fixture-gated", () => {
        // Outcome probability drifted from the recorded attempt; the unit
        // average is re-derived from the outcome so only the link binding rejects.
        expect(reportConsistent((r) => {
            r.outcomes[0] = { ...r.outcomes[0]!, probability: 0.42 };
            const probabilities = r.outcomes.slice(0, FROZEN_REPLICA_COUNT)
                .map((outcome) => outcome.probability).filter((p): p is number => p !== null);
            r.unitAverages[0] = {
                ...r.unitAverages[0]!,
                averageProbability: probabilities.reduce((sum, p) => sum + p, 0) / FROZEN_REPLICA_COUNT,
            };
        })).toBe(false);
        // Attempt succeeded but the outcome claims null (average, summary, and
        // gates updated so the probability binding is the only disagreement).
        expect(reportConsistent((r) => {
            r.outcomes[0] = { ...r.outcomes[0]!, probability: null };
            r.unitAverages[0] = { ...r.unitAverages[0]!, replicasAveraged: FROZEN_REPLICA_COUNT - 1, averageProbability: null };
            resummarize(r);
            r.qualification = withGates(r.qualification, { unjudged: 1 / FROZEN_CORPUS_UNITS });
        })).toBe(false);
    });

    fixtureIt("accepts a recorded-unjudged unit and rejects a claimed probability with no successful attempt — fixture-gated", () => {
        const failAllReplicas = (r: FullReport): void => {
            for (let replica = 0; replica < FROZEN_REPLICA_COUNT; replica += 1) {
                const attemptId = `rep-0-${replica}`;
                const index = r.attempts.findIndex((attempt) => attempt.attemptId === attemptId);
                r.attempts[index] = { ...r.attempts[index]!, probability: null, errorClass: "bad_response" };
                r.outcomes[replica] = { ...r.outcomes[replica]!, probability: null };
            }
            r.unitAverages[0] = { ...r.unitAverages[0]!, replicasAveraged: 0, averageProbability: null };
            resummarize(r);
            r.qualification = withGates(r.qualification, {
                availability: successCount(r) / r.attempts.length,
                unjudged: 1 / FROZEN_CORPUS_UNITS,
            });
        };
        // Complete capture, recorded unjudged unit: no block, no gate problem.
        expect(reportConsistent(failAllReplicas)).toBe(true);
        // Same capture, but one outcome still claims a probability although
        // no linked attempt succeeded.
        expect(reportConsistent((r) => {
            failAllReplicas(r);
            r.outcomes[0] = { ...r.outcomes[0]!, probability: reportProbability(0, 0) };
        })).toBe(false);
    });

    fixtureIt("rejects dropped or duplicated dispatched records (attemptIndex ledger) — fixture-gated", () => {
        // Gap: attemptIndex jumps from 1 to 3 for one unit/replica.
        expect(reportConsistent((r) => {
            r.attempts.push(validAttempt({
                attemptId: "rep-0-0-gap",
                queryGroup: "a:q01",
                unitId: "u0",
                replica: 0,
                attemptIndex: 3,
                payloadSha256: unitPayloadHash(0),
            }));
            resummarize(r);
        })).toBe(false);
        // Duplicate attemptIndex for the same unit/replica.
        expect(reportConsistent((r) => {
            r.attempts.push(validAttempt({
                attemptId: "rep-0-0-dup",
                queryGroup: "a:q01",
                unitId: "u0",
                replica: 0,
                attemptIndex: 1,
                payloadSha256: unitPayloadHash(0),
            }));
            resummarize(r);
        })).toBe(false);
        // Duplicate attemptId across warmups (never linked to an outcome).
        expect(reportConsistent((r) => {
            r.attempts.push(validAttempt({
                attemptId: "rep-warmup",
                warmup: true,
                queryGroup: null,
                unitId: "u0",
                probability: null,
                payloadSha256: "ff".repeat(32),
                inputTokens: null,
                outputTokens: null,
            }));
            resummarize(r);
        })).toBe(false);
    });

    fixtureIt("rejects attempts for units outside the planned corpus — fixture-gated", () => {
        expect(reportConsistent((r) => {
            r.attempts.push(validAttempt({
                attemptId: "stray-1",
                queryGroup: "a:q99",
                unitId: "u0",
                payloadSha256: unitPayloadHash(9999),
            }));
            resummarize(r);
        })).toBe(false);
    });

    fixtureIt("rejects a missing, duplicate, or underived unit average — fixture-gated", () => {
        // Missing average for the last planned unit.
        expect(reportConsistent((r) => { r.unitAverages.pop(); })).toBe(false);
        // Duplicate average for an already-covered unit.
        expect(reportConsistent((r) => { r.unitAverages.push({ ...r.unitAverages[0]! }); })).toBe(false);
        // Tampered mean for the unit.
        expect(reportConsistent((r) => {
            const average = r.unitAverages[0]!;
            r.unitAverages[0] = { ...average, averageProbability: (average.averageProbability ?? 0) + 0.01 };
        })).toBe(false);
    });

    fixtureIt("rejects summary coverage or cost claims that disagree with the recomputed values — fixture-gated", () => {
        // 313/1 is validator-valid (sums to 314) but disagrees with the averages.
        expect(reportConsistent((r) => {
            r.summaries[0] = { ...r.summaries[0]!, unitsWithValidAverage: 313, unitsUnjudged: 1 };
        })).toBe(false);
        // Observed replicas claim below the 0..4 the attempts show.
        expect(reportConsistent((r) => { r.summaries[0] = { ...r.summaries[0]!, replicasObserved: 4 }; })).toBe(false);
        // Known-cost claim above the sum of the known records.
        expect(reportConsistent((r) => {
            r.summaries[0] = { ...r.summaries[0]!, knownCostUsd: r.summaries[0]!.knownCostUsd + 0.001 };
        })).toBe(false);
    });

    fixtureIt("rejects availability or unjudged gate values that disagree with the records — fixture-gated", () => {
        // Records show 1571/1571 = 1.
        expect(reportConsistent((r) => {
            r.qualification = withGates(r.qualification, { availability: 0.999 });
        })).toBe(false);
        // Records show 0/314 unjudged units.
        expect(reportConsistent((r) => {
            r.qualification = withGates(r.qualification, { unjudged: 0.01 });
        })).toBe(false);
        // A null availability value cannot claim missing data the records disprove.
        expect(reportConsistent((r) => {
            const gates = r.qualification.gates.map((gate) => gate.gate === "availability"
                ? { ...gate, value: null, ciLow: null, ciHigh: null, pass: null }
                : gate);
            r.qualification = {
                ...r.qualification,
                gates,
                blocked: true,
                blockedReasons: ["missing_probability"],
                qualified: false,
            };
        })).toBe(false);
    });

    fixtureIt("rejects a planned unit set that is not the frozen corpus — fixture-gated", () => {
        // Wrong size (313 units).
        expect(reportConsistent((r) => { r.plannedUnits.pop(); })).toBe(false);
        // Duplicate (queryGroup, unitId) key at constant size; group count and
        // truth composition still hold, so only the uniqueness check rejects.
        expect(reportConsistent((r) => {
            const last = r.plannedUnits[r.plannedUnits.length - 1]!;
            const first = r.plannedUnits[0]!;
            r.plannedUnits[r.plannedUnits.length - 1] = {
                ...last,
                queryGroup: first.queryGroup,
                unitId: first.unitId,
            };
        })).toBe(false);
        // Group count: one group loses its last unit (44 → 43).
        expect(reportConsistent((r) => {
            const last = r.plannedUnits[r.plannedUnits.length - 1]!;
            const first = r.plannedUnits[0]!;
            r.plannedUnits[r.plannedUnits.length - 1] = {
                ...last,
                queryGroup: first.queryGroup,
                unitId: "u99",
            };
        })).toBe(false);
        // Truth composition drifts off the frozen 78/148/88.
        expect(reportConsistent((r) => {
            const goldIndex = r.plannedUnits.findIndex((unit) => unit.truth === "gold");
            r.plannedUnits[goldIndex] = { ...r.plannedUnits[goldIndex]!, truth: "hard-negative" };
        })).toBe(false);
        // Structurally invalid planned record.
        expect(reportConsistent((r) => {
            delete (r.plannedUnits[0] as Partial<ComparisonPlannedUnit>).file;
        })).toBe(false);
    });

    fixtureIt("requires the incumbent baseline in the report gate — fixture-gated", () => {
        // The per-record guard accepts any frozen arm as baseline…
        expect(isComparisonQualificationResult({
            ...validQualification(),
            baseline: "openai/gpt-6-luna-decisions",
        })).toBe(true);
        // …but the report gate fails closed on a non-incumbent baseline.
        expect(reportConsistent((r) => {
            r.qualification = { ...r.qualification, baseline: "openai/gpt-6-luna-decisions" };
        })).toBe(false);
    });

    fixtureIt("rejects renamed groups and paths even when attempts, outcomes, and averages are updated consistently — fixture-gated", () => {
        const report = fullReport();
        const renameGroup = (group: string): string => `renamed:${group}`;
        const renameFile = (file: string): string => `renamed/${file}`;
        for (const unit of report.plannedUnits) {
            unit.queryGroup = renameGroup(unit.queryGroup);
            unit.file = renameFile(unit.file);
        }
        for (const attempt of report.attempts) {
            if (attempt.queryGroup !== null) attempt.queryGroup = renameGroup(attempt.queryGroup);
        }
        for (const outcome of report.outcomes) {
            outcome.queryGroup = renameGroup(outcome.queryGroup);
            outcome.file = renameFile(outcome.file);
        }
        for (const average of report.unitAverages) {
            average.queryGroup = renameGroup(average.queryGroup);
            average.file = renameFile(average.file);
        }
        // Composition (314 / 44 / 78-148-88) and every internal link still
        // hold after the consistent rename — only the frozen fixture digest
        // can reject the report (the reviewer's P1a counterexample).
        expect(isComparisonReportConsistent(report)).toBe(false);
    });

    fixtureIt("rejects a fully passing report whose qualification records qualified: false — fixture-gated", () => {
        const report = fullReport();
        expect(report.qualification.qualified).toBe(true);
        expect(isComparisonQualificationResult(report.qualification)).toBe(true);
        report.qualification = { ...report.qualification, qualified: false };
        // The reviewer's P1b counterexample: gates all pass and the arm is
        // unblocked, yet qualified claims false — the gate must reject it.
        expect(isComparisonReportConsistent(report)).toBe(false);
    });

    it("guards planned-unit records fail-closed", () => {
        expect(isComparisonPlannedUnit({
            queryGroup: "a:q01", unitId: "u0", file: "src/search/grep-cascade.ts", truth: "gold",
        })).toBe(true);
        expect(isComparisonPlannedUnit({
            queryGroup: "a:q01", unitId: "u0", file: "src/x.ts", truth: "gold", extra: 1,
        })).toBe(false);
        expect(isComparisonPlannedUnit({ queryGroup: "", unitId: "u0", file: "src/x.ts", truth: "gold" })).toBe(false);
        expect(isComparisonPlannedUnit({ queryGroup: "a:q01", unitId: "u0", file: "src/x.ts", truth: "gold_hard" })).toBe(false);
        expect(isComparisonPlannedUnit(null)).toBe(false);
    });
});

describe("attempt provenance (attemptId / provider / payloadSha256)", () => {
    it("requires all three fields, non-empty, fail-closed", () => {
        expect(isComparisonAttemptRecord(validAttempt())).toBe(true);
        const noAttemptId = { ...validAttempt() } as Partial<ComparisonAttemptRecord>;
        delete noAttemptId.attemptId;
        expect(isComparisonAttemptRecord(noAttemptId)).toBe(false);
        const noProvider = { ...validAttempt() } as Partial<ComparisonAttemptRecord>;
        delete noProvider.provider;
        expect(isComparisonAttemptRecord(noProvider)).toBe(false);
        const noHash = { ...validAttempt() } as Partial<ComparisonAttemptRecord>;
        delete noHash.payloadSha256;
        expect(isComparisonAttemptRecord(noHash)).toBe(false);
        expect(isComparisonAttemptRecord(validAttempt({ attemptId: "" }))).toBe(false);
    });

    it("records provider only when returned, never inferred", () => {
        expect(isComparisonAttemptRecord(validAttempt({ provider: "OpenAI" }))).toBe(true);
        expect(isComparisonAttemptRecord(validAttempt({ provider: "" }))).toBe(false);
        expect(isComparisonAttemptRecord(validAttempt({ provider: 42 as never }))).toBe(false);
    });

    it("requires a canonical lowercase hex sha256 payload hash", () => {
        expect(isComparisonAttemptRecord(validAttempt({ payloadSha256: "a".repeat(64) }))).toBe(true);
        expect(isComparisonAttemptRecord(validAttempt({ payloadSha256: "A".repeat(64) }))).toBe(false);
        expect(isComparisonAttemptRecord(validAttempt({ payloadSha256: "z".repeat(64) }))).toBe(false);
        expect(isComparisonAttemptRecord(validAttempt({ payloadSha256: "ab".repeat(31) }))).toBe(false); // 62 chars
        expect(isComparisonAttemptRecord(validAttempt({ payloadSha256: "" }))).toBe(false);
    });
});

describe("detectComparisonAttemptDrift (served identity / payload)", () => {
    const hashA = "aa".repeat(32);
    const hashB = "bb".repeat(32);

    it("returns no reasons for empty or consistent inputs", () => {
        expect(detectComparisonAttemptDrift([])).toEqual([]);
        expect(detectComparisonAttemptDrift([
            validAttempt({ attemptId: "a1", replica: 0, payloadSha256: hashA }),
            validAttempt({ attemptId: "a2", replica: 1, payloadSha256: hashA }),
            validAttempt({ attemptId: "a3", replica: 0, attemptIndex: 2, payloadSha256: hashA }),
            transportFailureAttempt({ attemptId: "a4", replica: 2, payloadSha256: hashA }),
        ])).toEqual([]);
    });

    it("blocks a served identity differing from the per-arm allowlist value", () => {
        // The requested slug is NOT the allowlisted value: the pre-data pinned snapshot is.
        expect(detectComparisonAttemptDrift([
            validAttempt({ servedModel: "perplexity/pplx-decider-v1.1-27b" }),
        ])).toEqual(["served_identity_drift"]);
        // Another arm's pin on the wrong arm also drifts.
        expect(detectComparisonAttemptDrift([
            validAttempt({ servedModel: "openai/gpt-6-luna-decisions-20261006" }),
        ])).toEqual(["served_identity_drift"]);
        // An absent response (servedModel null) is not drift.
        expect(detectComparisonAttemptDrift([transportFailureAttempt()])).toEqual([]);
    });

    it("blocks payload drift across retries or replicas of the same unit", () => {
        expect(detectComparisonAttemptDrift([
            validAttempt({ attemptId: "a1", replica: 0, payloadSha256: hashA }),
            validAttempt({ attemptId: "a2", replica: 1, payloadSha256: hashB }),
        ])).toEqual(["payload_drift"]);
        expect(detectComparisonAttemptDrift([
            validAttempt({ attemptId: "a1", attemptIndex: 1, payloadSha256: hashA }),
            validAttempt({ attemptId: "a2", attemptIndex: 2, payloadSha256: hashB }),
        ])).toEqual(["payload_drift"]);
        // Different query groups are different payloads by design…
        expect(detectComparisonAttemptDrift([
            validAttempt({ attemptId: "g1", queryGroup: "a:q01", payloadSha256: hashA }),
            validAttempt({ attemptId: "g2", queryGroup: "b:B01", payloadSha256: hashB }),
        ])).toEqual([]);
        // …and warmups are their own payload unit (never merged with scored u0).
        expect(detectComparisonAttemptDrift([
            validAttempt({
                attemptId: "w1",
                warmup: true,
                queryGroup: null,
                unitId: "u0",
                probability: null,
                inputTokens: null,
                outputTokens: null,
                payloadSha256: hashA,
            }),
            validAttempt({ attemptId: "s1", unitId: "u0", payloadSha256: hashB }),
        ])).toEqual([]);
    });

    it("reports both reasons in frozen order and throws on invalid records", () => {
        expect(detectComparisonAttemptDrift([
            validAttempt({ attemptId: "a1", servedModel: "other/snapshot-1", payloadSha256: hashA }),
            validAttempt({ attemptId: "a2", replica: 1, payloadSha256: hashB }),
        ])).toEqual(["served_identity_drift", "payload_drift"]);
        const invalid = { ...validAttempt(), apiKey: "sk-not-recorded" } as ComparisonAttemptRecord;
        expect(() => detectComparisonAttemptDrift([invalid])).toThrow(/invalid attempt record/);
    });
});

describe("scored-outcome records (arm × unit × replica)", () => {
    it("accepts well-formed records including recorded unjudged outcomes", () => {
        expect(isComparisonScoredOutcome(validOutcome())).toBe(true);
        expect(isComparisonScoredOutcome(
            validOutcome({ probability: null, attemptIds: ["att-fail-1", "att-fail-2"] }),
        )).toBe(true);
        expect(isComparisonScoredOutcome(
            validOutcome({ replica: 4, truth: "other-negative", file: "src/search/find-symbol-tool.ts" }),
        )).toBe(true);
        expect(isComparisonScoredOutcome(validOutcome({ truth: "hard-negative", probability: 0.05 }))).toBe(true);
    });

    it("rejects malformed identity, truth, probability, and links", () => {
        // Fixture spelling must be mapped by truthClassFromFixtureLabel first.
        expect(isComparisonScoredOutcome({ ...validOutcome(), truth: "hard_negative" })).toBe(false);
        expect(isComparisonScoredOutcome({ ...validOutcome(), truth: "answerable" })).toBe(false);
        expect(isComparisonScoredOutcome({ ...validOutcome(), probability: 1.2 })).toBe(false);
        expect(isComparisonScoredOutcome({ ...validOutcome(), probability: Number.NaN })).toBe(false);
        expect(isComparisonScoredOutcome({ ...validOutcome(), probability: undefined })).toBe(false);
        expect(isComparisonScoredOutcome({ ...validOutcome(), replica: 5 })).toBe(false);
        expect(isComparisonScoredOutcome({ ...validOutcome(), replica: 1.5 })).toBe(false);
        expect(isComparisonScoredOutcome({ ...validOutcome(), attemptIds: [] })).toBe(false);
        expect(isComparisonScoredOutcome({ ...validOutcome(), attemptIds: ["dup", "dup"] })).toBe(false);
        expect(isComparisonScoredOutcome({ ...validOutcome(), attemptIds: [""] })).toBe(false);
        const missing = { ...validOutcome() } as Partial<ComparisonScoredOutcome>;
        delete missing.file;
        expect(isComparisonScoredOutcome(missing)).toBe(false);
        expect(isComparisonScoredOutcome({ ...validOutcome(), extra: 1 })).toBe(false);
        expect(isComparisonScoredOutcome(null)).toBe(false);
        expect(isComparisonScoredOutcome("a:q01")).toBe(false);
    });
});

describe("truthClassFromFixtureLabel (fixture-derived truth)", () => {
    it("maps the three fixture labels 1:1 and fails closed otherwise", () => {
        expect(truthClassFromFixtureLabel("gold")).toBe("gold");
        expect(truthClassFromFixtureLabel("hard_negative")).toBe("hard-negative");
        expect(truthClassFromFixtureLabel("easy_negative")).toBe("other-negative");
        expect(truthClassFromFixtureLabel("hard-negative")).toBeNull(); // policy spelling is not a fixture label
        expect(truthClassFromFixtureLabel("answerable")).toBeNull();
        expect(truthClassFromFixtureLabel(null)).toBeNull();
        expect(truthClassFromFixtureLabel(7)).toBeNull();
    });
});

describe("replica-averaged unit records", () => {
    it("accepts all-five averages and null partial averages", () => {
        expect(isComparisonUnitAverage(validAverage())).toBe(true);
        expect(isComparisonUnitAverage(validAverage({ replicasAveraged: 4, averageProbability: null }))).toBe(true);
        expect(isComparisonUnitAverage(validAverage({ replicasAveraged: 0, averageProbability: null }))).toBe(true);
    });

    it("rejects convention averages (partial non-null, full-five null)", () => {
        expect(isComparisonUnitAverage(validAverage({ replicasAveraged: 4, averageProbability: 0.8 }))).toBe(false);
        expect(isComparisonUnitAverage(validAverage({ replicasAveraged: 5, averageProbability: null }))).toBe(false);
        expect(isComparisonUnitAverage(validAverage({ replicasAveraged: 6, averageProbability: 0.8 }))).toBe(false);
        expect(isComparisonUnitAverage(validAverage({ averageProbability: -0.01 }))).toBe(false);
        expect(isComparisonUnitAverage(validAverage({ averageProbability: 1.01 }))).toBe(false);
        const missing = { ...validAverage() } as Partial<ComparisonUnitAverage>;
        delete missing.truth;
        expect(isComparisonUnitAverage(missing)).toBe(false);
    });

    it("binds the average to its outcome rows", () => {
        const outcomes = [0, 1, 2, 3, 4].map((replica) =>
            validOutcome({ replica, probability: 0.8, attemptIds: [`att-r${replica}-1`] }));
        expect(isComparisonUnitAverageDerivedFrom(outcomes, validAverage({ averageProbability: 0.8 }))).toBe(true);

        // Ascending-replica mean with float noise inside the 1e-12 tolerance.
        const varied = [0, 1, 2, 3, 4].map((replica) =>
            validOutcome({ replica, probability: (replica + 1) / 10, attemptIds: [`att-r${replica}-1`] }));
        expect(isComparisonUnitAverageDerivedFrom(varied, validAverage({ averageProbability: 0.3 }))).toBe(true);

        // Tampered mean and mismatched identity reject.
        expect(isComparisonUnitAverageDerivedFrom(outcomes, validAverage({ averageProbability: 0.81 }))).toBe(false);
        expect(isComparisonUnitAverageDerivedFrom(
            outcomes,
            validAverage({ file: "src/search/grep-cascade-2.ts" }),
        )).toBe(false);
        expect(isComparisonUnitAverageDerivedFrom(outcomes, validAverage({ unitId: "u1" }))).toBe(false);

        // Empty outcome sets and duplicate replicas reject.
        expect(isComparisonUnitAverageDerivedFrom(
            [],
            validAverage({ replicasAveraged: 0, averageProbability: null }),
        )).toBe(false);
        const duplicate = [outcomes[0]!, outcomes[0]!, ...outcomes.slice(2)];
        expect(isComparisonUnitAverageDerivedFrom(duplicate, validAverage({ averageProbability: 0.8 }))).toBe(false);

        // Partial replicas: the average must be null.
        const partial = outcomes.map((outcome, index) =>
            index === 4 ? { ...outcome, probability: null } : outcome);
        expect(isComparisonUnitAverageDerivedFrom(
            partial,
            validAverage({ replicasAveraged: 4, averageProbability: null }),
        )).toBe(true);
        expect(isComparisonUnitAverageDerivedFrom(partial, validAverage({ averageProbability: 0.8 }))).toBe(false);

        // Invalid members reject.
        expect(isComparisonUnitAverageDerivedFrom(
            [{ ...outcomes[0]!, truth: "nope" }],
            validAverage({ replicasAveraged: 1, averageProbability: null }),
        )).toBe(false);
    });
});

describe("frozen policy constants (Object.freeze)", () => {
    it("exposes the new blocked reasons", () => {
        expect([...COMPARISON_BLOCKED_REASONS]).toEqual([
            "missing_probability",
            "incomplete_cost_record",
            "aborted_run",
            "degenerate_bootstrap",
            "served_identity_drift",
            "payload_drift",
            "undefined_precision",
        ]);
        expect(Object.isFrozen(COMPARISON_BLOCKED_REASONS)).toBe(true);
        expect(Object.isFrozen(COMPARISON_GATE_IDS)).toBe(true);
        expect(Object.isFrozen(COMPARISON_GATE_THRESHOLDS)).toBe(true);
        expect(Object.isFrozen(COMPARISON_TRUTH_CLASSES)).toBe(true);
        expect(Object.isFrozen(COMPARISON_SERVED_MODEL_ALLOWLIST)).toBe(true);
    });

    it("matches the pre-data PLAN_SERVED_PINS (Jev/Luna 2026-10-07; PPLX v1.1 2026-10-09, Amendment A2)", () => {
        expect({ ...COMPARISON_SERVED_MODEL_ALLOWLIST }).toEqual({ ...PLAN_SERVED_PINS });
        expect(Object.keys(COMPARISON_SERVED_MODEL_ALLOWLIST).sort()).toEqual([
            "openai/gpt-6-luna-decisions",
            "perplexity/pplx-decider-v1.1-27b",
            "~typesafe/jev-latest",
        ]);
    });

    it("throws in strict mode on mutation and leaves values unchanged", () => {
        expect(() => {
            (COMPARISON_GATE_THRESHOLDS as unknown as Record<string, number>).recall_ci = 0;
        }).toThrow(TypeError);
        expect(COMPARISON_GATE_THRESHOLDS.recall_ci).toBe(-0.02);
        expect(() => {
            (COMPARISON_GATE_IDS as unknown as string[]).push("smuggled_gate");
        }).toThrow(TypeError);
        expect(() => {
            (COMPARISON_BLOCKED_REASONS as unknown as string[]).push("smuggled_reason");
        }).toThrow(TypeError);
        expect(() => {
            (COMPARISON_TRUTH_CLASSES as unknown as string[]).push("smuggled_truth");
        }).toThrow(TypeError);
        expect(() => {
            (COMPARISON_SERVED_MODEL_ALLOWLIST as unknown as Record<string, string>)["~typesafe/jev-latest"] = "evil/snapshot";
        }).toThrow(TypeError);
        expect(COMPARISON_SERVED_MODEL_ALLOWLIST["~typesafe/jev-latest"]).toBe("typesafe/jev-1.13-20260917");
        expect([...COMPARISON_GATE_IDS]).toHaveLength(10);
    });

    it("is unaffected by sloppy-mode writes", () => {
        const sloppyWrite = Function("obj", "obj.recall_ci = 0; obj.ece_harm_stop = 99;") as (obj: unknown) => void;
        sloppyWrite(COMPARISON_GATE_THRESHOLDS);
        expect(COMPARISON_GATE_THRESHOLDS.recall_ci).toBe(-0.02);
        expect(COMPARISON_GATE_THRESHOLDS.ece_harm_stop).toBe(0.3);
    });
});
