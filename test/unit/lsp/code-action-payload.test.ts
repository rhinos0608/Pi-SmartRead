import { describe, expect, it } from "vitest";
import { captureCodeActionPayload } from "../../../src/lsp/lsp-code-action-payload.js";
import { ACTION_JSON_MAX_BYTES, ACTION_SERIALIZED_EDIT_MAX_BYTES, canonicalActionJson, snapshotActionJson } from "../../../src/lsp/lsp-action-json.js";

describe("captureCodeActionPayload", () => {
  it("supports an optional byte bound while retaining the 48 KiB default", () => {
    expect(ACTION_JSON_MAX_BYTES).toBe(48 * 1024);
    expect(ACTION_SERIALIZED_EDIT_MAX_BYTES).toBe(16 * 1024 * 1024);
    expect(() => canonicalActionJson("x".repeat(100), { maxBytes: 102 })).not.toThrow();
    expect(() => canonicalActionJson("x".repeat(100), { maxBytes: 101 })).toThrow();
    expect(snapshotActionJson("x".repeat(100), { maxBytes: 102 })).toBe("x".repeat(100));
    expect(() => canonicalActionJson("x".repeat(48 * 1024 - 2))).not.toThrow();
  });
  it("retains an immutable, ordered full wire object while normalizing its display projection", () => {
    const raw = { title: "Fix", diagnostics: [{ message: "d" }], extension: { opaque: [1] }, edit: { documentChanges: [{ textDocument: { uri: "file:///a", version: 2 }, edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "x" }] }] }, data: { z: 1, a: { keep: true } } };
    Object.defineProperty(raw, "__proto__", { value: { safe: true }, enumerable: true });
    const result = captureCodeActionPayload(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const payload = result.payload as { readonly [key: string]: import("../../../src/lsp/lsp-action-json.js").ActionJson };
    expect(Object.keys(payload)).toEqual(Object.keys(raw));
    expect(payload).toEqual(raw);
    expect(result.projection.edit?.changes).toHaveLength(1);
    (raw.data.a as { keep: boolean }).keep = false;
    result.projection.data = { changed: true };
    expect(((payload.data as { readonly a: { readonly keep: boolean } }).a).keep).toBe(true);
    expect(Reflect.set(payload.data as object, "new", 1)).toBe(false);
    expect(result.selectable).toBe(true);
  });

  it("projects the captured snapshot, not later Proxy get values", () => {
    let titleReads = 0;
    const raw = new Proxy({ title: "wire" }, {
      get(target, key, receiver) {
        if (key === "title") { titleReads++; return "projection"; }
        return Reflect.get(target, key, receiver);
      },
    });
    const result = captureCodeActionPayload(raw);
    expect(result).toMatchObject({ ok: true, payload: { title: "wire" }, projection: { title: "wire" } });
    expect(titleReads).toBe(0);
  });

  it("snapshots the same descriptor values it validates for unknown host input", () => {
    let dataDescriptors = 0;
    const raw = new Proxy({ title: "wire", data: 1 }, {
      getOwnPropertyDescriptor(target, key) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
        if (key === "data" && descriptor) {
          return { ...descriptor, value: ++dataDescriptors === 1 ? 1 : Infinity };
        }
        return descriptor;
      },
    });
    expect(captureCodeActionPayload(raw)).toMatchObject({
      ok: true, payload: { data: 1 }, projection: { data: 1 },
    });
  });

  it("accepts exact byte and depth bounds and rejects the next unit", () => {
    expect(canonicalActionJson("x".repeat(48 * 1024 - 2))).toHaveLength(48 * 1024);
    expect(() => canonicalActionJson("x".repeat(48 * 1024 - 1))).toThrow();
    let atLimit: unknown = 0;
    let overLimit: unknown = 0;
    for (let index = 0; index < 64; index++) atLimit = [atLimit];
    for (let index = 0; index < 65; index++) overLimit = [overLimit];
    expect(canonicalActionJson(atLimit)).toBeDefined();
    expect(() => canonicalActionJson(overLimit)).toThrow();
    const sparse = new Array(1);
    expect(() => canonicalActionJson(sparse)).toThrow();
  });

  it("rejects unsafe JSON without invoking accessors", () => {
    let calls = 0;
    const accessor = { title: "a" };
    Object.defineProperty(accessor, "secret", { enumerable: true, get() { calls++; return 1; } });
    expect(captureCodeActionPayload(accessor)).toMatchObject({ ok: false, reason: "invalid-json" });
    expect(calls).toBe(0);
    const cyclic: Record<string, unknown> = { title: "a" }; cyclic.self = cyclic;
    expect(captureCodeActionPayload(cyclic)).toMatchObject({ ok: false, reason: "invalid-json" });
    expect(captureCodeActionPayload({ title: "x".repeat(49 * 1024) })).toMatchObject({ ok: false, reason: "size-limit" });
    expect(captureCodeActionPayload({ title: "a", data: Number.NaN })).toMatchObject({ ok: false, reason: "invalid-json" });
    expect(captureCodeActionPayload({ title: "a", data: new (class extends Array {})() })).toMatchObject({ ok: false, reason: "invalid-json" });
    let deep: unknown = null;
    for (let index = 0; index < 66; index++) deep = [deep];
    expect(captureCodeActionPayload({ title: "a", data: deep })).toMatchObject({ ok: false, reason: "invalid-json" });
    expect(captureCodeActionPayload({ title: "a", command: "x" })).toMatchObject({ ok: true, selectable: false });
    expect(captureCodeActionPayload({ title: "a", disabled: { reason: "no" } })).toMatchObject({ ok: true, selectable: false });
  });
});
