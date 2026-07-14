import { describe, expect, it } from "vitest";
import { leidenCommunities } from "../../src/graphify-enricher.js";

describe("leidenCommunities", () => {
  it("returns empty map for empty adjacency", () => {
    const result = leidenCommunities(new Map());
    expect(result.size).toBe(0);
  });

  it("returns single community for single node", () => {
    const adj = new Map<string, string[]>([["a", []]]);
    const result = leidenCommunities(adj);
    expect(result.size).toBe(1);
    expect(result.get("a")).toBe(0);
  });

  it("puts two connected nodes in same community", () => {
    const adj = new Map<string, string[]>([
      ["a", ["b"]],
      ["b", ["a"]],
    ]);
    const result = leidenCommunities(adj);
    expect(result.get("a")).toBe(result.get("b"));
  });

  it("produces deterministic output with same seed", () => {
    const adj = new Map<string, string[]>([
      ["a", ["b", "c"]],
      ["b", ["a", "c"]],
      ["c", ["a", "b"]],
      ["d", ["e"]],
      ["e", ["d"]],
    ]);
    const r1 = leidenCommunities(adj, { seed: 42 });
    const r2 = leidenCommunities(adj, { seed: 42 });
    expect(r1.size).toBe(r2.size);
    for (const [node, comm] of r1) {
      expect(r2.get(node)).toBe(comm);
    }
  });

  it("stores isolated nodes in separate communities", () => {
    const adj = new Map<string, string[]>([
      ["a", ["b"]],
      ["b", ["a"]],
      ["c", []],
      ["d", []],
    ]);
    const result = leidenCommunities(adj);
    // a and b should be in the same community
    expect(result.get("a")).toBe(result.get("b"));
    // c and d should be in different communities (isolated)
    const cComm = result.get("c");
    const dComm = result.get("d");
    expect(cComm).not.toBeUndefined();
    expect(dComm).not.toBeUndefined();
    expect(cComm).not.toBe(dComm);
  });

  it("splits 5-ring into multiple communities at higher resolution", () => {
    // 5-cycle: greedy Louvain local moving at gamma=1 collapses the ring
    // because every adjacent move yields a positive gain. With sufficient
    // resolution (gamma >= 2) the second penalty term dominates and the
    // ring splits into smaller communities. This guards against the
    // F-1/F-2 regression where the aggregation phase drops internal edge
    // mass and biases the algorithm toward a single super-community.
    const adj = new Map<string, string[]>([
      ["a", ["b", "e"]],
      ["b", ["a", "c"]],
      ["c", ["b", "d"]],
      ["d", ["c", "e"]],
      ["e", ["d", "a"]],
    ]);
    const result = leidenCommunities(adj, { resolution: 2.0 });
    const comms = new Set(result.values());
    // At resolution 2.0 the 5-ring must split into more than one community.
    expect(comms.size).toBeGreaterThan(1);
    // Each community must be non-empty.
    for (const c of comms) {
      expect([...result.values()].filter((v) => v === c).length).toBeGreaterThan(0);
    }
  });

  it("detects two clear communities", () => {
    // Two disconnected K3 clusters — the algorithm should split them
    // into two independent communities.
    const adj = new Map<string, string[]>([
      ["a", ["b", "c"]],
      ["b", ["a", "c"]],
      ["c", ["a", "b"]],
      ["d", ["e", "f"]],
      ["e", ["d", "f"]],
      ["f", ["d", "e"]],
    ]);
    const result = leidenCommunities(adj);
    // a, b, c should be in the same community
    expect(result.get("a")).toBe(result.get("b"));
    expect(result.get("b")).toBe(result.get("c"));
    // d, e, f should be in the same community
    expect(result.get("d")).toBe(result.get("e"));
    expect(result.get("e")).toBe(result.get("f"));
    // The two groups should be different
    expect(result.get("a")).not.toBe(result.get("d"));
  });

  it("splits more with higher resolution", () => {
    // Ring of 6 nodes (modularity splitting happens at resolution > 1.0)
    const adj = new Map<string, string[]>([
      ["a", ["b", "f"]],
      ["b", ["a", "c"]],
      ["c", ["b", "d"]],
      ["d", ["c", "e"]],
      ["e", ["d", "f"]],
      ["f", ["e", "a"]],
    ]);
    const lowRes = leidenCommunities(adj, { resolution: 0.5 });
    const highRes = leidenCommunities(adj, { resolution: 2.0 });
    const lowCount = new Set(lowRes.values()).size;
    const highCount = new Set(highRes.values()).size;
    // Higher resolution should produce same or more communities
    expect(highCount).toBeGreaterThanOrEqual(lowCount);
  });

  it("returns 0-indexed sequential community IDs", () => {
    const adj = new Map<string, string[]>([
      ["x", ["y"]],
      ["y", ["x"]],
      ["z", []],
    ]);
    const result = leidenCommunities(adj);
    const ids = [...new Set(result.values())].sort((a, b) => a - b);
    // IDs should be sequential from 0
    expect(ids[0]).toBe(0);
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]!).toBe(ids[i - 1]! + 1);
    }
  });
});
