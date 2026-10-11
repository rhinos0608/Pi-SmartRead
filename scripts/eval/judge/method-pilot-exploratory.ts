#!/usr/bin/env node
/**
 * EXPLORATORY paired analysis of the A1.1 method-pilot records
 * (`method-pilot-exploratory.ts`). This module performs NO selection
 * and produces NO verdict change: the preregistered selector
 * (`method-pilot-selector.ts:selectMethodPilotMethod`) and its sealed
 * verdict remain the only decision surface. Every table produced here
 * is labeled EXPLORATORY, and its percentile intervals are NOT
 * multiplicity-corrected (3 models × 3 loss contrasts, plus FN/FP
 * differences, interactions, and a spread statistic — see
 * `docs/plans/2026-10-09-method-pilot-exploratory-analysis.md`).
 *
 * Candidate scores are derived from the verified wire records through
 * the glue's own exported derivation
 * (`method-pilot-select.ts:deriveMethodPilotSelectorInput`), so the
 * per-model loss table is numerically identical to the verdict
 * artifact's — the CLI fail-closes unless
 * `buildPerModelPerMethodTable` reproduces `verdict.perModelPerMethod`
 * byte-for-value (JSON.stringify equality). Scoring itself re-implements
 * A1.1 line 484 exactly (M0/M1 score = mean of the two replica
 * probabilities; M2 replica score = (forward + reverse)/2, then the
 * replica mean; keep iff score >= .40; gold positive; 6·FN + FP), and
 * the reproduction check pins the re-implementation against the
 * selector's numbers.
 *
 * Unit of independence = QUERY (40 query clusters). Replicas are
 * averaged within candidate before thresholding; they are never
 * independent samples. Every interval comes from ONE paired
 * query-cluster bootstrap: B = 10,000 draws, seed 20261008, mulberry32,
 * lexicographic query order, Q picks per draw, and the SAME picks for
 * every model × method (the selector's own conventions; the PRNG and
 * nearest-rank percentile are the selector's exported helpers).
 * Intervals are two-sided 95% nearest-rank percentile intervals
 * (.025/.975) — descriptive, not confirmatory, and not Bonferroni-
 * adjusted (A1.1's Bonferroni one-sided bound applies only to the
 * preregistered selector, which this analysis does not replace).
 *
 * Pure/deterministic core: `buildExploratoryClusterTable`,
 * `computePointEstimates`, `runPairedQueryClusterBootstrap`,
 * `buildExploratoryIntervals`, `computePerQueryBreakdown`,
 * `analyzeMethodPilotExploratory`, `buildPerModelPerMethodTable`,
 * `assertReproducedVerdictTable` — no I/O, no network, no credentials.
 * The CLI (`runMethodPilotExploratory`) only reads the sealed pilot
 * root, the frozen plan artifact, its wire records, and the stored
 * verdict, then prints one JSON document to stdout. It never writes
 * into the pilot data root and never mutates the verdict.
 *
 * Sensitivity: the CLI detects the query groups containing the two
 * recovered-error components (attempt 1 failed, attempt 2 succeeded)
 * from the records themselves and re-runs the whole analysis with
 * those query clusters excluded — the smallest pairing-preserving
 * exclusion unit (cell-level exclusion would break the paired
 * structure or complete coverage).
 *
 * Exit codes mirror `method-pilot-select.ts`: 0 ok · 2
 * usage/validation (including a reproduction mismatch) · 3 gate
 * refusal (sealed corpus or plan artifact cannot be verified).
 * Main guard: the CLI runs only when this module is the invoked
 * entry point, so importing never executes it.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { METHOD_IDS, PILOT_REPLICA_COUNT, type MethodId } from "./method-comparison-contract.js";
import {
    isVerifiedPilotCorpusRoster,
    loadVerifiedPilotCorpus,
    type PilotCorpusRoster,
} from "./method-pilot-fixture.js";
import { defaultPilotRoot, isMethodPilotPlanArtifact, type MethodPilotPlanArtifact } from "./method-pilot.js";
import {
    deriveMethodPilotSelectorInput,
    verifyPlanForRoster,
} from "./method-pilot-select.js";
import {
    mulberry32,
    percentileSorted,
    type MethodPilotProbabilityRow,
} from "./method-pilot-selector.js";
import {
    FROZEN_BOOTSTRAP_ITERATIONS,
    FROZEN_BOOTSTRAP_SEED,
    FROZEN_CHALLENGER_ARMS,
    FROZEN_KEEP_THRESHOLD,
    INCUMBENT_ARM,
} from "./model-comparison-stats.js";
import { isComparisonModelId, type ComparisonModelId } from "./model-comparison-types.js";

/** Exit codes (method-pilot-select.ts conventions: 0 ok · 2 validation · 3 gate refusal). */
export const METHOD_PILOT_EXPLORATORY_EXIT_OK = 0;
export const METHOD_PILOT_EXPLORATORY_EXIT_USAGE = 2;
export const METHOD_PILOT_EXPLORATORY_EXIT_GATE = 3;

/** Every table this module emits carries this label. Never a selection input. */
export const METHOD_PILOT_EXPLORATORY_LABEL = "EXPLORATORY" as const;

/** A1.1 line 486: L = 6·FN + FP (the selector's frozen penalty; not a parameter). */
export const EXPLORATORY_WEIGHTED_FN_PENALTY = 6;

/** Two-sided 95% nearest-rank percentile interval (descriptive; NOT multiplicity-corrected). */
export const EXPLORATORY_INTERVAL_LOWER_QUANTILE = 0.025;
export const EXPLORATORY_INTERVAL_UPPER_QUANTILE = 0.975;

/** Frozen arm order (the selector's own order; plan.models equals it for the A2 plan). */
export const EXPLORATORY_ARMS: readonly ComparisonModelId[] = Object.freeze([
    INCUMBENT_ARM,
    ...FROZEN_CHALLENGER_ARMS,
]);

/** The challenger arm whose M1-vs-M0 contribution breakdown the report highlights. */
export const EXPLORATORY_DRIVER_ARM: ComparisonModelId = "openai/gpt-6-luna-decisions";

/* ──────────────────────────────────────────────────────────────────
 * Contrast vocabulary. Every statistic is an IMPROVEMENT contrast:
 * positive always favors the first-named method (loss contrast:
 * S_second − S_first; FN/FP difference: count_second − count_first).
 * ────────────────────────────────────────────────────────────────── */

export interface ExploratoryContrast {
    /** Display label, e.g. "D(M1-M0)". */
    readonly label: string;
    /** First-named method (the one the sign favors when positive). */
    readonly first: MethodId;
    /** Second-named method. */
    readonly second: MethodId;
}

export const EXPLORATORY_LOSS_CONTRASTS: readonly ExploratoryContrast[] = Object.freeze([
    { label: "D(M1-M0)", first: "M1", second: "M0" },
    { label: "D(M2-M0)", first: "M2", second: "M0" },
    { label: "D(M1-M2)", first: "M1", second: "M2" },
]);

/* ──────────────────────────────────────────────────────────────────
 * Cluster table: per-query loss/FN/FP for every model × method.
 * ────────────────────────────────────────────────────────────────── */

/** One query cluster's totals for one model × method. */
export interface ExploratoryCell {
    /** 6·FN + FP at the frozen .40 threshold (A1.1 line 486). */
    loss: number;
    fn: number;
    fp: number;
}

/** Per-query series for one model × method (length = cluster count). */
export interface ExploratorySeries {
    model: ComparisonModelId;
    method: MethodId;
    perQueryLoss: readonly number[];
    perQueryFn: readonly number[];
    perQueryFp: readonly number[];
}

/** Paired query-cluster table (the bootstrap's unit of resampling). */
export interface ExploratoryClusterTable {
    /** Cluster ids (sealed qids), lexicographic, exclusions applied. */
    queryIds: readonly string[];
    arms: readonly ComparisonModelId[];
    /** Arm-major, method order M0,M1,M2 — index = armIndex·3 + methodIndex. */
    series: readonly ExploratorySeries[];
}

function compareStrings(a: string, b: string): number {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
}

function seriesIndex(armIndex: number, method: MethodId): number {
    return armIndex * METHOD_IDS.length + METHOD_IDS.indexOf(method);
}

function rowLookupKey(model: string, method: string, queryGroup: string, candidateId: string, replica: number): string {
    return [model, method, queryGroup, candidateId, replica].join(" ");
}

function buildRowLookup(rows: readonly MethodPilotProbabilityRow[]): Map<string, MethodPilotProbabilityRow> {
    const lookup = new Map<string, MethodPilotProbabilityRow>();
    for (const row of rows) {
        const key = rowLookupKey(row.model, row.method, row.queryGroup, row.candidateId, row.replica);
        if (lookup.has(key)) {
            throw new Error(`method-pilot-exploratory: duplicate row for ${key}`);
        }
        lookup.set(key, row);
    }
    return lookup;
}

/**
 * A1.1 line 484, byte-identical in expression order to the selector's
 * private `candidateScore`: M0/M1 = (r0.probability + r1.probability)/2;
 * M2 = ((r0.forward + r0.reverse)/2 + (r1.forward + r1.reverse)/2)/2.
 * Fail-closed: a missing row or a null component throws (exploratory
 * scoring never imputes, never drops a candidate — same coverage rule
 * as qualification 4). Equivalence to the selector is pinned by the
 * CLI's byte-for-value reproduction of the verdict's loss table.
 */
function candidateScore(
    lookup: ReadonlyMap<string, MethodPilotProbabilityRow>,
    arm: ComparisonModelId,
    method: MethodId,
    queryGroup: string,
    candidateId: string,
): number {
    const r0 = lookup.get(rowLookupKey(arm, method, queryGroup, candidateId, 0));
    const r1 = lookup.get(rowLookupKey(arm, method, queryGroup, candidateId, 1));
    if (r0 === undefined || r1 === undefined) {
        throw new Error(`method-pilot-exploratory: missing row for ${arm}/${method}/${queryGroup}/${candidateId}`);
    }
    if (method === "M2") {
        if (r0.forward === null || r0.reverse === null || r1.forward === null || r1.reverse === null) {
            throw new Error(`method-pilot-exploratory: null M2 component for ${arm}/${queryGroup}/${candidateId}`);
        }
        const replica0 = (r0.forward + r0.reverse) / 2;
        const replica1 = (r1.forward + r1.reverse) / 2;
        return (replica0 + replica1) / 2;
    }
    if (r0.probability === null || r1.probability === null) {
        throw new Error(`method-pilot-exploratory: null ${method} probability for ${arm}/${queryGroup}/${candidateId}`);
    }
    return (r0.probability + r1.probability) / 2;
}

interface CandidateOutcome {
    candidateId: string;
    score: number;
    keep: boolean;
    gold: boolean;
    loss: number;
}

/** All roster candidates of one query under one model × method, scored at the frozen threshold. */
function candidateOutcomesForQuery(
    lookup: ReadonlyMap<string, MethodPilotProbabilityRow>,
    roster: PilotCorpusRoster,
    arm: ComparisonModelId,
    method: MethodId,
    queryGroup: string,
): CandidateOutcome[] {
    const outcomes: CandidateOutcome[] = [];
    for (const candidate of roster.candidates) {
        if (candidate.qid !== queryGroup) continue;
        const score = candidateScore(lookup, arm, method, queryGroup, candidate.cid);
        const keep = score >= FROZEN_KEEP_THRESHOLD;
        const gold = candidate.label === "gold";
        const loss = gold && !keep
            ? EXPLORATORY_WEIGHTED_FN_PENALTY
            : !gold && keep ? 1 : 0;
        outcomes.push({ candidateId: candidate.cid, score, keep, gold, loss });
    }
    return outcomes;
}

/** One query cluster's summed cell for one model × method. */
function queryCellOf(
    lookup: ReadonlyMap<string, MethodPilotProbabilityRow>,
    roster: PilotCorpusRoster,
    arm: ComparisonModelId,
    method: MethodId,
    queryGroup: string,
): ExploratoryCell {
    const cell: ExploratoryCell = { loss: 0, fn: 0, fp: 0 };
    for (const outcome of candidateOutcomesForQuery(lookup, roster, arm, method, queryGroup)) {
        cell.loss += outcome.loss;
        if (outcome.gold && !outcome.keep) cell.fn += 1;
        else if (!outcome.gold && outcome.keep) cell.fp += 1;
    }
    return cell;
}

/**
 * Per-query loss/FN/FP for every model × method, replicas averaged
 * within candidate before thresholding (A1.1). `excludedQueryGroups`
 * removes whole query clusters (the pairing-preserving sensitivity
 * unit); everything else fails closed.
 */
export function buildExploratoryClusterTable(
    roster: PilotCorpusRoster,
    rows: readonly MethodPilotProbabilityRow[],
    excludedQueryGroups: readonly string[] = [],
): ExploratoryClusterTable {
    const excluded = new Set(excludedQueryGroups);
    const queryIds = roster.queries
        .map((query) => query.qid)
        .filter((qid) => !excluded.has(qid))
        .sort(compareStrings);
    if (queryIds.length === 0) {
        throw new Error("method-pilot-exploratory: no query clusters remain after exclusions");
    }
    const lookup = buildRowLookup(rows);
    const series: ExploratorySeries[] = [];
    for (const arm of EXPLORATORY_ARMS) {
        for (const method of METHOD_IDS) {
            const perQuery = queryIds.map((qid) => queryCellOf(lookup, roster, arm, method, qid));
            series.push({
                model: arm,
                method,
                perQueryLoss: perQuery.map((cell) => cell.loss),
                perQueryFn: perQuery.map((cell) => cell.fn),
                perQueryFp: perQuery.map((cell) => cell.fp),
            });
        }
    }
    return { queryIds, arms: EXPLORATORY_ARMS, series };
}

/* ──────────────────────────────────────────────────────────────────
 * Scalars: ONE formula surface shared by the point pass and every
 * bootstrap draw (positive = improvement of the first-named method).
 * ────────────────────────────────────────────────────────────────── */

/** Scalar storage: scope index 0 = equally-averaged over arms; 1..A = per-arm. */
interface ScalarSet {
    /** Weighted loss per query, per series (index = seriesIndex). */
    lossPerQuery: number[];
    /** FN / FP counts per series. */
    fn: number[];
    fp: number[];
    /** S_m equally averaged over arms (A1.1 line 486), per method. */
    s: number[];
    /** [contrastIndex][scopeIndex]: S_second − S_first (per scope). */
    contrasts: number[][];
    /** [contrastIndex][scopeIndex]: FN_second − FN_first (per scope). */
    fnDiffs: number[][];
    /** [contrastIndex][scopeIndex]: FP_second − FP_first (per scope). */
    fpDiffs: number[][];
    /** DiD of the D(M1-M0) contrast per arm pair (pair order = EXPLORATORY_ARMS combinations). */
    interactions: number[][];
    /** max−min over arms of the per-arm D(M1-M0) (never negative by construction). */
    spread: number;
}

function totalOf(values: readonly number[], picks: readonly number[] | null): number {
    if (picks === null) {
        let total = 0;
        for (const value of values) total += value;
        return total;
    }
    let total = 0;
    for (const pick of picks) total += values[pick]!;
    return total;
}

function deriveScalars(
    table: ExploratoryClusterTable,
    picks: readonly number[] | null,
): ScalarSet {
    const armCount = table.arms.length;
    const methodCount = METHOD_IDS.length;
    const seriesCount = armCount * methodCount;
    const q = table.queryIds.length;
    const lossTotals = new Array<number>(seriesCount).fill(0);
    const fnTotals = new Array<number>(seriesCount).fill(0);
    const fpTotals = new Array<number>(seriesCount).fill(0);
    table.series.forEach((entry, index) => {
        lossTotals[index] = totalOf(entry.perQueryLoss, picks);
        fnTotals[index] = totalOf(entry.perQueryFn, picks);
        fpTotals[index] = totalOf(entry.perQueryFp, picks);
    });
    const lossPerQuery = lossTotals.map((total) => total / q);
    const s = METHOD_IDS.map((method) => {
        let total = 0;
        for (let armIndex = 0; armIndex < armCount; armIndex += 1) {
            total += lossTotals[seriesIndex(armIndex, method)]!;
        }
        return total / (armCount * q);
    });
    const scopeCount = armCount + 1;
    const scopeLoss = (armIndex: number, method: MethodId): number =>
        lossTotals[seriesIndex(armIndex, method)]! / q;
    const scopeCountOf = (
        totals: readonly number[],
        armIndex: number,
        method: MethodId,
    ): number => totals[seriesIndex(armIndex, method)]!;
    const totalsByArm = (totals: readonly number[], method: MethodId): number => {
        let total = 0;
        for (let armIndex = 0; armIndex < armCount; armIndex += 1) total += scopeCountOf(totals, armIndex, method);
        return total;
    };
    const contrasts = EXPLORATORY_LOSS_CONTRASTS.map(() => new Array<number>(scopeCount).fill(0));
    const fnDiffs = EXPLORATORY_LOSS_CONTRASTS.map(() => new Array<number>(scopeCount).fill(0));
    const fpDiffs = EXPLORATORY_LOSS_CONTRASTS.map(() => new Array<number>(scopeCount).fill(0));
    EXPLORATORY_LOSS_CONTRASTS.forEach((contrast, contrastIndex) => {
        const fnOf = (armIndex: number, method: MethodId): number =>
            scopeCountOf(fnTotals, armIndex, method);
        const fpOf = (armIndex: number, method: MethodId): number =>
            scopeCountOf(fpTotals, armIndex, method);
        contrasts[contrastIndex]![0] = s[METHOD_IDS.indexOf(contrast.second)]! - s[METHOD_IDS.indexOf(contrast.first)]!;
        fnDiffs[contrastIndex]![0] =
            totalsByArm(fnTotals, contrast.second) - totalsByArm(fnTotals, contrast.first);
        fpDiffs[contrastIndex]![0] =
            totalsByArm(fpTotals, contrast.second) - totalsByArm(fpTotals, contrast.first);
        for (let armIndex = 0; armIndex < armCount; armIndex += 1) {
            contrasts[contrastIndex]![armIndex + 1] =
                scopeLoss(armIndex, contrast.second) - scopeLoss(armIndex, contrast.first);
            fnDiffs[contrastIndex]![armIndex + 1] =
                fnOf(armIndex, contrast.second) - fnOf(armIndex, contrast.first);
            fpDiffs[contrastIndex]![armIndex + 1] =
                fpOf(armIndex, contrast.second) - fpOf(armIndex, contrast.first);
        }
    });
    const interactions: number[][] = [];
    for (let i = 0; i < armCount; i += 1) {
        for (let j = i + 1; j < armCount; j += 1) {
            const first = contrasts[0]![i + 1]!;
            const second = contrasts[0]![j + 1]!;
            interactions.push([first - second]);
        }
    }
    const perArmD = table.arms.map((_arm, armIndex) => contrasts[0]![armIndex + 1]!);
    const spread = Math.max(...perArmD) - Math.min(...perArmD);
    return { lossPerQuery, fn: fnTotals, fp: fpTotals, s, contrasts, fnDiffs, fpDiffs, interactions, spread };
}

/* ──────────────────────────────────────────────────────────────────
 * Point estimates and paired bootstrap.
 * ────────────────────────────────────────────────────────────────── */

export interface ExploratoryScopeEstimate {
    /** "averaged" or a model id. */
    scope: string;
    estimate: number;
}

export interface ExploratoryContrastEstimate {
    contrast: string;
    scope: string;
    estimate: number;
}

export interface ExploratoryInteractionEstimate {
    /** "modelA vs modelB". */
    modelPair: string;
    estimate: number;
}

export interface ExploratoryPointEstimates {
    perModelPerMethod: {
        model: ComparisonModelId;
        method: MethodId;
        loss: number;
        lossPerQuery: number;
        fn: number;
        fp: number;
    }[];
    averagedPerMethod: { method: MethodId; s: number }[];
    lossContrasts: ExploratoryContrastEstimate[];
    fnDiffs: ExploratoryContrastEstimate[];
    fpDiffs: ExploratoryContrastEstimate[];
    interactions: ExploratoryInteractionEstimate[];
    spread: number;
}

function armPairLabel(arms: readonly ComparisonModelId[], i: number, j: number): string {
    return `${arms[i]} vs ${arms[j]}`;
}

/** Point estimates on the full table (no resampling). Same formulas as every bootstrap draw. */
export function computePointEstimates(table: ExploratoryClusterTable): ExploratoryPointEstimates {
    const scalars = deriveScalars(table, null);
    const perModelPerMethod: ExploratoryPointEstimates["perModelPerMethod"] = [];
    table.arms.forEach((arm, armIndex) => {
        for (const method of METHOD_IDS) {
            const index = seriesIndex(armIndex, method);
            perModelPerMethod.push({
                model: arm,
                method,
                loss: table.series[index]!.perQueryLoss.reduce((a, b) => a + b, 0),
                lossPerQuery: scalars.lossPerQuery[index]!,
                fn: scalars.fn[index]!,
                fp: scalars.fp[index]!,
            });
        }
    });
    const scopeLabels = ["averaged", ...table.arms];
    const contrastEstimates = (perScope: readonly number[][]): ExploratoryContrastEstimate[] => {
        const out: ExploratoryContrastEstimate[] = [];
        EXPLORATORY_LOSS_CONTRASTS.forEach((contrast, contrastIndex) => {
            scopeLabels.forEach((scope, scopeIndex) => {
                out.push({ contrast: contrast.label, scope, estimate: perScope[contrastIndex]![scopeIndex]! });
            });
        });
        return out;
    };
    let pair = 0;
    const interactions: ExploratoryInteractionEstimate[] = [];
    for (let i = 0; i < table.arms.length; i += 1) {
        for (let j = i + 1; j < table.arms.length; j += 1) {
            interactions.push({ modelPair: armPairLabel(table.arms, i, j), estimate: scalars.interactions[pair]![0]! });
            pair += 1;
        }
    }
    return {
        perModelPerMethod,
        averagedPerMethod: METHOD_IDS.map((method, methodIndex) => ({ method, s: scalars.s[methodIndex]! })),
        lossContrasts: contrastEstimates(scalars.contrasts),
        fnDiffs: contrastEstimates(scalars.fnDiffs),
        fpDiffs: contrastEstimates(scalars.fpDiffs),
        interactions,
        spread: scalars.spread,
    };
}

/** Replicate storage: one flat array per scalar, draw-major. */
export interface ExploratoryReplicates {
    iterations: number;
    seed: number;
    lossPerQuery: number[][];
    fn: number[][];
    fp: number[][];
    s: number[][];
    contrasts: number[][][];
    fnDiffs: number[][][];
    fpDiffs: number[][][];
    interactions: number[][];
    spread: number[];
}

/**
 * The selector's paired query-cluster bootstrap conventions, applied
 * to every model × method at once: ONE mulberry32 stream (seed
 * 20261008), Q lexicographically ordered picks per draw, and the SAME
 * picks for every series — replicas and models are never independent
 * samples. No seed/B knobs beyond the frozen constants' re-export.
 */
export function runPairedQueryClusterBootstrap(
    table: ExploratoryClusterTable,
    iterations: number = FROZEN_BOOTSTRAP_ITERATIONS,
    seed: number = FROZEN_BOOTSTRAP_SEED,
): ExploratoryReplicates {
    const q = table.queryIds.length;
    const seriesCount = table.arms.length * METHOD_IDS.length;
    const scopeCount = table.arms.length + 1;
    const contrastCount = EXPLORATORY_LOSS_CONTRASTS.length;
    const armPairs: [number, number][] = [];
    for (let i = 0; i < table.arms.length; i += 1) {
        for (let j = i + 1; j < table.arms.length; j += 1) armPairs.push([i, j]);
    }
    const replicates: ExploratoryReplicates = {
        iterations,
        seed,
        lossPerQuery: Array.from({ length: seriesCount }, () => new Array<number>(iterations)),
        fn: Array.from({ length: seriesCount }, () => new Array<number>(iterations)),
        fp: Array.from({ length: seriesCount }, () => new Array<number>(iterations)),
        s: Array.from({ length: METHOD_IDS.length }, () => new Array<number>(iterations)),
        contrasts: Array.from({ length: contrastCount }, () =>
            Array.from({ length: scopeCount }, () => new Array<number>(iterations))),
        fnDiffs: Array.from({ length: contrastCount }, () =>
            Array.from({ length: scopeCount }, () => new Array<number>(iterations))),
        fpDiffs: Array.from({ length: contrastCount }, () =>
            Array.from({ length: scopeCount }, () => new Array<number>(iterations))),
        interactions: Array.from({ length: armPairs.length }, () => new Array<number>(iterations)),
        spread: new Array<number>(iterations),
    };
    const rand = mulberry32(seed);
    for (let draw = 0; draw < iterations; draw += 1) {
        const picks = new Array<number>(q);
        for (let i = 0; i < q; i += 1) picks[i] = Math.floor(rand() * q);
        const scalars = deriveScalars(table, picks);
        scalars.lossPerQuery.forEach((value, index) => { replicates.lossPerQuery[index]![draw] = value; });
        scalars.fn.forEach((value, index) => { replicates.fn[index]![draw] = value; });
        scalars.fp.forEach((value, index) => { replicates.fp[index]![draw] = value; });
        scalars.s.forEach((value, index) => { replicates.s[index]![draw] = value; });
        scalars.contrasts.forEach((values, index) => values.forEach((value, scope) => {
            replicates.contrasts[index]![scope]![draw] = value;
        }));
        scalars.fnDiffs.forEach((values, index) => values.forEach((value, scope) => {
            replicates.fnDiffs[index]![scope]![draw] = value;
        }));
        scalars.fpDiffs.forEach((values, index) => values.forEach((value, scope) => {
            replicates.fpDiffs[index]![scope]![draw] = value;
        }));
        scalars.interactions.forEach((values, index) => { replicates.interactions[index]![draw] = values[0]!; });
        replicates.spread[draw] = scalars.spread;
    }
    return replicates;
}

export interface ExploratoryInterval {
    lower: number;
    upper: number;
}

export interface ExploratoryIntervalEstimate {
    contrast: string;
    scope: string;
    point: number;
    interval: ExploratoryInterval;
}

export interface ExploratoryIntervals {
    /** Two-sided 95% nearest-rank percentile intervals; NOT multiplicity-corrected. */
    note: string;
    lossPerQuery: { model: ComparisonModelId; method: MethodId; point: number; interval: ExploratoryInterval }[];
    averagedPerMethod: { method: MethodId; point: number; interval: ExploratoryInterval }[];
    lossContrasts: ExploratoryIntervalEstimate[];
    fnDiffs: ExploratoryIntervalEstimate[];
    fpDiffs: ExploratoryIntervalEstimate[];
    interactions: { modelPair: string; point: number; interval: ExploratoryInterval }[];
    spread: { point: number; interval: ExploratoryInterval };
}

function percentileInterval(values: readonly number[]): ExploratoryInterval {
    const sorted = [...values].sort((a, b) => a - b);
    return {
        lower: percentileSorted(sorted, EXPLORATORY_INTERVAL_LOWER_QUANTILE),
        upper: percentileSorted(sorted, EXPLORATORY_INTERVAL_UPPER_QUANTILE),
    };
}

/** Two-sided 95% nearest-rank percentile intervals over the shared paired draws. */
export function buildExploratoryIntervals(
    table: ExploratoryClusterTable,
    replicates: ExploratoryReplicates,
    points: ExploratoryPointEstimates,
): ExploratoryIntervals {
    const scopeLabels = ["averaged", ...table.arms];
    const intervalEstimates = (
        perScopeReplicates: readonly number[][][],
        perScopePoints: readonly ExploratoryContrastEstimate[],
    ): ExploratoryIntervalEstimate[] => perScopePoints.map((point) => {
        const contrastIndex = EXPLORATORY_LOSS_CONTRASTS.findIndex((contrast) => contrast.label === point.contrast);
        const scopeIndex = scopeLabels.indexOf(point.scope);
        return {
            contrast: point.contrast,
            scope: point.scope,
            point: point.estimate,
            interval: percentileInterval(perScopeReplicates[contrastIndex]![scopeIndex]!),
        };
    });
    let pair = 0;
    const interactions = points.interactions.map((point) => {
        const interval = percentileInterval(replicates.interactions[pair]!);
        pair += 1;
        return { modelPair: point.modelPair, point: point.estimate, interval };
    });
    return {
        note: "two-sided 95% nearest-rank percentile interval over the shared paired query-cluster draws; NOT multiplicity-corrected; EXPLORATORY",
        lossPerQuery: points.perModelPerMethod.map((row) => {
            const index = seriesIndex(table.arms.indexOf(row.model), row.method);
            return {
                model: row.model,
                method: row.method,
                point: row.lossPerQuery,
                interval: percentileInterval(replicates.lossPerQuery[index]!),
            };
        }),
        averagedPerMethod: points.averagedPerMethod.map((row) => ({
            method: row.method,
            point: row.s,
            interval: percentileInterval(replicates.s[METHOD_IDS.indexOf(row.method)]!),
        })),
        lossContrasts: intervalEstimates(replicates.contrasts, points.lossContrasts),
        fnDiffs: intervalEstimates(replicates.fnDiffs, points.fnDiffs),
        fpDiffs: intervalEstimates(replicates.fpDiffs, points.fpDiffs),
        interactions,
        spread: { point: points.spread, interval: percentileInterval(replicates.spread) },
    };
}

/* ──────────────────────────────────────────────────────────────────
 * Per-query breakdown (sign counts + driver queries).
 * ────────────────────────────────────────────────────────────────── */

export interface ExploratoryWinTieLoss {
    model: ComparisonModelId;
    method: MethodId;
    /** Queries where the method's loss is below / equal to / above its M0 loss. */
    wins: number;
    ties: number;
    losses: number;
}

export interface ExploratoryTopContributor {
    rank: number;
    queryGroup: string;
    /** loss(M0) − loss(M1) for the driver arm: positive = M1 improved this query. */
    contribution: number;
    lossM0: number;
    lossM1: number;
    fnM0: number;
    fnM1: number;
    fpM0: number;
    fpM1: number;
}

export interface ExploratoryPerQueryBreakdown {
    /** Sign counts per model for each alternative method vs its own M0. */
    winTieLossVsM0: ExploratoryWinTieLoss[];
    /** Top queries driving the driver arm's D(M1-M0), descending, qid tie-break. */
    driverArm: ComparisonModelId;
    topContributors: ExploratoryTopContributor[];
}

function seriesFor(table: ExploratoryClusterTable, arm: ComparisonModelId, method: MethodId): ExploratorySeries {
    return table.series[seriesIndex(table.arms.indexOf(arm), method)]!;
}

/** Per-model sign counts vs M0 and the driver arm's top M1-vs-M0 contributors. */
export function computePerQueryBreakdown(
    table: ExploratoryClusterTable,
    driverArm: ComparisonModelId = EXPLORATORY_DRIVER_ARM,
): ExploratoryPerQueryBreakdown {
    const winTieLossVsM0: ExploratoryWinTieLoss[] = [];
    for (const arm of table.arms) {
        const baseline = seriesFor(table, arm, "M0");
        for (const method of ["M1", "M2"] as const) {
            const series = seriesFor(table, arm, method);
            let wins = 0;
            let ties = 0;
            let losses = 0;
            table.queryIds.forEach((_qid, index) => {
                const delta = series.perQueryLoss[index]! - baseline.perQueryLoss[index]!;
                if (delta < 0) wins += 1;
                else if (delta > 0) losses += 1;
                else ties += 1;
            });
            winTieLossVsM0.push({ model: arm, method, wins, ties, losses });
        }
    }
    const baseline = seriesFor(table, driverArm, "M0");
    const alternative = seriesFor(table, driverArm, "M1");
    const ranked = table.queryIds
        .map((qid, index) => ({
            queryGroup: qid,
            contribution: baseline.perQueryLoss[index]! - alternative.perQueryLoss[index]!,
            lossM0: baseline.perQueryLoss[index]!,
            lossM1: alternative.perQueryLoss[index]!,
            fnM0: baseline.perQueryFn[index]!,
            fnM1: alternative.perQueryFn[index]!,
            fpM0: baseline.perQueryFp[index]!,
            fpM1: alternative.perQueryFp[index]!,
        }))
        .sort((a, b) => (b.contribution - a.contribution) || compareStrings(a.queryGroup, b.queryGroup));
    const topContributors = ranked.slice(0, 5).map((row, index) => ({ rank: index + 1, ...row }));
    return { winTieLossVsM0, driverArm, topContributors };
}

/* ──────────────────────────────────────────────────────────────────
 * One full EXPLORATORY analysis over one cluster table.
 * ────────────────────────────────────────────────────────────────── */

export interface ExploratoryAnalysis {
    label: typeof METHOD_PILOT_EXPLORATORY_LABEL;
    queryClusters: number;
    replicasPerCandidate: number;
    pointEstimates: ExploratoryPointEstimates;
    intervals: ExploratoryIntervals;
    perQueryBreakdown: ExploratoryPerQueryBreakdown;
}

/** Bootstrap + intervals + breakdown over one table (full or sensitivity). */
export function analyzeMethodPilotExploratory(
    table: ExploratoryClusterTable,
    bootstrapIterations: number = FROZEN_BOOTSTRAP_ITERATIONS,
    bootstrapSeed: number = FROZEN_BOOTSTRAP_SEED,
): ExploratoryAnalysis {
    const pointEstimates = computePointEstimates(table);
    const replicates = runPairedQueryClusterBootstrap(table, bootstrapIterations, bootstrapSeed);
    return {
        label: METHOD_PILOT_EXPLORATORY_LABEL,
        queryClusters: table.queryIds.length,
        replicasPerCandidate: PILOT_REPLICA_COUNT,
        pointEstimates,
        intervals: buildExploratoryIntervals(table, replicates, pointEstimates),
        perQueryBreakdown: computePerQueryBreakdown(table),
    };
}

/* ──────────────────────────────────────────────────────────────────
 * Verdict reproduction (the glue-identity proof).
 * ────────────────────────────────────────────────────────────────── */

/** Verdict-shaped per-model/per-method row (loss/fn/lossPerQuery, same order and arithmetic as the glue). */
export interface MethodPilotReproducedRow {
    model: ComparisonModelId;
    method: MethodId;
    loss: number;
    fn: number;
    lossPerQuery: number;
}

/**
 * Rebuild the verdict's `perModelPerMethod` table from the exploratory
 * cluster table: arm-major order (frozen arm order), method order
 * M0,M1,M2, lossPerQuery = loss / cluster count — the glue's
 * `buildPerModelDiagnostics` arithmetic (loss / selector.queryCount).
 */
export function buildPerModelPerMethodTable(table: ExploratoryClusterTable): MethodPilotReproducedRow[] {
    const rows: MethodPilotReproducedRow[] = [];
    table.arms.forEach((arm, armIndex) => {
        for (const method of METHOD_IDS) {
            const series = table.series[seriesIndex(armIndex, method)]!;
            const loss = series.perQueryLoss.reduce((a, b) => a + b, 0);
            const fn = series.perQueryFn.reduce((a, b) => a + b, 0);
            rows.push({ model: arm, method, loss, fn, lossPerQuery: loss / table.queryIds.length });
        }
    });
    return rows;
}

/**
 * Fail-closed byte-for-value reproduction check: the rebuilt table
 * must JSON.stringify identically to `verdict.perModelPerMethod` (the
 * exact bytes the selector+glue produced). Any mismatch throws with
 * the first differing row.
 */
export function assertReproducedVerdictTable(
    reproduced: readonly MethodPilotReproducedRow[],
    verdictTable: readonly unknown[],
): void {
    const actualJson = JSON.stringify(reproduced);
    const expectedJson = JSON.stringify(verdictTable);
    if (actualJson === expectedJson) return;
    const length = Math.max(reproduced.length, verdictTable.length);
    for (let index = 0; index < length; index += 1) {
        const actualRow = JSON.stringify(reproduced[index]);
        const expectedRow = JSON.stringify(verdictTable[index]);
        if (actualRow !== expectedRow) {
            throw new Error(
                `method-pilot-exploratory: verdict reproduction mismatch at perModelPerMethod[${index}]: `
                + `reproduced ${actualRow ?? "<absent>"} vs verdict ${expectedRow ?? "<absent>"}`,
            );
        }
    }
    throw new Error("method-pilot-exploratory: verdict reproduction mismatch (row counts differ)");
}

/* ──────────────────────────────────────────────────────────────────
 * Recovered-error component detection (sensitivity input).
 * ────────────────────────────────────────────────────────────────── */

export interface RecoveredErrorComponent {
    model: string;
    method: string;
    queryGroup: string;
    replica: number;
    direction: string;
    candidateIds: readonly string[];
    attempts: { attemptIndex: number; httpStatus: number | null; errorClass: string | null }[];
    /** True when at least one attempt succeeded (the component's answer exists). */
    recovered: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

const NUL = String.fromCharCode(0);

function componentIdentityOf(raw: Record<string, unknown>): string | null {
    if (typeof raw.arm !== "string" || typeof raw.method !== "string" || typeof raw.replica !== "number") return null;
    if (typeof raw.queryGroup !== "string" || typeof raw.direction !== "string") return null;
    if (!Array.isArray(raw.candidateIds) || !raw.candidateIds.every((cid) => typeof cid === "string")) return null;
    return [raw.arm, raw.method, raw.queryGroup, String(raw.replica), raw.direction, (raw.candidateIds as string[]).join(NUL)].join(NUL);
}

/**
 * Scan raw wire-record rows for any component whose attempts include a
 * failed attempt (errorClass !== null) — the recovered-error
 * components. Returns the affected query groups (sorted) plus the
 * per-attempt provenance; never mutates anything.
 */
export function detectRecoveredErrorComponents(
    recordRows: readonly unknown[],
): { components: RecoveredErrorComponent[]; affectedQueryGroups: string[] } {
    const byComponent = new Map<string, RecoveredErrorComponent & { order: number }>();
    let order = 0;
    for (const raw of recordRows) {
        if (!isPlainObject(raw)) continue;
        const errorClass = raw.errorClass;
        const hasError = typeof errorClass === "string" && errorClass.length > 0;
        const identity = componentIdentityOf(raw);
        if (identity === null || (!hasError && typeof raw.wireId !== "string")) continue;
        let component = byComponent.get(identity);
        if (component === undefined) {
            component = {
                model: raw.arm as string,
                method: raw.method as string,
                queryGroup: raw.queryGroup as string,
                replica: raw.replica as number,
                direction: raw.direction as string,
                candidateIds: [...(raw.candidateIds as string[])],
                attempts: [],
                recovered: false,
                order: order,
            };
            order += 1;
            byComponent.set(identity, component);
        }
        component.attempts.push({
            attemptIndex: typeof raw.attemptIndex === "number" ? raw.attemptIndex : 0,
            httpStatus: typeof raw.httpStatus === "number" ? raw.httpStatus : null,
            errorClass: typeof errorClass === "string" && errorClass.length > 0 ? errorClass : null,
        });
        if (!hasError) component.recovered = true;
    }
    const errored = [...byComponent.values()]
        .filter((component) => component.attempts.some((attempt) => attempt.errorClass !== null))
        .sort((a, b) => a.order - b.order)
        .map(({ order: _order, ...component }) => {
            component.attempts.sort((a, b) => a.attemptIndex - b.attemptIndex);
            return component;
        });
    const groups = new Set(errored.map((component) => component.queryGroup));
    return { components: errored, affectedQueryGroups: [...groups].sort(compareStrings) };
}

/** Candidate-level outcome detail for each recovered-error component (shows the retried cells' scores). */
export function recoveredErrorCellDetails(
    roster: PilotCorpusRoster,
    rows: readonly MethodPilotProbabilityRow[],
    components: readonly RecoveredErrorComponent[],
): {
    model: string;
    method: string;
    queryGroup: string;
    candidateId: string;
    score: number | null;
    keep: boolean | null;
    gold: boolean;
    loss: number | null;
}[] {
    const lookup = buildRowLookup(rows);
    const details: ReturnType<typeof recoveredErrorCellDetails> = [];
    for (const component of components) {
        if (!isComparisonModelId(component.model)) continue;
        if (!METHOD_IDS.includes(component.method as MethodId)) continue;
        for (const candidateId of component.candidateIds) {
            const candidate = roster.candidates.find((entry) => entry.cid === candidateId
                && entry.qid === component.queryGroup);
            if (candidate === undefined) continue;
            const score = candidateScore(lookup, component.model, component.method as MethodId, component.queryGroup, candidateId);
            const keep = score >= FROZEN_KEEP_THRESHOLD;
            const gold = candidate.label === "gold";
            details.push({
                model: component.model,
                method: component.method,
                queryGroup: component.queryGroup,
                candidateId,
                score,
                keep,
                gold,
                loss: gold && !keep ? EXPLORATORY_WEIGHTED_FN_PENALTY : !gold && keep ? 1 : 0,
            });
        }
    }
    return details;
}

/* ──────────────────────────────────────────────────────────────────
 * CLI (read-only; prints one JSON document to stdout).
 * ────────────────────────────────────────────────────────────────── */

export interface MethodPilotExploratoryArgs {
    pilotRoot: string;
    records: string;
    plan: string;
    verdict: string;
    help: boolean;
}

function takeValue(flag: string, argv: readonly string[], index: number): string {
    const value = argv[index];
    if (value === undefined || value.startsWith("--")) {
        throw new Error(`${flag} requires a value`);
    }
    return value;
}

const VALUE_FLAGS = new Map<string, "pilotRoot" | "records" | "plan" | "verdict">([
    ["--pilot-root", "pilotRoot"],
    ["--records", "records"],
    ["--plan", "plan"],
    ["--verdict", "verdict"],
]);

export function parseMethodPilotExploratoryArgs(argv: readonly string[]): MethodPilotExploratoryArgs {
    const values: Record<"pilotRoot" | "records" | "plan" | "verdict", string | undefined> = {
        pilotRoot: undefined,
        records: undefined,
        plan: undefined,
        verdict: undefined,
    };
    let help = false;
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        const field = arg === undefined ? undefined : VALUE_FLAGS.get(arg);
        if (field !== undefined) {
            values[field] = takeValue(arg!, argv, i + 1);
            i += 1;
        } else if (arg === "--help" || arg === "-h") {
            help = true;
        } else {
            throw new Error(`Unknown argument: ${String(arg)}`);
        }
    }
    if (!help) {
        if (values.records === undefined) throw new Error("--records is required (wire-records JSONL path)");
        if (values.plan === undefined) throw new Error("--plan is required (plan artifact path)");
        if (values.verdict === undefined) throw new Error("--verdict is required (stored verdict JSON path)");
    }
    return {
        pilotRoot: values.pilotRoot ?? defaultPilotRoot(),
        records: values.records ?? "",
        plan: values.plan ?? "",
        verdict: values.verdict ?? "",
        help,
    };
}

function printUsage(): void {
    console.warn("Usage: npx tsx scripts/eval/judge/method-pilot-exploratory.ts --pilot-root DIR --records PATH --plan PATH --verdict PATH");
    console.warn("  EXPLORATORY paired query-cluster analysis of the method-pilot records.");
    console.warn("  No selection, no verdict change: prints one JSON document to stdout.");
    console.warn("  Offline: no network, no credentials, no writes into the pilot data root.");
    console.warn("  Exit codes: 0 ok, 2 usage/validation (incl. verdict reproduction mismatch), 3 corpus/plan gate refusal.");
}

function readJsonlRowsRaw(path: string): unknown[] {
    const content = readFileSync(path, "utf-8");
    const rows: unknown[] = [];
    for (const [index, line] of content.split("\n").entries()) {
        if (line === "") continue;
        try {
            rows.push(JSON.parse(line));
        } catch {
            throw new Error(`method-pilot-exploratory: ${path}: invalid JSON at line ${index + 1}`);
        }
    }
    return rows;
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export interface MethodPilotExploratoryRunOptions {
    /** Test seam: replace Stage B's loader (production: `loadVerifiedPilotCorpus`). */
    loadRoster?: (root: string) => PilotCorpusRoster;
}

/** CLI core: returns the process exit code; never calls `process.exit` itself. */
export async function runMethodPilotExploratory(
    argv: readonly string[],
    options: MethodPilotExploratoryRunOptions = {},
): Promise<number> {
    let args: MethodPilotExploratoryArgs;
    try {
        args = parseMethodPilotExploratoryArgs(argv);
    } catch (error) {
        console.error(`error: ${messageOf(error)}`);
        return METHOD_PILOT_EXPLORATORY_EXIT_USAGE;
    }
    if (args.help) {
        printUsage();
        return METHOD_PILOT_EXPLORATORY_EXIT_OK;
    }

    // Gate (exit 3): the sealed corpus and the plan artifact verify together.
    let roster: PilotCorpusRoster;
    let plan: MethodPilotPlanArtifact;
    try {
        roster = (options.loadRoster ?? loadVerifiedPilotCorpus)(args.pilotRoot);
        if (!isVerifiedPilotCorpusRoster(roster)) {
            throw new Error("method-pilot-exploratory: roster is not a load-verified sealed corpus roster");
        }
        let parsedPlan: unknown;
        try {
            parsedPlan = JSON.parse(readFileSync(args.plan, "utf-8"));
        } catch (error) {
            throw new Error(`plan artifact ${args.plan} is not valid JSON: ${messageOf(error)}`);
        }
        if (!isMethodPilotPlanArtifact(parsedPlan)) {
            throw new Error(`plan artifact ${args.plan} is not a valid method-pilot-request-plan artifact`);
        }
        plan = parsedPlan;
        const mismatch = verifyPlanForRoster(plan, roster);
        if (mismatch !== null) throw new Error(mismatch);
    } catch (error) {
        console.error(`error: pilot/plan gate refused: ${messageOf(error)}; no analysis produced`);
        return METHOD_PILOT_EXPLORATORY_EXIT_GATE;
    }

    // Validation + analysis (exit 2): records → derivation → reproduction proof → tables.
    try {
        const recordRows = readJsonlRowsRaw(args.records);
        const derivation = deriveMethodPilotSelectorInput(roster, plan, recordRows);
        const table = buildExploratoryClusterTable(roster, derivation.input.rows);
        const reproduced = buildPerModelPerMethodTable(table);
        let verdictTable: readonly unknown[];
        try {
            const verdict = JSON.parse(readFileSync(args.verdict, "utf-8")) as { perModelPerMethod?: unknown };
            if (!Array.isArray(verdict.perModelPerMethod)) {
                throw new Error("verdict has no perModelPerMethod array");
            }
            verdictTable = verdict.perModelPerMethod;
        } catch (error) {
            throw new Error(`verdict ${args.verdict} unreadable: ${messageOf(error)}`);
        }
        assertReproducedVerdictTable(reproduced, verdictTable);

        const recovered = detectRecoveredErrorComponents(recordRows);
        const full = analyzeMethodPilotExploratory(table);
        const sensitivityTable = buildExploratoryClusterTable(roster, derivation.input.rows, recovered.affectedQueryGroups);
        const sensitivity = analyzeMethodPilotExploratory(sensitivityTable);

        const payload = {
            label: METHOD_PILOT_EXPLORATORY_LABEL,
            disclaimer:
                "EXPLORATORY paired analysis: no selection, no verdict change. Intervals are descriptive, "
                + "two-sided 95% nearest-rank percentiles over shared paired query-cluster draws, and are NOT "
                + "multiplicity-corrected across the 3 models × 3 loss contrasts plus FN/FP differences, "
                + "interactions, and the spread statistic.",
            unitOfIndependence: `query cluster (${table.queryIds.length} clusters; 2 replicas averaged within candidate before thresholding)`,
            bootstrap: {
                iterations: FROZEN_BOOTSTRAP_ITERATIONS,
                seed: FROZEN_BOOTSTRAP_SEED,
                prng: "mulberry32",
                pairing: "the same query picks are used for every model x method within each draw",
            },
            reproduction: {
                verdictTableReproduced: true,
                reproducedPerModelPerMethod: reproduced,
            },
            recoveredErrorComponents: {
                components: recovered.components,
                affectedQueryGroups: recovered.affectedQueryGroups,
                cellDetails: recoveredErrorCellDetails(roster, derivation.input.rows, recovered.components),
            },
            full: full,
            sensitivityExcludingRecoveredErrorComponents: {
                excludedQueryGroups: recovered.affectedQueryGroups,
                analysis: sensitivity,
            },
        };
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        console.warn(
            `method-pilot-exploratory: EXPLORATORY analysis written to stdout `
            + `(${table.queryIds.length} clusters; verdict table reproduced byte-for-value; `
            + `${recovered.affectedQueryGroups.length} recovered-error query group(s) excluded in sensitivity)`,
        );
        return METHOD_PILOT_EXPLORATORY_EXIT_OK;
    } catch (error) {
        console.error(`error: ${messageOf(error)}; no analysis produced`);
        return METHOD_PILOT_EXPLORATORY_EXIT_USAGE;
    }
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : "";
if (invoked === fileURLToPath(import.meta.url)) {
    process.exitCode = await runMethodPilotExploratory(process.argv.slice(2));
}
