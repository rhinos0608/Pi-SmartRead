/**
 * Round-1 metric fidelity tests (RED-first): legacy top-5 token estimate vs
 * rendered-output tokens, q02 dual-count policy, file-vs-span categories,
 * and gate-threshold separation. Pure functions from
 * scripts/eval/judge/grep-e2e-metrics.ts — no fixture edits.
 */
import { describe, expect, it } from "vitest";
import {
    GATE_CONSTANTS,
    READ_READY_DEFAULT_BUDGET,
    classifyGoldRow,
    isWrongSpanOutcome,
    legacyTop5TokenEstimate,
    parseRenderedSpan,
    renderedTokenEstimate,
    scoreReadReadySpan,
    summarizeQueries,
    summarizeReadReady,
    validateFixture,
    type EvalRow,
    type QueryOutcome,
} from "../../../scripts/eval/judge/grep-e2e-metrics.js";

function row(overrides: Partial<EvalRow>): EvalRow {
    return {
        qid: "q01",
        query: "where is authentication handled",
        answerable: true,
        file: "src/auth.ts",
        startLine: 10,
        endLine: 20,
        symbol: "authenticate",
        label: "gold",
        why: "test",
        ...overrides,
    };
}

function outcome(overrides: Partial<QueryOutcome>): QueryOutcome {
    return {
        qid: "q01",
        query: "where is authentication handled",
        answerable: true,
        goldRows: 1,
        coveredGoldRows: 1,
        covered: true,
        fileHit: true,
        renderedChars: 100,
        renderedTokens: 25,
        legacyTop5Tokens: 20,
        top5: 1,
        abstained: false,
        abstentionCorrect: null,
        outcome: "covered",
        status: "ok",
        elapsedMs: 5,
        ...overrides,
    };
}

describe("token scope fidelity", () => {
    it("legacy top-5 estimate ignores production render headers", () => {
        const top5 = [{ relFile: "src/auth.ts", line: 10, endLine: 20, name: "authenticate", snippet: "fn" }];
        const rendered = `3 result(s) for "q" (lexical, 0.1s)\n\nsrc/auth.ts  L10-20  authenticate\nfn\n`;
        const legacy = legacyTop5TokenEstimate(top5);
        const renderedTokens = renderedTokenEstimate(rendered);
        const legacyChars = top5.map((h) => `${h.relFile}:${h.line}-${h.endLine} ${h.name}\n${h.snippet}`).join("").length;
        // Rendered text carries headers the legacy unit-only estimate drops.
        expect(rendered.length).toBeGreaterThan(legacyChars);
        expect(renderedTokens).toBe(Math.ceil(rendered.length / 4));
        expect(legacy).toBeLessThan(renderedTokens);
    });

    it("a note/abstention message is not zero output", () => {
        const note = `0 result(s) for "q" (lexical, 0.1s)\n\nno confident match for "q" (judge cloud, τ 0.40)\n`;
        expect(renderedTokenEstimate(note)).toBeGreaterThan(0);
        expect(note.length).toBeGreaterThan(0);
    });
});

describe("q02 dual-count policy", () => {
    it("reports answerable_without_gold without dropping q02", () => {
        const rows = [
            row({ qid: "q01" }),
            row({ qid: "q02", file: "src/other.ts", label: "hard_negative" }),
        ];
        const report = validateFixture(rows, new Set());
        expect(report.q02Disposition).toBe("answerable_without_gold");
        expect(report.declaredAnswerableCount).toBe(2);
        expect(report.evaluableAnswerableCount).toBe(1);
        // q02 stays visible in the query list, never silently excluded.
        expect(report.queryIds).toContain("q02");
    });

    it("RED: unknown labels are reported, q02 no-gold stays legal", () => {
        const bad = [row({ qid: "q01", label: "silver" })];
        expect(validateFixture(bad, new Set(["src/auth.ts"])).errors.some((e) => e.includes("unknown label"))).toBe(true);
        const q02only = [row({ qid: "q02", file: "src/other.ts", label: "hard_negative" })];
        expect(validateFixture(q02only, new Set()).errors).toEqual([]);
    });

    it("RED: optional file-end map catches ranges past actual EOF", () => {
        const rows = [row({ qid: "q01", endLine: 99 })];
        const report = validateFixture(rows, new Set(["src/auth.ts"]), new Map([["src/auth.ts", 30]]));
        expect(report.errors.some((e) => e.includes("beyond actual file end"))).toBe(true);
    });

    it("gold span into an empty file fails validation before retrieval", () => {
        const rows = [row({ qid: "q01", file: "src/empty.ts", startLine: 1, endLine: 1 })];
        const report = validateFixture(rows, new Set(["src/empty.ts"]), new Map([["src/empty.ts", 0]]));
        expect(report.errors.some((e) => e.includes("beyond actual file end"))).toBe(true);
    });

    it("summarize keeps declared and evaluable coverage separate", () => {
        const summary = summarizeQueries([
            outcome({ qid: "q01", covered: true }),
            outcome({ qid: "q02", goldRows: 0, coveredGoldRows: 0, covered: false, outcome: "label_unknown", fileHit: false }),
        ]);
        expect(summary.declaredQueryCoverage).toBe("1/2");
        expect(summary.evaluableQueryCoverage).toBe("1/1");
        // Item recall denominator counts only gold rows (lower-bound diagnostic).
        expect(summary.totalGoldRows).toBe(1);
    });

    it("RED: error rows stay in gold/coverage denominators as misses", () => {
        const summary = summarizeQueries([
            outcome({ qid: "q01", covered: true, fileHit: true, coveredGoldRows: 1, goldRows: 1 }),
            outcome({ qid: "q02", answerable: true, goldRows: 1, coveredGoldRows: 0, covered: false, fileHit: false, status: "error:timeout", outcome: "error" }),
        ]);
        expect(summary.totalGoldRows).toBe(2);
        expect(summary.knownGoldRecallAt5).toBe(0.5);
        expect(summary.declaredQueryCoverage).toBe("1/2");
        expect(summary.evaluableQueryCoverage).toBe("1/2");
        expect(summary.fileHitAt5).toBe("1/2");
        expect(summary.errors).toBe(1);
    });

    it("RED: degraded runs keep coverage with a separate count; unanswerable error-empty is never correct", () => {
        const summary = summarizeQueries([
            outcome({ qid: "q01", covered: true, status: "judge_degraded:judge_timeout" }),
            outcome({ qid: "q02", answerable: false, goldRows: 0, covered: false, fileHit: false, top5: 0, abstained: false, abstentionCorrect: true, status: "error:timeout", outcome: "error" }),
        ]);
        expect(summary.degraded).toBe(1);
        expect(summary.errors).toBe(1);
        expect(summary.evaluableQueryCoverage).toBe("1/1");
        expect(summary.abstentionCorrect).toBe("0/1");
    });
});

describe("file-vs-span categories", () => {
    it("distinguishes same-file wrong-span from not retrieved", () => {
        const gold = row({});
        const wrongSpan = [{ relFile: "src/auth.ts", line: 100, endLine: 110 }];
        const elsewhere = [{ relFile: "src/db.ts", line: 10, endLine: 20 }];
        expect(classifyGoldRow(gold, wrongSpan, { judged: false, abstained: false })).toBe("top5_wrong_span");
        expect(classifyGoldRow(gold, elsewhere, { judged: false, abstained: false })).toBe("retrieval_unobserved");
    });

    it("splits pool-only file hits from rendered top-5 misses", () => {
        const gold = row({});
        const elsewhere = [{ relFile: "src/db.ts", line: 10, endLine: 20 }];
        expect(classifyGoldRow(gold, elsewhere, {
            judged: true, abstained: false, preJudgeFiles: ["src/auth.ts", "src/db.ts"],
        })).toBe("pool_wrong_span");
        expect(classifyGoldRow(gold, elsewhere, {
            judged: true, abstained: false, preJudgeFiles: ["src/db.ts"],
        })).toBe("not_retrieved");
    });

    it("marks judge-dropped only with pre-judge evidence, never masks with abstained", () => {
        const gold = row({});
        const top5: Array<{ relFile: string; line: number; endLine: number }> = [];
        // Gold file was a fused candidate but the judge removed it.
        expect(classifyGoldRow(gold, top5, {
            judged: true,
            abstained: false,
            preJudgeFiles: ["src/auth.ts"],
            preJudgeCovered: true,
        })).toBe("judge_dropped");
        // Abstention is a query-level flag: the same evidence classifies
        // identically whether or not the query abstained.
        expect(classifyGoldRow(gold, top5, {
            judged: true,
            abstained: true,
            preJudgeFiles: ["src/auth.ts"],
            preJudgeCovered: true,
        })).toBe("judge_dropped");
        expect(classifyGoldRow(gold, top5, {
            judged: true,
            abstained: true,
            preJudgeFiles: ["src/auth.ts"],
        })).toBe("pool_wrong_span");
        expect(classifyGoldRow(gold, top5, {
            judged: true,
            abstained: true,
            preJudgeFiles: ["src/other.ts"],
        })).toBe("not_retrieved");
    });

    it("marks below_top5 when the gold span sits outside the top-5 window", () => {
        const gold = row({});
        expect(classifyGoldRow(gold, [], {
            judged: false,
            abstained: false,
            preJudgeCovered: false,
            shownCovered: true,
        })).toBe("below_top5");
    });

    it("RED: execution error precedes overlap inference", () => {
        const gold = row({});
        const hit = [{ relFile: "src/auth.ts", line: 10, endLine: 20 }];
        expect(classifyGoldRow(gold, hit, { judged: false, abstained: false, executionStatus: "error:timeout" })).toBe("execution_error");
    });

    it("RED: unobserved pool is retrieval_unobserved, not not_retrieved", () => {
        const gold = row({});
        expect(classifyGoldRow(gold, [], { judged: false, abstained: false })).toBe("retrieval_unobserved");
        expect(classifyGoldRow(gold, [], { judged: false, abstained: false, preJudgeFiles: ["other.ts"] })).toBe("not_retrieved");
    });
});

describe("legacy wrong-span alias", () => {
    it("treats old and split outcomes as wrong-span", () => {
        expect(isWrongSpanOutcome("retrieved_wrong_span")).toBe(true);
        expect(isWrongSpanOutcome("top5_wrong_span")).toBe(true);
        expect(isWrongSpanOutcome("pool_wrong_span")).toBe(true);
        expect(isWrongSpanOutcome("covered")).toBe(false);
    });
});

describe("parseRenderedSpan", () => {
    it("parses the exact SET of gutter numbers actually shown", () => {
        expect(parseRenderedSpan("      20 | code\n      22 | more\n      24 | end\n")?.lines)
            .toEqual(new Set([20, 22, 24]));
    });
    it("returns null when the snippet has no gutter numbers", () => {
        expect(parseRenderedSpan("no line numbers here")).toBeNull();
    });
    it("RED: a gap in displayed lines is not covered (gold 21, shown 20+22)", () => {
        const gold = { file: "src/a.ts", startLine: 21, endLine: 21 };
        const units = [{ relFile: "src/a.ts", line: 20, endLine: 22, snippet: "      20 | a\n      22 | b\n" }];
        expect(scoreReadReadySpan(gold, units).success).toBe(false);
    });
    it("RED: budget is measured from the captured rendered text in order", () => {
        const gold = { file: "src/a.ts", startLine: 100, endLine: 100 };
        const s1 = "     100 | hit\n";
        const s2 = "     200 | hit\n";
        const text = `HEADER\n${s1}${s2}`;
        const units = [
            { relFile: "src/a.ts", line: 100, endLine: 100, snippet: s1 },
            { relFile: "src/a.ts", line: 200, endLine: 200, snippet: s2 },
        ];
        const end1 = text.indexOf(s1) + s1.length;
        const over = Math.ceil(end1 / 4);
        // Budget below the cumulative cost through unit 0: no success.
        expect(scoreReadReadySpan(gold, units, over - 1, 5, text).success).toBe(false);
        // Exact cumulative cost through unit 0: success with exact tokens.
        const ok = scoreReadReadySpan(gold, units, over, 5, text);
        expect(ok.success).toBe(true);
        expect(ok.tokensUsed).toBe(over);
    });
    it("RED: unlocatable blocks are unmeasurable, never synthetic", () => {
        const gold = { file: "src/a.ts", startLine: 100, endLine: 100 };
        const r = scoreReadReadySpan(gold, [{ relFile: "src/a.ts", line: 100, endLine: 100, snippet: "     100 | hit\n" }], 1500, 5, "unrelated text");
        expect(r.success).toBe(false);
        expect(r.unmeasurable).toBe(true);
    });
    it("RED: a gap in displayed lines is not covered (gold 21, shown 20+22)", () => {
        const gold = { file: "src/a.ts", startLine: 100, endLine: 105 };
        expect(scoreReadReadySpan(gold, [{ relFile: "src/a.ts", line: 100, endLine: 105, snippet: "plain snippet" }]).success).toBe(false);
    });
});

describe("scoreReadReadySpan", () => {
    const gold = { file: "src/a.ts", startLine: 100, endLine: 110 };
    const card = (line: number, endLine: number, snippet: string, file = "src/a.ts"): {
        relFile: string; line: number; endLine: number; snippet: string;
    } => ({ relFile: file, line, endLine, snippet });
    it("scores overlap from RENDERED lines, not metadata ranges", () => {
        // Metadata claims lines 1-2 but the rendered card shows gutters 100 and 105.
        const hit = scoreReadReadySpan(gold, [card(1, 2, "     100 | hit\n     105 | hit\n")]);
        expect(hit.success).toBe(true);
        expect(hit.unitIndex).toBe(0);
        expect(hit.spanLength).toBe(2);
        expect(hit.precision).toBeCloseTo(1, 6);
        expect(hit.iou).toBeCloseTo(2 / 11, 6);
    });
    it("counts gutter-less cards as no coverage, never metadata fallback", () => {
        const r = scoreReadReadySpan(gold, [card(100, 105, "plain snippet")]);
        expect(r.success).toBe(false);
        expect(r.noGutterUnits).toBe(1);
    });
    it("counts gutter-less units on other files too, not only gold-file units", () => {
        const r = scoreReadReadySpan(gold, [
            card(1, 1, "plain snippet", "src/other.ts"),
            card(100, 105, "plain snippet"),
        ]);
        expect(r.success).toBe(false);
        expect(r.noGutterUnits).toBe(2);
    });
    it("fails when the gold file is absent from the first K units", () => {
        expect(scoreReadReadySpan(gold, [card(100, 110, "     100 | hit\n", "src/other.ts")]).success)
            .toBe(false);
    });
    it("stops consuming units once the token budget is exhausted", () => {
        const units = [
            card(1, 1, "x".repeat(4000), "src/other.ts"),
            card(100, 110, "     100 | hit\n"),
        ];
        expect(scoreReadReadySpan(gold, units, 500).success).toBe(false);
        expect(scoreReadReadySpan(gold, units, READ_READY_DEFAULT_BUDGET).success).toBe(true);
    });
});

describe("summarizeReadReady", () => {
    it("reports multi-gold queries separately", () => {
        const summary = summarizeReadReady(
            [
                { answerable: true, goldRows: 1, readReady: true },
                { answerable: true, goldRows: 2, readReady: false },
                { answerable: false, goldRows: 1, readReady: false },
            ],
            [{ precision: 1, iou: 0.5, spanLength: 6 }],
        );
        expect(summary.queriesSuccess).toBe("1/2");
        expect(summary.singleGoldQueries).toBe("1/1");
        expect(summary.multiGoldQueries).toBe("0/1");
        expect(summary.meanPrecision).toBeCloseTo(1, 6);
    });
});

describe("gate threshold separation", () => {
    it("records four independent gate constants", () => {
        expect(GATE_CONSTANTS.keep).toBe(0.4);
        expect(GATE_CONSTANTS.pointer).toBe(0.45);
        expect(GATE_CONSTANTS.exists).toBe(0.35);
        expect(GATE_CONSTANTS.find).toBe(0.4);
        // Keep/pointer/exists gates must not be conflated.
        expect(new Set(Object.values(GATE_CONSTANTS)).size).toBeGreaterThanOrEqual(3);
    });
});

describe("fixture validation completeness", () => {
    it("detects inconsistent qid query/answerability flags", () => {
        const report = validateFixture([
            row({ qid: "q01", query: "alpha" }),
            row({ qid: "q01", query: "beta" }),
        ], new Set());
        expect(report.errors.some((e) => e.includes("q01"))).toBe(true);
    });

    it("detects malformed ranges and missing files without dropping rows", () => {
        const report = validateFixture([row({ startLine: 20, endLine: 10 })], new Set(["src/auth.ts"]));
        expect(report.errors.length).toBeGreaterThan(0);
        expect(report.totalRows).toBe(1);
    });
});
