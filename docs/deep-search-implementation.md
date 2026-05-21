# Deep Search Implementation Plan

> **Note (2026-05-19):** Deep search shipped and was later consolidated into the unified `search` tool as `mode: "deep"`. The implementation lives in `deep-search.ts` and is invoked by `search-tool.ts` when `mode="deep"`. The `smartread_status` tool referenced below was removed.

## Source brief

This plan implements the MVP from `/Users/rhinesharar/Pi-SmartRead/tmp/deep-search-research.md`:

1. add `deep_search` with `quick` and `standard` depth;
2. fuse structural, symbol, optional semantic, and graph channels;
3. return provenance-rich markdown and follow-up suggestions;
4. add `smartread_status` for health visibility.

## Code changes

### 1. Add `deep-search.ts`

Create one module exporting:

- `createDeepSearchTool()`; ✅ Shipped
- ~~`createSmartReadStatusTool()`~~ — Removed; functionality absorbed into cross-cutting health checks
- narrow helper types for matches, provenance, depth, and scope.

The module depends on existing primitives instead of duplicating index builders:

- `createSearchTool()` for `code` and `symbols` channels;
- `createIntentReadTool()` for optional semantic file ranking;
- `findDirectImportNeighbours()` and `EdgeStore` for graph import and graph_mutate edge expansion;
- `findSrcFiles()` for bounded file discovery;
- `computeRanks()` from `scoring.ts` for deterministic RRF fusion.

### 2. Register tools

Update `mcp-registry.ts` to register the deep search tool. ✅ Shipped — `deep_search` now accessible via `search mode="deep"`.

### 3. Package metadata

Add `deep-search.ts` to `package.json.files` and `tsconfig.json.include`.

### 4. Tests

Add focused unit tests for:

- `smartread_status` summary output;
- `deep_search` validation;
- `deep_search` returning fused markdown and machine-readable details on a temporary TypeScript repository.

The tests should not require a live embedding service. The semantic channel must degrade cleanly when embedding config is missing.

## MVP algorithm

1. Validate and normalize input.
2. Discover candidate source files with `findSrcFiles()`.
3. Filter candidates by `scope`.
4. Run channels:
   - structural code search for every depth;
   - symbol search for every depth;
   - semantic `intent_read` for `standard` and `thorough` when possible;
   - graph expansion for `standard` and `thorough` using import adjacency and persisted breakage/co-change edges.
5. Parse candidate metadata from existing tool output.
6. Fuse per-channel ranks with RRF (`1 / (60 + rank)`).
7. Deduplicate matches by stable key.
8. Apply focus-file boost.
9. Optionally enrich top matches with caller counts.
10. Render markdown under the requested output budget.

## Degraded modes

The tool records non-fatal channel failures. Expected examples:

- missing embedding config for semantic channel;
- unsupported language or unavailable tree-sitter grammar;
- no callers found during relationship enrichment.

A degraded channel should not suppress useful results from other channels.

## Follow-up strategy

The markdown output must include actionable follow-ups:

- `read_files` with top file paths;
- `search` `mode="code"` for top symbols with enrichment (auto-resolves + shows callers);
- `find_symbol` for isolated symbol lookups.

This keeps the MCP response compact while giving agents exact next steps.

## Later phases

- Configurable channel weights and external reranking.
- Query-result cache keyed by query/depth/cwd/index timestamp.
- Relationship snippets from call graph and richer context graph edges.
- Background indexing only if on-demand performance becomes a proven bottleneck.
