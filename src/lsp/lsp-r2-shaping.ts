/**
 * Round-2 output shaping for reference- and caller-shaped LSP results.
 *
 * Stage A improves the OUTPUT of the operations agents already reach for
 * (`findReferences`, `incomingCalls`) without touching baseline or round-1
 * surfaces: every function here runs only on the r2 variant path.
 *
 * Two shaping pipelines share file-text/enrichment helpers:
 * - `shapeR2References`: group locations by file, attach the trimmed source
 *   line, a syntactic role, and the enclosing declaration.
 * - `shapeR2IncomingCalls`: de-duplicate callers with their call-site lines
 *   while preserving the opaque follow-up `item` verbatim.
 *
 * Fail-open contract: classification and enrichment never drop a hit. Any
 * unreadable file, failed symbol fetch, or exhausted budget yields a
 * degraded field (`"use"`, `null`, `enclosingIncomplete`) instead of an
 * error or a dropped location.
 *
 * Encoding note: `line`/`character` in results stay 0-based in the
 * negotiated encoding, exactly as the strict surface reports them. Line
 * slicing and symbol-range lookups convert to UTF-16 first via the
 * source-first codec, so text, role, and enclosing stay correct under
 * UTF-8/UTF-32 servers.
 */
import { relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { AFFORDANCE_BOUNDS } from "./affordance-contract.js";
import { convertOffset, type PositionEncoding } from "./lsp-position-codec.js";
import { canonicalPathOrFallback } from "../canonical-path.js";
import type { LspCursorStore } from "./lsp-cursor-store.js";
import { isUnderDir } from "./lsp-scope.js";
import type { NormalizedDocumentSymbol } from "./lsp-response-normalizer.js";
import type { LSPCallHierarchyItem, LSPLocation, LSPRange } from "./lsp-types.js";

export type R2ReferenceRole = "import" | "export" | "declaration" | "use";

export interface R2RefEnclosing {
  name: string;
  kind: number;
}

export interface R2ShapedRef {
  line: number;
  character: number;
  role: R2ReferenceRole;
  enclosing: R2RefEnclosing | null;
  text: string;
}

export interface R2FileGroup {
  path: string;
  refs: R2ShapedRef[];
}

export interface R2ReferencesResult {
  total: number;
  returned: number;
  truncated: boolean;
  nextCursor?: string;
  scope?: string;
  filteredOutByScope?: number;
  enclosingIncomplete?: true;
  files: R2FileGroup[];
}

export interface R2CallerSite {
  line: number;
  character: number;
  text: string;
}

export interface R2Caller {
  name: string;
  kind: number;
  path: string;
  line: number;
  character: number;
  callSites: R2CallerSite[];
  /**
   * Call sites dropped because this caller alone exceeded the output bound.
   * Pages advance by whole callers, so these are not reachable by cursor.
   */
  callSitesOmitted?: number;
  /** The exact normalized hierarchy item, preserved for follow-up requests. */
  item: LSPCallHierarchyItem;
}

/** Default page size in r2 when the caller gives no limit (references and callers). */
export const R2_DEFAULT_PAGE = 100;
/** documentSymbols is fetched at most once per distinct file, capped per page. */
export const R2_MAX_SYMBOL_FILES = 25;
/** Trimmed source-line cap per ref/call-site. */
const R2_TEXT_CHARS = 200;
/** Statement-scan bounds for the lexical role classifier. */
const R2_STATEMENT_LOOKBACK_LINES = 20;
const R2_STATEMENT_MAX_CHARS = 8000;

/**
 * LSP SymbolKinds that can enclose a reference: Class (5), Method (6),
 * Property (7), Field (8), Constructor (9), Function (12), Variable (13),
 * Constant (14), Struct (23).
 */
const R2_ENCLOSING_KINDS = new Set([5, 6, 7, 8, 9, 12, 13, 14, 23]);

export interface R2Position {
  line: number;
  character: number;
}

/** Unknown or future encodings fail open to UTF-16 (JS string indexing). */
export function asR2Encoding(value: unknown): PositionEncoding {
  return value === "utf-8" || value === "utf-16" || value === "utf-32" ? value : "utf-16";
}

/** Negotiated character offset to a UTF-16 (JS string) index via line source. */
function utf16Index(lineText: string, character: number, encoding: PositionEncoding): number {
  if (encoding === "utf-16") return Math.max(0, Math.min(character, lineText.length));
  return convertOffset(lineText, character, encoding, "utf-16");
}

/** Map symbol ranges from the negotiated encoding to UTF-16 so reference
 *  lookups compare in one consistent unit. Reported positions are untouched. */
function utf16SymbolRanges(
  symbols: NormalizedDocumentSymbol[],
  lines: string[],
  encoding: PositionEncoding,
): NormalizedDocumentSymbol[] {
  if (encoding === "utf-16") return symbols;
  const convertRange = (range: LSPRange): LSPRange => ({
    start: { line: range.start.line, character: convertOffset(lines[range.start.line] ?? "", range.start.character, encoding, "utf-16") },
    end: { line: range.end.line, character: convertOffset(lines[range.end.line] ?? "", range.end.character, encoding, "utf-16") },
  });
  const convertSymbol = (symbol: NormalizedDocumentSymbol): NormalizedDocumentSymbol => ({
    ...symbol,
    range: convertRange(symbol.range),
    selectionRange: convertRange(symbol.selectionRange),
    ...(symbol.children ? { children: symbol.children.map(convertSymbol) } : {}),
  });
  return symbols.map(convertSymbol);
}

/**
 * Opaque query identity bound into r2 cursors. A continuation must repeat
 * the same path, position, and scope (references) or item (callers): any
 * mismatch resolves to null, which surfaces as an `invalid cursor` caller
 * error through the existing handling instead of silently reusing an offset.
 */
export function r2ReferencesCursorIdentity(absPath: string, pos: R2Position, scopeAbs: string | null): string {
  return JSON.stringify(["findReferences", canonicalPathOrFallback(absPath), pos.line, pos.character, scopeAbs]);
}

export function r2CallsCursorIdentity(itemUri: string | null, selStart: R2Position | null): string {
  return JSON.stringify(["incomingCalls", itemUri, selStart?.line ?? null, selStart?.character ?? null]);
}

function containsPos(range: LSPRange, pos: R2Position): boolean {
  const { start, end } = range;
  const afterStart = pos.line > start.line || (pos.line === start.line && pos.character >= start.character);
  const beforeEnd = pos.line < end.line || (pos.line === end.line && pos.character <= end.character);
  return afterStart && beforeEnd;
}

function uriToAbs(uri: string): string | null {
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}

function posixRel(root: string, abs: string): string {
  return relative(root, abs).split(sep).join("/");
}

// ── Lexical role classifier ────────────────────────────────────────────
// Bounded statement scan (multi-line import/export braces included);
// syntactic, never semantic; fails open to "use". Line/character are
// UTF-16 (JS string) indices: callers convert from the negotiated encoding
// first (see utf16Index), so comparisons stay in one consistent unit.

function braceDepth(text: string): number {
  let depth = 0;
  for (const ch of text) {
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
  }
  return depth;
}

// A line skipped while walking a statement upward: blank or comment-only.
// Skipped lines are walked past but excluded from the scanned block, so a
// `;` inside a comment can never split the statement.
function isSkippedLine(text: string): boolean {
  const t = text.trim();
  return t === "" || t.startsWith("//") || t.startsWith("/*") || t.startsWith("*") || t.endsWith("*/");
}

// A code line whose balanced braces still continue the statement below:
// an unclosed opener or a trailing comma/paren. Tiebreak only — brace
// depth decides first, so a closed previous statement never joins.
function prevLineContinues(text: string): boolean {
  const t = text.trimEnd();
  return t.endsWith("{") || t.endsWith(",") || t.endsWith("(");
}

function statementSegment(lines: string[], line: number, character: number): { text: string; refOffset: number } | null {
  if (line < 0 || line >= lines.length) return null;
  // The ref line is always scanned. Previous lines join the scan while
  // they are blank/comment-only or the accumulated braces are unbalanced;
  // a balanced previous line joins only when it visibly continues (open
  // brace, comma, paren), and a line that would close the balance ends the
  // statement. All bounds keep the scan cheap and total: the classifier
  // below never throws and fails open to "use".
  const taken: string[] = [lines[line] ?? ""];
  let start = line;
  let walked = 0;
  let length = taken[0]!.length;
  while (start > 0 && walked < R2_STATEMENT_LOOKBACK_LINES && length < R2_STATEMENT_MAX_CHARS) {
    const prev = lines[start - 1] ?? "";
    const acc = taken.join("\n");
    if (!isSkippedLine(prev) && braceDepth(acc) === 0 && braceDepth(`${prev}\n${acc}`) <= 0 && !prevLineContinues(prev)) break;
    start -= 1;
    walked += 1;
    length += prev.length + 1;
    if (!isSkippedLine(prev)) taken.unshift(prev);
  }
  const block = taken.join("\n");
  const lineText = lines[line] ?? "";
  const refInLine = Math.max(0, Math.min(character, lineText.length));
  const refOffset = Math.min(block.length, (taken.length > 1 ? taken.slice(0, -1).join("\n").length + 1 : 0) + refInLine);
  const segStart = block.lastIndexOf(";", refOffset - 1) + 1;
  let segEnd = block.indexOf(";", refOffset);
  if (segEnd === -1) segEnd = block.length;
  return { text: block.slice(segStart, segEnd), refOffset: refOffset - segStart };
}

function isStaticImportStatement(segment: string): boolean {
  const head = /^\s*import(?![\w$])/.exec(segment);
  if (!head) return false;
  const after = segment.slice(head[0].length).trimStart();
  // Dynamic import() and import.meta are uses, not import bindings.
  if (after.startsWith("(") || after.startsWith(".")) return false;
  return true;
}

function refInBraces(segment: string, refOffset: number): boolean {
  let depth = 0;
  for (let i = 0; i < segment.length; i += 1) {
    if (segment[i] === "{") depth += 1;
    else if (segment[i] === "}") depth = Math.max(0, depth - 1);
    if (i === refOffset) return depth > 0;
  }
  return false;
}

function isDefaultExportIdentifier(segment: string): boolean {
  if (!/^\s*export\s+default(?![\w$])/.test(segment)) return false;
  // `export default function foo` / `export default class Foo` declare a
  // name; a bare `export default foo` re-exports an existing binding.
  return !/^\s*export\s+default\s+(abstract\s+)?(function|class)\b/.test(segment);
}

function isExportSpecifierName(segment: string, refOffset: number): boolean {
  // `export {…}` / `export type {…}` (with or without `from`): only a name
  // inside the specifier braces is an export binding. Uses elsewhere in an
  // export statement (object literals, JSX, call arguments) are not.
  if (!/^\s*export\s+(type\s+)?\{/.test(segment)) return false;
  return refInBraces(segment, refOffset);
}

function isExportEqualsName(segment: string, id: string): boolean {
  return new RegExp(`^\\s*export\\s*=\\s*${id}(?![\\w$])`).test(segment);
}

function isNamespaceReExportName(segment: string, id: string): boolean {
  return new RegExp(`^\\s*export\\s*\\*\\s*as\\s+${id}(?![\\w$])`).test(segment);
}

function identifierAt(lineText: string, character: number): string | null {
  const offset = Math.max(0, Math.min(character, lineText.length));
  let start = offset;
  while (start > 0 && /[\w$]/.test(lineText[start - 1] ?? "")) start -= 1;
  let end = offset;
  while (end < lineText.length && /[\w$]/.test(lineText[end] ?? "")) end += 1;
  if (start >= end) return null;
  return lineText.slice(start, end);
}

function isLexicalDeclaration(lineText: string, id: string | null): boolean {
  if (!id) return false;
  return (
    new RegExp(`\\bfunction\\s*\\*?\\s*${id}\\b`).test(lineText) ||
    new RegExp(`\\bclass\\s+${id}\\b`).test(lineText) ||
    new RegExp(`\\b(const|let|var)\\s+${id}(?=\\s*[:=;,])`).test(lineText) ||
    new RegExp(`\\b(interface|type|enum)\\s+${id}\\b`).test(lineText)
  );
}

function declaresPos(symbol: NormalizedDocumentSymbol, pos: R2Position): boolean {
  if (containsPos(symbol.selectionRange, pos)) return true;
  return symbol.children?.some((child) => declaresPos(child, pos)) ?? false;
}

function isDeclaration(
  lines: string[],
  line: number,
  character: number,
  symbols: NormalizedDocumentSymbol[] | null,
): boolean {
  const pos = { line, character };
  if (symbols?.some((s) => declaresPos(s, pos))) return true;
  return isLexicalDeclaration(lines[line] ?? "", identifierAt(lines[line] ?? "", character));
}

export function classifyReferenceRole(
  lines: string[],
  line: number,
  character: number,
  symbols: NormalizedDocumentSymbol[] | null,
): R2ReferenceRole {
  const segment = statementSegment(lines, line, character);
  if (segment) {
    if (isStaticImportStatement(segment.text)) return "import";
    if (/^\s*export(?![\w$])/.test(segment.text)) {
      // "export" is only an export binding in four syntactic positions:
      // a name inside `export {…}` / `export type {…}`, a bare
      // `export default <id>`, `export = <id>`, or the `ns` in
      // `export * as ns`. Anything else (declared names, uses inside
      // exported literals/JSX) falls through to declaration/use.
      if (isExportSpecifierName(segment.text, segment.refOffset)) return "export";
      if (isDefaultExportIdentifier(segment.text)) return "export";
      const id = identifierAt(lines[line] ?? "", character);
      if (id !== null) {
        if (isExportEqualsName(segment.text, id)) return "export";
        if (isNamespaceReExportName(segment.text, id)) return "export";
      }
    }
  }
  return isDeclaration(lines, line, character, symbols) ? "declaration" : "use";
}

export function findR2Enclosing(
  symbols: NormalizedDocumentSymbol[],
  pos: R2Position,
): R2RefEnclosing | null {
  const best: { current: { name: string; kind: number; depth: number; size: number } | null } = { current: null };
  const visit = (list: NormalizedDocumentSymbol[] | undefined, depth: number): void => {
    for (const s of list ?? []) {
      if (R2_ENCLOSING_KINDS.has(s.kind) && containsPos(s.range, pos)) {
        const size = (s.range.end.line - s.range.start.line) * 1_000_000_000 + (s.range.end.character - s.range.start.character);
        const prev = best.current;
        if (!prev || depth > prev.depth || (depth === prev.depth && size < prev.size)) {
          best.current = { name: s.name, kind: s.kind, depth, size };
        }
      }
      visit(s.children, depth + 1);
    }
  };
  visit(symbols, 0);
  const found = best.current;
  return found ? { name: found.name, kind: found.kind } : null;
}

// ── Reference shaping ──────────────────────────────────────────────────

export interface R2ShapingDeps {
  /** Absolute workspace root; canonicalized (symlinks resolved) internally. */
  root: string;
  /** File lines by absolute path, or null when unreadable. */
  readLines: (absPath: string) => string[] | null;
  /**
   * documentSymbols per absolute path. Called at most once per shaping
   * with at most R2_MAX_SYMBOL_FILES paths; keys of the returned map must
   * be the exact strings given. Null values mark that file incomplete. A
   * rejection named AbortError aborts the whole shaping and propagates to
   * the caller; any other rejection fails every file open to null.
   */
  fetchSymbols: (absPaths: string[]) => Promise<Map<string, NormalizedDocumentSymbol[] | null>>;
  cursors: LspCursorStore;
  now?: () => number;
}

function trimLine(lines: string[] | null, line: number): string {
  if (!lines) return "";
  return (lines[line] ?? "").trim().slice(0, R2_TEXT_CHARS);
}

interface R2PreparedLocation {
  rel: string;
  key: string | null;
  line: number;
  character: number;
}

function filterAndSortR2Locations(args: {
  locations: LSPLocation[];
  root: string;
  scoped: boolean;
  scopeAbs?: string | null;
  scopeIsFile?: boolean;
}): { kept: R2PreparedLocation[]; filteredOutByScope: number } {
  const { locations, root, scoped, scopeAbs, scopeIsFile } = args;
  const kept: R2PreparedLocation[] = [];
  let filteredOutByScope = 0;
  for (const location of locations) {
    const abs = uriToAbs(location.uri);
    const canonical = abs ? canonicalPathOrFallback(abs) : null;
    if (scoped && canonical) {
      const inside = scopeIsFile ? canonical === scopeAbs : isUnderDir(canonical, scopeAbs!);
      if (!inside) {
        filteredOutByScope += 1;
        continue;
      }
      // Unresolvable alias: keep rather than guessing scope.
    }
    kept.push({
      rel: canonical ? posixRel(root, canonical) : location.uri,
      key: canonical ?? abs,
      line: location.range.start.line,
      character: location.range.start.character,
    });
  }
  kept.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : a.line - b.line || a.character - b.character));
  return { kept, filteredOutByScope };
}

function pageR2List<T>(items: T[], limit: number | undefined, cursor: string | undefined, cursors: LspCursorStore, identity?: string): { page: T[]; offset: number; lim: number } {
  let offset = 0;
  if (cursor !== undefined) {
    const resolved = identity === undefined ? cursors.resolve(cursor) : cursors.resolve(cursor, { identity });
    if (resolved === null) throw new Error("invalid cursor");
    offset = resolved;
  }
  const lim = limit ?? R2_DEFAULT_PAGE;
  return { page: items.slice(offset, offset + lim), offset, lim };
}

export async function shapeR2References(args: {
  locations: LSPLocation[];
  scopeAbs?: string | null;
  scopeIsFile?: boolean;
  scopeEcho?: string;
  limit?: number;
  cursor?: string;
  /** Query identity the page cursor is bound to; continuations must repeat it. */
  cursorIdentity?: string;
  /** Negotiated position encoding of the reported locations and symbols. */
  encoding?: PositionEncoding;
  outputBytes?: number;
  deps: R2ShapingDeps;
}): Promise<R2ReferencesResult> {
  const { locations, limit, cursor, deps } = args;
  const total = locations.length;
  const root = canonicalPathOrFallback(deps.root);
  const scoped = args.scopeEcho !== undefined && args.scopeAbs != null;
  const { kept, filteredOutByScope } = filterAndSortR2Locations({
    locations, root, scoped, scopeAbs: args.scopeAbs, scopeIsFile: args.scopeIsFile,
  });
  const { page, offset, lim } = pageR2List(kept, limit, cursor, deps.cursors, args.cursorIdentity);

  const lineCache = new Map<string, string[] | null>();
  const getLines = (key: string | null): string[] | null => {
    if (key === null) return null;
    let cached = lineCache.get(key);
    if (cached === undefined) {
      cached = deps.readLines(key);
      lineCache.set(key, cached);
    }
    return cached;
  };
  const distinctFiles: string[] = [];
  for (const entry of page) {
    if (entry.key !== null && !distinctFiles.includes(entry.key)) distinctFiles.push(entry.key);
  }
  let symbolMap = new Map<string, NormalizedDocumentSymbol[] | null>();
  try {
    symbolMap = await deps.fetchSymbols(distinctFiles.slice(0, R2_MAX_SYMBOL_FILES));
  } catch (err) {
    // AbortError aborts the whole shaping (caller reports cancelled);
    // anything else fails every file open to null so no hit is dropped.
    if ((err as { name?: string } | null)?.name === "AbortError") throw err;
    symbolMap = new Map();
  }

function enrichR2Page(page: R2PreparedLocation[], getLines: (key: string | null) => string[] | null, symbolMap: Map<string, NormalizedDocumentSymbol[] | null>, encoding: PositionEncoding): { files: R2FileGroup[]; enclosingIncomplete: boolean } {
  let enclosingIncomplete = false;
  const groups = new Map<string, R2ShapedRef[]>();
  const order: string[] = [];
  // Symbol ranges arrive in the negotiated encoding; convert each file's
  // symbols once so role and enclosing lookups compare UTF-16 to UTF-16.
  const utf16ByFile = new Map<string, NormalizedDocumentSymbol[] | null>();
  for (const [key, symbols] of symbolMap) {
    utf16ByFile.set(key, symbols === null ? null : utf16SymbolRanges(symbols, getLines(key) ?? [], encoding));
  }
  for (const entry of page) {
    const lines = getLines(entry.key);
    const symbols = entry.key === null ? null : (utf16ByFile.get(entry.key) ?? null);
    const lineText = lines?.[entry.line] ?? "";
    // The reported character stays in the negotiated encoding; only the
    // lookup index is converted to UTF-16 for line slicing and comparison.
    const lookup = utf16Index(lineText, entry.character, encoding);
    const shaped = (role: R2ReferenceRole, enclosing: R2RefEnclosing | null): R2ShapedRef => ({
      line: entry.line, character: entry.character, role, enclosing, text: trimLine(lines, entry.line),
    });
    let ref: R2ShapedRef;
    if (entry.key === null || lines === null) {
      enclosingIncomplete = true;
      ref = shaped("use", null);
    } else {
      if (symbols === null) enclosingIncomplete = true;
      ref = shaped(
        classifyReferenceRole(lines, entry.line, lookup, symbols),
        symbols ? findR2Enclosing(symbols, { line: entry.line, character: lookup }) : null,
      );
    }
    const list = groups.get(entry.rel);
    if (list) list.push(ref);
    else {
      groups.set(entry.rel, [ref]);
      order.push(entry.rel);
    }
  }
  return { files: order.map((path) => ({ path, refs: groups.get(path)! })), enclosingIncomplete };
}

function shrinkR2Files(args: {
  files: R2FileGroup[];
  total: number;
  offset: number;
  lim: number;
  keptLength: number;
  scoped: boolean;
  scopeEcho?: string;
  filteredOutByScope?: number;
  enclosingIncomplete: boolean;
  bound: number;
  cursors: LspCursorStore;
  cursorIdentity?: string;
}): { returned: number; truncated: boolean; nextCursor?: string } {
  const { files, total, offset, lim, keptLength, scoped, scopeEcho, filteredOutByScope, enclosingIncomplete, bound, cursors, cursorIdentity } = args;
  let returned = files.reduce((n, g) => n + g.refs.length, 0);
  let truncated = offset + lim < keptLength;
  // Measure the shape as returned, including a cursor allowance: real
  // cursor tokens are ~30 chars, so a 64-char placeholder keeps the
  // final object under the bound once the real cursor is minted.
  const bytes = (): number => Buffer.byteLength(JSON.stringify({
    total, returned, truncated,
    ...(truncated ? { nextCursor: "x".repeat(64) } : {}),
    ...(scoped ? { scope: scopeEcho!, filteredOutByScope } : {}),
    ...(enclosingIncomplete ? { enclosingIncomplete: true as const } : {}),
    files,
  }), "utf8");
  while (returned > 1 && bytes() > bound) {
    const last = files[files.length - 1]!;
    last.refs.pop();
    if (last.refs.length === 0) files.pop();
    returned -= 1;
    truncated = true;
  }
  const cursorOffset = offset + returned;
  return {
    returned,
    truncated,
    ...(truncated
      ? { nextCursor: cursorIdentity === undefined ? cursors.create(cursorOffset) : cursors.create(cursorOffset, { identity: cursorIdentity }) }
      : {}),
  };
}
  const { files, enclosingIncomplete } = enrichR2Page(page, getLines, symbolMap, asR2Encoding(args.encoding));
  const tail = shrinkR2Files({
    files, total, offset, lim, keptLength: kept.length, scoped,
    ...(scoped ? { scopeEcho: args.scopeEcho, filteredOutByScope } : {}),
    enclosingIncomplete, bound: args.outputBytes ?? AFFORDANCE_BOUNDS.outputBytes, cursors: deps.cursors,
    ...(args.cursorIdentity === undefined ? {} : { cursorIdentity: args.cursorIdentity }),
  });
  return {
    total,
    returned: tail.returned,
    truncated: tail.truncated,
    ...(tail.nextCursor ? { nextCursor: tail.nextCursor } : {}),
    ...(scoped ? { scope: args.scopeEcho!, filteredOutByScope } : {}),
    ...(enclosingIncomplete ? { enclosingIncomplete: true as const } : {}),
    files,
  };
}

// ── Caller shaping ─────────────────────────────────────────────────────

export function shapeR2IncomingCalls(args: {
  calls: Array<{ from: LSPCallHierarchyItem; fromRanges: LSPRange[] }>;
  limit?: number;
  cursor?: string;
  /** Query identity the page cursor is bound to; continuations must repeat it. */
  cursorIdentity?: string;
  outputBytes?: number;
  root: string;
  readLines: (absPath: string) => string[] | null;
  cursors: LspCursorStore;
}): { result: { callers: R2Caller[] }; truncated: boolean; nextCursor?: string } {
  const { calls, limit, cursor, root, readLines, cursors } = args;
  const canonRoot = canonicalPathOrFallback(root);
  const merged = new Map<string, { from: LSPCallHierarchyItem; fromRanges: LSPRange[] }>();
  for (const call of calls) {
    const key = `${call.from.uri}::${call.from.selectionRange.start.line}:${call.from.selectionRange.start.character}::${call.from.name}`;
    const existing = merged.get(key);
    if (existing) existing.fromRanges.push(...call.fromRanges);
    else merged.set(key, { from: call.from, fromRanges: [...call.fromRanges] });
  }
  const lineCache = new Map<string, string[] | null>();
  const getLines = (abs: string | null): string[] | null => {
    if (abs === null) return null;
    let cached = lineCache.get(abs);
    if (cached === undefined) {
      try {
        cached = readLines(abs);
      } catch {
        cached = null;
      }
      lineCache.set(abs, cached);
    }
    return cached;
  };
  const callers: R2Caller[] = [...merged.values()].map(({ from, fromRanges }) => {
    const abs = uriToAbs(from.uri);
    const canonical = abs ? canonicalPathOrFallback(abs) : null;
    const lines = canonical ? getLines(canonical) : null;
    return {
      name: from.name,
      kind: from.kind,
      path: canonical ? posixRel(canonRoot, canonical) : from.uri,
      line: from.selectionRange.start.line,
      character: from.selectionRange.start.character,
      callSites: fromRanges.map((range) => ({
        line: range.start.line,
        character: range.start.character,
        text: lines ? (lines[range.start.line] ?? "").trim().slice(0, R2_TEXT_CHARS) : "",
      })),
      item: from,
    };
  });
  callers.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line || a.character - b.character));

  const { page, offset, lim } = pageR2List(callers, limit, cursor, cursors, args.cursorIdentity);
  const tail = shrinkR2Callers({
    callers: page, offset, total: callers.length, lim,
    bound: args.outputBytes ?? AFFORDANCE_BOUNDS.outputBytes, cursors,
    ...(args.cursorIdentity === undefined ? {} : { cursorIdentity: args.cursorIdentity }),
  });
  return {
    result: { callers: tail.callers },
    truncated: tail.truncated,
    ...(tail.nextCursor ? { nextCursor: tail.nextCursor } : {}),
  };
}

function shrinkR2Callers(args: {
  callers: R2Caller[];
  offset: number;
  total: number;
  lim: number;
  bound: number;
  cursors: LspCursorStore;
  cursorIdentity?: string;
}): { callers: R2Caller[]; truncated: boolean; nextCursor?: string } {
  const { callers, offset, total, lim, bound, cursors, cursorIdentity } = args;
  let truncated = offset + lim < total;
  // Same 48 KiB discipline as references, never cutting mid-object. The
  // placeholder reserves cursor space in the measurement.
  const bytes = (): number => Buffer.byteLength(JSON.stringify({
    callers,
    ...(truncated ? { nextCursor: "x".repeat(64) } : {}),
  }), "utf8");
  // Pages advance by whole callers, so only whole trailing callers may be
  // deferred: the cursor then resumes at the first caller not shown.
  while (bytes() > bound && callers.length > 1) {
    callers.pop();
    truncated = true;
  }
  // A lone caller that still exceeds the bound keeps its leading call sites
  // and states how many it dropped, since call sites are not cursor-addressable.
  const only = callers.length === 1 ? callers[0]! : undefined;
  if (only !== undefined && bytes() > bound && only.callSites.length > 1) {
    const all = only.callSites.length;
    while (bytes() > bound && only.callSites.length > 1) {
      only.callSites.pop();
      only.callSitesOmitted = all - only.callSites.length;
    }
  }
  const cursorOffset = offset + callers.length;
  return {
    callers,
    truncated,
    ...(truncated
      ? { nextCursor: cursorIdentity === undefined ? cursors.create(cursorOffset) : cursors.create(cursorOffset, { identity: cursorIdentity }) }
      : {}),
  };
}
