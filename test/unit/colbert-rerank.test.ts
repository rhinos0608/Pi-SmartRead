import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  segmentText,
  cosineSimilarity,
  meanPool,
  computeMaxSim,
  colbertRerank,
  type ColbertRerankerInput,
} from "../../rerank.js";

// Mock the embedding and provider modules so colbertRerank's dynamic imports
// don't hit real @huggingface/transformers.
vi.mock("../../embedding.js", () => ({
  fetchLocalEmbeddings: vi.fn(),
}));
vi.mock("../../local-embedding-provider.js", () => ({
  isLocalEmbeddingAvailable: vi.fn(),
}));

import { fetchLocalEmbeddings } from "../../embedding.js";
import { isLocalEmbeddingAvailable } from "../../local-embedding-provider.js";

// ── segmentText ───────────────────────────────────────────────────

describe("segmentText", () => {
  it("splits text on sentence boundaries", () => {
    const text = "First sentence. Second sentence! Third question? Fourth.";
    const segments = segmentText(text, 512, 10);
    expect(segments.length).toBe(1);
    expect(segments[0]).toContain("First sentence");
    expect(segments[0]).toContain("Fourth");
  });

  it("splits into multiple segments when exceeding segmentSize", () => {
    const text = "A".repeat(300) + ". " + "B".repeat(300) + ". " + "C".repeat(300) + ".";
    const segments = segmentText(text, 400, 10);
    expect(segments.length).toBeGreaterThanOrEqual(2);
  });

  it("caps at maxSegments", () => {
    const sentences = Array.from({ length: 20 }, (_, i) => `Sentence ${i} enough.`);
    const text = sentences.join(" ");
    const segments = segmentText(text, 100, 3);
    expect(segments.length).toBeLessThanOrEqual(3);
  });

  it("returns empty array for empty input", () => {
    expect(segmentText("", 512, 8)).toEqual([]);
  });

  it("handles text with no sentence delimiters", () => {
    const segments = segmentText("single chunk of text", 512, 8);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toBe("single chunk of text");
  });
});

// ── cosineSimilarity ──────────────────────────────────────────────

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 5);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBe(0);
  });

  it("returns 0 for zero vector", () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
  });

  it("returns 0 for empty vectors", () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it("returns 0 for mismatched length", () => {
    expect(cosineSimilarity([1], [1, 2])).toBe(0);
  });

  it("returns positive for similar vectors", () => {
    expect(cosineSimilarity([0.5, 0.5, 0.5, 0.5], [0.4, 0.6, 0.4, 0.6])).toBeGreaterThan(0);
  });
});

// ── meanPool ──────────────────────────────────────────────────────

describe("meanPool", () => {
  it("returns empty for empty input", () => {
    expect(meanPool([])).toEqual([]);
  });

  it("returns same vector for single input", () => {
    expect(meanPool([[1, 2, 3]])).toEqual([1, 2, 3]);
  });

  it("averages multiple vectors", () => {
    expect(meanPool([[1, 1], [3, 3]])).toEqual([2, 2]);
  });
});

// ── computeMaxSim ─────────────────────────────────────────────────

describe("computeMaxSim", () => {
  it("returns 0 for empty query", () => {
    expect(computeMaxSim([], [[1, 2]])).toBe(0);
  });

  it("returns 0 for empty docs", () => {
    expect(computeMaxSim([[1, 2]], [])).toBe(0);
  });

  it("takes max dot across doc tokens per query token", () => {
    // qv=[1,0] → max with [0.9,0.1]=0.9 or [0.5,0.5]=0.5 → 0.9
    expect(computeMaxSim([[1, 0]], [[0.5, 0.5], [0.9, 0.1]])).toBeCloseTo(0.9, 5);
  });

  it("averages maxes across multiple query vectors", () => {
    // qv1→0.9, qv2→0.9 → avg 0.9
    expect(computeMaxSim([[1, 0], [0, 1]], [[0.1, 0.9], [0.9, 0.1]])).toBeCloseTo(0.9, 5);
  });
});

// ── colbertRerank (mocked embedding) ──────────────────────────────

describe("colbertRerank", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty for no candidates", async () => {
    const r = await colbertRerank("q", [], [0.1]);
    expect(r.results).toEqual([]);
    expect(r.usedColbert).toBe(false);
    expect(r.error).toBe("no candidates");
  });

  it("falls back structurally when local embedding unavailable", async () => {
    vi.mocked(isLocalEmbeddingAvailable).mockResolvedValue(false);
    const candidates: ColbertRerankerInput[] = [
      { path: "/a.ts", body: "a", rrfScore: 10, keywordScore: 5 },
      { path: "/b.ts", body: "b", rrfScore: 5, keywordScore: 3 },
    ];
    const r = await colbertRerank("test", candidates, [0.1, 0.2, 0.3]);
    expect(r.usedColbert).toBe(false);
    expect(r.error).toContain("unavailable");
    expect(r.results).toHaveLength(2);
    expect(r.results.every((x) => x.colbertScore === 0)).toBe(true);
  });

  it("reranks with ColBERT when embeddings available", async () => {
    vi.mocked(isLocalEmbeddingAvailable).mockResolvedValue(true);

    // Stage 1 body embed: inputs ["a content", "b content"]
    // a gets [0.9,0.1,0.0] → cosine with [1,0,0] = 0.9
    // b gets [0.5,0.5,0.0] → cosine with [1,0,0] = 0.5
    // top-K order (cos descending): [a (idx 0), b (idx 1)]
    vi.mocked(fetchLocalEmbeddings)
      .mockResolvedValueOnce({ vectors: [[0.9, 0.1, 0.0], [0.5, 0.5, 0.0]] })
      .mockResolvedValueOnce({ vectors: [[1.0, 0.0, 0.0]] })
      // Stage 2 batch: inputs ["a content", "b content"] (top-K order)
      // a gets 0.85 MaxSim, b gets 0.10 MaxSim
      .mockResolvedValueOnce({ vectors: [[0.85, 0.15, 0.0], [0.10, 0.90, 0.0]] });

    const candidates: ColbertRerankerInput[] = [
      { path: "/a.ts", body: "a content", rrfScore: 10, keywordScore: 5 },
      { path: "/b.ts", body: "b content", rrfScore: 8, keywordScore: 4 },
    ];

    const r = await colbertRerank("test", candidates, [1, 0, 0]);
    expect(r.usedColbert).toBe(true);
    expect(r.results).toHaveLength(2);

    // a ranks first: high MaxSim (0.85) + high RRF (10)
    expect(r.results[0]!.path).toBe("/a.ts");
    expect(r.results[0]!.newRank).toBe(0);
    expect(r.results[0]!.maxSimScore).toBeCloseTo(0.85, 2);
    expect(r.results[1]!.path).toBe("/b.ts");
    expect(r.results[1]!.newRank).toBe(1);
  });

  it("blends colbert and RRF with default 0.7 weight", async () => {
    vi.mocked(isLocalEmbeddingAvailable).mockResolvedValue(true);

    // Stage 1 bodies [a, b]:
    // a → [0.1,0.9,0.0] → cos(query=[1,0,0]) = 0.1 (LOW)
    // b → [0.9,0.1,0.0] → cos(query=[1,0,0]) = 0.9 (HIGH)
    // top-K order (cos descending): [b (idx 1), a (idx 0)]
    vi.mocked(fetchLocalEmbeddings)
      .mockResolvedValueOnce({ vectors: [[0.1, 0.9, 0.0], [0.9, 0.1, 0.0]] })
      .mockResolvedValueOnce({ vectors: [[1.0, 0.0, 0.0]] })
      // Stage 2 batch: inputs ["b", "a"] (top-K order)
      // b gets HIGH MaxSim (0.85), a gets LOW MaxSim (0.10)
      .mockResolvedValueOnce({ vectors: [[0.85, 0.15, 0.0], [0.10, 0.90, 0.0]] });

    const candidates: ColbertRerankerInput[] = [
      { path: "/a.ts", body: "a", rrfScore: 100, keywordScore: 50 },
      { path: "/b.ts", body: "b", rrfScore: 1, keywordScore: 0 },
    ];

    const r = await colbertRerank("test", candidates, [1, 0, 0]);

    // b has MaxSim=0.85, a has MaxSim=0.10
    // b: 0.7*0.85 + 0.3*0 = 0.595
    // a: 0.7*0.10 + 0.3*1 = 0.37
    // b wins (colbert weight dominates)
    expect(r.results.find((x) => x.path === "/b.ts")!.newRank).toBe(0);
    expect(r.results.find((x) => x.path === "/a.ts")!.newRank).toBe(1);
  });

  it("respects custom colbertWeight (RRF dominates at low weight)", async () => {
    vi.mocked(isLocalEmbeddingAvailable).mockResolvedValue(true);

    vi.mocked(fetchLocalEmbeddings)
      .mockResolvedValueOnce({ vectors: [[0.1, 0.9, 0.0], [0.9, 0.1, 0.0]] })
      .mockResolvedValueOnce({ vectors: [[1.0, 0.0, 0.0]] })
      .mockResolvedValueOnce({ vectors: [[0.85, 0.15, 0.0], [0.10, 0.90, 0.0]] });

    const candidates: ColbertRerankerInput[] = [
      { path: "/a.ts", body: "a", rrfScore: 100, keywordScore: 50 },
      { path: "/b.ts", body: "b", rrfScore: 1, keywordScore: 0 },
    ];

    // colbertWeight=0.3 → RRF dominates (weight=0.7)
    const r = await colbertRerank("test", candidates, [1, 0, 0], { colbertWeight: 0.3 });

    // a has RRF=100 → normalized to 1, weighted 0.7 → 0.7
    // a: 0.3*0.10 + 0.7*1 = 0.73
    // b: 0.3*0.85 + 0.7*0 = 0.255
    // a wins (RRF dominates)
    expect(r.results.find((x) => x.path === "/a.ts")!.newRank).toBe(0);
    expect(r.results.find((x) => x.path === "/b.ts")!.newRank).toBe(1);
  });

  it("returns correct result structure", async () => {
    vi.mocked(isLocalEmbeddingAvailable).mockResolvedValue(true);
    vi.mocked(fetchLocalEmbeddings)
      .mockResolvedValueOnce({ vectors: [[0.6, 0.4]] })
      .mockResolvedValueOnce({ vectors: [[0.5, 0.5]] })
      .mockResolvedValueOnce({ vectors: [[0.6, 0.4]] });

    const r = await colbertRerank(
      "test",
      [{ path: "/only.ts", body: "content", rrfScore: 42, keywordScore: 10 }],
      [0.5, 0.5],
    );

    expect(r.results).toHaveLength(1);
    const res = r.results[0]!;
    expect(res.path).toBe("/only.ts");
    expect(typeof res.rerankScore).toBe("number");
    expect(typeof res.colbertScore).toBe("number");
    expect(typeof res.maxSimScore).toBe("number");
    expect(typeof res.pooledCosScore).toBe("number");
    expect(res.originalRank).toBe(0);
    expect(res.newRank).toBe(0);
  });

  it("handles embedding error with fallback", async () => {
    vi.mocked(isLocalEmbeddingAvailable).mockResolvedValue(true);
    vi.mocked(fetchLocalEmbeddings).mockRejectedValue(new Error("model crash"));

    const r = await colbertRerank(
      "test",
      [{ path: "/a.ts", body: "a", rrfScore: 10, keywordScore: 5 }],
      [0.5, 0.5],
    );
    expect(r.usedColbert).toBe(false);
    expect(r.error).toContain("model crash");
    expect(r.results).toHaveLength(1);
  });

  it("respects maxCandidates option", async () => {
    vi.mocked(isLocalEmbeddingAvailable).mockResolvedValue(true);
    vi.mocked(fetchLocalEmbeddings)
      // Only 2 candidates go through stage 1 (maxCandidates=2)
      .mockResolvedValueOnce({ vectors: [[0.5, 0.5], [0.6, 0.4]] })
      .mockResolvedValueOnce({ vectors: [[1.0, 0.0]] })
      .mockResolvedValueOnce({ vectors: [[0.5, 0.5], [0.6, 0.4], [0.7, 0.3]] });

    const candidates: ColbertRerankerInput[] = Array.from({ length: 5 }, (_, i) => ({
      path: `/file${i}.ts`,
      body: `content ${i}`,
      rrfScore: 10 - i,
      keywordScore: 5,
    }));

    const r = await colbertRerank("test", candidates, [0.5, 0.5], { maxCandidates: 2 });
    expect(r.results).toHaveLength(5);
  });
});
