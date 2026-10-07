/**
 * Metric computation for the external grep benchmark (D14).
 *
 * Primary: success@5 within a common rendered-token cap. Also:
 * known-patch-file recall@5, MRR, hunk/symbol overlap, rendered tokens,
 * latency, failures. Ranks deduplicated by first file appearance.
 * Reuses renderedTokenEstimate from the R1 judge metrics instead of
 * duplicating the token convention.
 */

import { renderedTokenEstimate } from "../../judge/grep-e2e-metrics.js";
import type { BenchmarkInstance } from "./instance.js";

/** Common rendered-token cap binding every comparator run (D14). */
export const RENDERED_TOKEN_CAP = 8000;

export interface ShownUnit {
    relFile: string;
    line: number;
    endLine: number;
    name: string;
}

export interface InstanceMetrics {
    instanceId: string;
    formulation: string;
    /** Ranked files deduped by first appearance (1-based ranks). */
    rankedFiles: string[];
    /** Gold file -> first-appearance rank (null when absent). */
    goldRanks: Array<{ file: string; rank: number | null }>;
    successAt5: boolean;
    recallAt5: number;
    mrr: number;
    /** Gold files with any top-5 line-range overlap. */
    hunkOverlapAt5: number;
    overTokenCap: boolean;
    renderedTokens: number;
    elapsedMs: number;
    status: string;
}

export function dedupeFilesByFirstAppearance(units: Array<Pick<ShownUnit, "relFile">>): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const unit of units) {
        if (!seen.has(unit.relFile)) {
            seen.add(unit.relFile);
            out.push(unit.relFile);
        }
    }
    return out;
}

function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
    return aStart <= bEnd && bStart <= aEnd;
}

/** Compute per-instance metrics from shown units (rank order = display order). */
export function computeInstanceMetrics(input: {
    instance: BenchmarkInstance;
    formulation: string;
    shown: ShownUnit[];
    renderedText: string;
    elapsedMs: number;
    status: string;
}): InstanceMetrics {
    const { instance, formulation, shown, renderedText, elapsedMs, status } = input;
    const rankedFiles = dedupeFilesByFirstAppearance(shown);
    const top5Files = new Set(rankedFiles.slice(0, 5));
    const top5Units = shown.filter((u) => top5Files.has(u.relFile));
    const goldRanks = instance.goldFiles.map((file) => {
        const idx = rankedFiles.indexOf(file);
        return { file, rank: idx >= 0 ? idx + 1 : null };
    });
    const hitsAt5 = goldRanks.filter((g) => g.rank !== null && (g.rank as number) <= 5);
    const renderedTokens = renderedTokenEstimate(renderedText);
    const overTokenCap = renderedTokens > RENDERED_TOKEN_CAP;
    const failed = status.startsWith("error:") || status.startsWith("timeout:");
    let hunkOverlapAt5 = 0;
    for (const hunk of instance.goldHunks) {
        if (!top5Files.has(hunk.file)) continue;
        const units = top5Units.filter((u) => u.relFile === hunk.file);
        const overlap = hunk.ranges.some((r) => units.some((u) => rangesOverlap(u.line, u.endLine, r.start, r.end)));
        if (overlap) hunkOverlapAt5++;
    }
    const presentRanks = goldRanks.filter((g) => g.rank !== null).map((g) => g.rank as number);
    return {
        instanceId: instance.instanceId,
        formulation,
        rankedFiles,
        goldRanks,
        successAt5: !failed && !overTokenCap && hitsAt5.length > 0,
        recallAt5: instance.goldFiles.length > 0 && !failed ? hitsAt5.length / instance.goldFiles.length : 0,
        mrr: presentRanks.length > 0 ? 1 / Math.min(...presentRanks) : 0,
        hunkOverlapAt5,
        overTokenCap,
        renderedTokens,
        elapsedMs,
        status: overTokenCap && !failed ? "over_token_cap" : status,
    };
}

export interface SummaryMetrics {
    runs: number;
    errors: number;
    overTokenCap: number;
    successAt5: string;
    meanRecallAt5: number;
    meanMRR: number;
    meanHunkOverlapAt5: number;
    meanRenderedTokens: number;
    meanElapsedMs: number;
}

/** Summarize per-instance metrics (errors stay in the denominator). */
export function summarizeMetrics(metrics: InstanceMetrics[]): SummaryMetrics {
    const successes = metrics.filter((m) => m.successAt5).length;
    const mean = (xs: number[]): number => (xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    return {
        runs: metrics.length,
        errors: metrics.filter((m) => m.status.startsWith("error:") || m.status.startsWith("timeout:")).length,
        overTokenCap: metrics.filter((m) => m.overTokenCap).length,
        successAt5: `${successes}/${metrics.length}`,
        meanRecallAt5: mean(metrics.map((m) => m.recallAt5)),
        meanMRR: mean(metrics.map((m) => m.mrr)),
        meanHunkOverlapAt5: mean(metrics.map((m) => m.hunkOverlapAt5)),
        meanRenderedTokens: mean(metrics.map((m) => m.renderedTokens)),
        meanElapsedMs: mean(metrics.map((m) => m.elapsedMs)),
    };
}
