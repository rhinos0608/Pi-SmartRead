/**
 * RepoMap orchestrator — Aider-style repository mapping for Pi-SmartRead.
 *
 * Pipeline (default — tree-sitter):
 *   1. Discover source files in the repo
 *   2. Extract tags (definitions/references) via tree-sitter
 *   3. Build reference graph (file → file edges based on shared identifiers)
 *   4. Run PageRank to rank files by importance
 *   5. Build token-budgeted map output showing key symbols with context
 *
 * Pipeline (fallback — import-based in-degree):
 *   1. Discover source files in the repo
 *   2. Extract import statements via regex (JS/TS/Python)
 *   3. Resolve imports to concrete file paths
 *   4. Build import graph, rank files by in-degree (how many files import them)
 *   5. Build token-budgeted map output showing ranked files with top symbols
 *
 * Aider compat features:
 * - Triple fallback chain: full context → without focusFiles → unhinted
 * - Sophisticated edge weighting (identifier-aware)
 * - mentioned_idents → file path matching
 * - Refresh caching modes (auto/manual/files/always)
 * - Progress indicator callback
 * - Model-aware token counting (sample-based)
 * - Priority/special files prepended to output
 * - Error recovery (RecursionError, parse failures, file-not-found)
 */
import path from "node:path";
import { readFileSync } from "node:fs";
import type { Tag } from "./cache.js";
import { TagsCache } from "./cache.js";
import { findSrcFiles } from "./file-discovery.js";
import { getTagsBatch, initParser, getTagsRaw } from "./tags.js";
import { pagerank, buildWeightedEdges, type GraphEdge } from "./pagerank.js";
import { renderTreeContext } from "./tree-context.js";
import { filenameToLang, isSupportedFile } from "./languages.js";
import { discoverImportantFiles, isImportantFile } from "./special.js";

// ── Options & Types ───────────────────────────────────────────────

export interface RepoMapOptions {
  /** Token budget for the map output (default: 4096) */
  mapTokens: number;
  /** Focus files to personalize PageRank toward */
  focusFiles: string[];
  /** Additional files beyond auto-discovered */
  additionalFiles: string[];
  /** Priority files (boosted in ranking) */
  priorityFiles: string[];
  /** Priority identifiers (boosted in ranking) */
  priorityIdentifiers: string[];
  /** Force re-parse even if cached */
  forceRefresh: boolean;
  /** Exclude files with rank === 0 from output */
  excludeUnranked: boolean;
  /** Verbose logging */
  verbose: boolean;
  /**
   * Use import-based dependency mapping instead of tree-sitter symbol PageRank.
   * Default: false (tree-sitter + PageRank).
   */
  useImportBased: boolean;
  /**
   * Auto-fallback to import-based mapping when tree-sitter fails.
   * Default: true. Set false to surface tree-sitter errors.
   */
  autoFallback: boolean;
  /**
   * Compact output format — single-line file summaries instead of code context.
   * Default: false (full code context).
   */
  compact: boolean;
  /**
   * Refresh mode for cached maps.
   * - "auto": caches if processing > 1s, refreshes on forceRefresh or cache miss
   * - "manual": returns last_map unless forceRefresh
   * - "files": only refreshes when file list changes (ignores content changes)
   * - "always": always regenerates
   * Default: "auto"
   */
  refresh: "auto" | "manual" | "files" | "always";
  /**
   * Optional progress callback for long operations.
   * Called with status messages during parsing, ranking, and rendering.
   */
  progress?: (msg: string) => void;
  /**
   * Identifiers mentioned in user query for path-based personalization.
   * When present, files whose path components match these identifiers
   * get personalization boost.
   */
  mentionedIdents?: string[];
  /**
   * Files mentioned in user query for path-based personalization.
   */
  mentionedFnames?: string[];
}

export interface RepoMapResult {
  /** The rendered repo map string */
  map: string;
  /** Token count of the map */
  tokenCount: number;
  /** Ranked tags with their scores */
  rankedTags: RankedTag[];
  /** Stats about what was processed */
  stats: RepoMapStats;
}

export interface RepoMapStats {
  totalFiles: number;
  totalTags: number;
  definitions: number;
  references: number;
  cacheSize: number;
  processingTimeMs: number;
  /** Which ranking method was used */
  rankMethod: "tree-sitter" | "import-based";
  /** When import-based, how many import edges were found */
  importEdges: number;
  /** How many fallback attempts were made */
  fallbackAttempts: number;
}

export interface RankedTag {
  tag: Tag;
  rank: number;
}

export interface SearchResult {
  file: string;
  line: number;
  name: string;
  kind: "def" | "ref";
  context: string;
}

const FALLBACK_DEFINITION_PATTERNS: RegExp[] = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/i,
  /^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/i,
  /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/i,
  /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/i,
  /^\s*(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/i,
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/i,
  /^\s*def\s+([A-Za-z_$][\w$]*)/i,
  /^\s*fn\s+([A-Za-z_$][\w$]*)/i,
  /^\s*module\s+([A-Za-z_$][\w$]*)/i,
];

function getFallbackMatch(line: string, queryLower: string): { kind: "def" | "ref"; name: string } | null {
  for (const pattern of FALLBACK_DEFINITION_PATTERNS) {
    const match = line.match(pattern);
    const name = match?.[1];
    if (name && name.toLowerCase().includes(queryLower)) {
      return { kind: "def", name };
    }
  }

  if (!line.toLowerCase().includes(queryLower)) return null;

  const identRe = /\b([A-Za-z_$][\w$]*)\b/g;
  let match: RegExpExecArray | null;
  while ((match = identRe.exec(line)) !== null) {
    const name = match[1];
    if (name.toLowerCase().includes(queryLower)) {
      return { kind: "ref", name };
    }
  }

  return null;
}

function sortSearchResults(results: SearchResult[]): SearchResult[] {
  return [...results].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "def" ? -1 : 1;
    const fileCompare = a.file.localeCompare(b.file);
    if (fileCompare !== 0) return fileCompare;
    return a.line - b.line;
  });
}

function searchIdentifiersByText(
  root: string,
  files: string[],
  query: string,
  options: {
    maxResults: number;
    includeDefinitions: boolean;
    includeReferences: boolean;
  },
  signal?: AbortSignal,
): SearchResult[] {
  const queryLower = query.toLowerCase();
  const results: SearchResult[] = [];

  for (const fname of files) {
    if (signal?.aborted) return [];

    let code: string;
    try {
      code = readFileSync(fname, "utf-8");
    } catch {
      continue;
    }

    const lines = code.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (!line.toLowerCase().includes(queryLower)) continue;

      const match = getFallbackMatch(line, queryLower);
      if (!match) continue;
      if (match.kind === "def" && !options.includeDefinitions) continue;
      if (match.kind === "ref" && !options.includeReferences) continue;

      const lineNumber = i + 1;
      const context = renderTreeContext(code, [lineNumber], {
        lineNumbers: true,
        loiPad: 2,
      }, fname);

      results.push({
        file: path.relative(root, fname),
        line: lineNumber,
        name: match.name,
        kind: match.kind,
        context,
      });
    }
  }

  const sorted = sortSearchResults(results);
  return sorted.slice(0, options.maxResults);
}

/** Directed edge between files (from → to = "from imports to") */
export interface ImportEdge {
  from: string;
  to: string;
}

const DEFAULT_MAP_TOKENS = 4096;
const CHARS_PER_TOKEN = 4;

/** Supported import-extraction languages */
type ImportExtractLang = "javascript" | "typescript" | "tsx" | "python";

// ── Token counting ────────────────────────────────────────────────

/**
 * Estimate tokens using chars/4 heuristic.
 * Used as fallback when model-aware counting is unavailable.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Model-aware token counting.
 * For texts > 200 chars, sample every ~1% of lines, compute sample token count,
 * and extrapolate to full text. Provides more accurate counts than chars/4.
 *
 * Matches Aider's behavior in repomap.py:
 * ```python
 * if len_text < 200:
 *     return self.main_model.token_count(text)
 * lines = text.splitlines(keepends=True)
 * step = num_lines // 100 or 1
 * lines = lines[::step]
 * sample_tokens = self.main_model.token_count(sample_text)
 * est_tokens = sample_tokens / len(sample_text) * len_text
 * ```
 *
 * Since we don't always have access to a model's token_count API,
 * we use a heuristic: chars/4 is the baseline, but for texts > 200 chars,
 * we sample lines and count characters more carefully.
 *
 * @param text - The text to count tokens for
 * @param tokenCountFn - Optional model token count function (e.g., model.token_count)
 * @returns Estimated token count
 */
export function countTokens(
  text: string,
  tokenCountFn?: (t: string) => number,
): number {
  if (!text) return 0;

  if (!tokenCountFn) {
    // Fall back to chars/4 heuristic
    return estimateTokens(text);
  }

  if (text.length < 200) {
    return tokenCountFn(text);
  }

  // Sample every ~1% of lines
  const lines = text.split("\n");
  const numLines = lines.length;
  const step = Math.max(1, Math.floor(numLines / 100));
  const sampledLines: string[] = [];
  for (let i = 0; i < numLines; i += step) {
    sampledLines.push(lines[i]);
  }
  const sampleText = sampledLines.join("\n");
  const sampleTokens = tokenCountFn(sampleText);

  // Extrapolate
  return Math.round((sampleTokens / sampleText.length) * text.length);
}

// ── Import extraction helpers ─────────────────────────────────────

const IMPORT_ESM =
  /import\s+(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+\w+|\w+))?)\s+from\s+)?['"]([^'"]+)['"]/g;
const IMPORT_CJS =
  /(?:^|[^.\w])(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

// ── TS path alias resolution ──────────────────────────────────────

/** Map of alias prefixes → target dirs, e.g. { "@/*": ["./src/*"] } */
export interface TsAliasMap {
  /** e.g. "@" → "./src" — the prefix without /* */
  prefixes: Map<string, string>;
}

/**
 * Parse tsconfig.json (or jsconfig.json) to extract compilerOptions.paths.
 * Returns a map of alias prefixes to directory targets.
 */
export function parseTsconfigPaths(root: string): TsAliasMap | null {
  const prefixes = new Map<string, string>();

  const configNames = ["tsconfig.json", "jsconfig.json"];
  for (const name of configNames) {
    const configPath = path.join(root, name);
    let raw: string;
    try {
      raw = readFileSync(configPath, "utf-8");
    } catch {
      continue;
    }

    try {
      const config = JSON.parse(raw);
      const paths = config?.compilerOptions?.paths;
      if (!paths || typeof paths !== "object") continue;

      for (const [alias, targets] of Object.entries(paths)) {
        const aliasMatch = alias.match(/^([^/*]+)\/(?:\*|\*\*)$/);
        if (!aliasMatch) continue;
        const prefix = aliasMatch[1];

        const targetArr = Array.isArray(targets) ? targets : [targets];
        for (const t of targetArr) {
          if (typeof t !== "string") continue;
          const dirMatch = t.match(/^\.(\/[^/*]+)(?:\/\*|\/\*\*)?$/);
          if (dirMatch) {
            const targetDir = "." + dirMatch[1];
            if (!prefixes.has(prefix)) {
              prefixes.set(prefix, targetDir);
            }
            break;
          }
        }
      }
    } catch {
      continue;
    }
  }

  if (prefixes.size === 0) return null;
  return { prefixes };
}

function resolveViaAlias(
  importPath: string,
  absRoot: string,
  aliases: TsAliasMap,
): string | null {
  for (const [prefix, targetDir] of aliases.prefixes) {
    if (!importPath.startsWith(prefix)) continue;
    const suffix = importPath.slice(prefix.length);
    if (!suffix.startsWith("/")) continue;
    return path.resolve(absRoot, targetDir + suffix);
  }
  return null;
}

function resolveImportPath(
  importPath: string,
  fromRelDir: string,
  absRoot: string,
  knownFiles: Set<string>,
  aliases?: TsAliasMap,
): string | null {
  const searchPaths: string[] = [];

  if (aliases && !importPath.startsWith(".") && !importPath.startsWith("/")) {
    const aliasResolved = resolveViaAlias(importPath, absRoot, aliases);
    if (aliasResolved) {
      searchPaths.push(aliasResolved);
    }
  }

  if (importPath.startsWith("/")) {
    searchPaths.push(path.resolve(absRoot, "." + importPath));
  } else if (importPath.startsWith(".")) {
    searchPaths.push(path.resolve(fromRelDir, importPath));
  } else {
    searchPaths.push(path.resolve(fromRelDir, importPath));
  }

  const extensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs"];

  for (const absPath of searchPaths) {
    const rel = path.relative(absRoot, absPath);
    if (knownFiles.has(rel)) return rel;
    for (const ext of extensions) {
      const candidate = rel + ext;
      if (knownFiles.has(candidate)) return candidate;
    }
    for (const ext of extensions) {
      const candidate = path.join(rel, `index${ext}`);
      if (knownFiles.has(candidate)) return candidate;
    }
  }

  return null;
}

function extractImports(fname: string, code: string): string[] {
  const lang = filenameToLang(fname);
  if (!lang) return [];

  const imports: string[] = [];
  const seen = new Set<string>();

  if (lang === "javascript" || lang === "typescript" || lang === "tsx") {
    for (const match of code.matchAll(IMPORT_ESM)) {
      const p = match[1];
      if (p && !seen.has(p)) { seen.add(p); imports.push(p); }
    }
    for (const match of code.matchAll(IMPORT_CJS)) {
      const p = match[1];
      if (p && !seen.has(p)) { seen.add(p); imports.push(p); }
    }
    const tsRef = /\/\/\/\s*<reference\s+path\s*=\s*['"]([^'"]+)['"]/g;
    for (const match of code.matchAll(tsRef)) {
      const p = match[1];
      if (p && !seen.has(p)) { seen.add(p); imports.push(p); }
    }
  } else if (lang === "go") {
    // Go: import "fmt"  or  import ("fmt" "os")
    const goImportLine = /^import\s+"([^"]+)"/gm;
    for (const match of code.matchAll(goImportLine)) {
      const p = match[1];
      if (p && !seen.has(p)) { seen.add(p); imports.push(p); }
    }
    // Go grouped: import ( "fmt" ; "fmt" "os" )
    const goImportBlock = /import\s*\(([^)]*)\)/g;
    for (const match of code.matchAll(goImportBlock)) {
      const block = match[1];
      const quoted = block.match(/"([^"]+)"/g);
      if (quoted) {
        for (const q of quoted) {
          const p = q.replace(/"/g, "");
          if (p && !seen.has(p)) { seen.add(p); imports.push(p); }
        }
      }
    }
  } else if (lang === "rust") {
    // Rust: use crate::module; use std::collections::HashMap;
    const rustUse = /^use\s+([a-zA-Z_][a-zA-Z0-9_:*]*);/gm;
    for (const match of code.matchAll(rustUse)) {
      let p = match[1];
      p = p.replace(/^(crate|self|super)::/, "");
      p = p.replace(/::\*$/, "");
      const parts = p.split("::");
      if (parts.length >= 1 && parts[0] !== "std" && parts[0] !== "core" && parts[0] !== "alloc") {
        const modulePath = parts.join("/");
        if (modulePath && !seen.has(modulePath)) { seen.add(modulePath); imports.push(modulePath); }
      }
    }
    // Rust: extern crate foo;
    const rustExtern = /^extern\s+crate\s+([a-zA-Z_][a-zA-Z0-9_]*);/gm;
    for (const match of code.matchAll(rustExtern)) {
      const p = match[1];
      if (p && !seen.has(p)) { seen.add(p); imports.push(p); }
    }
    // Rust: mod module
    const rustMod = /^mod\s+([a-zA-Z_][a-zA-Z0-9_]*);/gm;
    for (const match of code.matchAll(rustMod)) {
      const p = match[1];
      if (p && !seen.has(p) && p !== "tests") { seen.add(p); imports.push(p); }
    }
  } else if (lang === "python") {
    const fromRe = /^from\s+([a-zA-Z_][a-zA-Z0-9_.]*)\s+import/mg;
    for (const match of code.matchAll(fromRe)) {
      const p = match[1].replace(/\./g, "/");
      if (p && p !== "__future__" && !seen.has(p)) { seen.add(p); imports.push(p); }
    }
    const importRe = /^import\s+([a-zA-Z_][a-zA-Z0-9_]*)(?:\s*,\s*[a-zA-Z_][a-zA-Z0-9_]*)*/mg;
    for (const match of code.matchAll(importRe)) {
      const parts = match[0].split(/\s*,\s*/);
      for (const part of parts) {
        const p = part.replace(/^import\s+/, "").replace(/\./g, "/");
        if (p && !p.startsWith("__") && !seen.has(p)) { seen.add(p); imports.push(p); }
      }
    }
  }

  return imports;
}

function buildImportGraph(
  allFiles: string[],
  root: string,
  aliases?: TsAliasMap,
): { inDegrees: Map<string, number>; edges: ImportEdge[] } {
  const knownRelFiles = new Set(allFiles);
  const inDegrees = new Map<string, number>();
  const edges: ImportEdge[] = [];
  const processed = new Set<string>();

  // Use a queue for recursive resolution
  const queue = [...allFiles];
  while (queue.length > 0) {
    const relFname = queue.shift()!;
    if (processed.has(relFname)) continue;
    processed.add(relFname);

    const absFname = path.resolve(root, relFname);
    let code: string;
    try { code = readFileSync(absFname, "utf-8"); } catch { continue; }

    const importPaths = extractImports(absFname, code);

    for (const imp of importPaths) {
      const resolved = resolveImportPath(imp, path.dirname(absFname), root, knownRelFiles, aliases);
      if (resolved && resolved !== relFname) {
        edges.push({ from: relFname, to: resolved });
        inDegrees.set(resolved, (inDegrees.get(resolved) ?? 0) + 1);

        // Enqueue unresolved file for recursive processing
        if (!processed.has(resolved)) {
          queue.push(resolved);
        }
      }
    }
  }

  for (const relFname of allFiles) {
    if (!inDegrees.has(relFname)) { inDegrees.set(relFname, 0); }
  }

  return { inDegrees, edges };
}

// ── RepoMap orchestrator ──────────────────────────────────────────

export class RepoMap {
  private root: string;
  private mapTokens: number;
  private verbose: boolean;
  private cache: TagsCache;
  private mapCache: Map<string, RepoMapResult>;
  private lastMap: string | null;
  private lastMapTokens: number;
  private mapProcessingTime: number;
  private lastFileSet: Set<string> | null;
  private searchTreeSitterAvailable: boolean | null;

  constructor(root: string, options: Partial<RepoMapOptions> = {}) {
    this.root = path.resolve(root);
    this.mapTokens = options.mapTokens ?? DEFAULT_MAP_TOKENS;
    this.verbose = options.verbose ?? false;
    this.cache = new TagsCache(this.root);
    this.mapCache = new Map();
    this.lastMap = null;
    this.lastMapTokens = 0;
    this.mapProcessingTime = 0;
    this.lastFileSet = null;
    this.searchTreeSitterAvailable = null;
  }

  /**
   * Generate a token-budgeted repo map.
   *
   * Default mode: tree-sitter AST parsing → symbol extraction → PageRank.
   * Fallback mode: import statement scanning → in-degree counting.
   *
   * Triple fallback chain (matching Aider's base_coder.py get_repo_map):
   *   1. Full context with all focus files, priority files, priority idents
   *   2. Fallback: without focusFiles (if they're disconnected from the graph)
   *   3. Final fallback: completely unhinted (map whole repo)
   */
  async getRepoMap(
    options: Partial<RepoMapOptions> = {},
  ): Promise<RepoMapResult> {
    const startTime = Date.now();
    const refresh = options.refresh ?? "auto";
    const forceRefresh = options.forceRefresh ?? false;

    // ── Cache check ──
    const cacheKey = this.computeCacheKey(options);
    if (!forceRefresh) {
      if (refresh === "manual" && this.lastMap !== null) {
        // Return cached last map
        return this.buildCachedResult(cacheKey, startTime);
      }

      if (refresh === "files") {
        const filesSame = this.areFilesSame(options);
        if (filesSame && this.mapCache.has(cacheKey)) {
          return this.mapCache.get(cacheKey)!;
        }
      }

      if (refresh === "auto" && this.mapProcessingTime > 1.0) {
        const cached = this.mapCache.get(cacheKey);
        if (cached && !forceRefresh) {
          return cached;
        }
      }

      if (this.mapCache.has(cacheKey) && !forceRefresh) {
        return this.mapCache.get(cacheKey)!;
      }
    }

    // ── Generate map with triple fallback ──
    let result: RepoMapResult | null = null;
    let fallbackAttempts = 0;

    try {
      // Attempt 1: full context
      result = await this.generateMap(options, startTime, fallbackAttempts);

      // If map is empty or no valid content, try without focusFiles
      if (!result || !result.map) {
        fallbackAttempts++;
        const noFocusOptions = { ...options, focusFiles: [] };
        result = await this.generateMap(noFocusOptions, startTime, fallbackAttempts);
      }

      // If still empty, try completely unhinted
      if (!result || !result.map) {
        fallbackAttempts++;
        result = await this.generateMap(
          {
            ...options,
            focusFiles: [],
            priorityFiles: [],
            priorityIdentifiers: [],
          },
          startTime,
          fallbackAttempts,
        );
      }
    } catch (err) {
      // RecursionError or other — disable map
      if (this.verbose) {
        console.error(`[RepoMap] Generation failed: ${(err as Error).message}`);
      }
      result = this.buildEmptyResult(startTime, fallbackAttempts, options.useImportBased ? "import-based" : "tree-sitter");
    }

    if (!result) {
      result = this.buildEmptyResult(startTime, fallbackAttempts, options.useImportBased ? "import-based" : "tree-sitter");
    }

    // ── Cache and return ──
    this.mapProcessingTime = Date.now() - startTime;
    this.mapCache.set(cacheKey, result);
    this.lastMap = result.map;
    this.lastMapTokens = result.tokenCount;

    return result;
  }

  /**
   * Generate a single map attempt with given options.
   */
  private async generateMap(
    options: Partial<RepoMapOptions>,
    startTime: number,
    fallbackAttempts: number,
  ): Promise<RepoMapResult | null> {
    const useImportBased = options.useImportBased ?? false;
    const autoFallback = options.autoFallback ?? true;

    const focusFiles = (options.focusFiles ?? []).map((f) => path.resolve(this.root, f));
    const additionalFiles = (options.additionalFiles ?? []).map((f) => path.resolve(this.root, f));
    const priorityFiles = new Set(
      (options.priorityFiles ?? []).map((f) => path.resolve(this.root, f)),
    );
    const priorityIdentifiers = new Set(options.priorityIdentifiers ?? []);
    const mentionedIdents = options.mentionedIdents ?? [];
    const mentionedFnames = options.mentionedFnames ?? [];
    const forceRefresh = options.forceRefresh ?? false;
    const excludeUnranked = options.excludeUnranked ?? false;
    const maxTokens = options.mapTokens ?? this.mapTokens;
    const compact = options.compact ?? false;
    const progress = options.progress;

    // Discover files
    const allSrcFiles = findSrcFiles(this.root);
    const fileSet = new Set([...focusFiles, ...additionalFiles, ...allSrcFiles]);
    const allFiles = Array.from(fileSet);

    if (allFiles.length === 0) return null;

    // Update file set for refresh tracking
    this.lastFileSet = new Set(allFiles.map((f) => path.relative(this.root, f)));

    // Decide ranking method
    let rankMethod: "tree-sitter" | "import-based" = "tree-sitter";
    let allTags: Tag[] = [];
    let importEdges = 0;

    if (useImportBased) {
      rankMethod = "import-based";
    } else {
      let tsOk = false;
      try {
        await initParser();
        progress?.("Initializing parser...");

        // Quick check
        for (const f of allFiles) {
          const lang = filenameToLang(f);
          if (lang) {
            try {
              await getTagsRaw(f, path.relative(this.root, f));
              tsOk = true;
              break;
            } catch {
              // Continue checking
            }
          }
        }

        if (tsOk) {
          progress?.(`Parsing ${allFiles.length} files...`);

          // Process in batches with progress
          const batchSize = 20;
          for (let i = 0; i < allFiles.length; i += batchSize) {
            const batch = allFiles.slice(i, i + batchSize);
            const batchTags = await getTagsBatch(
              batch.map((f) => ({
                fname: f,
                relFname: path.relative(this.root, f),
              })),
              this.cache,
              forceRefresh,
              batchSize,
            );
            allTags.push(...batchTags);

            if (progress && i % 100 === 0) {
              progress?.(`Parsing files: ${Math.min(i + batchSize, allFiles.length)}/${allFiles.length}`);
            }
          }
        }
      } catch (err) {
        if (autoFallback) {
          rankMethod = "import-based";
        } else {
          throw err;
        }
      }

      if (!tsOk && autoFallback) {
        rankMethod = "import-based";
      }
    }

    // Build ranked output
    let rankedTags: RankedTag[];

    if (rankMethod === "tree-sitter" && allTags.length > 0) {
      let defCount = 0;
      let refCount = 0;
      for (const tag of allTags) {
        if (tag.kind === "def") defCount++;
        else refCount++;
      }

      progress?.("Ranking files (tree-sitter + PageRank)...");
      rankedTags = this.getRankedTags(
        allTags,
        allFiles,
        focusFiles,
        priorityFiles,
        priorityIdentifiers,
        mentionedIdents,
        mentionedFnames,
      );

      if (excludeUnranked) {
        rankedTags = rankedTags.filter((rt) => rt.rank > 0);
      }

      const { map, tokenCount } = this.buildMap(
        rankedTags, focusFiles, allFiles, maxTokens, compact,
      );

      // Prepend special files
      const finalMap = this.prependSpecialFiles(map, allFiles);

      const stats: RepoMapStats = {
        totalFiles: allFiles.length,
        totalTags: allTags.length,
        definitions: defCount,
        references: refCount,
        cacheSize: this.cache.size,
        processingTimeMs: Date.now() - startTime,
        rankMethod: "tree-sitter",
        importEdges: 0,
        fallbackAttempts,
      };

      return { map: finalMap, tokenCount, rankedTags, stats };
    }

    // ── Import-based fallback path ──
    progress?.("Building import graph...");
    const allRelFiles = allFiles.map((f) => path.relative(this.root, f));
    const tsAliases = parseTsconfigPaths(this.root) ?? undefined;
    const { inDegrees, edges } = buildImportGraph(allRelFiles, this.root, tsAliases);
    importEdges = edges.length;

    rankedTags = this.getImportRankedTags(
      allRelFiles,
      focusFiles,
      priorityFiles,
      inDegrees,
    );

    if (excludeUnranked) {
      rankedTags = rankedTags.filter((rt) => rt.rank > 0);
    }

    const { map, tokenCount } = this.buildMap(
      rankedTags, focusFiles, allFiles, maxTokens, compact,
    );

    const finalMap = this.prependSpecialFiles(map, allFiles);

    const stats: RepoMapStats = {
      totalFiles: allFiles.length,
      totalTags: rankedTags.length,
      definitions: rankedTags.length,
      references: 0,
      cacheSize: this.cache.size,
      processingTimeMs: Date.now() - startTime,
      rankMethod: "import-based",
      importEdges,
      fallbackAttempts,
    };

    return { map: finalMap, tokenCount, rankedTags, stats };
  }

  /**
   * Prepends special/important config files (Dockerfile, package.json, etc.)
   * to the repo map output. Matches Aider's filter_important_files behavior.
   */
  private prependSpecialFiles(map: string, allFiles: string[]): string {
    const absRoot = this.root;
    const allRelFiles = allFiles.map((f) => path.relative(absRoot, f));
    const specialFiles = allRelFiles.filter((f) => isImportantFile(f));

    if (specialFiles.length === 0) return map;

    const lines = specialFiles.map((f) => {
      let code = "";
      try {
        code = readFileSync(path.resolve(absRoot, f), "utf-8");
        // Show just the first 3 lines
        const firstLines = code.split("\n").slice(0, 3).join("\n");
        return `${f}:\n${firstLines}`;
      } catch {
        return `${f}:\n[unreadable]`;
      }
    });

    const specialSection = lines.join("\n\n") + "\n\n";

    // Prepend to existing map, or create a basic listing
    if (map && map.length > 0) {
      return specialSection + map;
    }

    return specialSection;
  }

  /**
   * Compute a cache key from the options.
   */
  private computeCacheKey(options: Partial<RepoMapOptions>): string {
    return JSON.stringify({
      mapTokens: options.mapTokens ?? this.mapTokens,
      focusFiles: options.focusFiles ?? [],
      priorityIdentifiers: options.priorityIdentifiers ?? [],
      useImportBased: options.useImportBased ?? false,
      compact: options.compact ?? false,
      excludeUnranked: options.excludeUnranked ?? false,
    });
  }

  /**
   * Check if the file set is the same as last time (for "files" refresh mode).
   */
  private areFilesSame(options: Partial<RepoMapOptions>): boolean {
    if (!this.lastFileSet) return false;

    const focusFiles = (options.focusFiles ?? []).map((f) => path.resolve(this.root, f));
    const additionalFiles = (options.additionalFiles ?? []).map((f) => path.resolve(this.root, f));

    // Quick check: discover files and compare
    const allSrcFiles = findSrcFiles(this.root);
    const fileSet = new Set([...focusFiles, ...additionalFiles, ...allSrcFiles]);
    const relFiles = new Set(Array.from(fileSet).map((f) => path.relative(this.root, f)));

    if (relFiles.size !== this.lastFileSet.size) return false;

    for (const f of relFiles) {
      if (!this.lastFileSet.has(f)) return false;
    }

    return true;
  }

  /**
   * Build a result from cached values.
   */
  private buildCachedResult(cacheKey: string, startTime: number): RepoMapResult {
    const cached = this.mapCache.get(cacheKey);
    if (cached) return cached;

    return {
      map: this.lastMap ?? "",
      tokenCount: this.lastMapTokens,
      rankedTags: [],
      stats: {
        totalFiles: 0,
        totalTags: 0,
        definitions: 0,
        references: 0,
        cacheSize: this.cache.size,
        processingTimeMs: Date.now() - startTime,
        rankMethod: "tree-sitter",
        importEdges: 0,
        fallbackAttempts: 0,
      },
    };
  }

  /**
   * Build an empty result (error/empty state).
   */
  private buildEmptyResult(
    startTime: number,
    fallbackAttempts: number,
    rankMethod: "tree-sitter" | "import-based" = "tree-sitter",
  ): RepoMapResult {
    return {
      map: "",
      tokenCount: 0,
      rankedTags: [],
      stats: {
        totalFiles: 0,
        totalTags: 0,
        definitions: 0,
        references: 0,
        cacheSize: this.cache.size,
        processingTimeMs: Date.now() - startTime,
        rankMethod,
        importEdges: 0,
        fallbackAttempts,
      },
    };
  }

  // ── Search (tree-sitter when available, text fallback otherwise) ──

  async searchIdentifiers(
    query: string,
    options: {
      maxResults?: number;
      includeDefinitions?: boolean;
      includeReferences?: boolean;
    } = {},
    signal?: AbortSignal,
    progress?: (msg: string) => void,
  ): Promise<SearchResult[]> {
    const maxResults = options.maxResults ?? 50;
    const includeDefinitions = options.includeDefinitions ?? true;
    const includeReferences = options.includeReferences ?? true;
    const queryLower = query.toLowerCase();

    const allSrcFiles = findSrcFiles(this.root);

    if (signal?.aborted) {
      return [];
    }

    const shouldTryTreeSitter = this.searchTreeSitterAvailable !== false;
    let allTags: Tag[] = [];
    let treeSitterAttempted = false;

    if (shouldTryTreeSitter) {
      treeSitterAttempted = true;
      try {
        await initParser();
        if (signal?.aborted) {
          return [];
        }

        // Use batched concurrent processing instead of sequential per-file awaits.
        // getTagsBatch already has built-in concurrency limiting and cache awareness.
        const concurrency = 20;
        progress?.(`Parsing ${allSrcFiles.length} files (concurrency=${concurrency})...`);

        const fileEntries = allSrcFiles.map((fname) => ({
          fname,
          relFname: path.relative(this.root, fname),
        }));

        allTags = await getTagsBatch(
          fileEntries,
          this.cache,
          false, // forceRefresh
          concurrency,
          signal,
        );

        if (signal?.aborted) {
          return [];
        }

        if (allSrcFiles.length > 0 && allTags.length === 0) {
          this.searchTreeSitterAvailable = false;
        } else {
          this.searchTreeSitterAvailable = true;
        }
      } catch {
        this.searchTreeSitterAvailable = false;
        allTags = [];
      }
    }

    // Determine if we should fall back to text search
    // Fall back when:
    //   - Tree-sitter is unavailable OR
    //   - Tree-sitter produced zero tags OR
    //   - Tree-sitter produced tags but none matched the query
    let useTextFallback = this.searchTreeSitterAvailable === false || allTags.length === 0;

    if (!useTextFallback && treeSitterAttempted) {
      // Tree-sitter succeeded — check if any tags match the query
      const anyMatch = allTags.some((tag) => {
        if (!tag.name.toLowerCase().includes(queryLower)) return false;
        if (tag.kind === "def" && !includeDefinitions) return false;
        if (tag.kind === "ref" && !includeReferences) return false;
        return true;
      });

      if (!anyMatch) {
        // Tree-sitter found plenty of symbols, but none match the user's query.
        // Fall back to text search which may find inline references or other patterns
        // that the .scm query files didn't capture.
        useTextFallback = true;
      }
    }

    if (useTextFallback) {
      progress?.(`Searching ${allSrcFiles.length} files with text fallback...`);
      return searchIdentifiersByText(
        this.root,
        allSrcFiles,
        query,
        {
          maxResults,
          includeDefinitions,
          includeReferences,
        },
        signal,
      );
    }

    progress?.(`Filtering ${allTags.length} tags...`);

    const matched = allTags.filter((tag) => {
      if (!tag.name.toLowerCase().includes(queryLower)) return false;
      if (tag.kind === "def" && !includeDefinitions) return false;
      if (tag.kind === "ref" && !includeReferences) return false;
      return true;
    });

    matched.sort((a, b) => {
      if (a.kind === "def" && b.kind !== "def") return -1;
      if (a.kind !== "def" && b.kind === "def") return 1;
      return a.name.localeCompare(b.name);
    });

    progress?.(`Rendering context for ${Math.min(matched.length, maxResults)} matches...`);

    const results: SearchResult[] = [];
    for (const tag of matched.slice(0, maxResults)) {
      if (signal?.aborted) return [];

      let context = "";
      try {
        const code = readFileSync(tag.fname, "utf-8");
        context = renderTreeContext(code, [tag.line], {
          lineNumbers: true,
          loiPad: 2,
        }, tag.fname);
      } catch {
        // omit context — file may have been deleted since parse
      }
      results.push({
        file: tag.relFname,
        line: tag.line,
        name: tag.name,
        kind: tag.kind,
        context,
      });
    }

    return sortSearchResults(results);
  }

  // ── Ranking: tree-sitter + PageRank ─────────────────────────────

  /**
   * Rank tags using PageRank with personalization and sophisticated edge weighting.
   *
   * Aider-compat features:
   *   - buildWeightedEdges: identifier-aware weighting (snake/camel/kebab/_
   *     prefix/generic names)
   *   - mentioned_idents → file path matching for personalization
   *   - Self-edges for defined-but-unreferenced identifiers
   *   - sqrt(num_refs) sub-linear scaling
   *   - Chat file boost (50x)
   */
  private getRankedTags(
    allTags: Tag[],
    allFiles: string[],
    focusFiles: string[],
    priorityFiles: Set<string>,
    priorityIdentifiers: Set<string>,
    mentionedIdents: string[],
    mentionedFnames: string[],
  ): RankedTag[] {
    // Build definition and reference maps
    const defines = new Map<string, Set<string>>();
    const references = new Map<string, string[]>();

    for (const tag of allTags) {
      if (tag.kind === "def") {
        let set = defines.get(tag.name);
        if (!set) { set = new Set(); defines.set(tag.name, set); }
        set.add(tag.relFname);
      } else if (tag.kind === "ref") {
        let list = references.get(tag.name);
        if (!list) { list = []; references.set(tag.name, list); }
        list.push(tag.relFname);
      }
    }

    const nodes = new Set(allFiles.map((f) => path.relative(this.root, f)));
    const focusRelFiles = new Set(focusFiles.map((f) => path.relative(this.root, f)));
    const mentionedIdentsSet = new Set(mentionedIdents);

    // Build personalization vector
    const personalization = new Map<string, number>();
    const personalize = 100 / Math.max(1, nodes.size);

    // ── Personalization: focus files ──
    for (const relFname of focusRelFiles) {
      personalization.set(relFname, (personalization.get(relFname) ?? 0) + personalize);
    }

    // ── Personalization: mentioned_fnames path matching ──
    for (const mentionedFname of mentionedFnames) {
      const relPath = path.relative(this.root, path.resolve(this.root, mentionedFname));
      if (nodes.has(relPath)) {
        personalization.set(relPath, (personalization.get(relPath) ?? 0) + personalize);
      }
    }

    // ── Personalization: mentioned_idents → file path matching ──
    // Aider: checks if ANY component of the file path (dirname, basename,
    // basename minus extension) matches a mentioned ident.
    for (const relFname of nodes) {
      const pathObj = relFname.split("/");
      const basename = pathObj[pathObj.length - 1] ?? "";
      const extIdx = basename.lastIndexOf(".");
      const basenameWithoutExt = extIdx >= 0 ? basename.slice(0, extIdx) : basename;
      const allComponents = new Set([...pathObj, basename, basenameWithoutExt]);

      for (const ident of mentionedIdents) {
        if (allComponents.has(ident)) {
          const current = personalization.get(relFname) ?? 0;
          personalization.set(relFname, current + personalize);
          break;
        }
      }
    }

    // Also personalize toward files connected to focus files
    if (focusRelFiles.size > 0) {
      for (const [name, refFnames] of references) {
        const defFnames = defines.get(name);
        if (!defFnames) continue;

        for (const refFname of refFnames) {
          if (focusRelFiles.has(refFname)) {
            // Files that reference things focus files reference
            for (const defFname of defFnames) {
              if (!focusRelFiles.has(defFname)) {
                personalization.set(defFname, (personalization.get(defFname) ?? 0) + personalize * 0.1);
              }
            }
          }
        }
      }
    }

    // ── Build weighted edges ──
    const edges = buildWeightedEdges(defines, references, {
      mentionedIdents: mentionedIdentsSet.size > 0 ? mentionedIdentsSet : undefined,
      chatRelFiles: focusRelFiles.size > 0 ? focusRelFiles : undefined,
    });

    // ── Run PageRank ──
    const ranks = pagerank(
      nodes,
      edges,
      personalization.size > 0 ? personalization : undefined,
    );

    // ── Score each definition tag ──
    const priorityRelFiles = new Set(
      Array.from(priorityFiles).map((f) => path.relative(this.root, f)),
    );

    const rankedTags: RankedTag[] = [];
    for (const tag of allTags) {
      if (tag.kind !== "def") continue;

      const fileRank = ranks.get(tag.relFname) ?? 0;
      let boost = 1.0;
      if (focusRelFiles.has(tag.relFname)) boost *= 20.0;
      if (priorityIdentifiers.has(tag.name)) boost *= 10.0;
      if (priorityRelFiles.has(tag.relFname)) boost *= 5.0;

      rankedTags.push({ rank: fileRank * boost, tag });
    }

    rankedTags.sort((a, b) => b.rank - a.rank);
    return rankedTags;
  }

  // ── Ranking: import-based in-degree ─────────────────────────────

  private getImportRankedTags(
    allFiles: string[],
    focusFiles: string[],
    priorityFiles: Set<string>,
    inDegrees: Map<string, number>,
  ): RankedTag[] {
    const focusRelFiles = new Set(focusFiles.map((f) => path.relative(this.root, f)));
    const priorityRelFiles = new Set(
      Array.from(priorityFiles).map((f) => path.relative(this.root, f)),
    );

    const maxDegree = Math.max(1, ...inDegrees.values());

    const rankedTags: RankedTag[] = [];
    for (const relFname of allFiles) {
      const absFname = path.resolve(this.root, relFname);
      const inDegree = inDegrees.get(relFname) ?? 0;
      let rank = inDegree / maxDegree;
      if (focusRelFiles.has(relFname)) rank += 2.0;
      if (priorityRelFiles.has(relFname)) rank += 1.0;

      const syntheticTag: Tag = {
        relFname,
        fname: absFname,
        line: 1,
        name: path.basename(relFname, path.extname(relFname)),
        kind: "def",
      };

      rankedTags.push({ rank, tag: syntheticTag });
    }

    rankedTags.sort((a, b) => b.rank - a.rank);
    return rankedTags;
  }

  // ── Token-budgeted map rendering ────────────────────────────────

  private buildMap(
    rankedTags: RankedTag[],
    focusFiles: string[],
    allFiles: string[],
    maxTokens: number,
    compact: boolean,
  ): { map: string; tokenCount: number } {
    const focusRelFiles = new Set(focusFiles.map((f) => path.relative(this.root, f)));

    let left = 0;
    let right = rankedTags.length;
    let bestOutput = "";
    let bestTokens = 0;

    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      const subset = rankedTags.slice(0, mid);
      const output = this.renderTags(subset, focusRelFiles, compact);
      const tokens = countTokens(output);

      if (tokens <= maxTokens) {
        bestOutput = output;
        bestTokens = tokens;
        left = mid + 1;
      } else {
        right = mid - 1;
      }
    }

    return { map: bestOutput, tokenCount: bestTokens };
  }

  private renderTags(
    tags: RankedTag[],
    focusRelFiles: Set<string>,
    compact: boolean,
  ): string {
    const byFile = new Map<string, RankedTag[]>();
    for (const rt of tags) {
      const existing = byFile.get(rt.tag.relFname) ?? [];
      existing.push(rt);
      byFile.set(rt.tag.relFname, existing);
    }

    const sortedFiles = Array.from(byFile.entries()).sort((a, b) => {
      const maxA = Math.max(...a[1].map((rt) => rt.rank));
      const maxB = Math.max(...b[1].map((rt) => rt.rank));
      return maxB - maxA;
    });

    if (compact) {
      return this.renderTagsCompact(sortedFiles, focusRelFiles);
    }

    const parts: string[] = [];
    for (const [relFname, fileTags] of sortedFiles) {
      if (focusRelFiles.has(relFname)) continue;

      const lois = fileTags.map((rt) => rt.tag.line);

      let code: string;
      try {
        code = readFileSync(path.resolve(this.root, relFname), "utf-8");
      } catch {
        continue;
      }

      const rendered = renderTreeContext(code, lois, {
        maxLineWidth: 100,
      }, path.resolve(this.root, relFname));
      if (!rendered) continue;

      parts.push(`${relFname}:\n${rendered}`);
    }

    return parts.join("\n\n");
  }

  private renderTagsCompact(
    sortedFiles: [string, RankedTag[]][],
    focusRelFiles: Set<string>,
  ): string {
    const parts: string[] = [];
    for (const [relFname, fileTags] of sortedFiles) {
      if (focusRelFiles.has(relFname)) continue;

      const symbols = [...new Set(fileTags.map((rt) => rt.tag.name))];
      const refCount = fileTags.length;
      const symbolList = symbols.slice(0, 8).join(", ");
      const overflow = symbols.length > 8 ? ` (+${symbols.length - 8} more)` : "";

      parts.push(`${relFname} (refs: ${refCount}) — ${symbolList}${overflow}`);
    }
    return parts.join("\n");
  }
}
