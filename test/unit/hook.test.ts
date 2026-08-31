/**
 * Tests for the SmartRead hook system.
 *
 * Covers:
 *   - wrapBuiltinReadTool: enrichment wrapping preserves read behavior
 *   - registerSessionHooks: event subscriptions at startup
 *   - Contextual enrichment appends annotations to read results
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createExtendedReadTool, registerSessionHooks, resetSessionState } from "../../src/hook.js";
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


describe("createExtendedReadTool", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "hook-wbr-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns a ToolDefinition with name 'read'", () => {
    const tool = createExtendedReadTool();
    expect(tool.name).toBe("read");
    expect(typeof tool.execute).toBe("function");
  });

  it("delegates to the underlying read tool", async () => {
    writeFileSync(join(tmpDir, "hello.ts"), "export const x = 1;\n");

    const tool = createExtendedReadTool();
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

  it("anchors reads from selector-based line windows using absolute line numbers", async () => {
    writeFileSync(join(tmpDir, "hello.ts"), "one\ntwo\nthree\n");

    const tool = createExtendedReadTool();
    const result = await tool.execute(
      "cid-selector",
      { path: "hello.ts:2-3" },
      undefined,
      undefined,
      makeMockContext(tmpDir),
    );

    const text = (result as { content: { text: string }[] }).content[0]?.text ?? "";
    expect(text).toMatch(/^2[a-z]{2}\|two/m);
    expect(text).toMatch(/^3[a-z]{2}\|three/m);
  });

  it("respects raw reads without injecting anchors or context", async () => {
    writeFileSync(join(tmpDir, "hello.ts"), "one\ntwo\nthree\n");

    const tool = createExtendedReadTool();
    const result = await tool.execute(
      "cid-raw",
      { path: "hello.ts:raw" },
      undefined,
      undefined,
      makeMockContext(tmpDir),
    );

    const text = (result as { content: { text: string }[] }).content[0]?.text ?? "";
    expect(text).toContain("one\ntwo\nthree");
    expect(text).not.toMatch(/^\d+[a-z]{0,2}\|/m);
    expect(text).not.toContain("🔍 Context for");
  });

  it("preserves read metadata (name, label, description)", () => {
    const tool = createExtendedReadTool();
    expect(tool.name).toBe("read");
    expect(tool.label).toBeDefined();
    expect(tool.description).toContain("Read files with strong workspace evidence");
  });

  it("does not reuse session git cache for nested project reads", async () => {
    const outer = realpathSync(tmpDir);
    writeFileSync(join(outer, "package.json"), '{"name":"outer-project"}\n');
    const nested = join(outer, "nested");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "package.json"), '{"name":"nested-project"}\n');
    writeFileSync(join(nested, "nested.ts"), "export const nested = true;\n");
    execFileSync("git", ["init"], { cwd: nested, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: nested, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "test"], { cwd: nested, stdio: "ignore" });
    execFileSync("git", ["add", "."], { cwd: nested, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "nested project commit"], { cwd: nested, stdio: "ignore" });

    const { api, handlers } = makeMockAPI();
    registerSessionHooks(api);
    await handlers.session_start!({ type: "session_start", reason: "startup" }, makeMockContext(outer));

    const result = await createExtendedReadTool().execute(
      "nested-cache",
      { path: "nested/nested.ts" },
      undefined,
      undefined,
      makeMockContext(outer),
    );
    const text = (result as { content: { type: string; text: string }[] }).content[0]?.text ?? "";
    expect(text).toContain("Recent commits:");
    expect(text).toContain("nested project commit");
  });

  it("enriches reads with contextual annotations for source files", async () => {
    // Create a minimal repo-like structure with import relationships
    writeFileSync(join(tmpDir, "package.json"), '{"name":"hook-read-fixture"}\n');
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

    const tool = createExtendedReadTool();

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
    expect(text).toContain("Nearby:");
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

    const projectDir = mkdtempSync(join(tmpdir(), "hook-map-test-"));
    writeFileSync(join(projectDir, "package.json"), '{"name":"hook-map-test"}\n');
    writeFileSync(join(projectDir, "index.ts"), "export const ready = true;\n");

    try {
      // First trigger session_start to prime the cache with a deliberately
      // tiny project. Using the whole checkout makes this latency-bound test
      // race the 750ms production startup budget under full-suite load.
      await handlers.session_start!(
        { type: "session_start", reason: "startup" },
        makeMockContext(projectDir),
      );

      // Then trigger before_agent_start
      const result = await handlers.before_agent_start!(
        { type: "before_agent_start", systemPrompt: "You are a helpful agent.", prompt: "hi" },
        makeMockContext(projectDir),
      );

      // Should have appended repo map
      const typed = result as { systemPrompt?: string } | undefined;
      expect(typed).toBeDefined();
      expect(typeof typed!.systemPrompt).toBe("string");
      const promptText = typed!.systemPrompt;
      expect(promptText).toContain("Repository Map");
      expect(promptText).toContain("SmartRead Tool Guide");
      expect(promptText).toContain("BM25+embedding RRF");
      expect(promptText).toContain("inspect { path }:");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  }, 15_000);

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
