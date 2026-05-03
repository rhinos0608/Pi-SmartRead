# Phase 6–8 Implementation Notes

Covers the implementation of the remaining gaps from the advanced retrieval plan:
- Phase 6: External/preference reranker endpoint
- Phase 8: MCP adapter (stdio server)
- HyDE query expansion
- Retrieval benchmarks (Recall@k/MRR)
- Call graph multi-language support (Python, Go, Rust)

---

## Phase 6 — External/Preference Reranker Endpoint

**Status:** ✅ Done
**Files:** `rerank.ts`, `config.ts`, `test/unit/rerank.test.ts`

### What changed

Added an optional external reranker API that can replace or augment the local structural reranker. When configured, `intent_read` can call a remote reranking service (Cohere, Jina, or any compatible endpoint) to reorder candidates after RRF fusion.

### Config

Add to `pi-smartread.config.json`:

```json
{
  "baseUrl": "http://localhost:11434/v1",
  "model": "nomic-embed-text",
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

| Field | Default | Description |
|---|---|---|
| `baseUrl` | (required) | Reranker API base URL |
| `apiKey` | — | Bearer token for authentication |
| `model` | — | Model name (provider-specific) |
| `timeoutMs` | 10000 | Request timeout |
| `maxDocuments` | 20 | Max documents per request |

### API format

The endpoint is `{baseUrl}/rerank` (POST). Three response formats are supported:

**Cohere-style:**
```json
{
  "results": [
    { "index": 2, "relevance_score": 0.95 },
    { "index": 0, "relevance_score": 0.80 }
  ]
}
```

**Ranked indices:**
```json
{ "ranked_indices": [2, 0, 1] }
```

**Scores array:**
```json
{ "scores": [0.3, 0.9, 0.6] }
```

### Fallback behavior

If the external API fails (timeout, HTTP error, network error, unrecognized format), the system falls back to the local structural reranker. The `reranking.status` field in details reports `"ok"` or `"failed_fallback"`.

### Security

- External reranker is **off by default** — requires explicit config
- Document snippets may be sent to the external API — document this for users
- API keys are read from config or environment, never logged

### Tests (8 new)

- Cohere-style response parsing
- Scores-based response parsing
- Ranked-indices response parsing
- HTTP error handling (429, 500)
- Network error handling (ECONNREFUSED)
- Unrecognized format handling
- `rerankWithExternal` integration with successful external call
- `rerankWithExternal` fallback to structural reranker on failure

---

## Phase 8 — MCP Adapter (stdio Server)

**Status:** ✅ Done
**Files:** `mcp-server.ts`, `test/unit/mcp-server.test.ts`, `docs/mcp-quickstart.md`

### What changed

A standalone MCP stdio server that exposes SmartRead tools via the Model Context Protocol. No additional dependencies — speaks JSON-RPC 2.0 over stdin/stdout directly.

### Design decisions

- **No SDK dependency** — the MCP protocol is simple enough (JSON-RPC 2.0) that a lightweight implementation avoids pulling in the 20+ transitive dependencies of `@modelcontextprotocol/sdk`
- **Same tool implementations** — reuses `createIntentReadTool()`, `createReadManyTool()`, and `registerRepoTools()` directly; no code duplication
- **Standalone entrypoint** — `mcp-server.ts` is a separate entry point that doesn't affect the Pi extension
- **No hooks** — MCP doesn't support the first-read repo map interception; tools behave identically to their Pi extension counterparts

### Tools exposed

| MCP Tool | Maps to | Description |
|---|---|---|
| `intent_read` | `createIntentReadTool()` | Hybrid RRF retrieval |
| `read_multiple_files` | `createReadManyTool()` | Multi-file reader |
| `repo_map` | `registerRepoTools()` | Repository symbol map |
| `search_symbols` | `registerRepoTools()` | Symbol search |
| `find_callers` | `registerRepoTools()` | Call graph queries |

### Protocol support

| MCP Method | Status |
|---|---|
| `initialize` | ✅ Returns protocol version, capabilities, server info |
| `notifications/initialized` | ✅ Acknowledged (no response) |
| `tools/list` | ✅ Returns all tools with JSON Schema |
| `tools/call` | ✅ Executes tools, returns content or error |
| `ping` | ✅ Health check |

### Running

```bash
npm run mcp-server
# or
npx tsx mcp-server.ts
```

See `docs/mcp-quickstart.md` for full setup instructions for Claude Desktop, Cursor, and generic MCP clients.

### Tests (6 new)

- Initialize handshake
- Tool list with all expected tools
- Ping response
- Unknown method error
- Unknown tool call error
- Input schema validation

---

## HyDE Query Expansion

**Status:** ✅ Done
**Files:** `hyde.ts`, `intent-read.ts`, `config.ts`, `test/unit/hyde.test.ts`

### What changed

HyDE (Hypothetical Document Embeddings) generates a synthetic code document from the user's query, then embeds that document instead of the raw query. The hypothetical document is semantically closer to actual relevant code than a natural-language query.

### How it works

1. **Extract identifiers** from the query (filters stop words, numeric tokens)
2. **Detect query pattern** — function, class, config, or module
3. **Generate hypothetical code** using templates:
   - Function queries → `export function extractedName(...) { ... }`
   - Class queries → `class ExtractedName { ... }`
   - Config queries → `export const extractedConfig = { ... }`
   - Module queries → `export class ExtractedModule { ... }`
4. **Embed the hypothetical document** as the query vector
5. **Compare against file chunk embeddings** using cosine similarity

### Design: no LLM required

Unlike the original HyDE paper (which uses an LLM to generate the hypothetical document), this implementation uses deterministic templates. Benefits:
- Zero latency overhead (no extra API call)
- Deterministic and reproducible
- Works offline
- No additional cost

The template approach is effective because code queries already contain strong lexical signals (identifier names, patterns). The templates rearrange these signals into a code-like structure that embeds more similarly to actual code files.

### Config

```json
{
  "baseUrl": "http://localhost:11434/v1",
  "model": "nomic-embed-text",
  "hydeEnabled": true
}
```

Off by default. Enable via `pi-smartread.config.json` or by setting the config field.

### Integration

In `intent-read.ts`, HyDE is applied just before the embedding call:

```
Query → applyHyde() → embeddingQuery → fetchEmbeddings([embeddingQuery, ...chunks])
```

BM25 scoring still uses the original query (not the hypothetical document) because keyword matching benefits from the exact user terms.

### Observability

When HyDE is active, `details.hyde` is populated:

```json
{
  "hyde": {
    "document": "export function authentication(middleware, handler) { ... }",
    "applied": true,
    "pattern": "function",
    "identifiers": ["authentication", "middleware", "handler"]
  }
}
```

### Tests (11 new)

- Function-style document generation
- Class-style document generation
- Config-style document generation
- Module-style document generation
- Stop-word-only query returns raw query
- Empty query handling
- snake_case → camelCase conversion
- Disabled → applied=false
- Enabled with meaningful query → applied=true
- Pattern detection (function, class, config)
- Short identifiers filtered out

---

## Retrieval Benchmarks

**Status:** ✅ Done
**Files:** `test/unit/retrieval-benchmark.test.ts`

### What changed

A benchmark test suite that measures retrieval quality with standard IR metrics. Each scenario defines a query, candidate files, and ground-truth relevant files.

### Metrics

| Metric | Formula | What it measures |
|---|---|---|
| **Recall@k** | \|relevant ∩ top-k\| / \|relevant\| | Fraction of relevant files found |
| **Precision@k** | \|relevant ∩ top-k\| / k | Fraction of results that are relevant |
| **MRR** | avg(1 / rank_of_first_relevant) | How quickly the first relevant result appears |
| **NDCG@k** | DCG@k / IDCG@k | Ranking quality with position discount |

### Benchmark scenarios

| Scenario | Query | Tests |
|---|---|---|
| `lexical-exact` | "handleUserLogin" | Exact keyword match baseline |
| `lexical-partial` | "authentication middleware" | Partial keyword overlap |
| `import-neighbor` | "database connection" | Direct import dependency |
| `symbol-cross-file` | "Repository" | Cross-file symbol resolution |
| `camelCase-split` | "UserService" | Token splitting across casings |
| `noise-filtering` | "error handling retry logic" | Many irrelevant files |
| `multi-concept` | "user authentication JWT token validation" | Multiple concepts in query |

### Results (current baseline)

```
  Scenario                   Recall       MRR   Precision      NDCG
───────────────────────────────────────────────────────────────────
  lexical-exact               1.000     1.000       0.500     1.000
  lexical-partial             0.500     1.000       0.500     0.613
  import-neighbor             1.000     1.000       1.000     1.000
  symbol-cross-file           1.000     1.000       1.000     1.000
  camelCase-split             1.000     1.000       0.333     1.000
  noise-filtering             1.000     1.000       0.667     1.000
  multi-concept               1.000     1.000       0.600     0.906
───────────────────────────────────────────────────────────────────
  AVERAGE                     0.929     1.000       0.657     0.931
```

Run benchmarks with:

```bash
npx vitest run test/unit/retrieval-benchmark.test.ts
```

The aggregate summary table is printed to stdout during the test run. Use these metrics to detect regressions when modifying retrieval logic.

---

## Call Graph Multi-Language Support

**Status:** ✅ Done
**Files:** `callgraph.ts`, `package.json`, `test/unit/callgraph.test.ts`

### What changed

The call graph extraction now supports **Python, Go, and Rust** in addition to TypeScript, JavaScript, and TSX. This enables `find_callers` and call-graph-based candidate expansion for polyglot repositories.

### New dependencies

```json
{
  "tree-sitter-python": "^0.21.0",
  "tree-sitter-go": "^0.21.0",
  "tree-sitter-rust": "^0.21.0"
}
```

All pinned to 0.21.x for compatibility with the existing `tree-sitter@0.21.1`.

### Language-specific AST patterns

| Language | Function node | Call node | Call target types |
|---|---|---|---|
| TypeScript/JS | `function_declaration`, `method_definition`, `arrow_function` | `call_expression` | `identifier`, `member_expression` |
| Python | `function_definition` | `call` | `identifier`, `attribute` |
| Go | `function_declaration`, `method_declaration` | `call_expression` | `identifier`, `selector_expression` |
| Rust | `function_item` | `call_expression`, `macro_invocation` | `identifier`, `scoped_identifier`, `field_expression` |

### Key implementation details

- **Python `call` vs `call_expression`**: Python's tree-sitter grammar uses `call` as the node type for function calls, not `call_expression`. Both are now handled.
- **Python `attribute` nodes**: For `svc.get_user()`, the function field is an `attribute` node. `childForFieldName("attribute")` extracts the method name.
- **Go `selector_expression`**: For `pkg.Func()` or `obj.Method()`, the function field is a `selector_expression`. The `field` child gives the method name.
- **Rust `scoped_identifier`**: For `Module::func()`, the function field is a `scoped_identifier`. The last child is the function name.
- **Rust `field_expression`**: For `self.repo.find()`, the function field is a `field_expression`. The `field` child gives the method name.
- **Rust `macro_invocation`**: Macro calls like `println!("...")` are tracked as call edges. The macro name is extracted from the `macro` field.
- **`source_file` as root**: Python uses `module`, Go and Rust use `source_file` as the root node type. Both are recognized as top-level boundaries in `findEnclosingFunction()`.

### Tests (10 new)

- Python `findCallers` with function calls
- Python method calls via `attribute` nodes
- Go `findCallers` with function calls
- Go method calls via `selector_expression`
- Rust `findCallers` with function calls
- Rust method calls via `field_expression`
- `buildCallGraph` for Python files
- `buildCallGraph` for Go files
- `buildCallGraph` for Rust files
- Graceful handling of unsupported files (unchanged)

---

## Test Summary

| Category | New Tests | Total Tests |
|---|---|---|
| Call graph (Python/Go/Rust) | +10 | 16 |
| Retrieval benchmarks | +8 | 8 |
| External reranker | +8 | 16 |
| HyDE | +13 | 13 |
| MCP server | +6 | 6 |
| **Total new** | **+45** | — |
| **Full suite** | — | **330** |

All 330 tests pass. Typecheck clean (zero errors).
