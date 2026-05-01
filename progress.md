# Progress

## Status
Current snapshot

## Implemented capabilities

- `read_multiple_files`
  - reads up to 20 files in one call
  - adaptive packing under Pi output limits
  - request-order output with smallest-first fallback only when it improves full successful coverage
- `intent_read`
  - BM25 + embedding similarity
  - Reciprocal Rank Fusion (RRF)
  - compressed embedding snippets with structural headers
  - direct in-workspace import-neighbour augmentation
  - 64-entry in-memory LRU cache for embedding batches
  - BM25-only degradation when the embedding request fails after config validation
- `repo_map`
  - tree-sitter-first repository mapping
  - PageRank-based ranking
  - import-based fallback mode
  - compact mode for first-read orientation
- `search_symbols`
  - symbol definition/reference search
  - tree-sitter-first extraction with text fallback
  - live-reload verified after the large-file parser fix
- native parsing
  - native `tree-sitter`, `tree-sitter-javascript`, and `tree-sitter-typescript`
  - chunked callback parsing in `tags.ts` to avoid the >32KB native parse failure

## Documentation status

- `README.md` updated to reflect the current tool surface, hook behavior, configuration, native parser path, and troubleshooting guidance
- `docs/research-deep-dive.md` updated with a current implementation snapshot and refreshed unknowns

## Verification snapshot

- `npm test -- --run test/unit/tags.test.ts test/unit/repomap-search.test.ts test/unit/repomap-tool.test.ts test/unit/index.test.ts`
- `npm run typecheck`
- `git diff --check`
