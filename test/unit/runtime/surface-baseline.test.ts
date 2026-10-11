import { describe, expect, it } from "vitest";
import { createInspectTool } from "../../../src/inspect/inspect-tool.js";
import { createGrepTool } from "../../../src/search/grep-tool.js";
import { createFindTool } from "../../../src/search/find-tool.js";
import { MCP_READ_NOTE, SMARTREAD_MCP_INSTRUCTIONS } from "../../../src/mcp/mcp-instructions.js";
import { SMARTREAD_TOOL_GUIDANCE, renderSmartReadToolGuide } from "../../../src/runtime/tool-guidance.js";

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, normalize(child)]));
  }
  return value;
}

describe("default off-mode surface baseline", () => {
  it("locks inspect, grep, find, Pi guidance, and MCP instructions/tool descriptions and schemas", () => {
    const tools = [
      createInspectTool({ getSessionFilePath: () => null }),
      createGrepTool({}),
      createFindTool({}),
    ]
      .map((tool) => ({ name: tool.name, description: tool.description, schema: normalize(tool.parameters) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    expect({
      tools,
      guidance: normalize(SMARTREAD_TOOL_GUIDANCE),
      piGuide: renderSmartReadToolGuide(),
      mcpReadNote: MCP_READ_NOTE,
      mcpInstructions: SMARTREAD_MCP_INSTRUCTIONS,
    }).toMatchSnapshot();
  });
});
