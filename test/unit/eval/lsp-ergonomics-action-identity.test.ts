import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { AFFORDANCE_BOUNDS } from "../../../src/lsp/affordance-contract.js";
import { createActionIdentity, type ActionIdentityBinding } from "../../../scripts/eval/lsp-ergonomics/action-identity.js";

const base: ActionIdentityBinding = {
  canonicalPath: "/repo/file.ts",
  sourceSha256: "a".repeat(64),
  descriptorId: "server-A",
  positionEncoding: "utf-16",
  range: { start: { line: 1, character: 2 }, end: { line: 1, character: 8 } },
  kind: "quickfix",
  action: { title: "Fix", edit: { changes: { "/repo/file.ts": [{ newText: "ok" }] } } },
};
const id = (binding: unknown) => createActionIdentity(binding);

describe("offline action identity", () => {
  it("matches an independently computed versioned canonical JSON golden", () => {
    const canonical = '{"action":{"edit":{"changes":{"/repo/file.ts":[{"newText":"ok"}]}},"title":"Fix"},"canonicalPath":"/repo/file.ts","descriptorId":"server-A","kind":"quickfix","positionEncoding":"utf-16","range":{"end":{"character":8,"line":1},"start":{"character":2,"line":1}},"sourceSha256":"' + "a".repeat(64) + '"}';
    const expected = createHash("sha256").update("pi-smartread:lsp-action-identity:v1\n" + canonical).digest("hex");
    expect(id(base)).toEqual({ ok: true, actionId: expected });
  });
  it("ignores property insertion order recursively but preserves array order", () => {
    const reordered = { ...base, action: { edit: { changes: { "/repo/file.ts": [{ newText: "ok" }] } }, title: "Fix" } };
    expect(id(reordered)).toEqual(id(base));
    expect(id({ ...base, action: { list: [1, 2] } })).not.toEqual(id({ ...base, action: { list: [2, 1] } }));
  });
  it.each([
    { canonicalPath: "/repo/other.ts" }, { sourceSha256: "b".repeat(64) }, { descriptorId: "server-B" },
    { positionEncoding: "utf-8" }, { range: { start: { line: 1, character: 3 }, end: { line: 1, character: 8 } } },
    { kind: "source.fixAll" }, { action: { title: "Other" } },
  ])("binds every identity component", (change) => {
    expect(id({ ...base, ...change })).not.toEqual(id(base));
  });
  it("preserves __proto__ JSON keys without prototype mutation", () => {
    const action = JSON.parse('{"__proto__":{"polluted":true},"constructor":1,"prototype":2}');
    const result = id({ ...base, action });
    expect(result.ok).toBe(true);
    expect(Object.prototype).not.toHaveProperty("polluted");
    expect(Object.keys(action)).toContain("__proto__");
    expect(result).not.toEqual(id({ ...base, action: { constructor: 1, prototype: 2 } }));
  });
  it("refuses malformed binding and non-JSON actions", () => {
    expect(id({ ...base, extra: true }).ok).toBe(false);
    expect(id({ ...base, descriptorId: "unknown" }).ok).toBe(false);
    expect(id({ ...base, sourceSha256: "A".repeat(64) }).ok).toBe(true);
    expect(id({ ...base, action: { x: undefined } }).ok).toBe(false);
    expect(id({ ...base, action: NaN }).ok).toBe(false);
  });
  it.each(["custom", "null"] as const)("refuses arrays with a nonstandard prototype: %s", (kind) => {
    const toJSON = vi.fn(() => "changed");
    const prototype = kind === "null" ? null : { toJSON };
    const action = [1, 2];
    Object.setPrototypeOf(action, prototype);
    expect(id({ ...base, action })).toEqual({ ok: false, reason: "invalid-binding" });
    expect(toJSON).not.toHaveBeenCalled();
    expect(Object.getPrototypeOf(action)).toBe(prototype);
    expect(id({ ...base, action: [1, 2] }).ok).toBe(true);
  });

  it("does not execute accessors and refuses cycles", () => {
    const getter = vi.fn(() => "x");
    const action = Object.defineProperty({}, "x", { enumerable: true, get: getter });
    expect(id({ ...base, action }).ok).toBe(false);
    expect(getter).not.toHaveBeenCalled();
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    expect(id({ ...base, action: cycle }).ok).toBe(false);
  });
  it.each([
    { label: "array", action: { title: "Fix", data: Array(30_000).fill(0) } },
    { label: "object", action: { title: "Fix", data: Object.fromEntries(Array.from({ length: 4_600 }, (_, index) => [`k${String(index).padStart(5, "0")}`, 0])) } },
  ])("counts every comma toward the canonical byte cap: $label", ({ action }) => {
    const binding = { ...base, action };
    expect(Buffer.byteLength(JSON.stringify(binding), "utf8")).toBeGreaterThan(AFFORDANCE_BOUNDS.outputBytes);
    expect(id(binding)).toEqual({ ok: false, reason: "size-limit" });
  });

  it("refuses depth and UTF-8 byte cap overflow", () => {
    let deep: unknown = "x";
    for (let index = 0; index < 65; index++) deep = [deep];
    expect(id({ ...base, action: deep }).ok).toBe(false);
    expect(id({ ...base, action: "😀".repeat(20_000) }).ok).toBe(false);
  });
});
