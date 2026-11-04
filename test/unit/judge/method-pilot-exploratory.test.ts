/**
 * EXPLORATORY paired analysis (`scripts/eval/judge/method-pilot-exploratory.ts`).
 *
 * All fixtures are SYNTHETIC: a branded 3-query/6-candidate roster
 * built through the documented `__test__brandPilotCorpusRoster` seam
 * plus hand-built selector rows. No synthetic test reads the real
 * pilot root, its wire records, or the stored verdict — the real-data
 * reproduction proof runs only through the CLI.
 *
 * Hand computation ("all-gold-kept" scenario), per arm and query:
 *   M0: gold .8 (keep), hard negative .5 (keep)   -> loss 1, FN 0, FP 1
 *   M1: gold .3/.3 (mean .3, drop -> FN loss 6),
 *       hard negative .1 (drop)                   -> loss 6, FN 1, FP 0
 *   M2: forward gold .9 / reverse .7 -> .8 keep;
 *       forward neg .3 / reverse .5 -> .4 keep (equality rule)
 *                                            -> loss 1, FN 0, FP 1
 * except the THIRD frozen arm ("openai/gpt-6-luna-decisions"), whose
 * M1 gold is .6 (keep) -> loss 0, FN 0, FP 0 there.
 * => per non-Luna arm: L0=3, L1=18, L2=3; per Luna arm: L0=3, L1=0, L2=3.
 *    S0 = (3+3+3)/(3*3) = 1; S1 = (18+18+0)/9 = 4; S2 = 1.
 *    D(M1-M0) = -3 averaged; per arm: -5, -5, +1 -> spread 6.
 *    D(M2-M0) = 0 everywhere; D(M1-M2) = -3 averaged.
 *    win/tie/loss vs M0 for M1: non-Luna arms L3 W0 T0; Luna W3 T0 L0.
 *    M2 ties every query of every arm (3 W0 T3 L0 each).
 */
import { describe, expect, it } from "vitest";
import {
    EXPLORATORY_DRIVER_ARM,
    METHOD_PILOT_EXPLORATORY_LABEL,
    analyzeMethodPilotExploratory,
    assertReproducedVerdictTable,
    buildExploratoryClusterTable,
    buildPerModelPerMethodTable,
    computePerQueryBreakdown,
    computePointEstimates,
    detectRecoveredErrorComponents,
    runPairedQueryClusterBootstrap,
} from "../../../scripts/eval/judge/method-pilot-exploratory.js";
import { METHOD_IDS } from "../../../scripts/eval/judge/method-comparison-contract.js";
import {
    __test__brandPilotCorpusRoster,
    type PilotCorpusRoster,
} from "../../../scripts/eval/judge/method-pilot-fixture.js";
import type { MethodPilotProbabilityRow } from "../../../scripts/eval/judge/method-pilot-selector.js";
import { FROZEN_CHALLENGER_ARMS, INCUMBENT_ARM } from "../../../scripts/eval/judge/model-comparison-stats.js";
import type { ComparisonModelId } from "../../../scripts/eval/judge/model-comparison-types.js";

const ARMS: readonly ComparisonModelId[] = [INCUMBENT_ARM, ...FROZEN_CHALLENGER_ARMS];
const QUERIES = ["q1", "q2", "q3"] as const;

function syntheticRoster(): PilotCorpusRoster {
    const candidates: PilotCorpusRoster["candidates"][number][] = [];
    for (const qid of QUERIES) {
        candidates.push({ cid: `${qid}-c1`, qid, file: `src/${qid}.ts`, startLine: 1, endLine: 10, label: "gold" });
        candidates.push({ cid: `${qid}-c2`, qid, file: `src/${qid}.ts`, startLine: 11, endLine: 20, label: "hard_negative" });
    }
    return __test__brandPilotCorpusRoster({
        queries: QUERIES.map((qid) => ({ qid, answerable: true })),
        candidates,
        sourceRef: "synthetic-exploratory-source-ref",
        manifestSha256: "synthetic-exploratory-manifest-sha",
    });
}

function syntheticRows(): MethodPilotProbabilityRow[] {
    const rows: MethodPilotProbabilityRow[] = [];
    for (const arm of ARMS) {
        const lunaM1Gold = arm === EXPLORATORY_DRIVER_ARM;
        for (const qid of QUERIES) {
            for (const replica of [0, 1]) {
                rows.push({
                    model: arm, method: "M0", queryGroup: qid, candidateId: `${qid}-c1`,
                    label: "gold", replica, probability: 0.8, forward: null, reverse: null,
                });
                rows.push({
                    model: arm, method: "M0", queryGroup: qid, candidateId: `${qid}-c2`,
                    label: "hard_negative", replica, probability: 0.5, forward: null, reverse: null,
                });
                rows.push({
                    model: arm, method: "M1", queryGroup: qid, candidateId: `${qid}-c1`,
                    label: "gold", replica, probability: lunaM1Gold ? 0.6 : 0.3, forward: null, reverse: null,
                });
                rows.push({
                    model: arm, method: "M1", queryGroup: qid, candidateId: `${qid}-c2`,
                    label: "hard_negative", replica, probability: 0.1, forward: null, reverse: null,
                });
                rows.push({
                    model: arm, method: "M2", queryGroup: qid, candidateId: `${qid}-c1`,
                    label: "gold", replica, probability: null, forward: 0.9, reverse: 0.7,
                });
                rows.push({
                    model: arm, method: "M2", queryGroup: qid, candidateId: `${qid}-c2`,
                    label: "hard_negative", replica, probability: null, forward: 0.3, reverse: 0.5,
                });
            }
        }
    }
    return rows;
}

describe("method-pilot-exploratory cluster table (synthetic rows)", () => {
    it("derives per-query loss with replicas averaged before thresholding", () => {
        const table = buildExploratoryClusterTable(syntheticRoster(), syntheticRows());
        expect(table.queryIds).toEqual([...QUERIES]);
        expect(table.series).toHaveLength(ARMS.length * METHOD_IDS.length);
        const lunaM1 = table.series.find((s) => s.model === EXPLORATORY_DRIVER_ARM && s.method === "M1")!;
        expect(lunaM1.perQueryLoss).toEqual([0, 0, 0]);
        expect(lunaM1.perQueryFn).toEqual([0, 0, 0]);
        const jevM1 = table.series.find((s) => s.model === INCUMBENT_ARM && s.method === "M1")!;
        expect(jevM1.perQueryLoss).toEqual([6, 6, 6]);
        expect(jevM1.perQueryFn).toEqual([1, 1, 1]);
        const jevM2 = table.series.find((s) => s.model === INCUMBENT_ARM && s.method === "M2")!;
        expect(jevM2.perQueryLoss).toEqual([1, 1, 1]);
        expect(jevM2.perQueryFp).toEqual([1, 1, 1]);
    });

    it("reproduces the hand-computed loss table and point estimates", () => {
        const table = buildExploratoryClusterTable(syntheticRoster(), syntheticRows());
        const rows = buildPerModelPerMethodTable(table);
        expect(rows).toHaveLength(9);
        for (const row of rows) {
            const expectedLoss = row.method === "M1"
                ? (row.model === EXPLORATORY_DRIVER_ARM ? 0 : 18)
                : 3;
            expect(row.loss).toBe(expectedLoss);
            expect(row.lossPerQuery).toBe(expectedLoss / 3);
        }
        const points = computePointEstimates(table);
        const sByMethod = new Map(points.averagedPerMethod.map((row) => [row.method, row.s]));
        expect(sByMethod.get("M0")).toBe(1);
        expect(sByMethod.get("M1")).toBeCloseTo(4, 12);
        expect(sByMethod.get("M2")).toBe(1);
        const d1 = points.lossContrasts.find((c) => c.contrast === "D(M1-M0)" && c.scope === "averaged")!;
        expect(d1.estimate).toBeCloseTo(-3, 12);
        const d2 = points.lossContrasts.find((c) => c.contrast === "D(M2-M0)" && c.scope === "averaged")!;
        expect(d2.estimate).toBe(0);
        expect(points.spread).toBeCloseTo(6, 12);
        const lunaD = points.lossContrasts.find((c) => c.contrast === "D(M1-M0)" && c.scope === EXPLORATORY_DRIVER_ARM)!;
        expect(lunaD.estimate).toBe(1);
    });

    it("excludes whole query clusters (sensitivity) and fails closed on null components", () => {
        const roster = syntheticRoster();
        const table = buildExploratoryClusterTable(roster, syntheticRows(), ["q2"]);
        expect(table.queryIds).toEqual(["q1", "q3"]);
        const rowsWithNull = syntheticRows().map((row) =>
            row.model === INCUMBENT_ARM && row.method === "M0" && row.queryGroup === "q1" && row.candidateId === "q1-c1" && row.replica === 1
                ? { ...row, probability: null }
                : row);
        expect(() => buildExploratoryClusterTable(roster, rowsWithNull)).toThrow(/null M0 probability/);
    });
});

describe("method-pilot-exploratory bootstrap and breakdown", () => {
    it("is deterministic for a fixed seed and yields ordered intervals", () => {
        const table = buildExploratoryClusterTable(syntheticRoster(), syntheticRows());
        const first = runPairedQueryClusterBootstrap(table, 200, 20261008);
        const second = runPairedQueryClusterBootstrap(table, 200, 20261008);
        expect(second).toEqual(first);
        const analysis = analyzeMethodPilotExploratory(table, 200, 20261008);
        expect(analysis.label).toBe(METHOD_PILOT_EXPLORATORY_LABEL);
        expect(analysis.queryClusters).toBe(3);
        for (const contrast of analysis.intervals.lossContrasts) {
            expect(contrast.interval.lower).toBeLessThanOrEqual(contrast.interval.upper);
        }
    });

    it("counts per-query wins/ties/losses vs M0 and ranks the driver arm's contributors", () => {
        const table = buildExploratoryClusterTable(syntheticRoster(), syntheticRows());
        const breakdown = computePerQueryBreakdown(table);
        const jevM1 = breakdown.winTieLossVsM0.find((r) => r.model === INCUMBENT_ARM && r.method === "M1")!;
        expect(jevM1).toMatchObject({ wins: 0, ties: 0, losses: 3 });
        const lunaM1 = breakdown.winTieLossVsM0.find((r) => r.model === EXPLORATORY_DRIVER_ARM && r.method === "M1")!;
        expect(lunaM1).toMatchObject({ wins: 3, ties: 0, losses: 0 });
        const jevM2 = breakdown.winTieLossVsM0.find((r) => r.model === INCUMBENT_ARM && r.method === "M2")!;
        expect(jevM2).toMatchObject({ wins: 0, ties: 3, losses: 0 });
        expect(breakdown.topContributors).toHaveLength(3);
        for (const contributor of breakdown.topContributors) {
            expect(contributor.contribution).toBe(1);
        }
        expect(breakdown.topContributors.map((c) => c.queryGroup)).toEqual(["q1", "q2", "q3"]);
    });
});

describe("method-pilot-exploratory verdict reproduction and error detection", () => {
    it("accepts a byte-identical verdict table and rejects a mutated one", () => {
        const table = buildExploratoryClusterTable(syntheticRoster(), syntheticRows());
        const reproduced = buildPerModelPerMethodTable(table);
        expect(() => assertReproducedVerdictTable(reproduced, JSON.parse(JSON.stringify(reproduced)))).not.toThrow();
        const mutated = JSON.parse(JSON.stringify(reproduced)) as typeof reproduced;
        mutated[4]!.loss += 1;
        expect(() => assertReproducedVerdictTable(reproduced, mutated)).toThrow(/reproduction mismatch/);
    });

    it("detects recovered-error components and their affected query groups", () => {
        const rows: unknown[] = [
            { arm: INCUMBENT_ARM, method: "M1", replica: 1, queryGroup: "q1", direction: "isolated", candidateIds: ["q1-c1"], attemptIndex: 1, httpStatus: 529, errorClass: "capture_gap", wireId: "w1" },
            { arm: INCUMBENT_ARM, method: "M1", replica: 1, queryGroup: "q1", direction: "isolated", candidateIds: ["q1-c1"], attemptIndex: 2, httpStatus: 200, errorClass: null, wireId: "w2" },
            { arm: INCUMBENT_ARM, method: "M0", replica: 0, queryGroup: "q3", direction: "forward", candidateIds: ["q3-c1"], attemptIndex: 1, httpStatus: 200, errorClass: null, wireId: "w3" },
        ];
        const { components, affectedQueryGroups } = detectRecoveredErrorComponents(rows);
        expect(components).toHaveLength(1);
        expect(components[0]).toMatchObject({ queryGroup: "q1", recovered: true });
        expect(components[0]!.attempts.map((a) => a.attemptIndex)).toEqual([1, 2]);
        expect(affectedQueryGroups).toEqual(["q1"]);
    });
});
