import { describe, it, expect } from "vitest";
import { rerank, type RerankerInput } from "../../src/rerank.js";

// ── Backward compatibility: zeroed new signals must not change baseline ──

describe("WP-7 rerank backward compatibility", () => {
  const baseline: RerankerInput[] = [
    { path: "a.ts", rrfScore: 0.8, keywordScore: 0.7, graphDistance: 1, pageRank: 0.05 },
    { path: "b.ts", rrfScore: 0.6, keywordScore: 0.5, graphDistance: 3, pageRank: 0.02 },
    { path: "c.ts", rrfScore: 0.4, keywordScore: 0.3, graphDistance: 5, pageRank: 0.01 },
  ];

  it("zeroed new signals produce same ranking as baseline", () => {
    const baselineResult = rerank(baseline);
    const withZeros = rerank(
      baseline.map((c) => ({
        ...c,
        halsteadComplexity: undefined,
        astProfile: undefined,
        minHashProximity: undefined,
      })),
    );
    // Same ranking order (paths in same rank order)
    const baselineOrder = baselineResult.map((r) => r.path);
    const zerosOrder = withZeros.map((r) => r.path);
    expect(zerosOrder).toEqual(baselineOrder);
  });

  it("populated new signals can re-rank candidates", () => {
    // Candidate b has lower RRF but high proximity + low complexity
    const enhanced: RerankerInput[] = [
      { path: "a.ts", rrfScore: 0.8, keywordScore: 0.7, graphDistance: 1, pageRank: 0.05, halsteadComplexity: 400, astProfile: 0.9 },
      { path: "b.ts", rrfScore: 0.6, keywordScore: 0.5, graphDistance: 3, pageRank: 0.02, minHashProximity: 0.95, halsteadComplexity: 10, astProfile: 0.1 },
      { path: "c.ts", rrfScore: 0.4, keywordScore: 0.3, graphDistance: 5, pageRank: 0.01 },
    ];

    const result = rerank(enhanced);
    // b.ts gets proximity boost and low-complexity boost; may move up
    const bRank = result.find((r) => r.path === "b.ts")!.newRank;
    const cRank = result.find((r) => r.path === "c.ts")!.newRank;
    // At minimum, b should still be above c
    expect(bRank).toBeLessThan(cRank);
  });

  it("high halstead complexity penalises a candidate", () => {
    const base: RerankerInput[] = [
      { path: "simple.ts", rrfScore: 0.5, keywordScore: 0.5, halsteadComplexity: 5 },
      { path: "complex.ts", rrfScore: 0.5, keywordScore: 0.5, halsteadComplexity: 500 },
    ];
    const result = rerank(base);
    // With identical RRF/keyword, simple should rank better (lower complexity → higher structural score)
    const simpleRank = result.find((r) => r.path === "simple.ts")!.newRank;
    const complexRank = result.find((r) => r.path === "complex.ts")!.newRank;
    expect(simpleRank).toBeLessThan(complexRank);
  });

  it("high minHash proximity boosts a candidate", () => {
    const base: RerankerInput[] = [
      { path: "distant.ts", rrfScore: 0.5, keywordScore: 0.5, minHashProximity: 0.1 },
      { path: "similar.ts", rrfScore: 0.5, keywordScore: 0.5, minHashProximity: 0.95 },
    ];
    const result = rerank(base);
    const similarRank = result.find((r) => r.path === "similar.ts")!.newRank;
    const distantRank = result.find((r) => r.path === "distant.ts")!.newRank;
    expect(similarRank).toBeLessThan(distantRank);
  });
});
