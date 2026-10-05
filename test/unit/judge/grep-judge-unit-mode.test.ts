/**
 * D31: the judge stage uses the rendered symbol-unit excerpt (not the
 * anchor window) when PI_SMARTREAD_GREP_UNIT_MODE=symbol, and records the
 * active unit mode in the judge details.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GrepHit } from "../../../src/search/grep-cascade.js";
import {
    GREP_JUDGE_UNIT_MAX_CHARS,
    runGrepJudgeStage,
    type GrepJudgeProvider,
} from "../../../src/judge/grep-judge-stage.js";
import type { Judge, JudgeNoulInput } from "../../../src/judge/types.js";

const UNIT_MODE_VAR = "PI_SMARTREAD_GREP_UNIT_MODE";

let workdir: string;
let savedUnitMode: string | undefined;
let seenTexts: string[];

beforeEach(() => {
    workdir = realpathSync(mkdtempSync(join(tmpdir(), "grep-judge-units-")));
    savedUnitMode = process.env[UNIT_MODE_VAR];
    seenTexts = [];
});

afterEach(() => {
    if (savedUnitMode === undefined) delete process.env[UNIT_MODE_VAR];
    else process.env[UNIT_MODE_VAR] = savedUnitMode;
    rmSync(workdir, { recursive: true, force: true });
});

function capturingJudge(): Judge {
    return {
        info: { backend: "cloud", model: "test-model", baseUrl: "http://judge.test" },
        async judgeNouls(input: JudgeNoulInput) {
            for (const item of input.items) {
                const text = (item.state as { text?: unknown }).text;
                if (typeof text === "string") seenTexts.push(text);
            }
            return {
                p: new Map(input.items.map((i) => [i.id, 1])),
                unjudged: [],
                usage: { inputTokens: 1, requests: 1 },
                cacheHits: 0,
            };
        },
    };
}

function provider(): GrepJudgeProvider {
    const judge = capturingJudge();
    return {
        resolveJudge: async () => ({ judge }),
        readFile: async () => "unrelated file body\n",
    };
}

function bm25Hit(suffix = ""): GrepHit {
    return {
        file: `${workdir}/a${suffix}.ts`,
        relFile: `a${suffix}.ts`,
        line: 2,
        endLine: 5,
        name: "retryFailedRequests",
        kind: "bm25",
        snippet: [
            "       2 | export function retryFailedRequests(url: string) {",
            "       3 |   const policy = loadRetryPolicy(url);",
            "       4 |   return executeWithBackoff(policy);",
        ].join("\n"),
        engines: ["bm25"],
        score: 3,
    };
}

const STAGE_BASE = {
    query: "where do we retry failed requests",
    contextLines: 2,
    literal: false,
    regex: false,
    structural: false,
} as const;

describe("judge stage unit mode", () => {
    it("uses the rendered excerpt in symbol mode and records unitMode", async () => {
        process.env[UNIT_MODE_VAR] = "symbol";
        const hit = bm25Hit();
        const staged = await runGrepJudgeStage({
            ...STAGE_BASE,
            hits: [hit, bm25Hit("-b")],
            cwd: workdir,
            provider: provider(),
        });
        expect(staged.judge?.unitMode).toBe("symbol");
        expect(seenTexts.some((t) => t.includes("symbol retryFailedRequests"))).toBe(true);
        expect(seenTexts.some((t) => t.includes(hit.snippet))).toBe(true);
        for (const text of seenTexts) {
            expect(text.length).toBeLessThanOrEqual(GREP_JUDGE_UNIT_MAX_CHARS + 64);
        }
    });

    it("uses the anchor window and records anchor mode by default", async () => {
        delete process.env[UNIT_MODE_VAR];
        const staged = await runGrepJudgeStage({
            ...STAGE_BASE,
            hits: [bm25Hit(), bm25Hit("-b")],
            cwd: workdir,
            provider: provider(),
        });
        expect(staged.judge?.unitMode).toBe("anchor");
        expect(seenTexts.some((t) => t.includes("unrelated file body"))).toBe(true);
    });
});
