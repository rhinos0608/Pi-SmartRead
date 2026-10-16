import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureAffordanceSelectors,
  selectSurfaceVariants,
} from "../../../src/runtime/affordances.js";
import { isR2AffordancesEnabled } from "../../../src/lsp/affordance-contract.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
});

// c388cc5 (round-1 producer) Pi-registration surface pins. The baseline arm
// (general off) and the round-1 arm (=1) must stay byte-identical in
// model-visible surface: tool description, schema, guidance, and output
// formatting. schemaHash/guidanceHash cover the registered LSP + inspect
// schemas/descriptions/guidance, so any text or schema drift fails here.
const BASELINE_SCHEMA_HASH = "b262fa1cb6b24f3943f57287d8d07e0b5dc2e98ff2bab442c6705e23410c1966";
const BASELINE_GUIDANCE_HASH = "0d3e79e23ece2949f06101d7d5c0250962fbbcac59f244c22fd04e9dede13ff2";
const R1_SCHEMA_HASH = "90eb9ae645f171b91e08ff4dbc8822cba9571ab0b046fa5b99c9a5ba4ab42b2d";
const R1_GUIDANCE_HASH = "16f517a78e1a6385ead16f9925e79c5fa309d2977023a08115a575b278618593";

// Stage-B r2 surface pins. Stage B rewrote the r2 description, schema
// (scope text), and guidance, so r2 carries its own hashes distinct from
// round-1. Baseline and round-1 pins above are unchanged.
const R2_SCHEMA_HASH = "13242f9025f1f01b77f0cce61e549a5a12e7d7f56fc823c80745a1346527804c";
const R2_GUIDANCE_HASH = "170083ab8ca6a69cf6445dab833cc7e952770fc612b6ca162708736a5af2e156";

async function piIdentityFor(general: string, inspect: string) {
  vi.stubEnv("PI_SMARTREAD_SURFACE_IDENTITY_LOG", "0");
  vi.resetModules();
  const affordances = await import("../../../src/runtime/affordances.js");
  const registration = await import("../../../src/extension-registration.js");
  const selectors = affordances.captureAffordanceSelectors({
    PI_SMARTREAD_AFFORDANCES: general,
    PI_SMARTREAD_INSPECT_AFFORDANCES: inspect,
  });
  const state = { affordanceSelectors: selectors, freshGraphGetter: async () => { throw new Error("unused"); } } as never;
  registration.registerInspectTool(state);
  registration.registerLspTool(state, selectors);
  registration.registerCoreTools({ registerTool: () => undefined } as never);
  return affordances.getEffectiveAffordanceIdentity()!;
}

describe("r2 general selector", () => {
  it('accepts "2" as the r2 variant following the "0"/"1" value scheme', () => {
    expect(captureAffordanceSelectors({ PI_SMARTREAD_AFFORDANCES: "2" }).general).toEqual({
      enabled: true,
      variant: "r2",
    });
    expect(captureAffordanceSelectors({ PI_SMARTREAD_AFFORDANCES: "1" }).general).toEqual({
      enabled: true,
    });
    expect(captureAffordanceSelectors({ PI_SMARTREAD_AFFORDANCES: "0" }).general).toEqual({
      enabled: false,
    });
    expect(captureAffordanceSelectors({}).general).toEqual({ enabled: false });
  });

  it('keeps "2" invalid on the inspect selector', () => {
    expect(captureAffordanceSelectors({ PI_SMARTREAD_INSPECT_AFFORDANCES: "2" }).inspect).toEqual({
      enabled: false,
      invalid: "2",
    });
  });

  it("maps r2 to its own lsp variant while keeping round-1 guidance", () => {
    const r2 = selectSurfaceVariants(captureAffordanceSelectors({ PI_SMARTREAD_AFFORDANCES: "2" }));
    expect(r2.lsp).toBe("r2");
    expect(r2.guidance).toBe("affordance-bundle");
    expect(r2.mcpInstructions).toBe("affordance-bundle");
    expect(r2.note).toBe("wp-c-unbuilt");
    const r1 = selectSurfaceVariants(captureAffordanceSelectors({ PI_SMARTREAD_AFFORDANCES: "1" }));
    expect(r1.lsp).toBe("affordance-bundle");
    const both = selectSurfaceVariants(captureAffordanceSelectors({
      PI_SMARTREAD_AFFORDANCES: "2",
      PI_SMARTREAD_INSPECT_AFFORDANCES: "1",
    }));
    expect(both.lsp).toBe("r2");
    expect(both.inspect).toBe("inspect-bundle");
  });

  it("detects the r2 variant from the environment", () => {
    expect(isR2AffordancesEnabled({ PI_SMARTREAD_AFFORDANCES: "2" } as NodeJS.ProcessEnv)).toBe(true);
    expect(isR2AffordancesEnabled({ PI_SMARTREAD_AFFORDANCES: "1" } as NodeJS.ProcessEnv)).toBe(false);
    expect(isR2AffordancesEnabled({} as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe("baseline and round-1 surface pins (c388cc5)", () => {
  it("keeps the baseline hashes unchanged", async () => {
    const id = await piIdentityFor("0", "0");
    expect(id.variants.lsp).toBe("baseline");
    expect(id.schemaHash).toBe(BASELINE_SCHEMA_HASH);
    expect(id.guidanceHash).toBe(BASELINE_GUIDANCE_HASH);
  });

  it("keeps the round-1 hashes unchanged", async () => {
    const id = await piIdentityFor("1", "0");
    expect(id.variants.lsp).toBe("affordance-bundle");
    expect(id.schemaHash).toBe(R1_SCHEMA_HASH);
    expect(id.guidanceHash).toBe(R1_GUIDANCE_HASH);
  });

  it("gives r2 a distinct identity with its own stage-B schema and guidance", async () => {
    const r1 = await piIdentityFor("1", "0");
    const r2 = await piIdentityFor("2", "0");
    expect(r2.variants.lsp).toBe("r2");
    expect(r2.surfaceIdentity).not.toBe(r1.surfaceIdentity);
    // Stage B rewrote the r2 description, schema, and guidance, so the
    // hashes differ from round-1 and pin the new text.
    expect(r2.schemaHash).not.toBe(r1.schemaHash);
    expect(r2.guidanceHash).not.toBe(r1.guidanceHash);
    expect(r2.schemaHash).toBe(R2_SCHEMA_HASH);
    expect(r2.guidanceHash).toBe(R2_GUIDANCE_HASH);
  });
});
