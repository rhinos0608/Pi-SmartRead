import { describe, expect, it } from "vitest";
import {
  AFFORDANCE_ANCHOR_OPS,
  AFFORDANCE_BOUNDS,
  isAffordancesEnabled,
} from "../../../src/lsp/affordance-contract.js";

describe("affordance-contract frozen bounds", () => {
  it("exposes the anchorable op allowlist", () => {
    expect([...AFFORDANCE_ANCHOR_OPS]).toEqual([
      "goToDefinition",
      "goToTypeDefinition",
      "goToImplementation",
      "findReferences",
      "hover",
      "prepareCallHierarchy",
    ]);
  });

  it("freezes resolution budgets", () => {
    expect(AFFORDANCE_BOUNDS.discoveryCandidates).toBe(100);
    expect(AFFORDANCE_BOUNDS.underlyingRequests).toBe(6);
    expect(AFFORDANCE_BOUNDS.ambiguityCandidates).toBe(10);
    expect(AFFORDANCE_BOUNDS.aggregateDeadlineMs).toBe(15000);
  });

  it("isAffordancesEnabled defaults off", () => {
    expect(isAffordancesEnabled({})).toBe(false);
    expect(isAffordancesEnabled({ PI_SMARTREAD_AFFORDANCES: "1" })).toBe(true);
    expect(isAffordancesEnabled({ PI_SMARTREAD_AFFORDANCES: "0" })).toBe(false);
  });
});
