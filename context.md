# Implementation Context: GraphRAG, Query Probing, and Reranking

## Relevant Files & Snippets

### Core Orchestration
- **`intent-read.ts`**: Main `intent_read` tool implementation.
  - *Graph Augmentation*: `findDirectImportNeighbours` (lines 114-142) is the current simple hook.
  - *Ranking Flow*: Lines 350-380 use `computeRrfScores` for merging BM25 and Semantic hits.
  - *Candidate Selection*: Lines 190-210 handle file vs directory resolution and initial graph expansion.

### Graphing & Symbols
- **`callgraph.ts`**: Tree-sitter BASED call graph.
  - `buildCallGraph` (lines 173-233) and `findCallers` (lines 240-278).
- **`repomap.ts`**: Reference graph (tags) and PageRank.
  - `getRankedTags` (lines 538-636) implements sophisticated weighting.
- **`symbol-resolver.ts`**: Cross-file resolution.
  - `resolveSymbol` (lines 127-247) uses tags and import proximity.

### Chunking & Scoring
- **`chunking.ts`**: Symbol-aware chunking.
  - `chunkBySymbolBoundaries` (lines 191-267) uses regex to identify function/class blocks.
- **`scoring.ts`**: Ranking logic.
  - `bm25Scores` (line 82), `cosineSimilarity` (line 144), `computeRrfScores` (line 173).

## Important Patterns
- **Triple Fallback**: Used in `RepoMap.getRepoMap` (contextual -> focus-free -> unhinted) and `searchIdentifiers` (tree-sitter -> tags-check -> text-fallback).
- **Tool-Observability**: All tools return a `details` object with stats (timing, cache hits, candidate counts).
- **Write-Through Caching**: `PersistentEmbeddingCache` implements memory LRU + Disk JSON storage with SHA-256 keys.

## Dependencies & Constraints
- **Tree-sitter**: Used for mapping, symbol search, and call graphs. Native bindings are used (parsing in chunks for reliability).
- **Token Budget**: `DEFAULT_MAX_BYTES` (10KB) and `DEFAULT_MAX_LINES` (500) guide all packing logic via `buildPlan`.
- **Hybrid Fusion**: Strictly RRF(k=60).

## Implementation Risks
- **Parsing Overhead**: Running full call-graph extraction during every `intent_read` might exceed acceptable latency (target < 1s).
- **Tag Noise**: Regex-based "backfill" for references in `tags.ts` is useful but high-noise.
- **WASM Constraints**: The project uses native `tree-sitter`. Porting to WASM for browser/restricted environments would be a major breaking change.
