/**
 * Merkle-tree incremental file indexing for Pi-SmartRead.
 *
 * Content-addressable file change detection using SHA-256 hashing.
 * Supports two-pass directory-level scanning, dirty propagation
 * through dependency graphs, and persistent cache at
 * `.pi-smartread/file-hashes.json`.
 *
 * Uses only Node.js built-in modules (fs, path, crypto).
 */
import { createHash } from "node:crypto";
import {
  readFileSync,
  readdirSync,
  statSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import {
  relative,
  resolve,
  dirname,
  join,
} from "node:path";

// ── Types ─────────────────────────────────────────────────────────

/** Per-file hash entry stored in the cache. */
export interface FileHashEntry {
  hash: string;
  mtimeMs: number;
  size: number;
}

/**
 * Serialisable file-hash cache.
 * Keys are paths relative to the project root (forward-slash-normalised).
 */
export interface FileHashCache {
  [filePath: string]: FileHashEntry;
}

/** Result of comparing current file tree against cached state. */
export interface IndexChangeSet {
  added: string[];
  modified: string[];
  deleted: string[];
  unchanged: string[];
}

/** Node in the dirty-propagation graph. */
export interface DirtyNode {
  path: string;
  reason: "direct_change" | "dependency_changed";
}

// ── Constants ─────────────────────────────────────────────────────

const CACHE_VERSION = 1;
const CACHE_RELPATH = ".pi-smartread/file-hashes.json";

// ── Disk cache persistence ─────────────────────────────────────────

/** On-disk format for the hash cache. */
interface SerializedCache {
  version: number;
  files: FileHashCache;
  /** Directory-relative-path → mtimeMs. Used for two-pass dir-level skip. */
  directories: Record<string, number>;
}

/** Get the absolute path to the cache file for a given project root. */
function cacheFilePath(root: string): string {
  return join(resolve(root), CACHE_RELPATH);
}

/**
 * Load the hash cache from disk.
 * Returns an empty cache if file doesn't exist, has wrong version,
 * or is corrupted.
 */
export function loadCache(cachePath: string): { files: FileHashCache; directories: Record<string, number> } {
  try {
    if (!existsSync(cachePath)) {
      return { files: {}, directories: {} };
    }
    const raw = readFileSync(cachePath, "utf-8");
    const parsed = JSON.parse(raw) as SerializedCache;
    if (parsed.version !== CACHE_VERSION) {
      return { files: {}, directories: {} };
    }
    return {
      files: parsed.files ?? {},
      directories: parsed.directories ?? {},
    };
  } catch {
    // Corrupted cache — return empty so caller rebuilds
    return { files: {}, directories: {} };
  }
}

/**
 * Save the hash cache to disk.
 * Creates parent directories if they don't exist.
 */
export function saveCache(
  cachePath: string,
  files: FileHashCache,
  directories: Record<string, number>,
): void {
  try {
    const dir = dirname(cachePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const data: SerializedCache = {
      version: CACHE_VERSION,
      files,
      directories,
    };
    writeFileSync(cachePath, JSON.stringify(data, null, 2), "utf-8");
  } catch {
    // Non-fatal — cache writes are advisory
  }
}

// ── Hashing ───────────────────────────────────────────────────────

/**
 * Compute SHA-256 hash of a file's contents.
 * Uses only Node.js built-in crypto (no external deps).
 */
export function hashFileSync(filePath: string): string {
  const content = readFileSync(filePath);
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Read file metadata (mtime + size) and optionally compute hash.
 * Returns null if file doesn't exist or can't be read.
 */
function statAndHash(
  filePath: string,
  computeHash: boolean,
): { mtimeMs: number; size: number; hash: string } | null {
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) return null;
    const hash = computeHash ? hashFileSync(filePath) : "";
    return { mtimeMs: stat.mtimeMs, size: stat.size, hash };
  } catch {
    return null;
  }
}

// ── File discovery helpers ───────────────────────────────────────

/** Normalise a path to forward-slash relative form. */
function relPath(root: string, absPath: string): string {
  return relative(root, absPath).replace(/\\/g, "/");
}

/** Default file filter: skip dot-files, node_modules, dot-dirs. */
function defaultFileFilter(filePath: string): boolean {
  const base = filePath.slice(filePath.lastIndexOf("/") + 1);
  if (base.startsWith(".")) return false;
  return true;
}

/** Directories always skipped during traversal. */
const HARD_SKIP_DIRS = new Set([
  ".git",
  ".svn",
  ".hg",
  "node_modules",
  ".pi-smartread",
  ".pi",
  ".yarn",
  ".pnp",
  ".turbo",
  ".next",
  ".nuxt",
  ".output",
  ".vercel",
  ".parcel-cache",
  ".svelte-kit",
  ".angular",
  "dist",
  "build",
  "coverage",
  ".nyc_output",
  "target",
  ".gradle",
  ".terraform",
  ".serverless",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".tox",
  ".venv",
  "venv",
  "env",
  "vendor",
  "Pods",
  ".bundle",
  ".gem",
  ".build",
  "graphify-out",
]);

// ── Two-pass scanning ─────────────────────────────────────────────

/**
 * Result of a directory traversal during change detection.
 */
interface ScanState {
  currentFiles: FileHashCache;
  currentDirectories: Record<string, number>;
}

/**
 * Collect file hashes and directory mtimes for a project tree.
 *
 * Walks the directory tree with `readdirSync` at every level so that
 * new files in deep subtrees are always detected. For each cached
 * file, a stat check compares mtime/size against the cache; only on
 * a mismatch is the file re-hashed. This keeps incremental cost
 * proportional to changed files rather than the whole tree, without
 * trusting ancestor directory mtimes to reflect subtree changes.
 *
 * @param rootDir - Absolute path to the project root.
 * @param cachedFiles - Previous file-hash cache (may be empty).
 * @param cachedDirs - Previous directory-mtime cache (may be empty).
 * @param fileFilter - Optional filter; return true to include file.
 */
export function scanTree(
  rootDir: string,
  cachedFiles: FileHashCache = {},
  _cachedDirs: Record<string, number> = {},
  fileFilter: (p: string) => boolean = defaultFileFilter,
): ScanState {
  const resolvedRoot = resolve(rootDir);
  const currentFiles: FileHashCache = {};
  const currentDirectories: Record<string, number> = {};

  function walk(dirAbs: string): void {
    const dirRel = relPath(resolvedRoot, dirAbs);

    // Record directory mtime for caching (root included)
    let dirMtime: number | undefined;
    try {
      dirMtime = statSync(dirAbs).mtimeMs;
    } catch {
      return; // Cannot stat — skip
    }
    currentDirectories[dirRel] = dirMtime;

    const prefix = dirRel === "" ? "" : dirRel + "/";

    // Re-hash or copy forward any cached files in this subtree by stat'ing them.
    // This catches content-only changes (e.g. on macOS where dir mtime does NOT
    // change when files inside are modified).
    for (const relFp of Object.keys(cachedFiles)) {
      if (relFp !== dirRel && !relFp.startsWith(prefix)) continue;
      const cached = cachedFiles[relFp]!;
      const absPath = join(resolvedRoot, relFp);
      let stat;
      try {
        stat = statSync(absPath);
      } catch {
        // File no longer exists — it will be detected as deleted below
        continue;
      }
      if (!stat.isFile()) continue;

      if (
        stat.mtimeMs === cached.mtimeMs &&
        stat.size === cached.size
      ) {
        currentFiles[relFp] = { ...cached };
      } else {
        // mtime or size changed — re-hash
        const info = statAndHash(absPath, true);
        if (info) {
          currentFiles[relFp] = info;
        }
      }
    }

    // Always readdir to detect new/removed files and subdirectories in this
    // subtree. Skipping readdir based on ancestor dir mtime is unsafe: a new
    // file under `src/deep/` does not propagate up to `src`'s mtime on every
    // filesystem, so we must walk every directory on every scan.
    let dirEntries: string[];
    try {
      dirEntries = readdirSync(dirAbs);
    } catch {
      return;
    }

    for (const name of dirEntries) {
      if (HARD_SKIP_DIRS.has(name)) continue;

      const absPath = join(dirAbs, name);

      let stat;
      try {
        stat = statSync(absPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        // Recurse into subdirectory
        walk(absPath);
      } else if (stat.isFile()) {
        if (!fileFilter(absPath)) continue;

        const relFp = relPath(resolvedRoot, absPath);
        if (currentFiles[relFp]) {
          // Already processed by the cached-loop above — skip
          continue;
        }
        // New file (not in cache) — hash it
        const info = statAndHash(absPath, true);
        if (info) {
          currentFiles[relFp] = info;
        }
      }
    }
    // Note: deleted files (in cache but not in current dirEntries) are detected
    // implicitly: they simply won't appear in currentFiles.
  }

  walk(resolvedRoot);
  return { currentFiles, currentDirectories };
}

// ── Change Detection ──────────────────────────────────────────────

/**
 * Detect which files changed between the current tree and a cached snapshot.
 *
 * @param rootDir - Absolute path to the project root.
 * @param previousCache - Previously cached file hashes.
 * @returns An IndexChangeSet categorising every file.
 */
export function detectChanges(
  rootDir: string,
  previousCache: FileHashCache,
): IndexChangeSet {
  const resolvedRoot = resolve(rootDir);

  // Load directory mtimes from serialised cache (currently informational —
  // scanTree walks every directory to avoid missing deep-tree changes).
  const { directories: loadedDirs } = loadCache(
    join(resolvedRoot, CACHE_RELPATH),
  );

  const { currentFiles } = scanTree(
    resolvedRoot,
    previousCache,
    loadedDirs,
  );

  return detectChangesFromMaps(previousCache, currentFiles);
}

/**
 * Hash all files in a directory tree (full scan, no caching).
 * Used for initial builds or forced rebuilds.
 *
 * @param rootDir - Absolute path to the project root.
 * @param fileFilter - Optional filter function.
 * @returns Map of relative file path → hash entry.
 */
export function hashDirectory(
  rootDir: string,
  fileFilter?: (p: string) => boolean,
): FileHashCache {
  const { currentFiles } = scanTree(
    rootDir,
    {}, // no cached files
    {}, // no cached dirs
    fileFilter,
  );
  return currentFiles;
}

// ── Cache management ──────────────────────────────────────────────

/**
 * Build or update the persistent hash cache for a project.
 *
 * On first run (no cache on disk), hashes everything.
 * On subsequent runs, scans the tree and re-hashes only files whose
 * mtime or size differs from the cache.
 *
 * Returns the change set so callers know what changed.
 */
export function buildCache(
  rootDir: string,
  fileFilter?: (p: string) => boolean,
): IndexChangeSet {
  const resolvedRoot = resolve(rootDir);
  const cachePath = cacheFilePath(resolvedRoot);
  const { files: prevFiles } = loadCache(cachePath);

  const firstRun = Object.keys(prevFiles).length === 0;

  if (firstRun) {
    // Full scan: hash everything, build complete cache
    const { currentFiles, currentDirectories } = scanTree(
      resolvedRoot,
      {}, // no cache
      {}, // no cached dirs
      fileFilter ?? defaultFileFilter,
    );
    saveCache(cachePath, currentFiles, currentDirectories);

    const allPaths = Object.keys(currentFiles);
    return {
      added: allPaths,
      modified: [],
      deleted: [],
      unchanged: [],
    };
  }

  // Incremental: scan and re-hash only files whose mtime/size changed
  const { currentFiles, currentDirectories } = scanTree(
    resolvedRoot,
    prevFiles,
    {}, // dir mtime cache no longer drives skip logic
    fileFilter ?? defaultFileFilter,
  );

  saveCache(cachePath, currentFiles, currentDirectories);

  return detectChangesFromMaps(prevFiles, currentFiles);
}

/** Compute change set from old and new file-hash maps. */
function detectChangesFromMaps(
  oldCache: FileHashCache,
  newCache: FileHashCache,
): IndexChangeSet {
  const result: IndexChangeSet = {
    added: [],
    modified: [],
    deleted: [],
    unchanged: [],
  };

  const oldPaths = new Set(Object.keys(oldCache));
  const newPaths = new Set(Object.keys(newCache));

  for (const fp of newPaths) {
    const oldEntry = oldCache[fp];
    if (!oldEntry) {
      result.added.push(fp);
    } else if (newCache[fp]!.hash !== oldEntry.hash) {
      result.modified.push(fp);
    } else {
      result.unchanged.push(fp);
    }
  }

  for (const fp of oldPaths) {
    if (!newPaths.has(fp)) {
      result.deleted.push(fp);
    }
  }

  return result;
}

/**
 * Invalidate the on-disk hash cache for a project.
 * Forces next buildCache() to do a full scan.
 */
export function invalidateCache(rootDir: string): void {
  const cachePath = cacheFilePath(resolve(rootDir));
  try {
    const data: SerializedCache = { version: CACHE_VERSION, files: {}, directories: {} };
    const dir = dirname(cachePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(cachePath, JSON.stringify(data), "utf-8");
  } catch {
    // Non-fatal
  }
}

// ── Dirty Propagation ─────────────────────────────────────────────

/**
 * Propagate dirtiness through a dependency graph.
 *
 * Given a list of directly changed files and a dependency graph
 * (file → files that depend on it), returns all files that need
 * re-indexing including transitive dependents.
 *
 * @param changedFiles - Files that changed directly.
 * @param dependencyGraph - Map of file → list of files that depend on it.
 * @returns Full list of dirty files including transitive dependents.
 */
export function computeDirtyPropagation(
  changedFiles: string[],
  dependencyGraph: Map<string, string[]>,
): DirtyNode[] {
  const result: DirtyNode[] = [];
  const visited = new Set<string>();

  function walk(node: string, reason: "direct_change" | "dependency_changed"): void {
    if (visited.has(node)) return;
    visited.add(node);
    result.push({ path: node, reason });
    const deps = dependencyGraph.get(node);
    if (deps) {
      for (const dep of deps) {
        walk(dep, "dependency_changed");
      }
    }
  }

  for (const file of changedFiles) {
    walk(file, "direct_change");
  }

  return result;
}

// ── Factory ───────────────────────────────────────────────────────

/**
 * Create an incremental index instance for a project root.
 *
 * Provides a high-level API for building/loading hash caches
 * and detecting file changes incrementally.
 */
export function createIncrementalIndex(root: string) {
  const resolvedRoot = resolve(root);

  let cachedFiles: FileHashCache = {};
  let cachedDirs: Record<string, number> = {};
  let loaded = false;

  function ensureLoaded(): void {
    if (!loaded) {
      const loadedCache = loadCache(cacheFilePath(resolvedRoot));
      cachedFiles = loadedCache.files;
      cachedDirs = loadedCache.directories;
      loaded = true;
    }
  }

  return {
    /**
     * Get the current change set by comparing the file tree against
     * the cached state. Walks the full tree and re-hashes only files
     * whose mtime or size differs from the cache.
     */
    getChanges(fileFilter?: (p: string) => boolean): IndexChangeSet {
      ensureLoaded();
      const { currentFiles, currentDirectories } = scanTree(
        resolvedRoot,
        cachedFiles,
        cachedDirs,
        fileFilter ?? defaultFileFilter,
      );

      const changes = detectChangesFromMaps(cachedFiles, currentFiles);

      // Persist updated cache
      saveCache(cacheFilePath(resolvedRoot), currentFiles, currentDirectories);
      cachedFiles = currentFiles;
      cachedDirs = currentDirectories;

      return changes;
    },

    /**
     * Force a full rebuild of the hash cache (ignore existing cache).
     */
    forceRebuild(fileFilter?: (p: string) => boolean): IndexChangeSet {
      const { currentFiles, currentDirectories } = scanTree(
        resolvedRoot,
        {}, // no cache — full scan
        {}, // no cached dirs — scan all dirs
        fileFilter ?? defaultFileFilter,
      );

      saveCache(cacheFilePath(resolvedRoot), currentFiles, currentDirectories);
      cachedFiles = currentFiles;
      cachedDirs = currentDirectories;
      loaded = true;

      const allPaths = Object.keys(currentFiles);
      return {
        added: allPaths,
        modified: [],
        deleted: [],
        unchanged: [],
      };
    },

    /** Check whether there is a persisted cache on disk. */
    hasCache(): boolean {
      const path = cacheFilePath(resolvedRoot);
      try {
        if (!existsSync(path)) return false;
        const raw = readFileSync(path, "utf-8");
        const parsed = JSON.parse(raw) as SerializedCache;
        return parsed.version === CACHE_VERSION && Object.keys(parsed.files ?? {}).length > 0;
      } catch {
        return false;
      }
    },

    /** Invalidate the on-disk cache. */
    invalidate(): void {
      invalidateCache(resolvedRoot);
      cachedFiles = {};
      cachedDirs = {};
      loaded = true;
    },
  };
}

/**
 * Get or create an incremental index for a project root.
 * Maintains a shared instance per root path for reuse across the session.
 */
const _indexInstances = new Map<string, ReturnType<typeof createIncrementalIndex>>();

export function getIncrementalIndex(root: string): ReturnType<typeof createIncrementalIndex> {
  const resolvedRoot = resolve(root);
  let idx = _indexInstances.get(resolvedRoot);
  if (!idx) {
    idx = createIncrementalIndex(resolvedRoot);
    _indexInstances.set(resolvedRoot, idx);
  }
  return idx;
}

export function clearIncrementalIndexInstance(root?: string): void {
  if (root) {
    _indexInstances.delete(resolve(root));
  } else {
    _indexInstances.clear();
  }
}
