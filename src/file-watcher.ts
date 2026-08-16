/**
 * File Watcher — debounced, descriptor-safe change detection.
 *
 * Uses stat-based polling by default, so external workspace changes always
 * invalidate stale retrieval state without consuming OS watch handles. Native
 * and chokidar watching remain opt-ins for environments with ample headroom.
 *
 * The watcher only detects changes and reports dirty paths.
 * Re-indexing is lazy — triggered by the next query, not by this module.
 *
 * FD cap: non-recursive mode creates one watcher per subdirectory. Its
 * conservative max-watcher-count cap (default 16) is used only when explicitly
 * enabled through `FILE_WATCHER_MODE=non-recursive` or WatcherOptions.
 */

import { watch, type FSWatcher } from "node:fs";
import { join, relative, resolve } from "node:path";
import { readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";

// ESM-safe optional require: this package is `"type": "module"`, so a bare
// `require` is undefined. createRequire yields a module-scoped require that
// resolves from this file's location, mirroring callgraph.ts/grammar-loader.ts.
const require = createRequire(import.meta.url);

// ── Config ─────────────────────────────────────────────────────────────────

const DEBOUNCE_MS = parseInt(
  process.env["FILE_WATCHER_DEBOUNCE_MS"] ?? "500",
  10,
);

/** Maximum watchers before graceful degradation (FD cap). */
const MAX_WATCHER_COUNT = parseInt(
  process.env["FILE_WATCHER_MAX_COUNT"] ?? "16",
  10,
);

/** Polling keeps freshness reliable without allocating native watch handles. */
const POLL_INTERVAL_MS = parseInt(
  process.env["FILE_WATCHER_POLL_INTERVAL_MS"] ?? "1000",
  10,
);

/**
 * Trees that do not contribute source changes and can contain thousands of
 * directories. Pi's subagent transcripts and artifacts are written during a
 * session, but are not workspace source and must not consume watcher handles.
 */
const WATCH_IGNORED_DIRECTORY = /(^|[/\\])(node_modules|\.git|dist|build|coverage|\.cache|\.next|\.pi-smartread[^/\\]*|\.pi-subagents|\.subagents|\.subagent-work|\.smart-edit-undo|graphify-out)([/\\]|$)/;

// ── Types ──────────────────────────────────────────────────────────────────

export interface WatcherOptions {
  /** Debounce window in ms. Default: 500 */
  debounceMs?: number;
  /** Maximum watcher count before degradation. Default: 16 */
  maxWatcherCount?: number;
  /** Force a specific mode. Default: descriptor-safe polling. */
  mode?: "polling" | "chokidar" | "recursive" | "non-recursive" | "none";
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
    return require("chokidar") as ChokidarModule;
  } catch {
    return null;
  }
}

/** Prevent a late native watcher failure from becoming an uncaught EventEmitter error. */
function guardNativeWatcher(watcher: FSWatcher, directory: string): void {
  const maybeOn = (watcher as FSWatcher & {
    on?: (event: string, listener: (error: Error) => void) => unknown;
  }).on;
  maybeOn?.call(watcher, "error", (error: Error) => {
    console.warn(`[file-watcher] Stopped watching ${directory}: ${error.message}`);
    try {
      watcher.close();
    } catch {
      // The watcher may already be closed after its error.
    }
  });
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
      if (WATCH_IGNORED_DIRECTORY.test(fullPath)) continue;
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

/** Capture source-file identity without retaining any filesystem handles. */
function scanFileState(root: string): Map<string, string> {
  const state = new Map<string, string>();
  const queue = [root];

  while (queue.length > 0) {
    const directory = queue.shift()!;
    let entries: string[];
    try {
      entries = readdirSync(directory);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const absolutePath = join(directory, entry);
      if (WATCH_IGNORED_DIRECTORY.test(absolutePath)) continue;
      try {
        const stat = statSync(absolutePath);
        if (stat.isDirectory()) {
          queue.push(absolutePath);
        } else if (stat.isFile()) {
          state.set(relative(root, absolutePath), `${stat.mtimeMs}:${stat.size}`);
        }
      } catch {
        // A file can disappear during a scan; it will be reconciled next pass.
      }
    }
  }

  return state;
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
      guardNativeWatcher(watcher, dir);
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
  const mode = options?.mode ?? watcherModeFromEnvironment();

  // Test-mode no-op: prevents FD leaks during test runs
  if (mode === "none" || process.env.VITEST || process.env.NODE_ENV === "test") {
    return () => {};
  }

  // A home directory is not a workspace: walking it at startup can take long
  // enough to prevent Pi opening, and native modes can consume its watcher
  // budget. This guard belongs here so every watcher mode is protected.
  if (resolvedRoot === resolve(homedir())) {
    return () => {};
  }

  if (mode === "polling") {
    return startPollingWatch(resolvedRoot, onDirty);
  }

  // Chokidar is explicit-only: even with ignored dependency trees it can open
  // enough handles to exhaust the process while Pi is loading extensions.
  if (mode === "chokidar") {
    const chokidar = tryRequireChokidar();
    if (chokidar) {
      return startChokidarWatch(resolvedRoot, onDirty, debounceMs, chokidar);
    }
    if (mode === "chokidar") {
      console.warn(
        `[file-watcher] chokidar not installed — falling back to native fs.watch for ${resolvedRoot}`,
      );
    }
  }

  // Explicit recursive mode attempts recursive everywhere and falls back (with
  // a warning) if the platform/runtime rejects it.
  if (mode === "recursive") {
    return startRecursiveWatch(resolvedRoot, onDirty, debounceMs, maxWatcherCount);
  }

  // Non-recursive fallback (or explicit mode)
  return startNonRecursiveWatch(resolvedRoot, onDirty, debounceMs, maxWatcherCount);
}

/**
 * Polling is the default because semantic results must become stale when agents
 * or users edit outside SmartRead. Invalid values also resolve to polling so a
 * typo never disables freshness tracking.
 */
function watcherModeFromEnvironment(): WatcherOptions["mode"] {
  const configured = process.env["FILE_WATCHER_MODE"];
  if (configured === "none" || configured === "polling" || configured === "chokidar" || configured === "recursive" || configured === "non-recursive") {
    return configured;
  }
  return "polling";
}

// ── Polling mode (default) ─────────────────────────────────────────────────

function startPollingWatch(
  root: string,
  onDirty: (paths: string[]) => void,
): () => void {
  const scan = (): Map<string, string> => scanFileState(root);
  let previous = scan();
  const intervalMs = Number.isFinite(POLL_INTERVAL_MS) && POLL_INTERVAL_MS > 0
    ? POLL_INTERVAL_MS
    : 1000;

  const timer = setInterval(() => {
    const next = scan();
    const dirtyPaths = new Set<string>();
    for (const [path, fingerprint] of next) {
      if (previous.get(path) !== fingerprint) dirtyPaths.add(path);
    }
    for (const path of previous.keys()) {
      if (!next.has(path)) dirtyPaths.add(path);
    }
    previous = next;
    if (dirtyPaths.size > 0) onDirty([...dirtyPaths]);
  }, intervalMs);
  timer.unref();

  return () => clearInterval(timer);
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
    ignored: (filePath: string) => WATCH_IGNORED_DIRECTORY.test(filePath),
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
  // Chokidar reports late setup failures asynchronously. Without this listener
  // EventEmitter treats EMFILE as fatal and terminates the entire Pi session.
  watcher.on("error", (error: unknown) => {
    console.warn(`[file-watcher] Chokidar disabled: ${(error as Error).message}`);
    void watcher.close();
  });

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
    guardNativeWatcher(watcher, root);
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
      guardNativeWatcher(watcher, dir);
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
    `[file-watcher] Descriptor-capped mode: watching ${watchers.length} directories. ` +
    `Set FILE_WATCHER_MAX_COUNT or mode:'chokidar' only if the process has sufficient FD headroom.`,
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
