/**
 * Retrieval holdout v2 — pure analysis + deterministic simulation validation.
 *
 * Companion to docs/plans/2026-10-09-retrieval-holdout-v2-prereg.md. Lives
 * OUTSIDE src/** and scripts/eval/** on purpose: scripts/eval/judge/
 * grep-e2e-contract.ts (isWantedSourceFile) hashes src/** and
 * scripts/eval/**.ts into the frozen V2 engine hash, so nothing here may
 * enter that set.
 *
 * Pure: no filesystem, no network, no holdout reads. Inputs are outcome
 * records handed in by the caller (report parsing happens elsewhere).
 * The Monte Carlo is seeded and fully deterministic for a given seed.
 *
 * Calibration (screening external dev64 only, shas verified in the prereg):
 *   A0  external-grep-dev-2026-10-08T19-19-30-779Z-80820a88.json
 *       sha256 7462a1441ac2d5a9fc5ec974ea8ca98bcaa3e09d7b9c0acdd2200e2ff6eddb6a
 *   A5  external-grep-dev-2026-10-08T21-38-32-544Z-1b8d3e70.json
 *       sha256 d62becce7ab5409ff0fca5d6641c6fecb9412cd10f923367c1848cfc3ce00bb5
 */

import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// Estimand (owner G-2L weighted success@5)
// ---------------------------------------------------------------------------

/** u = d for d >= 0, else 2d  (win +1, loss -2, tie 0). */
export function utilityFromDelta(delta: number): number {
    return delta >= 0 ? delta : 2 * delta;
}

function meanOf(values: readonly number[]): number {
    if (values.length === 0) throw new Error("mean of empty input");
    let sum = 0;
    for (const v of values) sum += v;
    return sum / values.length;
}

// ---------------------------------------------------------------------------
// Analysis on paired outcome records
// ---------------------------------------------------------------------------

export interface OutcomeRecord {
    readonly instanceId: string;
    readonly formulation: string;
    readonly successAt5: boolean;
}

export interface InstanceUtility {
    readonly instanceId: string;
    readonly u: number;
    readonly formulations: readonly string[];
}

export interface FormulationDelta {
    readonly instanceId: string;
    readonly formulation: string;
    /** success@5(A5) - success@5(A0), in {-1, 0, 1}. */
    readonly d: number;
}

export interface BuildResult {
    readonly instances: readonly InstanceUtility[];
    readonly deltas: readonly FormulationDelta[];
    /** Pre-run-invalid instances removed before any result was seen. */
    readonly excluded: readonly string[];
    /** Formulation present in only one arm — protocol deviation, disclosed. */
    readonly unmatched: readonly string[];
    /** Distinct instance ids with at least one unmatched formulation. */
    readonly unmatchedInstanceIds: readonly string[];
}

function pairKey(instanceId: string, formulation: string): string {
    return `${instanceId}\u0000${formulation}`;
}

interface InstanceMatch {
    readonly u: number;
    readonly formulations: readonly string[];
    readonly deltas: readonly FormulationDelta[];
    readonly unmatched: readonly string[];
}

/** Pair one instance across both arms; a formulation seen in one arm only
 * is disclosed as unmatched and contributes nothing. */
function matchInstance(
    id: string,
    formulations: ReadonlySet<string>,
    map5: ReadonlyMap<string, boolean>,
    map0: ReadonlyMap<string, boolean>,
): InstanceMatch {
    const us: number[] = [];
    const present: string[] = [];
    const deltas: FormulationDelta[] = [];
    const unmatched: string[] = [];
    for (const f of [...formulations].sort()) {
        const k = pairKey(id, f);
        const has5 = map5.has(k);
        const has0 = map0.has(k);
        if (has5 && has0) {
            const d = (map5.get(k) ? 1 : 0) - (map0.get(k) ? 1 : 0);
            us.push(utilityFromDelta(d));
            present.push(f);
            deltas.push({ instanceId: id, formulation: f, d });
        } else if (has5 || has0) {
            unmatched.push(`${id} ${f}`);
        }
    }
    return {
        u: us.length === 0 ? Number.NaN : meanOf(us),
        formulations: present,
        deltas,
        unmatched,
    };
}

/**
 * Pair A5 against A0 per instance x formulation. Excluded (pre-run invalid)
 * ids drop out before pairing; an instance survives on any single matched
 * formulation and is only excluded when neither formulation matches.
 */
export function buildInstanceUtilities(
    a5: readonly OutcomeRecord[],
    a0: readonly OutcomeRecord[],
    excludedIds: Iterable<string> = [],
): BuildResult {
    const preExcluded = new Set(excludedIds);
    const map5 = new Map<string, boolean>();
    const map0 = new Map<string, boolean>();
    const ids = new Set<string>();
    const formulationsById = new Map<string, Set<string>>();
    const addRecords = (recs: readonly OutcomeRecord[], map: Map<string, boolean>): void => {
        for (const r of recs) {
            map.set(pairKey(r.instanceId, r.formulation), r.successAt5);
            ids.add(r.instanceId);
            formulationsById.set(
                r.instanceId,
                (formulationsById.get(r.instanceId) ?? new Set<string>()).add(r.formulation),
            );
        }
    };
    addRecords(a5, map5);
    addRecords(a0, map0);

    const instances: InstanceUtility[] = [];
    const deltas: FormulationDelta[] = [];
    const excluded: string[] = [];
    const unmatched: string[] = [];
    const unmatchedIds = new Set<string>();

    for (const id of [...ids].sort()) {
        if (preExcluded.has(id)) {
            excluded.push(id);
            continue;
        }
        const match = matchInstance(id, formulationsById.get(id) ?? new Set<string>(), map5, map0);
        unmatched.push(...match.unmatched);
        if (match.unmatched.length > 0) unmatchedIds.add(id);
        if (Number.isNaN(match.u)) {
            excluded.push(id);
            continue;
        }
        instances.push({ instanceId: id, u: match.u, formulations: match.formulations });
        deltas.push(...match.deltas);
    }
    return { instances, deltas, excluded, unmatched, unmatchedInstanceIds: [...unmatchedIds].sort() };
}

// ---------------------------------------------------------------------------
// One-sided paired t-test (prereg §3)
// ---------------------------------------------------------------------------

export interface PairedTResult {
    readonly n: number;
    readonly mean: number;
    readonly sd: number;
    readonly se: number;
    readonly t: number;
    readonly df: number;
    readonly pOneSided: number;
    readonly lowerBound95: number;
    readonly ci95Low: number;
    readonly ci95High: number;
    readonly rejectAt05: boolean;
}

/**
 * One-sided paired t-test of H0: mu <= 0 vs H1: mu > 0 at alpha = .05 on
 * instance utilities, plus the one-sided 95% lower bound and the two-sided
 * 95% t interval reported by the prereg.
 */
export function pairedTTest(values: readonly number[], alpha = 0.05): PairedTResult {
    const n = values.length;
    if (n < 2) throw new Error("pairedTTest needs n >= 2");
    const mean = meanOf(values);
    let ss = 0;
    for (const v of values) ss += (v - mean) ** 2;
    const sd = Math.sqrt(ss / (n - 1));
    const df = n - 1;
    const tCritOne = studentTQuantile(1 - alpha, df);
    const tCritTwo = studentTQuantile(1 - alpha / 2, df);
    if (sd === 0) {
        const t = mean > 0 ? Number.POSITIVE_INFINITY : mean < 0 ? Number.NEGATIVE_INFINITY : Number.NaN;
        return {
            n, mean, sd, se: 0, t, df,
            pOneSided: mean > 0 ? 0 : 1,
            lowerBound95: mean, ci95Low: mean, ci95High: mean,
            rejectAt05: mean > 0,
        };
    }
    const se = sd / Math.sqrt(n);
    const t = mean / se;
    return {
        n, mean, sd, se, t, df,
        pOneSided: 1 - studentTCdf(t, df),
        lowerBound95: mean - tCritOne * se,
        ci95Low: mean - tCritTwo * se,
        ci95High: mean + tCritTwo * se,
        rejectAt05: t > tCritOne,
    };
}

// ---------------------------------------------------------------------------
// Reporting summaries (prereg §4.1 / reporting list)
// ---------------------------------------------------------------------------

export interface FormulationSummary {
    readonly formulation: string;
    readonly n: number;
    readonly wins: number;
    readonly losses: number;
    readonly ties: number;
    readonly meanD: number;
}

export interface RepoSummary {
    readonly repo: string;
    readonly n: number;
    readonly meanU: number;
    readonly wins: number;
    readonly losses: number;
    readonly ties: number;
    /** Mean title-formulation d in this repo (E16 gate: >= 0 in >= 2 repos). */
    readonly meanTitleD: number | null;
    /** Per-formulation (title/body) n, W/L/T, meanD within this repo. */
    readonly byFormulation: readonly FormulationSummary[];
}

/** CR1 cluster-robust SE for the instance-weighted mean mu (prereg §4.1).
 * Sensitivity only — never the primary test. */
export interface ClusterRobustResult {
    readonly clusters: number;
    readonly n: number;
    readonly mean: number;
    readonly seCr1: number;
    readonly t: number;
    /** G - 1. Few clusters (G = 5 at census composition): SE downward-biased. */
    readonly df: number;
    readonly lowerBound95: number;
}

/** Prereg §4.1 leave-one-repo-out: paired t recomputed omitting one repo. */
export interface LeaveOneRepoOutResult {
    readonly omittedRepo: string;
    /** Null only when omitting the repo leaves fewer than 2 instances. */
    readonly test: PairedTResult | null;
}

/** One imputed attrition scenario (prereg §2.3): primary values plus
 * `imputedCount` instance utilities set to `imputedUtility`. */
export interface AttritionSensitivity {
    readonly imputedUtility: number;
    readonly imputedCount: number;
    readonly n: number;
    readonly test: PairedTResult;
}

/** Prereg §2.3 post-run attrition worst-case sensitivity. Reporting only —
 * never gating. `instanceIds` is a conservative superset: every distinct id
 * in build.excluded ∪ build.unmatched, plus every expected id absent from
 * either arm report (post-run attrition invisible to the outcome records). */
export interface AttritionReport {
    readonly instanceIds: readonly string[];
    /** Every attrited instance scored as an A5 loss (u = −2). */
    readonly atWorstMinus2: AttritionSensitivity;
    /** Same id set imputed at u = 0. */
    readonly atZero: AttritionSensitivity;
}

export interface AnalysisResult {
    readonly build: BuildResult;
    readonly test: PairedTResult;
    readonly perFormulation: readonly FormulationSummary[];
    readonly perRepo: readonly RepoSummary[] | null;
    /** Prereg §2.3 attrition sensitivity (u = −2 and u = 0), reporting only. */
    readonly attrition: AttritionReport;
    /** Prereg §4.1 CR1 cluster-robust SE; null without a repo map or with
     * fewer than 2 clusters. */
    readonly clusterRobust: ClusterRobustResult | null;
    /** Prereg §4.1 leave-one-repo-out; empty without a repo map. */
    readonly leaveOneRepoOut: readonly LeaveOneRepoOutResult[];
}

function summarizeDeltas(
    formulation: string,
    deltas: readonly FormulationDelta[],
): FormulationSummary {
    let wins = 0, losses = 0, ties = 0, sum = 0;
    for (const x of deltas) {
        if (x.d > 0) wins++;
        else if (x.d < 0) losses++;
        else ties++;
        sum += x.d;
    }
    const n = wins + losses + ties;
    return { formulation, n, wins, losses, ties, meanD: n === 0 ? 0 : sum / n };
}

/** CR1 sandwich SE for the intercept-only mean:
 * var = G/(G−1) · (1/n²) · Σ_g (Σ_i (u_gi − mu_hat))² — the (n−1)/(n−K)
 * factor is 1 for K = 1 regressor; df = G − 1. Null for < 2 clusters. */
export function clusterRobustMean(
    clusters: ReadonlyArray<readonly number[]>,
): ClusterRobustResult | null {
    const g = clusters.length;
    if (g < 2) return null;
    const all: number[] = [];
    for (const c of clusters) all.push(...c);
    const n = all.length;
    if (n < 2) return null;
    const mean = meanOf(all);
    let meat = 0;
    for (const c of clusters) {
        let s = 0;
        for (const v of c) s += v - mean;
        meat += s * s;
    }
    const seCr1 = Math.sqrt(((g / (g - 1)) * meat) / (n * n));
    const df = g - 1;
    if (seCr1 === 0) {
        const t = mean > 0
            ? Number.POSITIVE_INFINITY
            : mean < 0
              ? Number.NEGATIVE_INFINITY
              : Number.NaN;
        return { clusters: g, n, mean, seCr1, t, df, lowerBound95: mean };
    }
    return {
        clusters: g,
        n,
        mean,
        seCr1,
        t: mean / seCr1,
        df,
        lowerBound95: mean - studentTQuantile(0.95, df) * seCr1,
    };
}

/** Prereg §4.1 leave-one-repo-out: paired t recomputed with one repository
 * omitted at a time; every estimate reported. */
export function leaveOneRepoOut(
    instances: readonly InstanceUtility[],
    repoOf: (instanceId: string) => string,
): LeaveOneRepoOutResult[] {
    const repos = [...new Set(instances.map((i) => repoOf(i.instanceId)))]
        .sort((a, b) => a.localeCompare(b));
    if (repos.length < 2) return [];
    return repos.map((omittedRepo) => {
        const subset = instances
            .filter((i) => repoOf(i.instanceId) !== omittedRepo)
            .map((i) => i.u);
        return { omittedRepo, test: subset.length >= 2 ? pairedTTest(subset) : null };
    });
}

/** Prereg §2.3: append `count` imputed instance utilities to the primary
 * value vector and re-test. */
export function attritionSensitivity(
    baseValues: readonly number[],
    count: number,
    imputedUtility: number,
): AttritionSensitivity {
    const extended = count === 0
        ? [...baseValues]
        : [...baseValues, ...Array<number>(count).fill(imputedUtility)];
    return {
        imputedUtility,
        imputedCount: count,
        n: extended.length,
        test: pairedTTest(extended),
    };
}

/** Full analysis entry point: pair, test, per-formulation and per-repo tables
 * (pooled + per formulation), the §2.3 attrition sensitivity, and the §4.1
 * repo-clustered sensitivities (CR1 + leave-one-repo-out with a repo map).
 *
 * `expectedInstanceIds` (the frozen holdout manifest's id list, passed in by
 * the run protocol) is REQUIRED: outcome ids outside it are rejected, and an
 * expected id absent from either arm report — or with no matched formulation
 * — is treated as attrited and imputed in the §2.3 u = −2 / u = 0
 * sensitivities (reviewer P1: outcome records alone cannot see an instance
 * missing from both reports). */
export function analyzeReports(
    a5: readonly OutcomeRecord[],
    a0: readonly OutcomeRecord[],
    opts: {
        expectedInstanceIds: Iterable<string>;
        excludedInstanceIds?: Iterable<string>;
        repoOf?: (instanceId: string) => string;
    },
): AnalysisResult {
    const expected = new Set(opts.expectedInstanceIds);
    if (expected.size === 0) {
        throw new Error("analyzeReports requires the frozen expected instance id list");
    }
    const inA5 = new Set<string>();
    const inA0 = new Set<string>();
    const collect = (recs: readonly OutcomeRecord[], seen: Set<string>): void => {
        for (const r of recs) {
            if (!expected.has(r.instanceId)) {
                throw new Error(`outcome instance id not in expected list: ${r.instanceId}`);
            }
            seen.add(r.instanceId);
        }
    };
    collect(a5, inA5);
    collect(a0, inA0);
    const build = buildInstanceUtilities(a5, a0, opts.excludedInstanceIds ?? []);
    const baseValues = build.instances.map((i) => i.u);
    const test = pairedTTest(baseValues);
    const formulations = [...new Set(build.deltas.map((x) => x.formulation))].sort();
    const perFormulation = formulations.map((f) =>
        summarizeDeltas(f, build.deltas.filter((x) => x.formulation === f)));
    let perRepo: RepoSummary[] | null = null;
    let clusterRobust: ClusterRobustResult | null = null;
    let leaveOneRepoOutResults: LeaveOneRepoOutResult[] = [];
    if (opts.repoOf) {
        const repoOf = opts.repoOf;
        const byRepo = new Map<string, { us: number[]; deltas: FormulationDelta[] }>();
        for (const inst of build.instances) {
            const r = repoOf(inst.instanceId);
            const slot = byRepo.get(r) ?? { us: [], deltas: [] };
            slot.us.push(inst.u);
            byRepo.set(r, slot);
        }
        for (const d of build.deltas) {
            const slot = byRepo.get(repoOf(d.instanceId));
            if (slot) slot.deltas.push(d);
        }
        const sorted = [...byRepo.entries()]
            .sort(([a], [b]) => a.localeCompare(b));
        perRepo = sorted.map(([repo, slot]) => {
            const title = summarizeDeltas(
                "title",
                slot.deltas.filter((x) => x.formulation === "title"),
            );
            const overall = summarizeDeltas("all", slot.deltas);
            const byFormulation = [...new Set(slot.deltas.map((x) => x.formulation))]
                .sort((a, b) => a.localeCompare(b))
                .map((f) => summarizeDeltas(
                    f,
                    slot.deltas.filter((x) => x.formulation === f),
                ));
            return {
                repo,
                n: slot.us.length,
                meanU: meanOf(slot.us),
                wins: overall.wins,
                losses: overall.losses,
                ties: overall.ties,
                meanTitleD: title.n === 0 ? null : title.meanD,
                byFormulation,
            };
        });
        clusterRobust = clusterRobustMean(sorted.map(([, slot]) => slot.us));
        leaveOneRepoOutResults = leaveOneRepoOut(build.instances, repoOf);
    }
    // Expected ids absent from either arm report are post-run attrition the
    // outcome records cannot reveal; union them with the disclosed exclusions
    // and unmatched formulations so the §2.3 sensitivity sees every attrited
    // instance (prereg §2 exclusion rule 3, §9.1).
    const missingFromEitherArm = [...expected]
        .filter((id) => !inA5.has(id) || !inA0.has(id));
    const attritionIds = [...new Set([
        ...build.excluded,
        ...build.unmatchedInstanceIds,
        ...missingFromEitherArm,
    ])].sort((a, b) => a.localeCompare(b));
    const attrition: AttritionReport = {
        instanceIds: attritionIds,
        atWorstMinus2: attritionSensitivity(baseValues, attritionIds.length, -2),
        atZero: attritionSensitivity(baseValues, attritionIds.length, 0),
    };
    return {
        build,
        test,
        perFormulation,
        perRepo,
        attrition,
        clusterRobust,
        leaveOneRepoOut: leaveOneRepoOutResults,
    };
}

// ---------------------------------------------------------------------------
// Deterministic PRNG + normal/probit
// ---------------------------------------------------------------------------

/** mulberry32: small deterministic PRNG, output in [0, 1). */
export function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Box-Muller standard normal generator bound to a uniform generator. */
export function makeRandn(rng: () => number): () => number {
    let spare: number | null = null;
    return () => {
        if (spare !== null) {
            const s = spare;
            spare = null;
            return s;
        }
        const u1 = 1 - rng(); // (0, 1] so ln is finite
        const u2 = rng();
        const r = Math.sqrt(-2 * Math.log(u1));
        const theta = 2 * Math.PI * u2;
        spare = r * Math.sin(theta);
        return r * Math.cos(theta);
    };
}

/** Inverse standard-normal CDF (Acklam's rational approximation, ~1e-9). */
export function probit(p: number): number {
    if (p <= 0) return Number.NEGATIVE_INFINITY;
    if (p >= 1) return Number.POSITIVE_INFINITY;
    const a = [
        -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
        1.383577518672690e2, -3.066479806614716e1, 2.506628277459239e0,
    ];
    const b = [
        -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
        6.680131188771972e1, -1.328068155288572e1,
    ];
    const c = [
        -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838e0,
        -2.549732539343734e0, 4.374664141464968e0, 2.938163982698783e0,
    ];
    const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996e0, 3.754408661907416e0];
    const pLow = 0.02425;
    const pHigh = 1 - pLow;
    if (p < pLow) {
        const q = Math.sqrt(-2 * Math.log(p));
        return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!)
            / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
    }
    if (p <= pHigh) {
        const q = p - 0.5;
        const r = q * q;
        return (((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q
            / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
    }
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!)
        / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
}

// ---------------------------------------------------------------------------
// Student-t distribution
// ---------------------------------------------------------------------------

function lgammaFn(x: number): number {
    const g = [
        676.5203681218851, -1259.1392167224028, 771.32342877765313,
        -176.61502916214059, 12.507343278686905, -0.13857109526572012,
        9.9843695780195716e-6, 1.5056327351493116e-7,
    ];
    if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgammaFn(1 - x);
    x -= 1;
    let acc = 0.99999999999980993;
    for (let i = 0; i < g.length; i++) acc += g[i]! / (x + i + 1);
    const t = x + g.length - 0.5;
    return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(acc);
}

function betaContinuedFraction(a: number, b: number, x: number): number {
    const MAX_ITER = 200;
    const EPS = 3e-14;
    const FPMIN = 1e-300;
    const qab = a + b;
    const qap = a + 1;
    const qam = a - 1;
    let c = 1;
    let d = 1 - (qab * x) / qap;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    d = 1 / d;
    let h = d;
    for (let m = 1; m <= MAX_ITER; m++) {
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
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    const logFront = lgammaFn(a + b) - lgammaFn(a) - lgammaFn(b)
        + a * Math.log(x) + b * Math.log(1 - x);
    if (x < (a + 1) / (a + b + 2)) {
        return (Math.exp(logFront) * betaContinuedFraction(a, b, x)) / a;
    }
    const logSwap = lgammaFn(a + b) - lgammaFn(a) - lgammaFn(b)
        + b * Math.log(1 - x) + a * Math.log(x);
    return 1 - (Math.exp(logSwap) * betaContinuedFraction(b, a, 1 - x)) / b;
}

/** CDF of Student's t with df degrees of freedom. */
export function studentTCdf(t: number, df: number): number {
    if (!Number.isFinite(t)) return t > 0 ? 1 : 0;
    const x = df / (df + t * t);
    const half = 0.5 * regularizedIncompleteBeta(df / 2, 0.5, x);
    return t >= 0 ? 1 - half : half;
}

/** Quantile of Student's t: studentTQuantile(p, df) for p in (0, 1). */
export function studentTQuantile(p: number, df: number): number {
    if (p <= 0 || p >= 1) throw new Error("quantile p must be in (0,1)");
    let lo = -50;
    let hi = 50;
    for (let i = 0; i < 200; i++) {
        const mid = (lo + hi) / 2;
        if (studentTCdf(mid, df) < p) lo = mid;
        else hi = mid;
    }
    return (lo + hi) / 2;
}

// ---------------------------------------------------------------------------
// Simulation: marginals, repo composition, dependence calibration
// ---------------------------------------------------------------------------

export interface FormulationMarginals {
    readonly pWin: number;
    readonly pLoss: number;
}

/** Screening dev64 A5-vs-A0 calibration (verified shas in file header). */
export const DEV_CALIBRATION = {
    n: 64,
    title: { pWin: 9 / 64, pLoss: 1 / 64 },
    body: { pWin: 7 / 64, pLoss: 3 / 64 },
    /** phi(d_title, d_body) on dev64, rounded to 4 dp. */
    targetPhi: -0.0534,
    /** Instance mean u on dev64. */
    meanU: 0.0625,
    /** Per-formulation discordance observed on dev64 (both formulations). */
    discordance: 0.15625,
} as const;

/** Census composition scaled to the assumed frozen n = 400 (prereg §6.2).
 * CLI override `--composition=<comma-separated positive integers>`; an
 * override must sum to the declared TOTAL_N (prereg §9.7). */
export const REPO_COMPOSITION: readonly number[] = [205, 128, 37, 22, 8];

/** Design n: the composition's sum (prereg §6.2 / E16 declared n = 400 at the
 * census split). TOTAL_N derives from REPO_COMPOSITION rather than a literal;
 * a `--composition` override is rejected unless it sums to this declared n. */
export const TOTAL_N: number = REPO_COMPOSITION.reduce((a, b) => a + b, 0);

/**
 * Heterogeneity sign pattern δ for k repos (prereg §9.7): +1 for repos at or
 * above the mean count n/k, −1 for repos below it; when every count is equal
 * (all signs identical) fall back to alternating +1/−1 by index. At the
 * census split this reproduces the frozen δ = [+1, +1, −1, −1, −1] exactly
 * (400/5 = 80; 205, 128 ≥ 80 > 37, 22, 8), so the default run is unchanged.
 * The downstream centering δ_r − w̄δ makes the census-weighted mean exactly 0.
 */
export function repoDelta(composition: readonly number[]): number[] {
    const total = composition.reduce((a, b) => a + b, 0);
    const mean = total / composition.length;
    const pattern = composition.map((c) => (c >= mean ? 1 : -1));
    const positives = pattern.filter((p) => p === 1).length;
    if (positives === 0 || positives === pattern.length) {
        return composition.map((_, i) => (i % 2 === 0 ? 1 : -1));
    }
    return pattern;
}

/**
 * Validate a repo composition: at least 2 repos, positive integers only, and
 * a sum equal to the declared design n (`declaredN`, default TOTAL_N = 400).
 * Every rejection path of `--composition` runs through here (prereg §9.7).
 */
export function assertComposition(
    composition: readonly number[],
    declaredN: number = TOTAL_N,
): void {
    if (composition.length < 2) {
        throw new Error(`composition needs at least 2 repos (got ${composition.length})`);
    }
    for (const c of composition) {
        if (!Number.isInteger(c) || c <= 0) {
            throw new Error(`composition entries must be positive integers (got ${c})`);
        }
    }
    const sum = composition.reduce((a, b) => a + b, 0);
    if (sum !== declaredN) {
        throw new Error(
            `composition must sum to the declared n=${declaredN}, got sum=${sum}`,
        );
    }
}

/** Parse `--composition=<csv>`; rejects non-integers, non-positive values,
 * fewer than 2 repos, and a sum ≠ the declared n (prereg §9.7). */
export function parseComposition(raw: string, declaredN: number = TOTAL_N): number[] {
    const counts = raw.split(",").map((t) => Number(t.trim()));
    assertComposition(counts, declaredN);
    return counts;
}

export const SIM_REPS = 20000;
export const BASE_SEED = 20261009;
export const PASS_TYPE1_MAX = 0.06;
export const PASS_COVERAGE_MIN = 0.94;
/** Inner bootstrap replicates for the prereg §6.1 alternative procedure.
 * Production B = 1999 (prereg §9 amendment: B = 199 was too coarse for the
 * frozen p ≤ .05 decision; the §6.3 record of the B = 199 run is unchanged). */
export const BOOTSTRAP_B = 1999;

/** Null marginals with mu = 0 exactly under G-2L: P(win) = 2 P(loss). */
export function nullMarginals(discordance: number): [FormulationMarginals, FormulationMarginals] {
    const m = { pWin: (2 * discordance) / 3, pLoss: discordance / 3 };
    return [m, m];
}

/**
 * Marginals at a shrinkage fraction of the dev effect, keeping each
 * formulation's discordance fixed: pLoss = (d - mu') / 3, pWin = d - pLoss.
 */
export function powerMargins(shrink: number): [FormulationMarginals, FormulationMarginals] {
    const conv = (m: FormulationMarginals): FormulationMarginals => {
        const d = m.pWin + m.pLoss;
        const mu = m.pWin - 2 * m.pLoss;
        const pLoss = (d - shrink * mu) / 3;
        return { pWin: d - pLoss, pLoss };
    };
    return [conv(DEV_CALIBRATION.title), conv(DEV_CALIBRATION.body)];
}

export function trueMeanFor(shrink: number): number {
    return DEV_CALIBRATION.meanU * shrink;
}

/**
 * Between-repo utility shifts whose census-weighted mean is exactly 0
 * (prereg §6.2): mu_r = 0.5 d (delta_r - w-bar) / max|delta - w-bar|, with
 * delta from `repoDelta(composition)` (signs centred by w-bar).
 */
export function repoUtilityShifts(
    discordance: number,
    n: number,
    composition: readonly number[] = REPO_COMPOSITION,
): number[] {
    const total = composition.reduce((a, b) => a + b, 0);
    if (n !== total) throw new Error(`clustering scenario requires n=${total}`);
    const delta = repoDelta(composition);
    let wbar = 0;
    for (let i = 0; i < composition.length; i++) {
        wbar += (composition[i]! / total) * delta[i]!;
    }
    const devs = delta.map((dlt) => dlt - wbar);
    const maxDev = Math.max(...devs.map(Math.abs));
    return devs.map((dev) => (0.5 * discordance * dev) / maxDev);
}

/** Apply a utility-mean shift to marginals: pWin += s/3, pLoss -= s/3. */
export function applyRepoShift(
    m: FormulationMarginals,
    shift: number,
): FormulationMarginals {
    const out = { pWin: m.pWin + shift / 3, pLoss: m.pLoss - shift / 3 };
    if (out.pWin < 0 || out.pLoss < 0 || out.pWin + out.pLoss > 1) {
        throw new Error(
            `repo shift out of bounds: shift=${shift} base=[${m.pWin},${m.pLoss}] -> [${out.pWin},${out.pLoss}]`,
        );
    }
    return out;
}

interface Thresholds {
    readonly cWin: number;
    readonly cLoss: number;
}

function thresholdsFor(m: FormulationMarginals): Thresholds {
    return { cWin: probit(1 - m.pWin), cLoss: probit(m.pLoss) };
}

function classify(z: number, th: Thresholds): number {
    if (z > th.cWin) return 1;
    if (z < th.cLoss) return -1;
    return 0;
}

function phiOf(d1: readonly number[], d2: readonly number[]): number {
    const n = d1.length;
    const m1 = meanOf(d1);
    const m2 = meanOf(d2);
    let cov = 0, v1 = 0, v2 = 0;
    for (let i = 0; i < n; i++) {
        const a = d1[i]! - m1;
        const b = d2[i]! - m2;
        cov += a * b;
        v1 += a * a;
        v2 += b * b;
    }
    const den = Math.sqrt(v1 * v2);
    return den === 0 ? 0 : cov / den;
}

export function simulatePhi(
    rho: number,
    margins: readonly [FormulationMarginals, FormulationMarginals],
    samples: number,
    seed: number,
): number {
    const rng = mulberry32(seed);
    const randn = makeRandn(rng);
    const thT = thresholdsFor(margins[0]);
    const thB = thresholdsFor(margins[1]);
    const sr = Math.sqrt(1 - rho * rho);
    const d1: number[] = [];
    const d2: number[] = [];
    for (let i = 0; i < samples; i++) {
        const z1 = randn();
        const z2 = randn();
        d1.push(classify(z1, thT));
        d2.push(classify(rho * z1 + sr * z2, thB));
    }
    return phiOf(d1, d2);
}

/**
 * Latent-Gaussian rho such that simulated phi(d_title, d_body) matches the
 * target (bisection, deterministic seed; exact 0 returned for target 0).
 */
export function calibrateLatentRho(
    margins: readonly [FormulationMarginals, FormulationMarginals],
    targetPhi: number,
    samples = 50000,
    seed = BASE_SEED + 777,
): number {
    if (targetPhi === 0) return 0;
    let lo = -0.95;
    let hi = 0.95;
    for (let i = 0; i < 30; i++) {
        const mid = (lo + hi) / 2;
        const phi = simulatePhi(mid, margins, samples, seed);
        if (phi < targetPhi) lo = mid;
        else hi = mid;
    }
    return (lo + hi) / 2;
}

// ---------------------------------------------------------------------------
// Scenario simulation
// ---------------------------------------------------------------------------

export interface Scenario {
    readonly id: string;
    readonly kind: "null" | "power";
    readonly n: number;
    /** True mean utility mu of the scenario. */
    readonly mu: number;
    /** Base margins per formulation (title, body) before repo shift. */
    readonly margins: readonly [FormulationMarginals, FormulationMarginals];
    readonly discordance: number;
    readonly clustering: boolean;
    readonly latentRho: number;
}

export interface ScenarioResult {
    readonly id: string;
    readonly kind: "null" | "power";
    readonly procedure: "t" | "bootstrap-t";
    readonly reps: number;
    readonly n: number;
    readonly mu: number;
    /** Type I error (null) or power (power). */
    readonly rejectRate: number;
    /** MC standard error of rejectRate: sqrt(p(1-p)/reps). */
    readonly rejectMcse: number;
    readonly coverage2: number;
    /** MC standard error of coverage2: sqrt(p(1-p)/reps). */
    readonly coverage2Mcse: number;
    readonly coverageLB: number;
    readonly meanEstimate: number;
}

function thresholdGrid(
    sc: Scenario,
    composition: readonly number[],
): {
    byRepo: readonly (readonly [Thresholds, Thresholds])[];
} {
    if (!sc.clustering) {
        return { byRepo: [[thresholdsFor(sc.margins[0]), thresholdsFor(sc.margins[1])]] };
    }
    const shifts = repoUtilityShifts(sc.discordance, sc.n, composition);
    const byRepo = composition.map((_, i) => [
        thresholdsFor(applyRepoShift(sc.margins[0], shifts[i]!)),
        thresholdsFor(applyRepoShift(sc.margins[1], shifts[i]!)),
    ] as const);
    return { byRepo };
}

function repoOfIndex(sc: Scenario, prefix: readonly number[], i: number): number {
    if (!sc.clustering) return 0;
    let repo = 0;
    while (repo < prefix.length - 2 && i >= prefix[repo + 1]!) repo++;
    return repo;
}

function repoPrefixSums(sc: Scenario, composition: readonly number[]): number[] {
    if (!sc.clustering) return [0, sc.n];
    const prefix = [0];
    let acc = 0;
    for (const c of composition) {
        acc += c;
        prefix.push(acc);
    }
    if (acc !== sc.n) throw new Error("composition does not sum to n");
    return prefix;
}

/** Stratum boundaries for bootstrap resampling: real repo composition at the
 * design size, a single stratum otherwise (toy scenarios). */
function compositionPrefix(composition: readonly number[]): number[] {
    const prefix = [0];
    let acc = 0;
    for (const c of composition) {
        acc += c;
        prefix.push(acc);
    }
    return prefix;
}

/**
 * Alternative primary procedure (prereg §6.1, named BEFORE the primary
 * failed): stratified bootstrap-t for H0: mu <= 0. Resample instances within
 * repository strata, studentize each replicate, and compare T_obs = mu_hat/SE
 * against the bootstrap distribution of T* = (mu_hat* - mu_hat)/SE* — the
 * studentization plus centering at mu_hat makes this the null-boundary
 * (mu = 0) corrected statistic, not a percentile interval around mu_hat.
 * p = (1 + #{T* >= T_obs}) / (B + 1), reject at the frozen alpha = .05.
 */
export interface BootstrapTOutcome {
    readonly reject: boolean;
    readonly pValue: number;
    /** Nearest-rank quantiles of the T* distribution. */
    readonly q025: number;
    readonly q95: number;
    readonly q975: number;
}

export function stratifiedBootstrapT(
    strataValues: readonly Float64Array[],
    meanObs: number,
    tObs: number,
    B: number,
    rng: () => number,
): BootstrapTOutcome {
    const total = strataValues.reduce((a, s) => a + s.length, 0);
    if (total < 2) throw new Error("bootstrap needs n >= 2");
    const ts = new Float64Array(B);
    let geCount = 0;
    for (let b = 0; b < B; b++) {
        let sum = 0;
        let sumSq = 0;
        for (const s of strataValues) {
            const len = s.length;
            for (let i = 0; i < len; i++) {
                const v = s[Math.floor(rng() * len)]!;
                sum += v;
                sumSq += v * v;
            }
        }
        const meanStar = sum / total;
        const varStar = (sumSq - total * meanStar * meanStar) / (total - 1);
        const seStar = Math.sqrt(Math.max(0, varStar) / total);
        let tStar: number;
        if (seStar === 0) {
            tStar = meanStar > meanObs ? Number.POSITIVE_INFINITY
                : meanStar < meanObs ? Number.NEGATIVE_INFINITY : 0;
        } else {
            tStar = (meanStar - meanObs) / seStar;
        }
        ts[b] = tStar;
        if (tStar >= tObs) geCount++;
    }
    const pValue = (1 + geCount) / (B + 1);
    const sorted = Float64Array.from(ts).sort(); // numeric ascending
    const quantile = (p: number): number =>
        sorted[Math.min(B - 1, Math.max(0, Math.ceil(p * B) - 1))]!;
    return {
        reject: pValue <= 0.05,
        pValue,
        q025: quantile(0.025),
        q95: quantile(0.95),
        q975: quantile(0.975),
    };
}

export interface SimulateOptions {
    /** "t" (prereg primary) or "bootstrap-t" (§6.1 alternative). */
    readonly procedure?: "t" | "bootstrap-t";
    readonly bootstrapB?: number;
    /** Repo composition for clustering shifts and bootstrap strata
     * (default: the frozen census split; an override must sum to TOTAL_N). */
    readonly composition?: readonly number[];
}

/** Per-rep decision metrics shared by both procedures. */
interface ProcedureMetrics {
    readonly reject: boolean;
    readonly lo: number;
    readonly hi: number;
    readonly lb: number;
}

function tProcedureMetrics(
    mean: number,
    se: number,
    tCritOne: number,
    tCritTwo: number,
): ProcedureMetrics {
    if (se === 0) return { reject: mean > 0, lo: mean, hi: mean, lb: mean };
    return {
        reject: mean / se > tCritOne,
        lo: mean - tCritTwo * se,
        hi: mean + tCritTwo * se,
        lb: mean - tCritOne * se,
    };
}

function bootstrapProcedureMetrics(
    strata: readonly Float64Array[],
    mean: number,
    se: number,
    opts: { bootstrapB: number; rng: () => number },
): ProcedureMetrics {
    const tObs = se === 0
        ? (mean > 0 ? Number.POSITIVE_INFINITY
            : mean < 0 ? Number.NEGATIVE_INFINITY : 0)
        : mean / se;
    const bt = stratifiedBootstrapT(strata, mean, tObs, opts.bootstrapB, opts.rng);
    return {
        reject: bt.reject,
        lo: mean - bt.q975 * se,
        hi: mean - bt.q025 * se,
        lb: mean - bt.q95 * se,
    };
}

/** Deterministic Monte Carlo for one scenario (seeded, reproducible). */
/** Bootstrap stratum boundaries: the repo composition whenever the design
 * size matches; pooled scenarios still stratify (homogeneous population). */
function strataPrefixFor(sc: Scenario, composition: readonly number[]): number[] {
    const total = composition.reduce((a, b) => a + b, 0);
    return sc.n === total ? compositionPrefix(composition) : [0, sc.n];
}

export function simulateScenario(
    sc: Scenario,
    reps: number,
    seed: number,
    opts: SimulateOptions = {},
): ScenarioResult {
    const procedure = opts.procedure ?? "t";
    const bootstrapB = opts.bootstrapB ?? BOOTSTRAP_B;
    const composition = opts.composition ?? REPO_COMPOSITION;
    const grid = thresholdGrid(sc, composition);
    const prefix = repoPrefixSums(sc, composition);
    const strataPrefix = strataPrefixFor(sc, composition);
    const rng = mulberry32(seed);
    const randn = makeRandn(rng);
    const sr = Math.sqrt(1 - sc.latentRho * sc.latentRho);
    const tCritOne = studentTQuantile(0.95, sc.n - 1);
    const tCritTwo = studentTQuantile(0.975, sc.n - 1);

    let rejects = 0;
    let cover2 = 0;
    let coverLB = 0;
    let estSum = 0;

    for (let rep = 0; rep < reps; rep++) {
        const values = new Float64Array(sc.n);
        for (let i = 0; i < sc.n; i++) {
            const th = grid.byRepo[repoOfIndex(sc, prefix, i)] ?? grid.byRepo[0]!;
            const z1 = randn();
            const z2 = randn();
            const dT = classify(z1, th[0]);
            const dB = classify(sc.latentRho * z1 + sr * z2, th[1]);
            values[i] = (utilityFromDelta(dT) + utilityFromDelta(dB)) / 2;
        }
        let mean = 0;
        for (const v of values) mean += v;
        mean /= sc.n;
        let ss = 0;
        for (const v of values) ss += (v - mean) ** 2;
        const sd = Math.sqrt(ss / (sc.n - 1));
        const se = sd / Math.sqrt(sc.n);

        const strata = strataPrefix
            .slice(0, -1)
            .map((start, j) => values.subarray(start, strataPrefix[j + 1]!));
        const metrics = procedure === "t"
            ? tProcedureMetrics(mean, se, tCritOne, tCritTwo)
            : bootstrapProcedureMetrics(strata, mean, se, { bootstrapB, rng });
        if (metrics.reject) rejects++;
        if (metrics.lo <= sc.mu && sc.mu <= metrics.hi) cover2++;
        if (metrics.lb <= sc.mu) coverLB++;
        estSum += mean;
    }

    return {
        id: sc.id,
        kind: sc.kind,
        procedure,
        reps,
        n: sc.n,
        mu: sc.mu,
        rejectRate: rejects / reps,
        rejectMcse: Math.sqrt((rejects / reps) * (1 - rejects / reps) / reps),
        coverage2: cover2 / reps,
        coverage2Mcse: Math.sqrt((cover2 / reps) * (1 - cover2 / reps) / reps),
        coverageLB: coverLB / reps,
        meanEstimate: estSum / reps,
    };
}

// ---------------------------------------------------------------------------
// Suite: 12 null scenarios + 4 power scenarios, pass evaluation
// ---------------------------------------------------------------------------

export interface SuiteOutput {
    readonly rows: readonly ScenarioResult[];
    readonly pass: boolean;
    readonly failures: readonly string[];
    readonly reps: number;
    readonly baseSeed: number;
    readonly procedure: "t" | "bootstrap-t";
    readonly bootstrapB?: number;
}

/** Build the prereg §6.2 scenario grid (rho calibration done here, once each).
 * `composition` overrides the repo split; it must sum to the declared n. */
export function buildScenarios(composition: readonly number[] = REPO_COMPOSITION): Scenario[] {
    assertComposition(composition);
    const n = composition.reduce((a, b) => a + b, 0);
    const discordances = [0.078, DEV_CALIBRATION.discordance, 0.313];
    const out: Scenario[] = [];
    for (const d of discordances) {
        const margins = nullMarginals(d);
        const rhoDev = calibrateLatentRho(margins, DEV_CALIBRATION.targetPhi);
        for (const target of ["independent", "dev"] as const) {
            for (const clustering of [false, true]) {
                out.push({
                    id: `null-d${d}-${target}-${clustering ? "cluster" : "pool"}`,
                    kind: "null",
                    n,
                    mu: 0,
                    margins,
                    discordance: d,
                    clustering,
                    latentRho: target === "independent" ? 0 : rhoDev,
                });
            }
        }
    }
    for (const shrink of [1, 0.5]) {
        const margins = powerMargins(shrink);
        const rho = calibrateLatentRho(margins, DEV_CALIBRATION.targetPhi);
        for (const clustering of [false, true]) {
            out.push({
                id: `power-shrink${Math.round(shrink * 100)}-${clustering ? "cluster" : "pool"}`,
                kind: "power",
                n,
                mu: trueMeanFor(shrink),
                margins,
                discordance: DEV_CALIBRATION.discordance,
                clustering,
                latentRho: rho,
            });
        }
    }
    return out;
}

/** Prereg §6.1 pass rule, evaluated over completed rows. */
export function evaluatePass(rows: readonly ScenarioResult[]): {
    pass: boolean;
    failures: string[];
} {
    const failures: string[] = [];
    for (const r of rows) {
        if (r.kind === "null" && r.rejectRate > PASS_TYPE1_MAX) {
            failures.push(`${r.id}: type I ${r.rejectRate.toFixed(4)} > ${PASS_TYPE1_MAX}`);
        }
        if (r.coverage2 < PASS_COVERAGE_MIN) {
            failures.push(`${r.id}: coverage ${r.coverage2.toFixed(4)} < ${PASS_COVERAGE_MIN}`);
        }
    }
    return { pass: failures.length === 0, failures };
}

export function runSimulationSuite(
    opts: {
        reps?: number;
        baseSeed?: number;
        procedure?: "t" | "bootstrap-t";
        bootstrapB?: number;
        /** Restrict to the 12 null scenarios (production-B revalidation). */
        nullOnly?: boolean;
        /** Repo composition override; must sum to the declared TOTAL_N. */
        composition?: readonly number[];
    } = {},
): SuiteOutput {
    const reps = opts.reps ?? SIM_REPS;
    const baseSeed = opts.baseSeed ?? BASE_SEED;
    const procedure = opts.procedure ?? "t";
    const simOpts: SimulateOptions = {
        procedure,
        bootstrapB: opts.bootstrapB,
        ...(opts.composition !== undefined ? { composition: opts.composition } : {}),
    };
    const scenarios = buildScenarios(opts.composition ?? REPO_COMPOSITION)
        .map((sc, i) => ({ sc, i }))
        .filter(({ sc }) => !opts.nullOnly || sc.kind === "null");
    const rows = scenarios.map(({ sc, i }) =>
        simulateScenario(sc, reps, baseSeed + i * 1000003, simOpts));
    const { pass, failures } = evaluatePass(rows);
    return {
        rows, pass, failures, reps, baseSeed, procedure,
        ...(procedure === "bootstrap-t"
            ? { bootstrapB: opts.bootstrapB ?? BOOTSTRAP_B }
            : {}),
    };
}

function formatSuite(out: SuiteOutput): string {
    const lines: string[] = [];
    lines.push(`procedure=${out.procedure}`
        + (out.bootstrapB !== undefined ? ` B=${out.bootstrapB}` : ""));
    lines.push("| scenario | kind | mu | rejectRate ± MCSE | coverage2 ± MCSE | coverageLB | meanEst |");
    lines.push("|---|---|---|---|---|---|---|");
    for (const r of out.rows) {
        lines.push(
            `| ${r.id} | ${r.kind} | ${r.mu.toFixed(4)} | ${r.rejectRate.toFixed(4)} ± ${r.rejectMcse.toFixed(4)} | `
            + `${r.coverage2.toFixed(4)} ± ${r.coverage2Mcse.toFixed(4)} | `
            + `${r.coverageLB.toFixed(4)} | ${r.meanEstimate.toFixed(4)} |`,
        );
    }
    lines.push("");
    lines.push(`reps=${out.reps} baseSeed=${out.baseSeed}`);
    lines.push(`PASS: ${out.pass ? "YES" : "NO"}`);
    for (const f of out.failures) lines.push(`FAILURE: ${f}`);
    return lines.join("\n");
}

function cliValue(name: string): string | undefined {
    const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
    if (eq !== undefined) return eq.slice(name.length + 3);
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
}

function cliNumber(name: string): number | undefined {
    const raw = cliValue(name);
    if (raw === undefined) return undefined;
    const v = Number(raw);
    if (!Number.isFinite(v) || v <= 0) throw new Error(`--${name} must be a positive number`);
    return v;
}

async function main(): Promise<void> {
    const procedure = process.argv.includes("bootstrap-t") ? "bootstrap-t" : "t";
    const reps = cliNumber("reps");
    const b = cliNumber("b");
    const rawComposition = cliValue("composition");
    const composition = rawComposition !== undefined
        ? parseComposition(rawComposition)
        : undefined;
    const out = runSimulationSuite({
        procedure,
        ...(reps !== undefined ? { reps } : {}),
        ...(b !== undefined ? { bootstrapB: b } : {}),
        ...(composition !== undefined ? { composition } : {}),
        ...(process.argv.includes("--null-only") ? { nullOnly: true } : {}),
    });
    process.stdout.write(formatSuite(out) + "\n");
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await main();
}
