# Pi-SmartRead

Code intelligence extension for [Pi](https://github.com/mariozechner/pi-coding-agent) — multi-file reading, intent-based retrieval, repository mapping, symbol search, cross-file resolution, and call graph analysis.

> Forked from [pi-read-many](https://github.com/Gurpartap/pi-read-many) and evolved into a full code-intelligence toolkit.

---

## Tools

| Tool | What it does |
|---|---|
| `read` | Wraps Pi's built-in `read` — may intercept the first repo read to show a compact repo map for orientation |
| `read_multiple_files` | Reads up to 20 files in one call with adaptive output packing |
| `intent_read` | Ranks candidate files for a query using BM25 + embeddings with RRF fusion |
| `repo_map` | Builds a PageRank-ranked repository map from native tree-sitter AST tags |
| `search_symbols` | Finds symbol definitions and references across the repo with code context |
| `resolve_symbol` | Resolves a symbol name to its definition, all references, and best-guess primary location |
| `find_callers` | Builds a call graph and finds all callers of a given function |

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

## First-read repo map hook

On the **first** `read`, `read_multiple_files`, or `intent_read` call in a repository, Pi-SmartRead may intercept the request and return a **compact repo map** instead of the requested file contents. This gives the agent orientation before deeper reads.

After that first intercept:
- Future reads pass through normally
- An explicit `repo_map` call also suppresses later first-read interception for that repo

If you see an intercept response, simply re-issue the original read.

---

## `read_multiple_files`

Read multiple known files in one call.

**Key behavior:**
- Reads files in request order
- Supports per-file `offset` and `limit`
- Continues on errors by default
- Uses adaptive packing under Pi output limits
- Returns stable per-file heredoc blocks
- Supports up to **20 files** per call

**Packing:** Starts with strict request-order packing, then switches to smallest-first **only** when that includes more complete successful files. Output order still follows the original request order.

### Example

```json
{
  "files": [
    { "path": "src/a.ts" },
    { "path": "src/b.ts", "offset": 40, "limit": 120 }
  ],
  "stopOnError": false
}
```

### Returned details

`details.packing` includes `strategy`, `switchedForCoverage`, `fullIncludedCount`, `fullIncludedSuccessCount`, `partialIncludedPath`, and `omittedPaths`.

---

## `intent_read`

Find the most relevant files for a query when you don't already know which files matter.

### When to use it

- "find the auth middleware"
- "which files implement repo mapping?"
- "what code is relevant to this bug?"

Use `read_multiple_files` when you already know the exact files to open.

### How it works

1. Resolves candidates from explicit files or a non-recursive directory scan
2. Augments candidates with direct in-workspace relative import neighbours
3. Reads candidate files
4. Chunks file content with overlap
5. Builds compressed embedding text with structural headers (imports stripped, whitespace collapsed, head/tail preserved)
6. Ranks files using **BM25 + semantic similarity**
7. Fuses ranks with **Reciprocal Rank Fusion (RRF, k=60)**
8. Filters low-signal candidates
9. Returns top-K files with scores and metadata

### Retrieval features

- **BM25 keyword ranking** — exact identifier and API name matching
- **Embedding cosine similarity** — conceptual matching via OpenAI-compatible endpoint
- **RRF fusion** — parameter-free rank combination (k=60)
- **Persistent embedding cache** — disk-backed (`.pi-smartread.embeddings.cache/`) with in-memory LRU layer; survives process restarts
- **Direct import-neighbour augmentation** — expands candidates via relative imports with symlink/workspace escape guards
- **Compressed embedding snippets** — noise-stripped, head/tail preserving for efficient embedding
- **BM25-only degradation** — graceful fallback when the embedding request fails after config validation

### Example

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

### Output

A single combined text payload using framed heredoc blocks, plus ranking metadata in `details.files`:

| Field | Type | Meaning |
|---|---|---|
| `path` | `string` | Resolved file path |
| `ok` | `boolean` | Whether reading succeeded |
| `keywordRank` / `keywordScore` | `number` | BM25 ranking data |
| `semanticRank` / `semanticScore` | `number` | Embedding ranking data |
| `rrfScore` | `number` | Fused RRF score |
| `rankedBy` | `"bm25" \| "hybrid"` | Ranking mode used |
| `inclusion` | `string` | `full`, `partial`, `omitted`, `not_top_k`, `below_threshold`, or `error` |

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
  "focusFiles": ["repomap.ts"],
  "priorityIdentifiers": ["RepoMap"],
  "mentionedIdents": ["cache"],
  "mentionedFnames": ["tags.ts"],
  "compact": false
}
```

### Options

| Option | Default | Meaning |
|---|---|---|
| `mapTokens` | 4096 | Token budget for the rendered map (256–32768) |
| `focusFiles` | `[]` | Files to personalize PageRank toward |
| `priorityIdentifiers` | `[]` | Identifiers to boost in ranking |
| `mentionedIdents` | `[]` | Identifiers from the user query — used for file-path matching |
| `mentionedFnames` | `[]` | File paths from the user query — used for personalization |
| `excludeUnranked` | `false` | Exclude files with zero PageRank |
| `forceRefresh` | `false` | Ignore cache and re-parse |
| `useImportBased` | `false` | Force import-only ranking (faster, less precise) |
| `autoFallback` | `true` | Fall back automatically if AST parsing fails |
| `compact` | `false` | Terse single-line-per-file view |

---

## `search_symbols`

Search for symbol definitions and references across the repository.

### What it does

- Uses native tree-sitter tags when available
- Falls back to text-based search when AST tags are unavailable
- Supports definition-only or reference-only filtering
- Returns surrounding code context for each match

### Example

```json
{
  "query": "getRepoMap",
  "directory": ".",
  "maxResults": 10,
  "includeDefinitions": true,
  "includeReferences": false
}
```

---

## `resolve_symbol`

Resolve a symbol name across the repository — find its definition, all references, and the most likely primary definition.

### What it does

- Parses all source files with tree-sitter
- Extracts definitions and references from AST tags
- Disambiguates when a symbol is defined in multiple files
- Prioritizes by proximity: same file → direct import → same directory → shared parent

### Example

```json
{
  "symbol": "User",
  "context": "src/models/user.ts:42",
  "directory": ".",
  "maxResults": 50
}
```

### Output

- `definitions[]` — all definition locations with kind, scope, and context
- `references[]` — all reference locations with context
- `bestDefinition` — the highest-confidence match based on context proximity

---

## `find_callers`

Find all functions that call a given function across the repository.

### What it does

- Builds a call graph from tree-sitter ASTs
- Extracts `call_expression` nodes and maps them to enclosing function definitions
- Supports TypeScript, JavaScript, and TSX

### Example

```json
{
  "function": "getConfig",
  "directory": ".",
  "maxResults": 50
}
```

---

## Supported languages

Pi-SmartRead supports tree-sitter analysis for **41 languages**:

Bash, C, C#, C++, Clojure, Common Lisp, CSS, D, Dart, Elisp, Elixir, Elm, Fortran, Gleam, Go, Haskell, HCL (Terraform), Java, JavaScript, JSX, Julia, Kotlin, Lua, MATLAB, OCaml, PHP, Pony, Python, QL (CodeQL), R, Racket, Ruby, Rust, Scala, Solidity, Swift, TypeScript, TSX, Udev, Zig

Languages without dedicated tree-sitter parsers still work for `read_multiple_files` and `intent_read` (via BM25 text ranking).

---

## Configuration

### Embedding backend

`intent_read` semantic ranking uses an **OpenAI-compatible embeddings API**.

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
| `probeEnabled` | — | — | No | Enable symbol-based query probing for intent_read (default: false, experimental) |
| `rerankEnabled` | — | — | No | Enable structural reranking after RRF for intent_read (default: false, experimental) |

### Caching

Pi-SmartRead uses a **two-tier embedding cache**:
- **In-memory LRU** (64 entries) — fast repeat lookups within a session
- **Persistent disk cache** (`.pi-smartread.embeddings.cache/`) — survives restarts, keyed by SHA-256 content hash of the request

### Behavior when config is missing

If `baseUrl` or `model` is missing, the extension still loads. `intent_read` throws before reading files. BM25-only fallback applies only after configuration is valid and the embedding request itself fails.

---

## Output format

`read_multiple_files` and `intent_read` return framed file blocks:

```
@path/to/file
<<'WORD_INDEX_HASH'
...file content...
WORD_INDEX_HASH
```

Delimiter parts: `WORD` (readable dictionary word), `INDEX` (1-based file index), `HASH` (deterministic short hash of the path). Collisions are automatically retried with a safe suffix.

---

## Native tree-sitter

Pi-SmartRead uses **native tree-sitter bindings** (not WASM) for all AST operations:

- Native parsers: `tree-sitter`, `tree-sitter-javascript`, `tree-sitter-typescript`
- Query files from the bundled `queries/` directory
- Chunked callback parsing for large files (avoids the native binding failure on files >32KB)
- Text fallback in `search_symbols` when AST tags are unavailable

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

**`intent_read` is not using semantic ranking** — Check `pi-smartread.config.json` or the `PI_SMARTREAD_EMBEDDING_*` environment variables.

**`search_symbols` returns no results after an update** — Reload Pi with `/reload`.

**I only want a quick structure overview** — Call `repo_map` with `compact: true`.

---

## Related docs

- `docs/research-deep-dive.md` — Design research, ecosystem analysis, implemented retrieval patterns, and roadmap
- `progress.md` — Implementation snapshot

---

## License

MIT © 2026 Gurpartap Singh
