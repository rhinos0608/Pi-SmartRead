/**
 * TEB (Tool Ergonomics Bench) reporter: per-arm / per-family markdown plus
 * a JSON payload with the same numbers.
 *
 * Pure functions over already-aggregated inputs (task outcomes, run-metric
 * aggregates, gate report). No IO, no grading, no event parsing.
 */

import type { TebAggregateMetrics } from "./metrics.js";
import type {
    TebBootstrapResult,
    TebGateReport,
    TebGateValues,
    TebPairedTask,
    TebRepoSensitivity,
} from "./stats.js";
import { repoSensitivity, successRate } from "./stats.js";

export interface TebArmSummary {
    armId: string;
    paired: TebPairedTask[];
    aggregates: TebAggregateMetrics;
    primaryBootstrap: TebBootstrapResult;
}

export interface TebFamilyRow {
    family: string;
    /** Task ids present in BOTH arms (paired denominator). */
    tasks: number;
    /** Null when the family has no paired tasks (arm intentionally did not run). */
    baseRate: number | null;
    /** Null when the family has no paired tasks (arm intentionally did not run). */
    armRate: number | null;
    /** Null when the family has no paired tasks. */
    gainPp: number | null;
}

export interface TebReportInput {
    arms: TebArmSummary[];
    /** Frozen gate values used for the gate report. */
    gateValues: TebGateValues;
    gateReport: TebGateReport;
    sensitivity: TebRepoSensitivity;
    /**
     * Session-validity accounting from scoring (E13.3): sessions
     * excluded from paired analysis (identity mismatch, infrastructure
     * failure) and sessions forced to failure (timeout, contamination).
     * Rendered as its own section, never merged into answer failures.
     */
    validity?: TebValiditySummary;
}

export interface TebValidityRow {
    taskId: string;
    arm: string;
    replicate: number;
    reason: string;
}

export interface TebValiditySummary {
    /** Excluded from paired analysis, with the reason, per session. */
    excluded: TebValidityRow[];
    /** Graded as failures by validity (timeout, contamination). */
    forcedFailures: TebValidityRow[];
    /** Excluded fraction over all sessions (null when no sessions). */
    excludedRate: number | null;
}

function pct(rate: number): string {
    return `${(rate * 100).toFixed(1)}%`;
}

function fmtOpt(value: number | null, asPct = false): string {
    if (value === null) return "n/a";
    return asPct ? pct(value) : value.toFixed(2);
}

function pctOpt(rate: number | null): string {
    return rate === null ? "n/a" : pct(rate);
}

function gainOpt(gainPp: number | null): string {
    if (gainPp === null) return "n/a";
    return `${gainPp >= 0 ? "+" : ""}${gainPp.toFixed(1)}`;
}

/**
 * Per-family base-vs-arm success rows for one arm comparison. Both
 * rates come from the SAME comparison-specific matched vote: the arm's
 * paired list carries each task's matched baseline vote (basePass) and
 * arm vote (armPass), so baseRate is the matched baseline rate, NOT
 * the standalone baseline descriptive rate (which may cover different
 * tasks/replicates). The `base` list contributes only the family union
 * so intentionally skipped families (e.g. negative controls the arm
 * did not run) still render as null/'n/a', never 0%.
 */
export function familyRows(base: TebPairedTask[], arm: TebPairedTask[]): TebFamilyRow[] {
    const families = [...new Set([...base, ...arm].map((t) => t.family))].sort();
    return families.map((family) => {
        const commonArm = arm.filter((t) => t.family === family);
        if (commonArm.length === 0) {
            return { family, tasks: 0, baseRate: null, armRate: null, gainPp: null };
        }
        const baseRate = successRate(commonArm, "base");
        const armRate = successRate(commonArm, "arm");
        return { family, tasks: commonArm.length, baseRate, armRate, gainPp: (armRate - baseRate) * 100 };
    });
}

export interface TebReport {
    markdown: string;
    json: unknown;
}

function renderArmSection(arm: TebArmSummary, baseline: TebArmSummary): string {
    const lines: string[] = [];
    const baseRate = successRate(arm.paired, "base");
    const armRate = successRate(arm.paired, "arm");
    const gainPp = (armRate - baseRate) * 100;
    lines.push(`## Arm ${arm.armId} vs ${baseline.armId}`);
    lines.push("");
    lines.push(
        `Success: base ${pct(baseRate)} → arm ${pct(armRate)} ` +
            `(${gainPp >= 0 ? "+" : ""}${gainPp.toFixed(2)}pp, ` +
            `paired 95% CI ${(arm.primaryBootstrap.lo * 100).toFixed(2)}..` +
            `${(arm.primaryBootstrap.hi * 100).toFixed(2)}pp over ${arm.paired.length} tasks).`,
    );
    lines.push("");
    lines.push(
        `Secondary: opportunity recall ${fmtOpt(arm.aggregates.opportunityRecall, true)}, ` +
            `specialist precision ${fmtOpt(arm.aggregates.specialistPrecision, true)}, ` +
            `invalid-call rate ${arm.aggregates.meanInvalidCallRate.toFixed(3)}, ` +
            `post-error success ${fmtOpt(arm.aggregates.postErrorSuccessRate, true)}, ` +
            `negative overuse ${fmtOpt(arm.aggregates.negativeOveruse, true)}.`,
    );
    // First-correct means average survivors only: always pair them with
    // the success fraction so a faster-looking failing arm cannot mislead.
    lines.push(
        `First-correct evidence: mean ${fmtOpt(arm.aggregates.meanCallsToFirstCorrect)} calls, ` +
            `${fmtOpt(arm.aggregates.meanTokensToFirstCorrect)} tokens, ` +
            `${fmtOpt(arm.aggregates.meanTimeToFirstCorrectMs)} ms ` +
            `(found in ${pct(arm.aggregates.firstCorrectSuccessRate)} of runs).`,
    );
    lines.push(
        `Cost: ${arm.aggregates.totalTokens} model tokens total, ` +
            `$${arm.aggregates.costTotal.toFixed(4)} (tool-nested costs tracked separately).`,
    );
    lines.push("");
    lines.push("| family | tasks | base | arm | gain (pp) |");
    lines.push("|---|---|---|---|---|");
    for (const row of familyRows(baseline.paired, arm.paired)) {
        lines.push(
            `| ${row.family} | ${row.tasks} | ${pctOpt(row.baseRate)} | ${pctOpt(row.armRate)} | ` +
                `${gainOpt(row.gainPp)} |`,
        );
    }
    return lines.join("\n");
}

/** Builds the per-arm / per-family markdown report plus JSON payload. */
export function buildTebReport(input: TebReportInput): TebReport {
    const [baseline, ...rest] = input.arms;
    const lines: string[] = ["# TEB report", ""];
    if (!baseline) {
        return { markdown: "# TEB report\n\nNo arms.\n", json: { arms: [] } };
    }
    lines.push(
        `Baseline ${baseline.armId}: ${pct(successRate(baseline.paired, "base"))} ` +
            `over ${baseline.paired.length} tasks.`,
    );
    lines.push("");
    for (const arm of rest.length === 0 ? [baseline] : rest) {
        lines.push(renderArmSection(arm, baseline));
        lines.push("");
    }
    lines.push("## Gates (frozen values)");
    lines.push("");
    lines.push(
        `Needs: success +${input.gateValues.minSuccessGainPp}pp with positive paired CI; ` +
            `recall +${input.gateValues.minRecallGainPp}pp; ` +
            `precision ≥${(input.gateValues.minSpecialistPrecision * 100).toFixed(0)}%; ` +
            `negative veto past +${input.gateValues.maxNegativeDeteriorationPp}pp (McNemar p<0.05); ` +
            `lost prior successes ≤${(input.gateValues.maxLostPriorSuccessRate * 100).toFixed(0)}%.`,
    );
    for (const gate of input.gateReport.gates) {
        lines.push(`- ${gate.passed ? "PASS" : "FAIL"} ${gate.id}: ${gate.detail}`);
    }
    lines.push("");
    lines.push("## Repo-clustered sensitivity");
    lines.push("");
    lines.push("| held out | tasks | diff (pp) |");
    lines.push("|---|---|---|");
    for (const row of input.sensitivity.leaveOneOut) {
        lines.push(
            `| ${row.heldOut} | ${row.tasks} | ${(row.diff * 100).toFixed(2)} |`,
        );
    }
    lines.push(
        `Cluster bootstrap 95% CI: ` +
            `${(input.sensitivity.clusterBootstrap.lo * 100).toFixed(2)}..` +
            `${(input.sensitivity.clusterBootstrap.hi * 100).toFixed(2)}pp.`,
    );
    if (input.gateReport.lostPriorSuccesses.length > 0) {
        lines.push("");
        lines.push(
            `Lost prior successes (${input.gateReport.lostPriorSuccesses.length}): ` +
                input.gateReport.lostPriorSuccesses.join(", "),
        );
    }
    if (input.validity) {
        lines.push("");
        lines.push("## Session validity");
        lines.push("");
        const rate = input.validity.excludedRate;
        lines.push(
            `Excluded from paired analysis: ${input.validity.excluded.length}` +
                (rate === null ? "" : ` (${(rate * 100).toFixed(1)}% of sessions)`) +
                "; forced to failure (timeout/contamination): " +
                `${input.validity.forcedFailures.length}.`,
        );
        for (const row of input.validity.excluded) {
            lines.push(`- excluded ${row.taskId} ${row.arm} r${row.replicate}: ${row.reason}`);
        }
        for (const row of input.validity.forcedFailures) {
            lines.push(`- failed ${row.taskId} ${row.arm} r${row.replicate}: ${row.reason}`);
        }
    }
    const markdown = `${lines.join("\n")}\n`;
    const json = {
        arms: input.arms.map((arm) => ({
            armId: arm.armId,
            tasks: arm.paired.length,
            baseRate: successRate(arm.paired, "base"),
            armRate: successRate(arm.paired, "arm"),
            primaryBootstrap: arm.primaryBootstrap,
            aggregates: arm.aggregates,
            families: familyRows(baseline.paired, arm.paired),
        })),
        gates: input.gateReport,
        gateValues: input.gateValues,
        sensitivity: input.sensitivity,
        validity: input.validity ?? null,
    };
    return { markdown, json };
}

/**
 * Convenience: builds the sensitivity section input from one arm's paired
 * tasks (leave-one-repo-out + cluster bootstrap).
 */
export function sensitivityFor(paired: TebPairedTask[]): TebRepoSensitivity {
    return repoSensitivity(paired);
}
