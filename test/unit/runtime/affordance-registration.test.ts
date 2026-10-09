import { describe, expect, it } from "vitest";
import { captureAffordanceSelectors, selectSurfaceVariants } from "../../../src/runtime/affordances.js";
import { getLspToolDescription, getLspToolSchema } from "../../../src/lsp/lsp-tool.js";

describe("affordance registration composition", () => {
  it("selects exactly one LSP surface for each general selector state", () => {
    const off = captureAffordanceSelectors({});
    const on = captureAffordanceSelectors({ PI_SMARTREAD_AFFORDANCES: "1" });
    expect(selectSurfaceVariants(off).lsp).toBe("baseline");
    expect(selectSurfaceVariants(on).lsp).toBe("affordance-bundle");
    expect(getLspToolDescription(false)).toBe(getLspToolDescription(selectSurfaceVariants(off).lsp === "affordance-bundle"));
    expect(getLspToolDescription(true)).toBe(getLspToolDescription(selectSurfaceVariants(on).lsp === "affordance-bundle"));
    expect(getLspToolSchema(false)).toBe(getLspToolSchema(selectSurfaceVariants(off).lsp === "affordance-bundle"));
  });

  it("keeps the general bundle off when the inspect selector alone is enabled", () => {
    const selectors = captureAffordanceSelectors({ PI_SMARTREAD_INSPECT_AFFORDANCES: "1" });
    expect(selectSurfaceVariants(selectors).lsp).toBe("baseline");
  });
});
