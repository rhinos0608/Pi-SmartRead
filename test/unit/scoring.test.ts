import { describe, expect, it } from "vitest";
import {
  bm25Scores,
  cosineSimilarity,
  computeRanks,
  computeRrfScores,
  tokenize,
} from "../../scoring.js";

describe("tokenize", () => {
  describe("full-token behavior (preserve existing tests)", () => {
    it("lowercases and splits on non-alphanumeric non-underscore", () => {
      expect(tokenize("Hello, World!")).toContain("hello");
      expect(tokenize("Hello, World!")).toContain("world");
      // foo_bar now also produces sub-tokens "foo" and "bar"
      const result = tokenize("foo_bar baz");
      expect(result).toContain("foo_bar");
      expect(result).toContain("foo");
      expect(result).toContain("bar");
      expect(result).toContain("baz");
      expect(tokenize("  spaces  ")).toEqual(["spaces"]);
    });

    it("discards empty tokens", () => {
      expect(tokenize(",,,,")).toEqual([]);
      expect(tokenize("")).toEqual([]);
    });

    it("keeps underscores inside tokens", () => {
      expect(tokenize("snake_case")).toEqual(["snake_case", "snake", "case"]);
    });
  });

  describe("sub-token generation via camelCase/PascalCase/snake_case splitting", () => {
    it("splits camelCase into sub-tokens", () => {
      // processUserData -> ["processuserdata", "process", "user", "data"]
      const result = tokenize("processUserData");
      expect(result).toContain("processuserdata");
      expect(result).toContain("process");
      expect(result).toContain("user");
      expect(result).toContain("data");
    });

    it("splits PascalCase into sub-tokens", () => {
      // MyClassName -> ["myclassname", "my", "class", "name"]
      const result = tokenize("MyClassName");
      expect(result).toContain("myclassname");
      expect(result).toContain("my");
      expect(result).toContain("class");
      expect(result).toContain("name");
    });

    it("splits snake_case via underscore then camelCase", () => {
      // process_user_data -> ["process_user_data", "process", "user", "data"]
      const result = tokenize("process_user_data");
      expect(result).toContain("process_user_data");
      expect(result).toContain("process");
      expect(result).toContain("user");
      expect(result).toContain("data");
    });

    it("handles mixed camelCase + snake_case", () => {
      // getUserById -> ["getuserbyid", "get", "user", "by", "id"]
      const result = tokenize("getUserById");
      expect(result).toContain("getuserbyid");
      expect(result).toContain("get");
      expect(result).toContain("user");
      expect(result).toContain("by");
      expect(result).toContain("id");
    });

    it("handles acronyms (uppercase->lowercase transitions)", () => {
      // OAuthAPI -> ["oauthapi", "o", "auth", "a", "p", "i"]
      const result = tokenize("OAuthAPI");
      expect(result).toContain("oauthapi");
      expect(result).toContain("o");
      expect(result).toContain("auth");
      expect(result).toContain("a");
      expect(result).toContain("p");
      expect(result).toContain("i");
    });

    it("handles numeric suffixes", () => {
      // userV2 -> ["userv2", "user", "v2"]
      // file2txt -> ["file2txt", "file", "2", "txt"]
      const result = tokenize("userV2");
      expect(result).toContain("userv2");
      expect(result).toContain("user");
      // V2 splits at letter->digit boundary
      expect(result).toContain("v");
      expect(result).toContain("2");

      const result2 = tokenize("file2txt");
      expect(result2).toContain("file2txt");
      expect(result2).toContain("file");
      expect(result2).toContain("txt");
    });

    it("deduplicates sub-tokens within a single expansion", () => {
      // authAuth -> ["authaus", "auth"] (no duplicate "auth")
      const result = tokenize("authAuth");
      const authCount = result.filter((t) => t === "auth").length;
      expect(authCount).toBe(1);
    });

    it("full token always included first in its expansion", () => {
      const result = tokenize("processUserData");
      const idx = result.indexOf("processuserdata");
      expect(idx).toBeGreaterThanOrEqual(0);
      // The expansion for "processUserData" starts at idx and includes sub-tokens
      const after = result.slice(idx);
      expect(after).toContain("process");
      expect(after).toContain("user");
      expect(after).toContain("data");
    });
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
