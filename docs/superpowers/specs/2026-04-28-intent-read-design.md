# intent_read — Design Spec

**Date:** 2026-04-28
**Status:** Approved

---

## Overview

`intent_read` is a new tool for the `pi-read-many` extension. It implements a mini ephemeral RAG pipeline: batch-reads up to 20 files, scores them against a query using hybrid RRF (keyword + semantic), and returns the top-K results with their file contents and per-file relevance metadata.

---

## File Structure

```
Pi-SmartRead/
├── index.ts          # registers both tools, loads config once at startup
├── utils.ts          # NEW: shared helpers lifted from read-many.ts
│                     #   validatePath, formatContentBlock, measureText,
│                     #   pickDelimiter, buildPartialSection, buildPlan,
│                     #   canFitSection, addSection, createPathHash
├── config.ts         # NEW: loads embedding config (JSON → env fallback)
├── read-many.ts      # unchanged logic, imports from utils.ts
└── intent-read.ts    # NEW: the intent_read tool
```

### `config.ts`

Reads `pi-smartread.config.json` from `process.cwd()` on first import (synchronous, cached). Falls back to `EMBEDDING_BASE_URL` and `EMBEDDING_MODEL` env vars. API key is optional (for local setups). Throws clearly at tool-call time if neither source provides `baseUrl` and `model`.

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

Lifts these helpers out of `read-many.ts` with no behavior changes:
- `validatePath`
- `formatContentBlock`
- `measureText`
- `pickDelimiter`
- `createPathHash`
- `buildLineSet`
- `canFitSection`
- `addSection`
- `buildPartialSection`
- `buildPlan`
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
  stopOnError?: boolean        // stop on first read error; default false
}
```

**Validation:** exactly one of `files` or `directory` must be provided. Enforced at runtime with a clear error message (TypeBox cannot express XOR). Directory expansion uses `fdir` (already in `node_modules`), non-recursive, capped at 20 files.

---

## Pipeline

Stages run sequentially:

### 1. Resolve Inputs
- If `directory` provided: expand to flat file list using `fdir`, non-recursive, cap at 20.
- If `files` provided: use as-is, cap at 20.
- Validate all paths with `validatePath`.

### 2. Read
- Call Pi's built-in `read` on each file sequentially (same as `read_many`).
- Collect file bodies as strings.
- On error: record error, continue (or stop if `stopOnError: true`).

### 3. Embed
- POST a single batched request to the configured embedding endpoint.
- Input array: `[query, ...fileBodies]` — first element is the query vector.
- Errored files use a zero vector and rank last.
- If the embedding API call fails entirely, the tool throws — no partial results.

### 4. Score — Hybrid RRF
- **Semantic rank**: cosine similarity between query vector and each file vector, sorted descending.
- **Keyword rank**: BM25-style term-frequency score of query tokens against file body, sorted descending.
- **RRF fusion**: `score = 1/(60 + semantic_rank) + 1/(60 + keyword_rank)` where `k=60` (standard constant). Sort descending by fused score.

### 5. Pack
- Take top `topK` files by RRF score.
- Pass them in ranked order to `buildPlan` from `utils.ts` to respect output budget limits.
- Output uses the same heredoc block format as `read_many`.

### 6. Return
- Content blocks in relevance order (heredoc format).
- `details` with per-file scores and packing metadata (see Output section).

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

```typescript
{
  query: string,
  processedCount: number,
  successCount: number,
  errorCount: number,
  topK: number,
  files: Array<{
    path: string,
    ok: boolean,
    error?: string,
    semanticRank: number,     // 1-based rank by cosine similarity
    keywordRank: number,      // 1-based rank by BM25 score
    rrfScore: number,         // fused score (higher = more relevant)
    included: boolean,        // whether content appears in the output
  }>,
  packing: {
    strategy: PackingStrategy,
    switchedForCoverage: boolean,
    fullIncludedCount: number,
    fullIncludedSuccessCount: number,
    partialIncludedPath?: string,
    omittedPaths: string[]
  }
}
```

All candidate files appear in `details.files` regardless of `topK` cutoff or packing, ordered by `rrfScore` descending, so the agent can inspect what was considered and why. If fewer files are available than `topK`, all successful files are returned.

---

## Error Handling

| Layer | Behavior |
|---|---|
| Config missing (`baseUrl` or `model`) | Throw immediately before any reads, pointing to both config paths |
| File read error | Record error, continue (or stop if `stopOnError`). Errored files get zero vector, rank last |
| Embedding API failure | Throw — no partial embedding results returned |

---

## Dependencies

No new runtime dependencies required:
- `fdir` — already in `node_modules`, used for directory expansion
- Embedding calls use Node's built-in `fetch` (Node ≥ 18, project requires ≥ 20)
- BM25 keyword scoring implemented inline (simple enough to not warrant a library)
