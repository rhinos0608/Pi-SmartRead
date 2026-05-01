# Progress

## Status
Current snapshot — 2026-05-01

## Implemented capabilities

- `read_multiple_files`
  - reads up to 20 files in one call
  - adaptive packing under Pi output limits
  - request-order output with smallest-first fallback only when it improves full successful coverage
- `intent_read`
  - BM25 + embedding similarity
  - Reciprocal Rank Fusion (RRF, k=60)
  - compressed embedding snippets with structural headers
  - direct in-workspace import-neighbour augmentation
  - 64-entry in-memory LRU cache for embedding batches
  - persistent disk cache (`.pi-smartread.embeddings.cache/`) that survives restarts
  - BM25-only degradation when the embedding request fails after config validation
- `repo_map`
  - tree-sitter-first repository mapping with native parsers
  - PageRank-based ranking with personalization (focus files, priority identifiers, mentioned idents/fnames)
  - 41 supported languages
  - import-based fallback mode
  - compact mode for first-read orientation
  - mention-aware file-path matching
- `search_symbols`
  - symbol definition/reference search
  - tree-sitter-first extraction with text fallback
  - up to 200 results with code context
- `resolve_symbol`
  - cross-file symbol resolution via tree-sitter AST tags
  - context-aware disambiguation (same file > direct import > same directory > shared parent)
  - best-guess definition selection
  - import specifier extraction and resolution
  - tree context rendering for enriched output
- `find_callers`
  - call graph extraction from tree-sitter ASTs
  - maps call_expression nodes to enclosing function definitions
  - supports TypeScript, JavaScript, and TSX
- native parsing
  - native `tree-sitter`, `tree-sitter-javascript`, and `tree-sitter-typescript`
  - chunked callback parsing to avoid the >32KB native parse failure
- first-read hook
  - intercepts first `read`, `read_multiple_files`, or `intent_read` per repo
  - returns compact repo map for agent orientation
  - suppressed by explicit `repo_map` call

## Repository

Detached from upstream (`Gurpartap/pi-read-many`). Now independent at `rhinos0608/Pi-SmartRead`.

## Documentation status

- `README.md` updated to reflect all 7 tools, configuration, supported languages, caching, and fork status
- `docs/research-deep-dive.md` updated with implementation snapshot and refreshed unknowns
- `progress.md` updated with full capability surface

## Verification snapshot

- `npm test -- --run test/unit/tags.test.ts test/unit/repomap-search.test.ts test/unit/repomap-tool.test.ts test/unit/index.test.ts`
- `npm run typecheck`
- `git diff --check`
