import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

// Mock discovery helpers
vi.mock("../../src/file-discovery.js", () => ({
  findSrcFiles: vi.fn().mockResolvedValue(["/fake/repo/test.ts"]),
  discoverFiles: vi.fn().mockResolvedValue({
    files: ["/fake/repo/test.ts"],
    diagnostics: {
      profile: "code",
      root: "/fake/repo",
      directoriesVisited: 1,
      filesConsidered: 1,
      filesMatched: 1,
      filesSkippedIgnored: 0,
      dirsSkippedHardDenied: 0,
      filesSkippedBinary: 0,
      filesSkippedUnsupported: 0,
      ignoredDetails: [],
      ignoredDetailsTruncated: 0,
    },
  }),
  IGNORED_DETAILS_LIMIT: 500,
}));

// Mock resolveSymbol
vi.mock("../../src/symbol-resolver.js", () => ({
  resolveSymbol: vi.fn().mockResolvedValue({
    symbol: "TestSymbol",
    contextFile: "(none)",
    contextLine: 1,
    strategy: "test",
    stats: { totalFilesScanned: 0, parseTimeMs: 0 },
    definitions: [],
    references: [],
    bestDefinition: null,
  }),
}));

// Mock findCallers
vi.mock("../../src/callgraph.js", () => ({
  findCallers: vi.fn().mockResolvedValue([]),
}));

import registerRepoTools from "../../src/repomap-tool.js";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";

function makeExtensionAPI(): {
  registered: ToolDefinition[];
  api: { registerTool: (def: ToolDefinition) => void };
} {
  const registered: ToolDefinition[] = [];
  const api = {
    registerTool: (def: ToolDefinition) => {
      registered.push(def);
    },
  };
  return { registered, api };
}

function getTool(registered: ToolDefinition[], name: string): ToolDefinition {
  const tool = registered.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool "${name}" not registered`);
  return tool;
}

function makeExtensionContext(cwd?: string): ExtensionContext {
  return { cwd: cwd ?? "/fake/repo" } as unknown as ExtensionContext;
}

describe("search tool (consolidated)", () => {
  let registered: ToolDefinition[];
  let tool: ToolDefinition;

  beforeEach(() => {
    const { registered: reg, api } = makeExtensionAPI();
    registerRepoTools(api as any);
    registered = reg;
    tool = getTool(registered, "search");
  });

  // ── Registration ──

  it("is registered with the correct name", () => {
    expect(tool.name).toBe("search");
  });

  it("has a label and description", () => {
    expect(tool.label).toBe("search");
    expect(tool.description).toBeTruthy();
    expect(tool.description).toContain("search");
  });

  it("has an execute function", () => {
    expect(typeof tool.execute).toBe("function");
  });

  it("has a parameter schema", () => {
    const schema = tool.parameters as Record<string, unknown>;
    expect(schema).toBeDefined();
    expect(schema.type || (schema as any).oneOf).toBeDefined();
  });

  // ── Execution: default mode (grep) ──

  it("default mode returns no-defs message when no files match", async () => {
    const { discoverFiles } = await import("../../src/file-discovery.js");
    vi.mocked(discoverFiles).mockResolvedValue({
      files: [],
      diagnostics: {
        profile: "text",
        root: "/fake/repo",
        directoriesVisited: 1,
        filesConsidered: 0,
        filesMatched: 0,
        filesSkippedIgnored: 0,
        dirsSkippedHardDenied: 0,
        filesSkippedBinary: 0,
        filesSkippedUnsupported: 0,
        ignoredDetails: [],
        ignoredDetailsTruncated: 0,
      },
    });

    const result = await tool.execute(
      "call-1",
      { query: "something" },
      undefined,
      undefined,
      makeExtensionContext(),
    );

    const text: string = (result.content[0] as any).text as string;
    expect(text).toContain("No matches");
  });

  it("rejects empty query", async () => {
    await expect(
      tool.execute(
        "call-2",
        { query: "" },
        undefined,
        undefined,
        makeExtensionContext(),
      ),
    ).rejects.toThrow(/query/i);
  });

  // ── Execution: empty results ──

  it('returns no-matches message when no files match', async () => {
    const { discoverFiles } = await import("../../src/file-discovery.js");
    vi.mocked(discoverFiles).mockResolvedValue({
      files: [],
      diagnostics: {
        profile: "code",
        root: "/fake/repo",
        directoriesVisited: 1,
        filesConsidered: 0,
        filesMatched: 0,
        filesSkippedIgnored: 0,
        dirsSkippedHardDenied: 0,
        filesSkippedBinary: 0,
        filesSkippedUnsupported: 0,
        ignoredDetails: [],
        ignoredDetailsTruncated: 0,
      },
    });

    const result = await tool.execute(
      "call-3",
      { query: "something" },
      undefined,
      undefined,
      makeExtensionContext(),
    );

    const text: string = (result.content[0] as any).text as string;
    expect(text).toContain("No matches");
  });

  it('requires a query', async () => {
    await expect(
      tool.execute(
        "call-4",
        { query: "" },
        undefined,
        undefined,
        makeExtensionContext(),
      ),
    ).rejects.toThrow(/query/i);
  });

});
