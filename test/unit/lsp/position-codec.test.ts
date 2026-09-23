import { describe, expect, it } from "vitest";
import {
  convertOffset,
  DEFAULT_POSITION_ENCODING,
  positionEncodingsAdvertisement,
  resolveNegotiatedEncoding,
  utf16ToUtf32,
  utf16ToUtf8,
  utf32ToUtf16,
  utf32ToUtf8,
  utf8ToUtf16,
  utf8ToUtf32,
} from "../../../src/lsp/lsp-position-codec.js";

const ASTRAL = "a😀b"; // a + U+1F600 (surrogate pair) + b
const EMOJI_SEQ = "👨‍👩‍👧"; // ZWJ sequence, multiple code points
const COMBINING = "e\u0301x"; // e + combining acute + x
const MIXED = "héllo😀世";

describe("position codec ascii", () => {
  it("identity on ascii across encodings", () => {
    expect(utf16ToUtf8("hello", 3)).toBe(3);
    expect(utf8ToUtf16("hello", 3)).toBe(3);
    expect(utf16ToUtf32("hello", 3)).toBe(3);
    expect(utf32ToUtf16("hello", 3)).toBe(3);
  });
});

describe("position codec astral/emoji/combining/mixed", () => {
  it("astral plane char counts 2 utf16, 4 utf8, 1 utf32", () => {
    // "a😀b": utf16 length 4, utf8 bytes 1+4+1=6, points 3
    expect(utf16ToUtf8(ASTRAL, 1)).toBe(1);
    // Offset 2 lands inside the surrogate pair; snap backward to the
    // previous valid character boundary instead of slicing a lone surrogate.
    expect(utf16ToUtf8(ASTRAL, 2)).toBe(1);
    expect(convertOffset(ASTRAL, 2, "utf-16", "utf-16")).toBe(1);
    expect(utf16ToUtf8(ASTRAL, 3)).toBe(5);
    expect(utf16ToUtf32(ASTRAL, 3)).toBe(2);
    expect(utf32ToUtf16(ASTRAL, 2)).toBe(3);
    expect(utf8ToUtf16(ASTRAL, 5)).toBe(3);
    expect(utf8ToUtf32(ASTRAL, 5)).toBe(2);
    expect(utf32ToUtf8(ASTRAL, 2)).toBe(5);
  });
  it("emoji ZWJ sequence round-trips", () => {
    const pts = Array.from(EMOJI_SEQ).length;
    const u16 = EMOJI_SEQ.length;
    const u8 = Buffer.byteLength(EMOJI_SEQ, "utf-8");
    expect(utf16ToUtf32(EMOJI_SEQ, u16)).toBe(pts);
    expect(utf32ToUtf16(EMOJI_SEQ, pts)).toBe(u16);
    expect(utf16ToUtf8(EMOJI_SEQ, u16)).toBe(u8);
    expect(utf8ToUtf16(EMOJI_SEQ, u8)).toBe(u16);
  });
  it("combining mark counts per encoding", () => {
    // "é" as e+acute: utf16 3, utf8 1+2+1=4, points 3
    expect(utf16ToUtf8(COMBINING, 2)).toBe(3);
    expect(utf8ToUtf16(COMBINING, 3)).toBe(2);
    expect(utf16ToUtf32(COMBINING, 2)).toBe(2);
  });
  it("mixed script converts source-first", () => {
    const u16len = MIXED.length;
    const u8len = Buffer.byteLength(MIXED, "utf-8");
    const pts = Array.from(MIXED).length;
    expect(convertOffset(MIXED, u16len, "utf-16", "utf-8")).toBe(u8len);
    expect(convertOffset(MIXED, u8len, "utf-8", "utf-16")).toBe(u16len);
    expect(convertOffset(MIXED, pts, "utf-32", "utf-16")).toBe(u16len);
  });
});

describe("position codec round-trip + negotiation", () => {
  it("round-trips every boundary offset", () => {
    for (const line of [ASTRAL, EMOJI_SEQ, COMBINING, MIXED]) {
      for (let i = 0; i <= line.length; i++) {
        const u8 = utf16ToUtf8(line, i);
        expect(utf8ToUtf16(line, u8)).toBeLessThanOrEqual(line.length);
        const pts = utf16ToUtf32(line, i);
        expect(utf32ToUtf16(line, pts)).toBeLessThanOrEqual(line.length);
      }
      const u8len = Buffer.byteLength(line, "utf-8");
      for (let b = 0; b <= u8len; b++) {
        const u16 = utf8ToUtf16(line, b);
        expect(utf16ToUtf8(line, u16)).toBeLessThanOrEqual(u8len);
      }
    }
  });
  it("defaults to utf-16 and records it", () => {
    expect(DEFAULT_POSITION_ENCODING).toBe("utf-16");
    expect(resolveNegotiatedEncoding(null)).toBe("utf-16");
    expect(resolveNegotiatedEncoding({})).toBe("utf-16");
    expect(resolveNegotiatedEncoding({ capabilities: {} })).toBe("utf-16");
  });
  it("honors server general.positionEncodings", () => {
    expect(
      resolveNegotiatedEncoding({ capabilities: { general: { positionEncodings: ["utf-8"] } } }),
    ).toBe("utf-8");
    expect(
      resolveNegotiatedEncoding({ capabilities: { general: { positionEncodings: ["utf-32"] } } }),
    ).toBe("utf-32");
  });
  it("reads standard capabilities.positionEncoding", () => {
    expect(resolveNegotiatedEncoding({ capabilities: { positionEncoding: "utf-8" } })).toBe("utf-8");
    expect(resolveNegotiatedEncoding({ capabilities: { positionEncoding: "utf-32" } })).toBe("utf-32");
    expect(resolveNegotiatedEncoding({ capabilities: { positionEncoding: "utf-7" } })).toBe("utf-16");
  });
  it("keeps a genuine U+FFFD instead of mistaking it for an incomplete sequence", () => {
    const line = "a�b";
    const offB = Buffer.byteLength("a�", "utf-8");
    expect(utf8ToUtf16(line, offB)).toBe(2);
    expect(utf8ToUtf16(line, Buffer.byteLength(line, "utf-8"))).toBe(line.length);
  });
  it("advertises only with all three converters", () => {
    expect(positionEncodingsAdvertisement()).toEqual({
      general: { positionEncodings: ["utf-8", "utf-16", "utf-32"] },
    });
  });
});
