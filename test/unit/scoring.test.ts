import { describe, expect, it } from "vitest";
import {
  bm25Scores,
  cosineSimilarity,
  computeRanks,
  computeRrfScores,
  tokenize,
} from "../../scoring.js";

describe("tokenize", () => {
  it("lowercases and splits on non-alphanumeric non-underscore", () => {
    expect(tokenize("Hello, World!")).toEqual(["hello", "world"]);
    expect(tokenize("foo_bar baz")).toEqual(["foo_bar", "baz"]);
    expect(tokenize("  spaces  ")).toEqual(["spaces"]);
  });

  it("discards empty tokens", () => {
    expect(tokenize(",,,,")).toEqual([]);
    expect(tokenize("")).toEqual([]);
  });

  it("keeps underscores inside tokens", () => {
    expect(tokenize("snake_case")).toEqual(["snake_case"]);
  });
});

describe("bm25Scores", () => {
  it("gives higher score to document containing query terms", () => {
    const docs = ["authentication middleware logic", "database schema migration"];
    const scores = bm25Scores("authentication", docs);
    expect(scores[0]).toBeGreaterThan(scores[1]);
  });

  it("returns zero score when query terms not in any document", () => {
    const docs = ["foo bar", "baz qux"];
    const scores = bm25Scores("zzz", docs);
    expect(scores[0]).toBe(0);
    expect(scores[1]).toBe(0);
  });

  it("does not multiply repeated query terms", () => {
    const docs = ["auth auth auth"];
    const scoresOnce = bm25Scores("auth", docs);
    const scoresRepeat = bm25Scores("auth auth auth", docs);
    expect(scoresOnce[0]).toBe(scoresRepeat[0]);
  });

  it("returns a score per document in input order", () => {
    const docs = ["a b c", "d e f", "a b c"];
    const scores = bm25Scores("a", docs);
    expect(scores).toHaveLength(3);
    expect(scores[0]).toBe(scores[2]);
    expect(scores[1]).toBe(0);
  });
});

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it("returns -Infinity when either vector has zero norm", () => {
    expect(cosineSimilarity([0, 0], [1, 2])).toBe(-Infinity);
    expect(cosineSimilarity([1, 2], [0, 0])).toBe(-Infinity);
  });
});

describe("computeRanks", () => {
  it("assigns rank 1 to highest score", () => {
    const ranks = computeRanks([0.9, 0.5, 0.7], ["a", "b", "c"]);
    expect(ranks[0]).toBe(1);
    expect(ranks[2]).toBe(2);
    expect(ranks[1]).toBe(3);
  });

  it("breaks ties by original index then path", () => {
    const ranks = computeRanks([0.5, 0.5], ["b", "a"]);
    expect(ranks[0]).toBe(1);
    expect(ranks[1]).toBe(2);
  });

  it("handles single element", () => {
    expect(computeRanks([0.9], ["a"])).toEqual([1]);
  });
});

describe("computeRrfScores", () => {
  it("applies RRF formula with k=60", () => {
    const scores = computeRrfScores([1, 2], [2, 1]);
    // File 0: 1/(60+1) + 1/(60+2) = 1/61 + 1/62
    // File 1: 1/(60+2) + 1/(60+1) = 1/62 + 1/61
    expect(scores[0]).toBeCloseTo(scores[1]);
  });

  it("produces higher scores for lower combined ranks", () => {
    const scores = computeRrfScores([1, 3], [1, 3]);
    expect(scores[0]).toBeGreaterThan(scores[1]);
  });
});
