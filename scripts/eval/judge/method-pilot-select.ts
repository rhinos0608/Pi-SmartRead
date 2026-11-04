#!/usr/bin/env node
/**
 * Stage-E selector input derivation from method-pilot wire records
 * (`method-pilot-select.ts`; protocol §9 Amendment A1.1 scoring, design
 * plan §1).
 *
 * `method-pilot.ts --mode full` persists one `MethodWireRecord` per
 * dispatched HTTP request to `<out>.wire-records.jsonl`; nothing
 * previously converted those records into the rows the preregistered
 * selector (`method-pilot-selector.ts:selectMethodPilotMethod`)
 * consumes. This CLI closes that gap, fail-closed end to end:
 *
 *  1. Load the sealed corpus through `loadVerifiedPilotCorpus`
 *     (Stage B re-verification; the roster carries the runtime brand)
 *     and the plan artifact named by `--plan` (exact shape guard plus
 *     a cross-check against the roster's manifest hash, source ref,
 *     corpus counts, and the roster digest recomputed from the
 *     load-verified roster — `plan.rosterDigest` is never trusted
 *     unverified). Corpus/plan gate failures exit 3.
 *  2. Scan every `--records` JSONL row against the frozen plan: each
 *     row must be a planned request (arm, method, replica, group) with
 *     the plan's payload hash, direction, and candidate order, a
 *     globally unique wireId, and every planned request must have at
 *     least one record (an incomplete run never derives).
 *  3. Bind exactly the three frozen arms × three methods × phase
 *     `pilot` × replicaCount 2 through
 *     `bindMethodComparisonReport` (the M2 envelope admits the reused
 *     M0 forward records, per contract). ANY bind failure is a
 *     rejection that lists the contract failure codes.
 *  4. Derive the selector rows from the bound wire answers — the
 *     contract's own derivation rules (A1.1 line 484): M0/M1 row
 *     `probability` = the wire probability of its single request; M2
 *     rows carry `forward` (the reused M0 forward record's answer)
 *     and `reverse` (the M2 record's answer) separately — the
 *     selector derives `(forward + reverse)/2` itself and never
 *     trusts an upstream average. A component whose attempts all
 *     failed (capture gap, error class) yields a `null` cell — never
 *     0 and never a dropped candidate. Warmup records (queryGroup
 *     null / warmup true) stay bound (they count in the envelope
 *     totals) but never become rows.
 *  5. Run `selectMethodPilotMethod` on the branded roster + rows and
 *     write a JSON verdict (chosen method, the full selector result,
 *     per-model/per-method loss diagnostics, bound-record counts, and
 *     the sha256 of the plan bytes) to `--out` with mode 600, then
 *     print a summary.
 *
 * Exit codes mirror `method-pilot.ts` conventions: 0 ok ·
 * 2 usage/validation failure (bad CLI, unreadable records, plan
 * mismatch inside a row, bind failure, derivation/selector error) ·
 * 3 gate refusal (sealed corpus or plan artifact cannot be verified).
 *
 * Main guard: the CLI runs only when this module is the invoked entry
 * point, so importing never executes.
 */
import { createHash, randomBytes } from "node:crypto";
import {
    closeSync,
    fsyncSync,
    mkdirSync,
    openSync,
    readFileSync,
    renameSync,
    unlinkSync,
    writeSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
    METHOD_CAPTURE_RULESET_VERSION_A3,
    METHOD_COMPARISON_CONTRACT_VERSION,
    METHOD_IDS,
    PILOT_REPLICA_COUNT,
    aggregateCampaignWireCosts,
    bindMethodComparisonReport,
    isMethodWireRecord,
    type MethodBindingTotals,
    type MethodDirection,
    type MethodId,
    type MethodPlannedCandidate,
    type MethodRecordEnvelope,
    type MethodReportBinding,
    type MethodWireRecord,
} from "./method-comparison-contract.js";
import {
    isVerifiedPilotCorpusRoster,
    loadVerifiedPilotCorpus,
    type PilotCorpusRoster,
} from "./method-pilot-fixture.js";
import {
    METHOD_PILOT_PLAN_KIND,
    defaultPilotRoot,
    isMethodPilotPlanArtifact,
    rosterDigestOf,
    type MethodPilotPlanArtifact,
    type MethodPilotPlanRequest,
} from "./method-pilot.js";
import {
    selectMethodPilotMethod,
    type MethodPilotIntegrityFlags,
    type MethodPilotProbabilityRow,
    type MethodPilotSelectorInput,
    type MethodPilotSelectionResult,
} from "./method-pilot-selector.js";
import {
    COMPARISON_SERVED_MODEL_ALLOWLIST,
    isComparisonModelId,
    type ComparisonModelId,
} from "./model-comparison-types.js";

/** Exit codes (method-pilot.ts conventions: 0 ok · 2 validation · 3 gate refusal). */
export const METHOD_PILOT_SELECT_EXIT_OK = 0;
export const METHOD_PILOT_SELECT_EXIT_USAGE = 2;
export const METHOD_PILOT_SELECT_EXIT_GATE = 3;

/** Verdict artifact discriminator (rejects foreign JSON for consumers). */
export const METHOD_PILOT_SELECT_VERDICT_KIND = "method-pilot-select-verdict";

const PILOT_PHASE = "pilot" as const;
/** Key separator (U+0000), the contract's own component-key separator. */
const NUL = String.fromCharCode(0);

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256Hex(value: string): string {
    return createHash("sha256").update(value, "utf-8").digest("hex");
}

function displayKey(key: string): string {
    return key.split(NUL).join("|");
}

/* ──────────────────────────────────────────────────────────────────
 * CLI parsing
 * ────────────────────────────────────────────────────────────────── */

export interface MethodPilotSelectArgs {
    pilotRoot: string;
    records: string;
    plan: string;
    out: string;
    help: boolean;
}

function takeValue(flag: string, argv: readonly string[], index: number): string {
    const value = argv[index];
    if (value === undefined || value.startsWith("--")) {
        throw new Error(`${flag} requires a value`);
    }
    return value;
}

export function parseMethodPilotSelectArgs(argv: readonly string[]): MethodPilotSelectArgs {
    let pilotRoot: string | undefined;
    let records: string | undefined;
    let plan: string | undefined;
    let out: string | undefined;
    let help = false;
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === "--pilot-root") {
            pilotRoot = takeValue(arg, argv, i + 1);
            i += 1;
        } else if (arg === "--records") {
            records = takeValue(arg, argv, i + 1);
            i += 1;
        } else if (arg === "--plan") {
            plan = takeValue(arg, argv, i + 1);
            i += 1;
        } else if (arg === "--out") {
            out = takeValue(arg, argv, i + 1);
            i += 1;
        } else if (arg === "--help" || arg === "-h") {
            help = true;
        } else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }
    if (!help) {
        if (records === undefined) throw new Error("--records is required (wire-records JSONL path)");
        if (plan === undefined) throw new Error("--plan is required (plan artifact path)");
        if (out === undefined) throw new Error("--out is required (verdict output path)");
    }
    // Lazy default: homedir() runs only when --pilot-root is absent.
    return {
        pilotRoot: pilotRoot ?? defaultPilotRoot(),
        records: records ?? "",
        plan: plan ?? "",
        out: out ?? "",
        help,
    };
}

function printUsage(): void {
    console.log("Usage: npx tsx scripts/eval/judge/method-pilot-select.ts --pilot-root DIR --records PATH --plan PATH --out PATH");
    console.log("  Derive the stage-E selector input from method-pilot wire records, run the");
    console.log("  preregistered A1.1 selector, and write a JSON verdict (mode 600) to --out.");
    console.log("  Offline: no network, no credentials, no campaign-ledger mutation.");
    console.log("  Exit codes: 0 ok, 2 usage/validation, 3 corpus/plan gate refusal.");
}

/* ──────────────────────────────────────────────────────────────────
 * Input readers (gate: corpus + plan; validation: records)
 * ────────────────────────────────────────────────────────────────── */

function readJsonlRowsRaw(path: string): unknown[] {
    const content = readFileSync(path, "utf-8");
    const rows: unknown[] = [];
    for (const [index, line] of content.split("\n").entries()) {
        if (line === "") continue;
        try {
            rows.push(JSON.parse(line));
        } catch {
            throw new Error(`method-pilot-select: ${path}: invalid JSON at line ${index + 1}`);
        }
    }
    return rows;
}

function readPlanArtifact(path: string): { artifact: MethodPilotPlanArtifact; sha256: string } {
    const bytes = readFileSync(path, "utf-8");
    let parsed: unknown;
    try {
        parsed = JSON.parse(bytes);
    } catch (error) {
        throw new Error(`plan artifact ${path} is not valid JSON: ${messageOf(error)}`);
    }
    if (!isMethodPilotPlanArtifact(parsed)) {
        throw new Error(`plan artifact ${path} is not a valid ${METHOD_PILOT_PLAN_KIND} artifact`);
    }
    return { artifact: parsed, sha256: sha256Hex(bytes) };
}

/**
 * Cross-check the (already shape-validated) plan against the
 * load-verified roster. Returns the first mismatch message, or null.
 * Both the CLI gate and `deriveMethodPilotSelectorInput` run it, so a
 * direct derivation call cannot skip the binding. The roster digest is
 * RECOMPUTED from the loaded roster with the exact function
 * `method-pilot.ts` used when building the plan (`rosterDigestOf`); a
 * tampered `plan.rosterDigest` fails here, before any record
 * derivation. Gate-class failure: the CLI maps it to exit 3.
 */
export function verifyPlanForRoster(plan: MethodPilotPlanArtifact, roster: PilotCorpusRoster): string | null {
    if (plan.rosterDigest !== rosterDigestOf(roster)) {
        return "method-pilot-select: plan rosterDigest does not match the digest recomputed from the load-verified roster";
    }
    if (plan.pilotManifestSha256 !== roster.manifestSha256) {
        return "method-pilot-select: plan pilotManifestSha256 does not match the load-verified roster";
    }
    if (plan.sourceRef !== roster.sourceRef) {
        return "method-pilot-select: plan sourceRef does not match the load-verified roster";
    }
    if (plan.queryCount !== roster.queries.length) {
        return `method-pilot-select: plan queryCount ${plan.queryCount} does not match roster queries ${roster.queries.length}`;
    }
    if (plan.candidateCount !== roster.candidates.length) {
        return `method-pilot-select: plan candidateCount ${plan.candidateCount} does not match roster candidates ${roster.candidates.length}`;
    }
    return null;
}

/* ──────────────────────────────────────────────────────────────────
 * Plan ↔ records binding (every row must be a planned request)
 * ────────────────────────────────────────────────────────────────── */

interface PlanSlot {
    payloadSha256: string;
    direction: MethodDirection;
    candidateIds: readonly string[];
}

/** One planned-request identity: arm, method, replica, scope, isolated candidate (M1 only). */
function planRequestKey(
    arm: string,
    method: string,
    replica: number,
    scope: string,
    isolated: string,
): string {
    return [arm, method, String(replica), scope, isolated].join(NUL);
}

function planKeyOfRequest(request: MethodPilotPlanRequest): string {
    const isolated = request.method === "M1" ? request.candidateIds[0] ?? "" : "";
    return planRequestKey(request.arm, request.method, request.replica, request.queryGroup ?? "warmup", isolated);
}

function buildPlanIndex(plan: MethodPilotPlanArtifact): Map<string, PlanSlot> {
    const index = new Map<string, PlanSlot>();
    for (const request of plan.requests) {
        const key = planKeyOfRequest(request);
        const existing = index.get(key);
        if (existing !== undefined) {
            if (existing.payloadSha256 !== request.payloadSha256
                || existing.candidateIds.join(NUL) !== request.candidateIds.join(NUL)) {
                throw new Error(`method-pilot-select: plan contains two different requests for ${displayKey(key)}`);
            }
            throw new Error(`method-pilot-select: plan contains a duplicate planned request ${displayKey(key)}`);
        }
        index.set(key, {
            payloadSha256: request.payloadSha256,
            direction: request.direction,
            candidateIds: request.candidateIds,
        });
    }
    return index;
}

/** Request identity of one raw record row, or null when the row carries no recognizable identity. */
function recordIdentityOf(raw: Record<string, unknown>): { key: string; scope: string } | null {
    const scope = raw.queryGroup === null
        ? "warmup"
        : typeof raw.queryGroup === "string" ? raw.queryGroup : null;
    if (scope === null) return null;
    if (typeof raw.arm !== "string" || typeof raw.method !== "string" || typeof raw.replica !== "number") {
        return null;
    }
    let isolated = "";
    if (raw.method === "M1") {
        if (!Array.isArray(raw.candidateIds) || typeof raw.candidateIds[0] !== "string") return null;
        isolated = raw.candidateIds[0] as string;
    }
    return { key: planRequestKey(raw.arm, raw.method, raw.replica, scope, isolated), scope };
}

function assertRecordMatchesSlot(raw: Record<string, unknown>, slot: PlanSlot, at: string): void {
    if (raw.payloadSha256 !== slot.payloadSha256) {
        throw new Error(`method-pilot-select: ${at}: payloadSha256 disagrees with the frozen plan`);
    }
    if (raw.direction !== slot.direction) {
        throw new Error(`method-pilot-select: ${at}: direction disagrees with the frozen plan`);
    }
    const candidateIds: unknown = raw.candidateIds;
    if (!Array.isArray(candidateIds)
        || candidateIds.length !== slot.candidateIds.length
        || !slot.candidateIds.every((cid, index) => candidateIds[index] === cid)) {
        throw new Error(`method-pilot-select: ${at}: candidate order disagrees with the frozen plan`);
    }
}

function assertRecordsMatchPlan(rows: readonly unknown[], planIndex: ReadonlyMap<string, PlanSlot>): void {
    const seenWireIds = new Set<string>();
    const seenSlots = new Set<string>();
    rows.forEach((raw, index) => {
        const at = `records row ${index + 1}`;
        if (!isPlainObject(raw)) throw new Error(`method-pilot-select: ${at} is not an object`);
        const identity = recordIdentityOf(raw);
        if (identity === null) {
            throw new Error(`method-pilot-select: ${at} does not match a planned request (unrecognized identity)`);
        }
        const slot = planIndex.get(identity.key);
        if (slot === undefined) {
            throw new Error(`method-pilot-select: ${at} (${displayKey(identity.key)}) is not a planned request in the frozen plan`);
        }
        assertRecordMatchesSlot(raw, slot, `${at} (${displayKey(identity.key)})`);
        if (typeof raw.wireId !== "string" || raw.wireId.length === 0) {
            throw new Error(`method-pilot-select: ${at} has no usable wireId`);
        }
        if (seenWireIds.has(raw.wireId)) {
            throw new Error(`method-pilot-select: ${at} duplicates wireId ${raw.wireId}`);
        }
        seenWireIds.add(raw.wireId);
        seenSlots.add(identity.key);
    });
    const missing = [...planIndex.keys()].filter((key) => !seenSlots.has(key));
    if (missing.length > 0) {
        const shown = missing.slice(0, 3).map(displayKey).join(", ");
        throw new Error(
            `method-pilot-select: ${missing.length} of ${planIndex.size} planned request(s) have no wire record `
            + `(incomplete run; first missing: ${shown})`,
        );
    }
}

/* ──────────────────────────────────────────────────────────────────
 * Envelope binding (3 arms × 3 methods, phase pilot, replicaCount 2)
 * ────────────────────────────────────────────────────────────────── */

interface EnvelopeBinding {
    arm: ComparisonModelId;
    method: MethodId;
    binding: Extract<MethodReportBinding, { ok: true }>;
}

/** Wire rows belonging to one envelope: by arm, plus the method partition (M2 also admits the reused M0 records). */
function rawPartition(rows: readonly unknown[], arm: ComparisonModelId, method: MethodId): unknown[] {
    return rows.filter((raw) => {
        if (!isPlainObject(raw)) return false;
        if (raw.arm !== arm) return false;
        if (method === "M2") return raw.method === "M0" || raw.method === "M2";
        return raw.method === method;
    });
}

type ComponentIndex = Map<string, Map<number, MethodWireRecord[]>>;

/** Component key: arm, method, scope (query group or "warmup"), direction, isolated candidate (M1). */
function componentKey(arm: string, method: MethodId, scope: string, direction: MethodDirection, isolated: string): string {
    return [arm, method, scope, direction, isolated].join(NUL);
}

function recordComponentKey(record: MethodWireRecord): string {
    return componentKey(
        record.arm,
        record.method,
        record.queryGroup ?? "warmup",
        record.direction,
        record.direction === "isolated" ? record.candidateIds.join(NUL) : "",
    );
}

function buildComponentIndex(records: Iterable<MethodWireRecord>): ComponentIndex {
    const index: ComponentIndex = new Map();
    for (const record of records) {
        const key = recordComponentKey(record);
        let byReplica = index.get(key);
        if (byReplica === undefined) {
            byReplica = new Map();
            index.set(key, byReplica);
        }
        const bucket = byReplica.get(record.replica);
        if (bucket === undefined) byReplica.set(record.replica, [record]);
        else bucket.push(record);
    }
    return index;
}

function componentAt(index: ComponentIndex, key: string, replica: number): MethodWireRecord[] | undefined {
    return index.get(key)?.get(replica);
}

/**
 * The answer one component produced for one candidate: null when every
 * attempt failed (capture gap / error class). Post-bind, successful
 * retries must agree (the binder enforces it), so the first successful
 * attempt is the component's answer; a successful attempt missing the
 * answer is unreachable after a successful bind and fails closed to
 * null (an incomplete cell) rather than inventing a number.
 */
function boundAnswer(records: readonly MethodWireRecord[], candidateId: string): number | null {
    for (const record of records) {
        if (record.errorClass !== null) continue;
        const answer = record.answers.find((entry) => entry.candidateId === candidateId);
        if (answer === undefined) return null;
        return answer.probability;
    }
    return null;
}

/**
 * One derived score per planned candidate × replica, recomputed from
 * this envelope's wire records exactly as the contract defines them:
 * M0/M1 = the wire probability; M2 = (forward + reverse)/2, null when
 * either leg is unjudged. Components absent from the wire table are
 * skipped — the binder's coverage rule reports them as
 * `missing_wire_coverage` / `missing_derived_coverage`.
 */
function buildDerivedScores(
    envelope: MethodRecordEnvelope,
    planned: readonly MethodPlannedCandidate[],
    typed: readonly MethodWireRecord[],
): unknown[] {
    const components = buildComponentIndex(typed);
    const derived: unknown[] = [];
    for (const candidate of planned) {
        for (let replica = 0; replica < PILOT_REPLICA_COUNT; replica += 1) {
            const ids: string[] = [];
            let probability: number | null;
            if (envelope.method === "M0" || envelope.method === "M1") {
                const direction: MethodDirection = envelope.method === "M0" ? "forward" : "isolated";
                const isolated = envelope.method === "M1" ? candidate.candidateId : "";
                const component = componentAt(components, componentKey(envelope.arm, envelope.method, candidate.queryGroup, direction, isolated), replica);
                if (component === undefined) continue;
                ids.push(...component.map((record) => record.wireId));
                probability = boundAnswer(component, candidate.candidateId);
            } else {
                const forward = componentAt(components, componentKey(envelope.arm, "M0", candidate.queryGroup, "forward", ""), replica);
                const reverse = componentAt(components, componentKey(envelope.arm, "M2", candidate.queryGroup, "reverse", ""), replica);
                if (forward === undefined && reverse === undefined) continue;
                if (forward !== undefined) ids.push(...forward.map((record) => record.wireId));
                if (reverse !== undefined) ids.push(...reverse.map((record) => record.wireId));
                const forwardAnswer = forward === undefined ? null : boundAnswer(forward, candidate.candidateId);
                const reverseAnswer = reverse === undefined ? null : boundAnswer(reverse, candidate.candidateId);
                probability = forwardAnswer === null || reverseAnswer === null
                    ? null
                    : (forwardAnswer + reverseAnswer) / 2;
            }
            derived.push({
                method: envelope.method,
                arm: envelope.arm,
                phase: envelope.phase,
                replica,
                queryGroup: candidate.queryGroup,
                candidateId: candidate.candidateId,
                probability,
                wireIds: ids,
            });
        }
    }
    return derived;
}

function bindEnvelopes(
    roster: PilotCorpusRoster,
    arms: readonly ComparisonModelId[],
    planned: readonly MethodPlannedCandidate[],
    rows: readonly unknown[],
): EnvelopeBinding[] {
    const envelopes: EnvelopeBinding[] = [];
    const failures: string[] = [];
    for (const arm of arms) {
        for (const method of METHOD_IDS) {
            const envelope: MethodRecordEnvelope = {
                contractVersion: METHOD_COMPARISON_CONTRACT_VERSION,
                method,
                arm,
                phase: PILOT_PHASE,
                replicaCount: PILOT_REPLICA_COUNT,
                manifestSha256: roster.manifestSha256,
            };
            const wire = rawPartition(rows, arm, method);
            const derivedScores = buildDerivedScores(envelope, planned, wire.filter(isMethodWireRecord));
            const binding = bindMethodComparisonReport({
                envelope,
                plannedCandidates: planned,
                wireRecords: wire,
                derivedScores,
            });
            if (binding.ok) envelopes.push({ arm, method, binding });
            else failures.push(`${arm}/${method}: ${binding.failures.join(",")}`);
        }
    }
    if (failures.length > 0) {
        throw new Error(`method-pilot-select: bindMethodComparisonReport failed (fail-closed) — ${failures.join("; ")}`);
    }
    return envelopes;
}

/* ──────────────────────────────────────────────────────────────────
 * Row derivation (A1.1 line 484 inputs; warmups excluded, nulls kept)
 * ────────────────────────────────────────────────────────────────── */

function requireComponent(
    components: ComponentIndex,
    key: string,
    replica: number,
    label: string,
): MethodWireRecord[] {
    const records = componentAt(components, key, replica);
    if (records === undefined) {
        // Unreachable: every envelope bound with complete wire coverage,
        // so the component exists for every planned candidate × replica.
        throw new Error(`method-pilot-select: internal: missing bound component for ${label} after a successful bind`);
    }
    return records;
}

type RosterCandidate = PilotCorpusRoster["candidates"][number];

function candidatesByQuery(roster: PilotCorpusRoster): Map<string, RosterCandidate[]> {
    const byQuery = new Map<string, RosterCandidate[]>();
    for (const candidate of roster.candidates) {
        const list = byQuery.get(candidate.qid);
        if (list === undefined) byQuery.set(candidate.qid, [candidate]);
        else list.push(candidate);
    }
    return byQuery;
}

function rowsForMethod(
    arm: ComparisonModelId,
    method: MethodId,
    roster: PilotCorpusRoster,
    byQuery: ReadonlyMap<string, RosterCandidate[]>,
    components: ComponentIndex,
): MethodPilotProbabilityRow[] {
    const rows: MethodPilotProbabilityRow[] = [];
    for (const query of roster.queries) {
        for (const candidate of byQuery.get(query.qid) ?? []) {
            for (let replica = 0; replica < PILOT_REPLICA_COUNT; replica += 1) {
                const base = {
                    model: arm,
                    method,
                    queryGroup: query.qid,
                    candidateId: candidate.cid,
                    label: candidate.label,
                    replica,
                };
                if (method === "M1") {
                    const component = requireComponent(
                        components,
                        componentKey(arm, "M1", query.qid, "isolated", candidate.cid),
                        replica,
                        `${arm} M1 ${query.qid} ${candidate.cid} r${replica}`,
                    );
                    rows.push({ ...base, probability: boundAnswer(component, candidate.cid), forward: null, reverse: null });
                } else if (method === "M2") {
                    const forward = requireComponent(
                        components,
                        componentKey(arm, "M0", query.qid, "forward", ""),
                        replica,
                        `${arm} M2 forward ${query.qid} r${replica}`,
                    );
                    const reverse = requireComponent(
                        components,
                        componentKey(arm, "M2", query.qid, "reverse", ""),
                        replica,
                        `${arm} M2 reverse ${query.qid} r${replica}`,
                    );
                    rows.push({
                        ...base,
                        probability: null,
                        forward: boundAnswer(forward, candidate.cid),
                        reverse: boundAnswer(reverse, candidate.cid),
                    });
                } else {
                    const forward = requireComponent(
                        components,
                        componentKey(arm, "M0", query.qid, "forward", ""),
                        replica,
                        `${arm} M0 forward ${query.qid} r${replica}`,
                    );
                    rows.push({ ...base, probability: boundAnswer(forward, candidate.cid), forward: null, reverse: null });
                }
            }
        }
    }
    return rows;
}

function buildRows(
    arms: readonly ComparisonModelId[],
    roster: PilotCorpusRoster,
    components: ComponentIndex,
): MethodPilotProbabilityRow[] {
    const byQuery = candidatesByQuery(roster);
    const rows: MethodPilotProbabilityRow[] = [];
    for (const arm of arms) {
        for (const method of METHOD_IDS) {
            rows.push(...rowsForMethod(arm, method, roster, byQuery, components));
        }
    }
    return rows;
}

/* ──────────────────────────────────────────────────────────────────
 * Integrity flags (A1.1 qualification 5), derived from bound records
 * ────────────────────────────────────────────────────────────────── */

function hasComponentDrift(records: readonly MethodWireRecord[]): boolean {
    const first = new Map<string, MethodWireRecord>();
    for (const record of records) {
        const key = recordComponentKey(record);
        const baseline = first.get(key);
        if (baseline === undefined) {
            first.set(key, record);
            continue;
        }
        if (record.payloadSha256 !== baseline.payloadSha256) return true;
        if (record.candidateIds.join(NUL) !== baseline.candidateIds.join(NUL)) return true;
    }
    return false;
}

/**
 * Amendment A3 (PROSPECTIVE, protocol §12): true when any planned
 * component × replica's FINAL attempt (highest attemptIndex — the
 * binder enforces gapless attemptIndex per component × replica, so
 * the final attempt is well-defined) is not a verified success: a 2xx
 * settlement with no error class and a served model on the arm's
 * allowlist. A transport error whose LATER attempt for the same
 * planned payload succeeded with verified identity (RECOVERED) does
 * NOT flag — only each component's final attempt is judged.
 */
function hasUnverifiedFinalAttempt(records: readonly MethodWireRecord[]): boolean {
    const finalByComponent = new Map<string, MethodWireRecord>();
    for (const record of records) {
        const key = `${recordComponentKey(record)}${NUL}${String(record.replica)}`;
        const current = finalByComponent.get(key);
        if (current === undefined || record.attemptIndex > current.attemptIndex) {
            finalByComponent.set(key, record);
        }
    }
    for (const final of finalByComponent.values()) {
        if (final.errorClass !== null) return true;
        if (final.servedModel !== COMPARISON_SERVED_MODEL_ALLOWLIST[final.arm]) return true;
    }
    return false;
}

function buildIntegrity(envelopes: readonly EnvelopeBinding[], a3Rules: boolean): MethodPilotIntegrityFlags[] {
    return envelopes.map(({ arm, method, binding }) => ({
        model: arm,
        method,
        servedIdentityDrift: binding.wireRecords.some(
            (record) => record.servedModel !== null && record.servedModel !== COMPARISON_SERVED_MODEL_ALLOWLIST[record.arm],
        ),
        payloadDrift: hasComponentDrift(binding.wireRecords),
        // Amendment A3 does not soften this: `capture_gap` is reserved for a
        // 2xx whose served identity could not be captured, and ANY such
        // record still flags the envelope that binds it.
        captureGap: binding.wireRecords.some((record) => record.errorClass === "capture_gap"),
        // An aborted run leaves planned components without wire records;
        // the binder's wire-coverage rule rejects that envelope outright
        // (and `requireComponent` re-checks every component the rows
        // read), so no run with a missing component reaches this point.
        abortedRun: false,
        // Amendment A3 (PROSPECTIVE, protocol §12): only A3-stamped records
        // are judged by the final-attempt rule; A1/A2-era derivations
        // always set this flag false (the rule did not exist then, so the
        // recorded 2026-10-09 pilot verdict stays reproducible).
        finalAttemptUnverified: a3Rules && hasUnverifiedFinalAttempt(binding.wireRecords),
    }));
}

/* ──────────────────────────────────────────────────────────────────
 * Ruleset era detection (Amendment A3, fail-closed)
 * ────────────────────────────────────────────────────────────────── */

/** Wire-records era: "A1/A2" (unstamped records) or "A3" (every record carries the A3 stamp). */
export type MethodPilotRulesetVersion = typeof METHOD_CAPTURE_RULESET_VERSION_A3 | "A1/A2";

/**
 * Amendment A3 (PROSPECTIVE, protocol §12.A3.4): the records file
 * alone decides which capture rules apply. All records unstamped →
 * A1/A2 era. All records stamped `rulesetVersion: "A3"` → A3 era. Any
 * other stamp value, or a file mixing stamped and unstamped records,
 * is refused (fail closed) — a pre-A3 artifact can never be silently
 * relabeled into the A3 era, and the 2026-10-09 pilot records (all
 * unstamped) can never be re-derived under A3 rules.
 */
export function detectMethodPilotRulesetVersion(rows: readonly unknown[]): MethodPilotRulesetVersion {
    let stamped = 0;
    let unstamped = 0;
    for (const row of rows) {
        if (!isPlainObject(row)) continue; // shape errors surface in the plan/binder checks
        if (row.rulesetVersion === undefined) {
            unstamped += 1;
            continue;
        }
        if (row.rulesetVersion !== METHOD_CAPTURE_RULESET_VERSION_A3) {
            throw new Error(
                `method-pilot-select: unknown wire-record rulesetVersion ${JSON.stringify(row.rulesetVersion)} `
                + `(fail closed; only "${METHOD_CAPTURE_RULESET_VERSION_A3}" exists)`,
            );
        }
        stamped += 1;
    }
    if (stamped > 0 && unstamped > 0) {
        throw new Error(
            `method-pilot-select: mixed-era records file (${stamped} A3-stamped, ${unstamped} unstamped) `
            + "— ruleset era boundaries are fail-closed",
        );
    }
    return stamped > 0 ? METHOD_CAPTURE_RULESET_VERSION_A3 : "A1/A2";
}

/* ──────────────────────────────────────────────────────────────────
 * Derivation entry point
 * ────────────────────────────────────────────────────────────────── */

/** One envelope's bound totals for the verdict (per-envelope; the reused forward request appears in two envelopes). */
export interface MethodPilotSelectEnvelopeTotals {
    arm: ComparisonModelId;
    method: MethodId;
    totals: MethodBindingTotals;
}

export interface MethodPilotSelectDerivation {
    /** Sealed selector input: branded roster + rows + integrity entries (exactly one per arm × method). */
    input: MethodPilotSelectorInput;
    envelopeTotals: readonly MethodPilotSelectEnvelopeTotals[];
    /** Physical wire requests across all envelopes, deduplicated by wireId (the supported aggregation). */
    uniqueWireRequestCount: number;
    /** Rows read from the records file (retries included). */
    recordRowCount: number;
    /** The frozen arm order the derivation used (plan models). */
    arms: readonly ComparisonModelId[];
    /** Capture-rule era the records file declared (Amendment A3 boundary). */
    rulesetVersion: MethodPilotRulesetVersion;
}

export interface MethodPilotSelectOptions {
    /**
     * Fail-closed refusal seam: when set (e.g. "A3"), the derivation
     * refuses (throws) unless EVERY wire record carries that ruleset
     * stamp — A3 rules are never applied to pre-A3 artifacts
     * (protocol §12.A3.4). Omitted → era auto-detected from the records.
     */
    ruleset?: MethodPilotRulesetVersion;
}

function plannedCandidatesOf(roster: PilotCorpusRoster): MethodPlannedCandidate[] {
    const planned: MethodPlannedCandidate[] = [];
    for (const query of roster.queries) {
        for (const candidate of roster.candidates) {
            if (candidate.qid === query.qid) planned.push({ queryGroup: query.qid, candidateId: candidate.cid });
        }
    }
    return planned;
}

/**
 * Fail-closed derivation: branded roster + plan artifact + raw record
 * rows → the stage-E selector input plus bound-record diagnostics.
 * Throws on any brand/plan/records mismatch or any
 * `bindMethodComparisonReport` failure (the message lists the
 * contract failure codes). Warmups stay in the bound wire tables but
 * never become rows; failed components become `null` cells.
 */
export function deriveMethodPilotSelectorInput(
    roster: PilotCorpusRoster,
    plan: MethodPilotPlanArtifact,
    recordRows: readonly unknown[],
    options: MethodPilotSelectOptions = {},
): MethodPilotSelectDerivation {
    if (!isVerifiedPilotCorpusRoster(roster)) {
        throw new Error(
            "method-pilot-select: roster is not a load-verified sealed corpus roster "
            + "(brand from Stage B loadVerifiedPilotCorpus required)",
        );
    }
    if (!isMethodPilotPlanArtifact(plan)) {
        throw new Error(`method-pilot-select: plan is not a valid ${METHOD_PILOT_PLAN_KIND} artifact`);
    }
    const mismatch = verifyPlanForRoster(plan, roster);
    if (mismatch !== null) throw new Error(mismatch);
    const rulesetVersion = detectMethodPilotRulesetVersion(recordRows);
    if (options.ruleset !== undefined && options.ruleset !== rulesetVersion) {
        throw new Error(
            `method-pilot-select: refusing to apply ${options.ruleset} rules to a ${rulesetVersion} records file `
            + "(fail closed; Amendment A3 applies only to A3-stamped artifacts — protocol §12.A3.4)",
        );
    }
    const a3Rules = rulesetVersion === METHOD_CAPTURE_RULESET_VERSION_A3;
    const arms = plan.models.filter(isComparisonModelId);
    if (arms.length !== plan.models.length) {
        throw new Error("method-pilot-select: plan models are not frozen ComparisonModelId arms");
    }
    const planned = plannedCandidatesOf(roster);
    const planIndex = buildPlanIndex(plan);
    assertRecordsMatchPlan(recordRows, planIndex);
    const envelopes = bindEnvelopes(roster, arms, planned, recordRows);

    const union = new Map<string, MethodWireRecord>();
    for (const envelope of envelopes) {
        for (const record of envelope.binding.wireRecords) union.set(record.wireId, record);
    }
    const rows = buildRows(arms, roster, buildComponentIndex(union.values()));
    const integrity = buildIntegrity(envelopes, a3Rules);
    const aggregate = aggregateCampaignWireCosts(envelopes.map((envelope) => envelope.binding));
    if (!aggregate.ok) {
        throw new Error(`method-pilot-select: campaign wire aggregation failed (${aggregate.failures.join(",")})`);
    }
    return {
        input: { roster, rows, integrity },
        envelopeTotals: envelopes.map(({ arm, method, binding }) => ({ arm, method, totals: binding.totals })),
        uniqueWireRequestCount: aggregate.totals.uniqueWireRequestCount,
        recordRowCount: recordRows.length,
        arms,
        rulesetVersion,
    };
}

/* ──────────────────────────────────────────────────────────────────
 * Verdict artifact
 * ────────────────────────────────────────────────────────────────── */

export interface MethodPilotSelectVerdict {
    kind: string;
    /** ONE common method for all three frozen arms (A1.1 line 498). */
    chosenMethod: MethodId;
    /** The full selector result: inconclusive flag, baseline block reasons, S_m, D_m, bootstrap, guards. */
    selector: MethodPilotSelectionResult;
    /** Per-model/per-method diagnostics: L_{a,m}, FN_{a,m}, and L_{a,m}/Q (the S_m per-model contribution). */
    perModelPerMethod: ReadonlyArray<{
        model: ComparisonModelId;
        method: MethodId;
        loss: number | null;
        fn: number | null;
        lossPerQuery: number | null;
    }>;
    boundRecordCounts: {
        recordRows: number;
        uniqueWireRequests: number;
        envelopes: ReadonlyArray<{
            model: ComparisonModelId;
            method: MethodId;
            wireRequestCount: number;
            warmupRequests: number;
        }>;
    };
    /** sha256 over the exact plan artifact bytes read from --plan. */
    planSha256: string;
    roster: {
        sourceRef: string;
        manifestSha256: string;
        queryCount: number;
        candidateCount: number;
    };
    /**
     * Amendment A3 marker: present (="A3") exactly when the wire records
     * were A3-stamped; ABSENT on A1/A2-era verdicts so the recorded
     * 2026-10-09 pilot verdict stays byte-reproducible. Its presence is
     * what makes A3-era and A1/A2-era artifacts distinguishable.
     */
    rulesetVersion?: typeof METHOD_CAPTURE_RULESET_VERSION_A3;
}

function buildPerModelDiagnostics(
    selector: MethodPilotSelectionResult,
    arms: readonly ComparisonModelId[],
): MethodPilotSelectVerdict["perModelPerMethod"] {
    const rows: MethodPilotSelectVerdict["perModelPerMethod"][number][] = [];
    for (const arm of arms) {
        for (const metrics of selector.methods) {
            const loss = metrics.lossByModel === null ? null : metrics.lossByModel[arm];
            const fn = metrics.fnByModel === null ? null : metrics.fnByModel[arm];
            rows.push({
                model: arm,
                method: metrics.method,
                loss,
                fn,
                lossPerQuery: loss === null ? null : loss / selector.queryCount,
            });
        }
    }
    return rows;
}

export function buildMethodPilotSelectVerdict(
    selector: MethodPilotSelectionResult,
    derivation: MethodPilotSelectDerivation,
    planSha256: string,
    roster: PilotCorpusRoster,
): MethodPilotSelectVerdict {
    return {
        kind: METHOD_PILOT_SELECT_VERDICT_KIND,
        chosenMethod: selector.selected,
        selector,
        perModelPerMethod: buildPerModelDiagnostics(selector, derivation.arms),
        boundRecordCounts: {
            recordRows: derivation.recordRowCount,
            uniqueWireRequests: derivation.uniqueWireRequestCount,
            envelopes: derivation.envelopeTotals.map(({ arm, method, totals }) => ({
                model: arm,
                method,
                wireRequestCount: totals.wireRequestCount,
                warmupRequests: totals.warmupRequests,
            })),
        },
        planSha256,
        roster: {
            sourceRef: roster.sourceRef,
            manifestSha256: roster.manifestSha256,
            queryCount: roster.queries.length,
            candidateCount: roster.candidates.length,
        },
        // A3-only marker (conditional so A1/A2-era verdict bytes are unchanged).
        ...(derivation.rulesetVersion === METHOD_CAPTURE_RULESET_VERSION_A3
            ? { rulesetVersion: METHOD_CAPTURE_RULESET_VERSION_A3 }
            : {}),
    };
}

/* ──────────────────────────────────────────────────────────────────
 * Atomic verdict write (unique temp + rename, mode 600)
 * ────────────────────────────────────────────────────────────────── */

function writeVerdictAtomic(outPath: string, body: string): void {
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

function printVerdictSummary(verdict: MethodPilotSelectVerdict, outPath: string): void {
    console.log(`method-pilot-select verdict written: ${outPath}`);
    console.log(`chosen method: ${verdict.chosenMethod} (inconclusive: ${verdict.selector.inconclusive})`);
    console.log(`S_m: ${verdict.selector.methods.map((m) => `${m.method}=${m.s === null ? "n/a" : String(m.s)}`).join(" ")}`);
    console.log(
        `bound records: ${verdict.boundRecordCounts.recordRows} rows, `
        + `${verdict.boundRecordCounts.uniqueWireRequests} unique wire requests across `
        + `${verdict.boundRecordCounts.envelopes.length} envelopes (reused forward requests counted once)`,
    );
    console.log(`plan sha256=${verdict.planSha256} rosterManifestSha256=${verdict.roster.manifestSha256}`);
}

/* ──────────────────────────────────────────────────────────────────
 * Orchestration
 * ────────────────────────────────────────────────────────────────── */

export interface MethodPilotSelectRunOptions {
    /** Test seam: replace Stage B's loader (production: `loadVerifiedPilotCorpus`). */
    loadRoster?: (root: string) => PilotCorpusRoster;
}

/** CLI core: returns the process exit code; never calls `process.exit` itself. */
export async function runMethodPilotSelect(
    argv: readonly string[],
    options: MethodPilotSelectRunOptions = {},
): Promise<number> {
    let args: MethodPilotSelectArgs;
    try {
        args = parseMethodPilotSelectArgs(argv);
    } catch (error) {
        console.error(`error: ${messageOf(error)}`);
        return METHOD_PILOT_SELECT_EXIT_USAGE;
    }
    if (args.help) {
        printUsage();
        return METHOD_PILOT_SELECT_EXIT_OK;
    }

    // Gate (exit 3): the sealed corpus and the plan artifact verify together.
    let roster: PilotCorpusRoster;
    let plan: MethodPilotPlanArtifact;
    let planSha256: string;
    try {
        roster = (options.loadRoster ?? loadVerifiedPilotCorpus)(args.pilotRoot);
        if (!isVerifiedPilotCorpusRoster(roster)) {
            throw new Error("method-pilot-select: roster is not a load-verified sealed corpus roster (Stage B brand required)");
        }
        ({ artifact: plan, sha256: planSha256 } = readPlanArtifact(args.plan));
        const mismatch = verifyPlanForRoster(plan, roster);
        if (mismatch !== null) throw new Error(mismatch);
    } catch (error) {
        console.error(`error: pilot/plan gate refused: ${messageOf(error)}; no verdict written`);
        return METHOD_PILOT_SELECT_EXIT_GATE;
    }

    // Validation (exit 2): records → plan binding → envelope binds → rows → selector.
    let verdict: MethodPilotSelectVerdict;
    try {
        const recordRows = readJsonlRowsRaw(args.records);
        const derivation = deriveMethodPilotSelectorInput(roster, plan, recordRows);
        const selector = selectMethodPilotMethod(derivation.input);
        verdict = buildMethodPilotSelectVerdict(selector, derivation, planSha256, roster);
    } catch (error) {
        console.error(`error: ${messageOf(error)}; no verdict written`);
        return METHOD_PILOT_SELECT_EXIT_USAGE;
    }

    try {
        writeVerdictAtomic(args.out, `${JSON.stringify(verdict, null, 2)}\n`);
    } catch (error) {
        console.error(`error: failed to write verdict ${args.out}: ${messageOf(error)}`);
        return METHOD_PILOT_SELECT_EXIT_USAGE;
    }
    printVerdictSummary(verdict, args.out);
    return METHOD_PILOT_SELECT_EXIT_OK;
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : "";
if (invoked === fileURLToPath(import.meta.url)) {
    process.exitCode = await runMethodPilotSelect(process.argv.slice(2));
}
