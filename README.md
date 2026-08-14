# Pi-SmartRead

Code intelligence extension for [Pi](https://github.com/mariozechner/pi-coding-agent) — unified file reading, structural code analysis, quality signals, repository mapping, and hybrid code search.

> Forked from [pi-read-many](https://github.com/Gurpartap/pi-read-many) and evolved into a full code-intelligence toolkit.
> Maintained by [Rhine Sharar](https://github.com/rhinos0608).
> Now standalone repository, original tool surface was one read-many tool with adaptive ascending packing.

---

## Tools

| Tool | What it does |
|---|---|
| `read` | Single-file, multi-file, query-selected file reads, or symbol-resolved code (via `symbol` param) with contextual enrichment and strong evidence. Only complete rendered read blocks provide strong evidence for patch. |
| `inspect` | Two modes — directory (ranked repo map + clusters, layers, boundaries, routes) or file (structural facts + quality signals + call graph traversal, impact analysis, dead code detection, diff mapping). Returns search-match evidence — read a file before editing it. |
| `grep` | Primary code search — BM25 ranking + AST symbol matching + semantic fallback behind a grep-shaped interface, plus graph-aware filtering (`graphFilter`). Returns search-match evidence — read a file before editing it. |
| `health` | Reports runtime graph/watcher/semantic-index/embedding/LSP status. |
| `skill` | Manages agent skills. |
| `graph_mutate` | [experimental] Records semantic coupling observations into the context graph. |

Experimental tools (`graph_mutate` and git-notes tools) are opt-in via `pi-smartread.config.json` and only register when enabled.

### Cross-cutting features

Pi-SmartRead also provides passive safety and enrichment that runs across all tool calls:

| Feature | What it does |
|---|---|
| **Context hygiene** | Tracks every read tool result; marks stale reads in the context window after file mutations |
| **Doom-loop detection** | Warns when the LLM repeats identical tool calls 3+ times, with tool-specific suggestions |
| **Bash context guard** | Caps oversized bash output to head+tail preview, writes full output to temp file |
| **Startup tool guidance + repo map injection** | Injects SmartRead tool-selection guidance and a compact repo map on the first turn — no wasted round trips |
| **Read enrichment** | Appends import relationships, git recency, branch notes, and graphify knowledge to every file read |
| **LSP bridge** | Tracks opened files on the language server for faster subsequent LSP queries; closes mutated files for fresh re-reads |
| **Microagents** | Scans `.pi-smartread/microagents/` for markdown-based agent instructions with trigger-based or always-loaded rules |

---

## Install

```bash
pi install github:rhinos0608/Pi-SmartRead
```

If Pi is already running:

```
/reload
```

---

## `read`

Read files with strong workspace evidence. Supports four modes:

- **Single file**: `{ path: "src/auth.ts" }` or `{ path, offset, limit }`
- **Multiple files**: `{ paths: [{ path: "a.ts" }, { path: "b.ts" }] }`
- **Symbol lookup**: `{ symbol: "AuthService.login" }` — resolves a qualified symbol name via LSP or the context graph and reads its definition file
- **Query-selected files**: `{ query: "auth flow" }` — ranks the startup index with whole-corpus BM25 + embedding RRF, then reads selected files; grep+AST discovers candidates only when indexed retrieval is unavailable

Successful single-file reads and complete file blocks rendered by multi/query reads return strong schema-v3 evidence. Partial and omitted packed blocks are intentionally not authorized.

An aider-style repo map is injected on start up, providing a high-level overview of the repository structure and symbol relationships, does not block start up, runs async and skips in home directories.

---

## `inspect`

Two-mode structural analysis tool. Mode is auto-detected from the input path — directories produce a repo map, files produce structural facts plus quality signals.

Every mode returns a `details.workspaceEvidence` envelope:
- **Directory mode**: `mode:"map"`, zero resources (no file authorization)
- **File mode**: `mode:"symbol"`, per-referenced-symbol `coverage:"search-match"` (weak evidence — use `read` for strong evidence that authorizes patch)

### Directory mode

Pass a directory path to get a ranked repository map with key symbols and architecture overview.

```json
{ "path": "src" }
```

Output includes a PageRank-ranked symbol tree, file structure, and optionally graph-knowledge clusters.

**Additional params (all optional, directory mode):** `clusters` (Louvain community detection on import graph), `layers` (architectural layer inference), `boundaries` (service boundary detection via monorepo config), `routes` (HTTP route extraction), `hotspots` (fan-in ranked functions), `graphSchema` (graph structure summary), `deadCode` (zero-caller functions).

### File mode

Pass a file path to get structural facts plus quality signals, plus optional analysis:

**Additional file-mode params:** `callDepth` + `callDirection` (BFS call graph, depth 1–5), `impact` (blast radius via call+import graph), `deadCode` (zero-caller functions), `diff` (git diff → affected symbols with risk), `hotspots` (fan-in ranked functions), `routes` (HTTP route → handler), `graphSchema` (node/edge counts).

**Structural facts:**
- Callers — intra-file and cross-file call sites
- Parent class/module — base class, barrel file in same directory
- Children — methods, nested classes, interfaces, enums, type aliases, variables
- Base classes — classes the file extends
- Interfaces — interfaces the file implements
- Overrides — methods that override parent methods (explicit with `override` keyword for TS; name-match heuristic for Python)
- Re-exports — barrel files and `__init__.py` files that re-export symbols

**Quality signals:**
| Signal | Method | Fallback |
|---|---|---|
| Complexity | Tree-sitter AST branch count per function | Regex keyword count (low confidence) |
| Public API | `export` keyword (TS/JS); `__all__` or underscore convention (Python) | Assume public if no clear private marker |
| Reuse | ContextGraph imported-by count | "Unknown" |
| Recency | `git log -1 --format=%ar` | File mtime if <1 day |
| Tests | Naming-convention candidate paths + `existsSync` | "No tests found" |
| Deprecation | Regex: `@deprecated`, `#[deprecated]`, `[Obsolete]`, `DeprecationWarning` | "No markers found" |

All signals degrade gracefully — missing git, unsupported language, or parse errors produce partial results with confidence annotations, never hard failures.

```json
{ "path": "src/inspect.ts" }
```

### Migration from v3

| Old call | New call |
|---|---|
| `inspect { query: "auth" }` | `grep { pattern: "auth" }` |
| `inspect { symbol: "AuthService.login" }` | `grep { pattern: "AuthService.login" }` |
| `inspect { action: "map" }` | `inspect { path: "dir/" }` |

---

## `grep`

Primary code search tool. Wraps standard text search with a hybrid cascade — the agent never needs to know which engine answered.

```json
{ "pattern": "auth middleware" }
```

Run up to 10 searches in one call. Top-level options act as shared defaults; query-level options override them:

```json
{
  "path": "src",
  "queries": [
    { "pattern": "auth middleware" },
    { "pattern": "DATABASE_URL", "literal": true }
  ]
}
```

Provide exactly one of `pattern` or `queries`. Batch output stays grouped by query and publishes one evidence envelope containing all shown hits.

### Internal cascade (agent never sees)

Pass `literal: true` to skip the cascade and go straight to exact text grep. `literal: true` is deterministic — the pattern is matched as an exact substring (no regex interpretation), so metacharacters like `.` or `*` are literal.

Otherwise (default):
1. Exact text grep runs first (always) → serves as priority safeguard
2. If semantic index unavailable → fuse exact-match results, an in-memory BM25 lexical ranker (token overlap over the discovered source corpus), and AST symbol search
3. If semantic index available, run:
   - BM25 lexical ranker (token overlap)
   - AST symbol matcher (tree-sitter name resolution)
   ↓ RRF fusion + dedup, exact matches prepended at front
4. If zero fused hits and semantic index supports vector search:
   Embedding semantic fallback (minimum cosine similarity 0.3)

Regex auto-detection is best-effort: it only recognizes a small set of common regex constructs (alternation, anchors, character classes, quantifiers). Patterns not in that set are treated as literal substrings — a pattern that looks like regex but is not recognized will NOT be interpreted as regex.

```
Path: literal=true                     → exact-text grep only
Path: semantic-index-unavailable       → exact-text + in-memory BM25 + AST symbol search
Path: semantic-index-available         → BM25 + AST → RRF → (embedding fallback if empty)
```

### Parameters

| Param | Type | Description |
|---|---|---|
| `pattern` | string | Single text, symbol name, or concept. Mutually exclusive with `queries` |
| `queries` | object[] | 1-10 full search objects. Mutually exclusive with `pattern` |
| `path` | string | Directory or file to scope search (default: cwd) |
| `glob` | string | File filter, e.g. `*.ts` or `src/**/*.py` |
| `ignoreCase` | boolean | Case-insensitive search (default: false) |
| `literal` | boolean | Exact substring match — skip BM25/semantic (default: false) |
| `limit` | number | Max results (1-100, default: 20) |
| `contextLines` | number | Lines of context per match (0-10, default: 2) |
| `graphFilter` | string | Graph edge filter, e.g. `"CALLS->auth.login"` or `"IMPORTED_BY->src/core"`. Filters results to files/symbols reachable via the specified relationship. Requires context graph to be built. |

### Evidence semantics

Envelope mode `query`, `coverage: "search-match"` per hit with `allowedRanges`. `tool_result.grep` events feed the resolver cache for SmartEdit patch authorization.

---

## `graph_mutate` [experimental]

Records a single semantic coupling observation (breakage or co-change) into the context graph. Edges are event-sourced to disk and survive session restarts. Disabled by default — enable via `pi-smartread.config.json`:

```json
{
  "experimental": { "graphMutate": true }
}
```

### Breakage (default)

When editing file A causes type-checking errors in file B:

```json
{
  "from": "src/types/user.ts",
  "to": "src/services/auth.ts",
  "relation": "breakage",
  "context": "renamed User.id field",
  "confidence": 0.9
}
```

Persisted mutation edges are loaded by the next successful graph build and used only by graph-aware operations (they do not automatically expand or alter ordinary `grep`/`inspect` results).

### Co-change

When files A and B consistently change together in git history:

```json
{
  "from": "src/api/routes.ts",
  "to": "src/api/validators.ts",
  "relation": "co-change",
  "context": "commit: abc1234",
  "confidence": 0.7
}
```

Edge weight decays with time.

---

## Supported languages

Pi-SmartRead supports tree-sitter analysis for **41 languages**:

Bash, C, C#, C++, Clojure, Common Lisp, CSS, D, Dart, Elisp, Elixir, Elm, Fortran, Gleam, Go, Haskell, HCL (Terraform), Java, JavaScript, JSX, Julia, Kotlin, Lua, MATLAB, OCaml, PHP, Pony, Python, QL (CodeQL), R, Racket, Ruby, Rust, Scala, Solidity, Swift, TypeScript, TSX, Udev, Zig

**Structural facts extraction** (for `inspect` file mode): TypeScript, JavaScript, TSX, Python.

**Call graph support** (for code search enrichment): TypeScript, JavaScript, TSX, Python, Go, Rust.

Languages without dedicated tree-sitter parsers still work for file reading and BM25 text ranking.

---

## Configuration

### Embedding backend

Semantic ranking uses an **OpenAI-compatible embeddings API**.

Create `pi-smartread.config.json` in the current directory or any parent:

```json
{
  "model": "nomic-embed-text",
  "chunkSizeChars": 4096,
  "probeEnabled": false,
  "rerankEnabled": false
}
```

> **Security:** `baseUrl` and `apiKey` are never read from the config file —
> only from environment variables. Network endpoints are untrusted in
> repo-level config. Set them via `PI_SMARTREAD_EMBEDDING_BASE_URL` and
> `PI_SMARTREAD_EMBEDDING_API_KEY` (or `EMBEDDING_BASE_URL` as fallback).

### Config fields

| Key | Env var | Alt env var | Required | Description |
|---|---|---|---|---|
| `baseUrl` | `PI_SMARTREAD_EMBEDDING_BASE_URL` | `EMBEDDING_BASE_URL` | Yes | OpenAI-compatible base URL (env only, not from file) |
| `model` | `PI_SMARTREAD_EMBEDDING_MODEL` | `EMBEDDING_MODEL` | Yes | Embedding model name |
| `apiKey` | `PI_SMARTREAD_EMBEDDING_API_KEY` | — | No | Bearer token (env only, not from file) |
| `chunkSizeChars` | `PI_SMARTREAD_CHUNK_SIZE` | — | No | Target chunk size (default: 4096) |
| `chunkOverlapChars` | `PI_SMARTREAD_CHUNK_OVERLAP` | — | No | Chunk overlap (default: 512) |
| `maxChunksPerFile` | `PI_SMARTREAD_MAX_CHUNKS` | — | No | Max chunks per file (default: 12) |
| `probeEnabled` | — | — | No | Enable symbol-based query probing (default: false) |
| `rerankEnabled` | — | — | No | Enable structural reranking after RRF (default: false) |
| `hydeEnabled` | — | — | No | Enable HyDE query expansion (default: false) |
| `externalReranker` | — | — | No | External reranker API config (see below) |
| — | `PI_SMARTREAD_ALLOWED_ROOT` | `CBM_ALLOWED_ROOT` | No | **Env var only.** Restricts automatic semantic-index/retrieval scoping to subtree; does NOT gate direct `read`/`grep`/`inspect` tool access |

### Caching

Session startup asynchronously builds a bounded, ignore-aware semantic index under `.pi-smartread/`. File hashes, model/config fingerprint, vector dimension, and SQLite vectors persist across restarts. Only successfully embedded added/modified files advance index state; failures retry on the next warm-up, and deleted files are removed. Query-time retrieval fuses whole-corpus BM25 and vector ranks with RRF.

### Graceful BM25 degradation

Pi-SmartRead is designed for agent robustness — missing embeddings degrade to BM25-only with a warning, not hard-fail:

| Scenario | Behaviour |
|---|---|
| Config missing (`baseUrl`/`model` not set) | Loud `console.warn`, proceeds with BM25 |
| Config valid, embedding API unreachable | Falls back to BM25 silently |
| Config valid, API returns wrong vector count | Falls back to BM25, reports in `details.embeddingError` |

All retrieval modes degrade gracefully. Only config authoring errors (e.g. `chunkSizeChars: "foo"`) throw.

---

## Advanced retrieval features

> The old standalone `read_files` tool is no longer registered. Its packing engine is internal to `read { paths: [...] }` and `read { query }`.

### HyDE query expansion

**HyDE** (Hypothetical Document Embeddings) improves semantic matching by generating a synthetic code document from the query, then embedding that instead of the raw query text. This is a **no-LLM** implementation — deterministic templates, zero extra latency.

Enable in config: `"hydeEnabled": true`

When active, `details.hyde` reports the generated document, detected pattern, and extracted identifiers.

### External reranker

An optional external reranker API can replace the local structural reranker. Supports Cohere, Jina, or any compatible endpoint.

> **Security:** Reranker `baseUrl` and `apiKey` are overridden by
> `PI_SMARTREAD_RERANKER_BASE_URL` and `PI_SMARTREAD_RERANKER_API_KEY`
> environment variables when set. Network endpoints are untrusted in repo-level
> config. Non-network settings like `model` and `timeoutMs` may come from file.

```json
{
  "rerankEnabled": true,
  "externalReranker": {
    "model": "rerank-english-v3.0",
    "timeoutMs": 10000,
    "maxDocuments": 20
  }
}
```

Falls back to structural reranking on failure.

### Query probing

When `probeEnabled: true`, the probe phase extracts probable code identifiers from the query and resolves them against the repository's symbol graph, adding definition files as candidates before ranking.

### Git context enrichment

When enabled (on by default), every file read is enriched with git recency info, co-commit hotspots, and branch notes. Configure via:

```json
{
  "gitContext": {
    "enabled": true,
    "readEnrichmentCommits": 3,
    "tokenBudget": {
      "gitLog": 800,
      "coCommitHotspots": 400,
      "gitNotes": 600
    }
  }
}
```

### Microagents

Place markdown files with YAML frontmatter in `.pi-smartread/microagents/` or `.openhands/microagents/`. Agents can be always-loaded or triggered by query keywords:

```markdown
---
triggers: ["auth", "jwt", "oauth"]
alwaysLoad: false
name: "auth-conventions"
description: "Auth service conventions"
---

# Auth Conventions
- JWT tokens use RS256
- Middleware order: auth → rate-limit → handler
```

### Retrieval benchmarks

Pi-SmartRead includes a benchmark suite measuring recall, precision, MRR, and NDCG:

```bash
npx vitest run test/unit/retrieval-benchmark.test.ts
```

---

## MCP server

Pi-SmartRead includes a standalone **MCP (Model Context Protocol) stdio server** for use with Claude Desktop, Cursor, or any MCP-compatible client.

```bash
npm run mcp-server
```

The MCP server exposes the shared `ToolRegistry` tools:

| Tool | Notes |
|---|---|
| `inspect` | Directory → map; file → structural facts + signals. |
| `grep` | BM25 + symbol + semantic cascade or literal text search. |
| `skill` | Skill invocations. |
| `graph_mutate` | Only when `experimental.graphMutate: true`. |
| git-notes tools | Only when `experimental.gitNotes: true`. |

`read` is **not** exposed over MCP; file reads and strong provenance are available through the Pi extension API. MCP `inspect`/`grep` remain discovery-only.

### Resources

The server exposes `smartread://` resources:

| URI | Description |
|---|---|
| `smartread://config` | Current SmartRead configuration (embedding, search, git context, experimental features) |
| `smartread://repo-map` | Latest repository symbol map (PageRank + tree-sitter) |
| `smartread://status` | Server version, tool count, and runtime status |
| `smartread://repo/stats` | Repository file count, language breakdown, and source-file statistics |
| `smartread://repo/graph/summary` | Knowledge graph summary — nodes, edges, communities, and file coverage |
| `smartread://repo/graph/communities` | Detected architectural clusters with file counts and sample filenames |
| `smartread://repo/graph/god-nodes` | Highest-centrality graph nodes (core abstractions), sorted by connection count |
| `smartread://repo/index/status` | Knowledge graph index — file count, last modified, and pending changes |
| `smartread://repo/index/coverage` | Index coverage records: indexed, ignored, unsupported, binary, partial, parse/read errors |
| `smartread://repo/adrs` | Project ADRs stored under `.pi-smartread/adrs` |
| `smartread://repo/near-clones` | MinHash+LSH near-clone pairs for source files |

### Prompts

The server exposes prompts for `explain-code`, `review-diff`, `architectural-analysis`, and `smartread-tool-guide`.

See **[docs/mcp-quickstart.md](docs/mcp-quickstart.md)** for full setup instructions.

---

## Native tree-sitter

Pi-SmartRead uses **native tree-sitter bindings** (not WASM) for all AST operations:

- Native parsers: `tree-sitter`, `tree-sitter-javascript`, `tree-sitter-typescript`, `tree-sitter-python`, `tree-sitter-go`, `tree-sitter-rust`
- Query files from the bundled `src/queries/` directory
- Chunked callback parsing for large files
- Text fallback when AST tags are unavailable

A **WASM grammar loader** (`src/grammar-loader.ts`) provides additional language support via `@vscode/tree-sitter-wasm` for AST-boundary chunking.

---

## Development

```bash
git clone https://github.com/rhinos0608/Pi-SmartRead.git
cd Pi-SmartRead
npm ci
npm run typecheck
npm test
```

For local one-off loading:

```bash
pi -e ./src/index.ts
```

If Pi is already running:

```
/reload
```

Focused test runs:

```bash
npm test -- --run test/unit/tags.test.ts test/unit/repomap-search.test.ts
```

---

## Troubleshooting

**Semantic ranking is not working** — Check `pi-smartread.config.json` or the `PI_SMARTREAD_EMBEDDING_*` environment variables. BM25-only ranking will still work.

**I only want a quick structure overview** — Call `inspect { path: "." }`.

**Doom-loop warning appears** — The LLM repeated identical tool calls 3+ times. Try a different grep pattern or use `inspect { path: "dir/" }` to get oriented.

---

## Migration

### v3 → v4

| Old call | New call |
|---|---|
| `inspect { query: "..." }` | `grep { pattern: "..." }` |
| `inspect { symbol: "..." }` | `grep { pattern: "..." }` |
| `inspect { action: "map" }` | `inspect { path: "dir/" }` |

### v3 tool consolidation (earlier)

The standalone `read_files`, `search`, `repo_map`, and `symbol` tools had been consolidated into `inspect` in v3. Update existing calls:

| Old call | New call |
|---|---|
| `read_files { files: [...] }` | `read { paths: [...] }` |
| `search { query }` | `grep { pattern }` |
| `repo_map { ... }` | `inspect { path: "dir/" }` |
| `symbol { ... }` | `grep { pattern }` |

`read` owns single-file provenance, multi-file packing, and query-selected reads.

---

## Related docs

- `docs/archive/research-deep-dive.md` — Design research, ecosystem analysis, and roadmap (predates consolidation; historical)
- `docs/archive/advanced-retrieval-spec.md` — Proposed architecture for graph-aware retrieval (historical / superseded)
- `docs/archive/advanced-retrieval-implementation-plan.md` — Phase-by-phase implementation plan (historical / superseded)
- `docs/archive/advanced-retrieval-research.md` — Academic and industry research survey (historical / superseded)
- `docs/pi-hashline-readmap-research.md` — Cross-extension integration analysis (historical / superseded)
- `docs/archive/deep-search-spec.md` — Deep search specification (historical / superseded)
- `docs/archive/deep-search-implementation.md` — Deep search implementation plan (historical / superseded)
- `docs/archive/phase-6-8-implementation-notes.md` — Notes on external reranker, MCP server, HyDE, benchmarks, multi-language call graphs (historical / superseded)
- `docs/archive/tool-consolidation-plan.md` — Pre-v3 tool-consolidation design (historical / superseded)
- `docs/archive/plans/2026-05-03-search-tool-consolidation-design.md` — Pre-v3 search-tool consolidation design (historical / superseded)
- `docs/mcp-quickstart.md` — MCP server setup for Claude Desktop, Cursor, and generic clients

---

## License

MIT © 2026 Rhine Sharar
