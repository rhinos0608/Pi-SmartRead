import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { findSrcFiles } from "./file-discovery.js";
import { getTagsBatch, initParser } from "./tags.js";
import { TagsCache } from "./cache.js";
import type { Tag } from "./cache.js";
import { resolveSymbol } from "./symbol-resolver.js";
import { buildCallGraph, type CallGraphResult } from "./callgraph.js";

// ── Types ─────────────────────────────────────────────────────────

export type NodeType = "file" | "symbol" | "function";
export type EdgeType = 
  | "imports" | "imported_by" 
  | "defines" | "defined_in" 
  | "references" | "referenced_by" 
  | "calls" | "called_by";

export interface ContextNode {
  id: string;
  type: NodeType;
  path?: string;
  name?: string;
}

export interface Provenance {
  from: string;
  to: string;
  type: EdgeType;
  confidence: number;
}

export interface ContextGraphOptions {
  maxFiles?: number;
  includeSymbols?: boolean;
  includeCalls?: boolean; // Phase 1: mostly ignored, kept for API stability
  forceRefresh?: boolean;
}

export interface GraphNeighbour {
  path: string;
  provenance: Provenance;
}

// ── Constants ─────────────────────────────────────────────────────

export const IMPORT_SPECIFIER_RE = /^\s*(?:import\s+(?:[^"']+?\s+from\s+)?|import\s*\(|(?:const|let|var)\s+[^=]+?=\s*require\(|export\s+[^"']+?\s+from\s+)["']([^"']+)["']/gm;
export const RESOLUTION_EXTENSIONS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", "/index.ts", "/index.tsx", "/index.js"];

// ── Path Helpers (moved from intent-read.ts) ──────────────────────

export function isPathInside(root: string, path: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  const lexicalRel = relative(resolvedRoot, resolvedPath);
  if (lexicalRel === "" || (!lexicalRel.startsWith("..") && !isAbsolute(lexicalRel))) {
    return true;
  }

  try {
    const realRoot = realpathSync(resolvedRoot);
    const realResolved = realpathSync(resolvedPath);
    const realRel = relative(realRoot, realResolved);
    return realRel === "" || (!realRel.startsWith("..") && !isAbsolute(realRel));
  } catch {
    return false;
  }
}

export function isReadableWorkspaceFile(cwd: string, path: string): boolean {
  try {
    if (!existsSync(path) || !isPathInside(cwd, path)) return false;
    const realPath = realpathSync(path);
    return isPathInside(cwd, realPath) && statSync(realPath).isFile();
  } catch {
    return false;
  }
}

// ── Import Resolution (moved from intent-read.ts) ─────────────────

export function resolveImportSpecifier(cwd: string, importerPath: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;

  const basePath = resolve(dirname(importerPath), specifier);
  if (!isPathInside(cwd, basePath)) return undefined;
  for (const ext of RESOLUTION_EXTENSIONS) {
    const candidate = `${basePath}${ext}`;
    if (isReadableWorkspaceFile(cwd, candidate)) return candidate;
  }

  return undefined;
}

// ── Graph Service ─────────────────────────────────────────────────

export class ContextGraph {
  private tagsCache: TagsCache;
  private provenances = new Map<string, Provenance>();
  /**
   * Pre-built symbol index: symbol name → tags across all files.
   * Built lazily by buildContextGraph(). Cleared on forceRefresh.
   */
  private symbolIndex: Map<string, Tag[]> | null = null;
  /**
   * Pre-built reverse index: file path → tags for that file.
   * Speeds up getSymbolNeighbours without rescanning.
   */
  private fileIndex: Map<string, Tag[]> | null = null;
  /**
   * Pre-built call graph. Built lazily if includeCalls is true.
   */
  private callGraph: CallGraphResult | null = null;

  constructor(private root: string) {
    this.tagsCache = new TagsCache(root);
  }

  /**
   * Builds the symbol index and file index for O(1) lookups.
   * Must be called before using findSymbolFiles or getSymbolNeighbours
   * for best performance. On-demand (index not built) still works —
   * falls back to per-call scanning with disk cache.
   */
  async buildContextGraph(options: ContextGraphOptions = {}): Promise<void> {
    await initParser();

    if (options.forceRefresh) {
      this.symbolIndex = null;
      this.fileIndex = null;
      this.callGraph = null;
      this.tagsCache.clearDiskCache();
    }

    const allFiles = findSrcFiles(this.root);
    
    if (options.includeCalls && this.callGraph === null && allFiles.length > 0) {
      this.callGraph = await buildCallGraph(allFiles);
    }

    if (this.symbolIndex !== null) return; // already built

    if (allFiles.length === 0) {
      this.symbolIndex = new Map();
      this.fileIndex = new Map();
      return;
    }

    const fileObjects = allFiles.map(f => ({
      fname: f,
      relFname: relative(this.root, f),
    }));

    const allTags = await getTagsBatch(
      fileObjects,
      this.tagsCache,
      false, // don't force refresh; handled above
      20,
    );

    // Build symbol → tags index
    const index = new Map<string, Tag[]>();
    const fileIdx = new Map<string, Tag[]>();
    for (const tag of allTags) {
      // Symbol index
      let list = index.get(tag.name);
      if (!list) {
        list = [];
        index.set(tag.name, list);
      }
      list.push(tag);

      // File index
      let fileList = fileIdx.get(tag.fname);
      if (!fileList) {
        fileList = [];
        fileIdx.set(tag.fname, fileList);
      }
      fileList.push(tag);
    }

    this.symbolIndex = index;
    this.fileIndex = fileIdx;
  }

  /**
   * Returns the pre-built symbol index, or null if not yet built.
   */
  private getSymbolIndex(): Map<string, Tag[]> | null {
    return this.symbolIndex;
  }

  /**
   * Returns the pre-built file tag index, or null if not yet built.
   */
  private getFileIndex(): Map<string, Tag[]> | null {
    return this.fileIndex;
  }

  /**
   * Get typed neighbor files for a given path.
   */
  async getFileNeighbours(path: string, options: ContextGraphOptions = {}): Promise<GraphNeighbour[]> {
    const neighbours: GraphNeighbour[] = [];
    const seen = new Set<string>([resolve(path)]);

    // 1. Direct Imports
    const importNeighbours = this.getImportNeighbours(path);
    for (const n of importNeighbours) {
      if (!seen.has(resolve(n))) {
        seen.add(resolve(n));
        const provenance: Provenance = { from: path, to: n, type: "imports", confidence: 1.0 };
        neighbours.push({ path: n, provenance });
        this.recordProvenance(provenance);
      }
    }

    // 2. Symbol-based neighbours (Phase 1: definitions for symbols used in this file)
    if (options.includeSymbols) {
      const symbolNeighbours = await this.getSymbolNeighbours(path, options);
      for (const n of symbolNeighbours) {
        if (!seen.has(resolve(n.path))) {
          seen.add(resolve(n.path));
          neighbours.push(n);
          this.recordProvenance(n.provenance);
        }
      }
    }

    // 3. Call-based neighbours
    if (options.includeCalls && this.callGraph) {
      const callNeighbours = this.getCallNeighbours(path);
      for (const n of callNeighbours) {
        if (!seen.has(resolve(n.path))) {
          seen.add(resolve(n.path));
          neighbours.push(n);
          this.recordProvenance(n.provenance);
        }
      }
    }

    return neighbours;
  }

  /**
   * Find files where a symbol is defined or referenced.
   *
   * Fast path: uses pre-built symbol index if available (O(1)).
   * Slow path: uses symbol-resolver.ts for import-aware resolution
   * (per Decision #143) with disk-cached tag fallback.
   */
  async findSymbolFiles(queryOrIdentifier: string, options: ContextGraphOptions = {}): Promise<GraphNeighbour[]> {
    const results: GraphNeighbour[] = [];
    const seen = new Set<string>();

    // Fast path: use pre-built symbol index
    const index = this.getSymbolIndex();
    if (index !== null) {
      const tags = index.get(queryOrIdentifier);
      if (tags) {
        for (const tag of tags) {
          if (seen.has(tag.fname)) continue;
          seen.add(tag.fname);
          const type: EdgeType = tag.kind === "def" ? "defines" : "references";
          results.push({
            path: tag.fname,
            provenance: { from: queryOrIdentifier, to: tag.fname, type, confidence: 0.9 },
          });
        }
      }
      return results;
    }

    // Slow path: use symbol-resolver with import-aware ranking
    try {
      const resolution = await resolveSymbol(
        this.root,
        queryOrIdentifier,
        undefined, // no context file at probe stage
        undefined, // no context line
        20,        // reasonable default
      );

      for (const def of resolution.definitions) {
        const fullPath = resolve(this.root, def.file);
        if (seen.has(fullPath)) continue;
        seen.add(fullPath);
        results.push({
          path: fullPath,
          provenance: { from: queryOrIdentifier, to: fullPath, type: "defines", confidence: 0.9 },
        });
      }

      for (const ref of resolution.references) {
        const fullPath = resolve(this.root, ref.file);
        if (seen.has(fullPath)) continue;
        seen.add(fullPath);
        results.push({
          path: fullPath,
          provenance: { from: queryOrIdentifier, to: fullPath, type: "references", confidence: 0.8 },
        });
      }
    } catch {
      // Fall back to raw tag-based lookup
      const allFiles = findSrcFiles(this.root);
      const fileObjects = allFiles.map(f => ({ fname: f, relFname: relative(this.root, f) }));
      const tags = await getTagsBatch(fileObjects, this.tagsCache, options.forceRefresh ?? false);

      for (const tag of tags) {
        if (tag.name === queryOrIdentifier) {
          if (seen.has(tag.fname)) continue;
          seen.add(tag.fname);
          const type: EdgeType = tag.kind === "def" ? "defines" : "references";
          const provenance: Provenance = { from: queryOrIdentifier, to: tag.fname, type, confidence: 0.8 };
          results.push({ path: tag.fname, provenance });
        }
      }
    }

    return results;
  }

  /**
   * Explains why a path was added to the context.
   */
  explainPathAddition(path: string): Provenance | undefined {
    return this.provenances.get(resolve(path));
  }

  private recordProvenance(p: Provenance): void {
    const target = resolve(p.to);
    if (!this.provenances.has(target)) {
      this.provenances.set(target, p);
    }
  }

  private getImportNeighbours(path: string): string[] {
    const neighbours: string[] = [];
    const fullPath = isAbsolute(path) ? path : resolve(this.root, path);
    
    if (!isPathInside(this.root, fullPath)) return [];

    let text: string;
    try {
      text = readFileSync(fullPath, "utf-8");
    } catch {
      return [];
    }

    for (const match of text.matchAll(IMPORT_SPECIFIER_RE)) {
      const resolved = resolveImportSpecifier(this.root, fullPath, match[1]!);
      if (resolved && isReadableWorkspaceFile(this.root, resolved)) {
        neighbours.push(resolved);
      }
    }

    return neighbours;
  }

  private getCallNeighbours(path: string): GraphNeighbour[] {
    const neighbours: GraphNeighbour[] = [];
    if (!this.callGraph) return neighbours;

    const resolvedPath = resolve(path);
    const relPath = relative(this.root, resolvedPath);

    // Find functions defined in this file
    const functionsInFile = this.callGraph.functions.filter(f => f.file === relPath);

    for (const func of functionsInFile) {
      // Functions this file calls
      for (const calleeStr of func.calls) {
        // calleeStr is typically file:func or func
        const parts = calleeStr.split(":");
        if (parts.length === 2) {
          const calleeFile = parts[0];
          if (calleeFile && calleeFile !== relPath) {
            const calleePath = resolve(this.root, calleeFile);
            if (isReadableWorkspaceFile(this.root, calleePath)) {
              neighbours.push({
                path: calleePath,
                provenance: { from: path, to: calleePath, type: "calls", confidence: 0.8 },
              });
            }
          }
        }
      }

      // Functions that call this file
      for (const callerStr of func.calledBy) {
        const parts = callerStr.split(":");
        if (parts.length === 2) {
          const callerFile = parts[0];
          if (callerFile && callerFile !== relPath) {
            const callerPath = resolve(this.root, callerFile);
            if (isReadableWorkspaceFile(this.root, callerPath)) {
              neighbours.push({
                path: callerPath,
                provenance: { from: path, to: callerPath, type: "called_by", confidence: 0.8 },
              });
            }
          }
        }
      }
    }

    return neighbours;
  }

  private async getSymbolNeighbours(path: string, options: ContextGraphOptions): Promise<GraphNeighbour[]> {
    const neighbours: GraphNeighbour[] = [];
    const resolvedPath = resolve(path);

    // Fast path: use file index + symbol index if built
    const fileIdx = this.getFileIndex();
    if (fileIdx !== null) {
      const tags = fileIdx.get(resolvedPath) ?? fileIdx.get(path) ?? [];
      const references = tags.filter(t => t.kind === "ref");
      const uniqueRefNames = new Set(references.map(tag => tag.name));

      if (uniqueRefNames.size > 0) {
        const index = this.getSymbolIndex();
        if (index !== null) {
          const seenPaths = new Set<string>([resolvedPath]);
          for (const refName of uniqueRefNames) {
            const defTags = index.get(refName);
            if (!defTags) continue;
            for (const tag of defTags) {
              if (tag.kind !== "def") continue;
              if (seenPaths.has(tag.fname)) continue;
              seenPaths.add(tag.fname);
              neighbours.push({
                path: tag.fname,
                provenance: { from: path, to: tag.fname, type: "defines", confidence: 0.9 },
              });
            }
          }
          return neighbours;
        }
      }
    }

    // Slow path: rescan files
    const relPath = relative(this.root, path);
    const tags = await getTagsBatch([{ fname: path, relFname: relPath }], this.tagsCache, options.forceRefresh ?? false);
    
    const references = tags.filter(t => t.kind === "ref");
    const uniqueRefNames = new Set(references.map(tag => tag.name));

    if (uniqueRefNames.size > 0) {
      const allFiles = findSrcFiles(this.root);
      const fileObjects = allFiles.map(f => ({ fname: f, relFname: relative(this.root, f) }));
      const allTags = await getTagsBatch(fileObjects, this.tagsCache, options.forceRefresh ?? false);

      const seenPaths = new Set<string>([resolvedPath]);
      for (const tag of allTags) {
        if (tag.kind === "def" && uniqueRefNames.has(tag.name)) {
          if (seenPaths.has(tag.fname)) continue;
          seenPaths.add(tag.fname);
          neighbours.push({
            path: tag.fname,
            provenance: { from: path, to: tag.fname, type: "defines", confidence: 0.9 },
          });
        }
      }
    }

    return neighbours;
  }
}

// ── Legacy Compatibility ──────────────────────────────────────────

/**
 * Maintained for backward compatibility with existing intent_read.
 */
export function findDirectImportNeighbours(cwd: string, paths: string[], maxCount: number): string[] {
  if (maxCount <= 0) return [];

  const basePaths = new Set(paths.map((path) => isAbsolute(path) ? path : resolve(cwd, path)));
  const neighbours: string[] = [];
  const seen = new Set<string>(basePaths);

  for (const path of paths) {
    const fullPath = isAbsolute(path) ? path : resolve(cwd, path);
    // Use the private method logic or just re-implement here to avoid complex async in this sync-looking function
    // intent-read.ts's version was synchronous.
    
    if (!isPathInside(cwd, fullPath)) continue;

    let text: string;
    try {
      text = readFileSync(fullPath, "utf-8");
    } catch {
      continue;
    }

    for (const match of text.matchAll(IMPORT_SPECIFIER_RE)) {
      const resolved = resolveImportSpecifier(cwd, fullPath, match[1]!);
      if (!resolved || seen.has(resolved)) continue;
      seen.add(resolved);
      neighbours.push(resolved);
      if (neighbours.length >= maxCount) return neighbours;
    }
  }

  return neighbours;
}
