# SPEC: inspect v4 + wrapped grep

## 1.1 Tool: `inspect` (redesigned)

### Description (actual text)
```
Inspect a file or directory to understand code structure and quality.
- Pass a directory to get a ranked repository map with key symbols and architecture.
- Pass a file to get structural facts: callers, parent class, children, base classes,
  overrides, re-exports, plus quality signals (complexity, public API, deprecation,
  test presence, reuse breadth, recency).

Every mode returns a details.workspaceEvidence envelope (schemaVersion 3).
File mode produces weak (search-match) evidence — you must read a file before
editing it. Map mode produces no file authorization.
```

### Parameter Schema
```ts
{
  path: string,              // required: file or directory path
  signals?: string[],        // optional: subset of ["complexity","public-api","reuse","recency","tests","deprecation"]
  mapTokens?: number,        // directory mode only: 256-32768, default 4096
  focus?: string[],          // directory mode only: files/symbols to boost
  compact?: boolean,         // directory mode only: default true for directory, false for file
}
```

### Dispatch
- `statSync(path).isDirectory()` → directory mode (repo map)
- `statSync(path).isFile()` → file mode (structural facts + signals)

### Directory Mode Output (example)
```
# Repo Map — 142 files, 847 definitions (budget 4096 tokens, ~3850 used)

src/
├── index.ts
│   └── activate() — extension entry point
├── inspect.ts
│   ├── executeInspectDetails() — async dispatch
│   └── resolveMode() — input classifier
├── hook.ts
│   ├── interceptContextualRead() — read enrichment
│   └── createExtendedReadTool() — tool factory
...

## Graph Knowledge
847 concepts, 2103 relationships, 8 clusters.
Core: EvidenceResolver (47 conns), ContextGraph (42 conns)
```

### File Mode Output (example)
```
## Structural Facts: src/inspect.ts

Callers (2)
  src/index.ts:445
  src/mcp-registry.ts:56

Parent Module
  (top-level module)

Children (7 exported)
  computeInspectDetails()         L67  deprecated sync wrapper
  executeInspectDetails()         L79  async entry point
  resolveMode()                   L93  input classifier
  InspectMode                     L32  type
  InspectDetails                  L35  interface
  ComputeInspectDetailsInput      L43  interface
  mergeRanges()                   L205 internal

Base Classes / Interfaces
  (none)

Overrides
  (none)

Re-Exported By (1)
  src/inspect-tool.ts — imports executeInspectDetails

Signals
  Complexity:   High (cyclomatic 12, max 22 in executeQueryInspectDetails)
  Public API:   Yes (7 exported)
  Reuse:        Yes (4 importing files)
  Recency:      3 days ago (commit aff71c4)
  Tests:        Yes (test/unit/inspect-v3.test.ts)
  Deprecated:   No
```

### Signal Definitions + Fallbacks

| Signal | Method | Fallback | Confidence |
|--------|--------|----------|------------|
| Complexity | Tree-sitter AST walk: count if/for/while/case/&&/||/?:/catch per function | Regex keyword count | High (AST) / Low (regex) |
| Public API | TS/JS: `export` keyword. Python: `__all__` or no `_` prefix. Go: capitalized. Rust: `pub` | Assume public if no clear private marker | High / Medium (Python) |
| Reuse | ContextGraph.getFileNeighbours → count imported_by | "Unknown" | High / None |
| Recency | `git log -1 --format=%ar -- <file>` | File mtime if <1 day | High / Low |
| Tests | Naming convention: `*.test.*`, `test_*`, `*_spec.*`, `*Test.*` | "No tests found" | Medium |
| Deprecated | Regex: `@deprecated`, `#[deprecated]`, `[Obsolete]` | "No markers found" (not "Not deprecated") | Medium |

### Evidence Semantics
- **Directory mode**: `mode: "map"`, zero resources. No file authorization.
- **File mode**: `mode: "symbol"` (protocol envelope mode), `coverage: "search-match"` per referenced symbol. Patch rejects — must read. (Presentation label is "file" but protocol validator only accepts `path|query|symbol|map`.)

---

## 1.2 Tool: `grep` (wrapped)

### Description (actual text)
```
Search code for a text pattern, symbol name, or concept.
Use this as your primary tool for finding code — it handles exact matches,
symbol lookups, and conceptual queries automatically.
Example: grep('auth middleware') finds authentication code even if the
function is named validateToken.

Parameters: pattern (required), path (scope directory/file), glob (file filter),
ignoreCase, literal, contextLines. Results are ranked and deduplicated.
```

### Parameter Schema
```ts
{
  pattern: string,          // required
  path?: string,            // directory or file scope
  glob?: string,            // file filter e.g. '*.ts'
  ignoreCase?: boolean,     // default false
  literal?: boolean,        // default false
  limit?: number,           // default 20, max 100
  contextLines?: number,    // default 2
}
```

### Internal Cascade (agent never sees)
```
Layer 1: BM25 lexical — ranked by token overlap (always)
Layer 2: AST symbol match — tree-sitter name resolution (always)
    ↓ RRF fusion (k=60), deduplicate by file+symbol
If zero hits:
Layer 3: Embedding semantic (when index available)
If still zero:
Layer 4: Pass-through to upstream grep (raw text)
```

### Output Format
```
12 results for "auth middleware" (BM25 + symbol, 0.8s)

src/auth/middleware.ts  L45-L52  authenticate()
  export async function authenticate(req: Request, res: Response, next) {
    const token = req.headers.authorization?.split(' ')[1]; ...

src/auth/tokens.ts  L12-L18  validateToken()
  function validateToken(token: string): TokenPayload | null { ...

(truncated: 12 of 47, narrow search for more)
```

### Evidence Semantics
`mode: "query"` (protocol envelope mode), `coverage: "search-match"` per hit. Resources with `allowedRanges`. Patch rejects. (Presentation label is "grep" but protocol validator only accepts `path|query|symbol|map`.)

---

## 1.3 Migration: Removed Modes

- `inspect { query: "..." }` → removed. Error: "inspect no longer supports query mode. Use grep('pattern')."
- `inspect { symbol: "..." }` → removed. Symbol lookup folded into wrapped grep's AST layer.
- `inspect { action: "map" }` → replaced by `inspect { path: "some/dir" }`.
- `computeInspectDetails()` → removed entirely (no backward-compat shim).
- `read { query: "..." }` → **unchanged**. Still uses retrieveQuery() internally, still reads selected files.

---

