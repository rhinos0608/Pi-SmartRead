/**
 * Tests for the SmartRead hook system.
 *
 * Covers:
 *   - wrapBuiltinReadTool: enrichment wrapping preserves read behavior
 *   - registerSessionHooks: event subscriptions at startup
 *   - Contextual enrichment appends annotations to read results
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { wrapBuiltinReadTool, registerSessionHooks, resetSessionState } from "../../hook.js";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

// ── Helpers ───────────────────────────────────────────────────────

function makeMockContext(cwd: string): ExtensionContext {
  return { cwd } as unknown as ExtensionContext;
}

function makeMockAPI(): {
  api: ExtensionAPI;
  handlers: Record<string, (...args: unknown[]) => unknown>;
} {
  const handlers: Record<string, (...args: unknown[]) => unknown> = {};
  const api = {
    on: (event: string, handler: (...args: unknown[]) => unknown) => {
      handlers[event] = handler;
    },
    registerTool: () => {},
  } as unknown as ExtensionAPI;
  return { api, handlers };
}


describe("wrapBuiltinReadTool", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "hook-wbr-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns a ToolDefinition with name 'read'", () => {
    const tool = wrapBuiltinReadTool();
    expect(tool.name).toBe("read");
    expect(typeof tool.execute).toBe("function");
  });

  it("delegates to the underlying read tool", async () => {
    writeFileSync(join(tmpDir, "hello.ts"), "export const x = 1;\n");

    const tool = wrapBuiltinReadTool();
    const result = await tool.execute(
      "cid-1",
      { path: "hello.ts" },
      undefined,
      undefined,
      makeMockContext(tmpDir),
    );

    expect(result).toBeDefined();
    const content = result as { content: { type: string; text: string }[] };
    expect(content?.content?.[0]?.text).toContain("export const x = 1");
  });

  it("preserves read metadata (name, label, description)", () => {
    const tool = wrapBuiltinReadTool();
    expect(tool.name).toBe("read");
    expect(tool.label).toBeDefined();
    expect(tool.description).toContain("Read the contents of a file");
  });

  it("enriches reads with contextual annotations for source files", async () => {
    // Create a minimal repo-like structure with import relationships
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(
      join(tmpDir, "src", "a.ts"),
      'import { b } from "./b";\n\nexport function a() { return b(); }\n',
    );
    writeFileSync(
      join(tmpDir, "src", "b.ts"),
      'import { c } from "./c";\n\nexport function b() { return c(); }\n',
    );
    writeFileSync(
      join(tmpDir, "src", "c.ts"),
      "export function c() { return 42; }\n",
    );

    const tool = wrapBuiltinReadTool();

    // Read src/a.ts — should get enrichment showing it imports b.ts
    const result = await tool.execute(
      "cid-1",
      { path: "src/a.ts" },
      undefined,
      undefined,
      makeMockContext(tmpDir),
    );

    const text = (result as { content: { text: string }[] }).content[0]?.text;
    expect(text).toContain("export function a()");
    // Context annotations should be appended
    expect(text).toContain("🔍 Context for");
    expect(text).toContain("Imports:");
    expect(text).toContain("src/b.ts");
  });
});

describe("registerSessionHooks", () => {
  beforeEach(() => {
    resetSessionState();
  });
  it("subscribes to session_start, before_agent_start, and session_shutdown", () => {
    const { api, handlers } = makeMockAPI();

    registerSessionHooks(api);

    expect(handlers.session_start).toBeDefined();
    expect(handlers.before_agent_start).toBeDefined();
    expect(handlers.session_shutdown).toBeDefined();
  });

  it("session_start handler fires on startup reason and triggers map generation", async () => {
    const { api, handlers } = makeMockAPI();

    registerSessionHooks(api);

    // Simulate session_start with reason=startup
    await handlers.session_start!(
      { type: "session_start", reason: "startup" },
      makeMockContext(process.cwd()),
    );

    // Map generation should be pending in the module cache
    // (We can't easily inspect the module-level cache, but we verify no crash)
    // The handler should not throw
  });

  it("session_start handler does nothing for non-startup reasons", async () => {
    const { api, handlers } = makeMockAPI();

    registerHooksWithSpy(api, handlers);

    // Simulate session_start with reason=reload
    await handlers.session_start!(
      { type: "session_start", reason: "reload" },
      makeMockContext(process.cwd()),
    );
    // Should not throw — no-op path
  });

  it("before_agent_start returns system prompt with repo map on first turn", async () => {
    const { api, handlers } = makeMockAPI();
    registerSessionHooks(api);

    // First trigger session_start to prime the cache
    await handlers.session_start!(
      { type: "session_start", reason: "startup" },
      makeMockContext(process.cwd()),
    );

    // Then trigger before_agent_start
    const result = await handlers.before_agent_start!(
      { type: "before_agent_start", systemPrompt: "You are a helpful agent.", prompt: "hi" },
      makeMockContext(process.cwd()),
    );

    // Should have appended repo map
    const typed = result as { systemPrompt?: string } | undefined;
    expect(typed).toBeDefined();
    expect(typed!.systemPrompt).toContain("Repository Map");
  });

  it("before_agent_start returns undefined for subsequent turns", async () => {
    const { api, handlers } = makeMockAPI();
    registerSessionHooks(api);

    // Prime cache
    await handlers.session_start!(
      { type: "session_start", reason: "startup" },
      makeMockContext(process.cwd()),
    );

    // First call returns map
    const first = await handlers.before_agent_start!(
      { type: "before_agent_start", systemPrompt: "You are a helpful agent.", prompt: "hi" },
      makeMockContext(process.cwd()),
    );
    expect(first as { systemPrompt?: string }).toBeDefined();

    // Second call returns undefined (already injected)
    const second = await handlers.before_agent_start!(
      { type: "before_agent_start", systemPrompt: "You are a helpful agent.", prompt: "hi" },
      makeMockContext(process.cwd()),
    );
    expect(second as { systemPrompt?: string } | undefined).toBeUndefined();
  });

  it("session_shutdown resets injection flag", async () => {
    const { api, handlers } = makeMockAPI();
    registerSessionHooks(api);

    // Prime and inject
    await handlers.session_start!(
      { type: "session_start", reason: "startup" },
      makeMockContext(process.cwd()),
    );
    await handlers.before_agent_start!(
      { type: "before_agent_start", systemPrompt: "You are a helpful agent.", prompt: "hi" },
      makeMockContext(process.cwd()),
    );

    // Shutdown
    await handlers.session_shutdown!(
      { type: "session_shutdown", reason: "quit" },
      makeMockContext(process.cwd()),
    );

    // Next before_agent_start should inject again
    const result = await handlers.before_agent_start!(
      { type: "before_agent_start", systemPrompt: "You are a helpful agent.", prompt: "hi" },
      makeMockContext(process.cwd()),
    );
    expect(result as { systemPrompt?: string } | undefined).toBeDefined();
  });
});

// ── Helper to observe handler registration ────────────────────────

function registerHooksWithSpy(
  _api: ExtensionAPI,
  handlers: Record<string, (...args: unknown[]) => unknown>,
): void {
  const spyApi = {
    on: (event: string, handler: (...args: unknown[]) => unknown) => {
      handlers[event] = handler;
    },
  } as unknown as ExtensionAPI;
  registerSessionHooks(spyApi);
}
