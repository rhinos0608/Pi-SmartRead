import { describe, it, expect } from "vitest";
import {
  getRelationshipEvidence,
} from "../../src/relationship-evidence.js";
import type { Provenance } from "../../src/relationship-evidence.js";

const edges: Provenance[] = [
  { from: "a", to: "b", type: "uses", confidence: 0.9 },
  { from: "c", to: "d", type: "uses", confidence: 0.8 },
  { from: "a", to: "e", type: "imports", confidence: 0.7 },
  { from: "f", to: "g", type: "depends", confidence: 0.6 },
  { from: "h", to: "a", type: "uses", confidence: 0.5 },
];

describe("getRelationshipEvidence", () => {
  it("filters by from", () => {
    const result = getRelationshipEvidence(edges, { from: "a", limit: 10 });
    expect(result.edges).toHaveLength(2);
    expect(result.edges.every((e) => e.from === "a")).toBe(true);
  });

  it("filters by to", () => {
    const result = getRelationshipEvidence(edges, { to: "d", limit: 10 });
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]!.to).toBe("d");
  });

  it("filters by relationshipTypes", () => {
    const result = getRelationshipEvidence(edges, {
      relationshipTypes: ["uses", "imports"],
      limit: 10,
    });
    expect(result.edges).toHaveLength(4);
    expect(
      result.edges.every(
        (e) =>
          e.relationshipType === "uses" || e.relationshipType === "imports"
      )
    ).toBe(true);
  });

  it("returns correct number of edges and nextCursor when more exist", () => {
    const result = getRelationshipEvidence(edges, { limit: 2 });
    expect(result.edges).toHaveLength(2);
    expect(result.nextCursor).toBeDefined();
  });

  it("paginates through two pages", () => {
    const page1 = getRelationshipEvidence(edges, { limit: 2 });
    expect(page1.edges).toHaveLength(2);
    expect(page1.nextCursor).toBeDefined();

    const page2 = getRelationshipEvidence(edges, {
      limit: 2,
      cursor: page1.nextCursor!,
    });
    expect(page2.edges).toHaveLength(2);

    const combined = [...page1.edges, ...page2.edges];
    expect(combined).toHaveLength(4);
    const signatures = combined.map((e) => `${e.from}->${e.to}`);
    expect(new Set(signatures).size).toBe(4);
  });

  it("respects limit (max 500 enforced)", () => {
    const many: Provenance[] = Array.from({ length: 600 }, (_, i) => ({
      from: `x${i}`,
      to: `y${i}`,
      type: "t",
      confidence: 0.5,
    }));
    const result = getRelationshipEvidence(many, { limit: 1000 });
    expect(result.edges).toHaveLength(500);
    expect(result.nextCursor).toBeDefined();
  });

  it("returns empty when no matches", () => {
    const result = getRelationshipEvidence(edges, {
      from: "nonexistent",
      limit: 10,
    });
    expect(result.edges).toHaveLength(0);
    expect(result.nextCursor).toBeUndefined();
  });

  it("maintains stable sort order", () => {
    const result = getRelationshipEvidence(edges, { limit: 10 });
    const types = result.edges.map((e) => e.relationshipType);
    const sorted = [...types].sort((a, b) => a.localeCompare(b));
    expect(types).toEqual(sorted);
    const sameType = result.edges.filter(
      (e) => e.relationshipType === "uses"
    );
    const froms = sameType.map((e) => e.from);
    expect([...froms].sort()).toEqual(froms);
  });

  it("cursor round-trip preserves position", () => {
    const page1 = getRelationshipEvidence(edges, { limit: 1 });
    const page2 = getRelationshipEvidence(edges, {
      limit: 1,
      cursor: page1.nextCursor!,
    });
    expect(page2.edges).toHaveLength(1);
    expect(page2.edges[0]).not.toEqual(page1.edges[0]);
  });
});
