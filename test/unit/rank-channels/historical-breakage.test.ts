import { describe, expect, it, vi } from "vitest";
import { runHistoricalBreakageChannel } from "../../../src/rank-channels/historical-breakage.js";

// Mock EdgeStore.readEdges to avoid filesystem access
vi.mock("../../../src/context-graph.js", () => ({
  EdgeStore: {
    readEdges: vi.fn(() => []),
  },
}));

import { EdgeStore } from "../../../src/context-graph.js";
const mockReadEdges = vi.mocked(EdgeStore.readEdges);

function makeBreakageEvent(
  from: string,
  to: string,
  timestamp: number,
  confidence?: number,
) {
  return {
    type: "breakage" as const,
    data: { from, to, context: `broke ${to}`, confidence, source: "diagnostics" as const },
    timestamp,
  };
}

function makeCoChangeEvent(from: string, to: string, timestamp: number) {
  return {
    type: "co_change" as const,
    data: { from, to, context: `co-changed`, confidence: 0.7, source: "git_history" as const },
    timestamp,
  };
}

describe("historical-breakage channel", () => {
  it("returns unavailable when no breakage events exist", () => {
    mockReadEdges.mockReturnValue([]);
    const result = runHistoricalBreakageChannel("/fake/root");
    expect(result.channel).toBe("historical-breakage");
    expect(result.unavailable).toBeDefined();
    expect(result.unavailable!.reason).toBe("no breakage events in EdgeStore");
    expect(result.candidates).toHaveLength(0);
  });

  it("returns unavailable when only co-change events exist (no breakage)", () => {
    mockReadEdges.mockReturnValue([
      makeCoChangeEvent("a.ts", "b.ts", Date.now() - 1000),
    ]);
    const result = runHistoricalBreakageChannel("/fake/root");
    expect(result.unavailable).toBeDefined();
    expect(result.unavailable!.reason).toBe("no breakage events in EdgeStore");
    expect(result.candidates).toHaveLength(0);
  });

  it("ranks files by weighted breakage score (frequency × recency)", () => {
    const now = Date.now();
    mockReadEdges.mockReturnValue([
      // recent.ts: 3 breakages, all recent
      makeBreakageEvent("x.ts", "recent.ts", now - 1000 * 60),
      makeBreakageEvent("y.ts", "recent.ts", now - 1000 * 60 * 60),
      makeBreakageEvent("z.ts", "recent.ts", now - 1000 * 60 * 60 * 2),
      // old.ts: 1 breakage, very old (30 days)
      makeBreakageEvent("x.ts", "old.ts", now - 30 * 24 * 60 * 60 * 1000),
    ]);

    const result = runHistoricalBreakageChannel("/fake/root");
    expect(result.channel).toBe("historical-breakage");
    expect(result.unavailable).toBeUndefined();
    expect(result.candidates).toHaveLength(2);

    // recent.ts should rank higher due to both frequency and recency
    expect(result.candidates[0]!.file).toBe("recent.ts");
    expect(result.candidates[0]!.rawScore).toBeGreaterThan(
      result.candidates[1]!.rawScore,
    );
    // old.ts should have a lower score
    expect(result.candidates[1]!.file).toBe("old.ts");
  });

  it("reports severity in kind field and count in snippet", () => {
    const now = Date.now();
    mockReadEdges.mockReturnValue([
      makeBreakageEvent("a.ts", "target.ts", now - 1000),
      makeBreakageEvent("b.ts", "target.ts", now - 2000),
    ]);

    const result = runHistoricalBreakageChannel("/fake/root");
    expect(result.candidates[0]!.kind).toBe("breakage");
    expect(result.candidates[0]!.snippet).toContain("2 breakage events");
  });

  it("includes metadata about total breakage events", () => {
    const now = Date.now();
    mockReadEdges.mockReturnValue([
      makeBreakageEvent("a.ts", "b.ts", now),
      makeBreakageEvent("c.ts", "d.ts", now),
    ]);

    const result = runHistoricalBreakageChannel("/fake/root");
    expect(result.metadata).toEqual({
      totalBreakageEvents: 2,
      matchedFiles: 2,
      maxCandidates: 500,
    });
  });

  it("bounds results to maxCandidates", () => {
    const now = Date.now();
    const events = Array.from({ length: 600 }, (_, i) =>
      makeBreakageEvent(`src.ts`, `file-${i}.ts`, now - i * 1000),
    );
    mockReadEdges.mockReturnValue(events);

    const result = runHistoricalBreakageChannel("/fake/root");
    expect(result.candidates).toHaveLength(500);
  });

  it("respects custom maxCandidates parameter", () => {
    const now = Date.now();
    const events = Array.from({ length: 10 }, (_, i) =>
      makeBreakageEvent("x.ts", `file-${i}.ts`, now - i * 1000),
    );
    mockReadEdges.mockReturnValue(events);

    const result = runHistoricalBreakageChannel("/fake/root", 5);
    expect(result.candidates).toHaveLength(5);
  });

  it("gives higher scores to more recent breakages", () => {
    const now = Date.now();
    mockReadEdges.mockReturnValue([
      // single event, recent
      makeBreakageEvent("a.ts", "recent.ts", now - 1000),
      // single event, old
      makeBreakageEvent("a.ts", "old.ts", now - 14 * 24 * 60 * 60 * 1000),
    ]);

    const result = runHistoricalBreakageChannel("/fake/root");
    expect(result.candidates[0]!.file).toBe("recent.ts");
    expect(result.candidates[0]!.rawScore).toBeGreaterThan(
      result.candidates[1]!.rawScore,
    );
  });

  it("uses confidence from event when present", () => {
    const now = Date.now();
    mockReadEdges.mockReturnValue([
      makeBreakageEvent("a.ts", "low.ts", now - 1000, 0.3),
      makeBreakageEvent("b.ts", "high.ts", now - 1000, 1.0),
    ]);

    const result = runHistoricalBreakageChannel("/fake/root");
    expect(result.candidates[0]!.file).toBe("high.ts");
    expect(result.candidates[0]!.rawScore).toBeGreaterThan(
      result.candidates[1]!.rawScore,
    );
  });
});
