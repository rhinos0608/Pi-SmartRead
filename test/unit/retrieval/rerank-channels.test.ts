/**
 * rerank-channels: pure kernel scoring stages extracted from rankCandidates.
 * Pins zero-behavior-change: BM25 ordering, RRF fusion preference,
 * BM25-only fallback, and the additive ADR-boost match semantics.
 */
import { describe, expect, it } from "vitest";
import { computeRanks, computeRrfScores } from "../../../src/scoring.js";
import { ADR_BOOST } from "../../../src/read/intent-ranking.js";
import {
  applyAdrBoost,
  computeKeywordStage,
  fuseRrfScores,
} from "../../../src/retrieval/rerank-channels.js";

describe("rerank-channels: computeKeywordStage", () => {
  it("orders exact keyword matches first on a tiny corpus", () => {
    const paths = ["/a.ts", "/b.ts", "/c.ts"];
    const bodies = [
      "authentication login session handler",
      "zebra xylophone quantum",
      "authentication helper",
    ];
    const { keywordScores, keywordRanks } = computeKeywordStage("authentication", bodies, paths);
    expect(keywordScores[0]).toBeGreaterThan(0);
    expect(keywordScores[1]).toBe(0);
    // Both matching files outrank the unrelated one (shorter doc scores higher via length norm).
    expect(keywordRanks[1]).toBe(3);
    expect(keywordRanks[0]).toBeLessThanOrEqual(2);
    expect(keywordRanks[2]).toBeLessThanOrEqual(2);
    expect(keywordScores[0]).toBeGreaterThan(keywordScores[1]!);
    expect(keywordScores[2]).toBeGreaterThan(keywordScores[1]!);
  });

  it("returns empty arrays for an empty corpus", () => {
    expect(computeKeywordStage("q", [], [])).toEqual({ keywordScores: [], keywordRanks: [] });
  });
});

describe("rerank-channels: fuseRrfScores", () => {
  it("prefers items ranked highly by both lists", () => {
    const paths = ["/a", "/b", "/c"];
    // a is ranked highly by both lists (1st + 2nd); b and c each trail in one list.
    const keywordRanks = [1, 2, 3];
    const semanticRanks = [2, 3, 1];
    const { rrfScores, rrfRanks, fusedBy } = fuseRrfScores(keywordRanks, semanticRanks, paths);
    expect(fusedBy).toBe("hybrid");
    expect(rrfScores).toEqual(computeRrfScores(semanticRanks, keywordRanks));
    expect(rrfRanks).toEqual(computeRanks(rrfScores, paths));
    expect(rrfRanks[0]).toBe(1);
  });

  it("falls back to 1/(60+rank) when semantic ranks are absent", () => {
    const paths = ["/a", "/b"];
    const absentCases: (number[] | null)[] = [null, []];
    for (const absent of absentCases) {
      const { rrfScores, rrfRanks, fusedBy } = fuseRrfScores([1, 2], absent, paths);
      expect(fusedBy).toBe("bm25");
      expect(rrfScores).toEqual([1 / 61, 1 / 62]);
      expect(rrfRanks).toEqual([1, 2]);
    }
  });
});

describe("rerank-channels: applyAdrBoost", () => {
  const paths = ["/repo/src/auth.ts", "/repo/src/other.ts"];
  const base = [0.5, 0.4];
  const ranks = [1, 2];

  it("adds ADR_BOOST additively on substring and basename matches and re-ranks", () => {
    const boosted = applyAdrBoost(base, ranks, paths, [{ tags: ["auth"] }], ADR_BOOST);
    expect(boosted.adrBoosts).toEqual([ADR_BOOST, 0]);
    expect(boosted.rrfScores[0]).toBeCloseTo(0.5 + ADR_BOOST, 12);
    expect(boosted.rrfScores[1]).toBe(0.4);
    expect(boosted.rrfRanks).toEqual(computeRanks(boosted.rrfScores, paths));
    // Inputs are not mutated.
    expect(base).toEqual([0.5, 0.4]);
  });

  it("matches a bare basename without extension", () => {
    const boosted = applyAdrBoost(base, ranks, ["/repo/other.ts"], [{ tags: ["other"] }], ADR_BOOST);
    expect(boosted.adrBoosts).toEqual([ADR_BOOST]);
  });

  it("leaves scores and ranks unchanged when no ADRs exist", () => {
    const boosted = applyAdrBoost(base, ranks, paths, [], ADR_BOOST);
    expect(boosted.adrBoosts).toEqual([0, 0]);
    expect(boosted.rrfScores).toEqual(base);
    expect(boosted.rrfRanks).toEqual(ranks);
  });

  it("awards the boost only once per file even with multiple matching ADRs", () => {
    const boosted = applyAdrBoost(
      base,
      ranks,
      paths,
      [{ tags: ["auth"] }, { tags: ["src/auth.ts"] }],
      ADR_BOOST,
    );
    expect(boosted.adrBoosts[0]).toBe(ADR_BOOST);
    expect(boosted.rrfScores[0]).toBeCloseTo(0.5 + ADR_BOOST, 12);
  });
});
