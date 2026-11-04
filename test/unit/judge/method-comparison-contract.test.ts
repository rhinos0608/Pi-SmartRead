/**
 * Stage C method-aware record contract (plan §3 "Reuse frozen DTOs
 * without corrupting their meaning"; Stage C acceptance: reject forged
 * M2 averages, duplicated costs, cross-method links, missing replicas,
 * incorrect hashes).
 *
 * Every rule of `bindMethodComparisonReport` gets at least one failing
 * fixture: envelope versioning and phase replica parameterization,
 * wire-record capture rules (payload hash format, served identity,
 * cost shapes, answer alignment, method/direction agreement), unique
 * wire accounting (cost once per HTTP request, never per candidate),
 * cross-method/arm/phase link rejection, complete replica coverage for
 * the declared replica count, payload/order agreement within a
 * component, gapless attempt ledgers, exact reverse ordering, and
 * recomputation of derived scores (forged M2 averages and substituted
 * surviving directions fail). The M1-only legacy projection is checked
 * against the frozen per-record validators, and M0/M2 projection is
 * asserted to be rejected (no 1:1 mapping exists for them).
 *
 * Review-fix coverage: the reference phase is bound to the deployed
 * Jev/M0 configuration, individually finite costs whose aggregate
 * overflows fail with `non_finite_total`, and
 * `aggregateCampaignWireCosts` is exercised for campaign spend:
 * wireIds shared by M0+M2 reports counted once, disjoint unions,
 * conflicting full-record content (cost, payload, identity, answers)
 * rejected, forged unbranded `{ok:true}` bindings and post-bind wire
 * record mutation rejected, identical duplicates counted once,
 * unbound and empty input rejected, campaign-level overflow rejected.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
    COMPARISON_GATE_THRESHOLDS,
    COMPARISON_SERVED_MODEL_ALLOWLIST,
    isComparisonAttemptRecord,
    isComparisonScoredOutcome,
    type ComparisonModelId,
    type ComparisonTruthClass,
} from "../../../scripts/eval/judge/model-comparison-types.js";
import {
    CONFIRMATION_REPLICA_COUNTS,
    METHOD_COMPARISON_CONTRACT_VERSION,
    PILOT_REPLICA_COUNT,
    aggregateCampaignWireCosts,
    bindMethodComparisonReport,
    isMethodDerivedScore,
    isMethodPlannedCandidate,
    isMethodRecordEnvelope,
    isMethodWireRecord,
    isValidPhaseReplicaCount,
    projectMethodDerivedToScoredOutcome,
    projectMethodWireToComparisonAttempt,
    type MethodBindFailure,
    type MethodBindingTotals,
    type MethodComparisonReportInput,
    type MethodDerivedScore,
    type MethodPlannedCandidate,
    type MethodRecordEnvelope,
    type MethodReportBinding,
    type MethodWireAnswer,
    type MethodWireRecord,
} from "../../../scripts/eval/judge/method-comparison-contract.js";

const ARM: ComparisonModelId = "perplexity/pplx-decider-v1.1-27b";
const SERVED = COMPARISON_SERVED_MODEL_ALLOWLIST[ARM];
const OTHER_ARM: ComparisonModelId = "~typesafe/jev-latest";
const OTHER_SERVED = COMPARISON_SERVED_MODEL_ALLOWLIST[OTHER_ARM];

const sha = (seed: string): string => createHash("sha256").update(seed).digest("hex");
const MANIFEST = sha("sealed-pilot-manifest");
const Q1 = "pilot:q01";
const Q2 = "pilot:q02";
const Q1_CANDIDATES = ["u0", "u1", "u2"];

function envelope(overrides: Partial<MethodRecordEnvelope> = {}): MethodRecordEnvelope {
    return {
        contractVersion: METHOD_COMPARISON_CONTRACT_VERSION,
        method: "M0",
        arm: ARM,
        phase: "pilot",
        replicaCount: PILOT_REPLICA_COUNT,
        manifestSha256: MANIFEST,
        ...overrides,
    };
}

/** Sealed planned set: Q1 has three candidates (u0,u1,u2), Q2 has one (u0) — order matters. */
const PLANNED: MethodPlannedCandidate[] = [
    { queryGroup: Q1, candidateId: "u0" },
    { queryGroup: Q1, candidateId: "u1" },
    { queryGroup: Q1, candidateId: "u2" },
    { queryGroup: Q2, candidateId: "u0" },
];

function answers(candidateIds: readonly string[], probabilities: Readonly<Record<string, number | null>>): MethodWireAnswer[] {
    return candidateIds.map((candidateId) => ({ candidateId, probability: probabilities[candidateId] ?? null }));
}

function forwardWire(overrides: Partial<MethodWireRecord> = {}): MethodWireRecord {
    return {
        wireId: "f-q1-r0",
        method: "M0",
        arm: ARM,
        phase: "pilot",
        replica: 0,
        warmup: false,
        direction: "forward",
        queryGroup: Q1,
        candidateIds: [...Q1_CANDIDATES],
        attemptIndex: 1,
        requestBytes: 812,
        payloadSha256: sha(`${Q1}:forward`),
        httpStatus: 200,
        servedModel: SERVED,
        provider: "Perplexity",
        inputTokens: 700,
        outputTokens: 18,
        cost: { status: "known", usd: 0.001 },
        errorClass: null,
        requestTimestamp: "2026-10-09T00:00:00.000Z",
        latencyMs: 240,
        answers: answers(Q1_CANDIDATES, { u0: 0.75, u1: 0.25, u2: 0.5 }),
        ...overrides,
    };
}

function reverseWire(overrides: Partial<MethodWireRecord> = {}): MethodWireRecord {
    const candidateIds = ["u2", "u1", "u0"]; // exact reverse of the forward order
    return {
        wireId: "rev-q1-r0",
        method: "M2",
        arm: ARM,
        phase: "pilot",
        replica: 0,
        warmup: false,
        direction: "reverse",
        queryGroup: Q1,
        candidateIds,
        attemptIndex: 1,
        requestBytes: 812,
        payloadSha256: sha(`${Q1}:reverse`),
        httpStatus: 200,
        servedModel: SERVED,
        provider: "Perplexity",
        inputTokens: 702,
        outputTokens: 20,
        cost: { status: "known", usd: 0.001 },
        errorClass: null,
        requestTimestamp: "2026-10-09T00:00:00.000Z",
        latencyMs: 260,
        answers: answers(candidateIds, { u0: 0.25, u1: 0.5, u2: 0.6 }),
        ...overrides,
    };
}

function isolatedWire(queryGroup: string, candidateId: string, replica: number, overrides: Partial<MethodWireRecord> = {}): MethodWireRecord {
    const candidateIds = [candidateId];
    return {
        wireId: `iso-${queryGroup}-${candidateId}-r${replica}`,
        method: "M1",
        arm: ARM,
        phase: "pilot",
        replica,
        warmup: false,
        direction: "isolated",
        queryGroup,
        candidateIds,
        attemptIndex: 1,
        requestBytes: 400,
        payloadSha256: sha(`${queryGroup}:${candidateId}:isolated`),
        httpStatus: 200,
        servedModel: SERVED,
        provider: "Perplexity",
        inputTokens: 350,
        outputTokens: 9,
        cost: { status: "known", usd: 0.001 },
        errorClass: null,
        requestTimestamp: "2026-10-09T00:00:00.000Z",
        latencyMs: 180,
        answers: answers(candidateIds, { [candidateId]: 0.6 }),
        ...overrides,
    };
}

function q2ForwardWire(replica: number): MethodWireRecord {
    return forwardWire({
        wireId: `f-q2-r${replica}`,
        replica,
        queryGroup: Q2,
        candidateIds: ["u0"],
        payloadSha256: sha(`${Q2}:forward`),
        answers: answers(["u0"], { u0: 0.4 }),
    });
}

function q2ReverseWire(replica: number): MethodWireRecord {
    return reverseWire({
        wireId: `rev-q2-r${replica}`,
        replica,
        queryGroup: Q2,
        candidateIds: ["u0"],
        payloadSha256: sha(`${Q2}:reverse`),
        answers: answers(["u0"], { u0: 0.7 }),
    });
}

/** A complete, valid M0 pilot report (forward packed requests for both replicas). */
function m0Report(): MethodComparisonReportInput {
    const wireRecords: unknown[] = [
        forwardWire({ wireId: "f-q1-r0", replica: 0 }),
        forwardWire({ wireId: "f-q1-r1", replica: 1 }),
        q2ForwardWire(0),
        q2ForwardWire(1),
    ];
    const derivedScores: unknown[] = [];
    for (const replica of [0, 1]) {
        for (const [candidateId, probability] of [["u0", 0.75], ["u1", 0.25], ["u2", 0.5]] as const) {
            derivedScores.push({ method: "M0", arm: ARM, phase: "pilot", replica, queryGroup: Q1, candidateId, probability, wireIds: [`f-q1-r${replica}`] });
        }
        derivedScores.push({ method: "M0", arm: ARM, phase: "pilot", replica, queryGroup: Q2, candidateId: "u0", probability: 0.4, wireIds: [`f-q2-r${replica}`] });
    }
    return { envelope: envelope(), plannedCandidates: PLANNED, wireRecords, derivedScores };
}

/** A complete, valid M1 pilot report (one isolated request per candidate and replica). */
function m1Report(): MethodComparisonReportInput {
    const wireRecords: unknown[] = [];
    const derivedScores: unknown[] = [];
    for (const replica of [0, 1]) {
        for (const { queryGroup, candidateId } of PLANNED) {
            const wire = isolatedWire(queryGroup, candidateId, replica);
            wireRecords.push(wire);
            derivedScores.push({ method: "M1", arm: ARM, phase: "pilot", replica, queryGroup, candidateId, probability: 0.6, wireIds: [wire.wireId] });
        }
    }
    return { envelope: envelope({ method: "M1" }), plannedCandidates: PLANNED, wireRecords, derivedScores };
}

/**
 * A complete, valid M2 pilot report: forward leg reuses the M0 forward
 * records (method M0), reverse leg carries method M2 with the exact
 * reversed candidate order.
 */
function m2Report(): MethodComparisonReportInput {
    const wireRecords: unknown[] = [
        forwardWire({ wireId: "f-q1-r0", replica: 0 }),
        forwardWire({ wireId: "f-q1-r1", replica: 1 }),
        q2ForwardWire(0),
        q2ForwardWire(1),
        reverseWire({ wireId: "rev-q1-r0", replica: 0 }),
        reverseWire({ wireId: "rev-q1-r1", replica: 1 }),
        q2ReverseWire(0),
        q2ReverseWire(1),
    ];
    const derivedScores: unknown[] = [];
    for (const replica of [0, 1]) {
        for (const [candidateId, forward, reverse] of [["u0", 0.75, 0.25], ["u1", 0.25, 0.5], ["u2", 0.5, 0.6]] as const) {
            derivedScores.push({
                method: "M2",
                arm: ARM,
                phase: "pilot",
                replica,
                queryGroup: Q1,
                candidateId,
                probability: (forward + reverse) / 2,
                wireIds: [`f-q1-r${replica}`, `rev-q1-r${replica}`],
            });
        }
        derivedScores.push({
            method: "M2",
            arm: ARM,
            phase: "pilot",
            replica,
            queryGroup: Q2,
            candidateId: "u0",
            probability: (0.4 + 0.7) / 2,
            wireIds: [`f-q2-r${replica}`, `rev-q2-r${replica}`],
        });
    }
    return { envelope: envelope({ method: "M2" }), plannedCandidates: PLANNED, wireRecords, derivedScores };
}

function bindOk(input: MethodComparisonReportInput): MethodBindingTotals {
    const result = bindMethodComparisonReport(input);
    if (!result.ok) throw new Error(`expected binding to succeed, failed: ${result.failures.join(", ")}`);
    return result.totals;
}

function bindFailure(input: MethodComparisonReportInput, ...expected: MethodBindFailure[]): MethodBindFailure[] {
    const result = bindMethodComparisonReport(input);
    if (result.ok) throw new Error("expected binding to fail, but it succeeded");
    for (const code of expected) expect(result.failures).toContain(code);
    return result.failures;
}

function withWire(input: MethodComparisonReportInput, wireId: string, patch: Partial<MethodWireRecord>): MethodComparisonReportInput {
    return {
        ...input,
        wireRecords: input.wireRecords.map((raw) => {
            const record = raw as MethodWireRecord;
            return record.wireId === wireId ? { ...record, ...patch } : raw;
        }),
    };
}

function mapDerived(input: MethodComparisonReportInput, mapper: (score: MethodDerivedScore) => unknown): MethodComparisonReportInput {
    return { ...input, derivedScores: input.derivedScores.map((raw) => mapper(raw as MethodDerivedScore)) };
}

function isQ1FirstDerived(score: MethodDerivedScore): boolean {
    return score.queryGroup === Q1 && score.candidateId === "u0" && score.replica === 0;
}

describe("method-aware envelope (versioned contract)", () => {
    it("accepts a sealed pilot envelope (replica count 2)", () => {
        expect(isMethodRecordEnvelope(envelope())).toBe(true);
    });

    it("parameterizes replica counts by phase (pilot 2; confirmation/reference 5/4/3)", () => {
        expect(isValidPhaseReplicaCount("pilot", 2)).toBe(true);
        expect(isValidPhaseReplicaCount("pilot", 3)).toBe(false);
        for (const replicaCount of CONFIRMATION_REPLICA_COUNTS) {
            expect(isValidPhaseReplicaCount("confirmation", replicaCount)).toBe(true);
            expect(isValidPhaseReplicaCount("reference", replicaCount)).toBe(true);
        }
        expect(isValidPhaseReplicaCount("confirmation", 2)).toBe(false);
        expect(isValidPhaseReplicaCount("reference", 6)).toBe(false);
        expect(isMethodRecordEnvelope(envelope({ method: "M2", phase: "confirmation", replicaCount: 4 }))).toBe(true);
        expect(isMethodRecordEnvelope(envelope({ method: "M0", arm: OTHER_ARM, phase: "reference", replicaCount: 5 }))).toBe(true);
    });

    it("rejects a wrong contract version", () => {
        expect(isMethodRecordEnvelope({ ...envelope(), contractVersion: "method-comparison/v0" })).toBe(false);
    });

    it("rejects an unknown phase", () => {
        expect(isMethodRecordEnvelope({ ...envelope(), phase: "production" })).toBe(false);
    });

    it("rejects a pilot envelope whose replica count is not 2", () => {
        expect(isMethodRecordEnvelope({ ...envelope(), replicaCount: 3 })).toBe(false);
        expect(isMethodRecordEnvelope({ ...envelope(), replicaCount: 1 })).toBe(false);
    });

    it("rejects confirmation replica counts outside {5,4,3}", () => {
        expect(isMethodRecordEnvelope({ ...envelope(), phase: "confirmation", replicaCount: 2 })).toBe(false);
        expect(isMethodRecordEnvelope({ ...envelope(), phase: "confirmation", replicaCount: 6 })).toBe(false);
    });

    it("rejects a malformed manifest hash and foreign envelope keys", () => {
        expect(isMethodRecordEnvelope({ ...envelope(), manifestSha256: "not-a-sha256" })).toBe(false);
        expect(isMethodRecordEnvelope({ ...envelope(), extra: 1 })).toBe(false);
        expect(bindMethodComparisonReport({ ...m0Report(), envelope: { ...envelope(), manifestSha256: "ABC" } }))
            .toEqual({ ok: false, failures: ["invalid_envelope"] });
    });

    it("rejects an unknown arm slug in the envelope", () => {
        expect(isMethodRecordEnvelope({ ...envelope(), arm: "openai/gpt-6-nope" })).toBe(false);
    });

    it("binds the reference phase to the deployed Jev/M0 configuration (plan §3, A1.3)", () => {
        // Deployed Jev under M0 is the only valid reference identity.
        expect(isMethodRecordEnvelope(envelope({ method: "M0", arm: OTHER_ARM, phase: "reference", replicaCount: 5 }))).toBe(true);
        expect(isMethodRecordEnvelope(envelope({ method: "M0", arm: OTHER_ARM, phase: "reference", replicaCount: 3 }))).toBe(true);
        // A non-deployed arm or a non-M0 method cannot be the reference.
        expect(isMethodRecordEnvelope(envelope({ method: "M0", phase: "reference", replicaCount: 5 }))).toBe(false);
        expect(isMethodRecordEnvelope(envelope({ method: "M1", phase: "reference", replicaCount: 5 }))).toBe(false);
        expect(isMethodRecordEnvelope(envelope({ method: "M1", arm: OTHER_ARM, phase: "reference", replicaCount: 5 }))).toBe(false);
        expect(isMethodRecordEnvelope(envelope({ method: "M2", arm: OTHER_ARM, phase: "reference", replicaCount: 3 }))).toBe(false);
        // The reverse implication is intentionally absent: Jev/M0 remains
        // valid outside the reference phase because A1.1's S_0 needs the
        // Jev M0 pilot baseline (2 replicas) and confirmation runs.
        expect(isMethodRecordEnvelope(envelope({ arm: OTHER_ARM }))).toBe(true); // pilot Jev/M0, 2 replicas
        expect(isMethodRecordEnvelope(envelope({ arm: OTHER_ARM, phase: "confirmation", replicaCount: 5 }))).toBe(true);
    });
});

describe("wire record capture rules (per HTTP request)", () => {
    it("accepts a valid packed forward record", () => {
        expect(isMethodWireRecord(forwardWire())).toBe(true);
    });

    it("rejects a payload hash that is not lowercase hex SHA-256", () => {
        const record = forwardWire();
        expect(isMethodWireRecord({ ...record, payloadSha256: record.payloadSha256.toUpperCase() })).toBe(false);
        expect(isMethodWireRecord({ ...record, payloadSha256: record.payloadSha256.slice(0, 63) })).toBe(false);
    });

    it("rejects a missing served identity on a received response", () => {
        expect(isMethodWireRecord({ ...forwardWire(), servedModel: null })).toBe(false);
    });

    it("rejects a served identity on a transport failure and requires an error class", () => {
        const base = forwardWire();
        expect(isMethodWireRecord({ ...base, httpStatus: null, errorClass: "network", servedModel: SERVED, provider: null, answers: answers(Q1_CANDIDATES, { u0: null, u1: null, u2: null }) })).toBe(false);
        expect(isMethodWireRecord({ ...base, httpStatus: null, errorClass: null, servedModel: null, provider: null, answers: answers(Q1_CANDIDATES, { u0: null, u1: null, u2: null }) })).toBe(false);
        expect(isMethodWireRecord({ ...base, httpStatus: null, errorClass: "network", servedModel: null, provider: null, answers: answers(Q1_CANDIDATES, { u0: null, u1: null, u2: null }) })).toBe(true);
    });

    it("accepts a RECEIVED response with un-capturable identity only as an explicit capture_gap record", () => {
        const gap = forwardWire({
            servedModel: null,
            provider: null,
            cost: { status: "unknown", reserveUsd: 0.0005 },
            errorClass: "capture_gap",
            answers: answers(Q1_CANDIDATES, { u0: null, u1: null, u2: null }),
        });
        expect(gap.httpStatus).toBe(200); // real status preserved on a capture gap
        expect(isMethodWireRecord(gap)).toBe(true);
        // Status + absent identity is rejected for every OTHER error class…
        expect(isMethodWireRecord({ ...gap, errorClass: "bad_response" })).toBe(false);
        // …`capture_gap` is a received-response-only class: a null status rejects…
        expect(isMethodWireRecord({ ...gap, httpStatus: null })).toBe(false);
        // …exactly as does an identity alongside it.
        expect(isMethodWireRecord({ ...gap, servedModel: SERVED })).toBe(false);
    });

    it("rejects a malformed cost shape (unknown must retain a positive reserve)", () => {
        expect(isMethodWireRecord({ ...forwardWire(), cost: { status: "unknown", reserveUsd: 0 } })).toBe(false);
        expect(isMethodWireRecord({ ...forwardWire(), cost: { status: "unknown" } })).toBe(false);
        expect(isMethodWireRecord({ ...forwardWire(), cost: { status: "known", usd: -0.1 } })).toBe(false);
        expect(isMethodWireRecord({ ...forwardWire(), cost: { status: "unknown", reserveUsd: 0.004 } })).toBe(true);
    });

    it("rejects missing, extra, or reordered candidate answers", () => {
        const record = forwardWire();
        expect(isMethodWireRecord({ ...record, answers: record.answers.slice(0, 2) })).toBe(false);
        expect(isMethodWireRecord({ ...record, answers: [...record.answers, { candidateId: "u9", probability: 0.5 }] })).toBe(false);
        expect(isMethodWireRecord({ ...record, answers: [...record.answers].reverse() })).toBe(false);
        expect(isMethodWireRecord({ ...record, answers: answers(Q1_CANDIDATES, { u0: 1.5, u1: 0.25, u2: 0.5 }) })).toBe(false);
    });

    it("rejects a successful response carrying a null answer (poisoned batch must record an error class)", () => {
        expect(isMethodWireRecord({ ...forwardWire(), answers: answers(Q1_CANDIDATES, { u0: null, u1: 0.25, u2: 0.5 }) })).toBe(false);
        expect(isMethodWireRecord({ ...forwardWire(), httpStatus: 500, errorClass: null, answers: answers(Q1_CANDIDATES, { u0: null, u1: null, u2: null }) })).toBe(false);
        expect(isMethodWireRecord({ ...forwardWire(), httpStatus: 503, errorClass: "http_500", answers: answers(Q1_CANDIDATES, { u0: null, u1: null, u2: null }) })).toBe(false);
        expect(isMethodWireRecord({ ...forwardWire(), httpStatus: 502, errorClass: "http_502", answers: answers(Q1_CANDIDATES, { u0: null, u1: null, u2: null }) })).toBe(true);
    });

    it("enforces one candidate per M1 request and method↔direction agreement", () => {
        const twoCandidateM1 = isolatedWire(Q1, "u0", 0, { candidateIds: ["u0", "u1"], answers: answers(["u0", "u1"], { u0: 0.6, u1: 0.4 }) });
        expect(isMethodWireRecord(twoCandidateM1)).toBe(false);
        expect(isMethodWireRecord({ ...forwardWire(), direction: "reverse" })).toBe(false);
        expect(isMethodWireRecord({ ...forwardWire(), direction: "isolated" })).toBe(false);
        expect(isMethodWireRecord({ ...forwardWire(), method: "M1" })).toBe(false);
        expect(isMethodWireRecord({ ...reverseWire(), direction: "forward" })).toBe(false);
        expect(isMethodWireRecord({ ...reverseWire(), method: "M0" })).toBe(false);
    });

    it("rejects out-of-range attempt index, replica, and probability", () => {
        const record = forwardWire();
        expect(isMethodWireRecord({ ...record, attemptIndex: 0 })).toBe(false);
        expect(isMethodWireRecord({ ...record, replica: 5 })).toBe(false);
        expect(isMethodWireRecord({ ...record, replica: -1 })).toBe(false);
        expect(isMethodWireRecord({ ...record, latencyMs: -1 })).toBe(false);
        expect(isMethodWireRecord({ ...record, requestBytes: -1 })).toBe(false);
    });

    it("enforces warmup/query-group exclusivity like the frozen attempt record", () => {
        expect(isMethodWireRecord({ ...forwardWire(), warmup: true, queryGroup: null })).toBe(true);
        expect(isMethodWireRecord({ ...forwardWire(), warmup: true })).toBe(false);
        expect(isMethodWireRecord({ ...forwardWire(), queryGroup: null })).toBe(false);
    });

    it("rejects foreign keys on a wire record", () => {
        expect(isMethodWireRecord({ ...forwardWire(), attemptId: "nope" })).toBe(false);
        expect(isMethodWireRecord({ ...forwardWire(), cost: { status: "known", usd: 0.001 }, extra: 1 })).toBe(false);
    });
});

describe("binder: valid reports bind", () => {
    it("binds a complete M0 pilot report with exact wire accounting", () => {
        const totals = bindOk(m0Report());
        expect(totals.wireRequestCount).toBe(4);
        expect(totals.warmupRequests).toBe(0);
        expect(totals.successfulResponses).toBe(4);
        expect(totals.knownCostRequests).toBe(4);
        expect(totals.knownCostUsd).toBeCloseTo(0.004, 9);
        expect(totals.costComplete).toBe(true);
    });

    it("binds a complete M1 pilot report", () => {
        const totals = bindOk(m1Report());
        expect(totals.wireRequestCount).toBe(8); // 4 candidates x 2 replicas
        expect(totals.knownCostUsd).toBeCloseTo(0.008, 9);
        expect(totals.costComplete).toBe(true);
    });

    it("binds a capture_gap response as received-but-unsuccessful: availability denominator only, never identity drift", () => {
        const input = m0Report();
        const wireRecords = input.wireRecords.map((raw) => {
            const record = raw as MethodWireRecord;
            if (record.wireId !== "f-q1-r0") return raw;
            return {
                ...record,
                servedModel: null,
                provider: null,
                cost: { status: "unknown", reserveUsd: 0.0005 },
                errorClass: "capture_gap",
                answers: answers(Q1_CANDIDATES, { u0: null, u1: null, u2: null }),
            };
        });
        // Absent identity on a capture gap is never identity drift (bindOk throws
        // on any failure), and the Q1 replica-0 derived scores follow their wire record.
        const derivedScores = mapDerived(input, (score) =>
            score.queryGroup === Q1 && score.replica === 0 ? { ...score, probability: null } : score,
        ).derivedScores;
        const totals = bindOk({ ...input, wireRecords, derivedScores });
        expect(totals.wireRequestCount).toBe(4); // received: still an attempted request (denominator)
        expect(totals.successfulResponses).toBe(3); // …but never a successful one (numerator)
        expect(totals.unknownCostRequests).toBe(1);
        expect(totals.costComplete).toBe(false);
        // The gate value that changes is `availability` = successfulResponses /
        // attemptedRequests: this record pulls the method report below the frozen threshold.
        expect(totals.successfulResponses / totals.wireRequestCount).toBeLessThan(COMPARISON_GATE_THRESHOLDS.availability);
    });

    it("binds a complete M2 report reusing the M0 forward records plus reversed legs", () => {
        const totals = bindOk(m2Report());
        expect(totals.wireRequestCount).toBe(8); // 4 forward + 4 reverse
        expect(totals.successfulResponses).toBe(8);
        expect(totals.knownCostUsd).toBeCloseTo(0.008, 9);
    });

    it("counts a warmup request once, without requiring warmup coverage", () => {
        const input = m0Report();
        const warmup: MethodWireRecord = {
            wireId: "warm-r0",
            method: "M0",
            arm: ARM,
            phase: "pilot",
            replica: 0,
            warmup: true,
            direction: "forward",
            queryGroup: null,
            candidateIds: [...Q1_CANDIDATES],
            attemptIndex: 1,
            requestBytes: 812,
            payloadSha256: sha("warmup-batch"),
            httpStatus: 200,
            servedModel: SERVED,
            provider: "Perplexity",
            inputTokens: 700,
            outputTokens: 18,
            cost: { status: "known", usd: 0.002 },
            errorClass: null,
            requestTimestamp: "2026-10-09T00:00:00.000Z",
            latencyMs: 300,
            answers: answers(Q1_CANDIDATES, { u0: 0.75, u1: 0.25, u2: 0.5 }),
        };
        const totals = bindOk({ ...input, wireRecords: [...input.wireRecords, warmup] });
        expect(totals.wireRequestCount).toBe(5);
        expect(totals.warmupRequests).toBe(1);
        expect(totals.knownCostUsd).toBeCloseTo(0.006, 9);
    });
});

describe("binder: unique wire accounting (cost once per request, never per candidate)", () => {
    it("charges a seven-candidate request exactly once, not seven times", () => {
        const candidateIds = ["u0", "u1", "u2", "u3", "u4", "u5", "u6"];
        const probabilities: Record<string, number | null> = { u0: 0.1, u1: 0.2, u2: 0.3, u3: 0.4, u4: 0.5, u5: 0.6, u6: 0.7 };
        const planned = candidateIds.map((candidateId) => ({ queryGroup: Q1, candidateId }));
        const wireRecords: unknown[] = [0, 1].map((replica) => forwardWire({
            wireId: `f-q1-r${replica}`,
            replica,
            candidateIds: [...candidateIds],
            cost: { status: "known", usd: 0.01 },
            answers: answers(candidateIds, probabilities),
        }));
        const derivedScores: unknown[] = [];
        for (const replica of [0, 1]) {
            for (const candidateId of candidateIds) {
                derivedScores.push({ method: "M0", arm: ARM, phase: "pilot", replica, queryGroup: Q1, candidateId, probability: probabilities[candidateId] ?? null, wireIds: [`f-q1-r${replica}`] });
            }
        }
        const totals = bindOk({ envelope: envelope(), plannedCandidates: planned, wireRecords, derivedScores });
        expect(totals.wireRequestCount).toBe(2);
        expect(totals.knownCostUsd).toBeCloseTo(0.02, 9); // NOT 0.14 (7 candidates x 2 replicas)
    });

    it("rejects a duplicated wire record (double-counted cost)", () => {
        const input = m0Report();
        const duplicate = { ...(input.wireRecords[0] as MethodWireRecord) };
        const failures = bindFailure({ ...input, wireRecords: [...input.wireRecords, duplicate] }, "duplicate_wire_id");
        expect(failures).toEqual(["duplicate_wire_id"]);
    });

    it("rejects a derived score carrying a cost field (cost exists only on wire records)", () => {
        const input = m0Report();
        const forged = { ...(input.derivedScores[0] as MethodDerivedScore), cost: { status: "known", usd: 9 } };
        const failures = bindFailure({ ...input, derivedScores: [forged, ...input.derivedScores.slice(1)] }, "invalid_derived_score");
        expect(failures).toContain("invalid_derived_score");
    });

    it("sums unknown-cost reservations per request and reports costComplete false", () => {
        const input = m0Report();
        const wireRecords = input.wireRecords.map((raw) => ({ ...(raw as MethodWireRecord), cost: { status: "unknown", reserveUsd: 0.005 } }));
        const totals = bindOk({ ...input, wireRecords });
        expect(totals.knownCostRequests).toBe(0);
        expect(totals.unknownCostRequests).toBe(4);
        expect(totals.unknownCostReserveUsd).toBeCloseTo(0.02, 9);
        expect(totals.costComplete).toBe(false);
    });
});

describe("binder: non-finite aggregate totals fail closed", () => {
    it("binds a single maximum finite total but rejects the overflowed sum of two", () => {
        const input = m0Report();
        const oneMax = input.wireRecords.map((raw, index) => index === 0
            ? { ...(raw as MethodWireRecord), cost: { status: "known", usd: Number.MAX_VALUE } }
            : raw);
        const single = bindOk({ ...input, wireRecords: oneMax });
        expect(single.knownCostUsd).toBe(Number.MAX_VALUE);
        expect(single.costComplete).toBe(true);

        const twoMax = input.wireRecords.map((raw, index) => index < 2
            ? { ...(raw as MethodWireRecord), cost: { status: "known", usd: Number.MAX_VALUE } }
            : raw);
        const failures = bindFailure({ ...input, wireRecords: twoMax }, "non_finite_total");
        expect(failures).toEqual(["non_finite_total"]);
    });

    it("rejects unknown-cost reserves whose running sum overflows", () => {
        const input = m0Report();
        const wireRecords = input.wireRecords.map((raw) => ({
            ...(raw as MethodWireRecord),
            cost: { status: "unknown", reserveUsd: Number.MAX_VALUE },
        }));
        const failures = bindFailure({ ...input, wireRecords }, "non_finite_total");
        expect(failures).toEqual(["non_finite_total"]);
    });
});

/** Binds a fixture report, failing the test when the binder rejects it. */
function boundReport(input: MethodComparisonReportInput): MethodReportBinding {
    const result = bindMethodComparisonReport(input);
    if (!result.ok) throw new Error(`expected binding to succeed, failed: ${result.failures.join(", ")}`);
    return result;
}

describe("campaign aggregation: aggregateCampaignWireCosts", () => {
    it("counts forward wireIds shared by M0 and M2 reports exactly once", () => {
        const campaign = aggregateCampaignWireCosts([boundReport(m0Report()), boundReport(m2Report())]);
        if (!campaign.ok) throw new Error(`expected campaign aggregation to succeed, failed: ${campaign.failures.join(", ")}`);
        // Naively summing report totals would charge the four shared
        // forward requests twice (0.004 + 0.008 = 0.012).
        expect(campaign.totals.uniqueWireRequestCount).toBe(8);
        expect(campaign.totals.knownCostUsd).toBeCloseTo(0.008, 9);
        expect(campaign.totals.unknownCostRequests).toBe(0);
        expect(campaign.totals.unknownCostReserveUsd).toBe(0);
    });

    it("aggregates the bind-time snapshot even if the binding or its input records are mutated afterwards", () => {
        const input = m0Report();
        const binding = boundReport(input);
        if (!binding.ok) throw new Error("expected ok binding");
        const before = aggregateCampaignWireCosts([binding]);
        if (!before.ok) throw new Error(`expected aggregation to succeed: ${before.failures.join(", ")}`);
        expect(() => {
            (binding.wireRecords as MethodWireRecord[]).length = 0;
        }).toThrow(TypeError);
        const firstInput = input.wireRecords[0] as { cost: unknown };
        firstInput.cost = { status: "known", usd: 999 };
        const after = aggregateCampaignWireCosts([binding]);
        if (!after.ok) throw new Error(`expected aggregation to succeed: ${after.failures.join(", ")}`);
        expect(after.totals).toEqual(before.totals);
    });

    it("unions disjoint reports and retains unknown-cost reservations", () => {
        const m1 = m1Report();
        const m1Unknown = {
            ...m1,
            wireRecords: m1.wireRecords.map((raw) => ({
                ...(raw as MethodWireRecord),
                cost: { status: "unknown", reserveUsd: 0.005 },
            })),
        };
        const campaign = aggregateCampaignWireCosts([boundReport(m0Report()), boundReport(m1Unknown)]);
        if (!campaign.ok) throw new Error(`expected campaign aggregation to succeed, failed: ${campaign.failures.join(", ")}`);
        expect(campaign.totals.uniqueWireRequestCount).toBe(12); // 4 M0 + 8 M1, disjoint wireIds
        expect(campaign.totals.knownCostUsd).toBeCloseTo(0.004, 9);
        expect(campaign.totals.unknownCostRequests).toBe(8);
        expect(campaign.totals.unknownCostReserveUsd).toBeCloseTo(0.04, 9);
    });

    it("rejects the same wireId with a differing cost across reports", () => {
        const campaign = aggregateCampaignWireCosts([
            boundReport(m0Report()),
            boundReport(withWire(m2Report(), "f-q1-r0", { cost: { status: "known", usd: 0.002 } })),
        ]);
        expect(campaign).toEqual({ ok: false, failures: ["campaign_wire_conflict"] });
    });

    it("rejects the same wireId with a differing payload hash across reports", () => {
        // Re-hash the M2 forward legs consistently WITHIN the M2 report
        // (so it still binds) — cross-report the shared wireIds then disagree.
        const m2 = m2Report();
        const rehashed = {
            ...m2,
            wireRecords: m2.wireRecords.map((raw) => {
                const record = raw as MethodWireRecord;
                return record.direction === "forward"
                    ? { ...record, payloadSha256: sha(`${record.queryGroup}:forward:alt`) }
                    : raw;
            }),
        };
        const campaign = aggregateCampaignWireCosts([boundReport(m0Report()), boundReport(rehashed)]);
        expect(campaign).toEqual({ ok: false, failures: ["campaign_wire_conflict"] });
    });

    it("rejects the same wireId with a differing serving identity across reports", () => {
        const campaign = aggregateCampaignWireCosts([
            boundReport(m0Report()),
            boundReport(withWire(m2Report(), "f-q1-r0", { provider: "AltProvider" })),
        ]);
        expect(campaign).toEqual({ ok: false, failures: ["campaign_wire_conflict"] });
    });

    it("rejects an empty campaign and an unbound report", () => {
        expect(aggregateCampaignWireCosts([])).toEqual({ ok: false, failures: ["campaign_unbound_report"] });
        const unbound = bindMethodComparisonReport({ ...m0Report(), plannedCandidates: [] });
        if (unbound.ok) throw new Error("expected binding to fail");
        expect(aggregateCampaignWireCosts([unbound])).toEqual({ ok: false, failures: ["campaign_unbound_report"] });
    });

    it("rejects campaign totals that overflow even though every report bound", () => {
        const m0 = m0Report();
        const m0OneMax = {
            ...m0,
            wireRecords: m0.wireRecords.map((raw, index) => index === 0
                ? { ...(raw as MethodWireRecord), cost: { status: "known", usd: Number.MAX_VALUE } }
                : raw),
        };
        const m1 = m1Report();
        const m1OneMax = {
            ...m1,
            wireRecords: m1.wireRecords.map((raw, index) => index === 0
                ? { ...(raw as MethodWireRecord), cost: { status: "known", usd: Number.MAX_VALUE } }
                : raw),
        };
        // Each report's own total stays finite (MAX + small additions).
        expect(bindMethodComparisonReport(m0OneMax).ok).toBe(true);
        expect(bindMethodComparisonReport(m1OneMax).ok).toBe(true);
        // The disjoint union of two maximums overflows.
        const campaign = aggregateCampaignWireCosts([boundReport(m0OneMax), boundReport(m1OneMax)]);
        expect(campaign).toEqual({ ok: false, failures: ["non_finite_total"] });
    });
});

describe("campaign aggregation: binding authenticity and full-record conflict guards", () => {
    it("rejects a forged {ok:true} object that the binder never produced", () => {
        const forged = {
            ok: true,
            wireRecords: [{
                wireId: "w",
                payloadSha256: "not-a-hash",
                cost: { status: "known", usd: 1 },
                method: "M0",
                arm: OTHER_ARM,
                phase: "reference",
                replica: 0,
                servedModel: "forged",
                provider: null,
            }],
        } as unknown as MethodReportBinding;
        expect(aggregateCampaignWireCosts([forged])).toEqual({ ok: false, failures: ["campaign_unbound_report"] });
    });

    it("freezes a branded binding's wire records so they cannot be mutated after binding", () => {
        const binding = boundReport(m0Report());
        if (!binding.ok) throw new Error("expected a successful binding");
        const before = aggregateCampaignWireCosts([binding]);
        const mutated = binding.wireRecords[0];
        if (mutated === undefined) throw new Error("expected a bound wire record");
        expect(() => {
            mutated.payloadSha256 = "not-a-hash";
        }).toThrow(TypeError);
        expect(aggregateCampaignWireCosts([binding])).toEqual(before);
    });

    it("rejects the same wireId with differing answers across reports", () => {
        // The shared f-q1-r0 record keeps its payload hash, cost, and
        // identity — only the answers (0.75 vs 0.1) differ, which the
        // former selected-field comparison would have accepted.
        const patched = withWire(m0Report(), "f-q1-r0", { answers: answers(Q1_CANDIDATES, { u0: 0.1, u1: 0.25, u2: 0.5 }) });
        const repatched = {
            ...patched,
            derivedScores: patched.derivedScores.map((raw) => {
                const score = raw as MethodDerivedScore;
                return score.queryGroup === Q1 && score.replica === 0 && score.candidateId === "u0"
                    ? { ...score, probability: 0.1 }
                    : raw;
            }),
        };
        const campaign = aggregateCampaignWireCosts([boundReport(m0Report()), boundReport(repatched)]);
        expect(campaign).toEqual({ ok: false, failures: ["campaign_wire_conflict"] });
    });

    it("counts identical duplicate reports once (deduplicated by wireId)", () => {
        const campaign = aggregateCampaignWireCosts([boundReport(m0Report()), boundReport(m0Report())]);
        if (!campaign.ok) throw new Error(`expected campaign aggregation to succeed, failed: ${campaign.failures.join(", ")}`);
        expect(campaign.totals.uniqueWireRequestCount).toBe(4);
        expect(campaign.totals.knownCostUsd).toBeCloseTo(0.004, 9);
    });
});

describe("binder: cross-method / cross-arm / cross-phase links rejected", () => {
    it("rejects an M1 wire record inside an M0 envelope", () => {
        const input = m0Report();
        const foreign = isolatedWire(Q1, "u0", 0, { wireId: "iso-foreign" });
        const failures = bindFailure({ ...input, wireRecords: [...input.wireRecords, foreign] }, "cross_method_link");
        expect(failures).toEqual(["cross_method_link"]);
    });

    it("rejects an M1 forward-direction record outright (method↔direction mismatch)", () => {
        expect(isMethodWireRecord({ ...forwardWire(), method: "M1" })).toBe(false);
    });

    it("rejects a cross-arm wire record", () => {
        const input = m0Report();
        const failures = bindFailure(withWire(input, "f-q1-r1", { arm: OTHER_ARM, servedModel: OTHER_SERVED }), "cross_arm_link");
        expect(failures).toContain("cross_arm_link");
    });

    it("rejects a cross-phase wire record", () => {
        const failures = bindFailure(withWire(m0Report(), "f-q1-r0", { phase: "confirmation" }), "cross_phase_link");
        expect(failures).toContain("cross_phase_link");
    });

    it("rejects a derived score whose method disagrees with the envelope", () => {
        const failures = bindFailure(mapDerived(m0Report(), (score) => isQ1FirstDerived(score) ? { ...score, method: "M1" } : score), "cross_method_link");
        expect(failures).toContain("cross_method_link");
    });

    it("rejects a derived score whose arm disagrees with the envelope", () => {
        const failures = bindFailure(mapDerived(m0Report(), (score) => isQ1FirstDerived(score) ? { ...score, arm: OTHER_ARM } : score), "cross_arm_link");
        expect(failures).toContain("cross_arm_link");
    });

    it("rejects a derived score whose phase disagrees with the envelope", () => {
        const failures = bindFailure(mapDerived(m0Report(), (score) => isQ1FirstDerived(score) ? { ...score, phase: "confirmation" } : score), "cross_phase_link");
        expect(failures).toContain("cross_phase_link");
    });
});

describe("binder: complete replica coverage for the declared replica count", () => {
    it("rejects a missing wire leg at one replica", () => {
        const input = m0Report();
        const wireRecords = input.wireRecords.filter((raw) => (raw as MethodWireRecord).wireId !== "f-q2-r1");
        const failures = bindFailure({ ...input, wireRecords }, "missing_wire_coverage");
        expect(failures).toContain("missing_wire_coverage");
    });

    it("rejects a missing derived score for one candidate and replica", () => {
        const input = m0Report();
        const derivedScores = input.derivedScores.filter((raw) => {
            const score = raw as MethodDerivedScore;
            return !(score.queryGroup === Q1 && score.candidateId === "u2" && score.replica === 1);
        });
        const failures = bindFailure({ ...input, derivedScores }, "missing_derived_coverage");
        expect(failures).toEqual(["missing_derived_coverage"]);
    });

    it("rejects a duplicate derived score for one candidate and replica", () => {
        const input = m0Report();
        const duplicate = { ...(input.derivedScores[0] as MethodDerivedScore) };
        const failures = bindFailure({ ...input, derivedScores: [...input.derivedScores, duplicate] }, "duplicate_derived_score");
        expect(failures).toContain("duplicate_derived_score");
    });

    it("rejects a wire record beyond the declared replica count", () => {
        const failures = bindFailure(withWire(m0Report(), "f-q1-r1", { replica: 2 }), "replica_out_of_range");
        expect(failures).toContain("replica_out_of_range");
    });

    it("requires wire and derived coverage for all 5 replicas of a sealed confirmation envelope", () => {
        const candidateIds = ["u0"];
        const planned = [{ queryGroup: Q1, candidateId: "u0" }];
        const wireRecords: unknown[] = [];
        const derivedScores: unknown[] = [];
        for (let replica = 0; replica < 5; replica += 1) {
            wireRecords.push(forwardWire({ wireId: `f-q1-r${replica}`, replica, phase: "confirmation", candidateIds: [...candidateIds], answers: answers(candidateIds, { u0: 0.5 }) }));
            derivedScores.push({ method: "M0", arm: ARM, phase: "confirmation", replica, queryGroup: Q1, candidateId: "u0", probability: 0.5, wireIds: [`f-q1-r${replica}`] });
        }
        const confirmationEnvelope = envelope({ method: "M0", phase: "confirmation", replicaCount: 5 });
        const totals = bindOk({ envelope: confirmationEnvelope, plannedCandidates: planned, wireRecords, derivedScores });
        expect(totals.wireRequestCount).toBe(5);
        // Drop the fifth replica: the declared count of 5 is not satisfied by 4.
        const failures = bindFailure({
            envelope: confirmationEnvelope,
            plannedCandidates: planned,
            wireRecords: wireRecords.slice(0, 4),
            derivedScores: derivedScores.slice(0, 4),
        }, "missing_wire_coverage", "missing_derived_coverage");
        expect(failures).toContain("missing_wire_coverage");
        expect(failures).toContain("missing_derived_coverage");
    });
});

describe("binder: payload hashes, identity, and attempt ledgers", () => {
    it("rejects a payload hash that differs across replicas within one component", () => {
        const failures = bindFailure(withWire(m0Report(), "f-q1-r1", { payloadSha256: sha("different-bytes") }), "payload_drift");
        expect(failures).toEqual(["payload_drift"]);
    });

    it("rejects a candidate order that differs across replicas within one component", () => {
        const input = m0Report();
        const reordered = ["u0", "u2", "u1"];
        const failures = bindFailure(withWire(input, "f-q1-r1", {
            candidateIds: reordered,
            answers: answers(reordered, { u0: 0.75, u2: 0.5, u1: 0.25 }),
        }), "payload_drift", "candidate_set_mismatch");
        expect(failures).toContain("payload_drift");
        expect(failures).toContain("candidate_set_mismatch");
    });

    it("rejects a served identity that drifts from the frozen allowlist", () => {
        const failures = bindFailure(withWire(m0Report(), "f-q1-r0", { servedModel: OTHER_SERVED }), "served_identity_drift");
        expect(failures).toEqual(["served_identity_drift"]);
    });

    it("rejects a gap or duplicate in the per-replica attemptIndex ledger", () => {
        const input = m0Report();
        const retry = forwardWire({ wireId: "f-q1-r0-retry", replica: 0, attemptIndex: 3 });
        const derivedScores = input.derivedScores.map((raw) => {
            const score = raw as MethodDerivedScore;
            return score.queryGroup === Q1 && score.replica === 0 ? { ...score, wireIds: [...score.wireIds, "f-q1-r0-retry"] } : raw;
        });
        const failures = bindFailure({ ...input, wireRecords: [...input.wireRecords, retry], derivedScores }, "attempt_index_gap");
        expect(failures).toEqual(["attempt_index_gap"]);
    });

    it("rejects an invalid payload hash format inside the binder", () => {
        const failures = bindFailure(withWire(m0Report(), "f-q1-r0", { payloadSha256: "xyz" }), "invalid_wire_record");
        expect(failures).toContain("invalid_wire_record");
    });

    it("allows forward and reverse components to carry different hashes (drift is per component)", () => {
        const input = m2Report();
        const wireRecords = input.wireRecords.map((raw) => {
            const record = raw as MethodWireRecord;
            return record.queryGroup === Q1 && record.replica === 0
                ? { ...record, payloadSha256: sha(`${record.queryGroup}:${record.direction}:${record.replica}`) }
                : raw;
        });
        // Re-hash both Q1 replica-0 legs consistently within their own components only:
        // forward r0 gets a new hash while forward r1 keeps the old one -> payload_drift.
        const failures = bindFailure({ ...input, wireRecords }, "payload_drift");
        expect(failures).toContain("payload_drift");
    });
});

describe("binder: reverse leg must be the exact reverse of forward", () => {
    it("rejects a reverse request whose candidate order is not the exact reverse", () => {
        const input = m2Report();
        const wrongOrder = ["u1", "u2", "u0"];
        const wireRecords = input.wireRecords.map((raw) => {
            const record = raw as MethodWireRecord;
            if (record.direction !== "reverse" || record.queryGroup !== Q1) return raw;
            return { ...record, candidateIds: [...wrongOrder], answers: answers(wrongOrder, { u1: 0.5, u2: 0.6, u0: 0.25 }) };
        });
        const failures = bindFailure({ ...input, wireRecords }, "reverse_order_mismatch");
        expect(failures).toEqual(["reverse_order_mismatch"]);
    });

    it("accepts an exact reversal (covered by the complete M2 report)", () => {
        expect(() => bindOk(m2Report())).not.toThrow();
    });
});

describe("binder: derived scores are recomputed, never trusted", () => {
    it("rejects a forged M2 average", () => {
        const failures = bindFailure(mapDerived(m2Report(), (score) => isQ1FirstDerived(score) ? { ...score, probability: 0.9 } : score), "forged_derived_score");
        expect(failures).toEqual(["forged_derived_score"]);
    });

    it("rejects a forged M0 probability", () => {
        const failures = bindFailure(mapDerived(m0Report(), (score) => isQ1FirstDerived(score) ? { ...score, probability: 0.9 } : score), "forged_derived_score");
        expect(failures).toEqual(["forged_derived_score"]);
    });

    it("keeps an M2 candidate unjudged when the reverse leg failed (never substitutes the surviving direction)", () => {
        const input = m2Report();
        const wireRecords = input.wireRecords.map((raw) => {
            const record = raw as MethodWireRecord;
            if (record.queryGroup !== Q2 || record.direction !== "reverse") return raw;
            return { ...record, httpStatus: 502, errorClass: "http_502", answers: answers(["u0"], { u0: null }) };
        });
        const derivedScores = mapDerived(input, (score) => score.queryGroup === Q2 ? { ...score, probability: null } : score).derivedScores;
        const totals = bindOk({ ...input, wireRecords, derivedScores });
        expect(totals.successfulResponses).toBe(6); // failed reverse legs are not successes
        expect(totals.wireRequestCount).toBe(8);
    });

    it("rejects a numeric M2 score when the reverse leg produced no answer", () => {
        const input = m2Report();
        const wireRecords = input.wireRecords.map((raw) => {
            const record = raw as MethodWireRecord;
            if (record.queryGroup !== Q2 || record.direction !== "reverse") return raw;
            return { ...record, httpStatus: 502, errorClass: "http_502", answers: answers(["u0"], { u0: null }) };
        });
        const failures = bindFailure({ ...input, wireRecords }, "forged_derived_score");
        expect(failures).toContain("forged_derived_score");
    });

    it("rejects a derived link set that does not match the component ledger (unknown id)", () => {
        const failures = bindFailure(mapDerived(m0Report(), (score) => isQ1FirstDerived(score) ? { ...score, wireIds: ["no-such-wire"] } : score), "invalid_derived_link");
        expect(failures).toEqual(["invalid_derived_link"]);
    });

    it("rejects a derived link set that omits a retry record", () => {
        const input = m0Report();
        const retry = forwardWire({ wireId: "f-q1-r0-retry", replica: 0, attemptIndex: 2 });
        const failures = bindFailure({ ...input, wireRecords: [...input.wireRecords, retry] }, "invalid_derived_link");
        expect(failures).toEqual(["invalid_derived_link"]);
    });

    it("rejects disagreeing answers across two successful retries of one component", () => {
        const input = m0Report();
        const retry = forwardWire({
            wireId: "f-q1-r0-retry",
            replica: 0,
            attemptIndex: 2,
            answers: answers(Q1_CANDIDATES, { u0: 0.9, u1: 0.25, u2: 0.5 }),
        });
        const derivedScores = input.derivedScores.map((raw) => {
            const score = raw as MethodDerivedScore;
            return score.queryGroup === Q1 && score.replica === 0 ? { ...score, wireIds: [...score.wireIds, "f-q1-r0-retry"] } : raw;
        });
        const failures = bindFailure({ ...input, wireRecords: [...input.wireRecords, retry], derivedScores }, "inconsistent_wire_answers");
        expect(failures).toEqual(["inconsistent_wire_answers"]);
    });
});

describe("binder: declared planned set", () => {
    it("rejects an empty planned candidate list", () => {
        expect(bindMethodComparisonReport({ ...m0Report(), plannedCandidates: [] }))
            .toEqual({ ok: false, failures: ["invalid_planned_candidates"] });
    });

    it("rejects duplicate planned candidates", () => {
        const planned = [...PLANNED, { queryGroup: Q1, candidateId: "u0" }];
        expect(bindMethodComparisonReport({ ...m0Report(), plannedCandidates: planned }))
            .toEqual({ ok: false, failures: ["invalid_planned_candidates"] });
    });

    it("rejects a malformed planned candidate entry", () => {
        const planned = [{ queryGroup: Q1 }, ...PLANNED.slice(1)];
        expect(bindMethodComparisonReport({ ...m0Report(), plannedCandidates: planned }))
            .toEqual({ ok: false, failures: ["invalid_planned_candidates"] });
        expect(isMethodPlannedCandidate({ queryGroup: Q1, candidateId: "u0" })).toBe(true);
        expect(isMethodPlannedCandidate({ queryGroup: Q1 })).toBe(false);
    });

    it("rejects a wire record for an unplanned query group", () => {
        const input = m0Report();
        const foreign = forwardWire({ wireId: "f-q9-r0", queryGroup: "pilot:q09", payloadSha256: sha("pilot:q09:forward") });
        const failures = bindFailure({ ...input, wireRecords: [...input.wireRecords, foreign] }, "candidate_set_mismatch");
        expect(failures).toEqual(["candidate_set_mismatch"]);
    });

    it("rejects a forward leg that does not submit the sealed candidate order", () => {
        const input = m0Report();
        const swapped = ["u1", "u0", "u2"];
        const failures = bindFailure(withWire(input, "f-q1-r0", {
            candidateIds: swapped,
            answers: answers(swapped, { u1: 0.25, u0: 0.75, u2: 0.5 }),
        }), "candidate_set_mismatch");
        expect(failures).toContain("candidate_set_mismatch");
    });
});

describe("projection to frozen DTOs (M1 only)", () => {
    it("projects a successful M1 wire record onto a frozen attempt record", () => {
        const wire = isolatedWire(Q1, "u0", 0);
        const attempt = projectMethodWireToComparisonAttempt(wire);
        if (attempt === null) throw new Error("expected M1 wire projection to succeed");
        expect(isComparisonAttemptRecord(attempt)).toBe(true);
        expect(attempt.attemptId).toBe(wire.wireId);
        expect(attempt.unitId).toBe("u0");
        expect(attempt.queryGroup).toBe(Q1);
        expect(attempt.probability).toBe(0.6);
        expect(attempt.replica).toBe(0);
        expect(attempt.payloadSha256).toBe(wire.payloadSha256);
        expect(attempt.cost).toEqual({ status: "known", usd: 0.001 });
    });

    it("projects a failed M1 wire record as a null-probability frozen attempt", () => {
        const wire = isolatedWire(Q1, "u0", 0, {
            httpStatus: null,
            errorClass: "network",
            servedModel: null,
            provider: null,
            answers: answers(["u0"], { u0: null }),
        });
        const attempt = projectMethodWireToComparisonAttempt(wire);
        if (attempt === null) throw new Error("expected M1 failure projection to succeed");
        expect(isComparisonAttemptRecord(attempt)).toBe(true);
        expect(attempt.probability).toBeNull();
        expect(attempt.servedModel).toBeNull();
    });

    it("projects an M1 warmup record with a null query group", () => {
        const wire = isolatedWire(Q1, "u0", 0, { wireId: "iso-warm", warmup: true, queryGroup: null });
        const attempt = projectMethodWireToComparisonAttempt(wire);
        if (attempt === null) throw new Error("expected M1 warmup projection to succeed");
        expect(isComparisonAttemptRecord(attempt)).toBe(true);
        expect(attempt.warmup).toBe(true);
        expect(attempt.queryGroup).toBeNull();
    });

    it("refuses to project M0 or M2 wire records (no 1:1 attempt exists)", () => {
        expect(projectMethodWireToComparisonAttempt(forwardWire())).toBeNull();
        expect(projectMethodWireToComparisonAttempt(reverseWire())).toBeNull();
        expect(projectMethodWireToComparisonAttempt("garbage")).toBeNull();
    });

    it("refuses to project a capture_gap wire record (the frozen §4.4 attempt record admits no capture-gap shape)", () => {
        const wire = isolatedWire(Q1, "u0", 0, {
            servedModel: null,
            provider: null,
            cost: { status: "unknown", reserveUsd: 0.0005 },
            errorClass: "capture_gap",
            answers: answers(["u0"], { u0: null }),
        });
        expect(isMethodWireRecord(wire)).toBe(true); // valid method-contract record…
        expect(projectMethodWireToComparisonAttempt(wire)).toBeNull(); // …that never projects onto the frozen attempt record
    });

    it("projects an M1 derived score onto a frozen scored outcome", () => {
        const score: MethodDerivedScore = {
            method: "M1",
            arm: ARM,
            phase: "pilot",
            replica: 1,
            queryGroup: Q1,
            candidateId: "u0",
            probability: 0.6,
            wireIds: [`iso-${Q1}-u0-r1`],
        };
        const outcome = projectMethodDerivedToScoredOutcome(score, { file: "src/search/grep-cascade.ts", truth: "gold" });
        if (outcome === null) throw new Error("expected M1 derived projection to succeed");
        expect(isComparisonScoredOutcome(outcome)).toBe(true);
        expect(outcome.unitId).toBe("u0");
        expect(outcome.replica).toBe(1);
        expect(outcome.probability).toBe(0.6);
        expect(outcome.attemptIds).toEqual([`iso-${Q1}-u0-r1`]);
        expect(outcome.file).toBe("src/search/grep-cascade.ts");
        expect(outcome.truth).toBe("gold");
    });

    it("refuses to project M0/M2 derived scores and invalid inputs", () => {
        const m0Score = { method: "M0", arm: ARM, phase: "pilot", replica: 0, queryGroup: Q1, candidateId: "u0", probability: 0.75, wireIds: ["f-q1-r0"] };
        const m2Score = { method: "M2", arm: ARM, phase: "pilot", replica: 0, queryGroup: Q1, candidateId: "u0", probability: 0.5, wireIds: ["f-q1-r0", "rev-q1-r0"] };
        const identity = { file: "src/a.ts", truth: "gold" as ComparisonTruthClass };
        expect(projectMethodDerivedToScoredOutcome(m0Score, identity)).toBeNull();
        expect(projectMethodDerivedToScoredOutcome(m2Score, identity)).toBeNull();
        expect(projectMethodDerivedToScoredOutcome(null, identity)).toBeNull();
        expect(projectMethodDerivedToScoredOutcome(
            { method: "M1", arm: ARM, phase: "pilot", replica: 0, queryGroup: Q1, candidateId: "u0", probability: 0.6, wireIds: ["x"] },
            { file: "src/a.ts", truth: "bogus" as ComparisonTruthClass },
        )).toBeNull();
    });
});

describe("derived score record validator", () => {
    it("accepts a well-formed derived score", () => {
        expect(isMethodDerivedScore({
            method: "M2",
            arm: ARM,
            phase: "pilot",
            replica: 1,
            queryGroup: Q1,
            candidateId: "u0",
            probability: null,
            wireIds: ["f-q1-r1", "rev-q1-r1"],
        })).toBe(true);
    });

    it("rejects out-of-range probability, empty link lists, and foreign keys", () => {
        const base = { method: "M0", arm: ARM, phase: "pilot", replica: 0, queryGroup: Q1, candidateId: "u0", probability: 0.5, wireIds: ["f-q1-r0"] };
        expect(isMethodDerivedScore({ ...base, probability: 1.5 })).toBe(false);
        expect(isMethodDerivedScore({ ...base, wireIds: [] })).toBe(false);
        expect(isMethodDerivedScore({ ...base, wireIds: ["", "x"] })).toBe(false);
        expect(isMethodDerivedScore({ ...base, replica: 5 })).toBe(false);
        expect(isMethodDerivedScore({ ...base, direction: "forward" })).toBe(false);
    });
});
