# ADR-001: Graph Query Surface — Param Extension vs Query Language

**Status:** Proposed
**Date:** 2026-07-16
**Deciders:** Pi-SmartRead parity design

## Context

DeusData/codebase-memory-mcp exposes a full read-only openCypher query engine (`query_graph`) with MATCH, WHERE, aggregates, variable-length paths, and EXISTS subqueries. This enables agents to ask arbitrary structural questions like "find all methods that call both X and Y" or "which functions have zero callers."

Pi-SmartRead has no graph query surface. The agent's structural questions are answered through fixed-param tools: `inspect` returns structural facts for a single file, `ContextGraph.getFileNeighbours()` expands edges programmatically, and `grep` searches text/identifiers but not graph structure.

Building a Cypher parser/executor in TypeScript is a large engineering investment (Lexer → Parser → Planner → Executor, ~3K+ lines) with ongoing maintenance burden. The agent consumer doesn't need full Cypher expressivity — it needs parameterized structural queries that are discoverable, composable, and fit within existing tool ergonomics.

## Decision

**Param-extension approach: extend `inspect` with structural-query parameters and `grep` with graph-filter parameters.** No new query language. No new tools.

### New `inspect` parameters (file + directory modes):

| Param | Type | Behavior |
|---|---|---|
| `callDepth` | number (1–5, default 1) | BFS depth for call graph traversal from symbols in target file |
| `callDirection` | "callers" \| "callees" \| "both" | Direction of call traversal (default "both") |
| `deadCode` | boolean | Return zero-caller functions in scope (file or directory) |
| `impact` | boolean | Compute blast radius: all files/symbols reachable via call+import graph from target |
| `diff` | "unstaged" \| "staged" \| "HEAD" | Map git diff to affected symbols with risk classification |
| `clusters` | boolean | Run community detection on import graph (Louvain algorithm) |
| `graphSchema` | boolean | Return graph structure summary (node/edge type counts, sample names) |
| `hotspots` | boolean | Return top-N functions by fan-in (most called) |
| `boundaries` | boolean | Detect service boundaries from package.json workspaces, docker-compose |
| `routes` | boolean | Extract HTTP route → handler mappings (file or directory mode) |
| `layers` | boolean | Derive architectural layers from import structure (directory mode only) |

### New `grep` parameters:

| Param | Type | Behavior |
|---|---|---|
| `graphFilter` | string | Filter results by graph relationship, e.g. `"CALLS->auth.login"` or `"IMPORTED_BY->src/core"` |

### New `read` parameter:

| Param | Type | Behavior |
|---|---|---|
| `symbol` | string | Resolve qualified name (e.g. `"AuthService.login"`) to file+line via LSP, then read |

### Removal of legacy param patterns:
- `inspect.impact` vs `inspect impact:true` — no flag-style params; boolean params only
- `inspect.callDirection` accepts string literal union, not boolean

## Consequences

### Positive
- Zero new tools registered. Follows the consolidation principle from the `project_tool_consolidation` memory.
- Agent discovers new capabilities as new params on tools it already knows — lower training overhead than a query language.
- Implementation piggybacks on existing `ContextGraph`, `callgraph.ts`, `LSP bridge`, `signals.ts` — no new engine.
- Parameter validation is trivial (TypeBox schema extensions — same module, same pattern as existing signals/mapTokens params).

### Negative
- Cannot express arbitrary graph queries like "functions with call depth > 3 AND no tests." Agent compensates by composing multiple tool calls (inspect → grep → inspect with callDepth).
- Parameter count on `inspect` grows from 5 to ~15. Mitigated by: most params are optional, behavior is orthogonal (callDepth is meaningful in file mode, clusters in dir mode, etc.), and TypeBox schema describes them clearly.
- Some capability gaps remain vs Cypher (variable-length path queries, predicate composition). These are low-value for agent workflows — the agent does not need ad-hoc graph analytics, it needs "who calls X," "what breaks if I change Y," "is this function dead."

### Alternatives Considered

1. **Full Cypher engine (rejected):** Too large (3K+ LoC), ongoing maintenance for edge cases, violates "extend not add" constraint, agent doesn't need expressivity.
2. **New `graph_query` tool (rejected):** Violates consolidation principle. Agent must discover and learn another tool name.
3. **Simple filter DSL string param on grep (too limited):** Rejected — would grow into ad-hoc mini-language without proper parser.
4. **gRPC/GraphQL query endpoint (rejected):** Inappropriate for Pi extension model; tools are the API surface.

## Validation

- [ ] All new params extend TypeBox schemas in existing tool files (inspect-tool.ts, grep-tool.ts, hook.ts for read)
- [ ] No new tool registrations in tool-registry.ts
- [ ] No import cycles (new compute modules are dependency-free and dependency-injected)
- [ ] Evidence envelope behavior is defined per-param in spec.md
