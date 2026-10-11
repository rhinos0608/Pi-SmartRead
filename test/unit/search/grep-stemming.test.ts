/**
 * C4 (borrow B2): NL-only English stemming knob.
 *
 * - porterStem reduces standard Porter cases and conflates code-identifier
 *   tokens produced by camelCase splitting (serialization/serialize,
 *   selectors/selector, computed/compute).
 * - The knob defaults OFF; when off the NL channel uses the byte-identical
 *   plain tokenizer (rankingTokenizer returns the shared tokenize).
 * - Stemming is isolated in the BM25 corpus cache (stem=1 segment) and
 *   recorded in run identities as rankStem.
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tokenize } from "../../../src/scoring.js";
import { porterStem } from "../../../src/search/english-stemmer.js";
import {
    _resetBm25CorpusCacheForTests,
    createGrepTool,
} from "../../../src/search/grep-tool.js";
import { disposeSemanticIndexes } from "../../../src/indexing/semantic-index-registry.js";
import { makeCtx, makeOpts } from "../../helpers/grep-tool-fixtures.js";
import {
    activeRankingKnobs,
    rankingCorpusKeySegment,
    rankingTokenizer,
    resolveGrepRankingOptions,
    resolveRankingForQuery,
    tokenizeRankingQuery,
    GREP_RANK_STEM_ENV_VAR,
} from "../../../src/search/grep-ranking.js";
import { toRankReportSettings } from "../../../scripts/eval/judge/grep-e2e-contract.js";

const STEM_CASES: Array<[string, string]> = [
    // Standard Porter reference pairs.
    ["caresses", "caress"],
    ["ponies", "poni"],
    ["ties", "ti"],
    ["caress", "caress"],
    ["cats", "cat"],
    ["feed", "feed"],
    ["agreed", "agre"],
    ["plastered", "plaster"],
    ["bled", "bled"],
    ["motoring", "motor"],
    ["sing", "sing"],
    ["conflated", "conflat"],
    ["troubled", "troubl"],
    ["sized", "size"],
    ["hopping", "hop"],
    ["tanned", "tan"],
    ["falling", "fall"],
    ["hissing", "hiss"],
    ["fizzed", "fizz"],
    ["failing", "fail"],
    ["filing", "file"],
    ["happy", "happi"],
    ["sky", "sky"],
    ["relational", "relat"],
    ["conditional", "condit"],
    ["rational", "ration"],
    ["formalize", "formal"],
    ["operator", "oper"],
    ["revival", "reviv"],
    ["adjustable", "adjust"],
    ["defensible", "defens"],
    ["replacement", "replac"],
    ["adjustment", "adjust"],
    ["dependent", "depend"],
    ["adoption", "adopt"],
    ["activate", "activ"],
    ["effective", "effect"],
    ["allow", "allow"],
];

describe("porterStem standard cases", () => {
    for (const [input, expected] of STEM_CASES) {
        it(`${input} -> ${expected}`, () => {
            expect(porterStem(input)).toBe(expected);
        });
    }

    it("leaves short tokens unchanged", () => {
        expect(porterStem("is")).toBe("is");
        expect(porterStem("a")).toBe("a");
    });
});

describe("porterStem on code-identifier tokens", () => {
    it("conflates the motivating morphological gaps", () => {
        // #5 serialization/serialize, #16/#17 selector/selectors,
        // #20 computed/compute (after camelCase splitting upstream).
        expect(porterStem("serialization")).toBe(porterStem("serialize"));
        expect(porterStem("selectors")).toBe("selector");
        expect(porterStem("computed")).toBe(porterStem("compute"));
    });

    it("stems camelCase-split tokens from tokenize() output", () => {
        const split = tokenize("computedSelector serializeResponse");
        expect(split).toContain("computed");
        const stemmed = split.map(porterStem);
        expect(stemmed).toContain(porterStem("compute"));
        expect(stemmed).toContain("selector");
    });
});

describe("stemming knob", () => {
    beforeEach(() => {
        delete process.env[GREP_RANK_STEM_ENV_VAR];
    });

    afterEach(() => {
        delete process.env[GREP_RANK_STEM_ENV_VAR];
    });

    it("defaults OFF and reports no active knob", () => {
        const options = resolveGrepRankingOptions();
        expect(options.stemming).toBe(false);
        expect(activeRankingKnobs(options)).not.toContain("stem");
        expect(rankingCorpusKeySegment(options)).toBe("");
    });

    it("enables via PI_SMARTREAD_GREP_RANK_STEM=on", () => {
        process.env[GREP_RANK_STEM_ENV_VAR] = "on";
        const options = resolveGrepRankingOptions();
        expect(options.stemming).toBe(true);
        expect(activeRankingKnobs(options)).toContain("stem");
        expect(rankingCorpusKeySegment(options)).toContain("stem=1");
    });

    it("uses the shared plain tokenizer when off (byte-identical)", () => {
        expect(rankingTokenizer(resolveGrepRankingOptions())).toBe(tokenize);
        expect(tokenizeRankingQuery("selectors serializing", resolveGrepRankingOptions())).toEqual(
            tokenize("selectors serializing"),
        );
    });

    it("stems query and document tokens identically when on (NL-shaped query)", () => {
        process.env[GREP_RANK_STEM_ENV_VAR] = "on";
        const options = resolveGrepRankingOptions();
        const tokenizeFn = rankingTokenizer(options);
        expect(tokenizeFn("selectors serializing responses")).toEqual(
            tokenizeRankingQuery("selectors serializing responses", options),
        );
        // Same stems on both sides of the morphological gap, inside NL queries.
        expect(tokenizeRankingQuery("serializing responses here", options)).toEqual(
            tokenizeRankingQuery("serialization responses here", options),
        );
    });

    it("records rankStem in run identities", () => {
        process.env[GREP_RANK_STEM_ENV_VAR] = "on";
        expect(toRankReportSettings(resolveGrepRankingOptions()).rankStem).toBe(true);
        delete process.env[GREP_RANK_STEM_ENV_VAR];
        expect(toRankReportSettings(resolveGrepRankingOptions()).rankStem).toBe(false);
    });
});

describe("stemming query-shape gate", () => {
    beforeEach(() => {
        delete process.env[GREP_RANK_STEM_ENV_VAR];
    });

    afterEach(() => {
        delete process.env[GREP_RANK_STEM_ENV_VAR];
    });

    it("resolveRankingForQuery disables stemming for identifier-shaped queries", () => {
        process.env[GREP_RANK_STEM_ENV_VAR] = "on";
        const options = resolveGrepRankingOptions();
        expect(options.stemming).toBe(true);
        for (const identifier of ["serializeResponse", "snake_case_name", "foo.barBaz", "response-parser"]) {
            expect(resolveRankingForQuery(identifier, options).stemming).toBe(false);
        }
        expect(resolveRankingForQuery("how selectors serialize responses", options).stemming).toBe(true);
    });

    it("tokenizeRankingQuery never stems identifier-shaped queries", () => {
        process.env[GREP_RANK_STEM_ENV_VAR] = "on";
        const options = resolveGrepRankingOptions();
        for (const identifier of ["serializeResponse", "snake_case_name", "foo.barBaz"]) {
            expect(tokenizeRankingQuery(identifier, options)).toEqual(tokenize(identifier));
        }
        // NL-shaped queries still stem.
        expect(tokenizeRankingQuery("how selectors serialize responses", options)).toEqual(
            tokenize("how selectors serialize responses").map(porterStem),
        );
    });
});

describe("stemming end-to-end (NL BM25 channel)", () => {
    let dir: string;

    async function runGrep(pattern: string, extra?: Record<string, unknown>): Promise<string> {
        const tool = createGrepTool(makeOpts());
        const result = await tool.execute("t-stem", { pattern, ...extra }, undefined, undefined, makeCtx(dir));
        return (result.content[0] as { text: string }).text;
    }

    beforeEach(() => {
        delete process.env[GREP_RANK_STEM_ENV_VAR];
        _resetBm25CorpusCacheForTests();
        dir = realpathSync(mkdtempSync(join(tmpdir(), "grep-stem-")));
        writeFileSync(
            join(dir, "serialize.ts"),
            "export function serializeResponse(payload: unknown): string {\n  return JSON.stringify(payload);\n}\n",
        );
    });

    afterEach(() => {
        delete process.env[GREP_RANK_STEM_ENV_VAR];
        _resetBm25CorpusCacheForTests();
        disposeSemanticIndexes();
        rmSync(dir, { recursive: true, force: true });
    });

    it("finds a morphological variant only when stemming is on", async () => {
        // NL-shaped query (shared classifier): no raw token occurs verbatim,
        // so the morphological match must not appear without the knob.
        const pattern = "serialization format handling";
        expect(await runGrep(pattern)).not.toContain("serialize.ts");
        process.env[GREP_RANK_STEM_ENV_VAR] = "on";
        expect(await runGrep(pattern)).toContain("serialize.ts");
    });

    it("leaves identifier-shaped smart-fallback queries unstemmed (identical with knob on/off)", async () => {
        const pattern = "serializeResponse";
        const normalize = (text: string): string => text.replace(/\d+\.\d+s\)/g, "Ts)");
        delete process.env[GREP_RANK_STEM_ENV_VAR];
        _resetBm25CorpusCacheForTests();
        const before = normalize(await runGrep(pattern));
        expect(before).toContain("serialize.ts");
        process.env[GREP_RANK_STEM_ENV_VAR] = "on";
        _resetBm25CorpusCacheForTests();
        expect(normalize(await runGrep(pattern))).toBe(before);
    });

    it("does not alter exact-channel results", async () => {
        const normalize = (text: string): string => text.replace(/\d+\.\d+s\)/g, "Ts)");
        const before = normalize(await runGrep("serializeResponse", { literal: true }));
        process.env[GREP_RANK_STEM_ENV_VAR] = "on";
        expect(normalize(await runGrep("serializeResponse", { literal: true }))).toBe(before);
    });
});
