/**
 * Grep details report the active BM25 ranking knobs (additive).
 *
 * Covers: single-query details carry `rankingKnobs` when a knob is on and
 * omit it by default; batch `queryResults` entries carry per-query knobs.
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    _resetBm25CorpusCacheForTests,
    createGrepTool,
} from "../../../src/search/grep-tool.js";
import {
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

describe("grep details ranking knobs", () => {
    let workdir: string;
    beforeEach(() => {
        workdir = realpathSync(mkdtempSync(join(tmpdir(), "grep-ranking-details-")));
        seedStandardWorkdir(workdir);
        writeFileSync(join(workdir, "src", "orders.ts"), "export function totalRevenue(): number { return 1; }\n", "utf8");
        _resetBm25CorpusCacheForTests();
        for (const v of RANK_ENV_VARS) delete process.env[v];
    });
    afterEach(() => {
        for (const v of RANK_ENV_VARS) delete process.env[v];
        _resetBm25CorpusCacheForTests();
        rmSync(workdir, { recursive: true, force: true });
    });

    it("omits rankingKnobs from single-query details by default", async () => {
        const tool = createGrepTool(makeOpts({ getWorkspaceRevision: () => 0 }));
        const result = await tool.execute(
            "r1", { pattern: "totalRevenue", path: "src" } as any, undefined, undefined, makeCtx(workdir),
        );
        expect((result as any).details.rankingKnobs).toBeUndefined();
    });

    it("reports active ranking knobs in single-query details", async () => {
        const tool = createGrepTool(makeOpts({ getWorkspaceRevision: () => 0 }));
        process.env[GREP_RANK_COVERAGE_ENV_VAR] = "1";
        const result = await tool.execute(
            "r1", { pattern: "totalRevenue", path: "src" } as any, undefined, undefined, makeCtx(workdir),
        );
        expect((result as any).details.rankingKnobs).toEqual(["coverage"]);
    });

    it("reports per-query ranking knobs in batch queryResults", async () => {
        const tool = createGrepTool(makeOpts({ getWorkspaceRevision: () => 0 }));
        process.env[GREP_RANK_BM25_ENV_VAR] = "1.5,0.5";
        const result = await tool.execute(
            "r1",
            { queries: [{ pattern: "totalRevenue", path: "src" }] } as any,
            undefined,
            undefined,
            makeCtx(workdir),
        );
        const queryResults = (result as any).details.queryResults;
        expect(queryResults).toHaveLength(1);
        expect(queryResults[0].rankingKnobs).toEqual(["bm25=1.5,0.5"]);
    });
});
