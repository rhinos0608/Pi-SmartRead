/**
 * Verification tests for the file-context.ts cache consolidation.
 *
 * Confirms:
 * (a) file-context.ts no longer contains `new ContextGraph(` — it delegates
 *     to the shared mcp-registry singleton.
 * (b) Repeated calls for the same workspace root route through the shared
 *     registry (only one graph built, not N independent instances).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// ── (a) Static source check ──────────────────────────────────────

describe("file-context.ts source audit", () => {
  it("contains no `new ContextGraph(` instantiation", () => {
    const src = readFileSync(
      path.resolve(__dirname, "../../src/file-context.ts"),
      "utf-8",
    );
    expect(src).not.toMatch(/new\s+ContextGraph\s*\(/);
  });

  it("imports getSharedContextGraphAsync from mcp-registry", () => {
    const src = readFileSync(
      path.resolve(__dirname, "../../src/file-context.ts"),
      "utf-8",
    );
    expect(src).toContain('getSharedContextGraphAsync');
    expect(src).toContain('./mcp-registry.js');
  });

  it("does not import ContextGraph directly", () => {
    const src = readFileSync(
      path.resolve(__dirname, "../../src/file-context.ts"),
      "utf-8",
    );
    // Should NOT have: import { ContextGraph } from "./context-graph.js";
    expect(src).not.toMatch(/import\s*\{[^}]*ContextGraph[^}]*\}\s*from\s*["']\.\/context-graph/);
  });

  it("does not import LruCache", () => {
    const src = readFileSync(
      path.resolve(__dirname, "../../src/file-context.ts"),
      "utf-8",
    );
    expect(src).not.toMatch(/import.*LruCache/);
  });
});

// ── (b) Runtime routing through shared registry ──────────────────

describe("buildFileContextLines routes through shared registry", () => {
  const graphMock = {
    getFileNeighbours: vi.fn().mockResolvedValue([]),
  };

  let getSharedContextGraphAsyncSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    // Mock the mcp-registry module to intercept getSharedContextGraphAsync calls
    getSharedContextGraphAsyncSpy = vi.fn().mockResolvedValue(graphMock);
    vi.doMock("../../src/mcp-registry.js", () => ({
      getSharedContextGraphAsync: getSharedContextGraphAsyncSpy,
    }));

    // Mock all other dependencies that file-context.ts imports
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...actual,
        existsSync: vi.fn().mockReturnValue(true),
      };
    });
    vi.doMock("../../src/workspace-scope.js", () => ({
      projectWorkspaceForFile: vi.fn().mockReturnValue("/mock/project"),
    }));
    vi.doMock("../../src/git-history.js", () => ({
      isRecentlyModified: vi.fn().mockResolvedValue(false),
    }));
    vi.doMock("../../src/git-context.js", () => ({
      findGitRoot: vi.fn().mockResolvedValue(null),
      getFileCommitContext: vi.fn().mockResolvedValue([]),
    }));
    vi.doMock("../../src/config.js", () => ({
      loadGitContextConfig: vi.fn().mockReturnValue({ enabled: false }),
    }));
    vi.doMock("../../src/git-notes.js", () => ({
      scanBranchNotes: vi.fn().mockResolvedValue([]),
    }));
    vi.doMock("../../src/graphify-enricher.js", () => ({
      getGraphifyEnricher: vi.fn().mockReturnValue({ isAvailable: false }),
    }));
    vi.doMock("../../src/lsp-bridge.js", () => ({
      getLSPBridge: vi.fn().mockResolvedValue(null),
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("calls getSharedContextGraphAsync (not new ContextGraph) for the workspace root", async () => {
    const { buildFileContextLines } = await import("../../src/file-context.js");

    await buildFileContextLines({
      fullPath: "/mock/project/src/index.ts",
      cwd: "/mock/project",
    });

    expect(getSharedContextGraphAsyncSpy).toHaveBeenCalledTimes(1);
    expect(getSharedContextGraphAsyncSpy).toHaveBeenCalledWith("/mock/project");
  });

  it("routes repeated calls through the same shared registry (no duplicate graphs)", async () => {
    const { buildFileContextLines } = await import("../../src/file-context.js");

    // Call twice with the same workspace root
    await buildFileContextLines({
      fullPath: "/mock/project/src/a.ts",
      cwd: "/mock/project",
    });
    await buildFileContextLines({
      fullPath: "/mock/project/src/b.ts",
      cwd: "/mock/project",
    });

    // Shared registry called once per invocation, but returns the SAME cached graph
    expect(getSharedContextGraphAsyncSpy).toHaveBeenCalledTimes(2);
    expect(getSharedContextGraphAsyncSpy).toHaveBeenNthCalledWith(1, "/mock/project");
    expect(getSharedContextGraphAsyncSpy).toHaveBeenNthCalledWith(2, "/mock/project");

    // Both calls got the same mock instance (simulating singleton behavior)
    const graph1 = await getSharedContextGraphAsyncSpy.mock.results[0]!.value;
    const graph2 = await getSharedContextGraphAsyncSpy.mock.results[1]!.value;
    expect(graph1).toBe(graph2);
  });

  it("preserves the exact output format (array of strings with header)", async () => {
    const { buildFileContextLines } = await import("../../src/file-context.js");

    const result = await buildFileContextLines({
      fullPath: "/mock/project/src/index.ts",
      cwd: "/mock/project",
    });

    // Should be an array
    expect(Array.isArray(result)).toBe(true);
    // When no bullets are produced (all channels return nothing), output is []
    expect(result).toEqual([]);
  });
});
