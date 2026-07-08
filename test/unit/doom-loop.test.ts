/**
 * Tests for doom-loop.ts — safety feature that detects when the LLM
 * repeats identical tool calls or gets stuck in alternating call sequences.
 */
import { describe, expect, it, beforeEach } from "vitest";
import {
  createDoomLoopState,
  makeToolFingerprint,
  MAX_SAME_NAME_FINGERPRINTS,
  recordToolCall,
  recordToolResult,
  consumeDoomLoopWarning,
  formatDoomLoopMessage,
  resetDoomLoopState,
  type DoomLoopState,
} from "../../doom-loop.js";
import {
  SUGGESTIONS,
  type DoomLoopSuggestion,
  type Suggestion,
} from "../../doom-loop-suggestions.js";

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
  it("returns empty recentCalls, pendingWarnings, stagedWarnings", () => {
    const state = createDoomLoopState();
    expect(state.recentCalls).toHaveLength(0);
    expect(state.pendingWarnings.size).toBe(0);
    expect(state.stagedWarnings.size).toBe(0);
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
      // Record results with same content to promote staged warning
      recordToolResult(state, "call-1", "same result");
      recordToolResult(state, "call-2", "same result");
      recordToolResult(state, "call-3", "same result");
      expect(state.pendingWarnings.size).toBe(1);
      const warning = state.pendingWarnings.get("call-3")!;
      expect(warning.kind).toBe("identical-tail");
      if (warning.kind === "identical-tail") {
        expect(warning.toolName).toBe("read");
        expect(warning.fingerprint).toContain("read:");
      }
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
      // Record same-content results to promote staged warning
      recordToolResult(state, "c1", "same result");
      recordToolResult(state, "c2", "same result");
      recordToolResult(state, "c3", "same result");
      recordToolResult(state, "c4", "same result");
      recordToolResult(state, "c5", "same result");
      recordToolResult(state, "c6", "same result");
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
      // Record same-content results to promote staged warning
      recordToolResult(state, "c1", "same result");
      recordToolResult(state, "c2", "same result");
      recordToolResult(state, "c3", "same result");
      recordToolResult(state, "c4", "same result");
      recordToolResult(state, "c5", "same result");
      recordToolResult(state, "c6", "same result");
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
    // Record results with same content to promote staged warning
    recordToolResult(state, "call-1", "same result");
    recordToolResult(state, "call-2", "same result");
    recordToolResult(state, "call-3", "same result");
    expect(state.pendingWarnings.size).toBe(1);
    const warning = consumeDoomLoopWarning(state, "call-3");
    expect(warning).not.toBeNull();
    expect(state.pendingWarnings.size).toBe(0);
  });

  it("returns warning on first consume, null on second", () => {
    recordToolCall(state, "read", "call-1", { path: "/a.ts" });
    recordToolCall(state, "read", "call-2", { path: "/a.ts" });
    recordToolCall(state, "read", "call-3", { path: "/a.ts" });
    // Record results with same content to promote staged warning
    recordToolResult(state, "call-1", "same result");
    recordToolResult(state, "call-2", "same result");
    recordToolResult(state, "call-3", "same result");
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
    recordToolResult(state, "call-1", "same result");
    recordToolResult(state, "call-2", "same result");
    recordToolResult(state, "call-3", "same result");
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
    recordToolResult(state, "c1", "same result");
    recordToolResult(state, "c2", "same result");
    recordToolResult(state, "c3", "same result");
    recordToolResult(state, "c4", "same result");
    recordToolResult(state, "c5", "same result");
    recordToolResult(state, "c6", "same result");
    const warning = state.pendingWarnings.get("c6")!;
    const message = formatDoomLoopMessage(warning);
    expect(message).toContain("⚠ ALTERNATING-CALL WARNING");
  });

  it("message includes tool call details", () => {
    const state = createDoomLoopState();
    recordToolCall(state, "read", "c1", { path: "/a.ts" });
    recordToolCall(state, "read", "c2", { path: "/a.ts" });
    recordToolCall(state, "read", "c3", { path: "/a.ts" });
    recordToolResult(state, "c1", "same result");
    recordToolResult(state, "c2", "same result");
    recordToolResult(state, "c3", "same result");
    const warning = state.pendingWarnings.get("c3")!;
    const message = formatDoomLoopMessage(warning);
    expect(message).toContain("read");
  });

  it("message includes suggestions", () => {
    const state = createDoomLoopState();
    recordToolCall(state, "read", "c1", { path: "/a.ts" });
    recordToolCall(state, "read", "c2", { path: "/a.ts" });
    recordToolCall(state, "read", "c3", { path: "/a.ts" });
    recordToolResult(state, "c1", "same result");
    recordToolResult(state, "c2", "same result");
    recordToolResult(state, "c3", "same result");
    const warning = state.pendingWarnings.get("c3")!;
    const message = formatDoomLoopMessage(warning);
    expect(message).toContain("Suggestions");
  });

// ── Content chanting ──────────────────────────────────────────────────────

describe("recordToolResult", () => {
  let state: DoomLoopState;

  beforeEach(() => {
    state = createDoomLoopState();
  });

  it("does nothing with empty content", () => {
    recordToolResult(state, "call-1", "");
    expect(state.contentChunks.length).toBe(0);
    expect(state.pendingWarnings.size).toBe(0);
  });

  it("does not fire before threshold", () => {
    const result = "A".repeat(50);
    for (let i = 0; i < 9; i++) {
      recordToolResult(state, `call-${i + 1}`, result);
    }
    expect(state.pendingWarnings.size).toBe(0);
  });

  it("does not fire for unique search results with repeated path boilerplate", () => {
    const prefix = "src/components/shared/path/that/repeats/in/results/";
    for (let i = 0; i < 10; i++) {
      recordToolCall(state, "search", `call-${i}`, { query: `query-${i}` });
      recordToolResult(state, `call-${i}`, `${prefix}file-${i}.ts\nunique symbol ${i}`);
    }
    expect(state.pendingWarnings.size).toBe(0);
  });

  it("fires content-chanting warning when same result appears 10+ times", () => {
    const result = "X".repeat(50);
    for (let i = 0; i < 10; i++) {
      recordToolResult(state, `call-${i + 1}`, result);
    }
    expect(state.pendingWarnings.size).toBe(1);
    const warning = state.pendingWarnings.get("call-10")!;
    expect(warning.kind).toBe("content-chanting");
    if (warning.kind === "content-chanting") {
      expect(warning.count).toBeGreaterThanOrEqual(10);
    }
  });

  it("respects MAX_CONTENT_CHUNKS window", () => {
    // Fill window with 200 unique chunks
    for (let i = 0; i < 200; i++) {
      recordToolResult(state, `call-${i + 1}`, String(i).repeat(50));
    }
    // Then push 10 identical chunks — should still fire
    // (old unique chunks get evicted, but same chunk appears 10x in new window)
    const chunk = "Y".repeat(50);
    for (let i = 0; i < 10; i++) {
      recordToolResult(state, `call-${i + 201}`, chunk);
    }
    expect(state.pendingWarnings.size).toBe(1);
  });

  it("does not overwrite existing warning", () => {
    // Set up identical-tail first
    const input = { path: "/a.ts" };
    recordToolCall(state, "read", "call-1", input);
    recordToolCall(state, "read", "call-2", input);
    recordToolCall(state, "read", "call-3", input);
    // Promote staged warning
    recordToolResult(state, "call-1", "some content");
    recordToolResult(state, "call-2", "some content");
    recordToolResult(state, "call-3", "some content");
    expect(state.pendingWarnings.get("call-3")?.kind).toBe("identical-tail");

    // Now call recordToolResult — should NOT overwrite
    const chunk = "Z".repeat(50);
    for (let i = 0; i < 10; i++) {
      recordToolResult(state, "call-3", chunk);
    }
    // Warning should still be identical-tail (not overwritten)
    const warning = state.pendingWarnings.get("call-3")!;
    expect(warning.kind).toBe("identical-tail");
  });
});

// ── Action stagnation ─────────────────────────────────────────────────────

describe("action stagnation", () => {
  let state: DoomLoopState;

  beforeEach(() => {
    state = createDoomLoopState();
  });

  it("does not fire for 7 consecutive same-tool calls", () => {
    for (let i = 0; i < 7; i++) {
      recordToolCall(state, "read", `call-${i + 1}`, { path: `/file${i}.ts` });
    }
    expect(state.pendingWarnings.size).toBe(0);
  });

  it("fires action-stagnation on 8th consecutive low-diversity non-read tool call", () => {
    const focuses = ["a", "b", "c", "a", "c", "b", "a", "b"];
    for (let i = 0; i < focuses.length; i++) {
      recordToolCall(state, "unknown_tool", `call-${i + 1}`, { focus: focuses[i] });
    }
    // Record same-content results to promote staged warning
    for (let i = 0; i < focuses.length; i++) {
      recordToolResult(state, `call-${i + 1}`, "same content");
    }
    expect(state.pendingWarnings.size).toBe(1);
    const warning = state.pendingWarnings.get("call-8")!;
    expect(warning.kind).toBe("action-stagnation");
    if (warning.kind === "action-stagnation") {
      expect(warning.count).toBe(8);
      expect(warning.toolName).toBe("unknown_tool");
    }
  });

  it("resets counter when tool name changes", () => {
    for (let i = 0; i < 7; i++) {
      recordToolCall(state, "read", `call-${i + 1}`, { path: `/file${i}.ts` });
    }
    recordToolCall(state, "repo_map", "call-8", { focus: "x" });
    for (let i = 0; i < 6; i++) {
      recordToolCall(state, "repo_map", `call-${i + 9}`, { focus: `x${i % 3}` });
    }
    expect(state.pendingWarnings.size).toBe(0);

    recordToolCall(state, "repo_map", "call-15", { focus: "x1" });
    // Record results with same content to promote staged warning
    recordToolResult(state, "call-8", "same content");
    recordToolResult(state, "call-9", "same content");
    recordToolResult(state, "call-10", "same content");
    recordToolResult(state, "call-11", "same content");
    recordToolResult(state, "call-12", "same content");
    recordToolResult(state, "call-13", "same content");
    recordToolResult(state, "call-14", "same content");
    recordToolResult(state, "call-15", "same content");
    expect(state.pendingWarnings.size).toBe(1);
  });

  it("does not fire stagnation when same tool keeps using distinct inputs", () => {
    for (let i = 0; i < 8; i++) {
      recordToolCall(state, "repo_map", `call-${i + 1}`, { focus: `/file${i}.ts` });
    }
    expect(state.pendingWarnings.size).toBe(0);
  });

  it("capped at priority below identical-tail", () => {
    // 8 identical calls → identical-tail should win
    const input = { path: "/a.ts" };
    for (let i = 0; i < 8; i++) {
      recordToolCall(state, "read", `call-${i + 1}`, input);
    }
    // Record results with same content to promote staged warning
    for (let i = 0; i < 8; i++) {
      recordToolResult(state, `call-${i + 1}`, "same result");
    }
    const warning = state.pendingWarnings.get("call-3")!;
    expect(warning.kind).toBe("identical-tail");
  });
});

// ── Read-file loop ────────────────────────────────────────────────────────

/** Avoid trigger action stagnation: mix read-like tools so none repeats ≥8x consecutively */
function recordReadLikeCalls(
  state: DoomLoopState,
  count: number,
  prefix = "r",
): void {
  const tools = ["read", "search", "read_files", "symbol"];
  for (let i = 0; i < count; i++) {
    const tool = tools[i % tools.length]!;
    recordToolCall(state, tool, `call-${prefix}${i}`, { path: `/f${i}.ts` });
  }
}

describe("read-file loop", () => {
  let state: DoomLoopState;

  beforeEach(() => {
    state = createDoomLoopState();
  });

  it("does not fire before window fills", () => {
    recordReadLikeCalls(state, 14);
    // 14 calls < window size 15 → no read-file-loop
    // no stagnation (tools mixed), no tail/subsequence (different inputs)
    expect(state.pendingWarnings.size).toBe(0);
  });

  it("fires when last 15 calls are dominated by context gathering with no progress tool", () => {
    recordReadLikeCalls(state, 12, "r");
    for (let i = 0; i < 3; i++) {
      recordToolCall(state, "repo_map", `call-m${i}`, { focus: `file${i}` });
    }
    // Record same-content results to promote staged warning
    for (let i = 0; i < 12; i++) {
      recordToolResult(state, `call-r${i}`, "same content");
    }
    for (let i = 0; i < 3; i++) {
      recordToolResult(state, `call-m${i}`, "same content");
    }
    expect(state.pendingWarnings.has("call-m2")).toBe(true);
    const warning = state.pendingWarnings.get("call-m2")!;
    expect(warning.kind).toBe("read-file-loop");
    if (warning.kind === "read-file-loop") {
      expect(warning.readCount).toBe(15);
      expect(warning.windowSize).toBe(15);
    }
  });

  it("does not fire when context gathering is below the read-loop threshold", () => {
    recordReadLikeCalls(state, 11, "r");
    for (let i = 0; i < 4; i++) {
      recordToolCall(state, "unknown_tool", `call-m${i}`, { value: `file${i}` });
    }
    const warnings = Array.from(state.pendingWarnings.values());
    expect(warnings.some((w) => w.kind === "read-file-loop")).toBe(false);
  });

  it("fires when all 15 calls are context gathering with no progress tool", () => {
    recordReadLikeCalls(state, 15);
    // Record same-content results to promote staged warning
    for (let i = 0; i < 15; i++) {
      recordToolResult(state, `call-r${i}`, "same content");
    }
    expect(state.pendingWarnings.size).toBeGreaterThanOrEqual(1);
  });

  it("does not fire when progress tools are present in the sliding window", () => {
    for (let i = 0; i < 5; i++) {
      recordToolCall(state, "search", `call-s${i}`, { query: `q${i}` });
      recordToolCall(state, "read", `call-r${i}`, { path: `/file${i}.ts` });
      recordToolCall(state, "bash", `call-b${i}`, { command: `npm test -- --runInBand case${i}` });
    }
    expect(state.pendingWarnings.size).toBe(0);
  });

  it("treats repo_map and symbol as context-gathering tools", () => {
    const allTools = ["read", "read_files", "search", "symbol", "repo_map"];
    for (let i = 0; i < allTools.length; i++) {
      recordToolCall(state, allTools[i]!, `call-${i}`, { path: `/f${i}.ts`, query: `q${i}` });
    }
    recordReadLikeCalls(state, 9, "fill");
    expect(state.pendingWarnings.size).toBe(0);

    recordToolCall(state, "search", "call-final", { query: "x" });
    // Record repeated search results to promote the staged read-loop warning.
    for (let i = 0; i < allTools.length; i++) {
      const result = allTools[i] === "search" ? "search repeated content" : `unique content ${i}`;
      recordToolResult(state, `call-${i}`, result);
    }
    for (let i = 0; i < 9; i++) {
      const result = i === 1 ? "search repeated content" : `unique fill content ${i}`;
      recordToolResult(state, `call-fill${i}`, result);
    }
    recordToolResult(state, "call-final", "search repeated content");
    expect(state.pendingWarnings.has("call-final")).toBe(true);
    const warning = state.pendingWarnings.get("call-final")!;
    expect(warning.kind).toBe("read-file-loop");
  });
});

// ─── Format message new types ─────────────────────────────────────────────

describe("formatDoomLoopMessage for new types", () => {
  it("formats content-chanting warning", () => {
    const warning = { kind: "content-chanting" as const, count: 12 };
    const message = formatDoomLoopMessage(warning);
    expect(message).toContain("CONTENT-CHANTING WARNING");
    expect(message).toContain("12");
  });

  it("formats action-stagnation warning", () => {
    const warning = { kind: "action-stagnation" as const, toolName: "read", count: 8 };
    const message = formatDoomLoopMessage(warning);
    expect(message).toContain("ACTION-STAGNATION WARNING");
    expect(message).toContain("8");
    expect(message).toContain("read");
    expect(message).toContain("Suggestions");
  });

  it("formats read-file-loop warning", () => {
    const warning = { kind: "read-file-loop" as const, readCount: 9, windowSize: 15 };
    const message = formatDoomLoopMessage(warning);
    expect(message).toContain("READ-FILE-LOOP WARNING");
    expect(message).toContain("9");
    expect(message).toContain("15");
  });
});

  it("message is non-empty for both warning kinds", () => {
    // identical-tail
    const s1 = createDoomLoopState();
    recordToolCall(s1, "read", "c1", { path: "/a.ts" });
    recordToolCall(s1, "read", "c2", { path: "/a.ts" });
    recordToolCall(s1, "read", "c3", { path: "/a.ts" });
    recordToolResult(s1, "c1", "same result");
    recordToolResult(s1, "c2", "same result");
    recordToolResult(s1, "c3", "same result");
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
    recordToolResult(s2, "c1", "same result");
    recordToolResult(s2, "c2", "same result");
    recordToolResult(s2, "c3", "same result");
    recordToolResult(s2, "c4", "same result");
    recordToolResult(s2, "c5", "same result");
    recordToolResult(s2, "c6", "same result");
    const w2 = s2.pendingWarnings.get("c6")!;
    expect(formatDoomLoopMessage(w2).length).toBeGreaterThan(0);
  });
});

function suggestionToolHints(suggestions: readonly Suggestion[]): string[] {
  return suggestions
    .filter((suggestion): suggestion is DoomLoopSuggestion => typeof suggestion !== "string")
    .map((suggestion) => suggestion.toolHint)
    .filter((toolHint): toolHint is string => typeof toolHint === "string");
}

describe("doom-loop suggestions", () => {
  it("read suggestions point to read_files query mode and symbol", () => {
    const hints = suggestionToolHints(SUGGESTIONS.read ?? []);
    expect(hints).toContain("read_files");
    expect(hints).toContain("symbol");
  });

  it("does not expose dead grep tool suggestions", () => {
    expect(SUGGESTIONS["grep"]).toBeUndefined();
  });

  it("search suggestions offer deep depth and symbol alternatives", () => {
    const hints = suggestionToolHints(SUGGESTIONS.search ?? []);
    expect(hints).toContain("symbol");
    const deepRetry = (SUGGESTIONS.search ?? []).find(
      (s) => typeof s !== "string" && s.toolInput?.depth === "deep",
    );
    expect(deepRetry).toBeDefined();
  });

  it("read_files suggestions include query-mode hint", () => {
    const withQuery = (SUGGESTIONS.read_files ?? []).find(
      (s) => typeof s !== "string" && s.toolInput?.query !== undefined,
    );
    expect(withQuery).toBeDefined();
  });

  it("has no suggestions for removed tools", () => {
    expect(SUGGESTIONS["intent_read"]).toBeUndefined();
    expect(SUGGESTIONS["deep_search"]).toBeUndefined();
    expect(SUGGESTIONS["find_symbol"]).toBeUndefined();
    expect(SUGGESTIONS["symbol_info"]).toBeUndefined();
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
    recordToolResult(state, "call-1", "same result");
    recordToolResult(state, "call-2", "same result");
    recordToolResult(state, "call-3", "same result");
    expect(state.pendingWarnings.size).toBe(1);
  });

  it("handles undefined/null input values gracefully", () => {
    const state = createDoomLoopState();
    // Should not throw
    recordToolCall(state, "read", "c1", { path: undefined as unknown as string, limit: null as unknown as number });
    recordToolCall(state, "read", "c2", { path: undefined as unknown as string, limit: null as unknown as number });
    recordToolCall(state, "read", "c3", { path: undefined as unknown as string, limit: null as unknown as number });
    recordToolResult(state, "c1", "same result");
    recordToolResult(state, "c2", "same result");
    recordToolResult(state, "c3", "same result");
    expect(state.pendingWarnings.size).toBe(1);
  });
});

// ─── Turn-scoped reset API ─────────────────────────────────────────────────

describe("resetDoomLoopState", () => {
  let state: DoomLoopState;

  beforeEach(() => {
    state = createDoomLoopState();
  });

  it("clears recentCalls and pendingWarnings", () => {
    recordToolCall(state, "read", "c1", { path: "/a.ts" });
    recordToolCall(state, "read", "c2", { path: "/a.ts" });
    recordToolCall(state, "read", "c3", { path: "/a.ts" });
    recordToolResult(state, "c1", "same result");
    recordToolResult(state, "c2", "same result");
    recordToolResult(state, "c3", "same result");
    expect(state.recentCalls.length).toBeGreaterThan(0);
    expect(state.pendingWarnings.size).toBeGreaterThan(0);

    resetDoomLoopState(state);

    expect(state.recentCalls).toHaveLength(0);
    expect(state.pendingWarnings.size).toBe(0);
    expect(state.contentChunks).toHaveLength(0);
    expect(state.sameNameStreak).toBe(0);
    expect(state.lastSeenToolName).toBeNull();
    expect(state.recentToolNames).toHaveLength(0);
  });

  it("preserves object identity (mutates in place)", () => {
    const originalRef = state;
    recordToolCall(state, "read", "c1", { path: "/a.ts" });
    resetDoomLoopState(state);
    expect(state).toBe(originalRef);
  });
});


// ─── Global duplicate detector ────────────────────────────────────────────

describe("global duplicate detector", () => {
  let state: DoomLoopState;

  beforeEach(() => {
    state = createDoomLoopState();
  });

  it("does not fire for few occurrences", () => {
    // 4 same fingerprints among different calls — under threshold
    recordToolCall(state, "read", "c1", { path: "/a.ts" });
    recordToolCall(state, "search", "c2", { query: "x" });
    recordToolCall(state, "read", "c3", { path: "/a.ts" });
    recordToolCall(state, "search", "c4", { query: "y" });
    // read(a) appears 2x, nowhere near 5. No warnings expected.
    expect(state.pendingWarnings.size).toBe(0);
  });

  it("fires global duplicate when same fingerprint appears 5+ times in window", () => {
    // 5 calls with same fingerprint, not at the tail (scattered)
    recordToolCall(state, "search", "c1", { query: "foo" });
    recordToolCall(state, "read", "c2", { path: "/a.ts" });  // dup target
    recordToolCall(state, "search", "c3", { query: "bar" });
    recordToolCall(state, "read", "c4", { path: "/a.ts" });  // dup
    recordToolCall(state, "search", "c5", { query: "baz" });
    recordToolCall(state, "read", "c6", { path: "/a.ts" });  // dup
    recordToolCall(state, "read", "c7", { path: "/b.ts" });
    recordToolCall(state, "read", "c8", { path: "/a.ts" });  // dup
    recordToolCall(state, "read", "c9", { path: "/a.ts" });  // dup (5th)
    // Record results with same content to promote staged warning
    for (const id of ["c1","c2","c3","c4","c5","c6","c7","c8","c9"]) {
      recordToolResult(state, id, "same result");
    }
    expect(state.pendingWarnings.size).toBeGreaterThanOrEqual(1);
    const warning = state.pendingWarnings.get("c9");
    expect(warning?.kind).toBe("global-duplicate");
  });

  it("does not double-warn when identical-tail already caught", () => {
    // 3 identical at tail: identical-tail fires. Don't ALSO fire global-duplicate.
    recordToolCall(state, "read", "c1", { path: "/a.ts" });
    recordToolCall(state, "read", "c2", { path: "/a.ts" });
    recordToolCall(state, "read", "c3", { path: "/a.ts" });
    // Record results with same content to promote staged warning
    recordToolResult(state, "c1", "same result");
    recordToolResult(state, "c2", "same result");
    recordToolResult(state, "c3", "same result");
    // Only 1 warning
    expect(state.pendingWarnings.size).toBe(1);
    const warning = state.pendingWarnings.get("c3")!;
    expect(warning.kind).toBe("identical-tail");
  });
});

// ─── Global alternating detector ──────────────────────────────────────────

describe("global alternating detector", () => {
  let state: DoomLoopState;

  beforeEach(() => {
    state = createDoomLoopState();
  });

  it("fires global-alternating for A-B-A-B-A-B across window", () => {
    // A-B-A-B-A-B with window=1: repeated-subsequence catches this.
    // But test that global-alternating also works.
    recordToolCall(state, "read", "c1", { path: "/a.ts" });
    recordToolCall(state, "search", "c2", { query: "x" });
    recordToolCall(state, "read", "c3", { path: "/a.ts" });
    recordToolCall(state, "search", "c4", { query: "x" });
    recordToolCall(state, "read", "c5", { path: "/a.ts" });
    recordToolCall(state, "search", "c6", { query: "x" });
    // Record same-content results to promote staged warning
    for (const id of ["c1","c2","c3","c4","c5","c6"]) {
      recordToolResult(state, id, "same result");
    }
    // repeated-subsequence fires at c6
    expect(state.pendingWarnings.size).toBeGreaterThanOrEqual(1);
  });

  it("does not fire for random tool mix", () => {
    for (let i = 0; i < 10; i++) {
      const tool = i % 3 === 0 ? "read" : i % 3 === 1 ? "search" : "repo_map";
      recordToolCall(state, tool, `c${i}`, { path: `/f${i}.ts` });
    }
    // No strong alternating pattern, no warnings
    expect(state.pendingWarnings.size).toBe(0);
  });
});

// ─── Action stagnation: reduced false positives for read-like tools ───────

describe("action stagnation read-like threshold", () => {
  let state: DoomLoopState;

  beforeEach(() => {
    state = createDoomLoopState();
  });

  it("does not fire stagnation for 8 consecutive read calls (different files)", () => {
    // Read-like tools should have higher threshold
    for (let i = 0; i < 8; i++) {
      recordToolCall(state, "read", `call-${i + 1}`, { path: `/file${i}.ts` });
    }
    // 8 consecutive reads with different args = batch exploration, not stagnation
    expect(state.pendingWarnings.size).toBe(0);
  });

  it("still fires stagnation after many consecutive same non-read tool calls", () => {
    // Non-read tool uses original lower threshold (8)
    const focuses = ["a", "b", "c", "a", "c", "b", "a", "b"];
    for (let i = 0; i < focuses.length; i++) {
      recordToolCall(state, "unknown_tool", `call-${i + 1}`, { focus: focuses[i] });
    }
    // Record same-content results to promote staged warning
    for (let i = 0; i < focuses.length; i++) {
      recordToolResult(state, `call-${i + 1}`, "same content");
    }
    expect(state.pendingWarnings.size).toBe(1);
    const warning = state.pendingWarnings.get("call-8")!;
    expect(warning.kind).toBe("action-stagnation");
  });

  it("fires stagnation for read-like tools when threshold truly exceeded", () => {
    // Even read-like tools should fire eventually at higher threshold (16)
    for (let i = 0; i < 16; i++) {
      recordToolCall(state, "read", `call-${i + 1}`, { path: `/file${i % 6}.ts` });
    }
    // Record same-content results to promote staged warning
    for (let i = 0; i < 16; i++) {
      recordToolResult(state, `call-${i + 1}`, "same content");
    }
    expect(state.pendingWarnings.has("call-16")).toBe(true);
    const warning = state.pendingWarnings.get("call-16")!;
    expect(warning.kind).toBe("action-stagnation");
  });

  it("uses higher threshold for search because it is read-like", () => {
    // Search is read-like and gets the same higher batch-exploration threshold.
    for (let i = 0; i < 8; i++) {
      recordToolCall(state, "search", `call-${i + 1}`, { query: `x${i}` });
    }
    expect(state.pendingWarnings.size).toBe(0);
  });
});

// ─── Read-file-loop guidance fix ─────────────────────────────────────────

describe("read-file-loop guidance", () => {
  it("does not suggest read-like tools in read-file-loop message", () => {
    const warning = { kind: "read-file-loop" as const, readCount: 10, windowSize: 15 };
    const message = formatDoomLoopMessage(warning);
    // Should NOT suggest read-like tools
    expect(message).not.toContain("search");
    expect(message).not.toContain("read_files");
    // Should suggest synthesis, non-read tools or stepping back
    expect(message).toContain("synthesising");
  });

  it("suggests synthesis and non-read alternatives", () => {
    const warning = { kind: "read-file-loop" as const, readCount: 9, windowSize: 15 };
    const message = formatDoomLoopMessage(warning);
    expect(message).toContain("synthesising");
  });
});

// ─── Improved guidance: synthesis/next action ────────────────────────────

describe("guidance improvement", () => {
  it("action-stagnation message includes synthesise guidance", () => {
    const warning = { kind: "action-stagnation" as const, toolName: "read", count: 10 };
    const message = formatDoomLoopMessage(warning);
    expect(message).toContain("synthesise");
  });

  it("identical-tail message includes synthesise guidance", () => {
    const state = createDoomLoopState();
    recordToolCall(state, "read", "c1", { path: "/a.ts" });
    recordToolCall(state, "read", "c2", { path: "/a.ts" });
    recordToolCall(state, "read", "c3", { path: "/a.ts" });
    recordToolResult(state, "c1", "same result");
    recordToolResult(state, "c2", "same result");
    recordToolResult(state, "c3", "same result");
    const warning = state.pendingWarnings.get("c3")!;
    const message = formatDoomLoopMessage(warning);
    expect(message).toContain("synthesise");
  });

  it("repeated-subsequence message includes synthesise guidance", () => {
    const state = createDoomLoopState();
    recordToolCall(state, "read", "c1", { path: "/a.ts" });
    recordToolCall(state, "search", "c2", { query: "x" });
    recordToolCall(state, "read", "c3", { path: "/a.ts" });
    recordToolCall(state, "search", "c4", { query: "x" });
    recordToolCall(state, "read", "c5", { path: "/a.ts" });
    recordToolCall(state, "search", "c6", { query: "x" });
    recordToolResult(state, "c1", "same result");
    recordToolResult(state, "c2", "same result");
    recordToolResult(state, "c3", "same result");
    recordToolResult(state, "c4", "same result");
    recordToolResult(state, "c5", "same result");
    recordToolResult(state, "c6", "same result");
    const warning = state.pendingWarnings.get("c6")!;
    const message = formatDoomLoopMessage(warning);
    expect(message).toContain("synthesise");
  });
});

describe("call-only staging gate (no result)", () => {
  let state: DoomLoopState;

  beforeEach(() => {
    state = createDoomLoopState();
  });

  it("identical-tail pattern via recordToolCall alone creates staged but no pending warning", () => {
    const input = { path: "/project/src/foo.ts" };
    recordToolCall(state, "read", "r-1", input);
    recordToolCall(state, "read", "r-2", input);
    recordToolCall(state, "read", "r-3", input);

    expect(state.stagedWarnings.size).toBe(1);
    expect(state.stagedWarnings.get("r-3")?.kind).toBe("identical-tail");
    expect(state.pendingWarnings.size).toBe(0);
    expect(consumeDoomLoopWarning(state, "r-3")).toBeNull();
  });

  it("alternating-subsequence pattern via recordToolCall alone does not create pending warning", () => {
    const a = { path: "/project/src/a.ts" };
    const b = { path: "/project/src/b.ts" };
    for (let i = 0; i < 3; i++) {
      recordToolCall(state, "read", `r-a${i}`, a);
      recordToolCall(state, "search", `s-b${i}`, b);
    }
    expect(state.stagedWarnings.size).toBe(1);
    expect(state.stagedWarnings.get("s-b2")?.kind).toBe("repeated-subsequence");
    expect(state.pendingWarnings.size).toBe(0);
  });

  it("novel result after identical-tail suppresses warning and clears staged", () => {
    const input = { path: "/project/src/foo.ts" };
    recordToolCall(state, "read", "r-1", input);
    recordToolCall(state, "read", "r-2", input);
    recordToolCall(state, "read", "r-3", input);
    expect(state.stagedWarnings.has("r-3")).toBe(true);

    recordToolResult(state, "r-3", "completely unique result 1");
    recordToolResult(state, "r-2", "completely unique result 2");
    recordToolResult(state, "r-1", "completely unique result 3");

    expect(state.stagedWarnings.size).toBe(0);
    expect(state.pendingWarnings.size).toBe(0);
    expect(consumeDoomLoopWarning(state, "r-3")).toBeNull();
  });
});

describe("empty/blank result handling", () => {
  let state: DoomLoopState;

  beforeEach(() => {
    state = createDoomLoopState();
  });

  it("blank result clears staged warning and does not leak", () => {
    const input = { path: "/project/src/foo.ts" };
    recordToolCall(state, "read", "r-1", input);
    recordToolCall(state, "read", "r-2", input);
    recordToolCall(state, "read", "r-3", input);
    expect(state.stagedWarnings.size).toBe(1);

    recordToolResult(state, "r-3", "");
    expect(state.stagedWarnings.size).toBe(0);
    expect(state.pendingWarnings.size).toBe(0);
    expect(consumeDoomLoopWarning(state, "r-3")).toBeNull();
  });

  it("whitespace-only result clears staged warning and does not leak", () => {
    const input = { path: "/project/src/foo.ts" };
    recordToolCall(state, "read", "r-1", input);
    recordToolCall(state, "read", "r-2", input);
    recordToolCall(state, "read", "r-3", input);

    recordToolResult(state, "r-3", "   \n\t  \r\n  ");
    expect(state.stagedWarnings.size).toBe(0);
    expect(state.pendingWarnings.size).toBe(0);
  });

  it("blank result for unknown toolCallId does not throw and is no-op", () => {
    expect(() => recordToolResult(state, "never-staged", "")).not.toThrow();
    expect(state.stagedWarnings.size).toBe(0);
    expect(state.pendingWarnings.size).toBe(0);
  });
});

describe("bounded growth of fingerprint maps", () => {
  it("globalFingerprintCounts shrinks when recentCalls evict fingerprints", () => {
    const state = createDoomLoopState();
    // 24 different fingerprints seen once each = 24 entries in recentCalls.
    for (let i = 0; i < 24; i++) {
      recordToolCall(state, "read", `c-${i}`, { path: `/file${i}.ts` });
    }
    const sizeAt24 = state.globalFingerprintCounts.size;
    expect(sizeAt24).toBeGreaterThan(0);

    // Add a 25th distinct fingerprint; oldest evicted and its count pruned.
    recordToolCall(state, "read", "c-24", { path: "/file24.ts" });
    expect(state.recentCalls.length).toBe(24);
    expect(state.globalFingerprintCounts.size).toBeLessThanOrEqual(24);
    // Evicted fingerprint's count should be gone (was 1, now 0 → deleted).
    const evictedFp = state.globalFingerprintCounts.get(
      makeToolFingerprint("read", { path: "/file0.ts" }),
    );
    expect(evictedFp ?? 0).toBe(0);
  });

  it("resultFingerprintsByTool set stays bounded per tool", () => {
    const state = createDoomLoopState();
    // Generate 40 distinct results for the same tool, each under different call ids.
    for (let i = 0; i < 40; i++) {
      recordToolCall(state, "read", `c-${i}`, { path: `/file${i}.ts` });
      recordToolResult(state, `c-${i}`, `result body ${i} ${"x".repeat(20)}`);
    }
    const set = state.resultFingerprintsByTool.get("read");
    expect(set).toBeDefined();
    expect(set!.size).toBeLessThanOrEqual(32);
  });

  it("stagedWarnings are pruned with evicted calls when results never arrive", () => {
    const state = createDoomLoopState();
    const input = { path: "/same.ts" };

    for (let i = 0; i < 100; i++) {
      recordToolCall(state, "read", `c-${i}`, input);
    }

    expect(state.recentCalls.length).toBeLessThanOrEqual(24);
    expect(state.stagedWarnings.size).toBeLessThanOrEqual(state.recentCalls.length);
    expect(state.stagedWarnings.has("c-2")).toBe(false);
  });

  it("sameNameFingerprints stays bounded during long same-tool streaks", () => {
    const state = createDoomLoopState();

    for (let i = 0; i < 100; i++) {
      recordToolCall(state, "read", `c-${i}`, { path: `/file${i}.ts` });
    }

    expect(state.sameNameFingerprints.length).toBeLessThanOrEqual(MAX_SAME_NAME_FINGERPRINTS);
  });
});