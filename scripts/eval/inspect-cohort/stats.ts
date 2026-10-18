import { majorityPass, mcnemarExact as tebMcNemar, pairedBootstrap as tebBootstrap } from "../teb/stats.js";
import type { TebBootstrapResult, TebMcNemarResult } from "../teb/stats.js";

export function majorityOutcome(outcomes: boolean[]): boolean {
    return majorityPass(outcomes);
}

export function pairedBootstrap(diffs: number[], draws = 10000, seed = 20261009): TebBootstrapResult {
    return tebBootstrap(diffs, draws, seed);
}

export function mcnemarExact(b: number, c: number): TebMcNemarResult {
    return tebMcNemar(b, c);
}

/** Harm requires both a >3pp deterioration and exact two-sided p < .05. */
export function negativeHarmVeto(input: { deteriorationPp: number; b: number; c: number }): boolean {
    return input.deteriorationPp > 3 && mcnemarExact(input.b, input.c).p < 0.05;
}

export const calibrationGates = {
    falseCompletenessCap: null as number | null,
    invalidCallMargin: null as number | null,
    costCeiling: null as number | null,
    latencyCeilingMs: null as number | null,
};

/** Small-n upper order statistic; deliberately makes no asymptotic p95 claim. */
export function orderedLatencyCeiling(samples: number[]): { value: number | null; rank: number; n: number } {
    if (samples.length === 0) return { value: null, rank: 0, n: 0 };
    const sorted = [...samples].sort((a, b) => a - b);
    const rank = Math.ceil(0.95 * sorted.length);
    return { value: sorted[rank - 1]!, rank, n: sorted.length };
}

/** Inverse standard-normal CDF (Acklam rational approximation). */
function normalQuantile(p: number): number {
    const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
    const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
    const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
    const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
    const low = 0.02425;
    if (p < low) {
        const q = Math.sqrt(-2 * Math.log(p));
        return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
            ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
    }
    if (p > 1 - low) return -normalQuantile(1 - p);
    const q = p - 0.5;
    const r = q * q;
    return (((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q /
        (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}

/** Approximate paired binary-outcome sample size from pilot discordance. */
export function sizeForMde(discordance: number, mde: number, alpha = 0.05, power = 0.8): number {
    if (!(discordance > 0 && discordance <= 1) || !(mde > 0 && mde <= 1) || !(alpha > 0 && alpha < 1) || !(power > 0 && power < 1)) {
        throw new RangeError("discordance, mde, alpha, and power must be valid probabilities");
    }
    const zAlpha = normalQuantile(1 - alpha / 2);
    const zPower = normalQuantile(power);
    return Math.ceil(((zAlpha + zPower) ** 2 * discordance) / (mde ** 2));
}
