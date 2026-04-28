# intent_read — Design Spec

**Date:** 2026-04-28
**Status:** Ready for Implementation Review

---

## Overview

`intent_read` is a new tool for the `pi-read-many` extension. It accepts up to 20 file candidates, reads them sequentially, scores successfully read files against a query using hybrid Reciprocal Rank Fusion (RRF) over semantic and keyword rankings, and returns the top-K relevant results with their file contents and per-file relevance metadata. The tool implements a mini ephemeral RAG pipeline without persisting embeddings or indexed content.

---

## File Structure

```
Pi-SmartRead/
├── index.ts          # registers both tools, loads config once at startup
├── utils.ts          # NEW: shared helpers lifted from read-many.ts
│                     #   validatePath, formatContentBlock, measureText,
│                     #   pickDelimiter, createPathHash, buildLineSet,
│                     #   canFitSection, addSection, buildPartialSection,
│                     #   buildPlan, DELIMITER_WORDS, and shared packing/types
├── config.ts         # NEW: loads embedding config (JSON → env fallback)
├── read-many.ts      # behavior unchanged; helper implementations moved to utils.ts
└── intent-read.ts    # NEW: the intent_read tool
```

### `config.ts`

`config.ts` loads `pi-smartread.config.json` from `process.cwd()` on first import and caches the parsed result. It does not throw for missing embedding settings during import; required embedding fields are validated by `intent_read` at tool-call time so the extension can still start and register tools when embeddings are not configured.

Config file values take precedence over environment variables. Environment fallback names are `PI_SMARTREAD_EMBEDDING_BASE_URL`, `PI_SMARTREAD_EMBEDDING_MODEL`, and `PI_SMARTREAD_EMBEDDING_API_KEY`. The legacy names `EMBEDDING_BASE_URL` and `EMBEDDING_MODEL` may optionally be supported as secondary fallbacks if backward compatibility is desired.

`baseUrl` is an OpenAI-compatible API base URL. `intent_read` calls `POST ${baseUrl}/embeddings` after normalizing trailing slashes. The request body is `{ "model": model, "input": [query, …fileBodies] }`. If `apiKey` is present, the request includes `Authorization: Bearer ${apiKey}`. The response must include `data[i].embedding` arrays in the same order as the input array.

If the embedding response is malformed, has fewer embeddings than requested, contains non-array embeddings, returns mismatched vector dimensions, or contains non-numeric vector values, the tool treats this as an embedding API failure and throws with no partial results.

**Security note:** query text and file contents are sent to the configured embedding endpoint. Users should configure only trusted local or remote embedding providers. The tool does not redact secrets or sensitive content before embedding.

Example config file:

```json
{
  "baseUrl": "http://localhost:11434/v1",
  "model": "nomic-embed-text",
  "apiKey": "sk-..."
}
```

`apiKey` is optional — omit the field entirely for local setups that don't require authentication.

### `utils.ts`

Lifts the following out of `read-many.ts` with no behavior changes:
- `validatePath`, `formatContentBlock`, `measureText`, `pickDelimiter`, `createPathHash`, `buildLineSet`
- `canFitSection`, `addSection`, `buildPartialSection`, `buildPlan`
- `DELIMITER_WORDS`
- Shared types: `TextMetrics`, `FileCandidate`, `PackedSection`, `PackingStrategy`, `PackingPlan`

---

## Tool Input Schema

```typescript
{
  query: string,               // the search intent — required
  files?: Array<{              // explicit file paths — mutually exclusive with directory
    path: string,
    offset?: number,
    limit?: number
  }>,
  directory?: string,          // scan all files in this dir (non-recursive, max 20)
  topK?: number,               // results to return; default 5, max 20
  stopOnError?: boolean        // stop on first error; default false
}
```

**Validation:** Exactly one of `files` or `directory` must be provided. This is enforced at runtime with a clear error message because TypeBox cannot express XOR. `query` must be a non-empty string after trimming whitespace. `files`, if provided, must contain 1–20 entries. `topK` defaults to 5 and must be an integer from 1 to 20 inclusive. `offset`, if provided, must be an integer greater than or equal to 0. `limit`, if provided, must be an integer greater than 0. Path validation is performed before reading. Invalid paths are treated as file-level errors unless `stopOnError` is true, in which case the tool throws immediately.

Directory expansion uses `fdir`, includes regular files only, is non-recursive, does not follow symlinks, and is capped at 20 files. Directory results are sorted lexicographically by resolved path before applying the 20-file cap. Directory-expanded files are read without explicit offset or limit. If more than 20 files are found, the cap is reflected in `details` so the caller can tell that only a subset was considered.

---

## Pipeline

Stages run sequentially:

### 1. Resolve Inputs

- If `directory` is provided: expand to a flat file list using `fdir`, regular files only, non-recursive, no symlink following, sorted lexicographically by resolved path, capped at 20 files.
- If `files` is provided: use the explicit list as-is, capped by validation at 20 entries.
- Validate all paths with `validatePath`.
- For explicit files, `offset` and `limit` are forwarded unchanged to Pi's built-in `read` and use the same semantics as `read_many`. Directory-expanded files are read without offset or limit.
- Record whether directory expansion was capped so it can be reported in `details`.

### 2. Read

- Call Pi's built-in `read` on each file sequentially, using the same read behavior as `read_many`.
- Collect the returned file bodies as strings. The text used for embedding is the same text returned by `read`, not the heredoc-formatted output block.
- On read error: record the error and continue by default.
- If `stopOnError` is true: throw on the first validation or read error and do not make an embedding request.
- Only successfully read files are eligible for semantic ranking, keyword ranking, top-K selection, and packed content output.

### 3. Embed

- Before reading or embedding, validate that embedding config provides both `baseUrl` and `model`. If either is missing, throw a clear error pointing to both supported config sources: `pi-smartread.config.json` and the environment variables.
- POST one batched request to the configured OpenAI-compatible embedding endpoint.
- Input array: `[query, …successfulFileBodies]`. The first returned vector is the query vector. Remaining vectors correspond to successfully read files in the same order.
- Failed files are not sent to the embedding endpoint and are ranked after all successful files.
- If the embedding API call fails entirely, times out, or returns a malformed response, the tool throws and returns no partial results.
- If either vector in a cosine similarity calculation has zero norm, treat cosine similarity as negative infinity for ranking.
- Embedding requests should use a fixed timeout of 30 seconds, unless the project already has a standard request timeout helper.

### 4. Score — Hybrid RRF

- **Semantic rank:** cosine similarity between the query vector and each successfully read file vector, sorted descending.
- **Keyword rank:** BM25 score of query tokens against each successfully read file body, sorted descending.
- **Tokenization:** lowercase text, split on non-alphanumeric and non-underscore runs, discard empty tokens. No stemming and no stopword removal.
- **BM25** uses `k1 = 1.2` and `b = 0.75`. Compute IDF over successfully read candidate files only. Repeated query terms do not multiply the query contribution; score over unique query tokens.
- Ranks are ordinal positions after deterministic sorting, starting at 1. Ties are broken by original candidate order, then path.
- **RRF fusion:** `score = 1/(60 + semantic_rank) + 1/(60 + keyword_rank)` where `k = 60` is a commonly used RRF constant. Sort descending by fused score. RRF score ties are broken by original candidate order, then path.
- Files with `ok: false` are appended after all successful files in deterministic input order. They do not receive meaningful semantic or keyword scores and must never be included in packed content.

### 5. Pack

- Take the top `topK` successful files by RRF score.
- Pass them in ranked order to `buildPlan` from `utils.ts` to respect output budget limits.
- Actual output may include full content, partial content, or omit selected files depending on output budget limits.
- Files outside the top-K cutoff remain listed in `details.files` but have `included: false`.
- Output uses the same heredoc block format as `read_many`.

### 6. Return

Return content blocks in relevance order using heredoc format, plus `details` with per-file scores, rank metadata, inclusion status, and packing metadata.

---

## Output Format

Content blocks use the same format as `read_many`:

```
@src/auth.ts
<<'PINE_1_A3F2C1'
...file content...
PINE_1_A3F2C1

@src/middleware.ts
<<'MANGO_2_B1D4E2'
...file content...
MANGO_2_B1D4E2
```

### `details` shape

`details` includes the original query, candidate counts, success/error counts, the requested and effective top-K values, per-file ranking metadata, and packing metadata.

- `processedCount` — number of candidate files after expansion, validation, and the 20-file cap.
- `successCount` — number of candidates successfully read.
- `errorCount` — number of candidates that failed validation or read.
- `requestedTopK` — the validated `topK` requested by the caller.
- `effectiveTopK` — number of successfully read files actually considered for top-K selection, capped by `requestedTopK`.

If directory mode found more than 20 files, `details` includes `candidateCountBeforeCap`, `candidateCountAfterCap`, and `capped: true`.

Each item in `details.files` includes:
- `path`, `ok`, `error` (if present)
- `semanticRank`, `semanticScore`, `keywordRank`, `keywordScore`, `rrfScore` — omitted for errored files, which are not ranked with successful files
- `selectedForPacking` — whether the file was in the top-K successful results and passed to `buildPlan`
- `included` — whether content for that file appears in the output (full or partial)
- `inclusion` — one of `full`, `partial`, `omitted`, `not_top_k`, or `error`

All candidate files appear in `details.files` regardless of `topK` cutoff or packing, ordered by RRF score descending for successful files, followed by errored files in deterministic input order. This allows the agent to inspect what was considered and why.

If fewer successful files are available than `topK`, all successful files are considered for packing. Actual included content may be full, partial, or omitted depending on output budget limits.

### `details.packing`

`packing` includes `strategy`, `switchedForCoverage`, `fullIncludedCount`, `fullIncludedSuccessCount`, `partialIncludedPath` (if any), and `omittedPaths`.

`omittedPaths` includes top-K selected candidate paths that were passed to packing but omitted because they did not fit the output budget. It does not include lower-ranked files outside the top-K cutoff.

---

## Error Handling

| Condition | Behavior |
|---|---|
| Config missing `baseUrl` or `model` | Throw immediately at tool-call time before any reads, pointing to `pi-smartread.config.json` and the environment variable fallback names |
| Invalid input shape, empty query, invalid `topK`/`offset`/`limit`, or both/neither `files` and `directory` | Throw a clear validation error before reading |
| Path validation failure | Record as a file-level error by default; if `stopOnError` is true, throw immediately |
| File read error | Record the error and continue by default; file excluded from embedding, ranking, top-K, and output. If `stopOnError` is true, throw immediately and do not make an embedding request |
| Embedding API failure, timeout, or malformed response | Throw with no partial embedding results returned |
| Zero-norm embedding vector | Treat cosine similarity as negative infinity for semantic ranking |
| Directory contains more than 20 files | Sort deterministically, cap at 20, continue, and report the cap in `details` |

---

## Dependencies

No new runtime dependencies required:
- `fdir` — already in `node_modules`, used for directory expansion
- Embedding calls use Node's built-in `fetch` (Node ≥ 18, project requires ≥ 20)
- BM25 keyword scoring implemented inline with explicitly documented tokenization and constants

---

## Security Considerations

`intent_read` may read and transmit file contents to the configured embedding endpoint. This is safe for trusted local embedding servers but may expose sensitive code or secrets if configured with a remote provider.

- The tool does not redact secrets before embedding.
- Directory mode is intentionally non-recursive and capped at 20 files to reduce accidental large reads.
- Path validation must be applied to every candidate before reading.
- Symlinks are not followed during directory expansion.
- Users should avoid pointing directory mode at locations containing secrets unless they trust the configured embedding endpoint.

---

## Determinism

- Directory-expanded candidates are sorted lexicographically by resolved path before capping.
- Ranking ties are broken by original candidate order, then path.
- RRF ties are broken by original candidate order, then path.
- Errored files are appended after successful files in deterministic input order.

This ensures repeated calls over the same inputs produce stable results.
