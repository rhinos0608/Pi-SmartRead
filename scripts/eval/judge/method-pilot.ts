#!/usr/bin/env node
/**
 * Stage F — method-selection pilot runner (design plan Stage F row and §3
 * "Pilot versus full-mode gate"; protocol §9 Amendment A1, cost table A1.6).
 *
 * Default mode is `dry-run` (also chosen when `--mode` is absent): NO
 * network — the transport factory is never invoked, no fetch/base URL is
 * constructed — NO credential or auth-store reads, NO campaign-ledger
 * mutation. Dry-run loads the sealed corpus through
 * `loadVerifiedPilotCorpus` (fail-closed re-verification), rebuilds the
 * FULL request plan with the Stage D builders (`payloadSha256` over the
 * exact body bytes), verifies the derived per-model inventory against the
 * protocol A1.6 arithmetic (560 isolated M1 + 80 M0 forward + 80 M2
 * reverse + 2 warmups = 722 requests/model), and writes the plan artifact
 * atomically (unique temp file + rename). The plan contains request
 * inventory, payload hashes, and the method/replica/query mapping only —
 * never synthetic quality scores, labels, or probabilities.
 *
 * `--mode full` is the paid-execution gate. It refuses with EXIT GATE (3)
 * unless ALL hold: an explicit `--authorize-paid` flag; the sealed corpus
 * verifies; and the plan artifact named by `--out` exists AND its payload
 * hashes/roster digest/manifest hash match a freshly rebuilt plan. Only
 * then does it build the paid transport (env check first: the factory
 * expects `PI_SMARTREAD_JUDGE_API_KEY`, the same `JUDGE_KEY_ENV` used by
 * `model-comparison.ts`, `run.ts`, and `grep-e2e.ts` — keys are never
 * embedded, logged, or written) and run the execution loop:
 * `seedCampaignLedger` + `executeWireRequest` (admission-before-fetch and
 * UNKNOWN retention live inside the executor), sequential dispatch in
 * frozen plan order. Resumption skips completed work via the payload-hash
 * progress ledger `<out>.progress.jsonl`; settled attempt records are
 * appended to `<out>.wire-records.jsonl` and each is checked with
 * `isMethodWireRecord` before persistence.
 *
 * Exit codes: 0 ok · 2 usage/validation/execution failure · 3 paid-gate
 * refusal. Dry-run requires `--out`; in full mode `--out` names the plan
 * artifact to verify against (missing ⇒ gate refusal 3).
 *
 * Main guard: this module runs its CLI only when it is the invoked entry
 * point (`model-comparison.ts` pattern), so importing never executes.
 */
import { createHash, randomBytes } from "node:crypto";
import {
    appendFileSync,
    closeSync,
    existsSync,
    fsyncSync,
    mkdirSync,
    openSync,
    readFileSync,
    renameSync,
    unlinkSync,
    writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FetchFn } from "../../../src/judge/systemone-client.js";
import type { JsonValue } from "../../../src/judge/types.js";
import {
    METHOD_DIRECTIONS,
    METHOD_IDS,
    PILOT_REPLICA_COUNT,
    isMethodWireRecord,
    type MethodDirection,
    type MethodId,
    type MethodWireRecord,
} from "./method-comparison-contract.js";
import {
    METHOD_WIRE_DIRECTION,
    attemptRecordsOf,
    buildM0Request,
    buildM1Request,
    buildM2Reverse,
    executeWireRequest,
    type MethodRequestCandidate,
    type MethodWireRequest,
} from "./method-comparison-executor.js";
import {
    PILOT_EXPECTED_QUERY_COUNT,
    PILOT_MANIFEST_SIDECAR_FILE,
    isPilotCandidateDossier,
    isPilotManifest,
    isPilotQueryDossier,
    isPilotSourceSnapshotRow,
    isVerifiedPilotCorpusRoster,
    loadVerifiedPilotCorpus,
    type PilotCorpusRoster,
} from "./method-pilot-fixture.js";
import { defaultCampaignRoot, seedCampaignLedger } from "./model-comparison-budget.js";
import { COMPARISON_MODELS, JUDGE_KEY_ENV } from "./model-comparison.js";
import { isComparisonModelId } from "./model-comparison-types.js";

/* ──────────────────────────────────────────────────────────────────
 * Constants: plan version + protocol A1.6 request arithmetic
 * ────────────────────────────────────────────────────────────────── */

/** Plan artifact format version. */
export const METHOD_PILOT_PLAN_VERSION = 1;
/** Plan artifact discriminator (rejects foreign JSON at the gate). */
export const METHOD_PILOT_PLAN_KIND = "method-pilot-request-plan";

/**
 * Protocol §9 A1.6 request arithmetic (frozen pre-data): per model,
 * **722** requests = **560** isolated M1 + **160** shared (80 M0 forward +
 * 80 M2 reverse) + **2** warmups, at exactly 40 queries / 280 candidates /
 * 2 replicas with no splits. Derived counts are checked against these
 * constants and a mismatch is REPORTED verbatim — never silently adjusted.
 */
export const A1_6_REQUESTS_PER_MODEL = 722;
/** A1.6: 560 isolated (280 candidates × 2 replicas). */
export const A1_6_ISOLATED_REQUESTS_PER_MODEL = 560;
/** A1.6: 160 shared = 80 M0 forward + 80 M2 reverse (40 queries × 2 replicas each). */
export const A1_6_SHARED_REQUESTS_PER_MODEL = 160;
/** A1.6: two warmups per model (one per pilot replica). */
export const A1_6_WARMUP_REQUESTS_PER_MODEL = 2;

/** Known sealed pilot data root (design plan "Data root"); always re-verified on load. */
export function defaultPilotRoot(): string {
    return join(homedir(), ".cache", "pi-smartread-judge-pilot-20261008");
}

/** Exit codes (task contract). */
export const METHOD_PILOT_EXIT_OK = 0;
export const METHOD_PILOT_EXIT_USAGE = 2;
export const METHOD_PILOT_EXIT_GATE = 3;

const PILOT_PHASE = "pilot" as const;
const HEX_64 = /^[0-9a-f]{64}$/;

/* ──────────────────────────────────────────────────────────────────
 * Inputs: sealed corpus + sealed artifacts re-read under the manifest
 * ────────────────────────────────────────────────────────────────── */

/**
 * Everything the plan builder needs, all cross-bound to the load-verified
 * roster: query texts (qid), per-candidate request states (cid → production
 * `toItems` shape `{path, symbol, text}` where `text` is the sealed
 * `materializePinnedRange` excerpt, byte-identical to `sourceRange`).
 */
export interface MethodPilotPlanInputs {
    roster: PilotCorpusRoster;
    queryTexts: ReadonlyMap<string, string>;
    candidateStates: ReadonlyMap<string, { readonly qid: string; readonly state: Record<string, JsonValue> }>;
}

function sha256Hex(value: string): string {
    return createHash("sha256").update(value, "utf-8").digest("hex");
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonl<T>(path: string, content: string, guard: (row: unknown) => row is T, label: string): T[] {
    const rows: T[] = [];
    const lines = content.split("\n");
    for (const [index, line] of lines.entries()) {
        if (line === "") continue;
        let parsed: unknown;
        try {
            parsed = JSON.parse(line);
        } catch {
            throw new Error(`${path}: invalid JSON at line ${index + 1}`);
        }
        if (!guard(parsed)) throw new Error(`${path}: invalid ${label} row at line ${index + 1}`);
        rows.push(parsed);
    }
    return rows;
}

/**
 * Load the sealed corpus AND the three artifacts the plan builder needs.
 * `loadVerifiedPilotCorpus` performs the full Stage B re-verification
 * (sidecar, artifact digests, label cross-binding, disjointness,
 * composition) and brands the roster; the artifact bytes read here are
 * then re-hashed against the manifest (whose own bytes must equal the
 * roster's `manifestSha256`) and cross-checked row-by-row against the
 * roster, so no unverified byte can reach a request body.
 */
export function loadMethodPilotPlanInputs(root: string): MethodPilotPlanInputs {
    const roster = loadVerifiedPilotCorpus(root);
    const manifestBytes = readFileSync(join(root, PILOT_MANIFEST_SIDECAR_FILE), "utf-8");
    if (sha256Hex(manifestBytes) !== roster.manifestSha256) {
        throw new Error("pilot manifest bytes do not match the load-verified roster manifestSha256");
    }
    let manifest: unknown;
    try {
        manifest = JSON.parse(manifestBytes);
    } catch {
        throw new Error("pilot manifest json invalid");
    }
    if (!isPilotManifest(manifest)) throw new Error("pilot manifest shape invalid");
    const entryByPath = new Map(manifest.artifacts.map((entry) => [entry.path, entry]));
    const readArtifact = (path: string): string => {
        const entry = entryByPath.get(path);
        if (entry === undefined) throw new Error(`pilot manifest does not cover artifact ${path}`);
        const content = readFileSync(join(root, path), "utf-8");
        if (sha256Hex(content) !== entry.sha256 || Buffer.byteLength(content, "utf-8") !== entry.byteLength) {
            throw new Error(`pilot artifact digest mismatch: ${path}`);
        }
        return content;
    };
    const queries = parseJsonl("pilot-queries.jsonl", readArtifact("pilot-queries.jsonl"), isPilotQueryDossier, "query dossier");
    const candidates = parseJsonl("pilot-candidates.jsonl", readArtifact("pilot-candidates.jsonl"), isPilotCandidateDossier, "candidate dossier");
    const snapshots = parseJsonl("pilot-source-snapshots.jsonl", readArtifact("pilot-source-snapshots.jsonl"), isPilotSourceSnapshotRow, "source snapshot row");

    if (queries.length !== roster.queries.length) {
        throw new Error(`pilot-queries.jsonl has ${queries.length} rows but the roster has ${roster.queries.length} queries`);
    }
    queries.forEach((query, index) => {
        if (query.qid !== roster.queries[index]?.qid) {
            throw new Error(`pilot-queries.jsonl row ${index} is ${query.qid}, roster query is ${roster.queries[index]?.qid}`);
        }
    });
    if (candidates.length !== roster.candidates.length) {
        throw new Error(`pilot-candidates.jsonl has ${candidates.length} rows but the roster has ${roster.candidates.length} candidates`);
    }
    candidates.forEach((candidate, index) => {
        const rostered = roster.candidates[index];
        if (rostered === undefined
            || candidate.cid !== rostered.cid
            || candidate.qid !== rostered.qid
            || candidate.file !== rostered.file
            || candidate.startLine !== rostered.startLine
            || candidate.endLine !== rostered.endLine) {
            throw new Error(`pilot-candidates.jsonl row ${index} does not match the load-verified roster candidate`);
        }
    });
    if (snapshots.length !== roster.candidates.length) {
        throw new Error(`pilot-source-snapshots.jsonl has ${snapshots.length} rows but the roster has ${roster.candidates.length} candidates`);
    }
    snapshots.forEach((snapshot, index) => {
        if (snapshot.cid !== roster.candidates[index]?.cid) {
            throw new Error(`pilot-source-snapshots.jsonl row ${index} is ${snapshot.cid}, roster candidate is ${roster.candidates[index]?.cid}`);
        }
    });

    const queryTexts = new Map<string, string>();
    for (const query of queries) queryTexts.set(query.qid, query.query);
    const candidateStates = new Map<string, { qid: string; state: Record<string, JsonValue> }>();
    const snapshotByCid = new Map(snapshots.map((snapshot) => [snapshot.cid, snapshot.excerpt]));
    for (const candidate of candidates) {
        const excerpt = snapshotByCid.get(candidate.cid);
        if (excerpt === undefined) throw new Error(`missing sealed excerpt for candidate ${candidate.cid}`);
        candidateStates.set(candidate.cid, {
            qid: candidate.qid,
            state: { path: candidate.file, symbol: candidate.symbol ?? "", text: excerpt },
        });
    }
    return { roster, queryTexts, candidateStates };
}

/* ──────────────────────────────────────────────────────────────────
 * Plan artifact types + validation (fail-closed, exact keys)
 * ────────────────────────────────────────────────────────────────── */

/** One planned physical request (identities + exact-byte payload hash; no bodies, no scores). */
export interface MethodPilotPlanRequest {
    arm: string;
    method: MethodId;
    direction: MethodDirection;
    replica: number;
    /** `qid` for scored requests; null exactly for warmups. */
    queryGroup: string | null;
    warmup: boolean;
    candidateIds: string[];
    payloadSha256: string;
    requestBytes: number;
}

/** Per-model A1.6 inventory. */
export interface MethodPilotModelInventory {
    m0Forward: number;
    m1Isolated: number;
    m2Reverse: number;
    warmups: number;
    total: number;
    /** sha256 over this model's payload hashes in plan order (compact tamper check). */
    payloadDigest: string;
}

export interface MethodPilotPlanArtifact {
    version: number;
    kind: string;
    pilotManifestSha256: string;
    rosterDigest: string;
    sourceRef: string;
    models: string[];
    replicaCount: number;
    queryCount: number;
    candidateCount: number;
    expectedRequestsPerModel: number;
    perModel: Record<string, MethodPilotModelInventory>;
    requests: MethodPilotPlanRequest[];
}

/** In-memory plan: artifact + the exact bodies the executor would dispatch. */
export interface MethodPilotPlan {
    artifact: MethodPilotPlanArtifact;
    entries: Array<{ request: MethodPilotPlanRequest; body: MethodWireRequest }>;
}

const PLAN_ARTIFACT_KEYS = [
    "version", "kind", "pilotManifestSha256", "rosterDigest", "sourceRef",
    "models", "replicaCount", "queryCount", "candidateCount",
    "expectedRequestsPerModel", "perModel", "requests",
] as const;
const INVENTORY_KEYS = ["m0Forward", "m1Isolated", "m2Reverse", "warmups", "total", "payloadDigest"] as const;
const REQUEST_KEYS = [
    "arm", "method", "direction", "replica", "queryGroup", "warmup",
    "candidateIds", "payloadSha256", "requestBytes",
] as const;

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
    const keySet = new Set(keys);
    return Object.keys(value).every((key) => keySet.has(key))
        && keys.every((key) => Object.hasOwn(value, key));
}

function isHex64(value: unknown): value is string {
    return typeof value === "string" && HEX_64.test(value);
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.length > 0;
}

function isInventory(value: unknown): value is MethodPilotModelInventory {
    if (!isPlainObject(value) || !hasExactKeys(value, INVENTORY_KEYS)) return false;
    return ["m0Forward", "m1Isolated", "m2Reverse", "warmups", "total"].every(
        (key) => Number.isInteger(value[key]) && (value[key] as number) >= 0,
    ) && isHex64(value.payloadDigest);
}

function isPlanRequest(value: unknown): value is MethodPilotPlanRequest {
    if (!isPlainObject(value) || !hasExactKeys(value, REQUEST_KEYS)) return false;
    if (!isNonEmptyString(value.arm)) return false;
    if (!(METHOD_IDS as readonly string[]).includes(value.method as string)) return false;
    const method = value.method as MethodId;
    if (value.direction !== METHOD_WIRE_DIRECTION[method]
        || !(METHOD_DIRECTIONS as readonly string[]).includes(value.direction as string)) return false;
    if (!Number.isInteger(value.replica) || (value.replica as number) < 0 || (value.replica as number) >= PILOT_REPLICA_COUNT) return false;
    if (typeof value.warmup !== "boolean") return false;
    if (value.warmup ? value.queryGroup !== null : !isNonEmptyString(value.queryGroup)) return false;
    if (!Array.isArray(value.candidateIds) || value.candidateIds.length === 0) return false;
    if (!value.candidateIds.every(isNonEmptyString)) return false;
    if (!isHex64(value.payloadSha256)) return false;
    if (!Number.isInteger(value.requestBytes) || (value.requestBytes as number) < 0) return false;
    return true;
}

/** Fail-closed shape guard for a stored plan artifact (foreign/tampered JSON refused). */
export function isMethodPilotPlanArtifact(value: unknown): value is MethodPilotPlanArtifact {
    if (!isPlainObject(value) || !hasExactKeys(value, PLAN_ARTIFACT_KEYS)) return false;
    if (value.version !== METHOD_PILOT_PLAN_VERSION || value.kind !== METHOD_PILOT_PLAN_KIND) return false;
    if (!isHex64(value.pilotManifestSha256) || !isHex64(value.rosterDigest)) return false;
    if (!isNonEmptyString(value.sourceRef)) return false;
    if (!Array.isArray(value.models)
        || value.models.length !== COMPARISON_MODELS.length
        || !value.models.every((model, index) => model === COMPARISON_MODELS[index])) return false;
    if (value.replicaCount !== PILOT_REPLICA_COUNT) return false;
    if (value.queryCount !== PILOT_EXPECTED_QUERY_COUNT) return false;
    if (!Number.isInteger(value.candidateCount) || (value.candidateCount as number) <= 0) return false;
    if (value.expectedRequestsPerModel !== A1_6_REQUESTS_PER_MODEL) return false;
    if (!isPlainObject(value.perModel)) return false;
    const modelKeys = Object.keys(value.perModel);
    if (modelKeys.length !== COMPARISON_MODELS.length
        || !COMPARISON_MODELS.every((model) => Object.hasOwn(value.perModel as object, model))) return false;
    if (!Object.values(value.perModel).every(isInventory)) return false;
    return Array.isArray(value.requests) && value.requests.every(isPlanRequest);
}

/* ──────────────────────────────────────────────────────────────────
 * Plan building
 * ────────────────────────────────────────────────────────────────── */

/** Stable skip/resume key: payload hash bound to the full request identity. */
export function methodPilotPlanKey(request: Pick<MethodPilotPlanRequest,
    "arm" | "method" | "replica" | "queryGroup" | "warmup" | "payloadSha256">): string {
    return [
        request.arm, request.method, String(request.replica),
        request.queryGroup ?? "warmup", String(request.warmup), request.payloadSha256,
    ].join("|");
}

function methodPilotRecordKey(record: MethodWireRecord): string {
    return [
        record.arm, record.method, String(record.replica),
        record.queryGroup ?? "warmup", String(record.warmup), record.payloadSha256,
    ].join("|");
}

/**
 * sha256 over the roster projection the plan binds (sourceRef, queries,
 * candidates). Exported so `method-pilot-select.ts` can recompute it
 * over the load-verified roster instead of trusting `plan.rosterDigest`.
 */
export function rosterDigestOf(roster: PilotCorpusRoster): string {
    return sha256Hex(JSON.stringify({
        sourceRef: roster.sourceRef,
        queries: roster.queries.map((query) => ({ qid: query.qid, answerable: query.answerable })),
        candidates: roster.candidates.map((candidate) => ({
            cid: candidate.cid, qid: candidate.qid, file: candidate.file,
            startLine: candidate.startLine, endLine: candidate.endLine, label: candidate.label,
        })),
    }));
}

/**
 * Verify the derived per-model inventory against protocol A1.6. Derived
 * counts come from the sealed roster + `PILOT_REPLICA_COUNT`; a mismatch
 * with the frozen 722/560/160/2 arithmetic is reported as-is (the design
 * explicitly forbids silently adjusting counts to fit).
 */
function assertA1_6Arithmetic(queryCount: number, candidateCount: number): {
    m0Forward: number; m1Isolated: number; m2Reverse: number; warmups: number; total: number;
} {
    const m0Forward = queryCount * PILOT_REPLICA_COUNT;
    const m1Isolated = candidateCount * PILOT_REPLICA_COUNT;
    const m2Reverse = queryCount * PILOT_REPLICA_COUNT;
    const warmups = PILOT_REPLICA_COUNT;
    const total = m0Forward + m1Isolated + m2Reverse + warmups;
    const shared = m0Forward + m2Reverse;
    if (m1Isolated !== A1_6_ISOLATED_REQUESTS_PER_MODEL
        || shared !== A1_6_SHARED_REQUESTS_PER_MODEL
        || warmups !== A1_6_WARMUP_REQUESTS_PER_MODEL
        || total !== A1_6_REQUESTS_PER_MODEL) {
        throw new Error(
            `A1.6 request arithmetic mismatch (reported, not adjusted): derived ${total} requests/model `
            + `(${m1Isolated} isolated + ${m0Forward} forward + ${m2Reverse} reverse + ${warmups} warmups) `
            + `from ${queryCount} queries / ${candidateCount} candidates x ${PILOT_REPLICA_COUNT} replicas, `
            + `but protocol A1.6 freezes ${A1_6_REQUESTS_PER_MODEL} `
            + `(${A1_6_ISOLATED_REQUESTS_PER_MODEL} isolated + ${A1_6_SHARED_REQUESTS_PER_MODEL} shared + ${A1_6_WARMUP_REQUESTS_PER_MODEL} warmups)`,
        );
    }
    return { m0Forward, m1Isolated, m2Reverse, warmups, total };
}

function onlyRequest(requests: MethodWireRequest[], label: string): MethodWireRequest {
    if (requests.length !== 1) {
        throw new Error(
            `${label} packed into ${requests.length} requests; protocol A1.6 arithmetic assumes no splits `
            + "(every M0/reverse query must fit ONE request — design plan §3 offline acceptance)",
        );
    }
    const [request] = requests;
    if (request === undefined) throw new Error(`${label} produced no request`);
    return request;
}

interface ModelPlan {
    requests: MethodPilotPlanRequest[];
    entries: Array<{ request: MethodPilotPlanRequest; body: MethodWireRequest }>;
}

function pushPlanned(
    model: ModelPlan,
    arm: string,
    method: MethodId,
    replica: number,
    queryGroup: string | null,
    warmup: boolean,
    body: MethodWireRequest,
): void {
    const request: MethodPilotPlanRequest = {
        arm,
        method,
        direction: METHOD_WIRE_DIRECTION[method],
        replica,
        queryGroup,
        warmup,
        candidateIds: [...body.candidateIds],
        payloadSha256: body.payloadSha256,
        requestBytes: body.requestBytes,
    };
    model.requests.push(request);
    model.entries.push({ request, body });
}

/**
 * Build the complete per-model request plan in frozen order:
 * warmups (one per replica, singleton over the first sealed candidate,
 * tagged M0/forward with `queryGroup: null`), then M0 forward per
 * replica × query, M1 singletons per replica × query × candidate, and
 * M2 reverse legs (the M2 forward leg IS the M0 forward request — it is
 * planned once here and never re-sent).
 */
function planModelRequests(
    arm: string,
    inputs: MethodPilotPlanInputs,
    candidatesByQid: ReadonlyMap<string, readonly MethodRequestCandidate[]>,
): ModelPlan {
    const model: ModelPlan = { requests: [], entries: [] };
    const firstQuery = inputs.roster.queries[0];
    if (firstQuery === undefined) throw new Error("sealed roster has no queries");
    const firstQueryText = inputs.queryTexts.get(firstQuery.qid);
    const firstCandidate = (candidatesByQid.get(firstQuery.qid) ?? [])[0];
    if (firstQueryText === undefined) throw new Error(`missing sealed query text for ${firstQuery.qid}`);
    if (firstCandidate === undefined) throw new Error(`missing sealed candidates for ${firstQuery.qid}`);

    for (let replica = 0; replica < PILOT_REPLICA_COUNT; replica += 1) {
        pushPlanned(model, arm, "M0", replica, null, true,
            onlyRequest(buildM0Request(arm, firstQueryText, [firstCandidate]), `warmup ${arm} r${replica}`));
    }
    for (let replica = 0; replica < PILOT_REPLICA_COUNT; replica += 1) {
        for (const query of inputs.roster.queries) {
            const text = inputs.queryTexts.get(query.qid);
            const candidates = candidatesByQid.get(query.qid);
            if (text === undefined) throw new Error(`missing sealed query text for ${query.qid}`);
            if (candidates === undefined || candidates.length === 0) throw new Error(`missing sealed candidates for ${query.qid}`);
            pushPlanned(model, arm, "M0", replica, query.qid, false,
                onlyRequest(buildM0Request(arm, text, candidates), `M0 ${arm} ${query.qid} r${replica}`));
        }
    }
    for (let replica = 0; replica < PILOT_REPLICA_COUNT; replica += 1) {
        for (const query of inputs.roster.queries) {
            const text = inputs.queryTexts.get(query.qid);
            const candidates = candidatesByQid.get(query.qid);
            if (text === undefined || candidates === undefined) throw new Error(`missing sealed inputs for ${query.qid}`);
            for (const candidate of candidates) {
                pushPlanned(model, arm, "M1", replica, query.qid, false, buildM1Request(arm, text, candidate));
            }
        }
    }
    for (let replica = 0; replica < PILOT_REPLICA_COUNT; replica += 1) {
        for (const query of inputs.roster.queries) {
            const text = inputs.queryTexts.get(query.qid);
            const candidates = candidatesByQid.get(query.qid);
            if (text === undefined || candidates === undefined) throw new Error(`missing sealed inputs for ${query.qid}`);
            pushPlanned(model, arm, "M2", replica, query.qid, false,
                onlyRequest(buildM2Reverse(arm, text, candidates), `M2 reverse ${arm} ${query.qid} r${replica}`));
        }
    }
    return model;
}

function countInventory(requests: readonly MethodPilotPlanRequest[]): MethodPilotModelInventory {
    const inventory: MethodPilotModelInventory = {
        m0Forward: 0, m1Isolated: 0, m2Reverse: 0, warmups: 0, total: 0, payloadDigest: "",
    };
    for (const request of requests) {
        if (request.warmup) inventory.warmups += 1;
        else if (request.method === "M0") inventory.m0Forward += 1;
        else if (request.method === "M1") inventory.m1Isolated += 1;
        else inventory.m2Reverse += 1;
        inventory.total += 1;
    }
    inventory.payloadDigest = sha256Hex(requests.map((request) => request.payloadSha256).join("\n"));
    return inventory;
}

/**
 * Build the full deterministic request plan from verified inputs. Throws
 * on an unbranded roster, an A1.6 arithmetic mismatch, a missing sealed
 * input, or a builder split — dry-run reports it as usage/validation (2);
 * the paid gate treats it as a gate refusal (3).
 */
export function buildMethodPilotPlan(inputs: MethodPilotPlanInputs): MethodPilotPlan {
    const { roster } = inputs;
    if (!isVerifiedPilotCorpusRoster(roster)) {
        throw new Error("method-pilot: roster is not a load-verified sealed corpus roster");
    }
    const queryCount = roster.queries.length;
    if (queryCount !== PILOT_EXPECTED_QUERY_COUNT) {
        throw new Error(`method-pilot: sealed roster has ${queryCount} queries; protocol A1 freezes ${PILOT_EXPECTED_QUERY_COUNT}`);
    }
    const candidateCount = roster.candidates.length;
    const expected = assertA1_6Arithmetic(queryCount, candidateCount);

    const candidatesByQid = new Map<string, MethodRequestCandidate[]>();
    for (const candidate of roster.candidates) {
        const sealed = inputs.candidateStates.get(candidate.cid);
        if (sealed === undefined) throw new Error(`missing sealed request state for candidate ${candidate.cid}`);
        if (sealed.qid !== candidate.qid) throw new Error(`sealed state for ${candidate.cid} references ${sealed.qid}, roster says ${candidate.qid}`);
        const list = candidatesByQid.get(candidate.qid) ?? [];
        list.push({ candidateId: candidate.cid, state: sealed.state });
        candidatesByQid.set(candidate.qid, list);
    }
    for (const query of roster.queries) {
        if (!inputs.queryTexts.has(query.qid)) throw new Error(`missing sealed query text for ${query.qid}`);
        if ((candidatesByQid.get(query.qid) ?? []).length === 0) throw new Error(`sealed roster query ${query.qid} has no candidates`);
    }

    const allRequests: MethodPilotPlanRequest[] = [];
    const allEntries: Array<{ request: MethodPilotPlanRequest; body: MethodWireRequest }> = [];
    const perModel: Record<string, MethodPilotModelInventory> = {};
    const models = [...COMPARISON_MODELS];
    for (const arm of models) {
        if (!isComparisonModelId(arm)) throw new Error(`unknown comparison arm: ${String(arm)}`);
        const model = planModelRequests(arm, inputs, candidatesByQid);
        const inventory = countInventory(model.requests);
        if (inventory.m0Forward !== expected.m0Forward
            || inventory.m1Isolated !== expected.m1Isolated
            || inventory.m2Reverse !== expected.m2Reverse
            || inventory.warmups !== expected.warmups
            || inventory.total !== expected.total) {
            throw new Error(
                `built inventory for ${arm} (${JSON.stringify(inventory)}) disagrees with A1.6-derived `
                + `${JSON.stringify(expected)} — reported, not adjusted`,
            );
        }
        perModel[arm] = inventory;
        allRequests.push(...model.requests);
        allEntries.push(...model.entries);
    }
    return {
        artifact: {
            version: METHOD_PILOT_PLAN_VERSION,
            kind: METHOD_PILOT_PLAN_KIND,
            pilotManifestSha256: roster.manifestSha256,
            rosterDigest: rosterDigestOf(roster),
            sourceRef: roster.sourceRef,
            models,
            replicaCount: PILOT_REPLICA_COUNT,
            queryCount,
            candidateCount,
            expectedRequestsPerModel: A1_6_REQUESTS_PER_MODEL,
            perModel,
            requests: allRequests,
        },
        entries: allEntries,
    };
}

/** Canonical artifact bytes (fixed key order, no timestamps ⇒ byte-identical across runs). */
export function serializeMethodPilotPlan(artifact: MethodPilotPlanArtifact): string {
    return `${JSON.stringify(artifact, null, 2)}\n`;
}

/* ──────────────────────────────────────────────────────────────────
 * Atomic plan write (unique temp + rename)
 * ────────────────────────────────────────────────────────────────── */

function writePlanAtomic(outPath: string, body: string): void {
    mkdirSync(dirname(outPath), { recursive: true });
    const tmp = join(dirname(outPath), `.${basename(outPath)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
    let fd: number | undefined;
    try {
        fd = openSync(tmp, "wx", 0o600);
        writeSync(fd, body, null, "utf-8");
        fsyncSync(fd);
        closeSync(fd);
        fd = undefined;
        renameSync(tmp, outPath);
    } finally {
        if (fd !== undefined) {
            try { closeSync(fd); } catch { /* cleanup only */ }
        }
        try { unlinkSync(tmp); } catch { /* ours alone; gone after a successful rename */ }
    }
}

/* ──────────────────────────────────────────────────────────────────
 * CLI parsing
 * ────────────────────────────────────────────────────────────────── */

export interface MethodPilotArgs {
    mode: "dry-run" | "full";
    pilotRoot: string;
    out: string | undefined;
    authorizePaid: boolean;
    help: boolean;
}

function takeValue(flag: string, argv: readonly string[], index: number): string {
    const value = argv[index];
    if (value === undefined || value.startsWith("--")) {
        throw new Error(`${flag} requires a value`);
    }
    return value;
}

export function parseMethodPilotArgs(argv: readonly string[]): MethodPilotArgs {
    let mode: "dry-run" | "full" = "dry-run";
    let pilotRoot: string | undefined;
    let out: string | undefined;
    let authorizePaid = false;
    let help = false;
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === "--mode") {
            const value = takeValue(arg, argv, i + 1);
            i += 1;
            if (value !== "dry-run" && value !== "full") throw new Error("--mode must be dry-run or full");
            mode = value;
        } else if (arg === "--pilot-root") {
            pilotRoot = takeValue(arg, argv, i + 1);
            i += 1;
        } else if (arg === "--out") {
            out = takeValue(arg, argv, i + 1);
            i += 1;
        } else if (arg === "--authorize-paid") {
            authorizePaid = true;
        } else if (arg === "--help" || arg === "-h") {
            help = true;
        } else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }
    if (!help && mode === "dry-run" && out === undefined) {
        throw new Error("--out is required in dry-run mode (plan artifact path)");
    }
    // Lazy default: homedir() runs only when --pilot-root is absent, so an
    // explicit-root dry-run never touches the home directory at all.
    return { mode, pilotRoot: pilotRoot ?? defaultPilotRoot(), out, authorizePaid, help };
}

function printUsage(): void {
    console.log("Usage: npx tsx scripts/eval/judge/method-pilot.ts [--mode dry-run|full] [--pilot-root DIR] [--out PATH] [--authorize-paid]");
    console.log("  dry-run (default): offline deterministic plan artifact; no network, no credentials, no ledger.");
    console.log("  full: paid execution; refuses (exit 3) without --authorize-paid, a verified sealed corpus,");
    console.log("        and an existing --out plan artifact matching a freshly rebuilt plan.");
    console.log(`  Paid transport expects ${JUDGE_KEY_ENV} in the environment.`);
    console.log("  Exit codes: 0 ok, 2 usage/validation, 3 paid-gate refusal.");
}

/* ──────────────────────────────────────────────────────────────────
 * Paid gate: stored plan vs freshly rebuilt plan
 * ────────────────────────────────────────────────────────────────── */

function readStoredPlan(outPath: string): MethodPilotPlanArtifact {
    let parsed: unknown;
    try {
        parsed = JSON.parse(readFileSync(outPath, "utf-8"));
    } catch (error) {
        throw new Error(`plan artifact ${outPath} is not valid JSON: ${messageOf(error)}`);
    }
    if (!isMethodPilotPlanArtifact(parsed)) {
        throw new Error(`plan artifact ${outPath} is not a valid ${METHOD_PILOT_PLAN_KIND} v${METHOD_PILOT_PLAN_VERSION}`);
    }
    return parsed;
}

/** First structural difference between the stored plan and a fresh rebuild, or null when identical. */
export function compareMethodPilotPlans(stored: MethodPilotPlanArtifact, fresh: MethodPilotPlanArtifact): string | null {
    if (stored.pilotManifestSha256 !== fresh.pilotManifestSha256) return "pilot manifest hash mismatch";
    if (stored.rosterDigest !== fresh.rosterDigest) return "roster digest mismatch";
    if (stored.sourceRef !== fresh.sourceRef) return "source ref mismatch";
    if (stored.queryCount !== fresh.queryCount || stored.candidateCount !== fresh.candidateCount) return "corpus counts mismatch";
    if (JSON.stringify(stored.perModel) !== JSON.stringify(fresh.perModel)) return "per-model inventory or payload digest mismatch";
    if (stored.requests.length !== fresh.requests.length) {
        return `request count mismatch: stored ${stored.requests.length}, fresh ${fresh.requests.length}`;
    }
    for (let i = 0; i < fresh.requests.length; i += 1) {
        const a = stored.requests[i];
        const b = fresh.requests[i];
        if (a === undefined || b === undefined) return `missing request at index ${i}`;
        if (a.arm !== b.arm || a.method !== b.method || a.replica !== b.replica
            || a.queryGroup !== b.queryGroup || a.warmup !== b.warmup
            || a.candidateIds.join(",") !== b.candidateIds.join(",")) {
            return `request identity mismatch at index ${i} (${b.arm} ${b.method} r${b.replica} ${b.queryGroup ?? "warmup"})`;
        }
        if (a.payloadSha256 !== b.payloadSha256) {
            return `payload hash mismatch at index ${i} (${b.arm} ${b.method} r${b.replica} ${b.queryGroup ?? "warmup"})`;
        }
    }
    // Full canonical catch-all: every remaining field (models, replicaCount,
    // expectedRequestsPerModel, per-request requestBytes, ...) must match too.
    // The plan artifact is fully deterministic, so stored and freshly rebuilt
    // serialize byte-identically — any tampered field trips this gate before
    // any transport exists.
    if (JSON.stringify(stored) !== JSON.stringify(fresh)) {
        return "plan artifact differs from the fresh rebuild (full canonical comparison)";
    }
    return null;
}

/* ──────────────────────────────────────────────────────────────────
 * Paid transport factory (env check first; never constructed in dry-run)
 * ────────────────────────────────────────────────────────────────── */

/**
 * Build the paid Decisions transport. Requires `PI_SMARTREAD_JUDGE_API_KEY`
 * (the `JUDGE_KEY_ENV` shared by `model-comparison.ts` / `run.ts` /
 * `grep-e2e.ts`) to be present in the environment — this entry point does
 * NOT fall back to the Pi auth store, so a paid run can never silently
 * resolve ambient credentials. The key stays inside this closure, is
 * attached only as the `authorization` header, and is never logged.
 * Throws cleanly when the variable is absent or blank.
 */
export function createMethodPilotPaidTransport(env: NodeJS.ProcessEnv = process.env): FetchFn {
    const key = env[JUDGE_KEY_ENV];
    if (typeof key !== "string" || key.trim() === "") {
        throw new Error(
            `paid execution requires ${JUDGE_KEY_ENV} in the environment (the same key used by `
            + "model-comparison.ts/run.ts); refusing to send without credentials",
        );
    }
    return async (url: string, init?: RequestInit): Promise<Response> => {
        const headers: Record<string, string> = { ...((init?.headers ?? {}) as Record<string, string>) };
        headers.authorization = `Bearer ${key}`;
        return fetch(url, { ...init, headers });
    };
}

/* ──────────────────────────────────────────────────────────────────
 * Execution loop skeleton: admission-before-fetch lives in the executor;
 * resume skips via the payload-hash progress ledger
 * ────────────────────────────────────────────────────────────────── */

function planProgressPath(outPath: string): string {
    return `${outPath}.progress.jsonl`;
}

function planRecordsPath(outPath: string): string {
    return `${outPath}.wire-records.jsonl`;
}

function readJsonlRows<T>(path: string, parse: (row: unknown, line: number) => T): T[] {
    if (!existsSync(path)) return [];
    const rows: T[] = [];
    for (const [index, line] of readFileSync(path, "utf-8").split("\n").entries()) {
        if (line === "") continue;
        let parsed: unknown;
        try {
            parsed = JSON.parse(line);
        } catch {
            throw new Error(`corrupt ${path} at line ${index + 1}`);
        }
        rows.push(parse(parsed, index + 1));
    }
    return rows;
}

function readCompletedKeys(progressPath: string): Set<string> {
    const completed = new Set<string>();
    const rows = readJsonlRows<{ key: string; payloadSha256: string }>(progressPath, (raw, ln) => {
        if (!isPlainObject(raw) || typeof raw.key !== "string" || typeof raw.payloadSha256 !== "string") {
            throw new Error(`corrupt ${progressPath} at line ${ln}`);
        }
        return { key: raw.key, payloadSha256: raw.payloadSha256 };
    });
    for (const row of rows) {
        completed.add(row.key);
    }
    return completed;
}

/** Prior attempts per plan key (from persisted wire records) ⇒ resume continues gaplessly. */
function readAttemptBases(recordsPath: string): Map<string, number> {
    const bases = new Map<string, number>();
    for (const record of readJsonlRows(recordsPath, (raw, ln) => {
        if (!isMethodWireRecord(raw)) throw new Error(`corrupt ${recordsPath} at line ${ln}`);
        return raw;
    })) {
        const key = methodPilotRecordKey(record);
        bases.set(key, Math.max(bases.get(key) ?? 0, record.attemptIndex));
    }
    return bases;
}

function persistWireRecord(recordsPath: string, record: MethodWireRecord, written: Set<string>): void {
    if (!isMethodWireRecord(record)) throw new Error("method-pilot: executor produced a record failing isMethodWireRecord");
    if (written.has(record.wireId)) return;
    appendFileSync(recordsPath, `${JSON.stringify(record)}\n`, { encoding: "utf-8" });
    written.add(record.wireId);
}

async function executePilotPlan(
    plan: MethodPilotPlan,
    outPath: string,
    createTransport: () => FetchFn,
): Promise<void> {
    // Transport (and its env check) BEFORE any ledger mutation: a missing
    // key fails cleanly with no campaign books touched.
    const transport = createTransport();
    const campaignRoot = defaultCampaignRoot();
    seedCampaignLedger(campaignRoot);
    const progressPath = planProgressPath(outPath);
    const recordsPath = planRecordsPath(outPath);
    const completed = readCompletedKeys(progressPath);
    const attemptBases = readAttemptBases(recordsPath);
    const writtenWireIds = new Set<string>();

    // Execution dispatch order ONLY: plan bytes (counts, models[], requests)
    // stay frozen and resume still skips completed payloads, so this local,
    // reversible ordering lets arms that work finish before reaching a
    // deterministic failure on another arm. Frozen arms: jev -> luna -> pplx.
    const armPriority = (arm: string): number =>
        arm === "~typesafe/jev-latest" ? 0 : arm === "openai/gpt-6-luna-decisions" ? 1 : 2;
    const dispatch = [...plan.entries].sort((a, b) => armPriority(a.request.arm) - armPriority(b.request.arm));
    for (const entry of dispatch) {
        const key = methodPilotPlanKey(entry.request);
        if (completed.has(key)) continue;
        const arm = entry.request.arm;
        if (!isComparisonModelId(arm)) throw new Error(`method-pilot: unknown arm in plan: ${String(arm)}`);
        try {
            await executeWireRequest({
                method: entry.request.method,
                arm,
                phase: PILOT_PHASE,
                replica: entry.request.replica,
                queryGroup: entry.request.queryGroup,
                warmup: entry.request.warmup,
                request: entry.body,
                transport,
                campaignRoot,
                attemptIndexStart: (attemptBases.get(key) ?? 0) + 1,
                onWireRecord: (record) => persistWireRecord(recordsPath, record, writtenWireIds),
            });
        } catch (error) {
            // Records reached the sink before any halt; capture any that were
            // only attached to the escaping error so none is lost.
            for (const record of attemptRecordsOf(error)) persistWireRecord(recordsPath, record, writtenWireIds);
            throw error;
        }
        appendFileSync(progressPath, `${JSON.stringify({ key, payloadSha256: entry.request.payloadSha256 })}\n`, { encoding: "utf-8" });
        completed.add(key);
    }
}

/* ──────────────────────────────────────────────────────────────────
 * Orchestration
 * ────────────────────────────────────────────────────────────────── */

export interface MethodPilotRunOptions {
    /** Test seam: replace the sealed-corpus loader (production: full Stage B re-verification). */
    loadInputs?: (root: string) => MethodPilotPlanInputs;
    /** Test seam: replace the paid transport factory (production: `createMethodPilotPaidTransport`). */
    createTransport?: () => FetchFn;
}

function printPlanSummary(artifact: MethodPilotPlanArtifact, outPath: string): void {
    console.log(`method-pilot plan written: ${outPath}`);
    console.log(`pilotManifestSha256=${artifact.pilotManifestSha256} rosterDigest=${artifact.rosterDigest} sourceRef=${artifact.sourceRef}`);
    console.log(`queries=${artifact.queryCount} candidates=${artifact.candidateCount} replicas=${artifact.replicaCount}`);
    let total = 0;
    for (const arm of artifact.models) {
        const inventory = artifact.perModel[arm];
        if (inventory === undefined) continue;
        total += inventory.total;
        console.log(
            `  ${arm}: ${inventory.total} requests `
            + `(M0 forward ${inventory.m0Forward}, M1 ${inventory.m1Isolated}, `
            + `M2 reverse ${inventory.m2Reverse}, warmups ${inventory.warmups})`,
        );
    }
    console.log(`total ${total} requests across ${artifact.models.length} models (A1.6: ${A1_6_REQUESTS_PER_MODEL}/model)`);
    console.log("dry-run: no network, no credentials, no campaign-ledger mutation, no synthetic scores");
}

async function runDryRun(
    args: MethodPilotArgs,
    loadInputs: (root: string) => MethodPilotPlanInputs,
): Promise<number> {
    try {
        const inputs = loadInputs(args.pilotRoot);
        const plan = buildMethodPilotPlan(inputs);
        const outPath = args.out as string;
        writePlanAtomic(outPath, serializeMethodPilotPlan(plan.artifact));
        printPlanSummary(plan.artifact, outPath);
        return METHOD_PILOT_EXIT_OK;
    } catch (error) {
        console.error(`error: dry-run failed: ${messageOf(error)}`);
        return METHOD_PILOT_EXIT_USAGE;
    }
}

async function runFull(
    args: MethodPilotArgs,
    loadInputs: (root: string) => MethodPilotPlanInputs,
    options: MethodPilotRunOptions,
): Promise<number> {
    if (!args.authorizePaid) {
        console.error("error: paid gate refused (--mode full): --authorize-paid is required for paid execution; no request was sent");
        return METHOD_PILOT_EXIT_GATE;
    }
    let plan: MethodPilotPlan;
    try {
        plan = buildMethodPilotPlan(loadInputs(args.pilotRoot));
    } catch (error) {
        console.error(`error: paid gate refused: sealed corpus/plan verification failed: ${messageOf(error)}; no request was sent`);
        return METHOD_PILOT_EXIT_GATE;
    }
    if (args.out === undefined || !existsSync(args.out)) {
        console.error(`error: paid gate refused: plan artifact ${args.out ?? "(--out not given)"} does not exist — run --mode dry-run first; no request was sent`);
        return METHOD_PILOT_EXIT_GATE;
    }
    try {
        const stored = readStoredPlan(args.out);
        const mismatch = compareMethodPilotPlans(stored, plan.artifact);
        if (mismatch !== null) {
            console.error(`error: paid gate refused: plan artifact does not match a freshly rebuilt plan (${mismatch}); no request was sent`);
            return METHOD_PILOT_EXIT_GATE;
        }
    } catch (error) {
        console.error(`error: paid gate refused: ${messageOf(error)}; no request was sent`);
        return METHOD_PILOT_EXIT_GATE;
    }
    try {
        await executePilotPlan(plan, args.out, options.createTransport ?? createMethodPilotPaidTransport);
    } catch (error) {
        console.error(`error: paid execution failed: ${messageOf(error)}`);
        return METHOD_PILOT_EXIT_USAGE;
    }
    return METHOD_PILOT_EXIT_OK;
}

/** CLI core: returns the process exit code; never calls `process.exit` itself. */
export async function runMethodPilot(
    argv: readonly string[],
    options: MethodPilotRunOptions = {},
): Promise<number> {
    let args: MethodPilotArgs;
    try {
        args = parseMethodPilotArgs(argv);
    } catch (error) {
        console.error(`error: ${messageOf(error)}`);
        return METHOD_PILOT_EXIT_USAGE;
    }
    if (args.help) {
        printUsage();
        return METHOD_PILOT_EXIT_OK;
    }
    const loadInputs = options.loadInputs ?? loadMethodPilotPlanInputs;
    return args.mode === "dry-run"
        ? runDryRun(args, loadInputs)
        : runFull(args, loadInputs, options);
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : "";
if (invoked === fileURLToPath(import.meta.url)) {
    process.exitCode = await runMethodPilot(process.argv.slice(2));
}
