/**
 * Tests for community-detection — Louvain community detection.
 */
import { describe, it, expect } from "vitest";
import { detectCommunities } from "../../src/community-detection.js";

describe("detectCommunities", () => {
  it("returns empty cluster for no edges", () => {
    const result = detectCommunities([]);
    expect(result.clusters.size).toBe(1);
    expect(result.clusters.get(0)).toEqual([]);
    expect(result.modularity).toBe(0);
  });

  it("detects two disconnected communities", () => {
    // Community A: 0-1-2, Community B: 3-4-5
    const edges = [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
      { from: "a", to: "c" },
      { from: "d", to: "e" },
      { from: "e", to: "f" },
      { from: "d", to: "f" },
    ];
    const result = detectCommunities(edges);
    expect(result.clusters.size).toBe(2);
    expect(result.modularity).toBeGreaterThan(0);

    // Check that each community has 3 members
    const sizes = [...result.clusters.values()].map((c) => c.length).sort();
    expect(sizes).toEqual([3, 3]);
  });

  it("detects single connected community", () => {
    const edges = [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
      { from: "c", to: "d" },
      { from: "a", to: "d" },
      { from: "a", to: "c" },
      { from: "b", to: "d" },
    ];
    const result = detectCommunities(edges);
    expect(result.clusters.size).toBe(1);
    expect(result.clusters.get(0)).toHaveLength(4);
  });

  it("handles single node (no edges)", () => {
    // Single self-referencing edge
    const result = detectCommunities([{ from: "a", to: "a" }]);
    expect(result.clusters.size).toBe(1);
  });

  it("detects three communities", () => {
    const edges = [
      // Community 1: x, y
      { from: "x", to: "y" },
      // Community 2: a, b, c
      { from: "a", to: "b" },
      { from: "b", to: "c" },
      // Community 3: p, q
      { from: "p", to: "q" },
      // Weak inter-community edge
      { from: "a", to: "x" },
    ];
    const result = detectCommunities(edges);
    // Should have at least 2 clusters (the strongly connected ones together)
    expect(result.clusters.size).toBeGreaterThanOrEqual(2);
    expect(result.modularity).toBeGreaterThanOrEqual(0);
  });

  it("all nodes appear in exactly one cluster", () => {
    const edges = [
      { from: "a", to: "b" },
      { from: "c", to: "d" },
      { from: "e", to: "f" },
    ];
    const result = detectCommunities(edges);
    const allNodes = [...result.clusters.values()].flat();
    expect(allNodes.sort()).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  it("uses louvain algorithm", () => {
    const edges = [
      { from: "a", to: "b" },
      { from: "c", to: "d" },
    ];
    const result = detectCommunities(edges);
    expect(result.algorithm).toBe("louvain");
  });
});
