# Progress

## Status
Complete

## Changes Made

1. **package.json** — Replaced hand-maintained `files[]` with glob patterns; added `prepublishOnly` script
2. **tsconfig.json** — Replaced hand-maintained denylist `include` with simple globs
3. **bun-types.d.ts:15** — Changed `declare var Bun` → `declare const Bun`
4. **code-summary.test.ts** — Moved from root to `test/unit/`, updated import path; deleted root copy
5. **.gitignore** — Added `test/unit/CLAUDE.md`, `.subagent-work/`, `research/`, `dump.ts`, `config.enc`, `bun.lock`
6. **vitest.config.ts** — Created with parallel workers, 45s timeout, setupFiles placeholder, keepAlive comment
7. **test/unit/deep-search.test.ts** — Replaced `delete process.env.X` with `vi.stubEnv()` / `vi.unstubAllEnvs()`
8. **test/unit/sqlite-vec-store.test.ts** — Changed `require("better-sqlite3")` to dynamic `await import(...)`
9. **test/unit/local-embedding-provider.test.ts** — Added `canImport()` helper, replaced env-var gating with `it.runIf(canImport(...))`
10. **test/unit/mcp-server.test.ts** and **index.test.ts** — Added `expect(...).toContain("deep_search")` assertion
11. **eslint --fix** — Ran successfully, 0 errors, only no-console warnings
12. **mcp-server.ts** — Plumb signal, validate args, fix fallback, enforce prompt args, snapshot cwd
13. **types.ts** — Replace throw in `ui.custom` with no-op return
14. **graph-mutate.ts** — Add `isError: true` to error returns
15. **git-notes-tool.ts** — Add `isError`, use ExtensionContext, add maxLength, fix imports
16. **mcp-registry.ts** — Dedup guard in `reg()`
17. **find-symbol-tool.ts** — Replace Type.Unsafe with Type.Union
18. **deep-search-tool.ts** — Replace Type.Unsafe with Type.Union, rename shadowing cwd

## Validation
- Typecheck: passes (pre-existing unused-import warnings only)
- All MCP tests pass
- 8 pre-existing failing test files unchanged
- Output written to: fix-mcp.md

---

## Core Retrieval Bug Fixes (19 Jun 2026)

- [x] Fix 1: `search-tool.ts` — handleCode global sort after merge (`allResults.sort`)
- [x] Fix 2: `read-many.ts` — stopOnError uses labeled break (`break chunkLoop`) instead of inner-only `break`
- [x] Fix 3: `read-many.ts` — skip `recordContiguous` when summary replaced body (`summaryApplied` flag)
- [x] Fix 4: `intent-read.ts` — vector count check `>=` instead of `===` with `.slice(1, n+1)`
- [x] Fix 5: `intent-read.ts` — deduplicate `params.files` by path in non-directory branch
- [x] Fix 6: `search-tool.ts` — handleGrep file size cap (`MAX_FILE_BYTES = 10MB`) before read
- [x] Fix 7: `search-tool.ts` — parser pool (`Map<string, Parser>`) in `extractCodeDefinitions`

## Files Changed (retrieval fixes)
- `search-tool.ts` (+48, −56): fixes 1, 6, 7
- `read-many.ts` (+14, −2): fixes 2, 3
- `intent-read.ts` (+16, −4): fixes 4, 5

## Validation (retrieval fixes)
- Typecheck: 0 errors in edited files
- read-many tests: 15/15 pass
- Pre-existing config HTTPS validation issue blocks intent-read + repomap tests
- Output written to: fix-core.md
