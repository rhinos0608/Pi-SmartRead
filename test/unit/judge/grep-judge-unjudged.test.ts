import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GrepHit } from "../../../src/search/grep-cascade.js";
import {
    runGrepJudgeStage,
    type GrepJudgeProvider,
} from "../../../src/judge/grep-judge-stage.js";
import type { ResolveJudgeResult } from "../../../src/judge/judge-resolver.js";
import type { Judge, JudgeNoulInput } from "../../../src/judge/types.js";
import { disposeSemanticIndexes } from "../../../src/indexing/semantic-index-registry.js";
import { seedStandardWorkdir } from "../../helpers/grep-tool-fixtures.js";

let workdir: string;
beforeEach(() => {
    workdir = realpathSync(mkdtempSync(join(tmpdir(), "grep-judge-unjudged-")));
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

describe("provider-unjudged units stay visible", () => {
    it("keeps unjudged ids as fallback hits after kept hits, without counting them as kept", async () => {
        const hits = [hit("src/a.ts", 1, "aaa"), hit("src/b.ts", 2, "bbb"), hit("src/c.ts", 3, "ccc")];
        const judge: Judge = {
            info: { backend: "cloud", model: "m", baseUrl: "http://x" },
            async judgeNouls(input: JudgeNoulInput) {
                // Unit wave: u1 reported unjudged with no probability.
                if (input.items.some((i) => i.id.startsWith("u"))) {
                    return {
                        p: new Map([["u0", 0.9], ["u2", 0.1]]),
                        unjudged: [{ id: "u1", code: "timeout" }],
                        usage: { inputTokens: 1, requests: 1 },
                        cacheHits: 0,
                    };
                }
                return {
                    p: new Map([["exists", 0.9]]),
                    unjudged: [],
                    usage: { inputTokens: 1, requests: 1 },
                    cacheHits: 0,
                };
            },
        };
        const result = await runGrepJudgeStage({
            query: NL_QUERY,
            hits,
            contextLines: 0,
            literal: false,
            regex: false,
            structural: false,
            cwd: workdir,
            provider: providerFor(judge),
        });
        expect(result.judged).toBe(true);
        expect(result.abstained).toBe(false);
        // Kept hit first, unjudged fallback after it in fused order.
        expect(result.hits.map((h) => h.name)).toEqual(["aaa", "bbb"]);
        expect(result.hits[1]?.judgeP).toBeUndefined();
        expect(result.judge).toMatchObject({ kept: 1, judged: 3 });
        expect(result.judge?.unjudged.count).toBe(1);
        expect(result.judge?.unjudged.ids).toEqual(["u1"]);
    });

    it("keeps an id reported unjudged as a fallback even when it carries a probability", async () => {
        const hits = [hit("src/a.ts", 1, "aaa"), hit("src/b.ts", 2, "bbb"), hit("src/c.ts", 3, "ccc")];
        const judge: Judge = {
            info: { backend: "cloud", model: "m", baseUrl: "http://x" },
            async judgeNouls(input: JudgeNoulInput) {
                // u1 appears in BOTH the probability map and the explicit
                // unjudged list: it must stay an unscored fallback (no
                // judgeP), never a kept hit and never dropped.
                if (input.items.some((i) => i.id.startsWith("u"))) {
                    return {
                        p: new Map([["u0", 0.9], ["u1", 0.8], ["u2", 0.1]]),
                        unjudged: [{ id: "u1", code: "timeout" }],
                        usage: { inputTokens: 1, requests: 1 },
                        cacheHits: 0,
                    };
                }
                return {
                    p: new Map([["exists", 0.9]]),
                    unjudged: [],
                    usage: { inputTokens: 1, requests: 1 },
                    cacheHits: 0,
                };
            },
        };
        const result = await runGrepJudgeStage({
            query: NL_QUERY,
            hits,
            contextLines: 0,
            literal: false,
            regex: false,
            structural: false,
            cwd: workdir,
            provider: providerFor(judge),
        });
        expect(result.judged).toBe(true);
        expect(result.hits.map((h) => h.name)).toEqual(["aaa", "bbb"]);
        expect(result.hits[0]?.judgeP).toBe(0.9);
        expect(result.hits[1]?.judgeP).toBeUndefined();
        expect(result.judge).toMatchObject({ kept: 1, judged: 3 });
        expect(result.judge?.unjudged.count).toBe(1);
        expect(result.judge?.unjudged.ids).toEqual(["u1"]);
        expect(result.degradation).toMatchObject({ backend: "judge", code: "timeout" });
    });

    it("does not abstain when only unjudged units remain and exists is absent", async () => {
        const hits = [hit("src/a.ts", 1, "aaa"), hit("src/b.ts", 2, "bbb")];
        const judge: Judge = {
            info: { backend: "cloud", model: "m", baseUrl: "http://x" },
            async judgeNouls(input: JudgeNoulInput) {
                if (input.items.some((i) => i.id.startsWith("u"))) {
                    return {
                        p: new Map<string, number>(),
                        unjudged: [{ id: "u0", code: "timeout" }, { id: "u1", code: "timeout" }],
                        usage: { inputTokens: 1, requests: 1 },
                        cacheHits: 0,
                    };
                }
                return {
                    p: new Map([["exists", 0.1]]),
                    unjudged: [],
                    usage: { inputTokens: 1, requests: 1 },
                    cacheHits: 0,
                };
            },
        };
        const result = await runGrepJudgeStage({
            query: NL_QUERY,
            hits,
            contextLines: 0,
            literal: false,
            regex: false,
            structural: false,
            cwd: workdir,
            provider: providerFor(judge),
        });
        expect(result.abstained).toBe(false);
        expect(result.hits.map((h) => h.name)).toEqual(["aaa", "bbb"]);
    });
});
