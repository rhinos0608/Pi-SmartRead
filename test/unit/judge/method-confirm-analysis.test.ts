/**
 * `scripts/eval/judge/method-confirm-analysis.ts` — pure analysis core for
 * the judge confirmation v2 preregistration.
 *
 * Everything here is hand-checkable:
 *  - t-CDF references come from SciPy's `scipy.stats.t` (independent
 *    implementation): t.cdf(2.2281388519649385, 10) = 0.975,
 *    t.cdf(-4.242640687119285, 4) = 0.006617799781841345, t.cdf(1, 1) = 0.75.
 *  - Power/sample-size references come from SciPy's `scipy.stats.norm`
 *    at alpha = 0.05/3: z = 2.128045234184983, z_0.8 = 0.8416212335729143.
 *  - Holm, challenger, cost, and envelope cases are arithmetic by hand.
 *  - The sign-flip procedure is checked against hand-enumerated sign
 *    patterns (all 2^n flips for n <= 10) and is deterministic for a
 *    fixed seed; the precommitted production draws/seed are pinned.
 *  - No test reads the real pilot root; the real-data path runs only via
 *    the CLI (verdict byte-for-value reproduction gate).
 */
import { describe, expect, it } from "vitest";
import {
    CONFIRM_FWER_MAX,
    CONFIRM_SIGN_FLIP_DRAWS,
    CONFIRM_SIGN_FLIP_SEED,
    CONFIRM_SIMULATION_REPS_MIN,
    CONFIRM_TYPE_I_MAX,
    analyticOneSidedPower,
    buildBudgetEnvelope,
    buildSignMatrix,
    costPerQueryPerReplica,
    holmStepDown,
    normalCdf,
    normalQuantile,
    pairedTTestOneSided,
    parseMethodConfirmAnalysisArgs,
    queriesForEightyPercentPower,
    regularizedIncompleteBeta,
    runConfirmationSimulation,
    selectChallenger,
    signFlipOneSidedPValue,
    studentTCdf,
    summarizeWireCost,
    usdForInputTokens,
    type ConfirmWireRow,
    type SignMatrix,
} from "../../../scripts/eval/judge/method-confirm-analysis.js";

const ALPHA_OVER_3 = 0.05 / 3;

const MODELS = [
    "~typesafe/jev-latest",
    "perplexity/pplx-decider-v1.1-27b",
    "openai/gpt-6-luna-decisions",
] as const;

describe("studentTCdf / normalCdf", () => {
    it("matches SciPy reference values", () => {
        expect(studentTCdf(0, 10)).toBe(0.5);
        expect(studentTCdf(2.2281388519649385, 10)).toBeCloseTo(0.975, 6);
        expect(studentTCdf(-4.242640687119285, 4)).toBeCloseTo(0.006617799781841345, 8);
        expect(studentTCdf(1, 1)).toBeCloseTo(0.75, 7);
        expect(studentTCdf(2.2281388519649385, 10)).toBeCloseTo(1 - studentTCdf(-2.2281388519649385, 10), 12);
        expect(studentTCdf(Infinity, 10)).toBe(1);
        expect(studentTCdf(-Infinity, 10)).toBe(0);
    });

    it("normal CDF/quantile round-trip at the 97.5th percentile", () => {
        expect(normalCdf(0)).toBeCloseTo(0.5, 9);
        expect(normalCdf(1.959963984540054)).toBeCloseTo(0.975, 6);
        expect(normalQuantile(0.975)).toBeCloseTo(1.959963984540054, 9);
        expect(normalQuantile(0.5)).toBeCloseTo(0, 9);
        expect(() => normalQuantile(0)).toThrow();
    });

    it("regularized incomplete beta hits its boundary identities", () => {
        expect(regularizedIncompleteBeta(2, 3, 0)).toBe(0);
        expect(regularizedIncompleteBeta(2, 3, 1)).toBe(1);
        expect(regularizedIncompleteBeta(1, 1, 0.5)).toBeCloseTo(0.5, 12);
        expect(regularizedIncompleteBeta(0.5, 0.5, 0.25)).toBeCloseTo(1 / 3, 9);
    });
});

describe("pairedTTestOneSided", () => {
    it("reproduces the hand-computed t and the SciPy one-sided p", () => {
        const result = pairedTTestOneSided([-1, -2, -3, -4, -5]);
        expect(result.n).toBe(5);
        expect(result.mean).toBe(-3);
        expect(result.sd).toBeCloseTo(Math.sqrt(2.5), 12);
        expect(result.se).toBeCloseTo(Math.sqrt(2.5 / 5), 12);
        expect(result.t).toBeCloseTo(-4.242640687119285, 9);
        expect(result.df).toBe(4);
        expect(result.pValue).toBeCloseTo(0.006617799781841345, 8);
    });

    it("handles a degenerate all-zero sample and rejects short input", () => {
        const zero = pairedTTestOneSided([0, 0, 0, 0]);
        expect(zero.t).toBe(0);
        expect(zero.pValue).toBe(0.5);
        const negative = pairedTTestOneSided([-1, -1]);
        expect(negative.pValue).toBe(0);
        expect(() => pairedTTestOneSided([1])).toThrow();
        expect(() => pairedTTestOneSided([1, NaN])).toThrow();
    });
});

describe("holmStepDown", () => {
    it("orders by p, applies alpha/(m-i), and stops at the first non-rejection", () => {
        const result = holmStepDown([0.01, 0.04, 0.03], 0.05);
        expect(result.order).toEqual([0, 2, 1]);
        expect(result.thresholds.map((t) => Number(t.toFixed(6)))).toEqual([0.016667, 0.025, 0.05]);
        expect(result.rejected).toEqual([true, false, false]);
        expect(result.stopAt).toBe(1);
        expect(result.anyRejected).toBe(true);
    });

    it("breaks exact p-value ties by input index and keeps step-down order", () => {
        const result = holmStepDown([0.01, 0.01, 0.5], 0.05);
        expect(result.order).toEqual([0, 1, 2]);
        expect(result.rejected).toEqual([true, true, false]);
        expect(result.stopAt).toBe(2);
    });

    it("rejects nothing when the very first step fails", () => {
        const result = holmStepDown([0.4, 0.5, 0.6], 0.05);
        expect(result.rejected).toEqual([false, false, false]);
        expect(result.stopAt).toBe(0);
        expect(result.anyRejected).toBe(false);
    });

    it("rejects everything when all p-values clear their thresholds", () => {
        const result = holmStepDown([0.001, 0.002, 0.003], 0.05);
        expect(result.rejected).toEqual([true, true, true]);
        expect(result.stopAt).toBeNull();
    });
});

describe("selectChallenger", () => {
    it("picks the lower-loss method per model (pilot rule)", () => {
        // Pilot totals: Jev M1 59 vs M2 62; PPLX M1 63 vs M2 55; Luna M1 42 vs M2 56.
        expect(selectChallenger("~typesafe/jev-latest", { M1: 59, M2: 62 }, { M1: 0.01, M2: 0.02 }).chosen).toBe("M1");
        expect(selectChallenger("perplexity/pplx-decider-v1.1-27b", { M1: 63, M2: 55 }, { M1: 0.01, M2: 0.02 }).chosen).toBe("M2");
        expect(selectChallenger("openai/gpt-6-luna-decisions", { M1: 42, M2: 56 }, { M1: 0.01, M2: 0.02 }).chosen).toBe("M1");
    });

    it("breaks an exact loss tie by projected cost per query, and fails closed on a full tie", () => {
        const tied = selectChallenger("m", { M1: 50, M2: 50 }, { M1: 0.002, M2: 0.001 });
        expect(tied.chosen).toBe("M2");
        expect(tied.tieBreak).toBe("projected-cost");
        expect(() => selectChallenger("m", { M1: 50, M2: 50 }, { M1: 0.001, M2: 0.001 })).toThrow(/unresolvable/);
        expect(() => selectChallenger("m", { M1: NaN, M2: 50 }, { M1: 0.1, M2: 0.2 })).toThrow(/non-finite/);
    });
});

describe("planning power and sample size", () => {
    it("returns the nominal alpha when the effect is exactly zero", () => {
        expect(analyticOneSidedPower(0, 1, 400, ALPHA_OVER_3)).toBeCloseTo(ALPHA_OVER_3, 6);
    });

    it("matches SciPy's normal approximation at a hand case", () => {
        // Phi(0.1*sqrt(400)/1 - z_{1-0.05/3}) = Phi(-0.128045234184983) = 0.4490565879711642
        expect(analyticOneSidedPower(-0.1, 1, 400, ALPHA_OVER_3)).toBeCloseTo(0.4490565879711642, 5);
        expect(analyticOneSidedPower(-1, 1, 400, ALPHA_OVER_3)).toBeCloseTo(1, 5);
    });

    it("computes n for 80% power and fails closed at a zero effect", () => {
        // ceil((z_{1-0.05/3} + z_0.8)^2 * sd^2 / effect^2) = ceil(2.9696664677578974^2) = 9
        expect(queriesForEightyPercentPower(-1, 1, ALPHA_OVER_3)).toBe(9);
        expect(queriesForEightyPercentPower(0, 1, ALPHA_OVER_3)).toBe(Infinity);
        expect(() => queriesForEightyPercentPower(-1, 0, ALPHA_OVER_3)).toThrow();
    });
});

describe("wire cost aggregation", () => {
    const row = (
        wireId: string, arm: string, method: ConfirmWireRow["method"], warmup: boolean, inputTokens: number | null,
    ): ConfirmWireRow => ({ wireId, arm, method, warmup, inputTokens });

    it("dedups by wireId, separates warmups, and averages scored tokens", () => {
        const rows = [
            row("w1", "a", "M0", true, 700),
            row("w2", "a", "M0", false, 1000),
            row("w3", "a", "M0", false, 3000),
            row("w2", "a", "M0", false, 1000), // duplicate wireId: first row wins, counted once
            row("w4", "a", "M1", false, null), // transport failure without a token count
            row("w5", "a", "M1", false, 500),
        ];
        const summary = summarizeWireCost(rows);
        const m0 = summary.get("a|M0")!;
        expect(m0.requests).toBe(3);
        expect(m0.warmups).toBe(1);
        expect(m0.scoredRequests).toBe(2);
        expect(m0.scoredInputTokens).toBe(4000);
        expect(m0.warmupInputTokens).toBe(700);
        expect(m0.meanInputTokens).toBe(2000);
        const m1 = summary.get("a|M1")!;
        expect(m1.scoredRequests).toBe(2);
        expect(m1.scoredRequestsMissingTokens).toBe(1);
        expect(m1.meanInputTokens).toBe(500);
        expect(() => summarizeWireCost([row("", "a", "M0", false, 1)])).toThrow(/empty wireId/);
    });

    it("converts tokens to USD and normalizes per query per replica", () => {
        expect(usdForInputTokens(1_000_000, 0.042)).toBeCloseTo(0.042, 12);
        // 1,000,000 tokens over 100 queries x 1 replica at $0.10/M = 10k tokens each = $0.001
        expect(costPerQueryPerReplica(1_000_000, 100, 1, 0.1)).toBeCloseTo(0.001, 12);
        expect(() => costPerQueryPerReplica(1, 0, 1, 0.1)).toThrow();
    });
});

describe("budget envelope", () => {
    it("applies the oracle stress conventions (3 attempts, UNKNOWN reserves, admission reserve)", () => {
        const envelope = buildBudgetEnvelope({
            queries: 10,
            replicas: 1,
            m0CostPerQueryReplicaByModel: { [MODELS[0]]: 0.1, [MODELS[1]]: 0.1, [MODELS[2]]: 0.1 },
            challengerMarginalCostPerQueryReplicaByModel: { [MODELS[0]]: 0.1, [MODELS[1]]: 0.1, [MODELS[2]]: 0.1 },
            warmupAllowanceUsd: 0,
            deferredSuiteUsd: 0,
            modelNames: [...MODELS],
            capUsd: 10,
            spentUsd: 0.3613,
        });
        // 10 queries x 1 replica x (3 x 0.2) = 6
        expect(envelope.nominalScoredUsd).toBeCloseTo(6, 12);
        expect(envelope.nominalTotalUsd).toBeCloseTo(6, 12);
        expect(envelope.attemptsEnvelopeUsd).toBeCloseTo(18, 12);
        // 2 UNKNOWN reserves x (0.001344 + 0.01048576 + 0.105)
        expect(envelope.unknownReserveUsd).toBeCloseTo(0.23365952, 9);
        // largest next-call admission reserve = Luna's full-context reserve
        expect(envelope.admissionReserveUsd).toBeCloseTo(0.105, 12);
        expect(envelope.stressTotalUsd).toBeCloseTo(18.33865952, 9);
        expect(envelope.remainingUsd).toBeCloseTo(9.6387, 9);
        expect(envelope.nominalFits).toBe(true);
        expect(envelope.stressFits).toBe(false);
    });

    it("fails closed on a model with a missing cost", () => {
        expect(() => buildBudgetEnvelope({
            queries: 10,
            replicas: 1,
            m0CostPerQueryReplicaByModel: {},
            challengerMarginalCostPerQueryReplicaByModel: {},
            warmupAllowanceUsd: 0,
            deferredSuiteUsd: 0,
            modelNames: [MODELS[0]],
            capUsd: 10,
            spentUsd: 0,
        })).toThrow(/missing cost/);
    });
});

describe("sign-flip procedure", () => {
    // Full 2^n sign-pattern enumeration as a matrix (n <= 10 fits one word).
    const fullEnumerationMatrix = (n: number): SignMatrix => ({
        draws: 2 ** n,
        n,
        wordsPerRow: 1,
        bits: Uint32Array.from({ length: 2 ** n }, (_, i) => i),
    });

    // Independent brute-force reference: bit i set => sign +1 at position i.
    const exactSignFlipP = (values: readonly number[]): number => {
        const obs = values.reduce((a, b) => a + b, 0);
        let hits = 0;
        for (let mask = 0; mask < 2 ** values.length; mask += 1) {
            let s = 0;
            for (let i = 0; i < values.length; i += 1) {
                s += (mask & (1 << i)) !== 0 ? values[i]! : -values[i]!;
            }
            if (s <= obs) hits += 1;
        }
        return hits / 2 ** values.length;
    };

    it("reproduces the hand-enumerated p on a hand-built 4-draw matrix", () => {
        const hand: SignMatrix = {
            draws: 4,
            n: 2,
            wordsPerRow: 1,
            bits: Uint32Array.from([0b00, 0b01, 0b10, 0b11]),
        };
        // x = [-1, 2], observed sum = 1; pattern sums: -1, -3, +3, +1
        // -> P(S* <= 1) = 3/4 (equality counted, one-sided).
        expect(signFlipOneSidedPValue([-1, 2], 1, hand)).toBe(0.75);
        expect(exactSignFlipP([-1, 2])).toBe(0.75);
    });

    it("matches exact enumeration for n <= 10 vectors with ties, zeros, and mixed signs", () => {
        expect(exactSignFlipP([-2, -2, 1])).toBe(0.25);
        expect(exactSignFlipP([1, -1])).toBe(0.75); // conservative equality counting
        expect(exactSignFlipP([0, 0, 0])).toBe(1);
        const vectors = [
            [-2, -2, 1],
            [1, -1],
            [0, 0, -1],
            [-1, -1, -1],
            [0, 0, -1, -1, 2, 0, -3, 1, -1, 4], // n = 10: the enumeration ceiling
            [1, 2, 3, 4, 5, -5, -4, -3, -2, -1],
        ];
        for (const values of vectors) {
            const obs = values.reduce((a, b) => a + b, 0);
            const matrix = fullEnumerationMatrix(values.length);
            expect(signFlipOneSidedPValue(values, obs, matrix)).toBeCloseTo(exactSignFlipP(values), 12);
        }
    });

    it("is deterministic for a fixed seed and converges to the exact p", () => {
        const m1 = buildSignMatrix(50_000, 6, CONFIRM_SIGN_FLIP_SEED);
        const m2 = buildSignMatrix(50_000, 6, CONFIRM_SIGN_FLIP_SEED);
        expect(Array.from(m1.bits)).toEqual(Array.from(m2.bits));
        const other = buildSignMatrix(50_000, 6, 7);
        expect(Array.from(other.bits)).not.toEqual(Array.from(m1.bits));
        const values = [-2, -1, 0, 1, 0, -2];
        const obs = values.reduce((a, b) => a + b, 0);
        const p = signFlipOneSidedPValue(values, obs, m1);
        expect(signFlipOneSidedPValue(values, obs, m1)).toBe(p); // same matrix => same p
        // MC with B = 50,000: SE <= 0.0023, so |MC - exact| < 0.01 is ~4.4 SE.
        expect(Math.abs(p - exactSignFlipP(values))).toBeLessThan(0.01);
    });

    it("pins the precommitted production draws and seed", () => {
        expect(CONFIRM_SIGN_FLIP_DRAWS).toBe(100_000);
        expect(CONFIRM_SIGN_FLIP_SEED).toBe(20_261_010);
    });
});

describe("runConfirmationSimulation", () => {
    // 8 synthetic pilot queries per model: mostly ties, one clear win each.
    const perModelD = {
        [MODELS[0]]: [-1, -2, 0, 0, 0, -1, 0, 1],
        [MODELS[1]]: [0, 1, 0, -1, 0, 0, 0, 0], // pilot mean exactly 0 (the PPLX challenger case)
        [MODELS[2]]: [-3, -1, 0, -2, 0, -1, 0, -4],
    };

    it("enforces the preregistered rep floor and model count", () => {
        expect(() => runConfirmationSimulation({
            perModelD, n: 50, reps: CONFIRM_SIMULATION_REPS_MIN - 1, seed: 1, procedure: "paired-t",
        })).toThrow(/20000/);
        expect(() => runConfirmationSimulation({
            perModelD: { [MODELS[0]]: [0, 1, 2] }, n: 50, reps: CONFIRM_SIMULATION_REPS_MIN, seed: 1,
            procedure: "paired-t",
        })).toThrow(/3 models/);
        expect(() => runConfirmationSimulation({
            perModelD, n: 50, reps: CONFIRM_SIMULATION_REPS_MIN, seed: 1,
            procedure: "wilcoxon" as never,
        })).toThrow(/procedure/);
    });

    it("is deterministic for a fixed seed and reports rates inside [0,1]", () => {
        const args = {
            perModelD, n: 50, reps: CONFIRM_SIMULATION_REPS_MIN, seed: 20_261_009,
            procedure: "paired-t" as const,
        };
        const a = runConfirmationSimulation(args);
        const b = runConfirmationSimulation(args);
        expect(JSON.stringify(a)).toBe(JSON.stringify(b));
        expect(a.seed).toBe(20_261_009);
        expect(a.reps).toBe(CONFIRM_SIMULATION_REPS_MIN);
        for (const rate of Object.values(a.typeI.perModel)) {
            expect(rate).toBeGreaterThanOrEqual(0);
            expect(rate).toBeLessThanOrEqual(1);
        }
        expect(a.typeI.fwer).toBeGreaterThanOrEqual(0);
        expect(a.typeI.fwer).toBeLessThanOrEqual(1);
        expect(a.criteria.typeIMax).toBe(CONFIRM_TYPE_I_MAX);
        expect(a.criteria.fwerMax).toBe(CONFIRM_FWER_MAX);
        expect(typeof a.criteria.pass).toBe("boolean");
        expect(a.power.point.perModel[MODELS[0]!]).toBeGreaterThanOrEqual(0);
        expect(a.power.half.perModel[MODELS[0]!]).toBeGreaterThanOrEqual(0);
        // Point effect >= half effect in magnitude => power(point) >= power(half), same draws
        // (every synthetic vector has a non-positive mean; the PPLX-like vector has mean 0).
        for (const model of Object.keys(perModelD)) {
            expect(a.power.point.perModel[model]!).toBeGreaterThanOrEqual(a.power.half.perModel[model]!);
        }
    });

    it("a different seed produces a different (still valid) simulation", () => {
        const base = { perModelD, n: 50, reps: CONFIRM_SIMULATION_REPS_MIN, procedure: "paired-t" as const };
        const a = runConfirmationSimulation({ ...base, seed: 20_261_009 });
        const b = runConfirmationSimulation({ ...base, seed: 42 });
        expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
    });

    it("runs the sign-flip procedure deterministically at a small inner-draw count", () => {
        const args = {
            perModelD, n: 50, reps: CONFIRM_SIMULATION_REPS_MIN, seed: 20_261_009,
            procedure: "sign-flip" as const, signFlipDraws: 128,
        };
        const a = runConfirmationSimulation(args);
        const b = runConfirmationSimulation(args);
        expect(JSON.stringify(a)).toBe(JSON.stringify(b));
        expect(a.procedure).toBe("sign-flip");
        expect(a.signFlipDraws).toBe(128);
        expect(a.criteria.typeIMax).toBe(CONFIRM_TYPE_I_MAX);
        expect(a.criteria.fwerMax).toBe(CONFIRM_FWER_MAX);
        for (const rate of Object.values(a.typeI.perModel)) {
            expect(rate).toBeGreaterThanOrEqual(0);
            expect(rate).toBeLessThanOrEqual(1);
        }
        expect(a.power.point.perModel[MODELS[0]!]).toBeGreaterThanOrEqual(0);
    });
});

describe("parseMethodConfirmAnalysisArgs", () => {
    it("parses value flags and rejects unknown or malformed input", () => {
        const args = parseMethodConfirmAnalysisArgs([
            "--records", "r.jsonl", "--plan", "p.json", "--verdict", "v.json",
            "--simulation", "--reps", "30000", "--seed", "7", "--confirmation-replicas", "4",
        ]);
        expect(args.records).toBe("r.jsonl");
        expect(args.plan).toBe("p.json");
        expect(args.verdict).toBe("v.json");
        expect(args.simulation).toBe(true);
        expect(args.reps).toBe(30_000);
        expect(args.seed).toBe(7);
        expect(args.confirmationReplicas).toBe(4);
        expect(() => parseMethodConfirmAnalysisArgs(["--nope"])).toThrow(/unknown flag/);
        expect(() => parseMethodConfirmAnalysisArgs(["--reps"])).toThrow(/requires a value/);
        expect(() => parseMethodConfirmAnalysisArgs(["--reps", "1.5"])).toThrow(/integer/);
    });
});
