import { describe, expect, it, beforeEach } from "vitest";
import {
  resetContextHygieneTracker,
  buildContextHygieneMetadata,
  buildFileResource,
  type ContextHygieneTracker,
} from "../../context-hygiene.js";

describe("recordMutation: stale-result auto-invalidation", () => {
  let tracker: ContextHygieneTracker;

  beforeEach(() => {
    tracker = resetContextHygieneTracker({ maxEvents: 100 });
  });

  it("records a mutation event and produces stale candidates from prior reads", () => {
    // Step 1: Agent reads a file — classify as read-context
    const readMeta = buildContextHygieneMetadata({
      tool: "read",
      classification: "read-context",
      resources: [buildFileResource("/project/src/utils.ts")],
      rehydrate: { tool: "read", input: { path: "/project/src/utils.ts" } },
    });
    const readEvent = tracker.record(readMeta, { resultId: "read-call-1" });
    expect(readEvent.id).toBe(1);

    // Step 2: Agent mutates the file via graph_mutate — recordMutation
    const mutationResources = [buildFileResource("/project/src/utils.ts")];
    const mutationEvent = tracker.recordMutation(mutationResources, {
      resultId: "graph_mutate-call-2",
    });
    expect(mutationEvent.id).toBe(2);
    expect(mutationEvent.classification).toBe("mutation");
    expect(mutationEvent.tool).toBe("graph_mutate");

    // Step 3: generateReport should surface the stale candidate
    const report = tracker.generateReport();

    const mar = report.mutationAfterRead;
    expect(mar.length).toBeGreaterThanOrEqual(1);
    const entry = mar.find((e) => e.resourceKey === "file:/project/src/utils.ts")!;
    expect(entry.readEventIds).toContain(1);
    expect(entry.mutationEventId).toBe(2);

    const candidates = report.staleCandidates;
    expect(candidates.length).toBeGreaterThanOrEqual(1);
    const stale = candidates.find((c) => c.resourceKey === "file:/project/src/utils.ts")!;
    expect(stale.staleEventIds).toEqual([1]);
    expect(stale.mutationEventId).toBe(2);
    expect(stale.reason).toBe("mutation-after-read");
    expect(stale.staleResults.length).toBe(1);
    expect(stale.staleResults[0]!.originalTool).toBe("read");
    expect(stale.staleResults[0]!.originalResultId).toBe("read-call-1");
    expect(stale.staleResults[0]!.invalidatingMutationResultId).toBe("graph_mutate-call-2");
    expect(stale.staleResults[0]!.rehydrate).toEqual({ tool: "read", input: { path: "/project/src/utils.ts" } });
  });

  it("deduplicates mutation resources within a single recordMutation call", () => {
    const readMeta = buildContextHygieneMetadata({
      tool: "read",
      classification: "read-context",
      resources: [buildFileResource("/project/src/utils.ts")],
    });
    tracker.record(readMeta, { resultId: "read-1" });

    // Two edges touching the same file in a single call — should produce ONE stale candidate
    const mutationResources = [
      buildFileResource("/project/src/utils.ts"),
      buildFileResource("/project/src/utils.ts"),
    ];
    tracker.recordMutation(mutationResources, { resultId: "graph-mutate-2" });

    const report = tracker.generateReport();
    const candidates = report.staleCandidates;
    // Within a single call, resources are deduplicated → one mutation event
    expect(candidates.length).toBe(1);
  });

  it("records resultId on mutation events", () => {
    // Must read the file first so mutationAfterRead has an entry
    tracker.record(
      buildContextHygieneMetadata({
        tool: "read",
        classification: "read-context",
        resources: [buildFileResource("/project/src/lib.ts")],
      }),
      { resultId: "read-lib" },
    );

    const mutationResources = [buildFileResource("/project/src/lib.ts")];
    const mutationEvent = tracker.recordMutation(mutationResources, {
      resultId: "graph_mutate-call-42",
    });

    const report = tracker.generateReport();
    const entry = report.mutationAfterRead[0];
    expect(entry).toBeDefined();
    expect(entry!.mutationEventId).toBe(mutationEvent.id);

    const stale = report.staleCandidates[0]!;
    expect(stale.staleResults[0]!.invalidatingMutationResultId).toBe("graph_mutate-call-42");
  });

  it("only marks reads that occurred before the mutation as stale", () => {
    // Read before mutation
    tracker.record(
      buildContextHygieneMetadata({
        tool: "read",
        classification: "read-context",
        resources: [buildFileResource("/project/src/foo.ts")],
      }),
      { resultId: "read-before" },
    );

    // Mutation
    tracker.recordMutation([buildFileResource("/project/src/foo.ts")], { resultId: "mutation" });

    // Read after mutation
    tracker.record(
      buildContextHygieneMetadata({
        tool: "read",
        classification: "read-context",
        resources: [buildFileResource("/project/src/foo.ts")],
      }),
      { resultId: "read-after" },
    );

    const report = tracker.generateReport();

    // Only the first read should be marked stale
    const candidates = report.staleCandidates;
    expect(candidates.length).toBe(1);
    expect(candidates[0]!.staleEventIds).toHaveLength(1);
    expect(candidates[0]!.staleEventIds[0]).toBe(1); // event id 1
  });

  it("handles mutation on a file that was never read (no stale candidates)", () => {
    // Mutation without any prior read
    tracker.recordMutation([buildFileResource("/project/src/never-read.ts")], { resultId: "mutation" });

    const report = tracker.generateReport();
    expect(report.mutationAfterRead).toHaveLength(0);
    expect(report.staleCandidates).toHaveLength(0);
  });

  it("handles empty mutation resources gracefully", () => {
    // Record mutation with empty array — should not throw
    const mutationEvent = tracker.recordMutation([], { resultId: "empty-mutation" });
    expect(mutationEvent.id).toBe(1);
    expect(mutationEvent.resources).toHaveLength(0);
    expect(mutationEvent.classification).toBe("mutation");

    const report = tracker.generateReport();
    expect(report.mutationAfterRead).toHaveLength(0);
    expect(report.staleCandidates).toHaveLength(0);
  });

  it("records co-change edges from graph_mutate", () => {
    // Read two files
    tracker.record(
      buildContextHygieneMetadata({
        tool: "read",
        classification: "read-context",
        resources: [buildFileResource("/project/src/a.ts")],
      }),
      { resultId: "read-a" },
    );
    tracker.record(
      buildContextHygieneMetadata({
        tool: "read",
        classification: "read-context",
        resources: [buildFileResource("/project/src/b.ts")],
      }),
      { resultId: "read-b" },
    );

    // graph_mutate records a co-change between a.ts and b.ts
    tracker.recordMutation(
      [
        buildFileResource("/project/src/a.ts"),
        buildFileResource("/project/src/b.ts"),
      ],
      {
        resultId: "graph-mutate-cochange",
      },
    );

    const report = tracker.generateReport();

    // Both a.ts and b.ts should have stale candidates
    const staleKeys = report.staleCandidates.map((c) => c.resourceKey).sort();
    expect(staleKeys).toEqual(["file:/project/src/a.ts", "file:/project/src/b.ts"]);
  });

  it("records both breakage from and to paths as mutations", () => {
    // Read the 'to' file (the one that broke)
    tracker.record(
      buildContextHygieneMetadata({
        tool: "read",
        classification: "read-context",
        resources: [buildFileResource("/project/src/broken.ts")],
      }),
      { resultId: "read-broken" },
    );

    // graph_mutate reports: editing foo.ts broke broken.ts
    tracker.recordMutation(
      [
        buildFileResource("/project/src/foo.ts"),  // the editor (from)
        buildFileResource("/project/src/broken.ts"), // the broke file (to)
      ],
      { resultId: "breakage-edge" },
    );

    const report = tracker.generateReport();

    // Only the read of broken.ts should be stale (not foo.ts, which was never read)
    const candidates = report.staleCandidates;
    expect(candidates.length).toBe(1);
    expect(candidates[0]!.resourceKey).toBe("file:/project/src/broken.ts");
  });

  it("non-blocking: recordMutation returns no-op event on unresolvable error", () => {
    // Use an object with a getter that throws during spread
    const badResources = [
      { get key() { throw new Error("boom"); }, path: "/project/src/test.ts" } as any,
    ];
    const event = tracker.recordMutation(badResources, { resultId: "gm-err" });
    expect(event.id).toBe(-1);
    expect(event.classification).toBe("mutation");
    expect(event.resources).toHaveLength(0);
  });

  it("multiple mutations to same file produce one stale candidate per mutation event", () => {
    tracker.record(
      buildContextHygieneMetadata({
        tool: "read",
        classification: "read-context",
        resources: [buildFileResource("/project/src/shared.ts")],
      }),
      { resultId: "read-1" },
    );

    tracker.recordMutation([buildFileResource("/project/src/shared.ts")], { resultId: "mut-1" });
    tracker.recordMutation([buildFileResource("/project/src/shared.ts")], { resultId: "mut-2" });

    const report = tracker.generateReport();
    // Two mutation events → two stale candidate entries in the report (one per mutation event)
    const candidates = report.staleCandidates;
    expect(candidates.length).toBe(2);
    // Both reference the same read, but different mutation events
    expect(candidates[0]!.staleEventIds).toEqual([1]);
    expect(candidates[1]!.staleEventIds).toEqual([1]);
    // context-application.ts dedupes by originalResultId, keeping the later mutation
    const mutEventIds = candidates.map((c) => c.mutationEventId).sort();
    expect(mutEventIds).toEqual([2, 3]);
  });
});