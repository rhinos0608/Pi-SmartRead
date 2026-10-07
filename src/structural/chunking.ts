export interface ChunkResult {
  text: string;
  chunkIndex: number;
  startChar: number;
  endChar: number;
  estimatedTokens: number;
  wasHardSplit: boolean;
  contextHeader?: string;
  embeddingText?: string;
  /** Non-whitespace character count (present when using cAST chunking) */
  nwsChars?: number;
  /** Present when using symbol-boundary chunking */
  symbolBoundary?: {
    type: "function" | "method" | "class" | "interface" | "enum" | "type_alias" | "variable" | "export";
    name: string;
    startLine: number;
    endLine: number;
  };
}

export interface ChunkOptions {
  chunkSizeChars?: number;
  chunkOverlapChars?: number;
  maxChunksPerFile?: number;
  minChunkChars?: number;
  filePath?: string;
  compressForEmbedding?: boolean;
  /** Use tree-sitter symbol boundaries (functions, classes, methods) instead of character-based splitting */
  useSymbolBoundaries?: boolean;
  /** Use cAST (Chunking via Abstract Syntax Trees) algorithm — recursive split-then-merge with NWS metric */
  useCAST?: boolean;
  /** Maximum non-whitespace characters per chunk (default 2000, optimal range 2000-2500) */
  maxNwsChars?: number;
}

export interface CompressSnippetOptions {
  maxChars?: number;
}

const IMPORT_LINE_RE = /^\s*import(?:\s.+?\sfrom\s+)?["'][^"']+["'];?\s*$/gm;
const REQUIRE_LINE_RE = /^\s*(?:const|let|var)\s+[^=]+?=\s*require\(["'][^"']+["']\);?\s*$/gm;
const DEFAULT_COMPRESSED_SNIPPET_CHARS = 1000;
const NON_METHOD_KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "function"]);

// ── Symbol boundary extraction (lightweight AST) ─────────────────

interface SymbolSpan {
  type: "function" | "method" | "class" | "interface" | "enum" | "type_alias" | "variable" | "export";
  name: string;
  startByte: number;
  endByte: number;
}

/**
 * Extract symbol boundaries from source text using lightweight regex + brace matching.
 *
 * This is a pure-text approach (no tree-sitter dependency) that works for
 * TypeScript, JavaScript, and similar C-family languages. It identifies:
 *   - function declarations/expressions
 *   - class declarations
 *   - interface declarations
 *   - method definitions (within classes)
 *   - enum declarations
 *   - type alias declarations
 *   - const/let/var exports at file scope
 *
 * More accurate than character-based chunking, lighter than full tree-sitter parse.
 */
/**
 * Extract symbol boundaries from source text using lightweight regex + brace matching.
 *
 * This is a pure-text approach (no tree-sitter dependency) that works for
 * TypeScript, JavaScript, and similar C-family languages.
 *
 * Exported for use by ast-chunker.ts as fallback when web-tree-sitter WASM is unavailable.
 * Prefer ast-chunker.ts::extractSymbolBoundaries for AST-accurate results.
 */
function isDuplicateSpan(spans: SymbolSpan[], name: string, declStart: number): boolean {
  return spans.some((s) => s.startByte === declStart || (s.name === name && Math.abs(s.startByte - declStart) < 50));
}

function collectPatternSpans(text: string, re: RegExp, type: SymbolSpan["type"], nameGroup: number, spans: SymbolSpan[]): void {
  re.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const name = match[nameGroup]!;
    const declStart = match.index;
    const endByte = findMatchingBrace(text, declStart) ?? Math.min(declStart + 2000, text.length);
    if (!isDuplicateSpan(spans, name, declStart)) spans.push({ type, name, startByte: declStart, endByte });
  }
}

function collectDeclSpans(text: string, patterns: { re: RegExp; type: SymbolSpan["type"]; nameGroup: number }[], spans: SymbolSpan[]): void {
  for (const { re, type, nameGroup } of patterns) collectPatternSpans(text, re, type, nameGroup, spans);
}

function mergeOverlappingSpans(spans: SymbolSpan[]): SymbolSpan[] {
  const merged: SymbolSpan[] = [];
  for (const span of spans) {
    const prev = merged[merged.length - 1];
    if (prev && span.startByte < prev.endByte) prev.endByte = Math.max(prev.endByte, span.endByte);
    else merged.push({ ...span });
  }
  return merged;
}

export function extractSymbolBoundaries(text: string): SymbolSpan[] {
  const spans: SymbolSpan[] = [];

  // Match major declarations with their starting positions
  const declPatterns: { re: RegExp; type: SymbolSpan["type"]; nameGroup: number }[] = [
    { re: /(?:^|\n)(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm, type: "function", nameGroup: 1 },
    { re: /(?:^|\n)(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/gm, type: "class", nameGroup: 1 },
    { re: /(?:^|\n)(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/gm, type: "interface", nameGroup: 1 },
    { re: /(?:^|\n)(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/gm, type: "enum", nameGroup: 1 },
    { re: /(?:^|\n)(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/gm, type: "type_alias", nameGroup: 1 },
    { re: /(?:^|\n)(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm, type: "variable", nameGroup: 1 },
  ];

  collectDeclSpans(text, declPatterns, spans);
  spans.sort((a, b) => a.startByte - b.startByte);
  return mergeOverlappingSpans(spans);
}

/**
 * Find the matching closing brace for an opening brace, respecting nesting.
 * Returns the byte offset after the closing brace, or null if unmatched.
 *
 * Known limitations:
 * - The escape check (`prev !== "\\"`) does not correctly handle double-escaped
 *   backslashes (e.g., `"\\\\"` before a quote) because it only inspects the
 *   immediately preceding character.
 * - Template literal `${...}` interpolations are not fully supported — expressions
 *   containing strings or braces can confuse the state machine.
 * A full parser (e.g., tree-sitter) would be needed to handle these scenarios.
 *
 * Exported for use by ast-chunker.ts as fallback when web-tree-sitter is unavailable.
 */
interface BraceScanState {
  depth: number;
  inString: string | null;
  inComment: "line" | "block" | null;
}

function isQuoteChar(ch: string): boolean {
  return ch === '"' || ch === "'" || ch === "`";
}

function isStringCloser(ch: string, prev: string, state: BraceScanState): boolean {
  return ch === state.inString && prev !== "\\";
}

function scanOpenStringChar(ch: string, state: BraceScanState): boolean {
  if (!isQuoteChar(ch)) return false;
  state.inString = ch;
  return true;
}

function scanStringChar(ch: string, prev: string, state: BraceScanState): boolean {
  if (state.inComment !== null) return false;
  if (state.inString) {
    if (isStringCloser(ch, prev, state)) state.inString = null;
    return true;
  }
  return scanOpenStringChar(ch, state);
}

function closeLineComment(ch: string, state: BraceScanState): boolean {
  if (ch === "\n") state.inComment = null;
  return true;
}

function closeBlockComment(ch: string, prev: string, state: BraceScanState): boolean {
  if (ch === "/" && prev === "*") state.inComment = null;
  return true;
}

function scanCommentChar(ch: string, prev: string, state: BraceScanState): boolean {
  if (state.inComment === null) return false;
  return state.inComment === "line"
    ? closeLineComment(ch, state)
    : closeBlockComment(ch, prev, state);
}

function isBlankText(text: string | undefined | null): boolean {
  if (!text) return true;
  if (text.length === 0) return true;
  return /^\s*$/.test(text);
}

function scanCommentStart(text: string, i: number, state: BraceScanState): boolean {
  if (state.inString !== null || state.inComment !== null) return false;
  const ch = text[i];
  if (ch === "/" && text[i + 1] === "/") { state.inComment = "line"; return true; }
  if (ch === "/" && text[i + 1] === "*") { state.inComment = "block"; return true; }
  return false;
}

function scanBraceChar(ch: string, state: BraceScanState, index: number): number | null {
  if (ch === "{") state.depth++;
  else if (ch === "}") {
    state.depth--;
    if (state.depth === 0) return index + 1;
  }
  return null;
}

export function findMatchingBrace(text: string, startPos: number): number | null {
  // Find the first { after startPos
  const openIdx = text.indexOf("{", startPos);
  if (openIdx === -1) return null;

  const state: BraceScanState = { depth: 0, inString: null, inComment: null };
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i]!;
    const prev = i > 0 ? text[i - 1]! : "";
    if (scanStringChar(ch, prev, state)) continue;
    if (scanCommentChar(ch, prev, state)) continue;
    if (scanCommentStart(text, i, state)) { i++; continue; }
    const done = scanBraceChar(ch, state, i);
    if (done !== null) return done;
  }
  return null;
}

const DEFAULT_CHUNK_SIZE_CHARS = 4096;
const DEFAULT_CHUNK_OVERLAP_CHARS = 512;
const DEFAULT_MAX_CHUNKS_PER_FILE = 12;
const DEFAULT_MIN_CHUNK_CHARS = 200;
const CHARS_PER_TOKEN = 4;
const DEFAULT_MAX_NWS_CHARS = 2000;

/**
 * Count non-whitespace characters in text.
 * Used by cAST chunking as the size metric.
 */
function isNwsChar(ch: string): boolean {
  return ch !== " " && ch !== "\n" && ch !== "\r" && ch !== "\t" && ch !== "\f" && ch !== "\v";
}

export function nwsChars(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (isNwsChar(text[i]!)) count++;
  }
  return count;
}

export function compressSnippet(text: string, options: CompressSnippetOptions = {}): string {
  const maxChars = options.maxChars ?? DEFAULT_COMPRESSED_SNIPPET_CHARS;
  const withoutImports = text
    .replace(IMPORT_LINE_RE, "")
    .replace(REQUIRE_LINE_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (withoutImports.length <= maxChars) return withoutImports;

  const headChars = Math.ceil(maxChars * 0.6);
  const tailChars = Math.max(0, maxChars - headChars);
  return `${withoutImports.slice(0, headChars)}\n// ... (truncated)\n${withoutImports.slice(-tailChars)}`;
}

function getStructuralContext(text: string): string | undefined {
  const classMatch = text.match(/\bclass\s+([A-Za-z_$][\w$]*)/);
  const functionMatch = text.match(/\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/);
  const methodMatch = text.match(/^\s*(?:public\s+|private\s+|protected\s+|async\s+|static\s+)*(?:[A-Za-z_$][\w$]*)\s*\(/m);

  if (classMatch && functionMatch) return `Class: ${classMatch[1]} > Function: ${functionMatch[1]}`;
  if (functionMatch) return `Function: ${functionMatch[1]}`;
  if (classMatch) return `Class: ${classMatch[1]}`;
  if (methodMatch) {
    const raw = methodMatch[0].trim().replace(/\($/, "");
    const methodName = raw.split(/\s+/).pop()!;
    if (!NON_METHOD_KEYWORDS.has(methodName)) return `Method: ${methodName}`;
  }
  return undefined;
}

function enrichChunk(chunk: ChunkResult, options: ChunkOptions): void {
  if (!options.filePath && !options.compressForEmbedding) return;

  const parts = options.filePath ? [`File: ${options.filePath}`] : [];
  const structuralContext = getStructuralContext(chunk.text);
  if (structuralContext) parts.push(structuralContext);

  const contextHeader = parts.join(" > ");
  if (contextHeader) chunk.contextHeader = contextHeader;

  const body = options.compressForEmbedding ? compressSnippet(chunk.text) : chunk.text;
  chunk.embeddingText = contextHeader ? `${contextHeader}\n${body}` : body;
}

// ── cAST (Chunking via Abstract Syntax Trees) ────────────────────

/**
 * Internal node for cAST tree representation.
 */
interface CASTNode {
  startByte: number;
  endByte: number;
  type?: string;
  name?: string;
  children: CASTNode[];
}

/**
 * Internal segment produced by the cAST splitting algorithm.
 * Each segment covers a contiguous byte range of the source text.
 * Concatenating all segments in order reproduces the original text.
 */
interface CASTSegment {
  startByte: number;
  endByte: number;
}

function collectNestedSpans(span: SymbolSpan, candidates: SymbolSpan[], from: number): { nested: SymbolSpan[]; next: number } {
  const nested: SymbolSpan[] = [];
  let j = from;
  while (j < candidates.length && candidates[j]!.startByte < span.endByte) {
    const cand = candidates[j]!;
    if (cand.startByte >= span.startByte && cand.endByte <= span.endByte) nested.push(cand);
    j++;
  }
  return { nested, next: j };
}

function spanToNode(span: SymbolSpan): CASTNode {
  return { startByte: span.startByte, endByte: span.endByte, type: span.type, name: span.name, children: [] };
}

function isOutsideParent(span: SymbolSpan, parent: CASTNode): boolean {
  return span.startByte < parent.startByte || span.endByte > parent.endByte;
}

function attachSpans(parent: CASTNode, candidates: SymbolSpan[]): void {
  let i = 0;
  while (i < candidates.length) {
    const span = candidates[i]!;
    if (isOutsideParent(span, parent)) { i++; continue; }
    const { nested, next } = collectNestedSpans(span, candidates, i + 1);
    const node = spanToNode(span);
    attachSpans(node, nested);
    parent.children.push(node);
    i = next;
  }
}

/**
 * Build a hierarchical tree from flat symbol spans.
 * Spans are nested by containment: if span B is fully inside span A,
 * B becomes a child of A. The root encompasses the entire text.
 */
function spansToTree(text: string, spans: SymbolSpan[]): CASTNode {
  const root: CASTNode = {
    startByte: 0,
    endByte: text.length,
    children: [],
  };

  if (spans.length === 0) return root;

  // Sort by start, then by end descending (parents before children)
  const sorted = [...spans].sort((a, b) => a.startByte - b.startByte || (b.endByte - b.startByte) - (a.endByte - a.startByte));

  attachSpans(root, sorted);
  return root;
}

/**
 * Hard-split a contiguous text segment into fixed-size NWS chunks.
 * Used when a leaf segment (no children) exceeds maxNwsChars.
 */
function cASTHardSplit(
  text: string,
  startByte: number,
  endByte: number,
  maxNws: number,
): CASTSegment[] {
  const segments: CASTSegment[] = [];
  let chunkStart = startByte;
  let nwsAccum = 0;

  for (let i = startByte; i < endByte; i++) {
    if (!isNwsChar(text[i]!)) continue;
    if (nwsAccum >= maxNws) {
      segments.push({ startByte: chunkStart, endByte: i });
      chunkStart = i;
      nwsAccum = 0;
    }
    nwsAccum++;
  }

  // Emit remaining
  if (chunkStart < endByte) {
    segments.push({ startByte: chunkStart, endByte });
  }

  return segments;
}

/**
 * Merge adjacent small segments whose combined NWS count is ≤ maxNws.
 * Prevents over-fragmentation from greedy splitting.
 */
function mergeAdjacentSmall(segments: CASTSegment[], text: string, maxNws: number): CASTSegment[] {
  if (segments.length <= 1) return segments;

  const merged: CASTSegment[] = [];
  let pending = segments[0]!;

  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i]!;
    const combinedText = text.slice(pending.startByte, seg.endByte);
    const combinedNws = nwsChars(combinedText);

    if (combinedNws <= maxNws) {
      pending = { startByte: pending.startByte, endByte: seg.endByte };
    } else {
      merged.push(pending);
      pending = seg;
    }
  }

  merged.push(pending);
  return merged;
}

/**
 * Recursive split-then-merge for the cAST algorithm.
 *
 * Given a parent range and its children (from tree/span analysis),
 * splits the text into contiguous segments covering the entire parent range.
 * Children serve as split hints — gaps between children are treated as atomic segments.
 *
 * Algorithm (adapted from arXiv 2506.15655v1):
 *   1. If node fits in maxNws, keep as one segment.
 *   2. Otherwise, iterate children: pack fitting children into current batch,
 *      recursively split oversized children.
 *   3. After initial pass, merge adjacent small siblings to avoid over-fragmentation.
 */
interface CASTSplitHint {
  startByte: number;
  endByte: number;
  children?: CASTNode[];
}

/**
 * First pass of cAST split: cut parent range at child boundaries.
 * Gaps between children become atomic segments; each child keeps its
 * subtree as a split hint. Output covers parent range contiguously.
 */
function buildCastSplitHints(
  parentStart: number,
  parentEnd: number,
  children: CASTNode[],
): CASTSplitHint[] {
  const segments: CASTSplitHint[] = [];
  const sorted = [...children].sort((a, b) => a.startByte - b.startByte);
  let cursor = parentStart;

  for (const child of sorted) {
    if (child.startByte > cursor) {
      segments.push({ startByte: cursor, endByte: child.startByte });
    }
    segments.push({
      startByte: child.startByte,
      endByte: child.endByte,
      children: child.children.length > 0 ? child.children : undefined,
    });
    cursor = child.endByte;
  }

  if (cursor < parentEnd) {
    segments.push({ startByte: cursor, endByte: parentEnd });
  }

  return segments;
}

/**
 * Resolve one split hint to concrete segments: recurse when the hint has
 * internal structure and exceeds the limit, hard-split over-large atomic
 * hints, otherwise keep as-is.
 */
function isHintOverLimit(seg: CASTSplitHint, text: string, maxNws: number): boolean {
  return nwsChars(text.slice(seg.startByte, seg.endByte)) > maxNws;
}

function hasChildStructure(seg: CASTSplitHint): boolean {
  return !!seg.children && seg.children.length > 0;
}

function splitCastHint(seg: CASTSplitHint, text: string, maxNws: number): CASTSegment[] {
  if (hasChildStructure(seg) && isHintOverLimit(seg, text, maxNws)) {
    return cASTSplitSegments(seg.startByte, seg.endByte, text, seg.children!, maxNws);
  }
  if (isHintOverLimit(seg, text, maxNws)) return cASTHardSplit(text, seg.startByte, seg.endByte, maxNws);
  return [{ startByte: seg.startByte, endByte: seg.endByte }];
}

/**
 * Second pass of cAST split: greedily pack hint segments into batches of
 * at most maxNws. Adjacent subs in the same batch merge into one segment
 * by extending the batch end (hints are contiguous, so no gaps result).
 */
interface CastBatch {
  startByte: number;
  endByte: number;
  nws: number;
}

function appendToCastBatch(batch: CastBatch | null, sub: CASTSegment, subNws: number): CastBatch {
  if (batch === null) return { startByte: sub.startByte, endByte: sub.endByte, nws: subNws };
  batch.endByte = sub.endByte;
  batch.nws += subNws;
  return batch;
}

interface PackSubsInput { subs: CASTSegment[]; text: string; maxNws: number; packed: CASTSegment[]; batch: CastBatch | null }

function flushPackBatch(packed: CASTSegment[], current: CastBatch | null): CastBatch | null {
  if (current === null) return null;
  packed.push({ startByte: current.startByte, endByte: current.endByte });
  return null;
}

function packOneSub(input: PackSubsInput, sub: CASTSegment, current: CastBatch | null): CastBatch | null {
  const subNws = nwsChars(input.text.slice(sub.startByte, sub.endByte));
  let next = current;
  if (next !== null && next.nws + subNws > input.maxNws) next = flushPackBatch(input.packed, next);
  return appendToCastBatch(next, sub, subNws);
}

function packHintSubs(input: PackSubsInput): CastBatch | null {
  let current = input.batch;
  for (const sub of input.subs) current = packOneSub(input, sub, current);
  return current;
}

function packCastSegments(hints: CASTSplitHint[], text: string, maxNws: number): CASTSegment[] {
  const packed: CASTSegment[] = [];
  let batch: CastBatch | null = null;
  for (const hint of hints) {
    batch = packHintSubs({ subs: splitCastHint(hint, text, maxNws), text, maxNws, packed, batch });
  }
  if (batch !== null) packed.push({ startByte: batch.startByte, endByte: batch.endByte });
  return packed;
}

function cASTSplitSegments(
  parentStart: number,
  parentEnd: number,
  text: string,
  children: CASTNode[],
  maxNws: number,
): CASTSegment[] {
  const parentText = text.slice(parentStart, parentEnd);
  if (nwsChars(parentText) <= maxNws) {
    return [{ startByte: parentStart, endByte: parentEnd }];
  }

  if (children.length === 0) {
    return cASTHardSplit(text, parentStart, parentEnd, maxNws);
  }

  const hints = buildCastSplitHints(parentStart, parentEnd, children);
  const packed = packCastSegments(hints, text, maxNws);
  return mergeAdjacentSmall(packed, text, maxNws);
}

/**
 * Convert cAST segments to ChunkResult array.
 */
function segmentsToChunks(
  segments: CASTSegment[],
  text: string,
  maxChunksPerFile: number,
  options?: ChunkOptions,
): ChunkResult[] {
  const results: ChunkResult[] = [];

  for (let i = 0; i < Math.min(segments.length, maxChunksPerFile); i++) {
    const seg = segments[i]!;
    const chunkTextContent = text.slice(seg.startByte, seg.endByte);
    const chunkNws = nwsChars(chunkTextContent);

    results.push({
      text: chunkTextContent,
      chunkIndex: i,
      startChar: seg.startByte,
      endChar: seg.endByte,
      estimatedTokens: Math.ceil(chunkTextContent.length / CHARS_PER_TOKEN),
      wasHardSplit: false,
      nwsChars: chunkNws,
    });
  }

  // Enrich with context headers and embedding text
  for (const chunk of results) {
    enrichChunk(chunk, options ?? {});
  }

  // Re-assign chunk indices after potential removals from enrichChunk
  for (let i = 0; i < results.length; i++) {
    results[i]!.chunkIndex = i;
  }

  return results;
}

/**
 * Main cAST entry point (sync).
 *
 * Extracts symbol boundaries via lightweight regex AST, builds a tree,
 * and applies the recursive split-then-merge cAST algorithm.
 * Falls back to character-based splitting when no symbols are found.
 *
 * @param text - Source code text
 * @param options - Chunking options
 * @returns Array of ChunkResults covering the entire text contiguously
 */
export function cASTChunkText(
  text: string,
  options?: ChunkOptions,
): ChunkResult[] {
  if (isBlankText(text)) return [];

  const maxNws = options?.maxNwsChars ?? DEFAULT_MAX_NWS_CHARS;
  const maxChunksPerFile = options?.maxChunksPerFile ?? DEFAULT_MAX_CHUNKS_PER_FILE;

  // Extract symbol boundaries (lightweight regex-based)
  const spans = extractSymbolBoundaries(text);

  // Build tree from spans
  const root = spansToTree(text, spans);

  // If tree has no children (no symbols found), use hard NWS split
  if (root.children.length === 0) {
    const segments = cASTHardSplit(text, 0, text.length, maxNws);
    return segmentsToChunks(segments, text, maxChunksPerFile, options);
  }

  // Apply cAST recursive split-then-merge
  const segments = cASTSplitSegments(
    root.startByte,
    root.endByte,
    text,
    root.children,
    maxNws,
  );

  return segmentsToChunks(segments, text, maxChunksPerFile, options);
}

// ── Main chunking entry point ────────────────────────────────────

/**
 * Splits text into chunks by preference:
 *   - Symbol boundaries (functions, classes, methods) when useSymbolBoundaries is set
 *   - Otherwise: double newline > single newline > whitespace > hard split
 *
 * Walks backward from target position to find a boundary.
 * Chunks may overlap by `chunkOverlapChars` characters.
 */
export function chunkText(
  text: string,
  options?: ChunkOptions,
): ChunkResult[] {
  const useSymbolBoundaries = options?.useSymbolBoundaries ?? false;
  const useCast = options?.useCAST ?? false;

  if (isBlankText(text)) return [];

  if (useCast) {
    return cASTChunkText(text, options);
  }

  if (useSymbolBoundaries) {
    return chunkBySymbolBoundaries(text, options);
  }

  return chunkByCharacterSize(text, options);
}

/**
 * Chunk text using symbol boundaries (function, class, method declarations).
 *
 * Strategy:
 *   1. Extract symbol spans from source
 *   2. Split at nearest symbol boundary
 *   3. Merge small adjacent chunks when possible
 *   4. Hard-split only for very large symbols
 */
interface SymbolDraftChunk {
  text: string;
  startChar: number;
  endChar: number;
  span?: SymbolSpan;
}

/**
 * First pass of symbol chunking: preamble (trimmed, kept only when
 * significant) plus one draft per symbol span. Very large symbols
 * (>2x chunkSizeChars) sub-split via character chunking.
 */
function pushSubDrafts(chunks: SymbolDraftChunk[], span: SymbolSpan, subChunks: ChunkResult[]): void {
  for (const sc of subChunks) {
    chunks.push({ text: sc.text, startChar: span.startByte + sc.startChar, endChar: span.startByte + sc.endChar, span });
  }
}

interface SpanDraftInput { chunks: SymbolDraftChunk[]; text: string; span: SymbolSpan; chunkSizeChars: number; options?: ChunkOptions }

function appendSpanDraft(input: SpanDraftInput): void {
  const slice = input.text.slice(input.span.startByte, input.span.endByte);
  if (slice.length === 0) return;
  if (slice.length <= input.chunkSizeChars * 2) {
    input.chunks.push({ text: slice, startChar: input.span.startByte, endChar: input.span.endByte, span: input.span });
    return;
  }
  pushSubDrafts(input.chunks, input.span, chunkByCharacterSize(slice, { ...input.options, chunkSizeChars: input.chunkSizeChars, maxChunksPerFile: 4 }));
}

function buildInitialSymbolChunks(
  text: string,
  spans: SymbolSpan[],
  minChunkChars: number,
  chunkSizeChars: number,
  options?: ChunkOptions,
): SymbolDraftChunk[] {
  const chunks: SymbolDraftChunk[] = [];

  if (spans[0]!.startByte > 0) {
    const preamble = text.slice(0, spans[0]!.startByte).trim();
    if (preamble.length >= minChunkChars) {
      chunks.push({ text: preamble, startChar: 0, endChar: spans[0]!.startByte });
    }
  }

  for (let i = 0; i < spans.length; i++) {
    appendSpanDraft({ chunks, text, span: spans[i]!, chunkSizeChars, options });
  }

  return chunks;
}

/**
 * Merge adjacent drafts while the combined text stays under chunkSizeChars.
 * Merged text joins with "\n"; endChar follows the absorbed chunk and the
 * first defined span wins.
 */
function mergeSmallSymbolChunks(chunks: SymbolDraftChunk[], chunkSizeChars: number): SymbolDraftChunk[] {
  const merged: SymbolDraftChunk[] = [];
  for (const chunk of chunks) {
    const prev = merged[merged.length - 1];
    if (prev && prev.text.length + chunk.text.length < chunkSizeChars) {
      prev.text += "\n" + chunk.text;
      prev.endChar = chunk.endChar;
      prev.span = prev.span ?? chunk.span;
    } else {
      merged.push({ ...chunk });
    }
  }
  return merged;
}

/**
 * Attach line-range symbol metadata, cap at maxChunksPerFile, then reindex
 * chunkIndex and enrich each chunk.
 */
function toSymbolChunkResults(
  text: string,
  merged: SymbolDraftChunk[],
  maxChunksPerFile: number,
  options?: ChunkOptions,
): ChunkResult[] {
  const results: ChunkResult[] = [];
  for (let i = 0; i < Math.min(merged.length, maxChunksPerFile); i++) {
    const chunk = merged[i]!;
    const startLine = text.slice(0, chunk.startChar).split("\n").length;
    const endLine = text.slice(0, chunk.endChar).split("\n").length;

    results.push({
      text: chunk.text,
      chunkIndex: i,
      startChar: chunk.startChar,
      endChar: chunk.endChar,
      estimatedTokens: Math.ceil(chunk.text.length / CHARS_PER_TOKEN),
      wasHardSplit: false,
      symbolBoundary: chunk.span ? {
        type: chunk.span.type,
        name: chunk.span.name,
        startLine,
        endLine,
      } : undefined,
    });
  }

  for (let i = 0; i < results.length; i++) {
    results[i]!.chunkIndex = i;
    enrichChunk(results[i]!, options ?? {});
  }

  return results;
}

function chunkBySymbolBoundaries(
  text: string,
  options?: ChunkOptions,
): ChunkResult[] {
  const maxChunksPerFile = options?.maxChunksPerFile ?? DEFAULT_MAX_CHUNKS_PER_FILE;
  const minChunkChars = options?.minChunkChars ?? DEFAULT_MIN_CHUNK_CHARS;
  const chunkSizeChars = options?.chunkSizeChars ?? DEFAULT_CHUNK_SIZE_CHARS;

  const spans = extractSymbolBoundaries(text);

  if (spans.length === 0) {
    return chunkByCharacterSize(text, options);
  }

  const chunks = buildInitialSymbolChunks(text, spans, minChunkChars, chunkSizeChars, options);
  const merged = mergeSmallSymbolChunks(chunks, chunkSizeChars);
  return toSymbolChunkResults(text, merged, maxChunksPerFile, options);
}

// ── AST-aware chunking (async, uses web-tree-sitter) ────────────

/**
 * Result of AST-aware chunking with diagnostics for observability.
 */
export interface AstChunkResult {
  chunks: ChunkResult[];
  diagnostics: {
    usedAst: boolean;
    wasmAvailable: boolean;
    parseTimeMs: number;
    symbolCount: number;
    grammarExtension: string;
    wasmFile: string | null;
  };
}

/**
 * Chunk text using AST-accurate symbol boundaries via web-tree-sitter.
 *
 * This is an async alternative to chunkText() that uses the same WASM
 * infrastructure as smart-edit's ast-resolver for precise AST boundary
 * detection. Falls back to regex-based symbol chunking when web-tree-sitter
 * is unavailable or the language isn't supported.
 *
 * Integration note: shares @vscode/tree-sitter-wasm with smart-edit extension.
 * WASM grammars are cached in-process, so loading is lazy per-grammar.
 *
 * @param text - Source code text
 * @param options - Chunking options (must include filePath for language detection)
 * @returns AstChunkResult with chunks and detailed diagnostics
 */
function emptyAstDiagnostics(parseTimeMs = 0): AstChunkResult["diagnostics"] {
  return { usedAst: false, wasmAvailable: false, parseTimeMs, symbolCount: 0, grammarExtension: "", wasmFile: null };
}

function toUsedDiagnostics(d: { usedFallback: boolean; wasmAvailable: boolean; parseTimeMs: number; symbolCount: number; grammarExtension: string; wasmFile: string | null | undefined }): AstChunkResult["diagnostics"] {
  return { usedAst: !d.usedFallback, wasmAvailable: d.wasmAvailable, parseTimeMs: d.parseTimeMs, symbolCount: d.symbolCount, grammarExtension: d.grammarExtension, wasmFile: d.wasmFile ?? null };
}

async function tryCastChunk(text: string, filePath: string, options?: ChunkOptions): Promise<AstChunkResult | null> {
  try {
    const { cASTChunkByAstBoundaries } = await import("./ast-chunker.js");
    const { chunks, diagnostics } = await cASTChunkByAstBoundaries(text, filePath, options);
    return { chunks, diagnostics: toUsedDiagnostics(diagnostics) };
  } catch {
    return null;
  }
}

async function tryAstBoundaries(text: string, filePath: string, options?: ChunkOptions): Promise<AstChunkResult | null> {
  try {
    const { chunkByAstBoundaries } = await import("./ast-chunker.js");
    const { chunks, diagnostics } = await chunkByAstBoundaries(text, filePath, options);
    return { chunks, diagnostics: toUsedDiagnostics(diagnostics) };
  } catch {
    return null;
  }
}

function astFilePath(options?: ChunkOptions): string {
  if (options && options.filePath) return options.filePath;
  return "";
}

function wantsCastChunk(options?: ChunkOptions): boolean {
  return !!options && options.useCAST === true;
}

function wantsSymbolChunk(options?: ChunkOptions): boolean {
  return !!options && options.useSymbolBoundaries === true;
}

async function runPreferredAstChunk(text: string, filePath: string, options: ChunkOptions | undefined, startTime: number): Promise<AstChunkResult> {
  if (wantsCastChunk(options)) {
    const cast = await tryCastChunk(text, filePath, options);
    if (cast !== null) return cast;
  }
  if (!wantsSymbolChunk(options)) return { chunks: chunkText(text, options), diagnostics: emptyAstDiagnostics() };
  const ast = await tryAstBoundaries(text, filePath, options);
  if (ast !== null) return ast;
  return { chunks: chunkBySymbolBoundaries(text, options), diagnostics: emptyAstDiagnostics(Date.now() - startTime) };
}

export async function chunkTextAst(
  text: string,
  options?: ChunkOptions,
): Promise<AstChunkResult> {
  if (isBlankText(text)) return { chunks: [], diagnostics: emptyAstDiagnostics() };
  return runPreferredAstChunk(text, astFilePath(options), options, Date.now());
}

/**
 * Pick a character split at or before targetEnd with fixed precedence:
 * (1) double newline, (2) single newline, (3) whitespace, (4) hard split.
 * Each stage scans backward from targetEnd-1 to offset+1 and takes the
 * first (nearest-to-target) match, returning the position just after it.
 */
function scanBackward(_text: string, offset: number, targetEnd: number, matches: (i: number) => boolean): number {
  for (let i = targetEnd - 1; i >= offset + 1; i--) {
    if (matches(i)) return i + 1;
  }
  return -1;
}

function findPreferredCharacterSplit(
  text: string,
  offset: number,
  targetEnd: number,
): { splitPos: number; wasHardSplit: boolean } {
  const doubleNl = scanBackward(text, offset, targetEnd, (i) => text[i] === '\n' && text[i - 1] === '\n');
  if (doubleNl >= 0) return { splitPos: doubleNl, wasHardSplit: false };
  const singleNl = scanBackward(text, offset, targetEnd, (i) => text[i] === '\n');
  if (singleNl >= 0) return { splitPos: singleNl, wasHardSplit: false };
  const space = scanBackward(text, offset, targetEnd, (i) => /\s/.test(text[i]!));
  if (space >= 0) return { splitPos: space, wasHardSplit: false };
  return { splitPos: targetEnd, wasHardSplit: true };
}

interface CharChunkParts { text: string; startChar: number; endChar: number; wasHardSplit: boolean; index: number }

function makeCharChunk(parts: CharChunkParts): ChunkResult {
  return {
    text: parts.text,
    chunkIndex: parts.index,
    startChar: parts.startChar,
    endChar: parts.endChar,
    estimatedTokens: Math.ceil(parts.text.length / CHARS_PER_TOKEN),
    wasHardSplit: parts.wasHardSplit,
  };
}

interface CharStepInput { text: string; offset: number; chunkSizeChars: number; chunkOverlapChars: number; minChunkChars: number; resultCount: number }

function finishCharacterRemainder(input: CharStepInput): { chunk: ChunkResult | null; nextOffset: number; done: boolean } {
  const chunk = input.text.slice(input.offset);
  return { chunk: makeCharChunk({ text: chunk, startChar: input.offset, endChar: input.text.length, wasHardSplit: false, index: input.resultCount }), nextOffset: input.text.length, done: true };
}

function keepSplitSlice(slice: string, resultCount: number, minChunkChars: number): boolean {
  if (resultCount === 0) return true;
  return slice.length >= minChunkChars;
}

function nextCharacterStep(input: CharStepInput): { chunk: ChunkResult | null; nextOffset: number; done: boolean } {
  if (input.text.length - input.offset <= input.chunkSizeChars) return finishCharacterRemainder(input);
  const { splitPos, wasHardSplit } = findPreferredCharacterSplit(input.text, input.offset, input.offset + input.chunkSizeChars);
  const slice = input.text.slice(input.offset, splitPos);
  const chunk = keepSplitSlice(slice, input.resultCount, input.minChunkChars)
    ? makeCharChunk({ text: slice, startChar: input.offset, endChar: splitPos, wasHardSplit, index: input.resultCount })
    : null;
  const nextOffset = Math.max(input.offset + 1, splitPos - input.chunkOverlapChars);
  if (nextOffset <= input.offset) return { chunk, nextOffset: input.offset, done: true };
  return { chunk, nextOffset, done: false };
}

interface CharChunkOptions { chunkSizeChars: number; chunkOverlapChars: number; maxChunksPerFile: number; minChunkChars: number }

function resolveCharChunkOptions(options?: ChunkOptions): CharChunkOptions {
  return {
    chunkSizeChars: options?.chunkSizeChars ?? DEFAULT_CHUNK_SIZE_CHARS,
    chunkOverlapChars: options?.chunkOverlapChars ?? DEFAULT_CHUNK_OVERLAP_CHARS,
    maxChunksPerFile: options?.maxChunksPerFile ?? DEFAULT_MAX_CHUNKS_PER_FILE,
    minChunkChars: options?.minChunkChars ?? DEFAULT_MIN_CHUNK_CHARS,
  };
}

function finalizeCharChunks(results: ChunkResult[], options?: ChunkOptions): ChunkResult[] {
  for (let i = 0; i < results.length; i++) {
    results[i]!.chunkIndex = i;
    enrichChunk(results[i]!, options ?? {});
  }
  return results;
}

/**
 * Character-size-based chunking (existing behavior).
 */
function chunkByCharacterSize(
  text: string,
  options?: ChunkOptions,
): ChunkResult[] {
  if (isBlankText(text)) return [];
  const resolved = resolveCharChunkOptions(options);
  const results: ChunkResult[] = [];
  let offset = 0;

  while (offset < text.length && results.length < resolved.maxChunksPerFile) {
    const step = nextCharacterStep({ text, offset, chunkSizeChars: resolved.chunkSizeChars, chunkOverlapChars: resolved.chunkOverlapChars, minChunkChars: resolved.minChunkChars, resultCount: results.length });
    if (step.chunk !== null) results.push(step.chunk);
    if (step.done) break;
    offset = step.nextOffset;
  }

  return finalizeCharChunks(results, options);
}