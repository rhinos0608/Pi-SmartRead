import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GrepHit } from "../../../src/search/grep-cascade.js";
import {
    GREP_JUDGE_MAX_UNITS,
    resolveGrepJudgeMaxUnits,
    runGrepJudgeStage,
    type GrepJudgeProvider,
} from "../../../src/judge/grep-judge-stage.js";
import type { ResolveJudgeResult } from "../../../src/judge/judge-resolver.js";
import type { Judge, JudgeNoulInput } from "../../../src/judge/types.js";
import { disposeSemanticIndexes } from "../../../src/indexing/semantic-index-registry.js";
import { seedStandardWorkdir } from "../../helpers/grep-tool-fixtures.js";

let workdir: string;
beforeEach(() => {
    workdir = realpathSync(mkdtempSync(join(tmpdir(), "grep-judge-cap-")));
    seedStandardWorkdir(workdir);
});
afterEach(() => {
    disposeSemanticIndexes();
    rmSync(workdir, { recursive: true, force: true });
});

function hit(file: string, line: number, name = "fn"): GrepHit {
    return {
        file: `${workdir}/${file}`,
        relFile: file,
        line,
        endLine: line,
        name,
        kind: "symbol",
        snippet: `${name} snippet`,
        engines: ["bm25"],
        score: 1,
    };
}

const NL_QUERY = "where do we retry failed requests";

function providerFor(judge: Judge): GrepJudgeProvider {
    const resolved: ResolveJudgeResult = { judge };
    return {
        resolveJudge: async () => resolved,
        readFile: async () => "line one\nline two\n",
    };
}

function allKeepJudge(): Judge {
    return {
        info: { backend: "cloud", model: "m", baseUrl: "http://x" },
        async judgeNouls(input: JudgeNoulInput) {
            const p = new Map<string, number>();
            for (const item of input.items) p.set(item.id, 0.99);
            return { p, unjudged: [], usage: { inputTokens: 1, requests: 1 }, cacheHits: 0 };
        },
    };
}

describe("resolveGrepJudgeMaxUnits", () => {
    it("defaults to 40 when unset or invalid", () => {
        expect(resolveGrepJudgeMaxUnits({})).toBe(GREP_JUDGE_MAX_UNITS);
        expect(resolveGrepJudgeMaxUnits({ PI_SMARTREAD_JUDGE_MAX_UNITS: "" })).toBe(40);
        expect(resolveGrepJudgeMaxUnits({ PI_SMARTREAD_JUDGE_MAX_UNITS: "banana" })).toBe(40);
        expect(resolveGrepJudgeMaxUnits({ PI_SMARTREAD_JUDGE_MAX_UNITS: "9" })).toBe(40);
        expect(resolveGrepJudgeMaxUnits({ PI_SMARTREAD_JUDGE_MAX_UNITS: "121" })).toBe(40);
        expect(resolveGrepJudgeMaxUnits({ PI_SMARTREAD_JUDGE_MAX_UNITS: "20.5" })).toBe(40);
    });

    it("accepts 10..120", () => {
        expect(resolveGrepJudgeMaxUnits({ PI_SMARTREAD_JUDGE_MAX_UNITS: "10" })).toBe(10);
        expect(resolveGrepJudgeMaxUnits({ PI_SMARTREAD_JUDGE_MAX_UNITS: "60" })).toBe(60);
        expect(resolveGrepJudgeMaxUnits({ PI_SMARTREAD_JUDGE_MAX_UNITS: "120" })).toBe(120);
    });
});

describe("units beyond the cap stay visible", () => {
    it("surfaces capped-out hits after kept hits with an explicit count", async () => {
        const hits = Array.from({ length: 15 }, (_, i) => hit(`src/f${i}.ts`, 1, `fn${i}`));
        const result = await runGrepJudgeStage({
            query: NL_QUERY,
            hits,
            contextLines: 0,
            literal: false,
            regex: false,
            structural: false,
            cwd: workdir,
            provider: providerFor(allKeepJudge()),
            maxUnits: 10,
        });
        expect(result.judged).toBe(true);
        expect(result.abstained).toBe(false);
        // 10 judged units (each its own file → 10 kept) + 5 beyond-cap fallbacks.
        expect(result.hits).toHaveLength(15);
        expect(result.hits.slice(10).map((h) => h.name)).toEqual(["fn10", "fn11", "fn12", "fn13", "fn14"]);
        expect(result.hits.slice(10).every((h) => h.judgeP === undefined)).toBe(true);
        expect(result.judge).toMatchObject({ judged: 10, kept: 10 });
        expect(result.judge?.["unscored_beyond_cap"]).toBe(5);
    });

    it("records a zero count when everything fits under the cap", async () => {
        const hits = [hit("src/a.ts", 1, "aaa"), hit("src/b.ts", 2, "bbb")];
        const result = await runGrepJudgeStage({
            query: NL_QUERY,
            hits,
            contextLines: 0,
            literal: false,
            regex: false,
            structural: false,
            cwd: workdir,
            provider: providerFor(allKeepJudge()),
        });
        expect(result.judge?.["unscored_beyond_cap"]).toBe(0);
        expect(result.hits).toHaveLength(2);
    });
});
