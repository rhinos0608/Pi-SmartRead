import { describe, expect, it } from "vitest";
import {
  computeRelationshipChanges,
  type MatchConfidence,
  type FileLineageResult,
} from "../../src/delta-relationships.js";
import type { Provenance, EdgeType } from "../../src/context-graph.js";

// ── Test helpers ─────────────────────────────────────────────────

function tx(
  from: string,
  to: string,
  type: EdgeType = "imports",
  confidence = 1.0,
): Provenance {
  return { from, to, type, confidence };
}

function highConfidence(score: number): MatchConfidence {
  return {
    value: score,
    class: "high",
    algorithmVersion: "lineage-v1",
    signals: ["content-hash"],
    ambiguities: [],
  };
}

const EMPTY_LINEAGE: FileLineageResult = { moves: [] };

// ── Tests ────────────────────────────────────────────────────────

describe("computeRelationshipChanges", () => {
  it("added edge", () => {
    const before: Provenance[] = [];
    const after: Provenance[] = [tx("a.ts", "b.ts")];

    const changes = computeRelationshipChanges(before, after, EMPTY_LINEAGE);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.kind).toBe("ADDED");
    expect(changes[0]!.after).toEqual({
      from: "a.ts",
      to: "b.ts",
      confidence: 1.0,
    });
    expect(changes[0]!.confidence.class).toBe("verified");
  });

  it("removed edge", () => {
    const before: Provenance[] = [tx("a.ts", "b.ts")];
    const after: Provenance[] = [];

    const changes = computeRelationshipChanges(before, after, EMPTY_LINEAGE);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.kind).toBe("REMOVED");
    expect(changes[0]!.before).toEqual({
      from: "a.ts",
      to: "b.ts",
      confidence: 1.0,
    });
    expect(changes[0]!.confidence.class).toBe("verified");
  });

  it("modified confidence", () => {
    const before: Provenance[] = [tx("a.ts", "b.ts", "imports", 1.0)];
    const after: Provenance[] = [tx("a.ts", "b.ts", "imports", 0.8)];

    const changes = computeRelationshipChanges(before, after, EMPTY_LINEAGE);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.kind).toBe("MODIFIED");
    expect(changes[0]!.before!.confidence).toBe(1.0);
    expect(changes[0]!.after!.confidence).toBe(0.8);
  });

  it("moved-file edge translation", () => {
    // Edge a.ts → b.ts exists in before. File a.ts moved to a2.ts.
    // In after, edge a2.ts → b.ts exists.
    // After translation, before-edge (a2.ts, b.ts, imports) matches after-edge.
    // No change expected.
    const before: Provenance[] = [tx("a.ts", "b.ts")];
    const after: Provenance[] = [tx("a2.ts", "b.ts")];

    const lineage: FileLineageResult = {
      moves: [
        {
          beforePath: "a.ts",
          afterPath: "a2.ts",
          confidence: highConfidence(0.96),
        },
      ],
    };

    const changes = computeRelationshipChanges(before, after, lineage);
    expect(changes).toHaveLength(0);
  });

  it("moved-file edge translation produces REMOVED when target absent", () => {
    // a.ts → b.ts in before. a.ts moved to a2.ts. But after has no a2.ts → b.ts.
    const before: Provenance[] = [tx("a.ts", "b.ts")];
    const after: Provenance[] = [];

    const lineage: FileLineageResult = {
      moves: [
        {
          beforePath: "a.ts",
          afterPath: "a2.ts",
          confidence: highConfidence(0.96),
        },
      ],
    };

    const changes = computeRelationshipChanges(before, after, lineage);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.kind).toBe("REMOVED");
    // Confidence should reflect the lineage match, not "verified"
    expect(changes[0]!.confidence.class).toBe("high");
    expect(changes[0]!.confidence.value).toBe(0.96);
  });

  it("unchanged edges produce no changes", () => {
    const edges: Provenance[] = [
      tx("a.ts", "b.ts"),
      tx("a.ts", "c.ts", "calls"),
      tx("x.ts", "y.ts", "imports", 0.9),
    ];

    const changes = computeRelationshipChanges(edges, edges, EMPTY_LINEAGE);
    expect(changes).toHaveLength(0);
  });

  it("edge type changes produce ADDED + REMOVED, not MODIFIED", () => {
    // Same (from, to) but different type = different key = no overlap
    const before: Provenance[] = [tx("a.ts", "b.ts", "imports")];
    const after: Provenance[] = [tx("a.ts", "b.ts", "calls")];

    const changes = computeRelationshipChanges(before, after, EMPTY_LINEAGE);
    // imports removed, calls added
    const removed = changes.find((c) => c.kind === "REMOVED");
    const added = changes.find((c) => c.kind === "ADDED");
    expect(removed).toBeDefined();
    expect(removed!.relationshipType).toBe("imports");
    expect(added).toBeDefined();
    expect(added!.relationshipType).toBe("calls");
  });

  it("multiple changes in one call", () => {
    const before: Provenance[] = [
      tx("a.ts", "b.ts"),
      tx("a.ts", "c.ts"),
    ];
    const after: Provenance[] = [
      tx("a.ts", "b.ts", "imports", 0.5), // MODIFIED confidence
      tx("d.ts", "e.ts"), // ADDED
    ];

    const changes = computeRelationshipChanges(before, after, EMPTY_LINEAGE);
    const kinds = changes.map((c) => c.kind).sort();
    expect(kinds).toEqual(["ADDED", "MODIFIED", "REMOVED"]);
  });

  it("move confidence flows into change confidence", () => {
    // a.ts → b.ts in before. a.ts → b.ts NOT in after.
    // a.ts moved to a2.ts (high confidence move).
    // The REMOVED change should carry the high confidence.
    const before: Provenance[] = [tx("a.ts", "b.ts")];
    const after: Provenance[] = [];

    const moveConf: MatchConfidence = {
      value: 0.88,
      class: "medium",
      algorithmVersion: "lineage-v1",
      signals: ["token-shingle"],
      ambiguities: [],
    };

    const lineage: FileLineageResult = {
      moves: [{ beforePath: "a.ts", afterPath: "a2.ts", confidence: moveConf }],
    };

    const changes = computeRelationshipChanges(before, after, lineage);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.kind).toBe("REMOVED");
    expect(changes[0]!.confidence).toBe(moveConf);
  });

  it("ADDED edge on moved file carries lineage confidence", () => {
    // after has a2.ts → b.ts. Before is empty. a.ts → a2.ts is a move.
    const before: Provenance[] = [];
    const after: Provenance[] = [tx("a2.ts", "b.ts")];

    const lineage: FileLineageResult = {
      moves: [
        {
          beforePath: "a.ts",
          afterPath: "a2.ts",
          confidence: highConfidence(0.97),
        },
      ],
    };

    const changes = computeRelationshipChanges(before, after, lineage);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.kind).toBe("ADDED");
    expect(changes[0]!.confidence.class).toBe("high");
  });

  it("only confidence differs triggers MODIFIED, not ADDED+REMOVED", () => {
    const before: Provenance[] = [tx("a.ts", "b.ts", "imports", 0.5)];
    const after: Provenance[] = [tx("a.ts", "b.ts", "imports", 1.0)];

    const changes = computeRelationshipChanges(before, after, EMPTY_LINEAGE);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.kind).toBe("MODIFIED");
  });

  it("same confidence and type produces no change", () => {
    const before: Provenance[] = [tx("a.ts", "b.ts", "calls", 0.7)];
    const after: Provenance[] = [tx("a.ts", "b.ts", "calls", 0.7)];

    const changes = computeRelationshipChanges(before, after, EMPTY_LINEAGE);
    expect(changes).toHaveLength(0);
  });
});
