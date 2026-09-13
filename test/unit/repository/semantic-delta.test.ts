import { describe, expect, it } from "vitest";
import { computeSemanticDelta } from "../../src/semantic-delta.js";

// ── Helpers ───────────────────────────────────────────────────────

function file(path: string, hash: string, edges?: Array<{ to: string; type: string }>) {
  return { path, contentHash: hash, edges };
}

// ── Tests ─────────────────────────────────────────────────────────

describe("computeSemanticDelta", () => {
  it("empty inputs → empty delta, complete assessment", () => {
    const delta = computeSemanticDelta([], []);

    expect(delta.fileChanges).toHaveLength(0);
    expect(delta.symbolChanges).toHaveLength(0);
    expect(delta.relationshipChanges).toHaveLength(0);
    expect(delta.diagnosticChanges).toHaveLength(0);
    expect(delta.assessment).toBe("complete");
    expect(delta.algorithmVersion).toBe("lineage-v1");
    expect(delta.truncated).toBe(false);
  });

  it("files added → correct fileChanges with ADDED kind", () => {
    const after = [file("new.ts", "hash-new")];
    const delta = computeSemanticDelta([], after);

    expect(delta.fileChanges).toHaveLength(1);
    expect(delta.fileChanges[0]!.kind).toBe("ADDED");
    expect(delta.fileChanges[0]!.afterPath).toBe("new.ts");
    expect(delta.fileChanges[0]!.confidence).toBe("added");
    expect(delta.assessment).toBe("complete");
  });

  it("files moved → correct MOVED kind with lineageId", () => {
    // Same hash + same edges → score >= medium threshold → MOVED
    const edges = [{ to: "a.ts", type: "imports" as const }];
    const before = [file("old.ts", "hash-1", edges)];
    const after = [file("new.ts", "hash-1", edges)];
    const delta = computeSemanticDelta(before, after);

    const movedChange = delta.fileChanges.find(
      (c) => c.kind === "MOVED",
    );
    expect(movedChange).toBeDefined();
    expect(movedChange!.beforePath).toBe("old.ts");
    expect(movedChange!.afterPath).toBe("new.ts");
    expect(movedChange!.lineageId).toBeDefined();
    expect(movedChange!.confidence).toBe("medium");
  });

  it("files modified → correct MODIFIED kind", () => {
    // Same path + high-overlap hashes + edges → MODIFIED
    const edges = [{ to: "a.ts", type: "imports" as const }, { to: "b.ts", type: "imports" as const }];
    const h1 = "aaa-bbb-ccc-ddd-eee-fff-ggg-hhh-iii";
    const h2 = "aaa-bbb-ccc-ddd-eee-fff-ggg-hhh-jjj";
    const before = [file("src/index.ts", h1, edges)];
    const after = [file("src/index.ts", h2, edges)];
    const delta = computeSemanticDelta(before, after);

    const modChange = delta.fileChanges.find(
      (c) => c.kind === "MODIFIED",
    );
    expect(modChange).toBeDefined();
    expect(modChange!.beforePath).toBe("src/index.ts");
    expect(modChange!.afterPath).toBe("src/index.ts");
    expect(modChange!.changedFacets).toContain("content");
  });

  it("end-to-end: mixed file changes produce expected delta structure", () => {
    const before = [
      file("src/a.ts", "hash-a"),
      file("src/b.ts", "hash-b"),
    ];
    const after = [
      file("src/a.ts", "hash-a"), // unchanged
      file("src/c.ts", "hash-c"), // added
    ];

    const delta = computeSemanticDelta(before, after);

    expect(delta.algorithmVersion).toBe("lineage-v1");
    expect(delta.before).toBe("");
    expect(delta.after).toBe("");
    expect(delta.truncated).toBe(false);

    expect(delta.fileChanges.length).toBeGreaterThanOrEqual(2);
    const kinds = delta.fileChanges.map((c) => c.kind);
    expect(kinds).toContain("ADDED");

    expect(Array.isArray(delta.relationshipChanges)).toBe(true);
    expect(Array.isArray(delta.diagnosticChanges)).toBe(true);
    expect(delta.capabilityChange).toBeDefined();
    expect(delta.capabilityChange.changedKeys).toBeDefined();
  });

  it("snapshot IDs propagated", () => {
    const delta = computeSemanticDelta([], [], {
      beforeSnapshotId: "snap-before-1",
      afterSnapshotId: "snap-after-2",
    });

    expect(delta.before).toBe("snap-before-1");
    expect(delta.after).toBe("snap-after-2");
  });

  it("assessment propagation: partial when no medium+ file matches", () => {
    // Files exist but none match at medium+ → partial
    const before = [file("x.ts", "hash-x")];
    const after = [file("y.ts", "hash-y")];
    const delta = computeSemanticDelta(before, after);

    expect(delta.assessment).toBe("partial");
    expect(delta.coverageReasons).toContain("no-medium-confidence-file-matches");
  });

  it("assessment: complete when file matches are medium+", () => {
    const before = [file("src/a.ts", "hash-a")];
    const after = [file("src/a.ts", "hash-a")];
    const delta = computeSemanticDelta(before, after);

    expect(delta.assessment).toBe("complete");
    expect(delta.coverageReasons).toHaveLength(0);
  });

  it("relationship and diagnostic arrays included", () => {
    const delta = computeSemanticDelta([], [], {
      beforeEdges: [],
      afterEdges: [],
      beforeDiags: [],
      afterDiags: [],
    });

    expect(delta.relationshipChanges).toEqual([]);
    expect(delta.diagnosticChanges).toEqual([]);
  });

  it("options defaults to empty collections", () => {
    const delta = computeSemanticDelta([], []);

    expect(delta.symbolChanges).toHaveLength(0);
    expect(delta.relationshipChanges).toHaveLength(0);
    expect(delta.diagnosticChanges).toHaveLength(0);
    expect(delta.capabilityChange.changedKeys).toEqual([]);
  });
});
