# Search Tool Consolidation Design

**Date:** 2026-05-03
**Status:** Approved

## Motivation

The MCP server exposes 6 tools (`intent_read`, `read_multiple_files`, `repo_map`, `search_symbols`, `find_callers`, `resolve_symbol`). Across multiple MCP servers, the cumulative tool surface area creates choice overhead for the LLM. Consolidating closely related symbol-navigation tools into a single polymorphic tool reduces that overhead and enables cross-mode enrichment.

## What changes

### Before (6 tools)

| Tool | Purpose |
|------|---------|
| `intent_read` | Semantic file retrieval (BM25 + embeddings) |
| `read_multiple_files` | Explicit file reading with packing |
| `repo_map` | Repository structure map (PageRank + tree-sitter) |
| `search_symbols` | Fuzzy symbol search by name |
| `find_callers` | Find callers of a function |
| `resolve_symbol` | Resolve symbol to definition + references |

### After (4 tools)

| Tool | Purpose |
|------|---------|
| `intent_read` | Semantic file retrieval (unchanged) |
| `read_multiple_files` | Explicit file reading (unchanged) |
| `repo_map` | Repository structure map (unchanged) |
| `search` | Consolidated symbol tool — 4 modes |

## The `search` tool

### Schema

```typescript
const SearchSchema = Type.Union([
  // mode: "symbols" — fuzzy/substring symbol search (replaces search_symbols)
  Type.Object({
    mode: Type.Literal("symbols"),
    query: Type.String({ description: "Identifier name or substring to search for" }),
    includeDefinitions: Type.Optional(Type.Boolean({ default: true })),
    includeReferences: Type.Optional(Type.Boolean({ default: true })),
    directory: Type.Optional(Type.String({})),
    maxResults: Type.Optional(Type.Number({ minimum: 1, maximum: 200 })),
  }),
  // mode: "callers" — call graph (replaces find_callers)
  Type.Object({
    mode: Type.Literal("callers"),
    function: Type.String({ description: "Function name to find callers for" }),
    directory: Type.Optional(Type.String({})),
    maxResults: Type.Optional(Type.Number({ minimum: 1, maximum: 500 })),
  }),
  // mode: "resolve" — exact symbol → def + refs + enriched callers (replaces resolve_symbol)
  Type.Object({
    mode: Type.Literal("resolve"),
    symbol: Type.String({ description: "Symbol name to resolve" }),
    context: Type.Optional(Type.String({ description: "Context file.ts:42 for disambiguation" })),
    enrich: Type.Optional(Type.Boolean({ default: true, description: "Auto-append callers (default: true)" })),
    directory: Type.Optional(Type.String({})),
    maxResults: Type.Optional(Type.Number({ minimum: 1, maximum: 200 })),
  }),
  // mode: "code" — AST-aware + semantically-ranked code search (new)
  Type.Object({
    mode: Type.Literal("code"),
    query: Type.String({ description: "Code pattern to search for" }),
    directory: Type.Optional(Type.String({})),
    filePattern: Type.Optional(Type.String({ description: "Glob filter (e.g. '*.ts')" })),
    maxResults: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
  }),
]);
```

### Common parameters

All modes support:
- `directory` — root to search (defaults to extension working directory)
- `maxResults` — result count limit (per-mode defaults and caps differ)
- `enrich` — boolean, default `true`, enables cross-mode enrichment

Using `Type.Union` with `Type.Literal` discriminants produces proper JSON Schema `oneOf`, so the LLM sees only relevant parameters per mode.

## mode: "code" — AST-aware semantic code search

### Pipeline

1. **Discovery** — Walk source files via `findSrcFiles`, respecting `.gitignore`
2. **AST extraction** — Parse each file with the appropriate tree-sitter grammar (via `grammar-loader.ts` + `tags.ts` queries) and extract all **definition AST nodes**: function declarations, class declarations, method definitions, interface/type definitions, variable declarations
3. **Chunking** — Each definition becomes a chunk with: file path, start line, end line, the full body text
4. **BM25 scoring** — Score each chunk against `query` using existing `scoring.ts` (BM25 + tokenizer)
5. **Embedding re-ranking** — If `pi-smartread.config.json` has embedding config, embed chunks and fuse with BM25 via RRF (same pipeline as `intent_read`)
6. **Return** — Top-K results as complete structural blocks (entire function/class body, not clipped line ranges)

### Why AST-aware > grep

- Returns complete structural units (whole functions, classes)
- Understands language boundaries — won't clip mid-function
- Can be extended with structured queries (e.g., "all async functions")

## Enrichment design

Two-tier: tool-level flag + config-level control.

### Tool-level flag

```
enrich: boolean  (default: true)
```

Pass `enrich: false` on any call to disable enrichment. Available across all modes.

### Config-level control (`pi-smartread.config.json`)

```json
{
  "search": {
    "enrich": {
      "resolve": {
        "callers": true
      },
      "symbols": {
        "resolution": true
      },
      "code": {
        "symbols": true
      }
    }
  }
}
```

| Mode | Enrichment | Config key | Default |
|------|-----------|------------|---------|
| `resolve` | Auto-append callers to resolved symbol | `search.enrich.resolve.callers` | `true` |
| `symbols` | Auto-resolve the top result | `search.enrich.symbols.resolution` | `true` |
| `code` | Tag results with symbol metadata | `search.enrich.code.symbols` | `true` |

## Integration opportunities (post-consolidation)

- **Warm embeddings** — `mode: "code"` and `intent_read` share the embedding cache
- **Rich responses** — a `search mode: "resolve"` call can return: the symbol definition + references + caller graph + related code snippets, all in one response
- **Lazy loading** — enrich results only when the data is cheap to compute; defer expensive ops to a warning annotation

## Removed files

The following tool creation functions in `repomap-tool.ts` and `symbol-resolver.ts` will be replaced by a single `createSearchTool` in a new `search-tool.ts`:

- `createSearchSymbolsTool` → folded into `search mode: "symbols"`
- `createFindCallersTool` → folded into `search mode: "callers"`
- `createSymbolResolverTool` → folded into `search mode: "resolve"`

The underlying implementation modules (`tags.ts`, `callgraph.ts`, `symbol-resolver.ts`, `scoring.ts`, `repomap.ts`, `file-discovery.ts`) remain unchanged — the `search-tool.ts` module orchestrates them.
