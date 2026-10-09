import { describe, expect, it } from "vitest";
import { captureAffordanceSelectors, recordEffectiveAffordanceIdentity, selectSurfaceVariants, surfaceIdentity } from "../../../src/runtime/affordances.js";
import { getLspToolDescription, getLspToolSchema } from "../../../src/lsp/lsp-tool.js";
import { createInspectV4Tool } from "../../../src/inspect/inspect-tool.js";

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

  it("selects baseline inspect for off and general-only, and full inspect for inspect-on", () => {
    const baseline = createInspectV4Tool({ getSessionFilePath: () => null });
    const off = createInspectV4Tool({ getSessionFilePath: () => null, affordances: false });
    const on = createInspectV4Tool({ getSessionFilePath: () => null, affordances: true });
    expect(off.parameters).toEqual(baseline.parameters);
    expect(off.description).toBe(baseline.description);
    expect(on.parameters).not.toEqual(baseline.parameters);
    expect(on.description).not.toBe(baseline.description);
    expect((on.parameters as { properties: Record<string, unknown> }).properties.view).toBeDefined();
    expect((on.parameters as { properties: Record<string, unknown> }).properties.gather).toBeDefined();
    expect((on.parameters as { properties: Record<string, unknown> }).properties.diff).toBeDefined();
  });

  it("includes both selected surfaces in identity even when inspect is baseline", () => {
    const off = captureAffordanceSelectors({});
    const offVariants = selectSurfaceVariants(off);
    const lsp = { schema: { type: "object" }, description: "lsp", guidance: "lsp guide" };
    const inspect = { schema: { type: "inspect" }, description: "baseline inspect", guidance: "baseline inspect guide" };
    recordEffectiveAffordanceIdentity(off, offVariants, inspect.schema, inspect.description, inspect.guidance, "inspect");
    const offIdentity = recordEffectiveAffordanceIdentity(off, offVariants, lsp.schema, lsp.description, lsp.guidance);
    expect(offIdentity.surfaceIdentity).toBe(surfaceIdentity(off, offVariants, { ...lsp, inspect }));

    const changedInspect = { ...inspect, schema: { type: "inspect", properties: { view: true } } };
    recordEffectiveAffordanceIdentity(off, offVariants, changedInspect.schema, changedInspect.description, changedInspect.guidance, "inspect");
    const changedOffIdentity = recordEffectiveAffordanceIdentity(off, offVariants, lsp.schema, lsp.description, lsp.guidance);
    expect(changedOffIdentity.surfaceIdentity).not.toBe(offIdentity.surfaceIdentity);
    expect(changedOffIdentity.schemaHash).not.toBe(offIdentity.schemaHash);

    const on = captureAffordanceSelectors({ PI_SMARTREAD_INSPECT_AFFORDANCES: "1" });
    const onVariants = selectSurfaceVariants(on);
    const onInspect = { schema: { type: "inspect-affordance" }, description: "inspect bundle", guidance: "inspect bundle guide" };
    recordEffectiveAffordanceIdentity(on, onVariants, onInspect.schema, onInspect.description, onInspect.guidance, "inspect");
    const onIdentity = recordEffectiveAffordanceIdentity(on, onVariants, lsp.schema, lsp.description, lsp.guidance);
    expect(onIdentity.surfaceIdentity).toBe(surfaceIdentity(on, onVariants, { ...lsp, inspect: onInspect }));
    expect(onIdentity.surfaceIdentity).not.toBe(offIdentity.surfaceIdentity);
    expect(onIdentity.schemaHash).not.toBe(offIdentity.schemaHash);
    expect(onIdentity.guidanceHash).not.toBe(offIdentity.guidanceHash);
  });

  it("keeps the general bundle off when the inspect selector alone is enabled", () => {
    const selectors = captureAffordanceSelectors({ PI_SMARTREAD_INSPECT_AFFORDANCES: "1" });
    expect(selectSurfaceVariants(selectors).lsp).toBe("baseline");
  });
});
