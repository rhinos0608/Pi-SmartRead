import { describe, expect, it, beforeEach, vi } from "vitest";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { GUARD_HINT_DEEP_SEARCH } from "../../src/runtime/bash-context-guard.js";
import { setupExtension, type IndexHarness } from "./index-fixture.js";
import { changedPathsFromDetails } from "../../src/extension-result-pipeline.js";

let harness: IndexHarness;

beforeEach(async () => {
  harness = await setupExtension();
});

describe("index extension result pipeline", () => {
  it("uses only applied Protocol v4 mutation lifecycle details for changed paths", () => {
    const applied = {
      tool: "edit",
      status: { kind: "applied" },
      toolCallId: "edit-1",
      evidenceRef: { inspectionId: "a".repeat(64), resourceIds: ["b".repeat(64)] },
      usedEvidence: ["b".repeat(64)],
      changedResources: [{ resourceId: "b".repeat(64), canonicalPath: "/ws/a.ts", fullFileSha256: "c".repeat(64), coverage: "full-file" }],
      checks: { blocking: [], completed: [], advisory: [], skipped: [], timedOut: [] },
      diagnostics: [],
    };
    expect(changedPathsFromDetails(applied)).toEqual(["/ws/a.ts"]);
    expect(changedPathsFromDetails({ ...applied, status: { kind: "rejected", reason: "stale" } })).toEqual([]);
    expect(changedPathsFromDetails({ tool: "edit", status: { kind: "failed", phase: "write" } })).toEqual([]);
  });

  it("accepts applied Protocol v0.5 MutationDetails and invalidates changed edit resources", async () => {
    const { handlers } = harness;

    await handlers.tool_result!({
      toolName: "read",
      toolCallId: "read-a",
      input: { path: "src/a.ts" },
      content: [{ type: "text", text: "a" }],
    });
    await handlers.tool_result!({
      toolName: "read",
      toolCallId: "read-b",
      input: { path: "src/b.ts" },
      content: [{ type: "text", text: "b" }],
    });

    const result = await handlers.tool_result!({
      toolName: "edit",
      toolCallId: "edit-v05",
      input: { edits: [{ path: "src/a.ts" }, { path: "src/b.ts" }] },
      details: {
        tool: "edit",
        status: { kind: "applied" },
        toolCallId: "edit-v05",
        evidenceRef: { inspectionId: "a".repeat(64), resourceIds: ["b".repeat(64)] },
        usedEvidence: ["b".repeat(64)],
        changedResources: [
          { resourceId: "b".repeat(64), canonicalPath: "src/a.ts", fullFileSha256: "c".repeat(64), coverage: "full-file" },
          { resourceId: "d".repeat(64), canonicalPath: "src/b.ts", fullFileSha256: "e".repeat(64), coverage: "full-file" },
        ],
        checks: { blocking: [], completed: [], advisory: [], skipped: [], timedOut: [] },
        diagnostics: [],
      },
      content: [{ type: "text", text: "edited" }],
    });

    expect(result).toBeUndefined();
    const context = handlers.context!({
      messages: [
        { role: "toolResult", toolCallId: "read-a", toolName: "read", content: [{ type: "text", text: "a" }] },
        { role: "toolResult", toolCallId: "read-b", toolName: "read", content: [{ type: "text", text: "b" }] },
      ],
    });
    expect(context.messages[0].content[0].text).toContain("Stale read context");
    expect(context.messages[1].content[0].text).toContain("Stale read context");
  });

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

    await handlers.tool_result!({ toolName: "read", toolCallId: "read-a", input: { path: "src/index.ts" }, content: [{ type: "text", text: "a" }] });
    await handlers.tool_result!({ toolName: "read", toolCallId: "read-b", input: { path: "src/hook.ts" }, content: [{ type: "text", text: "b" }] });
    await handlers.tool_result!({ toolName: "read", toolCallId: "read-unrelated", input: { path: "src/canonical-path.ts" }, content: [{ type: "text", text: "unrelated" }] });

    // Raw edit input with NO top-level path; changedResources carries the paths.
    await handlers.tool_result!({
      toolName: "edit",
      toolCallId: "edit-1",
      input: { edits: [{ path: "src/index.ts" }, { path: "src/hook.ts" }] },
      details: { changedResources: [{ canonicalPath: realpathSync(resolve(process.cwd(), "src/index.ts")) }, { canonicalPath: realpathSync(resolve(process.cwd(), "src/hook.ts")) }] },
      content: [{ type: "text", text: "edited" }],
    });

    const result = handlers.context!({
      messages: [
        { role: "toolResult", toolCallId: "read-a", toolName: "read", content: [{ type: "text", text: "a" }] },
        { role: "toolResult", toolCallId: "read-b", toolName: "read", content: [{ type: "text", text: "b" }] },
        { role: "toolResult", toolCallId: "read-unrelated", toolName: "read", content: [{ type: "text", text: "unrelated" }] },
      ],
    });

    expect(result.messages[0].content[0].text).toContain("Stale read context");
    expect(result.messages[1].content[0].text).toContain("Stale read context");
    expect(result.messages[2].content[0].text).toBe("unrelated");
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
    const impactMod = await import("../../src/runtime/post-edit-impact.js");
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

  it("transfer lifecycle: applied MutationDetails marks prior read stale and invalidates caches", async () => {
    const { handlers } = harness;
    const fsScan = await import("../../src/workspace/fs-scan-cache.js");
    const spy = vi.spyOn(fsScan, "invalidateFsScanCache");

    await handlers.tool_result!({ toolName: "read", toolCallId: "read-t", input: { path: "src/hook.ts" }, content: [{ type: "text", text: "old" }] });

    const canonical = realpathSync(resolve(process.cwd(), "src/hook.ts"));
    const appliedTransfer = {
      tool: "transfer",
      status: { kind: "applied" },
      toolCallId: "transfer-1",
      evidenceRef: { inspectionId: "a".repeat(64), resourceIds: ["b".repeat(64)] },
      usedEvidence: ["b".repeat(64)],
      changedResources: [{ resourceId: "b".repeat(64), canonicalPath: canonical, fullFileSha256: "c".repeat(64), coverage: "full-file" }],
      checks: { blocking: [], completed: [], advisory: [], skipped: [], timedOut: [] },
      diagnostics: [],
    };
    expect(changedPathsFromDetails(appliedTransfer)).toEqual([canonical]);

    await handlers.tool_result!({
      toolName: "transfer",
      toolCallId: "transfer-1",
      input: {},
      details: appliedTransfer,
      content: [{ type: "text", text: "transferred" }],
    });

    expect(spy).toHaveBeenCalled();
    spy.mockRestore();

    const context = handlers.context!({
      messages: [
        { role: "toolResult", toolCallId: "read-t", toolName: "read", content: [{ type: "text", text: "old" }] },
      ],
    });
    expect(context.messages[0].content[0].text).toContain("Stale read context");
  });

  it("rejected transfer with input.path does not close LSP files", async () => {
    const { handlers } = harness;
    const bridgeMod = await import("../../src/lsp/lsp-bridge.js");
    const closeFile = vi.fn().mockResolvedValue(undefined);
    const spy = vi.spyOn(bridgeMod, "getLSPBridge").mockResolvedValue({ closeFile } as never);
    try {
      await handlers.tool_result!({
        toolName: "transfer",
        toolCallId: "transfer-noclose",
        input: { path: "src/hook.ts" },
        details: {
          tool: "transfer",
          status: { kind: "rejected", reason: "stale" },
          toolCallId: "transfer-noclose",
          evidenceRef: { inspectionId: "a".repeat(64), resourceIds: ["b".repeat(64)] },
          usedEvidence: ["b".repeat(64)],
          changedResources: [{ resourceId: "b".repeat(64), canonicalPath: realpathSync(resolve(process.cwd(), "src/hook.ts")), fullFileSha256: "c".repeat(64), coverage: "full-file" }],
          checks: { blocking: [], completed: [], advisory: [], skipped: [], timedOut: [] },
          diagnostics: [],
        },
        content: [{ type: "text", text: "transfer rejected" }],
      });
      expect(closeFile).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("does not mark read context stale for rejected transfer lifecycle details", async () => {
    const { handlers } = harness;

    await handlers.tool_result!({ toolName: "read", toolCallId: "read-t2", input: { path: "src/hook.ts" }, content: [{ type: "text", text: "old" }] });
    await handlers.tool_result!({
      toolName: "transfer",
      toolCallId: "transfer-2",
      input: {},
      details: {
        tool: "transfer",
        status: { kind: "rejected", reason: "stale" },
        toolCallId: "transfer-2",
        evidenceRef: { inspectionId: "a".repeat(64), resourceIds: ["b".repeat(64)] },
        usedEvidence: ["b".repeat(64)],
        changedResources: [{ resourceId: "b".repeat(64), canonicalPath: realpathSync(resolve(process.cwd(), "src/hook.ts")), fullFileSha256: "c".repeat(64), coverage: "full-file" }],
        checks: { blocking: [], completed: [], advisory: [], skipped: [], timedOut: [] },
        diagnostics: [],
      },
      content: [{ type: "text", text: "transfer rejected" }],
    });

    const result = handlers.context!({
      messages: [{ role: "toolResult", toolCallId: "read-t2", toolName: "read", content: [{ type: "text", text: "old" }] }],
    });
    expect(result).toBeUndefined();
  });
});
