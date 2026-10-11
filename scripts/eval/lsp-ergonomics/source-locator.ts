import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { extname } from "node:path";
import Parser from "tree-sitter";
import { createRequire } from "node:module";

export interface SourceIdentifierTarget {
  path: string;
  /** One-based physical source line. */
  line: number;
  identifier: string;
  occurrence?: number;
}

export interface SourceTokenSpan {
  /** UTF-16 code-unit offset into the exact source text. */
  start: number;
  /** Exclusive UTF-16 code-unit offset into the exact source text. */
  end: number;
}

export type SourceLocatorResult =
  | { status: "found"; canonicalPath: string; sourceSha256: string; sourcePositionUtf16: { line: number; character: number }; tokenSpan: SourceTokenSpan }
  | { status: "notfound" }
  | { status: "ambiguous"; displayedMatches: Array<{ character: number; tokenSpan: SourceTokenSpan }>; totalMatches: number }
  | { status: "unsupported"; reason: string }
  | { status: "incomplete"; reason: string }
  | { status: "invalid"; reason: string };

export interface SourceLocatorOptions {
  signal?: AbortSignal;
  deadlineMs?: number;
  maxFileBytes?: number;
  maxNodes?: number;
  maxMatches?: number;
  maxDisplayedMatches?: number;
  languageLoader?: (family: SourceLanguageFamily) => unknown;
}

export type SourceLanguageFamily = "typescript" | "tsx" | "javascript" | "python" | "rust" | "go";

const DEFAULTS = { deadlineMs: 15_000, maxFileBytes: 1024 * 1024, maxNodes: 100_000, maxMatches: 100, maxDisplayedMatches: 10 };
const ALLOWED_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs", ".py", ".rs", ".go"]);
const IDENTIFIER_TYPES: Record<SourceLanguageFamily, ReadonlySet<string>> = {
  typescript: new Set(["identifier", "type_identifier", "property_identifier", "shorthand_property_identifier", "shorthand_property_identifier_pattern", "jsx_identifier"]),
  tsx: new Set(["identifier", "type_identifier", "property_identifier", "shorthand_property_identifier", "shorthand_property_identifier_pattern", "jsx_identifier"]),
  javascript: new Set(["identifier", "property_identifier", "shorthand_property_identifier", "shorthand_property_identifier_pattern", "jsx_identifier"]),
  python: new Set(["identifier"]),
  rust: new Set(["identifier", "type_identifier", "field_identifier"]),
  go: new Set(["identifier", "field_identifier", "package_identifier", "type_identifier"]),
};
const TARGET_FIELDS = new Set(["path", "line", "identifier", "occurrence"]);
const OPTION_FIELDS = new Set(["signal", "deadlineMs", "maxFileBytes", "maxNodes", "maxMatches", "maxDisplayedMatches", "languageLoader"]);
const require = createRequire(import.meta.url);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateTarget(value: unknown): value is SourceIdentifierTarget {
  if (!isRecord(value) || Object.keys(value).some((key) => !TARGET_FIELDS.has(key))) return false;
  return typeof value.path === "string" && value.path.length > 0 && Number.isInteger(value.line) && (value.line as number) >= 1 &&
    typeof value.identifier === "string" && value.identifier.length > 0 &&
    (value.occurrence === undefined || (Number.isInteger(value.occurrence) && (value.occurrence as number) >= 1));
}

function validOptions(value: unknown): value is SourceLocatorOptions {
  if (!isRecord(value) || Object.keys(value).some((key) => !OPTION_FIELDS.has(key))) return false;
  const counts = ["deadlineMs", "maxFileBytes", "maxNodes", "maxMatches", "maxDisplayedMatches"];
  return counts.every((key) => value[key] === undefined || (Number.isInteger(value[key]) && (value[key] as number) >= 1)) &&
    (value.signal === undefined || (typeof AbortSignal !== "undefined" && value.signal instanceof AbortSignal)) &&
    (value.languageLoader === undefined || typeof value.languageLoader === "function");
}

function sourceFamily(path: string): { ok: true; family: SourceLanguageFamily } | { ok: false; result: SourceLocatorResult } {
  const extension = extname(path).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) return { ok: false, result: { status: "unsupported", reason: "Unsupported source extension" } };
  const family = languageFor(extension);
  return family
    ? { ok: true, family }
    : { ok: false, result: { status: "unsupported", reason: "No parser for source extension" } };
}

function sourceLine(source: string, line: number): { ok: true; row: number; text: string } | { ok: false; result: SourceLocatorResult } {
  const row = line - 1;
  const text = source.split(/\r\n|\n|\r/)[row];
  return text === undefined
    ? { ok: false, result: { status: "notfound" } }
    : { ok: true, row, text };
}

async function resolveSourceLocation(target: SourceIdentifierTarget, options: SourceLocatorOptions, deadline: number): Promise<
  | { ok: true; read: Extract<SourceReadResult, { ok: true }>; row: number; line: string }
  | { ok: false; result: SourceLocatorResult }
> {
  const read = await readSource(target.path, options, deadline);
  if (!read.ok) return read;
  const location = sourceLine(read.source, target.line);
  return location.ok
    ? { ok: true, read, row: location.row, line: location.text }
    : location;
}

function languageFor(extension: string): SourceLanguageFamily | undefined {
  if ([".ts", ".mts", ".cts"].includes(extension)) return "typescript";
  if (extension === ".tsx") return "tsx";
  if ([".js", ".jsx", ".mjs", ".cjs"].includes(extension)) return "javascript";
  if (extension === ".py") return "python";
  if (extension === ".rs") return "rust";
  if (extension === ".go") return "go";
  return undefined;
}

function loadNativeLanguage(family: SourceLanguageFamily): unknown {
  switch (family) {
    case "typescript": return require("tree-sitter-typescript").typescript;
    case "tsx": return require("tree-sitter-typescript").tsx;
    case "javascript": return require("tree-sitter-javascript");
    case "python": return require("tree-sitter-python");
    case "rust": return require("tree-sitter-rust");
    case "go": return require("tree-sitter-go");
  }
}

function isNativeLanguage(value: unknown): value is object {
  if (!isRecord(value)) return false;
  return typeof value.name === "string" && value.language !== undefined && Array.isArray(value.nodeTypeInfo);
}

async function readBoundedSource(path: string, maxBytes: number, signal: AbortSignal | undefined, deadline: number): Promise<Buffer | null> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile()) return null;
    if (info.size > maxBytes) throw new RangeError("File exceeds byte limit");
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      if (signal?.aborted || Date.now() >= deadline) throw new Error("Read cancelled or deadline exceeded");
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) throw new RangeError("File exceeds byte limit");
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}

export type SourceReadResult =
  | { ok: true; canonicalPath: string; bytes: Buffer; source: string }
  | { ok: false; result: SourceLocatorResult };

type AstScanResult =
  | { ok: true; matches: Array<{ character: number; tokenSpan: SourceTokenSpan }> }
  | { ok: false; result: SourceLocatorResult };

export async function readSource(path: string, options: SourceLocatorOptions, deadline: number): Promise<SourceReadResult> {
  let canonicalPath: string;
  let bytes: Buffer | null;
  try {
    canonicalPath = await realpath(path);
    if (options.signal?.aborted || Date.now() >= deadline) {
      return { ok: false, result: { status: "incomplete", reason: "Deadline or cancellation before read" } };
    }
    bytes = await readBoundedSource(canonicalPath, options.maxFileBytes ?? DEFAULTS.maxFileBytes, options.signal, deadline);
  } catch (error) {
    const reason = error instanceof RangeError ? error.message : "Source read failed, cancelled, or exceeded deadline";
    return { ok: false, result: { status: "incomplete", reason } };
  }
  if (!bytes) return { ok: false, result: { status: "unsupported", reason: "Source path is not a regular file" } };
  let source: string;
  try { source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return { ok: false, result: { status: "unsupported", reason: "Source is not valid UTF-8" } }; }
  if (options.signal?.aborted || Date.now() >= deadline) {
    return { ok: false, result: { status: "incomplete", reason: "Deadline or cancellation after read" } };
  }
  return { ok: true, canonicalPath, bytes, source };
}

function tokenIsValid(node: Parser.SyntaxNode, source: string, targetLine: string, identifier: string): boolean {
  return node.startIndex >= 0 && node.endIndex <= source.length && node.endIndex > node.startIndex &&
    source.slice(node.startIndex, node.endIndex) === node.text && node.endIndex - node.startIndex === identifier.length &&
    node.startPosition.column >= 0 && node.startPosition.column + node.text.length <= targetLine.length &&
    targetLine.slice(node.startPosition.column, node.startPosition.column + node.text.length) === node.text;
}

interface AstScanInput {
  root: Parser.SyntaxNode;
  family: SourceLanguageFamily;
  source: string;
  targetLine: string;
  targetRow: number;
  identifier: string;
  options: SourceLocatorOptions;
  deadline: number;
}

function incompleteScan(reason: string): AstScanResult {
  return { ok: false, result: { status: "incomplete", reason } };
}

function nodeErrorIntersectsLine(node: Parser.SyntaxNode, row: number): boolean {
  return (node.isError || node.isMissing) && node.startPosition.row <= row && node.endPosition.row >= row;
}

function nodeIsIdentifier(node: Parser.SyntaxNode, input: AstScanInput): boolean {
  return IDENTIFIER_TYPES[input.family].has(node.type) && node.text === input.identifier &&
    node.startPosition.row === input.targetRow && node.endPosition.row === input.targetRow;
}

function candidateMatch(node: Parser.SyntaxNode, input: AstScanInput):
  | { ok: false; result: SourceLocatorResult }
  | { ok: true; match?: { character: number; tokenSpan: SourceTokenSpan } } {
  if (nodeErrorIntersectsLine(node, input.targetRow)) return incompleteScan("Syntax recovery intersects target line");
  if (!nodeIsIdentifier(node, input)) return { ok: true };
  if (!tokenIsValid(node, input.source, input.targetLine, input.identifier)) {
    return incompleteScan("Parser token offsets failed source validation");
  }
  return { ok: true, match: { character: node.startPosition.column, tokenSpan: { start: node.startIndex, end: node.endIndex } } };
}

function collectMatches(input: AstScanInput): AstScanResult {
  const stack = [input.root];
  const matches: Array<{ character: number; tokenSpan: SourceTokenSpan }> = [];
  let visited = 0;
  while (stack.length) {
    if (input.options.signal?.aborted || Date.now() >= input.deadline) return incompleteScan("Deadline or cancellation during traversal");
    const node = stack.pop()!;
    if (++visited > (input.options.maxNodes ?? DEFAULTS.maxNodes)) return incompleteScan("AST traversal limit reached");
    const candidate = candidateMatch(node, input);
    if (!candidate.ok) return candidate;
    if (candidate.match) {
      matches.push(candidate.match);
      if (matches.length > (input.options.maxMatches ?? DEFAULTS.maxMatches)) return incompleteScan("Identifier match limit reached");
    }
    for (let index = node.childCount - 1; index >= 0; index--) {
      const child = node.child(index);
      if (child) stack.push(child);
    }
  }
  return { ok: true, matches };
}

function scanSource(input: Omit<AstScanInput, "root">, language: object): AstScanResult {
  const parser = new Parser();
  try {
    parser.setLanguage(language);
    parser.setTimeoutMicros(Math.max(1, (input.deadline - Date.now()) * 1000));
    const parserSource = input.source.replace(/\r(?!\n)/g, "\n");
    const tree = parser.parse(parserSource);
    if (!tree) return incompleteScan("Parser returned no syntax tree");
    return collectMatches({ ...input, root: tree.rootNode });
  } catch {
    return incompleteScan("Parser failed before exhaustive target-line matching");
  }
}

function projectMatches(matches: AstScanResult & { ok: true }, target: SourceIdentifierTarget, options: SourceLocatorOptions):
  | { status: "notfound" }
  | { status: "ambiguous"; displayedMatches: Array<{ character: number; tokenSpan: SourceTokenSpan }>; totalMatches: number }
  | { status: "selected"; match: { character: number; tokenSpan: SourceTokenSpan } } {
  const requested = target.occurrence ?? (matches.matches.length === 1 ? 1 : undefined);
  if (requested === undefined) {
    return matches.matches.length
      ? { status: "ambiguous", displayedMatches: matches.matches.slice(0, options.maxDisplayedMatches ?? DEFAULTS.maxDisplayedMatches), totalMatches: matches.matches.length }
      : { status: "notfound" };
  }
  const match = matches.matches[requested - 1];
  return match ? { status: "selected", match } : { status: "notfound" };
}

/**
 * Locate an exact AST identifier on the requested one-based source line.
 * The result uses zero-based source rows and UTF-16 code-unit columns/offsets, not negotiated LSP coordinates.
 * The source fingerprint is for callers to recheck immediately before semantic dispatch; it grants no edit/evidence authorization.
 * Defaults bound input to 1 MiB, traversal to 100,000 nodes, matches to 100, ambiguity display to 10, and work to 15 seconds.
 * The deadline governs admission and parser CPU time; filesystem operations may not be interruptible while in flight.
 */
export async function locateSourceIdentifier(target: unknown, options: SourceLocatorOptions = {}): Promise<SourceLocatorResult> {
  if (!validateTarget(target) || !validOptions(options)) return { status: "invalid", reason: "Malformed target or options" };
  const deadline = Date.now() + (options.deadlineMs ?? DEFAULTS.deadlineMs);
  const languageFamily = sourceFamily(target.path);
  if (!languageFamily.ok) return languageFamily.result;
  const family = languageFamily.family;
  const sourceLocation = await resolveSourceLocation(target, options, deadline);
  if (!sourceLocation.ok) return sourceLocation.result;
  const { read, row: targetRow, line: targetLine } = sourceLocation;
  let grammar: unknown;
  try { grammar = (options.languageLoader ?? loadNativeLanguage)(family); }
  catch { return { status: "unsupported", reason: "Native grammar unavailable" }; }
  if (!isNativeLanguage(grammar)) return { status: "unsupported", reason: "Native grammar export has an unsupported shape" };
  if (options.signal?.aborted || Date.now() >= deadline) return { status: "incomplete", reason: "Deadline or cancellation before parse" };

  const scan = scanSource({
    family, source: read.source, targetLine, targetRow,
    identifier: target.identifier, options, deadline,
  }, grammar);
  if (!scan.ok) return scan.result;
  const projection = projectMatches(scan, target, options);
  if (projection.status !== "selected") return projection;
  return {
    status: "found", canonicalPath: read.canonicalPath, sourceSha256: createHash("sha256").update(read.bytes).digest("hex"),
    sourcePositionUtf16: { line: targetRow, character: projection.match.character }, tokenSpan: projection.match.tokenSpan,
  };
}
