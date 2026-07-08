import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, beforeEach } from "vitest";
import { resetSessionState } from "../../hook.js";
import { GUARD_HINT_DEEP_SEARCH } from "../../bash-context-guard.js";

// Import after resetting module state to avoid cross-test contamination
let registerExtension: (pi: ExtensionAPI) => void;

beforeEach(async () => {
  resetSessionState();
  // Dynamic import to get fresh module reference
  registerExtension = (await import("../../index.js")).default;
});

describe("index extension wiring", () => {
  it("registers all tools for the Pi extension path", () => {
    const registered: { name: string; execute: unknown }[] = [];
    const handlers: Record<string, (...args: unknown[]) => unknown> = {};

    const api = {
      registerTool: (definition: { name: string; execute: unknown }) => {
        registered.push(definition);
      },
      on: (event: string, handler: (...args: unknown[]) => unknown) => {
        handlers[event] = handler;
      },
    } as unknown as ExtensionAPI;

    registerExtension(api);

    const names = registered.map((t) => t.name);
    expect(names).toContain("read");
    expect(names).toContain("read_files");
    expect(names).toContain("search");
    expect(names).toContain("repo_map");
    expect(names).toContain("symbol");
    expect(names).toContain("skill");
    expect(names).not.toContain("intent_read");
    expect(names).not.toContain("find_symbol");
    expect(names).not.toContain("symbol_info");
    expect(names).not.toContain("deep_search");
    expect(names.every((name) => !name.startsWith("smartread_"))).toBe(true);
    // context_graph is not exposed as an agent-facing tool
    expect(names).not.toContain("context_graph");
    // graph_mutate and git_notes are experimental — disabled by default
    expect(names).not.toContain("graph_mutate");
    expect(names).not.toContain("git_notes_read");
    expect(names).not.toContain("git_notes_write");
    expect(registered.every((t) => typeof t.execute === "function")).toBe(true);

    // Should also register session hooks
    expect(handlers.session_start).toBeDefined();
    expect(handlers.before_agent_start).toBeDefined();
    expect(handlers.session_shutdown).toBeDefined();
  });

  it("guards large deep search tool results", () => {
    const registered: { name: string; execute: unknown }[] = [];
    const handlers: Record<string, (...args: any[]) => any> = {};

    const api = {
      registerTool: (definition: { name: string; execute: unknown }) => {
        registered.push(definition);
      },
      on: (event: string, handler: (...args: any[]) => any) => {
        handlers[event] = handler;
      },
    } as unknown as ExtensionAPI;

    registerExtension(api);

    const text = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n");
    const result = handlers.tool_result!({
      toolName: "search",
      toolCallId: "deep-search-1",
      input: { query: "architecture", depth: "deep" },
      content: [{ type: "text", text }],
    });

    expect(result.content[0].text).toContain("[Bash context guard: preview]");
    expect(result.content[0].text).toContain(GUARD_HINT_DEEP_SEARCH);
    expect(result.details.bashContextGuard.toolName).toBe("search");
  });

  it("applies bash context guard AFTER doom-loop warning injection (ordering fix)", () => {
    const handlers: Record<string, (...args: any[]) => any> = {};
    const api = {
      registerTool: () => {},
      on: (event: string, handler: (...args: any[]) => any) => {
        handlers[event] = handler;
      },
    } as unknown as ExtensionAPI;

    registerExtension(api);

    // Large output that triggers doom-loop identical-tail AND exceeds guard thresholds
    const largeText = Array.from({ length: 4000 }, (_, i) => `line ${i}`).join("\n");
    const input = { path: "/large.ts" };
    for (let i = 1; i <= 3; i++) {
      handlers.tool_call!({
        toolName: "read",
        toolCallId: `read-${i}`,
        input,
      });
    }
    // First two: side effects only (build doom-loop state)
    handlers.tool_result!({
      toolName: "read",
      toolCallId: "read-1",
      input,
      content: [{ type: "text", text: largeText }],
    });
    handlers.tool_result!({
      toolName: "read",
      toolCallId: "read-2",
      input,
      content: [{ type: "text", text: largeText }],
    });
    const result3 = handlers.tool_result!({
      toolName: "read",
      toolCallId: "read-3",
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
      // Should NOT contain all 3000 lines (trimmed)
      expect(text).not.toContain("line 2999");
    }
  });

  it("marks read context stale after write results mutate the same file", () => {
    const handlers: Record<string, (...args: any[]) => any> = {};
    const api = {
      registerTool: () => {},
      on: (event: string, handler: (...args: any[]) => any) => {
        handlers[event] = handler;
      },
    } as unknown as ExtensionAPI;

    registerExtension(api);

    handlers.tool_result!({
      toolName: "read",
      toolCallId: "read-1",
      input: { path: "src/foo.ts" },
      content: [{ type: "text", text: "export const value = 1;" }],
    });
    handlers.tool_result!({
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
});
