/**
 * Tests for the preregistered method-selection selector
 * (`scripts/eval/judge/method-pilot-selector.ts`, protocol §9
 * Amendment A1.1 — protocol document lines 480–500; design plan §1).
 *
 * Fixtures are hand-computed (arithmetic shown in comments) so every
 * S_m / D_m / bootstrap value below is derivable on paper. Q comes
 * from the sealed roster input (Stage B `loadVerifiedPilotCorpus` in
 * production; a constructed roster of the same frozen type here,
 * branded via `__test__brandPilotCorpusRoster`). The production entry
 * requires that brand plus Q === PILOT_EXPECTED_QUERY_COUNT (40), so
 * the hand-computed Q = 2 fixtures run through the documented test
 * seam `__test__selectMethodPilotMethodUnfixedQueryCount` (bypasses
 * ONLY the fixed-Q check), while the Q = 40 fixtures and the gating
 * tests run through the production entry.
 * Coverage:
 *
 *  1. Hand-computed S_m/D_m with Q taken from the sealed input (denominator 3Q, never 3×40, never a caller count).
 *  2. Keep-threshold equality at .40 on the replica MEAN (naive `>` and naive per-replica decisions flip the result).
 *  3. Both negative classes count as negatives (naive hard-only FP loss flips S_0).
 *  4. M2 derivation from forward/reverse components (naive `probability` read flips S_2).
 *  5. Bootstrap: determinism, row-order invariance, identical-arms lower bound exactly 0,
 *     hand-computed constant-replicate bounds, and the .025 nearest-rank goldens for
 *     the Q=40 margin fixtures (1/30 and 1/60).
 *  6. Byte-equivalence of the replicated mulberry32/percentile helpers against
 *     independent references (`d46/sample-second-label.ts`, `metrics.ts`).
 *  7. Every qualification branch: margin (pass / fail / exact .10 equality), bootstrap
 *     (pass / fail / pass-despite-margin-fail), FN guard (+1 allowed, +2 rejected —
 *     counter-case: a naive pooled FN delta would pass +2), coverage (null cell,
 *     missing row, missing baseline), integrity (all four flag types; baseline-scoped
 *     and alternative-scoped), invalid baseline.
 *  8. Selection: default M0, exactly-one, lower-S, exact tie → M2, inconclusive M0.
 *  9. Fail-closed validation of every structural defect, including
 *     sealed-roster binding (rows/labels outside the roster, roster defects).
 * 10. API surface: single-argument selector (threshold/seed/B are not parameters).
 * 11. Reviewer counterexamples: Q and the candidate universe come only from
 *     the roster — row subsetting cannot redefine Q nor drop a candidate
 *     from the coverage check.
 * 12. Verified-brand and fixed-Q gating at the production entry (reviewer P1):
 *     unbranded structural rosters and branded rosters with Q ≠ 40 fail closed
 *     with explicit errors; the test seam bypasses only the fixed-Q check.
 */
import { describe, expect, it } from "vitest";
import { METHOD_IDS } from "../../../scripts/eval/judge/method-comparison-contract.js";
import {
    __test__brandPilotCorpusRoster,
    isVerifiedPilotCorpusRoster,
    PILOT_EXPECTED_QUERY_COUNT,
    type PilotCorpusRoster,
} from "../../../scripts/eval/judge/method-pilot-fixture.js";
import {
    mulberry32 as referenceMulberry32,
} from "../../../scripts/eval/d46/sample-second-label.js";
import { percentile as referencePercentile } from "../../../scripts/eval/judge/metrics.js";
import {
    FROZEN_BOOTSTRAP_ITERATIONS,
    FROZEN_BOOTSTRAP_SEED,
    FROZEN_CHALLENGER_ARMS,
    FROZEN_KEEP_THRESHOLD,
    INCUMBENT_ARM,
} from "../../../scripts/eval/judge/model-comparison-stats.js";
import type { ComparisonModelId } from "../../../scripts/eval/judge/model-comparison-types.js";
import {
    __test__selectMethodPilotMethodUnfixedQueryCount,
    mulberry32,
    percentileSorted,
    selectMethodPilotMethod,
    type MethodPilotIntegrityFlags,
    type MethodPilotLabel,
    type MethodPilotProbabilityRow,
    type MethodPilotSelectorInput,
} from "../../../scripts/eval/judge/method-pilot-selector.js";

const ARMS: readonly ComparisonModelId[] = [INCUMBENT_ARM, ...FROZEN_CHALLENGER_ARMS];
const [ARM_A, ARM_B, ARM_C] = ARMS as [ComparisonModelId, ComparisonModelId, ComparisonModelId];

type SingleRowMethod = "M0" | "M1";

function integrityAllClean(): MethodPilotIntegrityFlags[] {
    const entries: MethodPilotIntegrityFlags[] = [];
    for (const model of ARMS) {
        for (const method of METHOD_IDS) {
            entries.push({
                model,
                method,
                servedIdentityDrift: false,
                payloadDrift: false,
                captureGap: false,
                abortedRun: false,
                finalAttemptUnverified: false,
            });
        }
    }
    return entries;
}

type IntegrityFlag = "servedIdentityDrift" | "payloadDrift" | "captureGap" | "abortedRun" | "finalAttemptUnverified";

function integrityWithFlag(model: ComparisonModelId, method: "M0" | "M1" | "M2", flag: IntegrityFlag): MethodPilotIntegrityFlags[] {
    return integrityAllClean().map((entry) =>
        entry.model === model && entry.method === method ? { ...entry, [flag]: true } : entry,
    );
}

/** M0/M1 rows: two replica probabilities for one candidate. */
function single(
    model: ComparisonModelId,
    method: SingleRowMethod,
    queryGroup: string,
    candidateId: string,
    label: MethodPilotLabel,
    replicas: readonly [number | null, number | null],
): MethodPilotProbabilityRow[] {
    return replicas.map((probability, replica) => ({
        model,
        method,
        queryGroup,
        candidateId,
        label,
        replica,
        probability,
        forward: null,
        reverse: null,
    }));
}

/** M2 rows: forward/reverse components per replica (one entry per replica). */
function paired(
    model: ComparisonModelId,
    queryGroup: string,
    candidateId: string,
    label: MethodPilotLabel,
    legs: readonly [readonly [number, number], readonly [number, number]],
): MethodPilotProbabilityRow[] {
    return legs.map(([forward, reverse], replica) => ({
        model,
        method: "M2" as const,
        queryGroup,
        candidateId,
        label,
        replica,
        probability: null,
        forward,
        reverse,
    }));
}

/**
 * Constructed sealed roster (the production roster comes from Stage B's
 * `loadVerifiedPilotCorpus`; tests construct the same frozen type and
 * brand it via the documented `__test__brandPilotCorpusRoster` seam —
 * they are NOT load-verified). Every query gets every (cid, label) spec
 * — the roster alone defines the candidate universe, the gold labels,
 * and Q for the selector.
 */
function rosterFor(qids: readonly string[], specs: readonly (readonly [string, MethodPilotLabel])[]): PilotCorpusRoster {
    return __test__brandPilotCorpusRoster({
        queries: qids.map((qid) => ({ qid, answerable: true })),
        candidates: qids.flatMap((qid) =>
            specs.map(([cid, label]) => ({ cid, qid, file: "src/pilot.ts", startLine: 1, endLine: 5, label })),
        ),
        sourceRef: "18f6463caa78e6657b1af6c7eb86b711bc2364f8",
        manifestSha256: "0".repeat(64),
    });
}

/* ──────────────────────────────────────────────────────────────
 * Hand fixture "core" (Q = 2: queries q1, q2; each has gold g1 and
 * hard negative n1).
 *
 * M0 (all arms):   g1 [.20,.40] → mean .30 < .40 → FN (a naive
 *                  per-replica decision would keep the .40 replica);
 *                  n1 [.10,.10] → TN.
 *                  L per arm per query = 6; Σ per query = 18;
 *                  Σ total = 36 → S_0 = 36 / (3·2) = 6.
 * M1 (all arms):   g1 [.40,.60] → mean .50 → keep; n1 dropped.
 *                  S_1 = 0, D_1 = 6.
 * M2 (all arms):   g1 legs (.20,.40)/(.40,.20) → replica means
 *                  .30/.30 → .30 → FN; n1 legs (.50,.50) both →
 *                  .50 → FP (a naive `probability` read would see
 *                  null and lose this FP).
 *                  L per arm per query = 7 → S_2 = 42/6 = 7,
 *                  D_2 = −1.
 * Bootstrap: every query's model-summed M1 improvement is 18 and
 * every M2 improvement is −3, so EVERY draw equals the point
 * estimate: LB(M1) = 6, LB(M2) = −1 (hand-computed).
 * ────────────────────────────────────────────────────────────── */
function coreInput(): MethodPilotSelectorInput {
    const rows: MethodPilotProbabilityRow[] = [];
    for (const model of ARMS) {
        for (const queryGroup of ["q1", "q2"]) {
            rows.push(...single(model, "M0", queryGroup, "g1", "gold", [0.2, 0.4]));
            rows.push(...single(model, "M0", queryGroup, "n1", "hard_negative", [0.1, 0.1]));
            rows.push(...single(model, "M1", queryGroup, "g1", "gold", [0.4, 0.6]));
            rows.push(...single(model, "M1", queryGroup, "n1", "hard_negative", [0.1, 0.1]));
            rows.push(...paired(model, queryGroup, "g1", "gold", [[0.2, 0.4], [0.4, 0.2]]));
            rows.push(...paired(model, queryGroup, "n1", "hard_negative", [[0.5, 0.5], [0.5, 0.5]]));
        }
    }
    return { roster: rosterFor(["q1", "q2"], [["g1", "gold"], ["n1", "hard_negative"]]), rows, integrity: integrityAllClean() };
}

/** Core layout with M1 identical to M0 (D_1 = 0, every draw 0 → LB = 0) and M2 = core M2. */
function identicalM1Input(): MethodPilotSelectorInput {
    const base = coreInput();
    const m0Probabilities = new Map(
        base.rows
            .filter((row) => row.method === "M0")
            .map((row) => [`${row.model}|${row.queryGroup}|${row.candidateId}|${row.replica}`, row.probability] as const),
    );
    return {
        ...base,
        rows: base.rows.map((row) => {
            if (row.method !== "M1") return row;
            const probability = m0Probabilities.get(`${row.model}|${row.queryGroup}|${row.candidateId}|${row.replica}`);
            return probability === undefined ? row : { ...row, probability };
        }),
    };
}

/** Core layout with M1 fixing only q1 (margin passes, 25% of draws hit q2-only → LB = 0). */
function concentratedM1Input(): MethodPilotSelectorInput {
    const base = coreInput();
    return {
        ...base,
        rows: base.rows.map((row) => {
            if (row.method !== "M1" || row.queryGroup !== "q2") return row;
            return row.candidateId === "g1"
                ? { ...row, probability: 0.3 }
                : row;
        }),
    };
}

/* ──────────────────────────────────────────────────────────────
 * FN-guard fixtures (Q = 2; each query has golds g1, g2 and hard
 * negative n1). The guard counts CORPUS totals: FN_{a,m} − FN_{a,0}.
 *
 * "+1 allowed" (arm A corpus delta = +1): M0 (all arms) drops g1
 * (.30 → FN), keeps g2 (.50), keeps n1 (.50 → FP): L = 7/arm/query;
 * Σ = 21/query; total 42 → S_0 = 7. M1 arm A additionally drops g2
 * on q1 ONLY (q2 g2 stays kept): corpus FN 3 vs 2 → delta +1;
 * L(q1) = 12, L(q2) = 6. M1 arms B/C clean → 0. Σ total = 18 →
 * S_1 = 3, D_1 = 4. Per-query improvements q1 = 9, q2 = 15 → draws
 * {q1,q1} = 3, {q1,q2} = 4, {q2,q2} = 5 → LB = 3 > 0. FN deltas:
 * A = +1 (boundary keeps), B/C = 0 − 2 = −2.
 *
 * "+2 rejected" (arm A corpus delta = +2): M0 arm A keeps both
 * golds (FN = 0) with n1 FP → L = 1/query; M0 arms B/C drop g1
 * (FN) + n1 FP → L = 7/query. Σ = 15/query; total 30 → S_0 = 5.
 * M1 arm A drops g1 on q1 and g2 on q2 (corpus FN 2 vs 0 → +2) and
 * fixes n1 → L = 6/query; M1 arms B/C clean → 0. Σ total = 12 →
 * S_1 = 2, D_1 = 3 ≥ .10; per-query improvement 9 on both queries →
 * every draw = 3 → LB = 3 > 0. Only the FN guard fails (counter-case:
 * pooled delta 2 − (0+2+2) = −2 would pass a naive pooled check).
 * ────────────────────────────────────────────────────────────── */
function fnGuardInput(plusTwo: boolean): MethodPilotSelectorInput {
    const rows: MethodPilotProbabilityRow[] = [];
    for (const model of ARMS) {
        const isArmA = model === ARM_A;
        for (const queryGroup of ["q1", "q2"]) {
            const isFirstQuery = queryGroup === "q1";
            const m0G1: readonly [number, number] = !plusTwo || !isArmA ? [0.3, 0.3] : [0.5, 0.5];
            const m0G2: readonly [number, number] = [0.5, 0.5];
            const m0N1: readonly [number, number] = [0.5, 0.5];
            let m1G1: readonly [number, number] = isArmA ? m0G1 : [0.5, 0.5];
            let m1G2: readonly [number, number] = isArmA ? m0G2 : [0.5, 0.5];
            if (isArmA && !plusTwo) {
                m1G1 = [0.3, 0.3];
                m1G2 = isFirstQuery ? [0.3, 0.3] : [0.5, 0.5];
            } else if (isArmA && plusTwo) {
                m1G1 = isFirstQuery ? [0.3, 0.3] : [0.5, 0.5];
                m1G2 = isFirstQuery ? [0.5, 0.5] : [0.3, 0.3];
            }
            const m1N1: readonly [number, number] = [0.1, 0.1];
            rows.push(...single(model, "M0", queryGroup, "g1", "gold", [...m0G1]));
            rows.push(...single(model, "M0", queryGroup, "g2", "gold", [...m0G2]));
            rows.push(...single(model, "M0", queryGroup, "n1", "hard_negative", [...m0N1]));
            rows.push(...single(model, "M1", queryGroup, "g1", "gold", [...m1G1]));
            rows.push(...single(model, "M1", queryGroup, "g2", "gold", [...m1G2]));
            rows.push(...single(model, "M1", queryGroup, "n1", "hard_negative", [...m1N1]));
            rows.push(...paired(model, queryGroup, "g1", "gold", [[m0G1[0], m0G1[1]], [m0G1[0], m0G1[1]]]));
            rows.push(...paired(model, queryGroup, "g2", "gold", [[m0G2[0], m0G2[1]], [m0G2[0], m0G2[1]]]));
            rows.push(...paired(model, queryGroup, "n1", "hard_negative", [[m0N1[0], m0N1[1]], [m0N1[0], m0N1[1]]]));
        }
    }
    return { roster: rosterFor(["q1", "q2"], [["g1", "gold"], ["g2", "gold"], ["n1", "hard_negative"]]), rows, integrity: integrityAllClean() };
}

/* ──────────────────────────────────────────────────────────────
 * Keep-threshold equality fixture (Q = 2; each query: gold g1,
 * hard negative h1, easy negative e1).
 *
 * M0: g1 [.30,.50] → mean exactly .40 → KEPT (naive `>` → FN);
 *     h1 and e1 [.40,.40] → exactly .40 → KEPT → FP for BOTH
 *     negative classes (naive `>` or hard-only loss flips S_0).
 *     L per arm per query = 2 FPs → Σ = 6/query; total 12 → S_0 = 2.
 * M1: g1 kept, h1/e1 [.10,.10] dropped → S_1 = 0, D_1 = 2;
 *     per-query improvement 6 on both queries → LB = 2 > 0.
 * ────────────────────────────────────────────────────────────── */
function thresholdEqualityInput(): MethodPilotSelectorInput {
    const rows: MethodPilotProbabilityRow[] = [];
    for (const model of ARMS) {
        for (const queryGroup of ["q1", "q2"]) {
            rows.push(...single(model, "M0", queryGroup, "g1", "gold", [0.3, 0.5]));
            rows.push(...single(model, "M0", queryGroup, "h1", "hard_negative", [0.4, 0.4]));
            rows.push(...single(model, "M0", queryGroup, "e1", "easy_negative", [0.4, 0.4]));
            rows.push(...single(model, "M1", queryGroup, "g1", "gold", [0.3, 0.5]));
            rows.push(...single(model, "M1", queryGroup, "h1", "hard_negative", [0.1, 0.1]));
            rows.push(...single(model, "M1", queryGroup, "e1", "easy_negative", [0.1, 0.1]));
            rows.push(...paired(model, queryGroup, "g1", "gold", [[0.3, 0.5], [0.3, 0.5]]));
            rows.push(...paired(model, queryGroup, "h1", "hard_negative", [[0.4, 0.4], [0.4, 0.4]]));
            rows.push(...paired(model, queryGroup, "e1", "easy_negative", [[0.4, 0.4], [0.4, 0.4]]));
        }
    }
    return { roster: rosterFor(["q1", "q2"], [["g1", "gold"], ["h1", "hard_negative"], ["e1", "easy_negative"]]), rows, integrity: integrityAllClean() };
}

/* ──────────────────────────────────────────────────────────────
 * Q = 40 fixtures (planned pilot scale; Q comes from the roster).
 *
 * Every query has one gold kept at .50 under all methods and one
 * negative. Under M0 (and M2, which mirrors M0) the negative is .50
 * on queries q00..q07 for every arm → FP → L_{a,0} = 8 per arm,
 * Σ L = 24 → S_0 = 24/120 = 0.2. Under M1 the negative drops to
 * .10 wherever `improves(queryIndex, armIndex)` says so (queries
 * q00..q07 only; elsewhere M1 = M0 exactly).
 *
 * Margin-equality scenario (improves = q < 6 && arm ∈ {A,B}):
 *   Σ L_1 = 2 + 2 + 8 = 12 → S_1 = 0.1 → D_1 = 0.2 − 0.1 = 0.1
 *   EXACTLY (double arithmetic: 24/120 = 0.2, 12/120 = 0.1,
 *   0.2 − 0.1 === 0.1 ≥ 0.10 → margin passes at equality).
 *   Per-query model-summed improvement is 2 on q00..q05, 0 elsewhere:
 *   6 improving clusters → few zero-improvement draws, and the
 *   nearest-rank .025 percentile (index 249) lands in the k=2 bucket
 *   = 4/120 = 1/30 (pinned golden under the frozen stream)
 *   → LB = 1/30 > 0. FN guard: no FN anywhere.
 *
 * Margin-fail scenario (improves = q < 6 && arm = A only):
 *   Σ L_1 = 2 + 8 + 8 = 18 → S_1 = 0.15 → D_1 = 0.2 − 0.15 =
 *   0.05000000000000002 < 0.10 → margin FAILS while the bootstrap
 *   still passes (index 249 lands in the k=2 bucket = 2/120 = 1/60 →
 *   LB = 1/60 golden > 0) and the FN guard passes → exactly
 *   ["margin_failed"].
 * ────────────────────────────────────────────────────────────── */
const FORTY_QIDS = Array.from({ length: 40 }, (_, index) => `q${String(index).padStart(2, "0")}`);

function fortyQueryInput(improves: (queryIndex: number, armIndex: number) => boolean): MethodPilotSelectorInput {
    const rows: MethodPilotProbabilityRow[] = [];
    ARMS.forEach((model, armIndex) => {
        for (let q = 0; q < 40; q += 1) {
            const queryGroup = `q${String(q).padStart(2, "0")}`;
            const isFp = q < 8;
            const m0Negative: readonly [number, number] = isFp ? [0.5, 0.5] : [0.1, 0.1];
            const m1Negative: readonly [number, number] = isFp && improves(q, armIndex) ? [0.1, 0.1] : m0Negative;
            rows.push(...single(model, "M0", queryGroup, "g1", "gold", [0.5, 0.5]));
            rows.push(...single(model, "M1", queryGroup, "g1", "gold", [0.5, 0.5]));
            rows.push(...single(model, "M0", queryGroup, "n1", "hard_negative", [...m0Negative]));
            rows.push(...single(model, "M1", queryGroup, "n1", "hard_negative", [...m1Negative]));
            rows.push(...paired(model, queryGroup, "g1", "gold", [[0.5, 0.5], [0.5, 0.5]]));
            rows.push(...paired(model, queryGroup, "n1", "hard_negative", [[...m0Negative], [...m0Negative]]));
        }
    });
    return { roster: rosterFor(FORTY_QIDS, [["g1", "gold"], ["n1", "hard_negative"]]), rows, integrity: integrityAllClean() };
}

/* ──────────────────────────────────────────────────────────────
 * Selection fixtures (Q = 2, core layout).
 *
 * tieInput: M2 fully clean (g1 kept at .50, n1 dropped) → S_2 = 0 =
 * S_1 (core M1) → exact tie → M2 (A1.1 line 498).
 * lowerSInput: M2 keeps n1 on q1 only → 3 arm-level FPs → Σ L_2 = 3
 * → S_2 = 0.5 > S_1 = 0 → M1 wins (lower S_m).
 * Per-query M2 improvements: q1 = 18−3 = 15, q2 = 18−0 = 18 →
 * draws {q1,q1} = 5, {q1,q2} = 5.5, {q2,q2} = 6 → LB(M2) = 5 > 0.
 * ────────────────────────────────────────────────────────────── */
function tieInput(): MethodPilotSelectorInput {
    const base = coreInput();
    const rows = base.rows.flatMap((row) => {
        if (row.method !== "M2") return [row];
        const keep = row.candidateId === "g1";
        return [{ ...row, forward: keep ? 0.5 : 0.1, reverse: keep ? 0.5 : 0.1 }];
    });
    return { ...base, rows };
}

function lowerSInput(): MethodPilotSelectorInput {
    const base = tieInput();
    const rows = base.rows.map((row) => {
        if (row.method !== "M2" || row.candidateId !== "n1") return row;
        return row.queryGroup === "q1" ? { ...row, forward: 0.5, reverse: 0.5 } : row;
    });
    return { ...base, rows };
}

/* ──────────────────────────────────────────────────────────────
 * Coverage / integrity mutation helpers.
 * ────────────────────────────────────────────────────────────── */
function mapRow(
    input: MethodPilotSelectorInput,
    match: (row: MethodPilotProbabilityRow) => boolean,
    patch: (row: MethodPilotProbabilityRow) => MethodPilotProbabilityRow,
): MethodPilotSelectorInput {
    return { ...input, rows: input.rows.map((row) => (match(row) ? patch(row) : row)) };
}

function dropRows(
    input: MethodPilotSelectorInput,
    match: (row: MethodPilotProbabilityRow) => boolean,
): MethodPilotSelectorInput {
    return { ...input, rows: input.rows.filter((row) => !match(row)) };
}

/* ════════════════════════════════════════════════════════════ */

describe("frozen constants and API surface", () => {
    it("uses the frozen .40 keep threshold from the §4.4 constants", () => {
        expect(FROZEN_KEEP_THRESHOLD).toBe(0.4);
        expect(FROZEN_BOOTSTRAP_SEED).toBe(20261008);
        expect(FROZEN_BOOTSTRAP_ITERATIONS).toBe(10_000);
    });

    it("the selector is single-argument: threshold/margin/seed/B are not parameters (A1.1 prohibited retuning)", () => {
        expect(selectMethodPilotMethod.length).toBe(1);
    });

    it("returns exactly one common method with fixed M0/M1/M2 and M1/M2 orderings", () => {
        const result = __test__selectMethodPilotMethodUnfixedQueryCount(coreInput());
        expect(result.methods.map((m) => m.method)).toEqual(["M0", "M1", "M2"]);
        expect(result.alternatives.map((a) => a.method)).toEqual(["M1", "M2"]);
        expect(typeof result.selected).toBe("string");
        expect(["M0", "M1", "M2"]).toContain(result.selected);
        expect(result.queryCount).toBe(2);
    });
});

describe("byte-equivalence of replicated helpers", () => {
    it("mulberry32 is byte-identical to the reference export in d46/sample-second-label.ts for the frozen seed", () => {
        const mine = mulberry32(FROZEN_BOOTSTRAP_SEED);
        const reference = referenceMulberry32(FROZEN_BOOTSTRAP_SEED);
        const mineValues: number[] = [];
        const referenceValues: number[] = [];
        for (let i = 0; i < FROZEN_BOOTSTRAP_ITERATIONS; i += 1) {
            mineValues.push(mine());
            referenceValues.push(reference());
        }
        expect(mineValues).toEqual(referenceValues);
    });

    it("pins the frozen-seed stream's first draws (golden literals from the reference)", () => {
        const rand = mulberry32(20261008);
        const firstSix = Array.from({ length: 6 }, () => rand());
        expect(firstSix).toEqual([
            0.9406747838947922,
            0.49959295336157084,
            0.03098052437417209,
            0.2070265905931592,
            0.7408745891880244,
            0.10686949291266501,
        ]);
    });

    it("percentileSorted matches metrics.percentile (same nearest-rank convention) and index ceil(q·len)−1", () => {
        const ten = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
        for (const q of [0, 0.025, 0.25, 0.5, 0.975, 1]) {
            expect(percentileSorted(ten, q)).toBe(referencePercentile([...ten], q));
        }
        expect(percentileSorted(ten, 0.025)).toBe(0);
        expect(percentileSorted(ten, 0.5)).toBe(4);
        expect(percentileSorted(ten, 0.975)).toBe(9);
        const tenThousand = Array.from({ length: 10_000 }, (_, i) => i);
        expect(percentileSorted(tenThousand, 0.025)).toBe(249);
        expect(percentileSorted(tenThousand, 0.975)).toBe(9749);
    });
});

describe("hand-computed S_m / D_m and bootstrap bounds (core fixture)", () => {
    it("reproduces the paper arithmetic: S_0 = 6, S_1 = 0, S_2 = 7, D_1 = 6, D_2 = −1", () => {
        const result = __test__selectMethodPilotMethodUnfixedQueryCount(coreInput());
        const [m0, m1, m2] = result.methods;
        expect(m0!.s).toBe(6);
        expect(m1!.s).toBe(0);
        expect(m2!.s).toBe(7);
        for (const arm of ARMS) {
            expect(m0!.lossByModel![arm]).toBe(12);
            expect(m1!.lossByModel![arm]).toBe(0);
            expect(m2!.lossByModel![arm]).toBe(14);
            expect(m0!.fnByModel![arm]).toBe(2);
            expect(m1!.fnByModel![arm]).toBe(0);
            expect(m2!.fnByModel![arm]).toBe(2);
        }
        const [a1, a2] = result.alternatives;
        expect(a1!.d).toBe(6);
        expect(a2!.d).toBe(-1);
        expect(a1!.marginPass).toBe(true);
        expect(a2!.marginPass).toBe(false);
    });

    it("homogeneous per-query improvements make every draw equal the point estimate: LB(M1) = 6, LB(M2) = −1", () => {
        const result = __test__selectMethodPilotMethodUnfixedQueryCount(coreInput());
        const [a1, a2] = result.alternatives;
        expect(a1!.bootstrapLowerBound).toBe(6);
        expect(a1!.bootstrapPass).toBe(true);
        expect(a1!.fnGuardPass).toBe(true);
        expect(a1!.qualified).toBe(true);
        expect(a1!.reasons).toEqual([]);
        expect(a2!.bootstrapLowerBound).toBe(-1);
        expect(a2!.bootstrapPass).toBe(false);
        expect(a2!.fnGuardPass).toBe(true);
        expect(a2!.qualified).toBe(false);
        expect(a2!.reasons).toEqual(["margin_failed", "bootstrap_failed"]);
    });

    it("selects exactly one qualifying alternative (M1)", () => {
        const result = __test__selectMethodPilotMethodUnfixedQueryCount(coreInput());
        expect(result.selected).toBe("M1");
        expect(result.inconclusive).toBe(false);
        expect(result.baselineBlockReasons).toEqual([]);
    });
});

describe("keep threshold equality and negative classes (counter-cases)", () => {
    it("score exactly .40 on the replica MEAN keeps (gold TP, both negative classes FP)", () => {
        const result = __test__selectMethodPilotMethodUnfixedQueryCount(thresholdEqualityInput());
        const [m0] = result.methods;
        expect(m0!.s).toBe(2);
        for (const arm of ARMS) {
            expect(m0!.fnByModel![arm]).toBe(0);
            expect(m0!.lossByModel![arm]).toBe(4);
        }
        const [a1] = result.alternatives;
        expect(a1!.d).toBe(2);
        expect(a1!.bootstrapLowerBound).toBe(2);
        expect(a1!.qualified).toBe(true);
        expect(result.selected).toBe("M1");
    });
});

describe("bootstrap determinism and goldens", () => {
    it("is deterministic: identical input produces identical results", () => {
        expect(__test__selectMethodPilotMethodUnfixedQueryCount(coreInput())).toEqual(__test__selectMethodPilotMethodUnfixedQueryCount(coreInput()));
    });

    it("row order does not matter: query ids are sorted lexicographically before sampling", () => {
        const input = coreInput();
        const shuffled: MethodPilotSelectorInput = {
            ...input,
            rows: [...input.rows].reverse(),
            integrity: [...input.integrity].reverse(),
        };
        expect(__test__selectMethodPilotMethodUnfixedQueryCount(shuffled)).toEqual(__test__selectMethodPilotMethodUnfixedQueryCount(input));
    });

    it("counter-case: identical arms give a lower bound of exactly 0, which fails the strict > 0 rule", () => {
        const result = __test__selectMethodPilotMethodUnfixedQueryCount(identicalM1Input());
        const [a1] = result.alternatives;
        expect(a1!.d).toBe(0);
        expect(a1!.bootstrapLowerBound).toBe(0);
        expect(a1!.bootstrapPass).toBe(false);
        expect(a1!.marginPass).toBe(false);
        expect(a1!.reasons).toEqual(["margin_failed", "bootstrap_failed"]);
        expect(result.selected).toBe("M0");
        expect(result.inconclusive).toBe(false);
    });

    it("margin passes but concentrated improvement fails the bootstrap: exactly [bootstrap_failed]", () => {
        const result = __test__selectMethodPilotMethodUnfixedQueryCount(concentratedM1Input());
        const [a1] = result.alternatives;
        expect(a1!.d).toBe(3);
        expect(a1!.marginPass).toBe(true);
        expect(a1!.bootstrapLowerBound).toBe(0);
        expect(a1!.bootstrapPass).toBe(false);
        expect(a1!.fnGuardPass).toBe(true);
        expect(a1!.reasons).toEqual(["bootstrap_failed"]);
        expect(result.selected).toBe("M0");
    });

    it("Q=40: D = .10 exactly qualifies (margin equality) with nearest-rank golden LB = 1/30", () => {
        const result = selectMethodPilotMethod(fortyQueryInput((q, arm) => q < 6 && arm < 2));
        const [m0, m1] = result.methods;
        expect(m0!.s).toBe(0.2);
        expect(m1!.s).toBe(0.1);
        const [a1, a2] = result.alternatives;
        expect(a1!.d).toBe(0.1);
        expect(a1!.d).toBeGreaterThanOrEqual(0.1);
        expect(a1!.marginPass).toBe(true);
        expect(a1!.bootstrapLowerBound).toBe(1 / 30);
        expect(a1!.bootstrapPass).toBe(true);
        expect(a1!.fnGuardPass).toBe(true);
        expect(a1!.qualified).toBe(true);
        expect(a2!.marginPass).toBe(false);
        expect(result.selected).toBe("M1");
    });

    it("Q=40: margin fails while bootstrap passes → exactly [margin_failed]", () => {
        const result = selectMethodPilotMethod(fortyQueryInput((q, arm) => q < 6 && arm === 0));
        const [m0, m1] = result.methods;
        expect(m0!.s).toBe(0.2);
        expect(m1!.s).toBe(0.15);
        const [a1] = result.alternatives;
        expect(a1!.d).toBeCloseTo(0.05, 12);
        expect(a1!.d).toBeLessThan(0.1);
        expect(a1!.marginPass).toBe(false);
        expect(a1!.bootstrapLowerBound).toBe(1 / 60);
        expect(a1!.bootstrapPass).toBe(true);
        expect(a1!.fnGuardPass).toBe(true);
        expect(a1!.reasons).toEqual(["margin_failed"]);
        expect(result.selected).toBe("M0");
    });
});

describe("FN guard boundary", () => {
    it("exactly +1 additional FN on one model is allowed (boundary keeps)", () => {
        const result = __test__selectMethodPilotMethodUnfixedQueryCount(fnGuardInput(false));
        expect(result.methods[0]!.s).toBe(7);
        expect(result.methods[1]!.s).toBe(3);
        const [a1] = result.alternatives;
        expect(a1!.fnDeltaByModel![ARM_A]).toBe(1);
        expect(a1!.fnDeltaByModel![ARM_B]).toBe(-2);
        expect(a1!.fnDeltaByModel![ARM_C]).toBe(-2);
        expect(a1!.fnGuardPass).toBe(true);
        expect(a1!.d).toBe(4);
        expect(a1!.bootstrapLowerBound).toBe(3);
        expect(a1!.qualified).toBe(true);
        expect(result.selected).toBe("M1");
    });

    it("+2 additional FNs on one model is rejected even though margin and bootstrap pass (counter-case: a pooled delta of −2 would pass)", () => {
        const result = __test__selectMethodPilotMethodUnfixedQueryCount(fnGuardInput(true));
        expect(result.methods[0]!.s).toBe(5);
        expect(result.methods[1]!.s).toBe(2);
        const [a1] = result.alternatives;
        expect(a1!.d).toBe(3);
        expect(a1!.marginPass).toBe(true);
        expect(a1!.bootstrapLowerBound).toBe(3);
        expect(a1!.bootstrapPass).toBe(true);
        expect(a1!.fnDeltaByModel![ARM_A]).toBe(2);
        expect(a1!.fnDeltaByModel![ARM_B]).toBe(-2);
        expect(a1!.fnGuardPass).toBe(false);
        expect(a1!.reasons).toEqual(["fn_guard_failed"]);
        expect(result.selected).toBe("M0");
    });
});

describe("complete numeric coverage", () => {
    it("a null probability cell makes that alternative ineligible: never a partial average, never a dropped candidate", () => {
        const broken = mapRow(
            tieInput(),
            (row) => row.method === "M1" && row.model === ARM_A && row.queryGroup === "q1" && row.candidateId === "g1" && row.replica === 1,
            (row) => ({ ...row, probability: null }),
        );
        const result = __test__selectMethodPilotMethodUnfixedQueryCount(broken);
        const [a1, a2] = result.alternatives;
        expect(a1!.reasons).toEqual(["incomplete_coverage"]);
        expect(a1!.qualified).toBe(false);
        expect(a1!.s).toBeNull();
        expect(a1!.d).toBeNull();
        expect(a1!.bootstrapLowerBound).toBeNull();
        expect(a1!.marginPass).toBeNull();
        expect(a1!.fnGuardPass).toBeNull();
        expect(result.methods[1]!.s).toBeNull();
        expect(result.methods[1]!.lossByModel).toBeNull();
        expect(a2!.qualified).toBe(true);
        expect(result.selected).toBe("M2");
    });

    it("a wholly missing alternative (no rows) is ineligible; the other alternative still selects", () => {
        const broken = dropRows(tieInput(), (row) => row.method === "M1");
        const result = __test__selectMethodPilotMethodUnfixedQueryCount(broken);
        expect(result.alternatives[0]!.reasons).toEqual(["incomplete_coverage"]);
        expect(result.selected).toBe("M2");
    });

    it("a missing M2 row is ineligible: exactly [incomplete_coverage]", () => {
        const broken = dropRows(coreInput(), (row) => row.method === "M2");
        const result = __test__selectMethodPilotMethodUnfixedQueryCount(broken);
        expect(result.alternatives[1]!.reasons).toEqual(["incomplete_coverage"]);
        expect(result.alternatives[1]!.qualified).toBe(false);
        expect(result.selected).toBe("M1");
    });

    it("a null M2 forward component is ineligible", () => {
        const broken = mapRow(
            tieInput(),
            (row) => row.method === "M2" && row.model === ARM_C && row.queryGroup === "q2" && row.candidateId === "n1" && row.replica === 0,
            (row) => ({ ...row, forward: null }),
        );
        const result = __test__selectMethodPilotMethodUnfixedQueryCount(broken);
        expect(result.alternatives[1]!.reasons).toEqual(["incomplete_coverage"]);
        expect(result.methods[2]!.s).toBeNull();
        expect(result.selected).toBe("M1");
    });

    it("invalid/incomplete M0 baseline → pilot inconclusive, retain M0 (line 498)", () => {
        const broken = mapRow(
            coreInput(),
            (row) => row.method === "M0" && row.model === ARM_C && row.queryGroup === "q1" && row.candidateId === "g1" && row.replica === 0,
            (row) => ({ ...row, probability: null }),
        );
        const result = __test__selectMethodPilotMethodUnfixedQueryCount(broken);
        expect(result.inconclusive).toBe(true);
        expect(result.baselineBlockReasons).toEqual(["incomplete_coverage"]);
        expect(result.selected).toBe("M0");
        expect(result.methods[0]!.s).toBeNull();
        expect(result.alternatives[0]!.reasons).toEqual(["invalid_baseline"]);
        expect(result.alternatives[1]!.reasons).toEqual(["invalid_baseline"]);
        expect(result.alternatives[0]!.d).toBeNull();
        expect(result.alternatives[0]!.bootstrapLowerBound).toBeNull();
    });
});

describe("sealed roster binding (A1.1 reviewer counterexamples)", () => {
    it("counterexample 1: Q is the roster query count — row subsetting cannot redefine the denominator", () => {
        // Previously queryCount was caller-supplied and validated only against
        // the query ids observed in rows, so a 2-query row set defined Q=2.
        const result = __test__selectMethodPilotMethodUnfixedQueryCount({
            ...coreInput(),
            roster: rosterFor(["q1", "q2", "q3"], [["g1", "gold"], ["n1", "hard_negative"]]),
        });
        expect(result.queryCount).toBe(3); // roster count, not the 2 queries present in rows
        expect(result.inconclusive).toBe(true); // q3's roster cells are missing → baseline incomplete
        expect(result.baselineBlockReasons).toEqual(["incomplete_coverage"]);
        expect(result.methods[0]!.s).toBeNull();
        expect(result.selected).toBe("M0");
    });

    it("counterexample 2: a candidate omitted from ALL rows cannot escape the coverage check", () => {
        // The old row-derived candidate universe lost q1/g1 entirely; the
        // roster still contains it, so every method loses coverage.
        const broken = dropRows(coreInput(), (row) => row.queryGroup === "q1" && row.candidateId === "g1");
        const result = __test__selectMethodPilotMethodUnfixedQueryCount(broken);
        expect(result.inconclusive).toBe(true);
        expect(result.baselineBlockReasons).toEqual(["incomplete_coverage"]);
        expect(result.methods[0]!.s).toBeNull();
        expect(result.alternatives[0]!.reasons).toEqual(["incomplete_coverage"]);
        expect(result.alternatives[1]!.reasons).toEqual(["incomplete_coverage"]);
        expect(result.selected).toBe("M0");
    });

    it("an empty row set leaves every roster cell uncovered → inconclusive, M0 retained", () => {
        const result = __test__selectMethodPilotMethodUnfixedQueryCount({ ...coreInput(), rows: [] });
        expect(result.queryCount).toBe(2);
        expect(result.inconclusive).toBe(true);
        expect(result.baselineBlockReasons).toEqual(["incomplete_coverage"]);
        expect(result.selected).toBe("M0");
    });

    it("Q from the sealed input: the Q=40 fixtures use the roster count as the 3Q denominator", () => {
        const result = selectMethodPilotMethod(fortyQueryInput(() => true));
        expect(result.queryCount).toBe(40);
        expect(result.methods[0]!.s).toBe(0.2); // 24 / (3 · roster Q=40)
    });
});

describe("sealed roster structure validation (fail-closed)", () => {
    it("rejects a row label that disagrees with the sealed roster (labels come only from the roster)", () => {
        expectThrow(
            (input) => ({
                ...input,
                rows: input.rows.map((row, index) => (index === 0 ? { ...row, label: "hard_negative" as const } : row)),
            }),
            /disagrees with the sealed roster/,
        );
    });

    it("rejects a legacy caller-supplied queryCount as a foreign key (Q belongs to the roster)", () => {
        expectThrow(
            (input) => ({ ...input, queryCount: 40 }) as unknown as MethodPilotSelectorInput,
            /foreign or missing keys/,
        );
    });

    it("rejects an empty roster query list (no sealed Q)", () => {
        expectThrow(
            (input) => ({ ...input, roster: __test__brandPilotCorpusRoster({ ...input.roster, queries: [] }) }),
            /at least one sealed query/,
        );
    });

    it("rejects rows for query/candidate pairs outside the sealed roster", () => {
        expectThrow(
            (input) => ({ ...input, rows: [...input.rows, ...single(ARM_A, "M0", "q1", "gX", "gold", [0.5, 0.5])] }),
            /not in the sealed roster/,
        );
        expectThrow(
            (input) => ({ ...input, rows: [...input.rows, ...single(ARM_A, "M0", "q9", "g1", "gold", [0.5, 0.5])] }),
            /not in the sealed roster/,
        );
    });

    it("rejects a roster candidate that references a query missing from roster.queries", () => {
        expectThrow(
            (input) => ({
                ...input,
                roster: __test__brandPilotCorpusRoster({
                    ...input.roster,
                    candidates: [
                        ...input.roster.candidates,
                        { cid: "z1", qid: "q9", file: "src/pilot.ts", startLine: 1, endLine: 5, label: "gold" as const },
                    ],
                }),
            }),
            /missing from roster.queries/,
        );
    });
});

describe("integrity blocks (drift / payload / capture gap / abort / unverified final attempt)", () => {
    it.each(["servedIdentityDrift", "payloadDrift", "captureGap", "abortedRun", "finalAttemptUnverified"] as const)(
        "%s on an alternative blocks only that alternative",
        (flag) => {
            const input: MethodPilotSelectorInput = {
                ...tieInput(),
                integrity: integrityWithFlag(ARM_A, "M1", flag),
            };
            const result = __test__selectMethodPilotMethodUnfixedQueryCount(input);
            expect(result.inconclusive).toBe(false);
            expect(result.alternatives[0]!.reasons).toEqual(["integrity_failed"]);
            expect(result.alternatives[0]!.qualified).toBe(false);
            expect(result.alternatives[0]!.bootstrapLowerBound).toBeNull();
            expect(result.alternatives[1]!.qualified).toBe(true);
            expect(result.selected).toBe("M2");
        },
    );

    it("a baseline integrity failure makes the pilot inconclusive and retains M0", () => {
        const input: MethodPilotSelectorInput = {
            ...tieInput(),
            integrity: integrityWithFlag(ARM_B, "M0", "servedIdentityDrift"),
        };
        const result = __test__selectMethodPilotMethodUnfixedQueryCount(input);
        expect(result.inconclusive).toBe(true);
        expect(result.baselineBlockReasons).toEqual(["integrity_failed"]);
        expect(result.selected).toBe("M0");
        expect(result.alternatives[0]!.reasons).toEqual(["invalid_baseline"]);
        expect(result.alternatives[1]!.reasons).toEqual(["invalid_baseline"]);
    });
});

describe("selection and default rules (A1.1 line 498)", () => {
    it("neither alternative qualifies → default M0, not inconclusive", () => {
        const result = __test__selectMethodPilotMethodUnfixedQueryCount(identicalM1Input());
        expect(result.alternatives.every((a) => !a.qualified)).toBe(true);
        expect(result.selected).toBe("M0");
        expect(result.inconclusive).toBe(false);
    });

    it("both qualify → the lower S_m wins (S_1 = 0 < S_2 = 0.5 → M1)", () => {
        const result = __test__selectMethodPilotMethodUnfixedQueryCount(lowerSInput());
        const [a1, a2] = result.alternatives;
        expect(a1!.qualified).toBe(true);
        expect(a2!.qualified).toBe(true);
        expect(a2!.bootstrapLowerBound).toBe(5);
        expect(a1!.s).toBe(0);
        expect(a2!.s).toBe(0.5);
        expect(result.selected).toBe("M1");
    });

    it("both qualify with an exact tie → M2 (fixed preference for fewer requests)", () => {
        const result = __test__selectMethodPilotMethodUnfixedQueryCount(tieInput());
        const [a1, a2] = result.alternatives;
        expect(a1!.qualified).toBe(true);
        expect(a2!.qualified).toBe(true);
        expect(a1!.s).toBe(0);
        expect(a2!.s).toBe(0);
        expect(a2!.bootstrapLowerBound).toBe(6);
        expect(result.selected).toBe("M2");
    });
});

/** Mutate a valid core input and assert the selector rejects the result. */
function expectThrow(mutate: (input: MethodPilotSelectorInput) => MethodPilotSelectorInput, pattern: RegExp): void {
    expect(() => __test__selectMethodPilotMethodUnfixedQueryCount(mutate(coreInput()))).toThrow(pattern);
}

describe("fail-closed input validation", () => {
    it("rejects duplicate rows", () => {
        expectThrow(
            (input) => ({ ...input, rows: [...input.rows, input.rows[0]!] }),
            /duplicate row/,
        );
    });

    it("rejects a non-frozen arm", () => {
        expectThrow(
            (input) => ({
                ...input,
                rows: input.rows.map((row, index) => (index === 0 ? { ...row, model: "openai/gpt-4" as ComparisonModelId } : row)),
            }),
            /not a frozen pilot arm/,
        );
    });

    it("rejects an unknown method", () => {
        expectThrow(
            (input) => ({
                ...input,
                rows: input.rows.map((row, index) => (index === 0 ? { ...row, method: "M3" as "M0" } : row)),
            }),
            /row.method is not M0\/M1\/M2/,
        );
    });

    it("rejects foreign extra keys on a row", () => {
        expectThrow(
            (input) => ({
                ...input,
                rows: input.rows.map((row, index) => (index === 0 ? { ...row, extra: 1 } as MethodPilotProbabilityRow : row)),
            }),
            /foreign or missing keys/,
        );
    });

    it("rejects a replica index outside the sealed pilot replica count", () => {
        expectThrow(
            (input) => ({ ...input, rows: input.rows.map((row, index) => (index === 0 ? { ...row, replica: 2 } : row)) }),
            /replica must be an integer/,
        );
    });

    it("rejects out-of-range and non-finite probabilities", () => {
        expectThrow(
            (input) => ({ ...input, rows: input.rows.map((row, index) => (index === 0 ? { ...row, probability: 1.5 } : row)) }),
            /probability must be null or in \[0,1\]/,
        );
        expectThrow(
            (input) => ({ ...input, rows: input.rows.map((row, index) => (index === 0 ? { ...row, probability: Number.NaN } : row)) }),
            /probability must be null or in \[0,1\]/,
        );
    });

    it("rejects an M2 row carrying a pre-averaged single probability", () => {
        expectThrow(
            (input) => ({
                ...input,
                rows: input.rows.map((row) => (row.method === "M2" ? { ...row, probability: 0.5 } : row)),
            }),
            /M2 rows carry forward\/reverse components/,
        );
    });

    it("rejects an M0/M1 row carrying direction components", () => {
        expectThrow(
            (input) => ({
                ...input,
                rows: input.rows.map((row, index) => (index === 0 ? { ...row, forward: 0.5 } : row)),
            }),
            /M0\/M1 rows carry a single probability only/,
        );
    });

    it("rejects a missing or duplicate integrity entry", () => {
        expectThrow((input) => ({ ...input, integrity: input.integrity.slice(1) }), /missing integrity entry/);
        expectThrow(
            (input) => ({ ...input, integrity: [...input.integrity, input.integrity[0]!] }),
            /duplicate integrity entry/,
        );
    });

    it("rejects a non-boolean integrity flag", () => {
        expectThrow(
            (input) => ({
                ...input,
                integrity: input.integrity.map((entry, index) => (index === 0 ? { ...entry, captureGap: "yes" as unknown as boolean } : entry)),
            }),
            /captureGap must be a boolean/,
        );
    });

    it("rejects non-array rows/integrity and a structurally invalid input object", () => {
        expectThrow((input) => ({ ...input, rows: undefined as unknown as MethodPilotProbabilityRow[] }), /rows must be an array/);
        expectThrow((input) => ({ ...input, integrity: undefined as unknown as MethodPilotIntegrityFlags[] }), /integrity must be an array/);
        expect(() => __test__selectMethodPilotMethodUnfixedQueryCount(null as unknown as MethodPilotSelectorInput)).toThrow(/input is not an object/);
        expect(() => __test__selectMethodPilotMethodUnfixedQueryCount([] as unknown as MethodPilotSelectorInput)).toThrow(/input is not an object/);
    });
});

describe("verified-brand and fixed-Q gating at the production entry (reviewer P1)", () => {
    it("rejects a well-formed but UNBRANDED structural roster", () => {
        const input = coreInput();
        expect(isVerifiedPilotCorpusRoster(input.roster)).toBe(true);
        const unbranded: MethodPilotSelectorInput = { ...input, roster: { ...input.roster } };
        expect(isVerifiedPilotCorpusRoster(unbranded.roster)).toBe(false);
        expect(() => selectMethodPilotMethod(unbranded)).toThrow("roster is not a verified pilot corpus roster");
    });

    it("the reviewer's counterexample now fails closed: branded Q = 2 core input cannot produce a selection", () => {
        const input = coreInput();
        expect(isVerifiedPilotCorpusRoster(input.roster)).toBe(true);
        expect(() => selectMethodPilotMethod(input)).toThrow("query count 2 violates A1.1 fixed Q = 40");
    });

    it("refuses the 3-query roster counterexample and any branded Q !== PILOT_EXPECTED_QUERY_COUNT", () => {
        expect(PILOT_EXPECTED_QUERY_COUNT).toBe(40);
        const qids39 = FORTY_QIDS.slice(0, 39);
        const qids41 = [...FORTY_QIDS, "q40"];
        const specs: readonly (readonly [string, MethodPilotLabel])[] = [["g1", "gold"], ["n1", "hard_negative"]];
        const three: MethodPilotSelectorInput = { ...coreInput(), roster: rosterFor(["q1", "q2", "q3"], specs) };
        expect(() => selectMethodPilotMethod(three)).toThrow("query count 3 violates A1.1 fixed Q = 40");
        for (const qids of [qids39, qids41]) {
            const input: MethodPilotSelectorInput = { ...coreInput(), roster: rosterFor(qids, specs) };
            expect(() => selectMethodPilotMethod(input)).toThrow(`query count ${qids.length} violates A1.1 fixed Q = 40`);
        }
    });

    it("accepts a branded Q = 40 roster at the production entry", () => {
        const result = selectMethodPilotMethod(fortyQueryInput((q, arm) => q < 6 && arm < 2));
        expect(result.queryCount).toBe(40);
        expect(result.selected).toBe("M1");
    });

    it("the fixed-Q test seam bypasses ONLY the Q check — the brand gate still applies", () => {
        const input = coreInput();
        expect(() => __test__selectMethodPilotMethodUnfixedQueryCount(input)).not.toThrow();
        const unbranded: MethodPilotSelectorInput = { ...input, roster: { ...input.roster } };
        expect(() => __test__selectMethodPilotMethodUnfixedQueryCount(unbranded)).toThrow(
            "roster is not a verified pilot corpus roster",
        );
    });
});
