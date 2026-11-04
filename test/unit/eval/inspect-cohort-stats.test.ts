import { describe, expect, it } from "vitest";
import { majorityOutcome, pairedBootstrap, mcnemarExact, negativeHarmVeto, calibrationGates, orderedLatencyCeiling, sizeForMde } from "../../../scripts/eval/inspect-cohort/stats.js";

describe("inspect cohort statistics", () => {
    it("uses strict majority and fails ties", () => {
        expect(majorityOutcome([true, false])).toBe(false);
        expect(majorityOutcome([true, true, false])).toBe(true);
        expect(majorityOutcome([])).toBe(false);
    });
    it("returns reproducible paired bootstrap intervals", () => {
        expect(pairedBootstrap([1, 0, -1, 1], 500, 42)).toEqual(pairedBootstrap([1, 0, -1, 1], 500, 42));
    });
    it("computes exact McNemar values and applies both veto thresholds", () => {
        expect(mcnemarExact(5, 0).p).toBe(0.0625);
        expect(mcnemarExact(6, 0).p).toBe(0.03125);
        expect(negativeHarmVeto({ deteriorationPp: 4, b: 6, c: 0 })).toBe(true);
        expect(negativeHarmVeto({ deteriorationPp: 3, b: 6, c: 0 })).toBe(false);
    });
    it("leaves calibration gates unset and reports ordered-statistic latency", () => {
        expect(calibrationGates).toEqual({ falseCompletenessCap: null, invalidCallMargin: null, costCeiling: null, latencyCeilingMs: null });
        expect(orderedLatencyCeiling([10, 20, 30, 40, 50])).toEqual({ value: 50, rank: 5, n: 5 });
    });
    it("sizes confirmation from pilot discordance and target effect", () => {
        expect(sizeForMde(0.5, 0.2)).toBeGreaterThan(sizeForMde(0.5, 0.3));
        expect(sizeForMde(0.5, 0.1, 0.01, 0.9)).toBeGreaterThan(sizeForMde(0.5, 0.1, 0.05, 0.8));
    });
});
