/**
 * Mtime-based file tag cache.
 * Caches tree-sitter tag results keyed by absolute file path.
 * Invalidates when file mtime changes.
 */
import { existsSync, statSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

export interface Tag {
  relFname: string;
  fname: string;
  line: number;
  name: string;
  kind: "def" | "ref";
}

interface CacheEntry {
  mtime: number;
  tags: Tag[];
}

export class TagsCache {
  private cacheDir: string;
  private memoryCache: Map<string, CacheEntry>;
  private useFilePersistence: boolean;

  constructor(root: string) {
    this.cacheDir = join(root, ".pi-smartread.tags.cache");
    this.memoryCache = new Map();
    this.useFilePersistence = false;
    this.initFilePersistence();
  }

  private initFilePersistence(): void {
    try {
      if (!existsSync(this.cacheDir)) {
        mkdirSync(this.cacheDir, { recursive: true });
      }
      this.useFilePersistence = true;
    } catch {
      this.useFilePersistence = false;
    }
  }

  private getFilePath(fname: string): string {
    const hash = createHash("sha256").update(fname).digest("hex");
    return join(this.cacheDir, `${hash}.json`);
  }

  private getMtime(fname: string): number | null {
    try {
      return statSync(fname).mtimeMs;
    } catch {
      return null;
    }
  }

  get(fname: string): Tag[] | null {
    const mtime = this.getMtime(fname);
    if (mtime === null) return null;

    // Check memory cache first
    const memEntry = this.memoryCache.get(fname);
    if (memEntry && memEntry.mtime === mtime) {
      return memEntry.tags;
    }

    // Check file persistence
    if (this.useFilePersistence) {
      try {
        const filePath = this.getFilePath(fname);
        if (existsSync(filePath)) {
          const raw = readFileSync(filePath, "utf-8");
          const entry: CacheEntry = JSON.parse(raw);
          if (entry.mtime === mtime) {
            // Promote to memory cache
            this.memoryCache.set(fname, entry);
            return entry.tags;
          }
        }
      } catch {
        // Corrupted cache entry — ignore
      }
    }

    return null;
  }

  set(fname: string, tags: Tag[]): void {
    const mtime = this.getMtime(fname);
    if (mtime === null) return;

    const entry: CacheEntry = { mtime, tags };
    this.memoryCache.set(fname, entry);

    if (this.useFilePersistence) {
      try {
        const filePath = this.getFilePath(fname);
        writeFileSync(filePath, JSON.stringify(entry), "utf-8");
      } catch {
        // Write failed — memory cache is sufficient fallback
      }
    }
  }

  clear(): void {
    this.memoryCache.clear();
  }

  get size(): number {
    return this.memoryCache.size;
  }
}
