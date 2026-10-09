#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadVerifiedConfirmCorpus, type ConfirmCorpusRoster } from "./method-confirm-fixture.js";
import { isMethodWireRecord, type MethodWireRecord } from "./method-comparison-contract.js";
import { buildSignMatrix, CONFIRM_SIGN_FLIP_DRAWS, CONFIRM_SIGN_FLIP_SEED, holmStepDown, signFlipOneSidedPValue, studentTCdf } from "./method-confirm-analysis.js";
import { FROZEN_KEEP_THRESHOLD } from "./model-comparison-stats.js";
import { METHOD_CONFIRM_MODELS } from "./method-confirm.js";
import { EXPLORATORY_WEIGHTED_FN_PENALTY } from "./method-pilot-exploratory.js";
import { COMPARISON_SERVED_MODEL_ALLOWLIST, isComparisonModelId, type ComparisonModelId } from "./model-comparison-types.js";

export const CONFIRM_RESULTS_MODEL_ORDER = Object.freeze([
    { arm: "~typesafe/jev-latest", method: "M1" },
    { arm: "perplexity/pplx-decider-v1.1-27b", method: "M2" },
    { arm: "openai/gpt-6-luna-decisions", method: "M1" },
] as const);
const ALPHA = 0.05;
const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const stable = (parts: readonly unknown[]): string => JSON.stringify(parts);
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export interface ConfirmResultsAnalysisOptions {
    roster: ConfirmCorpusRoster;
    plan: unknown;
    results: unknown;
    wireRecords: readonly unknown[];
}

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
}

interface ConfirmResultsIntegritySummary {
    aborted: boolean;
    captureGaps: string[];
    finalAttemptUnverified: string[];
    servedIdentityDrift: string[];
    payloadDrift: string[];
    retryAnswerDrift: string[];
}

function parseIntegrityReferences(value: unknown, field: string): string[] {
    if (!Array.isArray(value)) throw new Error(`invalid result integrity.${field}`);
    const references: string[] = [];
    for (const reference of value) {
        if (typeof reference !== "string") throw new Error(`invalid result integrity.${field}`);
        references.push(reference);
    }
    return references;
}

interface ParsedConfirmRequest {
    arm: ComparisonModelId;
    method: "M0" | "M1" | "M2";
    replica: number;
    queryGroup: string | null;
    warmup: boolean;
    candidateIds: string[];
    payloadSha256: string;
    requestBytes: number;
}

function confirmationDispatchKey(request: ParsedConfirmRequest): string {
    return [request.arm, request.method, request.replica, request.queryGroup ?? "warmup", request.warmup, request.payloadSha256].join("|");
}

function parsePlan(value: unknown, manifestSha256: string): { hash: string; requests: ParsedConfirmRequest[] } {
    if (!isObject(value)) throw new Error("invalid confirmation plan");
    assert(value.version === 1 && value.kind === "method-confirm-plan", "invalid confirmation plan");
    assert(value.manifestSha256 === manifestSha256, "plan manifest hash does not match verified corpus");
    assert(typeof value.queryCount === "number" && value.queryCount === 400
        && typeof value.candidateCount === "number" && value.candidateCount > 0
        && typeof value.replicaCount === "number" && value.replicaCount === 3, "plan composition mismatch");
    const rawRequests = value.requests;
    if (!Array.isArray(rawRequests)) throw new Error("plan requests missing");
    const bytes = `${JSON.stringify(value, null, 2)}\n`;
    const requests: ParsedConfirmRequest[] = [];
    const seen = new Set<string>();
    for (const rawRequest of rawRequests) {
        if (!isObject(rawRequest)) throw new Error("invalid planned request");
        const request = rawRequest;
        const rawArm = request.arm;
        if (!isComparisonModelId(rawArm)) throw new Error("invalid planned request arm");
        const rawMethod = request.method;
        if (rawMethod !== "M0" && rawMethod !== "M1" && rawMethod !== "M2") throw new Error("invalid planned method");
        const rawReplica = request.replica;
        if (typeof rawReplica !== "number" || !Number.isInteger(rawReplica) || rawReplica < 0 || rawReplica >= 3) throw new Error("invalid planned replica");
        const rawWarmup = request.warmup;
        if (typeof rawWarmup !== "boolean") throw new Error("invalid planned warmup flag");
        const rawQueryGroup = request.queryGroup;
        let queryGroup: string | null;
        if (rawWarmup) {
            if (rawQueryGroup !== null) throw new Error("invalid planned warmup query group");
            queryGroup = null;
        } else {
            if (typeof rawQueryGroup !== "string" || rawQueryGroup.length === 0) throw new Error("invalid planned query group");
            queryGroup = rawQueryGroup;
        }
        const rawPayloadSha256 = request.payloadSha256;
        if (typeof rawPayloadSha256 !== "string" || !/^[a-f0-9]{64}$/.test(rawPayloadSha256)) throw new Error("invalid planned payload hash");
        const rawRequestBytes = request.requestBytes;
        if (typeof rawRequestBytes !== "number" || !Number.isSafeInteger(rawRequestBytes) || rawRequestBytes < 0) throw new Error("invalid planned requestBytes");
        const rawCandidateIds = request.candidateIds;
        if (!Array.isArray(rawCandidateIds) || rawCandidateIds.length === 0) throw new Error("invalid planned candidate list");
        const candidateIds: string[] = [];
        for (const candidateId of rawCandidateIds) {
            if (typeof candidateId !== "string" || candidateId.length === 0) throw new Error("invalid planned candidate list");
            candidateIds.push(candidateId);
        }
        if (new Set(candidateIds).size !== candidateIds.length) throw new Error("invalid planned candidate list");
        const arm = rawArm;
        const method = rawMethod;
        const replica = rawReplica;
        const warmup = rawWarmup;
        const payloadSha256 = rawPayloadSha256;
        const requestBytes = rawRequestBytes;
        const key = stable([arm, method, replica, queryGroup, warmup, payloadSha256]);
        assert(!seen.has(key), "duplicate planned component");
        seen.add(key);
        requests.push({ arm, method, replica, queryGroup, warmup, candidateIds, payloadSha256, requestBytes });
    }
    return { hash: sha256(bytes), requests };
}

function mean(values: readonly number[]): number { return values.reduce((a, b) => a + b, 0) / values.length; }
function tCritical95(df: number): number {
    let lo = 0, hi = 20;
    for (let i = 0; i < 80; i += 1) { const mid = (lo + hi) / 2; if (studentTCdf(mid, df) < 0.975) lo = mid; else hi = mid; }
    return (lo + hi) / 2;
}
function interval(values: readonly number[]): [number, number] {
    const avg = mean(values); const variance = values.reduce((sum, x) => sum + (x - avg) ** 2, 0) / (values.length - 1);
    const margin = tCritical95(values.length - 1) * Math.sqrt(variance / values.length);
    return [avg - margin, avg + margin];
}

/** Pure boundary validation and preregistered aggregate derivation. */
export function analyzeMethodConfirmResults(input: ConfirmResultsAnalysisOptions): Record<string, unknown> {
    const { roster } = input;
    const queries = new Map(roster.queries.map((q) => [q.qid, q]));
    const candidates = new Map(roster.candidates.map((c) => [c.cid, c]));
    assert(roster.queries.length === 400 && roster.candidates.length === 2_800 && roster.queries.every((query) => roster.candidates.filter((candidate) => candidate.qid === query.qid).length === 7), "verified roster must contain 400 queries × 7 candidates");
    const rawPlan = input.plan;
    if (!isObject(rawPlan)) throw new Error("invalid confirmation plan");
    assert(typeof rawPlan.candidateCount === "number" && rawPlan.candidateCount === roster.candidates.length, "plan candidate count does not match verified corpus");
    const plan = parsePlan(rawPlan, roster.manifestSha256);
    const result = input.results;
    if (!isObject(result) || result.version !== 1 || result.kind !== "method-confirm-results") throw new Error("invalid result artifact");
    assert(result.manifestSha256 === roster.manifestSha256 && result.planSha256 === plan.hash, "result hash binding mismatch");
    const rawIntegritySummary = result.integrity;
    if (!Array.isArray(result.completed) || !Array.isArray(result.blocked) || !isObject(rawIntegritySummary)) throw new Error("invalid result artifact shape");
    assert(JSON.stringify(Object.keys(result).sort()) === JSON.stringify(["blocked", "completed", "integrity", "kind", "manifestSha256", "planSha256", "version"].sort()), "unexpected result artifact fields");
    const integrityKeys = ["aborted", "captureGaps", "finalAttemptUnverified", "servedIdentityDrift", "payloadDrift", "retryAnswerDrift"];
    assert(JSON.stringify(Object.keys(rawIntegritySummary).sort()) === JSON.stringify([...integrityKeys].sort()), "invalid result integrity summary");
    if (typeof rawIntegritySummary.aborted !== "boolean") throw new Error("invalid result integrity.aborted");
    const integritySummary: ConfirmResultsIntegritySummary = {
        aborted: rawIntegritySummary.aborted,
        captureGaps: parseIntegrityReferences(rawIntegritySummary.captureGaps, "captureGaps"),
        finalAttemptUnverified: parseIntegrityReferences(rawIntegritySummary.finalAttemptUnverified, "finalAttemptUnverified"),
        servedIdentityDrift: parseIntegrityReferences(rawIntegritySummary.servedIdentityDrift, "servedIdentityDrift"),
        payloadDrift: parseIntegrityReferences(rawIntegritySummary.payloadDrift, "payloadDrift"),
        retryAnswerDrift: parseIntegrityReferences(rawIntegritySummary.retryAnswerDrift, "retryAnswerDrift"),
    };

    const completedRows = result.completed;
    const blockedRows = result.blocked;
    if (!Array.isArray(completedRows) || !Array.isArray(blockedRows)) throw new Error("invalid result artifact shape");
    const plannedCandidates = new Map<string, Set<string>>();
    const plannedRequests = new Map<string, ParsedConfirmRequest>();
    for (const req of plan.requests) {
        assert(typeof req.arm === "string" && typeof req.method === "string" && typeof req.replica === "number" && Number.isInteger(req.replica) && typeof req.warmup === "boolean", "invalid planned request identity");
        const requestArm = req.arm, requestMethod = req.method, requestQid = req.queryGroup;
        plannedRequests.set(stable([requestArm, requestMethod, req.replica, requestQid, req.warmup, req.payloadSha256]), req);
        if (req.warmup === true) continue;
        const arm = String(req.arm), method = String(req.method), qid = String(req.queryGroup);
        const key = [arm, method, req.replica, qid].join("|");
        assert(Array.isArray(req.candidateIds), "planned candidate list missing");
        const cellCandidates = plannedCandidates.get(key) ?? new Set<string>();
        for (const cid of req.candidateIds) { assert(candidates.get(cid)?.qid === qid, "unexpected planned candidate"); cellCandidates.add(cid); }
        plannedCandidates.set(key, cellCandidates);
    }
    for (const config of METHOD_CONFIRM_MODELS) for (const query of roster.queries) {
        const candidateIds = roster.candidates.filter((candidate) => candidate.qid === query.qid).map((candidate) => candidate.cid);
        for (let replica = 0; replica < 3; replica += 1) for (const method of ["M0", config.challenger]) {
            const key = [config.arm, method, replica, query.qid].join("|");
            const planned = plannedCandidates.get(key);
            assert(planned !== undefined && planned.size === candidateIds.length && candidateIds.every((cid) => planned.has(cid)), `plan candidate coverage mismatch ${key}`);
            const requests = plan.requests.filter((request) => request.arm === config.arm && request.method === method && request.replica === replica && request.queryGroup === query.qid && request.warmup === false);
            if (method === "M1") assert(requests.length === candidateIds.length && requests.every((request) => Array.isArray(request.candidateIds) && request.candidateIds.length === 1), `M1 plan must contain one request per candidate ${key}`);
            else {
                assert(requests.length === 1, `packed plan must contain one request per query ${key}`);
                const expectedOrder = method === "M2" ? [...candidateIds].reverse() : candidateIds;
                assert(JSON.stringify(requests[0]!.candidateIds) === JSON.stringify(expectedOrder), `packed request candidate order differs from sealed roster ${key}`);
            }
        }
    }
    const completed = new Map<string, { probability: number; wireIds: string[] }>();
    const blockedKeys = new Set<string>();
    for (const [kind, rows] of [["completed", completedRows], ["blocked", blockedRows]] as const) {
        for (const raw of rows) {
            assert(isObject(raw), `invalid ${kind} cell`);
            const { arm, method, queryGroup, candidateId, replica } = raw;
            assert(typeof arm === "string" && typeof method === "string" && typeof queryGroup === "string" && typeof candidateId === "string" && typeof replica === "number" && Number.isInteger(replica), `invalid ${kind} identity`);
            assert(queries.has(queryGroup) && candidates.get(candidateId)?.qid === queryGroup, `unexpected ${kind} candidate/query`);
            assert(METHOD_CONFIRM_MODELS.some((m) => m.arm === arm && (m.challenger === method || method === "M0")), `unexpected ${kind} model/method`);
            assert(replica >= 0 && replica < 3, "unexpected replica");
            const key = [arm, method, replica, queryGroup, candidateId].join("|");
            assert(!completed.has(key) && !blockedKeys.has(key), `duplicate result cell ${key}`);
            const hashKey = [arm, method, replica, queryGroup].join("|");
            assert(plannedCandidates.get(hashKey)?.has(String(candidateId)), `unplanned result cell ${key}`);
            if (kind === "completed") {
                const probability = raw.probability;
                assert(typeof probability === "number" && Number.isFinite(probability) && probability >= 0 && probability <= 1, `invalid probability ${key}`);
                const rawWireIds = raw.wireIds;
                assert(Array.isArray(rawWireIds) && rawWireIds.length > 0 && rawWireIds.every((id): id is string => typeof id === "string"), `invalid wire links ${key}`);
                completed.set(key, { probability, wireIds: rawWireIds });
            } else {
                const rawWireIds = raw.wireIds;
                assert(raw.probability === null && Array.isArray(rawWireIds) && rawWireIds.every((id) => typeof id === "string") && typeof raw.reason === "string", `invalid blocked cell ${key}`);
                blockedKeys.add(key);
            }
        }
    }

    const wireIds = new Map<string, MethodWireRecord>();
    const uniqueWires: MethodWireRecord[] = [];
    const integrityFailureArms = new Set<string>();
    for (const raw of input.wireRecords) {
        assert(isMethodWireRecord(raw), "invalid wire record");
        const prior = wireIds.get(raw.wireId);
        if (prior) { assert(JSON.stringify(prior) === JSON.stringify(raw), `conflicting duplicate wireId ${raw.wireId}`); continue; }
        wireIds.set(raw.wireId, raw); uniqueWires.push(raw);
        assert(raw.phase === "confirmation", "wire record is not confirmation data");
        if (raw.rulesetVersion !== "A3") integrityFailureArms.add(raw.arm);
        const planned = plannedRequests.get(stable([raw.arm, raw.method, raw.replica, raw.queryGroup, raw.warmup, raw.payloadSha256]));
        assert(planned !== undefined && planned.payloadSha256 === raw.payloadSha256 && planned.requestBytes === raw.requestBytes && JSON.stringify(planned.candidateIds) === JSON.stringify(raw.candidateIds), `wire does not exactly match planned request/requestBytes ${raw.wireId}`);
        if (raw.servedModel !== null && raw.servedModel !== COMPARISON_SERVED_MODEL_ALLOWLIST[raw.arm]) integrityFailureArms.add(raw.arm);
    }
    const attemptsByPlannedRequest = new Map<string, MethodWireRecord[]>();
    for (const record of uniqueWires) {
        const key = stable([record.arm, record.method, record.replica, record.queryGroup, record.warmup, record.payloadSha256, record.candidateIds]);
        const attempts = attemptsByPlannedRequest.get(key) ?? [];
        attempts.push(record);
        attemptsByPlannedRequest.set(key, attempts);
    }
    for (const attempts of attemptsByPlannedRequest.values()) {
        attempts.sort((a, b) => a.attemptIndex - b.attemptIndex);
        if (attempts.some((record, index) => record.attemptIndex !== index + 1)) integrityFailureArms.add(attempts[0]!.arm);
    }
    for (const [key, cell] of completed) {
        const [arm, method, replicaText, qid, cid] = key.split("|");
        const replica = Number(replicaText);
        const links = cell.wireIds.map((id) => wireIds.get(id));
        assert(links.every((record) => record !== undefined), `unknown result wireId (${key})`);
        const expectedMethods = method === "M2" ? ["M0", "M2"] : [method];
        const relevant = uniqueWires.filter((record) => record.arm === arm && record.replica === replica && record.queryGroup === qid && expectedMethods.includes(record.method) && record.candidateIds.includes(cid!));
        const expectedIds = new Set(relevant.map((record) => record.wireId));
        assert(expectedIds.size === cell.wireIds.length && cell.wireIds.every((id) => expectedIds.has(id)), `result wire binding mismatch (${key})`);
        const allowlisted = (record: MethodWireRecord): boolean => record.rulesetVersion === "A3" && record.errorClass === null && record.httpStatus !== null && record.httpStatus >= 200 && record.httpStatus < 300 && record.servedModel === COMPARISON_SERVED_MODEL_ALLOWLIST[record.arm];
        const validSuccesses = relevant.filter(allowlisted);
        if (validSuccesses.length === 0) { integrityFailureArms.add(arm!); continue; }
        const byMethod = expectedMethods.map((needed) => {
            const component = validSuccesses.filter((record) => record.method === needed);
            const answers = component.map((record) => record.answers.find((answer) => answer.candidateId === cid)?.probability);
            if (answers.length === 0 || !answers.every((value) => value === answers[0])) integrityFailureArms.add(arm!);
            return answers[0];
        });
        if (!byMethod.every((value) => typeof value === "number")) { integrityFailureArms.add(arm!); continue; }
        const computed = method === "M2" ? (byMethod[0]! + byMethod[1]!) / 2 : byMethod[0]!;
        if (Math.abs(computed - cell.probability) > 1e-12) integrityFailureArms.add(arm!);
    }
    for (const [arm, method] of [["~typesafe/jev-latest", "M0"], ["~typesafe/jev-latest", "M1"], ["perplexity/pplx-decider-v1.1-27b", "M0"], ["perplexity/pplx-decider-v1.1-27b", "M2"], ["openai/gpt-6-luna-decisions", "M0"], ["openai/gpt-6-luna-decisions", "M1"]] as const) {
        for (const qid of queries.keys()) for (const c of roster.candidates.filter((x) => x.qid === qid)) for (let replica = 0; replica < 3; replica += 1) {
            const key = [arm, method, replica, qid, c.cid].join("|");
            if (!completed.has(key) && !blockedKeys.has(key)) blockedKeys.add(key);
        }
    }

    assert(typeof integritySummary.aborted === "boolean", "result integrity.aborted missing");
    const computedFinalAttemptUnverified = plan.requests.filter((request) => {
        const key = stable([request.arm, request.method, request.replica, request.queryGroup, request.warmup, request.payloadSha256, request.candidateIds]);
        const attempts = attemptsByPlannedRequest.get(key) ?? [];
        const latest = attempts[attempts.length - 1];
        return latest === undefined || latest.rulesetVersion !== "A3" || latest.errorClass !== null || latest.httpStatus === null || latest.httpStatus < 200 || latest.httpStatus >= 300 || latest.servedModel !== COMPARISON_SERVED_MODEL_ALLOWLIST[request.arm as keyof typeof COMPARISON_SERVED_MODEL_ALLOWLIST];
    }).map(confirmationDispatchKey);
    for (const reference of integritySummary.finalAttemptUnverified) assert(computedFinalAttemptUnverified.includes(reference), "result integrity.finalAttemptUnverified references unknown or verified planned request");
    assert(JSON.stringify([...(integritySummary.finalAttemptUnverified)].sort()) === JSON.stringify([...computedFinalAttemptUnverified].sort()), "result integrity.finalAttemptUnverified summary disagrees with wire ledger");
    const computedServedIdentityDrift = uniqueWires.filter((record) => record.servedModel !== null && record.servedModel !== COMPARISON_SERVED_MODEL_ALLOWLIST[record.arm]).map((record) => record.wireId).sort();
    for (const reference of integritySummary.servedIdentityDrift) assert(computedServedIdentityDrift.includes(reference), "result integrity.servedIdentityDrift references unknown or identity-verified wire");
    assert(JSON.stringify([...(integritySummary.servedIdentityDrift)].sort()) === JSON.stringify(computedServedIdentityDrift), "result integrity.servedIdentityDrift summary disagrees with wire ledger");
    const computedPayloadDrift = uniqueWires.filter((record) => !plannedRequests.has(stable([record.arm, record.method, record.replica, record.queryGroup, record.warmup, record.payloadSha256]))).map((record) => record.wireId).sort();
    for (const reference of integritySummary.payloadDrift) assert(computedPayloadDrift.includes(reference), "result integrity.payloadDrift references unknown or payload-verified wire");
    assert(JSON.stringify([...(integritySummary.payloadDrift)].sort()) === JSON.stringify(computedPayloadDrift), "result integrity.payloadDrift summary disagrees with wire ledger");
    const computedRetryAnswerDrift: string[] = [];
    for (const attempts of attemptsByPlannedRequest.values()) {
        const successes = attempts.filter((record) => record.errorClass === null);
        for (const candidateId of attempts[0]!.candidateIds) {
            const answers = successes.map((record) => record.answers.find((answer) => answer.candidateId === candidateId)?.probability);
            if (new Set(answers).size > 1) computedRetryAnswerDrift.push(...successes.map((record) => record.wireId));
        }
    }
    for (const reference of integritySummary.retryAnswerDrift) assert(computedRetryAnswerDrift.includes(reference), "result integrity.retryAnswerDrift references unknown or answer-consistent wire");
    assert(JSON.stringify([...(integritySummary.retryAnswerDrift)].sort()) === JSON.stringify([...computedRetryAnswerDrift].sort()), "result integrity.retryAnswerDrift summary disagrees with wire ledger");
    const computedCaptureGaps = uniqueWires.filter((r) => r.errorClass === "capture_gap").map((r) => r.wireId).sort();
    assert(Array.isArray(integritySummary.captureGaps) && JSON.stringify([...integritySummary.captureGaps].sort()) === JSON.stringify(computedCaptureGaps), "result capture-gap summary disagrees with wire ledger");
    const models: Record<string, unknown>[] = [];
    const pValues: number[] = [];
    for (const model of CONFIRM_RESULTS_MODEL_ORDER) {
        const arm = model.arm, challenger = model.method;
        const vectors: number[] = [], perRepo = new Map<string, number[]>();
        let fn0 = 0, fp0 = 0, fnc = 0, fpc = 0, wins = 0, ties = 0, losses = 0;
        let blocked = false;
        for (const [qid, query] of queries) {
            const lossesByMethod: Record<string, { loss: number; fn: number; fp: number }> = {};
            for (const method of ["M0", challenger]) {
                let fn = 0, fp = 0;
                for (const candidate of roster.candidates.filter((c) => c.qid === qid)) {
                    const values = Array.from({ length: 3 }, (_, replica) => completed.get([arm, method, replica, qid, candidate.cid].join("|"))?.probability);
                    if (values.some((v) => v === undefined)) { blocked = true; continue; }
                    const keep = mean(values as number[]) >= FROZEN_KEEP_THRESHOLD;
                    if (candidate.label === "gold" && !keep) fn += 1;
                    else if (candidate.label !== "gold" && keep) fp += 1;
                }
                lossesByMethod[method] = { loss: EXPLORATORY_WEIGHTED_FN_PENALTY * fn + fp, fn, fp };
            }
            if (blocked) continue;
            const baseline = lossesByMethod.M0!, changed = lossesByMethod[challenger]!;
            const d = changed.loss - baseline.loss; vectors.push(d);
            if (d < 0) wins++; else if (d > 0) losses++; else ties++;
            fn0 += baseline.fn; fp0 += baseline.fp; fnc += changed.fn; fpc += changed.fp;
            const repoValues = perRepo.get(query.repo) ?? []; repoValues.push(d); perRepo.set(query.repo, repoValues);
        }
        const hasIntegrity = integritySummary;
        const modelWires = uniqueWires.filter((r) => r.arm === arm);
        const finalAttemptFailure = plan.requests.filter((r) => r.arm === arm).some((request) => {
            const attempts = modelWires.filter((r) => r.method === request.method && r.replica === request.replica && r.queryGroup === request.queryGroup && r.warmup === request.warmup && r.payloadSha256 === request.payloadSha256 && JSON.stringify(r.candidateIds) === JSON.stringify(request.candidateIds));
            const latest = attempts.sort((a, b) => b.attemptIndex - a.attemptIndex)[0];
            return latest === undefined || latest.rulesetVersion !== "A3" || latest.errorClass !== null || latest.httpStatus === null || latest.httpStatus < 200 || latest.httpStatus >= 300 || latest.servedModel !== COMPARISON_SERVED_MODEL_ALLOWLIST[arm];
        });
        const retryDrift = modelWires.some((record) => record.errorClass === null && modelWires.some((other) => other !== record && other.method === record.method && other.replica === record.replica && other.warmup === record.warmup && other.queryGroup === record.queryGroup && other.payloadSha256 === record.payloadSha256 && JSON.stringify(other.candidateIds) === JSON.stringify(record.candidateIds) && other.errorClass === null && JSON.stringify(other.answers) !== JSON.stringify(record.answers)));
        const expectedIntegrity = modelWires.some((r) => r.errorClass === "capture_gap") || Boolean(hasIntegrity.aborted) || finalAttemptFailure || retryDrift || integrityFailureArms.has(arm);
        const modelBlocked = blocked || vectors.length !== 400 || expectedIntegrity;
        const internalP = modelBlocked ? 1 : signFlipOneSidedPValue(vectors, vectors.reduce((a, b) => a + b, 0), SIGN_MATRIX);
        pValues.push(internalP);
        const stats = modelBlocked ? { delta: null, fn: null, fp: null, WTL: null, pRaw: null, interval95T: null, perRepositoryDelta: null } : {
            delta: mean(vectors), fn: { M0: fn0, challenger: fnc, delta: fnc - fn0 }, fp: { M0: fp0, challenger: fpc, delta: fpc - fp0 },
            WTL: { wins, ties, losses }, pRaw: internalP, interval95T: interval(vectors),
            perRepositoryDelta: Object.fromEntries([...perRepo].map(([repo, ds]) => [repo, mean(ds)])),
        };
        models.push({ arm, challenger, status: modelBlocked ? "blocked" : "complete", ...stats, _internalP: internalP,
            adopt: false, adoptionReason: modelBlocked ? "blocked by incomplete/integrity" : null });
    }
    const holm = holmStepDown(pValues, ALPHA);
    const adjusted = new Array<number>(pValues.length).fill(1);
    let running = 0;
    holm.order.forEach((index, rank) => { running = Math.max(running, Math.min(1, pValues[index]! * (pValues.length - rank))); adjusted[index] = running; });
    models.forEach((m, i) => {
        const blocked = m.status === "blocked";
        delete m._internalP;
        if (blocked) { m.pHolmAdjusted = null; return; }
        m.pHolmAdjusted = adjusted[i];
        const guard = Number((m.fn as { delta: number }).delta) <= 1;
        m.adopt = holm.rejected[i] && guard;
        m.adoptionReason = m.adopt ? "Holm rejection and FN guard" : holm.rejected[i] ? "FN guard failed" : "Holm did not reject";
    });
    const isVerifiedSuccess = (record: MethodWireRecord): boolean => record.rulesetVersion === "A3" && record.errorClass === null && record.httpStatus !== null && record.httpStatus >= 200 && record.httpStatus < 300 && record.servedModel === COMPARISON_SERVED_MODEL_ALLOWLIST[record.arm];
    const samePlannedComponent = (a: MethodWireRecord, b: MethodWireRecord): boolean => a.arm === b.arm && a.method === b.method && a.replica === b.replica && a.warmup === b.warmup && a.queryGroup === b.queryGroup && a.payloadSha256 === b.payloadSha256 && JSON.stringify(a.candidateIds) === JSON.stringify(b.candidateIds);
    const availability = Object.fromEntries(CONFIRM_RESULTS_MODEL_ORDER.map(({ arm }) => {
        const records = uniqueWires.filter((r) => r.arm === arm && !r.warmup);
        const recovered = records.filter((record) => record.errorClass !== null && records.some((later) => samePlannedComponent(record, later) && later.attemptIndex > record.attemptIndex && isVerifiedSuccess(later)));
        return [arm, { attempts: records.length, firstAttemptSuccesses: records.filter((r) => r.attemptIndex === 1 && isVerifiedSuccess(r)).length,
            eventualSuccesses: records.filter(isVerifiedSuccess).length, recoveredFailures: recovered.length }];
    }));
    const costs = Object.fromEntries(CONFIRM_RESULTS_MODEL_ORDER.map(({ arm }) => [arm, Object.fromEntries(["M0", "M1", "M2"].map((method) => {
        const rows = uniqueWires.filter((r) => r.arm === arm && r.method === method);
        return [method, { attempts: rows.length, knownUsd: rows.reduce((n, r) => n + (r.cost.status === "known" ? r.cost.usd : 0), 0), unknownReservationsUsd: rows.reduce((n, r) => n + (r.cost.status === "unknown" ? r.cost.reserveUsd : 0), 0), inputTokensKnown: rows.reduce((n, r) => n + (r.inputTokens ?? 0), 0), inputTokensUnknownCount: rows.filter((r) => r.inputTokens === null).length, outputTokensKnown: rows.reduce((n, r) => n + (r.outputTokens ?? 0), 0), outputTokensUnknownCount: rows.filter((r) => r.outputTokens === null).length }];
    }))]));
    return { version: 1, kind: "method-confirm-analysis", manifestSha256: roster.manifestSha256, planSha256: plan.hash,
        primary: { procedure: "one-sided sign-flip permutation", draws: CONFIRM_SIGN_FLIP_DRAWS, seed: CONFIRM_SIGN_FLIP_SEED, familySize: 3, tieOrder: CONFIRM_RESULTS_MODEL_ORDER.map((m) => m.arm), models },
        availability, costs, integrity: { aborted: Boolean(integritySummary.aborted), captureGaps: uniqueWires.filter((r) => r.errorClass === "capture_gap").map((r) => r.wireId), allModelsReported: models.length === 3 } };
}
const SIGN_MATRIX = buildSignMatrix(CONFIRM_SIGN_FLIP_DRAWS, 400, CONFIRM_SIGN_FLIP_SEED);

function parseArgs(argv: readonly string[]): { corpus: string; plan: string; results: string; records: string } {
    const args: Record<string, string> = {};
    for (let i = 0; i < argv.length; i++) { const key = argv[i]; if (!["--corpus", "--plan", "--results", "--records"].includes(key!)) throw new Error(`unknown argument ${key}`); const value = argv[++i]; if (!value || value.startsWith("--")) throw new Error(`${key} requires a path`); args[key!] = value; }
    for (const key of ["--corpus", "--plan", "--results", "--records"]) if (!args[key]) throw new Error(`${key} is required`);
    return { corpus: args["--corpus"]!, plan: args["--plan"]!, results: args["--results"]!, records: args["--records"]! };
}
export function runMethodConfirmResults(argv: readonly string[]): number {
    try {
        const args = parseArgs(argv), roster = loadVerifiedConfirmCorpus(args.corpus);
        const plan = JSON.parse(readFileSync(args.plan, "utf8")) as unknown;
        const results = JSON.parse(readFileSync(args.results, "utf8")) as unknown;
        const records = readFileSync(args.records, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as unknown);
        console.log(JSON.stringify(analyzeMethodConfirmResults({ roster, plan, results, wireRecords: records })));
        return 0;
    } catch (error) { console.error(`analysis refused: ${error instanceof Error ? error.message : String(error)}`); return 2; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = runMethodConfirmResults(process.argv.slice(2));
