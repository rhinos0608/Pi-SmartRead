/**
 * D46 scorer tests on synthetic data (pure, no IO).
 * Covers file-level success/recall/precision/MRR, graded nDCG with
 * gain(grade 1) > gain(grade 2), TS-style corpusRoot-relative paths
 * (`src/...`), read-ready via the displayed-lines predicate, false-empty,
 * absence false-content, and exact_ish unexpected-judge.
 */
import { describe, expect, it } from "vitest";
import { aggregateD46, gainForGrade, scoreD46Query, summarizeD46 } from "../../../scripts/eval/d46/score.js";
import type { D46Query } from "../../../scripts/eval/d46/schema.js";
import type { D46ScoreInput } from "../../../scripts/eval/d46/score.js";

function query(overrides: Partial<D46Query> = {}): D46Query {
    return {
        id: "hono-001",
        repo: "honojs/hono",
        split: "dev",
        class: "behaviour",
        query: "synthetic query",
        gold: [{ path: "src/app.ts", startLine: 10, endLine: 20, grade: 1 }],
        rationale: "synthetic",
        author: "test",
        authoredAt: "2026-10-07T00:00:00Z",
        ...overrides,
    };
}

function input(overrides: Partial<D46ScoreInput> = {}): D46ScoreInput {
    return {
        query: query(),
        units: [],
        totalHits: 0,
        renderedChars: 0,
        routingMode: "smart",
        judgeInvoked: false,
        status: "ok",
        elapsedMs: 1,
        ...overrides,
    };
}

function gutterUnit(file: string, lines: number[], line = 1, endLine = 100): D46ScoreInput["units"][number] {
    const snippet = lines.map((n) => `  ${n} | code line ${n}`).join("\n");
    return { file, line, endLine, snippet };
}

describe("gain mapping (D59)", () => {
    it("grade 1 outranks grade 2", () => {
        expect(gainForGrade(1)).toBeGreaterThan(gainForGrade(2));
        expect(gainForGrade(1)).toBe(2);
        expect(gainForGrade(2)).toBe(1);
    });

    it("nDCG prefers the primary file at rank 1 over the supporting file", () => {
        const gold = [
            { path: "src/a.ts", startLine: 1, endLine: 5, grade: 1 as const },
            { path: "src/b.ts", startLine: 1, endLine: 5, grade: 2 as const },
        ];
        const primaryFirst = scoreD46Query(
            input({
                query: query({ gold }),
                units: [gutterUnit("src/a.ts", [1, 2, 3]), gutterUnit("src/b.ts", [1, 2, 3])],
                totalHits: 2,
                renderedChars: 100,
                renderedText: "",
            }),
        );
        const supportingFirst = scoreD46Query(
            input({
                query: query({ gold }),
                units: [gutterUnit("src/b.ts", [1, 2, 3]), gutterUnit("src/a.ts", [1, 2, 3])],
                totalHits: 2,
                renderedChars: 100,
                renderedText: "",
            }),
        );
        expect(primaryFirst.ndcgAt5).not.toBeNull();
        expect(supportingFirst.ndcgAt5).not.toBeNull();
        expect(primaryFirst.ndcgAt5!).toBeGreaterThan(supportingFirst.ndcgAt5!);
        expect(primaryFirst.ndcgAt5).toBe(1);
    });
});

describe("file-level scoring with TS-style corpusRoot paths", () => {
    it("scores success/recall/precision/MRR on src/-relative paths", () => {
        const row = scoreD46Query(
            input({
                units: [gutterUnit("src/other.ts", [1]), gutterUnit("src/app.ts", [10, 11])],
                totalHits: 2,
                renderedChars: 200,
                renderedText: "",
            }),
        );
        expect(row.top5Files).toEqual(["src/other.ts", "src/app.ts"]);
        expect(row.successAt5).toBe(true);
        expect(row.recallAt5).toBe(1);
        expect(row.precisionAt5).toBe(0.5);
        expect(row.mrr).toBe(0.5);
        expect(row.falseEmpty).toBe(false);
    });

    it("dedupes files by first appearance in the top-5 window", () => {
        const row = scoreD46Query(
            input({
                units: [
                    gutterUnit("src/app.ts", [10]),
                    gutterUnit("src/app.ts", [11]),
                    gutterUnit("src/app.ts", [12]),
                    gutterUnit("src/app.ts", [13]),
                    gutterUnit("src/app.ts", [14]),
                    gutterUnit("src/app.ts", [15]),
                ],
                totalHits: 6,
                renderedChars: 300,
                renderedText: "",
            }),
        );
        expect(row.top5Files).toEqual(["src/app.ts"]);
        expect(row.precisionAt5).toBe(1);
    });

    it("marks false-empty when an answerable query returns nothing", () => {
        const row = scoreD46Query(input());
        expect(row.successAt5).toBe(false);
        expect(row.falseEmpty).toBe(true);
        expect(row.ndcgAt5).toBe(0);
        expect(row.precisionAt5).toBe(0);
    });
});

describe("read-ready via displayed lines", () => {
    it("succeeds when rendered gutters overlap gold within budget", () => {
        const row = scoreD46Query(
            input({
                units: [gutterUnit("src/app.ts", [10, 11, 12])],
                totalHits: 1,
                renderedChars: 60,
                renderedText: "  10 | code line 10\n  11 | code line 11\n  12 | code line 12\n",
            }),
        );
        expect(row.readReadyAt5).toBe(true);
        expect(row.readReadyTokens).toBeGreaterThan(0);
    });

    it("fails when gutters miss the gold span", () => {
        const row = scoreD46Query(
            input({
                units: [gutterUnit("src/app.ts", [90, 91], 80, 95)],
                totalHits: 1,
                renderedChars: 60,
                renderedText: "",
            }),
        );
        expect(row.readReadyAt5).toBe(false);
    });
});

describe("absence and exact_ish classes", () => {
    it("flags false-content on absence queries with hits", () => {
        const row = scoreD46Query(
            input({
                query: query({ class: "absence", gold: [] }),
                units: [gutterUnit("src/app.ts", [1])],
                totalHits: 1,
                renderedChars: 50,
                renderedText: "",
            }),
        );
        expect(row.answerable).toBe(false);
        expect(row.falseContent).toBe(true);
        expect(row.correctAbstention).toBe(false);
        expect(row.recallAt5).toBeNull();
    });

    it("records correct abstention on empty absence queries", () => {
        const row = scoreD46Query(input({ query: query({ class: "absence", gold: [] }) }));
        expect(row.falseContent).toBe(false);
        expect(row.correctAbstention).toBe(true);
    });

    it("flags unexpectedJudge for exact_ish under literal routing", () => {
        const row = scoreD46Query(
            input({
                query: query({ class: "exact_ish", exactForm: "literal" }),
                routingMode: "literal",
                judgeInvoked: true,
            }),
        );
        expect(row.unexpectedJudge).toBe(true);
    });

    it("does not flag smart routing with a judge", () => {
        const row = scoreD46Query(
            input({
                query: query({ class: "exact_ish", exactForm: "literal" }),
                routingMode: "smart",
                judgeInvoked: true,
            }),
        );
        expect(row.unexpectedJudge).toBe(false);
    });
});

describe("aggregates", () => {
    it("produces per-class and overall aggregates", () => {
        const rows = [
            scoreD46Query(
                input({
                    units: [gutterUnit("src/app.ts", [10])],
                    totalHits: 1,
                    renderedChars: 60,
                    renderedText: "",
                }),
            ),
            scoreD46Query(input({ query: query({ id: "hono-002", class: "absence", gold: [] }) })),
        ];
        const report = summarizeD46(rows);
        expect(report.overall.queries).toBe(2);
        expect(report.overall.successAt5).toBe("1/1");
        expect(report.overall.correctAbstention).toBe("1/1");
        expect(report.byClass["behaviour"]?.queries).toBe(1);
        expect(report.byClass["absence"]?.queries).toBe(1);
        expect(aggregateD46([]).queries).toBe(0);
    });
});
