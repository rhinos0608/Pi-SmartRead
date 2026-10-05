import { describe, expect, it, vi } from "vitest";
import { postSystemOneDecisions } from "../../../src/judge/systemone-client.js";
import { JudgeError } from "../../../src/judge/types.js";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
}

const base = {
    baseUrl: "https://example.test",
    route: "/decisions",
    model: "m",
    state: {},
    questions: { q: { type: "noul", instructions: "x" } as const },
};

describe("postSystemOneDecisions", () => {
    it("sends model/state/questions with bearer key", async () => {
        const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(200, { answers: { q: 0.5 }, usage: {} }));
        await postSystemOneDecisions({ ...base, apiKey: "secret-key", fetchFn, sleepFn: async () => {} });
        const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
        expect(fetchFn.mock.calls[0]![0]).toBe("https://example.test/decisions");
        const sent = JSON.parse(init.body as string);
        expect(sent).toEqual({ model: "m", state: {}, questions: base.questions });
        expect((init.headers as Record<string, string>).authorization).toBe("Bearer secret-key");
    });

    it("retries 429/5xx with backoff and succeeds", async () => {
        const sleeps: number[] = [];
        const fetchFn = vi
            .fn(async () => jsonResponse(200, { answers: { q: 0.7 }, usage: {} }))
            .mockImplementationOnce(async () => jsonResponse(429, {}))
            .mockImplementationOnce(async () => jsonResponse(500, {}));
        const res = await postSystemOneDecisions({ ...base, fetchFn, sleepFn: async (ms) => { sleeps.push(ms); } });
        expect(res.answers).toEqual({ q: 0.7 });
        expect(sleeps).toEqual([500, 1000]);
    });

    it("skips the retry delay after the final attempt", async () => {
        const fetchFn = vi.fn(async () => jsonResponse(503, {}));
        const sleepFn = vi.fn(async () => {});
        await expect(postSystemOneDecisions({ ...base, fetchFn, sleepFn })).rejects.toMatchObject({ code: "http_503" });
        expect(fetchFn).toHaveBeenCalledTimes(3);
        expect(sleepFn).toHaveBeenCalledTimes(2);
    });

    it("aborts an in-progress retry delay", async () => {
        const controller = new AbortController();
        const fetchFn = vi.fn(async () => jsonResponse(429, {}));
        const sleepFn = vi.fn((_ms: number, signal?: AbortSignal) => new Promise<void>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(new JudgeError("aborted", "aborted")), { once: true });
        }));
        const pending = postSystemOneDecisions({ ...base, signal: controller.signal, fetchFn, sleepFn });
        await vi.waitFor(() => expect(sleepFn).toHaveBeenCalledTimes(1));
        controller.abort();
        await expect(pending).rejects.toMatchObject({ code: "aborted" });
        expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it("waits for the retry delay before sending the next request", async () => {
        let releaseSleep!: () => void;
        const fetchFn = vi
            .fn(async () => jsonResponse(200, { answers: { q: 0.7 }, usage: {} }))
            .mockImplementationOnce(async () => jsonResponse(429, {}));
        const sleepFn = vi.fn(() => new Promise<void>((resolve) => { releaseSleep = resolve; }));
        const pending = postSystemOneDecisions({ ...base, fetchFn, sleepFn });

        await vi.waitFor(() => expect(sleepFn).toHaveBeenCalledTimes(1));
        expect(fetchFn).toHaveBeenCalledTimes(1);
        releaseSleep();
        await pending;
        expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it("honors retry-after header capped at 5000ms", async () => {
        const sleeps: number[] = [];
        const fetchFn = vi
            .fn(async () => jsonResponse(200, { answers: { q: 0.1 }, usage: {} }))
            .mockImplementationOnce(async () => jsonResponse(429, {}, { "retry-after": "120" }));
        await postSystemOneDecisions({ ...base, fetchFn, sleepFn: async (ms) => { sleeps.push(ms); } });
        expect(sleeps).toEqual([5000]);
    });

    it("honors retry-after-ms header", async () => {
        const sleeps: number[] = [];
        const fetchFn = vi
            .fn(async () => jsonResponse(200, { answers: { q: 0.1 }, usage: {} }))
            .mockImplementationOnce(async () => jsonResponse(429, {}, { "retry-after-ms": "250" }));
        await postSystemOneDecisions({ ...base, fetchFn, sleepFn: async (ms) => { sleeps.push(ms); } });
        expect(sleeps).toEqual([250]);
    });

    it("does not retry 400 and throws http_400 without the key", async () => {
        const fetchFn = vi.fn(async () => jsonResponse(400, { error: "bad" }));
        const err = await postSystemOneDecisions({ ...base, apiKey: "secret-key", fetchFn, sleepFn: async () => {} }).catch((e) => e);
        expect(err).toBeInstanceOf(JudgeError);
        expect((err as JudgeError).code).toBe("http_400");
        expect(fetchFn).toHaveBeenCalledTimes(1);
        expect(String(err)).not.toContain("secret-key");
        expect(JSON.stringify(err)).not.toContain("secret-key");
    });

    it("throws bad_response for out-of-range noul", async () => {
        const fetchFn = vi.fn(async () => jsonResponse(200, { answers: { q: 7 }, usage: {} }));
        const err = await postSystemOneDecisions({ ...base, fetchFn, sleepFn: async () => {} }).catch((e) => e);
        expect((err as JudgeError).code).toBe("bad_response");
    });

    it("accepts von detail objects with noul and noul_raw", async () => {
        const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) =>
            jsonResponse(200, { answers: { q: { noul: 0.8, noul_raw: 0.522 } }, usage: {} }));
        const res = await postSystemOneDecisions({ ...base, fetchFn, sleepFn: async () => {} });
        expect(res.answers).toEqual({ q: { noul: 0.8, noul_raw: 0.522 } });
    });

    it("rejects detail objects with out-of-range noul_raw", async () => {
        const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) =>
            jsonResponse(200, { answers: { q: { noul: 0.8, noul_raw: 1.5 } }, usage: {} }));
        const err = await postSystemOneDecisions({ ...base, fetchFn, sleepFn: async () => {} }).catch((e) => e);
        expect((err as JudgeError).code).toBe("bad_response");
    });

    it("rejects detail objects with out-of-range noul", async () => {
        const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) =>
            jsonResponse(200, { answers: { q: { noul: 2, noul_raw: 0.5 } }, usage: {} }));
        const err = await postSystemOneDecisions({ ...base, fetchFn, sleepFn: async () => {} }).catch((e) => e);
        expect((err as JudgeError).code).toBe("bad_response");
    });

    it("maps network failure to network code without leaking the key", async () => {
        const fetchFn = vi.fn(async () => { throw new TypeError("fetch failed"); });
        const err = await postSystemOneDecisions({ ...base, apiKey: "secret-key", fetchFn, sleepFn: async () => {} }).catch((e) => e);
        expect((err as JudgeError).code).toBe("network");
        expect(String(err)).not.toContain("secret-key");
    });

    it("maps caller abort to aborted", async () => {
        const controller = new AbortController();
        controller.abort();
        const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
            if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
            return jsonResponse(200, { answers: { q: 0.5 }, usage: {} });
        });
        const err = await postSystemOneDecisions({ ...base, signal: controller.signal, fetchFn, sleepFn: async () => {} }).catch((e) => e);
        expect((err as JudgeError).code).toBe("aborted");
    });

    it("maps per-attempt timeout to timeout after 3 attempts", async () => {
        const fetchFn = vi.fn(async () => {
            await new Promise((r) => setTimeout(r, 30));
            throw new DOMException("timed out", "AbortError");
        });
        // Shrink the timeout path by using an already-slow abort: rely on retry loop.
        const err = await postSystemOneDecisions({ ...base, fetchFn, sleepFn: async () => {} }).catch((e) => e);
        expect((err as JudgeError).code).toBe("timeout");
        expect(fetchFn).toHaveBeenCalledTimes(3);
    }, 30000);
});
