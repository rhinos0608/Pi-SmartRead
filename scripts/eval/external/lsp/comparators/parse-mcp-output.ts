/**
 * Pure parsers for mcp-language-server (isaacphi, BSD-3-Clause, v0.1.1)
 * MCP tool text outputs. All coordinates in tool text are 1-indexed
 * (L#:C#); parsed locations are converted to 0-based UTF-16 LSP positions.
 *
 * Formats (from internal/tools/*.go at v0.1.1):
 * - definition(symbolName): per-symbol blocks
 *     "---\n\nSymbol: <name>\nFile: <abs path>\n[Kind: ...\n][Container Name: ...\n]Range: L<l>:C<c> - L<l>:C<c>\n\n<code...>"
 *   or "<name> not found".
 * - references(symbolName): per-file blocks
 *     "---\n\n<abs path>\nReferences in File: <n>\nAt: L<l>:C<c>, ...\n\n<code...>"
 *   or "No references found for symbol: <name>". Only START positions are
 *   reported, so locations are emitted as points (end == start).
 * - hover(filePath, line, column): hover markdown text, or
 *   "No hover information available for this position ...".
 */
import type { BenchLocation } from "../metrics.js";
import { pointLoc } from "./types.js";

export interface ParsedLocations {
  /** "ok" | "empty" — empty means explicit no-result text, not an error. */
  status: "ok" | "empty";
  locations: BenchLocation[];
}

const RANGE_RE =
  /^Range:\s*L(\d+):C(\d+)\s*-\s*L(\d+):C(\d+)\s*$/;
const FILE_RE = /^File:\s*(.+?)\s*$/;
const AT_RE = /\bL(\d+):C(\d+)\b/g;

/** Parse a `definition` tool response for one queried symbol. */
export function parseMcpDefinition(
  text: string,
  canonicalize: (file: string) => string | null,
): ParsedLocations {
  if (/not found\s*$/m.test(text.trimEnd())) return { status: "empty", locations: [] };
  const locations: BenchLocation[] = [];
  const lines = text.split("\n");
  let file: string | null = null;
  for (const line of lines) {
    const f = FILE_RE.exec(line.trim());
    if (f?.[1] !== undefined) {
      file = f[1];
      continue;
    }
    const r = RANGE_RE.exec(line.trim());
    if (r?.[1] !== undefined && r?.[2] !== undefined && r?.[3] !== undefined && r?.[4] !== undefined && file !== null) {
      const canon = canonicalize(file);
      if (canon === null) {
        file = null;
        continue;
      }
      const sl = Number(r[1]) - 1;
      const sc = Number(r[2]) - 1;
      const el = Number(r[3]) - 1;
      const ec = Number(r[4]) - 1;
      if (sl >= 0 && sc >= 0 && el >= 0 && ec >= 0) {
        locations.push({
          file: canon,
          start: { file: canon, line: sl, character: sc },
          end: { file: canon, line: el, character: ec },
        });
      }
      file = null;
    }
  }
  return { status: locations.length > 0 ? "ok" : "empty", locations };
}

/**
 * Parse a `references` tool response. Returns point locations grouped by the
 * per-file header path that precedes each "At:" line.
 */
export function parseMcpReferences(
  text: string,
  canonicalize: (file: string) => string | null,
): ParsedLocations {
  if (/No references found for symbol:/.test(text)) return { status: "empty", locations: [] };
  const locations: BenchLocation[] = [];
  // Split into per-file blocks on the "---" banner; the header path is the
  // first non-empty line of each block.
  for (const block of text.split(/^---$/m)) {
    const blockLines = block.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    if (blockLines.length === 0) continue;
    const header = blockLines[0] ?? "";
    if (!header.startsWith("/")) continue;
    const canon = canonicalize(header);
    if (canon === null) continue;
    const atLine = blockLines.find((l) => l.startsWith("At:"));
    if (!atLine) continue;
    for (const m of atLine.matchAll(AT_RE)) {
      const l = Number(m[1]) - 1;
      const c = Number(m[2]) - 1;
      if (l >= 0 && c >= 0) locations.push(pointLoc(canon, l, c));
    }
  }
  return { status: locations.length > 0 ? "ok" : "empty", locations };
}

export interface ParsedHover {
  status: "ok" | "empty";
  text: string;
}

/** Parse a `hover` tool response. */
export function parseMcpHover(text: string): ParsedHover {
  const trimmed = text.trim();
  if (
    trimmed.length === 0 ||
    trimmed.startsWith("No hover information available")
  ) {
    return { status: "empty", text: trimmed };
  }
  return { status: "ok", text };
}
