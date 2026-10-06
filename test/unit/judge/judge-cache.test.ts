import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JUDGE_CACHE_CANONICAL_REF, JudgeCache, judgeCacheKey, stableStringify } from "../../../src/judge/judge-cache.js";

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

    it("tolerates corrupt lines", () => {
        const dir = mkdtempSync(join(tmpdir(), "judge-cache-"));
        writeFileSync(join(dir, "verdicts.jsonl"), "not json\n{\"key\":\"k\",\"p\":0.5}\n[broken\n", "utf-8");
        const c = new JudgeCache(dir);
        expect(c.get("k")).toBe(0.5);
        expect(c.size()).toBe(1);
    });

    it("ignores cached values outside the probability range", () => {
        const dir = mkdtempSync(join(tmpdir(), "judge-cache-"));
        writeFileSync(
            join(dir, "verdicts.jsonl"),
            '{"key":"below","p":-0.1}\n{"key":"above","p":1.1}\n{"key":"valid","p":0.5}\n',
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
});
