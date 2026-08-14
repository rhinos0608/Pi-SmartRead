/**
 * File Watcher — debounced fs.watch-based change detection with chokidar opt-in.
 *
 * Uses `fs.watch(root, { recursive: true })` on macOS/Windows.
 * Falls back to non-recursive on Linux (one watcher per subdirectory).
 * Optional chokidar detection: `try { require("chokidar") } catch {}`.
 *
 * The watcher only detects changes and reports dirty paths.
 * Re-indexing is lazy — triggered by the next query, not by this module.
 *
 * FD cap: Linux non-recursive mode creates one watcher per subdirectory.
 * A max-watcher-count cap (default 256) prevents FD exhaustion.
 */

import { watch, type FSWatcher } from "node:fs";
import { join, relative, resolve } from "node:path";
import { readdirSync, statSync } from "node:fs";

// ── Config ─────────────────────────────────────────────────────────────────

const DEBOUNCE_MS = parseInt(
  process.env["FILE_WATCHER_DEBOUNCE_MS"] ?? "500",
  10,
);

/** Maximum watchers before graceful degradation (FD cap). */
const MAX_WATCHER_COUNT = parseInt(
  process.env["FILE_WATCHER_MAX_COUNT"] ?? "256",
  10,
);

// ── Platform detection ──────────────────────────────────────────────────────

const IS_LINUX = process.platform === "linux";
const SUPPORTS_RECURSIVE = process.platform === "darwin" || process.platform === "win32";

// ── Types ──────────────────────────────────────────────────────────────────

export interface WatcherOptions {
  /** Debounce window in ms. Default: 500 */
  debounceMs?: number;
  /** Maximum watcher count before degradation. Default: 256 */
  maxWatcherCount?: number;
  /** Force a specific mode: "chokidar", "recursive", "non-recursive", or "none" */
  mode?: "chokidar" | "recursive" | "non-recursive" | "none";
}

// ── Chokidar detection ─────────────────────────────────────────────────────

interface ChokidarWatcher {
  on(event: string, cb: (path: string) => void): ChokidarWatcher;
  close(): Promise<void>;
}

type ChokidarModule = {
  watch(
    paths: string | string[],
    options?: Record<string, unknown>,
  ): ChokidarWatcher;
};

function tryRequireChokidar(): ChokidarModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("chokidar") as ChokidarModule;
  } catch {
    return null;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Recursively collect subdirectories up to maxCount.
 * Returns array of absolute directory paths (including root).
 */
function collectDirectories(
  root: string,
  maxCount: number,
): string[] {
  const dirs: string[] = [root];
  const queue = [root];

  while (queue.length > 0 && dirs.length < maxCount) {
    const current = queue.shift()!;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (dirs.length >= maxCount) break;
      const fullPath = join(current, entry);
      try {
        if (statSync(fullPath).isDirectory()) {
          dirs.push(fullPath);
          queue.push(fullPath);
        }
      } catch {
        // skip unreadable
      }
    }
  }

  return dirs;
}

/** Watch directory and all discovered descendants with non-recursive watchers. */
function watchDirectoryTree(
  absPath: string,
  root: string,
  watchers: FSWatcher[],
  maxWatcherCount: number,
  onDirty: (relativePath: string) => void,
  scheduleFlush: () => void,
  watchedDirs?: Set<string>,
  pathToWatcher?: Map<string, FSWatcher>,
): void {
  const remaining = maxWatcherCount - watchers.length;
  if (remaining <= 0) {
    console.warn(
      `[file-watcher] Reached watcher cap (${maxWatcherCount}) during dynamic discovery. ` +
      `Some subdirectories will not be watched.`,
    );
    return;
  }

  const dirs = collectDirectories(absPath, remaining);
  for (const dir of dirs) {
    if (watchers.length >= maxWatcherCount) break;
    // If directory was previously watched (e.g. deleted and recreated),
    // close the stale watcher and remove it from tracking sets.
    if (pathToWatcher?.has(dir)) {
      try {
        pathToWatcher.get(dir)!.close();
      } catch { /* already closed */ }
      const idx = watchers.indexOf(pathToWatcher.get(dir)!);
      if (idx !== -1) watchers.splice(idx, 1);
      pathToWatcher.delete(dir);
      watchedDirs?.delete(dir);
    }
    // Skip already-watched directories to prevent duplicate watchers on rename events.
    if (watchedDirs?.has(dir)) continue;
    try {
      const watcher = watch(dir, (_event, filename) => {
        if (filename === null) return;
        onDirty(relative(root, join(dir, filename)));
        scheduleFlush();

        // Dynamic directory discovery: if a rename creates a new dir, watch it
        if (_event === "rename") {
          const absPath2 = join(dir, filename);
          try {
            if (statSync(absPath2).isDirectory()) {
              watchDirectoryTree(
                absPath2,
                root,
                watchers,
                maxWatcherCount,
                onDirty,
                scheduleFlush,
                watchedDirs,
                pathToWatcher,
              );
            }
          } catch { /* statSync failed — not a real path, ignore */ }
        }
      });
      watchers.push(watcher);
      pathToWatcher?.set(dir, watcher);
      // Only mark as watched AFTER the watcher was created successfully, so a
      // dir that failed initial watch can be retried by dynamic discovery.
      watchedDirs?.add(dir);
    } catch {
      // Ignore per-directory errors during dynamic discovery.
    }
  }

  if (watchers.length >= maxWatcherCount) {
    console.warn(
      `[file-watcher] Reached watcher cap (${maxWatcherCount}) during dynamic discovery. ` +
      `Some subdirectories will not be watched.`,
    );
  }
}

// ── Main API ───────────────────────────────────────────────────────────────

/**
 * Start watching a directory tree for file changes.
 *
 * @param root - Directory to watch (absolute path).
 * @param onDirty - Callback with batch of dirty relative paths (debounced).
 * @param options - Watcher configuration.
 * @returns Stop function — call to close all watchers.
 */
export function startWatching(
  root: string,
  onDirty: (paths: string[]) => void,
  options?: WatcherOptions,
): () => void {
  const resolvedRoot = resolve(root);
  const debounceMs = options?.debounceMs ?? DEBOUNCE_MS;
  const maxWatcherCount = options?.maxWatcherCount ?? MAX_WATCHER_COUNT;
  const mode = options?.mode;

  // Test-mode no-op: prevents FD leaks during test runs
  if (mode === "none" || process.env.VITEST || process.env.NODE_ENV === "test") {
    return () => {};
  }

  // Detect chokidar opt-in
  if (mode === "chokidar" || (!mode && !IS_LINUX)) {
    const chokidar = tryRequireChokidar();
    if (chokidar) {
      return startChokidarWatch(resolvedRoot, onDirty, debounceMs, chokidar);
    }
  }

  // Determine watch mode
  if (SUPPORTS_RECURSIVE && mode !== "non-recursive") {
    return startRecursiveWatch(resolvedRoot, onDirty, debounceMs, maxWatcherCount);
  }

  // Linux non-recursive fallback (or explicit mode)
  return startNonRecursiveWatch(resolvedRoot, onDirty, debounceMs, maxWatcherCount);
}

// ── Chokidar mode ──────────────────────────────────────────────────────────

function startChokidarWatch(
  root: string,
  onDirty: (paths: string[]) => void,
  debounceMs: number,
  chokidar: ChokidarModule,
): () => void {
  let pendingPaths = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    timer = null;
    if (pendingPaths.size > 0) {
      const paths = [...pendingPaths];
      pendingPaths = new Set();
      onDirty(paths);
    }
  };

  const watcher = chokidar.watch(root, {
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: false,
  });

  const handler = (filePath: string) => {
    const rel = relative(root, filePath);
    pendingPaths.add(rel);
    // True debounce: reset timer on every new event
    if (timer !== null) {
      clearTimeout(timer);
    }
    timer = setTimeout(flush, debounceMs);
  };

  watcher.on("change", handler);
  watcher.on("add", handler);
  watcher.on("unlink", handler);

  return () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    void watcher.close();
  };
}

// ── Recursive mode (macOS/Windows) ────────────────────────────────────────

function startRecursiveWatch(
  root: string,
  onDirty: (paths: string[]) => void,
  debounceMs: number,
  maxWatcherCount: number,
): () => void {
  let pendingPaths = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const watchers: FSWatcher[] = [];

  const flush = () => {
    timer = null;
    if (pendingPaths.size > 0) {
      const paths = [...pendingPaths];
      pendingPaths = new Set();
      onDirty(paths);
    }
  };

  const handler = (_event: string, filename: string | null) => {
    if (filename === null) return;
    const rel = filename;
    pendingPaths.add(rel);
    // True debounce: reset timer on every new event
    if (timer !== null) {
      clearTimeout(timer);
    }
    timer = setTimeout(flush, debounceMs);
  };

  try {
    const watcher = watch(root, { recursive: true }, handler);
    watchers.push(watcher);
  } catch (err) {
    console.warn(
      `[file-watcher] Failed to start recursive watcher on ${root}: ${(err as Error).message} — falling back to non-recursive`,
    );
    return startNonRecursiveWatch(root, onDirty, debounceMs, maxWatcherCount);
  }

  return () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    for (const w of watchers) {
      w.close();
    }
  };
}

// ── Non-recursive mode (Linux fallback) ────────────────────────────────────

function startNonRecursiveWatch(
  root: string,
  onDirty: (paths: string[]) => void,
  debounceMs: number,
  maxWatcherCount: number,
): () => void {
  let pendingPaths = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const watchers: FSWatcher[] = [];

  const flush = () => {
    timer = null;
    if (pendingPaths.size > 0) {
      const paths = [...pendingPaths];
      pendingPaths = new Set();
      onDirty(paths);
    }
  };

  const dirs = collectDirectories(root, maxWatcherCount);
  const watchedDirs = new Set<string>();  // Only successful watchers (dedup)
  const pathToWatcher = new Map<string, FSWatcher>();  // Track path-to-watcher ownership

  if (dirs.length >= maxWatcherCount) {
    console.warn(
      `[file-watcher] Reached watcher cap (${maxWatcherCount}). ` +
      `Some subdirectories will not be watched. Install chokidar for full coverage.`,
    );
  }

  const scheduleFlush = () => {
    if (timer !== null) {
      clearTimeout(timer);
    }
    timer = setTimeout(flush, debounceMs);
  };

  for (const dir of dirs) {
    try {
      const watcher = watch(dir, (_event, filename) => {
        if (filename === null) return;
        const absPath = join(dir, filename);
        const rel = relative(root, absPath);
        pendingPaths.add(rel);
        scheduleFlush();

        // Dynamic directory discovery: if a rename creates a new dir, watch it
        if (_event === "rename") {
          try {
            if (statSync(absPath).isDirectory()) {
              watchDirectoryTree(
                absPath,
                root,
                watchers,
                maxWatcherCount,
                (path) => pendingPaths.add(path),
                scheduleFlush,
                watchedDirs,
                pathToWatcher,
              );
            }
          } catch (_e) {
            // statSync failed — not a real path, ignore
          }
        }
      });
      watchers.push(watcher);
      pathToWatcher.set(dir, watcher);
      // Only mark as watched AFTER the watcher was created successfully, so a
      // dir that failed initial watch can be retried by dynamic discovery.
      watchedDirs.add(dir);
    } catch (err) {
      console.warn(
        `[file-watcher] Failed to watch ${dir}: ${(err as Error).message}`,
      );
    }
  }

  console.warn(
    `[file-watcher] Linux non-recursive mode: watching ${watchers.length} directories. ` +
    `Install chokidar for recursive support.`,
  );

  return () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    for (const w of watchers) {
      w.close();
    }
  };
}
