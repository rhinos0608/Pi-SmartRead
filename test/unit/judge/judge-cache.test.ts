import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JUDGE_CACHE_CANONICAL_REF, JudgeCache, judgeCacheKey, resolveJudgeCacheMaxAgeMs, stableStringify } from "../../../src/judge/judge-cache.js";

const q = { type: "noul" as const, instructions: "i" };

function keyArgs(overrides: Record<string, unknown> = {}) {
    return {
        backend: "cloud" as const,
        baseUrl: "https://judge.test",
        model: "m",
        shared: {},
        state: { t: "x" },
        question: q,
        ...overrides,
    };
}

describe("judge-cache", () => {
    it("stableStringify is key-order independent", () => {
        expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
    });

    it("miss then hit persists across instances via JSONL", () => {
        const dir = mkdtempSync(join(tmpdir(), "judge-cache-"));
        const c1 = new JudgeCache(dir);
        const key = judgeCacheKey(keyArgs());
        expect(c1.get(key)).toBeUndefined();
        c1.set(key, 0.77);
        const c2 = new JudgeCache(dir);
        expect(c2.get(key)).toBe(0.77);
        expect(readFileSync(join(dir, "verdicts.jsonl"), "utf-8").trim().split("\n")).toHaveLength(1);
    });

    it("tolerates corrupt lines and old-format entries without timestamps", () => {
        const dir = mkdtempSync(join(tmpdir(), "judge-cache-"));
        writeFileSync(join(dir, "verdicts.jsonl"), "not json\n{\"key\":\"k\",\"p\":0.5}\n[broken\n", "utf-8");
        const c = new JudgeCache(dir);
        // Old-format entries without a timestamp are misses, never errors.
        expect(c.get("k")).toBeUndefined();
        expect(c.size()).toBe(0);
    });

    it("ignores cached values outside the probability range", () => {
        const dir = mkdtempSync(join(tmpdir(), "judge-cache-"));
        const ts = Date.now();
        writeFileSync(
            join(dir, "verdicts.jsonl"),
            `{"key":"below","p":-0.1,"ts":${ts}}\n{"key":"above","p":1.1,"ts":${ts}}\n{"key":"valid","p":0.5,"ts":${ts}}\n`,
            "utf-8",
        );
        const cache = new JudgeCache(dir);
        expect(cache.get("below")).toBeUndefined();
        expect(cache.get("above")).toBeUndefined();
        expect(cache.get("valid")).toBe(0.5);
        expect(cache.size()).toBe(1);
        cache.set("invalid", 2);
        expect(cache.get("invalid")).toBeUndefined();
    });

    it("bounds the log when the same verdict is updated repeatedly", () => {
        const dir = mkdtempSync(join(tmpdir(), "judge-cache-"));
        const cache = new JudgeCache(dir, 2);
        for (let i = 0; i < 12; i++) cache.set("same", i / 12);
        expect(cache.size()).toBe(1);
        expect(readFileSync(join(dir, "verdicts.jsonl"), "utf-8").trim().split("\n").length).toBeLessThanOrEqual(4);
    });

    it("evicts the least recently used entry during compaction", () => {
        const dir = mkdtempSync(join(tmpdir(), "judge-cache-"));
        const cache = new JudgeCache(dir, 3);
        cache.set("k1", 0.1);
        cache.set("k2", 0.2);
        cache.set("k3", 0.3);
        expect(cache.get("k1")).toBe(0.1);
        cache.set("k4", 0.4);
        expect(cache.get("k1")).toBe(0.1);
        expect(cache.get("k2")).toBeUndefined();
        expect(cache.get("k3")).toBe(0.3);
        expect(cache.get("k4")).toBe(0.4);
    });

    it("compacts when over capacity, keeping newest", () => {
        const dir = mkdtempSync(join(tmpdir(), "judge-cache-"));
        const c = new JudgeCache(dir, 3);
        c.set("k1", 0.1);
        c.set("k2", 0.2);
        c.set("k3", 0.3);
        c.set("k4", 0.4);
        expect(c.size()).toBe(3);
        expect(c.get("k1")).toBeUndefined();
        expect(c.get("k4")).toBe(0.4);
        // Compacted file contains only newest entries.
        expect(readFileSync(join(dir, "verdicts.jsonl"), "utf-8").trim().split("\n")).toHaveLength(3);
    });

    it("canonical ref keeps identical backend/endpoint keys stable", () => {
        const a = judgeCacheKey(keyArgs({ question: { ...q, instructions: "Q ref" } }));
        const b = judgeCacheKey(keyArgs({ question: { ...q, instructions: "Q ref" } }));
        expect(a).toBe(b);
        expect(JUDGE_CACHE_CANONICAL_REF).toBe("ref");
    });

    it("keys differ across backend kind", () => {
        expect(judgeCacheKey(keyArgs()))
            .not.toBe(judgeCacheKey(keyArgs({ backend: "local" })));
    });

    it("keys differ across base URL", () => {
        expect(judgeCacheKey(keyArgs()))
            .not.toBe(judgeCacheKey(keyArgs({ baseUrl: "https://other.test" })));
    });

    it("normalizes equivalent base URLs to the same key", () => {
        expect(judgeCacheKey(keyArgs()))
            .toBe(judgeCacheKey(keyArgs({ baseUrl: "https://judge.test/" })));
        expect(judgeCacheKey(keyArgs()))
            .toBe(judgeCacheKey(keyArgs({ baseUrl: "HTTPS://JUDGE.test" })));
    });

    it("never includes secrets in the key input", () => {
        const key = judgeCacheKey(keyArgs());
        expect(key).not.toContain("secret");
        expect(key).toMatch(/^[0-9a-f]{64}$/);
    });

    it("treats entries older than max age as misses", () => {
        const dir = mkdtempSync(join(tmpdir(), "judge-cache-"));
        let now = 1_000_000;
        const cache = new JudgeCache(dir, 1000, { now: () => now, maxAgeMs: 1000 });
        const key = judgeCacheKey(keyArgs());
        cache.set(key, 0.5);
        expect(cache.get(key)).toBe(0.5);
        now += 1001;
        expect(cache.get(key)).toBeUndefined();
    });

    it("expired entries stay expired after reload", () => {
        const dir = mkdtempSync(join(tmpdir(), "judge-cache-"));
        let now = 1_000_000;
        new JudgeCache(dir, 1000, { now: () => now, maxAgeMs: 1000 })
            .set(judgeCacheKey(keyArgs()), 0.5);
        now += 10_000;
        const reloaded = new JudgeCache(dir, 1000, { now: () => now, maxAgeMs: 1000 });
        expect(reloaded.get(judgeCacheKey(keyArgs()))).toBeUndefined();
    });

    it("old-format entries without a timestamp are misses, never errors", () => {
        const dir = mkdtempSync(join(tmpdir(), "judge-cache-"));
        writeFileSync(
            join(dir, "verdicts.jsonl"),
            `${JSON.stringify({ key: judgeCacheKey(keyArgs()), p: 0.9 })}\n` +
            "not json at all\n",
        );
        const cache = new JudgeCache(dir);
        expect(cache.get(judgeCacheKey(keyArgs()))).toBeUndefined();
        expect(cache.size()).toBe(0);
    });

    it("resolves max age from env, defaulting to 7 days on missing/invalid", () => {
        const sevenDays = 7 * 24 * 60 * 60 * 1000;
        expect(resolveJudgeCacheMaxAgeMs({})).toBe(sevenDays);
        expect(resolveJudgeCacheMaxAgeMs({ PI_SMARTREAD_JUDGE_CACHE_MAX_AGE_DAYS: "1" }))
            .toBe(24 * 60 * 60 * 1000);
        for (const bad of ["0", "-3", "nope", "", "NaN", "Infinity"]) {
            expect(resolveJudgeCacheMaxAgeMs({ PI_SMARTREAD_JUDGE_CACHE_MAX_AGE_DAYS: bad }))
                .toBe(sevenDays);
        }
    });
});
