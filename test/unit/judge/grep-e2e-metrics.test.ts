/**
 * Round-1 metric fidelity tests (RED-first): legacy top-5 token estimate vs
 * rendered-output tokens, q02 dual-count policy, file-vs-span categories,
 * and gate-threshold separation. Pure functions from
 * scripts/eval/judge/grep-e2e-metrics.ts — no fixture edits.
 */
import { describe, expect, it } from "vitest";
import {
    GATE_CONSTANTS,
    classifyGoldRow,
    legacyTop5TokenEstimate,
    renderedTokenEstimate,
    summarizeQueries,
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
        expect(classifyGoldRow(gold, wrongSpan, { judged: false, abstained: false })).toBe("retrieved_wrong_span");
        expect(classifyGoldRow(gold, elsewhere, { judged: false, abstained: false })).toBe("retrieval_unobserved");
    });

    it("marks judge-dropped only with pre-judge evidence, abstained separately", () => {
        const gold = row({});
        const top5: Array<{ relFile: string; line: number; endLine: number }> = [];
        // Gold file was a fused candidate but the judge removed it.
        expect(classifyGoldRow(gold, top5, {
            judged: true,
            abstained: false,
            preJudgeFiles: ["src/auth.ts"],
            preJudgeCovered: true,
        })).toBe("judge_dropped");
        // Abstention is its own observable state, not a causal claim.
        expect(classifyGoldRow(gold, top5, { judged: true, abstained: true })).toBe("abstained");
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
