# Local Codebase Context: GraphRAG, CodeRAG Query Probing, and Reranking

> **Status (2026-05-21):** Most features described in this document are now implemented. Sections note implementation status.

This document provides technical context for the implementation of GraphRAG, CodeRAG query probing, and reranking in the Pi-SmartRead codebase.

## 1. Current Architecture Overview

### Orchestration & Tools

The codebase is structured as a collection of Pi tools registered via `ExtensionAPI` + a standalone MCP server (`mcp-server.ts`). Tools are registered through the central `ToolRegistry` (`tool-registry.ts`). The primary intelligence tools are:

- **`intent_read` (`intent-read.ts`)**: The core RAG tool. Performs hybrid search (BM25 + Cosine/Embedding), uses RRF for ranking, and performs graph augmentation (imports + symbols + calls + mutation edges).
- **`repo_map` (`repomap-tool.ts` → `repomap.ts` barrel → `repomap-pipeline.ts`/`repomap-ranking.ts`/`repomap-render.ts`)**: Builds a global view of the repository. Uses tree-sitter tag extraction to build a reference graph and ranks files using PageRank.
- **`search` (`search-tool.ts`)**: Consolidated search with three modes — `grep` (AST definition), `code` (BM25 + embedding + enrichment), `deep` (multi-channel).
- **`find_symbol` (`find-symbol-tool.ts`)**: Symbol exploration with 7 actions (symbol, overview, references, declaration, implementations, workspace, hover).
- **`graph_mutate` (`graph-mutate.ts`)**: [Experimental] Records breakage/co-change edges via EdgeStore.

> **Note:** `search_symbols`, `resolve_symbol`, and `find_callers` were removed in the search consolidation. Their functionality is available via `search` (code mode auto-resolves) and `find_symbol`.

### Data Flow (in `intent_read`)

1. **Candidate Resolution**: Resolves directory/file list via `resolver.ts`.
2. **Graph Augmentation**: Import neighbours (`findDirectImportNeighbours`), symbol neighbours (ContextGraph symbol index), call graph neighbours.
3. **Query Probing** (`query-probe.ts`): ✅ Implemented. Extracts identifiers from query, resolves via symbol index. Gated behind `probeEnabled: true`.
4. **Reading**: Reads file content via the read tool.
5. **Chunking**: AST-accurate via `ast-chunker.ts` (WASM web-tree-sitter), falls back to regex symbol boundaries, then character-size.
6. **HyDE** (`hyde.ts`): ✅ Implemented. No-LLM hypothetical document embeddings. Gated behind `hydeEnabled: true`.
7. **Embedding & Scoring**: Fetches embeddings for chunks and query, computes cosine similarity + BM25.
8. **Ranking**: RRF(k=60) via `computeRrfScores` in `scoring.ts`.
9. **Reranking** (`rerank.ts`): ✅ Implemented. Post-RRF structural reranking (graph distance, probe confidence, PageRank, temporal). Gated behind `rerankEnabled: true`.
10. **External Reranker**: ✅ Implemented. Cohere/Jina-compatible endpoint. Falls back to structural reranker on failure.
11. **Packing**: `buildPlan` from `utils.ts`.

---

## 2. GraphRAG: Current State & Integration Points

### What is Implemented ✅

- **Reference Graph**: `repomap-pipeline.ts` extracts definition and reference tags using tree-sitter. Edges between files sharing identifiers.
- **Call Graph**: `callgraph.ts` implements `buildCallGraph` (TS/JS/TSX/Python/Go/Rust).
- **Import Augmentation**: `findDirectImportNeighbours` in `intent-read.ts` (regex-based batch scan).
- **Symbol-Augmented Expansion**: Phase 2b in `intent-read.ts` — uses pre-built ContextGraph symbol index for symbol-neighbour expansion.
- **Call-Graph-Augmented Expansion**: Phase 2c — caller/callee expansion for high-confidence function symbols.
- **Mutation Edges**: `EdgeStore` (`context-graph.ts`) persists breakage and co-change edges via `graph_mutate` tool. Event-sourced JSONL.
- **Graphify Enrichment**: Knowledge graph enrichment via `graphify-enricher.ts` on read results.
- **Git Co-Commits**: `git-context.ts` extracts co-commit pairs for temporal graph signals.

### Integration Points

- The graph augmentation block in `intent-read.ts` is the primary target — it now runs three expansion phases (imports → symbols → calls).
- Graph-based scores (PageRank) from `repomap-ranking.ts` can be passed to `scoring.ts` as an additional RRF signal.
- **`rerank.ts`** already uses graph distance and temporal signals as reranking features.

### Risks

- **Parsing Latency**: Full AST parsing for call graphs can be slow. The symbol index and call graph are pre-built once per `ContextGraph` instance (cached via LRU per cwd). Probe/rerank phases are gated behind config flags.
- **Noisy Edges**: The backfill in `tags.ts` (regex-based reference extraction) is noisy. Symbol-neighbour expansion and mutation edges are higher-confidence.

---

## 3. CodeRAG Query Probing: Current State ✅

### What is Implemented ✅

- **Query Probing** (`query-probe.ts`): Extracts code identifiers from the user's natural-language query, resolves them via the ContextGraph's symbol index, and adds definition files as candidates before the embedding/ranking stage.
- **Integration Point**: Phase 3 in `intent-read.ts`, before the main `fileResults` loop.
- **Symbol Resolution**: `symbol-resolver.ts` provides `resolveSymbol` for cross-file definition lookup.
- **Gating**: Controlled by `probeEnabled: true` in config (default off, since probe uses tree-sitter which is expensive for simple queries).
- **Caller Expansion**: When probe matches a function/class, `search mode="code"` auto-resolves callers in the enrichment step.

### Suggested Approach (already implemented)

1. ⚡ **Probe**: Use the search query to find critical identifiers → `query-probe.ts` does this.
2. ⚡ **Expand**: Take top-matched symbols and resolve definitions → ContextGraph symbol index does this.
3. ⚡ **Seed**: Add definition files + callers to candidate set → Phase 2b/2c in `intent-read.ts`.

---

## 4. Reranking: Current State ✅

### What is Implemented ✅

- **Two-stage pipeline**: RRF(k=60) fusion, then post-RRF structural reranking.
- **Structural Reranker** (`rerank.ts`): Adjusts ranks using graph distance, PageRank, path proximity, probe confidence, and temporal (git co-commit) signals.
- **External Reranker** (`rerank.ts`): Optional Cohere/Jina-compatible endpoint. Configurable via `config.ts`.
- **Logic Location**: Post-RRF in `intent-read.ts`, before packing.
- **Fallback chain**: External reranker → structural reranker → original RRF order.

### Integration Points

- The reranking stage runs after `rankedSuccessOrder` is calculated in `intent-read.ts`, before the packing step.

---

## 5. Dependencies and Constraints

- **Tree-sitter**: Native bindings for tags and call graphs. `callgraph.ts` and `tags.ts` share grammar loading.
- **@orama/orama** ^3.1.18: In-memory BM25 full-text search engine (added alongside custom BM25).
- **sqlite-vec** ^0.1.9: SQLite loadable extension for vector KNN search.
- **@huggingface/transformers**: Local embedding provider (optional, for offline embedding inference).
- **Embedding API**: Configured via `config.ts` (baseUrl, model, apiKey from `pi-smartread.config.json` or env vars).
- **Token Limits**: All output respects `DEFAULT_MAX_BYTES` (10KB) and `DEFAULT_MAX_LINES` (500).
- **Cache**: `PersistentEmbeddingCache` (`.pi-smartread.embeddings.cache/`), `TagsCache` (`.pi-smartread.tags.cache/`), `FsScanCache` (TTL-based).

## 6. Implementation Risks & Validation

- **Incremental Complexity**: Graph augmentation is now multi-phase (imports → symbols → calls). Gated behind `probeEnabled: true` for the expensive phases.
- **Testing**: 
    - `test/unit/intent-read.test.ts` — includes graph expansion test cases.
    - `test/unit/query-probe.test.ts` — validates symbol extraction and resolution.
    - `test/unit/rerank.test.ts` — validates reranking logic.
- **Validation Path**: Queries like "How does auth work?" should pull in the `Authenticator` definition even if the query doesn't match the filename — verified via query probing and symbol-neighbour expansion.

## 7. Former Non-Goals (Status Update)

| Item | Status | Notes |
|------|--------|-------|
| Real-time indexing (watch-mode) | ⏳ Not implemented | Listed as medium-term/high-effort. |
| Vector DB replacement | ✅ Done (partially) | `sqlite-vec` added alongside `PersistentEmbeddingCache`. Both coexist. Orama also added for BM25. |
| Full cross-language call graph support | ✅ Done | Now supports TS/JS/TSX **and** Python, Go, Rust via native tree-sitter. |
