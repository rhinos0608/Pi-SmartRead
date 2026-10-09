import { describe, expect, it } from "vitest";
import { MCP_READ_NOTE, SMARTREAD_MCP_INSTRUCTIONS } from "../../../src/mcp/mcp-instructions.js";
import { getMcpAffordanceSelectors } from "../../../src/mcp-registry.js";
import { getSmartReadToolGuidance, renderSmartReadToolGuide } from "../../../src/runtime/tool-guidance.js";

describe("MCP affordance guidance parity", () => {
  it("renders the same selected tool-guide wording and never recommends a read action", () => {
    expect(SMARTREAD_MCP_INSTRUCTIONS).toContain(renderSmartReadToolGuide(undefined, getMcpAffordanceSelectors().general.enabled));
    expect(MCP_READ_NOTE).toContain("host's own file reading");
    const guidance = getSmartReadToolGuidance("LSP")!;
    expect([guidance.snippet, ...guidance.guidelines].join(" ")).not.toMatch(/\bread action\b/i);
    expect(SMARTREAD_MCP_INSTRUCTIONS).not.toMatch(/\bread action\b/i);
  });
});
