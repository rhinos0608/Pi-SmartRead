# Reference Capability Inventory: DeusData/codebase-memory-mcp

> **Source:** [github.com/DeusData/codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) — MIT License
> **Version:** commit hash unknown — captured via web research on 2026-07-16
> **Language:** Pure C, single static binary, zero runtime dependencies
> **Stars:** 32K+ | **Research paper:** arXiv:2603.27277

---

## Summary

codebase-memory-mcp is a high-performance MCP server that indexes codebases into a persistent SQLite-backed knowledge graph using vendored tree-sitter grammars (158 languages) + Hybrid LSP type resolution (12 languages). It exposes 15 MCP tools for graph indexing, structural querying (Cypher-like), semantic vector search (bundled Nomic embeddings), dead code detection, impact analysis, cross-service linking, and ADR management. Ships as a single static C binary. All processing is 100% local.

---

## 1. MCP Tools (15 total)

### 1.1 Indexing Tools (4)

| # | Tool Name | Input Parameters | Output Shape | Behavior |
|---|-----------|-----------------|--------------|----------|
| 1 | `index_repository` | `repo_path` (string, absolute) | `{status, project, nodes, edges, elapsed_ms}` | Full or incremental index. Builds knowledge graph from tree-sitter AST. RAM-first pipeline (LZ4 compressed, in-memory SQLite, single dump). Registers with background watcher. |
| 2 | `list_projects` | _(none)_ | `{projects: [{name, node_count, edge_count, indexed_at, root_path}]}` | Lists all indexed projects with node/edge counts. |
| 3 | `delete_project` | `project` (string) | `{status, deleted}` | Removes a project and all its graph data (nodes, edges, file hashes, coverage). |
| 4 | `index_status` | `project` (string) | `{project, indexed_at, root_path, node_count, edge_count, generation, coverage_status}` | Returns indexing status, coverage metadata, and generation info for a project. |

### 1.2 Query & Analysis Tools (11)

| # | Tool Name | Input Parameters | Output Shape | Behavior |
|---|-----------|-----------------|--------------|----------|
| 5 | `search_graph` | `project`, `label`, `name_pattern` (regex), `qn_pattern`, `file_pattern` (glob), `relationship`, `direction`, `min_degree`, `max_degree`, `limit`, `offset`, `sort_by`, `exclude_labels`, `semantic_query` (string — vector search mode), `case_sensitive` | `{results: [{node, in_degree, out_degree, connected_names}], total, count}` | Structural search (regex on name/QN, label filter, degree filter, file scoping). When `semantic_query` is provided, performs vector similarity search via bundled Nomic embeddings with 11-signal combined scoring. Pagination via limit/offset. |
| 6 | `trace_path` | `project`, `function_name` (string), `direction` ("inbound"/"outbound"/"both"), `depth` (1–5, default 5), `edge_types` (optional filter) | `{root, visited: [{node, hop}], edges: [{from_name, to_name, type, confidence, properties_json}], impact_summary: {critical, high, medium, low, has_cross_service}}` | BFS traversal from a function node. Resolves who calls it and what it calls. Alias: `trace_call_path`. Returns impact summary with risk classification by hop depth. |
| 7 | `detect_changes` | `project`, `diff` (optional — raw git diff; auto-detects if unset) | `{changes: [{file, symbols_affected, risk_level, blast_radius}], summary}` | Maps uncommitted git changes (or provided diff) to affected symbols in the graph. Classifies risk (critical/high/medium/low) based on call-graph centrality and blast radius. |
| 8 | `query_graph` | `project`, `query` (Cypher-like string) | `{columns, rows: [[...]], row_count}` | Read-only openCypher subset execution. Supports MATCH, OPTIONAL MATCH, WHERE, WITH, RETURN, ORDER BY, SKIP, LIMIT, DISTINCT, UNWIND, UNION, CASE. Aggregates (count, sum, avg, min, max, collect). Variable-length paths `[*1..3]`. EXISTS subqueries for dead-code checks. |
| 9 | `get_graph_schema` | `project` | `{node_labels: [{label, count, properties}], edge_types: [{type, count, properties}], relationship_patterns, sample_names}` | Returns node/edge counts, property definitions per label, relationship patterns, and sample names. Run first to understand graph structure. |
| 10 | `get_code_snippet` | `project`, `qualified_name` (string, format: `<project>.<path_parts>.<name>`) | `{code, file_path, start_line, end_line, language}` | Reads source code for a function/method by qualified name. Returns the exact code block. |
| 11 | `get_architecture` | `project`, `path` (optional scope), `aspects` (optional filter: `languages`, `packages`, `entry_points`, `routes`, `hotspots`, `boundaries`, `layers`, `clusters`, `services`, `file_tree`) | `{languages, packages, entry_points, routes, hotspots, boundaries, services, layers, clusters, file_tree}` | Returns codebase overview: detected languages, package summaries, entry points, HTTP routes, hotspots (by fan-in), cross-package boundaries, service links, Louvain/Leiden clusters, file tree. |
| 12 | `search_code` | `project`, `pattern` (string), `file_pattern` (optional glob) | `{results: [{file, line, text, node_match}], count}` | Graph-augmented grep over indexed files. Text search with node disambiguation. |
| 13 | `manage_adr` | `project`, `action` ("get"/"store"/"update"/"delete"), `content` (string), `sections` (optional `{key: value}` map for partial update) | `{adr: {content, created_at, updated_at}}` | CRUD for Architecture Decision Records. ADRs persist across sessions in the project's SQLite store. Max 8000 chars. Section-based parsing/rendering. |
| 14 | `ingest_traces` | `project`, `traces` (array of `{from, to, type}`) | `{validated, rejected, confidence_stats}` | Ingests runtime traces (e.g., from logging/profiling) to validate and create/weight HTTP_CALLS edges with confidence scores. |
| 15 | `check_index_coverage` | `project`, `path` (optional — file or directory) | `{coverage: [{rel_path, kind, detail}], meta: {generation, index_mode, recording_status, coverage_version}, shadow_project}` | Returns index coverage gaps: parse-partial files (ERROR/MISSING regions), skipped files (read/extract/oversized), and metadata. Creates a shadow graph project (`<project>::missed`) for coverage gaps. Used by agent tiers for evidence-path verification. |

---

## 2. Architecture

### 2.1 Storage Backend

- **SQLite** (WAL mode, ACID-safe) — single `.db` file per project in `~/.cache/codebase-memory-mcp/`
- **In-memory during indexing**: RAM-first pipeline with LZ4 HC compression; in-memory SQLite; single dump to disk at end; memory released after
- **FTS5** full-text search with custom `cbm_camel_split` tokenizer (camelCase/snake_case aware)
- **Vector storage**: Nomic `nomic-embed-code` int8 vectors (768-dim, 40K token vocab) stored per-node in SQLite; cosine similarity via custom `cbm_cosine_i8` SQL function
- **Configurable mmap**: `CBM_SQLITE_MMAP_SIZE` env var (default 64MB); disable to avoid SIGBUS under concurrent truncation
- **Bulk write optimization**: Drop indexes → bulk insert → recreate indexes; `synchronous=OFF` during bulk

### 2.2 Code Parsing

- **158 vendored tree-sitter grammars** compiled into the binary (via `internal/cbm/grammar_*.c`)
- **Hybrid LSP** — lightweight C implementation of type-resolution algorithms for 12 language families:
  - Python, TypeScript/JavaScript/JSX/TSX, PHP, C#, Go, C/C++, Java, Kotlin, Rust, Perl
  - Inspired by/compatible with tsserver, pyright, gopls, Roslyn, Eclipse JDT, rust-analyzer
  - Two-layer: tree-sitter pass (syntactic, all 158 languages) → Hybrid LSP pass (type-aware, refines CALLS/USAGE edges)
- **Multi-pass indexing pipeline** (`src/pipeline/`):
  - `pass_parallel.c` — parallel file parsing via worker pool
  - `pass_definitions.c` — function/class/method/interface/enum extraction
  - `pass_calls.c` — call resolution (import-aware, type-inferred)
  - `pass_imports.c` — import/dependency extraction
  - `pass_lsp_cross.c` — cross-file type resolution registry
  - `pass_route_nodes.c` — HTTP route extraction (REST, gRPC, GraphQL, tRPC)
  - `pass_configlink.c` — HTTP route ↔ call-site matching
  - `pass_envscan.c` — environment variable access extraction
  - `pass_configures.c` — configuration relationship edges
  - `pass_k8s.c` — Kubernetes manifest/Dockerfile/Kustomize indexing
  - `pass_infrascan.c` — infrastructure-as-code detection
  - `pass_enrichment.c` — graph enrichment (docstrings, metadata)
  - `pass_tests.c` — test↔source linkage (TESTS edge)
  - `pass_usages.c` — usage pattern extraction
  - `pass_githistory.c` — git blame/churn history
  - `pass_gitdiff.c` — uncommitted change mapping
  - `pass_complexity.c` — complexity metrics (Halstead-lite)
  - `pass_semantic.c` — Nomic embedding generation (40K token vocab, 768-dim int8)
  - `pass_semantic_edges.c` — SEMANTICALLY_RELATED edge creation (vocabulary-mismatch, same-language, score ≥ 0.80)
  - `pass_similarity.c` — SIMILAR_TO edges via MinHash + LSH near-clone detection
  - `pass_cross_repo.c` — CROSS_* edges for multi-repo intelligence
  - `pass_pkgmap.c` — package/module resolution (manifest scanning)
  - `pass_compile_commands.c` — compile_commands.json integration

### 2.3 Graph/Entity Model

#### Node Labels (13)
`Project`, `Package`, `Folder`, `File`, `Module`, `Class`, `Function`, `Method`, `Interface`, `Enum`, `Type`, `Route`, `Resource`

#### Edge Types (19+)
| Edge | Meaning |
|------|---------|
| `CONTAINS_PACKAGE`, `CONTAINS_FOLDER`, `CONTAINS_FILE` | Structural containment |
| `DEFINES`, `DEFINES_METHOD` | Definition membership |
| `IMPORTS` | Module/package imports |
| `CALLS` | Function/method calls (with arg-to-param mapping) |
| `HTTP_CALLS` | Cross-service HTTP route calls (with confidence) |
| `ASYNC_CALLS` | Async/callback-based calls |
| `IMPLEMENTS` | Interface implementation |
| `HANDLES` | Route handler binding |
| `USAGE` | Type/variable usage |
| `CONFIGURES` | Configuration relationships |
| `WRITES` | Config/output writing |
| `MEMBER_OF` | Class/module membership |
| `TESTS` | Test↔source linkage |
| `USES_TYPE` | Type reference |
| `FILE_CHANGES_WITH` | Git co-change correlation |
| `EMITS` / `LISTENS_ON` | Pub/sub channels (Socket.IO, EventEmitter, generic — 8 languages) |
| `DATA_FLOWS` | Data flow with arg-to-param mapping + field access chains |
| `SIMILAR_TO` | MinHash + LSH near-clone (Jaccard scored) |
| `SEMANTICALLY_RELATED` | Vocabulary-mismatch semantic match (score ≥ 0.80) |
| `CROSS_*` | Cross-repo edges |

### 2.4 Embedding / Semantic Search

- **Model**: Nomic `nomic-embed-code` (code-specialized), bundled as static binary data (`vendored/nomic/code_vectors.bin` — ~31MB)
- **Dimensions**: 768-dim int8 vectors
- **Vocabulary**: 40K code tokens (`vendored/nomic/code_tokens.txt`)
- **Generation**: Per-node embedding from function/class signatures, docstrings, and body tokens during indexing
- **Search**: `cbm_cosine_i8` custom SQLite SQL function for cosine similarity scan; 11-signal combined scoring:
  1. TF-IDF
  2. Retrieval-indexed (RRI) vectors
  3. API/Type/Decorator signatures
  4. AST profiles
  5. Data flow
  6. Halstead-lite complexity
  7. MinHash
  8. Module proximity
  9. Graph diffusion
  10. + 1 more (combined ranking)
- **Fully local**: No API key, no Ollama, no Docker. Embeddings run on-device.

### 2.5 Incremental Indexing / File Watching

- **Background watcher** (`src/watcher/watcher.c`):
  - Git-polling based: detects HEAD movement or dirty working tree
  - Adaptive polling intervals: 5s base + 1s per 500 files, capped at 60s
  - On change detection, triggers supervised background re-index (subprocess isolation for RSS management)
  - Registers automatically when `auto_index` is enabled (configurable)
- **Incremental pipeline** (`src/pipeline/pipeline_incremental.c`):
  - File hash comparison (SHA-256 + mtime + size)
  - Only changed/new files are re-parsed
  - Old nodes/edges for deleted files are pruned
- **Configurable**:
  - `auto_index` (bool) — auto-index on MCP session start
  - `auto_index_limit` (int) — max files for auto-index (default 50000)
  - `auto_watch` (bool, default true) — register with background watcher
- **Supervised indexing** (`src/mcp/index_supervisor.c`):
  - Runs indexing in a worker subprocess for RSS isolation
  - Parent process memory is not ratcheted by indexing large repos
  - Kill switch for supervisor path

### 2.6 Community Detection

- **Leiden algorithm** (Traag, Waltman & van Eck 2019, arXiv:1810.08473):
  - Local moving + refinement + aggregation
  - Resolution parameter (default 1.0) for granularity control
  - Used by `get_architecture` for cluster/module discovery
- **Louvain** convenience wrapper (resolution 1.0)

### 2.7 Cypher Query Engine

- **Read-only openCypher subset** (`src/cypher/`):
  - Lexer → Parser → Planner → Executor
  - Clauses: MATCH, OPTIONAL MATCH, WHERE, WITH, RETURN, ORDER BY, SKIP, LIMIT, DISTINCT, UNWIND, UNION/UNION ALL, CASE
  - Patterns: labelled nodes, label alternation, relationship types/direction, variable-length paths `[*1..3]`, inline property maps
  - WHERE operators: `=`, `<>`, `<`, `<=`, `>`, `>=`, AND/OR/XOR/NOT, IN, CONTAINS, STARTS WITH, ENDS WITH, IS [NOT] NULL, regex `=~`, label test, EXISTS subqueries
  - Aggregates: count, sum, avg, min, max, collect (with DISTINCT)
  - Functions: labels, type, id, keys, properties; toLower/toUpper/toString/toInteger/toFloat/toBoolean; size, length, trim/ltrim/rtrim, reverse; coalesce, substring, replace, left, right
  - Unsupported features fail with clear error (no silent empty results)

### 2.8 Distribution & Tool Profiles

- **Tool profiles** (per-agent surface):
  - `CBM_MCP_TOOL_PROFILE_ALL` (0) — full 15-tool surface
  - `CBM_MCP_TOOL_PROFILE_ANALYSIS` (1) — 11 tools (no mutating)
  - `CBM_MCP_TOOL_PROFILE_SCOUT` (2) — 7 fast inspection tools only
- **CLI mode**: Every MCP tool invocable via `codebase-memory-mcp cli <tool_name> '<json>'`
- **UI variant**: Optional 3D graph visualization at `localhost:9749` (embedded HTTP server)

---

## 3. Workflows (End-to-End Session Usage)

### 3.1 First-Time Setup
1. Install binary (`curl | bash` or download from releases)
2. Restart coding agent → agent auto-detects and configures MCP entry
3. Say "Index this project" → `index_repository` runs full index
4. Background watcher auto-registers for ongoing change detection

### 3.2 Query Session
1. `get_graph_schema` → understand graph structure (labels, counts)
2. `search_graph` / `semantic_query` → find relevant symbols
3. `trace_path` → resolve call chains (who calls X, what X calls)
4. `query_graph` → ad-hoc Cypher for complex structural questions
5. `get_code_snippet` → read exact source for a qualified symbol
6. `detect_changes` → map uncommitted changes to blast radius
7. `check_index_coverage` → verify what's indexed vs. gaps

### 3.3 Architecture Review
1. `get_architecture` → languages, packages, routes, hotspots, clusters, layers
2. `query_graph` (Cypher) → custom structural queries
3. Dead code via Cypher: `MATCH (f:Function) WHERE NOT EXISTS { (f)<-[:CALLS]-() } AND NOT f.entry_point RETURN f.name`
4. `manage_adr` → record/retrieve architecture decisions

### 3.4 Cross-Service Analysis
1. Index multiple repos under same store
2. Cross-repo `CROSS_*` edges auto-created
3. `get_architecture` → cross-repo summary
4. Graph UI → multi-galaxy 3D visualization

### 3.5 Incremental Updates
1. Background watcher detects git changes
2. Supervised subprocess re-indexes (RSS isolated)
3. Only changed files are re-parsed (SHA-256 + mtime comparison)
4. Old nodes/edges pruned, new ones inserted
5. Team-shared graph artifact (`.codebase-memory/graph.db.zst`) auto-updated

---

## 4. Distinctive Features

### 4.1 Memory Persistence Across Sessions
- SQLite database persists in `~/.cache/codebase-memory-mcp/` across restarts
- ADR (Architecture Decision Records) persist architectural decisions across sessions
- Team-shared graph artifact (`.codebase-memory/graph.db.zst`) for skipping re-index after clone

### 4.2 Call Graph & Type Resolution
- Full call graph across files and packages (import-aware, type-inferred)
- Hybrid LSP: 12 languages with IDE-quality type resolution (generics, inheritance, traits, etc.)
- Resolves across: packages, inheritance hierarchies, traits, stdlib calls

### 4.3 Dead Code Detection
- Finds functions with zero callers via Cypher `EXISTS` subqueries
- Excludes entry points (configurable)
- Graph-UI dead code tab with visual highlight

### 4.4 Impact Analysis / Blast Radius
- `detect_changes` → maps uncommitted diffs to affected symbols
- Risk classification: critical/high/medium/low based on call-graph centrality
- `trace_path` with `impact_summary` for affected-call-chain risk

### 4.5 Cross-Service Linking
- HTTP route ↔ call-site matching with confidence scoring
- gRPC, GraphQL, tRPC service detection with protobuf Route extraction
- Channel detection (`EMITS`/`LISTENS_ON`) for Socket.IO, EventEmitter, pub/sub (8 languages)

### 4.6 Near-Clone / Duplicate Detection
- `SIMILAR_TO` edges via MinHash + LSH (Jaccard scored)
- Vocabulary-mismatch semantic matches (`SEMANTICALLY_RELATED`)

### 4.7 Infrastructure-as-Code Indexing
- Dockerfiles, Kubernetes manifests, Kustomize overlays indexed as graph nodes
- `Resource` nodes for K8s kinds
- `Module` nodes for Kustomize overlays with `IMPORTS` edges

### 4.8 Team-Shared Graph Artifact
- Zstd-compressed SQLite snapshot in `.codebase-memory/graph.db.zst`
- Two tiers: Best (zstd -9, index strip, VACUUM INTO) and Fast (zstd -3, watcher incremental)
- Auto-creates `.gitattributes merge=ours` to avoid binary merge conflicts
- Bootstrap: teammate clones → artifact decompressed → incremental index fills local diff

### 4.9 Runtime Trace Ingestion
- `ingest_traces` validates and weights HTTP_CALLS edges from profiling/logging data
- Confidence scoring for trace-validated routes

### 4.10 Multi-Agent Support (43 surfaces)
- Automatic detection and configuration for 37 clients + 6 conditional
- Three-tier agent profiles: Scout (7 tools), Verify (11 tools), Auditor (full)
- Per-client lifecycle hooks (SessionStart, SubagentStart, PreToolUse, PostToolUse)
- Fail-open design, never modifies trust boundaries

### 4.11 Built-in 3D Graph Visualization
- Optional UI binary variant (`--ui`)
- 3D interactive graph at `localhost:9749`
- Multi-galaxy layout for cross-repo visualization
- Dead code highlighting, node labels, filter panel, stats tab

### 4.12 Diagnostics & Safety
- `CBM_DIAGNOSTICS=1` → NDJSON trajectory + JSON snapshot
- Zero telemetry, all local
- VirusTotal scanned (70+ engines), SLSA Level 3 provenance, Sigstore cosign, CodeQL SAST
- `CBM_ALLOWED_ROOT` env var for path restriction

---

## 5. Known Limitations & Pain Points

1. **No write/edit capabilities** — read-only knowledge graph; cannot modify source code
2. **Full reindex on initial run** — large repos (Linux kernel: 3 min) take significant time for first index
3. **Memory during indexing** — RAM-first pipeline uses substantial memory for large codebases (though released after)
4. **Watchdog polling, not FS events** — git-polling based (adaptive intervals), not inotify/FSEvents; may miss rapid changes between polls
5. **Cypher subset only** — read-only, no MERGE/CALL comprehensions/path functions/list literals; unsupported features error cleanly but may surprise users
6. **158 languages parsed, 12 with Hybrid LSP** — remaining 146 languages use syntactic-only resolution (no type inference)
7. **No incremental semantic indexing** — vector embeddings may not update for partially-changed functions without full reparse
8. **SQLite single-writer** — concurrent writes serialize; supervisor subprocess isolation mitigates but adds complexity
9. **Team artifact merge** — binary `.db.zst` with `merge=ours`; concurrent changes require re-index (no real merge)
10. **Windows limitations** — some client hooks withheld due to undocumented shell contracts; SmartScreen warnings
11. **WAL size growth** — `journal_size_limit` needs tuning for very large repos
12. **Coverage is best-effort** — "no recorded gap" ≠ proof of completeness
13. **No multi-project dependency tracking** — cross-repo edges link nodes but don't track inter-project imports as deeply as intra-project
14. **Embedding model fixed** — bundled Nomic model cannot be swapped or updated without binary rebuild
15. **No API-based embedding fallback** — all embeddings local only; no option for cloud model upgrade

---

## 6. Capability Checklist

- [x] MCP server (JSON-RPC 2.0 over stdio)
- [x] Persistent SQLite graph storage (WAL mode, ACID)
- [x] 158 language support via vendored tree-sitter grammars
- [x] Hybrid LSP type resolution (12 language families)
- [x] Knowledge graph with 13 node labels and 19+ edge types
- [x] Structural graph search (regex name, label, file, degree filters)
- [x] Semantic vector search (bundled Nomic nomic-embed-code, 768d int8)
- [x] 11-signal combined search scoring
- [x] BM25 full-text search (SQLite FTS5, camelCase/snake_case tokenizer)
- [x] Cypher-like graph query language (read-only openCypher subset)
- [x] BFS call graph traversal (depth 1-5, direction filter)
- [x] Impact analysis / blast radius mapping
- [x] Git diff → affected symbol mapping with risk classification
- [x] Dead code detection (zero-caller functions)
- [x] Near-clone / duplicate detection (MinHash + LSH)
- [x] Semantic similarity edges (vocabulary-mismatch)
- [x] HTTP route extraction and cross-service linking (REST, gRPC, GraphQL, tRPC)
- [x] Pub/sub channel detection (Socket.IO, EventEmitter, 8 languages)
- [x] Cross-repo intelligence (CROSS_* edges, multi-galaxy layout)
- [x] Infrastructure-as-code indexing (Docker, K8s, Kustomize)
- [x] Architecture overview (languages, packages, routes, hotspots, clusters, layers)
- [x] Louvain/Leiden community detection
- [x] ADR (Architecture Decision Record) management
- [x] Runtime trace ingestion for HTTP_CALLS validation
- [x] Index coverage tracking and gap reporting
- [x] Background auto-sync watcher (git-polling, adaptive intervals)
- [x] Incremental re-indexing (SHA-256 file hash comparison)
- [x] Supervised subprocess indexing (RSS isolation)
- [x] Team-shared graph artifact (.codebase-memory/graph.db.zst)
- [x] Code snippet retrieval by qualified name
- [x] Source code grep within indexed files
- [x] 3D graph visualization UI (localhost:9749)
- [x] CLI mode (every tool invocable from command line)
- [x] Tool profiles (Scout/Verify/Auditor)
- [x] 43 agent/client surface support
- [x] Single static binary, zero runtime dependencies
- [x] Cross-platform (macOS/Linux/Windows)
- [x] Package manager distribution (npm, PyPI, Homebrew, Scoop, Winget, Chocolatey, AUR, go install)
- [x] Diagnostics logging (NDJSON trajectory)
- [x] Zero telemetry
- [x] Security: SLSA L3, VirusTotal, Sigstore, CodeQL, checksums
- [x] No LLM dependency (agent is the intelligence layer)
- [x] File ignore system (.gitignore + .cbmignore + hardcoded patterns)
- [x] Configurable extensions (extra language mappings)
- [x] Complexity metrics (Halstead-lite)
- [x] Git co-change correlation edges (FILE_CHANGES_WITH)
- [x] Test↔source linkage (TESTS edge)
- [x] compile_commands.json integration (C/C++ projects)
- [x] Package manifest scanning (package.json, go.mod, Cargo.toml, pyproject.toml, composer.json, pubspec.yaml, pom.xml, build.gradle, mix.exs, gemspec)

---

*Inventory compiled from: README.md, docs/llms.txt, src/mcp/mcp.h, src/store/store.h, src/watcher/watcher.h, src/pipeline/*, vendored/nomic/*, src/cypher/cypher.h, internal/cbm/extract_* source files.*