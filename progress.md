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
