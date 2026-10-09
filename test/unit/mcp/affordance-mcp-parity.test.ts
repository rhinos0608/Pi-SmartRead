import { describe, expect, it } from "vitest";
import { MCP_READ_NOTE, SMARTREAD_MCP_INSTRUCTIONS } from "../../../src/mcp/mcp-instructions.js";
import { getMcpAffordanceSelectors } from "../../../src/mcp-registry.js";
import { getSmartReadToolGuidance, renderSmartReadToolGuide } from "../../../src/runtime/tool-guidance.js";

describe("MCP affordance guidance parity", () => {
  it("renders selected tool-guide wording and never recommends a read action", () => {
    const selectors = getMcpAffordanceSelectors();
    expect(SMARTREAD_MCP_INSTRUCTIONS).toContain(renderSmartReadToolGuide(undefined, selectors.general.enabled, selectors.inspect.enabled, true));
    expect(MCP_READ_NOTE).toContain("host's own file reading");
    for (const inspectAffordances of [false, true]) {
      const guidance = getSmartReadToolGuidance("inspect", false, inspectAffordances, true)!;
      expect([guidance.snippet, ...guidance.guidelines].join(" ")).not.toMatch(/\bread action\b/i);
      expect(renderSmartReadToolGuide(undefined, false, inspectAffordances, true)).not.toMatch(/\bread action\b/i);
    }
    expect(SMARTREAD_MCP_INSTRUCTIONS).not.toMatch(/\bread action\b/i);
  });
});
