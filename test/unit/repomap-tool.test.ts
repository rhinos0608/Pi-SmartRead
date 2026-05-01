import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

// ── Mock the RepoMap module before anything imports it ──
const mockSearchIdentifiers = vi.fn();

vi.mock("../../repomap.js", () => ({
  RepoMap: vi.fn().mockImplementation(() => ({
    searchIdentifiers: mockSearchIdentifiers,
  })),
}));

// Import the mocked RepoMap so we can clear its call history between tests
import { RepoMap } from "../../repomap.js";

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

describe("search_symbols tool", () => {
  let registered: ToolDefinition[];
  let tool: ToolDefinition;

  beforeEach(() => {
    mockSearchIdentifiers.mockReset();
    vi.mocked(RepoMap).mockClear();
    const { registered: reg, api } = makeExtensionAPI();
    registerRepoTools(api as any);
    registered = reg;
    tool = getTool(registered, "search_symbols");
  });

  // ── Registration ──

  it("is registered with the correct name", () => {
    expect(tool.name).toBe("search_symbols");
  });

  it("has a label and description", () => {
    expect(tool.label).toBe("search_symbols");
    expect(tool.description).toBeTruthy();
    expect(tool.description).toContain("symbols");
    expect(tool.description).toContain("tree-sitter");
  });

  it("has an execute function", () => {
    expect(typeof tool.execute).toBe("function");
  });

  // ── Parameter schema ──

  it("has a parameter schema with query (required)", () => {
    const schema = tool.parameters as Record<string, unknown>;
    const properties = schema.properties as Record<string, unknown>;
    expect(properties.query).toBeDefined();
    expect((properties.query as any).type).toBe("string");
  });

  it("has optional directory parameter", () => {
    const schema = tool.parameters as Record<string, unknown>;
    const properties = schema.properties as Record<string, unknown>;
    expect(properties).toHaveProperty("directory");
  });

  it("has optional maxResults, includeDefinitions, includeReferences", () => {
    const schema = tool.parameters as Record<string, unknown>;
    const properties = schema.properties as Record<string, unknown>;
    expect(properties).toHaveProperty("maxResults");
    expect(properties).toHaveProperty("includeDefinitions");
    expect(properties).toHaveProperty("includeReferences");
  });

  // ── Execution: empty results ──

  it("returns no-symbols message when searchIdentifiers returns []", async () => {
    mockSearchIdentifiers.mockResolvedValue([]);

    const result = await tool.execute(
      "call-1",
      { query: "nonexistent" },
      undefined, // signal
      undefined, // onUpdate
      makeExtensionContext(),
    );

    expect(result).toHaveProperty("content");
    expect((result.content[0] as any).text).toContain("No symbols found");
    expect(result.details).toMatchObject({ total: 0 });
  });

  // ── Execution: results with context ──

  it("formats search results with file, line, kind, and context", async () => {
    mockSearchIdentifiers.mockResolvedValue([
      {
        file: "src/utils.ts",
        line: 42,
        name: "calculateTotal",
        kind: "def",
        context: "  42: export function calculateTotal(items: Item[]) {\n    43:   return items.reduce((s, i) => s + i.price, 0);\n",
      },
      {
        file: "src/app.ts",
        line: 15,
        name: "calculateTotal",
        kind: "ref",
        context: "  15: const total = calculateTotal(cart);\n",
      },
    ]);

    const result = await tool.execute(
      "call-2",
      { query: "calculateTotal" },
      undefined,
      undefined,
      makeExtensionContext(),
    );

    expect(result).toHaveProperty("content");
    const text: string = (result.content[0] as any).text as string;
    expect(text).toContain('Found 2 symbol(s) matching "calculateTotal"');
    expect(text).toContain("src/utils.ts:42");
    expect(text).toContain("[def]");
    expect(text).toContain("calculateTotal");
    expect(text).toContain("src/app.ts:15");
    expect(text).toContain("[ref]");
    expect(result.details).toEqual({ total: 2 });
  });

  // ── Execution: respects directory param ──

  it("uses params.directory when provided", async () => {
    mockSearchIdentifiers.mockResolvedValue([]);

    await tool.execute(
      "call-3",
      { query: "foo", directory: "/custom/path" },
      undefined,
      undefined,
      makeExtensionContext(),
    );

    // RepoMap should have been constructed with /custom/path
    expect(vi.mocked(RepoMap)).toHaveBeenCalledWith("/custom/path");
  });

  it("uses ctx.cwd when directory is not provided", async () => {
    mockSearchIdentifiers.mockResolvedValue([]);

    await tool.execute(
      "call-4",
      { query: "foo" },
      undefined,
      undefined,
      makeExtensionContext("/ctx/cwd"),
    );

    expect(vi.mocked(RepoMap)).toHaveBeenCalledWith("/ctx/cwd");
  });

  // ── Execution: signal propagation ──

  it("passes the abort signal to searchIdentifiers", async () => {
    mockSearchIdentifiers.mockResolvedValue([]);
    const controller = new AbortController();

    await tool.execute(
      "call-5",
      { query: "foo" },
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

  // ── Context: handles missing context gracefully ──

  it("renders results even when context is empty", async () => {
    mockSearchIdentifiers.mockResolvedValue([
      {
        file: "src/lib.ts",
        line: 10,
        name: "myFn",
        kind: "def",
        context: "",
      },
    ]);

    const result = await tool.execute(
      "call-6",
      { query: "myFn" },
      undefined,
      undefined,
      makeExtensionContext(),
    );

    const text: string = (result.content[0] as any).text as string;
    expect(text).toContain("src/lib.ts:10");
    expect(text).toContain("[def]");
    expect(text).toContain("myFn");
    // Should not have trailing context block (empty context produces no extra lines)
    expect(result.details).toEqual({ total: 1 });
  });

  // ── filter params ──

  it("passes includeDefinitions and includeReferences to searchIdentifiers", async () => {
    mockSearchIdentifiers.mockResolvedValue([]);

    await tool.execute(
      "call-7",
      { query: "foo", includeDefinitions: false, includeReferences: true },
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

  it("uses defaults for includeDefinitions and includeReferences when omitted", async () => {
    mockSearchIdentifiers.mockResolvedValue([]);

    await tool.execute(
      "call-8",
      { query: "foo" },
      undefined,
      undefined,
      makeExtensionContext(),
    );

    expect(mockSearchIdentifiers).toHaveBeenCalledWith(
      "foo",
      expect.objectContaining({
        includeDefinitions: true,
        includeReferences: true,
      }),
      undefined,
    );
  });
});
