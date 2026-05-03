import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { findSrcFiles } from "./file-discovery.js";
import { getTagsBatch, initParser } from "./tags.js";
import { TagsCache } from "./cache.js";
import type { Tag } from "./cache.js";
import { resolveSymbol } from "./symbol-resolver.js";
import { buildCallGraph, type CallGraphResult } from "./callgraph.js";
import { LruCache } from "./utils.js";

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
      this.symbolIndex = null;
      this.fileIndex = null;
      this.callGraph = null;
      this.mutationEdges.clear();
      await this.tagsCache.clearDiskCache();
    }

    // Load mutation edges from EdgeStore (breakage + co-change events)
    // These are persisted observations from post-edit diagnostic cascades
    // and git history co-change analysis (Smart-Edit integration).
    this.loadMutationEdges();

    const allFiles = await findSrcFiles(this.root);
    
    if (options.includeCalls && this.callGraph === null && allFiles.length > 0) {
      this.callGraph = await buildCallGraph(allFiles);
    }

    if (this.symbolIndex !== null) return; // already built

    if (allFiles.length === 0) {
      this.symbolIndex = new LruCache(1);
      this.fileIndex = new LruCache(1);
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

    // Build symbol → tags index with memory caps
    const index = new LruCache<Tag[]>(50_000);
    const fileIdx = new LruCache<Tag[]>(10_000);
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
  private getSymbolIndex(): LruCache<Tag[]> | null {
    return this.symbolIndex;
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
      const allFiles = await findSrcFiles(this.root);
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

      const provenances = EdgeStore.toProvenances(events, this.root);
      for (const prov of provenances) {
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
   * from a given path. Used during graph expansion in intent_read.
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

// ── EdgeStore: Event-sourced graph mutation log ────────────────────

/**
 * A single mutation event recorded by the EdgeStore.
 * Each event is an append-only log entry: { type, data, timestamp }.
 */
export interface MutationEvent {
  /** Edge type: "breakage" | "co_change" */
  type: "breakage" | "co_change";
  data: {
    /** The file or symbol that was modified (e.g. "src/auth.ts:login"). */
    from: string;
    /** The file or symbol that broke or co-changed (e.g. "src/types.ts:User"). */
    to: string;
    /** Human-readable description (e.g. "type check failed in User interface"). */
    context?: string;
    /** Confidence score (0-1). Default 1.0 for observed breakage. */
    confidence?: number;
    /** Source of observation: "diagnostics" | "git_history" | "manual". */
    source?: string;
  };
  /** Unix timestamp in ms. */
  timestamp: number;
}

/**
 * Event-sourced store for graph mutations.
 *
 * Appends mutation events (breakage, co-change) to a JSONL log file.
 * On replay, produces Provenance edges that can feed into the ContextGraph's
 * neighbor expansion.
 *
 * File location: <root>/.pi-smartread/graph-mutations.jsonl
 *
 * This is the integration point for Smart-Edit's post-edit evidence pipeline.
 * Smart-Edit writes MutationEvents here; Pi-SmartRead replays them on graph
 * construction. Determinism within a retrieval call is preserved because
 * replay happens at graph build time, not during query.
 */
export class EdgeStore {
  private static readonly EDGE_LOG_RELPATH = ".pi-smartread/graph-mutations.jsonl";

  /**
   * Append a breakage event to the mutation log.
   *
   * @param root - Project root directory (used for log file location).
   * @param from - File/symbol that was modified (e.g. "src/auth.ts:login").
   * @param to - File/symbol that broke (e.g. "src/types.ts:User").
   * @param context - Optional human-readable description.
   * @param confidence - Confidence score (0-1). Default 1.0 for observed breakage.
   */
  static recordBreakage(
    root: string,
    from: string,
    to: string,
    context?: string,
    confidence?: number,
  ): void {
    const event: MutationEvent = {
      type: "breakage",
      data: { from, to, context, confidence, source: "diagnostics" },
      timestamp: Date.now(),
    };
    EdgeStore.append(root, event);
  }

  /**
   * Append a co-change event to the mutation log.
   *
   * @param root - Project root directory.
   * @param from - File that was edited.
   * @param to - File that co-changed in the same commit history.
   * @param context - Optional human-readable description (e.g. commit hash).
   * @param confidence - Confidence score (0-1). Default 0.7 for git history.
   */
  static recordCoChange(
    root: string,
    from: string,
    to: string,
    context?: string,
    confidence?: number,
  ): void {
    const event: MutationEvent = {
      type: "co_change",
      data: { from, to, context, confidence: confidence ?? 0.7, source: "git_history" },
      timestamp: Date.now(),
    };
    EdgeStore.append(root, event);
  }

  /**
   * Read all mutation events from the log, optionally filtered by recency.
   *
   * @param root - Project root directory.
   * @param maxAgeMs - Only return events newer than this (ms from now). Default: 30 days.
   * @returns Sorted array of mutation events (newest first).
   */
  static readEdges(root: string, maxAgeMs = 30 * 24 * 60 * 60 * 1000): MutationEvent[] {
    const logPath = EdgeStore.getLogPath(root);
    if (!existsSync(logPath)) return [];

    const now = Date.now();
    const events: MutationEvent[] = [];

    try {
      const text = readFileSync(logPath, "utf-8");
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const event = JSON.parse(trimmed) as MutationEvent;
          if (now - event.timestamp <= maxAgeMs) {
            events.push(event);
          }
        } catch {
          // Skip malformed lines silently
        }
      }
    } catch {
      return [];
    }

    // Sort newest first
    events.sort((a, b) => b.timestamp - a.timestamp);
    return events;
  }

  /**
   * Convert MutationEvents to Provenance edges for ContextGraph neighbor expansion.
   * Deduplicates by (from, to, type) keeping the highest confidence.
   */
  static toProvenances(events: MutationEvent[], root: string): Provenance[] {
    const best = new Map<string, Provenance>();

    for (const ev of events) {
      // Resolve relative paths against root
      const fromPath = resolve(root, ev.data.from);
      const toPath = resolve(root, ev.data.to);
      const key = `${fromPath}||${toPath}||${ev.type}`;

      const edgeType: EdgeType = ev.type === "breakage" ? "breakage" : "co_change";
      const existing = best.get(key);
      const confidence = ev.data.confidence ?? (ev.type === "breakage" ? 1.0 : 0.7);

      if (!existing || existing.confidence < confidence) {
        best.set(key, {
          from: fromPath,
          to: toPath,
          type: edgeType,
          confidence,
        });
      }
    }

    return [...best.values()];
  }

  private static getLogPath(root: string): string {
    return `${resolve(root)}/${EdgeStore.EDGE_LOG_RELPATH}`;
  }

  private static append(root: string, event: MutationEvent): void {
    const logPath = EdgeStore.getLogPath(root);
    const dir = dirname(logPath);

    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      // Directory may already exist
    }

    const line = JSON.stringify(event) + "\n";
    appendFileSync(logPath, line, "utf-8");
  }
}
