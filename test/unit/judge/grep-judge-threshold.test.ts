/**
 * Keep-threshold override tests for the grep judge stage.
 *
 * Covers resolveGrepJudgeThreshold (valid env applied, absent/invalid
 * falls back to GREP_JUDGE_THRESHOLD) and the stage input override.
 */
import { describe, expect, it } from "vitest";
import {
    GREP_JUDGE_THRESHOLD,
    GREP_JUDGE_THRESHOLD_ENV_VAR,
    resolveGrepJudgeThreshold,
    runGrepJudgeStage,
    type GrepJudgeProvider,
} from "../../../src/judge/grep-judge-stage.js";
import type { GrepHit } from "../../../src/search/grep-cascade.js";
import type { Judge, JudgeNoulInput } from "../../../src/judge/types.js";

describe("resolveGrepJudgeThreshold", () => {
    it("falls back to the default when the env var is absent", () => {
        expect(resolveGrepJudgeThreshold({})).toBe(GREP_JUDGE_THRESHOLD);
    });

    it.each(["", "   "])("falls back on blank value %j", (value) => {
        expect(resolveGrepJudgeThreshold({ [GREP_JUDGE_THRESHOLD_ENV_VAR]: value })).toBe(GREP_JUDGE_THRESHOLD);
    });

    it.each(["abc", "NaN", "Infinity", "0", "-0.2", "1", "1.5", "0.4.5"])(
        "ignores invalid value %j",
        (value) => {
            expect(resolveGrepJudgeThreshold({ [GREP_JUDGE_THRESHOLD_ENV_VAR]: value })).toBe(GREP_JUDGE_THRESHOLD);
        },
    );

    it.each([["0.35", 0.35], ["0.40", 0.4], ["0.45", 0.45]])("applies valid value %j", (value, expected) => {
        expect(resolveGrepJudgeThreshold({ [GREP_JUDGE_THRESHOLD_ENV_VAR]: value })).toBe(expected);
    });
});

const NL_QUERY = "where do we retry failed requests";

function hit(line: number): GrepHit {
    return {
        file: "/repo/src/a.ts",
        relFile: "src/a.ts",
        line,
        endLine: line,
        name: "fn",
        kind: "symbol",
        snippet: "fn snippet",
        engines: ["bm25"],
        score: 1,
    };
}

function providerFor(probs: Record<string, number>): GrepJudgeProvider {
    const judge: Judge = {
        info: { backend: "cloud", model: "test-model", baseUrl: "http://judge.test" },
        async judgeNouls(input: JudgeNoulInput) {
            const p = new Map<string, number>();
            for (const item of input.items) p.set(item.id, probs[item.id] ?? 0);
            return { p, unjudged: [], usage: { inputTokens: 1, requests: 1 }, cacheHits: 0 };
        },
    };
    return {
        resolveJudge: async () => ({ judge }),
        readFile: async () => "line one\nline two\nline three\nline four\nline five\n",
    };
}

describe("stage threshold override", () => {
    it("input threshold wins over the default (stricter keeps fewer)", async () => {
        const base = {
            query: NL_QUERY,
            hits: [hit(1), hit(2)],
            contextLines: 2,
            literal: false,
            regex: false,
            structural: false,
            cwd: "/repo",
        };
        const probs = { u0: 0.9, u1: 0.5, exists: 0.9 };
        const def = await runGrepJudgeStage({ ...base, hits: [hit(1), hit(10)], provider: providerFor(probs) });
        expect(def.judge?.threshold).toBe(GREP_JUDGE_THRESHOLD);
        expect(def.hits.length).toBe(2);
        const strict = await runGrepJudgeStage({ ...base, hits: [hit(1), hit(10)], provider: providerFor(probs), threshold: 0.8 });
        expect(strict.judge?.threshold).toBe(0.8);
        expect(strict.hits.length).toBe(1);
    });
});
