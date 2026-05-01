export interface ChunkResult {
  text: string;
  chunkIndex: number;
  startChar: number;
  endChar: number;
  estimatedTokens: number;
  wasHardSplit: boolean;
  contextHeader?: string;
  embeddingText?: string;
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
function extractSymbolBoundaries(text: string): SymbolSpan[] {
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

  for (const { re, type, nameGroup } of declPatterns) {
    // Reset lastIndex since we iterate per pattern
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const name = match[nameGroup]!;
      const startByte = match.index + (match[0].indexOf(name) === 0 ? 0 : match[0].indexOf(name));
      // Find the extent: from the declaration start to the matching closing brace
      const declStart = match.index;
      const endByte = findMatchingBrace(text, declStart) ?? Math.min(declStart + 2000, text.length);

      // Avoid duplicating spans from different patterns
      const duplicate = spans.find(
        (s) => s.startByte === declStart || s.name === name && Math.abs(s.startByte - declStart) < 50,
      );
      if (!duplicate) {
        spans.push({ type, name, startByte: declStart, endByte });
      }
    }
  }

  // Sort by position
  spans.sort((a, b) => a.startByte - b.startByte);

  // Merge overlapping spans (keep the larger one)
  const merged: SymbolSpan[] = [];
  for (const span of spans) {
    const prev = merged[merged.length - 1];
    if (prev && span.startByte < prev.endByte) {
      // Overlapping — extend the previous span
      prev.endByte = Math.max(prev.endByte, span.endByte);
    } else {
      merged.push({ ...span });
    }
  }

  return merged;
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
 */
function findMatchingBrace(text: string, startPos: number): number | null {
  // Find the first { after startPos
  const openIdx = text.indexOf("{", startPos);
  if (openIdx === -1) return null;

  let depth = 0;
  let inString: string | null = null;
  let inComment: "line" | "block" | null = null;

  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    const prev = i > 0 ? text[i - 1] : "";

    // Handle string boundaries
    if (inComment === null) {
      if (inString) {
        if (ch === inString && prev !== "\\") inString = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        inString = ch;
        continue;
      }
    }

    // Handle comment boundaries
    if (inComment === "line") {
      if (ch === "\n") inComment = null;
      continue;
    }
    if (inComment === "block") {
      if (ch === "/" && prev === "*") inComment = null;
      continue;
    }
    if (inString === null) {
      if (ch === "/" && text[i + 1] === "/") { inComment = "line"; i++; continue; }
      if (ch === "/" && text[i + 1] === "*") { inComment = "block"; i++; continue; }
    }

    // Track brace depth
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }

  return null;
}

const DEFAULT_CHUNK_SIZE_CHARS = 4096;
const DEFAULT_CHUNK_OVERLAP_CHARS = 512;
const DEFAULT_MAX_CHUNKS_PER_FILE = 12;
const DEFAULT_MIN_CHUNK_CHARS = 200;
const CHARS_PER_TOKEN = 4;

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
  const chunkSizeChars = options?.chunkSizeChars ?? DEFAULT_CHUNK_SIZE_CHARS;
  const chunkOverlapChars = options?.chunkOverlapChars ?? DEFAULT_CHUNK_OVERLAP_CHARS;
  const maxChunksPerFile = options?.maxChunksPerFile ?? DEFAULT_MAX_CHUNKS_PER_FILE;
  const minChunkChars = options?.minChunkChars ?? DEFAULT_MIN_CHUNK_CHARS;
  const useSymbolBoundaries = options?.useSymbolBoundaries ?? false;

  if (!text || text.length === 0 || /^\s*$/.test(text)) return [];

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
function chunkBySymbolBoundaries(
  text: string,
  options?: ChunkOptions,
): ChunkResult[] {
  const maxChunksPerFile = options?.maxChunksPerFile ?? DEFAULT_MAX_CHUNKS_PER_FILE;
  const minChunkChars = options?.minChunkChars ?? DEFAULT_MIN_CHUNK_CHARS;
  const chunkSizeChars = options?.chunkSizeChars ?? DEFAULT_CHUNK_SIZE_CHARS;

  const spans = extractSymbolBoundaries(text);

  if (spans.length === 0) {
    // No symbols found — fall back to character-based
    return chunkByCharacterSize(text, options);
  }

  // First pass: create initial chunks at symbol boundaries
  const chunks: { text: string; startChar: number; endChar: number; span?: SymbolSpan }[] = [];

  // Add text before first symbol if significant
  if (spans[0]!.startByte > 0) {
    const preamble = text.slice(0, spans[0]!.startByte).trim();
    if (preamble.length >= minChunkChars) {
      chunks.push({ text: preamble, startChar: 0, endChar: spans[0]!.startByte });
    }
  }

  for (let i = 0; i < spans.length; i++) {
    const span = spans[i]!;
    const chunkText2 = text.slice(span.startByte, span.endByte);

    if (chunkText2.length === 0) continue;

    // For very large symbols, sub-split at logical boundaries within the symbol
    if (chunkText2.length > chunkSizeChars * 2) {
      const subChunks = chunkByCharacterSize(chunkText2, {
        ...options,
        chunkSizeChars,
        maxChunksPerFile: 4,
      });
      for (const sc of subChunks) {
        chunks.push({
          text: sc.text,
          startChar: span.startByte + sc.startChar,
          endChar: span.startByte + sc.endChar,
          span,
        });
      }
    } else {
      chunks.push({
        text: chunkText2,
        startChar: span.startByte,
        endChar: span.endByte,
        span,
      });
    }
  }

  // Merge small adjacent chunks
  const merged: typeof chunks = [];
  for (const chunk of chunks) {
    const prev = merged[merged.length - 1];
    if (prev && prev.text.length + chunk.text.length < chunkSizeChars) {
      // Merge with previous
      prev.text += "\n" + chunk.text;
      prev.endChar = chunk.endChar;
      prev.span = prev.span ?? chunk.span;
    } else {
      merged.push({ ...chunk });
    }
  }

  // Build final ChunkResult array with line-aware metadata
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

  // Recompute indices and enrich
  for (let i = 0; i < results.length; i++) {
    results[i].chunkIndex = i;
    enrichChunk(results[i], options ?? {});
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
  const chunkSizeChars = options?.chunkSizeChars ?? DEFAULT_CHUNK_SIZE_CHARS;
  const chunkOverlapChars = options?.chunkOverlapChars ?? DEFAULT_CHUNK_OVERLAP_CHARS;
  const maxChunksPerFile = options?.maxChunksPerFile ?? DEFAULT_MAX_CHUNKS_PER_FILE;
  const minChunkChars = options?.minChunkChars ?? DEFAULT_MIN_CHUNK_CHARS;

  if (!text || text.length === 0 || /^\s*$/.test(text)) return [];

  const results: ChunkResult[] = [];
  let offset = 0;

  while (offset < text.length && results.length < maxChunksPerFile) {
    const remaining = text.length - offset;
    let targetEnd = offset + chunkSizeChars;

    if (remaining <= chunkSizeChars) {
      const chunk = text.slice(offset);
      results.push({
        text: chunk,
        chunkIndex: results.length,
        startChar: offset,
        endChar: text.length,
        estimatedTokens: Math.ceil(chunk.length / CHARS_PER_TOKEN),
        wasHardSplit: false,
      });
      break;
    }

    let splitPos = targetEnd;
    let wasHardSplit = true;

    let bestPos = -1;
    for (let i = targetEnd - 1; i >= offset + 1; i--) {
      if (text[i] === '\n' && text[i - 1] === '\n') {
        bestPos = i + 1;
        break;
      }
    }
    if (bestPos >= 0) {
      splitPos = bestPos;
      wasHardSplit = false;
    } else {
      bestPos = -1;
      for (let i = targetEnd - 1; i >= offset + 1; i--) {
        if (text[i] === '\n') {
          bestPos = i + 1;
          break;
        }
      }
      if (bestPos >= 0) {
        splitPos = bestPos;
        wasHardSplit = false;
      } else {
        bestPos = -1;
        for (let i = targetEnd - 1; i >= offset + 1; i--) {
          if (/\s/.test(text[i])) {
            bestPos = i + 1;
            break;
          }
        }
        if (bestPos >= 0) {
          splitPos = bestPos;
          wasHardSplit = false;
        }
      }
    }

    const chunk = text.slice(offset, splitPos);
    const endChar = splitPos;

    if (chunk.length >= minChunkChars || results.length === 0) {
      results.push({
        text: chunk,
        chunkIndex: results.length,
        startChar: offset,
        endChar,
        estimatedTokens: Math.ceil(chunk.length / CHARS_PER_TOKEN),
        wasHardSplit,
      });
    }

    const nextOffset = Math.max(offset + 1, splitPos - chunkOverlapChars);
    if (nextOffset <= offset) break;
    offset = nextOffset;
  }

  for (let i = 0; i < results.length; i++) {
    results[i].chunkIndex = i;
    enrichChunk(results[i], options ?? {});
  }

  return results;
}