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
 * The fallback activates when:
 *   - `useImportBased: true` is explicitly set
 *   - `autoFallback: true` (default) and tree-sitter WASM fails / unsupported lang
 */
import path from "node:path";
import { readFileSync } from "node:fs";
import type { Tag } from "./cache.js";
import { TagsCache } from "./cache.js";
import { findSrcFiles } from "./file-discovery.js";
import { getTags, getTagsBatch, initParser, getTagsRaw } from "./tags.js";
import { pagerank, type GraphEdge } from "./pagerank.js";
import { renderTreeContext } from "./tree-context.js";
import { filenameToLang, isSupportedFile } from "./languages.js";

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
   * Import-based is faster but less precise — uses in-degree counting
   * from import/require statements rather than symbol-level cross-referencing.
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
   * Compact is better for LLM consumption where token budget is tight.
   */
  compact: boolean;
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

/** Directed edge between files (from → to = "from imports to") */
export interface ImportEdge {
  from: string;
  to: string;
}

const DEFAULT_MAP_TOKENS = 4096;

/** Rough estimate: 1 token ≈ 4 characters for code */
const CHARS_PER_TOKEN = 4;

/** Supported import-extraction languages */
type ImportExtractLang = "javascript" | "typescript" | "tsx" | "python";

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
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
        // Normalize "@/*" → prefix "@", target "./src"
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
            break; // Use first valid target per alias
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

/**
 * Resolve an import path using tsconfig path aliases.
 * E.g. with alias @ → ./src, resolves "@/utils/helper" → "<root>/src/utils/helper"
 */
function resolveViaAlias(
  importPath: string,
  absRoot: string,
  aliases: TsAliasMap,
): string | null {
  for (const [prefix, targetDir] of aliases.prefixes) {
    if (!importPath.startsWith(prefix)) continue;

    // Strip the prefix from the import path
    // e.g. "@/utils/helper" with prefix "@" → "/utils/helper"
    const suffix = importPath.slice(prefix.length);
    if (!suffix.startsWith("/")) continue;

    return path.resolve(absRoot, targetDir + suffix);
  }

  return null;
}

/** Resolve an import path to a concrete file path within the repo root. */
function resolveImportPath(
  importPath: string,
  fromRelDir: string,
  absRoot: string,
  knownFiles: Set<string>,
  aliases?: TsAliasMap,
): string | null {
  // Try resolution paths; collect candidates
  const searchPaths: string[] = [];

  if (aliases && !importPath.startsWith(".") && !importPath.startsWith("/")) {
    // Try alias resolution first (e.g. @/utils → ./src/utils)
    const aliasResolved = resolveViaAlias(importPath, absRoot, aliases);
    if (aliasResolved) {
      searchPaths.push(aliasResolved);
    }
  }

  if (importPath.startsWith("/")) {
    // Absolute within repo
    searchPaths.push(path.resolve(absRoot, "." + importPath));
  } else if (importPath.startsWith(".")) {
    // Relative path
    searchPaths.push(path.resolve(fromRelDir, importPath));
  } else {
    // Bare name — could be a Python sibling module or other
    // Try resolving relative to the source file's directory
    searchPaths.push(path.resolve(fromRelDir, importPath));
  }

  // Extension list to try
  const extensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py"];

  for (const absPath of searchPaths) {
    const rel = path.relative(absRoot, absPath);

    // Direct match
    if (knownFiles.has(rel)) return rel;

    // Try extension appends
    for (const ext of extensions) {
      const candidate = rel + ext;
      if (knownFiles.has(candidate)) return candidate;
    }

    // Try /index.{ts,js,py} etc
    for (const ext of extensions) {
      const candidate = path.join(rel, `index${ext}`);
      if (knownFiles.has(candidate)) return candidate;
    }
  }

  return null;
}

/**
 * Extract import paths from source code using regex.
 * Supports JS/TS (ESM + CJS) and Python.
 */
function extractImports(
  fname: string,
  code: string,
): string[] {
  const lang = filenameToLang(fname);
  if (!lang) return [];

  const imports: string[] = [];
  const seen = new Set<string>();

  if (lang === "javascript" || lang === "typescript" || lang === "tsx") {
    // ESM imports
    for (const match of code.matchAll(IMPORT_ESM)) {
      const p = match[1];
      if (p && !seen.has(p)) {
        seen.add(p);
        imports.push(p);
      }
    }
    // CJS require / dynamic import()
    for (const match of code.matchAll(IMPORT_CJS)) {
      const p = match[1];
      if (p && !seen.has(p)) {
        seen.add(p);
        imports.push(p);
      }
    }
    // TypeScript triple-slash directives
    const tsRef = /\/\/\/\s*<reference\s+path\s*=\s*['"]([^'"]+)['"]/g;
    for (const match of code.matchAll(tsRef)) {
      const p = match[1];
      if (p && !seen.has(p)) {
        seen.add(p);
        imports.push(p);
      }
    }
  } else if (lang === "python") {
    // from x import y
    const fromRe = /^from\s+([a-zA-Z_][a-zA-Z0-9_.]*)\s+import/mg;
    for (const match of code.matchAll(fromRe)) {
      const p = match[1].replace(/\./g, "/");
      if (p && p !== "__future__" && !seen.has(p)) {
        seen.add(p);
        imports.push(p);
      }
    }
    // import x
    const importRe = /^import\s+([a-zA-Z_][a-zA-Z0-9_]*)(?:\s*,\s*[a-zA-Z_][a-zA-Z0-9_]*)*/mg;
    for (const match of code.matchAll(importRe)) {
      const parts = match[0].split(/\s*,\s*/);
      for (const part of parts) {
        const p = part.replace(/^import\s+/, "").replace(/\./g, "/");
        if (p && !p.startsWith("__") && !seen.has(p)) {
          seen.add(p);
          imports.push(p);
        }
      }
    }
  }

  return imports;
}

/**
 * Build the import graph for all files.
 * Returns a Map of relFname → in-degree count.
 */
function buildImportGraph(
  allFiles: string[],
  root: string,
  aliases?: TsAliasMap,
): { inDegrees: Map<string, number>; edges: ImportEdge[] } {
  const knownRelFiles = new Set(allFiles);
  const inDegrees = new Map<string, number>();
  const edges: ImportEdge[] = [];

  for (const relFname of allFiles) {
    const absFname = path.resolve(root, relFname);
    let code: string;
    try {
      code = readFileSync(absFname, "utf-8");
    } catch {
      continue;
    }

    const importPaths = extractImports(absFname, code);
    const resolvedPaths: string[] = [];

    for (const imp of importPaths) {
      const resolved = resolveImportPath(imp, path.dirname(absFname), root, knownRelFiles, aliases);
      if (resolved && resolved !== relFname) {
        resolvedPaths.push(resolved);
      }
    }

    for (const target of resolvedPaths) {
      edges.push({ from: relFname, to: target });
      inDegrees.set(target, (inDegrees.get(target) ?? 0) + 1);
    }
  }

  // Ensure all files are in the map (even zero-in-degree files)
  for (const relFname of allFiles) {
    if (!inDegrees.has(relFname)) {
      inDegrees.set(relFname, 0);
    }
  }

  return { inDegrees, edges };
}

// ── RepoMap orchestrator ──────────────────────────────────────────

export class RepoMap {
  private root: string;
  private mapTokens: number;
  private verbose: boolean;
  private cache: TagsCache;

  constructor(root: string, options: Partial<RepoMapOptions> = {}) {
    this.root = path.resolve(root);
    this.mapTokens = options.mapTokens ?? DEFAULT_MAP_TOKENS;
    this.verbose = options.verbose ?? false;
    this.cache = new TagsCache(this.root);
  }

  /**
   * Generate a token-budgeted repo map.
   *
   * Default mode: tree-sitter AST parsing → symbol extraction → PageRank.
   * Fallback mode: import statement scanning → in-degree counting.
   */
  async getRepoMap(
    options: Partial<RepoMapOptions> = {},
  ): Promise<RepoMapResult> {
    const startTime = Date.now();
    const useImportBased = options.useImportBased ?? false;
    const autoFallback = options.autoFallback ?? true;

    const focusFiles = (options.focusFiles ?? []).map((f) =>
      path.resolve(this.root, f),
    );
    const additionalFiles = (options.additionalFiles ?? []).map((f) =>
      path.resolve(this.root, f),
    );
    const priorityFiles = new Set(
      (options.priorityFiles ?? []).map((f) => path.resolve(this.root, f)),
    );
    const priorityIdentifiers = new Set(options.priorityIdentifiers ?? []);
    const forceRefresh = options.forceRefresh ?? false;
    const excludeUnranked = options.excludeUnranked ?? false;
    const maxTokens = options.mapTokens ?? this.mapTokens;

    // Discover files
    const allSrcFiles = findSrcFiles(this.root);
    const fileSet = new Set([
      ...focusFiles,
      ...additionalFiles,
      ...allSrcFiles,
    ]);
    const allFiles = Array.from(fileSet);

    // Decide which ranking method to use
    let rankMethod: "tree-sitter" | "import-based" = "tree-sitter";
    let allTags: Tag[] = [];
    let importEdges = 0;

    if (useImportBased) {
      rankMethod = "import-based";
    } else {
      // Try tree-sitter
      let tsOk = false;
      try {
        await initParser();
        // Quick check: can we parse at least one file?
        for (const f of allFiles) {
          const lang = filenameToLang(f);
          if (lang) {
            try {
              await getTagsRaw(f, path.relative(this.root, f));
              tsOk = true;
              break;
            } catch {
              // WASM not available for this language, continue checking
            }
          }
        }

        if (tsOk) {
          allTags = await getTagsBatch(
            allFiles.map((f) => ({
              fname: f,
              relFname: path.relative(this.root, f),
            })),
            this.cache,
            forceRefresh,
          );
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
    let stats: RepoMapStats;

    if (rankMethod === "tree-sitter" && allTags.length > 0) {
      // ── Tree-sitter + PageRank path ──
      let defCount = 0;
      let refCount = 0;
      for (const tag of allTags) {
        if (tag.kind === "def") defCount++;
        else refCount++;
      }

      rankedTags = this.getRankedTags(
        allTags,
        allFiles,
        focusFiles,
        priorityFiles,
        priorityIdentifiers,
      );

      if (excludeUnranked) {
        rankedTags = rankedTags.filter((rt) => rt.rank > 0);
      }

      const { map, tokenCount } = this.buildMap(rankedTags, focusFiles, maxTokens, options.compact ?? false);

      stats = {
        totalFiles: allFiles.length,
        totalTags: allTags.length,
        definitions: defCount,
        references: refCount,
        cacheSize: this.cache.size,
        processingTimeMs: Date.now() - startTime,
        rankMethod: "tree-sitter",
        importEdges: 0,
      };

      return { map, tokenCount, rankedTags, stats };
    }

    // ── Import-based fallback path ──
    // allFiles contains absolute paths; convert to relative for graph building
    const allRelFiles = allFiles.map((f) => path.relative(this.root, f));
    const tsAliases = parseTsconfigPaths(this.root) ?? undefined;
    const { inDegrees, edges } = buildImportGraph(allRelFiles, this.root, tsAliases);
    importEdges = edges.length;

    // Build ranked tags: each file gets a synthetic "def" tag at line 1
    rankedTags = this.getImportRankedTags(
      allRelFiles,
      focusFiles,
      priorityFiles,
      inDegrees,
    );

    if (excludeUnranked) {
      rankedTags = rankedTags.filter((rt) => rt.rank > 0);
    }

    const { map, tokenCount } = this.buildMap(rankedTags, focusFiles, maxTokens, options.compact ?? false);

    stats = {
      totalFiles: allFiles.length,
      totalTags: rankedTags.length,
      definitions: rankedTags.length,
      references: 0,
      cacheSize: this.cache.size,
      processingTimeMs: Date.now() - startTime,
      rankMethod: "import-based",
      importEdges,
    };

    return { map, tokenCount, rankedTags, stats };
  }

  // ── Search (always uses tree-sitter) ────────────────────────────

  /**
   * Search for identifiers by name across all source files.
   * Returns matching tags with surrounding context.
   */
  async searchIdentifiers(
    query: string,
    options: {
      maxResults?: number;
      includeDefinitions?: boolean;
      includeReferences?: boolean;
    } = {},
  ): Promise<SearchResult[]> {
    await initParser();

    const maxResults = options.maxResults ?? 50;
    const includeDefinitions = options.includeDefinitions ?? true;
    const includeReferences = options.includeReferences ?? true;
    const queryLower = query.toLowerCase();

    const allSrcFiles = findSrcFiles(this.root);
    const allTags: Tag[] = [];

    for (const fname of allSrcFiles) {
      const relFname = path.relative(this.root, fname);
      const tags = await getTags(fname, relFname, this.cache, false);
      allTags.push(...tags);
    }

    const matched = allTags.filter((tag) => {
      if (!tag.name.toLowerCase().includes(queryLower)) return false;
      if (tag.kind === "def" && !includeDefinitions) return false;
      if (tag.kind === "ref" && !includeReferences) return false;
      return true;
    });

    // Sort: definitions first, then by name
    matched.sort((a, b) => {
      if (a.kind === "def" && b.kind !== "def") return -1;
      if (a.kind !== "def" && b.kind === "def") return 1;
      return a.name.localeCompare(b.name);
    });

    const results: SearchResult[] = [];
    for (const tag of matched.slice(0, maxResults)) {
      let context = "";
      try {
        const code = readFileSync(tag.fname, "utf-8");
        context = renderTreeContext(code, [tag.line]);
      } catch {
        // Can't read file — omit context
      }
      results.push({
        file: tag.relFname,
        line: tag.line,
        name: tag.name,
        kind: tag.kind,
        context,
      });
    }

    return results;
  }

  // ── Ranking: tree-sitter + PageRank ─────────────────────────────

  /**
   * Rank tags using PageRank with personalization.
   *
   * Builds a graph where:
   * - Nodes = files
   * - Edges = referencing_file → defining_file (for identifiers shared across files)
   * - PageRank with personalization boosts focus files and mentioned identifiers
   */
  private getRankedTags(
    allTags: Tag[],
    allFiles: string[],
    focusFiles: string[],
    priorityFiles: Set<string>,
    priorityIdentifiers: Set<string>,
  ): RankedTag[] {
    // Build definition and reference maps
    const defines = new Map<string, Set<string>>();
    const references = new Map<string, Set<string>>();

    for (const tag of allTags) {
      const map = tag.kind === "def" ? defines : references;
      let set = map.get(tag.name);
      if (!set) {
        set = new Set();
        map.set(tag.name, set);
      }
      set.add(tag.relFname);
    }

    // Build graph edges: from referencing files to defining files
    const nodes = new Set(allFiles.map((f) => path.relative(this.root, f)));
    const edges: GraphEdge[] = [];

    for (const [name, refFnames] of references) {
      const defFnames = defines.get(name);
      if (!defFnames) continue;

      for (const refFname of refFnames) {
        for (const defFname of defFnames) {
          if (refFname !== defFname) {
            edges.push({ from: refFname, to: defFname });
          }
        }
      }
    }

    // Build personalization vector
    const personalization = new Map<string, number>();
    const focusRelFiles = new Set(
      focusFiles.map((f) => path.relative(this.root, f)),
    );

    // Personalize toward focus files
    for (const relFname of focusRelFiles) {
      personalization.set(relFname, 100.0);
    }

    // Also personalize toward files connected to focus files
    if (focusRelFiles.size > 0) {
      for (const edge of edges) {
        if (focusRelFiles.has(edge.to) && !focusRelFiles.has(edge.from)) {
          personalization.set(
            edge.from,
            (personalization.get(edge.from) ?? 0) + 10.0,
          );
        }
        if (focusRelFiles.has(edge.from) && !focusRelFiles.has(edge.to)) {
          personalization.set(
            edge.to,
            (personalization.get(edge.to) ?? 0) + 10.0,
          );
        }
      }
    }

    const ranks = pagerank(
      nodes,
      edges,
      personalization.size > 0 ? personalization : undefined,
    );

    const priorityRelFiles = new Set(
      Array.from(priorityFiles).map((f) => path.relative(this.root, f)),
    );

    // Score each definition tag
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

  /**
   * Rank files by import in-degree (how many files import each file).
   * Each file gets a synthetic Tag so the rendering pipeline works uniformly.
   */
  private getImportRankedTags(
    allFiles: string[],
    focusFiles: string[],
    priorityFiles: Set<string>,
    inDegrees: Map<string, number>,
  ): RankedTag[] {
    const focusRelFiles = new Set(
      focusFiles.map((f) => path.relative(this.root, f)),
    );
    const priorityRelFiles = new Set(
      Array.from(priorityFiles).map((f) => path.relative(this.root, f)),
    );

    const maxDegree = Math.max(1, ...inDegrees.values());

    const rankedTags: RankedTag[] = [];
    for (const relFname of allFiles) {
      const absFname = path.resolve(this.root, relFname);
      const inDegree = inDegrees.get(relFname) ?? 0;

      // Base rank: normalized in-degree (0-1)
      let rank = inDegree / maxDegree;

      // Focus files always rank above non-focus files (+2 shift)
      if (focusRelFiles.has(relFname)) rank += 2.0;

      // Priority files get a smaller bump
      if (priorityRelFiles.has(relFname)) rank += 1.0;

      // Create a synthetic "file" tag so the rendering pipeline works
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

  /**
   * Build the map output within token budget using binary search.
   *
   * Binary searches for the optimal number of top-ranked tags
   * that fit within the token budget.
   */
  private buildMap(
    rankedTags: RankedTag[],
    focusFiles: string[],
    maxTokens: number,
    compact: boolean,
  ): { map: string; tokenCount: number } {
    const focusRelFiles = new Set(
      focusFiles.map((f) => path.relative(this.root, f)),
    );

    let left = 0;
    let right = rankedTags.length;
    let bestOutput = "";
    let bestTokens = 0;

    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      const subset = rankedTags.slice(0, mid);
      const output = this.renderTags(subset, focusRelFiles, compact);
      const tokens = estimateTokens(output);

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

  /**
   * Render ranked tags into a structured text map.
   *
   * Groups tags by file, sorts files by max rank (descending),
   * and renders each file's symbol definitions with context.
   */
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

      const rendered = renderTreeContext(code, lois);
      if (!rendered) continue;

      parts.push(`${relFname}:\n${rendered}`);
    }

    return parts.join("\n\n");
  }

  /**
   * Compact output — single-line file summaries for agent consumption.
   * Format: file.ts (refs: N) — symbol1, symbol2, symbol3
   */
  private renderTagsCompact(
    sortedFiles: [string, RankedTag[]][],
    focusRelFiles: Set<string>,
  ): string {
    const parts: string[] = [];
    for (const [relFname, fileTags] of sortedFiles) {
      if (focusRelFiles.has(relFname)) continue;

      // Count unique symbol names (deduplicate by name)
      const symbols = [...new Set(fileTags.map((rt) => rt.tag.name))];
      const refCount = fileTags.length;

      // Show max 8 symbols to keep lines short
      const symbolList = symbols.slice(0, 8).join(", ");
      const overflow = symbols.length > 8 ? ` (+${symbols.length - 8} more)` : "";

      parts.push(`${relFname} (refs: ${refCount}) — ${symbolList}${overflow}`);
    }
    return parts.join("\n");
  }
}
