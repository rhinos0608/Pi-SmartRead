import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

// ── Mock the RepoMap module before anything imports it ──
const mockSearchIdentifiers = vi.fn();

vi.mock("../../repomap.js", () => ({
  RepoMap: vi.fn().mockImplementation(() => ({
    searchIdentifiers: mockSearchIdentifiers,
  })),
}));

// Mock findSrcFiles to return test files
vi.mock("../../file-discovery.js", () => ({
  findSrcFiles: vi.fn().mockResolvedValue(["/fake/repo/test.ts"]),
}));

// Mock findCallers
vi.mock("../../callgraph.js", () => ({
  findCallers: vi.fn().mockResolvedValue([]),
}));

import registerRepoTools from "../../repomap-tool.js";
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

function getTool(
  registered: ToolDefinition[],
  name: string,
): ToolDefinition {
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
    mockSearchIdentifiers.mockReset();
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

  // ── Schema structure (Type.Union produces a oneOf schema) ──

  it("has a parameter schema (some or oneOf form)", () => {
    const schema = tool.parameters as Record<string, unknown>;
    expect(schema).toBeDefined();
    // Could be a Type.Object (one variant) or a Type.Union (oneOf)
    const ok =
      schema.properties !== undefined ||
      Array.isArray((schema as any).oneOf) ||
      Object.keys(schema).length > 0;
    expect(ok).toBe(true);
  });

  // ── Execution: mode="symbols" ──

  it('mode="symbols" returns no-symbols message when searchIdentifiers returns []', async () => {
    mockSearchIdentifiers.mockResolvedValue([]);

    const result = await tool.execute(
      "call-1",
      { mode: "symbols", query: "nonexistent" },
      undefined,
      undefined,
      makeExtensionContext(),
    );

    expect(result).toHaveProperty("content");
    expect((result.content[0] as any).text).toContain("No symbols found");
    expect(result.details).toMatchObject({ total: 0 });
  });

  it('mode="symbols" formats search results with file, line, and kind', async () => {
    mockSearchIdentifiers.mockResolvedValue([
      {
        file: "src/utils.ts",
        line: 42,
        name: "calculateTotal",
        kind: "def",
        context: "  42: export function calculateTotal(items: Item[]) {\n    43:   return items.reduce((s, i) => s + i.price, 0);\n",
      },
    ]);

    const result = await tool.execute(
      "call-2",
      { mode: "symbols", query: "calculateTotal" },
      undefined,
      undefined,
      makeExtensionContext(),
    );

    const text: string = (result.content[0] as any).text as string;
    expect(text).toContain('Found 1 symbol(s) matching "calculateTotal"');
    expect(text).toContain("src/utils.ts:42");
    expect(text).toContain("[def]");
    expect(text).toContain("calculateTotal");
    expect(result.details).toEqual({ total: 1 });
  });

  it('mode="symbols" uses params.directory when provided', async () => {
    mockSearchIdentifiers.mockResolvedValue([]);
    const { RepoMap } = await import("../../repomap.js");

    await tool.execute(
      "call-3",
      { mode: "symbols", query: "foo", directory: "/custom/path" },
      undefined,
      undefined,
      makeExtensionContext(),
    );

    expect(vi.mocked(RepoMap)).toHaveBeenCalledWith("/custom/path");
  });

  it('mode="symbols" passes the abort signal to searchIdentifiers', async () => {
    mockSearchIdentifiers.mockResolvedValue([]);
    const controller = new AbortController();

    await tool.execute(
      "call-4",
      { mode: "symbols", query: "foo" },
      controller.signal,
      undefined,
      makeExtensionContext(),
    );

    expect(mockSearchIdentifiers).toHaveBeenCalledWith(
      "foo",
      expect.any(Object),
      controller.signal,
    );
  });

  it('mode="symbols" passes includeDefinitions and includeReferences', async () => {
    mockSearchIdentifiers.mockResolvedValue([]);

    await tool.execute(
      "call-5",
      { mode: "symbols", query: "foo", includeDefinitions: false, includeReferences: true },
      undefined,
      undefined,
      makeExtensionContext(),
    );

    expect(mockSearchIdentifiers).toHaveBeenCalledWith(
      "foo",
      expect.objectContaining({
        includeDefinitions: false,
        includeReferences: true,
      }),
      undefined,
    );
  });

  // ── Execution: mode="callers" ──

  it('mode="callers" returns no-callers message when none found', async () => {
    const { findCallers } = await import("../../callgraph.js");
    vi.mocked(findCallers).mockResolvedValue([]);

    const result = await tool.execute(
      "call-6",
      { mode: "callers", function: "noSuchFn" },
      undefined,
      undefined,
      makeExtensionContext(),
    );

    const text: string = (result.content[0] as any).text as string;
    expect(text).toContain('No callers found for "noSuchFn"');
    expect(result.details).toMatchObject({ total: 0 });
  });

  // ── Execution: mode="resolve" (thin proxy, tests basic dispatch) ──

  it('mode="resolve" dispatches resolveSymbol', async () => {
    const result = await tool.execute(
      "call-7",
      { mode: "resolve", symbol: "MyClass" },
      undefined,
      undefined,
      makeExtensionContext(),
    );

    const text: string = (result.content[0] as any).text as string;
    expect(text).toContain('Resolved symbol: "MyClass"');
    expect(result.details).toHaveProperty("symbol", "MyClass");
  });

  // ── Execution: mode="code" ──

  it('mode="code" returns no-defs message when no files match', async () => {
    const { findSrcFiles } = await import("../../file-discovery.js");
    vi.mocked(findSrcFiles).mockResolvedValue([]);

    const result = await tool.execute(
      "call-8",
      { mode: "code", query: "something" },
      undefined,
      undefined,
      makeExtensionContext(),
    );

    const text: string = (result.content[0] as any).text as string;
    expect(text).toContain("No code definitions found");
  });
});
