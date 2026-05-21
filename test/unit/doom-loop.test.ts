/**
 * Tests for doom-loop.ts — safety feature that detects when the LLM
 * repeats identical tool calls or gets stuck in alternating call sequences.
 */
import { describe, expect, it, beforeEach } from "vitest";
import {
  createDoomLoopState,
  makeToolFingerprint,
  recordToolCall,
  consumeDoomLoopWarning,
  formatDoomLoopMessage,
  type DoomLoopState,
} from "../../doom-loop.js";

describe("makeToolFingerprint", () => {
  it("produces a string fingerprint from tool name and input", () => {
    const fp = makeToolFingerprint("read", { path: "/project/src/foo.ts" });
    expect(typeof fp).toBe("string");
    expect(fp).toContain("read:");
  });

  it("produces stable fingerprints for the same input", () => {
    const input = { path: "/project/src/foo.ts", limit: 100 };
    const fp1 = makeToolFingerprint("read", input);
    const fp2 = makeToolFingerprint("read", input);
    expect(fp1).toBe(fp2);
  });

  it("different inputs produce different fingerprints", () => {
    const fp1 = makeToolFingerprint("read", { path: "/project/src/a.ts" });
    const fp2 = makeToolFingerprint("read", { path: "/project/src/b.ts" });
    expect(fp1).not.toBe(fp2);
  });

  it("handles nested object inputs", () => {
    const fp = makeToolFingerprint("search", {
      query: "foo",
      options: { ignoreCase: true, mode: "deep" },
    });
    expect(fp).toContain("search:");
  });

  it("handles array inputs", () => {
    const fp = makeToolFingerprint("read", { paths: ["/a.ts", "/b.ts"] });
    expect(fp).toContain("read:");
  });
});

describe("createDoomLoopState", () => {
  it("returns empty recentCalls and pendingWarnings", () => {
    const state = createDoomLoopState();
    expect(state.recentCalls).toHaveLength(0);
    expect(state.pendingWarnings.size).toBe(0);
  });

  it("produces independent state objects", () => {
    const state1 = createDoomLoopState();
    const state2 = createDoomLoopState();
    expect(state1).not.toBe(state2);
    expect(state1.recentCalls).not.toBe(state2.recentCalls);
  });
});

describe("recordToolCall", () => {
  let state: DoomLoopState;

  beforeEach(() => {
    state = createDoomLoopState();
  });

  it("records a call and appends to recentCalls", () => {
    recordToolCall(state, "read", "call-1", { path: "/project/src/foo.ts" });
    expect(state.recentCalls).toHaveLength(1);
    expect(state.recentCalls[0]!.toolName).toBe("read");
    expect(state.recentCalls[0]!.toolCallId).toBe("call-1");
  });

  it("computes and stores fingerprint", () => {
    recordToolCall(state, "read", "call-1", { path: "/project/src/foo.ts" });
    expect(state.recentCalls[0]!.fingerprint).toContain("read:");
    expect(state.recentCalls[0]!.fingerprint).toContain("/project/src/foo.ts");
  });

  it("evicts oldest calls when exceeding MAX_RECENT_TOOL_CALLS", () => {
    for (let i = 0; i < 30; i++) {
      recordToolCall(state, "read", `call-${i}`, { path: `/project/src/file${i}.ts` });
    }
    expect(state.recentCalls.length).toBeLessThanOrEqual(24);
  });

  describe("identical-tail detection", () => {
    it("does not flag a single repeated call", () => {
      recordToolCall(state, "read", "call-1", { path: "/project/src/foo.ts" });
      recordToolCall(state, "read", "call-2", { path: "/project/src/foo.ts" });
      expect(state.pendingWarnings.size).toBe(0);
    });

    it("flags 3rd identical call as identical-tail warning", () => {
      const input = { path: "/project/src/foo.ts" };
      recordToolCall(state, "read", "call-1", input);
      recordToolCall(state, "read", "call-2", input);
      recordToolCall(state, "read", "call-3", input);
      expect(state.pendingWarnings.size).toBe(1);
      const warning = state.pendingWarnings.get("call-3")!;
      expect(warning.kind).toBe("identical-tail");
      expect(warning.toolName).toBe("read");
      expect(warning.fingerprint).toContain("read:");
    });

    it("does not flag different inputs", () => {
      // Different files → different fingerprints → no identical-tail warning
      recordToolCall(state, "read", "call-1", { path: "/project/src/a.ts" });
      recordToolCall(state, "read", "call-2", { path: "/project/src/a.ts" });
      recordToolCall(state, "read", "call-3", { path: "/project/src/b.ts" });
      expect(state.pendingWarnings.size).toBe(0);
    });
  });

  describe("repeated-subsequence detection", () => {
    it("does not flag a window smaller than 2", () => {
      // Use 3 different values per tool so the subsequence check finds no repeating window
      const inputs = [
        { path: "/a1.ts" }, { query: "x1" },
        { path: "/a2.ts" }, { query: "x2" },
        { path: "/a3.ts" }, { query: "x3" },
      ];
      for (let i = 0; i < 6; i++) {
        const toolName = i % 2 === 0 ? "read" : "search";
        recordToolCall(state, toolName, `call-${i}`, inputs[i] as Record<string, unknown>);
      }
      // All inputs are unique → no repeated-subsequence window
      expect(state.pendingWarnings.size).toBe(0);
    });

    it("flags 3-repeat of a 2-call sequence as repeated-subsequence", () => {
      // Build a repeating pattern: read(a) + search(x), repeated 3x
      const inputA = { path: "/a.ts" };
      const inputB = { query: "x" };
      recordToolCall(state, "read", "c1", inputA);
      recordToolCall(state, "search", "c2", inputB);
      recordToolCall(state, "read", "c3", inputA);
      recordToolCall(state, "search", "c4", inputB);
      recordToolCall(state, "read", "c5", inputA);
      recordToolCall(state, "search", "c6", inputB);
      expect(state.pendingWarnings.size).toBeGreaterThanOrEqual(1);
      const warning = state.pendingWarnings.get("c6")!;
      expect(warning.kind).toBe("repeated-subsequence");
    });

    it("repeated-subsequence warning includes the steps", () => {
      const inputA = { path: "/a.ts" };
      const inputB = { query: "x" };
      recordToolCall(state, "read", "c1", inputA);
      recordToolCall(state, "search", "c2", inputB);
      recordToolCall(state, "read", "c3", inputA);
      recordToolCall(state, "search", "c4", inputB);
      recordToolCall(state, "read", "c5", inputA);
      recordToolCall(state, "search", "c6", inputB);
      const warning = state.pendingWarnings.get("c6")!;
      if (warning.kind === "repeated-subsequence") {
        expect(warning.steps.length).toBeGreaterThan(0);
        expect(warning.steps[0]!.toolName).toBeDefined();
      }
    });

  });
});

describe("consumeDoomLoopWarning", () => {
  let state: DoomLoopState;

  beforeEach(() => {
    state = createDoomLoopState();
  });

  it("returns null when no warning exists for toolCallId", () => {
    const result = consumeDoomLoopWarning(state, "nonexistent");
    expect(result).toBeNull();
  });

  it("returns and removes the warning", () => {
    recordToolCall(state, "read", "call-1", { path: "/a.ts" });
    recordToolCall(state, "read", "call-2", { path: "/a.ts" });
    recordToolCall(state, "read", "call-3", { path: "/a.ts" });
    expect(state.pendingWarnings.size).toBe(1);
    const warning = consumeDoomLoopWarning(state, "call-3");
    expect(warning).not.toBeNull();
    expect(state.pendingWarnings.size).toBe(0);
  });

  it("returns warning on first consume, null on second", () => {
    recordToolCall(state, "read", "call-1", { path: "/a.ts" });
    recordToolCall(state, "read", "call-2", { path: "/a.ts" });
    recordToolCall(state, "read", "call-3", { path: "/a.ts" });
    consumeDoomLoopWarning(state, "call-3");
    const second = consumeDoomLoopWarning(state, "call-3");
    expect(second).toBeNull();
  });
});

describe("formatDoomLoopMessage", () => {
  it("formats identical-tail warning with REPEATED-CALL WARNING", () => {
    const state = createDoomLoopState();
    recordToolCall(state, "read", "call-1", { path: "/a.ts" });
    recordToolCall(state, "read", "call-2", { path: "/a.ts" });
    recordToolCall(state, "read", "call-3", { path: "/a.ts" });
    const warning = state.pendingWarnings.get("call-3")!;
    const message = formatDoomLoopMessage(warning);
    expect(message).toContain("⚠ REPEATED-CALL WARNING");
  });

  it("formats repeated-subsequence warning with ALTERNATING-CALL WARNING", () => {
    const state = createDoomLoopState();
    recordToolCall(state, "read", "c1", { path: "/a.ts" });
    recordToolCall(state, "search", "c2", { query: "x" });
    recordToolCall(state, "read", "c3", { path: "/a.ts" });
    recordToolCall(state, "search", "c4", { query: "x" });
    recordToolCall(state, "read", "c5", { path: "/a.ts" });
    recordToolCall(state, "search", "c6", { query: "x" });
    const warning = state.pendingWarnings.get("c6")!;
    const message = formatDoomLoopMessage(warning);
    expect(message).toContain("⚠ ALTERNATING-CALL WARNING");
  });

  it("message includes tool call details", () => {
    const state = createDoomLoopState();
    recordToolCall(state, "read", "c1", { path: "/a.ts" });
    recordToolCall(state, "read", "c2", { path: "/a.ts" });
    recordToolCall(state, "read", "c3", { path: "/a.ts" });
    const warning = state.pendingWarnings.get("c3")!;
    const message = formatDoomLoopMessage(warning);
    expect(message).toContain("read");
  });

  it("message includes suggestions", () => {
    const state = createDoomLoopState();
    recordToolCall(state, "read", "c1", { path: "/a.ts" });
    recordToolCall(state, "read", "c2", { path: "/a.ts" });
    recordToolCall(state, "read", "c3", { path: "/a.ts" });
    const warning = state.pendingWarnings.get("c3")!;
    const message = formatDoomLoopMessage(warning);
    expect(message).toContain("Suggestions");
  });

  it("message is non-empty for both warning kinds", () => {
    // identical-tail
    const s1 = createDoomLoopState();
    recordToolCall(s1, "read", "c1", { path: "/a.ts" });
    recordToolCall(s1, "read", "c2", { path: "/a.ts" });
    recordToolCall(s1, "read", "c3", { path: "/a.ts" });
    const w1 = s1.pendingWarnings.get("c3")!;
    expect(formatDoomLoopMessage(w1).length).toBeGreaterThan(0);

    // repeated-subsequence
    const s2 = createDoomLoopState();
    recordToolCall(s2, "read", "c1", { path: "/a.ts" });
    recordToolCall(s2, "search", "c2", { query: "x" });
    recordToolCall(s2, "read", "c3", { path: "/a.ts" });
    recordToolCall(s2, "search", "c4", { query: "x" });
    recordToolCall(s2, "read", "c5", { path: "/a.ts" });
    recordToolCall(s2, "search", "c6", { query: "x" });
    const w2 = s2.pendingWarnings.get("c6")!;
    expect(formatDoomLoopMessage(w2).length).toBeGreaterThan(0);
  });
});

describe("doom-loop integration", () => {
  it("records multiple tool types without false positives", () => {
    const state = createDoomLoopState();
    const tools = [
      { name: "read", input: { path: "/a.ts" } },
      { name: "search", input: { query: "foo" } },
      { name: "grep", input: { pattern: "TODO" } },
      { name: "repo_map", input: {} },
    ];
    for (let i = 0; i < 6; i++) {
      const t = tools[i % tools.length]!;
      recordToolCall(state, t.name, `call-${i}`, t.input);
    }
    // Should not have warnings for non-repeating calls
    expect(state.pendingWarnings.size).toBe(0);
  });

  it("handles empty input objects", () => {
    const state = createDoomLoopState();
    recordToolCall(state, "repo_map", "call-1", {});
    recordToolCall(state, "repo_map", "call-2", {});
    recordToolCall(state, "repo_map", "call-3", {});
    expect(state.pendingWarnings.size).toBe(1);
  });

  it("handles undefined/null input values gracefully", () => {
    const state = createDoomLoopState();
    // Should not throw
    recordToolCall(state, "read", "c1", { path: undefined as unknown as string, limit: null as unknown as number });
    recordToolCall(state, "read", "c2", { path: undefined as unknown as string, limit: null as unknown as number });
    recordToolCall(state, "read", "c3", { path: undefined as unknown as string, limit: null as unknown as number });
    expect(state.pendingWarnings.size).toBe(1);
  });
});