/**
 * RepoMap pipeline orchestrator.
 *
 * Responsibilities:
 * - RepoMapOptions, RepoMapResult, RepoMapStats, RankedTag, SearchResult interfaces
 * - RepoMap class (constructor, getRepoMap, generateMap, cache management)
 * - File discovery and tag extraction orchestration
 * - LSP symbol augmentation
 * - Triple fallback chain (full → no-focus → unhinted)
 * - Error recovery (RecursionError, parse failures, file-not-found)
 * - searchIdentifiers with tree-sitter → text fallback chain
 */

import path from "node:path";
import { promises as fs } from "node:fs";
import type { Tag } from "./cache.js";
import { TagsCache } from "./cache.js";
import { findSrcFiles } from "./file-discovery.js";
import { getTagsBatch, initParser, getTagsRaw } from "./tags.js";
import { filenameToLang } from "./languages.js";
import { getLSPBridge } from "./lsp-bridge.js";
import type { LSPDocumentSymbol } from "./lsp-bridge.js";
import { renderTreeContext } from "./tree-context.js";
import {
  getRankedTags,
  getImportRankedTags,
  buildImportGraph,
  parseTsconfigPaths,
} from "./repomap-ranking.js";
import {
  buildMap,
  prependSpecialFiles,
} from "./repomap-render.js";

// ── Type definitions 

export interface RepoMapOptions {
  mapTokens: number;
  focusFiles: string[];
  additionalFiles: string[];
  priorityFiles: string[];
  priorityIdentifiers: string[];
  forceRefresh: boolean;
  excludeUnranked: boolean;
  verbose: boolean;
  useImportBased: boolean;
  autoFallback: boolean;
  compact: boolean;
  refresh: "auto" | "manual" | "files" | "always";
  progress?: (msg: string) => void;
  mentionedIdents?: string[];
  mentionedFnames?: string[];
}

export interface RepoMapResult {
  map: string;
  tokenCount: number;
  rankedTags: RankedTag[];
  stats: RepoMapStats;
}

export interface RepoMapStats {
  totalFiles: number;
  totalTags: number;
  definitions: number;
  references: number;
  cacheSize: number;
  processingTimeMs: number;
  rankMethod: "tree-sitter" | "import-based";
  importEdges: number;
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
  confidence?: "extracted" | "inferred" | "ambiguous";
}

// Re-export countTokens for external consumers (repomap-tool.ts uses it via the result)
export { countTokens } from "./repomap-render.js";

// ── Constants ────────────────────────────────────────────────────

const DEFAULT_MAP_TOKENS = 4096;

// ── Fallback pattern helpers ──────────────────────────────────────

export const FALLBACK_DEFINITION_PATTERNS: RegExp[] = [
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

export function getFallbackMatch(
  line: string,
  queryLower: string,
): { kind: "def" | "ref"; name: string } | null {
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
    const name = match[1]!;
    if (name.toLowerCase().includes(queryLower)) {
      return { kind: "ref", name };
    }
  }

  return null;
}

export function sortSearchResults(results: SearchResult[]): SearchResult[] {
  return [...results].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "def" ? -1 : 1;
    const fileCompare = a.file.localeCompare(b.file);
    if (fileCompare !== 0) return fileCompare;
    return a.line - b.line;
  });
}

// ── LSP symbol helpers ───────────────────────────────────────────

/**
 * Flatten an LSP document symbol tree into Tag entries.
 * Recursively walks children to capture nested symbols (methods, etc.).
 */
export function flattenLSPDocumentSymbols(
  symbols: LSPDocumentSymbol[],
  relFname: string,
  fname: string,
): Tag[] {
  const tags: Tag[] = [];
  function walk(list: LSPDocumentSymbol[]) {
    for (const sym of list) {
      tags.push({
        relFname,
        fname,
        line: sym.range.start.line + 1,
        name: sym.name,
        kind: "def" as const,
        confidence: "extracted" as const,
      });
      if (sym.children) walk(sym.children);
    }
  }
  walk(symbols);
  return tags;
}

/**
 * Augment sparse tree-sitter tags with LSP document symbols.
 * Only queries LSP for files with < 5 tree-sitter tags.
 */
async function augmentWithLspSymbols(
  allTags: Tag[],
  allFiles: string[],
  root: string,
  verbose: boolean,
): Promise<void> {
  try {
    const lspBridge = await getLSPBridge();
    if (!lspBridge) return;

    const tagsByFile = new Map<string, Tag[]>();
    for (const tag of allTags) {
      const arr = tagsByFile.get(tag.relFname) ?? [];
      arr.push(tag);
      tagsByFile.set(tag.relFname, arr);
    }

    for (const absFile of allFiles) {
      const relFname = path.relative(root, absFile);
      const fileTags = tagsByFile.get(relFname) ?? [];
      if (fileTags.length >= 5) continue;

      const lang = filenameToLang(absFile);
      if (!lang) continue;

      try {
        const symbols = await lspBridge.getDocumentSymbols(absFile, root);
        if (!symbols || symbols.length === 0) continue;

        const lspTags = flattenLSPDocumentSymbols(symbols, relFname, absFile);
        allTags.push(...lspTags);

        if (verbose) {
          console.error(
            `[RepoMap] LSP fallback: ${relFname} — tree-sitter: ${fileTags.length}, LSP: ${lspTags.length}`,
          );
        }
      } catch {
        // Best-effort per file
      }
    }
  } catch {
    // Best-effort — LSP bridge not available
  }
}

// ── Text-based identifier search ─────────────────────────────────

async function searchIdentifiersByText(
  root: string,
  files: string[],
  query: string,
  options: {
    maxResults: number;
    includeDefinitions: boolean;
    includeReferences: boolean;
  },
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  const queryLower = query.toLowerCase();
  const results: SearchResult[] = [];

  for (const fname of files) {
    if (signal?.aborted) return [];

    let code: string;
    try {
      code = await fs.readFile(fname, "utf-8");
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
      const context = await renderTreeContext(
        code,
        [lineNumber],
        {
          lineNumbers: true,
          loiPad: 2,
        },
        fname,
      );

      results.push({
        file: path.relative(root, fname),
        line: lineNumber,
        name: match.name,
        kind: match.kind,
        context,
        confidence: "inferred",
      });
    }
  }

  const sorted = sortSearchResults(results);
  return sorted.slice(0, options.maxResults);
}

// ── RepoMap orchestrator ─────────────────────────────────────────

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
  async getRepoMap(options: Partial<RepoMapOptions> = {}): Promise<RepoMapResult> {
    const startTime = Date.now();
    await this.cache.init();
    const refresh = options.refresh ?? "auto";
    const forceRefresh = options.forceRefresh ?? false;

    // ── Cache check ──
    const cacheKey = this.computeCacheKey(options);
    if (!forceRefresh) {
      if (refresh === "manual" && this.lastMap !== null) {
        return this.buildCachedResult(cacheKey, startTime);
      }

      if (refresh === "files") {
        const filesSame = await this.areFilesSame(options);
        if (filesSame && this.mapCache.has(cacheKey)) {
          return this.mapCache.get(cacheKey)!;
        }
      }

      if (refresh === "auto" && this.mapProcessingTime > 1000) {
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
      result = await this.generateMap(options, startTime, fallbackAttempts);

      if (!result || !result.map) {
        fallbackAttempts++;
        const noFocusOptions = { ...options, focusFiles: [] };
        result = await this.generateMap(noFocusOptions, startTime, fallbackAttempts);
      }

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
      if (this.verbose) {
        console.error(`[RepoMap] Generation failed: ${(err as Error).message}`);
      }
      result = this.buildEmptyResult(
        startTime,
        fallbackAttempts,
        options.useImportBased ? "import-based" : "tree-sitter",
      );
    }

    if (!result) {
      result = this.buildEmptyResult(
        startTime,
        fallbackAttempts,
        options.useImportBased ? "import-based" : "tree-sitter",
      );
    }

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

    const focusFiles = (options.focusFiles ?? []).map((f: string) =>
      path.resolve(this.root, f),
    );
    const additionalFiles = (options.additionalFiles ?? []).map((f: string) =>
      path.resolve(this.root, f),
    );
    const priorityFiles = new Set<string>(
      (options.priorityFiles ?? []).map((f: string) => path.resolve(this.root, f)),
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
    const allSrcFiles = await findSrcFiles(this.root);
    const fileSet = new Set([
      ...focusFiles,
      ...additionalFiles,
      ...allSrcFiles,
    ]);
    const allFiles = Array.from(fileSet);

    if (allFiles.length === 0) return null;

    this.lastFileSet = new Set(
      allFiles.map((f) => path.relative(this.root, f)),
    );

    // Decide ranking method
    let rankMethod: "tree-sitter" | "import-based" = "tree-sitter";
    const allTags: Tag[] = [];
    let importEdges = 0;

    if (useImportBased) {
      rankMethod = "import-based";
    } else {
      let tsOk = false;
      try {
        await initParser();
        progress?.("Initializing parser...");

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
              progress?.(
                `Parsing files: ${Math.min(i + batchSize, allFiles.length)}/${allFiles.length}`,
              );
            }
          }

          await augmentWithLspSymbols(
            allTags,
            allFiles,
            this.root,
            this.verbose,
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

    if (rankMethod === "tree-sitter" && allTags.length > 0) {
      let defCount = 0;
      let refCount = 0;
      for (const tag of allTags) {
        if (tag.kind === "def") defCount++;
        else refCount++;
      }

      progress?.("Ranking files (tree-sitter + PageRank)...");
      rankedTags = getRankedTags(
        this.root,
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

      const { map, tokenCount } = await buildMap(
        this.root,
        rankedTags,
        focusFiles,
        allFiles,
        maxTokens,
        compact,
      );

      const finalMap = await prependSpecialFiles(map, allFiles, this.root);

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
    const tsAliases = (await parseTsconfigPaths(this.root)) ?? undefined;
    const { inDegrees, edges } = await buildImportGraph(
      allRelFiles,
      this.root,
      tsAliases,
    );
    importEdges = edges.length;

    rankedTags = getImportRankedTags(
      this.root,
      allRelFiles,
      focusFiles,
      priorityFiles,
      inDegrees,
    );

    if (excludeUnranked) {
      rankedTags = rankedTags.filter((rt) => rt.rank > 0);
    }

    const { map, tokenCount } = await buildMap(
      this.root,
      rankedTags,
      focusFiles,
      allFiles,
      maxTokens,
      compact,
    );

    const finalMap = await prependSpecialFiles(map, allFiles, this.root);

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

  private async areFilesSame(options: Partial<RepoMapOptions>): Promise<boolean> {
    if (!this.lastFileSet) return false;

    const focusFiles = (options.focusFiles ?? []).map((f: string) =>
      path.resolve(this.root, f),
    );
    const additionalFiles = (options.additionalFiles ?? []).map((f: string) =>
      path.resolve(this.root, f),
    );

    const allSrcFiles = await findSrcFiles(this.root);
    const fileSet = new Set([
      ...focusFiles,
      ...additionalFiles,
      ...allSrcFiles,
    ]);
    const relFiles = new Set(
      Array.from(fileSet).map((f) => path.relative(this.root, f)),
    );

    if (relFiles.size !== this.lastFileSet.size) return false;

    for (const f of relFiles) {
      if (!this.lastFileSet.has(f)) return false;
    }

    return true;
  }

  private buildCachedResult(
    cacheKey: string,
    startTime: number,
  ): RepoMapResult {
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

  // ── Search ──────────────────────────────────────────────────────

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

    const allSrcFiles = await findSrcFiles(this.root);

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

        const concurrency = 20;
        progress?.(
          `Parsing ${allSrcFiles.length} files (concurrency=${concurrency})...`,
        );

        const fileEntries = allSrcFiles.map((fname) => ({
          fname,
          relFname: path.relative(this.root, fname),
        }));

        allTags = await getTagsBatch(
          fileEntries,
          this.cache,
          false,
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

    let useTextFallback =
      this.searchTreeSitterAvailable === false || allTags.length === 0;

    if (!useTextFallback && treeSitterAttempted) {
      const anyMatch = allTags.some((tag) => {
        if (!tag.name.toLowerCase().includes(queryLower)) return false;
        if (tag.kind === "def" && !includeDefinitions) return false;
        if (tag.kind === "ref" && !includeReferences) return false;
        return true;
      });

      if (!anyMatch) {
        useTextFallback = true;
      }
    }

    if (useTextFallback) {
      progress?.(`Searching ${allSrcFiles.length} files with text fallback...`);
      return await searchIdentifiersByText(
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

    progress?.(
      `Rendering context for ${Math.min(matched.length, maxResults)} matches...`,
    );

    const results: SearchResult[] = [];
    for (const tag of matched.slice(0, maxResults)) {
      if (signal?.aborted) return [];

      let context = "";
      try {
        const code = await fs.readFile(tag.fname, "utf-8");
        context = await renderTreeContext(
          code,
          [tag.line],
          {
            lineNumbers: true,
            loiPad: 2,
          },
          tag.fname,
        );
      } catch {
        // omit context — file may have been deleted since parse
      }
      results.push({
        file: tag.relFname,
        line: tag.line,
        name: tag.name,
        kind: tag.kind,
        context,
        confidence: tag.confidence ?? "extracted",
      });
    }

    return sortSearchResults(results);
  }
}