# Capability Parity Matrix: DeusData/codebase-memory-mcp vs Pi-SmartRead

> **Reference:** DeusData/codebase-memory-mcp (pure-C static binary, 32K+ stars, 158 tree-sitter grammars, bundled Nomic embeddings, Cypher engine, 3D UI)
> **Target:** Pi-SmartRead (TypeScript Pi-agent extension, consumer = coding agent not human)
> **Goal:** Agent-facing capability parity with better ergonomics — not implementation parity.

---

## 1. Matrix Table

### Indexing & Persistence

| Capability | Reference | SmartRead | Status |
|---|---|---|---|
| Persistent graph storage (SQLite WAL, ACID) | SQLite WAL per project, `~/.cache/codebase-memory-mcp/` | In-memory ContextGraph + JSONL EdgeStore + separate semantic SQLite | PARTIAL |
| Full codebase AST indexing | 158 vendored tree-sitter grammars, multi-pass pipeline | 7 languages (TS/TSX/JS/Python/Go/Rust) via tree-sitter WASM | PARTIAL |
| Persistent semantic/vector store | Nomic `nomic-embed-code` int8 vectors in SQLite | SQLite-vec with configurable embedding provider | PARITY |
| Persistent embedding cache | Implicit (per-node in SQLite) | `persistent-embedding-cache.ts` disk-serialized, SHA-256 keyed | SMARTREAD-ONLY |
| FTS with camelCase/snake_case tokenizer | Custom `cbm_camel_split` FTS5 tokenizer | BM25 scoring in `scoring.ts` (standard tokenization) | PARTIAL |
| File-level index coverage tracking | `check_index_coverage` with shadow gap project | `index-coverage.ts` JSON stats | PARTIAL |
| Ignore-aware file discovery | `.gitignore` + `.cbmignore` + hardcoded patterns | `file-discovery.ts` (gitignore patterns) | PARITY |
| Configurable extension mappings | Extra language mappings config | `config.ts` `.pi-smartread.json` feature flags | PARITY |

### Graph Model

| Capability | Reference | SmartRead | Status |
|---|---|---|---|
| Formal labeled node types (13 labels) | Project, Package, Folder, File, Module, Class, Function, Method, Interface, Enum, Type, Route, Resource | Ad-hoc symbol index + file index (no formal labels) | PARTIAL |
| Typed edges (19+ types) | 19+ edge types with properties | imports, calls, breakage, co-change (4 types) | PARTIAL |
| Structural containment edges (CONTAINS_*) | Package, folder, file containment | Workspace scope detection only | GAP |
| Import dependency edges | IMPORTS with package-level resolution | Import resolution in ContextGraph | PARITY |
| Call edges with argument mapping | CALLS with arg-to-param mapping | `callgraph.ts` callers/callees (no arg mapping) | PARTIAL |
| HTTP route nodes + HANDLES edges | REST, gRPC, GraphQL, tRPC route extraction | None | GAP |
| Pub/sub channel edges (EMITS/LISTENS_ON) | Socket.IO, EventEmitter, 8 languages | None | GAP |
| Test↔source linkage (TESTS edge) | Test file ↔ source file mapping | None | GAP |
| File co-change edges (FILE_CHANGES_WITH) | Git co-change correlation | `git-context.ts` co-commit analysis → auto-populated edges | PARITY |
| Semantic similarity edges (SIMILAR_TO) | MinHash + LSH Jaccard scoring | `near-clone.ts` exists but not integrated into graph | PARTIAL |
| Vocabulary-mismatch semantic edges | SEMANTICALLY_RELATED (score ≥ 0.80) | None | GAP |
| Data flow edges (DATA_FLOWS) | Arg-to-param + field access chains | None | GAP |
| Cross-repo edges (CROSS_*) | Multi-repo intelligence, CROSS_* edges | None | OUT-OF-SCOPE-CANDIDATE — Pi extension scoped to single workspace; cross-repo agent queries go through workspace switching |

### Query & Search

| Capability | Reference | SmartRead | Status |
|---|---|---|---|
| Semantic vector search | Bundled Nomic 768d int8, cosine similarity | Configurable provider, sqlite-vec, RRF fusion | PARITY |
| BM25 full-text search | FTS5 with camelCase tokenizer | `scoring.ts` BM25 scoring | PARITY |
| Multi-signal combined scoring | 11 signals (TF-IDF, RRI, API sig, AST, dataflow, Halstead, MinHash, proximity, diffusion, +2) | Multi-signal reranking (graph distance, PageRank, path proximity, temporal) — 4-5 signals | PARTIAL |
| Structural graph search (regex, label, degree) | `search_graph` with regex name, label filter, degree filter | `grep` tool (BM25+AST+semantic cascade + graph-aware filter via `graphFilter` param) | PARTIAL |
| Cypher-like graph query language | Full read-only openCypher subset (MATCH, WHERE, aggregates, variable paths) | None | GAP |
| Graph schema introspection | `get_graph_schema` (labels, counts, patterns) | `inspect { graphSchema: true }` — returns file-node counts (deduplicated), edge counts, symbol-entries, and sample edges | PARTIAL |
| Code snippet retrieval by qualified name | `get_code_snippet` by `<project>.<path>.<name>` | `read { symbol }` resolves via LSP `workspaceSymbol` + context graph fallback | PARITY |
| Code text search (grep) | `search_code` graph-augmented grep | `grep` tool with multi-engine cascade | SMARTREAD-ONLY |
| Glob-filtered search | `file_pattern` param on search_graph | `glob` param on grep | PARITY |
| Literal (exact substring) search | Implied in search_code | `grep { literal: true }` | PARITY |

### Call Graph & Impact Analysis

| Capability | Reference | SmartRead | Status |
|---|---|---|---|
| BFS call graph traversal (depth-limited) | `trace_path` depth 1–5, direction filter, edge type filter | `inspect { callDepth, callDirection }` — BFS from file symbols via `callgraph.ts` | PARTIAL |
| Impact analysis / blast radius | `detect_changes` maps diff → affected symbols with risk | `inspect { impact: true }` — blast radius via `impact-analysis.ts` BFS expansion | PARTIAL |
| Git diff → affected symbol mapping | `detect_changes` with auto git-diff | `inspect { diff: "unstaged"\|"staged"\|"HEAD" }` — maps changed symbols with risk | PARTIAL |
| Dead code detection | Cypher EXISTS subqueries (zero-caller functions) | `inspect { deadCode: true }` — zero-caller functions via `impact-analysis.ts` | PARTIAL |
| Risk classification (critical/high/medium/low) | Call-graph centrality + hop-depth scoring | `inspect { diff }` / `inspect { impact }` — risk via `impact-analysis.ts` classifyRisk | PARTIAL |
| Call graph extraction across files | Multi-file call resolution, import-aware | `callgraph.ts` tree-sitter extraction (6 languages) | PARTIAL |
| Type-aware call resolution | Hybrid LSP for 12 language families | LSP bridge for TS/JS with goToDefinition/findReferences | PARTIAL |

### Architecture Insight

| Capability | Reference | SmartRead | Status |
|---|---|---|---|
| Architecture overview (languages, packages, routes, hotspots, clusters, layers) | `get_architecture` multi-aspect | Inspect directory mode (repo map) + signals (complexity, public-api, reuse, recency, tests) | PARTIAL |
| Community detection (Louvain/Leiden) | Leiden algorithm, resolution-tunable | `inspect { clusters: true }` — Louvain via `community-detection.ts` | PARTIAL |
| Hotspot detection (fan-in ranking) | `get_architecture` hotspots aspect | PageRank-based ranking in repomap (related but different metric) | PARTIAL |
| Entry point detection | `get_architecture` entry_points aspect | Partial via symbol-resolver (main/export detection) | PARTIAL |
| Package/module summary | Manifest scanning (8+ ecosystems) | `workspace-scope.ts` project root detection only | PARTIAL |
| Cross-service boundary detection | `get_architecture` boundaries aspect | `inspect { boundaries: true }` — service boundaries via `monorepo-detector.ts` | PARTIAL |
| Layer analysis | `get_architecture` layers aspect | `inspect { layers: true }` — layer derivation via `layer-analysis.ts` | PARTIAL |

### Memory & Decisions

| Capability | Reference | SmartRead | Status |
|---|---|---|---|
| ADR management (CRUD) | `manage_adr` SQLite-backed, section-based parsing | `adr-store.ts` markdown files with status lifecycle | PARITY |
| Cross-session decision persistence | SQLite ADR persistence | Git notes + markdown ADRs (experimental) | PARTIAL |
| Runtime trace ingestion | `ingest_traces` validates HTTP_CALLS edges | None | GAP |

### Incremental & Watching

| Capability | Reference | SmartRead | Status |
|---|---|---|---|
| Background file watcher | Git-polling adaptive intervals (5–60s) | `fs.watch`-based with chokidar opt-in (`file-watcher.ts`); debounced cache invalidation | PARTIAL |
| Incremental re-indexing (hash comparison) | SHA-256 + mtime + size | `incremental-index.ts` Merkle-tree content-addressable | PARITY |
| Supervised subprocess indexing (RSS isolation) | Worker subprocess for large repos | Not needed (Node.js process, not C binary) | OUT-OF-SCOPE-CANDIDATE — RSS isolation critical for C static binary; irrelevant for managed runtime |
| Auto-index on session start | `auto_index` config | Semantic index warmup in `hook.ts` session_start | PARITY |

### Distribution & Ergonomics

| Capability | Reference | SmartRead | Status |
|---|---|---|---|
| Single static binary, zero runtime deps | Pure C binary | npm package (managed runtime) | OUT-OF-SCOPE-CANDIDATE — Pi extension runs in managed Node/Bun; binary model inapplicable |
| 158 language support | Vendored tree-sitter grammars compiled to binary | 7 languages via tree-sitter WASM | OUT-OF-SCOPE-CANDIDATE — 158 grammars at 31MB+ vendored C; TS extension uses on-demand WASM loading for target languages |
| 43 agent/client surface support | Auto-detection, per-client hooks | Pi-only (extension API + MCP stdio) | OUT-OF-SCOPE-CANDIDATE — Pi extension targets Pi agent surface exclusively |
| Tool profiles (Scout/Verify/Auditor) | 3-tier tool surface control | Not needed — tools extend existing read/inspect/grep with params | OUT-OF-SCOPE-CANDIDATE — SmartRead's param-extension model replaces tool profiles |
| 3D graph visualization UI | localhost:9749 interactive 3D graph | None | OUT-OF-SCOPE-CANDIDATE — Agent consumer, not human; text output > 3D viz |
| Multi-package manager distribution | npm, PyPI, Homebrew, Scoop, Winget, AUR, go install | npm only (Pi extension) | OUT-OF-SCOPE-CANDIDATE — Pi extension distributed via Pi marketplace |
| Security hardening (SLSA L3, Sigstore, VirusTotal) | Binary provenance and signing | Not applicable to TS extension | OUT-OF-SCOPE-CANDIDATE — npm provenance via registry; no binary distribution |
| MCP stdio server mode | Native MCP server | `mcp-server.ts` + `mcp-registry.ts` | PARITY |
| Diagnostics logging | NDJSON trajectory (`CBM_DIAGNOSTICS=1`) | `resource-diagnostics.ts` + dump utilities | PARITY |
| Zero telemetry | Yes | Yes | PARITY |
| Configurable file ignore | `.gitignore` + `.cbmignore` + hardcoded | `file-discovery.ts` gitignore patterns | PARITY |

### SmartRead-Only Capabilities

| Capability | SmartRead Module | Status |
|---|---|---|
| Workspace evidence envelope system (schema v3) | `workspace-evidence-resolver.ts`, `path-evidence.ts` | SMARTREAD-ONLY |
| Evidence RPC resolver for edit authorization | `workspace-evidence-resolver.ts` | SMARTREAD-ONLY |
| Context hygiene (stale context + placeholder replacement) | `context-hygiene.ts`, `context-application.ts` | SMARTREAD-ONLY |
| Anchor hygiene (edit delta tracking, churn detection) | `context-hygiene.ts` anchor delta events | SMARTREAD-ONLY |
| Doom loop detection (6 warning types) | `doom-loop.ts`, `doom-loop-suggestions.ts` | SMARTREAD-ONLY |
| Bash context guard (output capping) | `bash-context-guard.ts` | SMARTREAD-ONLY |
| HyDE query expansion (template-based, no LLM) | `hyde.ts` | SMARTREAD-ONLY |
| Structural reranking (graph, PageRank, proximity, temporal) | `rerank.ts` | SMARTREAD-ONLY |
| Query probing (symbol-based confidence) | `query-probe.ts`, `classifiers.ts` | SMARTREAD-ONLY |
| LSP bridge (full client: goToDefinition, findReferences, documentSymbols, hover) | `lsp-bridge.ts` | SMARTREAD-ONLY |
| Skill discovery and loading | `skill-tool.ts`, `skill-protocol.ts` | SMARTREAD-ONLY |
| Git notes read/write (AI session context) | `git-notes-tool.ts`, `git-notes.ts` | SMARTREAD-ONLY |
| Microagent system (trigger-based context injection) | `microagents.ts` | SMARTREAD-ONLY |
| Internal URL routing (skill://, memory://, graph://) | `internal-url-router.ts` | SMARTREAD-ONLY |
| Monorepo detection | `monorepo-detector.ts` | SMARTREAD-ONLY |
| Code summary (structural elision) | `code-summary.ts` | SMARTREAD-ONLY |
| Graphify knowledge graph integration | `graphify-enricher.ts` | SMARTREAD-ONLY |
| Deep search (multi-channel: graph, LSP, semantic, structural, symbol) | `deep-search.ts` + modules | SMARTREAD-ONLY |

---

## 2. Scoping Judgment

The reference is a pure-C static binary engineered for maximal language coverage and offline-first team workflows. Pi-SmartRead is a TypeScript Pi-agent extension whose sole consumer is a coding agent. Parity means **agent-facing capability parity** — the agent can answer the same questions, not that the implementation matches.

### OUT-OF-SCOPE-CANDIDATE Justifications

| Capability | Why Out of Scope |
|---|---|
| 158 vendored tree-sitter grammars | 31MB+ vendored C source; Pi extension loads WASM grammars on-demand for target languages; 158 is human-complete, agent needs ~10 |
| Pure C static binary | Pi extension runs in managed Node/Bun runtime; binary model inapplicable |
| 43 agent/client surfaces | Pi extension targets Pi agent surface exclusively |
| 3D graph visualization UI | Consumer is coding agent, not human; text output is ergonomically superior |
| Tool profiles (Scout/Verify/Auditor) | SmartRead extends tools via params; no need for tool-surface tiers |
| Package manager distribution (npm, PyPI, Homebrew...) | Pi extension distributed via Pi marketplace; npm-only is correct |
| Security hardening (SLSA L3, Sigstore, VirusTotal) | No binary distribution; npm provenance via registry |
| Supervised subprocess indexing (RSS isolation) | Critical for C binary memory model; irrelevant for managed runtime |
| Cross-repo edges (CROSS_*) | Pi extension scoped to single workspace; cross-repo queries use workspace switching |

---

## 3. Ranked Gap List (In-Scope GAPs and PARTIALs)

For each in-scope gap or partial: capability, agent value, rough size, build-on modules, and how SmartRead can do it better.

| # | Capability | Why It Matters | Size | Build On | Ergonomics Note |
|---|---|---|---|---|---|
| 1 | **BFS call graph traversal (depth-limited)** | Agent needs "who calls X" / "what does X call" with depth control for focused investigation | S | `callgraph.ts`, `ContextGraph.getFileNeighbours()` | Add `depth` and `direction` params to `inspect { path, signal: "calls" }` — no new tool |
| 2 | **Impact analysis / blast radius** | Before editing, agent needs to know what breaks — critical for safe multi-file changes | M | `context-graph.ts`, `graph-mutate.ts`, `callgraph.ts` | Extend `inspect` with `impact: true` param; compute blast radius from graph and return ranked affected files |
| 3 | **Git diff → affected symbol mapping** | Agent runs edits, needs to validate nothing critical was missed — "what did I just change that matters" | M | `git-context.ts`, `context-graph.ts`, `incremental-index.ts` | Add `inspect { diff: "unstaged" | "staged" | "HEAD" }` param; maps changed symbols to graph neighbors |
| 4 | **Dead code detection** | Agent identifies unused functions before refactoring — high-value for cleanup tasks | M | `callgraph.ts`, `ContextGraph` symbol/call indices | Add `inspect { deadcode: true, path: <dir> }` param; returns zero-caller functions (excluding entry points) |
| 5 | **Risk classification (critical/high/medium/low)** | Agent needs prioritized impact — not just "these 20 files affected" but "these 2 are critical" | M | `context-graph.ts` (PageRank centrality), `signals.ts` | Compute from call-graph centrality + fan-in; return alongside impact analysis |
| 6 | **Community detection (Louvain/Leiden)** | Agent needs module boundary understanding for "where should this code live" decisions | M | `repomap-ranking.ts` (PageRank), `context-graph.ts` | Add `inspect { clusters: true }` param to directory mode; run lightweight Louvain on import graph |
| 7 | **Structural containment edges** | Agent needs "what's inside this package" traversal; current workspace scope is flat | S | `workspace-scope.ts`, `file-discovery.ts` | Build containment tree during ContextGraph construction; expose via inspect directory mode |
| 8 | **Cypher-like graph query** | Agent needs ad-hoc structural queries beyond fixed params — "find all methods that call both X and Y" | L | `context-graph.ts`, new query engine | Avoid full Cypher — add `grep { graph: true, pattern: "...", filter: "CALLS->X,USES->Y" }` param; leverages existing graph without new language |
| 9 | **Graph schema introspection** | Agent needs to understand what's in the graph before querying it | S | `context-graph.ts` | Add `inspect { graph-schema: true }` param; returns node/edge type counts and samples |
| 10 | **Call edges with argument mapping** | Agent needs to understand data flow between caller/callee, not just who-calls-whom | L | `callgraph.ts`, LSP bridge hover info | Requires param signature extraction per function; extend `callgraph.ts` with LSP hover for type info |
| 11 | **HTTP route extraction + HANDLES edges** | Agent needs to understand API surface and route-to-handler mapping for web projects | M | `structural-facts.ts`, LSP bridge | Add route extraction pass in inspect file/directory mode for Express, Fastify, Next.js, tRPC patterns |
| 12 | **Test↔source linkage** | Agent needs "which tests cover this function" before refactoring | S | `callgraph.ts`, `file-discovery.ts` | Match test file names to source files + call graph overlap; expose via inspect `signals: ["tests"]` (already exists) |
| 13 | **Cross-service boundary detection** | Agent needs to know where service boundaries are in monorepo/microservice setups | M | `workspace-scope.ts`, `monorepo-detector.ts` | Extend `inspect { boundaries: true }` to detect service boundaries from package.json workspaces, docker-compose, etc. |
| 14 | **Layer analysis** | Agent needs architectural layer understanding (controller → service → repo) | M | `context-graph.ts`, `signals.ts`, `structural-facts.ts` | Derive layers from import patterns + naming conventions; return in inspect directory mode |
| 15 | **Hotspot detection (fan-in ranking)** | Agent needs "most-called" functions for prioritizing review | S | `callgraph.ts`, `context-graph.ts` (PageRank) | Extend `inspect { signals: ["hotspot"] }` with call-count ranking |
| 16 | **Multi-signal scoring expansion** | Agent benefits from richer ranking signals for better retrieval precision | M | `rerank.ts`, `scoring.ts`, `intent-read.ts` | Add Halstead-lite complexity, AST profile, and MinHash proximity to existing rerank pipeline |
| 17 | **Code snippet by qualified name** | Agent works with symbol names from LSP/reference results; needs QN → code mapping | S | `lsp-bridge.ts` (goToDefinition), `read` tool | Add `read { symbol: "ClassName.methodName" }` param; resolve via LSP then read |
| 18 | **Runtime trace ingestion** | Agent can learn actual call patterns from profiling data to improve graph accuracy | L | `callgraph.ts`, `context-graph.ts` | `graph_mutate` could accept trace data; low priority vs static analysis |
| 19 | **File co-change edges integration** | Near-clone exists but not in main retrieval; SEMANTICALLY_RELATED edges missing | M | `near-clone.ts`, `git-context.ts` | Integrate near-clone into `grep` results boost and inspect enrichment |
| 20 | **Persistent graph storage** | ContextGraph rebuilds on restart; team-shared artifact could skip re-analysis | L | `context-graph.ts`, `EdgeStore` | Serialize ContextGraph to SQLite on session end; restore on start. Or leverage semantic-index SQLite for graph data |
| 21 | **Background file watcher** | Agent works on long sessions; snapshot-based detection misses real-time changes | M | `file-watcher.ts`, `incremental-index.ts` | Uses Node.js `fs.watch` (recursive/non-recursive) + chokidar opt-in; debounced cache invalidation |
| 22 | **Cross-session decision persistence** | Git notes are experimental; ADRs are markdown; neither feeds retrieval ranking | S | `adr-store.ts`, `git-notes.ts`, `intent-read.ts` | Integrate ADRs into retrieval ranking as boost signals; make git notes part of read enrichment |
| 23 | **Type-aware call resolution (deeper)** | Current callgraph is syntactic; Hybrid LSP in reference resolves generics, inheritance | L | `lsp-bridge.ts`, `callgraph.ts` | LSP bridge already has goToDefinition + findReferences; wire into callgraph for type-aware resolution in TS/JS |

---

## 4. Proposed Parity Target — Definition of Done

SmartRead achieves agent-facing parity when:

- [x] Agent can traverse call graphs depth-limited (inspect `callDepth`/`callDirection` params)
- [x] Agent can compute blast radius / impact of a change before editing (`inspect { impact: true }`)
- [x] Agent can map git diff to affected symbols with risk classification (`inspect { diff }`)
- [x] Agent can detect dead code (zero-caller functions) (`inspect { deadCode: true }`)
- [x] Agent can understand module boundaries via community detection (`inspect { clusters: true }`)
- [x] Agent can query graph schema (what nodes/edges exist) (`inspect { graphSchema: true }`)
- [x] Agent can extract HTTP route → handler mappings for web projects (`inspect { routes: true }`)
- [ ] Agent can identify test↔source coverage gaps (detectTests() only reports test presence via conventional test paths — no source-to-test coverage-gap analysis yet)
- [x] Agent has background file watching for real-time invalidation (`file-watcher.ts`)
- [x] Agent can retrieve code by qualified name (symbol param on read)
- [ ] Agent's multi-signal scoring includes complexity, AST profile, and proximity signals
- [x] Cross-session ADRs feed into retrieval ranking

**Not required for parity:** Cypher engine, 158 grammars, 3D UI, 43-client support, cross-repo edges, runtime trace ingestion, supervised subprocess indexing, team-shared binary artifact.

---

*Matrix compiled from: reference-capabilities.md (DeusData/codebase-memory-mcp checklist), smartread-capabilities.md (Pi-SmartRead module inventory).*