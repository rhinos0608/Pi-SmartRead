import { describe, expect, it, vi } from "vitest";
import { CloudJudge } from "../../../src/judge/cloud-judge.js";

function item(id: string, text: string) {
    return { id, state: { text }, question: (ref: string) => ({ type: "noul" as const, instructions: `Q ${ref}` }) };
}

describe("CloudJudge", () => {
    it("batches many questions into one request and maps usage.cost", async () => {
        const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) =>
            new Response(JSON.stringify({ answers: { a: 0.9, b: 0.1 }, usage: { input_tokens: 42, cost: 0.001 } }),
                { status: 200 }),
        );
        const judge = new CloudJudge({ apiKey: "k", cache: null, fetchFn, sleepFn: async () => {} });
        const res = await judge.judgeNouls({ shared: {}, items: [item("a", "x"), item("b", "y")] });
        expect(fetchFn).toHaveBeenCalledTimes(1);
        const body = JSON.parse(((fetchFn.mock.calls[0] as [string, RequestInit])[1].body as string));
        expect(body.state.units.a).toEqual({ text: "x" });
        expect(body.questions.a.instructions).toContain("units.a");
        expect(res.p.get("a")).toBe(0.9);
        expect(res.usage).toEqual({ inputTokens: 42, costUsd: 0.001, requests: 1 });
        expect(judge.info).toEqual({ backend: "cloud", model: "~typesafe/jev-latest", baseUrl: "https://openrouter.ai/api/alpha" });
    });

    it("splits by the token budget for large states", async () => {
        const big = "z".repeat(50_000); // ~12.5k tokens each; two exceed 24k
        const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
            const body = JSON.parse(init!.body as string);
            const answers: Record<string, number> = {};
            for (const k of Object.keys(body.questions)) answers[k] = 0.5;
            return new Response(JSON.stringify({ answers, usage: {} }), { status: 200 });
        });
        const judge = new CloudJudge({ apiKey: "k", cache: null, fetchFn, sleepFn: async () => {} });
        const res = await judge.judgeNouls({ shared: {}, items: [item("a", big), item("b", big), item("c", big)] });
        expect(fetchFn).toHaveBeenCalledTimes(3);
        expect(res.p.size).toBe(3);
        expect(res.usage.requests).toBe(3);
    });

    it("counts cache hits and skips network", async () => {
        const { JudgeCache } = await import("../../../src/judge/judge-cache.js");
        const cache = new JudgeCache(undefined);
        const fetchFn = vi.fn(async () =>
            new Response(JSON.stringify({ answers: { a: 0.8 }, usage: {} }), { status: 200 }));
        const judge = new CloudJudge({ apiKey: "k", cache, fetchFn, sleepFn: async () => {} });
        await judge.judgeNouls({ shared: {}, items: [item("a", "x")] });
        expect(fetchFn).toHaveBeenCalledTimes(1);
        const again = await judge.judgeNouls({ shared: {}, items: [item("a", "x")] });
        expect(fetchFn).toHaveBeenCalledTimes(1);
        expect(again.cacheHits).toBe(1);
        expect(again.p.get("a")).toBe(0.8);
    });

    it("marks non-numeric answers as unjudged bad_response", async () => {
        const fetchFn = vi.fn(async () =>
            new Response(JSON.stringify({ answers: { a: "yes" }, usage: {} }), { status: 200 }));
        const judge = new CloudJudge({ apiKey: "k", cache: null, fetchFn, sleepFn: async () => {} });
        const res = await judge.judgeNouls({ shared: {}, items: [item("a", "x")] });
        expect(res.unjudged).toEqual([{ id: "a", code: "bad_response" }]);
    });

    it("uses the banded noul for object answers (no raw preference on cloud)", async () => {
        const fetchFn = vi.fn(async () =>
            new Response(JSON.stringify({ answers: { a: { noul: 0.8, noul_raw: 0.522 } }, usage: {} }), { status: 200 }));
        const judge = new CloudJudge({ apiKey: "k", cache: null, fetchFn, sleepFn: async () => {} });
        const res = await judge.judgeNouls({ shared: {}, items: [item("a", "x")] });
        expect(res.p.get("a")).toBe(0.8);
    });
});
