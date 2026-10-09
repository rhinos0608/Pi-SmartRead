/**
 * Mtime-based file tag cache with versioning and error recovery.
 *
 * Caches tree-sitter tag results keyed by absolute file path.
 * Invalidates when file mtime changes.
 *
 * Implements:
 *  - CACHE_VERSION for format migration (like Aider's diskcache versioning)
 *  - Memory-first: promotes disk entries to memory on access
 *  - Corruption recovery: re-parses on JSON parse failure, tracks corruption count
 *  - Disk cache clearing on version mismatch
 */
import { promises as fs, existsSync } from "node:fs";
import { join, resolve as pathResolve } from "node:path";
import { createHash } from "node:crypto";
import { resolveStateRoot } from "../workspace/state-root.js";
import { canonicalPathOrNull } from "../canonical-path.js";

export type TagConfidence = "extracted" | "inferred" | "ambiguous";

export interface Tag {
  relFname: string;
  fname: string;
  line: number;
  name: string;
  kind: "def" | "ref";
  /** How the tag was found: extracted (AST/parser), inferred (regex/fallback), ambiguous (uncertain) */
  confidence?: TagConfidence;
}

export interface TagsCacheOptions {
  /** Force fresh parsing by skipping disk persistence (default: false) */
  noDiskCache?: boolean;
  /** Max corruption entries before auto-clearing disk cache (default: 5) */
  maxCorruptionThreshold?: number;
  /** Track file dependencies for incremental invalidation */
  trackDependencies?: boolean;
}

interface CacheEntry {
  mtime: number;
  queryMtime: number | null;
  tags: Tag[];
}

/**
 * Current cache format version. Bump when Tag structure, serialization, or
 * key derivation changes. v4: entries live at the canonical state root and
 * keys are namespaced by scan root (see getFilePath).
 */
export const CACHE_VERSION = 4;

const VERSION_FILENAME = "version.json";

export class TagsCache {
  /** Canonical scan root — namespaces cache keys, see getFilePath. */
  private readonly scanRoot: string;
  /** Canonical state root + dir, or null when there is none (memory-only). */
  private cacheDir: string | null;
  private memoryCache: Map<string, CacheEntry>;
  private useFilePersistence: boolean;
  private corruptionCount: number;
  private maxCorruptionThreshold: number;
  private trackDependencies: boolean;
  /** Max entries in memory cache before eviction begins. */
  private readonly maxMemoryEntries: number;

  /** File → set of files that import from this file (reverse dependency graph) */
  dependents: Map<string, Set<string>> = new Map();
  private readonly maxDependentsEntries = 50_000;
  private dependentsFull = false;
  private dependentsEdgeCount = 0;

  /** Per-file parse timing (ms) */
  parseTimings: Map<string, number> = new Map();
  private readonly maxParseTimingsEntries = 20_000;

  /** Total parse time across all files in this session */
  totalParseTimeMs = 0;

  /** Number of parse operations this session */
  parseCount = 0;

  constructor(root: string, options: TagsCacheOptions = {}) {
    // Scan scope stays at `root` (the caller's scan dir — map results are
    // unchanged); the on-disk cache moves to the canonical state root so a
    // nested scan dir never gets its own `.pi-smartread.tags.cache`. No
    // state root (no git top level / no qualifying marker) → memory-only.
    this.scanRoot = canonicalPathOrNull(root) ?? pathResolve(root);
    const stateRoot = resolveStateRoot(root);
    this.cacheDir = stateRoot === null ? null : join(stateRoot, ".pi-smartread.tags.cache");
    this.memoryCache = new Map();
    this.useFilePersistence = false;
    this.corruptionCount = 0;
    this.maxCorruptionThreshold = options.maxCorruptionThreshold ?? 5;
    this.trackDependencies = options.trackDependencies ?? false;
    this.maxMemoryEntries = 10_000; // Hard cap: prevents unbounded memory growth

    if (!options.noDiskCache) {
      // We can't await in constructor, so we provide an init method
      // or handle it lazily. Here we use an async init.
    }
  }

  /**
   * Initialize disk persistence.
   * Checks CACHE_VERSION and clears if mismatch.
   */
  async init(): Promise<void> {
    if (this.cacheDir === null) {
      // No canonical state root: memory-only, never mkdir. Never throws.
      this.useFilePersistence = false;
      return;
    }
    try {
      if (!existsSync(this.cacheDir)) {
        await fs.mkdir(this.cacheDir, { recursive: true });
        await this.writeVersionFile();
        this.useFilePersistence = true;
        return;
      }

      // Check cache version
      const versionFile = join(this.cacheDir, VERSION_FILENAME);
      if (existsSync(versionFile)) {
        try {
          const raw = await fs.readFile(versionFile, "utf-8");
          const ver = JSON.parse(raw);
          if (ver.version !== CACHE_VERSION) {
            // Version mismatch — wipe and recreate
            await this.clearDiskCache();
          }
        } catch {
          // Corrupted version file — wipe
          await this.clearDiskCache();
        }
      } else {
        // No version file (old format) — wipe and recreate
        await this.clearDiskCache();
      }

      await this.writeVersionFile();
      this.useFilePersistence = true;
    } catch {
      this.useFilePersistence = false;
    }
  }

  private async writeVersionFile(): Promise<void> {
    if (this.cacheDir === null) return;
    try {
      const versionFile = join(this.cacheDir, VERSION_FILENAME);
      await fs.writeFile(
        versionFile,
        JSON.stringify({ version: CACHE_VERSION }),
        "utf-8",
      );
    } catch {
      // Non-fatal
    }
  }

  /**
   * Entry path for a file's tags, or null when the cache is memory-only.
   *
   * One state-root cache dir is shared by every scanDir beneath it, so the
   * key namespaces the canonical scan root: `relFname` inside an entry is
   * relative to the scan root that parsed it, and hashing the scan root
   * keeps two scanDirs from reading each other's entries for the same
   * absolute file.
   */
  private getFilePath(fname: string): string | null {
    if (this.cacheDir === null) return null;
    const hash = createHash("sha256").update(`${this.scanRoot}\0${fname}`).digest("hex");
    return join(this.cacheDir, `${hash}.json`);
  }

  private async getMtime(fname: string): Promise<number | null> {
    try {
      const stat = await fs.stat(fname);
      return stat.mtimeMs;
    } catch {
      return null;
    }
  }

  /**
   * Get tags for a file from cache.
   * Optionally accepts queryMtime — the mtime of the SCM query file for the file's language.
   * When the query file changes, cached entries are invalidated even if the source file hasn't.
   * Pass null/undefined for queryMtime to skip this check (backward compat).
   * Returns null on cache miss, mtime mismatch, or corrupted entry.
   */
  async get(fname: string, queryMtime?: number | null): Promise<Tag[] | null> {
    const mtime = await this.getMtime(fname);
    if (mtime === null) return null;

    // Check memory cache first
    const memEntry = this.memoryCache.get(fname);
    if (memEntry && memEntry.mtime === mtime && memEntry.queryMtime === (queryMtime ?? null)) {
      return memEntry.tags;
    }

    // Check file persistence
    if (this.useFilePersistence) {
      try {
        const filePath = this.getFilePath(fname);
        if (filePath !== null && existsSync(filePath)) {
          const raw = await fs.readFile(filePath, "utf-8");
          const entry = JSON.parse(raw) as CacheEntry;
          if (
            entry &&
            typeof entry.mtime === "number" &&
            entry.mtime === mtime &&
            entry.queryMtime === (queryMtime ?? null) &&
            Array.isArray(entry.tags)
          ) {
            // Promote to memory cache
            this.memoryCache.set(fname, entry);
            return entry.tags;
          }
          // Malformed entry — treat as miss
        }
      } catch {
        // Corrupted cache entry — treat as miss, will re-parse
        this.corruptionCount++;
        if (this.corruptionCount >= this.maxCorruptionThreshold) {
          console.error(
            `[TagsCache] ${this.corruptionCount} corrupted entries — clearing disk cache`,
          );
          await this.clearDiskCache();
          await this.writeVersionFile();
        }
      }
    }

    return null;
  }

  /**
   * Store tags for a file in cache.
   * Failure to write to disk is non-fatal — memory cache is sufficient fallback.
   */
  async set(fname: string, tags: Tag[], queryMtime?: number | null): Promise<void> {
    const mtime = await this.getMtime(fname);
    if (mtime === null) return;

    const entry: CacheEntry = { mtime, queryMtime: queryMtime ?? null, tags };
    this.memoryCache.set(fname, entry);

    if (this.useFilePersistence) {
      try {
        const filePath = this.getFilePath(fname);
        if (filePath !== null) await fs.writeFile(filePath, JSON.stringify(entry), "utf-8");
      } catch {
        // Write failed — memory cache is sufficient fallback
      }
    }

    // Evict oldest entries when memory cache exceeds hard cap
    if (this.memoryCache.size > this.maxMemoryEntries) {
      const toEvict = this.memoryCache.size - this.maxMemoryEntries;
      let evicted = 0;
      for (const key of this.memoryCache.keys()) {
        if (evicted >= toEvict) break;
        this.memoryCache.delete(key);
        evicted++;
      }
    }
  }

  /** Clear memory cache only. Disk cache persists. */
  clear(): void {
    this.memoryCache.clear();
    this.dependentsFull = false;
    this.dependentsEdgeCount = 0;
    this.dependents.clear();
    this.parseTimings.clear();
    this.totalParseTimeMs = 0;
    this.parseCount = 0;
  }

  /**
   * Wipe disk cache directory entirely and re-create it empty.
   */
  async clearDiskCache(): Promise<void> {
    try {
      if (this.cacheDir !== null) {
        if (existsSync(this.cacheDir)) {
          await fs.rm(this.cacheDir, { recursive: true, force: true });
        }
        await fs.mkdir(this.cacheDir, { recursive: true, mode: 0o700 });
      }
      this.memoryCache.clear();
      this.corruptionCount = 0;
      this.dependentsFull = false;
      this.dependentsEdgeCount = 0;
      this.dependents.clear();
      this.parseTimings.clear();
      this.totalParseTimeMs = 0;
      this.parseCount = 0;
    } catch {
      this.useFilePersistence = false;
    }
  }

  /**
   * Recover from corruption: resets corruption count and optionally clears disk cache.
   */
  async recover(clearDisk = false): Promise<void> {
    this.corruptionCount = 0;
    if (clearDisk && this.useFilePersistence) {
      await this.clearDiskCache();
      await this.writeVersionFile();
    }
  }

  /** Number of entries in memory cache. */
  get size(): number {
    return this.memoryCache.size;
  }

  /** Current corruption count. */
  get corruptions(): number {
    return this.corruptionCount;
  }

  /** Whether disk persistence is active. */
  get hasDiskPersistence(): boolean {
    return this.useFilePersistence;
  }

  /**
   * Warm the cache by pre-loading entries from disk for known files.
   * Useful during initial scan to detect cache hits without checking each file.
   */
  async warm(fnames: string[]): Promise<void> {
    if (!this.useFilePersistence) return;

    try {
      for (const fname of fnames) {
        const mtime = await this.getMtime(fname);
        if (mtime === null) continue;

        const filePath = this.getFilePath(fname);
        if (filePath === null) continue;
        try {
          const raw = await fs.readFile(filePath, "utf-8");
          const entry = JSON.parse(raw) as CacheEntry;
          if (
            entry &&
            typeof entry.mtime === "number" &&
            entry.mtime === mtime &&
            Array.isArray(entry.tags)
          ) {
            this.memoryCache.set(fname, entry);
          }
        } catch {
          // skip corrupted entries during warm
        }
      }
    } catch {
      // Non-fatal
    }
  }

  // ── Incremental AST tracking ────────────────────────────────────

  /** Record parse timing for a file. */
  recordParseTime(fname: string, ms: number): void {
    this.parseTimings.set(fname, ms);
    this.totalParseTimeMs += ms;
    this.parseCount++;

    // Evict oldest entries when parseTimings exceeds hard cap
    if (this.parseTimings.size > this.maxParseTimingsEntries) {
      const toEvict = this.parseTimings.size - this.maxParseTimingsEntries;
      let evicted = 0;
      for (const key of this.parseTimings.keys()) {
        if (evicted >= toEvict) break;
        this.parseTimings.delete(key);
        evicted++;
      }
    }
  }

  /** Get parse performance stats. */
  getParseStats(): {
    totalParseTimeMs: number;
    parseCount: number;
    avgParseTimeMs: number;
    slowestFile?: { fname: string; ms: number };
    fastestFile?: { fname: string; ms: number };
  } {
    const avg = this.parseCount > 0 ? this.totalParseTimeMs / this.parseCount : 0;

    let slowest: { fname: string; ms: number } | undefined;
    let fastest: { fname: string; ms: number } | undefined;
    for (const [fname, ms] of this.parseTimings) {
      if (!slowest || ms > slowest.ms) slowest = { fname, ms };
      if (!fastest || ms < fastest.ms) fastest = { fname, ms };
    }

    return {
      totalParseTimeMs: this.totalParseTimeMs,
      parseCount: this.parseCount,
      avgParseTimeMs: Math.round(avg * 100) / 100,
      slowestFile: slowest,
      fastestFile: fastest,
    };
  }

  /**
   * Register a dependency: `importer` depends on `importee`.
   * When `importee` changes, we know `importer`'s tags may be stale.
   */
  addDependency(importee: string, importer: string): void {
    if (!this.trackDependencies) return;

    let deps = this.dependents.get(importee);
    const isNewEdge = !deps || !deps.has(importer);

    if (isNewEdge && this.dependentsEdgeCount >= this.maxDependentsEntries) {
      if (!this.dependentsFull) this.dependentsFull = true;
      return;
    }

    if (!deps) {
      deps = new Set();
      this.dependents.set(importee, deps);
    }
    if (isNewEdge) this.dependentsEdgeCount++;
    deps.add(importer);
  }

  /**
   * Invalidate a file's cached tags and all its dependents.
   * Returns the set of invalidated files for caller awareness.
   */
  async invalidateFile(fname: string, invalidated = new Set<string>()): Promise<Set<string>> {
    // Guard against cycles
    if (invalidated.has(fname)) return invalidated;
    invalidated.add(fname);

    // Remove from memory cache
    this.memoryCache.delete(fname);

    // Remove from disk
    if (this.useFilePersistence) {
      try {
        const filePath = this.getFilePath(fname);
        if (filePath !== null && existsSync(filePath)) {
          await fs.rm(filePath);
        }
      } catch {
        // Non-fatal
      }
    }

    // Cascade to dependents
    if (this.trackDependencies) {
      const deps = this.dependents.get(fname);
      if (deps) {
        for (const dependent of deps) {
          await this.invalidateFile(dependent, invalidated);
        }
        this.dependents.delete(fname);
      }
    }

    return invalidated;
  }

  /** Get number of tracked dependency edges (uses cached counter for O(1)). */
  get dependencyEdgeCount(): number {
    return this.dependentsEdgeCount;
  }

  /** Return capacity stats for monitoring memory caps. */
  getCapacityStats(): {
    memoryCache: { size: number; max: number };
    dependents: { edges: number; max: number; full: boolean };
    parseTimings: { entries: number; max: number };
  } {
    return {
      memoryCache: { size: this.memoryCache.size, max: this.maxMemoryEntries },
      dependents: { edges: this.dependentsEdgeCount, max: this.maxDependentsEntries, full: this.dependentsFull },
      parseTimings: { entries: this.parseTimings.size, max: this.maxParseTimingsEntries },
    };
  }

  /** Export dependency graph as plain object (for diagnostics) */
  exportDependencies(): Record<string, string[]> {
    const result: Record<string, string[]> = {};
    for (const [importee, importers] of this.dependents) {
      result[importee] = [...importers];
    }
    return result;
  }
}
