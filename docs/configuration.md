# Configuration reference

This page lists every setting Pi-SmartRead reads. The defaults work without
any configuration. For an overview, see the
[README](../README.md#configuration).

Settings come from three places:

- **Repository config.** `pi-smartread.config.json`, found by searching
  upward from the current directory. It may hold models, sizes, feature
  flags and git options. It is never trusted for network endpoints or
  credentials.
- **Environment variables.** These are the only source of endpoints and
  keys. They also hold tuning knobs.
- **User-level files under `~/.pi/agent/`.** These hold judge and
  language-server settings.

## Contents

- [Repository config file](#repository-config-file)
- [Embeddings and reranking](#embeddings-and-reranking)
- [Reads](#reads)
- [grep ranking](#grep-ranking)
- [Relevance judge](#relevance-judge)
- [Output guard and bash hints](#output-guard-and-bash-hints)
- [File watching](#file-watching)
- [Diagnostics and performance](#diagnostics-and-performance)
- [Language servers](#language-servers)

## Repository config file

All keys are optional:

```json
{
  "model": "nomic-embed-text",
  "chunkSizeChars": 4096,
  "chunkOverlapChars": 512,
  "maxChunksPerFile": 12,
  "probeEnabled": false,
  "rerankEnabled": false,
  "hydeEnabled": false,
  "externalReranker": { "model": "rerank-english-v3.0", "timeoutMs": 10000, "maxDocuments": 20 },
  "search": { "enrich": { "code": { "callers": true, "resolution": true, "symbols": true } } },
  "gitContext": {
    "enabled": true,
    "startupLogLimit": 30,
    "coCommitAnalysisLimit": 100,
    "coCommitMinCorrelation": 0.15,
    "coCommitMinCount": 2,
    "readEnrichmentCommits": 3,
    "showTrailerKeys": ["Constraint", "Directive", "Rejected"],
    "notesRefs": ["refs/notes/pi-smartread", "refs/notes/lore", "refs/notes/opencode", "refs/notes/commits"],
    "tokenBudget": { "gitLog": 800, "coCommitHotspots": 400, "gitNotes": 600 }
  },
  "experimental": { "graphMutate": false, "gitNotes": false, "bashMisuseHints": true }
}
```

The `gitContext` and `experimental` values shown are the defaults.

| Key                   | Effect                                                         |
| --------------------- | -------------------------------------------------------------- |
| `model`               | Embedding model. Takes precedence over `PI_SMARTREAD_EMBEDDING_MODEL`. |
| `chunkSizeChars`, `chunkOverlapChars`, `maxChunksPerFile` | How files are split for embedding |
| `probeEnabled`        | Symbol-based query probing                                     |
| `rerankEnabled`       | Rerank after fusion. Uses the external reranker if one is configured, otherwise a structural reranker. |
| `hydeEnabled`         | Expands queries with HyDE (hypothetical document embeddings)   |
| `externalReranker`    | Model, timeout and batch size for the external reranker. Its endpoint comes from the environment. |
| `search.enrich.code`  | When code-search enrichment runs, chooses whether to add callers, resolution info and symbol tags. Each defaults to `true`. |
| `gitContext`          | Commit history, co-change analysis and git notes in read footers and startup context |
| `experimental`        | Turns on `graph_mutate`, the git-notes tools, and bash misuse hints |

SmartRead ignores any `baseUrl` or `apiKey` fields in this file.

## Embeddings and reranking

| Variable                          | Effect                                              |
| --------------------------------- | --------------------------------------------------- |
| `PI_SMARTREAD_EMBEDDING_BASE_URL` | OpenAI-compatible embeddings endpoint. Falls back to `EMBEDDING_BASE_URL`. |
| `PI_SMARTREAD_EMBEDDING_MODEL`    | Embedding model, used when the config file sets none. Falls back to `EMBEDDING_MODEL`. |
| `PI_SMARTREAD_EMBEDDING_API_KEY`  | Key for the embeddings endpoint                     |
| `PI_SMARTREAD_CHUNK_SIZE`, `PI_SMARTREAD_CHUNK_OVERLAP`, `PI_SMARTREAD_MAX_CHUNKS` | Chunking, used when the config file sets none |
| `PI_SMARTREAD_RERANKER_BASE_URL`  | External reranker endpoint. Its presence enables the reranker. |
| `PI_SMARTREAD_RERANKER_API_KEY`   | Key for the external reranker                       |
| `PI_SMARTREAD_ALLOWED_ROOT`       | Limits automatic indexing and retrieval to one root. It does not restrict direct reads. Falls back to `CBM_ALLOWED_ROOT`. |

Semantic search needs both an endpoint and a model. Plain HTTP is accepted
for `localhost`, private-network addresses and `.local` hosts. Any other
endpoint must use HTTPS. If the external reranker fails, the structural
reranker takes over.

## Reads

| Variable                         | Default    | Effect                                       |
| -------------------------------- | ---------- | -------------------------------------------- |
| `PI_SMARTREAD_AST_OUTLINE`       | on         | Set to `0` to always return full file bodies. |
| `PI_SMARTREAD_AST_OUTLINE_BYTES` | `20000`    | File size above which a plain read returns an outline |
| `PI_EDIT_MODE`                   | `text`     | `text` or `hashline` line prefixes. SmartEdit reads the same setting. |

## grep ranking

These knobs affect BM25 ranking when no semantic index exists. All are off
by default except test demotion. Boolean knobs accept `1`, `true`, `on` or
`yes`. The knobs that are active appear in `details.rankingKnobs`.

| Variable                             | Default     | Effect                                    |
| ------------------------------------ | ----------- | ----------------------------------------- |
| `PI_SMARTREAD_GREP_RANK_TEST_DEMOTE` | `0.7`       | Score multiplier for test, spec, fixture and `__tests__` paths and all `*.md` files. Set `off`, `0`, `false` or `no` to disable. Any value between 0 and 1 overrides it. |
| `PI_SMARTREAD_GREP_RANK_FILENAME`    | off         | Counts path tokens as part of each document |
| `PI_SMARTREAD_GREP_RANK_BM25`        | `1.2,0.75`  | BM25 `k1,b` parameters                    |
| `PI_SMARTREAD_GREP_RANK_COVERAGE`    | off         | Boosts files that match more distinct query terms |
| `PI_SMARTREAD_GREP_RANK_STOPWORDS`   | off         | Drops common English and keyword stopwords from queries |
| `PI_SMARTREAD_GREP_RANK_STEM`        | off         | Applies Porter English stemming to query and document tokens in the natural-language BM25 channel only (identifier/exact/regex/structural channels untouched) |
| `PI_SMARTREAD_GREP_UNIT_MODE`        | `anchor`    | `symbol` returns whole enclosing functions instead of line windows |
| `PI_SMARTREAD_GREP_UNIT_MAX_PER_FILE`| `2`         | Function units per file in `symbol` mode (1–4) |
| `PI_SMARTREAD_GREP_UNIT_EXCERPT_LINES` | `12`      | Lines shown per unit in `symbol` mode     |

## Relevance judge

Turn the judge on or off with `/judge` in Pi. The choice is saved in
`~/.pi/agent/smartread-judge.json`. The standalone MCP server ignores that
file and reads only the environment.

| Variable                                | Default       | Effect                              |
| --------------------------------------- | ------------- | ----------------------------------- |
| `PI_SMARTREAD_JUDGE_MODE`               | `off`         | `off`, `local` or `cloud`. In Pi this overrides the saved setting for one process. |
| `PI_SMARTREAD_JUDGE_API_KEY`            | —             | OpenRouter key. MCP requires it. Pi otherwise uses its auth store. |
| `PI_SMARTREAD_JUDGE_MODEL`              | backend default | Model override                    |
| `PI_SMARTREAD_JUDGE_BASE_URL`           | OpenRouter    | Cloud mode accepts only OpenRouter's origin. Local mode accepts any URL and skips the sidecar. |
| `PI_SMARTREAD_JUDGE_GREP_THRESHOLD`     | `0.40`        | Minimum score for a `grep` result to be kept |
| `PI_SMARTREAD_JUDGE_MAX_UNITS`          | `40`          | Results judged per query (10–120)   |
| `PI_SMARTREAD_JUDGE_EXISTS_EVIDENCE`    | count mode    | `excerpts` shows the judge code excerpts when it decides whether an answer exists |
| `PI_SMARTREAD_JUDGE_EXISTS_THRESHOLD`   | `0.35`        | Below this, `grep` abstains instead of returning weak results. The default applies in both modes. This variable changes it in excerpt mode only. |
| `PI_SMARTREAD_JUDGE_EXISTS_EXCERPT_COUNT` | `6`         | Excerpts shown in excerpt mode (5–8) |
| `PI_SMARTREAD_JUDGE_EXISTS_EXCERPT_LINES` | `12`        | Lines per excerpt (4–24)            |
| `PI_SMARTREAD_JUDGE_CACHE_MAX_AGE_DAYS` | `7`           | How long verdicts stay in the cache |

A value that is invalid or out of range falls back to the default.

Verdicts are cached in `<workspace>/.pi-smartread/judge-cache/`. The
cache key covers the backend, endpoint, model, query, unit text and
question. It never includes keys. The local sidecar runs a pinned
`von-sdk` in a private virtual environment under `~/.pi/agent/judge/von/`.
It listens only on `127.0.0.1` and refuses requests that are too large
instead of truncating them.

The held-out results quoted in the README used excerpt mode with an exists
threshold of 0.04. That differs from the shipped defaults above. The setup
is recorded in [the decision log](plans/2026-10-06-decision-log.md) as D69
and D70.

## Output guard and bash hints

| Variable                                     | Default | Effect                          |
| -------------------------------------------- | ------- | ------------------------------- |
| `PI_SMARTREAD_BASH_CONTEXT_GUARD`            | on      | Set to `0` to disable the guard. |
| `PI_SMARTREAD_BASH_CONTEXT_GUARD_MAX_LINES`  | `2000`  | Output longer than this is trimmed |
| `PI_SMARTREAD_BASH_CONTEXT_GUARD_MAX_BYTES`  | `51200` | Output larger than this is trimmed |
| `PI_SMARTREAD_BASH_CONTEXT_GUARD_HEAD_LINES` | `80`    | Lines kept from the start       |
| `PI_SMARTREAD_BASH_CONTEXT_GUARD_TAIL_LINES` | `120`   | Lines kept from the end         |
| `PI_SMARTREAD_BASH_MISUSE_HINTS`             | on      | `0` or `1`. Overrides `experimental.bashMisuseHints`. |

## File watching

| Variable                        | Default   | Effect                                       |
| ------------------------------- | --------- | -------------------------------------------- |
| `FILE_WATCHER_MODE`             | `polling` | `none`, `polling`, `chokidar`, `recursive` or `non-recursive` |
| `FILE_WATCHER_POLL_INTERVAL_MS` | `1000`    | How often to poll                            |
| `FILE_WATCHER_DEBOUNCE_MS`      | `500`     | How long to wait before handling a change    |
| `FILE_WATCHER_MAX_COUNT`        | `16`      | Maximum number of watchers                   |

Polling opens the fewest file descriptors. Dependency, build, cache and
subagent directories are never watched.

## Diagnostics and performance

| Variable                    | Effect                                                    |
| --------------------------- | --------------------------------------------------------- |
| `PI_SMARTREAD_DIAGNOSTICS`  | Samples resource use to `.pi-smartread/diagnostics-<pid>.ndjson` |
| `PI_SMARTREAD_CONCURRENCY`  | Fixes the worker concurrency, from 1 to 128, instead of choosing it automatically |

## Language servers

Language-server settings are stored per user, not per repository:

- `~/.pi/agent/language-intelligence.json` holds overrides and
  auto-install settings.
- `~/.pi/agent/language-intelligence/trust.json` lists the project roots
  allowed to run their own server binaries.
- `~/.pi/agent/language-intelligence/` also holds the managed installs, in
  `packages/`, `bin/`, `locks/`, `logs/` and `runtime.lock.json`.

Change these with the `/lsp` command rather than by editing the files. See
[Language servers](../README.md#language-servers).
