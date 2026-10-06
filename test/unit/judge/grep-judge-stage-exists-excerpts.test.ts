/**
 * D42 excerpt-based exists evidence tests (behind
 * PI_SMARTREAD_JUDGE_EXISTS_EVIDENCE=excerpts; default off = count-only).
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    GREP_JUDGE_EXISTS_ABSENT,
    buildExistsExcerpts,
    isExistsExcerptMode,
    resolveExistsExcerptCount,
    resolveExistsExcerptLines,
    resolveExistsThreshold,
    runGrepJudgeStage,
    type GrepJudgeProvider,
} from "../../../src/judge/grep-judge-stage.js";
import { existsExcerptQuestion } from "../../../src/judge/questions.js";
import type { GrepHit } from "../../../src/search/grep-cascade.js";
import type { Judge, JudgeNoulInput } from "../../../src/judge/types.js";
import type { ResolveJudgeResult } from "../../../src/judge/judge-resolver.js";
import { disposeSemanticIndexes } from "../../../src/indexing/semantic-index-registry.js";
import { seedStandardWorkdir } from "../../helpers/grep-tool-fixtures.js";

let workdir: string;
const NL_QUERY = "where do we retry failed requests";

beforeEach(() => {
    workdir = realpathSync(mkdtempSync(join(tmpdir(), "grep-exists-excerpt-")));
    seedStandardWorkdir(workdir);
    delete process.env.PI_SMARTREAD_JUDGE_EXISTS_EVIDENCE;
    delete process.env.PI_SMARTREAD_JUDGE_EXISTS_THRESHOLD;
    delete process.env.PI_SMARTREAD_JUDGE_EXISTS_EXCERPT_COUNT;
    delete process.env.PI_SMARTREAD_JUDGE_EXISTS_EXCERPT_LINES;
});

afterEach(() => {
    disposeSemanticIndexes();
    rmSync(workdir, { recursive: true, force: true });
    delete process.env.PI_SMARTREAD_JUDGE_EXISTS_EVIDENCE;
    delete process.env.PI_SMARTREAD_JUDGE_EXISTS_THRESHOLD;
    delete process.env.PI_SMARTREAD_JUDGE_EXISTS_EXCERPT_COUNT;
    delete process.env.PI_SMARTREAD_JUDGE_EXISTS_EXCERPT_LINES;
});

function hit(file: string, line: number, name = "fn"): GrepHit {
    return { file: `${workdir}/${file}`, relFile: file, line, endLine: line, name, kind: "symbol", snippet: `${name} snippet`, engines: ["bm25"], score: 1 };
}

function capturingProvider(seen: JudgeNoulInput[]): GrepJudgeProvider {
    const judge: Judge = {
        info: { backend: "cloud", model: "m", baseUrl: "http://x" },
        async judgeNouls(input: JudgeNoulInput) {
            seen.push(input);
            const p = new Map<string, number>();
            for (const item of input.items) p.set(item.id, item.id === "exists" ? 0.1 : 0.05);
            return { p, unjudged: [], usage: { inputTokens: 1, requests: 1 }, cacheHits: 0 };
        },
    };
    const resolved: ResolveJudgeResult = { judge };
    return { resolveJudge: async () => resolved, readFile: async () => Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n") + "\n" };
}

describe("D42 exists excerpt flag", () => {
    it("defaults off", () => {
        expect(isExistsExcerptMode({})).toBe(false);
        expect(isExistsExcerptMode({ PI_SMARTREAD_JUDGE_EXISTS_EVIDENCE: "excerpts" })).toBe(true);
        expect(isExistsExcerptMode({ PI_SMARTREAD_JUDGE_EXISTS_EVIDENCE: "EXCERPTS" })).toBe(false);
    });

    it("bounds the excerpt cap to 5..8, default 6", () => {
        expect(resolveExistsExcerptCount({})).toBe(6);
        expect(resolveExistsExcerptCount({ PI_SMARTREAD_JUDGE_EXISTS_EXCERPT_COUNT: "7" })).toBe(7);
        expect(resolveExistsExcerptCount({ PI_SMARTREAD_JUDGE_EXISTS_EXCERPT_COUNT: "4" })).toBe(6);
        expect(resolveExistsExcerptCount({ PI_SMARTREAD_JUDGE_EXISTS_EXCERPT_COUNT: "99" })).toBe(6);
        expect(resolveExistsExcerptCount({ PI_SMARTREAD_JUDGE_EXISTS_EXCERPT_COUNT: "bogus" })).toBe(6);
    });

    it("bounds excerpt lines, default 12", () => {
        expect(resolveExistsExcerptLines({})).toBe(12);
        expect(resolveExistsExcerptLines({ PI_SMARTREAD_JUDGE_EXISTS_EXCERPT_LINES: "0" })).toBe(12);
    });

    it("excerpt threshold defaults to the current .35 and validates (0,1)", () => {
        expect(resolveExistsThreshold({})).toBe(GREP_JUDGE_EXISTS_ABSENT);
        expect(resolveExistsThreshold({ PI_SMARTREAD_JUDGE_EXISTS_THRESHOLD: "0.6" })).toBe(0.6);
        expect(resolveExistsThreshold({ PI_SMARTREAD_JUDGE_EXISTS_THRESHOLD: "bogus" })).toBe(GREP_JUDGE_EXISTS_ABSENT);
        expect(resolveExistsThreshold({ PI_SMARTREAD_JUDGE_EXISTS_THRESHOLD: "2" })).toBe(GREP_JUDGE_EXISTS_ABSENT);
    });

    it("excerpt question is scoped to the candidates, not the repository", () => {
        const q = existsExcerptQuestion(NL_QUERY);
        expect(q.instructions).toContain("Among these candidates");
        expect(q.instructions).not.toMatch(/whole repository|entire repository/i);
        expect(q.instructions).toContain("make no claim about the rest of the repository");
    });

    it("buildExistsExcerpts keeps rank order, first N lines, deterministic budget truncation", () => {
        const units = Array.from({ length: 8 }, (_, i) => ({ path: `src/f${i}.ts`, symbol: `fn${i}`, text: Array.from({ length: 20 }, (_, j) => `L${i}-${j}`).join("\n") }));
        const two = buildExistsExcerpts(units, 2, 3);
        expect(two).toContain("[1] src/f0.ts");
        expect(two).toContain("[2] src/f1.ts");
        expect(two).not.toContain("[3]");
        expect(two).toContain("L0-0");
        expect(two).toContain("L0-2");
        expect(two).not.toContain("L0-3");
        // Budget: huge input truncates deterministically to the same prefix.
        const big = buildExistsExcerpts(units.map((u) => ({ ...u, text: "x".repeat(5000) })), 8, 24);
        const big2 = buildExistsExcerpts(units.map((u) => ({ ...u, text: "x".repeat(5000) })), 8, 24);
        expect(big).toBe(big2);
        expect(big.length).toBeLessThanOrEqual(4000);
    });

    it("default mode sends count-only exists state (byte-identical)", async () => {
        const seen: JudgeNoulInput[] = [];
        const result = await runGrepJudgeStage({ query: NL_QUERY, hits: [hit("src/a.ts", 1), hit("src/b.ts", 2)], contextLines: 1, literal: false, regex: false, structural: false, cwd: workdir, provider: capturingProvider(seen) });
        const existsCall = seen.find((s) => s.items.some((i) => i.id === "exists"));
        expect(existsCall?.items[0]?.state).toEqual({ candidateCount: 2 });
        expect(result.judge?.existsExcerptMode).toBe(false);
        expect(result.judge?.existsP).toBe(0.1);
    });

    it("excerpt mode sends content-sensitive exists state with excerpt wording", async () => {
        process.env.PI_SMARTREAD_JUDGE_EXISTS_EVIDENCE = "excerpts";
        const seen: JudgeNoulInput[] = [];
        const result = await runGrepJudgeStage({ query: NL_QUERY, hits: [hit("src/a.ts", 1), hit("src/b.ts", 2)], contextLines: 1, literal: false, regex: false, structural: false, cwd: workdir, provider: capturingProvider(seen) });
        const existsCall = seen.find((s) => s.items.some((i) => i.id === "exists"));
        const state = existsCall?.items[0]?.state as Record<string, unknown>;
        expect(state.candidateCount).toBe(2);
        expect(typeof state.excerpts).toBe("string");
        expect((state.excerpts as string)).toContain("src/a.ts");
        const q = existsCall?.items[0]?.question("exists");
        expect(q?.type).toBe("noul");
        if (q?.type === "noul") expect(q.instructions).toContain("Among these candidates");
        expect(result.judge?.existsExcerptMode).toBe(true);
        expect(result.judge?.existsP).toBe(0.1);
    });

    it("excerpt threshold env is honoured only in excerpt mode", async () => {
        // Count mode ignores the separate threshold env: exists=0.1 < .35 still abstains.
        process.env.PI_SMARTREAD_JUDGE_EXISTS_THRESHOLD = "0.05";
        const seen: JudgeNoulInput[] = [];
        const countResult = await runGrepJudgeStage({ query: NL_QUERY, hits: [hit("src/a.ts", 1), hit("src/b.ts", 2)], contextLines: 1, literal: false, regex: false, structural: false, cwd: workdir, provider: capturingProvider(seen) });
        expect(countResult.judge?.abstained).toBe(true);
        // Excerpt mode with threshold 0.05: exists=0.1 passes → no abstention gate from exists.
        process.env.PI_SMARTREAD_JUDGE_EXISTS_EVIDENCE = "excerpts";
        const seen2: JudgeNoulInput[] = [];
        const excerptResult = await runGrepJudgeStage({ query: NL_QUERY, hits: [hit("src/a.ts", 1), hit("src/b.ts", 2)], contextLines: 1, literal: false, regex: false, structural: false, cwd: workdir, provider: capturingProvider(seen2) });
        expect(excerptResult.judge?.abstained).toBe(false);
    });
});
