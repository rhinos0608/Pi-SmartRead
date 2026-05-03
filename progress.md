# Progress

## Status
Complete — all implementation plan phases delivered

## Completed (2026-05-03)

### Bug Fix: AST Chunker Infinite Loop
- **File:** `ast-chunker.ts`
- **Problem:** Tree-walking cursor loop compared `cursor.currentNode === rootNode` using reference equality. web-tree-sitter creates new Node wrappers on each `currentNode` access, so the comparison always failed → infinite loop.
- **Fix:** Replaced `===` comparison with a `reachedRoot` flag tracked via `gotoParent()` return value.
- **Impact:** All tests using `.ts` files (WASM grammar) were hanging indefinitely. intent-read graph tests and advanced-retrieval-baseline tests now pass in <100ms.

### Call Graph Expansion in intent_read
- **File:** `intent-read.ts`
- **Change:** Added `includeCalls: true` to `buildContextGraph()` and added phase 2c (call graph neighbour expansion) gated behind `probeEnabled`.
- **Impact:** intent_read now expands candidates with caller/callee files from the call graph when advanced retrieval is enabled.

### Relevance-First Packing Strategy
- **Files:** `intent-read.ts`, `utils.ts`
- **Change:** Added "relevance-first" hybrid packing that guarantees the #1 ranked file is included first, then fills remaining space with smallest-first for maximum coverage. Compares 3 strategies (request-order, smallest-first, relevance-first) and picks the best by success count with top-file tie-break.
- **Impact:** Prevents smallest-first from displacing the highest-confidence result, addressing lost-in-the-middle position sensitivity.

### Call Graph Multi-Language Support (Python, Go, Rust)
- **Files:** `callgraph.ts`, `package.json`, `test/unit/callgraph.test.ts`
- **Change:** Extended call graph extraction to support Python, Go, and Rust. Added tree-sitter grammars for each language. Handles language-specific patterns: Python `call`/`attribute` nodes, Go `selector_expression`, Rust `scoped_identifier`/`field_expression`/`macro_invocation`.
- **Dependencies:** `tree-sitter-python@0.21.0`, `tree-sitter-go@0.21.0`, `tree-sitter-rust@0.21.0`
- **Impact:** `find_callers` and call-graph-based candidate expansion now work in polyglot repositories.

### Retrieval Benchmarks (Recall@k/MRR/NDCG)
- **Files:** `test/unit/retrieval-benchmark.test.ts`
- **Change:** Created a benchmark test suite with 7 scenarios (lexical-exact, lexical-partial, import-neighbor, symbol-cross-file, camelCase-split, noise-filtering, multi-concept) and standard IR metrics (Recall@k, Precision@k, MRR, NDCG@k). Includes aggregate summary table.
- **Results:** avg MRR=1.000, avg Recall=0.929, avg NDCG=0.931
- **Impact:** Provides quantitative retrieval quality tracking and regression detection.

### HyDE Query Expansion
- **Files:** `hyde.ts`, `intent-read.ts`, `config.ts`, `test/unit/hyde.test.ts`
- **Change:** Implemented Hypothetical Document Embeddings using deterministic templates (no LLM required). Generates a hypothetical code document from the query, embeds it instead of the raw query for better semantic matching. Supports function/class/config/module patterns.
- **Config:** `hydeEnabled: true` in `pi-smartread.config.json`
- **Impact:** Improves semantic matching for natural-language queries against code repositories.

### External/Preference Reranker Endpoint
- **Files:** `rerank.ts`, `config.ts`, `test/unit/rerank.test.ts`
- **Change:** Added optional external reranker API support (Cohere/Jina/generic). Supports 3 response formats. Falls back to structural reranker on failure.
- **Config:** `externalReranker: { baseUrl, apiKey?, model?, timeoutMs?, maxDocuments? }`
- **Impact:** Enables high-quality reranking via external services while maintaining local fallback.

### MCP Adapter (stdio Server)
- **Files:** `mcp-server.ts`, `test/unit/mcp-server.test.ts`, `docs/mcp-quickstart.md`
- **Change:** Created a lightweight MCP stdio server (JSON-RPC 2.0) with no SDK dependency. Exposes `intent_read`, `read_multiple_files`, `repo_map`, `search` as MCP tools.
- **Run:** `npm run mcp-server` or `npx tsx mcp-server.ts`
- **Impact:** Makes SmartRead available to any MCP-compatible client (Claude Desktop, Cursor, custom).

### Search Tool Consolidation
- **Files:** `search-tool.ts`, `repomap-tool.ts`, `config.ts`
- **Change:** Consolidated `search_symbols`, `resolve_symbol`, and `find_callers` into a single polymorphic `search` tool with 4 modes (`symbols`, `resolve`, `callers`, `code`). Added AST-aware code definition search with BM25 + optional embedding re-rank (`mode: "code"`). Added cross-mode enrichment (auto-append callers, auto-resolve top result, tag results with symbol metadata). Enrichment configurable via `pi-smartread.config.json` `search.enrich` block.
- **Impact:** Reduced tool surface area from 6 → 4. New `mode: "code"` provides structural code search with complete function/class bodies.

### Updated Test Coverage
- **Test files:** 29 total
- **Tests:** 328 total
- **Updated test files:** `test/unit/repomap-tool.test.ts`, `test/unit/index.test.ts`, `test/unit/mcp-server.test.ts`

---

## Implementation Status (All Phases)

| Phase | Status | Module |
|-------|--------|--------|
| 0 — Baseline & fixtures | ✅ Done | `test/helpers/retrieval-fixtures.ts`, `advanced-retrieval-baseline.test.ts` |
| 1 — Context graph service | ✅ Done | `context-graph.ts` |
| 2 — Graph-aware expansion | ✅ Done | `intent-read.ts` (imports + symbols + calls) |
| 3 — Probe phase | ✅ Done | `query-probe.ts` |
| 4 — Call graph edges | ✅ Done | `callgraph.ts` (TS/JS/TSX/Python/Go/Rust) + `context-graph.ts` |
| 5 — Structural reranker | ✅ Done | `rerank.ts` (local) + `intent-read.ts` |
| 6 — External reranker | ✅ Done | `rerank.ts` (external) + `config.ts` |
| 7 — Context packing | ✅ Done | `intent-read.ts` (relevance-first strategy) |
| 8 — MCP adapter | ✅ Done | `mcp-server.ts` |
| HyDE expansion | ✅ Done | `hyde.ts` + `intent-read.ts` |
| Retrieval benchmarks | ✅ Done | `test/unit/retrieval-benchmark.test.ts` |

---

## Documentation

| Document | Description |
|---|---|
| `README.md` | Main docs — tools, config, features, setup |
| `docs/mcp-quickstart.md` | MCP server setup for Claude Desktop, Cursor, generic clients |
| `docs/phase-6-8-implementation-notes.md` | Detailed implementation notes for all new features |
| `docs/advanced-retrieval-implementation-plan.md` | Original phase-by-phase plan |
| `docs/advanced-retrieval-research.md` | Design research and ecosystem analysis |
| `docs/advanced-retrieval-spec.md` | Technical specification |
| `docs/research-deep-dive.md` | Deep dive into retrieval patterns and roadmap |
| `docs/plans/2026-05-03-search-tool-consolidation-design.md` | Search tool consolidation design |
