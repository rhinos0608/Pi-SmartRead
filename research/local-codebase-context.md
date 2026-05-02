# Local Codebase Context: GraphRAG, CodeRAG Query Probing, and Reranking

This document provides technical context for the implementation of GraphRAG, CodeRAG query probing, and reranking in the Pi-SmartRead (Pi-read-many) codebase.

## 1. Current Architecture Overview

### Orchestration & Tools
The codebase is structured as a collection of Pi tools registered via `ExtensionAPI`. The primary intelligence tools are:
- **`intent_read` (`intent-read.ts`)**: The core RAG tool. Performs hybrid search (BM25 + Cosine/Embedding), uses RRF for ranking, and performs basic graph augmentation (direct imports).
- **`repo_map` (`repomap.ts`)**: Builds a global view of the repository. Uses tree-sitter tag extraction (`tags.ts`) to build a reference graph (definitions/references) and ranks files using PageRank (`pagerank.ts`).
- **`search_symbols` / `resolve_symbol`**: Deep-dive tools for identifier lookup and cross-file resolution using the reference graph.
- **`find_callers` (`callgraph.ts`)**: Analyzes tree-sitter ASTs to build a call graph (specifically for TS/JS/TSX).

### Data Flow (in `intent_read`)
1. **Candidate Resolution**: Resolves directory/file list.
2. **Initial Augmentation**: Adds direct relative import neighbors of candidates (`findDirectImportNeighbours`).
3. **Reading**: Reads file content via `readTool`.
4. **Chunking**: Splits files into chunks. Supports symbol-boundary chunking via `chunking.ts`.
5. **Embedding & Scoring**:
   - Fetches embeddings for chunks and the query.
   - Computes cosine similarity for chunks (max per file used).
   - Computes BM25 for full file bodies (`bm25Scores` in `scoring.ts`).
6. **Ranking**: Merges scores using Reciprocal Rank Fusion (RRF) (`computeRrfScores` in `scoring.ts`).
7. **Packing**: Packs top-K results into the token budget using `buildPlan` (`utils.ts`).

---

## 2. GraphRAG: Current State & Integration Points

### What is Already Present
- **Reference Graph**: `repomap.ts` extracts definition (`def`) and reference (`ref`) tags using tree-sitter (`tags.ts`). It builds edges between files sharing identifiers.
- **Call Graph**: `callgraph.ts` implements `buildCallGraph` which parses ASTs to find `call_expression` nodes and maps them to enclosing functions.
- **Basic Augmentation**: `intent-read.ts` includes `findDirectImportNeighbours`, which parses `import` statements via regex to find adjacent files.

### Safe Integration Points
- **Expansion Logic**: The `graphAugmentation` block in `intent-read.ts` (around line 200) is the primary target. Instead of just `findDirectImportNeighbours`, it can call `buildCallGraph` or leverage the `RepoMap` to find "definition-neighbor" files.
- **Candidate Weighting**: Graph-based scores (e.g., PageRank or in-degree) from `repomap.ts` could be passed to `scoring.ts` as an additional signal for RRF.

### Risks
- **Parsing Latency**: Full AST parsing for call graphs or reference maps can be slow for large repos. PageRank is currently used for the map but suppressed for per-read queries for performance.
- **Noisy Edges**: The backfill in `tags.ts` (regex-based reference extraction) is noisy. Over-relying on it for RAG might pull in unrelated files.

---

## 3. CodeRAG Query Probing: Existing Infrastructure

### What is Already Present
- **Symbol Probing**: `repomap.ts` has `searchIdentifiersByText` and `searchIdentifiers` (using tree-sitter tags). These find line-specific instances of identifiers.
- **Resolution**: `symbol-resolver.ts` has `resolveSymbol`, which finds the "best" definition across files by scoring relevance (proximity, same directory, etc.).

### Suggested Approach
1. **Probe**: Use the search `query` to find critical identifiers in the codebase using `searchIdentifiers`.
2. **Expand**: Take the top-matched symbols and resolve their definitions using `resolveSymbol`.
3. **Seed**: Add the files containing these key definitions and their primary callers (via `callgraph.ts`) to the candidate set in `intent_read` *before* the embedding stage.

### Safe Integration Points
- `intent-read.ts` before the `fileResults` loop: Insert a "probing phase" that identifies core symbols in the query and ensures their definition files are in `resolvedFiles`.

---

## 4. Reranking Implementation Context

### Current State
- **Ranking**: Hybrid BM25 + Embedding similarity combined via RRF(k=60).
- **Logic Location**: `scoring.ts` contains `computeRanks` and `computeRrfScores`.

### Integration Path
- **Third Stage**: Introduce a post-RRF reranking stage.
- **Candidate Reducer**: Take the top ~50 RRF results.
- **Rerank Signals**:
    - **Cross-Encoder**: Call an external API/model with the (Query, Chunk) pair for higher precision relevance.
    - **Structural Reranker**: Adjust ranks based on repo map importance (PageRank) or call-graph centrality.
    - **Path Proximity**: Prefer files closer to already-selected high-confidence hits.

### Safe Integration Points
- After `rankedSuccessOrder` is calculated in `intent-read.ts` (around line 370). This is where the final order of files is determined before packing.

---

## 5. Dependencies and Constraints

- **Tree-sitter**: Used for tags and call graphs. Requires native bindings. `callgraph.ts` and `tags.ts` share grammar loading.
- **Embedding API**: Configured via `config.ts` (`pi-smartread.config.json` or Env Vars).
- **Token Limits**: All output must respect `DEFAULT_MAX_BYTES` and `DEFAULT_MAX_LINES`.
- **Cache**: `PersistentEmbeddingCache` and `TagsCache` are file-system based (per-repo `.pi-smartread.*.cache/`).

## 6. Implementation Risks & Validation

- **Incremental Complexity**: The graph augmentation must remain fast. A full call-graph build on every `intent_read` might exceed the 1s threshold.
- **Testing**: 
    - Update `test/unit/intent-read.test.ts` to mock the expanded graph responses.
    - Add `test/unit/graph-rag.test.ts` to verify neighbor expansion correctness.
- **Validation Path**: Verify that queries like "How does auth work?" successfully pull in the `Authenticator` definition even if the query doesn't match the filename, by probing for "auth" symbols first.

## 7. Non-Goals
- Real-time indexing (watch-mode is listed as medium-term/high-effort).
- Vector DB replacement (sticking to file-based persistent LRU).
- Full cross-language call graph support (currently TS/JS/TSX only).
