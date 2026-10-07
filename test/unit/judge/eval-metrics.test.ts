import { describe, expect, it } from "vitest";
import {
    bestThresholdByCost,
    computeJudgeMetrics,
    percentile,
    prCurve,
    rocCurve,
    thresholdSweep,
} from "../../../scripts/eval/judge/metrics.js";

describe("judge evaluation metrics", () => {
    it("computes tie-aware AUROC, ECE, and threshold precision/recall", () => {
        const metrics = computeJudgeMetrics([
            { label: "gold", p: 0.9 },
            { label: "gold", p: 0.6 },
            { label: "hard_negative", p: 0.6 },
            { label: "easy_negative", p: 0.1 },
        ], [0.2, 0.45], 2);

        expect(metrics.auroc).toBe(0.875);
        expect(metrics.ece).toBeCloseTo(0.05);
        expect(metrics.thresholds["0.2"]).toEqual({
            precision: 2 / 3,
            recall: 1,
            truePositives: 2,
            falsePositives: 1,
            falseNegatives: 0,
        });
    });

    it("returns null for undefined population metrics and validates probabilities", () => {
        expect(computeJudgeMetrics([]).auroc).toBeNull();
        expect(computeJudgeMetrics([{ label: "gold", p: 0.8 }]).auroc).toBeNull();
        expect(() => computeJudgeMetrics([{ label: "gold", p: 1.01 }])).toThrow("scores must be probabilities");
    });

    it("uses nearest-rank percentiles and handles empty samples", () => {
        expect(percentile([50, 10, 40, 20, 30], 0.5)).toBe(30);
        expect(percentile([], 0.95)).toBeNull();
    });
});

describe("judge ROC/PR curves", () => {
    const fixture = [
        { label: "gold", p: 0.9 },
        { label: "gold", p: 0.8 },
        { label: "gold", p: 0.4 },
        { label: "gold", p: 0.3 },
        { label: "hard_negative", p: 0.7 },
        { label: "hard_negative", p: 0.5 },
        { label: "easy_negative", p: 0.2 },
        { label: "easy_negative", p: 0.1 },
    ] as const;

    it("sweeps distinct scores with endpoints and matches AUROC", () => {
        const rows = fixture.map((row) => ({ ...row }));
        const { points, auc } = rocCurve(rows);
        expect(auc).toBe(0.75);
        expect(auc).toBe(computeJudgeMetrics(rows).auroc);
        expect(points[0]).toEqual({ threshold: Number.POSITIVE_INFINITY, fpr: 0, tpr: 0 });
        expect(points[points.length - 1]).toEqual({ threshold: 0, fpr: 1, tpr: 1 });
        expect(points).toHaveLength(10);
    });

    it("computes stepwise average precision", () => {
        const rows = fixture.map((row) => ({ ...row }));
        const { points, averagePrecision } = prCurve(rows);
        expect(averagePrecision).toBeCloseTo(0.8167, 4);
        expect(points[0]).toEqual({ threshold: Number.POSITIVE_INFINITY, precision: 0, recall: 0 });
        expect(points[points.length - 1]?.recall).toBe(1);
    });

    it("returns null curves for single-class input", () => {
        expect(rocCurve([])).toEqual({ points: [], auc: null });
        expect(prCurve([{ label: "gold", p: 0.8 }])).toEqual({ points: [], averagePrecision: null });
    });
});

describe("judge threshold sweep and cost", () => {
    const fixture = [
        { label: "gold", p: 0.9 },
        { label: "gold", p: 0.8 },
        { label: "gold", p: 0.4 },
        { label: "gold", p: 0.3 },
        { label: "hard_negative", p: 0.7 },
        { label: "hard_negative", p: 0.5 },
        { label: "easy_negative", p: 0.2 },
        { label: "easy_negative", p: 0.1 },
    ] as const;

    it("covers 0.00..1.00 with exact counts at 0.50", () => {
        const rows = fixture.map((row) => ({ ...row }));
        const sweep = thresholdSweep(rows);
        expect(sweep).toHaveLength(21);
        expect(sweep[0]?.threshold).toBe(0);
        expect(sweep[sweep.length - 1]?.threshold).toBe(1);
        const atHalf = sweep.find((row) => row.threshold === 0.5);
        expect(atHalf).toMatchObject({
            truePositives: 2,
            falsePositives: 2,
            falseNegatives: 2,
            trueNegatives: 2,
            precision: 0.5,
            recall: 0.5,
            f1: 0.5,
        });
    });

    it("finds the zero-cost threshold on a separable fixture", () => {
        const rows = [
            { label: "gold", p: 0.9 },
            { label: "gold", p: 0.6 },
            { label: "hard_negative", p: 0.55 },
            { label: "easy_negative", p: 0.2 },
        ] as const;
        const best = bestThresholdByCost(rows.map((row) => ({ ...row })), 1);
        expect(best).toMatchObject({ threshold: 0.6, cost: 0, falsePositives: 0, falseNegatives: 0 });
    });

    it("picks a lower threshold when missing positives costs more", () => {
        const rows = [
            { label: "gold", p: 0.9 },
            { label: "gold", p: 0.35 },
            { label: "hard_negative", p: 0.5 },
            { label: "hard_negative", p: 0.4 },
            { label: "easy_negative", p: 0.3 },
        ] as const;
        const cheap = bestThresholdByCost(rows.map((row) => ({ ...row })), 1);
        const pricey = bestThresholdByCost(rows.map((row) => ({ ...row })), 10);
        expect(cheap?.threshold).toBe(0.55);
        expect(pricey?.threshold).toBe(0.35);
        expect(pricey!.threshold).toBeLessThan(cheap!.threshold);
    });
});
