import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { analyzeMethodConfirmResults, CONFIRM_RESULTS_MODEL_ORDER } from "../../../scripts/eval/judge/method-confirm-results.js";
import { COMPARISON_SERVED_MODEL_ALLOWLIST, type ComparisonModelId } from "../../../scripts/eval/judge/model-comparison-types.js";
import type { ConfirmCorpusRoster } from "../../../scripts/eval/judge/method-confirm-fixture.js";
import type { MethodWireRecord } from "../../../scripts/eval/judge/method-comparison-contract.js";

const MODELS: ComparisonModelId[] = ["~typesafe/jev-latest", "perplexity/pplx-decider-v1.1-27b", "openai/gpt-6-luna-decisions"];
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
// This synthetic roster exercises the pure analysis core only. Production CLI trust comes from loadVerifiedConfirmCorpus; these fixtures do not claim to test that loader gate.
const roster = (): ConfirmCorpusRoster => ({
    queries: Array.from({ length: 400 }, (_, i) => ({ qid: `q${i}`, repo: `repo${i % 8}`, pin: "p", answerable: true })),
    candidates: Array.from({ length: 2_800 }, (_, i) => {
        const q = Math.floor(i / 7), candidate = i % 7;
        return { cid: `c${q}-${candidate}`, qid: `q${q}`, repo: `repo${q % 8}`, pin: "p", file: `src/${i}.ts`, startLine: 1, endLine: 1, label: candidate < 4 ? "gold" as const : "hard_negative" as const };
    }),
    sources: [], manifestSha256: "a".repeat(64),
});
const candidatesByQuery = (corpus: ConfirmCorpusRoster, qid: string) => corpus.candidates.filter((candidate) => candidate.qid === qid).map((candidate) => candidate.cid);
const plannedHash = (arm: ComparisonModelId, method: string, replica: number, qid: string, cids: readonly string[]) => sha(JSON.stringify([arm, method, replica, qid, cids]));

function fixture() {
    const corpus = roster();
    const requests: Record<string, unknown>[] = [];
    const completed: Record<string, unknown>[] = [];
    const blocked: Record<string, unknown>[] = [];
    const wires: MethodWireRecord[] = [];
    for (const [modelIndex, arm] of MODELS.entries()) for (let replica = 0; replica < 3; replica++) for (let q = 0; q < 400; q++) {
        const queryGroup = `q${q}`, candidateIds = candidatesByQuery(corpus, queryGroup);
        const forwardProbability = modelIndex === 1 ? 0.2 : 0.4;
        const forwardHash = plannedHash(arm, "M0", replica, queryGroup, candidateIds);
        requests.push({ arm, method: "M0", replica, queryGroup, warmup: false, candidateIds, payloadSha256: forwardHash, requestBytes: 10 });
        const forwardWireId = `${arm}|M0|${replica}|${queryGroup}`;
        wires.push({
            wireId: forwardWireId, method: "M0", arm, phase: "confirmation", replica, warmup: false, direction: "forward", queryGroup,
            candidateIds: [...candidateIds], rulesetVersion: "A3", attemptIndex: 1, requestBytes: 10, payloadSha256: forwardHash,
            httpStatus: 200, servedModel: COMPARISON_SERVED_MODEL_ALLOWLIST[arm], provider: "synthetic", inputTokens: 1, outputTokens: 1,
            cost: { status: "known", usd: 0.00001 }, errorClass: null, requestTimestamp: "2026-10-10T00:00:00.000Z", latencyMs: 1,
            answers: candidateIds.map((candidateId) => ({ candidateId, probability: forwardProbability })),
        });
        for (const candidateId of candidateIds) completed.push({ arm, method: "M0", replica, queryGroup, candidateId, probability: forwardProbability, wireIds: [forwardWireId] });

        const challenger = ["M1", "M2", "M1"][modelIndex]!;
        if (challenger === "M1") {
            for (const candidateId of candidateIds) {
                const ids = [candidateId], payloadSha256 = plannedHash(arm, "M1", replica, queryGroup, ids);
                requests.push({ arm, method: "M1", replica, queryGroup, warmup: false, candidateIds: ids, payloadSha256, requestBytes: 10 });
                const wireId = `${arm}|M1|${replica}|${queryGroup}|${candidateId}`;
                wires.push({
                    wireId, method: "M1", arm, phase: "confirmation", replica, warmup: false, direction: "isolated", queryGroup,
                    candidateIds: ids, rulesetVersion: "A3", attemptIndex: 1, requestBytes: 10, payloadSha256,
                    httpStatus: 200, servedModel: COMPARISON_SERVED_MODEL_ALLOWLIST[arm], provider: "synthetic", inputTokens: 1, outputTokens: 1,
                    cost: { status: "known", usd: 0.00001 }, errorClass: null, requestTimestamp: "2026-10-10T00:00:00.000Z", latencyMs: 1,
                    answers: [{ candidateId, probability: 0.8 }],
                });
                completed.push({ arm, method: "M1", replica, queryGroup, candidateId, probability: 0.8, wireIds: [wireId] });
            }
        } else {
            const reverseIds = [...candidateIds].reverse(), payloadSha256 = plannedHash(arm, "M2", replica, queryGroup, reverseIds);
            requests.push({ arm, method: "M2", replica, queryGroup, warmup: false, candidateIds: reverseIds, payloadSha256, requestBytes: 10 });
            const wireId = `${arm}|M2|${replica}|${queryGroup}`;
            wires.push({
                wireId, method: "M2", arm, phase: "confirmation", replica, warmup: false, direction: "reverse", queryGroup,
                candidateIds: reverseIds, rulesetVersion: "A3", attemptIndex: 1, requestBytes: 10, payloadSha256,
                httpStatus: 200, servedModel: COMPARISON_SERVED_MODEL_ALLOWLIST[arm], provider: "synthetic", inputTokens: 1, outputTokens: 1,
                cost: { status: "known", usd: 0.00001 }, errorClass: null, requestTimestamp: "2026-10-10T00:00:00.000Z", latencyMs: 1,
                answers: reverseIds.map((candidateId) => ({ candidateId, probability: 0.8 })),
            });
            for (const candidateId of candidateIds) completed.push({ arm, method: "M2", replica, queryGroup, candidateId, probability: (forwardProbability + 0.8) / 2, wireIds: [forwardWireId, wireId] });
        }
    }
    const plan = { version: 1, kind: "method-confirm-plan", manifestSha256: corpus.manifestSha256, queryCount: 400, candidateCount: 2_800, replicaCount: 3, requests };
    const planSha256 = sha(`${JSON.stringify(plan, null, 2)}\n`);
    const results = { version: 1, kind: "method-confirm-results", manifestSha256: corpus.manifestSha256, planSha256, completed, blocked, integrity: { aborted: false, captureGaps: [], finalAttemptUnverified: [], servedIdentityDrift: [], payloadDrift: [], retryAnswerDrift: [] } };
    return { corpus, plan, results, wires };
}
const analyze = (f = fixture()) => analyzeMethodConfirmResults({ roster: f.corpus, plan: f.plan, results: f.results, wireRecords: f.wires });
const modelsOf = (result: ReturnType<typeof analyze>) => (result.primary as { models: Array<Record<string, any>> }).models;
const resultCell = (f: ReturnType<typeof fixture>, arm: ComparisonModelId, method: string, qid: string, candidateId: string, replica: number) => (f.results as any).completed.find((cell: any) => cell.arm === arm && cell.method === method && cell.queryGroup === qid && cell.candidateId === candidateId && cell.replica === replica);
const rebindPlanHash = (f: ReturnType<typeof fixture>): void => { (f.results as any).planSha256 = sha(`${JSON.stringify(f.plan, null, 2)}\n`); };
const dispatchKeyOf = (request: Record<string, any>): string => [request.arm, request.method, request.replica, request.queryGroup ?? "warmup", request.warmup, request.payloadSha256].join("|");
const expectIntegrityFailClosed = (f: ReturnType<typeof fixture>, modelIndex: number, reason: string): void => {
    let output: ReturnType<typeof analyze> | undefined;
    try { output = analyze(f); } catch (error) {
        expect(String(error), reason).toMatch(/integrity|drift|unverified|final attempt/i);
        return;
    }
    const model = modelsOf(output)[modelIndex]!;
    expect(model.status, reason).toBe("blocked");
    expect(model.pRaw, reason).toBeNull();
    expect(model.pHolmAdjusted, reason).toBeNull();
    expect(model.adopt, reason).toBe(false);
    expect(model.adoptionReason, reason).toBe("blocked by incomplete/integrity");
};

describe("analyzeMethodConfirmResults", () => {
    it("accepts all exact shared allowlisted served identities and blocks the superseded PPLX pin", () => {
        expect(modelsOf(analyze())[1]!.status).toBe("complete");
        const f = fixture();
        const drifted = f.wires.find((record) => record.arm === MODELS[1])!;
        drifted.servedModel = "perplexity/pplx-decider-v1-27b-20261001";
        const request = f.plan.requests.find((entry: any) => entry.arm === drifted.arm && entry.method === drifted.method && entry.replica === drifted.replica && entry.queryGroup === drifted.queryGroup && entry.warmup === drifted.warmup && entry.payloadSha256 === drifted.payloadSha256)! as Record<string, any>;
        (f.results as any).integrity.servedIdentityDrift = [drifted.wireId];
        (f.results as any).integrity.finalAttemptUnverified = [dispatchKeyOf(request)];
        const pplx = modelsOf(analyze(f))[1]!;
        expect(pplx.status).toBe("blocked");
        expect(pplx.pRaw).toBeNull();
    }, 120_000);

    it("thresholds candidate replica means, not replica votes, and includes equality at .40", () => {
        const f = fixture();
        for (const [replica, probability] of [[0, 0.9], [1, 0.2], [2, 0.2]] as const) {
            resultCell(f, MODELS[0], "M0", "q0", "c0-4", replica).probability = probability;
            const wire = f.wires.find((record) => record.arm === MODELS[0] && record.method === "M0" && record.queryGroup === "q0" && record.replica === replica)!;
            wire.answers.find((answer) => answer.candidateId === "c0-4")!.probability = probability;
        }
        const jev = modelsOf(analyze(f))[0]!;
        expect((jev.fp as any).M0).toBe(1_200);
        expect(jev.status).toBe("complete");
    });

    it("uses the runner's M2 forward/reverse combination exactly once", () => {
        const pplx = modelsOf(analyze())[1]!;
        expect(pplx.delta).toBe(-21);
        expect(pplx.fn).toEqual({ M0: 1_600, challenger: 0, delta: -1_600 });
        expect(pplx.fp).toEqual({ M0: 0, challenger: 1_200, delta: 1_200 });
    });

    it("blocks incomplete models without publishing partial-case statistics and retains the three-test family", () => {
        const f = fixture();
        const omitted = resultCell(f, MODELS[0], "M0", "q0", "c0-0", 0);
        (f.results as any).completed = (f.results as any).completed.filter((cell: unknown) => cell !== omitted);
        const models = modelsOf(analyze(f));
        expect(models[0]!.status).toBe("blocked");
        expect(models[0]!.delta).toBeNull();
        expect(models[0]!.fn).toBeNull();
        expect(models[0]!.fp).toBeNull();
        expect(models[0]!.pRaw).toBeNull();
        expect(models[0]!.pHolmAdjusted).toBeNull();
        expect(models[0]!.WTL).toBeNull();
        expect(models[0]!.adoptionReason).toBe("blocked by incomplete/integrity");
        expect(models[2]!.status).toBe("complete");
        expect((analyze(f).primary as any).familySize).toBe(3);
    }, 120_000);

    it("rejects wire candidate-order changes even when candidate membership is otherwise valid", () => {
        const f = fixture();
        const wire = f.wires.find((record) => record.arm === MODELS[0] && record.method === "M0")!;
        wire.candidateIds.reverse();
        wire.answers.reverse();
        expect(() => analyze(f)).toThrow(/planned request/);
    });

    it("deduplicates wire IDs, detects conflicting retry answers, recovers matching transport retries, and retains UNKNOWN costs", () => {
        const recovered = fixture();
        const failed = recovered.wires.find((record) => record.arm === MODELS[0] && record.method === "M0" && record.queryGroup === "q0" && record.replica === 0)!;
        const success = { ...failed, wireId: `${failed.wireId}-retry`, attemptIndex: 2, answers: failed.answers.map((answer) => ({ ...answer })) };
        failed.httpStatus = 503; failed.servedModel = null; failed.provider = null; failed.errorClass = "http_503";
        failed.answers.forEach((answer) => { answer.probability = null; });
        failed.inputTokens = null; failed.outputTokens = null; failed.cost = { status: "unknown", reserveUsd: 0.001 };
        recovered.wires.push(success);
        for (const cell of (recovered.results as any).completed.filter((entry: any) => entry.arm === MODELS[0] && entry.method === "M0" && entry.queryGroup === "q0" && entry.replica === 0)) cell.wireIds.push(success.wireId);
        const output = analyze(recovered);
        expect(modelsOf(output)[0]!.status).toBe("complete");
        expect((output.availability as any)[MODELS[0]].recoveredFailures).toBe(1);
        expect((output.costs as any)[MODELS[0]].M0.unknownReservationsUsd).toBe(0.001);
        expect((output.costs as any)[MODELS[0]].M0.inputTokensUnknownCount).toBe(1);

        const drift = fixture();
        const first = drift.wires.find((record) => record.arm === MODELS[0] && record.method === "M0" && record.queryGroup === "q0" && record.replica === 0)!;
        const conflicting = { ...first, wireId: `${first.wireId}-conflict`, attemptIndex: 2, answers: first.answers.map((answer) => ({ ...answer })) };
        conflicting.answers[0]!.probability = 0.99;
        drift.wires.push(conflicting);
        for (const cell of (drift.results as any).completed.filter((entry: any) => entry.arm === MODELS[0] && entry.method === "M0" && entry.queryGroup === "q0" && entry.replica === 0)) cell.wireIds.push(conflicting.wireId);
        (drift.results as any).integrity.retryAnswerDrift = [first.wireId, conflicting.wireId];
        const driftedModel = modelsOf(analyze(drift))[0]!;
        expect(driftedModel.status).toBe("blocked");
        expect(driftedModel.pRaw).toBeNull();
        expect(driftedModel.adoptionReason).toBe("blocked by incomplete/integrity");
    }, 120_000);

    it("blocks A3 capture gaps and records without the A3 stamp", () => {
        const gap = fixture();
        const record = gap.wires.find((entry) => entry.arm === MODELS[0] && entry.method === "M0" && entry.queryGroup === "q0" && entry.replica === 0)!;
        record.errorClass = "capture_gap"; record.servedModel = null; record.provider = null; record.cost = { status: "unknown", reserveUsd: 0.001 };
        record.answers.forEach((answer) => { answer.probability = null; });
        const cells = (gap.results as any).completed;
        const affected = cells.filter((cell: any) => cell.arm === MODELS[0] && cell.method === "M0" && cell.queryGroup === "q0" && cell.replica === 0);
        (gap.results as any).completed = cells.filter((cell: unknown) => !affected.includes(cell));
        for (const cell of affected) (gap.results as any).blocked.push({ ...cell, probability: null, reason: "blocked" });
        (gap.results as any).integrity.captureGaps = [record.wireId];
        const failedRequest = gap.plan.requests.find((entry: any) => entry.arm === record.arm && entry.method === record.method && entry.replica === record.replica && entry.queryGroup === record.queryGroup && entry.warmup === record.warmup && entry.payloadSha256 === record.payloadSha256)! as Record<string, any>;
        (gap.results as any).integrity.finalAttemptUnverified = [dispatchKeyOf(failedRequest)];
        const captureGapModel = modelsOf(analyze(gap))[0]!;
        expect(captureGapModel.status).toBe("blocked");
        expect(captureGapModel.adoptionReason).toBe("blocked by incomplete/integrity");
        expect(captureGapModel.pRaw).toBeNull();
        expect(captureGapModel.pHolmAdjusted).toBeNull();

        const unstamped = fixture();
        const unstampedRecord = unstamped.wires.find((entry) => entry.arm === MODELS[0])!;
        delete (unstampedRecord as any).rulesetVersion;
        const unstampedRequest = unstamped.plan.requests.find((entry: any) => entry.arm === unstampedRecord.arm && entry.method === unstampedRecord.method && entry.replica === unstampedRecord.replica && entry.queryGroup === unstampedRecord.queryGroup && entry.warmup === unstampedRecord.warmup && entry.payloadSha256 === unstampedRecord.payloadSha256)! as Record<string, any>;
        (unstamped.results as any).integrity.finalAttemptUnverified = [dispatchKeyOf(unstampedRequest)];
        const unstampedModel = modelsOf(analyze(unstamped))[0]!;
        expect(unstampedModel.status).toBe("blocked");
        expect(unstampedModel.adoptionReason).toBe("blocked by incomplete/integrity");
    }, 120_000);

    it("rejects duplicate cells, hash tampering, and non-finite or out-of-range probabilities", () => {
        const duplicate = fixture();
        (duplicate.results as any).completed.push({ ...(duplicate.results as any).completed[0] });
        expect(() => analyze(duplicate)).toThrow(/duplicate/);
        const badHash = fixture();
        (badHash.results as any).planSha256 = "0".repeat(64);
        expect(() => analyze(badHash)).toThrow(/hash/);
        for (const probability of [Number.NaN, Number.POSITIVE_INFINITY, -0.01, 1.01]) {
            const bad = fixture();
            (bad.results as any).completed[0].probability = probability;
            expect(() => analyze(bad)).toThrow(/probability/);
        }
    });

    it("applies the FN guard even after Holm rejects", () => {
        const f = fixture();
        const improved = new Set<string>();
        for (const candidate of f.corpus.candidates.filter((entry) => entry.label !== "gold").slice(0, 200)) improved.add(`${candidate.qid}|${candidate.cid}`);
        for (const candidate of f.corpus.candidates.filter((entry) => entry.label === "gold").slice(0, 2)) improved.add(`${candidate.qid}|${candidate.cid}`);
        for (const cell of (f.results as any).completed.filter((entry: any) => entry.arm === MODELS[0] && entry.method === "M1" && improved.has(`${entry.queryGroup}|${entry.candidateId}`))) {
            cell.probability = 0.2;
            const wire = f.wires.find((record) => record.arm === MODELS[0] && record.method === "M1" && record.queryGroup === cell.queryGroup && record.replica === cell.replica && record.candidateIds.includes(cell.candidateId))!;
            wire.answers[0]!.probability = 0.2;
        }
        const jev = modelsOf(analyze(f))[0]!;
        expect(jev.pRaw).toBeLessThan(0.05 / 3);
        expect((jev.fn as any).delta).toBe(2);
        expect(jev.adopt).toBe(false);
        expect(jev.adoptionReason).toBe("FN guard failed");
    });

    it("keeps tied hypotheses in fixed order and uses the frozen 3-test family", () => {
        const f = fixture();
        for (const cell of (f.results as any).completed) {
            if (cell.method === "M0") continue;
            cell.probability = cell.arm === MODELS[1] ? 0.2 : 0.4;
            const wireMethod = cell.method === "M2" ? "M2" : cell.method;
            const wire = f.wires.find((record) => record.arm === cell.arm && record.method === wireMethod && record.replica === cell.replica && record.queryGroup === cell.queryGroup && record.candidateIds.includes(cell.candidateId))!;
            wire.answers.find((answer) => answer.candidateId === cell.candidateId)!.probability = cell.arm === MODELS[1] ? 0.2 : 0.4;
        }
        const result = analyze(f), models = modelsOf(result);
        expect((result.primary as any).tieOrder).toEqual(CONFIRM_RESULTS_MODEL_ORDER.map((model) => model.arm));
        expect((result.primary as any).familySize).toBe(3);
        expect(models.map((model) => model.pRaw)).toEqual([1, 1, 1]);
        expect(models.map((model) => model.pHolmAdjusted)).toEqual([1, 1, 1]);
    });

    const cleanWireSummaryCases = [
        ["finalAttemptUnverified", (f: ReturnType<typeof fixture>) => {
            const request = f.plan.requests.find((entry: any) => entry.arm === MODELS[0] && entry.method === "M0" && entry.replica === 0 && entry.queryGroup === "q0") as any;
            return [request.arm, request.method, request.replica, request.queryGroup, request.warmup, request.payloadSha256].join("|");
        }],
        ["servedIdentityDrift", (f: ReturnType<typeof fixture>) => f.wires.find((entry) => entry.arm === MODELS[0] && entry.method === "M0" && entry.replica === 0 && entry.queryGroup === "q0")!.wireId],
        ["payloadDrift", (f: ReturnType<typeof fixture>) => f.wires.find((entry) => entry.arm === MODELS[0] && entry.method === "M0" && entry.replica === 0 && entry.queryGroup === "q0")!.wireId],
        ["retryAnswerDrift", (f: ReturnType<typeof fixture>) => f.wires.find((entry) => entry.arm === MODELS[0] && entry.method === "M0" && entry.replica === 0 && entry.queryGroup === "q0")!.wireId],
    ] as const;
    for (const [flag, referenceOf] of cleanWireSummaryCases) {
        it(`fails closed for a known ${flag} summary reference when its wire is otherwise clean`, () => {
            const f = fixture();
            (f.results as any).integrity[flag] = [referenceOf(f)];
            expectIntegrityFailClosed(f, 0, flag);
        });
    }

    for (const flag of ["finalAttemptUnverified", "servedIdentityDrift", "payloadDrift", "retryAnswerDrift"] as const) {
        it(`rejects an unknown ${flag} reference`, () => {
            const f = fixture();
            (f.results as any).integrity[flag] = ["not-a-planned-wire-or-dispatch-id"];
            expect(() => analyze(f), flag).toThrow(/integrity|unknown|reference|planned/i);
        });
    }

    it("rejects an adverse final attempt omitted from the integrity summary", () => {
        const f = fixture();
        const record = f.wires.find((entry) => entry.arm === MODELS[0] && entry.method === "M0" && entry.replica === 0 && entry.queryGroup === "q0")!;
        record.httpStatus = 503; record.servedModel = null; record.provider = null; record.errorClass = "http_503";
        record.cost = { status: "unknown", reserveUsd: 0.001 }; record.inputTokens = null; record.outputTokens = null;
        record.answers.forEach((answer) => { answer.probability = null; });
        const rows = (f.results as any).completed;
        const blockedRows = rows.filter((cell: any) => cell.arm === MODELS[0] && cell.method === "M0" && cell.replica === 0 && cell.queryGroup === "q0");
        (f.results as any).completed = rows.filter((cell: unknown) => !blockedRows.includes(cell));
        for (const cell of blockedRows) (f.results as any).blocked.push({ ...cell, probability: null, reason: "blocked" });
        expect((f.results as any).integrity.finalAttemptUnverified).toEqual([]);
        expect(() => analyze(f)).toThrow(/finalAttemptUnverified summary disagrees with wire ledger/);
    });

    it("validates plan requestBytes and exact wire-to-plan bytecount binding", () => {
        expect(modelsOf(analyze())[0]!.status).toBe("complete");
        for (const invalid of [undefined, 1.5, -1]) {
            const f = fixture();
            const request = f.plan.requests.find((entry: any) => entry.arm === MODELS[0] && entry.method === "M0") as any;
            if (invalid === undefined) delete request.requestBytes;
            else request.requestBytes = invalid;
            rebindPlanHash(f);
            expect(() => analyze(f)).toThrow(/requestBytes|request byte|byte count/i);
        }
        const mismatched = fixture();
        const request = mismatched.plan.requests.find((entry: any) => entry.arm === MODELS[0] && entry.method === "M0") as any;
        request.requestBytes += 1;
        rebindPlanHash(mismatched);
        expect(() => analyze(mismatched)).toThrow(/requestBytes|request byte|byte count/i);
    });

    it("uses reproducible primary sign-flip output with exactly 100,000 draws and seed 20261010", () => {
        const first = analyze(), second = analyze();
        const primary = first.primary as Record<string, unknown>;
        expect(primary.draws).toBe(100_000);
        expect(primary.seed).toBe(20_261_010);
        expect(JSON.stringify(modelsOf(first).map((model) => model.pRaw))).toBe(JSON.stringify(modelsOf(second).map((model) => model.pRaw)));
    }, 120_000);
});
