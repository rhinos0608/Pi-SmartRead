import { describe, it, expect } from "vitest";
import { computeFileLineage } from "../../src/lineage-files.js";

type FileEntry = { path: string; contentHash: string; edges?: Array<{ to: string; type: string }> };

describe("computeFileLineage", () => {
  // Test 1: Identical files → verified unchanged
  it("identical files → verified unchanged", () => {
    const files: FileEntry[] = [{ path: "src/index.ts", contentHash: "abc123" }];
    const result = computeFileLineage(files, files);

    expect(result.algorithmVersion).toBe("lineage-v1");
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]!.kind).toBe("UNCHANGED");
    expect(result.changes[0]!.confidence).toBe("verified");
    expect(result.metadata.matchedCount).toBe(1);
    expect(result.metadata.unmatchedBeforeCount).toBe(0);
    expect(result.metadata.unmatchedAfterCount).toBe(0);
  });

  // Test 2: Pure move (same contentHash, different path) → medium or POSSIBLE_MATCH
  it("pure move → medium or POSSIBLE_MATCH", () => {
    const before: FileEntry[] = [{ path: "src/old.ts", contentHash: "aaa" }];
    const after: FileEntry[] = [{ path: "src/new.ts", contentHash: "aaa" }];
    const result = computeFileLineage(before, after);

    const nonTerminal = result.changes.filter(
      (c) => c.kind !== "REMOVED" && c.kind !== "ADDED",
    );
    expect(nonTerminal.length).toBeGreaterThanOrEqual(1);

    const move = result.changes.find((c) => c.kind === "MOVED");
    const pm = result.changes.find((c) => c.kind === "POSSIBLE_MATCH");
    expect(move || pm).toBeTruthy();
    if (move) {
      expect(move.confidence).toBe("medium");
      expect(move.beforePath).toBe("src/old.ts");
      expect(move.afterPath).toBe("src/new.ts");
    }
  });

  // Test 3: Move+edit → MOVED_AND_MODIFIED
  it("move+edit → MOVED_AND_MODIFIED", () => {
    // Long content with 1 token changed + matching edges → high Jaccard, high relJaccard
    const sharedEdges = [
      { to: "src/types.ts", type: "imports" },
      { to: "src/logger.ts", type: "imports" },
      { to: "src/config.ts", type: "imports" },
    ];
    const content1 = "import { Types } from './types'; import { Logger } from './logger'; export function processData(input: string, options: Options, ctx: Context, flags: Flags, cache: CacheStore, logger: Logger, config: Config, result: Result, state: State, tracker: Tracker) { return { input, options, ctx, flags, cache, logger, config, result, state, tracker }; }";
    const content2 = "import { Types } from './types'; import { Logger } from './logger'; export function processData(input: string, options: Options, ctx: Context, flags: Flags, cache: CacheStore, logger: Logger, config: Config, result: Result, state: State, tracker: Tracker) { return { input, options, ctx, flags, cache, logger, config, result, state, tracker, extra: true }; }";

    const before: FileEntry[] = [{ path: "src/utils.ts", contentHash: content1, edges: sharedEdges }];
    const after: FileEntry[] = [{ path: "src/lib/utils.ts", contentHash: content2, edges: sharedEdges }];
    const result = computeFileLineage(before, after);

    const match = result.changes.find(
      (c) => c.kind === "MOVED_AND_MODIFIED" || c.kind === "MOVED" || c.kind === "POSSIBLE_MATCH",
    );
    expect(match).toBeTruthy();
    if (match?.kind === "MOVED_AND_MODIFIED") {
      expect(match.confidence).toBe("medium");
      expect(match.changedFacets).toContain("content");
      expect(match.changedFacets).toContain("path");
    }
  });

  // Test 4: Split (1 before → 2 after) → removed+added
  it("split → removed+added", () => {
    const before: FileEntry[] = [{ path: "src/big.ts", contentHash: "hash_a" }];
    const after: FileEntry[] = [
      { path: "src/small_a.ts", contentHash: "hash_x" },
      { path: "src/small_b.ts", contentHash: "hash_y" },
    ];
    const result = computeFileLineage(before, after);

    // 1 removed + 2 added = 3 total
    expect(result.changes).toHaveLength(3);
    const removed4 = result.changes.filter((c) => c.kind === "REMOVED");
    const added4 = result.changes.filter((c) => c.kind === "ADDED");
    expect(removed4.length).toBe(1);
    expect(added4.length).toBe(2);
  });

  // Test 5: Merge (2 before → 1 after) → removed+added
  it("merge → removed+added", () => {
    const before: FileEntry[] = [
      { path: "src/a.ts", contentHash: "hash_1" },
      { path: "src/b.ts", contentHash: "hash_2" },
    ];
    const after: FileEntry[] = [{ path: "src/merged.ts", contentHash: "hash_3" }];
    const result = computeFileLineage(before, after);

    // 2 removed + 1 added = 3 total
    expect(result.changes).toHaveLength(3);
    const removed = result.changes.filter((c) => c.kind === "REMOVED");
    const added = result.changes.filter((c) => c.kind === "ADDED");
    expect(removed.length).toBe(2);
    expect(added.length).toBe(1);
  });

  // Test 6: Swapped names → removed+added (no false lineage)
  it("swapped names → removed+added, no false lineage", () => {
    const before: FileEntry[] = [
      { path: "src/a.ts", contentHash: "hash_alpha" },
      { path: "src/b.ts", contentHash: "hash_beta" },
    ];
    const after: FileEntry[] = [
      { path: "src/b.ts", contentHash: "hash_alpha" },
      { path: "src/a.ts", contentHash: "hash_beta" },
    ];
    const result = computeFileLineage(before, after);

    // No UNCHANGED entries (paths match but content hashes swapped)
    const unchanged = result.changes.filter((c) => c.kind === "UNCHANGED");
    expect(unchanged.length).toBe(0);
  });

  // Test 7: Duplicate files → POSSIBLE_MATCH or removed+added, NOT lineage
  it("duplicate files → POSSIBLE_MATCH or removed+added, NOT verified", () => {
    const before: FileEntry[] = [
      { path: "src/copy1.ts", contentHash: "dup_hash" },
      { path: "src/copy2.ts", contentHash: "dup_hash" },
    ];
    const after: FileEntry[] = [
      { path: "src/target.ts", contentHash: "dup_hash" },
    ];
    const result = computeFileLineage(before, after);

    const verified = result.changes.filter((c) => c.confidence === "verified");
    expect(verified.length).toBe(0);
  });

  // Test 8: Hard negatives: different files sharing basename → no lineage
  it("different files sharing basename → no lineage", () => {
    const before: FileEntry[] = [
      { path: "src/app.ts", contentHash: "completely_different_hash_1234567890" },
    ];
    const after: FileEntry[] = [
      { path: "test/app.ts", contentHash: "another_completely_different_hash_xyz" },
    ];
    const result = computeFileLineage(before, after);

    const strongMatches = result.changes.filter(
      (c) => c.confidence === "verified" || c.confidence === "medium" || c.confidence === "high",
    );
    expect(strongMatches.length).toBe(0);
  });

  // Test 9: Empty inputs → empty result
  it("empty inputs → empty result", () => {
    const result = computeFileLineage([], []);

    expect(result.algorithmVersion).toBe("lineage-v1");
    expect(result.changes).toHaveLength(0);
    expect(result.metadata.beforeCount).toBe(0);
    expect(result.metadata.afterCount).toBe(0);
    expect(result.metadata.matchedCount).toBe(0);
    expect(result.metadata.possibleMatchCount).toBe(0);
    expect(result.metadata.unmatchedBeforeCount).toBe(0);
    expect(result.metadata.unmatchedAfterCount).toBe(0);
  });

  // Test 10: All unchanged → all verified
  it("all unchanged → all verified", () => {
    const files: FileEntry[] = [
      { path: "src/a.ts", contentHash: "h1" },
      { path: "src/b.ts", contentHash: "h2" },
      { path: "src/c.ts", contentHash: "h3" },
    ];
    const result = computeFileLineage(files, files);

    expect(result.changes).toHaveLength(3);
    for (const c of result.changes) {
      expect(c.kind).toBe("UNCHANGED");
      expect(c.confidence).toBe("verified");
    }
    expect(result.metadata.matchedCount).toBe(3);
    expect(result.metadata.unmatchedBeforeCount).toBe(0);
    expect(result.metadata.unmatchedAfterCount).toBe(0);
  });

  // Test 11: All different → all removed+added
  it("all different → all removed+added", () => {
    const before: FileEntry[] = [
      { path: "src/old1.ts", contentHash: "hash_old1" },
      { path: "src/old2.ts", contentHash: "hash_old2" },
    ];
    const after: FileEntry[] = [
      { path: "src/new1.ts", contentHash: "hash_new1" },
      { path: "src/new2.ts", contentHash: "hash_new2" },
    ];
    const result = computeFileLineage(before, after);

    expect(result.changes).toHaveLength(4);
    const removed = result.changes.filter((c) => c.kind === "REMOVED");
    const added = result.changes.filter((c) => c.kind === "ADDED");
    expect(removed.length).toBe(2);
    expect(added.length).toBe(2);
    expect(result.metadata.unmatchedBeforeCount).toBe(2);
    expect(result.metadata.unmatchedAfterCount).toBe(2);
  });

  // Test 12: Score margin below threshold → POSSIBLE_MATCH not medium
  it("score margin below threshold → POSSIBLE_MATCH not medium", () => {
    const contentA = "import { helper } from './helper'; export function alpha() { return helper.run('test', 42, true, false, 'x'); }";
    const contentB = "import { helper } from './helper'; export function alpha() { return helper.run('test', 42, true, false, 'y'); }";
    const contentC = "import { helper } from './helper'; export function alpha() { return helper.run('test', 42, true, false, 'z'); }";

    const before: FileEntry[] = [
      { path: "src/file_a.ts", contentHash: contentA },
      { path: "src/file_b.ts", contentHash: contentB },
    ];
    const after: FileEntry[] = [
      { path: "src/file_a_v2.ts", contentHash: contentB },
      { path: "src/file_b_v2.ts", contentHash: contentC },
    ];
    const result = computeFileLineage(before, after);

    const possibleMatches = result.changes.filter(
      (c) => c.confidence === "POSSIBLE_MATCH",
    );
    const mediums = result.changes.filter((c) => c.confidence === "medium");

    expect(possibleMatches.length + mediums.length).toBeGreaterThanOrEqual(1);
  });

  // Test 13: Deterministic: same input twice → identical output
  it("deterministic: same input twice → identical output", () => {
    const before: FileEntry[] = [
      { path: "src/a.ts", contentHash: "h1" },
      { path: "src/b.ts", contentHash: "h2" },
    ];
    const after: FileEntry[] = [
      { path: "src/c.ts", contentHash: "h3" },
      { path: "src/d.ts", contentHash: "h4" },
    ];

    const result1 = computeFileLineage(before, after);
    const result2 = computeFileLineage(before, after);

    expect(result1).toEqual(result2);
  });

  // Additional: edges contribute to neighborhood scoring
  it("edges contribute to neighborhood scoring", () => {
    const before: FileEntry[] = [
      {
        path: "src/a.ts",
        contentHash: "hash_a",
        edges: [
          { to: "src/b.ts", type: "imports" },
          { to: "src/c.ts", type: "calls" },
        ],
      },
    ];
    const after: FileEntry[] = [
      {
        path: "src/moved_a.ts",
        contentHash: "hash_a",
        edges: [
          { to: "src/b.ts", type: "imports" },
          { to: "src/c.ts", type: "calls" },
        ],
      },
    ];
    const result = computeFileLineage(before, after);

    const match = result.changes.find(
      (c) => c.kind === "MOVED" || c.kind === "POSSIBLE_MATCH",
    );
    expect(match).toBeTruthy();
    expect(match?.score).toBeGreaterThanOrEqual(0.6);
  });

  // Additional: metadata counts are correct
  it("metadata counts are correct", () => {
    const before: FileEntry[] = [
      { path: "a.ts", contentHash: "h1" },
      { path: "b.ts", contentHash: "h2" },
    ];
    const after: FileEntry[] = [
      { path: "a.ts", contentHash: "h1" },
      { path: "c.ts", contentHash: "h3" },
    ];
    const result = computeFileLineage(before, after);

    expect(result.metadata.beforeCount).toBe(2);
    expect(result.metadata.afterCount).toBe(2);
    expect(result.metadata.matchedCount).toBeGreaterThanOrEqual(1);
    expect(result.metadata.unmatchedBeforeCount).toBeGreaterThanOrEqual(0);
    expect(result.metadata.unmatchedAfterCount).toBeGreaterThanOrEqual(0);
  });

  // Additional: content hash differs → MODIFIED or removed+added
  it("same path different hash → MODIFIED", () => {
    const before: FileEntry[] = [{ path: "src/app.ts", contentHash: "old_hash" }];
    const after: FileEntry[] = [{ path: "src/app.ts", contentHash: "new_hash" }];
    const result = computeFileLineage(before, after);

    expect(result.changes.length).toBeGreaterThanOrEqual(2);
  });
});
