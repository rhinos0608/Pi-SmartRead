# Code Context

## Files Retrieved
1. `README.md` (lines 1-40) - Current user-facing documentation (largely intercepted by repo-map).
2. `package.json` (lines 1-100) - Defines dependencies (native tree-sitter), scripts, and tool metadata.
3. `index.ts` (lines 1-20) - Main entry point; registers `read_multiple_files`, `intent_read`, `repo_map`, and `search_symbols`.
4. `intent-read.ts` (lines 1-200, 300-500) - Core logic for `intent_read`, hybrid scoring, LRU caching, and graph-neighbour augmentation.
5. `read-many.ts` (lines 50-150) - Implements `read_multiple_files` with adaptive packing.
6. `config.ts` (lines 1-120) - Configuration resolution via `pi-smartread.config.json` and ENV vars.
7. `docs/research-deep-dive.md` (full) - Source of truth for implemented retrieval patterns.
8. `progress.md` (full) - Recent implementation status of advanced features.

## Key Code

### Retrieval & Tools
- `read_multiple_files`: Batch read with adaptive packing (request-order vs. smallest-first to maximize file count).
- `intent_read`: Hybrid ranking using BM25 (keyword) + Cosine Similarity (embeddings) with RRF fusion.
- `graphAugmentation`: Expands search candidates by following relative imports from top-ranked hits.
- `LruCache`: Caches embedding results (64 entries) to optimize repeated agent queries.

### Integration
- **Native tree-sitter**: Migrated from WASM to native bindings for stability; uses chunked callback parsing to handle files >32KB.
- **Config**: Resolves via `pi-smartread.config.json` or `PI_SMARTREAD_*` env vars.

## Architecture
- **Hook System**: `hook.ts` intercepts the first `read` call to provide a repo map.
- **Scoring Pipeline**: `scoring.ts` provides BM25 and RRF; `embedding.ts` handles remote vector fetching.
- **Tree-sitter**: Used for symbol extraction (`tags.ts`) and structural chunking (`chunking.ts`).

## Start Here
Open `README.md` and `docs/research-deep-dive.md`. The README is extremely sparse and outdated compared to the "research deep dive" which contains the actual logic and patterns now implemented in the code (RRF, LRU caching, graph neighbours).

## Analysis of Documentation Coverage

### 1. Relevant Doc Paths
- `README.md`: Primary entry point.
- `docs/research-deep-dive.md`: Detailed technical specs of current retrieval logic.
- `progress.md`: Latest feature status.

### 2. Stale/Missing Sections
- **README.md (STALE)**: Does not document `intent_read`, `search_symbols`, or the configuration requirement for embeddings. It describes the project title but lacks usage examples for the new tools.
- **Native Tree-sitter (MISSING)**: No documentation on the requirement for native bindings or the chunked parsing strategy for large files.
- **Configuration (MISSING)**: `pi-smartread.config.json` and the environment variables (`PI_SMARTREAD_EMBEDDING_BASE_URL`, etc.) are not documented for users.
- **Graph & Cache (MISSING)**: `intent_read` features like graph-neighbour augmentation and LRU caching are only mentioned in internal docs/research, not user-facing guides.

### 3. Recommended Updates (Prioritized)
1. **[High] Setup & Config**: Document `pi-smartread.config.json` and ENV vars in `README.md`. Users cannot use `intent_read` without this.
2. **[High] Tool Reference**: Add usage examples and descriptions for `intent_read` (hybrid search), `read_multiple_files` (packing), and `search_symbols`.
3. **[Med] Performance Features**: Document the LRU cache and graph-augmentation to help agents/users understand why certain files are prioritized.
4. **[Low] Architecture**: Sync `README.md` with the "Deep Dive" findings to explain the RRF scoring and native tree-sitter usage.
