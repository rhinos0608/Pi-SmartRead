/**
 * MCP tool-schema tests — no subprocess.
 *
 * Exercises the same registry the stdio server serves
 * (`buildToolRegistry`) in-process: tool presence/absence,
 * required fields, and inputSchema shape.
 */
import { describe, expect, it } from "vitest";
import { buildToolRegistry } from "../../../src/mcp-registry.js";

describe("MCP tool registry schema (no subprocess)", () => {
  it("registers expected tools and omits consolidated/experimental ones", () => {
    const tools = buildToolRegistry();
    expect(tools).toBeDefined();
    expect(Array.isArray(tools)).toBe(true);
    expect(tools.length).toBeGreaterThan(0);

    const toolNames = tools.map((t) => t.name);
    // v3: only inspect + skill are registered (read/read_files/search/repo_map/symbol consolidated into inspect)
    // v4: grep added
    expect(toolNames).toContain("inspect");
    expect(toolNames).toContain("skill");
    expect(toolNames).toContain("grep");
    expect(toolNames).not.toContain("read");
    expect(toolNames).not.toContain("read_files");
    expect(toolNames).not.toContain("search");
    expect(toolNames).not.toContain("repo_map");
    expect(toolNames).not.toContain("symbol");
    expect(toolNames).not.toContain("intent_read");
    expect(toolNames).not.toContain("find_symbol");
    expect(toolNames).not.toContain("symbol_info");
    expect(toolNames).not.toContain("deep_search");
    expect(toolNames.every((name) => !name.startsWith("smartread_"))).toBe(true);
    // context_graph is not exposed as an agent-facing tool
    expect(toolNames).not.toContain("context_graph");
    // graph_mutate and git_notes are experimental — disabled by default
    expect(toolNames).not.toContain("graph_mutate");
    expect(toolNames).not.toContain("git_notes_read");
    expect(toolNames).not.toContain("git_notes_write");
  });

  it("each tool has required fields", () => {
    const tools = buildToolRegistry();
    for (const tool of tools) {
      expect(tool.name).toBeDefined();
      expect(typeof tool.name).toBe("string");
      expect(tool.description).toBeDefined();
      expect(typeof tool.description).toBe("string");
      expect(tool.parameters).toBeDefined();
    }
  });

  it("guided tools expose descriptions", () => {
    const tools = buildToolRegistry();
    // v3: guidance checks target inspect (which consolidates read/read_files/
    // search/repo_map/symbol) and skill.
    const guidedTools = ["inspect", "skill", "grep"];
    for (const name of guidedTools) {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool?.description).toBeDefined();
    }
  });

  it("inputSchema entries are root type-object schemas (upstream requirement)", () => {
    const tools = buildToolRegistry();
    for (const tool of tools) {
      const schema = tool.parameters as unknown as Record<string, unknown>;
      expect(schema).toBeDefined();
      // Upstream function-calling requires parameters schema type "object";
      // top-level unions (anyOf/oneOf) are rejected with invalid_request_error.
      expect((schema as { type?: unknown }).type).toBe("object");
      expect((schema as { anyOf?: unknown }).anyOf).toBeUndefined();
      expect((schema as { oneOf?: unknown }).oneOf).toBeUndefined();
      // Should have properties at minimum
      expect((schema as { properties?: unknown }).properties).toBeDefined();
    }
  });
});
