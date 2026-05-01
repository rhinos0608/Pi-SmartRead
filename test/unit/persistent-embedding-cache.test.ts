import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PersistentEmbeddingCache } from "../../persistent-embedding-cache.js";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

describe("PersistentEmbeddingCache", () => {
  let tmpDir: string;

  const makeReq = () => ({
    baseUrl: "https://api.example.com",
    model: "text-embedding-3-small",
    apiKey: "test-key",
    inputs: ["hello", "world"],
  });

  const makeResult = (): { vectors: number[][] } => ({
    vectors: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
  });

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "embedding-cache-test-"));
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it("creates cache directory on construction", () => {
    const cache = new PersistentEmbeddingCache(tmpDir);
    expect(cache.hasPersistence).toBe(true);
    expect(existsSync(join(tmpDir, ".pi-smartread.embeddings.cache"))).toBe(true);
  });

  it("computes deterministic keys from embedding config + query + inputs", () => {
    const key1 = PersistentEmbeddingCache.computeKey(makeReq(), "test", ["a", "b"]);
    const key2 = PersistentEmbeddingCache.computeKey(makeReq(), "test", ["a", "b"]);
    expect(key1).toBe(key2);

    const key3 = PersistentEmbeddingCache.computeKey(makeReq(), "different", ["a", "b"]);
    expect(key3).not.toBe(key1);
  });

  it("stores and retrieves embedding results", () => {
    const cache = new PersistentEmbeddingCache(tmpDir);
    const key = PersistentEmbeddingCache.computeKey(makeReq(), "query", ["content"]);
    const result = makeResult();

    cache.set(key, result);
    const retrieved = cache.get(key);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.vectors).toEqual(result.vectors);
    expect(cache.size).toBe(1);
  });

  it("returns null for unknown keys", () => {
    const cache = new PersistentEmbeddingCache(tmpDir);
    expect(cache.get("nonexistent")).toBeNull();
  });

  it("persists entries to disk (survives new instance)", () => {
    const cache1 = new PersistentEmbeddingCache(tmpDir);
    const key = PersistentEmbeddingCache.computeKey(makeReq(), "persist-test", ["data"]);
    const result = makeResult();

    cache1.set(key, result);

    // Create new instance — should find the cached entry on disk
    const cache2 = new PersistentEmbeddingCache(tmpDir);
    const retrieved = cache2.get(key);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.vectors).toEqual(result.vectors);
  });

  it("tracks disk entry count", () => {
    const cache = new PersistentEmbeddingCache(tmpDir);
    expect(cache.diskEntries).toBe(0);

    const result = makeResult();
    cache.set(PersistentEmbeddingCache.computeKey(makeReq(), "q1", ["a"]), result);
    cache.set(PersistentEmbeddingCache.computeKey(makeReq(), "q2", ["b"]), result);
    expect(cache.diskEntries).toBe(2);
  });

  it("evicts LRU entries from both memory and disk", () => {
    const cache = new PersistentEmbeddingCache(tmpDir, 2); // max 2 entries
    const result = makeResult();

    cache.set(PersistentEmbeddingCache.computeKey(makeReq(), "q1", ["a"]), result);
    cache.set(PersistentEmbeddingCache.computeKey(makeReq(), "q2", ["b"]), result);
    cache.set(PersistentEmbeddingCache.computeKey(makeReq(), "q3", ["c"]), result);

    // Both memory and disk evict oldest
    expect(cache.size).toBe(2);
    expect(cache.diskEntries).toBe(2);
  });

  it("clears both memory and disk cache", () => {
    const cache = new PersistentEmbeddingCache(tmpDir);
    const result = makeResult();
    cache.set(PersistentEmbeddingCache.computeKey(makeReq(), "q1", ["a"]), result);
    expect(cache.size).toBe(1);

    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.diskEntries).toBe(0);
  });

  it("handles many sequential reads/writes without corruption", () => {
    const cache = new PersistentEmbeddingCache(tmpDir, 100);

    // Write many entries sequentially
    for (let i = 0; i < 50; i++) {
      cache.set(
        PersistentEmbeddingCache.computeKey(makeReq(), `q${i}`, [`data${i}`]),
        { vectors: [[i, 0, 0], [0, i, 0], [0, 0, i]] },
      );
    }

    // Read them back
    for (let i = 0; i < 50; i++) {
      const retrieved = cache.get(
        PersistentEmbeddingCache.computeKey(makeReq(), `q${i}`, [`data${i}`]),
      );
      expect(retrieved).not.toBeNull();
      expect(retrieved!.vectors[0]![0]).toBe(i);
    }
  });
});
