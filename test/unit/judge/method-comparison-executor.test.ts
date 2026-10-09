/**
 * Stage D method builders + instrumented wire executor (design plan §3
 * "Method builders" / Stage D acceptance: M0 byte-equivalent to the
 * captured production builder, M1 singleton, reverse order correct,
 * forward reuse, retries separately admitted/settled).
 *
 * All transport is faked and all ledgers are ephemeral temp roots: no
 * network, no credentials, no live books. Byte-equivalence is proven by
 * driving the real `CloudJudge` with a body-capturing fetch and
 * comparing the exact strings. Records are checked against
 * `isMethodWireRecord` and bound through `bindMethodComparisonReport`
 * (including the M0/M2 forward-reuse dedup via
 * `aggregateCampaignWireCosts`).
 */
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CloudJudge } from "../../../src/judge/cloud-judge.js";
import { unitRelevanceQuestion } from "../../../src/judge/questions.js";
import type { FetchFn } from "../../../src/judge/systemone-client.js";
import {
    METHOD_COMPARISON_CONTRACT_VERSION,
    PILOT_REPLICA_COUNT,
    aggregateCampaignWireCosts,
    bindMethodComparisonReport,
    isMethodWireRecord,
    type MethodComparisonReportInput,
    type MethodDerivedScore,
    type MethodPlannedCandidate,
    type MethodRecordEnvelope,
    type MethodReportBinding,
    type MethodWireRecord,
} from "../../../scripts/eval/judge/method-comparison-contract.js";
import {
    METHOD_WIRE_DIRECTION,
    METHOD_WIRE_MAX_ATTEMPTS,
    MethodCaptureGapError,
    attemptRecordsOf,
    buildM0Request,
    buildM1Request,
    buildM2Reverse,
    executeWireRequest,
    type ExecuteWireRequestOptions,
    type MethodRequestCandidate,
    type MethodWireRequest,
} from "../../../scripts/eval/judge/method-comparison-executor.js";
import {
    CAMPAIGN_TOTAL_CAP_USD,
    loadCampaignLedger,
    requestReserveUsd,
    seedCampaignLedger,
} from "../../../scripts/eval/judge/model-comparison-budget.js";
import {
    COMPARISON_SERVED_MODEL_ALLOWLIST,
    type ComparisonModelId,
} from "../../../scripts/eval/judge/model-comparison-types.js";

const ARM: ComparisonModelId = "perplexity/pplx-decider-v1.1-27b";
const SERVED = COMPARISON_SERVED_MODEL_ALLOWLIST[ARM];
const QUERY = "How does text search fall back through engines when no semantic index is available?";
const Q1 = "pilot:q01";
const MANIFEST = createHash("sha256").update("sealed-pilot-manifest").digest("hex");
const RESERVE = requestReserveUsd(ARM);
const KNOWN_COST = 0.0004;

/** Deterministic per-candidate probabilities: identical across replicas and directions (binder requires retry/replica agreement within a component). */
const FIXED_P: Readonly<Record<string, number>> = { u0: 0.7, u1: 0.4, u2: 0.55 };

function candidates(): MethodRequestCandidate[] {
    return [
        { candidateId: "u0", state: { path: "src/search/grep-cascade.ts", symbol: "runCascade", text: "async function runCascade(pattern) { return searchIndex(pattern) ?? searchPlain(pattern); }" } },
        { candidateId: "u1", state: { path: "src/search/find-tool.ts", symbol: "handleFind", text: "function handleFind(pattern, limit) { return index.find(pattern, limit); }" } },
        { candidateId: "u2", state: { path: "src/ranking/rerank-colbert.ts", symbol: "rerank", text: "export function rerank(query, passages) { return model.score(query, passages); }" } },
    ];
}

function freshRoot(): string {
    // Canonical (realpath) root: macOS /var -> /private/var must not look
    // like an ancestor symlink to the ledger's fail-closed path checks.
    return realpathSync(mkdtempSync(join(tmpdir(), "method-executor-test-")));
}

function seededRoot(): string {
    const root = freshRoot();
    seedCampaignLedger(root, { attempts: 0, actualCostUsd: 0, note: "stage D executor test" });
    return root;
}

function jsonResponse(payload: unknown, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json", ...headers },
    });
}

function successBody(answers: Record<string, unknown>, usage: Record<string, number> = { input_tokens: 100, cost: KNOWN_COST }): unknown {
    return { id: "gen-test", model: SERVED, provider: "Test", answers, usage };
}

/** Answers a body's question set deterministically (FIXED_P by candidate id). */
function answersForBody(init?: RequestInit): Record<string, number> {
    const body = JSON.parse(String(init?.body ?? "{}")) as { questions?: Record<string, unknown> };
    const out: Record<string, number> = {};
    for (const key of Object.keys(body.questions ?? {})) out[key] = FIXED_P[key] ?? 0.5;
    return out;
}

function successTransport(): FetchFn {
    return vi.fn(async (_url: string, init?: RequestInit) => jsonResponse(successBody(answersForBody(init))));
}

function onlyRequest(requests: MethodWireRequest[]): MethodWireRequest {
    if (requests.length !== 1) throw new Error(`expected exactly one packed request, got ${requests.length}`);
    const [request] = requests;
    if (request === undefined) throw new Error("expected a packed request");
    return request;
}

function prodItems(items: MethodRequestCandidate[]) {
    return items.map((candidate) => ({
        id: candidate.candidateId,
        state: candidate.state,
        question: (stateRef: string) => unitRelevanceQuestion(QUERY, stateRef),
    }));
}

/** Capture the EXACT bodies production `CloudJudge.judgeNouls` would send for these candidates. */
async function productionBodies(items: MethodRequestCandidate[]): Promise<string[]> {
    const bodies: string[] = [];
    const fetchFn: FetchFn = async (_url, init) => {
        bodies.push(String(init?.body ?? ""));
        const answers = answersForBody(init);
        return jsonResponse({ model: SERVED, provider: "Test", answers, usage: { input_tokens: 1 } });
    };
    const judge = new CloudJudge({ model: ARM, cache: null, fetchFn, sleepFn: async () => {} });
    await judge.judgeNouls({ shared: { query: QUERY }, items: prodItems(items) });
    return bodies;
}

async function runExecute(
    root: string,
    transport: FetchFn,
    request: MethodWireRequest,
    overrides: Partial<ExecuteWireRequestOptions> = {},
): Promise<MethodWireRecord[]> {
    return executeWireRequest({
        method: "M0",
        arm: ARM,
        phase: "pilot",
        replica: 0,
        queryGroup: Q1,
        warmup: false,
        request,
        transport,
        campaignRoot: root,
        sleep: async () => {},
        ...overrides,
    });
}

async function executeOne(
    root: string,
    transport: FetchFn,
    request: MethodWireRequest,
    overrides: Partial<ExecuteWireRequestOptions> = {},
): Promise<MethodWireRecord> {
    const records = await runExecute(root, transport, request, overrides);
    const [record] = records;
    if (record === undefined || records.length !== 1) throw new Error(`expected exactly one wire record, got ${records.length}`);
    return record;
}

function envelope(method: MethodRecordEnvelope["method"]): MethodRecordEnvelope {
    return {
        contractVersion: METHOD_COMPARISON_CONTRACT_VERSION,
        method,
        arm: ARM,
        phase: "pilot",
        replicaCount: PILOT_REPLICA_COUNT,
        manifestSha256: MANIFEST,
    };
}

const PLANNED: MethodPlannedCandidate[] = [
    { queryGroup: Q1, candidateId: "u0" },
    { queryGroup: Q1, candidateId: "u1" },
    { queryGroup: Q1, candidateId: "u2" },
];

function derivedFromRecord(record: MethodWireRecord): MethodDerivedScore[] {
    const queryGroup = record.queryGroup;
    if (queryGroup === null) throw new Error("expected a non-warmup record");
    return record.answers.map((answer) => ({
        method: record.method,
        arm: record.arm,
        phase: record.phase,
        replica: record.replica,
        queryGroup,
        candidateId: answer.candidateId,
        probability: answer.probability,
        wireIds: [record.wireId],
    }));
}

function derivedM2(forward: MethodWireRecord, reverse: MethodWireRecord, candidateId: string): MethodDerivedScore {
    const f = forward.answers.find((answer) => answer.candidateId === candidateId)?.probability ?? null;
    const r = reverse.answers.find((answer) => answer.candidateId === candidateId)?.probability ?? null;
    if (forward.queryGroup === null) throw new Error("expected a non-warmup record");
    return {
        method: "M2",
        arm: ARM,
        phase: "pilot",
        replica: forward.replica,
        queryGroup: forward.queryGroup,
        candidateId,
        probability: f === null || r === null ? null : (f + r) / 2,
        wireIds: [forward.wireId, reverse.wireId],
    };
}

function expectBound(input: MethodComparisonReportInput): Extract<MethodReportBinding, { ok: true }> {
    const binding = bindMethodComparisonReport(input);
    if (!binding.ok) throw new Error(`expected binding to succeed, got: ${binding.failures.join(", ")}`);
    return binding;
}

describe("method builders: byte-equivalent to the production CloudJudge packing", () => {
    it("buildM0Request reproduces the exact production request body (shared state + units + questions)", async () => {
        const items = candidates();
        const built = buildM0Request(ARM, QUERY, items);
        const request = onlyRequest(built);
        const bodies = await productionBodies(items);
        expect(bodies).toEqual([request.body]);
        // payloadSha256 is the SHA-256 over the exact body bytes; requestBytes is the UTF-8 length.
        expect(request.payloadSha256).toBe(createHash("sha256").update(request.body, "utf-8").digest("hex"));
        expect(request.requestBytes).toBe(Buffer.byteLength(request.body, "utf-8"));
        expect(request.candidateIds).toEqual(["u0", "u1", "u2"]);
        const parsed = JSON.parse(request.body) as {
            model: string;
            state: { query: string; units: Record<string, unknown> };
            questions: Record<string, { type: string; instructions: string }>;
        };
        expect(parsed.model).toBe(ARM);
        expect(parsed.state.query).toBe(QUERY);
        expect(Object.keys(parsed.state.units)).toEqual(["u0", "u1", "u2"]);
        expect(parsed.questions.u0).toEqual(unitRelevanceQuestion(QUERY, "units.u0"));
    });

    it("replicates the production token-budget split exactly, one built request per split", async () => {
        const big = (id: string): MethodRequestCandidate => ({
            candidateId: id,
            state: { path: "src/big.ts", symbol: id, text: "z".repeat(50_000) },
        });
        const items = [big("u0"), big("u1"), big("u2")];
        const built = buildM0Request(ARM, QUERY, items);
        expect(built).toHaveLength(3); // ~12.5k estimated tokens each: production splits per unit
        const bodies = await productionBodies(items);
        expect(bodies).toEqual(built.map((request) => request.body));
        const hashes = new Set(built.map((request) => request.payloadSha256));
        expect(hashes.size).toBe(3);
    });

    it("fits pilot-sized excerpts (7 candidates x 3,500 chars) into ONE request — offline acceptance", () => {
        const items = Array.from({ length: 7 }, (_, i) => ({
            candidateId: `c${i}`,
            state: { path: `src/file${i}.ts`, symbol: `f${i}`, text: "x".repeat(3500) },
        }));
        const built = buildM0Request(ARM, QUERY, items);
        expect(built).toHaveLength(1);
        expect(built[0]?.candidateIds).toEqual(["c0", "c1", "c2", "c3", "c4", "c5", "c6"]);
    });

    it("buildM1Request packs exactly one unit and matches production's singleton body", async () => {
        const [first] = candidates();
        if (first === undefined) throw new Error("fixture missing");
        const request = buildM1Request(ARM, QUERY, first);
        expect(request.candidateIds).toEqual(["u0"]);
        const bodies = await productionBodies([first]);
        expect(bodies).toEqual([request.body]);
        const parsed = JSON.parse(request.body) as { state: { units: Record<string, unknown> }; questions: Record<string, unknown> };
        expect(Object.keys(parsed.state.units)).toEqual(["u0"]);
        expect(Object.keys(parsed.questions)).toEqual(["u0"]);
    });

    it("buildM2Reverse reverses both units and questions exactly, byte-identical to production over reversed items", async () => {
        const items = candidates();
        const reverse = onlyRequest(buildM2Reverse(ARM, QUERY, items));
        expect(reverse.candidateIds).toEqual(["u2", "u1", "u0"]);
        const parsed = JSON.parse(reverse.body) as { state: { units: Record<string, unknown> }; questions: Record<string, unknown> };
        expect(Object.keys(parsed.state.units)).toEqual(["u2", "u1", "u0"]);
        expect(Object.keys(parsed.questions)).toEqual(["u2", "u1", "u0"]);
        const bodies = await productionBodies([...items].reverse());
        expect(bodies).toEqual([reverse.body]);
        const forward = onlyRequest(buildM0Request(ARM, QUERY, items));
        expect(reverse.payloadSha256).not.toBe(forward.payloadSha256);
        expect(METHOD_WIRE_DIRECTION.M0).toBe("forward");
        expect(METHOD_WIRE_DIRECTION.M1).toBe("isolated");
        expect(METHOD_WIRE_DIRECTION.M2).toBe("reverse");
    });
});

describe("executeWireRequest: records satisfy the Stage C contract and bind", () => {
    it("executes M0 forward once per replica; records pass isMethodWireRecord and bind an M0 report", async () => {
        const root = seededRoot();
        const transport = successTransport();
        const request = onlyRequest(buildM0Request(ARM, QUERY, candidates()));
        const fwd0 = await executeOne(root, transport, request, { replica: 0 });
        const fwd1 = await executeOne(root, transport, request, { replica: 1 });
        for (const record of [fwd0, fwd1]) {
            expect(isMethodWireRecord(record)).toBe(true);
            expect(record.method).toBe("M0");
            expect(record.direction).toBe("forward");
            expect(record.queryGroup).toBe(Q1);
            expect(record.payloadSha256).toBe(request.payloadSha256);
            expect(record.requestBytes).toBe(request.requestBytes);
            expect(record.errorClass).toBeNull();
            expect(record.httpStatus).toBe(200);
            expect(record.answers.map((answer) => answer.probability)).toEqual([0.7, 0.4, 0.55]);
            expect(record.cost).toEqual({ status: "known", usd: KNOWN_COST });
            expect(record.inputTokens).toBe(100);
            expect(record.outputTokens).toBeNull(); // absence preserved as null, never zero-filled
            expect(record.requestTimestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
            expect(record.latencyMs).toBeGreaterThanOrEqual(0);
        }
        expect(fwd0.wireId).not.toBe(fwd1.wireId);
        expect(transport).toHaveBeenCalledTimes(2);
        const binding = expectBound({
            envelope: envelope("M0"),
            plannedCandidates: PLANNED,
            wireRecords: [fwd0, fwd1],
            derivedScores: [...derivedFromRecord(fwd0), ...derivedFromRecord(fwd1)],
        });
        expect(binding.totals.wireRequestCount).toBe(2);
        expect(binding.totals.knownCostUsd).toBeCloseTo(2 * KNOWN_COST, 12);
    });

    it("buildM1Request executes as isolated singleton records and binds an M1 report", async () => {
        const root = seededRoot();
        const transport = successTransport();
        const [first] = candidates();
        if (first === undefined) throw new Error("fixture missing");
        const request = buildM1Request(ARM, QUERY, first);
        const r0 = await executeOne(root, transport, request, { method: "M1", replica: 0 });
        const r1 = await executeOne(root, transport, request, { method: "M1", replica: 1 });
        expect(isMethodWireRecord(r0)).toBe(true);
        expect(r0.method).toBe("M1");
        expect(r0.direction).toBe("isolated");
        expect(r0.candidateIds).toEqual(["u0"]);
        expect(r0.answers).toEqual([{ candidateId: "u0", probability: 0.7 }]);
        const binding = expectBound({
            envelope: envelope("M1"),
            plannedCandidates: [{ queryGroup: Q1, candidateId: "u0" }],
            wireRecords: [r0, r1],
            derivedScores: [...derivedFromRecord(r0), ...derivedFromRecord(r1)],
        });
        expect(binding.totals.wireRequestCount).toBe(2);
    });

    it("M2: reverse order exact, M0 forward reused (never re-sent), report binds and dedups at campaign level", async () => {
        const root = seededRoot();
        const transport = successTransport();
        const items = candidates();
        const fwdRequest = onlyRequest(buildM0Request(ARM, QUERY, items));
        const revRequest = onlyRequest(buildM2Reverse(ARM, QUERY, items));
        const fwd0 = await executeOne(root, transport, fwdRequest, { replica: 0 });
        const rev0 = await executeOne(root, transport, revRequest, { replica: 0, method: "M2" });
        const fwd1 = await executeOne(root, transport, fwdRequest, { replica: 1 });
        const rev1 = await executeOne(root, transport, revRequest, { replica: 1, method: "M2" });
        // The forward body was sent ONCE per replica: M2 never re-sends it.
        expect(transport).toHaveBeenCalledTimes(4);
        expect(rev0.method).toBe("M2");
        expect(rev0.direction).toBe("reverse");
        expect(rev0.candidateIds).toEqual(["u2", "u1", "u0"]);
        expect(rev0.payloadSha256).not.toBe(fwd0.payloadSha256);
        for (const record of [fwd0, rev0, fwd1, rev1]) expect(isMethodWireRecord(record)).toBe(true);

        const m2Derived: MethodDerivedScore[] = [
            ...["u0", "u1", "u2"].map((id) => derivedM2(fwd0, rev0, id)),
            ...["u0", "u1", "u2"].map((id) => derivedM2(fwd1, rev1, id)),
        ];
        const m2Binding = expectBound({
            envelope: envelope("M2"),
            plannedCandidates: PLANNED,
            wireRecords: [fwd0, rev0, fwd1, rev1],
            derivedScores: m2Derived,
        });
        expect(m2Binding.totals.wireRequestCount).toBe(4);
        expect(m2Binding.totals.knownCostUsd).toBeCloseTo(4 * KNOWN_COST, 12);

        const m0Binding = expectBound({
            envelope: envelope("M0"),
            plannedCandidates: PLANNED,
            wireRecords: [fwd0, fwd1],
            derivedScores: [...derivedFromRecord(fwd0), ...derivedFromRecord(fwd1)],
        });
        const campaign = aggregateCampaignWireCosts([m0Binding, m2Binding]);
        if (!campaign.ok) throw new Error(`campaign aggregation failed: ${campaign.failures.join(", ")}`);
        // The reused forward records are counted once across envelopes.
        expect(campaign.totals.uniqueWireRequestCount).toBe(4);
        expect(campaign.totals.knownCostUsd).toBeCloseTo(4 * KNOWN_COST, 12);
    });

    it("executes warmups with null queryGroup and honors attemptIndexStart (resume)", async () => {
        const root = seededRoot();
        const transport = successTransport();
        const request = onlyRequest(buildM0Request(ARM, QUERY, candidates()));
        const warmup = await executeOne(root, transport, request, { warmup: true, queryGroup: null });
        expect(isMethodWireRecord(warmup)).toBe(true);
        expect(warmup.warmup).toBe(true);
        expect(warmup.queryGroup).toBeNull();
        const resumed = await executeOne(root, transport, request, { attemptIndexStart: 3 });
        expect(resumed.attemptIndex).toBe(3);
        expect(resumed.wireId).not.toBe(warmup.wireId);
    });

    it("re-sending the forward request produces a colliding wireId and is rejected as duplicate_wire_id", async () => {
        const root = seededRoot();
        const transport = successTransport();
        const fwdRequest = onlyRequest(buildM0Request(ARM, QUERY, candidates()));
        const fwd0 = await executeOne(root, transport, fwdRequest, { replica: 0 });
        const resend = await executeOne(root, transport, fwdRequest, { replica: 0 });
        expect(resend.wireId).toBe(fwd0.wireId);
        const binding = bindMethodComparisonReport({
            envelope: envelope("M2"),
            plannedCandidates: PLANNED,
            wireRecords: [fwd0, resend],
            derivedScores: [],
        });
        expect(binding.ok).toBe(false);
        if (!binding.ok) expect(binding.failures).toContain("duplicate_wire_id");
    });
});

describe("campaign admission and settlement accounting", () => {
    it("admits BEFORE each transport call; retries are separately admitted/settled with gapless attemptIndex", async () => {
        const root = seededRoot();
        let call = 0;
        const transport = vi.fn(async (_url: string, init?: RequestInit): Promise<Response> => {
            call += 1;
            if (call === 1) return jsonResponse({ model: SERVED, provider: "Test", error: "internal" }, 500);
            return jsonResponse(successBody(answersForBody(init)));
        });
        const sleep = vi.fn(async (_ms: number) => {});
        const request = onlyRequest(buildM0Request(ARM, QUERY, candidates()));
        const records = await runExecute(root, transport, request, { sleep });
        expect(transport).toHaveBeenCalledTimes(2);
        expect(records.map((record) => record.attemptIndex)).toEqual([1, 2]);
        const [first, second] = records;
        if (first === undefined || second === undefined) throw new Error("expected two records");
        expect(first.errorClass).toBe("http_500");
        expect(first.httpStatus).toBe(500);
        expect(first.servedModel).toBe(SERVED);
        expect(first.provider).toBe("Test");
        expect(first.answers.every((answer) => answer.probability === null)).toBe(true);
        expect(first.cost).toEqual({ status: "unknown", reserveUsd: RESERVE });
        expect(second.errorClass).toBeNull();
        expect(second.cost).toEqual({ status: "known", usd: KNOWN_COST });
        expect(second.payloadSha256).toBe(first.payloadSha256);
        // Production-style backoff between attempts (injectable sleep).
        expect(sleep).toHaveBeenCalledTimes(1);
        expect(sleep).toHaveBeenCalledWith(500);
        const ledger = loadCampaignLedger(root);
        expect(ledger.attempts).toBe(2);
        expect(ledger.perModelAttempts[ARM]).toBe(2);
        expect(ledger.inFlight).toHaveLength(0);
        expect(ledger.settled.map((record) => record.status)).toEqual(["unknown", "settled"]);
        expect(ledger.settled[1]?.actualCostUsd).toBe(KNOWN_COST);
        // Attempt 1 keeps its full reserve (UNKNOWN); attempt 2 trues up to the reported actual.
        expect(ledger.campaignUsedUsd).toBeCloseTo(RESERVE + KNOWN_COST, 12);
        expect(ledger.actualSpentUsd).toBeCloseTo(KNOWN_COST, 12);
        expect(ledger.costComplete).toBe(false);
    });

    it("bounds retries at METHOD_WIRE_MAX_ATTEMPTS; every attempt is admitted and settled UNKNOWN", async () => {
        const root = seededRoot();
        const transport = vi.fn(async (): Promise<Response> =>
            jsonResponse({ model: SERVED, provider: "Test", error: "still broken" }, 500));
        const sleep = vi.fn(async (_ms: number) => {});
        const request = onlyRequest(buildM0Request(ARM, QUERY, candidates()));
        const records = await runExecute(root, transport, request, { sleep });
        expect(METHOD_WIRE_MAX_ATTEMPTS).toBe(3);
        expect(records).toHaveLength(METHOD_WIRE_MAX_ATTEMPTS);
        expect(records.map((record) => record.attemptIndex)).toEqual([1, 2, 3]);
        expect(records.every((record) => record.errorClass === "http_500")).toBe(true);
        expect(records.every((record) => record.cost.status === "unknown")).toBe(true);
        expect(records.every((record) => isMethodWireRecord(record))).toBe(true);
        expect(transport).toHaveBeenCalledTimes(METHOD_WIRE_MAX_ATTEMPTS);
        expect(sleep).toHaveBeenCalledTimes(METHOD_WIRE_MAX_ATTEMPTS - 1);
        const ledger = loadCampaignLedger(root);
        expect(ledger.attempts).toBe(METHOD_WIRE_MAX_ATTEMPTS);
        expect(ledger.inFlight).toHaveLength(0);
        expect(ledger.settled.every((record) => record.status === "unknown")).toBe(true);
        expect(ledger.campaignUsedUsd).toBeCloseTo(METHOD_WIRE_MAX_ATTEMPTS * RESERVE, 12);
        expect(ledger.actualSpentUsd).toBe(0);
        expect(ledger.costComplete).toBe(false);
    });

    it("honors retry-after before the next admitted attempt", async () => {
        const root = seededRoot();
        let call = 0;
        const transport = vi.fn(async (_url: string, init?: RequestInit): Promise<Response> => {
            call += 1;
            if (call === 1) return jsonResponse({ model: SERVED, provider: "Test", error: "slow down" }, 429, { "retry-after": "2" });
            return jsonResponse(successBody(answersForBody(init)));
        });
        const sleep = vi.fn(async (_ms: number) => {});
        const request = onlyRequest(buildM0Request(ARM, QUERY, candidates()));
        const records = await runExecute(root, transport, request, { sleep });
        expect(records).toHaveLength(2);
        expect(records[0]?.errorClass).toBe("http_429");
        expect(sleep).toHaveBeenCalledTimes(1);
        expect(sleep).toHaveBeenCalledWith(2000);
    });

    it("settles a NEGATIVE reported cost as UNKNOWN (reserve retained), emits the record, never leaves the attempt in-flight", async () => {
        const root = seededRoot();
        const transport = vi.fn(async (_url: string, init?: RequestInit): Promise<Response> =>
            jsonResponse(successBody(answersForBody(init), { input_tokens: 100, cost: -0.01 })));
        const onWireRecord = vi.fn((_record: MethodWireRecord) => {});
        const request = onlyRequest(buildM0Request(ARM, QUERY, candidates()));
        const records = await runExecute(root, transport, request, { onWireRecord });
        expect(records).toHaveLength(1);
        const [record] = records;
        if (record === undefined) throw new Error("expected one record");
        expect(isMethodWireRecord(record)).toBe(true);
        expect(record.errorClass).toBeNull();
        expect(record.cost).toEqual({ status: "unknown", reserveUsd: RESERVE });
        expect(record.answers.map((answer) => answer.probability)).toEqual([0.7, 0.4, 0.55]);
        expect(onWireRecord).toHaveBeenCalledTimes(1);
        expect(onWireRecord.mock.calls[0]?.[0]).toBe(record);
        const ledger = loadCampaignLedger(root);
        expect(ledger.inFlight).toHaveLength(0); // settled exactly once — never stranded in-flight
        expect(ledger.settled.map((settled) => settled.status)).toEqual(["unknown"]);
        expect(ledger.campaignUsedUsd).toBeCloseTo(RESERVE, 12); // reserve retained
        expect(ledger.reserveBreached).toBe(false);
    });

    it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
        "settles a %s reported cost as UNKNOWN (reserve retained), emits the record, never leaves the attempt in-flight",
        async (invalidCost) => {
            const root = seededRoot();
            // JSON cannot spell NaN/±Infinity (they stringify to null), so a
            // marker-tagged body lets this test deliver a literal non-finite
            // cost through the executor's real capture/parse path.
            const realParse = JSON.parse.bind(JSON);
            const parseSpy = vi.spyOn(JSON, "parse").mockImplementation((text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
                const parsed: unknown = realParse(text, reviver);
                if (typeof text === "string" && text.includes('"costProbe":"non-finite-cost-probe"')) {
                    const body = parsed as { usage?: Record<string, unknown> };
                    body.usage = { ...body.usage, cost: invalidCost };
                }
                return parsed;
            });
            try {
                const transport = vi.fn(async (_url: string, init?: RequestInit): Promise<Response> =>
                    jsonResponse({
                        model: SERVED,
                        provider: "Test",
                        answers: answersForBody(init),
                        usage: { input_tokens: 100 },
                        costProbe: "non-finite-cost-probe",
                    }));
                const onWireRecord = vi.fn((_record: MethodWireRecord) => {});
                const request = onlyRequest(buildM0Request(ARM, QUERY, candidates()));
                const records = await runExecute(root, transport, request, { onWireRecord });
                expect(records).toHaveLength(1);
                const [record] = records;
                if (record === undefined) throw new Error("expected one record");
                expect(isMethodWireRecord(record)).toBe(true);
                expect(record.cost).toEqual({ status: "unknown", reserveUsd: RESERVE });
                expect(onWireRecord).toHaveBeenCalledTimes(1);
                expect(onWireRecord.mock.calls[0]?.[0]).toBe(record);
                const ledger = loadCampaignLedger(root);
                expect(ledger.inFlight).toHaveLength(0);
                expect(ledger.settled.map((settled) => settled.status)).toEqual(["unknown"]);
                expect(ledger.campaignUsedUsd).toBeCloseTo(RESERVE, 12);
            } finally {
                parseSpy.mockRestore();
            }
        },
    );

    it("retains the frozen reserve when the response reports no cost (UNKNOWN)", async () => {
        const root = seededRoot();
        const transport = vi.fn(async (_url: string, init?: RequestInit): Promise<Response> =>
            jsonResponse(successBody(answersForBody(init), { input_tokens: 128 })));
        const request = onlyRequest(buildM0Request(ARM, QUERY, candidates()));
        const [record] = await runExecute(root, transport, request);
        if (record === undefined) throw new Error("expected one record");
        expect(isMethodWireRecord(record)).toBe(true);
        expect(record.errorClass).toBeNull();
        expect(record.cost).toEqual({ status: "unknown", reserveUsd: RESERVE });
        expect(record.inputTokens).toBe(128);
        expect(record.outputTokens).toBeNull();
        const ledger = loadCampaignLedger(root);
        expect(ledger.inFlight).toHaveLength(0);
        expect(ledger.settled.map((settled) => settled.status)).toEqual(["unknown"]);
        expect(ledger.campaignUsedUsd).toBeCloseTo(RESERVE, 12);
        expect(ledger.costComplete).toBe(false);
    });

    it("records transport failures as null-status attempts and retries them within the bound", async () => {
        const root = seededRoot();
        const transport = vi.fn(async (): Promise<Response> => {
            throw new TypeError("fetch failed");
        });
        const sleep = vi.fn(async (_ms: number) => {});
        const request = onlyRequest(buildM0Request(ARM, QUERY, candidates()));
        const records = await runExecute(root, transport, request, { sleep });
        expect(records).toHaveLength(METHOD_WIRE_MAX_ATTEMPTS);
        for (const record of records) {
            expect(isMethodWireRecord(record)).toBe(true);
            expect(record.httpStatus).toBeNull();
            expect(record.servedModel).toBeNull();
            expect(record.provider).toBeNull();
            expect(record.errorClass).toBe("network");
            expect(record.answers.every((answer) => answer.probability === null)).toBe(true);
            expect(record.cost).toEqual({ status: "unknown", reserveUsd: RESERVE });
        }
        const ledger = loadCampaignLedger(root);
        expect(ledger.inFlight).toHaveLength(0);
        expect(ledger.settled.every((settled) => settled.status === "unknown")).toBe(true);
    });

    it("halts loudly on a reserve breach after emitting the settled record exactly once", async () => {
        const root = seededRoot();
        const transport = vi.fn(async (_url: string, init?: RequestInit): Promise<Response> =>
            jsonResponse(successBody(answersForBody(init), { input_tokens: 100, cost: 999 })));
        const onWireRecord = vi.fn((_record: MethodWireRecord) => {});
        const request = onlyRequest(buildM0Request(ARM, QUERY, candidates()));
        await expect(runExecute(root, transport, request, { onWireRecord })).rejects.toMatchObject({
            code: "aborted",
            message: "campaign_halted_reserve_breached",
        });
        expect(onWireRecord).toHaveBeenCalledTimes(1);
        expect(onWireRecord.mock.calls[0]?.[0].cost).toEqual({ status: "known", usd: 999 });
        const ledger = loadCampaignLedger(root);
        expect(ledger.reserveBreached).toBe(true);
        expect(ledger.inFlight).toHaveLength(0);
        expect(ledger.settled).toHaveLength(1);
    });

    it("carries records settled before a LATER admission refusal, even with no onWireRecord sink", async () => {
        const root = freshRoot();
        // Headroom between one and two reserves: attempt 1 admits and settles
        // UNKNOWN (reserve retained), attempt 2's admission then hits the cap.
        seedCampaignLedger(root, {
            attempts: 1,
            actualCostUsd: CAMPAIGN_TOTAL_CAP_USD - 1.5 * RESERVE,
            note: "retry-then-cap refusal fixture",
        });
        const transport = vi.fn(async (): Promise<Response> =>
            jsonResponse({ model: SERVED, provider: "Test", error: "internal" }, 500));
        const request = onlyRequest(buildM0Request(ARM, QUERY, candidates()));
        let caught: unknown;
        try {
            await runExecute(root, transport, request);
        } catch (error) {
            caught = error;
        }
        expect(String(caught)).toMatch(/Campaign cap exceeded/);
        const settledRecords = attemptRecordsOf(caught);
        expect(settledRecords).toHaveLength(1);
        expect(settledRecords[0]?.attemptIndex).toBe(1);
        expect(settledRecords[0]?.httpStatus).toBe(500);
        expect(transport).toHaveBeenCalledTimes(1); // attempt 2 never reached the wire
        const ledger = loadCampaignLedger(root);
        expect(ledger.inFlight).toHaveLength(0);
        expect(ledger.settled).toHaveLength(1);
    });

    it("a foreign `records` field on a thrown error never masks this call's settled snapshot", async () => {
        const root = seededRoot();
        const transport = vi.fn(async (): Promise<Response> =>
            jsonResponse({ model: SERVED, provider: "Test", error: "internal" }, 500));
        const sleep = vi.fn(async (): Promise<void> => {
            throw Object.assign(new Error("sleep failed"), { records: [] });
        });
        const request = onlyRequest(buildM0Request(ARM, QUERY, candidates()));
        let caught: unknown;
        try {
            await runExecute(root, transport, request, { sleep });
        } catch (error) {
            caught = error;
        }
        expect((caught as Error).message).toBe("sleep failed");
        expect((caught as Error).name).toBe("Error"); // original identity preserved
        const settledRecords = attemptRecordsOf(caught);
        expect(settledRecords).toHaveLength(1);
        expect(settledRecords[0]?.attemptIndex).toBe(1);
        expect(settledRecords[0]?.httpStatus).toBe(500);
        const ledger = loadCampaignLedger(root);
        expect(ledger.inFlight).toHaveLength(0);
        expect(ledger.settled).toHaveLength(1);
    });

    it.each([
        [
            "throwing getter",
            () => {
                const foreign = new Error("getter boom");
                Object.defineProperty(foreign, "records", {
                    get() {
                        throw new Error("getter boom");
                    },
                    configurable: true,
                });
                return foreign;
            },
        ],
        [
            "non-configurable property",
            () => {
                const foreign = new Error("nonconf boom");
                Object.defineProperty(foreign, "records", { value: [], configurable: false, writable: false });
                return foreign;
            },
        ],
    ])("a foreign %s on a thrown error cannot escape attachment", async (_label, makeForeign) => {
        const root = seededRoot();
        const foreign = makeForeign();
        const transport = vi.fn(async (): Promise<Response> =>
            jsonResponse({ model: SERVED, provider: "Test", error: "internal" }, 500));
        const sleep = vi.fn(async (): Promise<void> => {
            throw foreign;
        });
        const request = onlyRequest(buildM0Request(ARM, QUERY, candidates()));
        let caught: unknown;
        try {
            await runExecute(root, transport, request, { sleep });
        } catch (error) {
            caught = error;
        }
        const settledRecords = attemptRecordsOf(caught);
        expect(settledRecords).toHaveLength(1);
        expect(settledRecords[0]?.attemptIndex).toBe(1);
        expect(settledRecords[0]?.httpStatus).toBe(500);
        // Wrapped with the original preserved as cause, original message kept.
        expect((caught as Error).message).toBe(foreign.message);
        expect((caught as { cause?: unknown }).cause).toBe(foreign);
        const ledger = loadCampaignLedger(root);
        expect(ledger.inFlight).toHaveLength(0);
        expect(ledger.settled).toHaveLength(1);
    });

    it("keeps a foreign records array already carrying our snapshot (identity preserved) and replaces a partial one (JSON-invisible)", async () => {
        // Complete foreign array: our snapshot is already there -> original error kept.
        const rootComplete = seededRoot();
        const captured: MethodWireRecord[] = [];
        let thrown: Error | undefined;
        const transport = vi.fn(async (): Promise<Response> =>
            jsonResponse({ model: SERVED, provider: "Test", error: "internal" }, 500));
        const sleep = vi.fn(async (): Promise<void> => {
            thrown = Object.assign(new Error("already carried"), { records: [...captured] });
            throw thrown;
        });
        const request = onlyRequest(buildM0Request(ARM, QUERY, candidates()));
        let caught: unknown;
        try {
            await runExecute(rootComplete, transport, request, { sleep, onWireRecord: (record: MethodWireRecord) => captured.push(record) });
        } catch (error) {
            caught = error;
        }
        expect(captured).toHaveLength(1);
        expect(caught).toBe(thrown); // identity preserved, no redefinition
        expect(attemptRecordsOf(caught)).toHaveLength(1);

        // Partial foreign array: replaced with our snapshot, non-enumerable.
        const rootPartial = seededRoot();
        const transport2 = vi.fn(async (): Promise<Response> =>
            jsonResponse({ model: SERVED, provider: "Test", error: "internal" }, 500));
        const sleep2 = vi.fn(async (): Promise<void> => {
            throw Object.assign(new Error("partial"), { records: ["foreign"] });
        });
        let caught2: unknown;
        try {
            await runExecute(rootPartial, transport2, request, { sleep: sleep2 });
        } catch (error) {
            caught2 = error;
        }
        const records2 = attemptRecordsOf(caught2);
        expect(records2).toHaveLength(1);
        expect(typeof records2[0]).toBe("object"); // ours, not the foreign string
        expect(JSON.stringify(caught2)).not.toContain("records"); // non-enumerable attach
        expect(loadCampaignLedger(rootPartial).inFlight).toHaveLength(0);
    });

    it("a hostile Proxy error cannot fake attachment: the snapshot comes back via wrapping", async () => {
        const root = seededRoot();
        const fake = [{}, {}];
        const proxy = new Proxy(new Error("proxy boom"), {
            defineProperty: () => true, // silently claims success without defining
            get: (target, prop, recv) => (prop === "records" ? fake : Reflect.get(target, prop, recv)),
        });
        const transport = vi.fn(async (): Promise<Response> =>
            jsonResponse({ model: SERVED, provider: "Test", error: "internal" }, 500));
        const sleep = vi.fn(async (): Promise<void> => {
            throw proxy;
        });
        const request = onlyRequest(buildM0Request(ARM, QUERY, candidates()));
        let caught: unknown;
        try {
            await runExecute(root, transport, request, { sleep });
        } catch (error) {
            caught = error;
        }
        const settled = attemptRecordsOf(caught);
        expect(settled).toHaveLength(1); // our snapshot, never the proxy's fake
        expect(settled).not.toBe(fake as never);
        expect(settled[0]?.attemptIndex).toBe(1);
        expect((caught as Error).message).toBe("proxy boom");
        expect((caught as { cause?: unknown }).cause).toBe(proxy);
        expect(loadCampaignLedger(root).inFlight).toHaveLength(0);
    });

    it("a Proxy whose name getter throws still wraps with the snapshot intact", async () => {
        const root = seededRoot();
        const proxy = new Proxy(new Error("name boom"), {
            defineProperty: () => true,
            get: (target, prop, recv) => {
                if (prop === "records") return [{}];
                if (prop === "name") throw new Error("name getter boom");
                return Reflect.get(target, prop, recv);
            },
        });
        const transport = vi.fn(async (): Promise<Response> =>
            jsonResponse({ model: SERVED, provider: "Test", error: "internal" }, 500));
        const sleep = vi.fn(async (): Promise<void> => {
            throw proxy;
        });
        const request = onlyRequest(buildM0Request(ARM, QUERY, candidates()));
        let caught: unknown;
        try {
            await runExecute(root, transport, request, { sleep });
        } catch (error) {
            caught = error;
        }
        expect((caught as Error).name).toBe("MethodAttemptRecordsError");
        expect((caught as Error).message).toBe("name boom");
        expect((caught as { cause?: unknown }).cause).toBe(proxy);
        expect(attemptRecordsOf(caught)).toHaveLength(1);
        expect(loadCampaignLedger(root).inFlight).toHaveLength(0);
    });

    it("a non-Error throw keeps the original value as cause and the snapshot", async () => {
        const root = seededRoot();
        const transport = vi.fn(async (): Promise<Response> =>
            jsonResponse({ model: SERVED, provider: "Test", error: "internal" }, 500));
        const sleep = vi.fn(async (): Promise<void> => {
            // eslint-disable-next-line no-throw-literal -- intentional: the wrap path must keep non-Error throws
            throw 42;
        });
        const request = onlyRequest(buildM0Request(ARM, QUERY, candidates()));
        let caught: unknown;
        try {
            await runExecute(root, transport, request, { sleep });
        } catch (error) {
            caught = error;
        }
        expect((caught as { cause?: unknown }).cause).toBe(42);
        expect((caught as Error).message).toBe("42");
        expect(attemptRecordsOf(caught)).toHaveLength(1);
        expect(loadCampaignLedger(root).inFlight).toHaveLength(0);
    });

    it("exposed records are immutable: frozen elements, frozen arrays, non-writable records property", async () => {
        // Caught-error path (near-cap seed so attempt 2's admission refuses).
        const root = freshRoot();
        seedCampaignLedger(root, {
            attempts: 1,
            actualCostUsd: CAMPAIGN_TOTAL_CAP_USD - 1.5 * RESERVE,
            note: "immutability fixture",
        });
        const transport = vi.fn(async (): Promise<Response> =>
            jsonResponse({ model: SERVED, provider: "Test", error: "internal" }, 500));
        const request = onlyRequest(buildM0Request(ARM, QUERY, candidates()));
        let caught: unknown;
        try {
            await runExecute(root, transport, request);
        } catch (error) {
            caught = error;
        }
        const settled = attemptRecordsOf(caught);
        expect(settled).toHaveLength(1);
        expect(Object.isFrozen(settled)).toBe(true);
        expect(Object.isFrozen(settled[0])).toBe(true);
        expect(Object.isFrozen((settled[0] as { cost: unknown }).cost)).toBe(true);
        expect(() => (settled as unknown as MethodWireRecord[]).push(settled[0] as MethodWireRecord)).toThrow(TypeError);
        expect(() => {
            (settled[0] as unknown as { httpStatus: number }).httpStatus = 999;
        }).toThrow(TypeError);
        expect(() => {
            (caught as { records: unknown }).records = [];
        }).toThrow(TypeError); // non-writable property

        // Success path: returned records are frozen at birth too.
        const rootOk = seededRoot();
        const transportOk = vi.fn(async (): Promise<Response> => jsonResponse(successBody(answersForBody(undefined))));
        const out = await runExecute(rootOk, transportOk, request);
        expect(Object.isFrozen(out)).toBe(true);
        expect(Object.isFrozen(out[0])).toBe(true);
        expect(() => (out as unknown as MethodWireRecord[]).push(out[0] as MethodWireRecord)).toThrow(TypeError);
    });

    it("reserve breach with NO sink still exposes the settled record on the thrown error", async () => {
        const root = seededRoot();
        const transport = vi.fn(async (_url: string, init?: RequestInit): Promise<Response> =>
            jsonResponse(successBody(answersForBody(init), { input_tokens: 100, cost: 999 }))); 
        const request = onlyRequest(buildM0Request(ARM, QUERY, candidates()));
        let caught: unknown;
        try {
            await runExecute(root, transport, request);
        } catch (error) {
            caught = error;
        }
        expect((caught as { code?: string }).code).toBe("aborted");
        const settledRecords = attemptRecordsOf(caught);
        expect(settledRecords).toHaveLength(1);
        expect(settledRecords[0]?.cost).toEqual({ status: "known", usd: 999 });
        const ledger = loadCampaignLedger(root);
        expect(ledger.inFlight).toHaveLength(0);
        expect(ledger.settled).toHaveLength(1);
    });
});

describe("served identity capture (verbatim, never inferred)", () => {
    it("captures served model and provider from the response body, not the requested slug", async () => {
        const root = seededRoot();
        const transport = vi.fn(async (_url: string, init?: RequestInit): Promise<Response> =>
            jsonResponse({ model: SERVED, provider: "Perplexity", answers: answersForBody(init), usage: { input_tokens: 100, cost: KNOWN_COST } }));
        const request = onlyRequest(buildM0Request(ARM, QUERY, candidates()));
        const [record] = await runExecute(root, transport, request);
        if (record === undefined) throw new Error("expected one record");
        expect(SERVED).not.toBe(ARM); // served identity differs from the requested slug
        expect(record.servedModel).toBe(SERVED);
        expect(record.provider).toBe("Perplexity");
        expect(isMethodWireRecord(record)).toBe(true);
    });

    it("halts with MethodCaptureGapError AFTER settling UNKNOWN and emitting a bindable capture-gap record", async () => {
        const root = seededRoot();
        const transport = vi.fn(async (_url: string, init?: RequestInit): Promise<Response> =>
            jsonResponse({ answers: answersForBody(init), usage: { input_tokens: 100, cost: KNOWN_COST } }));
        const emitted: MethodWireRecord[] = [];
        const onWireRecord = vi.fn((record: MethodWireRecord) => { emitted.push(record); });
        const request = onlyRequest(buildM0Request(ARM, QUERY, candidates()));
        await expect(runExecute(root, transport, request, { onWireRecord, replica: 0 }))
            .rejects.toBeInstanceOf(MethodCaptureGapError);
        // The halt happens only AFTER the durable record reached the hook.
        expect(transport).toHaveBeenCalledTimes(1);
        expect(onWireRecord).toHaveBeenCalledTimes(1);
        const [gap0] = emitted;
        if (gap0 === undefined) throw new Error("expected a capture-gap record");
        expect(isMethodWireRecord(gap0)).toBe(true); // bindable: passes the Stage C guard
        // A capture gap keeps the REAL response status and records the explicit
        // absent-identity class (received-but-unsuccessful) — never a null status.
        expect(gap0.httpStatus).toBe(200);
        expect(gap0.servedModel).toBeNull();
        expect(gap0.provider).toBeNull();
        expect(gap0.errorClass).toBe("capture_gap");
        expect(gap0.answers.every((answer) => answer.probability === null)).toBe(true);
        expect(gap0.cost).toEqual({ status: "unknown", reserveUsd: RESERVE });
        const ledger = loadCampaignLedger(root);
        expect(ledger.inFlight).toHaveLength(0); // settled exactly once, never left in-flight
        expect(ledger.settled.map((settled) => settled.status)).toEqual(["unknown"]);
        expect(ledger.campaignUsedUsd).toBeCloseTo(RESERVE, 12); // reserve retained

        // Replica 1 completes a two-replica report: the capture-gap records
        // still bind end-to-end through bindMethodComparisonReport.
        await expect(runExecute(root, transport, request, { onWireRecord, replica: 1 }))
            .rejects.toBeInstanceOf(MethodCaptureGapError);
        expect(onWireRecord).toHaveBeenCalledTimes(2);
        const gap1 = emitted[1];
        if (gap1 === undefined) throw new Error("expected a second capture-gap record");
        expect(isMethodWireRecord(gap1)).toBe(true);
        const derivedScores: MethodDerivedScore[] = [];
        for (const record of [gap0, gap1]) {
            if (record.queryGroup === null) throw new Error("expected a non-warmup record");
            for (const answer of record.answers) {
                derivedScores.push({
                    method: record.method,
                    arm: record.arm,
                    phase: record.phase,
                    replica: record.replica,
                    queryGroup: record.queryGroup,
                    candidateId: answer.candidateId,
                    probability: answer.probability,
                    wireIds: [record.wireId],
                });
            }
        }
        const binding = expectBound({
            envelope: envelope("M0"),
            plannedCandidates: PLANNED,
            wireRecords: [gap0, gap1],
            derivedScores,
        });
        expect(binding.totals.wireRequestCount).toBe(2);
        expect(binding.totals.knownCostRequests).toBe(0);
        expect(binding.totals.unknownCostRequests).toBe(2);
        expect(binding.totals.unknownCostReserveUsd).toBeCloseTo(2 * RESERVE, 12);
        const finalLedger = loadCampaignLedger(root);
        expect(finalLedger.inFlight).toHaveLength(0);
        expect(finalLedger.settled.map((settled) => settled.status)).toEqual(["unknown", "unknown"]);
        expect(finalLedger.campaignUsedUsd).toBeCloseTo(2 * RESERVE, 12);
    });

    it("exposes the capture-gap record on MethodCaptureGapError when no onWireRecord sink is provided", async () => {
        const root = seededRoot();
        const transport = vi.fn(async (_url: string, init?: RequestInit): Promise<Response> =>
            jsonResponse({ answers: answersForBody(init), usage: { input_tokens: 100, cost: KNOWN_COST } }));
        const request = onlyRequest(buildM0Request(ARM, QUERY, candidates()));
        const rejected: unknown = await runExecute(root, transport, request).then(
            () => { throw new Error("expected a capture-gap halt"); },
            (error: unknown) => error,
        );
        expect(rejected).toBeInstanceOf(MethodCaptureGapError);
        const { records } = rejected as MethodCaptureGapError;
        expect(records).toHaveLength(1); // durable even with no sink
        const [gap] = records;
        if (gap === undefined) throw new Error("expected the capture-gap record on the error");
        expect(isMethodWireRecord(gap)).toBe(true);
        expect(gap.httpStatus).toBe(200);
        expect(gap.errorClass).toBe("capture_gap");
        expect(gap.servedModel).toBeNull();
        const ledger = loadCampaignLedger(root);
        expect(ledger.inFlight).toHaveLength(0); // settled exactly once, never left in-flight
        expect(ledger.settled.map((settled) => settled.status)).toEqual(["unknown"]);
    });
});

/* ──────────────────────────────────────────────────────────────────
 * Amendment A3 (protocol §12): transport classification vs capture gap
 * ────────────────────────────────────────────────────────────────── */

describe("Amendment A3: a received non-2xx without served model is a transport failure, never a capture gap", () => {
    it("classifies a 529 without a served model as http_529, retries it, and succeeds on attempt 2 — no halt", async () => {
        const root = seededRoot();
        let call = 0;
        const transport = vi.fn(async (_url: string, init?: RequestInit): Promise<Response> => {
            call += 1;
            if (call === 1) return jsonResponse({ error: { type: "overloaded_error", message: "Overloaded" } }, 529);
            return jsonResponse(successBody(answersForBody(init)));
        });
        const emitted: MethodWireRecord[] = [];
        const request = onlyRequest(buildM0Request(ARM, QUERY, candidates()));
        // The whole run completes: the transient 5xx is retried within the
        // bound, never a MethodCaptureGapError.
        const records = await runExecute(root, transport, request, { onWireRecord: (record) => { emitted.push(record); }, sleep: async () => {} });
        expect(records).toHaveLength(2);
        const [failed, recovered] = records;
        if (failed === undefined || recovered === undefined) throw new Error("expected two records");
        expect(isMethodWireRecord(failed)).toBe(true);
        // A3: REAL status + transport class + absent identity — NOT capture_gap.
        expect(failed.httpStatus).toBe(529);
        expect(failed.errorClass).toBe("http_529");
        expect(failed.servedModel).toBeNull();
        expect(failed.provider).toBeNull();
        expect(failed.answers.every((answer) => answer.probability === null)).toBe(true);
        expect(failed.cost).toEqual({ status: "unknown", reserveUsd: RESERVE });
        expect(failed.attemptIndex).toBe(1);
        // Every emitted record is stamped A3-era (the era boundary).
        expect(failed.rulesetVersion).toBe("A3");
        expect(recovered.errorClass).toBeNull();
        expect(recovered.servedModel).toBe(SERVED);
        expect(recovered.attemptIndex).toBe(2);
        expect(recovered.rulesetVersion).toBe("A3");
        expect(emitted).toHaveLength(2);
        const ledger = loadCampaignLedger(root);
        expect(ledger.inFlight).toHaveLength(0);
        expect(ledger.settled.map((settled) => settled.status)).toEqual(["unknown", "settled"]);
    });

    it("a received non-2xx WITH a captured served model keeps the pre-A3 statusFailure shape (identity verbatim)", async () => {
        const root = seededRoot();
        const transport = vi.fn(async (): Promise<Response> =>
            jsonResponse({ model: SERVED, provider: "Test", error: "slow down" }, 429));
        const request = onlyRequest(buildM0Request(ARM, QUERY, candidates()));
        const records = await runExecute(root, transport, request, { sleep: async () => {} });
        const [record] = records;
        if (record === undefined) throw new Error("expected one record");
        expect(isMethodWireRecord(record)).toBe(true);
        expect(record.httpStatus).toBe(429);
        expect(record.errorClass).toBe("http_429");
        expect(record.servedModel).toBe(SERVED);
        expect(record.provider).toBe("Test");
    });

    it("a received 2xx WITHOUT a served model remains a capture gap under A3 (halt + capture_gap record)", async () => {
        const root = seededRoot();
        const transport = vi.fn(async (_url: string, init?: RequestInit): Promise<Response> =>
            jsonResponse({ answers: answersForBody(init), usage: { input_tokens: 100, cost: KNOWN_COST } }));
        const request = onlyRequest(buildM0Request(ARM, QUERY, candidates()));
        const rejected: unknown = await runExecute(root, transport, request).then(
            () => { throw new Error("expected a capture-gap halt"); },
            (error: unknown) => error,
        );
        expect(rejected).toBeInstanceOf(MethodCaptureGapError);
        const { records } = rejected as MethodCaptureGapError;
        const [gap] = records;
        if (gap === undefined) throw new Error("expected a capture-gap record");
        expect(isMethodWireRecord(gap)).toBe(true);
        expect(gap.httpStatus).toBe(200);
        expect(gap.errorClass).toBe("capture_gap");
        expect(gap.rulesetVersion).toBe("A3");
    });
});

describe("admission refusals and origin pin never reach the transport", () => {
    it("propagates an absent-ledger admission refusal without calling the transport", async () => {
        const root = freshRoot(); // deliberately NOT seeded
        const transport = vi.fn(async (): Promise<Response> => jsonResponse(successBody({})));
        const request = onlyRequest(buildM0Request(ARM, QUERY, candidates()));
        await expect(runExecute(root, transport, request)).rejects.toThrow(/seed it first/);
        expect(transport).not.toHaveBeenCalled();
    });

    it("propagates a cap-exceeded admission refusal without calling the transport or touching the ledger", async () => {
        const root = freshRoot();
        seedCampaignLedger(root, { attempts: 1, actualCostUsd: CAMPAIGN_TOTAL_CAP_USD - 0.0001, note: "near-cap refusal fixture" });
        const transport = vi.fn(async (): Promise<Response> => jsonResponse(successBody({})));
        const request = onlyRequest(buildM0Request(ARM, QUERY, candidates()));
        await expect(runExecute(root, transport, request)).rejects.toThrow(/Campaign cap exceeded/);
        expect(transport).not.toHaveBeenCalled();
        const ledger = loadCampaignLedger(root);
        expect(ledger.attempts).toBe(1);
        expect(ledger.inFlight).toHaveLength(0);
    });

    it("rejects an off-origin decisions URL before any admission (origin pin, redirect refused)", async () => {
        const root = seededRoot();
        const transport = vi.fn(async (): Promise<Response> => jsonResponse(successBody({})));
        const request = onlyRequest(buildM0Request(ARM, QUERY, candidates()));
        await expect(runExecute(root, transport, request, { baseUrl: "http://openrouter.ai/api/alpha" }))
            .rejects.toMatchObject({ code: "endpoint_not_allowed" });
        expect(transport).not.toHaveBeenCalled();
        expect(loadCampaignLedger(root).attempts).toBe(0);
    });
});

describe("clock validation precedes admission (an invalid clock strands nothing)", () => {
    it("a throwing now() fails BEFORE admission: no attempt in flight, no transport call", async () => {
        const root = seededRoot();
        const transport = vi.fn(async (_url: string, init?: RequestInit): Promise<Response> =>
            jsonResponse(successBody(answersForBody(init))));
        const request = onlyRequest(buildM0Request(ARM, QUERY, candidates()));
        const now = vi.fn((): Date => { throw new Error("clock broken"); });
        await expect(runExecute(root, transport, request, { now })).rejects.toThrow("clock broken");
        expect(now).toHaveBeenCalled(); // the clock was consulted…
        expect(transport).not.toHaveBeenCalled(); // …but admission/transport never happened
        const ledger = loadCampaignLedger(root);
        expect(ledger.attempts).toBe(0);
        expect(ledger.inFlight).toHaveLength(0);
        expect(ledger.settled).toHaveLength(0);
    });

    it("an invalid Date from now() fails BEFORE admission with nothing in flight", async () => {
        const root = seededRoot();
        const transport = vi.fn(async (_url: string, init?: RequestInit): Promise<Response> =>
            jsonResponse(successBody(answersForBody(init))));
        const request = onlyRequest(buildM0Request(ARM, QUERY, candidates()));
        await expect(runExecute(root, transport, request, { now: () => new Date(NaN) }))
            .rejects.toThrow(/invalid Date/);
        expect(transport).not.toHaveBeenCalled();
        const ledger = loadCampaignLedger(root);
        expect(ledger.attempts).toBe(0);
        expect(ledger.inFlight).toHaveLength(0);
        expect(ledger.settled).toHaveLength(0);
    });
});

describe("answer validation: production validateAnswers semantics, whole-request poisoning", () => {
    it("poisons the whole request on a malformed answer (production also rejects it)", async () => {
        const items = candidates();
        const poisoned = { u0: 0.5, u1: { noul: 1.5 }, u2: 0.55 };
        // Production: validateAnswers throws bad_response for the same payload.
        const prodFetch: FetchFn = async () => jsonResponse({ model: SERVED, provider: "Test", answers: poisoned, usage: {} });
        const judge = new CloudJudge({ model: ARM, cache: null, fetchFn: prodFetch, sleepFn: async () => {} });
        await expect(judge.judgeNouls({ shared: { query: QUERY }, items: prodItems(items) }))
            .rejects.toMatchObject({ code: "bad_response" });
        // Executor: the WHOLE request is bad_response (all answers null), reserve retained.
        const root = seededRoot();
        const transport = vi.fn(async (): Promise<Response> =>
            jsonResponse({ model: SERVED, provider: "Test", answers: poisoned, usage: {} }));
        const request = onlyRequest(buildM0Request(ARM, QUERY, items));
        const [record] = await runExecute(root, transport, request);
        if (record === undefined) throw new Error("expected one record");
        expect(record.errorClass).toBe("bad_response");
        expect(record.httpStatus).toBe(200);
        expect(record.servedModel).toBe(SERVED);
        expect(record.answers).toEqual([
            { candidateId: "u0", probability: null },
            { candidateId: "u1", probability: null },
            { candidateId: "u2", probability: null },
        ]);
        expect(record.cost.status).toBe("unknown");
        expect(isMethodWireRecord(record)).toBe(true);
        expect(loadCampaignLedger(root).settled.map((settled) => settled.status)).toEqual(["unknown"]);
    });

    it("poisons on a MISSING answer where production only marks that entry unjudged (plan §3 divergence)", async () => {
        const items = candidates();
        const missing = { u0: 0.7, u1: 0.4 }; // u2 absent
        const prodFetch: FetchFn = async () => jsonResponse({ model: SERVED, provider: "Test", answers: missing, usage: {} });
        const judge = new CloudJudge({ model: ARM, cache: null, fetchFn: prodFetch, sleepFn: async () => {} });
        const prod = await judge.judgeNouls({ shared: { query: QUERY }, items: prodItems(items) });
        expect(prod.unjudged).toEqual([{ id: "u2", code: "bad_response" }]);
        expect(prod.p.get("u0")).toBe(0.7);
        // Executor poisons the whole batch instead: a partial response can never bind.
        const root = seededRoot();
        const transport = vi.fn(async (): Promise<Response> =>
            jsonResponse({ model: SERVED, provider: "Test", answers: missing, usage: {} }));
        const request = onlyRequest(buildM0Request(ARM, QUERY, items));
        const [record] = await runExecute(root, transport, request);
        if (record === undefined) throw new Error("expected one record");
        expect(record.errorClass).toBe("bad_response");
        expect(record.answers.every((answer) => answer.probability === null)).toBe(true);
    });

    it("poisons on an EXTRA answer key (production would ignore it)", async () => {
        const items = candidates();
        const extra = { u0: 0.7, u1: 0.4, u2: 0.55, u9: 0.5 };
        const prodFetch: FetchFn = async () => jsonResponse({ model: SERVED, provider: "Test", answers: extra, usage: {} });
        const judge = new CloudJudge({ model: ARM, cache: null, fetchFn: prodFetch, sleepFn: async () => {} });
        const prod = await judge.judgeNouls({ shared: { query: QUERY }, items: prodItems(items) });
        expect(prod.unjudged).toHaveLength(0); // production judged all three and ignored u9
        const root = seededRoot();
        const transport = vi.fn(async (): Promise<Response> =>
            jsonResponse({ model: SERVED, provider: "Test", answers: extra, usage: {} }));
        const request = onlyRequest(buildM0Request(ARM, QUERY, items));
        const [record] = await runExecute(root, transport, request);
        if (record === undefined) throw new Error("expected one record");
        expect(record.errorClass).toBe("bad_response");
        expect(record.answers.every((answer) => answer.probability === null)).toBe(true);
    });

    it("accepts von-style detail objects and maps them to the banded noul (like production)", async () => {
        const root = seededRoot();
        const transport = vi.fn(async (): Promise<Response> =>
            jsonResponse(successBody({ u0: { noul: 0.7, noul_raw: 0.68 }, u1: { noul: 0.4 }, u2: { noul: 0.55 } })));
        const request = onlyRequest(buildM0Request(ARM, QUERY, candidates()));
        const [record] = await runExecute(root, transport, request);
        if (record === undefined) throw new Error("expected one record");
        expect(record.errorClass).toBeNull();
        expect(record.answers.map((answer) => answer.probability)).toEqual([0.7, 0.4, 0.55]);
        expect(answersForBody({ body: request.body })).toEqual(FIXED_P); // sanity: body untouched
    });
});
