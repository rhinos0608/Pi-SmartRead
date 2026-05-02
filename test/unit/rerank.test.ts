import { describe, expect, it } from "vitest";
import { rerank, type RerankerInput } from "../../rerank.js";

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
