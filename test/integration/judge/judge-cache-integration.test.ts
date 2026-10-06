/**
 * Workspace judge-verdict cache integration (D53).
 *
 * Verifies the existing cache end-to-end with a FAKE judge transport (no
 * network, no keys): fresh CloudJudge instances sharing one temp workspace
 * cache dir, simulating a new Pi session and a new MCP server.
 *
 * Documents actual behaviour; where it contradicts D53's expectation the
 * test names the gap explicitly instead of changing src/.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CloudJudge } from "../../../src/judge/cloud-judge.js";
import {
    GREP_JUDGE_THRESHOLD,
    runGrepJudgeStage,
    type GrepJudgeProvider,
} from "../../../src/judge/grep-judge-stage.js";
import { resolveMcpJudge, resolvePiJudge } from "../../../src/judge/judge-runtime.js";
import { LocalJudge } from "../../../src/judge/local-judge.js";
import { unitRelevanceQuestion } from "../../../src/judge/questions.js";
import type { FetchFn } from "../../../src/judge/systemone-client.js";
import type { JudgeNoulInput } from "../../../src/judge/types.js";
import type { GrepHit } from "../../../src/search/grep-cascade.js";

const QUERY = "where do we retry failed requests";
const UNIT_TEXT = "src/a.ts lines 1-3 symbol fn\n1 | export function fn() {\n2 |   retry();\n3 | }";
const MODEL = "test-model-alias";

function workspaceCacheDir(root: string): string {
    return join(root, ".pi-smartread", "judge-cache");
}

function noulInput(query: string, text: string): JudgeNoulInput {
    return {
        shared: { query },
        items: [{
            id: "u0",
            state: { path: "src/a.ts", symbol: "fn", text },
            question: (ref: string) => unitRelevanceQuestion(query, ref),
        }],
    };
}

/** Fake transport: answers every requested question key with `prob`, counts calls. */
function fakeFetch(counter: { calls: number }, prob: number): FetchFn {
    return (async (_url: string, init?: RequestInit) => {
        counter.calls++;
        const body = JSON.parse(String((init as Record<string, unknown>)?.body ?? "{}")) as {
            questions?: Record<string, unknown>;
        };
        const answers: Record<string, number> = {};
        for (const key of Object.keys(body.questions ?? {})) answers[key] = prob;
        return new Response(JSON.stringify({ answers, usage: { input_tokens: 10 } }), {
            status: 200,
            headers: { "content-type": "application/json" },
        });
    }) as FetchFn;
}

function freshJudge(cacheDir: string, counter: { calls: number }, prob: number, model = MODEL): CloudJudge {
    return new CloudJudge({ apiKey: "test-key", baseUrl: "https://judge.test", model, cacheDir, fetchFn: fakeFetch(counter, prob) });
}

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

describe("workspace verdict cache integration", () => {
    it("(1) identical request on a fresh instance → cache hit, zero transport calls", async () => {
        const root = mkdtempSync(join(tmpdir(), "judge-int-"));
        const cacheDir = workspaceCacheDir(root);
        const counter = { calls: 0 };
        const first = freshJudge(cacheDir, counter, 0.75);
        const r1 = await first.judgeNouls(noulInput(QUERY, UNIT_TEXT));
        expect(r1.p.get("u0")).toBe(0.75);
        expect(r1.cacheHits).toBe(0);
        expect(counter.calls).toBe(1);

        // Fresh instance = new Pi/MCP session sharing the workspace dir.
        const second = freshJudge(cacheDir, counter, 0.75);
        const r2 = await second.judgeNouls(noulInput(QUERY, UNIT_TEXT));
        expect(r2.p.get("u0")).toBe(0.75);
        expect(r2.cacheHits).toBe(1);
        expect(counter.calls).toBe(1);
    });

    it("(2a) changed query → miss", async () => {
        const root = mkdtempSync(join(tmpdir(), "judge-int-"));
        const cacheDir = workspaceCacheDir(root);
        const counter = { calls: 0 };
        await freshJudge(cacheDir, counter, 0.75).judgeNouls(noulInput(QUERY, UNIT_TEXT));
        const r = await freshJudge(cacheDir, counter, 0.75).judgeNouls(noulInput("where do we log failed requests", UNIT_TEXT));
        expect(r.cacheHits).toBe(0);
        expect(counter.calls).toBe(2);
    });

    it("(2b) changed rendered unit text → miss", async () => {
        const root = mkdtempSync(join(tmpdir(), "judge-int-"));
        const cacheDir = workspaceCacheDir(root);
        const counter = { calls: 0 };
        await freshJudge(cacheDir, counter, 0.75).judgeNouls(noulInput(QUERY, UNIT_TEXT));
        const r = await freshJudge(cacheDir, counter, 0.75).judgeNouls(noulInput(QUERY, `${UNIT_TEXT}\n4 | edited();`));
        expect(r.cacheHits).toBe(0);
        expect(counter.calls).toBe(2);
    });

    it("(2c) changed model → miss", async () => {
        const root = mkdtempSync(join(tmpdir(), "judge-int-"));
        const cacheDir = workspaceCacheDir(root);
        const counter = { calls: 0 };
        await freshJudge(cacheDir, counter, 0.75).judgeNouls(noulInput(QUERY, UNIT_TEXT));
        const r = await freshJudge(cacheDir, counter, 0.75, "other-model").judgeNouls(noulInput(QUERY, UNIT_TEXT));
        expect(r.cacheHits).toBe(0);
        expect(counter.calls).toBe(2);
    });

    it("(3) changed keep threshold → cached probability reused, gate recomputed, no transport", async () => {
        const root = mkdtempSync(join(tmpdir(), "judge-int-"));
        const cacheDir = workspaceCacheDir(root);
        const counter = { calls: 0 };
        const provider: GrepJudgeProvider = {
            resolveJudge: async () => ({ judge: freshJudge(cacheDir, counter, 0.6) }),
            readFile: async () => "line one\nline two\nline three\nline four\nline five\n",
        };
        const base = {
            query: QUERY,
            hits: [hit(1), hit(2)],
            contextLines: 2,
            literal: false,
            regex: false,
            structural: false,
            cwd: "/repo",
        };
        const loose = await runGrepJudgeStage({ ...base, provider, threshold: 0.4 });
        expect(loose.judged).toBe(true);
        const keptLoose = loose.judge?.kept ?? 0;
        expect(keptLoose).toBeGreaterThan(0);
        const callsAfterFirst = counter.calls;

        const strict = await runGrepJudgeStage({ ...base, provider, threshold: 0.95 });
        expect(strict.judged).toBe(true);
        expect(strict.judge?.kept).toBe(0);
        // No new transport: probabilities came from the workspace cache …
        expect(counter.calls).toBe(callsAfterFirst);
        expect(strict.judge?.cacheHits ?? 0).toBeGreaterThan(0);
        // … and the kept set changed purely by re-gating the cached probability.
        expect(strict.judge?.kept).toBeLessThan(keptLoose);
        expect(GREP_JUDGE_THRESHOLD).toBe(0.4);
    });

    it("(4) cold miss costs one transport call; two concurrent identical misses cost two (no in-flight dedup)", async () => {
        const root = mkdtempSync(join(tmpdir(), "judge-int-"));
        const cacheDir = workspaceCacheDir(root);
        const counter = { calls: 0 };
        const cold = await freshJudge(cacheDir, counter, 0.75).judgeNouls(noulInput(QUERY, UNIT_TEXT));
        expect(cold.cacheHits).toBe(0);
        expect(counter.calls).toBe(1);

        const root2 = mkdtempSync(join(tmpdir(), "judge-int-"));
        const cacheDir2 = workspaceCacheDir(root2);
        const counter2 = { calls: 0 };
        const [a, b] = await Promise.all([
            freshJudge(cacheDir2, counter2, 0.75).judgeNouls(noulInput(QUERY, UNIT_TEXT)),
            freshJudge(cacheDir2, counter2, 0.75).judgeNouls(noulInput(QUERY, UNIT_TEXT)),
        ]);
        expect(a.p.get("u0")).toBe(0.75);
        expect(b.p.get("u0")).toBe(0.75);
        // Actual behaviour: concurrent misses do NOT coalesce — each instance
        // checks its own lazily-loaded cache before any fetch, so both miss.
        expect(counter2.calls).toBe(2);
    });

    it("(5) Pi and MCP resolvers share the same workspace cache dir and read each other's verdicts", async () => {
        const root = mkdtempSync(join(tmpdir(), "judge-int-"));
        const savedMode = process.env.PI_SMARTREAD_JUDGE_MODE;
        const savedKey = process.env.PI_SMARTREAD_JUDGE_API_KEY;
        const savedModel = process.env.PI_SMARTREAD_JUDGE_MODEL;
        process.env.PI_SMARTREAD_JUDGE_MODE = "cloud";
        process.env.PI_SMARTREAD_JUDGE_API_KEY = "test-key";
        delete process.env.PI_SMARTREAD_JUDGE_MODEL;
        try {
            // Both surfaces are off by default (no key / no settings): unavailable, no cache.
            // With cloud mode + key both resolve a judge against the same root …
            const pi = await resolvePiJudge(root, undefined);
            const mcp = await resolveMcpJudge(root);
            expect("judge" in pi).toBe(true);
            expect("judge" in mcp).toBe(true);
            if (!("judge" in pi) || !("judge" in mcp)) return;
            expect(pi.judge.info.model).toBe(mcp.judge.info.model);
            expect(pi.judge.info.baseUrl).toBe(mcp.judge.info.baseUrl);

            // … sharing the workspace verdict cache: seed via a fake-transport
            // judge at the same cache dir, then the MCP-resolved judge must
            // hit without network. The aborted signal proves no fetch happens:
            // a miss would throw "aborted" instead of hanging on the network.
            const seedCounter = { calls: 0 };
            await freshJudge(workspaceCacheDir(root), seedCounter, 0.66, pi.judge.info.model)
                .judgeNouls(noulInput(QUERY, UNIT_TEXT));
            expect(seedCounter.calls).toBe(1);
            const aborted = new AbortController();
            aborted.abort();
            const viaMcp = await mcp.judge.judgeNouls(noulInput(QUERY, UNIT_TEXT), aborted.signal);
            expect(viaMcp.p.get("u0")).toBe(0.66);
            expect(viaMcp.cacheHits).toBe(1);
        } finally {
            if (savedMode === undefined) delete process.env.PI_SMARTREAD_JUDGE_MODE;
            else process.env.PI_SMARTREAD_JUDGE_MODE = savedMode;
            if (savedKey === undefined) delete process.env.PI_SMARTREAD_JUDGE_API_KEY;
            else process.env.PI_SMARTREAD_JUDGE_API_KEY = savedKey;
            if (savedModel === undefined) delete process.env.PI_SMARTREAD_JUDGE_MODEL;
            else process.env.PI_SMARTREAD_JUDGE_MODEL = savedModel;
        }
    });

    it("(6) cache key covers the model alias only — baseUrl and backend are NOT keyed (stale-verdict risk per D53)", async () => {
        const root = mkdtempSync(join(tmpdir(), "judge-int-"));
        const cacheDir = workspaceCacheDir(root);
        const counter = { calls: 0 };
        await freshJudge(cacheDir, counter, 0.75).judgeNouls(noulInput(QUERY, UNIT_TEXT));

        // Same alias, different endpoint: still a hit — provider/baseUrl are
        // not part of judgeCacheKey.
        const otherEndpoint = new CloudJudge({
            apiKey: "test-key",
            baseUrl: "https://other-endpoint.test",
            model: MODEL,
            cacheDir,
            fetchFn: fakeFetch(counter, 0.1),
        });
        const rEndpoint = await otherEndpoint.judgeNouls(noulInput(QUERY, UNIT_TEXT));
        expect(rEndpoint.cacheHits).toBe(1);
        expect(rEndpoint.p.get("u0")).toBe(0.75);

        // Same model string, different backend (local): still a hit — the key
        // carries no backend/provider discriminator either.
        const local = new LocalJudge({
            baseUrl: "http://127.0.0.1:1",
            model: MODEL,
            cacheDir,
            fetchFn: fakeFetch(counter, 0.1),
        });
        const rLocal = await local.judgeNouls(noulInput(QUERY, UNIT_TEXT));
        expect(rLocal.cacheHits).toBe(1);
        expect(rLocal.p.get("u0")).toBe(0.75);
        expect(counter.calls).toBe(1);
    });
});
