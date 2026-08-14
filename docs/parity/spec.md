# Pi-SmartRead Parity Specification

> Behavioral specification for agent-facing parity with DeusData/codebase-memory-mcp.
> ADRs: [ADR-001](adrs/ADR-001-graph-query-surface.md) · [ADR-002](adrs/ADR-002-graph-persistence.md) · [ADR-003](adrs/ADR-003-file-watching.md) · [ADR-004](adrs/ADR-004-impact-analysis.md) · [ADR-005](adrs/ADR-005-architecture-insights.md)

---

## 1. Tool Schema Extensions

### 1.1 `inspect` — New Parameters

**Existing params unchanged:** `path`, `signals`, `mapTokens`, `focus`, `compact`

**New TypeBox schemas:**

```typescript
// Added to InspectV4Schema in src/inspect-tool.ts
callDepth: Type.Optional(Type.Number({
  minimum: 1, maximum: 5,
  description: "BFS call graph traversal depth (1-5, default 1). File mode."
})),
callDirection: Type.Optional(Type.Union([
  Type.Literal("callers"),
  Type.Literal("callees"),
  Type.Literal("both"),
], { description: "Call graph traversal direction. File mode." })),
deadCode: Type.Optional(Type.Boolean({
  default: false,
  description: "Return zero-caller functions in scope. File or directory mode."
})),
impact: Type.Optional(Type.Boolean({
  default: false,
  description: "Compute blast radius: files/symbols reachable via call+import graph from target."
})),
diff: Type.Optional(Type.Union([
  Type.Literal("unstaged"),
  Type.Literal("staged"),
  Type.Literal("HEAD"),
], { description: "Map git diff to affected symbols with risk classification." })),
clusters: Type.Optional(Type.Boolean({
  default: false,
  description: "Run community detection on import graph. Directory mode only."
})),
graphSchema: Type.Optional(Type.Boolean({
  default: false,
  description: "Return graph structure summary (node/edge counts, sample names)."
})),
hotspots: Type.Optional(Type.Boolean({
  default: false,
  description: "Top-N functions by fan-in. File or directory mode."
})),
boundaries: Type.Optional(Type.Boolean({
  default: false,
  description: "Detect service boundaries from monorepo config. Directory mode only."
})),
routes: Type.Optional(Type.Boolean({
  default: false,
  description: "Extract HTTP route → handler mappings. File or directory mode."
})),
layers: Type.Optional(Type.Boolean({
  default: false,
  description: "Derive architectural layers. Directory mode only."
})),
```

**Params only valid in directory mode (error if specified on file):**
`clusters`, `boundaries`, `layers`

Error shape:
```
Error: inspect param "clusters" requires a directory target (got file: src/auth.ts)
```

### 1.2 `grep` — New Parameter

```typescript
graphFilter: Type.Optional(Type.String({
  description: 'Filter results by graph relationship. Format: "EDGE_TYPE->target" e.g. "CALLS->auth.login" or "IMPORTED_BY->src/core".'
})),
```

Behavior: After cascade produces hits, filter to only files/symbols that have the specified graph edge to the target. If target is a qualified symbol (contains `.`), resolve via LSP. If target is a file path, use file-level edges.

Error on invalid filter format: `Invalid graphFilter: expected "EDGE_TYPE->target" format`

### 1.3 `read` — New Parameter (in `hook.ts`)

```typescript
symbol: Type.Optional(Type.String({
  description: "Resolve qualified name (e.g. 'AuthService.login') to file+line via LSP, then read surrounding code."
})),
```

Behavior:
1. Resolve symbol via LSP bridge (`workspace/symbol` or `findReferences` + `goToDefinition`)
2. If resolved, read the file at the definition location with contextual enrichment
3. If unresolved, return error: `Symbol "ClassName.methodName" not found in workspace`
4. When `symbol` is set, `path` and `query` are ignored (symbol takes precedence)

### 1.4 `graph_mutate` — Extended Edge Types (no schema change)

Existing `relation` param already accepts `"breakage" | "co-change"` via `Type.Unsafe`. No schema change needed — the EdgeStore already stores any string. Runtime validation rejects unknown edge types.

---

## 2. Output Shapes

### 2.1 Call Graph Traversal (`callDepth` + `callDirection`)

Appended to inspect file-mode output as a new section:

```
## Call Graph (depth=3, direction=both)

outbound:
  AuthService.login()  L42
    → TokenService.issue()  L128
      → JWT.sign()  L15
    → UserRepo.findByEmail()  L200

inbound:
  AuthController.handleLogin()  L30  ← calls this
    router.post("/login")  L12
```

### 2.2 Dead Code Detection (`deadCode`)

```
## Dead Code (15 zero-caller functions)

  src/utils/deprecated.ts:
    oldFormatDate()  L34
    legacyParser()  L67

  src/views/unused.tsx:
    ArchivedBanner()  L12
    (10 more in this file)
```

Excludes: exported public API functions, entry points (`main`, `handler`, route handlers), test files.

### 2.3 Impact Analysis (`impact`)

```
## Impact Analysis: src/auth/login.ts

Risk: HIGH
  - 8 direct callers, 23 transitive callers
  - Blast radius: depth 3 (15 files, 42 symbols)
  - Entry point: yes (route handler)

Affected Files (by risk):
  CRITICAL  src/auth/session.ts            — 12 callers
  HIGH      src/auth/middleware.ts          — 8 callers
  HIGH      src/api/gateway.ts              — 7 callers
  MEDIUM    src/utils/validation.ts         — 4 callers
  LOW       test/auth/login.test.ts         — 1 caller

Affected Symbols:
  SessionManager.refresh()  (12 callers)
  AuthMiddleware.validate() (8 callers)
  ...
```

### 2.4 Git Diff Impact (`diff`)

```
## Diff Impact: unstaged changes

Changed Files (3):
  src/auth/login.ts     — 4 symbols modified
  src/auth/types.ts     — 1 symbol modified
  src/config.ts         — 0 symbols (comment only)

Risk Summary:
  CRITICAL  2 files, 5 symbols   src/auth/login.ts, src/auth/session.ts
  HIGH      3 files, 8 symbols   src/auth/middleware.ts, src/api/gateway.ts, src/utils/validation.ts
  MEDIUM    5 files              (import chain)
  LOW       2 files              test files
```

### 2.5 Community Detection (`clusters`)

```
## Community Clusters (modularity: 0.42, 6 clusters)

Cluster 0 (42 files)  — "auth"
  src/auth/login.ts, src/auth/session.ts, src/auth/middleware.ts, ...
Cluster 1 (38 files)  — "api"
  src/api/gateway.ts, src/api/routes.ts, src/api/handlers.ts, ...
Cluster 2 (21 files)  — "database"
  src/db/connection.ts, src/db/models.ts, src/db/migrations.ts, ...
...
```

### 2.6 Graph Schema (`graphSchema`)

```
## Graph Schema

Node Types (counts):
  file    127
  symbol  1,842 (function: 892, class: 124, interface: 38, type: 356, enum: 12, ...)

Edge Types (counts):
  imports    1,204
  calls      3,891
  breakage   47
  co_change  83

Sample Paths:
  src/auth/login.ts  → imports → src/db/connection.ts
  src/api/gateway.ts  → calls → src/auth/middleware.ts
  src/config.ts  → co_change → src/config.test.ts
```

### 2.7 Hotspots (`hotspots`)

```
## Hotspots (top 15 by fan-in)

  1. TokenService.issue()         src/auth/tokens.ts:42     — 87 callers
  2. UserRepo.findByEmail()       src/db/user-repo.ts:120   — 73 callers
  3. validateInput()              src/utils/validation.ts:15 — 65 callers
  4. AuthMiddleware.validate()    src/auth/middleware.ts:32  — 58 callers
  ...
```

### 2.8 Route Extraction (`routes`)

```
## HTTP Routes (23 routes)

src/auth/routes.ts:
  POST   /api/auth/login          → AuthController.login         L42
  POST   /api/auth/refresh        → AuthController.refresh       L68
  DELETE /api/auth/logout         → AuthController.logout        L91

src/api/gateway.ts:
  GET    /api/users/:id           → UserController.getById       L120
  GET    /api/users               → UserController.list          L145

Next.js API:
  src/app/api/health/route.ts     → GET handler (export)         L3
  src/pages/api/webhook.ts        → default handler (export)     L15

tRPC:
  src/server/routers/user.ts      → userRouter.getById           L22
```

### 2.9 Test Linkage (`signals: ["tests"]`, extended)

```
## Test Coverage

src/auth/login.ts:
  test/auth/login.test.ts           — direct (23 test cases)
  test/auth/integration.test.ts     — indirect (calls login via gateway)
  test/e2e/auth-flow.test.ts        — indirect (end-to-end)

src/utils/validation.ts:
  (no test coverage found)
```

### 2.10 Layer Analysis (`layers`)

```
## Architectural Layers (derived from imports)

controller (12 files):
  src/auth/routes.ts, src/api/gateway.ts, src/web/handlers.ts, ...

service (15 files):
  src/auth/service.ts, src/api/service.ts, src/billing/service.ts, ...

repository (8 files):
  src/db/user-repo.ts, src/db/session-repo.ts, src/db/audit-repo.ts, ...

model (6 files):
  src/models/user.ts, src/models/session.ts, src/models/audit.ts, ...

utility (11 files):
  src/utils/validation.ts, src/utils/formatting.ts, src/utils/crypto.ts, ...

unclassified (23 files):
  (files without clear layer assignment)
```

### 2.11 Boundaries (`boundaries`)

```
## Service Boundaries

auth (package: @acme/auth)  — src/auth/
  → depends on: database, shared
api (package: @acme/api)  — src/api/
  → depends on: auth, database, shared
database (package: @acme/db)  — src/db/
  → depends on: shared
shared (package: @acme/shared)  — src/shared/
  → depends on: (none)
```

### 2.12 Symbol Read (`read { symbol: "..." }`)

Standard read output enriched with structural context, plus a header line:

```
## Symbol: AuthService.login → src/auth/service.ts:42
```

Behavior identical to `read { path: "src/auth/service.ts", offset: 42, limit: 60 }` after resolution.

---

## 3. Evidence Envelope Behavior

### General rule

All new params in `inspect` produce the existing evidence modes:
- File-mode params: `mode: "symbol"`, `coverage: "search-match"`, resources listing affected files
- Directory-mode params: `mode: "map"`, zero resources

### Per-param evidence

| Param | Mode | Resources | Notes |
|---|---|---|---|
| `callDepth` | `symbol` | Referenced caller/callee files | search-match |
| `deadCode` | `symbol` (file) / `map` (dir) | Files containing dead functions (file mode) / Zero resources (dir mode) | Directory mode: no file authorization |
| `impact` | `symbol` | All affected files in blast radius | search-match |
| `diff` | `symbol` | Inspected file + changed files | search-match |
| `clusters` | `map` | Zero resources | Architecture insight, no file authorization |
| `graphSchema` | `map` | Zero resources | Schema introspection |
| `hotspots` | `symbol` (file) / `map` (dir) | Files (file mode) / Zero resources (dir mode) | Directory mode: no file authorization |
| `routes` | `symbol` (file) / `map` (dir) | Files (file mode) / Zero resources (dir mode) | Directory mode: no file authorization |
| `layers` | `map` | Zero resources | Architecture insight |
| `boundaries` | `map` | Zero resources | Architecture insight |
| `symbol` (read) | Strong evidence (same as normal read) | Read file | File-level authorization |

### Evidence safety

- `search-match` coverage is weak — agent must read a file before editing it. No change from existing behavior.
- Directory mode always sets `mode: "map"` with `resources: []` in the envelope, even when extra params (deadCode, hotspots, routes, diff) are set. SmartEdit sees zero authorized files for directory-mode inspections.
- File mode produces per-param resources with `coverage: "search-match"` as listed above.
- Evidence envelope building is best-effort. Failures are swallowed — the model still sees the content text.

---

## 4. Error Behavior

| Error | Trigger | Response |
|---|---|---|
| Dir-only param on file | `clusters`/`boundaries`/`layers` on file path | `Error: inspect param "X" requires a directory target (got file: <path>)` |
| Missing git repo | `diff` param but no `.git` | `Error: inspect diff requires a git repository` |
| Symbol not found | `read { symbol: "..." }` LSP miss | `Error: Symbol "X" not found in workspace` |
| Invalid graph filter | `grep { graphFilter: "bad" }` | `Error: Invalid graphFilter: expected "EDGE_TYPE->target" format` |
| Deep traversal exceeds token budget | `callDepth: 5` on very connected graph | Output truncated at mapTokens with `(truncated: N call graph edges omitted)` |
| `callDirection` without `callDepth` | `callDirection` specified but `callDepth` missing | `Error: inspect callDirection requires callDepth to be set` |
| `callDepth` on directory | directory mode | `Error: inspect callDepth requires a file target` |
| No indexing | `graphSchema` with unbuilt ContextGraph | Returns schema with `contextGraph: "not built"` notice; no crash |

---

## 5. Token Budget Behavior

### General rule

All inspect output respects the existing `mapTokens` budget. When combined params would exceed the budget:
1. Core output (structural facts, signals) always rendered first
2. Additional param output appended in order: callGraph → impact → diff → deadCode → routes → hotspots → tests → clusters → layers → boundaries → graphSchema
3. When budget exhausted, remaining sections replaced with: `## Section Name (omitted: token budget reached — rerun with higher mapTokens)`
4. Budget tracking accumulates lines rendered across all sections

### Symbol read token budget

`read { symbol: "..." }` uses the read path's limit/offset params. Default: 200 lines if neither `limit` nor `offset` specified. Same as `read { path, limit: 200 }`.

---

## 6. Mode Compatibility Matrix

| Param | File mode | Directory mode |
|---|---|---|
| `callDepth` | ✓ | error |
| `callDirection` | ✓ (requires callDepth) | error |
| `deadCode` | ✓ (file scope) | ✓ (directory scope) |
| `impact` | ✓ (from file) | ✓ (from dir slice) |
| `diff` | ✓ | ✓ |
| `clusters` | error | ✓ |
| `graphSchema` | ✓ (file scope) | ✓ (full graph) |
| `hotspots` | ✓ (file scope) | ✓ (directory scope) |
| `routes` | ✓ (single file) | ✓ (directory scan) |
| `layers` | error | ✓ |
| `boundaries` | error | ✓ |
| *Existing params* | ✓ | ✓ |

---

## 7. Implementation Modules

New dependency-free compute modules (no import cycles):

| Module | Purpose | Inputs | Output |
|---|---|---|---|
| `src/file-watcher.ts` | FS change detection | root path | dirty cache invalidation events |
| `src/impact-analysis.ts` | Blast radius + risk compute | ContextGraph, CallGraphResult, file path | ImpactResult |
| `src/community-detection.ts` | Louvain clustering | import edges from ContextGraph | ClusterResult |
| `src/route-extraction.ts` | HTTP route pattern matching | file path + AST | RouteInfo[] |
| `src/layer-analysis.ts` | Layer derivation | import edges + naming conventions | LayerMap |
| `src/graph-filter.ts` | `grep { graphFilter }` edge-based filtering | ContextGraph, grep hits, filter string | FilteredGrepHit[] |

Modified modules:

| Module | Changes |
|---|---|
| `src/inspect-tool.ts` | New param schemas, dispatch to new compute modules |
| `src/inspect.ts` | Wire new params to compute modules, render output sections |
| `src/inspect-types.ts` | Add types for new params and result shapes |
| `src/grep-tool.ts` | Add `graphFilter` param, wire to `graph-filter.ts` |
| `src/hook.ts` | Add `symbol` param to read, resolve via LSP |
| `src/index.ts` | Wire file watcher start/stop to session lifecycle |
| `src/incremental-index.ts` | Extend with per-file graph stats (symbol/edge counts) |
| `src/signals.ts` | Extend `tests` signal with file-name matching + call graph overlap |
| `src/monorepo-detector.ts` | Extend with boundary detection from workspace configs |
| `src/tool-registry.ts` | No changes (no new tools registered) |
