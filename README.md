# 📚 pi-read-many

> **Tool renamed:** `read_many` → `read_multiple_files`

[![pi coding agent](https://img.shields.io/badge/pi-coding%20agent-6f6bff?logo=terminal&logoColor=white)](https://pi.dev/)
[![npm version](https://img.shields.io/npm/v/pi-read-many.svg)](https://www.npmjs.com/package/pi-read-many)
[![license](https://img.shields.io/github/license/Gurpartap/pi-read-many.svg)](LICENSE)

Batch file reads for Pi via a single tool: **`read_multiple_files`**.

It helps the model inspect multiple files in one call instead of issuing many separate `read` calls.

---

## 🚀 Install

### Preferred (npm)

```bash
pi install npm:pi-read-many
```

### Alternative (source)

```bash
pi install git:https://github.com/Gurpartap/pi-read-many
```

After install, use Pi normally. If Pi is already running when you install or update, run:

```text
/reload
```

---

## 📝 Notes

- `read_multiple_files` does **not** override built-in `read`.
- `read_multiple_files` summarizes image attachments in combined text output; exact single-file image payload behavior remains in built-in `read`.

---

## ✨ What `read_multiple_files` does

- Reads files **sequentially in request order**.
- Uses Pi's built-in `read` under the hood (same core semantics).
- Returns one combined text response using per-file heredoc blocks.
- Continues on per-file errors by default (`stopOnError: false`).
- Applies combined output budgeting with block-safe packing.
- Exposes packing decisions in `details.packing`.
- **Limit:** up to **5 files** per call.

### Additional behavior

- **Adaptive packing:** starts with strict request-order full-block packing.
- **Strategy switch:** uses smallest-first **only if** it increases complete successful-file coverage.
- **Stable output order:** rendered sections still follow original request order.
- **Partial inclusion:** includes at most one partial section when needed.
- **Error consistency:** errors are framed exactly like normal file blocks.
- **Image-safe output:** image payloads are summarized in text.

## 🔢 Example `read_multiple_files` input

```json
{
  "files": [
    { "path": "src/a.ts" },
    { "path": "src/b.ts", "offset": 40, "limit": 120 }
  ],
  "stopOnError": false
}
```

---

## 🔍 `intent_read` — Intent-Based File Reader

A second tool ships alongside `read_multiple_files`. It accepts a **query string** and up to **20 file candidates**, reads all of them, ranks them by relevance to the query, and returns the top-K results with file contents and per-file relevance metadata.

**Limit:** up to **20 files** per call.

### When to use it

Use `intent_read` when the model needs to find the right files for a task but doesn't know which ones to open — for example, searching for a bug across many source files, gathering all files related to a feature, or answering a high-level question from a codebase.

Use `read_multiple_files` when the files are already known and should all be included.

### How it works

1. **Read** all candidate files sequentially.
2. **Chunk** each file's content (configurable chunk size and overlap).
3. **Score** each file's chunks against the query using hybrid ranking.
4. **Select** the top-scoring chunk per file as that file's relevance score.
5. **Fuse** per-file scores via Reciprocal Rank Fusion (RRF) across ranking approaches.
6. **Return** top-K results with their full content and per-file metadata.

### Ranking: Hybrid BM25 + Semantic RRF

`intent_read` uses two independent ranking passes per file:

| Ranker | Method | Description |
|---|---|---|
| **BM25** | Classic keyword | Fast sparse retrieval over raw chunk text |
| **Semantic** | Embedding cosine | Dense similarity via an OpenAI-compatible embedding endpoint |

Per-file scores are fused via **Reciprocal Rank Fusion (RRF)**:

```
RRF_score(d) = Σ  1 / (k + rank(d))
```

Where `k = 60` and ranks come from BM25 and semantic rankers independently. Each file's best-scoring chunk is used for both rankers.

If no embedding endpoint is configured, `intent_read` falls back to **BM25-only ranking**.

### Output fields

Each result in `results` includes:

| Field | Type | Description |
|---|---|---|
| `path` | `string` | Resolved file path |
| `content` | `string` | Full text content of the file |
| `score` | `number` | RRF fusion score (higher = more relevant) |
| `ranks` | `object` | Raw per-ranker scores (`bm25`, `semantic`) and ranks (`bm25_rank`, `semantic_rank`) |

### 🔢 Example `intent_read` input

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

---

## 📦 Output format

Each included file is returned in this framed block format:

```bash
@path/to/file
<<'WORD_INDEX_HASH'
...file content...
WORD_INDEX_HASH
```

### Delimiter rules (`WORD_INDEX_HASH`)

- `WORD`: fixed readable dictionary word from a **26-word dictionary** (one unique starting letter per word)
- `INDEX`: 1-based file index in the request
- `HASH`: deterministic short hash of the file path

> **Note:** The 26-word dictionary is purely a **formatting convenience** — it produces readable, distinct delimiters per file. It is not a file count limit. Limits are enforced by the tool's schema (5 for `read_multiple_files`, 20 for `intent_read`).

If a delimiter collides with a content line, the tool auto-suffixes (`_1`, `_2`, …) and keeps trying deterministic fallbacks until it finds a safe delimiter.

---

## 🧾 `details.packing` fields

| Field | Meaning |
|---|---|
| `strategy` | Chosen packing strategy (`request-order` or `smallest-first`) |
| `switchedForCoverage` | Whether strategy switched to improve successful full-file coverage |
| `fullIncludedCount` | Number of fully included blocks |
| `fullIncludedSuccessCount` | Number of fully included successful blocks |
| `partialIncludedPath` | Path of partially included block (if any) |
| `omittedPaths` | Paths omitted due to budget limits |

---

## ⚙️ Configuration

### Embedding backend (for `intent_read` semantic ranking)

`intent_read` sends file contents to an **OpenAI-compatible embedding endpoint** for semantic scoring. The model may be open-source (e.g. Nomic, Ollama), self-hosted, or a cloud provider.

Configure it via **`pi-smartread.config.json`** in the current working directory or any parent directory, or via **environment variables**:

```json
{
  "baseUrl": "http://localhost:11434/v1",
  "model": "nomic-embed-text",
  "apiKey": "ollama"
}
```

| Config key | Env var | Required | Description |
|---|---|---|---|
| `baseUrl` | `PI_SMARTREAD_EMBEDDING_BASE_URL` | ✅ Yes | OpenAI-compatible `/embeddings` endpoint base URL |
| `model` | `PI_SMARTREAD_EMBEDDING_MODEL` | ✅ Yes | Embedding model name |
| `apiKey` | `PI_SMARTREAD_EMBEDDING_API_KEY` | No | Bearer token sent as `Authorization: Bearer <apiKey>` |

> If `baseUrl` or `model` is missing, `intent_read` falls back to **BM25-only ranking** at call time — the extension will still load and register successfully.

### Chunking (for `intent_read` embedding/scoring)

Each file is split into overlapping text chunks before embedding and BM25 scoring.

| Env var | Default | Description |
|---|---|---|
| `PI_SMARTREAD_CHUNK_SIZE` | `4096` | Target characters per chunk |
| `PI_SMARTREAD_CHUNK_OVERLAP` | `512` | Character overlap between consecutive chunks |
| `PI_SMARTREAD_MAX_CHUNKS_PER_FILE` | `12` | Maximum chunks extracted per file (prevents runaway processing of very large files) |

These values can also be set in `pi-smartread.config.json` using the keys `chunkSizeChars`, `chunkOverlapChars`, and `maxChunksPerFile`.

---

## 🛠️ Development

```bash
npm install
npm run typecheck
npm test
```

Tests are unit-level and do not launch Pi directly.

For local one-off development loading:

```bash
pi -e ./read-many.ts
```

---

## 📄 License

MIT © 2026 Gurpartap Singh
