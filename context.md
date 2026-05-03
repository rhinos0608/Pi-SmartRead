# Implementation Context: GraphRAG, Query Probing, and Reranking

## Relevant Files & Snippets

### Core Orchestration
- **`intent-read.ts`**: Main `intent_read` tool implementation.
  - *Graph Augmentation*: `findDirectImportNeighbours` (lines 114-142) is the current simple hook.
  - *Ranking Flow*: Lines 350-380 use `computeRrfScores` for merging BM25 and Semantic hits.
  - *Candidate Selection*: Lines 190-210 handle file vs directory resolution and initial graph expansion.
  - *AST Chunking Integration*: Now uses `chunkTextAst()` for AST-accurate symbol boundary chunking.
  - *Diagnostics*: Returns `astChunking` field in details when AST chunking was used.

### Graphing & Symbols
- **`callgraph.ts`**: Tree-sitter BASED call graph.
  - `buildCallGraph` (lines 173-233) and `findCallers` (lines 240-278).
- **`repomap.ts`**: Reference graph (tags) and PageRank.
  - `getRankedTags` (lines 538-636) implements sophisticated weighting.
- **`symbol-resolver.ts`**: Cross-file resolution.
  - `resolveSymbol` (lines 127-247) uses tags and import proximity.
- **`context-graph.ts`**: File neighbour graph with import/symbol/call edges.
  - Uses pre-built symbol index from tree-sitter tags (Decision #143).

### Chunking & Scoring
- **`chunking.ts`**: Symbol-aware chunking.
  - `chunkBySymbolBoundaries` uses regex to identify function/class blocks (legacy).
  - `chunkTextAst()` async variant uses web-tree-sitter for AST-accurate boundaries.
  - `extractSymbolBoundaries()` and `findMatchingBrace()` are exported for ast-chunker fallback.
- **`ast-chunker.ts`**: NEW — AST-accurate chunking via web-tree-sitter WASM (same infra as smart-edit).
  - Mirrors smart-edit's `ast-resolver.ts` SYMBOL_NODE_TYPES.
  - Uses `grammar-loader.ts` for lazy WASM grammar loading.
  - Falls back to regex chunking when WASM unavailable.
  - Supports TS, JS, TSX, Python, Rust, Go, Java, C/C++, Ruby, CSS, Bash.
- **`grammar-loader.ts`**: NEW — Lazy-loads WASM grammars from @vscode/tree-sitter-wasm.
  - Mirrors smart-edit's `lib/grammar-loader.ts` for cross-extension consistency.
- **`scoring.ts`**: Ranking logic.
  - `bm25Scores` (line 82), `cosineSimilarity` (line 144), `computeRrfScores` (line 173).

### Smart-Edit Integration
- **Shared infrastructure**: @vscode/tree-sitter-wasm + web-tree-sitter (same versions as smart-edit).
- **Read cache**: Smart-edit automatically tracks reads from Pi-SmartRead via tool_result hooks.
- **See**: `research/smart-edit-integration.md` for full integration analysis.

## Important Patterns
- **Triple Fallback**: Used in `RepoMap.getRepoMap` (contextual -> focus-free -> unhinted) and `searchIdentifiers` (tree-sitter -> tags-check -> text-fallback).
- **Tool-Observability**: All tools return a `details` object with stats (timing, cache hits, candidate counts).
- **Write-Through Caching**: `PersistentEmbeddingCache` implements memory LRU + Disk JSON storage with SHA-256 keys.
- **AST Fallback Chain**: WASM AST → regex symbol boundaries → character-size chunking.

## Dependencies & Constraints
- **Tree-sitter (native)**: Used for mapping, symbol search, and call graphs via N-API bindings.
- **Tree-sitter (WASM)**: Optional dependency via @vscode/tree-sitter-wasm for AST-aware chunking.
  Same packages as smart-edit extension for cross-extension consistency.
- **Token Budget**: `DEFAULT_MAX_BYTES` (10KB) and `DEFAULT_MAX_LINES` (500) guide all packing logic via `buildPlan`.
- **Hybrid Fusion**: Strictly RRF(k=60).

## Implementation Risks
- **Parsing Overhead**: Running full call-graph extraction during every `intent_read` might exceed acceptable latency (target < 1s).
- **Tag Noise**: Regex-based "backfill" for references in `tags.ts` is useful but high-noise.
- **WASM Constraints**: Native tree-sitter for tags + web-tree-sitter WASM for chunking means two parsing infrastructures. Future consolidation possible if native tree-sitter also moves to WASM.
