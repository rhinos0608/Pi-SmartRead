# Core Retrieval Bug Fixes

## Changes Applied

### Fix 1: `search-tool.ts` — handleCode top-K global sort (line 664)
**Problem**: `allResults` merged pre-sorted `scored` + `bm25Only` arrays via concatenation, not globally sorted. Results with close scores from different sub-arrays could appear out of order.
**Fix**: `const allResults = [...scored, ...bm25Only].sort((a, b) => b.score - a.score);`
**Re-sort after LSP merge** (line 700-702): Already present; re-sorts after LSP symbols appended.

### Fix 2: `read-many.ts` — stopOnError breaks only inner loop (line 261-262)
**Problem**: `break` in catch block exits inner `for` loop only. Outer chunked loop (`for chunkStart`) continues, processing subsequent chunks of files despite error.
**Fix**: Labeled break `break chunkLoop;` exits both inner and outer loops, stopping all processing while preserving result-building flow (test expects `processedCount=1`).

### Fix 3: `read-many.ts` — summarized files corrupt file-read cache (lines 197-243)
**Problem**: When `body` is replaced by summarized text (rendered summary), `recordContiguous` stores summary lines against the original `startLine`. The file-read cache then has wrong content for anchor-stale recovery.
**Fix**: 
- Added `let summaryApplied = false` before summarization block
- Set `summaryApplied = true` when summary replaces `body`
- Guard `recordContiguous` with `if (!summaryApplied)`

### Fix 4: `intent-read.ts` — strict vector count equality rejects extra vectors (lines 704-706)
**Problem**: `if (vectors.length === allChunkTexts.length + 1)` rejects embedding APIs that return more vectors than requested (some providers include metadata/extra vectors).
**Fix**: `if (vectors.length >= allChunkTexts.length + 1)` and `const chunkVecs = vectors.slice(1, allChunkTexts.length + 1);` — gracefully handles extra trailing vectors.

### Fix 5: `intent-read.ts` — duplicate paths in params.files overwrite detail map (lines 265-271)
**Problem**: When `params.files` array contained the same path twice, `fileDetails.set(f.path, ...)` silently overwrote the first entry with the second. Metadata for the first entry was lost.
**Fix**: Deduplicate by path at input parsing: `const seenPaths = new Set(); resolvedFiles = params.files!.filter(f => { if (seenPaths.has(f.path)) return false; seenPaths.add(f.path); return true; });`

### Fix 6: `search-tool.ts` — handleGrep reads entire file before scanning (lines 502-514)
**Problem**: `handleGrep` calls `fs.readFile(filePath, "utf-8")` without checking file size, risking OOM or excessive memory on large binary/log files.
**Fix**: Added `const MAX_FILE_BYTES = 10 * 1024 * 1024;` and stat-check before read: `const stat = await fs.stat(filePath); if (stat.size > MAX_FILE_BYTES) continue;`

### Fix 7: `search-tool.ts` — parser pool in extractCodeDefinitions (lines 119-144)
**Problem**: `extractCodeDefinitions` creates a fresh `new Parser()` per file. Tree-sitter parser initialization is expensive (grammar compilation, WASM instantiation).
**Fix**: Added `const parserPool = new Map<string, Parser>();` at module level. In function, reuse parsers: `let parser = parserPool.get(lang); if (!parser) { parser = new Parser(); parser.setLanguage(grammar); parserPool.set(lang, parser); }`

## Validation

### Typecheck
`npm run typecheck` — **No errors in edited files** (search-tool.ts, read-many.ts, intent-read.ts).

### Tests
**All 15 read-many tests pass** (including `heredoc error framing and honors stopOnError`):
```
✓ read_files: execute behavior > uses heredoc error framing and honors stopOnError 1ms
Test Files  1 passed (1)
     Tests  15 passed (15)
```

**Other test failures are pre-existing** and unrelated to these changes:
- `config.test.ts` (8 tests) — HTTPS validation rejects `http://localhost:11434/v1`
- `intent-read.test.ts` (6 tests) — Same HTTPS config issue in test setup
- `repomap-tool.test.ts` (3 tests) — `resolveSearchRoot` uses `realpathSync` which fails in test tempdir (pre-existing working-tree change)
- `advanced-retrieval-baseline.test.ts`, `deep-search.test.ts`, `git-notes-tool.test.ts`, `index.test.ts` — All pre-existing (type errors, config issues)

## Changed Files
| File | Lines Changed | Fixes |
|------|--------------|-------|
| `search-tool.ts` | +48, −56 (net −8) | 1, 6, 7 |
| `read-many.ts` | +14, −2 (net +12) | 2, 3 |
| `intent-read.ts` | +16, −4 (net +12) | 4, 5 |

## Open Risks
- `resolveSearchRoot` function in `search-tool.ts` was already modified in working tree before my edits (uses `realpathSync`). Pre-existing test failures in `repomap-tool.test.ts`.
- Config HTTPS validation (`config.ts`) causes cascading test failures across multiple test files. Pre-existing.

## Recommended Next Steps
1. Fix `config.ts` `validateUrl` to allow `localhost` HTTP for development/test environments.
2. Restore or fix `resolveSearchRoot` to handle non-existent paths gracefully (or revert to simple version).
