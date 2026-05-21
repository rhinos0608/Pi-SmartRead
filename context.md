# Implementation Context: Code Intelligence Toolkit

## Tool Surface

All tools are registered through the central `ToolRegistry` (`tool-registry.ts`), consumed by both the Pi extension API (`index.ts`) and the standalone MCP server (`mcp-server.ts`).

### Core Tools

| Tool | File | Description |
|------|------|-------------|
| `read` | `unified-read.ts` | Unified reader: single-file (`file`), multi-file batch (`multiple`), intent-based hybrid RRF retrieval (`intent`). The intent mode delegates to `intent-read.ts` internally. |
| `read_files` | `read-many.ts` | Multi-file batch read with adaptive output packing. |
| `intent_read` | `intent-read.ts` | Intent-based retrieval with hybrid RRF (BM25 + embeddings). |
| `search` | `search-tool.ts` | Consolidated search: `grep` (AST-aware definition), `code` (BM25 + embedding with symbol enrichment), `deep` (multi-channel orchestration). |
| `repo_map` | `repomap-tool.ts` → `repomap.ts` → `repomap-pipeline.ts` | PageRank-ranked repo map via native tree-sitter. |
| `find_symbol` | `find-symbol-tool.ts` | Symbol exploration: name search, file outline, references, declaration, implementations, workspace-wide LSP search, hover info. |

### Experimental Tools (opt-in via config)

| Tool | File | Description |
|------|------|-------------|
| `graph_mutate` | `graph-mutate.ts` | Records breakage/co-change edges via EdgeStore (event-sourced JSONL). |
| `git_notes_*` | `git-notes-tool.ts` | Read/write git notes on objects. |

### Cross-Cutting Safety Features (in `index.ts` via event hooks)

| Feature | What it does |
|---------|--------------|
| **Context hygiene** | Tracks read tool results; marks stale context after mutations. Files: `context-hygiene.ts`, `context-application.ts`. |
| **Doom-loop detection** | Warns on repeated identical tool calls (3+). File: `doom-loop.ts`, `doom-loop-suggestions.ts`. |
| **Bash context guard** | Caps oversized bash output to head+tail preview. File: `bash-context-guard.ts`. |
| **LSP document tracking** | Opens read files on LSP, closes mutated files for fresh re-reads. File: `lsp-bridge.ts`. |

---

## Core Retrieval Pipeline (`intent_read`)

### Data Flow

1. **Candidate Resolution** (`resolver.ts`): Resolves explicit files or directory scan (capped at MAX_INTENT_READ_FILES=500). `presortPathsByQuery` reorders by filename/query token overlap.

2. **Graph Augmentation** (`context-graph.ts`):
   - Phase 2a: **Import neighbours** — `findDirectImportNeighbours` (regex-based, batch scan). Adds direct in-workspace relative imports.
   - Phase 2b: **Symbol neighbours** — Uses pre-built shared ContextGraph symbol index. Finds co-occurring symbols across files.
   - Phase 2c: **Call graph neighbours** — Caller/callee expansion for high-confidence function references.
   - Graph distance tracking: 0 = seed, 1 = import neighbour, 2 = symbol/call neighbour.

3. **Query Probing** (`query-probe.ts`): Extracts code identifiers from the query, resolves them via the context graph's symbol index. Adds definition files as candidates. Gated behind `probeEnabled: true`.

4. **Reading & Chunking**: Reads file content via the read tool. Chunks via `chunkTextAst()` (`chunking.ts`), which tries AST-accurate chunking (`ast-chunker.ts` via web-tree-sitter WASM) first, then falls back to regex-based symbol boundaries, then character-size splitting. Triple fallback chain.

5. **HyDE Query Expansion** (`hyde.ts`): No-LLM approach — extracts code-like identifiers, generates a synthetic code document from templates, then embeds that instead of the raw query. Gated behind `hydeEnabled: true`.

6. **Scoring & Ranking** (`scoring.ts`):
   - BM25 keyword scores against full file bodies.
   - Embedding cosine similarity for chunks (max per file).
   - Reciprocal Rank Fusion (RRF, k=60) to merge both signals.

7. **Structural Reranking** (`rerank.ts`): Post-RRF reordering using graph distance, probe confidence, PageRank, path proximity, and temporal (git co-commit) signals. Gated behind `rerankEnabled: true`.

8. **External Reranker** (`rerank.ts`): Optional Cohere/Jina-compatible endpoint. Falls back to structural reranking on failure.

9. **Packing** (`utils.ts` → `buildPlan`): Builds token-budget-aware output respecting `DEFAULT_MAX_BYTES` (10KB) and `DEFAULT_MAX_LINES` (500).

### Embedding Tier Cache

- **PersistentEmbeddingCache** (`persistent-embedding-cache.ts`): Disk-backed LRU in `.pi-smartread.embeddings.cache/`. SHA-256 content hash keys.
- **In-memory LRU** (64 entries): Fast session repeat lookups.
- **BM25-only degradation**: Graceful fallback when embedding config is missing/unreachable.

---

## Search (`search` tool, `search-tool.ts`)

### Modes

| Mode | Description |
|------|-------------|
| `grep` (default) | AST-aware definition search — finds function/class/method definitions matching by name. Fast, no embeddings. Pure tree-sitter. |
| `code` | BM25 + optional embedding re-rank with symbol resolution enrichment (callers, declarations). Supersedes old `symbols`/`callers`/`resolve` modes. |
| `deep` | Multi-channel orchestration: code + symbols + semantic + graph channels with RRF fusion. Orchestrator is `deep-search.ts` with channel modules: `deep-search-semantic.ts`, `deep-search-structural.ts`, `deep-search-symbol.ts`, `deep-search-graph.ts`, `deep-search-lsp.ts`. |

### Old tool consolidation

The following standalone tools have been removed and their functionality absorbed into `search`:
- `search_symbols` → `search mode="grep"` or `find_symbol action="symbol"`
- `resolve_symbol` → `search mode="code"` (auto-resolves top symbols)
- `find_callers` → `search mode="code"` (caller enrichment in results)
- `smartread_status` → absorbed into cross-cutting health checks

---

## Symbol Tool (`find_symbol`, `find-symbol-tool.ts`)

Seven actions: `symbol` (default name search), `overview` (file outline), `references`, `declaration`, `implementations`, `workspace` (LSP), `hover`. Uses tree-sitter for AST operations and LSP bridge for workspace/hover queries.

---

## Repo Map (`repo_map`)

The old monolithic `repomap.ts` has been split into a barrel module re-exporting from:
- **`repomap-pipeline.ts`** — Orchestration, RepoMap class, searchIdentifiers, sortSearchResults.
- **`repomap-ranking.ts`** — PageRank, import graph edge weighting, `parseTsconfigPaths`, `getRankedTags`, `getImportRankedTags`.
- **`repomap-render.ts`** — Token-budgeted rendering, tree-context output.
- **`pagerank.ts`** — Standalone PageRank algorithm.

The `repo_map` tool (`repomap-tool.ts`) wraps these with config/parameter handling.

---

## Context Graph (`context-graph.ts`)

Builds a file-neighbour graph from:
- **Imports**: Regex-based `IMPORT_SPECIFIER_RE` parsing
- **Symbols**: Tree-sitter tags (definitions/references) — `getTagsBatch`, `TagsCache`
- **Calls**: `buildCallGraph` (TS/JS/TSX/Python/Go/Rust via native tree-sitter)
- **Mutation edges**: `EdgeStore` — breakage and co-change edges from `graph_mutate` tool, persisted as append-only JSONL
- **Git co-commits**: `git-context.ts` — `extractCoCommitPairs` for co-change frequency signals

Edge types: `imports`, `imported_by`, `defines`, `defined_in`, `references`, `referenced_by`, `calls`, `called_by`, `breakage`, `co_change`.

---

## AST & Chunking

### Three-Level Fallback Chain

1. **WASM AST** (`ast-chunker.ts` + `grammar-loader.ts`): Uses `@vscode/tree-sitter-wasm` + `web-tree-sitter` for AST-accurate symbol boundary detection. Same infrastructure as smart-edit extension.
2. **Regex symbol boundaries** (`chunking.ts` → `extractSymbolBoundaries`): Lightweight regex + brace matching for C-family languages.
3. **Character-size splitting**: Pure chunk-size-based split.

### Language Support

- **41 native tree-sitter grammars** for `repo_map` and `search`
- **WASM grammars for chunking**: Bash, C#, C++, CSS, Go, Java, JavaScript, PHP, Python, Ruby, Rust, TSX, TypeScript
- **Call graph**: TypeScript, JavaScript, TSX, Python, Go, Rust

---

## MCP Server (`mcp-server.ts`)

Standalone MCP stdio server exposing all tools plus:
- **Prompts** (`mcp-prompts.ts`): `explain-code`, `review-diff`, `architectural-analysis`
- **Resources** (`mcp-resources.ts`): SmartRead config, recent files, workspace info

Uses `@modelcontextprotocol/sdk` v1.29.0 with low-level `Server` class (tools + prompts + resources capabilities). Graceful shutdown on SIGINT/SIGTERM/uncaughtException/unhandledRejection.

---

## Additional Modules

| Module | Purpose |
|--------|---------|
| `classifiers.ts` | Confidence/relevance classification thresholds for public API output. |
| `code-summary.ts` | File-level code summarization (symbol count, comment ratio, language detection). |
| `config.ts` | Configuration loading from `pi-smartread.config.json` or env vars. |
| `embedding.ts` | OpenAI-compatible embedding API client with sharded requests. |
| `local-embedding-provider.ts` | Local embeddings via `@huggingface/transformers` (ONNX). |
| `git-context.ts` | Git co-commit extraction, EdgeStore auto-population. |
| `git-history.ts` | Git history queries (co-committed files). |
| `git-notes.ts` | Git notes read/write primitives. |
| `graphify-enricher.ts` | Knowledge graph enrichment for read results. |
| `hashline.ts` | Hashline anchor engine (xxHash32-based line hashing, mirrors smart-edit). |
| `hook.ts` | Session hooks: startup repo map injection, read enrichment, contextual graph cache. |
| `internal-url-router.ts` | URL routing for `skill://`, `memory://`, `graph://` internal URLs. |
| `languages.ts` | Language detection (ext-to-lang, filename-to-lang). Split from `tags.ts`. |
| `lsp-bridge.ts` | Minimal JSON-RPC LSP client for symbol queries and document tracking. |
| `fs-scan-cache.ts` | TTL-based cache for filesystem scan results, invalidated on write/edit. |
| `monorepo-detector.ts` | Monorepo structure detection. |
| `orama-search.ts` | Orama full-text search integration. |
| `sqlite-vec-store.ts` | SQLite vector store integration. |
| `tag-registry.ts` | Tag registry for tool registration. |
| `tree-context.ts` | Tree context generation. |
| `types.ts` | Extension context adapter, tool definition types. |
| `utils.ts` | Shared utilities: hashline formatting, content packing, path validation, LRU cache. |

---

## Important Patterns

- **Triple Fallback**: Used throughout — WASM AST → regex → text, contextual map → focus-free → unhinted.
- **Tool-Observability**: All tools return a `details` object with stats (timing, cache hits, candidate counts).
- **Write-Through Caching**: `PersistentEmbeddingCache` implements memory LRU + Disk JSON storage with SHA-256 keys.
- **Event-Sourced Graph Edges**: `EdgeStore` is append-only JSONL, replayed on graph construction. Deterministic within a retrieval call.
- **Graceful Degradation**: All retrieval features degrade gracefully (no hard failures when embeddings/config are missing).

## Dependencies

- **`@modelcontextprotocol/sdk`** ^1.29.0 — MCP protocol
- **`tree-sitter`** 0.21.1 (native) — AST for mapping, search, call graphs
- **`@orama/orama`** ^3.1.18 — In-memory BM25 full-text search engine
- **`sqlite-vec`** ^0.1.9 — SQLite loadable extension for vector KNN search
- **`@huggingface/transformers`** — Local embedding provider (optional)
- **`xxhash-wasm`** ^1.1.0 — Hashline anchor computation
- **`@sinclair/typebox`** — Runtime type validation for tool schemas

## Implementation Risks

- **Parsing Overhead**: Full call-graph extraction during `intent_read` may exceed 1s target. Gated behind `probeEnabled: true`.
- **WASM Constraints**: Native tree-sitter for tags + web-tree-sitter WASM for chunking means two parsing infrastructures.
- **sqlite-vec Schema Migrations**: `vec0` virtual tables don't support `ALTER TABLE`. Migrations require CREATE/DROP/INSERT SELECT cycles.
- **LSP Spawn Overhead**: LSP bridge spawns language servers lazily; first query per language incurs startup latency.
