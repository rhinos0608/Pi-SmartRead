import { describe, it, expect } from "vitest";
import { detectCommunities } from "../../src/community-detection.js";

describe("detectCommunities", () => {
  it("two disconnected triangles → 2 clusters, positive modularity", () => {
    // Triangle A: 0-1, 1-2, 0-2
    // Triangle B: 3-4, 4-5, 3-5
    // No cross edges
    const edges = [
      { from: "0", to: "1" },
      { from: "1", to: "2" },
      { from: "0", to: "2" },
      { from: "3", to: "4" },
      { from: "4", to: "5" },
      { from: "3", to: "5" },
    ];

    const result = detectCommunities(edges);

    expect(result.clusters.size).toBe(2);

    // Each cluster should have exactly 3 nodes
    const sizes = [...result.clusters.values()].map((c) => c.length).sort();
    expect(sizes).toEqual([3, 3]);

    // All 6 nodes accounted for
    const allNodes = [...result.clusters.values()].flat();
    expect(new Set(allNodes).size).toBe(6);

    // Modularity should be positive (good community structure)
    expect(result.modularity).toBeGreaterThan(0);
  });

  it("single connected component → all nodes in some cluster", () => {
    const edges = [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
      { from: "c", to: "d" },
    ];

    const result = detectCommunities(edges);
    // All 4 nodes accounted for across all clusters
    const allNodes = [...result.clusters.values()].flat();
    expect(new Set(allNodes).size).toBe(4);
    expect(result.modularity).toBeGreaterThanOrEqual(0);
  });

  it("empty edges → empty cluster", () => {
    const result = detectCommunities([]);
    expect(result.clusters.size).toBe(1);
    expect(result.clusters.get(0)!.length).toBe(0);
  });

  it("deterministic: same input produces same output", () => {
    const edges = [
      { from: "x", to: "y" },
      { from: "y", to: "z" },
      { from: "z", to: "x" },
      { from: "a", to: "b" },
      { from: "b", to: "c" },
      { from: "c", to: "a" },
    ];

    const r1 = detectCommunities(edges);
    const r2 = detectCommunities(edges);

    expect(r1.modularity).toBe(r2.modularity);
    expect(r1.clusters.size).toBe(r2.clusters.size);
    // Cluster contents should match (order within clusters may differ)
    const sorted1 = [...r1.clusters.values()]
      .map((c) => [...c].sort())
      .sort();
    const sorted2 = [...r2.clusters.values()]
      .map((c) => [...c].sort())
      .sort();
    expect(sorted1).toEqual(sorted2);
  });

  it("linear chain of 5 nodes handles uniform structure", () => {
    const edges = [
      { from: "0", to: "1" },
      { from: "1", to: "2" },
      { from: "2", to: "3" },
      { from: "3", to: "4" },
    ];
    const result = detectCommunities(edges);
    // Linear chain: no clear community structure; Louvain may split into multiple clusters
    expect(result.clusters.size).toBeGreaterThanOrEqual(1);
    expect(result.modularity).toBeGreaterThanOrEqual(0);
  });
});
