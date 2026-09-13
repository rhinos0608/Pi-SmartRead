/**
 * Persistent embedding cache — survives process restarts.
 *
 * Extends the in-memory LRU with disk-based serialization.
 * Cache entries are keyed by a content hash of the embedding request
 * (baseUrl + model + query + sorted inputs), so identical requests
 * produce cache hits regardless of calling context.
 *
 * Stored in: .pi-smartread.embeddings.cache/
 *
 * Design:
 *   - Memory-first: check LRU, then disk
 *   - Write-through: set LRU + disk simultaneously
 *   - SHA-256 content hashing for keys
 *   - Size-limited: max entries configurable (default 128)
 *   - JSON serialization of float arrays
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync } from "node:fs";
import { join, parse, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { EmbedRequest, EmbedResult } from "./embedding.js";
import { embeddingProfileId } from "./embedding-profile.js";

const DEFAULT_MAX_ENTRIES = 128;
const CACHE_DIRNAME = ".pi-smartread.embeddings.cache";

interface DiskCacheEntry {
  hash: string;
  vectors: number[][];
  createdAt: number;
}

export class PersistentEmbeddingCache {
  private lru: Map<string, EmbedResult>;
  private cacheDir: string;
  private usePersistence: boolean;
  private maxEntries: number;

  constructor(root: string, maxEntries: number = DEFAULT_MAX_ENTRIES) {
    this.lru = new Map();
    this.maxEntries = maxEntries;
    this.cacheDir = join(root, CACHE_DIRNAME);
    this.usePersistence = false;
    // Filesystem roots are shared across unrelated tests and processes, so
    // disk entries written by one fake-embedder test leak into another with
    // identical query and inputs (order-dependent hits; drive roots are
    // writable on Windows while permission-denied on Linux masked it).
    // Keep memory LRU only for such roots. Parse the resolved path: on
    // Windows resolve("/") yields the drive root (e.g. "D:\\") while
    // parse("/").root does not, so comparing against the raw input misses.
    let resolved: string;
    try {
      resolved = resolve(root);
      const { root: parsedRoot } = parse(resolved);
      if (resolved === parsedRoot) return;
    } catch {
      return;
    }
    // Stub roots (e.g. "/" or "/workspace/repo" in tests) must not gain a
    // cache directory: on Windows mkdir -p would succeed under the drive
    // root and leak entries across tests, and pollute the filesystem.
    try {
      if (!statSync(resolved).isDirectory()) return;
    } catch {
      return;
    }

    try {
      if (!existsSync(this.cacheDir)) {
        mkdirSync(this.cacheDir, { recursive: true });
      }
      this.usePersistence = true;
      // Load disk entries into in-memory index (not full data — lazy load)
      this.warmCache();
    } catch {
      this.usePersistence = false;
    }
  }

  /**
   * Compute a cache key from an embedding request.
   */
  static computeKey(req: EmbedRequest, query: string, inputs: string[]): string {
    const payload = JSON.stringify({
      baseUrl: req.baseUrl.replace(/\/+$/, ""),
      model: req.model,
      profile: embeddingProfileId(req.model),
      query,
      inputs: [...inputs],
      inputTypes: req.inputTypes,
      inputTitles: req.inputTitles,
    });
    return createHash("sha256").update(payload).digest("hex").slice(0, 16);
  }

  private getFilePath(hash: string): string {
    return join(this.cacheDir, `${hash}.json`);
  }

  /**
   * Check the cache (LRU → disk).
   */
  get(key: string): EmbedResult | null {
    // Check memory
    const memResult = this.lru.get(key);
    if (memResult) {
      // Promote to most recent
      this.lru.delete(key);
      this.lru.set(key, memResult);
      return memResult;
    }

    // Check disk
    if (this.usePersistence) {
      try {
        const filePath = this.getFilePath(key);
        if (existsSync(filePath)) {
          const raw = readFileSync(filePath, "utf-8");
          const entry: DiskCacheEntry = JSON.parse(raw);
          if (entry.hash === key) {
            const result: EmbedResult = { vectors: entry.vectors };
            // Promote to memory
            this.lru.set(key, result);
            this.evictIfNeeded();
            return result;
          }
        }
      } catch {
        // Corrupted entry — ignore
      }
    }

    return null;
  }

  /**
   * Store a result (write-through: LRU + disk).
   * Respects maxEntries for both memory and disk.
   */
  set(key: string, result: EmbedResult): void {
    // LRU
    this.lru.set(key, result);
    this.evictIfNeeded();

    // Disk
    if (this.usePersistence) {
      try {
        const entry: DiskCacheEntry = {
          hash: key,
          vectors: result.vectors,
          createdAt: Date.now(),
        };
        writeFileSync(this.getFilePath(key), JSON.stringify(entry), "utf-8");
        this.evictDiskIfNeeded();
      } catch {
        // Non-fatal: memory cache is sufficient
      }
    }
  }

  private evictIfNeeded(): void {
    while (this.lru.size > this.maxEntries) {
      const oldest = this.lru.keys().next().value;
      if (oldest !== undefined) {
        this.lru.delete(oldest);
      } else {
        break;
      }
    }
  }

  /**
   * Evict the oldest disk entries when exceeding maxEntries.
   * Keeps disk from growing unbounded while maintaining LRU semantics.
   */
  private evictDiskIfNeeded(): void {
    if (!this.usePersistence) return;
    try {
      const entries = readdirSync(this.cacheDir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => {
          const filePath = join(this.cacheDir, f);
          try {
            const raw = readFileSync(filePath, "utf-8");
            const entry: DiskCacheEntry = JSON.parse(raw);
            return { name: f, createdAt: entry.createdAt };
          } catch {
            return { name: f, createdAt: 0 };
          }
        })
        .sort((a, b) => a.createdAt - b.createdAt); // oldest first

      while (entries.length > this.maxEntries) {
        const oldest = entries.shift();
        if (oldest) {
          try { rmSync(join(this.cacheDir, oldest.name)); } catch { /* skip */ }
        }
      }
    } catch {
      // Non-fatal
    }
  }

  /**
   * Verify disk cache integrity on construction.
   * Does not pre-load entries into memory (lazy loading is used instead).
   */
  private warmCache(): void {
    try {
      // Discover what entries exist on disk — individual entries are
      // lazy-loaded via get(). No need to populate memory here.
      const entries = readdirSync(this.cacheDir);
      const jsonCount = entries.filter((f) => f.endsWith(".json")).length;
      // If there are more disk entries than the memory limit,
      // evict excess old entries to enforce maxEntries on disk.
      if (jsonCount > this.maxEntries) {
        this.evictDiskIfNeeded();
      }
    } catch {
      // Non-fatal
    }
  }

  /** Number of entries in memory cache. */
  get size(): number {
    return this.lru.size;
  }

  /** Whether disk persistence is active. */
  get hasPersistence(): boolean {
    return this.usePersistence;
  }

  /** Number of cached entries on disk */
  get diskEntries(): number {
    if (!this.usePersistence) return 0;
    try {
      return readdirSync(this.cacheDir).filter((f) => f.endsWith(".json")).length;
    } catch {
      return 0;
    }
  }

  /** Clear both memory and disk cache. */
  clear(): void {
    this.lru.clear();
    if (this.usePersistence) {
      try {
        const entries = readdirSync(this.cacheDir);
        for (const entry of entries) {
          if (entry.endsWith(".json")) {
            try { rmSync(join(this.cacheDir, entry)); } catch { /* skip */ }
          }
        }
      } catch { /* skip */ }
    }
  }
}
