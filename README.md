# Pi-SmartRead

Code intelligence extension for [Pi](https://github.com/mariozechner/pi-coding-agent) — unified file reading, intent-based retrieval, repository mapping, consolidated symbol/code/deep search, cross-file resolution, call graph analysis, and AST-aware code search.

> Forked from [pi-read-many](https://github.com/Gurpartap/pi-read-many) and evolved into a full code-intelligence toolkit.

---

## Tools

| Tool | What it does |
|---|---|
| `read` | Single-file read with contextual enrichment (imports, git, graphify) |
| `read_files` | Multi-file batch read with adaptive output packing |
| `intent_read` | Intent-based file discovery with hybrid RRF retrieval (BM25 + embeddings) |
| `search` | Consolidated search: grep-style text search with definition-aware ranking (`grep`), BM25 + embedding code search with symbol enrichment (`code`), agentic multi-channel deep search (`deep`) |
| `repo_map` | PageRank-ranked repository map from native tree-sitter AST tags |
| `find_symbol` | Symbol-level exploration: name search, file outline, references, declaration, implementations, workspace-wide LSP search, hover info |
| `graph_mutate` | [experimental] Records semantic coupling observations (breakage edges, co-change edges) into the context graph |

### Cross-cutting features

Pi-SmartRead also provides passive safety and enrichment that runs across all tool calls:

| Feature | What it does |
|---|---|
| **Context hygiene** | Tracks every read tool result; marks stale reads in the context window after file mutations |
| **Doom-loop detection** | Warns when the LLM repeats identical tool calls 3+ times, with tool-specific suggestions |
| **Bash context guard** | Caps oversized bash output to head+tail preview, writes full output to temp file |
| **Startup repo map injection** | Injects a compact repo map on the first turn of every session — no wasted round trips |
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

## `read_files`

Read up to 20 files in one call with adaptive output packing.

**Key behavior:**
- Reads files in request order
- Supports per-file `offset` and `limit`
- Continues on errors by default (`stopOnError: false`)
- Uses adaptive packing under pi output limits
- Returns stable per-file heredoc blocks

```json
{
  "files": [
    { "path": "src/a.ts" },
    { "path": "src/b.ts", "offset": 40, "limit": 120 }
  ],
  "stopOnError": false
}
```

`details.packing` includes `strategy`, `switchedForCoverage`, `fullIncludedCount`, `fullIncludedSuccessCount`, `partialIncludedPath`, and `omittedPaths`.

---

## `intent_read`

Find the most relevant files for a query using hybrid retrieval.

**How it works:**
1. Resolves candidates from explicit files or a non-recursive directory scan
2. Augments candidates with direct in-workspace relative import neighbours
3. Reads candidate files and chunks content with overlap
4. Builds compressed embedding text with structural headers
5. Ranks files using **BM25 + semantic similarity**
6. Fuses ranks with **Reciprocal Rank Fusion (RRF, k=60)**
7. Returns top-K files with scores and provenance metadata

**Retrieval features:**
- **BM25 keyword ranking** — exact identifier and API name matching
- **Embedding cosine similarity** — conceptual matching via OpenAI-compatible endpoint
- **RRF fusion** — parameter-free rank combination
- **HyDE query expansion** — hypothetical document embedding for better semantic matching (opt-in)
- **Graph-aware candidate expansion** — import neighbours, symbol neighbours, call graph neighbours
- **Query probing** — extracts identifiers from query and resolves definition files (opt-in)
- **Structural reranker** — reorders results using graph distance, probe confidence, temporal signals (opt-in)
- **External reranker** — optional Cohere/Jina-compatible reranking endpoint
- **Persistent embedding cache** — disk-backed (`.pi-smartread.embeddings.cache/`) with in-memory LRU layer
- **BM25-only degradation** — graceful fallback when embedding config is missing or unreachable

```json
{
  "query": "authentication middleware",
  "files": [
    { "path": "src/auth.ts" },
    { "path": "src/middleware.ts" }
  ],
  "topK": 2
}
```

The output includes framed heredoc blocks plus ranking metadata in `details.files` with path, relevance scores, and inclusion status.

---

## `search`

Consolidated search with three modes.

### Modes

| Mode | What it does | Use when |
|---|---|---|
| `grep` (default) | Grep-style line search across code, config, and docs files. Definition hits are ranked first, then plain text hits. | "find `JWT_SECRET` in the repo" |
| `code` | BM25 + optional embedding re-rank with symbol resolution and caller enrichment. | "find authentication middleware implementation" |
| `deep` | Agentic multi-channel deep search orchestrating code, symbol, semantic, and graph channels with RRF fusion. | "how does the auth system work?" |

### Enrichment

In `code` mode, results are enriched by default: top symbols are resolved and caller info is appended. Set `enrich: false` for bare results.

### Examples

**Grep-style text search:**

```json
{
  "mode": "grep",
  "query": "JWT_SECRET",
  "contextLines": 1
}
```

`grep` mode defaults to literal substring matching, auto-switches to case-sensitive matching for mixed-case queries, and also supports:

```json
{
  "mode": "grep",
  "query": "plugin-[a-z]+",
  "matchMode": "regex",
  "caseSensitive": false
}
```

**Code search with enrichment:**

```json
{
  "mode": "code",
  "query": "authentication middleware",
  "directory": "src"
}
```

**Deep search:**

```json
{
  "mode": "deep",
  "query": "how does JWT token validation work?",
  "depth": "standard",
  "scope": "code",
  "directory": "src",
  "limit": 15,
  "maxSnippetChars": 400,
  "includeRelationships": true
}
```

### Deep search options

| Option | Default | Meaning |
|---|---|---|
| `depth` | `standard` | `quick` (code+symbols), `standard` (+semantic+graph), `thorough` (+caller enrichment) |
| `scope` | `all` | Filter to `code`, `docs`, `tests`, or `all` |
| `directory` / `folder` | working directory | Root directory to search |
| `limit` | 15 | Maximum matches (1–50) |
| `maxSnippetChars` | 400 | Max chars per snippet (100–1000) |
| `outputBudget` | 4096 | Approximate output token budget (1k–16k) |
| `includeRelationships` | false | Include caller/callee/import hints for top matches |

---

## `repo_map`

Generate a repository map using **native tree-sitter AST extraction** by default, with an **import-based fallback** when needed.

### What it does

- Scans source files across 41 supported languages
- Extracts definitions and references via native tree-sitter parsers
- Ranks files using PageRank with optional personalization
- Renders a token-budgeted map for agent orientation

### Example

```json
{
  "directory": ".",
  "mapTokens": 4096,
  "focus": ["repomap.ts"],
  "compact": false
}
```

### Options

| Option | Default | Meaning |
|---|---|---|
| `mapTokens` | 4096 | Token budget (256–32768) |
| `focus` | `[]` | Files or symbols to personalize PageRank toward |
| `compact` | false | Terse single-line-per-file view |

---

## `find_symbol`

Symbol-level code exploration with seven actions.

### Actions

| Action | What it does |
|---|---|
| `symbol` (default) | Find symbols by name/pattern. Supports qualified paths (`ClassName.methodName`). |
| `overview` | File outline via AST analysis — all top-level symbols with types and line ranges. |
| `references` | All reference locations for a symbol across the codebase. |
| `declaration` | Find the definition/declaration of a symbol with optional context file. |
| `implementations` | Find types that implement an interface or extend a class. |
| `workspace` | Workspace-wide symbol search via LSP. |
| `hover` | Type/signature/quick-info at a file position via LSP. |

### Examples

```json
{
  "action": "symbol",
  "query": "UserService.create"
}
```

```json
{
  "action": "overview",
  "relative_path": "src/services/auth.ts"
}
```

```json
{
  "action": "references",
  "query": "Authenticator",
  "relative_path": "src/middleware/auth.ts"
}
```

```json
{
  "action": "hover",
  "relative_path": "src/services/auth.ts:42:12"
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

The next `intent_read` touching A will automatically include B as a candidate.

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

Exposes: `read`, `read_files`, `intent_read`, `search`, `repo_map`, `find_symbol`, and (if experimental features are enabled) `graph_mutate` and git notes tools.

See **[docs/mcp-quickstart.md](docs/mcp-quickstart.md)** for full setup instructions.

---

## Native tree-sitter

Pi-SmartRead uses **native tree-sitter bindings** (not WASM) for all AST operations:

- Native parsers: `tree-sitter`, `tree-sitter-javascript`, `tree-sitter-typescript`, `tree-sitter-python`, `tree-sitter-go`, `tree-sitter-rust`
- Query files from the bundled `queries/` directory
- Chunked callback parsing for large files
- Text fallback when AST tags are unavailable

A **WASM grammar loader** (`grammar-loader.ts`) provides additional language support via `@vscode/tree-sitter-wasm` for AST-boundary chunking.

---

## Development

```bash
npm install
npm run typecheck
npm test
```

For local one-off loading:

```bash
pi -e ./index.ts
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

**I only want a quick structure overview** — Call `repo_map` with `compact: true`.

**Doom-loop warning appears** — The LLM repeated identical tool calls 3+ times. Try a different search query or use `repo_map` to get oriented.

---

## Migration

### `query` is now required (v2.0.0)

The `query` parameter for the `search` tool is now required. Previously it was optional in some contexts.

To migrate:

1. Ensure all `search` tool calls include a non-empty `query` string.
2. If you previously omitted `query`, add it explicitly.
3. Missing or empty `query` now throws a descriptive error.

---

## Related docs

- `docs/research-deep-dive.md` — Design research, ecosystem analysis, and roadmap (some sections predate consolidation)
- `docs/advanced-retrieval-spec.md` — Proposed architecture for graph-aware retrieval
- `docs/advanced-retrieval-implementation-plan.md` — Phase-by-phase implementation plan
- `docs/advanced-retrieval-research.md` — Academic and industry research survey
- `docs/pi-hashline-readmap-research.md` — Cross-extension integration analysis
- `docs/deep-search-spec.md` — Deep search specification (predates consolidation into `search mode="deep"`)
- `docs/deep-search-implementation.md` — Deep search implementation plan
- `docs/phase-6-8-implementation-notes.md` — Notes on external reranker, MCP server, HyDE, benchmarks, multi-language call graphs
- `docs/mcp-quickstart.md` — MCP server setup for Claude Desktop, Cursor, and generic clients
- `progress.md` — Implementation snapshot

---

## License

MIT © 2026 Gurpartap Singh
MIT © 2026 Rhine Sharar
