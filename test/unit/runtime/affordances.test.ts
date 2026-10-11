import { describe, expect, it } from "vitest";
import { captureAffordanceSelectors, selectSurfaceVariants, surfaceIdentity } from "../../../src/runtime/affordances.js";

describe("captureAffordanceSelectors", () => {
  it.each([undefined, "0", "", "true", "01", "1 "])("records invalid/off general value %j", (value) => {
    const env = { PI_SMARTREAD_AFFORDANCES: value };
    const selectors = captureAffordanceSelectors(env);
    expect(selectors.general.enabled).toBe(false);
    if (value !== undefined && value !== "0") expect(selectors.general).toEqual({ enabled: false, invalid: value });
    else expect(selectors.general).toEqual({ enabled: false });
    expect(Object.isFrozen(selectors)).toBe(true);
    expect(Object.isFrozen(selectors.general)).toBe(true);
  });

  it.each([undefined, "0", "", "true", "01", "1 "])("captures inspect selector value %j", (value) => {
    const selectors = captureAffordanceSelectors({ PI_SMARTREAD_INSPECT_AFFORDANCES: value });
    expect(selectors.inspect.enabled).toBe(value === "1");
    if (value !== undefined && value !== "0") expect(selectors.inspect).toEqual({ enabled: false, invalid: value });
    else expect(selectors.inspect).toEqual({ enabled: false });
  });

  it("reads each selector once and accepts only exact one", () => {
    const reads: string[] = [];
    const env = Object.defineProperties({}, {
      PI_SMARTREAD_AFFORDANCES: { get() { reads.push("general"); return "1"; } },
      PI_SMARTREAD_INSPECT_AFFORDANCES: { get() { reads.push("inspect"); return "1"; } },
    }) as NodeJS.ProcessEnv;
    expect(captureAffordanceSelectors(env)).toEqual({ general: { enabled: true }, inspect: { enabled: true } });
    expect(reads).toEqual(["general", "inspect"]);
  });
});

describe("selectSurfaceVariants", () => {
  it.each([
    [false, false, { lsp: "baseline", inspect: "baseline", grep: "baseline", guidance: "baseline", mcpInstructions: "baseline" }],
    [true, false, { lsp: "affordance-bundle", inspect: "baseline", grep: "baseline", guidance: "affordance-bundle", mcpInstructions: "affordance-bundle", note: "wp-c-unbuilt" }],
    [false, true, { lsp: "baseline", inspect: "inspect-bundle", grep: "baseline", guidance: "inspect-bundle", mcpInstructions: "inspect-bundle" }],
    [true, true, { lsp: "affordance-bundle", inspect: "inspect-bundle", grep: "baseline", guidance: "inspect-bundle", mcpInstructions: "inspect-bundle" }],
  ])("composes general=%s inspect=%s", (general, inspect, expected) => {
    expect(selectSurfaceVariants({ general: { enabled: general }, inspect: { enabled: inspect } })).toEqual(expected);
  });

  it("treats invalid captured values as off", () => {
    const selectors = captureAffordanceSelectors({
      PI_SMARTREAD_AFFORDANCES: "yes",
      PI_SMARTREAD_INSPECT_AFFORDANCES: "on",
    });
    expect(selectors.general.invalid).toBe("yes");
    expect(selectors.inspect.invalid).toBe("on");
    expect(selectSurfaceVariants(selectors).inspect).toBe("baseline");
  });
});

describe("surfaceIdentity", () => {
  it("is canonical, stable, and sensitive to selectors, variants, and supplied surface text", () => {
    const selectors = { general: { enabled: false }, inspect: { enabled: false } } as const;
    const variants = selectSurfaceVariants(selectors);
    const first = surfaceIdentity(selectors, variants, { schema: { z: 1, a: 2 }, guidance: "base" });
    expect(first).toBe(surfaceIdentity(selectors, variants, { guidance: "base", schema: { a: 2, z: 1 } }));
    expect(first).not.toBe(surfaceIdentity({ ...selectors, general: { enabled: true } }, variants, { schema: { a: 2, z: 1 }, guidance: "base" }));
    expect(first).not.toBe(surfaceIdentity(selectors, { ...variants, inspect: "inspect-bundle" }, { schema: { a: 2, z: 1 }, guidance: "base" }));
    expect(first).not.toBe(surfaceIdentity(selectors, variants, { schema: { a: 2, z: 1 }, guidance: "changed" }));
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });
});
