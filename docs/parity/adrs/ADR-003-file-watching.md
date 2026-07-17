# ADR-003: File Watching vs Snapshot Invalidation

**Status:** Proposed
**Date:** 2026-07-16
**Deciders:** Pi-SmartRead parity design

## Context

DeusData/codebase-memory-mcp runs a background watcher that polls git HEAD and triggers supervised subprocess re-indexing on change. Pi-SmartRead currently uses snapshot-based invalidation: `IncrementalIndex` compares source hashes at query time, and `FS scan cache` is invalidated on detected mutations (write/edit/graph_mutate tool events).

The parity target includes a file-watching system that provides real-time invalidation of caches and indexes during long-running agent sessions.

Node.js provides `fs.watch` (platform-specific, unreliable for recursive watching) and the `chokidar` library (mature, cross-platform, recursive, debounced). Pi-SmartRead must decide between:

1. **chokidar-based watcher** — add a dependency, richer event model, cross-platform
2. **fs.watch fallback** — no dependency, platform quirks, no recursive on Linux
3. **Keep snapshot-only** — no watcher, rely on `tool_call` events for mutation detection

## Decision

**Use `fs.watch` for the common path, with `chokidar` as an optional opt-in.** The watcher runs during active Pi sessions, not as a persistent daemon.

### Strategy

1. Create `src/file-watcher.ts` — new dependency-free module
2. On session start, call `startWatching(root)` which:
   - Uses `fs.watch(root, { recursive: true })` on macOS/Windows (both support recursive)
   - Falls back to non-recursive `fs.watch` on Linux with a warning log (Linux recursive is unreliable; users can install chokidar for Linux recursive support)
3. On file change events (debounced 500ms), the watcher:
   - Invalidates the FS scan cache for affected paths
   - Marks `ContextGraph` as dirty (next query triggers incremental rebuild)
   - Invalidates `SemanticIndex` file state for affected paths (next query re-indexes)
   - Logs change count at debug level
4. On session end, call `stopWatching()` to remove all watchers
5. Chokidar auto-detection: on non-Linux platforms (`!IS_LINUX`), `try { require("chokidar") }` is attempted before falling back to native `fs.watch`. If chokidar is found, it handles recursive watching reliably on all platforms. **Linux is excluded from auto-detection** — the `!IS_LINUX` guard skips the `require("chokidar")` attempt on Linux. Linux users who want chokidar-based watching must install chokidar as a dependency and explicitly configure `mode: 'chokidar'` in `WatcherOptions`. Without that, Linux defaults to non-recursive `fs.watch`.

### Linux non-recursive fallback

When chokidar is unavailable on Linux (`fs.watch` does not support recursive), the fallback:
- Uses `collectDirectories()` to recursively discover all subdirectories up front (BFS from root)
- Creates one `fs.watch` per subdirectory (each watches its immediate children)
- Caps at `maxWatcherCount=256` directories to prevent FD exhaustion; emits `console.warn` when cap is hit
- Logs: `[file-watcher] Linux non-recursive mode: watching N directories. Install chokidar for recursive support.`

### Rationale

- Zero added dependencies for the default path (`fs.watch` is built into Node.js).
- `fs.watch` recursive works on macOS (Pi's primary dev platform) and Windows.
- Linux recursive watching via `fs.watch` is unreliable (kernel limitation). The fallback to non-recursive with a log warning is acceptable — Linux users can install `chokidar` for full support, or the agent can manually trigger re-indexing by running a query.
- The watcher is a "hint" layer, not a correctness requirement. Snapshot-based invalidation remains the safety net: even if the watcher misses a change, the next `IncrementalIndex.diff()` catches it.
- Debouncing (500ms) prevents thrashing during git operations and multi-file saves.
- No subprocess model — Node.js is the managed runtime, no RSS isolation needed (unlike the reference C binary).

### Scope boundary

The watcher only watches for changes — it does NOT trigger re-indexing. It marks caches dirty. Re-indexing happens lazily on the next query. This avoids unbounded background work during active agent sessions.

## Consequences

### Positive
- Real-time invalidation means the agent sees fresh state without manual re-indexing
- Zero dependencies by default
- Degrades gracefully (snapshot-based detection is the safety net)
- No background work — lazy re-indexing only on query

### Negative
- Linux users without chokidar get degraded watching (non-recursive only)
- `fs.watch` can emit duplicate events (mitigated by debouncing)
- Watcher handles (file descriptors) count could be high for very large repos on Linux (non-recursive means one watcher per directory). Mitigated by limiting to top-level directories or falling back to chokidar.

### Alternatives Considered

1. **chokidar as hard dependency (rejected):** Adds ~500KB to install size. The Pi extension ecosystem values minimal dependencies. The opt-in model gives users the choice.
2. **Git-polling watcher like reference (rejected):** Polling is wasteful for Node.js — the event loop can handle native FS events efficiently. Git polling would require spawning `git` processes.
3. **No watcher — only snapshot (rejected):** Insufficient for parity. Agent can go many turns without triggering a mutation-detected tool_call (it may be reading, searching, planning). A file change from an external editor or git checkout would go undetected until explicit re-query.
4. **inotify native bindings (rejected):** Adds native module compilation complexity. chokidar/fs.watch is sufficient.

## Validation

- [ ] Watcher detects file add/modify/delete during active session
- [ ] Debouncing prevents duplicate invalidation within 500ms window
- [ ] Watcher stops cleanly on session end (no FD leaks)
- [ ] Linux non-recursive fallback logs warning, does not crash
- [ ] chokidar opt-in path works when package is installed
- [ ] No watcher-related flake in test suite (watcher disabled in test env)
