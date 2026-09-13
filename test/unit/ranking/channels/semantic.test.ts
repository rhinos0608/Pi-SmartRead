import { describe, expect, it } from "vitest";
import {
  rankSemantic,
  type SemanticEntry,
} from "../../../src/rank-channels/semantic.js";

// ── Helpers ──────────────────────────────────────────────────────────

function entry(overrides: Partial<SemanticEntry> & { file: string; snippet: string }): SemanticEntry {
  return {
    name: overrides.file.split("/").pop() ?? overrides.file,
    kind: "file",
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("rankSemantic", () => {
  it("returns unavailable for empty entries", () => {
    const result = rankSemantic("auth", []);
    expect(result.channel).toBe("semantic");
    expect(result.unavailable).toEqual({ reason: "no entries provided" });
    expect(result.candidates).toEqual([]);
  });

  it("returns unavailable for empty query", () => {
    const result = rankSemantic("  ", [
      entry({ file: "a.ts", snippet: "const x = 1;" }),
    ]);
    expect(result.unavailable).toEqual({ reason: "empty query" });
    expect(result.candidates).toEqual([]);
  });

  it("returns unavailable when all snippets are blank", () => {
    const result = rankSemantic("auth", [
      entry({ file: "a.ts", snippet: "" }),
      entry({ file: "b.ts", snippet: "   " }),
    ]);
    expect(result.unavailable).toEqual({ reason: "all snippets empty" });
    expect(result.candidates).toEqual([]);
  });

  it("scores a single matching entry above zero", () => {
    const result = rankSemantic("authenticate", [
      entry({ file: "auth.ts", snippet: "function authenticate(user: string) { return user; }" }),
    ]);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.rawScore).toBeGreaterThan(0);
    expect(result.candidates[0]!.file).toBe("auth.ts");
  });

  it("ranks more relevant snippets higher", () => {
    const entries: SemanticEntry[] = [
      entry({ file: "low.ts", snippet: "const unusedVariable = 42;" }),
      entry({ file: "high.ts", snippet: "async function authenticate(token: string): Promise<User> { return verify(token); }" }),
    ];
    const result = rankSemantic("authenticate", entries);
    expect(result.candidates[0]!.file).toBe("high.ts");
    expect(result.candidates[0]!.rawScore).toBeGreaterThan(result.candidates[1]!.rawScore);
  });

  it("is deterministic across runs", () => {
    const entries: SemanticEntry[] = [
      entry({ file: "a.ts", snippet: "parse JSON safely" }),
      entry({ file: "b.ts", snippet: "serialize object to JSON" }),
    ];
    const a = rankSemantic("json", entries);
    const b = rankSemantic("json", entries);
    expect(a).toEqual(b);
  });

  it("sorts ties by file name for determinism", () => {
    const entries: SemanticEntry[] = [
      entry({ file: "z.ts", snippet: "same content" }),
      entry({ file: "a.ts", snippet: "same content" }),
    ];
    const result = rankSemantic("content", entries);
    expect(result.candidates[0]!.file).toBe("a.ts");
    expect(result.candidates[1]!.file).toBe("z.ts");
  });

  it("caps at 500 candidates by default", () => {
    const entries: SemanticEntry[] = Array.from({ length: 600 }, (_, i) =>
      entry({ file: `f${i}.ts`, snippet: `file ${i} content here` }),
    );
    const result = rankSemantic("file", entries);
    expect(result.candidates).toHaveLength(500);
  });

  it("respects custom maxCandidates option", () => {
    const entries: SemanticEntry[] = Array.from({ length: 10 }, (_, i) =>
      entry({ file: `f${i}.ts`, snippet: `content ${i}` }),
    );
    const result = rankSemantic("content", entries, { maxCandidates: 3 });
    expect(result.candidates).toHaveLength(3);
  });

  it("preserves line and endLine when provided", () => {
    const result = rankSemantic("parse", [
      entry({ file: "p.ts", snippet: "function parse() {}", line: 10, endLine: 15 }),
    ]);
    expect(result.candidates[0]!.line).toBe(10);
    expect(result.candidates[0]!.endLine).toBe(15);
  });

  it("includes metadata about the corpus", () => {
    const entries: SemanticEntry[] = [
      entry({ file: "a.ts", snippet: "alpha bravo" }),
      entry({ file: "b.ts", snippet: "charlie delta" }),
    ];
    const result = rankSemantic("alpha", entries);
    expect(result.metadata?.corpusSize).toBe(2);
    expect(result.metadata?.totalEntries).toBe(2);
    expect(result.metadata?.avgDocLen).toBeGreaterThan(0);
  });

  it("skips entries with empty snippets but scores the rest", () => {
    const entries: SemanticEntry[] = [
      entry({ file: "empty.ts", snippet: "" }),
      entry({ file: "good.ts", snippet: "authentication middleware" }),
    ];
    const result = rankSemantic("authentication", entries);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.file).toBe("good.ts");
  });
});
