/**
 * Tests for the repo-map hook system.
 *
 * Covers: intercept behavior, state scoping, skip-map escape hatch,
 * explicit repo_map suppression, concurrency guard, failure fallback,
 * and cwd normalization.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { wrapReadManyTool, wrapIntentReadTool, markRepoMapExplicitlyCalled } from "../../hook.js";
import type { ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";

// ── Helpers ───────────────────────────────────────────────────────

function makeMockContext(cwd: string): ExtensionContext {
  return { cwd } as unknown as ExtensionContext;
}

function makeWrappedTool(execFn: Function): ToolDefinition {
  return wrapReadManyTool({
    name: "read_multiple_files",
    label: "read_multiple_files",
    description: "test",
    parameters: { type: "object", properties: {} },
    execute: execFn as () => Promise<unknown>,
  } as unknown as ToolDefinition);
}

function makeIntentWrappedTool(execFn: Function): ToolDefinition {
  return wrapIntentReadTool({
    name: "intent_read",
    label: "intent_read",
    description: "test",
    parameters: { type: "object", properties: {} },
    execute: execFn as () => Promise<unknown>,
  } as unknown as ToolDefinition);
}

describe("hook — repo-map interceptor", () => {
  let tmpDir: string;
  let calls: number;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "hook-test-"));
    calls = 0;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makePassthroughResult() {
    return {
      content: [{ type: "text" as const, text: "ORIGINAL_READ" }],
      details: { fileRead: true },
    };
  }

  // ── 1. First read returns intercept ──

  it("first read returns a repo-map intercept, not original read", async () => {
    writeFileSync(join(tmpDir, "main.ts"), "export const x = 1;\n");

    const tool = makeWrappedTool(() => {
      calls++;
      return makePassthroughResult();
    });

    const result = await tool.execute(
      "cid-1",
      { directory: tmpDir },
      undefined,
      undefined,
      makeMockContext(tmpDir),
    ) as { content: { text: string }[]; details: Record<string, unknown> };

    const text = result.content?.[0]?.text ?? "";
    expect(text).toContain("REPO MAP");
    expect(text).toContain("INTERCEPTED");
    expect(result.details?.intercepted).toBe(true);
    expect(calls).toBe(0); // Underlying tool was NOT called
  });

  // ── 2. Second read passes through ──

  it("second read calls the underlying tool", async () => {
    writeFileSync(join(tmpDir, "main.ts"), "export const x = 1;\n");

    const tool = makeWrappedTool(() => {
      calls++;
      return makePassthroughResult();
    });

    // First call — intercepted
    await tool.execute(
      "cid-1",
      { directory: tmpDir },
      undefined,
      undefined,
      makeMockContext(tmpDir),
    );

    // Second call — passes through
    const result = await tool.execute(
      "cid-2",
      { directory: tmpDir },
      undefined,
      undefined,
      makeMockContext(tmpDir),
    ) as { content: { text: string }[]; details: Record<string, unknown> };

    const text = result.content?.[0]?.text ?? "";
    expect(text).toBe("ORIGINAL_READ");
    expect(result.details?.intercepted).toBeUndefined();
    expect(calls).toBe(1);
  });

  // ── 3. skip-map bypasses interception ──

  it("_meta.skipRepoMapHook bypasses interception", async () => {
    writeFileSync(join(tmpDir, "main.ts"), "export const x = 1;\n");

    const tool = makeWrappedTool(() => {
      calls++;
      return makePassthroughResult();
    });

    const result = await tool.execute(
      "cid-1",
      { directory: tmpDir, _meta: { skipRepoMapHook: true } },
      undefined,
      undefined,
      makeMockContext(tmpDir),
    ) as { content: { text: string }[] };

    const text = result.content?.[0]?.text ?? "";
    expect(text).toBe("ORIGINAL_READ");
    expect(calls).toBe(1);
  });

  // ── 4. Explicit repo_map before read suppresses hook ──

  it("explicit repo_map before first read suppresses interception", async () => {
    writeFileSync(join(tmpDir, "main.ts"), "export const x = 1;\n");

    // Simulate explicit repo_map call
    markRepoMapExplicitlyCalled(tmpDir);

    const tool = makeWrappedTool(() => {
      calls++;
      return makePassthroughResult();
    });

    const result = await tool.execute(
      "cid-1",
      { directory: tmpDir },
      undefined,
      undefined,
      makeMockContext(tmpDir),
    ) as { content: { text: string }[] };

    const text = result.content?.[0]?.text ?? "";
    expect(text).toBe("ORIGINAL_READ");
    expect(calls).toBe(1);
  });

  // ── 5. State scoped by repo key ──

  it("state is scoped by repo key (different repos don't interfere)", async () => {
    const repoA = join(tmpDir, "repoA");
    const repoB = join(tmpDir, "repoB");
    mkdirSync(repoA, { recursive: true });
    mkdirSync(repoB, { recursive: true });
    writeFileSync(join(repoA, "main.ts"), "export const a = 1;\n");
    writeFileSync(join(repoB, "main.ts"), "export const b = 2;\n");

    const tool = makeWrappedTool(() => {
      calls++;
      return makePassthroughResult();
    });

    // First call in repoA — intercepted
    const r1 = await tool.execute(
      "cid-1",
      { directory: repoA },
      undefined,
      undefined,
      makeMockContext(repoA),
    ) as { details: Record<string, unknown> };
    expect(r1.details?.intercepted).toBe(true);

    // First call in repoB — intercepted (different repo)
    const r2 = await tool.execute(
      "cid-2",
      { directory: repoB },
      undefined,
      undefined,
      makeMockContext(repoB),
    ) as { details: Record<string, unknown> };
    expect(r2.details?.intercepted).toBe(true);

    // Second call in repoA — pass through
    const r3 = await tool.execute(
      "cid-3",
      { directory: repoA },
      undefined,
      undefined,
      makeMockContext(repoA),
    ) as { content: { text: string }[] };
    expect(r3.content?.[0]?.text).toBe("ORIGINAL_READ");

    // Underlying tool was called exactly once (second repoA call)
    expect(calls).toBe(1);
  });

  // ── 6. Explicit repo_map in repo A does not suppress repo B ──

  it("explicit repo_map in one repo does not suppress hook in another", async () => {
    const repoA = join(tmpDir, "repoA");
    const repoB = join(tmpDir, "repoB");
    mkdirSync(repoA, { recursive: true });
    mkdirSync(repoB, { recursive: true });
    writeFileSync(join(repoA, "main.ts"), "export const a = 1;\n");
    writeFileSync(join(repoB, "main.ts"), "export const b = 2;\n");

    // Mark repoA as explicitly called, but NOT repoB
    markRepoMapExplicitlyCalled(repoA);

    const tool = makeWrappedTool(() => {
      calls++;
      return makePassthroughResult();
    });

    // repoA — pass through (explicitly called)
    const r1 = await tool.execute(
      "cid-1",
      { directory: repoA },
      undefined,
      undefined,
      makeMockContext(repoA),
    ) as { content: { text: string }[] };
    expect(r1.content?.[0]?.text).toBe("ORIGINAL_READ");

    // repoB — intercepted (not explicitly called)
    const r2 = await tool.execute(
      "cid-2",
      { directory: repoB },
      undefined,
      undefined,
      makeMockContext(repoB),
    ) as { details: Record<string, unknown> };
    expect(r2.details?.intercepted).toBe(true);

    expect(calls).toBe(1); // Only repoA's read passed through
  });

  // ── 7. Concurrent first reads share in-flight promise ──

  it("concurrent first reads do not duplicate generation", async () => {
    writeFileSync(join(tmpDir, "main.ts"), "export const x = 1;\n");

    const tool = makeWrappedTool(() => {
      calls++;
      return makePassthroughResult();
    });

    // Fire two concurrent first reads
    const [r1, r2] = await Promise.all([
      tool.execute(
        "cid-1",
        { directory: tmpDir },
        undefined,
        undefined,
        makeMockContext(tmpDir),
      ),
      tool.execute(
        "cid-2",
        { directory: tmpDir },
        undefined,
        undefined,
        makeMockContext(tmpDir),
      ),
    ]) as { details: Record<string, unknown> }[];

    // Both should return intercept responses
    expect(r1!.details?.intercepted).toBe(true);
    expect(r2!.details?.intercepted).toBe(true);
    expect(calls).toBe(0); // Underlying tool never called
  });

  // ── 8. Empty repo (no source files) passes through ──

  it("empty repo (no source files) passes through to original read", async () => {
    // No source files in tmpDir
    const tool = makeWrappedTool(() => {
      calls++;
      return makePassthroughResult();
    });

    const result = await tool.execute(
      "cid-1",
      { directory: tmpDir },
      undefined,
      undefined,
      makeMockContext(tmpDir),
    ) as { content: { text: string }[]; details: Record<string, unknown> };

    // Should have passthrough since hook checks result.map === "" and therefore falls through
    // We just verify the hook is in the flow — with no files, compact map returns empty
    const text = result.content?.[0]?.text ?? "";
    expect(text).toBe("ORIGINAL_READ");
    expect(calls).toBe(1);
  });

  // ── 9. intent_read tool also intercepts first call ──

  it("intent_read first call also intercepts for repo map", async () => {
    writeFileSync(join(tmpDir, "main.ts"), "export const x = 1;\n");

    const tool = makeIntentWrappedTool(() => {
      calls++;
      return makePassthroughResult();
    });

    const result = await tool.execute(
      "cid-1",
      { directory: tmpDir },
      undefined,
      undefined,
      makeMockContext(tmpDir),
    ) as { content: { text: string }[]; details: Record<string, unknown> };

    const text = result.content?.[0]?.text ?? "";
    expect(text).toContain("INTENT_READ INTERCEPTED");
    expect(result.details?.intercepted).toBe(true);
    expect(calls).toBe(0);
  });

  // ── 10. cwd normalization treats nested paths in same repo ──

  it("cwd normalization treats nested paths in same repo consistently", async () => {
    // Create a .git directory to make this look like a git repo
    mkdirSync(join(tmpDir, ".git"), { recursive: true });
    mkdirSync(join(tmpDir, "packages", "foo"), { recursive: true });
    writeFileSync(join(tmpDir, "main.ts"), "export const x = 1;\n");
    writeFileSync(join(tmpDir, "packages", "foo", "helper.ts"), "export const y = 2;\n");

    const tool = makeWrappedTool(() => {
      calls++;
      return makePassthroughResult();
    });

    // Call from root — intercepted
    const r1 = await tool.execute(
      "cid-1",
      { directory: tmpDir },
      undefined,
      undefined,
      makeMockContext(tmpDir),
    ) as { details: Record<string, unknown> };
    expect(r1.details?.intercepted).toBe(true);

    // Call from nested path — should pass through (same git root key)
    const r2 = await tool.execute(
      "cid-2",
      { directory: join(tmpDir, "packages", "foo") },
      undefined,
      undefined,
      makeMockContext(join(tmpDir, "packages", "foo")),
    ) as { content: { text: string }[] };
    expect(r2.content?.[0]?.text).toBe("ORIGINAL_READ");

    expect(calls).toBe(1);
  });

  // ── 11. Intent read state is shared with read_many ──

  it("intent_read and read_many share intercept state", async () => {
    writeFileSync(join(tmpDir, "main.ts"), "export const x = 1;\n");

    // First call with read_many — intercepted
    const rmTool = makeWrappedTool(() => {
      calls++;
      return makePassthroughResult();
    });
    const irTool = makeIntentWrappedTool(() => {
      calls++;
      return makePassthroughResult();
    });

    const r1 = await rmTool.execute(
      "cid-1",
      { directory: tmpDir },
      undefined,
      undefined,
      makeMockContext(tmpDir),
    ) as { details: Record<string, unknown> };
    expect(r1.details?.intercepted).toBe(true);

    // Second call with intent_read — should pass through (same repo, map already shown)
    const r2 = await irTool.execute(
      "cid-2",
      { directory: tmpDir },
      undefined,
      undefined,
      makeMockContext(tmpDir),
    ) as { content: { text: string }[] };
    expect(r2.content?.[0]?.text).toBe("ORIGINAL_READ");

    expect(calls).toBe(1);
  });
});
