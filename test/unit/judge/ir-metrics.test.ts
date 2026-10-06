import { describe, expect, it } from "vitest";
import {
    averagePrecision,
    bootstrapCI,
    correctAbstentionRate,
    expectedCalibrationError,
    expectedUtility,
    falseNoResultsRate,
    meanReciprocalRank,
    ndcgAtK,
    pairedBootstrapDiff,
    precisionAtK,
    prCurveFromScores,
    recallAtK,
    reciprocalRank,
} from "../../../scripts/eval/judge/ir-metrics.js";

describe("precisionAtK / recallAtK", () => {
    it("computes precision over the top-k window", () => {
        expect(precisionAtK([true, false, true], 2)).toBeCloseTo(0.5);
        expect(precisionAtK([true, true], 5)).toBeCloseTo(1);
    });
    it("rejects bad k and empty rankings", () => {
        expect(() => precisionAtK([], 5)).toThrow();
        expect(() => precisionAtK([true], 0)).toThrow();
    });
    it("computes recall against the total relevant count", () => {
        expect(recallAtK([true, false, true], 4, 3)).toBeCloseTo(2 / 3);
        expect(recallAtK([false, false], 2, 2)).toBe(0);
    });
    it("rejects non-positive total relevant", () => {
        expect(() => recallAtK([true], 1, 0)).toThrow();
    });
});

describe("reciprocalRank / MRR", () => {
    it("returns 0 when nothing relevant is retrieved", () => {
        expect(reciprocalRank([false, false])).toBe(0);
    });
    it("returns 1/rank of the first hit", () => {
        expect(reciprocalRank([false, false, true])).toBeCloseTo(1 / 3);
    });
    it("averages per-query reciprocal ranks", () => {
        expect(meanReciprocalRank([[true], [false, true]])).toBeCloseTo(0.75);
    });
    it("rejects empty input", () => {
        expect(() => meanReciprocalRank([])).toThrow();
    });
});

describe("nDCG@k", () => {
    it("scores a perfect ranking as 1", () => {
        expect(ndcgAtK([3, 2, 1], 3)).toBeCloseTo(1);
    });
    it("is 0 when no gains exist", () => {
        expect(ndcgAtK([0, 0], 2)).toBe(0);
    });
    it("uses the full ranking for the ideal, not the top-k slice", () => {
        // Ideal@1 is gain 3 (elsewhere in the ranking), so nDCG = 1/3, not 1.
        expect(ndcgAtK([1, 0, 3], 1)).toBeCloseTo(1 / 3);
    });
    it("counts relevant items that were not retrieved via idealGains", () => {
        // Best relevant item (gain 3) was not retrieved: ideal@1 = 3.
        expect(ndcgAtK([1], 1, [3, 1])).toBeCloseTo(1 / 3);
        // Perfect retrieval against the same ideal scores 1.
        expect(ndcgAtK([3, 1], 2, [3, 1])).toBeCloseTo(1);
    });
    it("rejects bad idealGains", () => {
        expect(() => ndcgAtK([1], 1, [])).toThrow();
        expect(() => ndcgAtK([1], 1, [Number.NaN])).toThrow();
        expect(() => ndcgAtK([1], 1, [-1])).toThrow();
    });
    it("rejects NaN gains and bad k", () => {
        expect(() => ndcgAtK([Number.NaN], 1)).toThrow();
        expect(() => ndcgAtK([1], 0)).toThrow();
    });
});

describe("abstention rates", () => {
    const queries = [
        { answerable: true, resultCount: 0 },
        { answerable: true, resultCount: 3 },
        { answerable: false, resultCount: 0 },
        { answerable: false, resultCount: 2 },
    ];
    it("measures false no-results over answerable queries", () => {
        expect(falseNoResultsRate(queries)).toBeCloseTo(0.5);
    });
    it("measures correct abstention over unanswerable queries", () => {
        expect(correctAbstentionRate(queries)).toBeCloseTo(0.5);
    });
    it("returns null when the denominator set is empty", () => {
        expect(falseNoResultsRate([{ answerable: false, resultCount: 0 }])).toBeNull();
        expect(correctAbstentionRate([{ answerable: true, resultCount: 1 }])).toBeNull();
    });
    it("rejects negative counts", () => {
        expect(() => falseNoResultsRate([{ answerable: true, resultCount: -1 }])).toThrow();
    });
});

describe("prCurveFromScores", () => {
    it("handles ties as a single step and reports AP", () => {
        const { points, averagePrecision: ap } = prCurveFromScores([
            { score: 0.9, relevant: true },
            { score: 0.9, relevant: false },
            { score: 0.1, relevant: true },
        ]);
        expect(points).toHaveLength(2);
        expect(ap).toBeCloseTo(averagePrecision([
            { score: 0.9, relevant: true },
            { score: 0.9, relevant: false },
            { score: 0.1, relevant: true },
        ]));
    });
    it("rejects empty pairs and NaN scores", () => {
        expect(() => prCurveFromScores([])).toThrow();
        expect(() => prCurveFromScores([{ score: Number.NaN, relevant: true }])).toThrow();
    });
});

describe("ECE", () => {
    it("returns a reliability table with fixed equal-width bins", () => {
        const { ece, bins } = expectedCalibrationError(
            [0.1, 0.9, 0.8, 0.2],
            [false, true, true, false],
            2,
        );
        expect(bins).toHaveLength(2);
        expect(bins[0]).toMatchObject({ lo: 0, hi: 0.5 });
        expect(ece).toBeGreaterThanOrEqual(0);
    });
    it("rejects mismatched lengths", () => {
        expect(() => expectedCalibrationError([0.5], [], 10)).toThrow();
    });
});

describe("expectedUtility", () => {
    const rows = [
        { score: 0.9, relevant: true },
        { score: 0.4, relevant: false },
        { score: 0.1, relevant: true },
    ];
    const costs = { tp: 1, tn: 0, fp: -1, fn: -2 };
    it("returns the utility-optimal threshold", () => {
        const { best, sweep } = expectedUtility(rows, costs);
        expect(sweep.length).toBeGreaterThan(0);
        expect(sweep.map((r) => r.threshold)).toContain(best.threshold);
        for (const row of sweep) expect(row.utility).toBeLessThanOrEqual(best.utility);
    });
    it("rejects non-finite costs", () => {
        expect(() => expectedUtility(rows, { ...costs, fp: Number.NaN })).toThrow();
    });
});

describe("bootstrapCI", () => {
    const values = [0, 1, 0, 1, 1];
    const mean = (v: number[]): number => v.reduce((a, b) => a + b, 0) / v.length;
    it("is deterministic for a fixed seed and brackets the estimate", () => {
        const a = bootstrapCI(values, mean, { iterations: 200, seed: 7, alpha: 0.05 });
        const b = bootstrapCI(values, mean, { iterations: 200, seed: 7, alpha: 0.05 });
        expect(a).toEqual(b);
        expect(a.lower).toBeLessThanOrEqual(a.estimate);
        expect(a.upper).toBeGreaterThanOrEqual(a.estimate);
    });
    it("supports cluster resampling", () => {
        const r = bootstrapCI(values, mean, {
            iterations: 100, seed: 3, alpha: 0.1, clusters: ["a", "a", "b", "b", "c"],
        });
        expect(r.lower).toBeLessThanOrEqual(r.upper);
    });
    it("rejects empty values and mismatched clusters", () => {
        expect(() => bootstrapCI([], mean, { iterations: 10, seed: 1, alpha: 0.05 })).toThrow();
        expect(() => bootstrapCI(values, mean, {
            iterations: 10, seed: 1, alpha: 0.05, clusters: ["a"],
        })).toThrow();
    });
});

describe("pairedBootstrapDiff", () => {
    const pairs = [
        { id: "q1", baseline: 0, variant: 1 },
        { id: "q2", baseline: 1, variant: 1 },
    ];
    const mean = (v: number[]): number => v.reduce((a, b) => a + b, 0) / v.length;
    it("estimates the mean paired improvement", () => {
        const r = pairedBootstrapDiff(pairs, mean, { iterations: 200, seed: 11, alpha: 0.05 });
        expect(r.estimate).toBeCloseTo(0.5);
        expect(r.lower).toBeLessThanOrEqual(r.upper);
    });
    it("rejects duplicate ids", () => {
        expect(() => pairedBootstrapDiff([...pairs, pairs[0]!], mean, {
            iterations: 10, seed: 1, alpha: 0.05,
        })).toThrow();
    });
});
