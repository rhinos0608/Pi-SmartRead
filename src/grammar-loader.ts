/**
 * Grammar Loader — lazy-loads web-tree-sitter WASM grammars for AST-boundary chunking.
 *
 * Mirrors smart-edit's grammar-loader.ts approach for cross-extension consistency.
 * Uses @vscode/tree-sitter-wasm (pre-built, comprehensive) for parsing.
 * Graceful degradation when WASM is unavailable — returns null.
 *
 * Key differences from smart-edit's grammar-loader:
 *   - Uses dynamic import() for web-tree-sitter (optional peer dependency)
 *   - Same extension-to-WASM mapping for consistency
 *
 * Integration with smart-edit:
 *   - Same package: @vscode/tree-sitter-wasm + web-tree-sitter
 *   - Same WASM loading strategy: fs.readFile + Language.load
 *   - Same extension-to-WASM mapping
 *   - If both extensions are loaded, grammars are cached separately (no shared memory),
 *     but WASM files are read once from disk (OS file cache).
 */

import { createRequire } from "module";
import { readFile } from "fs/promises";

const _require = createRequire(import.meta.url);

const VSCODE_WASM_PACKAGE = "@vscode/tree-sitter-wasm";
const WASM_DIR = "wasm";

/**
 * Map file extensions to WASM filenames within @vscode/tree-sitter-wasm.
 * Same mapping as smart-edit's grammar-loader for consistency.
 */
const EXT_TO_WASM: Record<string, string | null> = {
  ".ts": "tree-sitter-typescript.wasm",
  ".tsx": "tree-sitter-tsx.wasm",
  ".js": "tree-sitter-javascript.wasm",
  ".jsx": "tree-sitter-javascript.wasm",
  ".mjs": "tree-sitter-javascript.wasm",
  ".cjs": "tree-sitter-javascript.wasm",
  ".mts": "tree-sitter-typescript.wasm",
  ".cts": "tree-sitter-typescript.wasm",
  ".py": "tree-sitter-python.wasm",
  ".rs": "tree-sitter-rust.wasm",
  ".go": "tree-sitter-go.wasm",
  ".java": "tree-sitter-java.wasm",
  ".c": "tree-sitter-cpp.wasm",
  ".cpp": "tree-sitter-cpp.wasm",
  ".h": "tree-sitter-cpp.wasm",
  ".hpp": "tree-sitter-cpp.wasm",
  ".rb": "tree-sitter-ruby.wasm",
  ".css": "tree-sitter-css.wasm",
  ".bash": "tree-sitter-bash.wasm",
  ".sh": "tree-sitter-bash.wasm",
};

// ── Module state ──────────────────────────────────────────────────

/** web-tree-sitter module, cached after init. */
let ParserModule: unknown | null = null;
let parserInitPromise: Promise<unknown> | null = null;

/** Loaded grammars, cached per WASM filename. */
const grammarCache = new Map<string, unknown | null>();
const loadWarnings = new Set<string>();

// ── Internal helpers ──────────────────────────────────────────────

/**
 * Get the web-tree-sitter Parser module.
 * Initializes the WASM runtime on first call.
 */
async function getParser(): Promise<unknown> {
  if (ParserModule) return ParserModule;
  if (parserInitPromise) return parserInitPromise;
  parserInitPromise = initWasm();
  return parserInitPromise;
}

async function initWasm(): Promise<unknown> {
  // Dynamic import since web-tree-sitter is optional
  const mod = await import("web-tree-sitter");
  await mod.default.init();
  ParserModule = mod.default;
  return ParserModule;
}

/**
 * Resolve the WASM file path from @vscode/tree-sitter-wasm.
 */
function resolveWasmPath(wasmFile: string): string | null {
  try {
    return _require.resolve(`${VSCODE_WASM_PACKAGE}/${WASM_DIR}/${wasmFile}`);
  } catch {
    return null;
  }
}

/**
 * Load a single WASM grammar file.
 * Results are cached per WASM filename.
 */
async function loadWasmGrammar(wasmFile: string): Promise<unknown | null> {
  if (grammarCache.has(wasmFile)) {
    return grammarCache.get(wasmFile) ?? null;
  }

  try {
    const Parser = (await getParser()) as {
      Language: { load: (buf: Buffer) => Promise<unknown> };
      init: () => Promise<void>;
    };
    const wasmPath = resolveWasmPath(wasmFile);
    if (!wasmPath) {
      if (!loadWarnings.has(wasmFile)) {
        loadWarnings.add(wasmFile);
        console.warn(`[pi-smartread] Grammar for ${wasmFile} not available in ${VSCODE_WASM_PACKAGE}`);
      }
      return null;
    }

    const wasmBuffer = await readFile(wasmPath);
    const language = await Parser.Language.load(wasmBuffer);
    grammarCache.set(wasmFile, language);
    return language;
  } catch (err) {
    if (!loadWarnings.has(wasmFile)) {
      loadWarnings.add(wasmFile);
      console.warn(`[pi-smartread] Cannot load grammar ${wasmFile}: ${err instanceof Error ? err.message : String(err)}`);
    }
    grammarCache.set(wasmFile, null);
    return null;
  }
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Result of loading a grammar.
 */
export interface GrammarInfo {
  /** The tree-sitter Language object for parsing. */
  language: unknown;
  /** The WASM filename (e.g., "tree-sitter-typescript.wasm") for cache keying. */
  wasmFile: string;
  /** The extension that was requested (e.g., ".ts"). */
  extension: string;
}

/**
 * Load a grammar for the given file extension.
 *
 * Returns the GrammarInfo with loaded Language, or null if:
 * - The extension is not supported
 * - The WASM package is not installed
 * - WASM initialization fails
 *
 * Results are cached. First call to any extension triggers async WASM init.
 *
 * @param ext - File extension including dot (e.g., ".ts")
 */
export async function loadGrammar(ext: string): Promise<GrammarInfo | null> {
  const wasmFile = EXT_TO_WASM[ext.toLowerCase()];
  if (!wasmFile) return null;

  const language = await loadWasmGrammar(wasmFile);
  if (!language) return null;

  return { language, wasmFile, extension: ext };
}

/**
 * Check if a grammar is available for the given extension
 * without triggering a load. Returns true if cached.
 */
export function isGrammarCached(ext: string): boolean {
  const wasmFile = EXT_TO_WASM[ext.toLowerCase()];
  if (!wasmFile) return false;
  return grammarCache.has(wasmFile) && grammarCache.get(wasmFile) !== null;
}

/**
 * Get all supported file extensions for AST parsing.
 */
export function getSupportedExtensions(): string[] {
  return Object.keys(EXT_TO_WASM).filter((ext) => EXT_TO_WASM[ext] !== null);
}

/**
 * Clear all cached grammars. Frees WASM memory.
 * Useful for testing.
 */
export function clearGrammarCache(): void {
  grammarCache.clear();
  loadWarnings.clear();
}

/**
 * Reset parser state (for testing).
 */
export function resetParser(): void {
  ParserModule = null;
  parserInitPromise = null;
}
