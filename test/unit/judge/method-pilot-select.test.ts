/**
 * Stage-E selector input derivation (`scripts/eval/judge/method-pilot-select.ts`).
 *
 * All derivation/gate fixtures are SYNTHETIC: a branded
 * 40-query/280-candidate roster built through the documented
 * `__test__brandPilotCorpusRoster` seam, a plan from
 * `buildMethodPilotPlan`, and wire records generated FROM that plan
 * (payload hashes and candidate orders match by construction). No
 * synthetic test reads any real `<pilot-root>/pilot-plan-*.wire-records.jsonl`,
 * so a concurrent paid run is never consumed. The single exception is
 * the `it.runIf`-gated sealed-corpus digest test below: it re-verifies
 * the sealed roster (read-only) and reads the stored plan FILE (never
 * its wire records) to prove the real `rosterDigest` is reproducible.
 *
 * Hand-computed scenario ("happy"): queries p001..p020 are type A,
 * p021..p040 are type B; first candidate of each query is gold, the
 * other six are hard negatives. Per replica:
 *   M0 forward:  gold A .8, gold B .3, negative .5
 *   M1 isolated: gold .3/.5 (mean exactly .40 -> keep, equality rule),
 *                negative .1 (drop)
 *   M2 reverse:  gold A .3, gold B .8, negative .4
 * => S_0 = (720 FP + 20x6x3 FN penalty) / 120 = 1080/120 = 9
 *    S_1 = 0 (replica MEAN keeps every gold at .40; a per-replica AND
 *             read would drop replica 0 and yield 6)
 *    S_2 = 720/120 = 6 (averaged legs keep every gold at .55 and every
 *         negative at .45; a forward-only read yields 9 via type-B
 *         gold FNs and a reverse-only read yields 9 via type-A gold
 *         FNs - so 6 discriminates the (f+r)/2 derivation from both)
 * => D_1 = 9, D_2 = 3, both qualify, lower S_m wins => chosen M1.
 *
 * Capture-gap scenarios replace exactly one component's record with
 * the contract's capture-gap shape (real status, null identity, null
 * answers): the cell derives to null, never 0 and never dropped.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MethodWireRecord } from "../../../scripts/eval/judge/method-comparison-contract.js";
import { METHOD_CAPTURE_RULESET_VERSION_A3, isMethodWireRecord } from "../../../scripts/eval/judge/method-comparison-contract.js";
import {
    PILOT_SOURCE_REF,
    __test__brandPilotCorpusRoster,
    loadVerifiedPilotCorpus,
    type PilotCorpusRoster,
    type PilotLabel,
} from "../../../scripts/eval/judge/method-pilot-fixture.js";
import {
    METHOD_PILOT_SELECT_EXIT_GATE,
    METHOD_PILOT_SELECT_EXIT_OK,
    METHOD_PILOT_SELECT_EXIT_USAGE,
    METHOD_PILOT_SELECT_VERDICT_KIND,
    buildMethodPilotSelectVerdict,
    deriveMethodPilotSelectorInput,
    detectMethodPilotRulesetVersion,
    runMethodPilotSelect,
    verifyPlanForRoster,
    type MethodPilotSelectVerdict,
} from "../../../scripts/eval/judge/method-pilot-select.js";
import {
    buildMethodPilotPlan,
    defaultPilotRoot,
    isMethodPilotPlanArtifact,
    rosterDigestOf,
    serializeMethodPilotPlan,
    type MethodPilotPlanArtifact,
    type MethodPilotPlanInputs,
    type MethodPilotPlanRequest,
} from "../../../scripts/eval/judge/method-pilot.js";
import { selectMethodPilotMethod, type MethodPilotProbabilityRow } from "../../../scripts/eval/judge/method-pilot-selector.js";
import { INCUMBENT_ARM } from "../../../scripts/eval/judge/model-comparison-stats.js";
import {
    COMPARISON_SERVED_MODEL_ALLOWLIST,
    isComparisonModelId,
    type ComparisonModelId,
} from "../../../scripts/eval/judge/model-comparison-types.js";

const sha = (seed: string): string => createHash("sha256").update(seed).digest("hex");

/* ──────────────────────────────────────────────────────────────────
 * Synthetic sealed inputs, plan, and plan-derived wire records
 * ────────────────────────────────────────────────────────────────── */

function syntheticInputs(): MethodPilotPlanInputs {
    const queries: Array<{ qid: string; answerable: boolean }> = [];
    const candidates: Array<{ cid: string; qid: string; file: string; startLine: number; endLine: number; label: PilotLabel }> = [];
    const queryTexts = new Map<string, string>();
    const candidateStates = new Map<string, { qid: string; state: Record<string, string> }>();
    for (let qi = 1; qi <= 40; qi += 1) {
        const qid = `p${String(qi).padStart(3, "0")}`;
        queries.push({ qid, answerable: qi <= 32 });
        queryTexts.set(qid, `How does component ${qid} behave when a dependency is missing?`);
        for (let ci = 1; ci <= 7; ci += 1) {
            const cid = `${qid}-c${String(ci).padStart(2, "0")}`;
            candidates.push({
                cid,
                qid,
                file: `src/mod${qi}.ts`,
                startLine: 1,
                endLine: 20,
                label: ci === 1 ? "gold" : "hard_negative",
            });
            candidateStates.set(cid, {
                qid,
                state: { path: `src/mod${qi}.ts`, symbol: `f${ci}`, text: `export function f${ci}() { return "${cid}"; }` },
            });
        }
    }
    const roster: PilotCorpusRoster = __test__brandPilotCorpusRoster({
        queries,
        candidates,
        sourceRef: PILOT_SOURCE_REF,
        manifestSha256: sha("synthetic-method-pilot-select-manifest"),
    });
    return {
        roster,
        queryTexts,
        candidateStates: candidateStates as MethodPilotPlanInputs["candidateStates"],
    };
}

const INPUTS = syntheticInputs();
const ROSTER = INPUTS.roster;
const PLAN: MethodPilotPlanArtifact = buildMethodPilotPlan(INPUTS).artifact;
const PLAN_BYTES = serializeMethodPilotPlan(PLAN);
const LABEL_BY_CID = new Map(ROSTER.candidates.map((candidate) => [candidate.cid, candidate.label]));

const GAP_ARM: ComparisonModelId = INCUMBENT_ARM;
const GAP_QUERY = "p001";
const GAP_CID = "p001-c01";

type Scenario = "happy" | "gap-m0" | "gap-m1";

/** See the module header for the full hand computation behind these constants. */
function syntheticAnswer(method: "M0" | "M1" | "M2", qid: string, candidateId: string, replica: number): number {
    const label = LABEL_BY_CID.get(candidateId);
    if (label === undefined) throw new Error(`synthetic answer for unknown candidate ${candidateId}`);
    const typeA = Number(qid.slice(1)) <= 20;
    if (method === "M0") return label === "gold" ? (typeA ? 0.8 : 0.3) : 0.5;
    if (method === "M1") return label === "gold" ? (replica === 0 ? 0.3 : 0.5) : 0.1;
    return label === "gold" ? (typeA ? 0.3 : 0.8) : 0.4;
}

function requireModelId(arm: string): ComparisonModelId {
    if (!isComparisonModelId(arm)) throw new Error(`unknown comparison arm: ${arm}`);
    return arm;
}

function wireIdFor(request: MethodPilotPlanRequest): string {
    const scope = request.queryGroup ?? "warmup";
    const isolated = request.method === "M1" ? request.candidateIds[0] ?? "" : "";
    return sha([request.arm, request.method, String(request.replica), scope, isolated, "attempt", "1"].join("|"));
}

function matchesGap(request: MethodPilotPlanRequest, scenario: Scenario): boolean {
    if (scenario === "happy" || request.warmup || request.arm !== GAP_ARM) return false;
    if (request.queryGroup !== GAP_QUERY || request.replica !== 0) return false;
    if (scenario === "gap-m0") return request.method === "M0";
    return request.method === "M1" && request.candidateIds[0] === GAP_CID;
}

function generateRecords(scenario: Scenario): MethodWireRecord[] {
    return PLAN.requests.map((request) => {
        const arm = requireModelId(request.arm);
        const gapped = matchesGap(request, scenario);
        const answers = request.candidateIds.map((candidateId) => ({
            candidateId,
            probability: gapped
                ? null
                : request.warmup
                    ? 0.5
                    : syntheticAnswer(request.method, request.queryGroup ?? "", candidateId, request.replica),
        }));
        const record: MethodWireRecord = {
            wireId: wireIdFor(request),
            method: request.method,
            arm,
            phase: "pilot",
            replica: request.replica,
            warmup: request.warmup,
            direction: request.direction,
            queryGroup: request.queryGroup,
            candidateIds: [...request.candidateIds],
            attemptIndex: 1,
            requestBytes: request.requestBytes,
            payloadSha256: request.payloadSha256,
            httpStatus: 200,
            servedModel: gapped ? null : COMPARISON_SERVED_MODEL_ALLOWLIST[arm],
            provider: gapped ? null : "synthetic",
            inputTokens: gapped ? null : 100,
            outputTokens: gapped ? null : 20,
            cost: { status: "known", usd: 0.001 },
            errorClass: gapped ? "capture_gap" : null,
            requestTimestamp: "2026-10-09T00:00:00.000Z",
            latencyMs: 250,
            answers,
        };
        return record;
    });
}

const HAPPY_RECORDS = generateRecords("happy");

function writeJsonl(dir: string, name: string, rows: readonly unknown[]): string {
    const path = join(dir, name);
    writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    return path;
}

interface RowQuery {
    model: ComparisonModelId;
    method: "M0" | "M1" | "M2";
    queryGroup: string;
    candidateId: string;
    replica: number;
}

function findRow(rows: readonly MethodPilotProbabilityRow[], query: RowQuery): MethodPilotProbabilityRow {
    const row = rows.find((candidate) =>
        candidate.model === query.model
        && candidate.method === query.method
        && candidate.queryGroup === query.queryGroup
        && candidate.candidateId === query.candidateId
        && candidate.replica === query.replica);
    if (row === undefined) throw new Error(`derived row not found: ${JSON.stringify(query)}`);
    return row;
}

function rowProbabilities(rows: readonly MethodPilotProbabilityRow[], query: Omit<RowQuery, "replica">): number[] {
    return [0, 1].map((replica) => {
        const row = findRow(rows, { ...query, replica });
        if (row.probability === null) throw new Error("expected a numeric probability cell");
        return row.probability;
    });
}

function tempDir(prefix: string): string {
    return mkdtempSync(join(tmpdir(), prefix));
}

function silence(): { logs: string[]; errors: string[]; restore: () => void } {
    const logs: string[] = [];
    const errors: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(" "));
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
        errors.push(args.map(String).join(" "));
    });
    return {
        logs,
        errors,
        restore: () => {
            logSpy.mockRestore();
            errorSpy.mockRestore();
        },
    };
}

afterEach(() => {
    vi.restoreAllMocks();
});

/* ──────────────────────────────────────────────────────────────────
 * Derivation: exact rows, warmup exclusion, null propagation
 * ────────────────────────────────────────────────────────────────── */

describe("method-pilot-select derivation (synthetic, plan-derived records)", () => {
    it("derives exact per-replica cells: M0/M1 single probability, M2 forward/reverse kept separate", () => {
        const derivation = deriveMethodPilotSelectorInput(ROSTER, PLAN, HAPPY_RECORDS);
        const rows = derivation.input.rows;

        // Type-A gold (p001-c01): M0 forward [.8,.8]; M1 replica mean inputs [.3,.5];
        // M2 legs forward [.8,.8] (the reused M0 records) / reverse [.3,.3].
        expect(rowProbabilities(rows, { model: GAP_ARM, method: "M0", queryGroup: "p001", candidateId: GAP_CID })).toEqual([0.8, 0.8]);
        expect(rowProbabilities(rows, { model: GAP_ARM, method: "M1", queryGroup: "p001", candidateId: GAP_CID })).toEqual([0.3, 0.5]);
        for (let replica = 0; replica < 2; replica += 1) {
            const m2 = findRow(rows, { model: GAP_ARM, method: "M2", queryGroup: "p001", candidateId: GAP_CID, replica });
            expect(m2.probability).toBeNull(); // the selector derives the average itself
            expect(m2.forward).toBe(0.8);
            expect(m2.reverse).toBe(0.3);
        }

        // Type-B gold (p021): M0 forward .3 (drops at M0), M2 reverse .8 keeps it when averaged (.55).
        expect(rowProbabilities(rows, { model: GAP_ARM, method: "M0", queryGroup: "p021", candidateId: "p021-c01" })).toEqual([0.3, 0.3]);
        const typeBGoldM2 = findRow(rows, { model: GAP_ARM, method: "M2", queryGroup: "p021", candidateId: "p021-c01", replica: 0 });
        expect(typeBGoldM2.forward).toBe(0.3);
        expect(typeBGoldM2.reverse).toBe(0.8);

        // Negative: M0 .5, M1 .1, M2 forward .5 / reverse .4 (averaged .45 keeps -> FP).
        expect(rowProbabilities(rows, { model: GAP_ARM, method: "M0", queryGroup: "p001", candidateId: "p001-c02" })).toEqual([0.5, 0.5]);
        expect(rowProbabilities(rows, { model: GAP_ARM, method: "M1", queryGroup: "p001", candidateId: "p001-c02" })).toEqual([0.1, 0.1]);
        const negativeM2 = findRow(rows, { model: GAP_ARM, method: "M2", queryGroup: "p001", candidateId: "p001-c02", replica: 0 });
        expect(negativeM2.forward).toBe(0.5);
        expect(negativeM2.reverse).toBe(0.4);

        // Row shape invariants: M0/M1 rows never carry leg components; labels come from the roster.
        for (const row of rows) {
            if (row.method === "M2") expect(row.probability).toBeNull();
            else expect(row.forward === null && row.reverse === null).toBe(true);
            const rostered = ROSTER.candidates.find((candidate) => candidate.cid === row.candidateId);
            expect(row.label).toBe(rostered?.label);
        }
    });

    it("excludes warmups from rows but keeps them bound in the envelope totals", () => {
        const derivation = deriveMethodPilotSelectorInput(ROSTER, PLAN, HAPPY_RECORDS);
        const rows = derivation.input.rows;

        // 3 arms x 3 methods x 280 candidates x 2 replicas; warmups never become rows.
        expect(rows).toHaveLength(3 * 3 * 280 * 2);
        expect(rows.every((row) => row.queryGroup !== null)).toBe(true);

        expect(derivation.recordRowCount).toBe(2166); // 722 x 3 records, one per plan request
        expect(derivation.uniqueWireRequestCount).toBe(2166); // forward reuse deduplicated
        expect(derivation.envelopeTotals).toHaveLength(9);
        const byKey = new Map(derivation.envelopeTotals.map((entry) => [`${entry.arm}/${entry.method}`, entry.totals]));
        for (const arm of PLAN.models) {
            expect(byKey.get(`${arm}/M0`)).toMatchObject({ wireRequestCount: 82, warmupRequests: 2 }); // 80 forward + 2 warmups
            expect(byKey.get(`${arm}/M1`)).toMatchObject({ wireRequestCount: 560, warmupRequests: 0 });
            expect(byKey.get(`${arm}/M2`)).toMatchObject({ wireRequestCount: 162, warmupRequests: 2 }); // reused forward + reverse + warmups
        }
        expect(derivation.arms).toEqual(PLAN.models);
        expect(derivation.input.integrity).toHaveLength(9);
        expect(derivation.input.integrity.every((entry) =>
            !entry.servedIdentityDrift && !entry.payloadDrift && !entry.captureGap && !entry.abortedRun)).toBe(true);
    });

    it("happy path: hand-computed S_m [9, 0, 6], both alternatives qualify, selector chooses M1", () => {
        const derivation = deriveMethodPilotSelectorInput(ROSTER, PLAN, HAPPY_RECORDS);
        const result = selectMethodPilotMethod(derivation.input);
        expect(result.queryCount).toBe(40);
        expect(result.inconclusive).toBe(false);
        expect(result.baselineBlockReasons).toEqual([]);
        // S_0 = 1080/120 = 9 (720 FP + 360 gold-FN penalty on type-B queries);
        // S_1 = 0 (replica-mean keeps every gold at exactly .40);
        // S_2 = 720/120 = 6 from the (forward+reverse)/2 derivation.
        expect(result.methods.map((metrics) => metrics.s)).toEqual([9, 0, 6]);
        const [m1, m2] = result.alternatives;
        expect(m1.method).toBe("M1");
        expect(m1.qualified).toBe(true);
        expect(m1.s).toBe(0);
        expect(m1.d).toBe(9);
        expect(m1.marginPass).toBe(true);
        expect(m1.bootstrapPass).toBe(true);
        expect(m1.fnGuardPass).toBe(true);
        expect(m2.method).toBe("M2");
        expect(m2.qualified).toBe(true);
        expect(m2.s).toBe(6);
        expect(m2.d).toBe(3);
        expect(m2.bootstrapPass).toBe(true);
        expect(m2.fnGuardPass).toBe(true);
        expect(result.selected).toBe("M1"); // both qualify -> lower S_m wins
    });

    it("capture gap on an M1 component => null cell, M1 ineligible (integrity + coverage), selection continues", () => {
        const derivation = deriveMethodPilotSelectorInput(ROSTER, PLAN, generateRecords("gap-m1"));
        const rows = derivation.input.rows;
        expect(rows).toHaveLength(3 * 3 * 280 * 2); // the gapped candidate is never dropped
        const gapped = findRow(rows, { model: GAP_ARM, method: "M1", queryGroup: GAP_QUERY, candidateId: GAP_CID, replica: 0 });
        expect(gapped.probability).toBeNull();
        expect(gapped.probability).not.toBe(0);
        const flag = derivation.input.integrity.find((entry) => entry.model === GAP_ARM && entry.method === "M1");
        expect(flag?.captureGap).toBe(true);

        const result = selectMethodPilotMethod(derivation.input);
        expect(result.inconclusive).toBe(false); // M0 baseline is intact
        expect(result.methods[1]?.s).toBeNull();
        const [m1] = result.alternatives;
        expect(m1?.reasons).toEqual(["incomplete_coverage", "integrity_failed"]);
        expect(m1?.qualified).toBe(false);
        expect(result.selected).toBe("M2"); // M2 still qualifies; only M1 is excluded
    });

    it("capture gap on the M0 baseline => null cells in M0 and M2 forward legs, pilot inconclusive, M0 retained", () => {
        const derivation = deriveMethodPilotSelectorInput(ROSTER, PLAN, generateRecords("gap-m0"));
        const rows = derivation.input.rows;
        expect(rows).toHaveLength(3 * 3 * 280 * 2);
        expect(findRow(rows, { model: GAP_ARM, method: "M0", queryGroup: GAP_QUERY, candidateId: GAP_CID, replica: 0 }).probability).toBeNull();
        const m2Row = findRow(rows, { model: GAP_ARM, method: "M2", queryGroup: GAP_QUERY, candidateId: GAP_CID, replica: 0 });
        expect(m2Row.forward).toBeNull();
        expect(m2Row.reverse).toBe(0.3);
        const flag = derivation.input.integrity.find((entry) => entry.model === GAP_ARM && entry.method === "M0");
        expect(flag?.captureGap).toBe(true);

        const result = selectMethodPilotMethod(derivation.input);
        expect(result.inconclusive).toBe(true);
        expect(result.baselineBlockReasons).toEqual(["incomplete_coverage", "integrity_failed"]);
        expect(result.methods[0]?.s).toBeNull();
        expect(result.selected).toBe("M0");
        expect(result.alternatives[0]?.reasons).toContain("invalid_baseline");
    });
});

/* ──────────────────────────────────────────────────────────────────
 * Fail-closed rejection: forged records, incomplete runs, roster brand
 * ────────────────────────────────────────────────────────────────── */

describe("method-pilot-select fail-closed derivation", () => {
    it("rejects a forged record (served-identity drift) with the binder failure code", () => {
        const forged = HAPPY_RECORDS.map((record) => {
            if (record.method === "M1" && record.arm === GAP_ARM && record.queryGroup === GAP_QUERY && record.replica === 0) {
                return { ...record, servedModel: "forged/served-model-x" };
            }
            return record;
        });
        expect(() => deriveMethodPilotSelectorInput(ROSTER, PLAN, forged))
            .toThrow(/bindMethodComparisonReport failed.*served_identity_drift/);
    });

    it("rejects an incomplete run (missing planned request) and a payload-hash mismatch", () => {
        const withoutLast = HAPPY_RECORDS.slice(0, -1);
        expect(() => deriveMethodPilotSelectorInput(ROSTER, PLAN, withoutLast))
            .toThrow(/1 of 2166 planned request\(s\) have no wire record/);

        const tampered = HAPPY_RECORDS.map((record, index) =>
            index === 0 ? { ...record, payloadSha256: sha("tampered-payload") } : record);
        expect(() => deriveMethodPilotSelectorInput(ROSTER, PLAN, tampered))
            .toThrow(/payloadSha256 disagrees with the frozen plan/);
    });

    it("requires the Stage B roster brand (structural copies fail closed)", () => {
        const unbranded: PilotCorpusRoster = { ...ROSTER };
        expect(() => deriveMethodPilotSelectorInput(unbranded, PLAN, HAPPY_RECORDS))
            .toThrow(/not a load-verified sealed corpus roster/);
    });

    it("rejects a plan that does not match the roster", () => {
        const otherRoster = __test__brandPilotCorpusRoster({ ...ROSTER, manifestSha256: sha("other-manifest") });
        expect(() => deriveMethodPilotSelectorInput(otherRoster, PLAN, HAPPY_RECORDS))
            .toThrow(/pilotManifestSha256 does not match/);
    });

    it("rejects a tampered plan rosterDigest even when every other plan field matches the roster", () => {
        // Reviewer counterexample: swap only the digest; nothing else differs.
        const tampered: MethodPilotPlanArtifact = { ...PLAN, rosterDigest: sha("tampered-roster-digest") };
        expect(verifyPlanForRoster(tampered, ROSTER)).toMatch(/rosterDigest does not match the digest recomputed/);
        // Derivation refuses before touching a single record.
        expect(() => deriveMethodPilotSelectorInput(ROSTER, tampered, HAPPY_RECORDS))
            .toThrow(/rosterDigest does not match the digest recomputed/);
    });

    it("accepts the plan whose rosterDigest is the digest recomputed from the roster", () => {
        expect(PLAN.rosterDigest).toBe(rosterDigestOf(ROSTER));
        expect(verifyPlanForRoster(PLAN, ROSTER)).toBeNull();
        expect(() => deriveMethodPilotSelectorInput(ROSTER, PLAN, HAPPY_RECORDS)).not.toThrow();
    });
});

/* ──────────────────────────────────────────────────────────────────
 * Sealed corpus: the real plan's rosterDigest is reproducible
 * ────────────────────────────────────────────────────────────────── */

const SEALED_ROOT = defaultPilotRoot();
// Amendment A2 (2026-10-09): the PPLX arm now plans v1.1, so the current
// plan artifact is the A2 rebuild; `pilot-plan-20261009.json` (v1) is history.
const SEALED_PLAN_PATH = join(SEALED_ROOT, "pilot-plan-20261009-a2.json");
const SEALED_ROSTER_DIGEST = "62515e10ef7eefcbb5a7bb2ae84bd0d893d93e1ded4526271ad6c74d3ad0afa3";

describe("method-pilot-select sealed-corpus digest binding", () => {
    it.runIf(existsSync(SEALED_PLAN_PATH))(
        "reproduces the stored plan's rosterDigest over the load-verified sealed roster",
        () => {
            // Read-only Stage B re-verification; the stored plan file is read,
            // its wire records are not, so a concurrent paid run is untouched.
            const roster = loadVerifiedPilotCorpus(SEALED_ROOT);
            const plan = JSON.parse(readFileSync(SEALED_PLAN_PATH, "utf-8")) as MethodPilotPlanArtifact;
            expect(isMethodPilotPlanArtifact(plan)).toBe(true);
            expect(rosterDigestOf(roster)).toBe(SEALED_ROSTER_DIGEST);
            expect(plan.rosterDigest).toBe(SEALED_ROSTER_DIGEST);
            expect(verifyPlanForRoster(plan, roster)).toBeNull();
        });
});

/* ──────────────────────────────────────────────────────────────────
 * CLI: exit codes 0/2/3, verdict artifact, main guard
 * ────────────────────────────────────────────────────────────────── */

describe("method-pilot-select CLI", () => {
    it("usage errors exit 2 and --help exits 0", async () => {
        const captured = silence();
        try {
            expect(await runMethodPilotSelect(["--out", "/tmp/never.json"])).toBe(METHOD_PILOT_SELECT_EXIT_USAGE);
            expect(await runMethodPilotSelect(["--records", "r", "--plan", "p", "--bogus"])).toBe(METHOD_PILOT_SELECT_EXIT_USAGE);
            expect(await runMethodPilotSelect(["--help"])).toBe(METHOD_PILOT_SELECT_EXIT_OK);
        } finally {
            captured.restore();
        }
        expect(captured.errors.join("\n")).toContain("--records is required");
    });

    it("gate refusals exit 3: unsealable pilot root, and a roster that does not match the plan", async () => {
        const work = tempDir("method-pilot-select-gate-");
        try {
            const planPath = join(work, "plan.json");
            writeFileSync(planPath, PLAN_BYTES);
            writeJsonl(work, "records.jsonl", HAPPY_RECORDS);
            const captured = silence();
            try {
                // No loader seam: the real Stage B loader fails on an empty root.
                expect(await runMethodPilotSelect([
                    "--pilot-root", work,
                    "--records", join(work, "records.jsonl"),
                    "--plan", planPath,
                    "--out", join(work, "verdict.json"),
                ])).toBe(METHOD_PILOT_SELECT_EXIT_GATE);

                // Branded roster whose manifest differs from the plan's.
                const mismatched = __test__brandPilotCorpusRoster({ ...ROSTER, manifestSha256: sha("other-manifest") });
                expect(await runMethodPilotSelect([
                    "--pilot-root", "/unused",
                    "--records", join(work, "records.jsonl"),
                    "--plan", planPath,
                    "--out", join(work, "verdict.json"),
                ], { loadRoster: () => mismatched })).toBe(METHOD_PILOT_SELECT_EXIT_GATE);
            } finally {
                captured.restore();
            }
            expect(captured.errors.join("\n")).toContain("pilot/plan gate refused");
            expect(statSync(join(work, "verdict.json"), { throwIfNoEntry: false })).toBeUndefined();
        } finally {
            rmSync(work, { recursive: true, force: true });
        }
    });

    it("a forged records file exits 2 without writing a verdict", async () => {
        const work = tempDir("method-pilot-select-forged-");
        try {
            const planPath = join(work, "plan.json");
            writeFileSync(planPath, PLAN_BYTES);
            const forged = HAPPY_RECORDS.map((record) =>
                record.method === "M1" && record.arm === GAP_ARM && record.queryGroup === GAP_QUERY && record.replica === 0
                    ? { ...record, servedModel: "forged/served-model-x" }
                    : record);
            const recordsPath = writeJsonl(work, "records.jsonl", forged);
            const captured = silence();
            let code: number;
            try {
                code = await runMethodPilotSelect(
                    ["--pilot-root", "/unused", "--records", recordsPath, "--plan", planPath, "--out", join(work, "verdict.json")],
                    { loadRoster: () => ROSTER },
                );
            } finally {
                captured.restore();
            }
            expect(code).toBe(METHOD_PILOT_SELECT_EXIT_USAGE);
            expect(captured.errors.join("\n")).toContain("served_identity_drift");
            expect(statSync(join(work, "verdict.json"), { throwIfNoEntry: false })).toBeUndefined();
        } finally {
            rmSync(work, { recursive: true, force: true });
        }
    });

    it("happy path exits 0 and writes a mode-600 verdict with the chosen method, diagnostics, counts, and plan sha", async () => {
        const work = tempDir("method-pilot-select-happy-");
        try {
            const planPath = join(work, "plan.json");
            writeFileSync(planPath, PLAN_BYTES);
            const recordsPath = writeJsonl(work, "records.jsonl", HAPPY_RECORDS);
            const outPath = join(work, "verdict.json");
            const captured = silence();
            let code: number;
            try {
                code = await runMethodPilotSelect(
                    ["--pilot-root", "/unused", "--records", recordsPath, "--plan", planPath, "--out", outPath],
                    { loadRoster: () => ROSTER },
                );
            } finally {
                captured.restore();
            }
            expect(code).toBe(METHOD_PILOT_SELECT_EXIT_OK);

            expect(statSync(outPath).mode & 0o777).toBe(0o600);
            const verdict = JSON.parse(readFileSync(outPath, "utf-8")) as MethodPilotSelectVerdict;
            expect(verdict.kind).toBe(METHOD_PILOT_SELECT_VERDICT_KIND);
            expect(verdict.chosenMethod).toBe("M1");
            expect(verdict.selector.selected).toBe("M1");
            expect(verdict.selector.inconclusive).toBe(false);
            expect(verdict.selector.methods.map((metrics) => metrics.s)).toEqual([9, 0, 6]);
            expect(verdict.perModelPerMethod).toHaveLength(9);
            expect(verdict.perModelPerMethod.every((entry) => entry.loss !== null && entry.lossPerQuery !== null)).toBe(true);
            expect(verdict.boundRecordCounts.recordRows).toBe(2166);
            expect(verdict.boundRecordCounts.uniqueWireRequests).toBe(2166);
            expect(verdict.boundRecordCounts.envelopes).toHaveLength(9);
            expect(verdict.boundRecordCounts.envelopes.find((entry) => entry.method === "M0" && entry.warmupRequests)).toBeDefined();
            expect(verdict.planSha256).toBe(sha(PLAN_BYTES));
            expect(verdict.roster.queryCount).toBe(40);
            expect(verdict.roster.candidateCount).toBe(280);

            const summary = captured.logs.join("\n");
            expect(summary).toContain("chosen method: M1");
            expect(summary).toContain("S_m: M0=9 M1=0 M2=6");
        } finally {
            rmSync(work, { recursive: true, force: true });
        }
    });

    it("main guard: importing the module never executes the CLI", async () => {
        const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
            throw new Error(`process.exit(${String(code)}) called during import`);
        }) as never);
        const captured = silence();
        const exitCodeBefore = process.exitCode;
        try {
            vi.resetModules();
            const mod = await import("../../../scripts/eval/judge/method-pilot-select.js");
            expect(typeof mod.runMethodPilotSelect).toBe("function");
            expect(exitSpy).not.toHaveBeenCalled();
            expect(captured.logs).toEqual([]);
            expect(captured.errors).toEqual([]);
            expect(process.exitCode).toBe(exitCodeBefore);
        } finally {
            captured.restore();
            exitSpy.mockRestore();
        }
    });
});

describe("method-pilot-select CLI digest gate ordering", () => {
    it("a tampered plan rosterDigest is a gate refusal (exit 3) before any record is read", async () => {
        const work = tempDir("method-pilot-select-digest-");
        try {
            const planPath = join(work, "plan.json");
            writeFileSync(planPath, serializeMethodPilotPlan({ ...PLAN, rosterDigest: sha("tampered-roster-digest") }));
            // No records file exists: the digest gate must fire before record reading.
            const captured = silence();
            let code: number;
            try {
                code = await runMethodPilotSelect(
                    ["--pilot-root", "/unused", "--records", join(work, "missing-records.jsonl"), "--plan", planPath, "--out", join(work, "verdict.json")],
                    { loadRoster: () => ROSTER },
                );
            } finally {
                captured.restore();
            }
            expect(code).toBe(METHOD_PILOT_SELECT_EXIT_GATE);
            expect(captured.errors.join("\n")).toContain("rosterDigest does not match the digest recomputed");
            expect(statSync(join(work, "verdict.json"), { throwIfNoEntry: false })).toBeUndefined();
        } finally {
            rmSync(work, { recursive: true, force: true });
        }
    });
});

/* ──────────────────────────────────────────────────────────────────
 * Amendment A3 (protocol §12): recovered transport errors, prospective
 * ────────────────────────────────────────────────────────────────── */

/** Stamp every record A3-era (what the A3 executor emits). */
function withA3(records: readonly MethodWireRecord[]): MethodWireRecord[] {
    return records.map((record) => ({ ...record, rulesetVersion: METHOD_CAPTURE_RULESET_VERSION_A3 }));
}

/** The A3 transport-class shape for a received non-2xx without a served model. */
function transportFailure(base: MethodWireRecord, httpStatus: number, wireId: string, attemptIndex: number): MethodWireRecord {
    return {
        ...base,
        wireId,
        attemptIndex,
        httpStatus,
        servedModel: null,
        provider: null,
        inputTokens: null,
        outputTokens: null,
        cost: { status: "unknown", reserveUsd: 0.01 },
        errorClass: `http_${httpStatus}`,
        answers: base.candidateIds.map((candidateId) => ({ candidateId, probability: null })),
        rulesetVersion: METHOD_CAPTURE_RULESET_VERSION_A3,
    };
}

/** The planned M1 component the A3 tests perturb (first candidate of p001, replica 0). */
function a3Target(records: readonly MethodWireRecord[]): MethodWireRecord {
    const record = records.find((entry) => entry.method === "M1" && entry.replica === 0
        && entry.queryGroup === "p001" && entry.candidateIds[0] === "p001-c01");
    if (record === undefined) throw new Error("a3Target: expected a planned M1 record");
    return record;
}

describe("Amendment A3: recovered transport errors and the integrity gate", () => {
    it("a transient 529 retried to a verified success sets NO integrity flag and the verdict carries rulesetVersion A3", () => {
        const target = a3Target(HAPPY_RECORDS);
        const retryWireId = sha([target.arm, target.method, String(target.replica), target.queryGroup ?? "", target.candidateIds[0] ?? "", "attempt", "2"].join("|"));
        const records = withA3(HAPPY_RECORDS).flatMap((record) => {
            if (record.wireId !== target.wireId) return [record];
            // Same planned payload: attempt 1 = received 529 with no served model
            // (transport class under A3), attempt 2 = the verified success.
            return [
                transportFailure(target, 529, sha(`${target.wireId}|retry`), 1),
                { ...target, attemptIndex: 2, wireId: retryWireId, rulesetVersion: METHOD_CAPTURE_RULESET_VERSION_A3 },
            ];
        });
        const derivation = deriveMethodPilotSelectorInput(ROSTER, PLAN, records);
        expect(derivation.rulesetVersion).toBe(METHOD_CAPTURE_RULESET_VERSION_A3);
        const integrity = derivation.input.integrity.find((entry) => entry.model === GAP_ARM && entry.method === "M1");
        expect(integrity).toBeDefined();
        // Recovered: neither the capture gap nor the final-attempt rule fires.
        expect(integrity?.captureGap).toBe(false);
        expect(integrity?.finalAttemptUnverified).toBe(false);
        expect(derivation.input.integrity.every((entry) => !entry.finalAttemptUnverified)).toBe(true);
        // The successful retry supplies the answer; both alternatives still qualify.
        const result = selectMethodPilotMethod(derivation.input);
        expect(result.selected).toBe("M1");
        expect(result.alternatives.every((alternative) => alternative.qualified)).toBe(true);
        const verdict = buildMethodPilotSelectVerdict(result, derivation, sha("a3-plan"), ROSTER);
        // A3-era artifacts are distinguishable: the marker is present.
        expect(verdict.rulesetVersion).toBe(METHOD_CAPTURE_RULESET_VERSION_A3);
        expect(verdict.chosenMethod).toBe("M1");
    });

    it("a 2xx without served identity is still capture_gap under A3 and still sets the integrity flag", () => {
        const target = a3Target(HAPPY_RECORDS);
        const gap: MethodWireRecord = {
            ...target,
            servedModel: null,
            provider: null,
            inputTokens: null,
            outputTokens: null,
            cost: { status: "unknown", reserveUsd: 0.01 },
            errorClass: "capture_gap",
            answers: target.candidateIds.map((candidateId) => ({ candidateId, probability: null })),
            rulesetVersion: METHOD_CAPTURE_RULESET_VERSION_A3,
        };
        const records = withA3(HAPPY_RECORDS).map((record) => (record.wireId === target.wireId ? gap : record));
        const derivation = deriveMethodPilotSelectorInput(ROSTER, PLAN, records);
        const integrity = derivation.input.integrity.find((entry) => entry.model === GAP_ARM && entry.method === "M1");
        expect(integrity?.captureGap).toBe(true);
        // The gap is the component's final attempt and unverified.
        expect(integrity?.finalAttemptUnverified).toBe(true);
    });

    it("rejects an A3-stamped capture_gap on a non-2xx (transport class instead) but keeps the legacy shape valid", () => {
        const target = a3Target(HAPPY_RECORDS);
        const legacyGap: MethodWireRecord = {
            ...target,
            httpStatus: 503,
            servedModel: null,
            provider: null,
            inputTokens: null,
            outputTokens: null,
            cost: { status: "unknown", reserveUsd: 0.01 },
            errorClass: "capture_gap",
            answers: target.candidateIds.map((candidateId) => ({ candidateId, probability: null })),
        };
        expect(isMethodWireRecord(legacyGap)).toBe(true);
        expect(isMethodWireRecord({ ...legacyGap, rulesetVersion: METHOD_CAPTURE_RULESET_VERSION_A3 })).toBe(false);
        expect(isMethodWireRecord(transportFailure(target, 503, sha(`${target.wireId}|a3-503`), 1))).toBe(true);
    });

    it("a final attempt that is a transport failure flags finalAttemptUnverified even after an earlier success", () => {
        const target = a3Target(HAPPY_RECORDS);
        const failedWireId = sha(`${target.wireId}|final-fail`);
        const records = withA3(HAPPY_RECORDS).flatMap((record) => {
            if (record.wireId !== target.wireId) return [record];
            // attempt 1 = verified success, attempt 2 (final) = unrecovered 500.
            return [
                { ...target, rulesetVersion: METHOD_CAPTURE_RULESET_VERSION_A3 },
                transportFailure(target, 500, failedWireId, 2),
            ];
        });
        const derivation = deriveMethodPilotSelectorInput(ROSTER, PLAN, records);
        const integrity = derivation.input.integrity.find((entry) => entry.model === GAP_ARM && entry.method === "M1");
        expect(integrity?.finalAttemptUnverified).toBe(true);
        expect(integrity?.captureGap).toBe(false);
        // And the gate blocks exactly like any other integrity flag.
        const result = selectMethodPilotMethod(derivation.input);
        expect(result.alternatives.find((alternative) => alternative.method === "M1")?.reasons).toEqual(["integrity_failed"]);
    });

    it("served-identity and payload drift still fail closed under A3-stamped records", () => {
        const target = a3Target(HAPPY_RECORDS);
        const drifted = withA3(HAPPY_RECORDS).map((record) =>
            (record.wireId === target.wireId ? { ...record, servedModel: "typesafe/evil-model" } : record));
        expect(() => deriveMethodPilotSelectorInput(ROSTER, PLAN, drifted))
            .toThrow(/served_identity_drift/);
        const payloadTampered = withA3(HAPPY_RECORDS).map((record, index) =>
            (index === 0 ? { ...record, payloadSha256: sha("tampered-payload") } : record));
        expect(() => deriveMethodPilotSelectorInput(ROSTER, PLAN, payloadTampered))
            .toThrow(/payloadSha256 disagrees/);
    });

    it("refuses to apply A3 rules to a pre-A3 artifact (fail closed), including mixed-era and unknown stamps", () => {
        // Explicit A3 request against unstamped (A1/A2-era) records → refusal.
        expect(() => deriveMethodPilotSelectorInput(ROSTER, PLAN, HAPPY_RECORDS, { ruleset: METHOD_CAPTURE_RULESET_VERSION_A3 }))
            .toThrow(/refusing to apply A3 rules to a A1\/A2 records file/);
        // A file mixing stamped and unstamped records → refusal.
        const target = a3Target(HAPPY_RECORDS);
        const mixed = HAPPY_RECORDS.map((record) =>
            (record.wireId === target.wireId ? { ...record, rulesetVersion: METHOD_CAPTURE_RULESET_VERSION_A3 } : record));
        expect(() => deriveMethodPilotSelectorInput(ROSTER, PLAN, mixed))
            .toThrow(/mixed-era records file/);
        // An unknown stamp value → refusal.
        const unknownStamp = HAPPY_RECORDS.map((record) => ({ ...record, rulesetVersion: "A4" }));
        expect(() => deriveMethodPilotSelectorInput(ROSTER, PLAN, unknownStamp))
            .toThrow(/unknown wire-record rulesetVersion/);
        // Era detection is a pure function of the records file.
        expect(detectMethodPilotRulesetVersion(HAPPY_RECORDS)).toBe("A1/A2");
        expect(detectMethodPilotRulesetVersion(withA3(HAPPY_RECORDS))).toBe(METHOD_CAPTURE_RULESET_VERSION_A3);
    });

    it("A1/A2-era records keep the old semantics: a null-identity non-2xx wire record is rejected outright", () => {
        // The A3 transport shape can never be smuggled into an unstamped
        // artifact: the contract rejects it without the A3 stamp.
        const target = a3Target(HAPPY_RECORDS);
        const { rulesetVersion: _omit, ...unstampedShape } = transportFailure(target, 529, target.wireId, 1);
        const unstamped = HAPPY_RECORDS.map((record) =>
            (record.wireId === target.wireId ? unstampedShape : record));
        expect(() => deriveMethodPilotSelectorInput(ROSTER, PLAN, unstamped))
            .toThrow(/invalid_wire_record/);
    });
});

describe("Amendment A3 regression guard: the 2026-10-09 pilot verdict stays reproducible", () => {
    const SEALED_RECORDS_PATH = join(SEALED_ROOT, "pilot-plan-20261009-a2.json.wire-records.jsonl");
    const SEALED_VERDICT_PATH = join(SEALED_ROOT, "method-verdict-20261009.json");
    it.runIf(existsSync(SEALED_RECORDS_PATH) && existsSync(SEALED_VERDICT_PATH) && existsSync(SEALED_PLAN_PATH))(
        "replays the pilot wire records through the A1/A2-era path byte-identically (M0; M1/M2 integrity_failed)",
        () => {
            const roster = loadVerifiedPilotCorpus(SEALED_ROOT);
            const planBytes = readFileSync(SEALED_PLAN_PATH, "utf-8");
            const plan = JSON.parse(planBytes) as MethodPilotPlanArtifact;
            const recordRows = readFileSync(SEALED_RECORDS_PATH, "utf-8")
                .split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line));
            const derivation = deriveMethodPilotSelectorInput(roster, plan, recordRows);
            // The pilot records are unstamped: permanently A1/A2-era.
            expect(derivation.rulesetVersion).toBe("A1/A2");
            const result = selectMethodPilotMethod(derivation.input);
            const verdict = buildMethodPilotSelectVerdict(result, derivation, sha(planBytes), roster);
            // No A3 marker may appear on an A1/A2-era verdict.
            expect(verdict.rulesetVersion).toBeUndefined();
            expect(verdict.chosenMethod).toBe("M0");
            expect(result.alternatives.find((alternative) => alternative.method === "M1")?.reasons).toEqual(["integrity_failed"]);
            expect(result.alternatives.find((alternative) => alternative.method === "M2")?.reasons).toEqual(["integrity_failed"]);
            // Byte-identical with the recorded verdict artifact.
            const recorded = readFileSync(SEALED_VERDICT_PATH, "utf-8");
            expect(`${JSON.stringify(verdict, null, 2)}\n`).toBe(recorded);
        },
    );
});
