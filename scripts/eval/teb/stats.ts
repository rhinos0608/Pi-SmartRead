/**
 * TEB (Tool Ergonomics Bench) statistics: task-level aggregation, paired
 * bootstrap CIs, repo-clustered sensitivity, exact McNemar veto, and gate
 * evaluation.
 *
 * Binding inputs: §11–§12 of `docs/plans/2026-10-07-teb-protocol.md`.
 * Unit of analysis is the TASK: replicates aggregate by majority (pass
 * fraction > 0.5 passes; ties fail — predeclared). Every ordinary timeout
 * stays in the denominator as 0/0; only predeclared infrastructure
 * exclusions drop pairs. The 3pp negative veto is paired-tested
 * (McNemar exact p < 0.05 AND point deterioration > 3pp).
 *
 * Pure functions, no dependencies beyond node builtins. All randomness
 * flows through a seeded RNG (mulberry32); seeds are fixed and recorded
 * by the caller.
 */

/** One paired task outcome (majority over replicates already applied). */
export interface TebPairedTask {
    taskId: string;
    repo: string;
    family: string;
    negativeControl: boolean;
    basePass: boolean;
    armPass: boolean;
}

/** Majority over replicates: pass fraction > 0.5 passes; ties fail. */
export function majorityPass(replicatePasses: boolean[]): boolean {
    if (replicatePasses.length === 0) return false;
    const passes = replicatePasses.filter(Boolean).length;
    return passes / replicatePasses.length > 0.5;
}

/** Seeded RNG (mulberry32): deterministic across runs for a fixed seed. */
export function mulberry32(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export interface TebBootstrapResult {
    mean: number;
    lo: number;
    hi: number;
    draws: number;
    seed: number;
}

/**
 * Paired task bootstrap 95% CI on the arm-minus-baseline difference:
 * resample tasks with replacement, keep each task's outcome intact.
 * `diffs` holds per-task differences in {-1, 0, 1}.
 */
export function pairedBootstrap(
    diffs: number[],
    draws = 10000,
    seed = 20261007,
): TebBootstrapResult {
    const n = diffs.length;
    if (n === 0) return { mean: 0, lo: 0, hi: 0, draws, seed };
    const rng = mulberry32(seed);
    const observed = diffs.reduce((a, b) => a + b, 0) / n;
    const means: number[] = new Array(draws);
    for (let d = 0; d < draws; d++) {
        let sum = 0;
        for (let i = 0; i < n; i++) sum += diffs[Math.floor(rng() * n)]!;
        means[d] = sum / n;
    }
    means.sort((a, b) => a - b);
    const quantile = (q: number): number => means[Math.min(draws - 1, Math.floor(q * draws))]!;
    return { mean: observed, lo: quantile(0.025), hi: quantile(0.975), draws, seed };
}

export function taskDiffs(tasks: TebPairedTask[]): number[] {
    return tasks.map((t) => (t.armPass ? 1 : 0) - (t.basePass ? 1 : 0));
}

export function successRate(tasks: TebPairedTask[], arm: "base" | "arm"): number {
    if (tasks.length === 0) return 0;
    const passes = tasks.filter((t) => (arm === "base" ? t.basePass : t.armPass)).length;
    return passes / tasks.length;
}

export interface TebRepoSensitivity {
    /** Leave-one-repo-out arm-minus-baseline differences keyed by held-out repo. */
    leaveOneOut: Array<{ heldOut: string; diff: number; tasks: number }>;
    /** Cluster bootstrap (resample repos, keep task outcomes intact). */
    clusterBootstrap: TebBootstrapResult;
}

/** Repo-clustered sensitivity: a champion that depends on one repo must show. */
export function repoSensitivity(
    tasks: TebPairedTask[],
    draws = 10000,
    seed = 20261008,
): TebRepoSensitivity {
    const repos = [...new Set(tasks.map((t) => t.repo))];
    const leaveOneOut = repos.map((heldOut) => {
        const rest = tasks.filter((t) => t.repo !== heldOut);
        const diffs = taskDiffs(rest);
        return {
            heldOut,
            diff: diffs.length === 0 ? 0 : diffs.reduce((a, b) => a + b, 0) / diffs.length,
            tasks: rest.length,
        };
    });
    // Cluster bootstrap: resample repos with replacement to the same
    // repo count, keeping every task outcome inside a sampled repo intact.
    const rng = mulberry32(seed);
    const means: number[] = new Array(draws);
    for (let d = 0; d < draws; d++) {
        const sampled: TebPairedTask[] = [];
        for (let i = 0; i < repos.length; i++) {
            const repo = repos[Math.floor(rng() * repos.length)]!;
            for (const t of tasks) if (t.repo === repo) sampled.push(t);
        }
        const diffs = taskDiffs(sampled);
        means[d] = diffs.length === 0 ? 0 : diffs.reduce((a, b) => a + b, 0) / diffs.length;
    }
    means.sort((a, b) => a - b);
    const quantile = (q: number): number => means[Math.min(draws - 1, Math.floor(q * draws))]!;
    const all = taskDiffs(tasks);
    return {
        leaveOneOut,
        clusterBootstrap: {
            mean: all.length === 0 ? 0 : all.reduce((a, b) => a + b, 0) / all.length,
            lo: quantile(0.025),
            hi: quantile(0.975),
            draws,
            seed,
        },
    };
}

function binomialPmf(n: number, k: number): number {
    if (k < 0 || k > n) return 0;
    // Symmetric iterative product; n is at most the task count (~120).
    let c = 1;
    const r = Math.min(k, n - k);
    for (let i = 1; i <= r; i++) c = (c * (n - r + i)) / i;
    return c * Math.pow(0.5, n);
}

export interface TebMcNemarResult {
    /** Base-passed, arm-failed. */
    b: number;
    /** Base-failed, arm-passed. */
    c: number;
    /** Exact two-sided p-value under Bin(b+c, 0.5). */
    p: number;
}

/** Exact McNemar test on the discordant paired outcomes. */
export function mcnemarExact(b: number, c: number): TebMcNemarResult {
    const n = b + c;
    if (n === 0) return { b, c, p: 1 };
    const k = Math.min(b, c);
    let lower = 0;
    for (let i = 0; i <= k; i++) lower += binomialPmf(n, i);
    return { b, c, p: Math.min(1, 2 * lower) };
}

export interface TebGateValues {
    minSuccessGainPp: number;
    minRecallGainPp: number;
    minSpecialistPrecision: number;
    maxNegativeDeteriorationPp: number;
    maxLostPriorSuccessRate: number;
}

export interface TebGateInput {
    paired: TebPairedTask[];
    /** Opportunity-recall gain in percentage points (arm − base). */
    recallGainPp: number;
    /** Specialist precision on the arm (0–1). */
    armPrecision: number | null;
}

export interface TebGateResult {
    id: string;
    passed: boolean;
    detail: string;
}

export interface TebGateReport {
    gates: TebGateResult[];
    passed: boolean;
    /** Tasks B passed at task level but the champion failed. */
    lostPriorSuccesses: string[];
    lostPriorSuccessRate: number | null;
    negativeMcNemar: TebMcNemarResult;
    primaryBootstrap: TebBootstrapResult;
}

/**
 * Gate evaluation against frozen values (§12): holdout success gain with
 * a positive paired 95% CI, opportunity-recall gain, specialist
 * precision floor, and the loss vetoes (paired-tested negative
 * deterioration + lost-prior-success cap).
 */
export function evaluateGates(
    input: TebGateInput,
    gates: TebGateValues,
    draws = 10000,
    seed = 20261007,
): TebGateReport {
    const { paired } = input;
    const diffs = taskDiffs(paired);
    const bootstrap = pairedBootstrap(diffs, draws, seed);

    const negatives = paired.filter((t) => t.negativeControl);
    const negDiffs = taskDiffs(negatives);
    const negDeteriorationPp =
        negDiffs.length === 0 ? 0 : -(negDiffs.reduce((a, b) => a + b, 0) / negDiffs.length) * 100;
    const b = negatives.filter((t) => t.basePass && !t.armPass).length;
    const c = negatives.filter((t) => !t.basePass && t.armPass).length;
    const negMcNemar = mcnemarExact(b, c);

    const basePassed = paired.filter((t) => t.basePass);
    const lost = basePassed.filter((t) => !t.armPass).map((t) => t.taskId);
    const lostRate = basePassed.length === 0 ? null : lost.length / basePassed.length;

    const successGainPp = bootstrap.mean * 100;
    const gatesOut: TebGateResult[] = [
        {
            id: "success-gain",
            passed: successGainPp >= gates.minSuccessGainPp && bootstrap.lo > 0,
            detail:
                `gain ${successGainPp.toFixed(2)}pp (95% CI ` +
                `${(bootstrap.lo * 100).toFixed(2)}..${(bootstrap.hi * 100).toFixed(2)}), ` +
                `needs +${gates.minSuccessGainPp}pp with positive CI`,
        },
        {
            id: "recall-gain",
            passed: input.recallGainPp >= gates.minRecallGainPp,
            detail:
                `opportunity recall gain ${input.recallGainPp.toFixed(2)}pp, ` +
                `needs +${gates.minRecallGainPp}pp`,
        },
        {
            id: "specialist-precision",
            passed: input.armPrecision !== null && input.armPrecision >= gates.minSpecialistPrecision,
            detail:
                `arm precision ${
                    input.armPrecision === null
                        ? "n/a (no specialist calls)"
                        : `${(input.armPrecision * 100).toFixed(1)}%`
                }, needs ≥${(gates.minSpecialistPrecision * 100).toFixed(0)}%`,
        },
        {
            id: "negative-veto",
            passed: !(negDeteriorationPp > gates.maxNegativeDeteriorationPp && negMcNemar.p < 0.05),
            detail:
                `negative deterioration ${negDeteriorationPp.toFixed(2)}pp ` +
                `(McNemar b=${b} c=${c} p=${negMcNemar.p.toFixed(4)}), ` +
                `veto past +${gates.maxNegativeDeteriorationPp}pp with p<0.05`,
        },
        {
            id: "lost-successes",
            passed: lostRate !== null && lostRate <= gates.maxLostPriorSuccessRate,
            detail:
                `lost ${lost.length}/${basePassed.length} prior successes ` +
                `(${
                    lostRate === null ? "n/a" : `${(lostRate * 100).toFixed(1)}%`
                }, cap ${(gates.maxLostPriorSuccessRate * 100).toFixed(0)}%)`,
        },
    ];
    return {
        gates: gatesOut,
        passed: gatesOut.every((g) => g.passed),
        lostPriorSuccesses: lost,
        lostPriorSuccessRate: lostRate,
        negativeMcNemar: negMcNemar,
        primaryBootstrap: bootstrap,
    };
}
