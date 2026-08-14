# Deep Search Specification

> **Note (2026-05-19):** The standalone `deep_search` tool has been consolidated into the unified `search` tool as `mode: "deep"`. The channel architecture and ranking model described below remain accurate, but the tool is now accessed via `search` with `mode: "deep"`.

## Goal

Deep search gives agents one query-driven entry point for repository investigation. It orchestrates existing Pi-SmartRead retrieval primitives, fuses their evidence, and returns ranked matches with provenance and follow-up actions.

It is the workflow layer an agent calls first when it needs a coherent answer to a natural-language codebase question.

## User experience

A caller provides a question such as `how does auth middleware work?` and receives:

- ranked, deduplicated matches across files and symbols;
- evidence for why each match was selected;
- optional relationship hints for top matches;
- safe follow-up suggestions using existing SmartRead tools.

## Tool contract

### Input

| Field | Type | Default | Bounds | Description |
|---|---:|---:|---:|---|
| `query` | string | required | 1-500 chars | Natural-language question or code symbol. (In the unified `search` tool, `mode` must be set to `"deep"`.) |
| `depth` | `quick \| standard \| thorough` | `standard` | enum | Controls orchestration cost and relationship enrichment. |
| `scope` | `code \| docs \| tests \| all` | `all` | enum | Filters discovered files by content type. |
| `directory` | string | working directory | path | Root directory to search. |
| `folder` | string | working directory | path | Alias for `directory`. |
| `limit` | number | `15` | 1-50 | Maximum fused matches to return. |
| `maxSnippetChars` | number | `400` | 100-1000 | Maximum snippet length per match. |
| `outputBudget` | number | `4096` | 1024-16384 | Approximate token budget for returned markdown. |
| `includeRelationships` | boolean | `false` (`true` for `thorough`) | boolean | Include caller/relationship hints for top matches. |
| `rerank` | boolean | `false` | boolean | Reserved for configured rankers in a later phase. |

### Output

The tool returns markdown:

1. title and search metadata;
2. `Matches` grouped by ranked item;
3. optional `Relationships` section;
4. `Summary` with channels used, files inspected, and elapsed time;
5. `Follow-ups` with concrete calls to `read_files`, `search`, and `find_symbol`.

The returned result also includes machine-readable `details` with matches, channel counts, files inspected, and degraded-mode notes.

## Ranking model

`deep_search` produces candidates from five channel groups:

- **grep/text channel**: exact text retrieval across searchable files, including docs;
- **structural/code channel**: AST/BM25/embedding definition search;
- **semantic/file channel**: `intent_read` file-level hybrid retrieval when embedding config is available;
- **symbol channel**: exact or fuzzy symbol hits;
- **graph channel**: bounded import adjacency plus persisted `graph_mutate` breakage/co-change edges from files found by earlier channels.

MVP fusion uses reciprocal rank fusion (RRF) across candidate channel ranks with `k=60`, then applies a small focus-file boost. Candidates deduplicate by `file + line + name`, falling back to `file + name`.

## Depth modes

| Depth | Channels | Relationship enrichment | Target latency |
|---|---|---|---:|
| `quick` | grep + AST structural + symbol | none | <3s on medium repos |
| `standard` | grep + AST structural + symbol + semantic fallback + graph | caller count for top matches when requested | <6s |
| `thorough` | all available channels, including grep, AST structural, semantic, symbol, graph, and LSP | caller lookups for top matches | <10s |

All expensive phases are best-effort. A failed channel is recorded in `details.degraded` and does not fail the entire search unless no channel can produce output.

## Supporting tool: `smartread_status` (removed)

`smartread_status` was a lightweight health check for agents. It reported:

- working directory;
- source file count;
- embedding configuration status;
- known cache directories;
- registered tool health notes.

**Deprecated/unavailable:** The tool was removed in a later consolidation; health visibility is now covered by cross-cutting health checks. Do not rely on `smartread_status` in current usage.

## Non-goals for MVP

- No background watcher or daemon.
- No persisted fused-result cache.
- No mandatory embedding configuration.
- No schema migration or public removal of existing tools.
