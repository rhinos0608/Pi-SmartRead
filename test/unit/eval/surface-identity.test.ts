import { describe, expect, it } from "vitest";
import { parseSurfaceIdentity, SurfaceIdentityError } from "../../../scripts/eval/surface-identity.js";

const identity = { selectors: { general: false, inspect: true }, variants: { lsp: "baseline", inspect: "inspect-bundle", grep: "baseline", guidance: "inspect-bundle", mcpInstructions: "inspect-bundle" }, surfaceIdentity: "a".repeat(64), schemaHash: "b".repeat(64), guidanceHash: "c".repeat(64) };
const line = `[pi-smartread:surface-identity] ${JSON.stringify(identity)}`;

describe("surface identity stderr parser", () => {
    it("parses one strictly shaped identity line", () => expect(parseSurfaceIdentity(`startup\n${line}\n`)).toEqual(identity));
    it.each(["", `${line}\n${line}`, `${line.slice(0, -1)}!`, `[pi-smartread:surface-identity] ${JSON.stringify({ ...identity, unexpected: true })}`, `[pi-smartread:surface-identity] ${JSON.stringify({ ...identity, variants: { ...identity.variants, inspect: "/tmp/secret" } })}`])("rejects invalid stderr: %s", (stderr) => {
        expect(() => parseSurfaceIdentity(stderr)).toThrow(SurfaceIdentityError);
    });
});
