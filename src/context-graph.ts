import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { findSrcFiles } from "./file-discovery.js";
import { getTagsBatch, initParser } from "./tags.js";
import { TagsCache } from "./cache.js";
import type { Tag } from "./cache.js";
import { resolveSymbol } from "./symbol-resolver.js";
import { buildCallGraph, type CallGraphResult } from "./callgraph.js";
import { LruCache } from "./utils.js";
import { chooseConcurrency } from "./adaptive-concurrency.js";
import { EdgeStore } from "./edge-store.js";
import {
  buildTagIndices,
  collectBuildInputs,
  collectImportEdges,
  emptyIndices,
  invalidateIncrementalIndex,
  populateHistoricalEdges,
  recordBuildTelemetry,
  type BuildResult,
} from "./context-graph-build.js";

// Re-exported for compatibility (moved to edge-store.ts).
export { EdgeStore, type MutationEvent } from "./edge-store.js";

// ── Types ─────────────────────────────────────────────────────────

export type NodeType = "file" | "symbol" | "function";
export type EdgeType =
  | "imports" | "imported_by"
  | "defines" | "defined_in"
  | "references" | "referenced_by"
  | "calls" | "called_by"
  | "breakage" | "co_change";

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
  source?: string;
  impactEligible?: boolean;
}

export interface ContextGraphOptions {
  maxFiles?: number;
  includeSymbols?: boolean;
  includeCalls?: boolean; // Phase 1: mostly ignored, kept for API stability
  forceRefresh?: boolean;
  skipGitPopulation?: boolean; // Skip first-run git co-commit auto-population
  /**
   * Enable incremental indexing using content-addressable file hashing.
   * When enabled, skips re-parsing files whose content hasn't changed
   * since the last graph build.
   */
  incrementalIndex?: boolean;
}

export interface GraphNeighbour {
  path: string;
  provenance: Provenance;
}

// ── Constants ─────────────────────────────────────────────────────

export const IMPORT_SPECIFIER_RE = /^\s*(?:import\s+(?:[^"']+?\s+from\s+)?|import\s*\(|(?:const|let|var)\s+[^=]+?=\s*require\(|export\s+[^"']+?\s+from\s+)["']([^"']+)["']/gm;
export const RESOLUTION_EXTENSIONS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", "/index.ts", "/index.tsx", "/index.js"];

export function isReadableWorkspaceFile(_cwd: string, path: string): boolean {
  try {
    if (!existsSync(path)) return false;
    return statSync(realpathSync(path)).isFile();
  } catch {
    return false;
  }
}

// ── Import Resolution (moved from intent-read.ts) ─────────────────

export function resolveImportSpecifier(cwd: string, importerPath: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;

  const basePath = resolve(dirname(importerPath), specifier);
  for (const ext of RESOLUTION_EXTENSIONS) {
    const candidate = `${basePath}${ext}`;
    if (isReadableWorkspaceFile(cwd, candidate)) return candidate;
  }

  return undefined;
}

// ── Small shared helpers (pure, no behavior change) ─────────────────

/** Dedup key for symbol-neighbour results. */
function pushTagNeighbour(
  results: GraphNeighbour[],
  seen: Set<string>,
  fname: string,
  from: string,
  type: EdgeType,
  confidence: number,
): void {
  const pairKey = `${fname}::${type}`;
  if (seen.has(pairKey)) return;
  seen.add(pairKey);
  results.push({ path: fname, provenance: { from, to: fname, type, confidence } });
}

/** Collect call-graph neighbours for one function entry (calls or called_by). */
function collectCallEdges(
  func: { calls: string[]; calledBy: string[] },
  field: "calls" | "calledBy",
  relPath: string,
  root: string,
): Array<{ path: string; type: EdgeType }> {
  const out: Array<{ path: string; type: EdgeType }> = [];
  const edgeType: EdgeType = field === "calls" ? "calls" : "called_by";
  for (const entry of func[field]) {
    const parts = entry.split(":");
    if (parts.length !== 2) continue;
    const file = parts[0];
    if (!file || file === relPath) continue;
    const fullPath = resolve(root, file);
    if (!isReadableWorkspaceFile(root, fullPath)) continue;
    out.push({ path: fullPath, type: edgeType });
  }
  return out;
}

// ── Graph Service ─────────────────────────────────────────────────

export class ContextGraph {
  private tagsCache: TagsCache;
  private provenances = new Map<string, Provenance>();
  private _provenancesCapReached = false;
  private static readonly PROVENANCES_MAX = 50_000;
  /**
   * Pre-built symbol index: symbol name → tags across all files.
   * Built lazily by buildContextGraph(). Cleared on forceRefresh.
   */
  private symbolIndex: LruCache<Tag[]> | null = null;
  /**
   * Pre-built reverse index: file path → tags for that file.
   * Speeds up getSymbolNeighbours without rescanning.
   */
  private fileIndex: LruCache<Tag[]> | null = null;
  /**
   * Pre-built call graph. Built lazily if includeCalls is true.
   */
  private callGraph: CallGraphResult | null = null;
  /**
   * Cached mutation edges from EdgeStore (breakage + co-change).
   * Loaded during buildContextGraph() if the store has entries.
   * Indexed by originating path for O(1) neighbor lookups.
   */
  private mutationEdges: Map<string, Provenance[]> = new Map();
  private static readonly MUTATION_EDGES_MAX = 10_000;

  /**
   * Dedicated import adjacency edges, populated during buildContextGraph().
   * Replaces the mixed provenances cache for buildImportEdges consumers.
   * Each entry is a directed { from: importer, to: imported } pair.
   */
  private importEdges: Array<{ from: string; to: string }> = [];

  private lastBuildFilesLength: number = -1;

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
    await this.tagsCache.init();

    if (options.forceRefresh) {
      this.resetBuildState();
      await this.tagsCache.clearDiskCache();
    }

    // Stage 1: historical populate (EdgeStore + bounded git backfill).
    await populateHistoricalEdges(this.root, options, {
      loadMutationEdges: () => this.loadMutationEdges(),
      mutationEdgeCount: () => this.mutationEdges.size,
    });

    // Stage 2: rebuild decision (file discovery + incremental + safety net).
    const inputs = await collectBuildInputs(
      this.root,
      options,
      this.lastBuildFilesLength,
      this.symbolIndex !== null,
    );
    const allFiles = inputs.allFiles;
    if (options.incrementalIndex && inputs.fileCountChanged) {
      invalidateIncrementalIndex(this.root);
    }

    // Lifecycle: call-graph trigger stays here; built lazily on demand.
    if (options.includeCalls && this.callGraph === null && allFiles.length > 0) {
      this.callGraph = await buildCallGraph(allFiles);
    }

    // Fast-path: nothing changed and index already built. Skip rebuilding,
    // preserving import adjacency across unchanged builds.
    if (!inputs.needsRebuild) {
      this.lastBuildFilesLength = allFiles.length;
      return;
    }

    // Rebuild path: file-less workspaces commit empty indices.
    if (allFiles.length === 0) {
      this.commitBuildResult({ ...emptyIndices(), importEdges: [], fileCount: 0 });
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
      chooseConcurrency({ fileCount: fileObjects.length, operation: "parse" }),
    );

    // Stage 4: coverage + snapshot telemetry (side-effect only).
    recordBuildTelemetry(this.root, allFiles, allTags);

    // Stage 3 (cont.): in-memory indices, built locally and published once.
    // (Supersedes the old F-3 pre-nulling: the commit below overwrites both
    // indices unconditionally, so a changed file set always rebuilds.)
    const { symbolIndex, fileIndex } = buildTagIndices(allTags);

    // Stage 5: import edges from actual import adjacency data. Produces typed
    // IMPORT edges for buildImportEdges consumers (community detection,
    // layer analysis). Rebuilt only on a full rebuild; preserved across
    // unchanged fast-path builds by the early return above.
    const importEdges = collectImportEdges(allFiles, (file) => this.getImportNeighbours(file));

    // Single build-result commit: publish indices, edges, and the file-count
    // watermark together so readers never observe a partially rebuilt graph.
    this.commitBuildResult({ symbolIndex, fileIndex, importEdges, fileCount: allFiles.length });
  }

  /** Clear all built state (force-refresh lifecycle; repopulated by stages). */
  private resetBuildState(): void {
    this.symbolIndex = null;
    this.fileIndex = null;
    this.callGraph = null;
    this.provenances.clear();
    this._provenancesCapReached = false;
    this.mutationEdges.clear();
  }

  /** Publish a rebuilt graph atomically: indices, edges, watermark. */
  private commitBuildResult(result: BuildResult): void {
    this.symbolIndex = result.symbolIndex;
    this.fileIndex = result.fileIndex;
    this.importEdges = result.importEdges;
    this.lastBuildFilesLength = result.fileCount;
  }

  /**
   * Returns the pre-built symbol index, or null if not yet built.
   */
  private getSymbolIndex(): LruCache<Tag[]> | null {
    return this.symbolIndex;
  }

  /**
   * Exact-definition lookup from the built symbol index (O(1)). Returns the
   * first definition tag for a simple identifier, or null when the index is
   * not yet built, the symbol is absent, or it has no `def` tag. Used by grep
   * to avoid a full AST workspace scan for simple symbols when a graph is
   * already built; callers must retain a fallback for qualified/partial
   * identifiers and for the unbuilt-graph case.
   */
  findExactSymbolDef(
    name: string,
  ): { file: string; relFile: string; line: number; name: string; kind: string } | null {
    const index = this.getSymbolIndex();
    if (!index) return null;
    const tags = index.get(name);
    if (!tags) return null;
    const def = tags.find((t) => t.kind === "def");
    if (!def) return null;
    const absFile = resolve(this.root, def.fname);
    return {
      file: absFile,
      relFile: relative(this.root, absFile).replace(/\\/g, "/"),
      line: def.line ?? 1,
      name: def.name ?? name,
      kind: "symbol",
    };
  }

  /**
   * Returns the pre-built file tag index, or null if not yet built.
   */
  private getFileIndex(): LruCache<Tag[]> | null {
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
      this.addUniqueNeighbour(neighbours, seen, n, { from: path, to: n, type: "imports", confidence: 1.0 });
    }

    // 2. Reverse imports from built adjacency (no workspace rescan)
    for (const n of this.getImportDependents(path)) {
      this.addUniqueNeighbour(neighbours, seen, n, { from: path, to: n, type: "imported_by", confidence: 1.0 });
    }

    // 3. Symbol-based neighbours (Phase 1: definitions for symbols used in this file)
    if (options.includeSymbols) {
      const symbolNeighbours = await this.getSymbolNeighbours(path, options);
      for (const n of symbolNeighbours) {
        this.addUniqueNeighbour(neighbours, seen, n.path, n.provenance);
      }
    }

    // 3. Call-based neighbours
    if (options.includeCalls && this.callGraph) {
      const callNeighbours = this.getCallNeighbours(path);
      for (const n of callNeighbours) {
        this.addUniqueNeighbour(neighbours, seen, n.path, n.provenance);
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
          const type: EdgeType = tag.kind === "def" ? "defines" : "references";
          pushTagNeighbour(results, seen, tag.fname, queryOrIdentifier, type, 0.9);
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
        pushTagNeighbour(results, seen, fullPath, queryOrIdentifier, "defines", 0.9);
      }

      for (const ref of resolution.references) {
        const fullPath = resolve(this.root, ref.file);
        pushTagNeighbour(results, seen, fullPath, queryOrIdentifier, "references", 0.8);
      }
    } catch {
      // Fall back to raw tag-based lookup
      const allFiles = await findSrcFiles(this.root);
      const fileObjects = allFiles.map(f => ({ fname: f, relFname: relative(this.root, f) }));
      const tags = await getTagsBatch(fileObjects, this.tagsCache, options.forceRefresh ?? false);

      for (const tag of tags) {
        if (tag.name !== queryOrIdentifier) continue;
        const type: EdgeType = tag.kind === "def" ? "defines" : "references";
        pushTagNeighbour(results, seen, tag.fname, queryOrIdentifier, type, 0.8);
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

  /** Append a neighbour once per resolved path and record its provenance. */
  private addUniqueNeighbour(
    neighbours: GraphNeighbour[],
    seen: Set<string>,
    path: string,
    provenance: Provenance,
  ): void {
    const key = resolve(path);
    if (seen.has(key)) return;
    seen.add(key);
    neighbours.push({ path, provenance });
    this.recordProvenance(provenance);
  }

  private recordProvenance(p: Provenance): void {
    if (this._provenancesCapReached) return;
    const target = resolve(p.to);
    if (!this.provenances.has(target)) {
      if (this.provenances.size >= ContextGraph.PROVENANCES_MAX) {
        this._provenancesCapReached = true;
        return;
      }
      this.provenances.set(target, p);
    }
  }

  private getImportNeighbours(path: string): string[] {
    const neighbours: string[] = [];
    // Normalize to resolved absolute path so edge keys are consistent
    const fullPath = resolve(this.root, path);

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
      for (const edge of [
        ...collectCallEdges(func, "calls", relPath, this.root),
        ...collectCallEdges(func, "calledBy", relPath, this.root),
      ]) {
        neighbours.push({
          path: edge.path,
          provenance: { from: path, to: edge.path, type: edge.type, confidence: 0.8 },
        });
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
      const allFiles = await findSrcFiles(this.root);
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

  /**
   * Load mutation edges from the EdgeStore (breakage + co-change events).
   * Called during buildContextGraph(). Builds an intra-session index for
   * O(1) neighbor lookups during graph expansion.
   */
  private loadMutationEdges(): void {
    this.mutationEdges.clear();

    try {
      const events = EdgeStore.readEdges(this.root);
      if (events.length === 0) return;

      if (this.mutationEdges.size >= ContextGraph.MUTATION_EDGES_MAX) return;

      const provenances = EdgeStore.toProvenances(events, this.root);
      for (const prov of provenances) {
        if (this.mutationEdges.size >= ContextGraph.MUTATION_EDGES_MAX) break;
        const fromPath = prov.from;
        let list = this.mutationEdges.get(fromPath);
        if (!list) {
          list = [];
          this.mutationEdges.set(fromPath, list);
        }
        list.push(prov);
      }
    } catch {
      // EdgeStore unavailable or corrupted — proceed without mutation edges
    }
  }

  /**
   * Get neighbor files reachable via mutation edges (breakage/co-change)
   * from a given path. Used during graph expansion in the intent-read engine.
   */
  getMutationNeighbours(path: string): GraphNeighbour[] {
    const neighbours: GraphNeighbour[] = [];
    const resolved = resolve(path);

    // Check both the requested path and its resolved form
    const list = this.mutationEdges.get(path) ?? this.mutationEdges.get(resolved) ?? [];
    for (const prov of list) {
      neighbours.push({
        path: prov.to,
        provenance: prov,
      });
    }

    return neighbours;
  }

  /**
   * Return files importing target from already-built import adjacency.
   * Does not scan workspace; empty means adjacency is not built or has no match.
   */
  getImportDependents(path: string): string[] {
    const target = resolve(path);
    return this.importEdges
      .filter((edge) => resolve(edge.to) === target)
      .map((edge) => edge.from);
  }

  /**
   * Return all recorded import edges as {from, to} pairs.
   * Used by buildImportEdges for community detection / layer analysis.
   */
  getProvenanceEdges(): Array<{ from: string; to: string }> {
    return this.importEdges;
  }

  /** Return capacity stats for monitoring memory caps. */
  getCapacityStats(): {
    symbolIndex: { entries: number; max: number };
    fileIndex: { entries: number; max: number };
    provenances: { size: number; max: number; capReached: boolean };
    mutationEdges: { size: number; max: number };
  } {
    return {
      symbolIndex: { entries: this.symbolIndex?.size ?? 0, max: 20_000 },
      fileIndex: { entries: this.fileIndex?.size ?? 0, max: 5_000 },
      provenances: { size: this.provenances.size, max: ContextGraph.PROVENANCES_MAX, capReached: this._provenancesCapReached },
      mutationEdges: { size: this.mutationEdges.size, max: ContextGraph.MUTATION_EDGES_MAX },
    };
  }
}

// ── Legacy Compatibility ──────────────────────────────────────────

/**
 * Maintained for backward compatibility with the existing intent-read engine.
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
