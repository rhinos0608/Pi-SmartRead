import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { LruCache } from "../../src/utils.js";
import type { EmbedResult } from "../../src/embedding.js";
import type { PersistentEmbeddingCache } from "../../src/persistent-embedding-cache.js";
import {
  ADR_BOOST,
  MIN_RELEVANCE_SCORE,
  createEmbeddingCacheKey,
  isRelevantCandidate,
  normalizeCandidatePath,
  rankCandidates,
  type RankingFileDetail,
} from "../../src/intent-ranking.js";

function makeParams(overrides: Record<string, unknown> = {}) {
  const fileDetails = new Map<string, Partial<RankingFileDetail>>();
  for (const p of ["/a.ts", "/b.ts"]) {
    fileDetails.set(p, { path: p, ok: true, rankedBy: "bm25" });
  }
  return {
    query: "authentication",
    files: [
      { path: "/a.ts", body: "authentication login session handler" },
      { path: "/b.ts", body: "zebra xylophone quantum" },
    ],
    embeddingConfig: null,
    cwd: "/repo",
    embeddingLruCache: new LruCache<EmbedResult>(64),
    persistentCaches: new LruCache<PersistentEmbeddingCache>(4),
    fetchEmbeddingsImpl: async (): Promise<EmbedResult> => ({ vectors: [] }),
    probeAddedSet: new Set<string>(),
    graphDistanceMap: new Map<string, number>(),
    fileDetails,
    ...overrides,
  } as Parameters<typeof rankCandidates>[0];
}

describe("intent-ranking: thresholds", () => {
  it("pins ranking constants", () => {
    expect(MIN_RELEVANCE_SCORE).toBe(0.05);
    expect(ADR_BOOST).toBe(0.3);
  });

  it("keeps exact keyword matches even when semantic similarity is below threshold", () => {
    expect(isRelevantCandidate(1.2, 0.0, "ok")).toBe(true);
  });

  it("keeps semantic matches at or above the minimum relevance score", () => {
    expect(isRelevantCandidate(0, MIN_RELEVANCE_SCORE, "ok")).toBe(true);
    expect(isRelevantCandidate(0, MIN_RELEVANCE_SCORE - 0.001, "ok")).toBe(false);
  });

  it("drops query-unrelated files when embeddings are unavailable", () => {
    expect(isRelevantCandidate(0, undefined, "failed_fallback_bm25")).toBe(false);
  });
});

describe("intent-ranking: embedding cache key", () => {
  const base = {
    baseUrl: "http://localhost:11434/v1",
    model: "nomic-embed-text",
    inputs: [] as string[],
  };

  it("is deterministic for identical inputs", () => {
    const a = createEmbeddingCacheKey({ ...base }, "q", ["doc"]);
    expect(createEmbeddingCacheKey({ ...base }, "q", ["doc"])).toBe(a);
  });

  it("varies by model, query, and inputs", () => {
    const a = createEmbeddingCacheKey({ ...base }, "q", ["doc"]);
    expect(createEmbeddingCacheKey({ ...base, model: "other" }, "q", ["doc"])).not.toBe(a);
    expect(createEmbeddingCacheKey({ ...base }, "other query", ["doc"])).not.toBe(a);
    expect(createEmbeddingCacheKey({ ...base }, "q", ["other doc"])).not.toBe(a);
  });
});

describe("intent-ranking: normalizeCandidatePath", () => {
  it("resolves relative paths against cwd and leaves absolute paths alone", () => {
    expect(normalizeCandidatePath("/repo", "src/a.ts")).toBe(resolve("/repo", "src/a.ts"));
    expect(normalizeCandidatePath("/repo", "/elsewhere/b.ts")).toBe("/elsewhere/b.ts");
  });
});

describe("intent-ranking: rankCandidates", () => {
  it("returns empty ranking for zero files without touching embeddings", async () => {
    let calls = 0;
    const params = makeParams({
      files: [],
      fetchEmbeddingsImpl: async () => {
        calls++;
        return { vectors: [] };
      },
    });
    params.fileDetails.clear();
    const result = await rankCandidates(params);
    expect(result.rankedSuccessOrder).toEqual([]);
    expect(result.embeddingStatus).toBe("ok");
    expect(result.totalChunks).toBe(0);
    expect(calls).toBe(0);
  });

  it("falls back to BM25 when embedding config is missing and filters unrelated files", async () => {
    const result = await rankCandidates(makeParams());
    expect(result.embeddingStatus).toBe("failed_fallback_bm25");
    expect(result.rankedSuccessOrder).toEqual(["/a.ts"]);
    expect(result.filteredBelowThresholdPaths).toEqual(["/b.ts"]);
  });

  it("marks probe files with graph distance 0 and max confidence", async () => {
    const params = makeParams({ probeAddedSet: new Set(["/a.ts"]) });
    const result = await rankCandidates(params);
    expect(result.rankedSuccessOrder).toContain("/a.ts");
    expect(params.fileDetails.get("/a.ts")?.graphDistance).toBe(0);
    expect(params.fileDetails.get("/a.ts")?.probeConfidenceScore).toBe(1.0);
  });
});
