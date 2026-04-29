# Pi-SmartRead Progress

## Phase 1: Extract utils.ts from read-many.ts

## Review

- **Correct:**
  - `utils.ts` contains all planned exports: constants, types (`TextMetrics`, `FileCandidate`, `PackedSection`, `PackingStrategy`, `PackingPlan`), and functions (`measureText`, `createPathHash`, `buildLineSet`, `pickDelimiter`, `validatePath`, `formatContentBlock`, `canFitSection`, `addSection`, `buildPartialSection`, `buildPlan`).
  - `utils.ts` correctly imports `DEFAULT_MAX_BYTES`, `DEFAULT_MAX_LINES`, and `truncateHead` from `@mariozechner/pi-coding-agent`.
  - `read-many.ts` had all inlined definitions removed and correctly imports from `./utils.js`.
  - `__test` re-export still works and is used by `read-many.test.ts`.
  - `test/unit/utils.test.ts` contains 8 correct and comprehensive tests covering measureText, createPathHash, pickDelimiter (collision + fallback), formatContentBlock, buildPartialSection, and buildPlan (request-order stop + success count).
  - `tsconfig.json` includes `utils.ts` in the `include` array.
  - All 21 tests pass across 3 test files.
  - `tsc --noEmit` compiles cleanly.

- **Fixed:**
  - `read-many.ts` had split/duplicate import blocks from `./utils.js` and imported unused types (`PackingPlan`, `TextMetrics`). Consolidated into a single import statement and removed unused type imports.

- **Note:**
  - No behavior changes observed in `createReadManyTool`.
  - Everything is ready for Phase 2.

## Phase 2: config.ts + tests

## Review

- **Correct:**
  - `config.ts` exports `validateEmbeddingConfig` and `resetConfigCache` correctly.
  - Config loading precedence is implemented exactly as planned: `pi-smartread.config.json` first, then `PI_SMARTREAD_EMBEDDING_*` env vars, then legacy `EMBEDDING_BASE_URL` / `EMBEDDING_MODEL`.
  - `apiKey` is optional and omitted from the resolved config when not provided.
  - Error messages reference both `pi-smartread.config.json` and the `PI_SMARTREAD_EMBEDDING_*` env var names.
  - `cache` is populated in `loadRaw()` and `resetConfigCache()` correctly nulls it out.
  - `test/unit/config.test.ts` contains 7 clean tests covering missing baseUrl, missing model, PI_SMARTREAD_ env vars, API key reading, legacy fallback, precedence of PI_SMARTREAD_ over legacy, and error-message content.
  - All 28 tests pass across 4 test files (config: 7, index: 1, utils: 8, read-many: 12).
  - `tsc --noEmit` compiles cleanly.

- **Fixed:**
  - Nothing — no issues found.

- **Note:**
  - Unit tests do not explicitly exercise a present `pi-smartread.config.json` (the file is absent during runs), so config-file loading is correct by inspection but not directly asserted. This is acceptable given the straightforward `fs.readFileSync` usage.

## Phase 3: scoring.ts + tests

## Review

- **Correct:**
  - `tokenize` lowercases, splits on `/[^a-z0-9_]+/`, discards empty tokens via `.filter(t => t.length > 0)`, and keeps underscores inside tokens.
  - `bm25Scores` uses k1=1.2, b=0.75, computes IDF over the corpus only (`N` and `df`), deduplicates query tokens with `[...new Set(tokenize(query))]` so repeated terms do not multiply the score, and returns one score per document in input order.
  - `cosineSimilarity` returns `1` for identical vectors, `0` for orthogonal vectors, and `-Infinity` when either vector has zero norm.
  - `computeRanks` sorts descending by score, then ascending by original index, then ascending by path. Rank 1 is assigned to the highest score, with ties broken correctly (lower index wins, verified by test).
  - `computeRrfScores` uses k=60 and applies the standard RRF formula per document.
  - `test/unit/scoring.test.ts` contains exactly 15 tests covering all specified behaviors: 3 for tokenize, 4 for bm25Scores, 3 for cosineSimilarity, 3 for computeRanks, and 2 for computeRrfScores.
  - All 43 tests pass across 5 test files (config: 7, index: 1, utils: 8, read-many: 12, scoring: 15).
  - `tsc --noEmit` compiles cleanly.

- **Fixed:**
  - Nothing — no issues found.

- **Note:**
  - Implementation is complete and ready for the next phase.

## Phase 3: scoring.ts + tests

## Review

- **Correct:**
  - `tokenize` lowercases input, splits on `/[^a-z0-9_]+/`, discards empty tokens via `.filter(t => t.length > 0)`, and preserves underscores inside tokens.
  - `bm25Scores` uses exactly k1=1.2 and b=0.75; IDF is computed over the full corpus (N, df); query tokens are deduplicated with `new Set(tokenize(query))` so repeated terms do not multiply the score; output array preserves input document order.
  - `cosineSimilarity` returns `1` for identical vectors, `0` for orthogonal vectors, and `-Infinity` when either vector has zero norm.
  - `computeRanks` sorts by descending score, then ascending index, then ascending path, and assigns rank 1 to the highest score. Ties are broken correctly (lower index wins).
  - `computeRrfScores` uses k=60 and computes `1/(k + sr) + 1/(k + kr)` per document.
  - `test/unit/scoring.test.ts` contains exactly 15 tests covering all functions and edge cases described above.
  - All 43 tests pass across 5 test files.
  - `npx tsc --noEmit` compiles cleanly.

- **Fixed:**
  - Nothing — no issues found.

- **Note:**
  - No behavior changes observed in any other module.
  - Implementation is complete and ready for the next phase.

## Phase 4: embedding.ts + tests

## Review

- **Correct:**
  - `fetchEmbeddings` POSTs to `baseUrl.replace(/\/+$/, "") + "/embeddings"` with body `{ model, input: inputs }`, exactly as specified.
  - Trailing-slash normalization strips all trailing `/` characters before appending `/embeddings`.
  - `Authorization: Bearer <apiKey>` header is added only when `apiKey` is provided; absent otherwise.
  - Default timeout is 30,000 ms via `req.timeoutMs ?? 30_000`; `AbortController` is wired correctly and `clearTimeout` runs in `finally`.
  - Response validation covers: HTTP status (`response.ok`), JSON parse safety, `data` array presence, count check (`data.length < req.inputs.length`), per-embedding array check, numeric element check, and dimension consistency across embeddings.
  - Error messages are clear and specific: network errors, HTTP status, malformed JSON, missing data array, fewer embeddings, non-array embedding, non-numeric values, and dimension mismatch.
  - `read-many.ts` duplicate import blocks were cleaned up as part of this commit (3 insertions, 7 deletions), consolidating all `./utils.js` imports into one statement.
  - `test/unit/embedding.test.ts` contains exactly the 11 tests specified in the plan, all passing.
  - All 54 tests pass across 6 test files.
  - `npx tsc --noEmit` compiles cleanly.

- **Fixed:**
  - Nothing — no issues found.

- **Note:**
  - The 30 s default timeout and `AbortController` logic are correct by inspection but not directly exercised by the 11 tests (the plan did not specify a timeout test). Adding a `vi.useFakeTimers()` coverage test is an optional follow-up if desired.
  - Package dependency switched from `@sinclair/typebox` to `typebox` consistently in `package.json` and `read-many.ts`; runtime and compile-time APIs verified.
  - Implementation matches the plan exactly and is ready for the next phase.


## Phase 5: resolver.ts + tests

## Review

- **Correct:**
  - `resolver.ts` uses `fdir` with `withFullPaths()`, `maxDepth: 0`, and `excludeSymlinks: true` exactly as planned.
  - Paths are sorted lexicographically via `.sort((a, b) => a.localeCompare(b))`.
  - Default cap is 20 and `resolveDirectory` accepts an optional `cap` parameter.
  - Returns `DirectoryResolution` with `paths`, `capped`, and `countBeforeCap`.
  - `test/unit/resolver.test.ts` contains exactly 7 tests covering: regular files found, lexicographic sorting, non-recursive behavior, symlinks excluded, capped at 20, within-limit uncapped, and empty directory.
  - All 61 tests pass across 7 test files.
  - `npx tsc --noEmit` compiles cleanly.

- **Fixed:**
  - Empty-directory test was missing an assertion for `countBeforeCap`. Added `expect(result.countBeforeCap).toBe(0)` to fully verify the `DirectoryResolution` interface in the edge case.

- **Note:**
  - Implementation matches the plan exactly and is ready for the next phase.

## Phase 6: intent-read.ts + tests

## Review

- **Correct:**
  - `validateEmbeddingConfig()` is called first in `execute()`, before any file reads or directory resolution.
  - XOR validation for `files` vs `directory` is strict: throws when both are provided, throws when neither is provided.
  - Empty or whitespace-only query throws after `.trim()`.
  - Schema enforces `files` array size (1-20) and `topK` range (1-20).
  - Directory resolution calls `resolveDirectory` without offset/limit and reports cap info (`candidateCountBeforeCap`, `candidateCountAfterCap`, `capped`) only when capped.
  - Per-file `validatePath` is called inside the read loop; `offset`/`limit` are forwarded to the read tool.
  - Errors are recorded per file, the loop continues unless `stopOnError=true`, in which case the original error is thrown immediately (before embedding).
  - Embedding is skipped entirely when there are no successful files.
  - Query vector is `vectors[0]`; file vectors are `vectors.slice(1)`.
  - BM25, cosine similarity, semantic/keyword ranks, RRF scores, and RRF ranks are all computed correctly.
  - Per-file `semanticRank`, `semanticScore`, `keywordRank`, `keywordScore`, `rrfScore` are stored for every successful file.
  - `effectiveTopK = Math.min(topK, successfulFiles.length)`.
  - Non-top-K successful files are marked `inclusion: "not_top_k"` and `included: false`.
  - Only top-K files are passed to `buildPlan`.
  - Packing uses `request-order` vs `smallest-first` switching (same as `read_many`), and the output sections are emitted in RRF rank order, not packing order.
  - `details.files` is ordered: successes by RRF rank, then errors by input order.
  - `packing.omittedPaths` contains only top-K files that didn't fit (non-top-K files are excluded).
  - `selectedForPacking` is set correctly (`true` for top-K files, `false` otherwise).
  - `inclusion` statuses (`full`, `partial`, `omitted`, `not_top_k`, `error`) are all assigned correctly.
  - Edge cases are handled: all-fail yields empty content and `effectiveTopK=0`; fewer successes than `topK` uses all of them.
  - `test/unit/intent-read.test.ts` contains exactly the 10 specified tests and all pass.
  - All 71 tests pass across 8 test files.
  - `npx tsc --noEmit` compiles cleanly.

- **Fixed:**
  - `intent-read.ts` imported `ExtensionAPI` from `@mariozechner/pi-coding-agent` but never used it. Removed the unused import.

- **Note:**
  - `index.ts` has not yet been updated to register `intent_read` alongside `read_many` (that is Task 7 of the plan). This review focused on `intent-read.ts` and its tests as requested.
  - Directory cap metadata is only included in `details` when `capped` is `true`; the type definitions allow this with optional fields.

## Phase 7: Register both tools in index.ts + FINAL REVIEW

## Review

- **Correct:**
  - `index.ts` registers both `read_many` and `intent_read` tools in a single default export.
  - `test/unit/index.test.ts` verifies both tool names are registered and their `execute` functions are defined.
  - All 71 tests pass across 8 test files.
  - `npx tsc --noEmit` compiles cleanly.
  - Batch read up to 20 files: enforced by schema (`maxItems: 20`) and directory resolver default cap.
  - XOR files/directory: strict validation throws when both or neither are provided.
  - `fdir` non-recursive (`maxDepth: 0`), no symlinks (`excludeSymlinks: true`), sorted (`localeCompare`).
  - Directory cap reported via `candidateCountBeforeCap`, `candidateCountAfterCap`, `capped`.
  - All paths validated via `validatePath` before each read.
  - Embedding config precedence: JSON file → `PI_SMARTREAD_*` env vars → legacy `EMBEDDING_*` fallbacks.
  - Config throws at call time (`validateEmbeddingConfig()` inside `execute`), not at import.
  - `POST` to `{baseUrl}/embeddings` with `{ model, input }` body.
  - Auth header included exactly when `apiKey` is present.
  - Default 30 s timeout via `AbortController`.
  - Malformed response validated: JSON parse, `data` array presence, count, per-embedding array shape, numeric values, dimension consistency.
  - BM25 uses `k1=1.2`, `b=0.75`, IDF over corpus.
  - Tokenizer lowercases and splits on `/[^a-z0-9_]+/`, preserving underscores.
  - Query tokens deduplicated via `new Set(tokenize(query))`.
  - Cosine similarity returns `-Infinity` on zero norm.
  - `computeRanks` tie-breaks by index then path.
  - RRF uses `k=60`.
  - Errored files excluded from scoring and appended last in `details.files`.
  - `stopOnError` throws before embedding.
  - `effectiveTopK = Math.min(topK, successfulFiles.length)`.
  - `buildPlan` and `formatContentBlock` shared via `utils.ts`, reused in both tools.
  - Heredoc output format identical to `read_many`.
  - `details.files` ordered by RRF rank for successes, then input order for errors.
  - `inclusion` field covers all five statuses (`full`, `partial`, `omitted`, `not_top_k`, `error`).
  - `selectedForPacking`, `semanticRank/Score`, `keywordRank/Score`, `rrfScore` all present.
  - `requestedTopK` and `effectiveTopK` both reported.
  - `packing.omittedPaths` contains only top-K files omitted due to budget; non-top-K files are excluded.

- **Fixed:**
  - Nothing — no issues found.

- **Note:**
  - Minor schema inconsistency: `intent_read` allows `offset: 0` while `read_many` requires `offset: 1` (1-indexed). This is harmless and not specified in the intent_read requirements.
  - `read-many.ts` still exports its own default handler for backward compatibility; `index.ts` is the unified entry point. If the framework auto-discovers both, `read_many` could be registered twice. This appears to be pre-existing behavior.

## Verdict
**All spec requirements satisfied. Implementation is complete, tested, and clean. Ready for merge/PR.**

## Phase 1: repo-map integration (tree-sitter tags, pagerank, cache, file-discovery, tree-context)

## Review
- **Correct:**
  - `languages.ts` provides a clean, exhaustive map of 40+ file extensions to tree-sitter language names, with correct WASM filename aliases (`c_sharp` → `c-sharp`, etc.) and query-name aliases for `.scm` discovery.
  - `file-discovery.ts` filters by supported extensions, safely ignores common build/vendor directories, handles permission errors gracefully, supports max-file caps, and offers a focused `findFilesMatching` helper.
  - `cache.ts` implements mtime-based invalidation with both in-memory and optional on-disk persistence. Failures during JSON parse or disk writes are caught and fall back gracefully.
  - `pagerank.ts` correctly implements personalized PageRank: damping factor (default 0.85), dangling-node redistribution via the personalization vector, convergence check (`tol = 1e-6`), and zero-node guard.
  - `tags.ts` architecture matches Aider repomap patterns: async parser init, per-language WASM loading, query caching, flat capture processing, deduplication, and batch concurrency limiting.
  - `Tag` interface in `cache.ts` (`relFname`, `fname`, `line`, `name`, `kind: "def" | "ref"`) matches `tags.ts` usage exactly.
  - All internal imports use `.js` extensions for ESM compatibility (`./languages.js`, `./cache.js`).
  - No `any` types observed; strict-null annotations are present (`number | null`, `Tag[] | null`, etc.).
  - Edge cases handled: unsupported language, missing WASM, missing query file, unreadable source file, null parse tree, empty captures.

- **Fixed:**
  - `tags.ts` ESM imports: `web-tree-sitter` v0.26.x is a CJS default-export module. Named value imports (`Language`, `Query`) fail at runtime in pure ESM Node. Replaced with `import Parser from "web-tree-sitter"` and used `Parser.Language.load()` / `new Parser.Query()` at runtime, keeping `import type { Language, Query, Tree }` for type safety.
  - `tags.ts` concurrency race: `initParser()` used a boolean flag (`parserInitialized`) before an async `Parser.init()`, allowing duplicate concurrent initializations. Replaced with a shared `initPromise` guard.
  - `tags.ts` memory safety: parser and tree `.delete()` calls were only in the success path. Wrapped tag extraction in `try/finally` so `tree?.delete()` and `parser.delete()` run even if `query.captures()` or the loop throws.
  - `cache.ts` filename collisions: the `replace(/[^a-zA-Z0-9._-]/g, "_")` sanitization is lossy (e.g., `foo:bar.ts` and `foo_bar.ts` collide). Replaced with SHA-256 hashing for guaranteed unique, fixed-length cache filenames.
  - `tree-context.ts` bounds-check bug: `renderTreeContext` called `addParentContext(lines, loi, ...)` before validating `loi`. Passing `linesOfInterest` containing `0` or negative numbers caused an array out-of-bounds crash (`lines[-1]`). Added `if (loi < 1 || loi > lines.length) continue;` guard.

- **Note:**
  - `tree-context.ts` defines `TreeContextOptions` (`color?`, `margin?`) but `renderTreeContext` ignores the parameter entirely (prefixed `_options`). Either implement margin/color or remove from public API to avoid confusion.
  - `tree-context.ts` `getIndent` uses raw character count for tabs; mixed tab/space indentation will produce incorrect parent-context hierarchies. Consider documenting or normalizing tabs to spaces.
  - `cache.ts` in-memory `Map` has no eviction policy; for repos with >100k files this could grow without bound.
  - `tsconfig.json` `include` array currently omits the 6 new repo-map source files. Add them (`languages.ts`, `cache.ts`, `pagerank.ts`, `tree-context.ts`, `file-discovery.ts`, `tags.ts`) before wire-up so `tsc --noEmit` covers them.
  - `web-tree-sitter` v0.26.x `Parser.init()` is assumed idempotent; the `initPromise` pattern prevents duplicate concurrent calls but does not retry on failure (acceptable behavior).

## Review: Re-review all finished repo-map phases (1-3) with fixes

### Correct
- **Phase 1 bugs verified fixed:**
  1. `tags.ts` CJS/ESM import: uses `createRequire(import.meta.url)` to resolve `tree-sitter-wasms/package.json` inside an ESM module. Named value imports (`Parser`, `Language`, `Query`) from `web-tree-sitter` v0.26.8 are valid because the package is `"type": "module"` and exports them explicitly.
  2. `tags.ts` race condition: `initPromise` is a shared `Promise<void> | null` guard. All concurrent callers await the same initialization promise; no duplicate `Parser.init()` calls.
  3. `tags.ts` memory leak: `parser.parse()` returns a `Tree`; both `tree?.delete()` and `parser.delete()` are called inside a `finally` block, guaranteeing cleanup on success, error, or early return.
  4. `cache.ts` SHA-256 filename collision: `getFilePath` uses `createHash("sha256").update(fname).digest("hex")` for cache filenames, eliminating any possible collision from path-sanitization edge cases.
  5. `tree-context.ts` bounds checking: `renderTreeContext` validates every `loi` with `if (loi < 1 || loi > lines.length) continue;` before passing it to `addParentContext`, preventing `lines[-1]` crashes.
- **Phase 2 orchestrator (`repomap.ts`):**
  - PageRank graph construction is correct: nodes = all files (relative paths), edges = `refFile → defFile` for shared identifiers across files. Missing-node edges are safely skipped inside `pagerank.ts`.
  - Personalized PageRank matches Aider patterns: focus files get weight `100`, connected neighbors get `+10`, priority identifiers boost rank `×10`, priority files boost `×5`, focus files boost `×20`.
  - Token-budget binary search is correctly implemented in `buildMap`: `left/right` converges on the largest `mid` slice of already-sorted tags whose rendered output fits within `maxTokens`.
  - Focus files are intentionally excluded from the rendered map (`if (focusRelFiles.has(relFname)) continue`), matching Aider's behavior (focus files are already in the conversation context).
  - `Tag` type is shared between `cache.ts` and `tags.ts`; no boundary mismatches.
  - `repomap.ts` correctly handles absolute vs. relative paths: all internal file lists use absolute paths; tags store `relFname`; PageRank and rendering operate on `relFname`.
- **Phase 3 tool wrappers (`repomap-tool.ts`):**
  - Two tools exposed: `repo_map` and `search_symbols`.
  - Schema definitions use `Type.Object` from `typebox`, matching existing `read-many.ts` and `intent-read.ts` patterns.
  - `execute` signature matches existing tools (`toolCallId`, `params`, `signal`, `_onUpdate`, `ctx`).
  - Result shapes return `{ content: [{ type: "text", text: ... }], details: ... }`, matching the content/detail pattern used by `read_many` and `intent_read`.
  - `search_symbols` formats output with relative file paths, line numbers, `[def]`/`[ref]` labels, and optional tree context.
- **`index.ts` registration:**
  - Correctly imports `registerRepoTools` from `./repomap-tool.js` (`.js` extension).
  - Calls `registerRepoTools(pi)` inside the default export alongside existing tools.
  - No duplicated registrations; `read-many.ts` default export is left for backward compatibility.
- **ESM imports:**
  - All cross-module imports use `.js` extensions (`./cache.js`, `./languages.js`, `./tags.js`, `./pagerank.js`, `./tree-context.js`, `./file-discovery.js`, `./repomap.js`, `./repomap-tool.js`).
- **Type safety:**
  - No explicit `any` types remain in the new code.
  - Strict TypeScript (`strict: true`) is enabled in `tsconfig.json`.
  - `tsconfig.json` `include` array already lists all new repo-map sources (`languages.ts`, `cache.ts`, `pagerank.ts`, `tree-context.ts`, `file-discovery.ts`, `tags.ts`, `repomap.ts`, `repomap-tool.ts`).

### Fixed
- **`repomap-tool.ts` stale singleton bug:** the original `getRepoMap(cwd)` helper used a single `repoMapInstance` variable. If the tool was invoked with a different `directory` / `ctx.cwd`, it would return the cached `RepoMap` for the old directory. Replaced with `const repoMapInstances = new Map<string, RepoMap>()` so each working directory gets its own cached instance, consistent with the tool's schema which allows varying `directory` per call.
- **`repomap.ts` redundant filtering:** `findSrcFiles(this.root).filter(isSupportedFile)` appeared twice (`getRepoMap` and `searchIdentifiers`). `findSrcFiles` already applies `isSupportedFile` internally, so the `.filter` was redundant. Removed both occurrences and removed the unused `isSupportedFile` import.

### Note
- `tree-context.ts` still accepts `TreeContextOptions` (color, margin) but ignores them. This is harmless but could be removed or implemented later.
- `searchIdentifiers` in `repomap.ts` processes files sequentially rather than using `getTagsBatch` (which has controlled concurrency). This is correct but slower on very large repos; consider switching to `getTagsBatch` in a future optimization.
- `cache.ts` in-memory map has no eviction policy. For monorepos with hundreds of thousands of files this could grow unbounded. Acceptable for current target repos.
## Final Review: repo-map optimizations, hook system, and tests

### Correct
- **ESM imports:** All new files use `.js` extensions (`./hook.js`, `./repomap.js`, `./file-discovery.js`); `index.ts` correctly wraps before registering.
- **Hook state model:** Keyed by normalized git root (or absolute path fallback); stores `mapShown`, `explicitlyCalled`, `inFlight`. Handles skip-map meta, already-shown, concurrency guard, and generation correctly. The concurrency guard is safe because JS is single-threaded: the first caller sets `inFlight` synchronously before yielding, so concurrent callers arriving in the same tick will see it and await the shared promise.
- **Hook failure recovery:** Generation errors fall through to the original tool with `_repoMapHook.failed` in `details`, signalling the failure without breaking the read flow.
- **Response contract:** `intercepted: true` in `details` plus explicit `[REPO MAP — TOOL INTERCEPTED]` header makes it unambiguous.
- **Cross-tool state sharing:** `read_many` and `intent_read` share the same `sessionStates` map because both are keyed by the same `computeRepoKey(cwd)`. Verified by test.
- **Gitignore parsing:** Cascading upward via `loadGitignoreRules` works. Negation re-applies in order. Anchored (`/`) and dir-only (`/`) patterns are detected and compiled into anchored regexes. Unanchored patterns without a slash match at any depth (`(?:^|/)…$`). `**/` expands to `(?:.+/)?`. `gitignoreGlobToRegex` escapes regex metacharacters except `*` and `?`.
- **TS path alias resolution:** `parseTsconfigPaths` correctly extracts `@/* → ./src/*` style aliases from `compilerOptions.paths`. `resolveViaAlias` strips the prefix, appends the suffix, and resolves against `absRoot`. Multiple aliases and `jsconfig.json` fallback are supported.
- **Compact mode:** `renderTagsCompact` produces single-line summaries: `file.ts (refs: N) — sym1, sym2 (+3 more)`. Symbols are deduplicated and capped at 8. Works correctly with the token-budget binary search (subset slicing is independent of rendering format).
- **Tests:**
  - `import-based.test.ts` (13 tests) covers: empty repo, in-degree ranking, CJS require, Python imports, bare package filtering, `excludeUnranked`, focus-files boost, token budget, `importEdges` counting, triple-slash references, self-import filtering, TS alias resolution, and compact output assertions.
  - `hook.test.ts` (11 tests) covers: first-read intercept, second-read passthrough, `skipRepoMapHook`, explicit-call suppression, cross-repo isolation, explicit-call scope, concurrent readers, empty-repo fallthrough, `intent_read` intercept, cwd normalization via git root, and cross-tool state sharing.

### Fixed
1. **`tsconfig.json` missing `hook.ts`** — Added to `include` array so it is covered by `tsc --noEmit`.
2. **`repomap.ts` tree-sitter path ignored `compact` option** — Line ~514 hardcoded `compact: false` for the tree-sitter success path, so users who requested `compact: true` while tree-sitter succeeded still got full code context. Changed to `options.compact ?? false`.
3. **`repomap.ts` dead `existsSync` in `resolveViaAlias`** — Checked `existsSync(resolved)` and returned the same `resolved` path in both branches. Simplified to a single `return`.
4. **`file-discovery.ts` dead/misleading dot-dir gitignore check** — The code checked `isGitignored(relPath, true, rules)` for dot-dirs inside `IGNORE_DIRS` but then executed an unconditional second `continue`, making the check dead. Simplified both `findSrcFiles` and `findFilesMatching` to: `if (IGNORE_DIRS.has(entry) || entry.startsWith(".")) continue;`.
5. **`file-discovery.ts` hardcoded Unix root `/` in `loadGitignoreRules`** — Replaced `dir === "/" ? null : join(dir, "..")` with `resolve(dir, "..")` and `parent !== dir`, which works correctly on both Unix and Windows.
6. **`file-discovery.ts` cross-platform path separator bug** — `relative()` can produce backslashes on Windows, but gitignore regexes match forward slashes. Added `relPath.replace(/\\/g, "/")` normalization inside `isGitignored` before regex testing.
7. **`file-discovery.ts` unused `sep` import** — Removed from the `node:path` import list.
8. **`hook.ts` dead `registerHookedTools` used `require()` in ESM** — This function was exported but never called by `index.ts` (which uses `wrapReadManyTool`/`wrapIntentReadTool` instead). It would have thrown `ReferenceError: require is not defined` in pure ESM. Removed entirely.
9. **`hook.ts` unused imports** — Removed `type Static` and `ExtensionAPI` which became unused after removing `registerHookedTools`.
10. **`repomap.ts` unused `existsSync` import** — Removed after cleaning up `resolveViaAlias`.

### Note
- No missing tests were identified as strictly necessary, though explicit gitignore edge-case tests (negation, anchored vs. unanchored patterns on Windows) could be added as a future enhancement.
- The hook's `generateCompactMap` double-catches (tree-sitter + explicit import-based fallback) is defensive but slightly redundant because `autoFallback: true` inside `getRepoMap` already handles tree-sitter failure internally. This is harmless redundancy.
- `file-discovery.ts` `IGNORE_DIRS` still unconditionally skips all dot-directories. This is intentional and safe, but means a `.gitignore` negation like `!.hidden/` cannot override it. Acceptable for security/performance.

- The `initPromise` pattern in `tags.ts` does not retry if `Parser.init()` throws (the rejected promise is cached). Given that WASM files are bundled, this is an acceptable failure mode.
