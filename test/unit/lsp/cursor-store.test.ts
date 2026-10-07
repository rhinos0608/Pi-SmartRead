import { describe, expect, it } from "vitest";
import { LspCursorStore } from "../../../src/lsp/lsp-cursor-store.js";

describe("LspCursorStore", () => {
  it("round-trips offset 0", () => {
    const s = new LspCursorStore();
    expect(s.resolve(s.create(0, { now: 1000 }), { now: 1000 })).toBe(0);
  });

  it("round-trips a large offset", () => {
    const s = new LspCursorStore();
    expect(s.resolve(s.create(12345, { now: 1000 }), { now: 1000 })).toBe(12345);
  });

  it("returns null for unknown token", () => {
    const s = new LspCursorStore();
    expect(s.resolve("AAAAAAAAAAAAAAAAAAAAAA", { now: 1000 })).toBeNull();
  });

  it("returns null for empty/garbage token", () => {
    const s = new LspCursorStore();
    expect(s.resolve("", { now: 1000 })).toBeNull();
    expect(s.resolve("!!!not-a-token!!!", { now: 1000 })).toBeNull();
  });

  it("returns null for tampered token", () => {
    const s = new LspCursorStore();
    const token = s.create(7, { now: 1000 });
    // Flip a non-trailing char: avoids trailing-A alias flakiness (last
    // base64url char's low bits are truncated on decode).
    const idx = token.length > 2 ? 1 : 0;
    const flipped = token[idx] === "A" ? "B" : "A";
    const tampered = token.slice(0, idx) + flipped + token.slice(idx + 1);
    expect(s.resolve(tampered, { now: 1000 })).toBeNull();
    // Non-canonical aliases of a valid token must also reject: padding and
    // trailing-char low-bit variants decode to the same bytes.
    expect(s.resolve(token + "=", { now: 1000 })).toBeNull();
    const last = token[token.length - 1]!;
    for (const alias of ["A", "B", "E", "Q"]) {
      if (alias === last) continue;
      const variant = token.slice(0, -1) + alias;
      let sameBytes = false;
      try {
        sameBytes = Buffer.from(variant, "base64url").equals(
          Buffer.from(token, "base64url"),
        );
      } catch {
        sameBytes = false;
      }
      if (sameBytes) expect(s.resolve(variant, { now: 1000 })).toBeNull();
    }
  });

  it("throws on negative offset", () => {
    expect(() => new LspCursorStore().create(-1)).toThrow(RangeError);
  });

  it("throws on non-integer offsets", () => {
    const s = new LspCursorStore();
    expect(() => s.create(1.5)).toThrow(RangeError);
    expect(() => s.create(NaN)).toThrow(RangeError);
    expect(() => s.create(Infinity)).toThrow(RangeError);
  });

  it("does not leak offset in token plaintext", () => {
    const s = new LspCursorStore();
    const token = s.create(999999, { now: 1000 });
    expect(token).not.toContain("999999");
    expect(Buffer.from(token, "base64url").toString("utf8")).not.toContain("999999");
  });

  it("evicts oldest on 257th create", () => {
    const s = new LspCursorStore();
    const tokens: string[] = [];
    for (let i = 0; i < 256; i++) tokens.push(s.create(i, { now: 1000 }));
    expect(s.size()).toBe(256);
    const latest = s.create(1000, { now: 1000 });
    expect(s.size()).toBe(256);
    expect(s.resolve(tokens[0]!, { now: 1000 })).toBeNull();
    expect(s.resolve(latest, { now: 1000 })).toBe(1000);
    expect(s.resolve(tokens[1]!, { now: 1000 })).toBe(1);
  });

  it("expires entries after TTL via injected clock", () => {
    const s = new LspCursorStore();
    const token = s.create(42, { now: 0 });
    expect(s.resolve(token, { now: 10 * 60 * 1000 })).toBe(42);
    expect(s.resolve(token, { now: 10 * 60 * 1000 + 1 })).toBeNull();
  });

  it("size() reflects creates and TTL sweeps", () => {
    const s = new LspCursorStore();
    expect(s.size()).toBe(0);
    const a = s.create(1, { now: 0 });
    const b = s.create(2, { now: 0 });
    expect(s.size()).toBe(2);
    s.resolve(a, { now: 10 * 60 * 1000 + 5 });
    expect(s.size()).toBe(1);
    expect(s.resolve(b, { now: 1000 })).toBe(2);
  });
});
