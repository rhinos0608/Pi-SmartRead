import { createHash } from "node:crypto";

const fsyncProbe = vi.hoisted(() => ({ events: [] as string[], fdPaths: new Map<number, string>(), failDirectorySync: false, journalSyncCount: 0, failJournalSyncAt: 0 }));
vi.mock("node:fs", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs")>();
    return {
        ...actual,
        openSync: ((path: string, flags: string | number, mode?: number) => {
            const fd = actual.openSync(path, flags as number, mode);
            fsyncProbe.fdPaths.set(fd, path);
            return fd;
        }) as typeof actual.openSync,
        closeSync: (fd: number) => { fsyncProbe.fdPaths.delete(fd); actual.closeSync(fd); },
        fsyncSync: (fd: number) => {
            const path = fsyncProbe.fdPaths.get(fd) ?? "unknown";
            if (actual.fstatSync(fd).isDirectory()) {
                fsyncProbe.events.push(`directory:${path}`);
                if (fsyncProbe.failDirectorySync) throw new Error("injected directory fsync failure");
            } else {
                fsyncProbe.events.push(`file:${path}`);
                if (path.endsWith("dispatch-intents.jsonl")) {
                    fsyncProbe.journalSyncCount += 1;
                    if (fsyncProbe.journalSyncCount === fsyncProbe.failJournalSyncAt) throw new Error("injected journal fsync failure");
                }
            }
            actual.fsyncSync(fd);
        },
    };
});
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildM0Request, buildM2Reverse } from "../../../scripts/eval/judge/method-comparison-executor.js";
import { loadVerifiedConfirmCorpus } from "../../../scripts/eval/judge/method-confirm-fixture.js";
import { seedCampaignLedger } from "../../../scripts/eval/judge/model-comparison-budget.js";
import { COMPARISON_SERVED_MODEL_ALLOWLIST, type ComparisonModelId } from "../../../scripts/eval/judge/model-comparison-types.js";
import {
    METHOD_CONFIRM_DEFERRED_SUITE, METHOD_CONFIRM_MODELS, METHOD_CONFIRM_REPLICAS,
    METHOD_CONFIRM_EXIT_GATE, buildMethodConfirmPlanFromInputs, executeConfirmPlan, runMethodConfirm,
    type BuiltConfirmPlan, type ConfirmPlan, type ConfirmPlanRequest,
} from "../../../scripts/eval/judge/method-confirm.js";
import type { FetchFn } from "../../../src/judge/systemone-client.js";

const roots: string[] = [];
function tempRoot(prefix: string): string { const root = realpathSync(mkdtempSync(join(tmpdir(), prefix))); roots.push(root); return root; }
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
const corpusRoot = join(process.env.HOME ?? "", ".cache/pi-smartread-judge-confirm-20261009/sealed");
const sealedCorpusAvailable = (() => { try { return loadVerifiedConfirmCorpus(corpusRoot).queries.length === 400; } catch { return false; } })();

function oneRequest(qid: string, arm: ComparisonModelId = "~typesafe/jev-latest"): BuiltConfirmPlan {
    const candidate = { candidateId: `c-${qid}`, state: { path: "src/file.ts", symbol: "f", text: "export function f() {}" } };
    const request = buildM0Request(arm, `How does ${qid} work?`, [candidate])[0]!;
    const plan: ConfirmPlanRequest = { arm, method: "M0", replica: 0, queryGroup: qid, warmup: false, candidateIds: [candidate.candidateId], payloadSha256: request.payloadSha256, requestBytes: request.requestBytes };
    const artifact: ConfirmPlan = { version: 1, kind: "method-confirm-plan", manifestSha256: "a".repeat(64), queryCount: 400, candidateCount: 1, replicaCount: METHOD_CONFIRM_REPLICAS, orderingRule: "test", requests: [plan], inventory: {}, replicaLadder: { fiveReplicaStressUsd: 0, fourReplicaStressUsd: 0, threeReplicaStressUsd: 0, headroomUsd: 0, selected: 3 }, deferredSuite: METHOD_CONFIRM_DEFERRED_SUITE, projection: { pilotBilledUsdPerQueryReplica: 0, scoredUsd: 0, warmupUsd: 0, deferredSuiteUsd: 0, nominalUsd: 0, stressUsd: 0, capUsd: 10, components: [] } };
    return { artifact, dispatch: [{ plan, request }] };
}
function twoCandidateRequest(qid: string): BuiltConfirmPlan {
    const arm = "~typesafe/jev-latest" as const;
    const candidates = ["a", "b"].map((suffix) => ({ candidateId: `c-${qid}-${suffix}`, state: { path: "src/file.ts", symbol: "f", text: `candidate ${suffix}` } }));
    const request = buildM0Request(arm, `How does ${qid} work?`, candidates)[0]!;
    const plan: ConfirmPlanRequest = { arm, method: "M0", replica: 0, queryGroup: qid, warmup: false, candidateIds: [...request.candidateIds], payloadSha256: request.payloadSha256, requestBytes: request.requestBytes };
    const base = oneRequest(qid);
    return { artifact: { ...base.artifact, requests: [plan] }, dispatch: [{ plan, request }] };
}
function response(arm: ComparisonModelId = "~typesafe/jev-latest", body: unknown = { model: COMPARISON_SERVED_MODEL_ALLOWLIST[arm], provider: "mock", answers: { "c-q1": 0.8 }, usage: { cost: 0, input_tokens: 10 } }): Response {
    return new Response(JSON.stringify(body), { status: 200 });
}
function rewriteRecordAndReceipt(out: string, mutate: (record: Record<string, unknown>) => Record<string, unknown>): void {
    const recordsPath = join(out, "wire-records.jsonl"), journalPath = join(out, "dispatch-intents.jsonl");
    const record = JSON.parse(readFileSync(recordsPath, "utf8").trim()) as Record<string, unknown>;
    const changed = mutate(record);
    writeFileSync(recordsPath, `${JSON.stringify(changed)}\n`, { mode: 0o600 });
    const entries = readFileSync(journalPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    const receipt = entries.find((entry) => entry.kind === "receipt" && entry.wireId === record.wireId)!;
    receipt.recordSha256 = createHash("sha256").update(JSON.stringify(changed)).digest("hex");
    writeFileSync(journalPath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, { mode: 0o600 });
}

describe("method confirmation plan", () => {
    it.runIf(sealedCorpusAvailable)("builds three replicas with exactly M0 plus the preregistered challenger, and reuses PPLX forward calls", () => {
        const roster = loadVerifiedConfirmCorpus(corpusRoot);
        const queries = readFileSync(join(corpusRoot, "confirm-queries.jsonl"), "utf8").trimEnd().split("\n").map((line) => JSON.parse(line) as { qid: string; query: string });
        const snapshots = readFileSync(join(corpusRoot, "confirm-source-snapshots.jsonl"), "utf8").trimEnd().split("\n").map((line) => JSON.parse(line) as { cid: string; excerpt: string });
        const candidates = new Map(roster.candidates.map((candidate) => [candidate.cid, candidate]));
        const built = buildMethodConfirmPlanFromInputs({ roster, queryTexts: new Map(queries.map((q) => [q.qid, q.query])), candidateStates: new Map(snapshots.map((row) => [row.cid, { path: candidates.get(row.cid)!.file, text: row.excerpt }])) });
        expect(built.artifact.replicaCount).toBe(3);
        expect(built.artifact.orderingRule).toContain("pilot plan builder order");
        for (const config of METHOD_CONFIRM_MODELS) {
            const counts = built.artifact.inventory[config.arm]!;
            expect(counts.M0).toBe(1200);
            expect(counts[config.challenger]).toBe(config.challenger === "M1" ? roster.candidates.length * 3 : 1200);
            expect(counts[config.challenger === "M1" ? "M2" : "M1"]).toBe(0);
        }
        const pplx = built.artifact.inventory["perplexity/pplx-decider-v1.1-27b"]!;
        expect(pplx.M0).toBe(1200);
        expect(pplx.M2).toBe(1200);
        expect(built.artifact.requests.filter((r) => r.arm === "perplexity/pplx-decider-v1.1-27b" && r.method === "M0")).toHaveLength(1200 + 3);
        for (const config of METHOD_CONFIRM_MODELS) {
            const rows = built.artifact.requests.filter((row) => row.arm === config.arm && !row.warmup);
            for (let replica = 0; replica < 3; replica += 1) {
                expect(rows.filter((row) => row.replica === replica && row.method === "M0")).toHaveLength(400);
                expect(rows.filter((row) => row.replica === replica && row.method === config.challenger)).toHaveLength(config.challenger === "M1" ? roster.candidates.length : 400);
            }
            expect(built.artifact.requests.filter((row) => row.arm === config.arm && row.warmup)).toHaveLength(config.challenger === "M2" ? 6 : 3);
        }
        expect(built.artifact.deferredSuite).toContain("deferred");
        expect(built.artifact.projection.scoredUsd).toBeCloseTo(2.775, 8);
        expect(built.artifact.projection.nominalUsd).toBeCloseTo(2.91666, 8);
        expect(built.artifact.replicaLadder.threeReplicaStressUsd).toBeCloseTo(9.08864, 5);
        expect(built.artifact.projection.components.find((row) => row.method === "M0" && row.arm.includes("pplx"))?.billedInputTokensPerRequest).toBe(22976);
    });

    it("refuses unverified roster input and enforces the paid flag before corpus loading", async () => {
        const loader = vi.fn(() => { throw new Error("must not load"); });
        expect(await runMethodConfirm(["--run", "--out", tempRoot("confirm-gate-")], { loadInputs: loader })).toBe(METHOD_CONFIRM_EXIT_GATE);
        expect(loader).not.toHaveBeenCalled();
        const root = tempRoot("confirm-unverified-");
        const fake = { roster: { queries: [], candidates: [], manifestSha256: "a".repeat(64) }, queryTexts: new Map(), candidateStates: new Map() } as never;
        const code = await runMethodConfirm(["--dry-run", "--out", root], { loadInputs: () => fake });
        expect(code).not.toBe(0);
    });
});

describe("method confirmation injected transport", () => {
    it("captures successful probabilities and wire IDs in the results schema", async () => {
        const out = tempRoot("confirm-success-"); const ledger = join(out, "ledger"); seedCampaignLedger(ledger, { attempts: 0, actualCostUsd: 0, note: "test" });
        const transport: FetchFn = vi.fn(async () => response());
        await executeConfirmPlan(oneRequest("q1"), out, transport, ledger);
        const results = JSON.parse(readFileSync(join(out, "results.json"), "utf8")) as { completed: Array<{ probability: number; wireIds: string[] }>; blocked: unknown[] };
        expect(results.completed[0]?.probability).toBe(0.8);
        expect(results.completed[0]?.wireIds).toHaveLength(1);
        expect(results.blocked).toEqual([]);
        const fullResult = JSON.parse(readFileSync(join(out, "results.json"), "utf8")) as { manifestSha256: string; planSha256: string; integrity: Record<string, unknown> };
        expect(fullResult.manifestSha256).toBe("a".repeat(64));
        expect(fullResult.planSha256).toMatch(/^[a-f0-9]{64}$/);
        expect(fullResult.integrity).toHaveProperty("captureGaps");
        expect(transport).toHaveBeenCalledTimes(1);
        expect(statSync(join(out, "dispatch-intents.jsonl")).mode & 0o777).toBe(0o600);
    });

    it("rejects changed wire probabilities and records outside the exact planned dispatch", async () => {
        const out = tempRoot("confirm-binding-"); const ledger = join(out, "ledger"); seedCampaignLedger(ledger, { attempts: 0, actualCostUsd: 0, note: "test" });
        const built = oneRequest("q1");
        await executeConfirmPlan(built, out, vi.fn(async () => response()), ledger);
        const file = join(out, "wire-records.jsonl");
        const row = JSON.parse(readFileSync(file, "utf8").trim());
        const changed = { ...row, answers: [{ ...row.answers[0], probability: 0.1 }] };
        writeFileSync(file, `${JSON.stringify(changed)}\n`, { mode: 0o600 });
        await expect(executeConfirmPlan(built, out, vi.fn(async () => response()), ledger)).rejects.toThrow(/receipt|digest/i);
        writeFileSync(file, `${JSON.stringify({ ...row, phase: "pilot" })}\n`, { mode: 0o600 });
        await expect(executeConfirmPlan(built, out, vi.fn(async () => response()), ledger)).rejects.toThrow(/receipt|dispatch|phase/i);
    });

    it("rejects missing receipts and duplicate wire or attempt identities before scoring", async () => {
        const makeRun = async (qid: string) => {
            const out = tempRoot(`confirm-receipt-${qid}-`); const ledger = join(out, "ledger"); seedCampaignLedger(ledger, { attempts: 0, actualCostUsd: 0, note: "test" });
            const built = oneRequest(qid); await executeConfirmPlan(built, out, vi.fn(async () => response()), ledger);
            return { out, ledger, built };
        };
        const missing = await makeRun("missing");
        const journalPath = join(missing.out, "dispatch-intents.jsonl");
        const entries = readFileSync(journalPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
        writeFileSync(journalPath, `${JSON.stringify(entries.find((entry) => entry.kind === "intent"))}\n`, { mode: 0o600 });
        await expect(executeConfirmPlan(missing.built, missing.out, vi.fn(async () => response()), missing.ledger)).rejects.toThrow(/receipt/i);

        const duplicateWire = await makeRun("dup-wire");
        const recordPath = join(duplicateWire.out, "wire-records.jsonl"); const wire = readFileSync(recordPath, "utf8").trim();
        writeFileSync(recordPath, `${wire}\n${wire}\n`, { mode: 0o600 });
        await expect(executeConfirmPlan(duplicateWire.built, duplicateWire.out, vi.fn(async () => response()), duplicateWire.ledger)).rejects.toThrow(/duplicate/i);

        const duplicateAttempt = await makeRun("dup-attempt");
        const attemptPath = join(duplicateAttempt.out, "wire-records.jsonl"), attemptJournal = join(duplicateAttempt.out, "dispatch-intents.jsonl");
        const original = JSON.parse(readFileSync(attemptPath, "utf8").trim()) as Record<string, unknown>;
        const second = { ...original, wireId: "f".repeat(64) };
        writeFileSync(attemptPath, `${JSON.stringify(original)}\n${JSON.stringify(second)}\n`, { mode: 0o600 });
        const journalRows = readFileSync(attemptJournal, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
        journalRows.push({ kind: "receipt", planSha256: journalRows.find((row) => row.kind === "intent")!.planSha256, wireId: second.wireId, recordSha256: createHash("sha256").update(JSON.stringify(second)).digest("hex") });
        writeFileSync(attemptJournal, `${journalRows.map((row) => JSON.stringify(row)).join("\n")}\n`, { mode: 0o600 });
        await expect(executeConfirmPlan(duplicateAttempt.built, duplicateAttempt.out, vi.fn(async () => response()), duplicateAttempt.ledger)).rejects.toThrow(/attempt identity/i);
    });

    it("rejects a recovery journal bound to another plan before transport", async () => {
        const out = tempRoot("confirm-journal-plan-"); const ledger = join(out, "ledger"); seedCampaignLedger(ledger, { attempts: 0, actualCostUsd: 0, note: "test" });
        const built = oneRequest("q-plan-mismatch"); await executeConfirmPlan(built, out, vi.fn(async () => response()), ledger);
        const journal = join(out, "dispatch-intents.jsonl");
        const rows = readFileSync(journal, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
        const intent = rows.find((row) => row.kind === "intent")!; intent.planSha256 = "0".repeat(64);
        writeFileSync(journal, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, { mode: 0o600 });
        const transport: FetchFn = vi.fn(async () => response());
        await expect(executeConfirmPlan(built, out, transport, ledger)).rejects.toThrow(/plan.*journal/i);
        expect(transport).not.toHaveBeenCalled();
    });

    it("rejects record phase, payload, request size, candidate order, and answer coverage drift", async () => {
        const mutations: Array<[string, (record: Record<string, unknown>) => Record<string, unknown>]> = [
            ["phase", (record) => ({ ...record, phase: "pilot" })],
            ["payload", (record) => ({ ...record, payloadSha256: "f".repeat(64) })],
            ["requestBytes", (record) => ({ ...record, requestBytes: (record.requestBytes as number) + 1 })],
            ["candidate order", (record) => ({ ...record, candidateIds: ["unplanned-candidate"], answers: [{ candidateId: "unplanned-candidate", probability: 0.8 }] })],
            ["answer coverage", (record) => ({ ...record, answers: [{ candidateId: "unplanned-candidate", probability: 0.8 }] })],
        ];
        for (const [label, mutate] of mutations) {
            const out = tempRoot(`confirm-binding-${label}-`); const ledger = join(out, "ledger"); seedCampaignLedger(ledger, { attempts: 0, actualCostUsd: 0, note: "test" });
            const built = oneRequest("q1"); await executeConfirmPlan(built, out, vi.fn(async () => response()), ledger);
            rewriteRecordAndReceipt(out, mutate);
            const transport: FetchFn = vi.fn(async () => response());
            await expect(executeConfirmPlan(built, out, transport, ledger), label).rejects.toThrow();
            expect(transport, label).not.toHaveBeenCalled();
        }
    });

    it("accepts a builder-produced M2 reverse warmup receipt as its exact planned dispatch", async () => {
        const out = tempRoot("confirm-m2-warmup-"); const ledger = join(out, "ledger"); seedCampaignLedger(ledger, { attempts: 0, actualCostUsd: 0, note: "test" });
        const arm = "perplexity/pplx-decider-v1.1-27b" as const;
        const candidate = { candidateId: "c-warmup", state: { path: "src/file.ts", text: "source" } };
        const request = buildM2Reverse(arm, "warmup question", [candidate])[0]!;
        const plan: ConfirmPlanRequest = { arm, method: "M2", replica: 0, queryGroup: null, warmup: true, candidateIds: [...request.candidateIds], payloadSha256: request.payloadSha256, requestBytes: request.requestBytes };
        const base = oneRequest("q-warmup"); const built: BuiltConfirmPlan = { artifact: { ...base.artifact, requests: [plan] }, dispatch: [{ plan, request }] };
        const transport: FetchFn = vi.fn(async () => response(arm, { model: COMPARISON_SERVED_MODEL_ALLOWLIST[arm], provider: "mock", answers: { "c-warmup": 0.7 }, usage: { cost: 0, input_tokens: 10 } }));
        await executeConfirmPlan(built, out, transport, ledger);
        expect(transport).toHaveBeenCalledTimes(1);
        expect(JSON.parse(readFileSync(join(out, "wire-records.jsonl"), "utf8").trim()).method).toBe("M2");
    });

    it("rejects reordered planned candidate IDs and answers on a genuine two-candidate receipt", async () => {
        const out = tempRoot("confirm-candidate-order-"); const ledger = join(out, "ledger"); seedCampaignLedger(ledger, { attempts: 0, actualCostUsd: 0, note: "test" });
        const built = twoCandidateRequest("q-order");
        const transport: FetchFn = vi.fn(async () => response("~typesafe/jev-latest", { model: COMPARISON_SERVED_MODEL_ALLOWLIST["~typesafe/jev-latest"], provider: "mock", answers: { "c-q-order-a": 0.2, "c-q-order-b": 0.8 }, usage: { cost: 0, input_tokens: 10 } }));
        await executeConfirmPlan(built, out, transport, ledger);
        rewriteRecordAndReceipt(out, (record) => ({ ...record, candidateIds: [...(record.candidateIds as string[])].reverse(), answers: [...(record.answers as Array<{ candidateId: string; probability: number }> )].reverse() }));
        const retry: FetchFn = vi.fn(async () => response());
        await expect(executeConfirmPlan(built, out, retry, ledger)).rejects.toThrow(/planned confirmation dispatch/i);
        expect(retry).not.toHaveBeenCalled();
    });

    it("blocks schema-valid unallowlisted, unstamped, or mixed-era successes", async () => {
        const out = tempRoot("confirm-era-"); const ledger = join(out, "ledger"); seedCampaignLedger(ledger, { attempts: 0, actualCostUsd: 0, note: "test" });
        const built = oneRequest("q-era");
        await executeConfirmPlan(built, out, vi.fn(async () => response("~typesafe/jev-latest", { model: COMPARISON_SERVED_MODEL_ALLOWLIST["~typesafe/jev-latest"], provider: "mock", answers: { "c-q-era": 0.8 }, usage: { cost: 0, input_tokens: 10 } })), ledger);
        const file = join(out, "wire-records.jsonl");
        const record = JSON.parse(readFileSync(file, "utf8").trim());
        rewriteRecordAndReceipt(out, () => ({ ...record, servedModel: "drifted-model" }));
        unlinkSync(join(out, "results.json"));
        await executeConfirmPlan(built, out, vi.fn(async () => response()), ledger);
        expect(JSON.parse(readFileSync(join(out, "results.json"), "utf8")).completed).toEqual([]);
        rewriteRecordAndReceipt(out, () => ({ ...record, rulesetVersion: undefined }));
        await expect(executeConfirmPlan(built, out, vi.fn(async () => response()), ledger)).rejects.toThrow(/A3|era/i);
    });

    it("uses executor backoff in the production-default runner path", async () => {
        const out = tempRoot("confirm-default-delay-"); const ledger = join(out, "ledger"); seedCampaignLedger(ledger, { attempts: 0, actualCostUsd: 0, note: "test" });
        let calls = 0;
        const transport: FetchFn = vi.fn(async () => { calls += 1; if (calls === 1) return new Response("{}", { status: 503 }); return response(); });
        vi.useFakeTimers();
        try {
            const execution = executeConfirmPlan(oneRequest("q1"), out, transport, ledger);
            await vi.advanceTimersByTimeAsync(10_000);
            await execution;
        } finally { vi.useRealTimers(); }
        expect(transport).toHaveBeenCalledTimes(2);
    });

    it("uses the executor retry-delay policy unless a test sleep is injected", async () => {
        const out = tempRoot("confirm-delay-"); const ledger = join(out, "ledger"); seedCampaignLedger(ledger, { attempts: 0, actualCostUsd: 0, note: "test" });
        let calls = 0; const delays: number[] = [];
        const transport: FetchFn = vi.fn(async () => { calls += 1; if (calls === 1) return new Response("{}", { status: 503 }); return response(); });
        await executeConfirmPlan(oneRequest("q1"), out, transport, ledger, undefined, async (ms) => { delays.push(ms); });
        expect(delays).toEqual([expect.any(Number)]);
        expect(delays[0]).toBeGreaterThan(0);
        expect(transport).toHaveBeenCalledTimes(2);
    });

    it("honors Retry-After-ms delays and stops after exactly three attempts", async () => {
        const out = tempRoot("confirm-three-attempts-"); const ledger = join(out, "ledger"); seedCampaignLedger(ledger, { attempts: 0, actualCostUsd: 0, note: "test" });
        const delays: number[] = [];
        const transport: FetchFn = vi.fn(async () => new Response("{}", { status: 503, headers: { "retry-after-ms": "17" } }));
        await executeConfirmPlan(oneRequest("q-three"), out, transport, ledger, undefined, async (ms) => { delays.push(ms); });
        expect(transport).toHaveBeenCalledTimes(3);
        expect(delays).toEqual([17, 17]);
    });

    it("keeps the failed attempt and the successful retry separate", async () => {
        const out = tempRoot("confirm-retry-"); const ledger = join(out, "ledger"); seedCampaignLedger(ledger, { attempts: 0, actualCostUsd: 0, note: "test" });
        let calls = 0;
        const transport: FetchFn = vi.fn(async () => { calls += 1; if (calls === 1) throw new Error("transient"); return response(); });
        await executeConfirmPlan(oneRequest("q1"), out, transport, ledger);
        const lines = readFileSync(join(out, "wire-records.jsonl"), "utf8").trim().split("\n");
        expect(lines).toHaveLength(2);
        expect(JSON.parse(lines[0]!).errorClass).toBe("network");
        expect(JSON.parse(lines[1]!).errorClass).toBeNull();
    });

    it("halts and remains halted after a durable 2xx capture gap", async () => {
        const out = tempRoot("confirm-gap-halt-"); const ledger = join(out, "ledger"); seedCampaignLedger(ledger, { attempts: 0, actualCostUsd: 0, note: "test" });
        const first = oneRequest("gap");
        const second = oneRequest("later");
        const built = { ...first, artifact: { ...first.artifact, requests: [first.dispatch[0]!.plan, second.dispatch[0]!.plan] }, dispatch: [...first.dispatch, ...second.dispatch] };
        const transport: FetchFn = vi.fn(async () => response("~typesafe/jev-latest", { answers: { "c-gap": 0.8 } }));
        await executeConfirmPlan(built, out, transport, ledger);
        expect(transport).toHaveBeenCalledTimes(1);
        await executeConfirmPlan(built, out, transport, ledger);
        expect(transport).toHaveBeenCalledTimes(1);
        const result = JSON.parse(readFileSync(join(out, "results.json"), "utf8"));
        expect(result.integrity.aborted).toBe(true);
        expect(result.integrity.captureGaps).toHaveLength(1);
    });

    it("records 2xx capture gaps as blocked without losing their wire record", async () => {
        const out = tempRoot("confirm-gap-"); const ledger = join(out, "ledger"); seedCampaignLedger(ledger, { attempts: 0, actualCostUsd: 0, note: "test" });
        const transport: FetchFn = vi.fn(async () => response("~typesafe/jev-latest", { answers: { "c-q1": 0.8 } }));
        await executeConfirmPlan(oneRequest("q1"), out, transport, ledger);
        const record = JSON.parse(readFileSync(join(out, "wire-records.jsonl"), "utf8").trim());
        expect(record.errorClass).toBe("capture_gap");
        const results = JSON.parse(readFileSync(join(out, "results.json"), "utf8")) as { blocked: Array<{ probability: null; wireIds: string[] }> };
        expect(results.blocked[0]?.probability).toBeNull();
        expect(results.blocked[0]?.wireIds).toHaveLength(1);
    });

    it("stops at the campaign cap before an over-cap fetch", async () => {
        const out = tempRoot("confirm-cap-"); const ledger = join(out, "ledger"); seedCampaignLedger(ledger, { attempts: 0, actualCostUsd: 0, note: "test" });
        const base = oneRequest("q1", "openai/gpt-6-luna-decisions");
        const dispatch = Array.from({ length: 100 }, (_, i) => {
            const body = buildM0Request("openai/gpt-6-luna-decisions", `cap ${i}`, [{ candidateId: `c${i}`, state: { path: "a.ts", text: `x${i}` } }])[0]!;
            const plan = { ...base.dispatch[0]!.plan, queryGroup: `q${i}`, candidateIds: body.candidateIds, payloadSha256: body.payloadSha256, requestBytes: body.requestBytes };
            return { plan, request: body };
        });
        const built = { artifact: { ...base.artifact, requests: dispatch.map((item) => item.plan) }, dispatch } as BuiltConfirmPlan;
        const mockTransport = vi.fn(async () => { throw new Error("unknown transport outcome"); });
        const transport: FetchFn = mockTransport;
        await executeConfirmPlan(built, out, transport, ledger, undefined, async () => undefined);
        expect(mockTransport.mock.calls.length).toBeLessThan(100 * 3);
    });

    it("rejects a dangling wire-record symlink before admission or transport", async () => {
        const out = tempRoot("confirm-dangling-records-"); const ledger = join(out, "ledger"); seedCampaignLedger(ledger, { attempts: 0, actualCostUsd: 0, note: "test" });
        const beforeLedger = readFileSync(join(ledger, "campaign-ledger.json"), "utf8");
        symlinkSync("missing-wire-target", join(out, "wire-records.jsonl"));
        const transport: FetchFn = vi.fn(async () => response());
        await expect(executeConfirmPlan(oneRequest("q-dangling"), out, transport, ledger)).rejects.toThrow();
        expect(transport).not.toHaveBeenCalled();
        expect(readFileSync(join(ledger, "campaign-ledger.json"), "utf8")).toBe(beforeLedger);
    });

    it("fsyncs intent data and both new directory entries before dispatch", async () => {
        const parent = tempRoot("confirm-durable-parent-"); const out = join(parent, "new-out"); const ledger = join(parent, "ledger"); seedCampaignLedger(ledger, { attempts: 0, actualCostUsd: 0, note: "test" });
        fsyncProbe.events.length = 0; fsyncProbe.fdPaths.clear(); fsyncProbe.failDirectorySync = false;
        const transport: FetchFn = vi.fn(async () => { fsyncProbe.events.push("transport"); return response(); });
        await executeConfirmPlan(oneRequest("q-durable"), out, transport, ledger);
        const transportIndex = fsyncProbe.events.indexOf("transport");
        const intentDataSync = fsyncProbe.events.indexOf(`file:${join(out, "dispatch-intents.jsonl")}`);
        const journalDirectorySync = fsyncProbe.events.indexOf(`directory:${out}`);
        const outputParentSync = fsyncProbe.events.indexOf(`directory:${parent}`);
        expect(intentDataSync).toBeGreaterThanOrEqual(0);
        expect(journalDirectorySync).toBeGreaterThanOrEqual(0);
        expect(outputParentSync).toBeGreaterThanOrEqual(0);
        expect(intentDataSync).toBeLessThan(transportIndex);
        expect(journalDirectorySync).toBeLessThan(transportIndex);
        expect(outputParentSync).toBeLessThan(transportIndex);
    });

    it("does not dispatch if output-directory durability synchronization fails", async () => {
        const parent = tempRoot("confirm-dir-fsync-fail-"); const out = join(parent, "new-out"); const ledger = join(parent, "ledger"); seedCampaignLedger(ledger, { attempts: 0, actualCostUsd: 0, note: "test" });
        fsyncProbe.events.length = 0; fsyncProbe.fdPaths.clear(); fsyncProbe.failDirectorySync = true;
        const transport: FetchFn = vi.fn(async () => response());
        try { await expect(executeConfirmPlan(oneRequest("q-dir-fail"), out, transport, ledger)).rejects.toThrow(/directory fsync/i); }
        finally { fsyncProbe.failDirectorySync = false; }
        expect(transport).not.toHaveBeenCalled();
    });

    it("refuses unsafe dispatch journals before transport", async () => {
        const out = tempRoot("confirm-journal-"); const ledger = join(out, "ledger"); seedCampaignLedger(ledger, { attempts: 0, actualCostUsd: 0, note: "test" });
        const target = join(out, "target.jsonl"); writeFileSync(target, "", { mode: 0o600 });
        symlinkSync(target, join(out, "dispatch-intents.jsonl"));
        const transport: FetchFn = vi.fn(async () => response());
        await expect(executeConfirmPlan(oneRequest("q-symlink"), out, transport, ledger)).rejects.toThrow();
        expect(transport).not.toHaveBeenCalled();
        expect(readFileSync(target, "utf8")).toBe("");
        rmSync(join(out, "dispatch-intents.jsonl"));
        symlinkSync("missing-journal-target", join(out, "dispatch-intents.jsonl"));
        await expect(executeConfirmPlan(oneRequest("q-dangling-journal"), out, transport, ledger)).rejects.toThrow();
        expect(transport).not.toHaveBeenCalled();
        rmSync(join(out, "dispatch-intents.jsonl"));
        writeFileSync(join(out, "dispatch-intents.jsonl"), "", { mode: 0o600 }); chmodSync(join(out, "dispatch-intents.jsonl"), 0o644);
        await expect(executeConfirmPlan(oneRequest("q-insecure"), out, transport, ledger)).rejects.toThrow();
        expect(transport).not.toHaveBeenCalled();
    });

    it("fails closed on a crash between durable wire-record and receipt persistence", async () => {
        const out = tempRoot("confirm-receipt-crash-"); const ledger = join(out, "ledger"); seedCampaignLedger(ledger, { attempts: 0, actualCostUsd: 0, note: "test" });
        fsyncProbe.journalSyncCount = 0; fsyncProbe.failJournalSyncAt = 2;
        const transport: FetchFn = vi.fn(async () => response());
        try { await expect(executeConfirmPlan(oneRequest("q-receipt-crash"), out, transport, ledger)).rejects.toThrow(/fsync/i); }
        finally { fsyncProbe.failJournalSyncAt = 0; }
        expect(transport).toHaveBeenCalledTimes(1);
        await expect(executeConfirmPlan(oneRequest("q-receipt-crash"), out, vi.fn(async () => response()), ledger)).rejects.toThrow(/receipt|duplicate|ambiguous/i);
    });

    it("fails closed when an intent has no durable verified receipt", async () => {
        const out = tempRoot("confirm-intent-"); const ledger = join(out, "ledger"); seedCampaignLedger(ledger, { attempts: 0, actualCostUsd: 0, note: "test" });
        const built = oneRequest("q1"); const transport: FetchFn = vi.fn(async () => response());
        await expect(executeConfirmPlan(built, out, transport, ledger, () => { throw new Error("crash after durable receipt"); })).rejects.toThrow("crash after durable receipt");
        const journal = join(out, "dispatch-intents.jsonl");
        const intent = readFileSync(journal, "utf8").split("\n").find((line) => line.includes('"kind":"intent"'))!;
        writeFileSync(join(out, "wire-records.jsonl"), "", { mode: 0o600 });
        writeFileSync(journal, `${intent}\n`, { mode: 0o600 });
        await expect(executeConfirmPlan(built, out, vi.fn(async () => response()), ledger)).rejects.toThrow(/recovery.*ambiguous/i);
        expect(transport).toHaveBeenCalledTimes(1);
    });

    it("rejects a second worker while the same output directory is executing", async () => {
        const out = tempRoot("confirm-lock-"); const ledger = join(out, "ledger"); seedCampaignLedger(ledger, { attempts: 0, actualCostUsd: 0, note: "test" });
        const built = oneRequest("q-lock"); let release!: () => void;
        const transport: FetchFn = vi.fn(async () => { await new Promise<void>((resolve) => { release = resolve; }); return response(); });
        const first = executeConfirmPlan(built, out, transport, ledger);
        await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
        await expect(executeConfirmPlan(built, out, vi.fn(async () => response()), ledger)).rejects.toThrow();
        release(); await first;
        expect(transport).toHaveBeenCalledTimes(1);
    });

    it("resumes from the durable records without re-dispatching a settled success", async () => {
        const out = tempRoot("confirm-resume-"); const ledger = join(out, "ledger"); seedCampaignLedger(ledger, { attempts: 0, actualCostUsd: 0, note: "test" });
        const built = oneRequest("q1"); const interrupted: FetchFn = vi.fn(async () => response());
        await expect(executeConfirmPlan(built, out, interrupted, ledger, () => { throw new Error("simulated crash after durable receipt"); })).rejects.toThrow("simulated crash");
        await expect(executeConfirmPlan(built, out, interrupted, ledger, () => { throw new Error("must not run"); })).resolves.toBeUndefined();
        expect(interrupted).toHaveBeenCalledTimes(1);
        const saved = readFileSync(join(out, "wire-records.jsonl"), "utf8").trim().split("\n");
        expect(saved).toHaveLength(1);
        expect(createHash("sha256").update(saved[0]!).digest("hex")).toMatch(/^[a-f0-9]{64}$/);
    });
});
