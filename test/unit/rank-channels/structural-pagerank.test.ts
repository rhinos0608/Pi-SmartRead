import { describe, it, expect } from "vitest";
import { structuralPageRank } from "../../../src/rank-channels/structural-pagerank.js";
import type { GraphEdge } from "../../../src/pagerank.js";

// ── Helpers ────────────────────────────────────────────────────────────

function edge(from: string, to: string, weight?: number): GraphEdge {
  return weight !== undefined ? { from, to, weight } : { from, to };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("structuralPageRank", () => {
  it("returns unavailable when edges are empty", () => {
    const result = structuralPageRank([]);
    expect(result.channel).toBe("structural-pagerank");
    expect(result.candidates).toEqual([]);
    expect(result.unavailable).toEqual({
      reason: "empty graph — no edges provided",
    });
  });

  it("ranks a single-edge graph deterministically", () => {
    const edges = [edge("a.ts", "b.ts")];
    const r1 = structuralPageRank(edges);
    const r2 = structuralPageRank(edges);

    // Deterministic
    expect(r1.candidates.map((c) => c.file)).toEqual(
      r2.candidates.map((c) => c.file),
    );

    // b.ts should rank higher (incoming link)
    expect(r1.candidates[0]!.file).toBe("b.ts");
    expect(r1.candidates[1]!.file).toBe("a.ts");
  });

  it("ranks higher-indegree nodes higher in a chain", () => {
    // a → b → c → d, plus a → c
    const edges = [
      edge("a.ts", "b.ts"),
      edge("b.ts", "c.ts"),
      edge("c.ts", "d.ts"),
      edge("a.ts", "c.ts"),
    ];
    const result = structuralPageRank(edges);

    // d.ts is the terminal sink — accumulates the most rank in the chain
    expect(result.candidates[0]!.file).toBe("d.ts");
  });

  it("respects maxCandidates option", () => {
    const edges: GraphEdge[] = [];
    for (let i = 0; i < 10; i++) {
      for (let j = 0; j < 10; j++) {
        if (i !== j) edges.push(edge(`f${i}.ts`, `f${j}.ts`));
      }
    }
    const result = structuralPageRank(edges, { maxCandidates: 5 });
    expect(result.candidates).toHaveLength(5);
  });

  it("applies damping factor", () => {
    const edges = [edge("a.ts", "b.ts")];

    const low = structuralPageRank(edges, { dampingFactor: 0.5 });
    const high = structuralPageRank(edges, { dampingFactor: 0.99 });

    // Both should have same ordering but different absolute scores
    expect(low.candidates[0]!.file).toBe("b.ts");
    expect(high.candidates[0]!.file).toBe("b.ts");

    // Higher damping → scores more differentiated
    const highRange =
      high.candidates[0]!.rawScore - high.candidates[1]!.rawScore;
    const lowRange =
      low.candidates[0]!.rawScore - low.candidates[1]!.rawScore;
    expect(highRange).toBeGreaterThan(lowRange);
  });

  it("sets correct metadata", () => {
    const edges = [edge("x.ts", "y.ts"), edge("y.ts", "z.ts")];
    const result = structuralPageRank(edges);

    expect(result.metadata).toEqual({
      nodeCount: 3,
      edgeCount: 2,
      dampingFactor: 0.85,
    });
  });

  it("produces ChannelCandidate shape with kind and snippet", () => {
    const result = structuralPageRank([edge("foo.ts", "bar.ts")]);
    for (const c of result.candidates) {
      expect(c).toHaveProperty("kind", "file");
      expect(c).toHaveProperty("snippet", "");
      expect(c).toHaveProperty("rawScore");
      expect(typeof c.rawScore).toBe("number");
    }
  });

  it("caps output to 500 by default", () => {
    // Build a complete graph with >500 nodes
    const edges: GraphEdge[] = [];
    for (let i = 0; i < 510; i++) {
      edges.push(edge(`n${i}.ts`, `n${(i + 1) % 510}.ts`));
    }
    const result = structuralPageRank(edges);
    expect(result.candidates.length).toBeLessThanOrEqual(500);
  });

  it("scores are deterministic across runs (same input → same output)", () => {
    const edges = [
      edge("auth.ts", "db.ts"),
      edge("db.ts", "config.ts"),
      edge("auth.ts", "config.ts"),
      edge("routes.ts", "auth.ts"),
      edge("routes.ts", "db.ts"),
    ];
    const run1 = structuralPageRank(edges);
    const run2 = structuralPageRank(edges);
    expect(run1.candidates).toEqual(run2.candidates);
  });

  it("handles self-edges without crashing", () => {
    const edges = [edge("self.ts", "self.ts")];
    const result = structuralPageRank(edges);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.file).toBe("self.ts");
    expect(result.candidates[0]!.rawScore).toBeCloseTo(1, 0);
  });
});
