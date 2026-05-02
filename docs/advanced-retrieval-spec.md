# Advanced Repository Retrieval Spec

**Status:** Proposed
**Related research:** `docs/advanced-retrieval-research.md`
**Target:** Pi-SmartRead TypeScript extension, with optional future MCP adapter.

## Goal

Evolve Pi-SmartRead from hybrid file retrieval into graph-aware repository context retrieval while preserving the current Pi tool surface and output guarantees.

The system should answer repository-context questions by combining:

- lexical relevance (`BM25`),
- semantic relevance (chunk embeddings),
- structural relevance (imports, definitions/references, calls, later dataflow),
- probe-derived relevance (symbols/files inferred from user intent or code prefix), and
- post-retrieval reranking tuned for compact, high-signal context.

## Non-goals

- Replace `intent_read`, `repo_map`, `search_symbols`, `resolve_symbol`, or `find_callers`.
- Convert the project into an MCP-only server.
- Require a vector database.
- Require token logprobs for default use.
- Build full TypeScript dataflow analysis in the first phase.
- Claim GraphRAG or CodeRAG parity before local evaluation proves it.

## Current integration boundary

Pi-SmartRead currently registers Pi tools through `ExtensionAPI` and `ToolDefinition` in `index.ts` and `repomap-tool.ts`. A future MCP server should wrap shared retrieval services, but the current product spec targets Pi tools first.

## User-facing behavior

### `intent_read`

`intent_read` remains the main intent-to-context tool.

Default behavior should stay backward compatible:

- `query` remains required.
- `files` or `directory` remains required and mutually exclusive.
- `topK` remains bounded by existing limits.
- Output remains framed file blocks plus `details` metadata.
- BM25-only fallback remains available when embeddings fail after config validation.

Proposed additive behavior:

1. Candidate expansion can include graph and symbol neighbours, not only direct import neighbours.
2. `details` reports which retrieval signals contributed to each result.
3. Optional reranking can change final ordering, but the pre-rerank scores remain visible.
4. Optional probe input can seed relevant symbols/files before embedding.

### `repo_map`

`repo_map` remains the orientation tool. It can later consume the shared graph service but should keep its current PageRank-ranked map behavior and import-based fallback.

### `search_symbols`, `resolve_symbol`, `find_callers`

These remain precise drill-down tools. They should become graph-service consumers over time, but their user-visible behavior should not regress.

### Future MCP adapter

A future MCP adapter can expose the same shared services to MCP clients. The adapter should be separate from the Pi extension entrypoint and should not duplicate indexing logic.

Candidate MCP tools:

| MCP tool | Backing service | Purpose |
|---|---|---|
| `code_context.search` | `intent_read` core | Hybrid + graph retrieval. |
| `code_context.map` | `repo_map` core | Repo overview. |
| `code_context.symbols` | symbol graph | Definitions/references. |
| `code_context.callers` | call graph | Caller/callee queries. |
| `code_context.impact` | graph traversal | Blast-radius style file/symbol impact. |

## Architecture

### 1. Repository Context Graph

Introduce a shared graph abstraction that can be used by `intent_read`, `repo_map`, symbol tools, and a future MCP adapter.

#### Node types

| Node | Source | Notes |
|---|---|---|
| `file` | file discovery | Absolute path plus repo-relative path. |
| `symbol` | `tags.ts`, fallback extraction | Definitions and references. |
| `function` | `callgraph.ts`, tags | TS/JS/TSX initially. |
| `chunk` | `chunking.ts` | Optional, for linking retrieval scores to graph entities. |
| `external` | imports/calls that cannot be resolved | Useful for provenance but not for file expansion. |

#### Edge types

| Edge | Source | Phase |
|---|---|---|
| `imports` / `imported_by` | current direct import resolver; import fallback in `repomap.ts` | Phase 1 |
| `defines` / `defined_in` | `tags.ts` | Phase 1 |
| `references` / `referenced_by` | `tags.ts` | Phase 1 |
| `calls` / `called_by` | `callgraph.ts` | Phase 2 |
| `same_identifier` | existing repo-map reference graph | Phase 2 |
| `dataflow` | future TypeScript analysis | Phase 4+ |

#### Requirements

- Graph construction must respect workspace boundaries and symlink escape guards.
- Graph data must be cacheable per repo and invalidated by mtime/content changes.
- Graph expansion must be bounded by caps to preserve `intent_read` latency and output limits.
- Every graph-added candidate must include provenance in details.

### 2. Probe phase

Add a probe phase before reading/embedding candidate files.

Inputs:

- required `query`,
- optional explicit file/directory candidates,
- optional future code prefix or active file context,
- optional future logprob/probe-model output.

Default probes should be deterministic and local:

1. tokenize query using the same code-aware tokenization as `scoring.ts`,
2. extract probable identifiers and file/path terms,
3. call symbol search/resolution for high-confidence terms,
4. add definition files and near neighbours within caps,
5. record all additions in `details.probing`.

Experimental probes can use a model:

- A local or configured probe model can generate missing-symbol/file hypotheses.
- Token logprob-based probing is only enabled when an upstream model or probe endpoint supplies logprobs.
- The probe output is advisory and must pass path validation and graph/symbol verification before affecting candidates.

### 3. Multi-path retrieval and ranking

The ranking stack should become explicit:

1. **Lexical path:** BM25 over whole-file bodies, using existing `bm25Scores`.
2. **Semantic path:** max chunk cosine similarity, using existing chunk embeddings.
3. **Graph path:** graph proximity from seed files/symbols and repo-map centrality.
4. **Probe path:** confidence from symbol/file probes.
5. **Fusion:** RRF over available rank lists, with missing signals handled deterministically.

Default RRF behavior should remain compatible with current BM25 + semantic fusion until graph/probe signals are enabled.

### 4. Reranking

Add a post-RRF reranking stage after broad candidate ranking and before packing.

#### Stage 1: structural reranker

Cheap and local. Inputs include:

- RRF score,
- keyword score,
- semantic score,
- graph distance to seed nodes,
- PageRank or in-degree,
- path proximity to known relevant files,
- symbol-definition match confidence.

#### Stage 2: optional neural/preference reranker

Experimental and off by default. Inputs are query + candidate chunk/file snippets. It can be implemented by:

- an OpenAI-compatible rerank endpoint,
- a local cross-encoder service,
- or a future preference-aligned reranker.

It must have:

- timeout and failure fallback,
- no secret logging,
- clear provider configuration,
- deterministic fallback to pre-rerank order,
- metadata showing `rerankingStatus` and reason.

### 5. Context packing

Packing should continue to respect `DEFAULT_MAX_BYTES` and `DEFAULT_MAX_LINES`.

Enhancements:

- preserve highest-confidence snippets near the start of output,
- keep source attribution for every included snippet,
- include graph/probe provenance in details rather than bloating content,
- avoid dumping low-confidence context just because the model has a long context window.

## Proposed schema additions

All additions should be optional and backward compatible.

```ts
{
  query: string;
  files?: Array<{ path: string; offset?: number; limit?: number }>;
  directory?: string;
  topK?: number;
  stopOnError?: boolean;

  retrieval?: {
    graph?: "off" | "imports" | "symbols" | "calls" | "auto";
    probing?: "off" | "symbols" | "model" | "auto";
    rerank?: "off" | "structural" | "external" | "auto";
    maxGraphAdded?: number;
    maxProbeAdded?: number;
    maxRerankCandidates?: number;
  };

  context?: {
    activeFile?: string;
    prefix?: string;
    mentionedSymbols?: string[];
  };
}
```

If the schema surface feels too large, start with config-level feature flags and expose only metadata. Do not add public parameters until tests and defaults are stable.

## Details metadata additions

Add metadata without removing current fields. Current `graphAugmentation` already reports `addedPaths`, `candidateCountBefore`, and `candidateCountAfter`; the edge-level fields below are additive.

```ts
{
  graphAugmentation: {
    addedPaths: string[];
    candidateCountBefore: number;
    candidateCountAfter: number;
    edgesUsed?: Array<{
      from: string;
      to: string;
      type: "imports" | "references" | "calls" | "dataflow";
      confidence: number;
    }>;
  };
  probing?: {
    status: "off" | "ok" | "failed";
    strategy: "symbols" | "model" | "logprob";
    inferredSymbols: string[];
    addedPaths: string[];
    warnings: string[];
  };
  reranking?: {
    status: "off" | "ok" | "failed_fallback";
    strategy: "structural" | "external";
    candidateCount: number;
    changedOrder: boolean;
    error?: string;
  };
  rankingSignals: {
    bm25: true;
    embeddings: boolean;
    graph?: boolean;
    probing?: boolean;
    reranker?: boolean;
  };
}
```

## Quality attributes

### Correctness

- Path validation and workspace containment rules must match existing `intent_read` safeguards.
- Graph neighbours must be real files inside the workspace.
- Generated/model probe suggestions must be verified before use.
- Ranking must be deterministic under equal scores.

### Performance

- Default `intent_read` must remain fast for small candidate sets.
- Full call graph/dataflow indexing must not run on every request unless cached.
- Feature caps must bound added files and rerank candidates.
- Timeouts must degrade gracefully to existing ranking.

### Privacy and security

- Embeddings already send query/file text to the configured endpoint. Rerank/probe endpoints add the same risk and need explicit config docs.
- Do not send files to an external reranker unless the user configured that provider.
- Do not store secrets in graph/probe/reranker logs.

### Observability

Every non-default retrieval signal must be visible in `details`, including:

- which files were added,
- why they were added,
- which scores changed ordering,
- which feature failed or fell back.

## Acceptance criteria

1. Existing tests for `intent_read`, `repo_map`, symbol tools, and `find_callers` continue to pass.
2. Default `intent_read` output is backward compatible unless optional features are enabled.
3. Graph/probe/reranker additions are deterministic, capped, and reflected in metadata.
4. Documentation states that Pi-SmartRead is a Pi extension today and MCP is future adapter work.
5. Benchmarks show whether graph/probe/reranking improve local retrieval before defaults are widened.
