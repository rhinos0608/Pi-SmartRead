import { describe, expect, it, vi } from "vitest";
import { LocalJudge } from "../../../src/judge/local-judge.js";

function item(id: string, text: string) {
    return { id, state: { text }, question: (ref: string) => ({ type: "noul" as const, instructions: `Q ${ref}` }) };
}

describe("LocalJudge", () => {
    it("sends one request per item with unit state and unit ref", async () => {
        const seen: Array<{ state: unknown; questions: unknown }> = [];
        const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
            const body = JSON.parse(init!.body as string);
            seen.push(body);
            return new Response(JSON.stringify({ answers: { q: 0.6 }, usage: {} }), { status: 200 });
        });
        const judge = new LocalJudge({ baseUrl: "http://127.0.0.1:9", cache: null, fetchFn, sleepFn: async () => {} });
        const res = await judge.judgeNouls({ shared: { lang: "ts" }, items: [item("a", "x"), item("b", "y")] });
        expect(fetchFn).toHaveBeenCalledTimes(2);
        expect((fetchFn.mock.calls[0] as [string, RequestInit])[0]).toBe("http://127.0.0.1:9/v1/systemone");
        expect(seen[0]!.state).toEqual({ lang: "ts", unit: { text: "x" } });
        expect((seen[0]!.questions as Record<string, { instructions: string }>).q!.instructions).toContain("unit");
        expect(res.p.get("a")).toBe(0.6);
        expect(res.usage.requests).toBe(2);
        expect(judge.info.backend).toBe("local");
        expect(judge.info.model).toBe("von");
    });

    it("skips oversized units with unit_too_large without network", async () => {
        const fetchFn = vi.fn(async () =>
            new Response(JSON.stringify({ answers: { q: 0.5 }, usage: {} }), { status: 200 }));
        const judge = new LocalJudge({ baseUrl: "http://127.0.0.1:9", cache: null, fetchFn, sleepFn: async () => {} });
        const res = await judge.judgeNouls({ shared: {}, items: [item("big", "z".repeat(40_000))] });
        expect(fetchFn).not.toHaveBeenCalled();
        expect(res.unjudged).toEqual([{ id: "big", code: "unit_too_large" }]);
    });

    it("exposes noul_raw (not the banded commit) to gates", async () => {
        const fetchFn = vi.fn(async () =>
            new Response(JSON.stringify({ answers: { q: { noul: 0.8, noul_raw: 0.522 } }, usage: {} }), { status: 200 }));
        const judge = new LocalJudge({ baseUrl: "http://127.0.0.1:9", cache: null, fetchFn, sleepFn: async () => {} });
        const res = await judge.judgeNouls({ shared: {}, items: [item("a", "x")] });
        expect(res.p.get("a")).toBe(0.522);
    });

    it("falls back to banded noul when noul_raw is absent", async () => {
        const fetchFn = vi.fn(async () =>
            new Response(JSON.stringify({ answers: { q: { noul: 0.2 } }, usage: {} }), { status: 200 }));
        const judge = new LocalJudge({ baseUrl: "http://127.0.0.1:9", cache: null, fetchFn, sleepFn: async () => {} });
        const res = await judge.judgeNouls({ shared: {}, items: [item("a", "x")] });
        expect(res.p.get("a")).toBe(0.2);
    });

    // von's MPS backend aborts the server process on overlapping inference.
    it("serializes requests to one endpoint across calls and instances", async () => {
        let live = 0;
        let maxLive = 0;
        const fetchFn = vi.fn(async () => {
            live++;
            maxLive = Math.max(maxLive, live);
            await new Promise((r) => setTimeout(r, 5));
            live--;
            return new Response(JSON.stringify({ answers: { q: 0.5 }, usage: {} }), { status: 200 });
        });
        const opts = { baseUrl: "http://127.0.0.1:9", cache: null, fetchFn, sleepFn: async () => {} };
        const items = ["a", "b", "c"].map((id) => item(id, "x"));
        const results = await Promise.all([
            new LocalJudge(opts).judgeNouls({ shared: {}, items }),
            new LocalJudge(opts).judgeNouls({ shared: {}, items }),
        ]);
        expect(maxLive).toBe(1);
        expect(fetchFn).toHaveBeenCalledTimes(6);
        expect(results.map((r) => r.p.size)).toEqual([3, 3]);
    });

    it("keeps serving queued requests after one request fails", async () => {
        const failingFetch = async () => {
            throw new TypeError("fetch failed");
        };
        const succeedingFetch = vi.fn(async () =>
            new Response(JSON.stringify({ answers: { q: 0.5 }, usage: {} }), { status: 200 }));
        const baseUrl = "http://127.0.0.1:10";
        const [failed, ok] = await Promise.allSettled([
            new LocalJudge({ baseUrl, cache: null, fetchFn: failingFetch, sleepFn: async () => {} }).judgeNouls({ shared: {}, items: [item("a", "x")] }),
            new LocalJudge({ baseUrl, cache: null, fetchFn: succeedingFetch, sleepFn: async () => {} }).judgeNouls({ shared: {}, items: [item("b", "x")] }),
        ]);
        expect(failed.status).toBe("rejected");
        expect(ok.status).toBe("fulfilled");
    });
});
