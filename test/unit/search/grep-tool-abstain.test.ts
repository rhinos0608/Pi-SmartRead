/**
 * Grep abstention rendering tests (D67 product contract).
 *
 * An abstention must render ZERO location pointers: the abstain message
 * stays, the `maybe: file:line name` fallback lines are gone — in every
 * output path (single query, batch queryResults). Judge details keep
 * their existing fields (abstained, empty pointers/hits) for evaluation.
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGrepTool } from "../../../src/search/grep-tool.js";
import type { GrepJudgeProvider } from "../../../src/judge/grep-judge-stage.js";
import type { ResolveJudgeResult } from "../../../src/judge/judge-resolver.js";
import type { Judge, JudgeNoulInput } from "../../../src/judge/types.js";
import { disposeSemanticIndexes } from "../../../src/indexing/semantic-index-registry.js";
import { makeCtx, makeOpts, seedStandardWorkdir } from "../../helpers/grep-tool-fixtures.js";

let workdir: string;

beforeEach(() => {
    workdir = realpathSync(mkdtempSync(join(tmpdir(), "grep-abstain-")));
    seedStandardWorkdir(workdir);
    seedRetryFiles(workdir);
});

afterEach(() => {
    disposeSemanticIndexes();
    rmSync(workdir, { recursive: true, force: true });
});

function fakeJudge(probs: Record<string, number>): Judge {
    return {
        info: { backend: "cloud", model: "test-model", baseUrl: "http://judge.test" },
        async judgeNouls(input: JudgeNoulInput) {
            const p = new Map<string, number>();
            for (const item of input.items) p.set(item.id, probs[item.id] ?? 0);
            return { p, unjudged: [], usage: { inputTokens: 1, requests: 1 }, cacheHits: 0 };
        },
    };
}

function providerFor(judge: Judge): GrepJudgeProvider {
    const resolved: ResolveJudgeResult = { judge };
    return {
        resolveJudge: async () => resolved,
        readFile: async () => "line one\nline two\nline three\nline four\nline five\n",
    };
}

/** Two files sharing behavioural vocabulary so NL queries yield >= 2 hits. */
function seedRetryFiles(dir: string): void {
    writeFileSync(
        join(dir, "src", "retry-a.ts"),
        "export function retryFailedRequests(url: string) {\n  return fetchWithBackoff(url);\n}\n",
        "utf8",
    );
    writeFileSync(
        join(dir, "src", "retry-b.ts"),
        "export function fetchWithBackoff(url: string) {\n  return retryFailedRequests(url);\n}\n",
        "utf8",
    );
}

const NL_QUERY = "where do we retry failed requests";

function abstainProvider(): GrepJudgeProvider {
    return providerFor(fakeJudge({ u0: 0.05, u1: 0.1, exists: 0.1 }));
}

describe("grep abstention rendering (D67)", () => {
    it("single query renders the abstain message and zero location pointers", async () => {
        const tool = createGrepTool(makeOpts({ judge: abstainProvider() }));
        const result = await tool.execute("t-abstain-render", { pattern: NL_QUERY }, undefined, undefined, makeCtx(workdir));
        const text = (result.content[0] as { text: string }).text;
        expect(text).toContain("no confident match");
        expect(text).not.toMatch(/^maybe:/m);
        expect(text).not.toMatch(/retry-[ab]\.ts.*L\d/m);
        // Judge details keep their evaluation fields.
        expect((result.details as { judge: { abstained: boolean } }).judge.abstained).toBe(true);
        expect((result.details as { judge: { pointers: unknown[] } }).judge.pointers).toEqual([]);
        expect((result.details as { judge: { hits: unknown[] } }).judge.hits).toEqual([]);
        // Internal candidate count is preserved while nothing renders.
        expect((result.details as { totalHits: number }).totalHits).toBeGreaterThan(0);
        // No search-match evidence for an abstention.
        const evidence = (result.details as { workspaceEvidence: { resources: unknown[] } }).workspaceEvidence;
        expect(evidence.resources).toEqual([]);
    });

    it("batch queryResults render zero location pointers for an abstained query", async () => {
        const tool = createGrepTool(makeOpts({ judge: abstainProvider() }));
        const result = await tool.execute(
            "t-abstain-batch",
            { queries: [{ pattern: NL_QUERY }] },
            undefined,
            undefined,
            makeCtx(workdir),
        );
        const text = (result.content[0] as { text: string }).text;
        expect(text).toContain("no confident match"); // D67: batch renders the abstain message.
        expect(text).not.toMatch(/^maybe:/m);
        expect(text).not.toMatch(/retry-[ab]\.ts.*L\d/m);
        // Batch abstained entries expose zero hits in details.
        const queryResults = (result.details as { queryResults: { shownHits: number }[] }).queryResults;
        expect(queryResults[0]!.shownHits).toBe(0);
    });

    it("non-abstained judged output still renders kept hits and the judged footer", async () => {
        const tool = createGrepTool(makeOpts({ judge: providerFor(fakeJudge({ u0: 0.9, u1: 0.85, exists: 0.9 })) }));
        const result = await tool.execute("t-kept-render", { pattern: NL_QUERY }, undefined, undefined, makeCtx(workdir));
        const text = (result.content[0] as { text: string }).text;
        expect(text).not.toContain("no confident match");
        expect(text).not.toMatch(/^maybe:/m);
        expect(text).toContain(", judged");
        expect(text).toMatch(/retry-[ab]\.ts\s+L\d/);
        expect((result.details as { judge: { abstained: boolean } }).judge.abstained).toBe(false);
    });

    it("duplicate patterns do not cross-talk: abstained entry hides only its own hits", async () => {
        // Reviewer repro: same NL pattern twice, once smart (judged, abstained)
        // and once literal (judge bypassed, hits). The literal entry must
        // render its hits; the abstained entry renders only its message.
        writeFileSync(
            join(workdir, "src", "retry-note.ts"),
            "// retry failed requests here\nexport const note = 1;\n",
            "utf8",
        );
        const dup = "retry failed requests";
        const tool = createGrepTool(makeOpts({ judge: abstainProvider() }));
        const result = await tool.execute(
            "t-abstain-dup-pattern",
            { queries: [{ pattern: dup }, { pattern: dup, literal: true }] },
            undefined,
            undefined,
            makeCtx(workdir),
        );
        const text = (result.content[0] as { text: string }).text;
        const queryResults = (result.details as { queryResults: { pattern: string; shownHits: number }[] }).queryResults;
        expect(queryResults).toHaveLength(2);
        expect(queryResults[1]!.shownHits).toBeGreaterThan(0);
        expect(text).toContain("no confident match"); // abstained entry's message stays.
        expect(text).not.toContain("(no matches for any query)");
        expect(text).toMatch(/retry-note\.ts\s+L\d/);
    });

    it("all-abstained batch omits the generic no-matches line", async () => {
        // Every entry abstains, so the merged view is empty: the abstain
        // messages explain it, and the generic line must not conflate
        // abstention with no-results.
        const tool = createGrepTool(makeOpts({ judge: abstainProvider() }));
        const result = await tool.execute(
            "t-abstain-all-batch",
            { queries: [{ pattern: NL_QUERY }, { pattern: NL_QUERY }] },
            undefined,
            undefined,
            makeCtx(workdir),
        );
        const text = (result.content[0] as { text: string }).text;
        const queryResults = (result.details as { queryResults: { shownHits: number }[] }).queryResults;
        expect(queryResults).toHaveLength(2);
        expect(queryResults.every((entry) => entry.shownHits === 0)).toBe(true);
        expect(text).toContain("no confident match");
        expect(text).not.toContain("(no matches for any query)");
        expect(text).not.toMatch(/^maybe:/m);
    });
});
