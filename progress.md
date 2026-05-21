# Progress

## Status
In Progress

## Tasks

- [x] P3a: Create `fs-scan-cache.ts` with TTL-based LRU cache
- [x] P3a: Integrate cache into `file-discovery.ts`
- [x] P3a: Export from `index.ts` (cache invalidation on write/edit)
- [x] P3a: Add unit tests in `test/unit/fs-scan-cache.test.ts`

## Files Changed

- `fs-scan-cache.ts` (new) — TTL-based LRU cache for cross-tool FS scan sharing
- `file-discovery.ts` (modified) — wrapped `findSrcFiles` and `findSrcFilesWithContextMode` with cache
- `index.ts` (modified) — added `invalidateFsScanCache` import and cache invalidation on write/edit/graph_mutate tool calls
- `test/unit/fs-scan-cache.test.ts` (new) — 10 tests covering cache operations, LRU eviction, invalidation, cache key uniqueness, cacheAgeMs, and global instance

## Implementation Details

### fs-scan-cache.ts

- `FsScanCache<T>` class with configurable TTL, empty-recheck window, and max entries
- `getOrScan(root, scanFn)` — returns cached results or runs scan
- `forceRescan(root, scanFn)` — bypasses cache and re-caches
- `invalidatePath(target)` — removes cache entries covering the target path
- `invalidateAll()` — clears entire cache
- LRU eviction: tracks access count, evicts lowest-score entry when capacity exceeded
- Default config: TTL=1000ms, emptyRecheck=200ms, maxEntries=16
- Configurable via env vars: `FS_SCAN_CACHE_TTL_MS`, `FS_SCAN_EMPTY_RECHECK_MS`, `FS_SCAN_CACHE_MAX_ENTRIES`
- Global default instance (`getFsScanCache()`) for cross-tool sharing

### file-discovery.ts integration

- `findSrcFiles` and `findSrcFilesWithContextMode` now use `getOrScan` with the cache
- Cache key is resolved root path (no gitignore hash in v1 — can be extended)
- Results are capped to `maxFiles` after retrieval

### index.ts integration

- On `tool_call` events for `write`, `edit`, `graph_mutate`, the cache is invalidated for the target path
- Uses `invalidateFsScanCache(target)` from the global default instance

## Notes

- Empty-result fast recheck: 200ms (allows rapid re-scanning when empty to catch newly created files)
- Cache key uniqueness based on resolved paths (normalizes `dir/../dir` → `dir`)
- All 10 new tests pass; all 8 existing file-discovery tests still pass
