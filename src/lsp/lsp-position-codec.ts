/**
 * Source-first LSP position codec (Wave 2 lane P).
 *
 * Every conversion reads actual document source line, never arithmetic-only
 * on JS indices. Covers UTF-8 bytes, UTF-16 code units, UTF-32 code points.
 */

export type PositionEncoding = "utf-8" | "utf-16" | "utf-32";

export const DEFAULT_POSITION_ENCODING: PositionEncoding = "utf-16";

export const SUPPORTED_POSITION_ENCODINGS: readonly PositionEncoding[] = [
  "utf-8",
  "utf-16",
  "utf-32",
] as const;

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, Math.trunc(n)));
}

/** Clamp UTF-16 offset to valid range, snapping lone-surrogate splits back. */
function clampUtf16(line: string, off: number): number {
  const c = clamp(off, 0, line.length);
  const cu = line.charCodeAt(c);
  // Snap forward split (high surrogate at boundary) is caller's choice;
  // here snap backward when landing between surrogate pair.
  if (c > 0 && c < line.length) {
    const prev = line.charCodeAt(c - 1);
    if (prev >= 0xd800 && prev <= 0xdbff && cu >= 0xdc00 && cu <= 0xdfff) return c - 1;
  }
  return c;
}

/** UTF-16 code units -> UTF-8 bytes. Reads line source. */
export function utf16ToUtf8(line: string, utf16Offset: number): number {
  const off = clampUtf16(line, utf16Offset);
  return Buffer.byteLength(line.slice(0, off), "utf-8");
}

/** UTF-8 bytes -> UTF-16 code units. Reads line source. */
export function utf8ToUtf16(line: string, utf8Offset: number): number {
  const total = Buffer.byteLength(line, "utf-8");
  const off = clamp(utf8Offset, 0, total);
  const buf = Buffer.from(line, "utf-8").subarray(0, off);
  // Decode prefix; incomplete trailing sequence decodes to replacement char —
  // count decoded UTF-16 length then snap to valid boundary by re-encoding.
  const prefix = buf.toString("utf-8");
  // If buf ended mid-sequence, toString emits U+FFFD; strip it and step back.
  // A genuine U+FFFD in the source encodes as EF BF BD — when the truncated
  // buffer already ends with those bytes the replacement char is real, not
  // an incomplete sequence, so keep it.
  if (prefix.endsWith("�") && off < total && off > 0) {
    const fffd = Buffer.from("�", "utf-8");
    const tail = buf.subarray(Math.max(0, buf.length - fffd.length));
    if (tail.length === fffd.length && tail.equals(fffd)) return prefix.length;
    // Walk back until prefix re-encodes within budget.
    let len = prefix.length - 1;
    while (len > 0 && Buffer.byteLength(prefix.slice(0, len), "utf-8") > off) len--;
    return len;
  }
  return prefix.length;
}

/** UTF-16 code units -> UTF-32 code points. Reads line source. */
export function utf16ToUtf32(line: string, utf16Offset: number): number {
  const off = clampUtf16(line, utf16Offset);
  return Array.from(line.slice(0, off)).length;
}

/** UTF-32 code points -> UTF-16 code units. Reads line source. */
export function utf32ToUtf16(line: string, codePointOffset: number): number {
  const points = Array.from(line);
  const off = clamp(codePointOffset, 0, points.length);
  return points.slice(0, off).join("").length;
}

/** UTF-8 bytes -> UTF-32 code points. Reads line source. */
export function utf8ToUtf32(line: string, utf8Offset: number): number {
  return utf16ToUtf32(line, utf8ToUtf16(line, utf8Offset));
}

/** UTF-32 code points -> UTF-8 bytes. Reads line source. */
export function utf32ToUtf8(line: string, codePointOffset: number): number {
  return utf16ToUtf8(line, utf32ToUtf16(line, codePointOffset));
}

/** Convert position character from one encoding to another via line source. */
export function convertOffset(
  line: string,
  offset: number,
  from: PositionEncoding,
  to: PositionEncoding,
): number {
  if (from === to) {
    if (from === "utf-8") return clamp(offset, 0, Buffer.byteLength(line, "utf-8"));
    if (from === "utf-32") return clamp(offset, 0, Array.from(line).length);
    return clampUtf16(line, offset);
  }
  const asUtf16 =
    from === "utf-16"
      ? clampUtf16(line, offset)
      : from === "utf-8"
        ? utf8ToUtf16(line, offset)
        : utf32ToUtf16(line, offset);
  if (to === "utf-16") return asUtf16;
  if (to === "utf-8") return utf16ToUtf8(line, asUtf16);
  return utf16ToUtf32(line, asUtf16);
}

function isSupportedEncoding(v: unknown): v is PositionEncoding {
  return v === "utf-8" || v === "utf-16" || v === "utf-32";
}

/**
 * Record negotiated encoding from initialize result. Defaults to utf-16
 * (and records it as such) when server offers nothing usable.
 */
export function resolveNegotiatedEncoding(initResult: unknown): PositionEncoding {
  try {
    const caps = (initResult as Record<string, unknown> | null)?.capabilities;
    const general = (caps as Record<string, unknown> | undefined)?.general as
      | Record<string, unknown>
      | undefined;
    const offered = (general as Record<string, unknown> | undefined)?.positionEncodings;
    if (Array.isArray(offered)) {
      for (const e of offered) if (isSupportedEncoding(e)) return e;
    }
    // Standard LSP 3.17 capability: capabilities.positionEncoding (singular string).
    const positionEncoding = (caps as Record<string, unknown> | undefined)?.positionEncoding;
    if (isSupportedEncoding(positionEncoding)) return positionEncoding;
    const offsetEncoding = (caps as Record<string, unknown> | undefined)?.offsetEncoding;
    if (isSupportedEncoding(offsetEncoding)) return offsetEncoding;
  } catch { /* non-object init result, use default encoding */ }
  return DEFAULT_POSITION_ENCODING;
}

/** True only when all three converters present (they are — single module). */
export function hasAllConverters(): boolean {
  return (
    typeof utf16ToUtf8 === "function" &&
    typeof utf8ToUtf16 === "function" &&
    typeof utf16ToUtf32 === "function" &&
    typeof utf32ToUtf16 === "function" &&
    typeof utf8ToUtf32 === "function" &&
    typeof utf32ToUtf8 === "function"
  );
}

/**
 * Advertise general.positionEncodings only with all three converters present.
 * Returns undefined when incomplete (never today — guard for future splits).
 */
export function positionEncodingsAdvertisement():
  | { general: { positionEncodings: PositionEncoding[] } }
  | undefined {
  if (!hasAllConverters()) return undefined;
  return { general: { positionEncodings: [...SUPPORTED_POSITION_ENCODINGS] } };
}
