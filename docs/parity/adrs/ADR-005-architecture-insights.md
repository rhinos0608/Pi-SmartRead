# ADR-005: Architecture Insights — HTTP Routes, Test Linkage, Clusters, Layers, Boundaries

**Status:** Proposed
**Date:** 2026-07-16
**Deciders:** Pi-SmartRead parity design

## Context

The parity target includes several architecture-level insights that Pi-SmartRead currently lacks:
- HTTP route extraction + handler mapping (Express, Fastify, Next.js, tRPC patterns)
- Test↔source linkage (which tests cover this function)
- Community detection / clustering (Louvain on import graph)
- Layer analysis (controller → service → repository)
- Cross-service boundary detection (monorepo/microservice setups)
- Hotspot detection (most-called functions by fan-in)

Pi-SmartRead has building blocks: `structural-facts.ts` (AST extraction), `signals.ts` (quality signals), `repomap-ranking.ts` (PageRank), `monorepo-detector.ts` (workspace detection), `callgraph.ts` (fan-in data). These new insights are pattern-matching extensions on the existing AST infrastructure.

## Decision

**Extend `inspect` with new params that trigger targeted analysis passes on the existing AST infrastructure.** Each insight is an independent compute module that produces structured output rendered into the inspect text. No new graph storage — all computed at query time.

### New params and compute modules

| inspect param | New module | Behavior |
|---|---|---|
| `routes` (boolean) | `src/route-extraction.ts` | AST pattern-match for Express (`app.get/post/...`), Fastify (`fastify.get/...`), Next.js (`export default function handler`/route.ts exports), tRPC router definitions. Returns `[{ method, path, file, line, handler }]`. |
| `tests` (already exists in `signals` param, but shallow) | Extended `src/signals.ts` | `signals: ["tests"]` now also does file-name matching (`.test.ts` ↔ `.ts`) + call graph overlap. Returns `[{ sourceFile, testFile, coverage: "direct"\|"indirect" }]`. |
| `clusters` (boolean) | `src/community-detection.ts` | Louvain algorithm on import graph (from ContextGraph). Returns partition map: `{clusterId → [filePaths]}` with modularity score. Directory mode only. |
| `layers` (boolean) | `src/layer-analysis.ts` | Derives layers from import patterns + naming conventions: controller/handler → service → repository/model/dao. Returns `{layer → [filePaths]}`. Directory mode only. |
| `boundaries` (boolean) | Extended `src/monorepo-detector.ts` | Detects service boundaries from package.json workspaces, docker-compose.yml, nx.json, turbo.json. Returns `[{name, rootPath, dependencies}]`. Directory mode only. |
| `hotspots` (boolean) | Uses existing `callgraph.ts` fan-in data | Top-N functions by caller count. Returns `[{name, file, line, fanIn}]`. File and directory mode. |

### Integration with inspect

All new params are orthogonal — they can be combined: `inspect { path: "src/", clusters: true, layers: true, hotspots: true }` returns a comprehensive architecture overview.

Inspect mode auto-detection (file vs directory) remains. Some params only apply in directory mode (`clusters`, `layers`, `boundaries` — they need a scope of files). Specifying them on a file target returns an error with a clear message.

### Evidence envelope behavior

All new params produce `mode: "symbol"` evidence (or `mode: "map"` for directory-mode results). Resources list affected files with `coverage: "search-match"` — same as existing structural facts and signals.

## Consequences

### Positive
- Five new compute modules, each focused and independently testable
- No coupling between modules — `routes` doesn't import `clusters`
- Reuses existing AST parsers (tree-sitter grammars already loaded)
- Output is plain text rendered into inspect result — agent sees architecture insight in the tool it already knows
- Evidence weak (search-match) forces agent to read files before editing, maintaining the safety invariant

### Negative
- Five new files adds to the module count (but each is small: ~150-300 LOC)
- Louvain algorithm is iterative — could be slow for very large repos (>10K files). Mitigation: run on the import graph (which is sparse — 10K files typically have ~20K edges), not the full file graph. Also, the algorithm is a well-studied O(m) per iteration implementation.
- Route extraction is pattern-based, not type-aware. Some frameworks (NestJS decorators) won't be detected. Mitigation: document known coverage; agent can supplement with manual read.

### Alternatives Considered

1. **Combine all into a single `get_architecture` tool (rejected):** Violates "extend not add" constraint. The agent benefits from composable params — it can request exactly what it needs without a monolithic dump.
2. **Pre-compute and cache all architecture insights (rejected):** Stale architecture data is worse than none. The codebase changes, insights should reflect current state. Query-time computation is fast enough for agent interaction (sub-second for typical repos).
3. **Skip the less common ones (layers, boundaries) — only do routes + tests + clusters + hotspots (rejected):** All five are in the parity target. Layers and boundaries are lower priority but the compute cost is low (pattern matching and import graph analysis).

## Validation

- [ ] `inspect { routes: true, path: "src/" }` returns Express/Fastify/Next.js/tRPC route table
- [ ] `inspect { signals: ["tests"], path: "src/auth.ts" }` returns test files with coverage level
- [ ] `inspect { clusters: true, path: "src/" }` returns partition map with modularity score
- [ ] `inspect { layers: true, path: "src/" }` derives layer structure from imports
- [ ] `inspect { boundaries: true, path: "." }` detects service boundaries in monorepo
- [ ] `inspect { hotspots: true, path: "src/" }` returns top functions by fan-in
- [ ] File target + dir-only params returns clear error
- [ ] Combined params work (e.g., `{ clusters: true, layers: true, hotspots: true }`)
