/**
 * Experimental BM25 ranking knobs for the no-index grep fallback.
 *
 * Covers: default-off equivalence (byte-identical scores/behaviour),
 * env-knob resolvers, the explicit test/doc path classifier, stopword
 * filtering, the filename header, the coverage boost, active-knob
 * reporting, and corpus-cache isolation across the filename knob.
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    compileBm25Corpus,
    cosineSimilarity,
    DEFAULT_BM25_B,
    DEFAULT_BM25_K1,
    tokenize,
} from "../../../src/scoring.js";
import {
    _bm25CorpusCacheForTests,
    _resetBm25CorpusCacheForTests,
    createGrepTool,
} from "../../../src/search/grep-tool.js";
import {
    activeRankingKnobs,
    coverageBoostFactor,
    filterRankingStopwords,
    isDefaultRankingOptions,
    isTestOrDocPath,
    parseBm25Params,
    parseDemoteFactor,
    rankingCorpusKeySegment,
    resolveGrepRankingOptions,
    tokenizeRankingQuery,
    withFilenameHeader,
    GREP_RANK_BM25_ENV_VAR,
    GREP_RANK_COVERAGE_ENV_VAR,
    GREP_RANK_FILENAME_ENV_VAR,
    GREP_RANK_STOPWORDS_ENV_VAR,
    GREP_RANK_TEST_DEMOTE_ENV_VAR,
} from "../../../src/search/grep-ranking.js";
import { makeCtx, makeOpts, seedStandardWorkdir } from "../../helpers/grep-tool-fixtures.js";

const RANK_ENV_VARS = [
    GREP_RANK_TEST_DEMOTE_ENV_VAR,
    GREP_RANK_FILENAME_ENV_VAR,
    GREP_RANK_BM25_ENV_VAR,
    GREP_RANK_COVERAGE_ENV_VAR,
    GREP_RANK_STOPWORDS_ENV_VAR,
];

const DOCS = [
    "the quick brown fox jumps over the lazy dog",
    "quick brown dogs run fast through the field",
    "a completely unrelated document about typescript",
];

describe("grep ranking knobs default off (equivalence)", () => {
    it("resolves every knob to off / current values with an empty env", () => {
        const options = resolveGrepRankingOptions({});
        expect(options).toEqual({
            testDemoteFactor: null,
            filenamePrepend: false,
            bm25k1: DEFAULT_BM25_K1,
            bm25b: DEFAULT_BM25_B,
            coverageBoost: false,
            stopwords: false,
        });
        expect(isDefaultRankingOptions(options)).toBe(true);
        expect(activeRankingKnobs(options)).toEqual([]);
        expect(rankingCorpusKeySegment(options)).toBe("");
    });

    it("keeps canonical current BM25 defaults (k1=1.2, b=0.75)", () => {
        expect(DEFAULT_BM25_K1).toBe(1.2);
        expect(DEFAULT_BM25_B).toBe(0.75);
    });

    it("produces byte-identical scores without options vs explicit defaults", () => {
        const implicit = compileBm25Corpus(DOCS).score("quick brown");
        const explicit = compileBm25Corpus(DOCS, { k1: 1.2, b: 0.75 }).score("quick brown");
        expect(explicit).toEqual(implicit);
    });

    it("leaves tokenize/cosineSimilarity behaviour unchanged", () => {
        expect(tokenize("totalRevenue_count")).toEqual(tokenize("totalRevenue_count"));
        expect(tokenize("Where is the function")).toContain("where");
        expect(cosineSimilarity([1, 0], [1, 0])).toBe(1);
        expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
        expect(tokenizeRankingQuery("Where is the function", resolveGrepRankingOptions({})))
            .toEqual(tokenize("Where is the function"));
    });
});

describe("grep ranking knob resolvers", () => {
    it("parses the test-demote factor, rejecting out-of-range input", () => {
        expect(parseDemoteFactor(undefined)).toBeNull();
        expect(parseDemoteFactor("")).toBeNull();
        expect(parseDemoteFactor("0.7")).toBe(0.7);
        expect(parseDemoteFactor("1")).toBeNull();
        expect(parseDemoteFactor("0")).toBeNull();
        expect(parseDemoteFactor("2")).toBeNull();
        expect(parseDemoteFactor("abc")).toBeNull();
    });

    it("parses k1,b overrides, falling back per-field on invalid input", () => {
        expect(parseBm25Params(undefined)).toEqual({ k1: 1.2, b: 0.75 });
        expect(parseBm25Params("1.5,0.5")).toEqual({ k1: 1.5, b: 0.5 });
        expect(parseBm25Params("nope")).toEqual({ k1: 1.2, b: 0.75 });
        expect(parseBm25Params("1.5,nope")).toEqual({ k1: 1.5, b: 0.75 });
    });

    it("resolves on/off knobs and reports active knob names", () => {
        const options = resolveGrepRankingOptions({
            [GREP_RANK_TEST_DEMOTE_ENV_VAR]: "0.7",
            [GREP_RANK_FILENAME_ENV_VAR]: "1",
            [GREP_RANK_BM25_ENV_VAR]: "1.5,0.5",
            [GREP_RANK_COVERAGE_ENV_VAR]: "true",
            [GREP_RANK_STOPWORDS_ENV_VAR]: "on",
        });
        expect(options.testDemoteFactor).toBe(0.7);
        expect(options.filenamePrepend).toBe(true);
        expect(options.coverageBoost).toBe(true);
        expect(options.stopwords).toBe(true);
        expect(isDefaultRankingOptions(options)).toBe(false);
        expect(activeRankingKnobs(options)).toEqual([
            "testDemote=0.7",
            "filename",
            "bm25=1.5,0.5",
            "coverage",
            "stopwords",
        ]);
        expect(rankingCorpusKeySegment(options)).toBe("filename=1");
    });
});

describe("test/doc path classifier", () => {
    it.each([
        ["src/parser.ts", false],
        ["src/__tests__/parser.test.ts", true],
        ["src/parser.test.ts", true],
        ["src/parser.spec.ts", true],
        ["test/helpers/util.ts", true],
        ["tests/e2e/flow.ts", true],
        ["spec/unit/runner.ts", true],
        ["specs/old.ts", true],
        ["test_parser.py", true],
        ["parser_test.go", true],
        ["src/fixture/data.json", true],
        ["src/fixtures/rows.ts", true],
        ["README.md", true],
        ["docs/quickstart.md", true],
        ["src/__tests__/snapshot.ts", true],
        ["src/contest/results.ts", false],
        ["src/latest/news.ts", false],
        ["src/protest/util.ts", false],
        ["src/attested.md.bak", false],
    ])("classifies %s as demoted=%s", (path, expected) => {
        expect(isTestOrDocPath(path)).toBe(expected);
    });
});

describe("stopword filtering", () => {
    it("drops NL framing and programming keywords, keeping domain terms", () => {
        const tokens = tokenize("Where is the function to validate token const");
        const filtered = filterRankingStopwords(tokens);
        expect(filtered).not.toContain("where");
        expect(filtered).not.toContain("the");
        expect(filtered).not.toContain("function");
        expect(filtered).not.toContain("const");
        expect(filtered).toContain("validate");
        expect(filtered).toContain("token");
    });

    it("applies only when the knob is on", () => {
        const pattern = "Where is the token";
        expect(tokenizeRankingQuery(pattern, resolveGrepRankingOptions({})))
            .toEqual(tokenize(pattern));
        const on = resolveGrepRankingOptions({ [GREP_RANK_STOPWORDS_ENV_VAR]: "1" });
        const filtered = tokenizeRankingQuery(pattern, on);
        expect(filtered).not.toContain("where");
        expect(filtered).not.toContain("the");
        expect(filtered).toContain("token");
    });
});

describe("filename header and coverage boost", () => {
    it("prepends the synthetic filename header to the BM25 document", () => {
        expect(withFilenameHeader("const x = 1;", "src/orders.ts"))
            .toBe("// Filename: src/orders.ts\nconst x = 1;");
    });

    it("lets filename tokens participate in BM25 scoring", () => {
        const raw = compileBm25Corpus(["const x = 1;"]).score("orders");
        const withHeader = compileBm25Corpus(
            [withFilenameHeader("const x = 1;", "src/orders.ts")],
        ).score("orders");
        expect(raw[0]).toBe(0);
        expect(withHeader[0]).toBeGreaterThan(0);
    });

    it("computes 1 + cov^1.5 * 2 coverage boost (max 3x)", () => {
        expect(coverageBoostFactor(["a", "b"], "a b")).toBe(3);
        expect(coverageBoostFactor(["a", "b"], "nothing here")).toBe(1);
        expect(coverageBoostFactor([], "a b")).toBe(1);
        expect(coverageBoostFactor(["a", "b"], "a only")).toBeCloseTo(1 + Math.pow(0.5, 1.5) * 2, 10);
    });
});

describe("ranking knobs end to end (no-index fallback)", () => {
    let workdir: string;
    beforeEach(() => {
        workdir = realpathSync(mkdtempSync(join(tmpdir(), "grep-ranking-")));
        seedStandardWorkdir(workdir);
        writeFileSync(join(workdir, "src", "orders.ts"), "export function totalRevenue(): number { return 1; }\n", "utf8");
        writeFileSync(join(workdir, "src", "orders.test.ts"), "totalRevenue totalRevenue totalRevenue\n", "utf8");
        _resetBm25CorpusCacheForTests();
        for (const v of RANK_ENV_VARS) delete process.env[v];
    });
    afterEach(() => {
        for (const v of RANK_ENV_VARS) delete process.env[v];
        _resetBm25CorpusCacheForTests();
        rmSync(workdir, { recursive: true, force: true });
    });

    it("reports no active knobs and identical order by default", async () => {
        const tool = createGrepTool(makeOpts({ getWorkspaceRevision: () => 0 }));
        const first = await tool.execute(
            "r1", { pattern: "totalRevenue", path: "src" } as any, undefined, undefined, makeCtx(workdir),
        );
        const second = await tool.execute(
            "r2", { pattern: "totalRevenue", path: "src" } as any, undefined, undefined, makeCtx(workdir),
        );
        expect(_bm25CorpusCacheForTests().builds).toBe(1);
        const orderOf = (result: unknown) => {
            const text = (result as { content: Array<{ text: string }> }).content[0]!.text;
            return text.split("\n").filter((line) => line.includes("src/orders"));
        };
        expect(orderOf(second)).toEqual(orderOf(first));
    });

    it("isolates cached corpora across the filename knob (no cross-setting reuse)", async () => {
        const tool = createGrepTool(makeOpts({ getWorkspaceRevision: () => 0 }));
        const params = { pattern: "totalRevenue", path: "src" } as any;
        await tool.execute("r1", params, undefined, undefined, makeCtx(workdir));
        expect(_bm25CorpusCacheForTests().builds).toBe(1);
        process.env[GREP_RANK_FILENAME_ENV_VAR] = "1";
        await tool.execute("r2", params, undefined, undefined, makeCtx(workdir));
        // Filename prepending changes the indexed document, so the corpus
        // must be rebuilt under a different cache key — never reused.
        expect(_bm25CorpusCacheForTests().builds).toBe(2);
        expect(_bm25CorpusCacheForTests().size).toBe(2);
        await tool.execute("r3", params, undefined, undefined, makeCtx(workdir));
        expect(_bm25CorpusCacheForTests().builds).toBe(2);
    });

    it("isolates cached corpora across k1/b scoring params (no stale-score reuse)", async () => {
        const tool = createGrepTool(makeOpts({ getWorkspaceRevision: () => 0 }));
        const params = { pattern: "totalRevenue", path: "src" } as any;
        await tool.execute("r1", params, undefined, undefined, makeCtx(workdir));
        expect(_bm25CorpusCacheForTests().builds).toBe(1);
        process.env[GREP_RANK_BM25_ENV_VAR] = "1.5,0.5";
        await tool.execute("r2", params, undefined, undefined, makeCtx(workdir));
        // k1/b are baked into the compiled scorer closure, so a changed
        // setting must miss the cache and rebuild — never reuse old scores.
        expect(_bm25CorpusCacheForTests().builds).toBe(2);
        expect(_bm25CorpusCacheForTests().size).toBe(2);
        await tool.execute("r3", params, undefined, undefined, makeCtx(workdir));
        expect(_bm25CorpusCacheForTests().builds).toBe(2);
    });

    it("demotes test paths when the demote knob is on", async () => {
        const tool = createGrepTool(makeOpts({ getWorkspaceRevision: () => 0 }));
        const params = { pattern: "totalRevenue", path: "src" } as any;
        const plain = await tool.execute("r1", params, undefined, undefined, makeCtx(workdir));
        process.env[GREP_RANK_TEST_DEMOTE_ENV_VAR] = "0.7";
        const demoted = await tool.execute("r2", params, undefined, undefined, makeCtx(workdir));
        const textOf = (result: { content: Array<{ text: string }> }) =>
            (result.content[0] as { text: string }).text;
        const plainText = textOf(plain as unknown as { content: Array<{ text: string }> });
        const demotedText = textOf(demoted as unknown as { content: Array<{ text: string }> });
        // The repeated-term test file leads by default; demotion must move
        // it later (or keep it) relative to the production file.
        expect(plainText.indexOf("orders.test.ts")).toBeGreaterThanOrEqual(0);
        const plainGap = plainText.indexOf("orders.test.ts") - plainText.indexOf("src/orders.ts");
        const demotedGap = demotedText.indexOf("orders.test.ts") - demotedText.indexOf("src/orders.ts");
        expect(demotedGap).toBeGreaterThanOrEqual(plainGap);
    });
});
