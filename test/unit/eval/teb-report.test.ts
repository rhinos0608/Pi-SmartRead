/**
 * Unit tests for the TEB reporter. Synthetic aggregates only: per-family
 * rows, markdown sections per arm, gate lines, and the JSON payload shape.
 */
import { describe, expect, it } from "vitest";
import { aggregateRunMetrics, scoreRunMetrics } from "../../../scripts/eval/teb/metrics.js";
import { buildTebReport, familyRows } from "../../../scripts/eval/teb/report.js";
import type { TebArmSummary } from "../../../scripts/eval/teb/report.js";
import { extractRunFromText } from "../../../scripts/eval/teb/extract.js";
import {
    evaluateGates,
    pairedBootstrap,
    repoSensitivity,
} from "../../../scripts/eval/teb/stats.js";
import type { TebGateValues, TebPairedTask } from "../../../scripts/eval/teb/stats.js";
import type { TebTask } from "../../../scripts/eval/teb/schema.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";

function task(id: string, family: TebTask["family"]): TebTask {
    return {
        id,
        split: "pilot",
        repo: "egoist__tsup",
        commit: SHA,
        subpath: "src",
        family,
        prompt: "synthetic",
        scope: "",
        answerType: "scalar",
        gold: { kind: "scalar", value: "x" },
        opportunity: { tools: [], rationale: "negative control" },
        negativeControl: true,
        derivation: "synthetic",
        agreement: "agree",
        labelers: ["a", "b"],
        adjudication: "agree",
    };
}

function arm(id: string, paired: TebPairedTask[]): TebArmSummary {
    const t = task("teb-pilot-config-value-001", "config-value");
    const run = extractRunFromText("");
    const scored = [{ task: t, run, metrics: scoreRunMetrics(t, run) }];
    return {
        armId: id,
        paired,
        aggregates: aggregateRunMetrics(scored),
        primaryBootstrap: pairedBootstrap(paired.map((p) => (p.armPass ? 1 : 0) - (p.basePass ? 1 : 0)), 200, 5),
    };
}

function paired(family: string, basePass: boolean, armPass: boolean): TebPairedTask {
    return { taskId: `${family}-1`, repo: "egoist__tsup", family, negativeControl: true, basePass, armPass };
}

const GATE_VALUES: TebGateValues = {
    minSuccessGainPp: 5,
    minRecallGainPp: 15,
    minSpecialistPrecision: 0.8,
    maxNegativeDeteriorationPp: 3,
    maxLostPriorSuccessRate: 0.05,
};

describe("familyRows", () => {
    it("computes per-family base/arm rates and gains", () => {
        const base = [paired("config-value", true, true), paired("config-value", false, false)];
        const rows = familyRows(base, base);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.tasks).toBe(2);
        expect(rows[0]?.baseRate).toBeCloseTo(0.5, 10);
        expect(rows[0]?.gainPp).toBeCloseTo(0, 10);
    });

    it("pairs over common task ids and renders unrun families as n/a, never 0%", () => {
        const base: TebPairedTask[] = [
            { taskId: "def-1", repo: "r", family: "definition", negativeControl: false, basePass: true, armPass: true },
            { taskId: "neg-1", repo: "r", family: "file-by-name", negativeControl: true, basePass: true, armPass: true },
        ];
        // Instructed arm intentionally did not run the negative control:
        // its paired list holds only the common definition task.
        const instructed: TebPairedTask[] = [
            { taskId: "def-1", repo: "r", family: "definition", negativeControl: false, basePass: true, armPass: true },
        ];
        const rows = familyRows(base, instructed);
        expect(rows).toHaveLength(2);
        const def = rows.find((r) => r.family === "definition");
        expect(def?.tasks).toBe(1);
        expect(def?.baseRate).toBeCloseTo(1, 10);
        expect(def?.armRate).toBeCloseTo(1, 10);
        const skipped = rows.find((r) => r.family === "file-by-name");
        expect(skipped?.tasks).toBe(0);
        expect(skipped?.baseRate).toBeNull();
        expect(skipped?.armRate).toBeNull();
        expect(skipped?.gainPp).toBeNull();
        const baseline = arm("B", base);
        const champion = arm("A1", instructed);
        const report = buildTebReport({
            arms: [baseline, champion],
            gateValues: GATE_VALUES,
            gateReport: evaluateGates(
                { paired: instructed, recallGainPp: 0, armPrecision: null },
                GATE_VALUES,
                50,
                1,
            ),
            sensitivity: repoSensitivity(instructed, 50, 1),
        });
        expect(report.markdown).toContain("| file-by-name | 0 | n/a | n/a | n/a |");
        expect(report.markdown).not.toContain("| file-by-name | 1 | 100.0% | 0.0%");
    });

    it("uses the comparison's matched baseline votes, not the standalone baseline rate", () => {
        // Standalone baseline ran two config-value tasks (1/2 = 50%), but
        // this comparison shares only t1, where the matched baseline vote
        // is fail. The row must show base 0% over 1 task — the matched
        // vote — never the standalone 50%.
        const standalone: TebPairedTask[] = [
            { taskId: "t1", repo: "r", family: "config-value", negativeControl: true, basePass: true, armPass: true },
            { taskId: "t2", repo: "r", family: "config-value", negativeControl: true, basePass: false, armPass: false },
        ];
        const matched: TebPairedTask[] = [
            { taskId: "t1", repo: "r", family: "config-value", negativeControl: true, basePass: false, armPass: true },
        ];
        const rows = familyRows(standalone, matched);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.tasks).toBe(1);
        expect(rows[0]?.baseRate).toBeCloseTo(0, 10);
        expect(rows[0]?.armRate).toBeCloseTo(1, 10);
        expect(rows[0]?.gainPp).toBeCloseTo(100, 10);
    });
});

describe("buildTebReport", () => {
    it("renders markdown and JSON for baseline plus one arm", () => {
        const base = [paired("config-value", true, true), paired("config-value", true, true)];
        const armTasks = [paired("config-value", true, true), paired("config-value", false, true)];
        const baseline = arm("B", base);
        const champion = arm("A1", armTasks);
        const gateReport = evaluateGates(
            { paired: armTasks, recallGainPp: 0, armPrecision: null },
            GATE_VALUES,
            200,
            5,
        );
        const report = buildTebReport({
            arms: [baseline, champion],
            gateValues: GATE_VALUES,
            gateReport,
            sensitivity: repoSensitivity(armTasks, 200, 5),
        });
        expect(report.markdown).toContain("## Arm A1 vs B");
        expect(report.markdown).toContain("config-value");
        expect(report.markdown).toContain("Gates");
        // Survivor-bias guard: first-correct means ship with the fraction
        // of runs that showed evidence at all.
        expect(report.markdown).toContain("of runs");
        const json = report.json as { arms: Array<{ armId: string }> };
        expect(json.arms.map((a) => a.armId)).toEqual(["B", "A1"]);
    });

    it("handles an empty arm list", () => {
        const report = buildTebReport({
            arms: [],
            gateValues: GATE_VALUES,
            gateReport: evaluateGates({ paired: [], recallGainPp: 0, armPrecision: null }, GATE_VALUES, 50, 1),
            sensitivity: repoSensitivity([], 50, 1),
        });
        expect(report.markdown).toContain("No arms");
    });

    it("lists session-validity exclusions and forced failures (E13.3)", () => {
        const base = [paired("config-value", true, true)];
        const baseline = arm("B", base);
        const report = buildTebReport({
            arms: [baseline],
            gateValues: GATE_VALUES,
            gateReport: evaluateGates({ paired: base, recallGainPp: 0, armPrecision: null }, GATE_VALUES, 50, 1),
            sensitivity: repoSensitivity(base, 50, 1),
            validity: {
                excluded: [
                    { taskId: "t1", arm: "A1", replicate: 0, reason: "identity mismatch: model mismatch" },
                ],
                forcedFailures: [{ taskId: "t2", arm: "B", replicate: 0, reason: "contamination: tool-call args" }],
                excludedRate: 0.25,
            },
        });
        expect(report.markdown).toContain("## Session validity");
        expect(report.markdown).toContain("excluded t1 A1 r0: identity mismatch");
        expect(report.markdown).toContain("failed t2 B r0: contamination");
        const json = report.json as { validity: { excludedRate: number } };
        expect(json.validity.excludedRate).toBe(0.25);
    });

    it("omits the validity section when no validity input is given", () => {
        const base = [paired("config-value", true, true)];
        const report = buildTebReport({
            arms: [arm("B", base)],
            gateValues: GATE_VALUES,
            gateReport: evaluateGates({ paired: base, recallGainPp: 0, armPrecision: null }, GATE_VALUES, 50, 1),
            sensitivity: repoSensitivity(base, 50, 1),
        });
        expect(report.markdown).not.toContain("## Session validity");
    });
});
