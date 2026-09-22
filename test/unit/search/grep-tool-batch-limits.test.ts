/**
 * Grep batch cardinality: cross-query dedup, global cap, full-range
 * evidence identity, and the output size guard.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    createGrepTool,
    dedupGrepHits,
    enforceGrepOutputGuard,
    inspectionIdForRanges,
    resolveMaxResults,
    resolvePerQueryLimit,
    resourceIdForRanges,
} from "../../../src/search/grep-tool.js";
import { disposeSemanticIndexes } from "../../../src/indexing/semantic-index-registry.js";
import { makeCtx, makeOpts, seedStandardWorkdir } from "../../helpers/grep-tool-fixtures.js";

let workdir: string;

beforeEach(() => {
    workdir = realpathSync(mkdtempSync(join(tmpdir(), "grep-batch-")));
    seedStandardWorkdir(workdir);
});

afterEach(() => {
    disposeSemanticIndexes();
    rmSync(workdir, { recursive: true, force: true });
});

describe("grep batch cardinality", () => {
    it("perQueryLimit wins over deprecated limit; defaults + clamps hold", () => {
        expect(resolvePerQueryLimit({})).toBe(20);
        expect(resolvePerQueryLimit({ limit: 5 })).toBe(5);
        expect(resolvePerQueryLimit({ limit: 5, perQueryLimit: 7 })).toBe(7);
        expect(resolvePerQueryLimit({ perQueryLimit: 999 })).toBe(50);
        expect(resolvePerQueryLimit({ perQueryLimit: 0 })).toBe(1);
        expect(resolveMaxResults({})).toBe(100);
        expect(resolveMaxResults({ maxResults: 5 })).toBe(5);
        expect(resolveMaxResults({ maxResults: 999 })).toBe(200);
    });

    it("10 overlapping queries dedup to a single render with merged provenance", async () => {
        const tool = createGrepTool(makeOpts());
        const queries = Array.from({ length: 10 }, () => ({
            pattern: "authenticate",
            literal: true,
        }));
        const result = await tool.execute("t-overlap", { queries } as any, undefined, undefined, makeCtx(workdir));
        const text = (result.content[0] as { text: string }).text;
        const details = result.details as any;
        // Same file+range hits collapse: exactly one merged section per hit.
        const authLines = text.split("\n").filter((l) => l.startsWith("src/auth.ts"));
        expect(authLines.length).toBeGreaterThan(0);
        for (const line of authLines) {
            expect(line).toContain("matched queries:");
        }
        // Summed per-query hits exceed the merged total.
        const summed = details.queryResults.reduce((s: number, q: any) => s + q.shownHits, 0);
        expect(details.totalHits).toBeLessThanOrEqual(summed);
        expect(details.totalHits).toBe(details.shownHits);
    });

    it("global maxResults cap is enforced on the merged render", async () => {
        const tool = createGrepTool(makeOpts());
        const result = await tool.execute(
            "t-cap",
            {
                queries: [
                    { pattern: "handler", perQueryLimit: 50 },
                    { pattern: "export", perQueryLimit: 50 },
                ],
                maxResults: 3,
            } as any,
            undefined,
            undefined,
            makeCtx(workdir),
        );
        const details = result.details as any;
        expect(details.maxResults).toBe(3);
        expect(details.shownHits).toBeLessThanOrEqual(3);
        expect(details.truncated).toBe(true);
        expect((result.content[0] as { text: string }).text).toContain("truncated");
    });

    it("dedup merges engines and matchedQueries across queries", () => {
        const base: any = {
            file: "/w/src/auth.ts",
            relFile: "src/auth.ts",
            line: 1,
            endLine: 1,
            name: "authenticate",
            kind: "function",
            snippet: "fn",
            score: 1,
        };
        const out = dedupGrepHits([
            { ...base, engines: ["lexical"], matchedQueries: ["aaa"], score: 1 },
            { ...base, engines: ["bm25"], matchedQueries: ["bbb"], score: 2 },
        ]);
        expect(out).toHaveLength(1);
        expect(out[0]!.engines.sort()).toEqual(["bm25", "lexical"]);
        expect(out[0]!.matchedQueries!.sort()).toEqual(["aaa", "bbb"]);
        expect(out[0]!.score).toBe(2);
    });

    it("evidence identity differs for different range sets on the same file", () => {
        const a = resourceIdForRanges("/w/src/auth.ts", [
            { startLine: 10, endLine: 12 },
            { startLine: 80, endLine: 82 },
        ]);
        const b = resourceIdForRanges("/w/src/auth.ts", [
            { startLine: 10, endLine: 12 },
            { startLine: 300, endLine: 302 },
        ]);
        expect(a).not.toBe(b);
        const ia = inspectionIdForRanges("s", "/w", [
            { canonicalPath: "/w/src/auth.ts", ranges: [{ startLine: 10, endLine: 12 }, { startLine: 80, endLine: 82 }] },
        ]);
        const ib = inspectionIdForRanges("s", "/w", [
            { canonicalPath: "/w/src/auth.ts", ranges: [{ startLine: 10, endLine: 12 }, { startLine: 300, endLine: 302 }] },
        ]);
        expect(ia).not.toBe(ib);
        // Order-invariant: same set in different order hashes equal.
        const ic = inspectionIdForRanges("s", "/w", [
            { canonicalPath: "/w/src/auth.ts", ranges: [{ startLine: 80, endLine: 82 }, { startLine: 10, endLine: 12 }] },
        ]);
        expect(ic).toBe(ia);
    });

    it("output byte guard truncates with a recovery hint", () => {
        const big = Array.from({ length: 5000 }, (_, i) => `src/f.ts  L${i + 1}  hit number ${i} with padding xxxxxxxxxx`).join("\n");
        const { text, outputTruncated } = enforceGrepOutputGuard(big);
        expect(outputTruncated).toBe(true);
        expect(text).toContain("size guard");
        expect(text).toContain("Reduce maxResults, contextLines, or queries");
        expect(text.split("\n").length).toBeLessThan(5000);
    });

    it("single-query maxResults is enforced globally", async () => {
        const tool = createGrepTool(makeOpts());
        const result = await tool.execute(
            "t-single-cap",
            { pattern: "export", perQueryLimit: 50, maxResults: 1 } as any,
            undefined,
            undefined,
            makeCtx(workdir),
        );
        const details = result.details as any;
        expect(details.shownHits).toBe(1);
        expect(details.truncated).toBe(true);
        expect(details.maxResults).toBe(1);
        expect(details.workspaceEvidence.resources.length).toBeLessThanOrEqual(1);
    });

    it("ten distinct queries are capped by the global maxResults", async () => {
        const tool = createGrepTool(makeOpts());
        const queries = Array.from({ length: 10 }, (_, i) => ({ pattern: `handler${i}` }));
        const result = await tool.execute(
            "t-ten-cap",
            { queries, perQueryLimit: 50, maxResults: 5 } as any,
            undefined,
            undefined,
            makeCtx(workdir),
        );
        const details = result.details as any;
        expect(details.shownHits).toBeLessThanOrEqual(5);
        expect(details.truncated).toBe(true);
        expect(details.maxResults).toBe(5);
    });

    it("contextLines:20 amplification stays within the byte guard", async () => {
        const tool = createGrepTool(makeOpts());
        const result = await tool.execute(
            "t-ctx20",
            { pattern: "handler", contextLines: 20, maxResults: 3 } as any,
            undefined,
            undefined,
            makeCtx(workdir),
        );
        const text = (result.content[0] as { text: string }).text;
        expect(text.length).toBeLessThanOrEqual(200 * 1024 + 512);
    });

    it("different capped tails produce different evidence ids", async () => {
        const tool = createGrepTool(makeOpts());
        const run = (id: string, maxResults: number) =>
            tool.execute(
                id,
                { pattern: "handler", perQueryLimit: 50, maxResults } as any,
                undefined,
                undefined,
                makeCtx(workdir),
            );
        const narrow = (await run("t-tail2", 2)).details as any;
        const wide = (await run("t-tail5", 5)).details as any;
        expect(narrow.workspaceEvidence.inspectionId).not.toBe(wide.workspaceEvidence.inspectionId);
    });

    it("all ten query names appear in merged provenance", async () => {
        const tool = createGrepTool(makeOpts());
        const queries = Array.from({ length: 10 }, (_, i) => ({ pattern: `handler${i}` }));
        const result = await tool.execute("t-ten-prov", { queries, perQueryLimit: 50 } as any, undefined, undefined, makeCtx(workdir));
        const text = (result.content[0] as { text: string }).text;
        for (let i = 0; i < 10; i++) expect(text).toContain(`"handler${i}"`);
    });
});
