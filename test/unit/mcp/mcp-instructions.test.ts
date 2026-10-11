import { describe, expect, it } from "vitest";
import {
  MCP_READ_NOTE,
  SMARTREAD_MCP_INSTRUCTIONS,
  buildServerOptions,
} from "../../../src/mcp/mcp-instructions.js";
import {
  SMARTREAD_TOOL_GUIDE_TITLE,
  renderSmartReadToolGuide,
} from "../../../src/runtime/tool-guidance.js";

describe("mcp instructions (E1-C)", () => {
  it("starts with the guide title and includes the guide body", () => {
    expect(SMARTREAD_MCP_INSTRUCTIONS.startsWith(SMARTREAD_TOOL_GUIDE_TITLE)).toBe(
      true,
    );
    expect(SMARTREAD_MCP_INSTRUCTIONS).toContain(renderSmartReadToolGuide());
  });

  it("notes that MCP has no wrapped read tool", () => {
    expect(SMARTREAD_MCP_INSTRUCTIONS).toContain(MCP_READ_NOTE);
    expect(SMARTREAD_MCP_INSTRUCTIONS).toContain("read");
  });

  it("buildServerOptions exposes instructions alongside capabilities", () => {
    const options = buildServerOptions();
    expect(options.instructions).toBe(SMARTREAD_MCP_INSTRUCTIONS);
    expect(options.capabilities).toEqual({
      tools: {},
      prompts: {},
      resources: {},
    });
  });
});
