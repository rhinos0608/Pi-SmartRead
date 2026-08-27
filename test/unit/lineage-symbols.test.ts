import { describe, expect, it } from "vitest";
import {
  computeSymbolLineage,
  type SymbolTag,
  type MatchConfidence,
  type ParserAvailability,
} from "../../src/lineage-symbols.js";

// ── Fixtures ───────────────────────────────────────────────────────────

function makeSymbol(overrides: Partial<SymbolTag> & { id: string; language: string; kind: string; qualifiedName: string }): SymbolTag {
  return {
    signatureHash: "sig_" + overrides.id,
    bodyHash: "body_" + overrides.id,
    bodyTokens: ["token_a", "token_b"],
    signature: "(x: number) => void",
    parentQualifiedName: null,
    relationships: [],
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("computeSymbolLineage", () => {
  it("exact match → verified", () => {
    const before = [makeSymbol({ id: "b1", language: "typescript", kind: "function", qualifiedName: "foo" })];
    const after = [makeSymbol({ id: "a1", language: "typescript", kind: "function", qualifiedName: "foo", signatureHash: "sig_b1", bodyHash: "body_b1" })];

    const out = computeSymbolLineage(before, after, "medium");
    expect(out.results).toHaveLength(1);
    expect(out.results[0]!).toMatchObject({
      beforeId: "b1",
      afterId: "a1",
      confidence: "verified",
      delta: "matched",
      partial: false,
      absenceClaimDisabled: false,
    });
    expect(out.results[0]!.score).toBe(1.0);
  });

  it("rename with same body → high (git lineage) or medium (scoring)", () => {
    // Git lineage compares signature content (not hash) — rename keeps same signature
    const before = [makeSymbol({ id: "b1", language: "typescript", kind: "function", qualifiedName: "oldName", bodyTokens: ["x", "y"], signature: "(x: number) => void" })];
    const after = [makeSymbol({ id: "a1", language: "typescript", kind: "function", qualifiedName: "newName", bodyTokens: ["x", "y"], signature: "(x: number) => void" })];

    // Without git lineage → scoring path
    const out = computeSymbolLineage(before, after, "medium", undefined, false);
    expect(out.results).toHaveLength(1);
    expect(out.results[0]!.beforeId).toBe("b1");
    expect(out.results[0]!.afterId).toBe("a1");
    expect(["high", "medium"]).toContain(out.results[0]!.confidence);

    // With git lineage → high (same kind + same signature content)
    const outGit = computeSymbolLineage(before, after, "medium", undefined, true);
    expect(outGit.results).toHaveLength(1);
    expect(outGit.results[0]!.confidence).toBe("high");
  });

  it("body edit (same name, different body) → MODIFIED (matched with medium score)", () => {
    // Use high-overlap body tokens to ensure score >= 0.82 for medium
    // Score = 0.50*jaccard + 0.20*sigSim + 0.15*parentInd + 0.15*relJaccard
    // With 8/9 token overlap: 0.50*(8/9) + 0.20*1.0 + 0.15*0.5 + 0.15*1.0 = 0.444+0.20+0.075+0.15 = 0.869
    const before = [makeSymbol({ id: "b1", language: "typescript", kind: "function", qualifiedName: "foo",
      bodyTokens: ["a", "b", "c", "d", "e", "f", "g", "h", "i"],
      signature: "(x: number) => void" })];
    const after = [makeSymbol({ id: "a1", language: "typescript", kind: "function", qualifiedName: "foo",
      bodyTokens: ["a", "b", "c", "d", "e", "f", "g", "h", "j"],
      signature: "(x: number) => void" })];

    const out = computeSymbolLineage(before, after, "medium", undefined, false);
    expect(out.results.length).toBeGreaterThanOrEqual(1);
    const match = out.results.find((r) => r.beforeId === "b1" && r.afterId === "a1");
    expect(match).toBeDefined();
    expect(match!.confidence).toBe("medium");
    expect(match!.delta).toBe("modified");
    expect(match!.score).toBeGreaterThanOrEqual(0.82);
  });

  it("overload with different signatures → both matched independently", () => {
    const before = [
      makeSymbol({ id: "b1", language: "typescript", kind: "function", qualifiedName: "foo", signatureHash: "sig_str", bodyHash: "body_str", signature: "(s: string) => void", bodyTokens: ["s"] }),
      makeSymbol({ id: "b2", language: "typescript", kind: "function", qualifiedName: "foo", signatureHash: "sig_num", bodyHash: "body_num", signature: "(n: number) => void", bodyTokens: ["n"] }),
    ];
    const after = [
      makeSymbol({ id: "a1", language: "typescript", kind: "function", qualifiedName: "foo", signatureHash: "sig_str", bodyHash: "body_str", signature: "(s: string) => void", bodyTokens: ["s"] }),
      makeSymbol({ id: "a2", language: "typescript", kind: "function", qualifiedName: "foo", signatureHash: "sig_num", bodyHash: "body_num", signature: "(n: number) => void", bodyTokens: ["n"] }),
    ];

    const out = computeSymbolLineage(before, after, "medium");
    expect(out.results).toHaveLength(2);
    expect(out.results.every((r) => r.confidence === "verified")).toBe(true);
    expect(out.results.every((r) => r.delta === "matched")).toBe(true);
    expect(out.results.map((r) => r.beforeId).sort()).toEqual(["b1", "b2"]);
    expect(out.results.map((r) => r.afterId).sort()).toEqual(["a1", "a2"]);
  });

  it("different language → no match even if name identical", () => {
    const before = [makeSymbol({ id: "b1", language: "typescript", kind: "function", qualifiedName: "foo" })];
    const after = [makeSymbol({ id: "a1", language: "python", kind: "function", qualifiedName: "foo" })];

    const out = computeSymbolLineage(before, after, "medium");
    expect(out.results).toHaveLength(2);
    expect(out.results.find((r) => r.beforeId === "b1")?.confidence).toBe("removed");
    expect(out.results.find((r) => r.afterId === "a1")?.confidence).toBe("added");
  });

  it("different kind → no match even if name identical", () => {
    const before = [makeSymbol({ id: "b1", language: "typescript", kind: "function", qualifiedName: "foo", bodyTokens: ["x"], signature: "(x: number) => void" })];
    const after = [makeSymbol({ id: "a1", language: "typescript", kind: "class", qualifiedName: "foo", bodyTokens: ["x"], signature: "(x: number) => void" })];

    const out = computeSymbolLineage(before, after, "medium");
    expect(out.results).toHaveLength(2);
    expect(out.results.find((r) => r.beforeId === "b1")?.confidence).toBe("removed");
    expect(out.results.find((r) => r.afterId === "a1")?.confidence).toBe("added");
  });

  it("hard negative: unrelated symbol sharing a name → no lineage", () => {
    const before = [makeSymbol({ id: "b1", language: "typescript", kind: "function", qualifiedName: "utils", bodyTokens: ["auth", "login", "token"], signature: "(cred: Credentials) => Session", relationships: ["Auth.login"] })];
    const after = [makeSymbol({ id: "a1", language: "typescript", kind: "function", qualifiedName: "utils", bodyTokens: ["render", "dom", "element"], signature: "(el: Element) => void", relationships: ["DOM.render"] })];

    const out = computeSymbolLineage(before, after, "medium", undefined, false);
    // Should have removed + added, not medium or better
    const match = out.results.find((r) => r.beforeId === "b1" && r.afterId === "a1");
    if (match) {
      expect(match.confidence).not.toBe("verified");
      expect(match.confidence).not.toBe("high");
      expect(match.confidence).not.toBe("medium");
    }
    expect(out.results.find((r) => r.beforeId === "b1")?.confidence).toBe("removed");
    expect(out.results.find((r) => r.afterId === "a1")?.confidence).toBe("added");
  });

  it("parser unavailable → disabled, partial, no absence claims", () => {
    const before = [makeSymbol({ id: "b1", language: "ruby", kind: "method", qualifiedName: "Foo#bar" })];
    const after = [makeSymbol({ id: "a1", language: "ruby", kind: "method", qualifiedName: "Foo#bar" })];

    const availability = new Map<string, ParserAvailability>([["ruby", "unavailable"]]);
    const out = computeSymbolLineage(before, after, "medium", availability);

    expect(out.results).toHaveLength(2);
    for (const r of out.results) {
      expect(r.partial).toBe(true);
      expect(r.absenceClaimDisabled).toBe(true);
      expect(r.score).toBeNull();
    }
    const removed = out.results.find((r) => r.beforeId === "b1");
    const added = out.results.find((r) => r.afterId === "a1");
    expect(removed?.confidence).toBe("removed");
    expect(added?.confidence).toBe("added");
  });

  it("margin enforcement: single exact match with tie → blocks medium for competitor", () => {
    // Two before symbols, only one matches exactly. The other gets removed.
    // This tests that unmatched symbols after exact pass become removed.
    const before = [
      makeSymbol({ id: "b1", language: "typescript", kind: "function", qualifiedName: "foo", bodyTokens: ["a", "b", "c", "d", "e"], signature: "(x: string, y: number) => void" }),
      makeSymbol({ id: "b2", language: "typescript", kind: "function", qualifiedName: "foo", bodyTokens: ["a", "b", "c", "d", "f"], signature: "(x: string, y: number) => void" }),
    ];
    const after = [
      makeSymbol({ id: "a1", language: "typescript", kind: "function", qualifiedName: "foo", bodyTokens: ["a", "b", "c", "d", "e"], signature: "(x: string, y: number) => void" }),
    ];

    const out = computeSymbolLineage(before, after, "medium", undefined, false);
    // One should match (candidate scoring with score >= 0.82), the other should be removed
    const matched = out.results.filter((r) => r.afterId !== null);
    const removed = out.results.filter((r) => r.confidence === "removed");
    expect(matched).toHaveLength(1);
    expect(removed).toHaveLength(1);
    // The matched one should have high score
    expect(matched[0]!.score).toBeGreaterThanOrEqual(0.82);
  });

  it("returns empty results when file confidence is below medium", () => {
    const before = [makeSymbol({ id: "b1", language: "typescript", kind: "function", qualifiedName: "foo" })];
    const after = [makeSymbol({ id: "a1", language: "typescript", kind: "function", qualifiedName: "foo" })];

    for (const conf of ["removed", "added", "POSSIBLE_MATCH"] as MatchConfidence[]) {
      const out = computeSymbolLineage(before, after, conf);
      expect(out.results).toEqual([]);
    }
  });

  it("metadata records algorithm parameters", () => {
    const out = computeSymbolLineage([], [], "medium");
    expect(out.metadata.tokenizerVersion).toBe("lineage-v1");
    expect(out.metadata.mediumThreshold).toBe(0.82);
    expect(out.metadata.possibleMatchThreshold).toBe(0.65);
    expect(out.metadata.endpointMargin).toBe(0.08);
    expect(out.metadata.beforeCount).toBe(0);
    expect(out.metadata.afterCount).toBe(0);
  });

  it("possible match for score >= 0.65 but < 0.82", () => {
    // Score = 0.50*0.5 + 0.20*0.88 + 0.15*0.5 + 0.15*0 = 0.25+0.176+0.075+0 = 0.501
    // Too low. Use more overlap:
    // bodyTokens: 3/5 overlap → Jaccard = 3/7 ≈ 0.428
    // Actually let's compute precisely:
    // bodyTokens: ["a","b","c"] vs ["a","b","d"] → Jaccard = 2/4 = 0.5
    // sig: "(x: string) => string" vs "(x: string) => number"
    // bigrams of "(x: string) => string": "(x", "x:", ": ", " s", "st", "tr", "ri", "in", "ng", "g)", ") ", " =>", "=> ", "> s" → 13 bigrams
    // bigrams of "(x: string) => number": "(x", "x:", ": ", " s", "st", "tr", "ri", "in", "ng", "g)", ") ", " =>", "=> ", "> n", "nu", "um", "mb", "be", "er" → 19 bigrams
    // Common: "(x", "x:", ": ", " s", "st", "tr", "ri", "in", "ng", "g)", ") ", " =>", "=> " = 13
    // Total: 13 + 19 - 13 = 19
    // Similarity: 13/19 ≈ 0.684
    // Score = 0.50*0.5 + 0.20*0.684 + 0.15*0.5 + 0.15*1.0 = 0.25+0.137+0.075+0.15 = 0.612
    // Still below 0.65. Need more overlap.
    // Try bodyTokens: 4/5 overlap → Jaccard = 4/6 = 0.667
    // Score = 0.50*0.667 + 0.20*0.684 + 0.15*0.5 + 0.15*1.0 = 0.333+0.137+0.075+0.15 = 0.695
    // That's in [0.65, 0.82) range → POSSIBLE_MATCH
    const before = [makeSymbol({ id: "b1", language: "typescript", kind: "function", qualifiedName: "foo",
      bodyTokens: ["a", "b", "c", "d", "e"],
      signature: "(x: string) => string",
      relationships: [] })];
    const after = [makeSymbol({ id: "a1", language: "typescript", kind: "function", qualifiedName: "foo",
      bodyTokens: ["a", "b", "c", "d", "f"],
      signature: "(x: string) => number",
      relationships: [] })];

    const out = computeSymbolLineage(before, after, "medium", undefined, false);
    const match = out.results.find((r) => r.beforeId === "b1" && r.afterId === "a1");
    expect(match).toBeDefined();
    expect(match!.confidence).toBe("POSSIBLE_MATCH");
    expect(match!.score).toBeGreaterThanOrEqual(0.65);
    expect(match!.score).toBeLessThan(0.82);
  });

  it("deterministic output: same input always produces same results", () => {
    const before = [
      makeSymbol({ id: "b1", language: "typescript", kind: "function", qualifiedName: "alpha" }),
      makeSymbol({ id: "b2", language: "typescript", kind: "class", qualifiedName: "beta" }),
    ];
    const after = [
      makeSymbol({ id: "a1", language: "typescript", kind: "function", qualifiedName: "alpha" }),
      makeSymbol({ id: "a2", language: "typescript", kind: "class", qualifiedName: "beta" }),
    ];

    const out1 = computeSymbolLineage(before, after, "medium");
    const out2 = computeSymbolLineage(before, after, "medium");
    expect(JSON.stringify(out1)).toBe(JSON.stringify(out2));
  });

  it("overloads: same name different kind → not same entity", () => {
    const before = [
      makeSymbol({ id: "b1", language: "typescript", kind: "function", qualifiedName: "overloaded", signatureHash: "sig1", bodyHash: "body1", signature: "(x: string) => void" }),
      makeSymbol({ id: "b2", language: "typescript", kind: "type", qualifiedName: "overloaded", signatureHash: "sig2", bodyHash: "body2", signature: "interface" }),
    ];
    const after = [
      makeSymbol({ id: "a1", language: "typescript", kind: "function", qualifiedName: "overloaded", signatureHash: "sig1", bodyHash: "body1", signature: "(x: string) => void" }),
      makeSymbol({ id: "a2", language: "typescript", kind: "type", qualifiedName: "overloaded", signatureHash: "sig2", bodyHash: "body2", signature: "interface" }),
    ];

    const out = computeSymbolLineage(before, after, "medium");
    expect(out.results).toHaveLength(2);
    expect(out.results.every((r) => r.confidence === "verified")).toBe(true);
  });
});
