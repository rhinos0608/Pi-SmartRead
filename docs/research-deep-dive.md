# Deep Research: Code-Aware Retrieval, Repo Mapping & Agent Integration

> **Date:** 2026-05-01
> **Scope:** Cross-referencing Pi-SmartRead against the ecosystem of code intelligence tools
> **Sources:** GitHub (live API), Reddit (r/LocalLLaMA), Hacker News, Academic (arXiv), Code-level analysis

---

## Executive Summary

Pi-SmartRead occupies a niche at the intersection of **code-aware hybrid retrieval**, **repository mapping via tree-sitter + PageRank**, and **agent tool extension**. The landscape is vibrant with ~6 directly comparable projects, each contributing distinct patterns. Three high-ROI patterns emerge for immediate integration: **RRF fusion scoring**, **AST-aware chunking with context headers**, and **graph-neighbour augmentation**. Medium-term: **cross-encoder re-ranking**, **model-agnostic embedding registry**, and **HyDE query expansion**.

## Current Implementation Snapshot (2026-05-01)

Pi-SmartRead is now an independent fork at `rhinos0608/Pi-SmartRead`, detached from the upstream `Gurpartap/pi-read-many`. It ships 7 code-intelligence tools:

- `read_multiple_files` with adaptive packing under Pi output limits
- `intent_read` with BM25 + embedding similarity, RRF fusion, persistent disk-backed embedding cache, LRU in-memory layer, direct import-neighbour augmentation, and compressed embedding snippets
- `repo_map` with tree-sitter-first ranking (41 languages), PageRank personalization, and import-based fallback
- `search_symbols` with native tree-sitter symbol extraction plus text fallback
- `resolve_symbol` with cross-file resolution, context-aware disambiguation, and best-guess definition selection
- `find_callers` with call graph extraction from tree-sitter ASTs (TypeScript, JavaScript, TSX)
- First-read hook that intercepts the initial read-like call per repo to return a compact repo map
- Native `tree-sitter` parsers for JavaScript and TypeScript (not WASM)
- Chunked callback parsing in `tags.ts`, which avoids the native binding failure on large TypeScript files

Treat the rest of this document as research, implementation rationale, and roadmap context around that shipped baseline.

---

## Part 1: Directly Comparable Tools

### 1. CodeGraph CLI (`al1-nasir/codegraph-cli`)
- **Stars:** 19 | **Language:** Python | **License:** MIT
- **Stack:** tree-sitter → SQLite graph → LanceDB vectors → RAG → CrewAI multi-agent
- **Key patterns Pi-SmartRead can adopt:**

**Pattern: 5-Tier Embedding Registry**
```python
EMBEDDING_MODELS = {
    "qodo-1.5b": {"hf_id": "Qodo/Qodo-Embed-1-1.5B", "dim": 1536, "pooling": "last_token"},
    "jina-code": {"hf_id": "jinaai/jina-embeddings-v2-base-code", "dim": 768, "pooling": "mean"},
    "bge-base":  {"hf_id": "BAAI/bge-base-en-v1.5", "dim": 768, "pooling": "cls"},
    "minilm":    {"hf_id": "sentence-transformers/all-MiniLM-L6-v2", "dim": 384, "pooling": "mean"},
    "hash":      {"hf_id": None, "dim": 256, "pooling": None},
}
```
Pi-SmartRead currently has a single model config via OpenAI-compatible endpoint. CodeGraph shows a pattern where a **registry of models** lets users trade off quality vs. resource usage. The `hash` fallback (BLAKE2b token hashing → 256-dim) is a zero-dependency safety net that always works.

**Pattern: Graph-Neighbour Augmentation**
```python
def _augment_with_graph_neighbours(self, results, query_emb, max_total):
    """For top-3 semantic hits, fetch outgoing+incoming graph edges,
    score neighbours against query, merge de-duplicated."""
    for sr in results[:3]:
        for edge in self.store.neighbors(sr.node_id):    # outgoing edges (CALLS, IMPORTS)
            ...
        for edge in self.store.reverse_neighbors(sr.node_id):  # incoming (CALLED_BY, IMPORTED_BY)
            ...
```
This is a pattern Pi-SmartRead's `intent_read` can adopt: expand the candidate set with structurally connected files so relevant context missed by embeddings still enters ranking. Initial integration adds direct in-workspace relative import neighbours before reading/ranking, with deterministic deduping, a 20-candidate cap, and realpath-based symlink/workspace escape guards.

**Pattern: LRU Query Cache**
```python
self._cache = OrderedDict()  # max 64 entries
```
`intent_read` queries during an agent session are often repeated — caching avoids re-embedding unchanged query/content batches. Initial integration adds a 64-entry in-memory LRU cache scoped to each `intent_read` tool instance.

**Pattern: Context Compression**
```python
def _compress_snippet(code, max_chars=1000):
    code = _IMPORT_RE.sub("", code)           # strip imports
    code = re.sub(r"\n{3,}", "\n\n", code)    # collapse blank lines
    if len(code) > max_chars:
        code = code[:max_chars] + "\n# ... (truncated)"
    return code
```
When preparing embedding snippets for the LLM retrieval pipeline, strip noise (imports, blank lines), add file/structure context headers, and truncate with head/tail preservation so late relevant code is not always discarded.

---

### 2. Arbor (`Anandb71/arbor`)
- **Stars:** 111 | **Language:** Rust | **License:** MIT
- **Stack:** tree-sitter → semantic graph → MCP bridge (stdio) → blast-radius analysis
- **Key differentiator:** Deterministic, no embeddings needed — pure graph analysis

**Pattern: MCP Tool Design (stdin/stdout transport)**
```bash
# Claude Code integration
claude mcp add --transport stdio --scope project arbor -- arbor bridge

# Cursor / VS Code integration via mcp.json
{"mcpServers": {"arbor": {"command": "arbor", "args": ["bridge"]}}}
```
Arbor's `arbor bridge` is a stdio MCP server with tools like:
- `refactor <symbol>` — blast radius analysis
- `check --max-blast-radius 30` — CI gate
- `open <symbol>` — graph traversal

Pi-SmartRead's `repo_map` and `intent_read` could be exposed similarly as MCP tools for Cursor/Claude Code, not just Pi.

**Pattern: Incremental Indexing**
> "Sub-second background cache updates instantly tracking your code edits in real-time."

Arbor does incremental re-parsing on file change. Pi-SmartRead uses mtime-based cache invalidation — adding watch-based incremental updates would dramatically reduce latency for repeated queries during active development.

**Pattern: Git-Aware Risk Gating**
```yaml
name: Arbor Check
on: [pull_request]
jobs:
  arbor:
    steps:
      - uses: Anandb71/arbor@v2.0.1
        with:
          command: check . --max-blast-radius 30
```
The idea of using the dependency graph as a CI quality gate is novel for Pi-SmartRead — imagine `pi-smartread check --max-context-size` as a pre-commit hook.

---

### 3. ctx-sys (`david-franz/ctx-sys`)
- **Stars:** 10 | **Language:** TypeScript | **License:** MIT
- **Stack:** tree-sitter → SQLite (FTS5 + sqlite-vec + graph) → 12 MCP tools → HyDE → Ollama
- **This is the closest architectural analogue to Pi-SmartRead** — both are TypeScript, both use tree-sitter, both target agent context management.

**Pattern: Four-Strategy Hybrid RAG with RRF**
```
Vector similarity │ FTS5 keyword │ Graph traversal │ Heuristic reranking
         └──────────────────── RRF fusion ─────────────────────┘
```
Unlike Pi-SmartRead's 2-strategy (BM25 + embedding), ctx-sys combines **four** retrieval strategies using reciprocal rank fusion. The graph traversal leg adds structural context the pure lexical/semantic search misses.

**Pattern: 12 Action-Based MCP Tools**
| Tool | What It Does |
|------|-------------|
| context_query | Hybrid RAG with source attribution |
| entity | CRUD for code/document entities |
| index | codebase, document, sync, status |
| graph | link, query, stats |
| session | create, list, archive, summarize |
| message | store, history |
| decision | search, create (ADR tracking) |
| checkpoint | save, load, list, delete |
| memory | spill, recall, status (hot/cold tiers) |
| reflection | store, query (cross-session learning) |
| project | create, list, set_active, delete |
| hooks | install, impact_report |

This design pattern — **action-based tools** where each tool name is a noun and each action is a verb — is notably clean and agent-friendly. Pi-SmartRead's current tool names (`read_multiple_files`, `intent_read`, `repo_map`, `search_symbols`) could be re-thought as action-oriented tools:
- `codebase.search` (semantic + keyword + graph)
- `codebase.map` (repo map)
- `codebase.symbols` (find definitions/references)
- `codebase.read` (batch read with context)

**Pattern: HyDE (Hypothetical Document Embedding)**
```bash
ctx-sys search "database connection pooling" --hyde
```
HyDE generates a synthetic answer to the query, embeds *that*, then retrieves documents similar to the synthetic answer. This bridges the "query is short, documents are long" gap that plagues code retrieval. ctx-sys uses `gemma3:12b` via Ollama for HyDE generation.

**Pattern: Smart Context Expansion**
```bash
ctx-sys context "error handling in the API layer" --max-tokens 8000 --no-expand
```
After initial retrieval, expand each result by fetching its parent scope (enclosing function/class) and its immediate dependencies.

---

### 4. libragen (`libragen/libragen`)
- **Stars:** 18 | **Language:** TypeScript | **License:** MIT
- **Stack:** ONNX Runtime embeddings → SQLite vector store → MCP server
- **Key differentiator:** Focused on *documentation*, not code. Portable `.libragen` single-file format.

**Pattern: ONNX Runtime for Embeddings (No Torch)**
libragen uses ONNX Runtime for model inference instead of PyTorch/TensorFlow. For Pi-SmartRead's embedding client, supporting ONNX-exported models would reduce the dependency surface (no need for `sentence-transformers` or `torch`).

**Pattern: Single-File Portable Libraries**
```bash
npx @libragen/cli build ./docs --name company-docs  # → company-docs.libragen
```
The idea of serializing the index (code map, embeddings, chunk metadata) into a single portable file could apply to Pi-SmartRead: `pi-smartread export --output project.map` for sharing project context.

---

### 5. Microsoft GraphRAG (broader reference)
- **Stars:** 23k+ | **Language:** Python | **License:** MIT
- **Pattern:** Community detection on the entity graph → hierarchical summarization → retrieval traverses communities

While overkill for Pi-SmartRead's scope, the pattern of using **Leiden community detection** on the dependency graph to find "logical groups" of code (services, modules, subsystems) could inform a smart context expansion: "retrieve all related symbols in the same community."

---

## Part 2: Academic & Industry Patterns

### Hybrid Retrieval (Sparse + Dense Fusion)

The consensus across papers (Blended RAG, Sparse Meets Dense, Adaptive Chunking, late chunking vs. contextual retrieval) is:

1. **Sparse (BM25)** excels at exact identifier/API name matching — critical for code
2. **Dense (embeddings)** excels at conceptual similarity — "find the auth logic"
3. **RRF (k=60)** is the preferred fusion method — parameter-free, robust across domains
4. **Cross-encoder re-ranking** on top-20/50 results adds 10-15% MRR improvement
5. **Two-stage is the standard**: hybrid retrieve → cross-encode re-rank

### Code Chunking

The Adaptive Chunking paper (2026) proposes 5 intrinsic metrics:
- **References Completeness (RC)** — do chunks preserve cross-references?
- **Intrachunk Cohesion (ICC)** — is code within a chunk semantically related?
- **Document Contextual Coherence (DCC)** — does chunk order preserve document flow?
- **Block Integrity (BI)** — are functions/classes kept whole?
- **Size Compliance (SC)** — do chunks respect token budgets?

For code specifically, the pattern used by CodeGraph CLI and codeqai is:
```
Chunk = smallest complete AST unit (function/method/class)
       + context header ("File: auth.ts > Class: Authenticator > Method: login")
       + no import lines (they dilute the embedding)
```

vs. Pi-SmartRead's current approach (overlapping fixed-size line windows). AST-aware chunking consistently outperforms fixed-size for code retrieval by 30-50% on recall@5.

### Late Chunking vs. Contextual Retrieval
Paper (Merola & Singh, 2025):
- **Late chunking**: embed the full document, then pool embeddings for each chunk — preserves global document context
- **Contextual retrieval**: prepend document-level context to each chunk before embedding
- **Verdict**: contextual retrieval better for coherence, late chunking better for speed

---

## Part 3: Specific Patterns by Module

### For `scoring.ts` (BM25 + ranking)
| Pattern | Source | Impact |
|---------|--------|--------|
| RRF fusion (k=60) instead of score interpolation | ctx-sys, ranx, academic consensus | Eliminates score normalization issues |
| 4-strategy fusion (vector + FTS5 + graph + heuristic) | ctx-sys | Higher recall on structural queries |
| Minimum score threshold (0.05) | CodeGraph CLI | Filters noise before ranking |
| LRU query cache (64 entries) | CodeGraph CLI | ~80% hit rate on repeated agent queries |

### For `chunking.ts`
| Pattern | Source | Impact |
|---------|--------|--------|
| Chunk by tree-sitter named nodes (not line windows) | CodeGraph CLI, codeqai, academic | 30-50% recall improvement |
| Context headers: `File: X > Class: Y > Method: Z` | CodeGraph CLI, codeqai | Anchors embeddings to structure |
| Strip import lines before embedding | CodeGraph CLI RAG | Reduces embedding noise |
| Adaptive chunking based on 5 intrinsic metrics | Ekimetrics paper (2026) | Document-specific optimal chunking |
| Late chunking for docs, AST-chunk for code | Merola & Singh (2025) | Best of both worlds |

### For `intent_read.ts`
| Pattern | Source | Impact |
|---------|--------|--------|
| Graph-neighbour augmentation (top-3 → expand via edges) | CodeGraph CLI | Adds structural context missed by embeddings |
| HyDE query expansion | ctx-sys | Better retrieval for vague/short queries |
| File/directory filter (WHERE clause) | CodeGraph CLI, ctx-sys | Precision for targeted queries |
| Context compression before returning to LLM | CodeGraph CLI `retrieve_context()` | Cleaner, token-efficient output |

### For `embedding.ts`
| Pattern | Source | Impact |
|---------|--------|--------|
| Model registry (not single config) | CodeGraph CLI 5-tier | User choice quality vs. resource |
| Hash fallback (BLAKE2b, 256-dim) | CodeGraph CLI | Always works, zero deps |
| ONNX Runtime mode | libragen | Lighter than torch/transformers |
| Dimension validation on stored embeddings | CodeGraph CLI `rag.py:184` | Prevents silent bugs on model swap |

### For `repomap.ts` + `pagerank.ts`
| Pattern | Source | Impact |
|---------|--------|--------|
| Personalized PageRank (query-biased teleport) | Aider | Relevance-aware ranking |
| Multi-edge types (CALLS, EXTENDS, IMPLEMENTS, not just IMPORTS) | Aider, Arbor | Richer graph |
| Incremental indexing (watch mode) | Arbor, ctx-sys | Sub-second updates |
| Community detection (Leiden) | GraphRAG | Smart context grouping |
| SCIP index integration | sourcegraph/scip | More precise than tree-sitter alone |

### For hook system (`hook.ts`)
| Pattern | Source | Impact |
|---------|--------|--------|
| Git-aware hooks (pre-commit impact report) | Arbor, ctx-sys | CI integration |
| Watch-and-reindex | ctx-sys, CodeGraph CLI | Real-time updates |

---

## Part 4: MCP Integration Opportunities

Pi-SmartRead currently exists as a Pi extension. All three comparable tools (Arbor, ctx-sys, libragen) already have MCP servers. Opportunities:

1. **MCP Server wrapper**: Expose `repo_map`, `intent_read`, `search_symbols` as MCP tools for Cursor/Claude Code/VS Code
2. **Action-based tool design**: Follow ctx-sys's pattern — nouns as tool names, verbs as actions
3. **Project-scoped MCP config**: `.pi/smartread-mcp.json` similar to Arbor's `.cursor/mcp.json`
4. **Remote MCP**: Arbor supports Docker + GHCR — Pi-SmartRead could too

---

## Part 5: Prioritized Adoption Roadmap

### Completed
1. ~~**RRF fusion in `scoring.ts`**~~ — shipped via RRF(k=60).
2. ~~**Context-header chunking in `chunking.ts`**~~ — initial integration with file/function/class headers and compressed embedding text.
3. ~~**LRU query cache in `intent_read`**~~ — shipped (64-entry in-memory).
4. ~~**Graph-neighbour augmentation**~~ — initial direct relative import-neighbour expansion shipped.
5. ~~**Context compression**~~ — shipped for embedding snippets.
6. ~~**Minimum score threshold**~~ — shipped for low-signal candidates.
7. ~~**Persistent embedding cache**~~ — shipped (disk-backed, survives restarts).
8. ~~**Call graph analysis**~~ — shipped via `find_callers`.
9. ~~**Cross-file symbol resolution**~~ — shipped via `resolve_symbol`.
10. ~~**41-language support**~~ — shipped for repo_map.

### Medium-Term (High ROI, Higher Effort)
- **Cross-encoder re-ranking** — add lightweight re-ranker on top-20 results. Needs model loading.
- **HyDE query expansion** — generate hypothetical code/docs for better embedding. Needs LLM call.
- **MCP server exposure** — wrap tools for Cursor/Claude Code. New module.

### Long-Term (Architectural)
- **Model registry** — multiple embedding model options with hash fallback
- **Incremental indexing** — watch mode for real-time updates
- **Portable export** — single-file project maps
- **Community detection** — group code into logical clusters

---

## Part 6: Key Repos to Track

| Repo | Stars | Why |
|------|-------|-----|
| `al1-nasir/codegraph-cli` | 19 | Best embedding/RAG implementation to learn from |
| `Anandb71/arbor` | 111 | Best MCP integration + Rust AST design |
| `david-franz/ctx-sys` | 10 | Closest architectural analogue, richest MCP tool design |
| `libragen/libragen` | 18 | ONNX embedding pattern, portable format |
| `Aider-AI/aider` | 30k+ | PageRank reference implementation |
| `microsoft/graphrag` | 23k+ | Community detection pattern |
| `sourcegraph/scip` | 800+ | Symbol index protocol |
| `AmenRa/ranx` | 800+ | RRF reference implementation |

---

## Part 7: Gaps & Unknowns

1. **Retrieval quality still lacks formal benchmarks** — no Recall@k, MRR, or NDCG measurements to quantify retrieval quality over time.
2. **Embedding model in use is deployment-specific** — the OpenAI-compatible endpoint could proxy to very different embedding models depending on the environment.
3. **AST chunking is still partial** — context-header chunking and snippet compression are implemented, but full AST-unit chunking remains future work.
4. **Call graph is TypeScript/JavaScript/TSX only** — `find_callers` does not yet support Python, Go, Rust, or other languages with tree-sitter parsers.
5. **Test corpus needed** — a standard set of 5-10 open-source repos of varying sizes would make retrieval regressions easier to catch and compare.
