#!/usr/bin/env node
/**
 * Confirmation runner for the sealed 400-query corpus. Results JSON schema:
 * { version: 1, kind: "method-confirm-results", manifestSha256, planSha256,
 *   completed: [{arm,method,queryGroup,candidateId,replica,probability,wireIds}],
 *   blocked: [{arm,method,queryGroup,replica,reason}], integrity:
 *   {aborted,captureGaps,finalAttemptUnverified,servedIdentityDrift,payloadDrift,retryAnswerDrift} }.
 * Probabilities are null only for blocked cells; all attempts remain in the
 * append-only wire ledger, including transport retries and UNKNOWN costs.
 * Recovery journal: private dispatch-intents.jsonl is fsynced before each
 * executor handoff. An intent without a complete verified A3 receipt is
 * ambiguous (admission may already be SETTLED or UNKNOWN) and permanently
 * blocks automatic resend; no reserve is cleared or probability inferred.
 * A private exclusive execution lock prevents concurrent same-output runs.
 * Receipt digests detect local artifact inconsistency; they do not prove
 * service authenticity, and coordinated edits to both files can recompute them.
 */
import { createHash, randomBytes } from "node:crypto";
import { constants, closeSync, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FetchFn } from "../../../src/judge/systemone-client.js";
import type { JsonValue } from "../../../src/judge/types.js";
import {
    attemptRecordsOf, buildM0Request, buildM1Request, buildM2Reverse,
    executeWireRequest, type MethodRequestCandidate, type MethodWireRequest,
} from "./method-comparison-executor.js";
import { isMethodWireRecord, type MethodId, type MethodWireRecord } from "./method-comparison-contract.js";
import type { MethodSleepFn } from "./method-comparison-executor.js";
import { loadVerifiedConfirmCorpus, isVerifiedConfirmCorpusRoster, type ConfirmCorpusRoster } from "./method-confirm-fixture.js";
import { defaultCampaignRoot, seedCampaignLedger } from "./model-comparison-budget.js";
import { COMPARISON_MODELS, JUDGE_KEY_ENV } from "./model-comparison.js";
import { COMPARISON_SERVED_MODEL_ALLOWLIST, type ComparisonModelId } from "./model-comparison-types.js";

export const METHOD_CONFIRM_REPLICAS = 3;
export const METHOD_CONFIRM_MODELS = Object.freeze([
    { arm: "~typesafe/jev-latest", challenger: "M1" },
    { arm: "perplexity/pplx-decider-v1.1-27b", challenger: "M2" },
    { arm: "openai/gpt-6-luna-decisions", challenger: "M1" },
] as const satisfies readonly { arm: ComparisonModelId; challenger: "M1" | "M2" }[]);
export const METHOD_CONFIRM_EXIT_OK = 0;
export const METHOD_CONFIRM_EXIT_ERROR = 2;
export const METHOD_CONFIRM_EXIT_GATE = 3;
export const METHOD_CONFIRM_DEFERRED_SUITE = "The 44-query three-model M0 suite is deferred; prereg §6 line 319 requires its own payload-specific projection before authorization.";
const ORDERING_RULE = "pilot plan builder order: warmups, M0 forward per replica/query, then the selected challenger leg";
const PHASE = "confirmation" as const;
const RESERVE_UNKNOWN_CONTINGENCY_PER_MODEL = 2;

export interface ConfirmPlanRequest {
    arm: ComparisonModelId;
    method: MethodId;
    replica: number;
    queryGroup: string | null;
    warmup: boolean;
    candidateIds: string[];
    payloadSha256: string;
    requestBytes: number;
}
export interface ConfirmPlan {
    version: 1;
    kind: "method-confirm-plan";
    manifestSha256: string;
    queryCount: number;
    candidateCount: number;
    replicaCount: number;
    orderingRule: string;
    requests: ConfirmPlanRequest[];
    inventory: Record<string, Record<string, number>>;
    replicaLadder: { fiveReplicaStressUsd: number; fourReplicaStressUsd: number; threeReplicaStressUsd: number; headroomUsd: number; selected: 3 };
    deferredSuite: string;
    projection: { pilotBilledUsdPerQueryReplica: number; components: Array<{ arm: string; method: string; billedInputTokensPerRequest: number; pilotUsdPerQueryReplica: number }>; scoredUsd: number; warmupUsd: number; deferredSuiteUsd: number; nominalUsd: number; stressUsd: number; capUsd: 10 };
}
interface PlannedDispatch { plan: ConfirmPlanRequest; request: MethodWireRequest; }
export interface BuiltConfirmPlan { artifact: ConfirmPlan; dispatch: PlannedDispatch[]; }

function sha256(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function serializePlan(plan: ConfirmPlan): string { return `${JSON.stringify(plan, null, 2)}\n`; }
function exactlyOne(requests: MethodWireRequest[], label: string): MethodWireRequest {
    if (requests.length !== 1 || requests[0] === undefined) throw new Error(`${label} produced ${requests.length} requests; confirmation arithmetic requires one packed request`);
    return requests[0];
}
function assertVerified(roster: ConfirmCorpusRoster): void {
    if (!isVerifiedConfirmCorpusRoster(roster)) throw new Error("confirmation roster is not load-verified; refusing to plan");
    if (roster.queries.length !== 400 || roster.candidates.length === 0) throw new Error(`verified confirmation roster has invalid composition (${roster.queries.length} queries, ${roster.candidates.length} candidates)`);
}

interface ConfirmPlanInputs { roster: ConfirmCorpusRoster; queryTexts: ReadonlyMap<string, string>; candidateStates: ReadonlyMap<string, Record<string, JsonValue>>; }
export function buildMethodConfirmPlanFromInputs(inputs: ConfirmPlanInputs): BuiltConfirmPlan {
    const { roster, queryTexts, candidateStates } = inputs;
    assertVerified(roster);
    const grouped = new Map<string, MethodRequestCandidate[]>();
    for (const candidate of roster.candidates) {
        const state = candidateStates.get(candidate.cid);
        if (state === undefined) throw new Error(`missing sealed state for candidate ${candidate.cid}`);
        const list = grouped.get(candidate.qid) ?? [];
        list.push({ candidateId: candidate.cid, state }); grouped.set(candidate.qid, list);
    }
    const queries = [...roster.queries].sort((a, b) => a.qid.localeCompare(b.qid));
    const dispatch: PlannedDispatch[] = [];
    const inventory: ConfirmPlan["inventory"] = {};
    for (const config of METHOD_CONFIRM_MODELS) {
        const arm = config.arm;
        const counts = { M0: 0, M1: 0, M2: 0, warmups: 0 };
        const warmups: PlannedDispatch[] = [];
        const forward: PlannedDispatch[] = [];
        const challengerLeg: PlannedDispatch[] = [];
        for (let replica = 0; replica < METHOD_CONFIRM_REPLICAS; replica += 1) {
            const q = queries[0]!; const text = queryTexts.get(q.qid); const first = grouped.get(q.qid)?.[0];
            if (text === undefined || first === undefined) throw new Error(`missing warmup inputs for ${q.qid}`);
            const request = exactlyOne(buildM0Request(arm, text, [first]), `M0 warmup ${arm}`);
            warmups.push(makeEntry(arm, "M0", replica, null, true, request)); counts.warmups += 1;
            if (config.challenger === "M2") {
                const reverse = exactlyOne(buildM2Reverse(arm, text, [first]), `M2 warmup ${arm}`);
                warmups.push(makeEntry(arm, "M2", replica, null, true, reverse)); counts.warmups += 1;
            }
        }
        for (let replica = 0; replica < METHOD_CONFIRM_REPLICAS; replica += 1) for (const query of queries) {
            const text = queryTexts.get(query.qid); const candidates = grouped.get(query.qid);
            if (text === undefined || candidates === undefined || candidates.length === 0) throw new Error(`missing sealed inputs for ${query.qid}`);
            forward.push(makeEntry(arm, "M0", replica, query.qid, false, exactlyOne(buildM0Request(arm, text, candidates), `M0 ${arm}/${query.qid}`))); counts.M0 += 1;
            if (config.challenger === "M1") {
                for (const candidate of candidates) { challengerLeg.push(makeEntry(arm, "M1", replica, query.qid, false, buildM1Request(arm, text, candidate))); counts.M1 += 1; }
            } else {
                challengerLeg.push(makeEntry(arm, "M2", replica, query.qid, false, exactlyOne(buildM2Reverse(arm, text, candidates), `M2 ${arm}/${query.qid}`))); counts.M2 += 1;
            }
        }
        dispatch.push(...warmups, ...forward, ...challengerLeg);
        inventory[arm] = counts;
    }
    const components = [
        { arm: "~typesafe/jev-latest", method: "M0", billedInputTokensPerRequest: 4484, pilotUsdPerQueryReplica: 0.00018832 },
        { arm: "~typesafe/jev-latest", method: "M1", billedInputTokensPerRequest: 900, pilotUsdPerQueryReplica: 0.00026470 },
        { arm: "perplexity/pplx-decider-v1.1-27b", method: "M0", billedInputTokensPerRequest: 22976, pilotUsdPerQueryReplica: 0.00045952 },
        { arm: "perplexity/pplx-decider-v1.1-27b", method: "M2 marginal reverse", billedInputTokensPerRequest: 22976, pilotUsdPerQueryReplica: 0.00045952 },
        { arm: "openai/gpt-6-luna-decisions", method: "M0", billedInputTokensPerRequest: 4578, pilotUsdPerQueryReplica: 0.00045777 },
        { arm: "openai/gpt-6-luna-decisions", method: "M1", billedInputTokensPerRequest: 690, pilotUsdPerQueryReplica: 0.00048271 },
    ];
    const billedPerReplica = 0.0023125;
    const warmupUsd = 0.00166;
    const deferredUsd = 0.14;
    const stress = (replicas: number): number => (400 * replicas * billedPerReplica + warmupUsd + deferredUsd) * 3
        + RESERVE_UNKNOWN_CONTINGENCY_PER_MODEL * (0.001344 + 0.01048576 + 0.105) + 0.105;
    const scoredUsd = 400 * METHOD_CONFIRM_REPLICAS * billedPerReplica;
    const nominalUsd = scoredUsd + warmupUsd + deferredUsd;
    const artifact: ConfirmPlan = {
        version: 1, kind: "method-confirm-plan", manifestSha256: roster.manifestSha256,
        queryCount: roster.queries.length, candidateCount: roster.candidates.length, replicaCount: METHOD_CONFIRM_REPLICAS,
        orderingRule: ORDERING_RULE, requests: dispatch.map(({ plan }) => plan), inventory,
        replicaLadder: { fiveReplicaStressUsd: stress(5), fourReplicaStressUsd: stress(4), threeReplicaStressUsd: stress(3), headroomUsd: 9.6387, selected: 3 },
        deferredSuite: METHOD_CONFIRM_DEFERRED_SUITE,
        projection: { pilotBilledUsdPerQueryReplica: billedPerReplica, components, scoredUsd, warmupUsd, deferredSuiteUsd: deferredUsd, nominalUsd, stressUsd: stress(METHOD_CONFIRM_REPLICAS), capUsd: 10 },
    };
    return { artifact, dispatch };
}
function makeEntry(arm: ComparisonModelId, method: MethodId, replica: number, queryGroup: string | null, warmup: boolean, request: MethodWireRequest): PlannedDispatch {
    const plan: ConfirmPlanRequest = { arm, method, replica, queryGroup, warmup, candidateIds: [...request.candidateIds], payloadSha256: request.payloadSha256, requestBytes: request.requestBytes };
    return { plan, request };
}

function defaultCorpusRoot(): string { return join(homedir(), ".cache", "pi-smartread-judge-confirm-20261009", "sealed"); }
function parseArgs(argv: readonly string[]): { mode: "dry-run" | "run"; out: string; corpus: string; authorized: boolean; help: boolean } {
    let mode: "dry-run" | "run" = "dry-run", out: string | undefined, corpus = defaultCorpusRoot(), authorized = false, help = false;
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === "--dry-run") mode = "dry-run";
        else if (arg === "--run") mode = "run";
        else if (arg === "--i-understand-this-spends-money") authorized = true;
        else if (arg === "--out" || arg === "--corpus") { const value = argv[++i]; if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`); if (arg === "--out") out = value; else corpus = value; }
        else if (arg === "--help" || arg === "-h") help = true;
        else throw new Error(`Unknown argument: ${arg}`);
    }
    if (!help && out === undefined) throw new Error("--out is required");
    return { mode, out: out ?? "", corpus, authorized, help };
}
function fsyncDirectory(path: string): void {
    const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
        if (!fstatSync(fd).isDirectory()) throw new Error(`refusing non-directory sync target: ${path}`);
        fsyncSync(fd);
    } finally { closeSync(fd); }
}
function ensureOutputDirectory(path: string): void {
    const missing: string[] = [];
    let current = resolve(path);
    while (true) {
        try { lstatSync(current); break; }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            missing.push(current);
            const parent = dirname(current);
            if (parent === current) throw error;
            current = parent;
        }
    }
    mkdirSync(path, { recursive: true });
    for (const created of missing.reverse()) fsyncDirectory(dirname(created));
}
function writeExclusive(path: string, bytes: string): void {
    mkdirSync(dirname(path), { recursive: true });
    const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
    const fd = openSync(temp, "wx", 0o600);
    try {
        writeSync(fd, bytes, null, "utf8");
        fsyncSync(fd);
        closeSync(fd);
        linkSync(temp, path);
    } catch (error) {
        try { closeSync(fd); } catch { /* already closed */ }
        throw error;
    } finally {
        try { unlinkSync(temp); } catch { /* this unique temporary file may already be linked and removed */ }
    }
}
function inputsFromVerifiedRoot(root: string): ConfirmPlanInputs {
    const roster = loadVerifiedConfirmCorpus(root);
    const manifestBytes = readFileSync(join(root, "confirm-manifest.json"), "utf8");
    const manifest = JSON.parse(manifestBytes) as { artifacts: Array<{ path: string; sha256: string; byteLength: number }> };
    if (sha256(manifestBytes) !== roster.manifestSha256) throw new Error("confirm manifest changed after corpus verification");
    const verifiedText = (path: string): string => {
        const bytes = readFileSync(join(root, path));
        const entry = manifest.artifacts.find((artifact) => artifact.path === path);
        if (!entry || sha256(bytes) !== entry.sha256 || bytes.byteLength !== entry.byteLength) throw new Error(`sealed digest mismatch after corpus verification: ${path}`);
        return bytes.toString("utf8");
    };
    const queriesRaw = verifiedText("confirm-queries.jsonl").trimEnd().split("\n").map((line) => JSON.parse(line) as { qid: string; query: string });
    const snapshots = verifiedText("confirm-source-snapshots.jsonl").trimEnd().split("\n").map((line) => JSON.parse(line) as { cid: string; excerpt: string });
    const candidateByCid = new Map(roster.candidates.map((candidate) => [candidate.cid, candidate]));
    const candidateStates = new Map<string, Record<string, JsonValue>>();
    for (const row of snapshots) {
        const candidate = candidateByCid.get(row.cid);
        if (!candidate) throw new Error(`sealed snapshot references unknown candidate ${row.cid}`);
        candidateStates.set(row.cid, { path: candidate.file, text: row.excerpt });
    }
    return { roster, queryTexts: new Map(queriesRaw.map((query) => [query.qid, query.query])), candidateStates };
}

function resultPaths(out: string): { records: string; results: string; plan: string; intents: string; lock: string } { return { records: join(out, "wire-records.jsonl"), results: join(out, "results.json"), plan: join(out, "plan.json"), intents: join(out, "dispatch-intents.jsonl"), lock: join(out, ".execution.lock") }; }
function appendDurable(path: string, line: string): void {
    const fd = openSync(path, "a", 0o600);
    try { writeSync(fd, line, null, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
}
function appendJournal(path: string, line: string): void {
    ensurePrivateJournal(path, true);
    const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
    try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) throw new Error(`refusing non-regular or non-private recovery journal: ${path}`);
        writeSync(fd, line, null, "utf8"); fsyncSync(fd);
    } finally { closeSync(fd); }
}
interface DispatchIntent { kind: "intent"; planSha256: string; key: string; payloadSha256: string; }
interface RecordReceipt { kind: "receipt"; planSha256: string; wireId: string; recordSha256: string; }
type RecoveryEntry = DispatchIntent | RecordReceipt;
function ensurePrivateJournal(path: string, create: boolean): boolean {
    let exists = true;
    try { lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") exists = false; else throw error; }
    if (!exists) {
        if (!create) return false;
        const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        closeSync(fd);
        fsyncDirectory(dirname(path));
    }
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const stat = fstatSync(fd); if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) throw new Error(`refusing non-regular or non-private recovery journal: ${path}`); }
    finally { closeSync(fd); }
    return true;
}
function readRecoveryJournal(path: string): RecoveryEntry[] {
    if (!ensurePrivateJournal(path, false)) return [];
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let contents: string;
    try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) throw new Error(`refusing non-regular or non-private recovery journal: ${path}`);
        contents = readFileSync(fd, "utf8");
    } finally { closeSync(fd); }
    return contents.split("\n").filter(Boolean).map((line, index) => {
        const value: unknown = JSON.parse(line);
        if (!value || typeof value !== "object") throw new Error(`invalid recovery journal entry at line ${index + 1}`);
        const row = value as Partial<RecoveryEntry>;
        if (row.kind === "intent" && typeof row.planSha256 === "string" && typeof row.key === "string" && typeof row.payloadSha256 === "string") return row as DispatchIntent;
        if (row.kind === "receipt" && typeof row.planSha256 === "string" && typeof row.wireId === "string" && typeof row.recordSha256 === "string") return row as RecordReceipt;
        throw new Error(`invalid recovery journal entry at line ${index + 1}`);
    });
}
function validateDurableRecords(plan: BuiltConfirmPlan, planSha: string, records: readonly MethodWireRecord[], entries: readonly RecoveryEntry[]): void {
    const planned = new Map(plan.dispatch.map((entry) => [dispatchKey(entry.plan), entry.plan]));
    const intents = new Set<string>();
    const receipts = new Map<string, string>();
    for (const entry of entries) {
        if (entry.kind === "intent") {
            if (intents.has(entry.key)) throw new Error(`duplicate dispatch intent: ${entry.key}`);
            intents.add(entry.key);
            continue;
        }
        if (entry.planSha256 !== planSha || receipts.has(entry.wireId)) throw new Error("duplicate or mismatched wire-record receipt");
        receipts.set(entry.wireId, entry.recordSha256);
    }
    const wireIds = new Set<string>(), attempts = new Set<string>();
    for (const record of records) {
        const key = wireKey(record), expected = planned.get(key);
        if (!expected || record.phase !== PHASE || record.payloadSha256 !== expected.payloadSha256 || record.requestBytes !== expected.requestBytes || JSON.stringify(record.candidateIds) !== JSON.stringify(expected.candidateIds)) throw new Error(`wire record is outside its exact planned confirmation dispatch: ${record.wireId}`);
        if (!intents.has(key)) throw new Error(`wire record has no matching durable dispatch intent: ${record.wireId}`);
        if (wireIds.has(record.wireId)) throw new Error(`duplicate wire record id: ${record.wireId}`);
        wireIds.add(record.wireId);
        const attemptKey = `${key}|${record.attemptIndex}`;
        if (attempts.has(attemptKey)) throw new Error(`duplicate wire attempt identity: ${attemptKey}`);
        attempts.add(attemptKey);
        if (JSON.stringify(record.answers.map((answer) => answer.candidateId)) !== JSON.stringify(expected.candidateIds)) throw new Error(`wire answer coverage/order differs from plan: ${record.wireId}`);
        if (receipts.get(record.wireId) !== sha256(JSON.stringify(record))) throw new Error(`wire record missing matching durable receipt digest: ${record.wireId}`);
    }
    if (receipts.size !== records.length) throw new Error("recovery journal has receipts without matching wire records");
}
function ensurePrivateRecordsFile(path: string): void {
    if (!existsSync(path)) {
        const fd = openSync(path, "ax", 0o600);
        closeSync(fd);
    }
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) {
        throw new Error(`refusing non-regular or non-private wire ledger: ${path}`);
    }
}
function readRecords(path: string): MethodWireRecord[] {
    try { lstatSync(path); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
    }
    ensurePrivateRecordsFile(path);
    return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line, index) => { const record: unknown = JSON.parse(line); if (!isMethodWireRecord(record)) throw new Error(`invalid wire record at line ${index + 1}`); return record; });
}
function dispatchKey(p: ConfirmPlanRequest): string { return [p.arm, p.method, p.replica, p.queryGroup ?? "warmup", p.warmup, p.payloadSha256].join("|"); }
function wireKey(r: MethodWireRecord): string { return [r.arm, r.method, r.replica, r.queryGroup ?? "warmup", r.warmup, r.payloadSha256].join("|"); }
function knownSuccess(r: MethodWireRecord): boolean { return r.rulesetVersion === "A3" && r.errorClass === null && r.httpStatus !== null && r.httpStatus >= 200 && r.httpStatus < 300 && r.servedModel === COMPARISON_SERVED_MODEL_ALLOWLIST[r.arm]; }
function writeResult(path: string, result: unknown): void {
    const bytes = `${JSON.stringify(result, null, 2)}\n`;
    try {
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) throw new Error(`refusing non-regular or non-private result artifact: ${path}`);
        if (readFileSync(path, "utf8") !== bytes) throw new Error(`existing result differs from current durable run state: ${path}`);
        return;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    writeExclusive(path, bytes);
}

export async function executeConfirmPlan(plan: BuiltConfirmPlan, out: string, transport: FetchFn, campaignRoot = defaultCampaignRoot(), afterRecordPersisted?: () => void, sleep?: MethodSleepFn): Promise<void> {
    ensureOutputDirectory(out);
    const paths = resultPaths(out);
    const lockFd = openSync(paths.lock, "wx", 0o600);
    try {
    let records = readRecords(paths.records);
    const planSha = sha256(serializePlan(plan.artifact));
    const journal = readRecoveryJournal(paths.intents);
    const intents = journal.filter((entry): entry is DispatchIntent => entry.kind === "intent");
    for (const intent of intents) if (intent.planSha256 !== planSha || !plan.dispatch.some((entry) => dispatchKey(entry.plan) === intent.key && entry.plan.payloadSha256 === intent.payloadSha256)) throw new Error("dispatch intent plan/journal mismatch; refusing execution");
    validateDurableRecords(plan, planSha, records, journal);
    seedCampaignLedger(campaignRoot);
    const done = new Set<string>();
    const interrupted = new Set<string>();
    for (const p of plan.dispatch) {
        const key = dispatchKey(p.plan); const matches = records.filter((record) => wireKey(record) === key);
        if (matches.some(knownSuccess)) done.add(key);
        else if (matches.length > 0) interrupted.add(key);
    }
    const eras = new Set(records.map((record) => record.rulesetVersion ?? "A1/A2"));
    if (eras.size > 1 || (records.length > 0 && !eras.has("A3"))) throw new Error("wire records are mixed-era or unstamped; refusing A3 confirmation resume");
    let aborted = records.some((record) => record.errorClass === "capture_gap");
    for (const entry of plan.dispatch) {
        const key = dispatchKey(entry.plan); if (aborted) break; if (done.has(key)) continue;
        const priorIntent = intents.find((intent) => intent.key === key);
        if (priorIntent) {
            const priorRecords = records.filter((record) => wireKey(record) === key);
            if (priorRecords.some((record) => record.errorClass === "capture_gap")) { aborted = true; break; }
            if (priorRecords.length > 0) { interrupted.add(key); continue; }
            throw new Error(`recovery is ambiguous for ${key}: dispatch intent has no complete verified wire record; refusing resend`);
        }
        if (interrupted.has(key)) continue;
        appendJournal(paths.intents, `${JSON.stringify({ kind: "intent", planSha256: planSha, key, payloadSha256: entry.plan.payloadSha256 })}\n`);
        intents.push({ kind: "intent", planSha256: planSha, key, payloadSha256: entry.plan.payloadSha256 });
        const prior = records.filter((r) => wireKey(r) === key); const attemptIndexStart = Math.max(0, ...prior.map((r) => r.attemptIndex)) + 1;
        try {
            const captured = await executeWireRequest({ ...entry.plan, phase: PHASE, transport, campaignRoot, request: entry.request, attemptIndexStart,
                onWireRecord: (record) => {
                    ensurePrivateRecordsFile(paths.records);
                    appendDurable(paths.records, `${JSON.stringify(record)}\n`);
                    appendJournal(paths.intents, `${JSON.stringify({ kind: "receipt", planSha256: planSha, wireId: record.wireId, recordSha256: sha256(JSON.stringify(record)) })}\n`);
                    records.push(record);
                    afterRecordPersisted?.();
                }, ...(sleep === undefined ? {} : { sleep }) });
            if (captured.some(knownSuccess)) done.add(key);
        } catch (error) {
            for (const record of attemptRecordsOf(error)) if (!records.some((existing) => existing.wireId === record.wireId)) {
                ensurePrivateRecordsFile(paths.records);
                appendDurable(paths.records, `${JSON.stringify(record)}\n`);
                    appendJournal(paths.intents, `${JSON.stringify({ kind: "receipt", planSha256: planSha, wireId: record.wireId, recordSha256: sha256(JSON.stringify(record)) })}\n`);
                records.push(record);
            }
            if (error instanceof Error && error.message.includes("campaign_halted_reserve_breached")) { aborted = true; break; }
            if (error instanceof Error && error.name === "MethodCaptureGapError") { aborted = true; break; }
            else if (error instanceof Error && /Campaign cap exceeded/.test(error.message)) { aborted = true; break; }
            else throw error;
        }
        // Every planned cell must end with a verified success; failures are retained, never dropped.
        const latest = records.filter((record) => wireKey(record) === key);
        if (!latest.some(knownSuccess) && latest.length >= 3) done.add(key);
    }
    records = readRecords(paths.records);
    const finalJournal = readRecoveryJournal(paths.intents);
    validateDurableRecords(plan, planSha, records, finalJournal);
    const cells = deriveCells(plan, records);
    const attemptsByKey = new Map<string, MethodWireRecord[]>();
    for (const record of records) { const key = wireKey(record); const bucket = attemptsByKey.get(key) ?? []; bucket.push(record); attemptsByKey.set(key, bucket); }
    const finalAttemptUnverified = plan.dispatch.filter((entry) => {
        const attempts = attemptsByKey.get(dispatchKey(entry.plan)) ?? [];
        return !attempts.length || !knownSuccess(attempts.reduce((latest, record) => record.attemptIndex > latest.attemptIndex ? record : latest));
    }).map((entry) => dispatchKey(entry.plan));
    const servedIdentityDrift = records.filter((record) => record.servedModel !== null && record.servedModel !== COMPARISON_SERVED_MODEL_ALLOWLIST[record.arm]).map((record) => record.wireId);
    const plannedHashes = new Map(plan.dispatch.map((entry) => [dispatchKey(entry.plan), entry.plan.payloadSha256]));
    const payloadDrift = records.filter((record) => plannedHashes.get(wireKey(record)) !== record.payloadSha256).map((record) => record.wireId);
    const retryAnswerDrift: string[] = [];
    const successes = records.filter(knownSuccess);
    const components = new Map<string, MethodWireRecord[]>();
    for (const record of successes) { const key = wireKey(record); const group = components.get(key) ?? []; group.push(record); components.set(key, group); }
    for (const group of components.values()) for (const cid of group[0]!.candidateIds) {
        const values = new Set(group.map((record) => record.answers.find((answer) => answer.candidateId === cid)?.probability));
        if (values.size > 1) retryAnswerDrift.push(...group.map((record) => record.wireId));
    }
    const result = { version: 1, kind: "method-confirm-results", manifestSha256: plan.artifact.manifestSha256, planSha256: sha256(serializePlan(plan.artifact)), completed: cells.completed, blocked: cells.blocked, integrity: { aborted, captureGaps: records.filter((r) => r.errorClass === "capture_gap").map((r) => r.wireId), finalAttemptUnverified, servedIdentityDrift, payloadDrift, retryAnswerDrift } };
    writeResult(paths.results, result);
    } finally { closeSync(lockFd); unlinkSync(paths.lock); }
}
function deriveCells(plan: BuiltConfirmPlan, records: readonly MethodWireRecord[]): { completed: Array<Record<string, unknown>>; blocked: Array<Record<string, unknown>> } {
    const completed: Array<Record<string, unknown>> = [], blocked: Array<Record<string, unknown>> = [];
    const plannedCells = new Set<string>();
    const recordsByGroup = new Map<string, MethodWireRecord[]>();
    for (const record of records) if (!record.warmup && record.queryGroup !== null) {
        const key = `${record.arm}|${record.method}|${record.replica}|${record.queryGroup}`;
        const bucket = recordsByGroup.get(key) ?? []; bucket.push(record); recordsByGroup.set(key, bucket);
    }
    for (const { plan: request } of plan.dispatch) if (!request.warmup && request.queryGroup !== null) {
        for (const cid of request.candidateIds) plannedCells.add(`${request.arm}|${request.method}|${request.replica}|${request.queryGroup}|${cid}`);
    }
    for (const config of METHOD_CONFIRM_MODELS) for (const query of plan.dispatch.filter((p) => !p.plan.warmup && p.plan.arm === config.arm && p.plan.method === "M0" && p.plan.replica === 0)) {
        for (const cid of query.plan.candidateIds) for (let replica = 0; replica < METHOD_CONFIRM_REPLICAS; replica += 1) for (const method of ["M0", config.challenger] as const) {
            if (!plannedCells.has(`${config.arm}|${method}|${replica}|${query.plan.queryGroup}|${cid}`)) continue;
            const forwardMethod = method === "M1" ? "M1" : "M0";
            const forward = (recordsByGroup.get(`${config.arm}|${forwardMethod}|${replica}|${query.plan.queryGroup}`) ?? []).filter((record) => record.candidateIds.includes(cid));
            const reverse = method === "M2" ? recordsByGroup.get(`${config.arm}|M2|${replica}|${query.plan.queryGroup}`) ?? [] : [];
            const success = forward.filter(knownSuccess); const reverseSuccess = reverse.filter(knownSuccess);
            const wireIds = [...forward, ...reverse].map((r) => r.wireId);
            let probability: number | null = null;
            if (success.length && (method !== "M2" || reverseSuccess.length)) {
                const p = success[0]!.answers.find((a) => a.candidateId === cid)?.probability;
                const rp = method === "M2" ? reverseSuccess[0]!.answers.find((a) => a.candidateId === cid)?.probability : undefined;
                if (typeof p === "number" && (method !== "M2" || typeof rp === "number")) probability = method === "M2" ? (p + rp!) / 2 : p;
            }
            const row = { arm: config.arm, method, queryGroup: query.plan.queryGroup, candidateId: cid, replica, probability, wireIds };
            if (probability === null) blocked.push({ ...row, reason: "blocked: incomplete; no planned cell excluded" }); else completed.push(row);
        }
    }
    return { completed, blocked };
}

function paidTransport(env: NodeJS.ProcessEnv = process.env): FetchFn {
    const key = env[JUDGE_KEY_ENV];
    if (typeof key !== "string" || key.trim() === "") throw new Error(`--run requires ${JUDGE_KEY_ENV}; credential value is never logged`);
    return async (url, init) => { const headers = new Headers(init?.headers); headers.set("authorization", `Bearer ${key}`); return fetch(url, { ...init, headers }); };
}

export interface MethodConfirmRunOptions {
    loadInputs?: (root: string) => ConfirmPlanInputs;
    createTransport?: () => FetchFn;
    campaignRoot?: string;
}
export async function runMethodConfirm(argv: readonly string[], options: MethodConfirmRunOptions = {}): Promise<number> {
    let args: ReturnType<typeof parseArgs>;
    try { args = parseArgs(argv); } catch (error) { console.error(`error: ${error instanceof Error ? error.message : String(error)}`); return METHOD_CONFIRM_EXIT_ERROR; }
    if (args.help) { console.log("Usage: method-confirm.ts --dry-run|--run --out DIR [--corpus DIR] [--i-understand-this-spends-money]"); return METHOD_CONFIRM_EXIT_OK; }
    if (args.mode === "run" && !args.authorized) { console.error("paid gate refused: --i-understand-this-spends-money is required; no request sent"); return METHOD_CONFIRM_EXIT_GATE; }
    let built: BuiltConfirmPlan;
    try { built = buildMethodConfirmPlanFromInputs((options.loadInputs ?? inputsFromVerifiedRoot)(args.corpus)); }
    catch (error) { console.error(`corpus/plan refused: ${error instanceof Error ? error.message : String(error)}`); return args.mode === "run" ? METHOD_CONFIRM_EXIT_GATE : METHOD_CONFIRM_EXIT_ERROR; }
    const paths = resultPaths(args.out); const bytes = serializePlan(built.artifact); const planHash = sha256(bytes);
    try { ensureOutputDirectory(args.out); if (!existsSync(paths.plan)) writeExclusive(paths.plan, bytes); else if (readFileSync(paths.plan, "utf8") !== bytes) throw new Error("existing plan differs from freshly rebuilt sealed plan; refusing"); }
    catch (error) { console.error(`plan write refused: ${error instanceof Error ? error.message : String(error)}`); return METHOD_CONFIRM_EXIT_ERROR; }
    const counts = built.artifact.inventory;
    console.log(`plan=${paths.plan} manifestSha256=${built.artifact.manifestSha256} planSha256=${planHash}`);
    console.log(`queries=${built.artifact.queryCount} candidates=${built.artifact.candidateCount} replicas=3 totalRequests=${built.artifact.requests.length}`);
    for (const arm of COMPARISON_MODELS) console.log(`${arm}: ${JSON.stringify(counts[arm])}`);
    console.log(`replicaLadder=${JSON.stringify(built.artifact.replicaLadder)}`);
    console.log(`projection=${JSON.stringify(built.artifact.projection)}`);
    console.log(METHOD_CONFIRM_DEFERRED_SUITE);
    if (args.mode === "dry-run") { console.log("dry-run: zero network calls, no credential read, no campaign ledger mutation"); return METHOD_CONFIRM_EXIT_OK; }
    try { const transport = (options.createTransport ?? paidTransport)(); await executeConfirmPlan(built, args.out, transport, options.campaignRoot ?? defaultCampaignRoot()); return METHOD_CONFIRM_EXIT_OK; }
    catch (error) { console.error(`execution failed: ${error instanceof Error ? error.message : String(error)}`); return METHOD_CONFIRM_EXIT_ERROR; }
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : "";
if (invoked === fileURLToPath(import.meta.url)) process.exitCode = await runMethodConfirm(process.argv.slice(2));
