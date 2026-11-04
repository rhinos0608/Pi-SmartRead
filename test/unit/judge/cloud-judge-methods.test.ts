import { describe, expect, it, vi } from "vitest";
import { CLOUD_JUDGE_DEFAULT_BASE_URL, CloudJudge } from "../../../src/judge/cloud-judge.js";
import { JudgeError } from "../../../src/judge/types.js";

const LUNA = "openai/gpt-6-luna-decisions";
const PPLX = "perplexity/pplx-decider-v1.1-27b";
const JEV = "~typesafe/jev-latest";

function item(id: string, text: string) {
    return { id, state: { text }, question: (ref: string) => ({ type: "noul" as const, instructions: `Q ${ref}` }) };
}

function okJson(body: unknown) {
    return new Response(JSON.stringify(body), { status: 200 });
}

describe("CloudJudge M1 singleton requests (D-80)", () => {
    it("sends one request per candidate with a singleton units/questions body", async () => {
        const seen: Array<{ units: string[]; questions: string[]; instructions: string[] }> = [];
        const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
            const body = JSON.parse(init!.body as string) as {
                model: string; state: { units: Record<string, unknown> }; questions: Record<string, { instructions: string }>;
            };
            seen.push({
                units: Object.keys(body.state.units),
                questions: Object.keys(body.questions),
                instructions: Object.values(body.questions).map((q) => q.instructions),
            });
            const answers: Record<string, number> = {};
            for (const k of Object.keys(body.questions)) answers[k] = k === "a" ? 0.9 : k === "b" ? 0.2 : 0.5;
            return okJson({ answers, usage: { input_tokens: 10, cost: 0.001 } });
        });
        const judge = new CloudJudge({ model: LUNA, apiKey: "k", cache: null, fetchFn, sleepFn: async () => {} });
        const res = await judge.judgeNouls({
            shared: { query: "q" },
            items: [item("a", "x"), item("b", "y"), item("c", "z")],
        });
        expect(fetchFn).toHaveBeenCalledTimes(3);
        expect(seen.map((s) => s.units)).toEqual([["a"], ["b"], ["c"]]);
        expect(seen.map((s) => s.questions)).toEqual([["a"], ["b"], ["c"]]);
        for (const s of seen) {
            expect(s.instructions).toHaveLength(1);
            expect(s.instructions[0]).toContain(`units.${s.units[0]}`);
        }
        // Results map back by candidate id.
        expect(res.p.get("a")).toBe(0.9);
        expect(res.p.get("b")).toBe(0.2);
        expect(res.p.get("c")).toBe(0.5);
        expect(res.unjudged).toEqual([]);
        expect(res.usage).toEqual({ inputTokens: 30, costUsd: 0.003, requests: 3 });
        expect(judge.info.model).toBe(LUNA);
    });

    it("reuses the per-item cache (no network on repeat)", async () => {
        const { JudgeCache } = await import("../../../src/judge/judge-cache.js");
        const cache = new JudgeCache(undefined);
        const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
            const body = JSON.parse(init!.body as string) as { questions: Record<string, unknown> };
            const answers: Record<string, number> = {};
            for (const k of Object.keys(body.questions)) answers[k] = 0.7;
            return okJson({ answers, usage: {} });
        });
        const m1 = new CloudJudge({ model: LUNA, apiKey: "k", cache, fetchFn, sleepFn: async () => {} });
        await m1.judgeNouls({ shared: { query: "q" }, items: [item("a", "x")] });
        expect(fetchFn).toHaveBeenCalledTimes(1);
        const again = await m1.judgeNouls({ shared: { query: "q" }, items: [item("a", "x")] });
        expect(fetchFn).toHaveBeenCalledTimes(1);
        expect(again.cacheHits).toBe(1);
        expect(again.p.get("a")).toBe(0.7);
    });

    it("never serves a verdict cached before the model's method changed", async () => {
        const { JudgeCache, judgeCacheKey, JUDGE_CACHE_CANONICAL_REF } = await import("../../../src/judge/judge-cache.js");
        const cache = new JudgeCache(undefined);
        const a = item("a", "x");
        // A verdict persisted under the pre-D-80 key shape (no method component).
        cache.set(judgeCacheKey({
            backend: "cloud",
            baseUrl: CLOUD_JUDGE_DEFAULT_BASE_URL,
            model: LUNA,
            shared: { query: "q" },
            state: a.state,
            question: a.question(JUDGE_CACHE_CANONICAL_REF),
        }), 0.01);
        const fetchFn = vi.fn(async () => okJson({ answers: { a: 0.8 }, usage: {} }));
        const m1 = new CloudJudge({ model: LUNA, apiKey: "k", cache, fetchFn, sleepFn: async () => {} });
        const res = await m1.judgeNouls({ shared: { query: "q" }, items: [a] });
        expect(fetchFn).toHaveBeenCalledTimes(1);
        expect(res.cacheHits).toBe(0);
        expect(res.p.get("a")).toBe(0.8);
    });
});

describe("CloudJudge M2 forward/reverse averaging (D-80)", () => {
    it("sends forward then exact-reverse requests and averages per candidate", async () => {
        const bodies: Array<{ units: string[]; questions: string[] }> = [];
        let call = 0;
        const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
            call += 1;
            const body = JSON.parse(init!.body as string) as {
                state: { units: Record<string, unknown> }; questions: Record<string, unknown>;
            };
            bodies.push({ units: Object.keys(body.state.units), questions: Object.keys(body.questions) });
            // Forward leg then reverse leg, with known per-direction probabilities.
            const answers = call === 1 ? { a: 0.2, b: 0.4, c: 0.6 } : { a: 0.8, b: 0.6, c: 0.4 };
            return okJson({ answers, usage: { input_tokens: 7 } });
        });
        const judge = new CloudJudge({ model: PPLX, apiKey: "k", cache: null, fetchFn, sleepFn: async () => {} });
        const res = await judge.judgeNouls({
            shared: { query: "q" },
            items: [item("a", "x"), item("b", "y"), item("c", "z")],
        });
        expect(fetchFn).toHaveBeenCalledTimes(2);
        // Forward keeps canonical order; reverse is the exact reverse (units and questions driven by one order).
        expect(bodies[0]).toEqual({ units: ["a", "b", "c"], questions: ["a", "b", "c"] });
        expect(bodies[1]).toEqual({ units: ["c", "b", "a"], questions: ["c", "b", "a"] });
        // Study aggregation: (forward + reverse) / 2 per candidate.
        expect(res.p.get("a")).toBeCloseTo(0.5, 12);
        expect(res.p.get("b")).toBeCloseTo(0.5, 12);
        expect(res.p.get("c")).toBeCloseTo(0.5, 12);
        expect(res.unjudged).toEqual([]);
        expect(res.usage).toEqual({ inputTokens: 14, requests: 2 });
    });

    it("averages direction-specific probabilities on asymmetric legs", async () => {
        let call = 0;
        const fetchFn = vi.fn(async () => {
            call += 1;
            const answers = call === 1 ? { a: 0.1, b: 0.9 } : { a: 0.3, b: 0.7 };
            return okJson({ answers, usage: {} });
        });
        const judge = new CloudJudge({ model: PPLX, apiKey: "k", cache: null, fetchFn, sleepFn: async () => {} });
        const res = await judge.judgeNouls({ shared: { query: "q" }, items: [item("a", "x"), item("b", "y")] });
        expect(res.p.get("a")).toBeCloseTo(0.2, 12);
        expect(res.p.get("b")).toBeCloseTo(0.8, 12);
    });

    it("marks a candidate unjudged when one leg has no usable answer (no fallback to the surviving leg)", async () => {
        let call = 0;
        const fetchFn = vi.fn(async () => {
            call += 1;
            // Reverse leg answers only "a": "b" has a missing leg.
            const answers = call === 1 ? { a: 0.2, b: 0.4 } : { a: 0.6 };
            return okJson({ answers, usage: {} });
        });
        const judge = new CloudJudge({ model: PPLX, apiKey: "k", cache: null, fetchFn, sleepFn: async () => {} });
        const res = await judge.judgeNouls({ shared: { query: "q" }, items: [item("a", "x"), item("b", "y")] });
        expect(res.p.get("a")).toBeCloseTo(0.4, 12);
        expect(res.p.has("b")).toBe(false);
        expect(res.unjudged).toEqual([{ id: "b", code: "bad_response" }]);
    });
});

describe("CloudJudge M0 path unchanged (D-80)", () => {
    it("Jev keeps the packed shape: one request for many candidates", async () => {
        const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) =>
            okJson({ answers: { a: 0.9, b: 0.1 }, usage: {} }));
        const judge = new CloudJudge({ model: JEV, apiKey: "k", cache: null, fetchFn, sleepFn: async () => {} });
        const res = await judge.judgeNouls({ shared: {}, items: [item("a", "x"), item("b", "y")] });
        expect(fetchFn).toHaveBeenCalledTimes(1);
        expect(res.p.get("a")).toBe(0.9);
        expect(res.p.get("b")).toBe(0.1);
    });
});

describe("CloudJudge per-model failure semantics (D-80)", () => {
    it("one failing M1 sub-request rejects the whole call, like today's single-request failure", async () => {
        const failing = vi.fn(async (_url: string, init?: RequestInit) => {
            const body = JSON.parse(init!.body as string) as { questions: Record<string, unknown> };
            if ("b" in body.questions) throw new JudgeError("network", "network");
            return okJson({ answers: { a: 0.9 }, usage: {} });
        });
        const m1 = new CloudJudge({ model: LUNA, apiKey: "k", cache: null, fetchFn: failing, sleepFn: async () => {} });
        await expect(m1.judgeNouls({ shared: {}, items: [item("a", "x"), item("b", "y")] }))
            .rejects.toMatchObject({ code: "network" });
        // Baseline: an M0 packed request failing rejects the same way.
        const m0fetch = vi.fn(async () => { throw new JudgeError("network", "network"); });
        const m0 = new CloudJudge({ model: JEV, apiKey: "k", cache: null, fetchFn: m0fetch, sleepFn: async () => {} });
        await expect(m0.judgeNouls({ shared: {}, items: [item("a", "x"), item("b", "y")] }))
            .rejects.toMatchObject({ code: "network" });
    });

    it("a failing M2 reverse leg rejects the whole call (never silently falls back to forward-only)", async () => {
        let call = 0;
        const fetchFn = vi.fn(async () => {
            call += 1;
            if (call === 2) throw new JudgeError("timeout", "timeout");
            return okJson({ answers: { a: 0.5 }, usage: {} });
        });
        const judge = new CloudJudge({ model: PPLX, apiKey: "k", cache: null, fetchFn, sleepFn: async () => {} });
        await expect(judge.judgeNouls({ shared: { query: "q" }, items: [item("a", "x")] }))
            .rejects.toMatchObject({ code: "timeout" });
    });

    it("an aborted signal rejects M1/M2 without useful results (signal honored)", async () => {
        const fetchFn = vi.fn(async () => okJson({ answers: { a: 0.5 }, usage: {} }));
        const controller = new AbortController();
        controller.abort();
        const m1 = new CloudJudge({ model: LUNA, apiKey: "k", cache: null, fetchFn, sleepFn: async () => {} });
        await expect(m1.judgeNouls({ shared: {}, items: [item("a", "x")] }, controller.signal))
            .rejects.toMatchObject({ code: "aborted" });
        const m2 = new CloudJudge({ model: PPLX, apiKey: "k", cache: null, fetchFn, sleepFn: async () => {} });
        await expect(m2.judgeNouls({ shared: { query: "q" }, items: [item("a", "x")] }, controller.signal))
            .rejects.toMatchObject({ code: "aborted" });
    });
});
