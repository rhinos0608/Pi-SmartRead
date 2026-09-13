import { describe, expect, it } from "vitest";
import { rankExplicitSeed } from "../../../src/rank-channels/explicit-seed.js";

const FILES = [
  "src/auth/login.ts",
  "src/auth/logout.ts",
  "src/utils/helpers.ts",
  "src/pages/Dashboard.tsx",
  "lib/auth.js",
];

describe("rankExplicitSeed", () => {
  it("returns unavailable when no seeds provided", () => {
    const result = rankExplicitSeed([], FILES);
    expect(result.channel).toBe("explicit-seed");
    expect(result.unavailable).toEqual({ reason: "no seeds provided" });
    expect(result.candidates).toEqual([]);
  });

  it("scores exact path match as 1.0", () => {
    const result = rankExplicitSeed(["src/auth/login.ts"], FILES);
    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0]!.file).toBe("src/auth/login.ts");
    expect(result.candidates[0]!.rawScore).toBe(1.0);
  });

  it("scores basename match as 0.5", () => {
    const result = rankExplicitSeed(["login.ts"], FILES);
    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0]!.file).toBe("src/auth/login.ts");
    expect(result.candidates[0]!.rawScore).toBe(0.5);
  });

  it("scores partial path match as 0.3", () => {
    const result = rankExplicitSeed(["src/auth"], FILES);
    const matches = result.candidates.map((c) => c.file);
    expect(matches).toContain("src/auth/login.ts");
    expect(matches).toContain("src/auth/logout.ts");
    expect(result.candidates.find((c) => c.file === "src/auth/login.ts")!.rawScore).toBe(0.3);
  });

  it("prefers higher score when multiple match levels apply", () => {
    // "src/auth/login.ts" is exact (1.0), others are partial (0.3)
    const result = rankExplicitSeed(["src/auth/login.ts"], FILES);
    const scores = result.candidates.map((c) => ({ file: c.file, score: c.rawScore }));
    // Only exact match should appear since partial ones use different seeds
    expect(scores).toEqual([{ file: "src/auth/login.ts", score: 1.0 }]);
  });

  it("handles multiple seeds", () => {
    const result = rankExplicitSeed(["src/auth/login.ts", "helpers.ts"], FILES);
    const files = result.candidates.map((c) => c.file);
    expect(files).toContain("src/auth/login.ts");
    expect(files).toContain("src/utils/helpers.ts");
  });

  it("is deterministic — same input produces same output", () => {
    const a = rankExplicitSeed(["auth"], FILES);
    const b = rankExplicitSeed(["auth"], FILES);
    expect(a).toEqual(b);
  });

  it("caps at MAX_CANDIDATES (500)", () => {
    const big = Array.from({ length: 600 }, (_, i) => `file${i}.ts`);
    const result = rankExplicitSeed(["file"], big);
    expect(result.candidates.length).toBe(500);
  });

  it("sorts by score descending, then alphabetically", () => {
    const result = rankExplicitSeed(["login.ts", "src/auth"], FILES);
    // basename match (0.5) should come before partial (0.3)
    expect(result.candidates[0]!.rawScore).toBeGreaterThanOrEqual(result.candidates[1]!.rawScore);
    if (result.candidates[0]!.rawScore === result.candidates[1]!.rawScore) {
      expect(result.candidates[0]!.file.localeCompare(result.candidates[1]!.file)).toBeLessThanOrEqual(0);
    }
  });

  it("includes metadata with totalMatches", () => {
    const result = rankExplicitSeed(["auth"], FILES);
    expect(result.metadata?.totalMatches).toBe(result.candidates.length);
  });

  it("handles backslash paths (Windows)", () => {
    const windows = ["src\\auth\\login.ts"];
    const result = rankExplicitSeed(["src/auth/login.ts"], windows);
    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0]!.rawScore).toBe(1.0);
  });
});
