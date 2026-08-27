import { describe, expect, it } from "vitest";
import {
  renderWorkspaceView,
  type ChannelCandidate,
} from "../../src/workspace-view.js";

function c(overrides: Partial<ChannelCandidate> = {}): ChannelCandidate {
  return {
    file: "src/foo.ts",
    line: 123,
    name: "handleClick",
    kind: "function",
    snippet: "handleClick(event) { return event; }",
    rawScore: 1,
    ...overrides,
  };
}

function unlimited() {
  return { maxBytes: 1_000_000, maxLines: 100_000 };
}

describe("renderWorkspaceView", () => {
  it("returns empty view for empty candidates", () => {
    const v = renderWorkspaceView({
      rankedCandidates: [],
      format: "OUTLINE",
      hardBudget: unlimited(),
    });
    expect(v.entities).toEqual([]);
    expect(v.truncated).toBe(false);
    expect(v.omittedEntityCount).toBe(0);
    expect(v.byteLength).toBe(0);
  });

  it("renders single entity in OUTLINE format", () => {
    const v = renderWorkspaceView({
      rankedCandidates: [c()],
      format: "OUTLINE",
      hardBudget: unlimited(),
    });
    expect(v.entities).toHaveLength(1);
    expect(v.entities[0]!.renderedText).toBe(
      "src/foo.ts:123 handleClick (function)"
    );
    expect(v.truncated).toBe(false);
    expect(v.omittedEntityCount).toBe(0);
  });

  it("renders single entity in EVIDENCE format", () => {
    const v = renderWorkspaceView({
      rankedCandidates: [c({ line: 5 })],
      format: "EVIDENCE",
      hardBudget: unlimited(),
    });
    expect(v.entities[0]!.renderedText).toBe(
      "src/foo.ts:5 handleClick handleClick(event) { return event; }"
    );
  });

  it("renders single entity in DIFF format (same as EVIDENCE)", () => {
    const v = renderWorkspaceView({
      rankedCandidates: [c({ line: 5 })],
      format: "DIFF",
      hardBudget: unlimited(),
    });
    expect(v.entities[0]!.renderedText).toBe(
      "src/foo.ts:5 handleClick handleClick(event) { return event; }"
    );
  });

  it("handles candidate with no line number", () => {
    const v = renderWorkspaceView({
      rankedCandidates: [c({ line: undefined })],
      format: "OUTLINE",
      hardBudget: unlimited(),
    });
    expect(v.entities[0]!.renderedText).toBe("src/foo.ts handleClick (function)");
  });

  it("stops adding entities when maxBytes budget hit", () => {
    const candidates = [
      c({ file: "a.ts", name: "a" }),
      c({ file: "b.ts", name: "b" }),
      c({ file: "c.ts", name: "c" }),
    ];
    // renderEntity for OUTLINE "a.ts:123 a (function)" = ~20 bytes each
    // Set budget to fit 2 but not 3
    const first2Bytes = byteLen("a.ts:123 a (function)") + byteLen("b.ts:123 b (function)");
    const v = renderWorkspaceView({
      rankedCandidates: candidates,
      format: "OUTLINE",
      hardBudget: { maxBytes: first2Bytes, maxLines: 1000 },
    });
    expect(v.entities).toHaveLength(2);
    expect(v.truncated).toBe(true);
    expect(v.omittedEntityCount).toBe(1);
  });

  it("stops adding entities when maxLines budget hit", () => {
    const candidates = [
      c({ file: "a.ts", snippet: "line1\nline2\nline3" }),
      c({ file: "b.ts", snippet: "line1" }),
    ];
    // EVIDENCE format: "a.ts:123 handleClick line1\nline2\nline3" = 3 lines (2 newlines)
    // "b.ts:123 handleClick line1" = 1 line
    const v = renderWorkspaceView({
      rankedCandidates: candidates,
      format: "EVIDENCE",
      hardBudget: { maxBytes: 1_000_000, maxLines: 3 },
    });
    // First entity uses 3 lines, fits exactly. Second would make 4.
    expect(v.entities).toHaveLength(1);
    expect(v.truncated).toBe(true);
    expect(v.omittedEntityCount).toBe(1);
  });

  it("byteLength matches actual UTF-8 byte count", () => {
    const candidates = [
      c({ file: "a.ts", name: "alpha" }),
      c({ file: "b.ts", name: "beta" }),
    ];
    const v = renderWorkspaceView({
      rankedCandidates: candidates,
      format: "OUTLINE",
      hardBudget: unlimited(),
    });
    const expected = v.entities.reduce(
      (sum, e) => sum + new TextEncoder().encode(e.renderedText).byteLength,
      0
    );
    expect(v.byteLength).toBe(expected);
  });

  it("zero maxBytes rejects all non-empty entities", () => {
    const v = renderWorkspaceView({
      rankedCandidates: [c()],
      format: "OUTLINE",
      hardBudget: { maxBytes: 0, maxLines: 1000 },
    });
    expect(v.entities).toHaveLength(0);
    expect(v.truncated).toBe(true);
    expect(v.omittedEntityCount).toBe(1);
  });

  it("zero maxLines rejects all non-empty entities", () => {
    const v = renderWorkspaceView({
      rankedCandidates: [c()],
      format: "OUTLINE",
      hardBudget: { maxBytes: 1_000_000, maxLines: 0 },
    });
    expect(v.entities).toHaveLength(0);
    expect(v.truncated).toBe(true);
    expect(v.omittedEntityCount).toBe(1);
  });

  it("zero budget with empty candidates returns empty not truncated", () => {
    const v = renderWorkspaceView({
      rankedCandidates: [],
      format: "OUTLINE",
      hardBudget: { maxBytes: 0, maxLines: 0 },
    });
    expect(v.entities).toHaveLength(0);
    expect(v.truncated).toBe(false);
    expect(v.omittedEntityCount).toBe(0);
  });

  it("sets startLine and endLine from candidate", () => {
    const v = renderWorkspaceView({
      rankedCandidates: [c({ line: 10, endLine: 20 })],
      format: "OUTLINE",
      hardBudget: unlimited(),
    });
    expect(v.entities[0]!.startLine).toBe(10);
    expect(v.entities[0]!.endLine).toBe(20);
  });

  it("uses file as path in entity", () => {
    const v = renderWorkspaceView({
      rankedCandidates: [c({ file: "lib/bar.ts" })],
      format: "OUTLINE",
      hardBudget: unlimited(),
    });
    expect(v.entities[0]!.path).toBe("lib/bar.ts");
  });

  it("generates deterministic entityId", () => {
    const v = renderWorkspaceView({
      rankedCandidates: [c({ file: "x.ts", line: 7, name: "fn" })],
      format: "OUTLINE",
      hardBudget: unlimited(),
    });
    expect(v.entities[0]!.entityId).toBe("x.ts:7:fn");
  });
});

// helper for tests
function byteLen(s: string): number {
  return new TextEncoder().encode(s).byteLength;
}
