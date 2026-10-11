#!/usr/bin/env node
/**
 * Judge confirmation v2 — preregistration analysis, power/cost projection,
 * and Monte-Carlo validation of the two candidate per-model test
 * procedures (paired t-test and sign-flip permutation, each + Holm
 * step-down) — `method-confirm-analysis.ts`.
 *
 * This module is the analysis companion of
 * `docs/plans/2026-10-09-judge-confirmation-prereg.md`. It performs NO
 * selection of a deployed method: the pilot data below is used only to
 * CHOOSE WHICH per-model comparison the fresh study tests (owner decision
 * 3: "Preregister one challenger per model using the pilot. Apply Holm
 * across three tests. Assess power and cost."), never to support an effect
 * claim. Adoption in the fresh study additionally requires the inherited
 * A1.1 FN guard (protocol §9, line 495).
 *
 * Estimand (preregistered): for model a and query q,
 * d_{a,q} = L_{a,C,q} − L_{a,M0,q} with L = 6·FN + FP at tau = 0.40 on
 * replica-averaged probabilities; delta_a = E_q[d_{a,q}]; one-sided paired
 * query-level test H0: delta_a >= 0 vs H1: delta_a < 0 (frozen primary
 * procedure: sign-flip permutation after the §7 simulation failure of the
 * paired t-test candidate; §7.1); Holm step-down across the three models
 * at FWER 0.05.
 *
 * Loss logic is NOT duplicated here: per-model/per-method per-query loss
 * comes from the pilot exploratory module's exported derivation
 * (`buildExploratoryClusterTable`), which is itself pinned byte-for-value
 * against the sealed verdict by `assertReproducedVerdictTable` (run on
 * every CLI invocation). Token/cost aggregation copies the dedup-by-wireId
 * method of the pilot aggregation script (first-seen row per wireId).
 *
 * Pure/deterministic core: `studentTCdf`, `pairedTTestOneSided`,
 * `buildSignMatrix`, `signFlipNullSums`, `signFlipOneSidedPValue`,
 * `holmStepDown`, `selectChallenger`, `analyticOneSidedPower`,
 * `queriesForEightyPercentPower`, `summarizeWireCost`,
 * `costPerQueryPerReplica`, `buildBudgetEnvelope`,
 * `runConfirmationSimulation` — no I/O, no network, no credentials, no
 * clock. The CLI only reads the sealed pilot root, the plan artifact, its
 * wire records, and the stored verdict, then prints one JSON document.
 *
 * Both per-model procedures are first-class exports because the
 * preregistration (§7 / §7.1 of the companion doc) validated both under
 * the identical Monte-Carlo design: the paired t-test FAILED its frozen
 * per-test Type-I criterion, so the pre-committed fallback — the one-sided
 * sign-flip permutation test (production: CONFIRM_SIGN_FLIP_DRAWS draws,
 * CONFIRM_SIGN_FLIP_SEED seed, Holm across the three models) — is the
 * frozen PRIMARY procedure for the confirmation analysis. The paired-t
 * results are retained for transparency (`--procedure paired-t`).
 *
 * Simulation conventions (frozen in the preregistration BEFORE the
 * simulation was run): seed 20261009, >= 20,000 reps, n = 400 per-model
 * draws with replacement from the pilot per-query d (centred to delta = 0
 * for Type I; shifted by the pilot point estimate and by half of it for
 * power — for the sign-flip procedure the shift is applied to the
 * resampled values themselves, exactly as the real analysis would see
 * them; for paired-t the additive shift moves only the sample mean, so one
 * sample mean/sd per rep serves all three scenarios), per-test Type I at
 * alpha = 0.05 and Holm FWER both must be <= 0.06 to PASS.
 *
 * Exit codes (sibling conventions): 0 ok · 2 usage/validation · 3 gate
 * refusal (sealed corpus or plan artifact cannot be verified). Main guard:
 * the CLI runs only when this module is the invoked entry point.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { METHOD_IDS, type MethodId } from "./method-comparison-contract.js";
import {
    isVerifiedPilotCorpusRoster,
    loadVerifiedPilotCorpus,
    type PilotCorpusRoster,
} from "./method-pilot-fixture.js";
import {
    assertReproducedVerdictTable,
    buildExploratoryClusterTable,
    buildPerModelPerMethodTable,
    type ExploratoryClusterTable,
} from "./method-pilot-exploratory.js";
import { defaultPilotRoot, isMethodPilotPlanArtifact, type MethodPilotPlanArtifact } from "./method-pilot.js";
import {
    deriveMethodPilotSelectorInput,
    verifyPlanForRoster,
} from "./method-pilot-select.js";
import { mulberry32 } from "./method-pilot-selector.js";
import { MODEL_INPUT_RATE_PER_M_USD, requestReserveUsd } from "./model-comparison-budget.js";

/** Exit codes (0 ok · 2 validation · 3 gate refusal). */
export const METHOD_CONFIRM_ANALYSIS_EXIT_OK = 0;
export const METHOD_CONFIRM_ANALYSIS_EXIT_USAGE = 2;
export const METHOD_CONFIRM_ANALYSIS_EXIT_GATE = 3;

/** Family-wise alpha for the three per-model tests (Holm step-down). */
export const CONFIRM_FAMILY_ALPHA = 0.05;
/** Number of per-model tests (one per requested Decisions API model). */
export const CONFIRM_TEST_COUNT = 3;
/** Preregistered confirmation size (fresh held-out queries). */
export const CONFIRM_QUERY_COUNT = 400;
/** Preregistered confirmation replica count (see prereg open question on A1.4's ladder). */
export const CONFIRM_REPLICA_COUNT = 3;
/** Monte-Carlo floor demanded by the brief. */
export const CONFIRM_SIMULATION_REPS_MIN = 20_000;
/** Frozen simulation seed (recorded in the preregistration pre-run). */
export const CONFIRM_SIMULATION_SEED = 20_261_009;
/** PASS criteria, written into the preregistration before the run. */
export const CONFIRM_TYPE_I_MAX = 0.06;
export const CONFIRM_FWER_MAX = 0.06;
/** Output tokens are billed at $0 for all three decision models (ledger P5). */
export const CONFIRM_OUTPUT_RATE_PER_M_USD = 0;
/**
 * Deferred 44-query three-model M0 suite (oracle §5): ~$0.14 at three
 * replicas. Approximation only — its payload-specific projection must
 * replace this number before paid authorization.
 */
export const DEFERRED_44_QUERY_M0_SUITE_USD = 0.14;
/** Campaign cap raised by the owner on 2026-10-09 (previous cap: $3). */
export const CONFIRM_CAMPAIGN_CAP_USD = 10;
/** Spend + reservations already used against the campaign cap (2026-10-09). */
export const CONFIRM_CAMPAIGN_SPENT_USD = 0.3613;
/** Two additional UNKNOWN reservations per model (budget-module reserves). */
export const CONFIRM_UNKNOWN_RESERVES_PER_MODEL = 2;
/** Sigma for the analytic normal-approximation power / sample-size math. */
export const CONFIRM_PLANNING_Z_ALPHA_ONE_SIDED = 0.05 / CONFIRM_TEST_COUNT;
/**
 * Sign-flip permutation test (pre-committed fallback, now the frozen
 * primary after the paired-t failure — prereg §7 criteria block, results
 * §7.1): production draws and seed for the real confirmation analysis.
 */
export const CONFIRM_SIGN_FLIP_DRAWS = 100_000;
export const CONFIRM_SIGN_FLIP_SEED = 20_261_010;
/** Inner draws when the simulation validates the sign-flip procedure (prereg §7.1). */
export const CONFIRM_SIMULATION_SIGN_FLIP_DRAWS = 10_000;

/* ──────────────────────────────────────────────────────────────────
 * Special functions (deterministic, no dependencies).
 * ────────────────────────────────────────────────────────────────── */

/**
 * Complementary error function, Chebyshev fit (Numerical Recipes
 * `erfcc`): fractional error < 1.2e-7 everywhere — sufficient for the
 * planning power figures, never used to produce a study p-value (the
 * t-tests below use the exact-by-construction incomplete-beta CDF).
 */
export function erfcChebyshev(x: number): number {
    const z = Math.abs(x);
    const t = 2 / (2 + z);
    const ty = 4 * t - 2;
    const cof = [
        -1.3026537197817094, 6.4196979235649026e-1, 1.9476473204185836e-2, -9.561514786808631e-3,
        -9.46595344482036e-4, 3.66839497852761e-4, 4.2523324806907e-5, -2.0278578112534e-5,
        -1.624290004647e-6, 1.303655835580e-6, 1.5626441722e-8, -8.5238095915e-8,
        6.529054439e-9, 5.059343495e-9, -9.91364156e-10, -2.27365122e-10,
        9.6467911e-11, 2.394038e-12, -6.886027e-12, 8.94487e-13,
        3.13092e-13, -1.12708e-13, 3.81e-16, 7.106e-15,
    ];
    let d = 0;
    let dd = 0;
    for (let j = cof.length - 1; j > 0; j -= 1) {
        const tmp = d;
        d = ty * d - dd + cof[j]!;
        dd = tmp;
    }
    const ans = t * Math.exp(-z * z + 0.5 * (cof[0]! + ty * d) - dd);
    return x >= 0 ? ans : 2 - ans;
}

/** Standard normal CDF. */
export function normalCdf(x: number): number {
    return 0.5 * erfcChebyshev(-x / Math.SQRT2);
}

/** Standard normal quantile (bisection against `normalCdf`, 1e-12 tolerance). */
export function normalQuantile(p: number): number {
    if (!(p > 0 && p < 1)) throw new Error("normalQuantile: p must be in (0,1)");
    let low = -40;
    let high = 40;
    for (let i = 0; i < 200 && high - low > 1e-12; i += 1) {
        const mid = (low + high) / 2;
        if (normalCdf(mid) < p) low = mid;
        else high = mid;
    }
    return (low + high) / 2;
}

function logGammaLanczos(x: number): number {
    const g = 7;
    const cof = [
        0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
        -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
        1.5056327351493116e-7,
    ];
    if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGammaLanczos(1 - x);
    const xx = x - 1;
    let a = cof[0]!;
    const t = xx + g + 0.5;
    for (let i = 1; i < cof.length; i += 1) a += cof[i]! / (xx + i);
    return 0.5 * Math.log(2 * Math.PI) + (xx + 0.5) * Math.log(t) - t + Math.log(a);
}

function betaContinuedFraction(a: number, b: number, x: number): number {
    const MAX_ITER = 300;
    const EPS = 3e-16;
    const FPMIN = 1e-300;
    const qab = a + b;
    const qap = a + 1;
    const qam = a - 1;
    let c = 1;
    let d = 1 - (qab * x) / qap;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    d = 1 / d;
    let h = d;
    for (let m = 1; m <= MAX_ITER; m += 1) {
        const m2 = 2 * m;
        let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
        d = 1 + aa * d;
        if (Math.abs(d) < FPMIN) d = FPMIN;
        c = 1 + aa / c;
        if (Math.abs(c) < FPMIN) c = FPMIN;
        d = 1 / d;
        h *= d * c;
        aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
        d = 1 + aa * d;
        if (Math.abs(d) < FPMIN) d = FPMIN;
        c = 1 + aa / c;
        if (Math.abs(c) < FPMIN) c = FPMIN;
        d = 1 / d;
        const del = d * c;
        h *= del;
        if (Math.abs(del - 1) < EPS) break;
    }
    return h;
}

/** Regularized incomplete beta I_x(a, b). */
export function regularizedIncompleteBeta(a: number, b: number, x: number): number {
    if (!(a > 0) || !(b > 0)) throw new Error("regularizedIncompleteBeta: a and b must be positive");
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    const front = Math.exp(
        logGammaLanczos(a + b) - logGammaLanczos(a) - logGammaLanczos(b) + a * Math.log(x) + b * Math.log(1 - x),
    );
    if (x < (a + 1) / (a + b + 2)) return (front * betaContinuedFraction(a, b, x)) / a;
    return 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b;
}

/** Student-t CDF P(T <= t) with `df` degrees of freedom (exact beta identity). */
export function studentTCdf(t: number, df: number): number {
    if (!(df > 0)) throw new Error("studentTCdf: df must be positive");
    if (!Number.isFinite(t)) return t > 0 ? 1 : 0;
    if (t === 0) return 0.5;
    const x = df / (df + t * t);
    const half = 0.5 * regularizedIncompleteBeta(df / 2, 0.5, x);
    return t > 0 ? 1 - half : half;
}

/* ──────────────────────────────────────────────────────────────────
 * Test primitives: paired one-sided t-test and Holm step-down.
 * ────────────────────────────────────────────────────────────────── */

export interface PairedTResult {
    n: number;
    mean: number;
    /** Sample standard deviation (n − 1 denominator). */
    sd: number;
    se: number;
    /** t = mean / se; ±Infinity when the sample is degenerate. */
    t: number;
    df: number;
    /** One-sided p-value for H1: mean < 0 (P(T <= t)). */
    pValue: number;
}

/**
 * One-sided paired query-level t-test on the per-query differences d.
 * H0: delta >= 0 vs H1: delta < 0 (negative d favours the challenger).
 */
export function pairedTTestOneSided(values: readonly number[]): PairedTResult {
    const n = values.length;
    if (n < 2) throw new Error("pairedTTestOneSided: need at least 2 values");
    let sum = 0;
    for (const v of values) {
        if (!Number.isFinite(v)) throw new Error("pairedTTestOneSided: non-finite value");
        sum += v;
    }
    const mean = sum / n;
    let sq = 0;
    for (const v of values) sq += (v - mean) ** 2;
    const sd = Math.sqrt(sq / (n - 1));
    const df = n - 1;
    if (sd === 0) {
        const t = mean < 0 ? -Infinity : mean > 0 ? Infinity : 0;
        const pValue = mean < 0 ? 0 : mean > 0 ? 1 : 0.5;
        return { n, mean, sd, se: 0, t, df, pValue };
    }
    const se = sd / Math.sqrt(n);
    const t = mean / se;
    return { n, mean, sd, se, t, df, pValue: studentTCdf(t, df) };
}

export interface HolmResult {
    /** Input indices ordered by ascending p (ties: lower input index first). */
    order: number[];
    /** Per-step alpha/(m − i) thresholds, aligned with `order`. */
    thresholds: number[];
    /** Rejection flags, aligned with the input array. */
    rejected: boolean[];
    /** Index into `order` of the first non-rejection (step-down stop), or null. */
    stopAt: number | null;
    anyRejected: boolean;
}

/**
 * Holm step-down at family alpha: sort p ascending (ties broken by input
 * index), reject p_(i) iff p_(i) <= alpha/(m − i) and every earlier step
 * rejected; stop at the first failure.
 */
export function holmStepDown(pValues: readonly number[], alpha: number = CONFIRM_FAMILY_ALPHA): HolmResult {
    const m = pValues.length;
    if (m === 0) throw new Error("holmStepDown: no p-values");
    const order = pValues.map((p, i) => [p, i] as const)
        .sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]))
        .map(([, i]) => i);
    const thresholds: number[] = [];
    const rejected = new Array<boolean>(m).fill(false);
    let stopAt: number | null = null;
    for (let i = 0; i < m; i += 1) {
        const threshold = alpha / (m - i);
        thresholds.push(threshold);
        const p = pValues[order[i]!]!;
        if (stopAt === null && p <= threshold) rejected[order[i]!] = true;
        else if (stopAt === null) stopAt = i;
    }
    return { order, thresholds, rejected, stopAt, anyRejected: rejected.some(Boolean) };
}

/* ──────────────────────────────────────────────────────────────────
 * Challenger rule (owner decision 3) and analytic planning power.
 * ────────────────────────────────────────────────────────────────── */

export interface ChallengerChoice {
    model: string;
    chosen: MethodId;
    m1Loss: number;
    m2Loss: number;
    /** "loss" normally; "projected-cost" only on an exact loss tie. */
    tieBreak: "loss" | "projected-cost";
    m1ProjectedCostPerQuery: number;
    m2ProjectedCostPerQuery: number;
}

/**
 * Challenger rule (preregistered): per model, the method in {M1, M2} with
 * the lowest pilot weighted loss (6FN + FP at tau .40 on replica-averaged
 * probabilities); exact tie → lower projected cost per query; an exact
 * cost tie fails closed (no silent preference).
 */
export function selectChallenger(
    model: string,
    losses: { M1: number; M2: number },
    projectedCostPerQuery: { M1: number; M2: number },
): ChallengerChoice {
    if (!Number.isFinite(losses.M1) || !Number.isFinite(losses.M2)) {
        throw new Error(`selectChallenger: non-finite loss for ${model}`);
    }
    if (losses.M1 < losses.M2) {
        return {
            model, chosen: "M1", m1Loss: losses.M1, m2Loss: losses.M2, tieBreak: "loss",
            m1ProjectedCostPerQuery: projectedCostPerQuery.M1, m2ProjectedCostPerQuery: projectedCostPerQuery.M2,
        };
    }
    if (losses.M2 < losses.M1) {
        return {
            model, chosen: "M2", m1Loss: losses.M1, m2Loss: losses.M2, tieBreak: "loss",
            m1ProjectedCostPerQuery: projectedCostPerQuery.M1, m2ProjectedCostPerQuery: projectedCostPerQuery.M2,
        };
    }
    if (projectedCostPerQuery.M1 < projectedCostPerQuery.M2) {
        return {
            model, chosen: "M1", m1Loss: losses.M1, m2Loss: losses.M2, tieBreak: "projected-cost",
            m1ProjectedCostPerQuery: projectedCostPerQuery.M1, m2ProjectedCostPerQuery: projectedCostPerQuery.M2,
        };
    }
    if (projectedCostPerQuery.M2 < projectedCostPerQuery.M1) {
        return {
            model, chosen: "M2", m1Loss: losses.M1, m2Loss: losses.M2, tieBreak: "projected-cost",
            m1ProjectedCostPerQuery: projectedCostPerQuery.M1, m2ProjectedCostPerQuery: projectedCostPerQuery.M2,
        };
    }
    throw new Error(`selectChallenger: unresolvable exact tie for ${model} (loss and projected cost both tie)`);
}

/**
 * Conservative analytic planning power for a one-sided test of
 * H1: delta < 0 at level `alpha`, normal approximation with the pilot
 * query-level sd (Holm's first step runs at alpha/3 — the Bonferroni
 * level — so `alpha = CONFIRM_PLANNING_Z_ALPHA_ONE_SIDED` is the
 * conservative per-test planning number; actual Holm power comes from
 * the Monte-Carlo simulation).
 */
export function analyticOneSidedPower(effect: number, sd: number, n: number, alpha: number): number {
    if (!(sd > 0)) throw new Error("analyticOneSidedPower: sd must be positive");
    if (!(n >= 2)) throw new Error("analyticOneSidedPower: n must be >= 2");
    const noncentrality = (Math.abs(effect) * Math.sqrt(n)) / sd;
    return normalCdf(noncentrality - normalQuantile(1 - alpha));
}

/** Queries needed for 80% planning power at the Bonferroni/Holm first-step level. */
export function queriesForEightyPercentPower(effect: number, sd: number, alpha: number): number {
    if (!(sd > 0)) throw new Error("queriesForEightyPercentPower: sd must be positive");
    if (Math.abs(effect) < 1e-12) return Infinity;
    const z = normalQuantile(1 - alpha) + normalQuantile(0.8);
    return Math.ceil(((z * sd) / Math.abs(effect)) ** 2);
}

/* ──────────────────────────────────────────────────────────────────
 * Cost: wireId-deduped token aggregation (method copied from the pilot
 * aggregation script: first row per wireId wins) at live ledger prices.
 * ────────────────────────────────────────────────────────────────── */

export interface ConfirmWireRow {
    wireId: string;
    arm: string;
    method: MethodId;
    warmup: boolean;
    inputTokens: number | null;
}

export interface WireCostSummary {
    arm: string;
    method: MethodId;
    /** Distinct wireIds (attempt-level records are distinct wireIds). */
    requests: number;
    warmups: number;
    scoredRequests: number;
    /** Scored (non-warmup) requests carrying a token count. */
    scoredTokenRequests: number;
    /** Non-warmup input tokens (rows without a token count are excluded). */
    scoredInputTokens: number;
    meanInputTokens: number | null;
    /** Warmup input tokens across all replicas present in the pilot. */
    warmupInputTokens: number;
    scoredRequestsMissingTokens: number;
}

function wireKey(arm: string, method: MethodId): string {
    return `${arm}|${method}`;
}

/** Dedup by wireId (first row wins), then aggregate tokens per model × method. */
export function summarizeWireCost(rows: readonly ConfirmWireRow[]): Map<string, WireCostSummary> {
    const seen = new Map<string, ConfirmWireRow>();
    for (const row of rows) {
        if (row.wireId === "") throw new Error("summarizeWireCost: empty wireId");
        if (!seen.has(row.wireId)) seen.set(row.wireId, row);
    }
    const out = new Map<string, WireCostSummary>();
    for (const row of seen.values()) {
        const key = wireKey(row.arm, row.method);
        let e = out.get(key);
        if (e === undefined) {
            e = {
                arm: row.arm, method: row.method, requests: 0, warmups: 0, scoredRequests: 0,
                scoredTokenRequests: 0, scoredInputTokens: 0, meanInputTokens: null,
                warmupInputTokens: 0, scoredRequestsMissingTokens: 0,
            };
            out.set(key, e);
        }
        e.requests += 1;
        if (row.warmup) {
            e.warmups += 1;
            if (typeof row.inputTokens === "number") e.warmupInputTokens += row.inputTokens;
            continue;
        }
        e.scoredRequests += 1;
        if (typeof row.inputTokens === "number") {
            e.scoredInputTokens += row.inputTokens;
            e.scoredTokenRequests += 1;
        } else {
            e.scoredRequestsMissingTokens += 1;
        }
    }
    for (const e of out.values()) {
        e.meanInputTokens = e.scoredTokenRequests > 0 ? e.scoredInputTokens / e.scoredTokenRequests : null;
    }
    return out;
}

/** USD for `tokens` input tokens at `ratePerM` USD per million (output is $0). */
export function usdForInputTokens(tokens: number, ratePerM: number): number {
    return (tokens * ratePerM) / 1_000_000;
}

/** Cost of one query per replica for a method made of `totalInputTokens` worth of requests. */
export function costPerQueryPerReplica(
    totalInputTokens: number,
    queries: number,
    replicas: number,
    ratePerM: number,
): number {
    if (!(queries > 0) || !(replicas > 0)) throw new Error("costPerQueryPerReplica: queries and replicas must be > 0");
    return usdForInputTokens(totalInputTokens / (queries * replicas), ratePerM);
}

/* ──────────────────────────────────────────────────────────────────
 * Budget envelope (nominal + oracle-style stress).
 * ────────────────────────────────────────────────────────────────── */

export interface BudgetEnvelopeInput {
    queries: number;
    replicas: number;
    /** USD per query per replica: M0 arm per model. */
    m0CostPerQueryReplicaByModel: Record<string, number>;
    /** USD per query per replica: the model's chosen challenger, marginal of shared M0 forward calls. */
    challengerMarginalCostPerQueryReplicaByModel: Record<string, number>;
    /** Warmup allowance for the whole campaign at the frozen replica count. */
    warmupAllowanceUsd: number;
    deferredSuiteUsd: number;
    modelNames: readonly string[];
    capUsd: number;
    spentUsd: number;
}

export interface BudgetEnvelope {
    queries: number;
    replicas: number;
    nominalScoredUsd: number;
    warmupAllowanceUsd: number;
    deferredSuiteUsd: number;
    nominalTotalUsd: number;
    /** Three billed attempts per planned request (oracle stress convention). */
    attemptsEnvelopeUsd: number;
    unknownReserveUsd: number;
    admissionReserveUsd: number;
    stressTotalUsd: number;
    capUsd: number;
    spentUsd: number;
    remainingUsd: number;
    nominalFits: boolean;
    stressFits: boolean;
}

/** Nominal and stress envelope, mirroring the oracle's budget-envelope method. */
export function buildBudgetEnvelope(input: BudgetEnvelopeInput): BudgetEnvelope {
    const challengers = input.challengerMarginalCostPerQueryReplicaByModel;
    let perQueryReplica = 0;
    for (const model of input.modelNames) {
        const m0 = input.m0CostPerQueryReplicaByModel[model];
        const challenger = challengers[model];
        if (m0 === undefined || challenger === undefined || !Number.isFinite(m0) || !Number.isFinite(challenger)) {
            throw new Error(`buildBudgetEnvelope: missing cost for model ${model}`);
        }
        perQueryReplica += m0 + challenger;
    }
    const nominalScoredUsd = input.queries * input.replicas * perQueryReplica;
    const nominalTotalUsd = nominalScoredUsd + input.warmupAllowanceUsd + input.deferredSuiteUsd;
    const attemptsEnvelopeUsd = 3 * nominalTotalUsd;
    const unknownReserveUsd = CONFIRM_UNKNOWN_RESERVES_PER_MODEL
        * input.modelNames.reduce((sum, model) => sum + requestReserveUsd(model), 0);
    const admissionReserveUsd = Math.max(...input.modelNames.map((model) => requestReserveUsd(model)));
    const stressTotalUsd = attemptsEnvelopeUsd + unknownReserveUsd + admissionReserveUsd;
    const remainingUsd = input.capUsd - input.spentUsd;
    return {
        queries: input.queries,
        replicas: input.replicas,
        nominalScoredUsd,
        warmupAllowanceUsd: input.warmupAllowanceUsd,
        deferredSuiteUsd: input.deferredSuiteUsd,
        nominalTotalUsd,
        attemptsEnvelopeUsd,
        unknownReserveUsd,
        admissionReserveUsd,
        stressTotalUsd,
        capUsd: input.capUsd,
        spentUsd: input.spentUsd,
        remainingUsd,
        nominalFits: nominalTotalUsd <= remainingUsd,
        stressFits: stressTotalUsd <= remainingUsd,
    };
}

/* ──────────────────────────────────────────────────────────────────
 * Sign-flip permutation test (the pre-committed fallback, now the frozen
 * primary after the paired-t procedure failed its Type-I criterion;
 * prereg §7 criteria block, results §7.1).
 * ────────────────────────────────────────────────────────────────── */

export interface SignMatrix {
    draws: number;
    n: number;
    wordsPerRow: number;
    /** Row-major bit matrix: bit i of row b is the sign of position i (+1 when set). */
    bits: Uint32Array;
}

function popcount32(x: number): number {
    let v = x - ((x >>> 1) & 0x55555555);
    v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
    v = (v + (v >>> 4)) & 0x0f0f0f0f;
    return (v * 0x01010101) >>> 24;
}

/** Deterministic seeded sign matrix for the sign-flip null (one row per draw). */
export function buildSignMatrix(draws: number, n: number, seed: number): SignMatrix {
    if (!(draws >= 1) || !(n >= 1)) throw new Error("buildSignMatrix: draws and n must be >= 1");
    const wordsPerRow = Math.ceil(n / 32);
    const bits = new Uint32Array(draws * wordsPerRow);
    const rng = mulberry32(seed);
    for (let i = 0; i < bits.length; i += 1) bits[i] = (rng() * 4_294_967_296) >>> 0;
    return { draws, n, wordsPerRow, bits };
}

/**
 * One-sided sign-flip p-value for H1: mean < 0:
 * p = P*(sum_i eps_i x_i <= observedSum) over the seeded sign matrix;
 * equality counts, so the test is conservative on a lattice. Works for
 * any real values — equal values are grouped after an in-place sort.
 */
export function signFlipOneSidedPValue(
    values: readonly number[],
    observedSum: number,
    matrix: SignMatrix,
): number {
    if (values.length !== matrix.n) {
        throw new Error(`signFlipOneSidedPValue: expected ${matrix.n} values, got ${values.length}`);
    }
    if (!Number.isFinite(observedSum)) throw new Error("signFlipOneSidedPValue: non-finite observedSum");
    const sorted = Float64Array.from(values);
    sorted.sort();
    const perDraw = new Float64Array(matrix.draws);
    const { bits, wordsPerRow, draws, n } = matrix;
    let groupStart = 0;
    for (let i = 0; i <= n; i += 1) {
        if (i < n && sorted[i] === sorted[groupStart]) continue;
        const value = sorted[groupStart]!;
        const count = i - groupStart;
        if (count > 0) {
            const wordStart = groupStart >>> 5;
            const wordEnd = (i - 1) >>> 5;
            const startShift = groupStart & 31;
            const endBit = (i - 1) & 31;
            for (let b = 0; b < draws; b += 1) {
                const base = b * wordsPerRow;
                let k = 0;
                if (wordStart === wordEnd) {
                    const mask = endBit === 31
                        ? (0xffffffff << startShift) >>> 0
                        : ((((1 << (endBit - startShift + 1)) - 1) << startShift) >>> 0);
                    k = popcount32(bits[base + wordStart]! & mask);
                } else {
                    k += popcount32(bits[base + wordStart]! >>> startShift);
                    for (let w = wordStart + 1; w < wordEnd; w += 1) k += popcount32(bits[base + w]!);
                    k += popcount32(bits[base + wordEnd]! & (endBit === 31 ? 0xffffffff : (1 << (endBit + 1)) - 1));
                }
                perDraw[b] = perDraw[b]! + value * (2 * k - count);
            }
        }
        groupStart = i;
    }
    let hits = 0;
    for (let b = 0; b < draws; b += 1) if (perDraw[b]! <= observedSum) hits += 1;
    return hits / draws;
}

/* ──────────────────────────────────────────────────────────────────
 * Monte-Carlo validation of the paired t-test and sign-flip procedures
 * (+ Holm step-down in both cases).
 * ────────────────────────────────────────────────────────────────── */

export interface SimulationOutput {
    reps: number;
    seed: number;
    n: number;
    alpha: number;
    /** Which per-test procedure was validated. */
    procedure: "paired-t" | "sign-flip";
    /** Inner draws and seed for the sign-flip procedure (null for paired-t). */
    signFlipDraws: number | null;
    signFlipSeed: number | null;
    models: string[];
    typeI: {
        perModel: Record<string, number>;
        fwer: number;
    };
    power: {
        point: { perModel: Record<string, number>; anyRejection: number };
        half: { perModel: Record<string, number>; anyRejection: number };
    };
    criteria: {
        typeIMax: number;
        fwerMax: number;
        typeIPass: boolean;
        fwerPass: boolean;
        pass: boolean;
    };
}

export interface SimulationInput {
    /** Per-model pilot per-query d vectors, model order = test order. */
    perModelD: Readonly<Record<string, readonly number[]>>;
    n: number;
    reps: number;
    seed: number;
    /** Which per-test procedure to validate. Required — no silent default. */
    procedure: "paired-t" | "sign-flip";
    /** Inner draws for the sign-flip procedure (default: CONFIRM_SIMULATION_SIGN_FLIP_DRAWS). */
    signFlipDraws?: number;
    /** Seed for the sign-flip sign matrix (default: CONFIRM_SIGN_FLIP_SEED). */
    signFlipSeed?: number;
}

/**
 * Sign-flip p-value for one power scenario: the shift is applied to the
 * resampled values themselves, so the null is built from exactly the data
 * the real analysis would receive. A zero shift returns the Type-I p of
 * the identical resample (bit-for-bit, no recompute).
 */
function signFlipScenarioPower(
    sample: readonly number[],
    typeIP: number,
    typeISum: number,
    shift: number,
    matrix: SignMatrix,
): number {
    if (shift === 0) return typeIP;
    const shifted = new Array<number>(sample.length);
    let obs = typeISum;
    for (let i = 0; i < sample.length; i += 1) {
        shifted[i] = sample[i]! + shift;
        obs += shift;
    }
    return signFlipOneSidedPValue(shifted, obs, matrix);
}

/**
 * Resample each model's pilot per-query d with replacement at size n.
 * The pilot vectors are centred to their own mean first (delta = 0 null);
 * the power scenarios add the pilot point estimate (and half of it) back
 * as an additive shift. For paired-t, adding a constant moves the sample
 * mean only, so one sample mean/sd per (rep, model) serves all three
 * scenarios. For sign-flip, the null is built by flipping the signs of
 * the data the real analysis would receive, so each scenario's shift is
 * applied to the resampled values themselves (the resamples/draws stay
 * shared across scenarios — deterministic and unbiased per scenario).
 */
export function runConfirmationSimulation(input: SimulationInput): SimulationOutput {
    if (input.reps < CONFIRM_SIMULATION_REPS_MIN) {
        throw new Error(`runConfirmationSimulation: need >= ${CONFIRM_SIMULATION_REPS_MIN} reps`);
    }
    if (input.n < 2) throw new Error("runConfirmationSimulation: n must be >= 2");
    if (input.procedure !== "paired-t" && input.procedure !== "sign-flip") {
        throw new Error('runConfirmationSimulation: procedure must be "paired-t" or "sign-flip"');
    }
    const models = Object.keys(input.perModelD);
    if (models.length !== CONFIRM_TEST_COUNT) {
        throw new Error(`runConfirmationSimulation: expected ${CONFIRM_TEST_COUNT} models, got ${models.length}`);
    }
    const centred = models.map((model) => {
        const d = input.perModelD[model]!;
        if (d.length < 2) throw new Error(`runConfirmationSimulation: ${model} has < 2 pilot queries`);
        const mean = d.reduce((s, v) => s + v, 0) / d.length;
        return { model, values: d.map((v) => v - mean), pilotMean: mean };
    });
    // Power scenarios shift the centred resample by the pilot point estimate
    // ("point") and by half of it ("half"); the offset is per model.
    const pointOffsets = centred.map((c) => c.pilotMean);
    const halfOffsets = centred.map((c) => c.pilotMean / 2);

    const rng = mulberry32(input.seed);
    const procedure = input.procedure;
    const signFlipDraws = input.signFlipDraws ?? CONFIRM_SIMULATION_SIGN_FLIP_DRAWS;
    const signFlipSeed = input.signFlipSeed ?? CONFIRM_SIGN_FLIP_SEED;
    const signMatrix = procedure === "sign-flip" ? buildSignMatrix(signFlipDraws, input.n, signFlipSeed) : null;
    const typeICounts = new Array<number>(models.length).fill(0);
    let typeIFwerCount = 0;
    const powerCounts = [
        new Array<number>(models.length).fill(0),
        new Array<number>(models.length).fill(0),
    ];
    const powerAnyCounts = [0, 0];
    const pTypeI = new Array<number>(models.length).fill(0);
    const pPower = [
        new Array<number>(models.length).fill(0),
        new Array<number>(models.length).fill(0),
    ];

    for (let rep = 0; rep < input.reps; rep += 1) {
        for (let m = 0; m < models.length; m += 1) {
            const values = centred[m]!.values;
            let sum = 0;
            let sq = 0;
            const sample = new Float64Array(input.n);
            for (let i = 0; i < input.n; i += 1) {
                const v = values[Math.floor(rng() * values.length)]!;
                sample[i] = v;
                sum += v;
                sq += v * v;
            }
            const mean = sum / input.n;
            const sd = Math.sqrt(Math.max(0, (sq - input.n * mean * mean) / (input.n - 1)));
            const se = sd / Math.sqrt(input.n);
            if (signMatrix !== null) {
                const asArray = Array.from(sample);
                pTypeI[m] = signFlipOneSidedPValue(asArray, sum, signMatrix);
                for (const [s, shiftList] of [[0, pointOffsets], [1, halfOffsets]] as const) {
                    pPower[s]![m] = signFlipScenarioPower(
                        asArray, pTypeI[m]!, sum, shiftList[m]!, signMatrix,
                    );
                }
                continue;
            }
            if (!(se > 0)) throw new Error(`runConfirmationSimulation: degenerate resample for ${models[m]}`);
            const t0 = mean / se;
            pTypeI[m] = studentTCdf(t0, input.n - 1);
            for (const [s, shiftList] of [[0, pointOffsets], [1, halfOffsets]] as const) {
                const t = (mean + shiftList[m]!) / se;
                pPower[s]![m] = studentTCdf(t, input.n - 1);
            }
        }
        for (let m = 0; m < models.length; m += 1) {
            if (pTypeI[m]! < CONFIRM_FAMILY_ALPHA) typeICounts[m]! += 1;
        }
        if (holmStepDown(pTypeI, CONFIRM_FAMILY_ALPHA).anyRejected) typeIFwerCount += 1;
        for (const s of [0, 1] as const) {
            const holm = holmStepDown(pPower[s]!, CONFIRM_FAMILY_ALPHA);
            for (let m = 0; m < models.length; m += 1) {
                if (holm.rejected[m]) powerCounts[s]![m]! += 1;
            }
            if (holm.anyRejected) powerAnyCounts[s]! += 1;
        }
    }

    const typeIPerModel: Record<string, number> = {};
    models.forEach((model, m) => {
        typeIPerModel[model] = typeICounts[m]! / input.reps;
    });
    const powerFor = (s: 0 | 1): { perModel: Record<string, number>; anyRejection: number } => {
        const perModel: Record<string, number> = {};
        models.forEach((model, m) => {
            perModel[model] = powerCounts[s]![m]! / input.reps;
        });
        return { perModel, anyRejection: powerAnyCounts[s]! / input.reps };
    };
    const typeIPass = Object.values(typeIPerModel).every((rate) => rate <= CONFIRM_TYPE_I_MAX);
    const fwer = typeIFwerCount / input.reps;
    const fwerPass = fwer <= CONFIRM_FWER_MAX;
    return {
        reps: input.reps,
        seed: input.seed,
        n: input.n,
        alpha: CONFIRM_FAMILY_ALPHA,
        procedure,
        signFlipDraws: signMatrix === null ? null : signFlipDraws,
        signFlipSeed: signMatrix === null ? null : signFlipSeed,
        models,
        typeI: { perModel: typeIPerModel, fwer },
        power: { point: powerFor(0), half: powerFor(1) },
        criteria: {
            typeIMax: CONFIRM_TYPE_I_MAX,
            fwerMax: CONFIRM_FWER_MAX,
            typeIPass,
            fwerPass,
            pass: typeIPass && fwerPass,
        },
    };
}

/* ──────────────────────────────────────────────────────────────────
 * Analysis assembly (pure over already-loaded artifacts).
 * ────────────────────────────────────────────────────────────────── */

export interface ConfirmAnalysisModelResult {
    model: string;
    challenger: ChallengerChoice;
    m0Loss: number;
    challengerLoss: number;
    /** Pilot per-query d = L_challenger − L_M0 (negative favours the challenger). */
    pilotD: { mean: number; sd: number; wins: number; ties: number; losses: number };
    pilotFnDelta: number;
    pilotFpDelta: number;
    power: {
        atPilotEffect: { analyticPerTestAtAlphaOver3: number; nFor80Pct: number };
        atHalfEffect: { analyticPerTestAtAlphaOver3: number; nFor80Pct: number };
    };
    cost: {
        m0CostPerQueryReplicaUsd: number;
        challengerCostPerQueryReplicaUsd: number;
        challengerMarginalCostPerQueryReplicaUsd: number;
        challengerMeanInputTokensPerRequest: number | null;
        m0MeanInputTokensPerRequest: number | null;
    };
}

function seriesIndex(armIndex: number, method: MethodId): number {
    return armIndex * METHOD_IDS.length + METHOD_IDS.indexOf(method);
}

function seriesOf(table: ExploratoryClusterTable, model: string, method: MethodId) {
    const armIndex = table.arms.indexOf(model as (typeof table.arms)[number]);
    if (armIndex < 0) throw new Error(`model ${model} not in cluster table arms`);
    return table.series[seriesIndex(armIndex, method)]!;
}

export interface ConfirmAnalysisInput {
    table: ExploratoryClusterTable;
    wireRows: readonly ConfirmWireRow[];
    pilotReplicaCount: number;
    confirmationQueries: number;
    confirmationReplicas: number;
}

export interface ConfirmAnalysis {
    models: ConfirmAnalysisModelResult[];
    envelope: BudgetEnvelope;
    warmupAllowance: { byModel: Record<string, number>; totalUsd: number; assumptions: string[] };
}

/** Build the challenger/power/cost tables from the bound pilot artifacts. */
export function buildConfirmAnalysis(input: ConfirmAnalysisInput): ConfirmAnalysis {
    const { table, wireRows } = input;
    const queries = table.queryIds.length;
    const cost = summarizeWireCost(wireRows);
    const assumptions: string[] = [];
    const warmupByModel: Record<string, number> = {};

    const models: ConfirmAnalysisModelResult[] = table.arms.map((model) => {
        const m0 = seriesOf(table, model, "M0");
        const losses = {
            M1: seriesOf(table, model, "M1").perQueryLoss.reduce((s, v) => s + v, 0),
            M2: seriesOf(table, model, "M2").perQueryLoss.reduce((s, v) => s + v, 0),
        };
        const rate = MODEL_INPUT_RATE_PER_M_USD[model];
        if (rate === undefined) throw new Error(`no input rate for model ${model}`);
        const tokensOf = (method: MethodId): number => cost.get(`${model}|${method}`)?.scoredInputTokens ?? 0;
        const warmupTokensOf = (method: MethodId): number => cost.get(`${model}|${method}`)?.warmupInputTokens ?? 0;
        const projectedCostPerQuery = {
            M1: costPerQueryPerReplica(tokensOf("M1"), queries, input.pilotReplicaCount, rate),
            // M2 = forward (reused M0 packed calls) + reverse packed: two packed calls.
            M2: costPerQueryPerReplica(tokensOf("M0") + tokensOf("M2"), queries, input.pilotReplicaCount, rate),
        };
        const challenger = selectChallenger(model, losses, projectedCostPerQuery);
        const challengerSeries = seriesOf(table, model, challenger.chosen);
        const d = table.queryIds.map((_, i) => challengerSeries.perQueryLoss[i]! - m0.perQueryLoss[i]!);
        const t = pairedTTestOneSided(d);
        const halfEffect = t.mean / 2;

        // Marginal challenger cost for the campaign: the M2 forward leg is M0's
        // packed call (already paid for in the M0 arm), so only the reverse leg
        // is marginal; M1's singletons are entirely additional.
        const challengerMarginalTokens = challenger.chosen === "M1" ? tokensOf("M1") : tokensOf("M2");
        const challengerCostPerQueryReplica = challenger.chosen === "M1"
            ? costPerQueryPerReplica(tokensOf("M1"), queries, input.pilotReplicaCount, rate)
            : costPerQueryPerReplica(tokensOf("M0") + tokensOf("M2"), queries, input.pilotReplicaCount, rate);
        const challengerMarginal = costPerQueryPerReplica(
            challengerMarginalTokens, queries, input.pilotReplicaCount, rate,
        );

        // Warmup allowance at the frozen confirmation replica count.
        const warmupPerPilotReplica = usdForInputTokens(
            warmupTokensOf("M0") / input.pilotReplicaCount, rate,
        );
        warmupByModel[model] = warmupPerPilotReplica * input.confirmationReplicas;
        if (challenger.chosen === "M2") {
            const reverseTokens = tokensOf("M2") / (queries * input.pilotReplicaCount);
            warmupByModel[model] = (warmupByModel[model] ?? 0)
                + usdForInputTokens(reverseTokens, rate) * input.confirmationReplicas;
            assumptions.push(`${model}: one reverse-packed warmup per replica assumed (the pilot warmed only M0).`);
        }

        return {
            model,
            challenger,
            m0Loss: m0.perQueryLoss.reduce((s, v) => s + v, 0),
            challengerLoss: challengerSeries.perQueryLoss.reduce((s, v) => s + v, 0),
            pilotD: {
                mean: t.mean,
                sd: t.sd,
                wins: d.filter((v) => v < 0).length,
                ties: d.filter((v) => v === 0).length,
                losses: d.filter((v) => v > 0).length,
            },
            pilotFnDelta: challengerSeries.perQueryFn.reduce((s, v) => s + v, 0)
                - m0.perQueryFn.reduce((s, v) => s + v, 0),
            pilotFpDelta: challengerSeries.perQueryFp.reduce((s, v) => s + v, 0)
                - m0.perQueryFp.reduce((s, v) => s + v, 0),
            power: {
                atPilotEffect: {
                    analyticPerTestAtAlphaOver3: analyticOneSidedPower(
                        t.mean, t.sd, input.confirmationQueries, CONFIRM_PLANNING_Z_ALPHA_ONE_SIDED,
                    ),
                    nFor80Pct: queriesForEightyPercentPower(
                        t.mean, t.sd, CONFIRM_PLANNING_Z_ALPHA_ONE_SIDED,
                    ),
                },
                atHalfEffect: {
                    analyticPerTestAtAlphaOver3: analyticOneSidedPower(
                        halfEffect, t.sd, input.confirmationQueries, CONFIRM_PLANNING_Z_ALPHA_ONE_SIDED,
                    ),
                    nFor80Pct: queriesForEightyPercentPower(
                        halfEffect, t.sd, CONFIRM_PLANNING_Z_ALPHA_ONE_SIDED,
                    ),
                },
            },
            cost: {
                m0CostPerQueryReplicaUsd: costPerQueryPerReplica(
                    tokensOf("M0"), queries, input.pilotReplicaCount, rate,
                ),
                challengerCostPerQueryReplicaUsd: challengerCostPerQueryReplica,
                challengerMarginalCostPerQueryReplicaUsd: challengerMarginal,
                challengerMeanInputTokensPerRequest: challenger.chosen === "M1"
                    ? (cost.get(`${model}|M1`)?.meanInputTokens ?? null)
                    : (cost.get(`${model}|M2`)?.meanInputTokens ?? null),
                m0MeanInputTokensPerRequest: cost.get(`${model}|M0`)?.meanInputTokens ?? null,
            },
        };
    });

    const warmupTotal = Object.values(warmupByModel).reduce((s, v) => s + v, 0);
    assumptions.push(
        "Warmup allowance = pilot-observed M0 warmups scaled to the confirmation replica count"
        + " (+ one reverse-packed warmup per replica for an M2 challenger; M1 warmed nothing in the pilot).",
    );
    const m0Cost: Record<string, number> = {};
    const challengerCost: Record<string, number> = {};
    for (const m of models) {
        m0Cost[m.model] = m.cost.m0CostPerQueryReplicaUsd;
        challengerCost[m.model] = m.cost.challengerMarginalCostPerQueryReplicaUsd;
    }
    const envelope = buildBudgetEnvelope({
        queries: input.confirmationQueries,
        replicas: input.confirmationReplicas,
        m0CostPerQueryReplicaByModel: m0Cost,
        challengerMarginalCostPerQueryReplicaByModel: challengerCost,
        warmupAllowanceUsd: warmupTotal,
        deferredSuiteUsd: DEFERRED_44_QUERY_M0_SUITE_USD,
        modelNames: [...table.arms],
        capUsd: CONFIRM_CAMPAIGN_CAP_USD,
        spentUsd: CONFIRM_CAMPAIGN_SPENT_USD,
    });
    return { models, envelope, warmupAllowance: { byModel: warmupByModel, totalUsd: warmupTotal, assumptions } };
}

/* ──────────────────────────────────────────────────────────────────
 * CLI.
 * ────────────────────────────────────────────────────────────────── */

export interface MethodConfirmAnalysisArgs {
    pilotRoot: string;
    records: string;
    plan: string;
    verdict: string;
    help: boolean;
    simulation: boolean;
    procedure: "paired-t" | "sign-flip";
    reps: number;
    seed: number;
    confirmationQueries: number;
    confirmationReplicas: number;
}

function takeValue(flag: string, argv: readonly string[], index: number): string {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    return value;
}

function takeInt(flag: string, argv: readonly string[], index: number): number {
    const raw = takeValue(flag, argv, index);
    const n = Number(raw);
    if (!Number.isInteger(n)) throw new Error(`${flag} requires an integer, got ${raw}`);
    return n;
}

export function parseMethodConfirmAnalysisArgs(argv: readonly string[]): MethodConfirmAnalysisArgs {
    const args: MethodConfirmAnalysisArgs = {
        pilotRoot: defaultPilotRoot(),
        records: "",
        plan: "",
        verdict: "",
        help: false,
        simulation: false,
        procedure: "sign-flip", // frozen primary after the paired-t failure (prereg §7.1)
        reps: CONFIRM_SIMULATION_REPS_MIN,
        seed: CONFIRM_SIMULATION_SEED,
        confirmationQueries: CONFIRM_QUERY_COUNT,
        confirmationReplicas: CONFIRM_REPLICA_COUNT,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const flag = argv[i]!;
        switch (flag) {
            case "--help": case "-h": args.help = true; break;
            case "--simulation": args.simulation = true; break;
            case "--procedure": {
                const value = takeValue(flag, argv, i);
                i += 1;
                if (value !== "paired-t" && value !== "sign-flip") {
                    throw new Error(`--procedure must be paired-t or sign-flip, got ${value}`);
                }
                args.procedure = value;
                break;
            }
            case "--pilot-root": args.pilotRoot = takeValue(flag, argv, i); i += 1; break;
            case "--records": args.records = takeValue(flag, argv, i); i += 1; break;
            case "--plan": args.plan = takeValue(flag, argv, i); i += 1; break;
            case "--verdict": args.verdict = takeValue(flag, argv, i); i += 1; break;
            case "--reps": args.reps = takeInt(flag, argv, i); i += 1; break;
            case "--seed": args.seed = takeInt(flag, argv, i); i += 1; break;
            case "--confirmation-queries": args.confirmationQueries = takeInt(flag, argv, i); i += 1; break;
            case "--confirmation-replicas": args.confirmationReplicas = takeInt(flag, argv, i); i += 1; break;
            default: throw new Error(`unknown flag ${flag}`);
        }
    }
    return args;
}

function printUsage(): void {
    process.stdout.write(
        "usage: method-confirm-analysis --records <wire.jsonl> --plan <plan.json> --verdict <verdict.json>\n"
        + "       [--pilot-root <dir>] [--simulation] [--procedure sign-flip|paired-t] (default: sign-flip)\n"
        + "       [--reps 20000] [--seed 20261009]\n"
        + "       [--confirmation-queries 400] [--confirmation-replicas 3] [--help]\n",
    );
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function readJsonlRowsRaw(path: string): unknown[] {
    return readFileSync(path, "utf-8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as unknown);
}

function toWireRows(rawRows: readonly unknown[]): ConfirmWireRow[] {
    return rawRows.map((raw, index) => {
        if (typeof raw !== "object" || raw === null) throw new Error(`wire row ${index} is not an object`);
        const row = raw as Record<string, unknown>;
        const { wireId, arm, method, warmup, inputTokens } = row;
        if (typeof wireId !== "string" || typeof arm !== "string") {
            throw new Error(`wire row ${index}: missing wireId/arm`);
        }
        if (method !== "M0" && method !== "M1" && method !== "M2") {
            throw new Error(`wire row ${index}: bad method ${String(method)}`);
        }
        if (typeof warmup !== "boolean") throw new Error(`wire row ${index}: bad warmup flag`);
        if (inputTokens !== null && typeof inputTokens !== "number") {
            throw new Error(`wire row ${index}: bad inputTokens`);
        }
        return { wireId, arm, method, warmup, inputTokens: inputTokens as number | null };
    });
}

export interface MethodConfirmAnalysisRunOptions {
    /** Test seam: replace Stage B's loader (production: `loadVerifiedPilotCorpus`). */
    loadRoster?: (root: string) => PilotCorpusRoster;
}

/** CLI core: returns the process exit code; never calls `process.exit` itself. */
export function runMethodConfirmAnalysis(
    argv: readonly string[],
    options: MethodConfirmAnalysisRunOptions = {},
): Promise<number> {
    let args: MethodConfirmAnalysisArgs;
    try {
        args = parseMethodConfirmAnalysisArgs(argv);
    } catch (error) {
        console.error(`error: ${messageOf(error)}`);
        return Promise.resolve(METHOD_CONFIRM_ANALYSIS_EXIT_USAGE);
    }
    if (args.help) {
        printUsage();
        return Promise.resolve(METHOD_CONFIRM_ANALYSIS_EXIT_OK);
    }

    let roster: PilotCorpusRoster;
    let plan: MethodPilotPlanArtifact;
    try {
        roster = (options.loadRoster ?? loadVerifiedPilotCorpus)(args.pilotRoot);
        if (!isVerifiedPilotCorpusRoster(roster)) {
            throw new Error("method-confirm-analysis: roster is not a load-verified sealed corpus roster");
        }
        let parsedPlan: unknown;
        try {
            parsedPlan = JSON.parse(readFileSync(args.plan, "utf-8"));
        } catch (error) {
            throw new Error(`plan artifact ${args.plan} is not valid JSON: ${messageOf(error)}`);
        }
        if (!isMethodPilotPlanArtifact(parsedPlan)) {
            throw new Error(`plan artifact ${args.plan} is not a method-pilot-request-plan artifact`);
        }
        plan = parsedPlan;
        const mismatch = verifyPlanForRoster(plan, roster);
        if (mismatch !== null) throw new Error(mismatch);
    } catch (error) {
        console.error(`error: pilot/plan gate refused: ${messageOf(error)}; no analysis produced`);
        return Promise.resolve(METHOD_CONFIRM_ANALYSIS_EXIT_GATE);
    }

    try {
        const recordRows = readJsonlRowsRaw(args.records);
        const derivation = deriveMethodPilotSelectorInput(roster, plan, recordRows);
        const table = buildExploratoryClusterTable(roster, derivation.input.rows);

        // Identity proof: the loss table must reproduce the sealed verdict byte-for-value.
        const verdict = JSON.parse(readFileSync(args.verdict, "utf-8")) as { perModelPerMethod?: unknown };
        if (!Array.isArray(verdict.perModelPerMethod)) throw new Error("verdict has no perModelPerMethod array");
        assertReproducedVerdictTable(buildPerModelPerMethodTable(table), verdict.perModelPerMethod);

        const analysis = buildConfirmAnalysis({
            table,
            wireRows: toWireRows(recordRows),
            pilotReplicaCount: plan.replicaCount,
            confirmationQueries: args.confirmationQueries,
            confirmationReplicas: args.confirmationReplicas,
        });

        const perModelD: Record<string, number[]> = {};
        for (const m of analysis.models) {
            const challenger = seriesOf(table, m.model, m.challenger.chosen);
            const m0 = seriesOf(table, m.model, "M0");
            perModelD[m.model] = table.queryIds.map(
                (_, i) => challenger.perQueryLoss[i]! - m0.perQueryLoss[i]!,
            );
        }

        const payload: Record<string, unknown> = {
            kind: "method-confirm-analysis",
            estimand: "d = L(challenger) - L(M0); L = 6*FN + FP at tau 0.40 on replica-averaged probabilities",
            test: "one-sided paired query-level test of mean d, H0: delta >= 0 vs H1: delta < 0, Holm step-down across 3 models at FWER 0.05; frozen primary procedure: sign-flip permutation (paired-t failed its frozen §7 simulation criterion; §7.1)",
            pilotQueries: table.queryIds.length,
            pilotReplicaCount: plan.replicaCount,
            verdictTableReproduced: true,
            analysis,
            prices: {
                inputUsdPerMTokens: MODEL_INPUT_RATE_PER_M_USD,
                outputUsdPerMTokens: CONFIRM_OUTPUT_RATE_PER_M_USD,
                source: "evidence ledger project-external P5 (verified 2026-10-09)",
            },
        };
        if (args.simulation) {
            payload.simulation = runConfirmationSimulation({
                perModelD,
                n: args.confirmationQueries,
                reps: args.reps,
                seed: args.seed,
                procedure: args.procedure,
            });
        }
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        console.warn(
            `method-confirm-analysis: ${analysis.models.length} models, `
            + `pilot Q=${table.queryIds.length}; `
            + `${args.simulation ? "simulation included" : "simulation omitted (pass --simulation)"}`,
        );
        return Promise.resolve(METHOD_CONFIRM_ANALYSIS_EXIT_OK);
    } catch (error) {
        console.error(`error: ${messageOf(error)}; no analysis produced`);
        return Promise.resolve(METHOD_CONFIRM_ANALYSIS_EXIT_USAGE);
    }
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : "";
if (invoked === fileURLToPath(import.meta.url)) {
    runMethodConfirmAnalysis(process.argv.slice(2)).then((code) => {
        process.exitCode = code;
    });
}
