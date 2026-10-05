/**
 * WS1 grep judgment stage tests (spec docs/plans/2026-10-05-grep-judge-design.md).
 *
 * Covers: mode-off byte-identical bypass (snapshot), gate cases, threshold /
 * merge / order filtering, failure → unjudged + stable degraded code,
 * abstention, and pointer-wave no-build behaviour.
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGrepTool, type GrepToolOptions } from "../../../src/search/grep-tool.js";
import type { GrepHit } from "../../../src/search/grep-cascade.js";
import {
    GREP_JUDGE_THRESHOLD,
    runGrepJudgeStage,
    shouldJudgeGrep,
    type GrepJudgeProvider,
} from "../../../src/judge/grep-judge-stage.js";
import type { ResolveJudgeResult } from "../../../src/judge/judge-resolver.js";
import { JudgeError, type Judge, type JudgeNoulInput } from "../../../src/judge/types.js";
import { disposeSemanticIndexes } from "../../../src/indexing/semantic-index-registry.js";
import { makeCtx, makeOpts, seedStandardWorkdir } from "../../helpers/grep-tool-fixtures.js";

let workdir: string;

beforeEach(() => {
    workdir = realpathSync(mkdtempSync(join(tmpdir(), "grep-judge-")));
    seedStandardWorkdir(workdir);
});

afterEach(() => {
    disposeSemanticIndexes();
    rmSync(workdir, { recursive: true, force: true });
});

// ── Fakes ─────────────────────────────────────────────────────────────

function fakeJudge(
    probs: Record<string, number>,
    opts?: { throws?: JudgeError; backend?: "cloud" | "local" },
): Judge {
    return {
        info: { backend: opts?.backend ?? "cloud", model: "test-model", baseUrl: "http://judge.test" },
        async judgeNouls(_input: JudgeNoulInput) {
            if (opts?.throws) throw opts.throws;
            const p = new Map<string, number>();
            for (const item of _input.items) p.set(item.id, probs[item.id] ?? 0);
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

function offProvider(): GrepJudgeProvider {
    return { resolveJudge: async () => ({ unavailable: "aborted" }) };
}

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

// ── Gate ──────────────────────────────────────────────────────────────

describe("grep judge gate", () => {
    it("accepts smart-cascade natural-language queries with >= 2 hits", () => {
        expect(shouldJudgeGrep({ pattern: NL_QUERY, literal: false, regex: false, structural: false, hitCount: 2 })).toBe(true);
    });

    it.each([
        ["literal", { pattern: NL_QUERY, literal: true, regex: false, structural: false, hitCount: 3 }],
        ["regex", { pattern: NL_QUERY, literal: false, regex: true, structural: false, hitCount: 3 }],
        ["structural", { pattern: NL_QUERY, literal: false, regex: false, structural: true, hitCount: 3 }],
        ["non-NL identifier", { pattern: "authenticate", literal: false, regex: false, structural: false, hitCount: 3 }],
        ["single hit", { pattern: NL_QUERY, literal: false, regex: false, structural: false, hitCount: 1 }],
    ])("bypasses %s without resolving a backend", async (_label, gate) => {
        let resolved = false;
        const provider: GrepJudgeProvider = {
            resolveJudge: async () => {
                resolved = true;
                return { unavailable: "aborted" };
            },
        };
        const allHits = [hit("src/a.ts", 1), hit("src/b.ts", 2), hit("src/c.ts", 3)];
        const hits = allHits.slice(0, gate.hitCount);
        const result = await runGrepJudgeStage({
            query: gate.pattern,
            hits,
            contextLines: 2,
            literal: gate.literal,
            regex: gate.regex,
            structural: gate.structural,
            cwd: workdir,
            provider,
        });
        expect(result.judged).toBe(false);
        expect(result.hits).toBe(hits);
        expect(result.judge).toBeUndefined();
        expect(result.degradation).toBeUndefined();
        expect(resolved).toBe(false);
    });
});

// ── Filtering ─────────────────────────────────────────────────────────

describe("grep judge filtering", () => {
    it("keeps p >= τ ordered by p desc and drops the rest", async () => {
        const hits = [hit("src/a.ts", 1, "aaa"), hit("src/b.ts", 2, "bbb"), hit("src/c.ts", 3, "ccc")];
        const result = await runGrepJudgeStage({
            query: NL_QUERY,
            hits,
            contextLines: 1,
            literal: false,
            regex: false,
            structural: false,
            cwd: workdir,
            provider: providerFor(fakeJudge({ u0: 0.9, u1: 0.39, u2: 0.4, exists: 0.8 })),
        });
        expect(result.judged).toBe(true);
        expect(result.abstained).toBe(false);
        expect(result.hits.map((h) => h.name)).toEqual(["aaa", "ccc"]);
        expect(result.hits.map((h) => h.judgeP)).toEqual([0.9, 0.4]);
        expect(result.judge).toMatchObject({
            backend: "cloud",
            judged: 3,
            kept: 2,
            belowThreshold: 1,
            threshold: GREP_JUDGE_THRESHOLD,
            abstained: false,
        });
        // Per-hit probabilities travel in details for the footer/render path.
        expect(result.judge?.hits).toHaveLength(2);
    });

    it("merges adjacent kept ranges in the same file with max p winning", async () => {
        const first = { ...hit("src/a.ts", 10, "aaa"), endLine: 12 };
        const second = { ...hit("src/a.ts", 13, "bbb"), endLine: 15 };
        const result = await runGrepJudgeStage({
            query: NL_QUERY,
            hits: [first, second],
            contextLines: 0,
            literal: false,
            regex: false,
            structural: false,
            cwd: workdir,
            provider: providerFor(fakeJudge({ u0: 0.6, u1: 0.9, exists: 0.8 })),
        });
        expect(result.hits).toHaveLength(1);
        expect(result.hits[0]).toMatchObject({ line: 10, endLine: 15, judgeP: 0.9 });
    });

    it("judges at most 40 candidates from the top of the fused order", async () => {
        const hits = Array.from({ length: 60 }, (_, i) => hit(`src/f${i}.ts`, 1, `fn${i}`));
        let seenIds = 0;
        const judge: Judge = {
            info: { backend: "cloud", model: "m", baseUrl: "http://x" },
            async judgeNouls(input: JudgeNoulInput) {
                seenIds = Math.max(seenIds, input.items.length);
                const p = new Map<string, number>();
                for (const item of input.items) p.set(item.id, 0.99);
                return { p, unjudged: [], usage: { inputTokens: 1, requests: 1 }, cacheHits: 0 };
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
        expect(seenIds).toBeLessThanOrEqual(40);
        expect(result.judge?.judged).toBeLessThanOrEqual(40);
    });
});

// ── Failure ───────────────────────────────────────────────────────────

describe("grep judge failure", () => {
    it("returns unjudged hits plus a stable degraded code when judging throws", async () => {
        const hits = [hit("src/a.ts", 1), hit("src/b.ts", 2)];
        const result = await runGrepJudgeStage({
            query: NL_QUERY,
            hits,
            contextLines: 1,
            literal: false,
            regex: false,
            structural: false,
            cwd: workdir,
            provider: providerFor(fakeJudge({}, { throws: new JudgeError("timeout") })),
        });
        expect(result.judged).toBe(false);
        expect(result.hits).toBe(hits);
        expect(result.degradation).toEqual({ backend: "judge", code: "timeout" });
        expect(result.judge).toBeUndefined();
    });

    it("maps unavailable backends to judge_<code> without dropping results", async () => {
        const hits = [hit("src/a.ts", 1), hit("src/b.ts", 2)];
        const provider: GrepJudgeProvider = {
            resolveJudge: async () => ({ unavailable: "no_key" }),
        };
        const result = await runGrepJudgeStage({
            query: NL_QUERY,
            hits,
            contextLines: 1,
            literal: false,
            regex: false,
            structural: false,
            cwd: workdir,
            provider,
        });
        expect(result.hits).toBe(hits);
        expect(result.degradation).toEqual({ backend: "judge", code: "no_key" });
    });
});

// ── Abstention ────────────────────────────────────────────────────────

describe("grep judge abstention", () => {
    function abstainProvider(): GrepJudgeProvider {
        return providerFor(fakeJudge({ u0: 0.05, u1: 0.1, exists: 0.1 }));
    }

    it("abstains with a message when nothing passes and exists is absent", async () => {
        const hits = [hit("src/a.ts", 1), hit("src/b.ts", 2)];
        const result = await runGrepJudgeStage({
            query: NL_QUERY,
            hits,
            contextLines: 1,
            literal: false,
            regex: false,
            structural: false,
            cwd: workdir,
            provider: abstainProvider(),
        });
        expect(result.judged).toBe(true);
        expect(result.abstained).toBe(true);
        expect(result.hits).toEqual([]);
        expect(result.unjudged).toBe(hits);
        expect(result.abstainMessage).toContain(`no confident match for \"${NL_QUERY}\"`);
        expect(result.judge).toMatchObject({ abstained: true, kept: 0 });
    });

    it("renders the abstain message plus top-3 unjudged pointers at the tool level", async () => {
        seedRetryFiles(workdir);
        const tool = createGrepTool(makeOpts({ judge: abstainProvider() }));
        const result = await tool.execute("t-abstain", { pattern: NL_QUERY }, undefined, undefined, makeCtx(workdir));
        const text = (result.content[0] as { text: string }).text;
        expect(text).toContain("no confident match");
        expect(text).toContain("maybe:");
        // Abstention produces no search-match evidence for judged drops.
        expect((result.details as { totalHits: number }).totalHits).toBeGreaterThan(0);
        expect((result.details as { judge: { abstained: boolean } }).judge.abstained).toBe(true);
    });

    it("does not abstain when exists is uncertain (no message, kept as judged)", async () => {
        const hits = [hit("src/a.ts", 1, "aaa"), hit("src/b.ts", 2, "bbb")];
        const result = await runGrepJudgeStage({
            query: NL_QUERY,
            hits,
            contextLines: 1,
            literal: false,
            regex: false,
            structural: false,
            cwd: workdir,
            provider: providerFor(fakeJudge({ u0: 0.9, u1: 0.05, exists: 0.8 })),
        });
        expect(result.abstained).toBe(false);
        expect(result.abstainMessage).toBeUndefined();
        expect(result.hits.map((h) => h.name)).toEqual(["aaa"]);
    });
});

// ── Pointers / no-build ───────────────────────────────────────────────

describe("grep judge pointers", () => {
    function pointerProvider(graph: GrepJudgeProvider["getGraphIfBuilt"]): GrepJudgeProvider {
        return {
            ...providerFor(fakeJudge({ u0: 0.9, u1: 0.8, exists: 0.9, n0: 0.7, n1: 0.2 })),
            getGraphIfBuilt: graph,
        };
    }

    it("skips pointers when the graph is not built and never triggers a build", async () => {
        let peeked = 0;
        const result = await runGrepJudgeStage({
            query: NL_QUERY,
            hits: [hit("src/a.ts", 1), hit("src/b.ts", 2)],
            contextLines: 1,
            literal: false,
            regex: false,
            structural: false,
            cwd: workdir,
            provider: pointerProvider(() => {
                peeked++;
                return null;
            }),
        });
        expect(result.judged).toBe(true);
        expect(result.judge?.pointers).toEqual([]);
        // Exactly one sync peek per query; a null graph means no pointers.
        expect(peeked).toBe(1);
    });

    it("skips pointers when no graph peek is wired", async () => {
        const result = await runGrepJudgeStage({
            query: NL_QUERY,
            hits: [hit("src/a.ts", 1), hit("src/b.ts", 2)],
            contextLines: 1,
            literal: false,
            regex: false,
            structural: false,
            cwd: workdir,
            provider: providerFor(fakeJudge({ u0: 0.9, u1: 0.8, exists: 0.9 })),
        });
        expect(result.judged).toBe(true);
        expect(result.judge?.pointers).toEqual([]);
    });

    it("emits judged neighbours at p >= 0.45, excluding already-shown files", async () => {
        const neighbour = `${workdir}/src/backoff.ts`;
        const graph = {
            getMutationNeighbours: () => [{ path: neighbour, provenance: {} }],
            getImportDependents: () => [`${workdir}/src/a.ts`], // already shown → excluded
        };
        const result = await runGrepJudgeStage({
            query: NL_QUERY,
            hits: [hit("src/a.ts", 1), hit("src/b.ts", 2)],
            contextLines: 1,
            literal: false,
            regex: false,
            structural: false,
            cwd: workdir,
            provider: pointerProvider(() => graph as never),
        });
        expect(result.judge?.pointers).toHaveLength(1);
        expect(result.judge?.pointers[0]).toMatchObject({ path: neighbour, p: 0.7 });
    });
});

// ── Mode-off byte-identical ───────────────────────────────────────────

describe("grep judge off", () => {
    const pattern = "how does authentication work here";

    async function runWithJudge(judge: GrepToolOptions["judge"]) {
        const tool = createGrepTool(makeOpts({ ...(judge ? { judge } : {}) }));
        return tool.execute("t-off", { pattern }, undefined, undefined, makeCtx(workdir));
    }

    it("is byte-identical with mode off vs no provider (snapshot)", async () => {
        seedRetryFiles(workdir);
        const plain = await runWithJudge(undefined);
        const off = await runWithJudge(offProvider());
        const plainText = (plain.content[0] as { text: string }).text;
        const offText = (off.content[0] as { text: string }).text;
        const normalizeDuration = (text: string) => text.replace(/, \d+(?:\.\d+)?s\)/g, ", <duration>)");
        expect(normalizeDuration(offText)).toBe(normalizeDuration(plainText));
        // Evidence envelopes carry per-run timestamps/ids; normalize those
        // before comparing so the assertion pins judge behaviour, not clocks.
        expect(normalizeEvidence(off.details)).toBe(normalizeEvidence(plain.details));
        // No judge fields leak into details when off.
        expect(plain.details).not.toHaveProperty("judge");
        expect(off.details).not.toHaveProperty("judge");
        expect(plainText).toContain("result(s)");
    });
});

/** Strip per-run envelope values (timestamps, ids) for stable comparison. */
function normalizeEvidence(details: unknown): string {
    const clone = JSON.parse(JSON.stringify(details)) as Record<string, unknown>;
    const envelope = clone.workspaceEvidence as Record<string, unknown> | undefined;
    if (envelope) {
        delete envelope.createdAt;
        delete envelope.inspectionId;
    }
    return JSON.stringify(clone);
}
