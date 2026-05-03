/**
 * AST-Boundary Chunker — Precise code splitting at AST symbol boundaries.
 *
 * Uses web-tree-sitter WASM (same infrastructure as smart-edit) for AST-accurate
 * function/class/interface/enum boundary detection, replacing the regex-based
 * approach in chunking.ts.
 *
 * Architecture:
 *   - grammar-loader.ts loads WASM grammars lazily from @vscode/tree-sitter-wasm
 *   - ast-chunker.ts parses code with web-tree-sitter and extracts symbol spans
 *   - Falls back gracefully to regex-based boundary extraction when WASM is unavailable
 *   - Same return types as chunking.ts exports so it's a drop-in replacement
 *
 * Integration with smart-edit:
 *   - Same WASM package (@vscode/tree-sitter-wasm)
 *   - Same grammar loading strategy (fs.readFile + Language.load)
 *   - AST node classification mirrors smart-edit's ast-resolver.ts SYMBOL_NODE_TYPES
 *   - Cross-extension: if both extensions are loaded, grammars are cached separately
 *     per extension module scope (no shared memory), but WASM files benefit from
 *     OS-level disk cache.
 *
 * Advantages over regex-based chunking:
 *   - Accurate string/template literal handling (no brace-matching confusion)
 *   - Correct nested scope detection
 *   - Language-aware: handles Python (indentation), Rust (no braces for enums/traits),
 *     and other non-C-family languages
 *   - NO ERROR nodes in tree → confidence boundary is correct
 *   - Method detection within classes is reliable
 */

import { loadGrammar, type GrammarInfo } from "./grammar-loader.js";
import type { ChunkResult, ChunkOptions } from "./chunking.js";
import { extractSymbolBoundaries as chunkingExtractSymbolBoundaries } from "./chunking.js";

// ── Types ─────────────────────────────────────────────────────────

/**
 * A symbol span extracted from an AST.
 * Mirrors the internal SymbolSpan in chunking.ts but uses the same field names
 * for drop-in compatibility.
 */
export interface AstSymbolSpan {
  type: "function" | "method" | "class" | "interface" | "enum" | "type_alias" | "variable" | "export";
  name: string;
  startByte: number;
  endByte: number;
}

/**
 * Diagnostics from AST chunking, useful for debugging integration issues.
 */
export interface AstChunkerDiagnostics {
  /** Whether web-tree-sitter WASM was available */
  wasmAvailable: boolean;
  /** Which grammar was loaded */
  grammarExtension: string;
  /** The WASM file used */
  wasmFile: string | null;
  /** Whether the tree had ERROR or MISSING nodes */
  hasParseErrors: boolean;
  /** Number of symbol spans extracted */
  symbolCount: number;
  /** Time spent parsing in ms */
  parseTimeMs: number;
  /** Whether fallback to regex was used */
  usedFallback: boolean;
  /** Symbol types found */
  symbolTypesFound: string[];
}

// ─── Constants (matching chunking.ts defaults) ─────────────────────

const DEFAULT_CHUNK_SIZE_CHARS = 4096;
const DEFAULT_MAX_CHUNKS_PER_FILE = 12;
const DEFAULT_MIN_CHUNK_CHARS = 200;
const CHARS_PER_TOKEN = 4;

/**
 * Symbol node types recognized by tree-sitter.
 * Mirrors smart-edit's ast-resolver.ts SYMBOL_NODE_TYPES for consistency.
 */
const SYMBOL_NODE_TYPES = new Set([
  // ── JavaScript / TypeScript / TSX ──
  "function_declaration",
  "function_expression",
  "arrow_function",
  "method_definition",
  "class_declaration",
  "class_expression",
  "variable_declarator",
  "lexical_declaration",
  "export_statement",

  // ── Python ──
  "function_definition",
  "class_definition",
  "decorated_definition",

  // ── Rust ──
  "function_item",
  "struct_item",
  "enum_item",
  "trait_item",
  "impl_item",
  "mod_item",

  // ── Go ──
  "method_declaration",
  "function_declaration",
  "type_declaration",

  // ── Java ──
  "interface_declaration",
  "constructor_declaration",

  // ── Ruby ──
  "method",
  "class",
  "module",
  "singleton_method",

  // ── C / C++ ──
  "class_specifier",
  "struct_specifier",
  "enum_specifier",
  "function_definition",
]);

/**
 * Map tree-sitter node types to our chunker's symbol boundary types.
 */
const NODE_TYPE_TO_SYMBOL_TYPE: Record<string, AstSymbolSpan["type"]> = {
  "function_declaration": "function",
  "function_expression": "function",
  "arrow_function": "function",
  "method_definition": "method",
  "class_declaration": "class",
  "class_expression": "class",
  "variable_declarator": "variable",
  "lexical_declaration": "variable",
  "export_statement": "export",
  "function_definition": "function",  // Python, C
  "class_definition": "class",        // Python
  "decorated_definition": "function", // Python
  "function_item": "function",        // Rust
  "struct_item": "class",             // Rust
  "enum_item": "enum",                // Rust
  "trait_item": "interface",          // Rust
  "impl_item": "class",               // Rust
  "mod_item": "export",               // Rust module
  "method_declaration": "method",     // Go, Java
  "type_declaration": "type_alias",   // Go
  "interface_declaration": "interface", // Java
  "constructor_declaration": "method",  // Java
  "method": "method",                    // Ruby
  "class": "class",                      // Ruby
  "module": "export",                    // Ruby
  "singleton_method": "method",          // Ruby
  "class_specifier": "class",            // C++
  "struct_specifier": "class",           // C++
  "enum_specifier": "enum",              // C++
};

// ─── Name extraction helpers ─────────────────────────────────────

/**
 * Extract the name/identifier text from a symbol node.
 * Tries the "name" field (works for most tree-sitter grammars),
 * falls back to finding the first identifier-like child.
 *
 * Mirrors smart-edit's ast-resolver.ts findNameChild.
 */
function getNameFromNode(node: {
  childForFieldName: (field: string) => { text: string } | null;
  namedChildren: ReadonlyArray<{ type: string; text: string; isNamed: boolean }>;
}): string | null {
  // Try "name" field first (canonical for JS/TS/Python function_declaration)
  const nameField = node.childForFieldName?.("name");
  if (nameField) return nameField.text;

  // Try "type" field for type declarations (Go type X struct{})
  const typeField = node.childForFieldName?.("type");
  if (typeField) return typeField.text;

  // Fallback: find first identifier-like named child
  for (const child of node.namedChildren) {
    if (child.isNamed && (
      child.type === "identifier" ||
      child.type === "property_identifier" ||
      child.type === "type_identifier" ||
      child.type === "constant"
    )) {
      return child.text;
    }
  }

  return null;
}

// ─── AST symbol extraction ───────────────────────────────────────

/**
 * Extract symbol spans from source code using web-tree-sitter AST.
 *
 * Uses dynamic import() for web-tree-sitter since it's optional.
 * The Language object from grammarInfo is already loaded — we create
 * a fresh Parser instance, set the language, parse, and walk the tree.
 *
 * @param content - Source code text
 * @param grammarInfo - Pre-loaded grammar for the file's language
 * @returns Object with spans array and diagnostics
 */
export async function extractSymbolBoundariesAst(
  content: string,
  grammarInfo: GrammarInfo,
): Promise<{ spans: AstSymbolSpan[]; hasErrors: boolean; parseTimeMs: number }> {
  const startTime = Date.now();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const language = grammarInfo.language as any;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let parserInstance: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tree: any = null;

  try {
    if (!language || content.length === 0) {
      return { spans: [], hasErrors: false, parseTimeMs: Date.now() - startTime };
    }

    // We need a Parser instance to parse content. The Language object
    // alone can't parse — we need web-tree-sitter's Parser class.
    // Since grammar-loader already initialized the WASM runtime,
    // the Language object was loaded via Parser.Language.load().
    // We import web-tree-sitter dynamically to get the Parser class.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ParserModule: any = (await import("web-tree-sitter")).default;
    if (!ParserModule) {
      return { spans: [], hasErrors: false, parseTimeMs: Date.now() - startTime };
    }

    parserInstance = new ParserModule();
    parserInstance.setLanguage(language);
    tree = parserInstance.parse(content);

    const spans: AstSymbolSpan[] = [];
    const rootNode = tree.rootNode;
    const hasErrors = rootNode.hasError === true || rootNode.type === "ERROR";

    // Walk the tree using cursor (depth-first traversal)
    // Note: cursor.currentNode returns a new Node wrapper on each access,
    // so reference equality (===) must NOT be used to compare nodes.
    // Instead, we track traversal completion via gotoParent() return value.
    const cursor = rootNode.walk();

    while (true) {
      const node = cursor.currentNode;

      if (node && SYMBOL_NODE_TYPES.has(node.type)) {
        const name = getNameFromNode(node);
        if (name) {
          spans.push({
            type: NODE_TYPE_TO_SYMBOL_TYPE[node.type] ?? "function",
            name,
            startByte: node.startIndex,
            endByte: node.endIndex,
          });
        }
      }

      // Depth-first walk: try child, then sibling, then backtrack
      if (cursor.gotoFirstChild()) continue;
      if (cursor.gotoNextSibling()) continue;

      // Backtrack up the tree looking for an unvisited sibling
      let reachedRoot = false;
      while (true) {
        if (!cursor.gotoParent()) {
          reachedRoot = true;
          break;
        }
        if (cursor.gotoNextSibling()) {
          break;
        }
      }

      if (reachedRoot) {
        break;
      }
    }

    // Merge overlapping spans (keep the larger one)
    spans.sort((a, b) => a.startByte - b.startByte);
    const merged: AstSymbolSpan[] = [];
    for (const span of spans) {
      const prev = merged[merged.length - 1];
      if (prev && span.startByte < prev.endByte) {
        prev.endByte = Math.max(prev.endByte, span.endByte);
      } else {
        merged.push({ ...span });
      }
    }

    return { spans: merged, hasErrors, parseTimeMs: Date.now() - startTime };
  } finally {
    if (tree) { try { tree.delete(); } catch { /* ignore */ } }
    if (parserInstance) { try { parserInstance.delete(); } catch { /* ignore */ } }
  }
}

// ─── Async wrappers (the main entry points) ──────────────────────

/**
 * Extract symbol boundaries from source code using web-tree-sitter.
 *
 * Async wrapper that loads a grammar for the given extension and extracts
 * symbol spans. Falls back to regex-based extraction when WASM is unavailable.
 *
 * @param content - Source code text
 * @param filePath - File path (used to detect language via extension)
 * @returns Object with spans array and diagnostics
 */
export async function extractSymbolBoundaries(
  content: string,
  filePath: string,
): Promise<{ spans: AstSymbolSpan[]; diagnostics: AstChunkerDiagnostics }> {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  const diag: AstChunkerDiagnostics = {
    wasmAvailable: false,
    grammarExtension: ext,
    wasmFile: null,
    hasParseErrors: false,
    symbolCount: 0,
    parseTimeMs: 0,
    usedFallback: false,
    symbolTypesFound: [],
  };
  const parseStart = Date.now();

  try {
    const grammarInfo = await loadGrammar(ext);
    if (grammarInfo) {
      diag.wasmAvailable = true;
      diag.wasmFile = grammarInfo.wasmFile;

      const result = await extractSymbolBoundariesAst(content, grammarInfo);
      diag.hasParseErrors = result.hasErrors;
      diag.parseTimeMs = result.parseTimeMs;
      diag.symbolTypesFound = [...new Set(result.spans.map((s: AstSymbolSpan) => s.type))];
      diag.symbolCount = result.spans.length;

      return { spans: result.spans, diagnostics: diag };
    }
  } catch {
    // WASM unavailable or parse failure — fall through to regex fallback
  }

  // Fallback: use exported regex-based extraction from chunking.ts
  diag.usedFallback = true;
  diag.parseTimeMs = Date.now() - parseStart;

  const fallbackSpans = chunkingExtractSymbolBoundaries(content) as AstSymbolSpan[];
  diag.symbolCount = fallbackSpans.length;
  diag.symbolTypesFound = [...new Set(fallbackSpans.map((s) => s.type))];

  return { spans: fallbackSpans, diagnostics: diag };
}


// ─── Chunking by AST boundaries ───────────────────────────────────

/**
 * Chunk text using AST-accurate symbol boundaries.
 *
 * This is the drop-in replacement for chunking.ts's chunkBySymbolBoundaries.
 * Same algorithm, but uses web-tree-sitter AST spans for precise boundaries.
 *
 * Strategy:
 *   1. Extract symbol spans via AST
 *   2. Split at symbol boundaries
 *   3. Merge small adjacent chunks when possible
 *   4. Hard-split only for very large symbols
 *
 * @param text - Source code text
 * @param filePath - File path (for language detection)
 * @param options - Chunking options
 * @returns Array of ChunkResults
 */
export async function chunkByAstBoundaries(
  text: string,
  filePath: string,
  options?: ChunkOptions,
): Promise<{ chunks: ChunkResult[]; diagnostics: AstChunkerDiagnostics }> {
  const maxChunksPerFile = options?.maxChunksPerFile ?? DEFAULT_MAX_CHUNKS_PER_FILE;
  const minChunkChars = options?.minChunkChars ?? DEFAULT_MIN_CHUNK_CHARS;
  const chunkSizeChars = options?.chunkSizeChars ?? DEFAULT_CHUNK_SIZE_CHARS;

  const { spans, diagnostics } = await extractSymbolBoundaries(text, filePath);

  if (spans.length === 0) {
    // No symbols found — fall back to character-based
    const { chunkText } = await import("./chunking.js");
    const chunks = chunkText(text, { ...options, useSymbolBoundaries: false });
    return { chunks, diagnostics };
  }

  // First pass: create initial chunks at symbol boundaries
  const chunks: { text: string; startChar: number; endChar: number; span?: AstSymbolSpan }[] = [];

  // Add text before first symbol if significant
  if (spans[0]!.startByte > 0) {
    const preamble = text.slice(0, spans[0]!.startByte).trim();
    if (preamble.length >= minChunkChars) {
      chunks.push({ text: preamble, startChar: 0, endChar: spans[0]!.startByte });
    }
  }

  for (let i = 0; i < spans.length; i++) {
    const span = spans[i]!;
    const chunkTextContent = text.slice(span.startByte, span.endByte);

    if (chunkTextContent.length === 0) continue;

    // For very large symbols, sub-split at logical boundaries within the symbol
    if (chunkTextContent.length > chunkSizeChars * 2) {
      const { chunkText } = await import("./chunking.js");
      const subChunks = chunkText(chunkTextContent, {
        ...options,
        chunkSizeChars,
        maxChunksPerFile: 4,
        useSymbolBoundaries: false,
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
        text: chunkTextContent,
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
      ...(chunk.span && {
        symbolBoundary: {
          type: chunk.span.type,
          name: chunk.span.name,
          startLine,
          endLine,
        },
      }),
    });
  }

  return { chunks: results, diagnostics };
}

/**
 * Check if AST chunking is available for a given file extension.
 * Fast synchronous check — no async grammar loading.
 */
export function isAstChunkingAvailable(_ext: string): boolean {
  return loadGrammar !== undefined; // Grammar loader is always importable;
  // actual WASM availability is checked at async runtime
}
