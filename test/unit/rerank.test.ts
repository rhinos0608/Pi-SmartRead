import { describe, expect, it, vi } from "vitest";
import { rerank, externalRerank, rerankWithExternal, type RerankerInput } from "../../rerank.js";

describe("rerank", () => {
  it("returns empty array for empty input", () => {
    const results = rerank([]);
    expect(results).toEqual([]);
  });

  it("preserves order when no structural signals are present", () => {
    const inputs: RerankerInput[] = [
      { path: "/a.ts", rrfScore: 10, keywordScore: 5 },
      { path: "/b.ts", rrfScore: 5, keywordScore: 3 },
      { path: "/c.ts", rrfScore: 1, keywordScore: 0 },
    ];
    const results = rerank(inputs);
    expect(results[0]!.path).toBe("/a.ts");
    expect(results[1]!.path).toBe("/b.ts");
    expect(results[2]!.path).toBe("/c.ts");
    // No structural signals, so order should be preserved
    expect(results.every((r) => !r.changed)).toBe(true);
  });

  it("promotes files with graph proximity when structural signal breaks RRF tie", () => {
    // Equal RRF scores — graph distance should break the tie
    const inputs: RerankerInput[] = [
      { path: "/a.ts", rrfScore: 10, keywordScore: 5, graphDistance: 10 },
      { path: "/b.ts", rrfScore: 10, keywordScore: 5, graphDistance: 0 },  // closer
      { path: "/c.ts", rrfScore: 10, keywordScore: 5, graphDistance: 10 },
    ];
    const results = rerank(inputs);
    // Results are in original input order; newRank reflects reranked position
    // b should have newRank=0 (first), a should have newRank=1, c newRank=2
    const aResult = results.find((r) => r.path === "/a.ts")!;
    const bResult = results.find((r) => r.path === "/b.ts")!;
    const cResult = results.find((r) => r.path === "/c.ts")!;
    expect(bResult.newRank).toBe(0);   // b promoted to first
    expect(aResult.newRank).toBe(1);   // a demoted to second
    expect(cResult.newRank).toBe(2);   // c stays last
    expect(bResult.changed).toBe(true);
  });

  it("respects maxCandidates limit", () => {
    const inputs: RerankerInput[] = Array.from({ length: 10 }, (_, i) => ({
      path: `/file${i}.ts`,
      rrfScore: 10 - i,
      keywordScore: 5,
    }));
    const results = rerank(inputs, { maxCandidates: 3 });
    // First 3 should be reranked, rest preserved
    expect(results).toHaveLength(10);
    // Files beyond maxCandidates have newRank === originalRank (preserved)
    expect(results[9]!.newRank).toBe(results[9]!.originalRank);
  });

  it("does not demote exact keyword matches below irrelevant graph neighbours", () => {
    // A file with high keyword score should not be demoted far
    const inputs: RerankerInput[] = [
      { path: "/exact-match.ts", rrfScore: 100, keywordScore: 50 },
      { path: "/graph-far.ts", rrfScore: 1, keywordScore: 0, graphDistance: 0, pageRank: 0.5 },
    ];
    const results = rerank(inputs);
    // Exact match file should still be ranked first (RRF dominates at 0.6 weight)
    expect(results[0]!.path).toBe("/exact-match.ts");
  });

  it("single-element arrays are unchanged", () => {
    const inputs: RerankerInput[] = [
      { path: "/only.ts", rrfScore: 42, keywordScore: 10, graphDistance: 5, pageRank: 0.1 },
    ];
    const results = rerank(inputs);
    expect(results).toHaveLength(1);
    expect(results[0]!.changed).toBe(false);
  });

  it("handles probe confidence signals", () => {
    const inputs: RerankerInput[] = [
      { path: "/a.ts", rrfScore: 10, keywordScore: 5, probeConfidence: 0 },
      { path: "/b.ts", rrfScore: 9, keywordScore: 4, probeConfidence: 0.9 },  // probe-found
    ];
    const results = rerank(inputs);
    const bResult = results.find((r) => r.path === "/b.ts")!;
    // Probe confidence should boost /b.ts
    expect(bResult.newRank).toBeLessThanOrEqual(bResult.originalRank);
  });

  it("includes signal weights in results", () => {
    const inputs: RerankerInput[] = [
      { path: "/a.ts", rrfScore: 10, keywordScore: 5 },
    ];
    const results = rerank(inputs, { rrfWeight: 0.5, structuralWeight: 0.4, proximityWeight: 0.1 });
    expect(results[0]!.signals.rrfWeight).toBe(0.5);
    expect(results[0]!.signals.structuralWeight).toBe(0.4);
    expect(results[0]!.signals.proximityWeight).toBe(0.1);
  });
});

describe("externalRerank", () => {
  it("returns success with Cohere-style response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        results: [
          { index: 2, relevance_score: 0.95 },
          { index: 0, relevance_score: 0.80 },
          { index: 1, relevance_score: 0.30 },
        ],
      }),
    });

    // Temporarily override global fetch
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as any;
    try {
      const result = await externalRerank({
        query: "test query",
        documents: ["doc1", "doc2", "doc3"],
        baseUrl: "https://api.example.com/v1",
        apiKey: "test-key",
      });

      expect(result.success).toBe(true);
      expect(result.rankedIndices).toEqual([2, 0, 1]);
      expect(result.scores).toEqual([0.95, 0.80, 0.30]);
      expect(mockFetch).toHaveBeenCalledOnce();

      // Verify the request was made correctly
      const [url, options] = mockFetch.mock.calls[0]!;
      expect(url).toBe("https://api.example.com/v1/rerank");
      expect(options.method).toBe("POST");
      expect(options.headers.Authorization).toBe("Bearer test-key");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns success with scores-based response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ scores: [0.3, 0.9, 0.6] }),
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as any;
    try {
      const result = await externalRerank({
        query: "test",
        documents: ["a", "b", "c"],
        baseUrl: "https://api.example.com",
      });

      expect(result.success).toBe(true);
      expect(result.rankedIndices).toEqual([1, 2, 0]); // sorted by desc score
      expect(result.scores).toEqual([0.9, 0.6, 0.3]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns success with ranked_indices response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ranked_indices: [2, 0, 1] }),
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as any;
    try {
      const result = await externalRerank({
        query: "test",
        documents: ["a", "b", "c"],
        baseUrl: "https://api.example.com",
      });

      expect(result.success).toBe(true);
      expect(result.rankedIndices).toEqual([2, 0, 1]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns failure on HTTP error", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as any;
    try {
      const result = await externalRerank({
        query: "test",
        documents: ["a"],
        baseUrl: "https://api.example.com",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("429");
      expect(result.rankedIndices).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns failure on network error", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as any;
    try {
      const result = await externalRerank({
        query: "test",
        documents: ["a"],
        baseUrl: "https://api.example.com",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("ECONNREFUSED");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns failure on unrecognized response format", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ unexpected: "format" }),
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as any;
    try {
      const result = await externalRerank({
        query: "test",
        documents: ["a"],
        baseUrl: "https://api.example.com",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Unrecognized");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("rerankWithExternal", () => {
  it("uses external reranker when available", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        results: [
          { index: 1, relevance_score: 0.95 },
          { index: 0, relevance_score: 0.80 },
        ],
      }),
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as any;
    try {
      const candidates: RerankerInput[] = [
        { path: "/a.ts", rrfScore: 10, keywordScore: 5 },
        { path: "/b.ts", rrfScore: 8, keywordScore: 4 },
      ];

      const result = await rerankWithExternal(
        candidates,
        "test query",
        ["content of a", "content of b"],
        { baseUrl: "https://api.example.com" },
      );

      expect(result.externalUsed).toBe(true);
      expect(result.results).toHaveLength(2);
      // External ranked index 1 (b) first, index 0 (a) second
      const bResult = result.results.find((r) => r.path === "/b.ts")!;
      const aResult = result.results.find((r) => r.path === "/a.ts")!;
      expect(bResult.newRank).toBe(0);
      expect(aResult.newRank).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("falls back to structural reranker on external failure", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("timeout"));

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as any;
    try {
      const candidates: RerankerInput[] = [
        { path: "/a.ts", rrfScore: 10, keywordScore: 5 },
        { path: "/b.ts", rrfScore: 8, keywordScore: 4, graphDistance: 0 },
      ];

      const result = await rerankWithExternal(
        candidates,
        "test",
        ["a", "b"],
        { baseUrl: "https://api.example.com" },
      );

      expect(result.externalUsed).toBe(false);
      expect(result.externalError).toContain("timeout");
      expect(result.results).toHaveLength(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
