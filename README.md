# Pi-SmartRead

Code intelligence extension for [Pi](https://github.com/mariozechner/pi-coding-agent) — unified file reading, intent-based retrieval, repository mapping, consolidated symbol/code/deep search, cross-file resolution, call graph analysis, and AST-aware code search.

> Forked from [pi-read-many](https://github.com/Gurpartap/pi-read-many) and evolved into a full code-intelligence toolkit.

---

## Tools

| Tool | What it does |
|---|---|
| `read` | Single-file read with contextual enrichment (imports, git, graphify). |
| `inspect` | Multi-mode retrieval: `path` (file read + evidence), `query` (intent search; `depth: "deep"` enables semantic/symbol/graph/LSP channels), `symbol` (symbol lookup), and `map` (repo map). |
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
pi install git:https://github.com/rhinos0608/Pi-SmartRead.git
```

If Pi is already running:

```
/reload
```

---

## `read`

Single-file read with contextual enrichment. Appends import relationships, git recency, branch notes, and graphify knowledge to every read.

```json
{
  "path": "src/auth.ts",
  "offset": 40,
  "limit": 120
}
```

On the first read-like call in a repo, may return a compact repo map — simply re-issue the read.

---

## `inspect`

Multi-mode retrieval tool. One mode per call, selected by the input shape. Every mode returns a `details.workspaceEvidence` envelope; path mode produces **strong** evidence that authorizes patch, while query/symbol/map modes produce weak (search-match) evidence and are meant for discovery.

### Path mode

Single-file read with evidence. Same enrichment as `read`.

Accepted params: `path`, `offset`, `limit`.

```json
{
  "path": "src/auth.ts",
  "offset": 40,
  "limit": 120
}
```

### Query mode

Intent-based search. Default depth is `"quick"` (grep + AST). Use `depth: "deep"` to also run semantic, symbol, graph, and LSP channels with RRF fusion.

Accepted params: `query`, `depth` (`"quick"` or `"deep"`), `directory`.

`scope`, `limit`, `maxSnippetChars`, `outputBudget`, and `includeRelationships` are internal engine defaults — they are not exposed tool params.

```json
{
  "query": "authentication middleware",
  "directory": "src"
}
```

Deep search:

```json
{
  "query": "how does JWT token validation work?",
  "depth": "deep",
  "directory": "src"
}
```

### Symbol mode

Symbol lookup: name search, file outline, declaration, references, implementations.

Accepted params: `symbol`, `directory`.

```json
{
  "symbol": "AuthService.login",
  "directory": "src"
}
```

### Map mode

Repository structure and PageRank-ranked symbol map.

Accepted params: `action: "map"`, `directory`.

```json
{
  "action": "map",
  "directory": "."
}
```

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

The next `inspect { query }` touching A will automatically include B as a candidate.

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

**Call graph support** (for code search enrichment and deep search): TypeScript, JavaScript, TSX, Python, Go, Rust.

Languages without dedicated tree-sitter parsers still work for file reading and BM25 text ranking.

---

## Configuration

### Embedding backend

Semantic ranking uses an **OpenAI-compatible embeddings API**.

Create `pi-smartread.config.json` in the current directory or any parent:

```json
{
  "baseUrl": "http://localhost:11434/v1",
  "model": "nomic-embed-text",
  "apiKey": "ollama"
}
```

### Config fields

| Key | Env var | Alt env var | Required | Description |
|---|---|---|---|---|
| `baseUrl` | `PI_SMARTREAD_EMBEDDING_BASE_URL` | `EMBEDDING_BASE_URL` | Yes | OpenAI-compatible base URL |
| `model` | `PI_SMARTREAD_EMBEDDING_MODEL` | `EMBEDDING_MODEL` | Yes | Embedding model name |
| `apiKey` | `PI_SMARTREAD_EMBEDDING_API_KEY` | — | No | Bearer token |
| `chunkSizeChars` | `PI_SMARTREAD_CHUNK_SIZE` | — | No | Target chunk size (default: 4096) |
| `chunkOverlapChars` | `PI_SMARTREAD_CHUNK_OVERLAP` | — | No | Chunk overlap (default: 512) |
| `maxChunksPerFile` | `PI_SMARTREAD_MAX_CHUNKS` | — | No | Max chunks per file (default: 12) |
| `probeEnabled` | — | — | No | Enable symbol-based query probing (default: false) |
| `rerankEnabled` | — | — | No | Enable structural reranking after RRF (default: false) |
| `hydeEnabled` | — | — | No | Enable HyDE query expansion (default: false) |
| `externalReranker` | — | — | No | External reranker API config (see below) |

### Caching

Pi-SmartRead uses a **two-tier embedding cache**:
- **In-memory LRU** (64 entries) — fast repeat lookups within a session
- **Persistent disk cache** (`.pi-smartread.embeddings.cache/`) — survives restarts, keyed by SHA-256 content hash

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

> The old standalone `read_files` tool wrapper (`createReadFilesTool` / `src/read-many.ts`) is no longer registered. Its retrieval engine lives on inside `inspect { query, depth: "deep" }`.

### HyDE query expansion

**HyDE** (Hypothetical Document Embeddings) improves semantic matching by generating a synthetic code document from the query, then embedding that instead of the raw query text. This is a **no-LLM** implementation — deterministic templates, zero extra latency.

Enable in config: `"hydeEnabled": true`

When active, `details.hyde` reports the generated document, detected pattern, and extracted identifiers.

### External reranker

An optional external reranker API can replace the local structural reranker. Supports Cohere, Jina, or any compatible endpoint.

```json
{
  "rerankEnabled": true,
  "externalReranker": {
    "baseUrl": "https://api.cohere.com/v1",
    "apiKey": "your-api-key",
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
| `inspect` | Path, query, symbol, and map modes. |
| `skill` | Skill invocations. |
| `graph_mutate` | Only when `experimental.graphMutate: true`. |
| git-notes tools | Only when `experimental.gitNotes: true`. |

`read` is **not** exposed over MCP — it is registered directly on the Pi extension API only. Use `inspect { path }` for single-file reads through MCP.

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
npm install
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

**I got a repo map instead of my read result** — Expected on the first read-like call in a repository. Re-issue the read.

**Semantic ranking is not working** — Check `pi-smartread.config.json` or the `PI_SMARTREAD_EMBEDDING_*` environment variables. BM25-only ranking will still work.

**I only want a quick structure overview** — Call `inspect { action: "map" }`.

**Doom-loop warning appears** — The LLM repeated identical tool calls 3+ times. Try a different search query or use `inspect { action: "map" }` to get oriented.

---

## Migration

### v3 tool consolidation

The standalone `read_files`, `search`, `repo_map`, and `symbol` tools have been consolidated into the `inspect` tool. Update existing calls:

| Old call | New call |
|---|---|
| `read_files { files: [...] }` | Use `read` for single files. Batch multi-file reads are no longer exposed as a registered tool; use `inspect { query }` or `inspect { path }` calls as needed. |
| `search { query }` | `inspect { query }` (default quick) or `inspect { query, depth: "deep" }` |
| `repo_map { ... }` | `inspect { action: "map" }` |
| `symbol { ... }` | `inspect { symbol }` |

`read` is unchanged.

---

## Related docs

- `docs/research-deep-dive.md` — Design research, ecosystem analysis, and roadmap (predates consolidation; historical)
- `docs/advanced-retrieval-spec.md` — Proposed architecture for graph-aware retrieval (historical / superseded)
- `docs/advanced-retrieval-implementation-plan.md` — Phase-by-phase implementation plan (historical / superseded)
- `docs/advanced-retrieval-research.md` — Academic and industry research survey (historical / superseded)
- `docs/pi-hashline-readmap-research.md` — Cross-extension integration analysis (historical / superseded)
- `docs/deep-search-spec.md` — Deep search specification (historical / superseded)
- `docs/deep-search-implementation.md` — Deep search implementation plan (historical / superseded)
- `docs/phase-6-8-implementation-notes.md` — Notes on external reranker, MCP server, HyDE, benchmarks, multi-language call graphs (historical / superseded)
- `docs/tool-consolidation-plan.md` — Pre-v3 tool-consolidation design (historical / superseded)
- `docs/plans/2026-05-03-search-tool-consolidation-design.md` — Pre-v3 search-tool consolidation design (historical / superseded)
- `docs/mcp-quickstart.md` — MCP server setup for Claude Desktop, Cursor, and generic clients

---

## License

MIT © 2026 Gurpartap Singh
MIT © 2026 Rhine Sharar
