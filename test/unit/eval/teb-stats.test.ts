/**
 * Unit tests for the TEB statistics. Fully synthetic: majority
 * aggregation, seeded bootstrap determinism and CI shape, repo-clustered
 * sensitivity, exact McNemar against hand-computed values, and gate
 * evaluation (pass and each veto firing).
 */
import { describe, expect, it } from "vitest";
import {
    evaluateGates,
    majorityPass,
    mcnemarExact,
    mulberry32,
    pairedBootstrap,
    repoSensitivity,
    successRate,
    taskDiffs,
} from "../../../scripts/eval/teb/stats.js";
import type { TebGateValues, TebPairedTask } from "../../../scripts/eval/teb/stats.js";

function task(id: string, repo: string, basePass: boolean, armPass: boolean): TebPairedTask {
    return { taskId: id, repo, family: "definition", negativeControl: false, basePass, armPass };
}

const GATES: TebGateValues = {
    minSuccessGainPp: 5,
    minRecallGainPp: 15,
    minSpecialistPrecision: 0.8,
    maxNegativeDeteriorationPp: 3,
    maxLostPriorSuccessRate: 0.05,
};

describe("majorityPass", () => {
    it("passes fractions above one half; ties fail", () => {
        expect(majorityPass([true, true, false])).toBe(true);
        expect(majorityPass([true, false, false])).toBe(false);
        expect(majorityPass([true, false])).toBe(false);
        expect(majorityPass([])).toBe(false);
        expect(majorityPass([true])).toBe(true);
    });
});

describe("mulberry32", () => {
    it("is deterministic per seed and varies across seeds", () => {
        const a = mulberry32(7);
        const b = mulberry32(7);
        expect([a(), a(), a()]).toEqual([b(), b(), b()]);
        expect(mulberry32(8)()).not.toBe(mulberry32(9)());
    });
});

describe("pairedBootstrap", () => {
    it("is seeded-deterministic with CI bracketing the mean", () => {
        const diffs = [1, 1, 0, -1, 0, 1, 0, 0, 1, -1];
        const first = pairedBootstrap(diffs, 2000, 42);
        const second = pairedBootstrap(diffs, 2000, 42);
        expect(first).toEqual(second);
        expect(first.lo).toBeLessThanOrEqual(first.mean);
        expect(first.hi).toBeGreaterThanOrEqual(first.mean);
        expect(first.mean).toBeCloseTo(0.2, 10);
    });

    it("handles empty input", () => {
        expect(pairedBootstrap([], 100, 1)).toEqual({ mean: 0, lo: 0, hi: 0, draws: 100, seed: 1 });
    });
});

describe("taskDiffs and successRate", () => {
    it("maps paired outcomes to {-1, 0, 1}", () => {
        const tasks = [task("a", "r1", true, true), task("b", "r1", true, false), task("c", "r1", false, true)];
        expect(taskDiffs(tasks)).toEqual([0, -1, 1]);
        expect(successRate(tasks, "base")).toBeCloseTo(2 / 3, 10);
        expect(successRate(tasks, "arm")).toBeCloseTo(2 / 3, 10);
        expect(successRate([], "arm")).toBe(0);
    });
});

describe("repoSensitivity", () => {
    it("reports leave-one-out diffs and a cluster CI", () => {
        const tasks = [
            task("a", "r1", false, true),
            task("b", "r1", false, true),
            task("c", "r2", true, true),
            task("d", "r2", true, false),
        ];
        const sens = repoSensitivity(tasks, 500, 3);
        expect(sens.leaveOneOut).toHaveLength(2);
        const heldOutR1 = sens.leaveOneOut.find((r) => r.heldOut === "r1");
        // Without r1 only c (0) and d (-1) remain: mean -0.5.
        expect(heldOutR1?.diff).toBeCloseTo(-0.5, 10);
        expect(sens.clusterBootstrap.lo).toBeLessThanOrEqual(sens.clusterBootstrap.mean);
    });
});

describe("mcnemarExact", () => {
    it("matches hand-computed exact two-sided values", () => {
        // n=1, k=0: 2 * 0.5 = 1.
        expect(mcnemarExact(1, 0).p).toBeCloseTo(1, 10);
        // n=6, k=0: 2 * (1/64) = 0.03125.
        expect(mcnemarExact(6, 0).p).toBeCloseTo(0.03125, 10);
        // Symmetry in b/c.
        expect(mcnemarExact(2, 5).p).toBeCloseTo(mcnemarExact(5, 2).p, 10);
        // No discordant pairs: p = 1.
        expect(mcnemarExact(0, 0).p).toBe(1);
    });
});

describe("evaluateGates", () => {
    function strongArm(): TebPairedTask[] {
        const tasks: TebPairedTask[] = [];
        for (let i = 0; i < 40; i++) {
            tasks.push(task(`t-${i}`, `repo-${i % 4}`, i % 4 !== 0, true));
        }
        for (let i = 0; i < 40; i++) {
            tasks.push({
                taskId: `n-${i}`,
                repo: `repo-${i % 4}`,
                family: "config-value",
                negativeControl: true,
                basePass: true,
                armPass: true,
            });
        }
        return tasks;
    }

    it("passes a clean sweep with room to spare", () => {
        const report = evaluateGates(
            { paired: strongArm(), recallGainPp: 20, armPrecision: 0.9 },
            GATES,
            2000,
            11,
        );
        expect(report.passed).toBe(true);
        expect(report.gates.every((g) => g.passed)).toBe(true);
        expect(report.lostPriorSuccesses).toEqual([]);
    });

    it("fails success-gain when the CI is not positive", () => {
        const paired = [task("a", "r1", true, false), task("b", "r1", false, false)];
        const report = evaluateGates({ paired, recallGainPp: 20, armPrecision: 0.9 }, GATES, 500, 1);
        expect(report.gates.find((g) => g.id === "success-gain")?.passed).toBe(false);
        expect(report.passed).toBe(false);
    });

    it("vetoes paired-tested negative deterioration past the cap", () => {
        // 40 negatives: base passes all, arm fails 6 -> 15pp deterioration,
        // McNemar(6,0) p = 0.03125 < 0.05: veto fires.
        const paired: TebPairedTask[] = [];
        for (let i = 0; i < 40; i++) {
            paired.push({
                taskId: `n-${i}`,
                repo: "r1",
                family: "config-value",
                negativeControl: true,
                basePass: true,
                armPass: i >= 6,
            });
        }
        const report = evaluateGates(
            { paired, recallGainPp: 99, armPrecision: 1 },
            GATES,
            500,
            1,
        );
        const veto = report.gates.find((g) => g.id === "negative-veto");
        expect(report.negativeMcNemar.p).toBeLessThan(0.05);
        expect(veto?.passed).toBe(false);
    });

    it("does not veto single-task noise on tiny negative sets", () => {
        // One negative task flipping is 100pp but McNemar(1,0) p = 1.
        const paired: TebPairedTask[] = [
            {
                taskId: "n-0",
                repo: "r1",
                family: "config-value",
                negativeControl: true,
                basePass: true,
                armPass: false,
            },
        ];
        const report = evaluateGates(
            { paired, recallGainPp: 99, armPrecision: 1 },
            GATES,
            500,
            1,
        );
        expect(report.gates.find((g) => g.id === "negative-veto")?.passed).toBe(true);
    });

    it("caps lost prior successes against the B-passed denominator", () => {
        const paired = [
            task("a", "r1", true, false),
            task("b", "r1", true, true),
            task("c", "r1", false, true),
        ];
        const report = evaluateGates(
            { paired, recallGainPp: 99, armPrecision: 1 },
            { ...GATES, minSuccessGainPp: -100 },
            500,
            1,
        );
        // Lost 1 of 2 B-passed = 50% > 5%: veto fires with the right ids.
        expect(report.lostPriorSuccesses).toEqual(["a"]);
        expect(report.gates.find((g) => g.id === "lost-successes")?.passed).toBe(false);
    });
});
