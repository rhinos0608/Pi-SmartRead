# 📚 Pi-SmartRead (`pi-read-many`)

Pi extension package for **multi-file reading, intent-based retrieval, repository mapping, and symbol search**.

> npm package name: `pi-read-many`
> project/repo name: `Pi-SmartRead`

---

## What it adds to Pi

This package ships five code-navigation tools and behaviors:

| Tool / behavior | What it does |
|---|---|
| `read` | Wraps Pi's built-in `read` and may intercept the first repo read to show a compact repo map |
| `read_multiple_files` | Reads up to 20 files in one call with adaptive output packing |
| `intent_read` | Ranks candidate files for a query using BM25 + embeddings with RRF fusion |
| `repo_map` | Builds a PageRank-ranked repository map from native tree-sitter tags |
| `search_symbols` | Finds symbol definitions and references with context |

This package is useful when an agent needs to:
- inspect several files at once
- find the most relevant files for a task
- understand repo structure before reading deeply
- locate functions, classes, and references quickly

---

## Install

### Preferred (npm)

```bash
pi install npm:pi-read-many
```

### Alternative (source)

```bash
pi install git:https://github.com/Gurpartap/pi-read-many
```

If Pi is already running when you install or update the package, run:

```text
/reload
```

---

## First-read repo map hook

On the **first** `read`, `read_multiple_files`, or `intent_read` call in a repository, Pi-SmartRead may intercept the request and return a **compact repo map** instead of the requested file contents.

This gives the agent orientation before deeper reads.

After that first intercept:
- future reads pass through normally
- an explicit `repo_map` call also suppresses later first-read interception for that repo

If you see an intercept response, simply re-issue the original read.

---

## `read_multiple_files`

Read multiple known files in one call.

### Key behavior

- reads files in request order
- supports per-file `offset` and `limit`
- continues on errors by default
- uses adaptive packing under Pi output limits
- returns stable per-file heredoc blocks
- supports up to **20 files** per call

### Packing behavior

Pi-SmartRead starts with strict request-order packing, then switches to smallest-first **only** when that includes more complete successful files. Output order still follows the original request order.

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

`details.packing` includes:
- `strategy`
- `switchedForCoverage`
- `fullIncludedCount`
- `fullIncludedSuccessCount`
- `partialIncludedPath`
- `omittedPaths`

---

## `intent_read`

Find the most relevant files for a query when you do **not** already know which files matter.

### When to use it

Use `intent_read` for tasks like:
- “find the auth middleware”
- “which files implement repo mapping?”
- “what code is relevant to this bug?”

Use `read_multiple_files` when you already know the exact files to open.

### How it works

1. resolves candidates from explicit files or a non-recursive directory scan
2. augments candidates with direct in-workspace relative import neighbours when there is room
3. reads candidate files
4. chunks file content with overlap
5. builds compressed embedding text with structural headers
6. ranks files using **BM25 + semantic similarity**
7. fuses ranks with **Reciprocal Rank Fusion (RRF)**
8. filters low-signal candidates
9. returns the top-K files with scores and metadata

### Current implemented retrieval features

- **BM25 keyword ranking**
- **embedding cosine similarity** against an OpenAI-compatible endpoint
- **RRF fusion** (`k = 60`)
- **direct import-neighbour augmentation**
- **compressed embedding snippets** (imports stripped, whitespace collapsed, head/tail preserved)
- **in-memory LRU cache** for repeated embedding batches
- **BM25-only degradation** when the embedding request fails after configuration has been validated

### Example

```json
{
  "query": "authentication middleware",
  "files": [
    { "path": "src/auth.ts" },
    { "path": "src/middleware.ts" },
    { "path": "src/routes.ts" }
  ],
  "topK": 2
}
```

### Output shape

`intent_read` returns:
- a single combined text payload in `content[0].text`, using framed heredoc blocks for included files
- ranking and diagnostic metadata in `details`

The per-file ranking data lives in `details.files`. Each file entry may include:

| Field | Type | Meaning |
|---|---|---|
| `path` | `string` | resolved file path |
| `ok` | `boolean` | whether reading succeeded |
| `keywordRank` / `keywordScore` | `number` | BM25 ranking data |
| `semanticRank` / `semanticScore` | `number` | embedding ranking data when semantic ranking succeeded |
| `rrfScore` | `number` | fused RRF score |
| `chunkIndex` / `chunkScore` | `number` | best chunk selected for the file |
| `rankedBy` | `"bm25" | "hybrid"` | ranking mode used for that file |
| `selectedForPacking` | `boolean` | whether the file made the top-K set |
| `included` | `boolean` | whether the file made it into the final output budget |
| `inclusion` | `string` | inclusion reason such as `full`, `partial`, `omitted`, `not_top_k`, `below_threshold`, or `error` |

Additional diagnostics may appear under `details`, including:
- `embeddingStatus`
- `embeddingCache`
- `filteredBelowThresholdPaths`
- `graphAugmentation`
- `chunkInfo`
- `packing`

---

## `repo_map`

Generate a repository map using **native tree-sitter AST extraction** by default, with an **import-based fallback** when needed.

### What it does

- scans supported source files
- extracts definitions and references
- ranks files using PageRank
- personalizes ranking toward files and identifiers
- renders a token-budgeted map for agent orientation

### Example

```json
{
  "directory": ".",
  "mapTokens": 4096,
  "focusFiles": ["repomap.ts"],
  "priorityIdentifiers": ["RepoMap"],
  "compact": false
}
```

### Notable options

| Option | Meaning |
|---|---|
| `mapTokens` | token budget for the rendered map |
| `focusFiles` | files to personalize PageRank toward |
| `priorityIdentifiers` | identifiers to boost |
| `forceRefresh` | ignore cache and re-parse |
| `useImportBased` | force import-only ranking |
| `autoFallback` | fall back automatically if AST parsing fails |
| `compact` | emit a terse single-line-per-file view |

---

## `search_symbols`

Search for symbol definitions and references across the repository.

### What it does

- uses native tree-sitter tags when available
- falls back to text-based symbol search when AST tags are unavailable
- supports definition-only or reference-only filtering
- returns surrounding code context for each match

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

### Typical output

```text
Found 2 symbol(s) matching "getRepoMap":

  repomap-tool.ts:95  [def]  getRepoMap
  repomap.ts:598  [def]  getRepoMap
```

---

## Output format

`read_multiple_files` and `intent_read` return framed file blocks like:

```bash
@path/to/file
<<'WORD_INDEX_HASH'
...file content...
WORD_INDEX_HASH
```

Delimiter parts:
- `WORD`: readable dictionary word
- `INDEX`: 1-based file index
- `HASH`: deterministic short hash of the path

If a delimiter collides with file content, Pi-SmartRead automatically retries with a safe suffix.

---

## Configuration

### Embedding backend

`intent_read` semantic ranking uses an **OpenAI-compatible embeddings API**.

Configure it with `pi-smartread.config.json` in the current directory or any parent directory:

```json
{
  "baseUrl": "http://localhost:11434/v1",
  "model": "nomic-embed-text",
  "apiKey": "ollama"
}
```

### Config fields

| Config key | Primary env var | Compatibility env var | Required | Description |
|---|---|---|---|---|
| `baseUrl` | `PI_SMARTREAD_EMBEDDING_BASE_URL` | `EMBEDDING_BASE_URL` | Yes | OpenAI-compatible base URL |
| `model` | `PI_SMARTREAD_EMBEDDING_MODEL` | `EMBEDDING_MODEL` | Yes | embedding model name |
| `apiKey` | `PI_SMARTREAD_EMBEDDING_API_KEY` | — | No | bearer token |
| `chunkSizeChars` | `PI_SMARTREAD_CHUNK_SIZE` | — | No | target chunk size |
| `chunkOverlapChars` | `PI_SMARTREAD_CHUNK_OVERLAP` | — | No | chunk overlap |
| `maxChunksPerFile` | `PI_SMARTREAD_MAX_CHUNKS` | — | No | max chunks per file |

### Chunking defaults

| Setting | Default |
|---|---|
| `chunkSizeChars` | `4096` |
| `chunkOverlapChars` | `512` |
| `maxChunksPerFile` | `12` |

### Behavior when config is missing

If `baseUrl` or `model` is missing:
- the extension still loads
- `intent_read` throws before reading files
- BM25-only fallback applies only after configuration is valid and the embedding request itself fails

---

## Native tree-sitter notes

Pi-SmartRead now uses **native tree-sitter bindings**, not WASM, for repo mapping and symbol search.

Current implementation details:
- native parsers: `tree-sitter`, `tree-sitter-javascript`, `tree-sitter-typescript`
- query files from the bundled `queries/` directory
- chunked callback parsing for large files, which avoids the native binding failure seen on TypeScript files larger than roughly 32KB
- text fallback in `search_symbols` when AST tags are unavailable

---

## Development

```bash
npm install
npm run typecheck
npm test
```

For local one-off loading during development:

```bash
pi -e ./index.ts
```

If Pi is already running, use:

```text
/reload
```

Useful focused checks:

```bash
npm test -- --run test/unit/tags.test.ts test/unit/repomap-search.test.ts test/unit/repomap-tool.test.ts test/unit/index.test.ts
```

---

## Troubleshooting

### I got a repo map instead of my read result
That is expected on the first read-like call in a repository. Re-issue the read.

### `intent_read` is not using semantic ranking
Check `pi-smartread.config.json` or the `PI_SMARTREAD_EMBEDDING_*` environment variables.

### `search_symbols` returns no results after an update
Reload Pi with `/reload` so the running extension host picks up the current build.

### I only want a quick structure overview
Call `repo_map` with `compact: true`.

---

## Related docs

- `docs/research-deep-dive.md` — design research, implemented retrieval patterns, and roadmap
- `progress.md` — implementation snapshot

---

## License

MIT © 2026 Gurpartap Singh
