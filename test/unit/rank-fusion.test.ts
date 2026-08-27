import { describe, it, expect } from "vitest";
import { fuseChannels } from "../../src/rank-fusion.js";
import type { ChannelResult, ChannelCandidate } from "../../src/rank-fusion.js";
import { RRF_K } from "../../src/deep-search-constants.js";

function mkCandidate(overrides: Partial<ChannelCandidate> & { name: string; file: string }): ChannelCandidate {
  return { kind: "function", snippet: "", rawScore: 0, ...overrides };
}

function mkChannel(channel: string, candidates: ChannelCandidate[], unavailable?: { reason: string }): ChannelResult {
  return { channel, candidates, unavailable };
}

describe("fuseChannels", () => {
  it("single channel passthrough: scores match RRF formula", () => {
    const results = [mkChannel("semantic", [mkCandidate({ name: "foo", file: "a.ts" }), mkCandidate({ name: "bar", file: "b.ts" })])];
    const fused = fuseChannels(results);
    expect(fused.channel).toBe("fused");
    expect(fused.candidates).toHaveLength(2);
    expect(fused.candidates[0]!.name).toBe("foo");
    expect(fused.candidates[0]!.rawScore).toBeCloseTo(1 / (RRF_K + 1), 10);
    expect(fused.candidates[1]!.name).toBe("bar");
    expect(fused.candidates[1]!.rawScore).toBeCloseTo(1 / (RRF_K + 2), 10);
  });

  it("multi-channel boost: candidate in two channels gets higher score", () => {
    const results = [
      mkChannel("semantic", [mkCandidate({ name: "foo", file: "a.ts" }), mkCandidate({ name: "bar", file: "b.ts" })]),
      mkChannel("ast", [mkCandidate({ name: "foo", file: "a.ts" }), mkCandidate({ name: "baz", file: "c.ts" })]),
    ];
    const fused = fuseChannels(results);
    const fooExpected = 1 / (RRF_K + 1) + 1 / (RRF_K + 1);
    expect(fused.candidates[0]!.name).toBe("foo");
    expect(fused.candidates[0]!.rawScore).toBeCloseTo(fooExpected, 10);
    expect(fused.candidates[0]!.metadata?.rrfOrigins).toEqual([
      { channel: "semantic", rank: 1 },
      { channel: "ast", rank: 1 },
    ]);
    const remaining = fused.candidates.slice(1).map((c) => c.name);
    expect(remaining).toContain("bar");
    expect(remaining).toContain("baz");
  });

  it("correct RRF math: hand-computed two-channel case", () => {
    const results = [
      mkChannel("semantic", [mkCandidate({ name: "A", file: "a.ts" }), mkCandidate({ name: "B", file: "b.ts" })]),
      mkChannel("ast", [mkCandidate({ name: "B", file: "b.ts" }), mkCandidate({ name: "C", file: "c.ts" })]),
    ];
    const fused = fuseChannels(results);
    const scoreB = 1 / (RRF_K + 2) + 1 / (RRF_K + 1);
    const scoreA = 1 / (RRF_K + 1);
    const scoreC = 1 / (RRF_K + 2);
    expect(fused.candidates[0]!.name).toBe("B");
    expect(fused.candidates[0]!.rawScore).toBeCloseTo(scoreB, 10);
    expect(fused.candidates[1]!.name).toBe("A");
    expect(fused.candidates[1]!.rawScore).toBeCloseTo(scoreA, 10);
    expect(fused.candidates[2]!.name).toBe("C");
    expect(fused.candidates[2]!.rawScore).toBeCloseTo(scoreC, 10);
  });

  it("unavailable channels are skipped", () => {
    const results = [
      mkChannel("semantic", [mkCandidate({ name: "foo", file: "a.ts" })]),
      mkChannel("ast", [mkCandidate({ name: "bar", file: "b.ts" })], { reason: "LSP not running" }),
    ];
    const fused = fuseChannels(results);
    expect(fused.candidates).toHaveLength(1);
    expect(fused.candidates[0]!.name).toBe("foo");
  });

  it("weight override works", () => {
    const results = [
      mkChannel("semantic", [mkCandidate({ name: "foo", file: "a.ts" })]),
      mkChannel("ast", [mkCandidate({ name: "foo", file: "a.ts" })]),
    ];
    const defaultFused = fuseChannels(results);
    expect(defaultFused.candidates[0]!.rawScore).toBeCloseTo(2 / (RRF_K + 1), 10);

    const weightedFused = fuseChannels(results, { weights: { semantic: 3, ast: 1 } });
    expect(weightedFused.candidates[0]!.rawScore).toBeCloseTo(4 / (RRF_K + 1), 10);
  });

  it("2000 cap enforced", () => {
    const candidates = Array.from({ length: 2005 }, (_, i) => mkCandidate({ name: `fn${i}`, file: `f${i}.ts` }));
    const fused = fuseChannels([mkChannel("semantic", candidates)]);
    expect(fused.candidates).toHaveLength(2000);
  });

  it("deterministic: same input produces same output", () => {
    const results = [
      mkChannel("semantic", [mkCandidate({ name: "alpha", file: "z.ts" }), mkCandidate({ name: "beta", file: "a.ts" })]),
      mkChannel("ast", [mkCandidate({ name: "beta", file: "a.ts" })]),
    ];
    const run1 = fuseChannels(results);
    const run2 = fuseChannels(results);
    expect(run1.candidates).toEqual(run2.candidates);
  });

  it("empty input returns empty fused channel", () => {
    const fused = fuseChannels([]);
    expect(fused.channel).toBe("fused");
    expect(fused.candidates).toEqual([]);
  });

  it("preserves candidate metadata beyond rrfOrigins", () => {
    const results = [mkChannel("semantic", [mkCandidate({ name: "foo", file: "a.ts", metadata: { extra: "val" } })])];
    const fused = fuseChannels(results);
    expect(fused.candidates[0]!.metadata).toEqual({
      extra: "val",
      rrfOrigins: [{ channel: "semantic", rank: 1 }],
    });
  });
});
