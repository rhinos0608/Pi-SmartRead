import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, beforeEach } from "vitest";
import { resetSessionState } from "../../hook.js";

// Import after resetting module state to avoid cross-test contamination
let registerExtension: (pi: ExtensionAPI) => void;

beforeEach(async () => {
  resetSessionState();
  // Dynamic import to get fresh module reference
  registerExtension = (await import("../../index.js")).default;
});

describe("index extension wiring", () => {
  it("registers all tools: read, read_multiple_files, intent_read, repo_map, search", () => {
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
    expect(names).toContain("read_multiple_files");
    expect(names).toContain("intent_read");
    expect(names).toContain("repo_map");
    expect(names).toContain("search");
    expect(registered.every((t) => typeof t.execute === "function")).toBe(true);

    // Should also register session hooks
    expect(handlers.session_start).toBeDefined();
    expect(handlers.before_agent_start).toBeDefined();
    expect(handlers.session_shutdown).toBeDefined();
  });
});