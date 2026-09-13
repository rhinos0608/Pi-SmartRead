import { describe, expect, it, beforeEach, vi } from "vitest";
import { GUARD_HINT_DEEP_SEARCH } from "../../src/bash-context-guard.js";
import { setupExtension, type IndexHarness } from "./index-fixture.js";

let harness: IndexHarness;

beforeEach(async () => {
  harness = await setupExtension();
});

describe("index extension result pipeline", () => {
  it("guards large deep search tool results", async () => {
    // v3: deep search runs as inspect { query, depth: "deep" }.
    // The bash-context-guard should still cap oversized tool_result content for the
    // `inspect` tool name (which replaced `search` in v3).
    const { handlers } = harness;

    const text = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
    const result = await handlers.tool_result!({
      toolName: "inspect",
      toolCallId: "deep-search-1",
      input: { query: "architecture", depth: "deep" },
      details: { mode: "query" },
      content: [{ type: "text", text }],
    });

    expect(result.content[0].text).toContain("[Bash context guard: preview]");
    expect(result.content[0].text).toContain(GUARD_HINT_DEEP_SEARCH);
    expect(result.details.bashContextGuard.toolName).toBe("inspect");
  });

  it("applies bash context guard AFTER doom-loop warning injection (ordering fix)", async () => {
    const { handlers } = harness;

    // Large output that triggers doom-loop identical-tail AND exceeds guard thresholds
    const largeText = Array.from({ length: 4000 }, (_, i) => `line ${i}`).join("\n");
    // v3: `read` is replaced by `inspect`; large `inspect` results are still
    // capped by the bash context guard.
    const input = { path: "/large.ts" };
    for (let i = 1; i <= 3; i++) {
      handlers.tool_call!({
        toolName: "inspect",
        toolCallId: `inspect-${i}`,
        input,
      });
    }
    // First two: side effects only (build doom-loop state)
    await handlers.tool_result!({
      toolName: "inspect",
      toolCallId: "inspect-1",
      input,
      content: [{ type: "text", text: largeText }],
    });
    await handlers.tool_result!({
      toolName: "inspect",
      toolCallId: "inspect-2",
      input,
      content: [{ type: "text", text: largeText }],
    });
    const result3 = await handlers.tool_result!({
      toolName: "inspect",
      toolCallId: "inspect-3",
      input,
      content: [{ type: "text", text: largeText }],
    });

    // The third identical call triggers doom-loop identical-tail warning
    // But output should STILL be capped by bash guard (not raw largeText)
    expect(result3).toBeDefined();
    if (result3) {
      const text = result3.content[0].text;
      // Should contain guard preview header
      expect(text).toContain("[Bash context guard: preview]");
      // Should still contain the doom-loop warning (preserved notice)
      expect(text).toContain("⚠ REPEATED-CALL WARNING:");
      // Should NOT contain lines from the omitted middle section (headLines=120,
      // tailLines=160 for inspect profile; line 2000 falls in the omitted range)
      expect(text).not.toContain("line 2000");
    }
  });

  it("marks read context stale after write results mutate the same file", async () => {
    const { handlers } = harness;

    await handlers.tool_result!({
      toolName: "read",
      toolCallId: "read-1",
      input: { path: "src/foo.ts" },
      content: [{ type: "text", text: "export const value = 1;" }],
    });
    await handlers.tool_result!({
      toolName: "write",
      toolCallId: "write-1",
      input: { path: "src/foo.ts" },
      content: [{ type: "text", text: "wrote file" }],
    });

    const result = handlers.context!({
      messages: [
        {
          role: "toolResult",
          toolCallId: "read-1",
          toolName: "read",
          content: [{ type: "text", text: "export const value = 1;" }],
        },
      ],
    });

    expect(result.messages[0].content[0].text).toContain("Stale read context");
  });

  it("uses changedResources.canonicalPath as authoritative mutation paths for multi-file edit (raw input, no top-level path)", async () => {
    const { handlers } = harness;

    await handlers.tool_result!({ toolName: "read", toolCallId: "read-a", input: { path: "src/a.ts" }, content: [{ type: "text", text: "a" }] });
    await handlers.tool_result!({ toolName: "read", toolCallId: "read-b", input: { path: "src/b.ts" }, content: [{ type: "text", text: "b" }] });

    // Raw edit input with NO top-level path; changedResources carries the paths.
    await handlers.tool_result!({
      toolName: "edit",
      toolCallId: "edit-1",
      input: { edits: [{ path: "src/a.ts" }, { path: "src/b.ts" }] },
      details: { changedResources: [{ canonicalPath: "src/a.ts" }, { canonicalPath: "src/b.ts" }] },
      content: [{ type: "text", text: "edited" }],
    });

    const result = handlers.context!({
      messages: [
        { role: "toolResult", toolCallId: "read-a", toolName: "read", content: [{ type: "text", text: "a" }] },
        { role: "toolResult", toolCallId: "read-b", toolName: "read", content: [{ type: "text", text: "b" }] },
      ],
    });

    expect(result.messages[0].content[0].text).toContain("Stale read context");
    expect(result.messages[1].content[0].text).toContain("Stale read context");
  });

  it("does not mark read context stale for failed edits", async () => {
    const { handlers } = harness;

    await handlers.tool_result!({ toolName: "read", toolCallId: "read-1", input: { path: "src/foo.ts" }, content: [{ type: "text", text: "export const value = 1;" }] });
    await handlers.tool_result!({
      toolName: "edit",
      toolCallId: "edit-1",
      input: { path: "src/foo.ts" },
      isError: true,
      details: { changedResources: [{ canonicalPath: "src/foo.ts" }] },
      content: [{ type: "text", text: "edit failed" }],
    });

    const result = handlers.context!({
      messages: [{ role: "toolResult", toolCallId: "read-1", toolName: "read", content: [{ type: "text", text: "export const value = 1;" }] }],
    });
    expect(result).toBeUndefined();
  });

  it("does not mark read context stale for failed writes", async () => {
    const { handlers } = harness;

    await handlers.tool_result!({ toolName: "read", toolCallId: "read-1", input: { path: "src/foo.ts" }, content: [{ type: "text", text: "export const value = 1;" }] });
    await handlers.tool_result!({
      toolName: "write",
      toolCallId: "write-1",
      input: { path: "src/foo.ts" },
      isError: true,
      content: [{ type: "text", text: "write failed" }],
    });

    const result = handlers.context!({
      messages: [{ role: "toolResult", toolCallId: "read-1", toolName: "read", content: [{ type: "text", text: "export const value = 1;" }] }],
    });
    expect(result).toBeUndefined();
  });

  it("does not mark read context stale for failed graph_mutate", async () => {
    const { handlers } = harness;

    await handlers.tool_result!({ toolName: "read", toolCallId: "read-1", input: { path: "src/foo.ts" }, content: [{ type: "text", text: "export const value = 1;" }] });
    await handlers.tool_result!({
      toolName: "graph_mutate",
      toolCallId: "gm-1",
      input: { from: "src/foo.ts", to: "src/bar.ts" },
      isError: true,
      content: [{ type: "text", text: "graph_mutate failed" }],
    });

    const result = handlers.context!({
      messages: [{ role: "toolResult", toolCallId: "read-1", toolName: "read", content: [{ type: "text", text: "export const value = 1;" }] }],
    });
    expect(result).toBeUndefined();
  });

  it("ignores malformed changedResources and falls back to input path for edit", async () => {
    const { handlers } = harness;

    await handlers.tool_result!({ toolName: "read", toolCallId: "read-1", input: { path: "src/foo.ts" }, content: [{ type: "text", text: "export const value = 1;" }] });

    // Non-string canonicalPath entries are dropped; input.path is the fallback.
    await handlers.tool_result!({
      toolName: "edit",
      toolCallId: "edit-1",
      input: { path: "src/foo.ts" },
      details: { changedResources: [{ canonicalPath: 123 }, { canonicalPath: "" }] },
      content: [{ type: "text", text: "edited" }],
    });

    const result = handlers.context!({
      messages: [
        { role: "toolResult", toolCallId: "read-1", toolName: "read", content: [{ type: "text", text: "export const value = 1;" }] },
      ],
    });

    expect(result.messages[0].content[0].text).toContain("Stale read context");
  });

  it("post-edit impact wiring: does not throw and is additive for write (no graph data -> no-op)", async () => {
    const { handlers } = harness;

    // No graph built -> impact summary should no-op without affecting result
    const result = await handlers.tool_result!({
      toolName: "write",
      toolCallId: "write-impact-noop",
      input: { path: "src/foo.ts" },
      content: [{ type: "text", text: "wrote file" }],
    });
    // tool_result should still resolve (either undefined or same content); no throw
    if (result) {
      expect(result.content[0].text).toContain("wrote file");
    }
  });

  it("post-edit impact wiring: appends impact block when graph data exists (mocked)", async () => {
    const { handlers } = harness;
    // Mock post-edit-impact to return a block for this test via vi.mock-like override
    const impactMod = await import("../../src/post-edit-impact.js");
    const spy = vi.spyOn(impactMod, "runPostEditImpactSummary").mockResolvedValue({
      content: [{ type: "text", text: "wrote file" }, { type: "text", text: "[Possibly affected: src/b.ts — advisory, based on prior graph data]" }],
    });
    const result = await handlers.tool_result!({
      toolName: "write",
      toolCallId: "write-impact-mocked",
      input: { path: "src/foo.ts" },
      content: [{ type: "text", text: "wrote file" }],
    });
    expect(result).toBeDefined();
    expect(result.content).toHaveLength(2);
    expect((result.content[1] as { text: string }).text).toContain("Possibly affected");
    spy.mockRestore();
    // Also ensure subsequent write without mock still works (diagnostics fallback not broken)
    const result2 = await handlers.tool_result!({
      toolName: "write",
      toolCallId: "write-impact-2",
      input: { path: "src/foo.ts" },
      content: [{ type: "text", text: "wrote again" }],
    });
    if (result2) expect(result2.content[0].text).toContain("wrote again");
  });
});
