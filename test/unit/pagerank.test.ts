/**
 * Tests for PageRank implementation.
 */
import { describe, it, expect } from "vitest";
import { pagerank } from "../../pagerank.js";

describe("pagerank", () => {
  it("returns empty map for empty nodes", () => {
    const result = pagerank(new Set(), []);
    expect(result.size).toBe(0);
  });

  it("ranks single node with value 1", () => {
    const result = pagerank(new Set(["a.ts"]), []);
    expect(result.size).toBe(1);
    expect(result.get("a.ts")).toBeCloseTo(1, 1);
  });

  it("gives higher rank to referenced files", () => {
    const nodes = new Set(["a.ts", "b.ts"]);
    const edges = [{ from: "a.ts", to: "b.ts" }];
    const result = pagerank(nodes, edges);

    // b.ts should have higher rank because a.ts points to it
    expect(result.get("b.ts")).toBeGreaterThan(result.get("a.ts")!);
  });

  it("personalization biases ranks", () => {
    const nodes = new Set(["common.ts", "a.ts", "b.ts"]);
    // b.ts references common.ts
    const edges = [
      { from: "b.ts", to: "common.ts" },
    ];
    const personalization = new Map([["a.ts", 100.0]]);

    const result = pagerank(nodes, edges, personalization);

    // a.ts should have the highest rank due to personalization
    const ranks = Array.from(result.entries()).sort((a, b) => b[1] - a[1]);
    expect(ranks[0][0]).toBe("a.ts");
  });

  it("converges within max iterations", () => {
    const nodes = new Set(Array.from({ length: 50 }, (_, i) => `f${i}.ts`));
    const edges = [];
    for (let i = 0; i < 49; i++) {
      edges.push({ from: `f${i}.ts`, to: `f${i + 1}.ts` });
    }

    const start = performance.now();
    const result = pagerank(nodes, edges, undefined, 0.85, 100, 1e-6);
    const elapsed = performance.now() - start;

    expect(result.size).toBe(50);
    expect(elapsed).toBeLessThan(1000); // Should complete in under 1s
  });

  it("total rank sums to ~1", () => {
    const nodes = new Set(["a.ts", "b.ts", "c.ts", "d.ts"]);
    const edges = [
      { from: "a.ts", to: "b.ts" },
      { from: "b.ts", to: "c.ts" },
      { from: "c.ts", to: "d.ts" },
      { from: "d.ts", to: "a.ts" },
    ];

    const result = pagerank(nodes, edges);
    const total = Array.from(result.values()).reduce((s, v) => s + v, 0);
    expect(total).toBeCloseTo(1, 1);
  });

  it("handles dangling nodes (no outgoing edges)", () => {
    const nodes = new Set(["a.ts", "b.ts"]);
    // No edges — both are dangling
    const result = pagerank(nodes, []);

    expect(result.size).toBe(2);
    // Both should have equal rank
    expect(result.get("a.ts")).toBeCloseTo(result.get("b.ts")!, 2);
  });

  it("handles self-loops", () => {
    const nodes = new Set(["a.ts", "b.ts"]);
    const edges = [
      { from: "a.ts", to: "a.ts" },
      { from: "b.ts", to: "a.ts" },
    ];
    const result = pagerank(nodes, edges);

    // a.ts should rank higher (it's referenced by both nodes)
    expect(result.get("a.ts")).toBeGreaterThan(result.get("b.ts")!);
  });
});
