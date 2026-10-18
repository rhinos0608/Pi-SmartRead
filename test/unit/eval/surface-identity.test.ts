import { describe, expect, it } from "vitest";
import { parseSurfaceIdentity, SurfaceIdentityError } from "../../../scripts/eval/surface-identity.js";

// Captured from product snapshot75d3a81a by the local recorder probe: captureAffordanceSelectors, selectSurfaceVariants, and recordEffectiveAffordanceIdentity with synthetic inputs.
const identity = { selectors: { general: { enabled: false }, inspect: { enabled: true } }, variants: { lsp: "baseline", inspect: "inspect-bundle", grep: "baseline", guidance: "inspect-bundle", mcpInstructions: "inspect-bundle" }, surfaceIdentity: "f1218b8674c6be84b3106c6a3ddab74dcd14adbe3e5933f12d96006b92811f83", schemaHash: "a2c799262a3ce3c19ef5cdd983bf3d12b43ab3c426227091b909dcb7054738c0", guidanceHash: "6bce10fdf83f22c9b44a707a06731485e214d972cee4a4fc29106e51b9ea5a62" };
const line = `[pi-smartread:surface-identity] ${JSON.stringify(identity)}`;

describe("surface identity stderr parser", () => {
    it("parses one strictly shaped identity line", () => expect(parseSurfaceIdentity(`startup\n${line}\n`)).toEqual(identity));
    it.each([[false, false], [false, true], [true, false], [true, true]])("accepts product selectors general=%s inspect=%s", (general, inspect) => {
        const payload = { ...identity, selectors: { general: { enabled: general }, inspect: { enabled: inspect } } };
        expect(parseSurfaceIdentity(`[pi-smartread:surface-identity] ${JSON.stringify(payload)}`).selectors).toEqual(payload.selectors);
    });
    it.each(["", `${line}\n${line}`, `${line.slice(0, -1)}!`, `[pi-smartread:surface-identity] ${JSON.stringify({ ...identity, unexpected: true })}`, `[pi-smartread:surface-identity] ${JSON.stringify({ ...identity, selectors: { general: true, inspect: true } })}`, `[pi-smartread:surface-identity] ${JSON.stringify({ ...identity, selectors: { ...identity.selectors, general: { enabled: false, foreign: true } } })}`, `[pi-smartread:surface-identity] ${JSON.stringify({ ...identity, variants: { ...identity.variants, inspect: "/tmp/secret" } })}`])("rejects invalid stderr: %s", (stderr) => {
        expect(() => parseSurfaceIdentity(stderr)).toThrow(SurfaceIdentityError);
    });
});
