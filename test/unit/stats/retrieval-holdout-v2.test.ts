/**
 * Retrieval holdout v2 — hand-computed toy cases + determinism for the
 * analysis/simulation functions used by the preregistration.
 *
 * No holdout data: every fixture here is synthetic.
 */
import { describe, expect, it } from "vitest";
import {
    BASE_SEED,
    BOOTSTRAP_B,
    DEV_CALIBRATION,
    PASS_COVERAGE_MIN,
    PASS_TYPE1_MAX,
    REPO_COMPOSITION,
    TOTAL_N,
    analyzeReports,
    assertComposition,
    attritionSensitivity,
    buildInstanceUtilities,
    buildScenarios,
    calibrateLatentRho,
    clusterRobustMean,
    evaluatePass,
    leaveOneRepoOut,
    makeRandn,
    mulberry32,
    nullMarginals,
    pairedTTest,
    parseComposition,
    powerMargins,
    probit,
    repoDelta,
    repoUtilityShifts,
    applyRepoShift,
    runSimulationSuite,
    simulatePhi,
    simulateScenario,
    stratifiedBootstrapT,
    studentTCdf,
    studentTQuantile,
    trueMeanFor,
    utilityFromDelta,
    type OutcomeRecord,
    type Scenario,
    type ScenarioResult,
} from "../../../scripts/stats/retrieval-holdout-v2.js";

describe("utilityFromDelta (owner G-2L)", () => {
    it("maps win/tie/loss to +1/0/-2", () => {
        expect(utilityFromDelta(1)).toBe(1);
        expect(utilityFromDelta(0)).toBe(0);
        expect(utilityFromDelta(-1)).toBe(-2);
    });
});

describe("buildInstanceUtilities", () => {
    const a5: OutcomeRecord[] = [
        { instanceId: "i1", formulation: "title", successAt5: true },
        { instanceId: "i1", formulation: "body", successAt5: false },
        { instanceId: "i2", formulation: "title", successAt5: false },
        { instanceId: "i2", formulation: "body", successAt5: true },
    ];
    const a0: OutcomeRecord[] = [
        { instanceId: "i1", formulation: "title", successAt5: false },
        { instanceId: "i1", formulation: "body", successAt5: true },
        { instanceId: "i2", formulation: "title", successAt5: false },
        { instanceId: "i2", formulation: "body", successAt5: false },
    ];

    it("computes hand-checked instance utilities", () => {
        const out = buildInstanceUtilities(a5, a0);
        // i1: title d=+1 -> u=1, body d=-1 -> u=-2 => mean -0.5
        // i2: title d=0, body d=+1 => mean +0.5
        expect(out.instances).toHaveLength(2);
        expect(out.instances[0]).toMatchObject({ instanceId: "i1", u: -0.5 });
        expect(out.instances[1]).toMatchObject({ instanceId: "i2", u: 0.5 });
        expect(out.deltas).toHaveLength(4);
        expect(out.excluded).toEqual([]);
        expect(out.unmatched).toEqual([]);
    });

    it("honors pre-run exclusions before pairing", () => {
        const out = buildInstanceUtilities(a5, a0, ["i2"]);
        expect(out.excluded).toEqual(["i2"]);
        expect(out.instances.map((x) => x.instanceId)).toEqual(["i1"]);
        expect(out.deltas).toHaveLength(2);
    });

    it("averages over formulations present when one formulation is missing", () => {
        const onlyBody5: OutcomeRecord[] = [{ instanceId: "i3", formulation: "body", successAt5: true }];
        const onlyBody0: OutcomeRecord[] = [{ instanceId: "i3", formulation: "body", successAt5: false }];
        const out = buildInstanceUtilities(onlyBody5, onlyBody0);
        expect(out.instances).toHaveLength(1);
        expect(out.instances[0]).toMatchObject({ instanceId: "i3", u: 1, formulations: ["body"] });
        expect(out.unmatched).toEqual([]);
    });

    it("excludes an instance with no shared formulation and discloses unmatched", () => {
        const five5: OutcomeRecord[] = [{ instanceId: "i5", formulation: "title", successAt5: true }];
        const five0: OutcomeRecord[] = [{ instanceId: "i5", formulation: "body", successAt5: true }];
        const out = buildInstanceUtilities(five5, five0);
        expect(out.instances).toEqual([]);
        expect(out.excluded).toEqual(["i5"]);
        expect(out.unmatched).toEqual(["i5 body", "i5 title"]);
        expect(out.unmatchedInstanceIds).toEqual(["i5"]);
    });

    it("discloses a formulation present in only one arm", () => {
        const partial5: OutcomeRecord[] = [
            { instanceId: "i6", formulation: "title", successAt5: true },
            { instanceId: "i6", formulation: "body", successAt5: true },
        ];
        const partial0: OutcomeRecord[] = [
            { instanceId: "i6", formulation: "title", successAt5: false },
        ];
        const out = buildInstanceUtilities(partial5, partial0);
        expect(out.instances).toHaveLength(1);
        expect(out.instances[0]).toMatchObject({ instanceId: "i6", u: 1, formulations: ["title"] });
        expect(out.unmatched).toEqual(["i6 body"]);
        expect(out.unmatchedInstanceIds).toEqual(["i6"]);
    });
});

describe("pairedTTest (hand-computed)", () => {
    it("matches a hand-computed n=4 case", () => {
        // values: 0.5, -0.25, 0.75, 0 -> mean .25, sum sq dev .625,
        // s = sqrt(.625/3), se = s/2, t = 1.0954451150, df = 3.
        const r = pairedTTest([0.5, -0.25, 0.75, 0]);
        expect(r.n).toBe(4);
        expect(r.mean).toBeCloseTo(0.25, 12);
        expect(r.sd).toBeCloseTo(0.4564354642, 9);
        expect(r.se).toBeCloseTo(0.2282177321, 9);
        expect(r.t).toBeCloseTo(1.0954451150, 9);
        expect(r.df).toBe(3);
        // F_df=3(t) via closed form: F(1.0954451150) = 0.8232577 => one-sided p ~ 0.1767423
        expect(r.pOneSided).toBeCloseTo(0.1767423, 3);
        // LB = .25 - t_{.95,3} * se = .25 - 2.353363 * .2282177 = -0.2870792
        expect(r.lowerBound95).toBeCloseTo(-0.2870792, 6);
        expect(r.rejectAt05).toBe(false);
    });

    it("rejects and gives a positive lower bound on a strong positive case", () => {
        // values: 1, 1, 0, 1, 0.5 -> mean .7, sum sq dev .8, s = sqrt(.2),
        // se = .2, t = 3.5, df = 4, t_{.95,4} = 2.131847,
        // LB = .7 - 2.131847*.2 = 0.2736306.
        const r = pairedTTest([1, 1, 0, 1, 0.5]);
        expect(r.mean).toBeCloseTo(0.7, 12);
        expect(r.sd).toBeCloseTo(0.4472135955, 9);
        expect(r.t).toBeCloseTo(3.5, 10);
        expect(r.lowerBound95).toBeCloseTo(0.2736306, 6);
        // two-sided 95%: .7 - t_{.975,4}*se = .7 - 2.776445*.2 = 0.1447110
        expect(r.ci95Low).toBeCloseTo(0.1447110, 6);
        expect(r.rejectAt05).toBe(true);
        expect(r.pOneSided).toBeGreaterThan(0);
        expect(r.pOneSided).toBeLessThan(0.05);
    });

    it("handles zero-variance inputs without NaN", () => {
        const pos = pairedTTest([2, 2]);
        expect(pos.t).toBe(Number.POSITIVE_INFINITY);
        expect(pos.pOneSided).toBe(0);
        expect(pos.lowerBound95).toBe(2);
        expect(pos.rejectAt05).toBe(true);
        const zero = pairedTTest([0, 0]);
        expect(zero.pOneSided).toBe(1);
        expect(zero.rejectAt05).toBe(false);
        const neg = pairedTTest([-1, -1]);
        expect(neg.pOneSided).toBe(1);
        expect(neg.rejectAt05).toBe(false);
    });

    it("rejects n < 2", () => {
        expect(() => pairedTTest([1])).toThrow();
    });
});

describe("t distribution and probit", () => {
    it("matches table quantiles", () => {
        expect(studentTQuantile(0.95, 3)).toBeCloseTo(2.353363, 3);
        expect(studentTQuantile(0.975, 4)).toBeCloseTo(2.776445, 3);
        expect(studentTQuantile(0.95, 399)).toBeCloseTo(1.648718, 2);
        expect(studentTQuantile(0.975, 399)).toBeCloseTo(1.965927, 2);
    });

    it("matches known CDF values", () => {
        expect(studentTCdf(0, 10)).toBeCloseTo(0.5, 12);
        expect(studentTCdf(2.353363, 3)).toBeCloseTo(0.95, 3);
        // Cauchy (df=1) closed form: F(-1) = 0.25
        expect(studentTCdf(-1, 1)).toBeCloseTo(0.25, 6);
        expect(studentTCdf(Number.POSITIVE_INFINITY, 3)).toBe(1);
    });

    it("inverts the normal CDF", () => {
        expect(probit(0.5)).toBeCloseTo(0, 9);
        expect(probit(0.975)).toBeCloseTo(1.959963985, 5);
        expect(probit(0.9)).toBeCloseTo(1.281551566, 5);
        expect(probit(0.1)).toBeCloseTo(-1.281551566, 5);
    });
});

describe("PRNG determinism", () => {
    it("mulberry32 is reproducible and in range", () => {
        const a = mulberry32(42);
        const b = mulberry32(42);
        const c = mulberry32(43);
        const seqA = Array.from({ length: 5 }, () => a());
        const seqB = Array.from({ length: 5 }, () => b());
        const seqC = Array.from({ length: 5 }, () => c());
        expect(seqA).toEqual(seqB);
        expect(seqA).not.toEqual(seqC);
        for (const v of seqA) {
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThan(1);
        }
    });

    it("Box-Muller randn is reproducible", () => {
        const r1 = makeRandn(mulberry32(7));
        const r2 = makeRandn(mulberry32(7));
        const s1 = Array.from({ length: 10 }, () => r1());
        const s2 = Array.from({ length: 10 }, () => r2());
        expect(s1).toEqual(s2);
        expect(new Set(s1).size).toBe(10);
        for (const v of s1) expect(Number.isFinite(v)).toBe(true);
    });
});

describe("marginals and repo shifts", () => {
    it("null marginals satisfy P(win) = 2 P(loss) and mu = 0 exactly", () => {
        const [t, b] = nullMarginals(0.15625);
        expect(t.pWin).toBeCloseTo(2 * t.pLoss, 15);
        expect(t.pWin - 2 * t.pLoss).toBeCloseTo(0, 15);
        expect(t.pWin + t.pLoss).toBeCloseTo(0.15625, 15);
        expect(b).toEqual(t);
    });

    it("powerMargins(1) reproduces the dev marginals exactly", () => {
        const [t, b] = powerMargins(1);
        expect(t.pWin).toBeCloseTo(9 / 64, 12);
        expect(t.pLoss).toBeCloseTo(1 / 64, 12);
        expect(b.pWin).toBeCloseTo(7 / 64, 12);
        expect(b.pLoss).toBeCloseTo(3 / 64, 12);
        const muTitle = t.pWin - 2 * t.pLoss;
        const muBody = b.pWin - 2 * b.pLoss;
        expect((muTitle + muBody) / 2).toBeCloseTo(DEV_CALIBRATION.meanU, 12);
    });

    it("powerMargins(0.5) halves each formulation's effect at fixed discordance", () => {
        const [t, b] = powerMargins(0.5);
        expect(t.pWin + t.pLoss).toBeCloseTo(9 / 64 + 1 / 64, 12);
        expect(b.pWin + b.pLoss).toBeCloseTo(7 / 64 + 3 / 64, 12);
        expect(t.pWin - 2 * t.pLoss).toBeCloseTo((9 / 64 - 2 / 64) / 2, 12);
        expect(trueMeanFor(0.5)).toBeCloseTo(0.03125, 12);
    });

    it("repo shifts have census-weighted mean exactly 0 and stay in bounds", () => {
        for (const d of [0.078, 0.15625, 0.313]) {
            const shifts = repoUtilityShifts(d, TOTAL_N);
            expect(shifts).toHaveLength(5);
            let wmean = 0;
            for (let i = 0; i < shifts.length; i++) {
                wmean += (REPO_COMPOSITION[i]! / TOTAL_N) * shifts[i]!;
            }
            expect(wmean).toBeCloseTo(0, 12);
            for (const s of shifts) {
                const base = nullMarginals(d)[0];
                const shifted = applyRepoShift(base, s);
                // G-2L mean of shifted marginals = 0 + s
                expect(shifted.pWin - 2 * shifted.pLoss).toBeCloseTo(s, 12);
                expect(shifted.pWin + shifted.pLoss).toBeCloseTo(d, 12);
            }
        }
    });

    it("clustering requires the frozen composition size", () => {
        expect(() => repoUtilityShifts(0.1, TOTAL_N - 1)).toThrow();
    });
});

describe("dependence calibration", () => {
    it("returns exact 0 for target phi 0", () => {
        expect(calibrateLatentRho(nullMarginals(0.15625), 0)).toBe(0);
    });

    it("recovers the target phi within Monte Carlo error (deterministic)", () => {
        const margins = nullMarginals(DEV_CALIBRATION.discordance);
        const rho1 = calibrateLatentRho(margins, DEV_CALIBRATION.targetPhi);
        const rho2 = calibrateLatentRho(margins, DEV_CALIBRATION.targetPhi);
        expect(rho1).toBe(rho2); // deterministic
        expect(rho1).toBeGreaterThan(-0.95);
        expect(rho1).toBeLessThan(0.95);
        const achieved = simulatePhi(rho1, margins, 50000, BASE_SEED + 777);
        expect(achieved).toBeCloseTo(DEV_CALIBRATION.targetPhi, 2);
    });
});

describe("simulateScenario determinism and structure", () => {
    const toy: Scenario = {
        id: "toy-null",
        kind: "null",
        n: 40,
        mu: 0,
        margins: nullMarginals(0.15625),
        discordance: 0.15625,
        clustering: false,
        latentRho: 0,
    };

    it("is fully deterministic for a fixed seed", () => {
        const r1 = simulateScenario(toy, 500, 12345);
        const r2 = simulateScenario(toy, 500, 12345);
        expect(r1).toEqual(r2);
        expect(r1.reps).toBe(500);
        expect(r1.rejectRate).toBeGreaterThanOrEqual(0);
        expect(r1.rejectRate).toBeLessThanOrEqual(1);
        expect(r1.coverage2).toBeGreaterThanOrEqual(0);
        expect(r1.coverageLB).toBeLessThanOrEqual(1);
    });

    it("different seeds give different streams", () => {
        const r1 = simulateScenario(toy, 500, 12345);
        const r3 = simulateScenario(toy, 500, 12346);
        expect(r3.meanEstimate).not.toBe(r1.meanEstimate);
    });

    it("runs a clustered n=400 scenario", () => {
        const clustered: Scenario = {
            id: "toy-cluster",
            kind: "null",
            n: TOTAL_N,
            mu: 0,
            margins: nullMarginals(0.313),
            discordance: 0.313,
            clustering: true,
            latentRho: 0,
        };
        const r = simulateScenario(clustered, 50, 99);
        expect(r.reps).toBe(50);
        expect(r.rejectRate).toBeGreaterThanOrEqual(0);
        expect(r.rejectRate).toBeLessThanOrEqual(1);
        expect(r.meanEstimate).toBeGreaterThanOrEqual(-2);
        expect(r.meanEstimate).toBeLessThanOrEqual(1);
    });
});

describe("stratifiedBootstrapT (prereg §6.1 alternative)", () => {
    it("rejects a zero-variance positive signal with p = 1/(B+1)", () => {
        const strata = [new Float64Array([1, 1, 1, 1]), new Float64Array([1, 1])];
        const r = stratifiedBootstrapT(strata, 1, Number.POSITIVE_INFINITY, 199, mulberry32(5));
        expect(r.pValue).toBeCloseTo(1 / 200, 10);
        expect(r.reject).toBe(true);
        expect(r.q95).toBe(0);
    });

    it("never rejects a strong negative signal", () => {
        const strata = [new Float64Array([-1, -1, -1, -1])];
        const r = stratifiedBootstrapT(strata, -1, Number.NEGATIVE_INFINITY, 99, mulberry32(5));
        expect(r.pValue).toBe(1);
        expect(r.reject).toBe(false);
    });

    it("is deterministic and returns ordered quantiles", () => {
        const vals = Float64Array.from(
            { length: 40 },
            (_, i) => (i % 5 === 0 ? -2 : i % 3 === 0 ? 1 : 0),
        );
        const strata = [vals.subarray(0, 20), vals.subarray(20, 40)];
        let mean = 0;
        for (const v of vals) mean += v;
        mean /= vals.length;
        let ss = 0;
        for (const v of vals) ss += (v - mean) ** 2;
        const tObs = mean / (Math.sqrt(ss / (vals.length - 1)) / Math.sqrt(vals.length));
        const r1 = stratifiedBootstrapT(strata, mean, tObs, 199, mulberry32(9));
        const r2 = stratifiedBootstrapT(strata, mean, tObs, 199, mulberry32(9));
        expect(r1).toEqual(r2);
        expect(r1.q025).toBeLessThanOrEqual(r1.q95);
        expect(r1.q95).toBeLessThanOrEqual(r1.q975);
        expect(r1.pValue).toBeGreaterThan(0);
        expect(r1.pValue).toBeLessThanOrEqual(1);
        expect(typeof r1.reject).toBe("boolean");
    });

    it("runs as the simulateScenario procedure, deterministically", () => {
        const toy: Scenario = {
            id: "toy-boot",
            kind: "null",
            n: 40,
            mu: 0,
            margins: nullMarginals(0.15625),
            discordance: 0.15625,
            clustering: false,
            latentRho: 0,
        };
        const opts = { procedure: "bootstrap-t" as const, bootstrapB: 49 };
        const r1 = simulateScenario(toy, 50, 12345, opts);
        const r2 = simulateScenario(toy, 50, 12345, opts);
        expect(r1).toEqual(r2);
        expect(r1.procedure).toBe("bootstrap-t");
        expect(r1.rejectRate).toBeGreaterThanOrEqual(0);
        expect(r1.rejectRate).toBeLessThanOrEqual(1);
        expect(r1.coverage2).toBeGreaterThanOrEqual(0);
        expect(r1.coverage2).toBeLessThanOrEqual(1);
    });
});

describe("suite grid and pass evaluation", () => {
    it("builds the prereg 12 null + 4 power grid", () => {
        const scenarios = buildScenarios();
        expect(scenarios).toHaveLength(16);
        expect(new Set(scenarios.map((s) => s.id)).size).toBe(16);
        const nulls = scenarios.filter((s) => s.kind === "null");
        const powers = scenarios.filter((s) => s.kind === "power");
        expect(nulls).toHaveLength(12);
        expect(powers).toHaveLength(4);
        for (const s of nulls) {
            expect(s.mu).toBe(0);
            expect(s.margins[0].pWin).toBeCloseTo(2 * s.margins[0].pLoss, 15);
        }
        expect(powers.map((p) => p.mu).sort((a, b) => a - b))
            .toEqual([0.03125, 0.03125, 0.0625, 0.0625]);
        expect(scenarios.filter((s) => s.clustering)).toHaveLength(8);
    });

    it("implements the prereg pass rule", () => {
        const ok: ScenarioResult[] = [
            { id: "a", kind: "null", procedure: "t", reps: 10, n: 400, mu: 0, rejectRate: 0.05, rejectMcse: 0.0218, coverage2: 0.95, coverage2Mcse: 0.0218, coverageLB: 0.95, meanEstimate: 0 },
            { id: "b", kind: "power", procedure: "t", reps: 10, n: 400, mu: 0.0625, rejectRate: 0.9, rejectMcse: 0.0949, coverage2: 0.94, coverage2Mcse: 0.0774, coverageLB: 0.96, meanEstimate: 0.062 },
        ];
        expect(evaluatePass(ok)).toEqual({ pass: true, failures: [] });

        const type1Bad = [{ ...ok[0]!, rejectRate: PASS_TYPE1_MAX + 0.001 }];
        const r1 = evaluatePass(type1Bad);
        expect(r1.pass).toBe(false);
        expect(r1.failures[0]).toContain("type I");

        const covBad = [{ ...ok[1]!, coverage2: PASS_COVERAGE_MIN - 0.001 }];
        const r2 = evaluatePass(covBad);
        expect(r2.pass).toBe(false);
        expect(r2.failures[0]).toContain("coverage");
    });

    it("suite is seeded and reproducible on a tiny rep count", () => {
        const out = runSimulationSuite({ reps: 5, baseSeed: 1 });
        expect(out.rows).toHaveLength(16);
        expect(out.reps).toBe(5);
        expect(out.baseSeed).toBe(1);
        for (const r of out.rows) expect(r.reps).toBe(5);
        const again = runSimulationSuite({ reps: 5, baseSeed: 1 });
        expect(again.rows).toEqual(out.rows);
    });

    it("nullOnly keeps exactly the 12 null rows with unchanged seeds", () => {
        const full = runSimulationSuite({ reps: 5, baseSeed: 1 });
        const nulls = runSimulationSuite({ reps: 5, baseSeed: 1, nullOnly: true });
        expect(nulls.rows).toHaveLength(12);
        expect(nulls.rows.every((r) => r.kind === "null")).toBe(true);
        expect(nulls.rows).toEqual(full.rows.filter((r) => r.kind === "null"));
        expect(nulls.pass).toBe(full.pass);
    });

    it("reports Monte Carlo standard errors on every row", () => {
        const sc = buildScenarios()[0]!;
        const r = simulateScenario(sc, 500, 7, { procedure: "t" });
        expect(r.rejectMcse).toBeCloseTo(
            Math.sqrt(r.rejectRate * (1 - r.rejectRate) / 500), 12);
        expect(r.coverage2Mcse).toBeCloseTo(
            Math.sqrt(r.coverage2 * (1 - r.coverage2) / 500), 12);
    });

    it("freezes the production bootstrap B at 1999 (prereg §9 amendment)", () => {
        expect(BOOTSTRAP_B).toBe(1999);
    });
});

describe("analyzeReports reporting tables", () => {
    it("produces hand-checked per-formulation and per-repo summaries", () => {
        const a5: OutcomeRecord[] = [
            { instanceId: "svelte-a", formulation: "title", successAt5: true },
            { instanceId: "svelte-a", formulation: "body", successAt5: true },
            { instanceId: "mui-b", formulation: "title", successAt5: false },
            { instanceId: "mui-b", formulation: "body", successAt5: true },
        ];
        const a0: OutcomeRecord[] = [
            { instanceId: "svelte-a", formulation: "title", successAt5: false },
            { instanceId: "svelte-a", formulation: "body", successAt5: false },
            { instanceId: "mui-b", formulation: "title", successAt5: true },
            { instanceId: "mui-b", formulation: "body", successAt5: false },
        ];
        const repoOf = (id: string): string => (id.startsWith("svelte") ? "svelte" : "mui");
        const out = analyzeReports(a5, a0, {
            expectedInstanceIds: ["svelte-a", "mui-b"],
            repoOf,
        });
        expect(out.build.instances).toHaveLength(2);
        const title = out.perFormulation.find((x) => x.formulation === "title");
        expect(title).toMatchObject({ n: 2, wins: 1, losses: 1, ties: 0, meanD: 0 });
        const body = out.perFormulation.find((x) => x.formulation === "body");
        expect(body).toMatchObject({ n: 2, wins: 2, losses: 0, ties: 0, meanD: 1 });
        expect(out.perRepo).toHaveLength(2);
        const svelte = out.perRepo!.find((x) => x.repo === "svelte");
        expect(svelte).toMatchObject({ n: 1, wins: 2, losses: 0, ties: 0, meanTitleD: 1 });
        const mui = out.perRepo!.find((x) => x.repo === "mui");
        expect(mui).toMatchObject({ n: 1, wins: 1, losses: 1, meanTitleD: -1 });
        // u: svelte-a = (1+1)/2 = 1; mui-b = (-2+1)/2 = -0.5 => mean 0.25
        expect(out.test.mean).toBeCloseTo(0.25, 12);
    });

    it("omits per-repo table without a repo map", () => {
        const out = analyzeReports(
            [
                { instanceId: "x", formulation: "title", successAt5: true },
                { instanceId: "y", formulation: "title", successAt5: false },
            ],
            [
                { instanceId: "x", formulation: "title", successAt5: false },
                { instanceId: "y", formulation: "title", successAt5: false },
            ],
            { expectedInstanceIds: ["x", "y"] },
        );
        expect(out.perRepo).toBeNull();
        expect(out.test.n).toBe(2);
        // No repo map: no repo-clustered sensitivities (prereg §4.1).
        expect(out.clusterRobust).toBeNull();
        expect(out.leaveOneRepoOut).toEqual([]);
        expect(out.attrition.instanceIds).toEqual([]);
        expect(out.attrition.atWorstMinus2.imputedCount).toBe(0);
        expect(out.attrition.atWorstMinus2.test.mean).toBe(out.test.mean);
        expect(out.attrition.atZero.test.mean).toBe(out.test.mean);
    });
});

describe("expected instance id list — attrition completeness (reviewer P1)", () => {
    const fullArm = (): { a5: OutcomeRecord[]; a0: OutcomeRecord[] } => ({
        a5: [
            { instanceId: "i1", formulation: "title", successAt5: true },
            { instanceId: "i1", formulation: "body", successAt5: true },
            { instanceId: "i2", formulation: "title", successAt5: false },
            { instanceId: "i2", formulation: "body", successAt5: false },
        ],
        a0: [
            { instanceId: "i1", formulation: "title", successAt5: false },
            { instanceId: "i1", formulation: "body", successAt5: false },
            { instanceId: "i2", formulation: "title", successAt5: true },
            { instanceId: "i2", formulation: "body", successAt5: false },
        ],
    });

    it("treats an expected id missing from BOTH arm reports as attrited", () => {
        const { a5, a0 } = fullArm();
        const out = analyzeReports(a5, a0, {
            expectedInstanceIds: ["i1", "i2", "lost-both"],
        });
        // Primary set unaffected: the id is invisible to the outcome records.
        expect(out.build.excluded).toEqual([]);
        expect(out.test.n).toBe(2);
        // u_i1 = mean(+1, +1) = 1; u_i2 = mean(−2, 0) = −1 → ū = 0.
        expect(out.test.mean).toBeCloseTo(0, 12);
        // …but the id IS attrited into both §2.3 sensitivities.
        expect(out.attrition.instanceIds).toEqual(["lost-both"]);
        expect(out.attrition.atWorstMinus2.imputedCount).toBe(1);
        expect(out.attrition.atWorstMinus2.n).toBe(3);
        // Hand: values [1, −1, −2] → mean −2/3; ss = 14/3, s² = 7/3,
        // se = sqrt(7)/3 → t = (−2/3)/(sqrt(7)/3) = −2/sqrt(7).
        expect(out.attrition.atWorstMinus2.test.mean).toBeCloseTo(-2 / 3, 12);
        expect(out.attrition.atWorstMinus2.test.t).toBeCloseTo(-2 / Math.sqrt(7), 9);
        expect(out.attrition.atWorstMinus2.test.rejectAt05).toBe(false);
        expect(out.attrition.atZero.imputedCount).toBe(1);
        expect(out.attrition.atZero.n).toBe(3);
        // Hand: values [1, −1, 0] → mean 0, s² = 1, t = 0.
        expect(out.attrition.atZero.test.mean).toBeCloseTo(0, 12);
        expect(out.attrition.atZero.test.t).toBeCloseTo(0, 12);
        expect(out.attrition.atZero.test.rejectAt05).toBe(false);
    });

    it("treats an expected id missing from ONE arm report as attrited", () => {
        const { a5, a0 } = fullArm();
        a5.push({ instanceId: "ghost-one", formulation: "title", successAt5: true });
        const out = analyzeReports(a5, a0, {
            expectedInstanceIds: ["i1", "i2", "ghost-one"],
        });
        expect(out.test.n).toBe(2);
        expect(out.attrition.instanceIds).toEqual(["ghost-one"]);
        expect(out.attrition.atWorstMinus2.imputedCount).toBe(1);
        expect(out.attrition.atWorstMinus2.n).toBe(3);
        expect(out.attrition.atZero.imputedCount).toBe(1);
        expect(out.attrition.atZero.n).toBe(3);
    });

    it("rejects an outcome id outside the frozen expected list", () => {
        const { a5, a0 } = fullArm();
        a5.push({ instanceId: "stray", formulation: "title", successAt5: true });
        expect(() => analyzeReports(a5, a0, { expectedInstanceIds: ["i1", "i2"] }))
            .toThrow("outcome instance id not in expected list: stray");
        const { a5: a5b, a0: a0b } = fullArm();
        a0b.push({ instanceId: "stray", formulation: "body", successAt5: false });
        expect(() => analyzeReports(a5b, a0b, { expectedInstanceIds: ["i1", "i2"] }))
            .toThrow("outcome instance id not in expected list: stray");
    });

    it("fails closed when the expected id list is missing or empty", () => {
        const { a5, a0 } = fullArm();
        const noList = {} as Parameters<typeof analyzeReports>[2];
        expect(() => analyzeReports(a5, a0, noList)).toThrow(
            "analyzeReports requires the frozen expected instance id list");
        expect(() => analyzeReports(a5, a0, { expectedInstanceIds: [] })).toThrow(
            "analyzeReports requires the frozen expected instance id list");
    });
});

// Hand fixture for the §2.3/§4.1 tests (prereg §9 amendment):
//   svelte-a: d title +1, body +1 -> u = 1
//   svelte-b: d title  0, body  0 -> u = 0
//   mui-c:    d title -1, body +1 -> u = -0.5
//   mui-d:    d title  0, body +1 -> u = 0.5
//   prun-x:   pre-run invalid (excluded before matching)
//   ghost-x:  A5-only instance (excluded + unmatched)
const AUDIT_A5: OutcomeRecord[] = [
    { instanceId: "svelte-a", formulation: "title", successAt5: true },
    { instanceId: "svelte-a", formulation: "body", successAt5: true },
    { instanceId: "svelte-b", formulation: "title", successAt5: false },
    { instanceId: "svelte-b", formulation: "body", successAt5: false },
    { instanceId: "mui-c", formulation: "title", successAt5: false },
    { instanceId: "mui-c", formulation: "body", successAt5: true },
    { instanceId: "mui-d", formulation: "title", successAt5: false },
    { instanceId: "mui-d", formulation: "body", successAt5: true },
    { instanceId: "prun-x", formulation: "title", successAt5: true },
    { instanceId: "ghost-x", formulation: "title", successAt5: true },
];
const AUDIT_A0: OutcomeRecord[] = [
    { instanceId: "svelte-a", formulation: "title", successAt5: false },
    { instanceId: "svelte-a", formulation: "body", successAt5: false },
    { instanceId: "svelte-b", formulation: "title", successAt5: false },
    { instanceId: "svelte-b", formulation: "body", successAt5: false },
    { instanceId: "mui-c", formulation: "title", successAt5: true },
    { instanceId: "mui-c", formulation: "body", successAt5: false },
    { instanceId: "mui-d", formulation: "title", successAt5: false },
    { instanceId: "mui-d", formulation: "body", successAt5: false },
    { instanceId: "prun-x", formulation: "title", successAt5: false },
];
const auditRepoOf = (id: string) => (id.startsWith("svelte") ? "svelte" : "mui");
const auditReport = () => analyzeReports(AUDIT_A5, AUDIT_A0, {
    expectedInstanceIds: [
        "svelte-a", "svelte-b", "mui-c", "mui-d", "prun-x", "ghost-x",
    ],
    excludedInstanceIds: ["prun-x"],
    repoOf: auditRepoOf,
});

describe("per-repo reporting tables (pooled + per formulation, §4.1)", () => {
    it("reports pooled and per-formulation W/L/T per repository", () => {
        const out = auditReport();
        expect(out.perRepo).not.toBeNull();
        expect(out.perRepo!.map((r) => r.repo)).toEqual(["mui", "svelte"]);
        expect(out.perRepo![0]).toEqual({
            repo: "mui",
            n: 2,
            meanU: 0,
            wins: 2,
            losses: 1,
            ties: 1,
            meanTitleD: -0.5,
            byFormulation: [
                { formulation: "body", n: 2, wins: 2, losses: 0, ties: 0, meanD: 1 },
                { formulation: "title", n: 2, wins: 0, losses: 1, ties: 1, meanD: -0.5 },
            ],
        });
        expect(out.perRepo![1]).toEqual({
            repo: "svelte",
            n: 2,
            meanU: 0.5,
            wins: 2,
            losses: 0,
            ties: 2,
            meanTitleD: 0.5,
            byFormulation: [
                { formulation: "body", n: 2, wins: 1, losses: 0, ties: 1, meanD: 0.5 },
                { formulation: "title", n: 2, wins: 1, losses: 0, ties: 1, meanD: 0.5 },
            ],
        });
    });

    it("reports the CR1 cluster-robust SE (sensitivity, not primary)", () => {
        const out = auditReport();
        // clusters (repo-sorted): mui [-0.5, 0.5], svelte [1, 0];
        // mean = 0.25; cluster residual sums = -0.5 and +0.5;
        // var = G/(G-1) * (1/n^2) * sum S_g^2 = 2 * 0.5 / 16 = 0.0625;
        // seCr1 = 0.25, t = 1, df = G-1 = 1.
        expect(out.clusterRobust).toEqual({
            clusters: 2,
            n: 4,
            mean: 0.25,
            seCr1: 0.25,
            t: 1,
            df: 1,
            lowerBound95: 0.25 - studentTQuantile(0.95, 1) * 0.25,
        });
    });

    it("reports leave-one-repo-out estimates for every repository", () => {
        const out = auditReport();
        expect(out.leaveOneRepoOut.map((r) => r.omittedRepo)).toEqual(["mui", "svelte"]);
        // omit mui -> u = [1, 0]: mean 0.5, se 0.5, t = 1, df = 1 (p = 0.25).
        const omitMui = out.leaveOneRepoOut[0]!.test!;
        expect(omitMui.n).toBe(2);
        expect(omitMui.mean).toBeCloseTo(0.5, 12);
        expect(omitMui.t).toBeCloseTo(1, 10);
        expect(omitMui.pOneSided).toBeCloseTo(0.25, 6);
        expect(omitMui.rejectAt05).toBe(false);
        // omit svelte -> u = [-0.5, 0.5]: mean 0, se 0.5, t = 0 (p = 0.5).
        const omitSvelte = out.leaveOneRepoOut[1]!.test!;
        expect(omitSvelte.n).toBe(2);
        expect(omitSvelte.mean).toBeCloseTo(0, 12);
        expect(omitSvelte.t).toBeCloseTo(0, 10);
        expect(omitSvelte.pOneSided).toBeCloseTo(0.5, 6);
        expect(omitSvelte.rejectAt05).toBe(false);
    });
});

describe("attrition sensitivity and degradation guards (§2.3/§4.1)", () => {
    it("imputes excluded+unmatched instances at u=-2 and u=0 (reporting only)", () => {
        const out = auditReport();
        // distinct ids in excluded {ghost-x, prun-x} ∪ unmatched {ghost-x}
        expect(out.attrition.instanceIds).toEqual(["ghost-x", "prun-x"]);
        expect(out.test.n).toBe(4);
        expect(out.test.mean).toBeCloseTo(0.25, 12);

        const worst = out.attrition.atWorstMinus2;
        expect(worst.imputedUtility).toBe(-2);
        expect(worst.imputedCount).toBe(2);
        expect(worst.n).toBe(6);
        // values [1, 0, -0.5, 0.5, -2, -2]: mean -3/6 = -0.5, sum sq dev = 8.
        expect(worst.test.mean).toBeCloseTo(-0.5, 12);
        expect(worst.test.se).toBeCloseTo(Math.sqrt(8 / 30), 12);
        expect(worst.test.t).toBeCloseTo(-0.9682458366, 8);
        expect(worst.test.df).toBe(5);
        expect(worst.test.rejectAt05).toBe(false);

        const zero = out.attrition.atZero;
        expect(zero.imputedUtility).toBe(0);
        expect(zero.imputedCount).toBe(2);
        expect(zero.n).toBe(6);
        // values [1, 0, -0.5, 0.5, 0, 0]: mean 1/6, sum sq dev = 4/3.
        expect(zero.test.mean).toBeCloseTo(1 / 6, 12);
        expect(zero.test.se).toBeCloseTo(Math.sqrt(4 / 90), 12);
        expect(zero.test.t).toBeCloseTo(0.790569415, 8);
        expect(zero.test.rejectAt05).toBe(false);
    });

    it("clusterRobustMean and leaveOneRepoOut degrade safely", () => {
        expect(clusterRobustMean([])).toBeNull();
        expect(clusterRobustMean([[1, 2]])).toBeNull();
        // zero within-cluster variance: SE 0, infinite t, LB collapses to mean.
        const flat = clusterRobustMean([[1, 1], [1, 1]])!;
        expect(flat.seCr1).toBe(0);
        expect(flat.t).toBe(Infinity);
        expect(flat.lowerBound95).toBe(1);
        // a single repo yields no leave-one-repo-out rows.
        const singleRepo = buildInstanceUtilities(
            [{ instanceId: "only-1", formulation: "title", successAt5: true }],
            [{ instanceId: "only-1", formulation: "title", successAt5: false }],
            [],
        );
        expect(leaveOneRepoOut(singleRepo.instances, () => "only")).toEqual([]);
    });

    it("attritionSensitivity with zero imputations reproduces the primary test", () => {
        const base = [1, 0, -0.5, 0.5];
        const primary = pairedTTest(base);
        const same = attritionSensitivity(base, 0, -2);
        expect(same.imputedCount).toBe(0);
        expect(same.n).toBe(4);
        expect(same.test.mean).toBe(primary.mean);
        expect(same.test.t).toBe(primary.t);
        // one u=0 imputation: values [1, 0, -0.5, 0.5, 0] -> mean 0.2.
        const one = attritionSensitivity(base, 1, 0);
        expect(one.n).toBe(5);
        expect(one.test.mean).toBeCloseTo(0.2, 12);
    });
});

describe("composition override (--composition, prereg §9.7)", () => {
    it("parses a comma-separated split summing to the declared n", () => {
        expect(parseComposition("210,120,40,20,10")).toEqual([210, 120, 40, 20, 10]);
        expect(parseComposition("205, 128, 37, 22, 8")).toEqual([...REPO_COMPOSITION]);
        // n derives from the composition: TOTAL_N is the composition's sum.
        expect(TOTAL_N).toBe(REPO_COMPOSITION.reduce((a, b) => a + b, 0));
        expect(TOTAL_N).toBe(400);
    });

    it("rejects non-integers, non-positive values, k < 2, and sum ≠ declared n", () => {
        expect(() => parseComposition("1.5,398.5")).toThrow(/positive integers/);
        expect(() => parseComposition("0,400")).toThrow(/positive integers/);
        expect(() => parseComposition("-5,405")).toThrow(/positive integers/);
        expect(() => parseComposition("abc,400")).toThrow(/positive integers/);
        expect(() => parseComposition("400")).toThrow(/at least 2 repos/);
        expect(() => parseComposition("")).toThrow(/at least 2 repos/);
        expect(() => parseComposition("100,50,50"))
            .toThrow(/sum to the declared n=400, got sum=200/);
        // the same declared-n guard fires at scenario build time and in direct API use
        expect(() => assertComposition([100, 50, 50], 400)).toThrow(/sum to the declared n/);
        expect(() => assertComposition([100, 50, 50])).toThrow(/sum to the declared n/);
        expect(() => assertComposition([200, 200])).not.toThrow();
        expect(() => buildScenarios([100, 50, 50])).toThrow(/sum to the declared n/);
    });

    it("repoDelta reproduces the frozen pattern at the census split and generalises to k", () => {
        // frozen prereg §6.2 pattern [+1, +1, −1, −1, −1] (205, 128 ≥ 80 > 37, 22, 8)
        expect(repoDelta(REPO_COMPOSITION)).toEqual([1, 1, -1, -1, -1]);
        expect(repoDelta([300, 100])).toEqual([1, -1]);
        expect(repoDelta([150, 150, 100])).toEqual([1, 1, -1]);
        // equal counts: all signs would coincide -> alternating fallback
        expect(repoDelta([100, 100, 100, 100])).toEqual([1, -1, 1, -1]);
    });

    it("repo effects keep the census-weighted mean exactly 0 (hand cases)", () => {
        const d = 0.15625;
        // hand case [300,100]: w-bar = 0.75 - 0.25 = 0.5, devs = [0.5, -1.5],
        // maxDev = 1.5 -> shifts = [0.5*d/3, -0.5*d] = [d/6, -d/2].
        const hand = repoUtilityShifts(d, 400, [300, 100]);
        expect(hand).toHaveLength(2);
        expect(hand[0]).toBeCloseTo(d / 6, 12);
        expect(hand[1]).toBeCloseTo(-d / 2, 12);
        const handWmean = (300 / 400) * hand[0]! + (100 / 400) * hand[1]!;
        expect(handWmean).toBeCloseTo(0, 12);
        for (const composition of [
            [210, 120, 40, 20, 10],
            [200, 200],
            [150, 150, 100],
            [100, 100, 100, 100],
        ]) {
            const shifts = repoUtilityShifts(d, 400, composition);
            expect(shifts).toHaveLength(composition.length);
            let wmean = 0;
            for (let i = 0; i < composition.length; i++) {
                wmean += (composition[i]! / 400) * shifts[i]!;
            }
            expect(wmean).toBeCloseTo(0, 12);
        }
        // a custom composition still rejects a mismatched declared n
        expect(() => repoUtilityShifts(d, 399, [300, 100])).toThrow(/requires n=400/);
    });

    it("default invariance: an explicit default composition equals the no-argument run", () => {
        const scenarios = buildScenarios();
        const first = scenarios[0]!;
        expect(simulateScenario(first, 60, 7, { composition: REPO_COMPOSITION }))
            .toEqual(simulateScenario(first, 60, 7));
        const clustered = scenarios.find((s) => s.clustering)!;
        const boot = { procedure: "bootstrap-t" as const, bootstrapB: 19 };
        expect(simulateScenario(clustered, 40, 11, { ...boot, composition: REPO_COMPOSITION }))
            .toEqual(simulateScenario(clustered, 40, 11, boot));
        const withDefault = runSimulationSuite({
            reps: 3,
            baseSeed: 1,
            nullOnly: true,
            composition: REPO_COMPOSITION,
        });
        const without = runSimulationSuite({ reps: 3, baseSeed: 1, nullOnly: true });
        expect(withDefault.rows).toEqual(without.rows);
        expect(withDefault.pass).toBe(without.pass);
    });

    it("threads a non-default split through clustering shifts and bootstrap strata", () => {
        const custom = [300, 100];
        // n stays the declared design size (composition must sum to it)
        expect(buildScenarios(custom).map((s) => s.n))
            .toEqual(buildScenarios().map((s) => s.n));
        const clustered = buildScenarios(custom).find((s) => s.clustering)!;
        const opts = { procedure: "bootstrap-t" as const, bootstrapB: 19 };
        const customRun = simulateScenario(clustered, 40, 13, { ...opts, composition: custom });
        const defaultRun = simulateScenario(clustered, 40, 13, opts);
        // different repo shifts -> different utilities -> different estimates
        expect(customRun.meanEstimate).not.toBe(defaultRun.meanEstimate);
        // simulation rejects a composition that does not sum to the scenario's declared n
        expect(() => simulateScenario(clustered, 5, 1, { composition: [300, 50] }))
            .toThrow("clustering scenario requires n=350");
    });
});
