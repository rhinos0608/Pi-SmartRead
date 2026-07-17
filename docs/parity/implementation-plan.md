# Pi-SmartRead Parity Implementation Plan

> Based on: [spec.md](spec.md), [ADR-001](adrs/ADR-001-graph-query-surface.md) through [ADR-005](adrs/ADR-005-architecture-insights.md)
> Target: 12-item parity definition of done from [capability matrix](capability-matrix.md)

---

## Wave Overview

```
Wave 1 (parallel)          Wave 2 (serial, needs W1)     Wave 3 (needs W2)     Wave 4 (needs W3)
+-----------------+       +----------------------+      +--------------+      +--------------+
| WP-1: Watcher   |--+    | WP-4: Inspect Wiring  +----->| WP-5: Integr. +----->| WP-6: Tests  |
+-----------------+  |    |  - inspect-tool.ts    |      |  - index.ts   |      |  + verify    |
| WP-2: Impact    |  |    |  - inspect.ts         |      |  - hook.ts    |      +--------------+
|  + Graph Filter |  |    |  - inspect-types.ts   |      |  - typecheck  |
+-----------------+  |    |  - hook.ts (symbol)   |      |  - evidence   |
| WP-3: Arch      |  |    +----------------------+      +--------------+
|  Insights       |  |
+-----------------+  |
| WP-7: Scoring   |  |
|  Signals        |  |
+-----------------+  |
| WP-8: ADR       |  |
|  Ranking        |  |
+-----------------+  |
                     +--- WP-4 references watcher API
                          and compute modules from W1
```

---

## Work Packages

### WP-1: File Watcher

**Wave:** 1 — Parallel with WP-2, WP-3, WP-7, WP-8
**Scope:** Real-time FS change detection with debounced cache invalidation
**ADR:** ADR-003

**Files to CREATE:**
- `src/file-watcher.ts` (~150 LOC)
  - `startWatching(root: string, onDirty: (paths: string[]) => void): () => void`
  - Uses `fs.watch(root, { recursive: true })` on macOS/Windows
  - Falls back to non-recursive on Linux with console.warn
  - Optional chokidar detection: `try { require("chokidar") } catch {}`
  - Debounce: 500ms window, collect paths, emit once
  - Returns stop function (calls `.close()` on all FSWatcher handles)
  - Test-mode detection: `process.env.VITEST || process.env.NODE_ENV === "test"` → no-op watcher (prevents FD leaks during test runs)

**Files to MODIFY:**
- `src/index.ts` — lines near session_start/shutdown hooks:
  - Call `startWatching(ctx.cwd, onDirty)` at session start
  - `onDirty` callback: invalidate FS scan cache (`invalidateFsScanCache` already imported), mark ContextGraph as dirty (set a flag on a session-scoped object), invalidate SemanticIndex file states for affected paths
  - Call stop function in `session_shutdown` handler
  - Store watcher stop handle in extension activation scope

**Dependencies:** None (Wave 1 independence)
**Tests:** `test/unit/file-watcher.test.ts` — mock fs.watch, verify debounce, verify stop, verify test-mode no-op

---

### WP-2: Impact Analysis + Graph Filter

**Wave:** 1 — Parallel with WP-1, WP-3, WP-7, WP-8
**Scope:** Blast radius computation, risk classification, grep graph filter schema + standalone `applyGraphFilter()` function
**ADR:** ADR-001, ADR-004

**Files to CREATE:**
- `src/impact-analysis.ts` (~250 LOC)
  - `computeImpact(params): ImpactResult`
  - BFS from target file through call+import graph (uses `ContextGraph.getFileNeighbours()` for file-level neighbor expansion; `ContextGraph.findSymbolFiles()` for symbol→file resolution; `ContextGraph.getMutationNeighbours()` for breakage/co-change edges)
  - Risk classification: PageRank + fan-in + blast radius depth
  - Returns `{ risk, affectedFiles[], affectedSymbols[], blastRadiusDepth, callGraphSummary }`
  - Also exports `detectDeadCode(fileOrDir, contextGraph, callGraph): DeadCodeResult`
- `src/graph-filter.ts` (~80 LOC)
  - `applyGraphFilter(hits: GrepHit[], filter: string, contextGraph: ContextGraph): GrepHit[]`
  - Parses `"EDGE_TYPE->target"` format
  - For each hit, checks if a graph edge exists from the hit file to the target
  - Returns filtered hits array

**Files to MODIFY:**
- `src/grep-tool.ts`:
  - **WP-2 boundary: only add `graphFilter` to `GrepSchema` (TypeBox Optional String).**
  - **Do NOT edit `GrepToolOptions` interface or `execute()` wiring — that is WP-5's sole responsibility.**
  - `applyGraphFilter()` is a standalone dependency-free function in `src/graph-filter.ts`; WP-2 does not wire it into grep-tool.ts execution path.

**Dependencies:** None (Wave 1 independence — graph-filter.ts is dependency-free; grep-tool.ts schema-only edit requires no runtime ContextGraph import)
**Tests:**
- `test/unit/impact-analysis.test.ts` — BFS traversal, risk classification, dead code detection with fixture data
- `test/unit/graph-filter.test.ts` — filter parsing, edge matching, error cases
- Extend `test/unit/grep-tool.test.ts` — add `graphFilter` param schema test cases

---

### WP-3: Architecture Insights

**Wave:** 1 — Parallel with WP-1, WP-2, WP-7, WP-8
**Scope:** HTTP route extraction, community detection, layer analysis, boundary detection, test linkage, incremental index extension
**ADR:** ADR-001, ADR-005

**Files to CREATE:**
- `src/route-extraction.ts` (~200 LOC)
  - `extractRoutes(filePath: string): RouteInfo[]`
  - Pattern matching via tree-sitter AST for:
    - Express: `app.get/post/put/delete/patch(path, handler)`
    - Fastify: `fastify.get/post/...(...)`
    - Next.js App Router: `export async function GET/POST/...` in route.ts files
    - Next.js Pages Router: `export default function handler` in pages/api/
    - tRPC: `.query()`, `.mutation()` on router definitions
  - `scanRoutes(dirPath: string): RouteInfo[]` — recursive directory scan
- `src/community-detection.ts` (~200 LOC)
  - `detectCommunities(importEdges: Array<{from, to}>): ClusterResult`
  - Louvain algorithm: initialize each node as its own community → local moving phase → aggregation → repeat
  - Returns `{ clusters: Map<number, string[]>, modularity: number }`
  - Lightweight implementation (~150 LOC for the algorithm core)
- `src/layer-analysis.ts` (~120 LOC)
  - `deriveLayers(importEdges, filePaths: string[]): LayerMap`
  - Heuristic: controller/handler files have route registrations or export handlers; service files have `.service.` or `Service` in name; repository files import DB/ORM adapters; model files export interfaces/types/schemas
  - Returns `{ layers: Map<string, string[]>, unclassified: string[] }`

**Files to MODIFY:**
- `src/signals.ts`:
  - Extend `tests` signal: when computing `signals: ["tests"]`, also do:
    - File-name matching: for `src/auth/login.ts`, look for `test/auth/login.test.ts`, `src/auth/__tests__/login.test.ts`, `test/auth/login.spec.ts`
    - Call graph overlap: check if test files import from the source file's module
    - Return `{ sourceFile, testFile, coverage: "direct" | "indirect" }`
- `src/monorepo-detector.ts`:
  - Extend `detectMonorepo` to also detect service boundaries:
    - Parse `package.json` workspaces → service names + root paths
    - Parse `docker-compose.yml` → service names
    - Parse `nx.json` / `turbo.json` → project names
    - Build dependency graph from `package.json` dependencies between workspace packages
    - Export `detectServiceBoundaries(root): BoundaryResult`
- `src/incremental-index.ts`:
  - Extend `IncrementalIndex` metadata to store per-file `{ symbolCount, edgeCount }` alongside hash
  - `diff()` returns per-file graph stats diff, not just hash changes
  - Backward-compatible — old `file-hashes.json` without these fields treated as "unknown, needs rebuild"

**Dependencies:** None (Wave 1 independence — all new modules are self-contained)
**Tests:**
- `test/unit/route-extraction.test.ts` — Express, Fastify, Next.js, tRPC patterns
- `test/unit/community-detection.test.ts` — algorithm correctness on known graphs
- `test/unit/layer-analysis.test.ts` — layer classification accuracy
- Extend `test/unit/signals.test.ts` — test linkage
- Extend `test/unit/incremental-index.test.ts` — per-file graph stats
- Extend `test/unit/monorepo-detector.test.ts` — boundary detection

---

### WP-7: Multi-Signal Scoring Expansion

**Wave:** 1 — Parallel with WP-1, WP-2, WP-3, WP-8
**Scope:** Add Halstead-lite complexity, AST-profile, and MinHash-proximity signals to the existing reranker. New signal computation lives in dependency-free modules; wired into `src/rerank.ts`.
**ADR:** N/A (coverage matrix item 11)

**Definition of Done item covered:** "Multi-signal scoring includes complexity, AST profile, proximity"

**Files to CREATE:**
- `src/complexity-signals.ts` (~150 LOC)
  - `computeHalsteadLite(ast: ASTNode): { operandCount, operatorCount, vocabulary, volume }` — lightweight Halstead metrics from tree-sitter AST (operand/operator count, vocabulary size, difficulty approximation)
  - `computeAstProfile(ast: ASTNode): { depth, branchingFactor, cyclomaticComplexity, nodeCount }` — structural profile: max nesting depth, average branching factor, cyclomatic complexity, total AST node count
  - `computeMinHashProximity(sourceAst: ASTNode, candidateAst: ASTNode): number` — MinHash-based structural similarity score (0.0–1.0) using shingle sets of AST node type sequences; used for near-clone proximity ranking
  - All functions are pure, dependency-free, take AST input and return numeric scores

**Files to MODIFY:**
- `src/rerank.ts`:
  - Extend `RerankerInput` (already has `pageRank`, `graphDistance`, `temporalScore` fields at lines 11–21) with three new optional fields: `halsteadComplexity?: number`, `astProfile?: number`, `minHashProximity?: number`
  - Import and call `complexity-signals.ts` functions to compute new signal values from the AST of each candidate file
  - Add new signals to the scoring formula in `rerank()` with tunable weights (additive, backward-compatible — zero-value defaults preserve existing ranking when signals absent)
- `src/scoring.ts` (alternative/extension point):
  - If scoring.ts owns the weight configuration, extend the weight map to include the three new signal keys with default weight 0 (no-op until configured)
  - Must not break existing signal consumption by inspect's file mode

**Contracts:**
- `complexity-signals.ts` exports are pure functions with no side effects
- `RerankerInput` remains backward-compatible: new fields optional, zero default = no ranking change
- Existing `rerank()` output shape unchanged — only ranking order may shift when new signals present

**File overlap verification:** `src/rerank.ts` is NOT touched by WP-1, WP-2, or WP-3. `src/scoring.ts` is NOT touched by WP-1, WP-2, or WP-3. No wave-1 collision.

**Test requirements:**
- `test/unit/complexity-signals.test.ts` — Halstead-lite on known ASTs, AST profile correctness, MinHash proximity for identical/similar/different ASTs
- Extend `test/unit/inspect-v4.test.ts` or dedicated rerank test — verify new signals affect ranking order, verify backward-compatible zero-signal behavior

**Acceptance criteria:**
1. `computeHalsteadLite()` returns correct metrics for a fixture AST with known operator/operand counts
2. `computeAstProfile()` returns correct depth, branching, cyclomatic complexity for nested/branching fixture code
3. `computeMinHashProximity()` returns 1.0 for identical ASTs, >0.5 for similar structures, <0.2 for dissimilar
4. `rerank()` with zeroed new signals produces identical ranking to baseline (no regression)
5. `rerank()` with populated new signals re-ranks candidates — higher complexity penalized, higher proximity boosted

---

### WP-8: ADR Retrieval Integration

**Wave:** 1 — Parallel with WP-1, WP-2, WP-3, WP-7
**Scope:** Cross-session ADRs feed retrieval ranking as boost signals in `src/intent-read.ts`. Reads `AdrRecord` from `src/adr-store.ts` (with `status` and `tags` fields) and applies ranking boosts.
**ADR:** N/A (coverage matrix item 12)

**Definition of Done item covered:** "Cross-session ADRs feed into retrieval ranking"

**Files to MODIFY:**
- `src/intent-read.ts`:
  - Import `AdrRecord` type and `listAdrs` (or equivalent read accessor) from `src/adr-store.ts`
  - After initial retrieval ranking (BM25/embedding scores), apply ADR-based boost: for each candidate file, check if any ADR references it (by path or symbol in `AdrRecord.tags` or body). Matching ADRs with `status: "accepted"` apply a configurable boost multiplier; `status: "proposed"` or `status: "deprecated"` apply no boost or a penalty.
  - Boost is additive to existing score — does not replace or override retrieval ranking
  - Guard: if ADR store is empty or unavailable, skip boost (zero overhead)
- `src/adr-store.ts`:
  - Export `listAdrs(filter?: { status?: string, tags?: string[] }): AdrRecord[]` if not already exported (verify existing API surface)
  - No schema changes — `AdrRecord` already has `status` and `tags` fields

**Contracts:**
- ADR boost is purely additive — retrieval ranking without ADRs produces identical results
- `listAdrs()` is called once per retrieval query, result cached for query duration
- No import cycles: `adr-store.ts` does not import from `intent-read.ts`; `intent-read.ts` imports from `adr-store.ts` (unidirectional)

**File overlap verification:** `src/intent-read.ts` is NOT touched by WP-1, WP-2, WP-3, or WP-7. `src/adr-store.ts` is NOT touched by WP-1, WP-2, WP-3, or WP-7. No wave-1 collision.

**Test requirements:**
- `test/unit/intent-read.test.ts` (extend) — verify ADR boost re-ranks candidates, verify no boost when ADR store empty, verify accepted-only boost filtering
- `test/unit/adr-store.test.ts` (extend) — verify `listAdrs()` filter behavior if new accessor added

**Acceptance criteria:**
1. Retrieval query with no ADRs returns identical ranking to baseline
2. Retrieval query with ADRs containing matching paths/symbols shows boosted rankings for those candidates
3. Only `status: "accepted"` ADRs produce boost; `proposed`/`deprecated` produce no boost
4. No import cycle between `adr-store.ts` and `intent-read.ts`

---

### WP-4: Inspect Param Wiring + Symbol Read

**Wave:** 2 — Depends on WP-2, WP-3 (needs compute modules available)
**Scope:** Wire all new inspect params to their compute modules, add `symbol` param to read, render output sections
**ADR:** ADR-001, ADR-004, ADR-005

**Inspect DI ownership:** WP-4 extends `InspectV4Input` (src/inspect-types.ts) with an optional `contextGraph?: ContextGraph` field. This is the type-level contract. WP-5 is responsible for populating this field from `inspect-tool.ts` options at runtime.

**Files to MODIFY:**
- `src/inspect-types.ts`:
  - Add `CallDirection`, `DiffTarget` types
  - Extend `InspectV4Input` with all new optional params **and add `contextGraph?: ContextGraph`** (import ContextGraph type only — no runtime dependency)
  - Add `ImpactResult`, `DeadCodeResult`, `ClusterResult`, `RouteInfo`, `LayerMap`, `BoundaryResult` type imports/exports
  - Add `GraphSchemaResult` type
- `src/inspect-tool.ts`:
  - Extend `InspectV4Schema` with all new TypeBox schemas (see spec §1.1)
  - Add dir-only param validation in `execute()`: if mode is "file" and params contain `clusters`/`boundaries`/`layers`, throw with descriptive error
  - Wire `params.symbol` to read-tool redirect (intercept early, redirect to read tool execution path)
  - Pass new params through to `executeInspectV4()` via extended `InspectV4Input`
- `src/inspect.ts`:
  - `executeFileInspect()`: call compute modules for enabled params (impact, deadCode, callDepth, hotspots, routes, graphSchema), append output sections to content text
  - `executeDirectoryInspect()`: call compute modules for enabled params (clusters, layers, boundaries, deadCode, hotspots, routes), append output sections
  - Token budget tracking: accumulate rendered line count, stop appending sections when budget exceeded
  - Evidence envelope: add resources for affected files when impact/deadCode/routes params active
  - Import new compute modules (impact-analysis.ts, community-detection.ts, route-extraction.ts, layer-analysis.ts) — these are dependency-free, no cycle risk
  - Use `input.contextGraph` (populated by WP-5) when available for graph-dependent operations; gracefully degrade to no-graph behavior when absent
- `src/hook.ts`:
  - Add `symbol` param to read tool schema (TypeBox Optional String)
  - In execute: if `params.symbol`, resolve via `resolveSymbolFromLSP(params.symbol)` → if found, set `params.path` to resolved file, set `params.offset` to resolved line - 5, set `params.limit` to contextLines. If not found, throw error.
  - Import LSP bridge symbol resolution (already available as `getLSPBridge()` is imported in index.ts — hook.ts would need access)
  - For import-cycle safety: LSP bridge resolution function must be dependency-injected, not imported directly. Use same pattern as resolver — pass `getLSPClient` in the read tool options.

**Dependencies:** WP-2 (impact-analysis.ts, graph-filter.ts), WP-3 (route-extraction.ts, community-detection.ts, layer-analysis.ts, monorepo-detector.ts, signals.ts extension)
**Tests:**
- Extend `test/unit/inspect-v4.test.ts` — new params, dir-only error, combined params, token budget truncation
- Extend `test/unit/hook.test.ts` — symbol param resolution (watch for known flake: "before_agent_start returns system prompt with repo map" — avoid adding assertions that touch that path)
- `test/unit/inspect-enrichment.test.ts` — verify evidence envelope resources for new params

---

### WP-5: Integration Wiring

**Wave:** 3 — Depends on WP-4 (needs complete inspect/hook changes)
**Scope:** Wire everything together in index.ts, typecheck pass, evidence envelope validation
**ADR:** All ADRs

**grep-tool.ts ownership:** WP-5 adds `contextGraph?: ContextGraph` to the `GrepToolOptions` interface and wires it into `execute()` so that `applyGraphFilter()` (created by WP-2 in `src/graph-filter.ts`) can be called when `params.graphFilter` is present. WP-2 must NOT have edited `GrepToolOptions` or `execute()` — this is WP-5's sole responsibility for grep-tool.ts runtime wiring.

**inspect-tool.ts ownership:** WP-5 populates the `contextGraph` field on `InspectV4Input` (type extended by WP-4) by reading it from `InspectToolOptions` and threading it through to `executeInspectV4()`. WP-4 defined the type contract; WP-5 implements the runtime wiring.

**Files to MODIFY:**
- `src/index.ts`:
  - Wire `ContextGraph` instance into inspect tool options (needed for impact analysis, graph filter, graph schema, etc.)
  - Wire `ContextGraph` instance into grep tool options (needed for graphFilter)
  - Wire LSP bridge symbol resolution into read tool options (needed for symbol param)
  - Wire file watcher start/stop to session lifecycle (from WP-1)
  - Ensure import cycle safety: ContextGraph and LSP bridge are already available in index.ts scope; pass them as function parameters, don't import them into hook.ts or inspect.ts
- `src/mcp-registry.ts`:
  - `buildInspectToolForExtension()` already passes resolver and session file path; extend to pass ContextGraph instance
  - `createGrepTool()` already passes resolver; extend to pass ContextGraph instance
- `src/grep-tool.ts`:
  - Add `contextGraph?: ContextGraph` to `GrepToolOptions` interface (WP-2 did NOT edit this interface — schema-only boundary)
  - In `execute()`, when `params.graphFilter` is present and `options.contextGraph` is available, call `applyGraphFilter(hits, params.graphFilter, options.contextGraph)` after the glob filter step
  - When `graphFilter` specified but no ContextGraph available: return error `"graphFilter requires an indexed context graph"`
- `src/inspect-tool.ts`:
  - Add `contextGraph?: ContextGraph` to `InspectToolOptions`
  - In `execute()`, populate `input.contextGraph = options.contextGraph` before passing to `executeInspectV4()`

**Typecheck:** Run `npx tsc --noEmit` and fix all errors before considering this package done.

**Dependencies:** WP-1 (file-watcher.ts), WP-2 (impact-analysis.ts, graph-filter.ts), WP-3 (route-extraction.ts, community-detection.ts, layer-analysis.ts, monorepo-detector.ts), WP-4 (inspect.ts, inspect-tool.ts, inspect-types.ts, hook.ts changes)
**Tests:** No new tests — integration covered by extended existing tests from WP-4 and WP-6.

---

### WP-6: Tests + Verification

**Wave:** 4 — Depends on WP-5 (needs full integration working)
**Scope:** Unit tests for all new modules, integration tests, typecheck, smoke tests
**ADR:** All ADRs

**Activities:**

1. **Run existing test suite** to establish baseline:
   ```bash
   npx vitest run
   ```
   Known flake: `hook.test.ts` "before_agent_start returns system prompt with repo map" — not a regression signal.

2. **Unit tests for new modules** (if not already created in their WPs):
   - `test/unit/file-watcher.test.ts`
   - `test/unit/impact-analysis.test.ts`
   - `test/unit/graph-filter.test.ts`
   - `test/unit/route-extraction.test.ts`
   - `test/unit/community-detection.test.ts`
   - `test/unit/layer-analysis.test.ts`
   - `test/unit/complexity-signals.test.ts`

3. **Extended tests for modified modules** (if not already created in their WPs):
   - `test/unit/inspect-v4.test.ts` — new params
   - `test/unit/grep-tool.test.ts` — graphFilter param
   - `test/unit/hook.test.ts` — symbol param
   - `test/unit/signals.test.ts` — extended tests signal
   - `test/unit/incremental-index.test.ts` — per-file graph stats
   - `test/unit/monorepo-detector.test.ts` — boundary detection
   - `test/unit/intent-read.test.ts` — ADR boost

4. **Typecheck:**
   ```bash
   npx tsc --noEmit
   ```

5. **Full test suite:**
   ```bash
   npx vitest run
   ```

6. **Manual smoke tests** (document in `docs/parity/smoke-test-log.md`):
   - `inspect { impact: true, path: "src/index.ts" }` — returns blast radius
   - `inspect { deadCode: true, path: "src/" }` — returns zero-caller functions
   - `inspect { diff: "unstaged", path: "." }` — maps changed files
   - `inspect { callDepth: 3, callDirection: "callers", path: "src/auth.ts" }` — returns caller tree
   - `inspect { clusters: true, path: "src/" }` — returns community partition
   - `inspect { routes: true, path: "src/" }` — returns route table
   - `inspect { graphSchema: true, path: "." }` — returns schema summary
   - `inspect { hotspots: true, path: "src/" }` — returns top functions
   - `inspect { layers: true, path: "src/" }` — returns layer map
   - `inspect { boundaries: true, path: "." }` — returns service boundaries
   - `inspect { signals: ["tests"], path: "src/index.ts" }` — test linkage
   - `grep { pattern: "login", graphFilter: "CALLED_BY->AuthController" }` — graph-filtered results
   - `read { symbol: "ContextGraph.buildContextGraph" }` — symbol resolution

**Dependencies:** WP-5 (full integration)
**Tests:** This IS the test package.

---

## Dependency Graph

```
WP-1 ──┐
WP-2 ──┤
WP-3 ──┼──→ WP-4 ──→ WP-5 ──→ WP-6
WP-7 ──┤
WP-8 ──┘
```

- Wave 1 (WP-1, WP-2, WP-3, WP-7, WP-8): Fully parallel, touch disjoint files
- Wave 2 (WP-4): Needs WP-2 and WP-3 compute modules available (not necessarily tested — just files exist and types export)
- Wave 3 (WP-5): Needs WP-4 complete + WP-1 watcher
- Wave 4 (WP-6): Needs WP-5 complete (full integration)

---

## Files Changed Summary

| File | WP | Action |
|---|---|---|
| `src/file-watcher.ts` | WP-1 | CREATE |
| `src/impact-analysis.ts` | WP-2 | CREATE |
| `src/graph-filter.ts` | WP-2 | CREATE |
| `src/route-extraction.ts` | WP-3 | CREATE |
| `src/community-detection.ts` | WP-3 | CREATE |
| `src/layer-analysis.ts` | WP-3 | CREATE |
| `src/complexity-signals.ts` | WP-7 | CREATE |
| `src/inspect-types.ts` | WP-4 | MODIFY |
| `src/inspect-tool.ts` | WP-4, WP-5 | MODIFY |
| `src/inspect.ts` | WP-4 | MODIFY |
| `src/hook.ts` | WP-4 | MODIFY |
| `src/grep-tool.ts` | WP-2 (schema), WP-5 (wiring) | MODIFY |
| `src/signals.ts` | WP-3 | MODIFY |
| `src/monorepo-detector.ts` | WP-3 | MODIFY |
| `src/incremental-index.ts` | WP-3 | MODIFY |
| `src/rerank.ts` | WP-7 | MODIFY |
| `src/scoring.ts` | WP-7 (optional) | MODIFY |
| `src/intent-read.ts` | WP-8 | MODIFY |
| `src/adr-store.ts` | WP-8 (verify API) | MODIFY (if needed) |
| `src/index.ts` | WP-1, WP-5 | MODIFY |
| `src/mcp-registry.ts` | WP-5 | MODIFY |
| `test/unit/file-watcher.test.ts` | WP-1/WP-6 | CREATE |
| `test/unit/impact-analysis.test.ts` | WP-2/WP-6 | CREATE |
| `test/unit/graph-filter.test.ts` | WP-2/WP-6 | CREATE |
| `test/unit/route-extraction.test.ts` | WP-3/WP-6 | CREATE |
| `test/unit/community-detection.test.ts` | WP-3/WP-6 | CREATE |
| `test/unit/layer-analysis.test.ts` | WP-3/WP-6 | CREATE |
| `test/unit/complexity-signals.test.ts` | WP-7/WP-6 | CREATE |
| `test/unit/inspect-v4.test.ts` | WP-4/WP-6 | MODIFY |
| `test/unit/grep-tool.test.ts` | WP-2/WP-6 | MODIFY |
| `test/unit/hook.test.ts` | WP-4/WP-6 | MODIFY |
| `test/unit/signals.test.ts` | WP-3/WP-6 | MODIFY |
| `test/unit/incremental-index.test.ts` | WP-3/WP-6 | MODIFY |
| `test/unit/monorepo-detector.test.ts` | WP-3/WP-6 | MODIFY |
| `test/unit/intent-read.test.ts` | WP-8/WP-6 | MODIFY |

**No new tools registered. No changes to `@rhinos0608/pi-workspace-protocol`. No import cycles.**

---

## Wave Assignment Table

| WP | Wave | Description | Files |
|---|---|---|---|
| WP-1 | 1 | File Watcher | file-watcher.ts, index.ts |
| WP-2 | 1 | Impact Analysis + Graph Filter | impact-analysis.ts, graph-filter.ts, grep-tool.ts (schema only) |
| WP-3 | 1 | Architecture Insights | route-extraction.ts, community-detection.ts, layer-analysis.ts, signals.ts, monorepo-detector.ts, incremental-index.ts |
| WP-7 | 1 | Multi-Signal Scoring | complexity-signals.ts, rerank.ts, scoring.ts |
| WP-8 | 1 | ADR Retrieval Integration | intent-read.ts, adr-store.ts |
| WP-4 | 2 | Inspect Param Wiring | inspect-types.ts, inspect-tool.ts, inspect.ts, hook.ts |
| WP-5 | 3 | Integration Wiring | index.ts, mcp-registry.ts, grep-tool.ts (wiring), inspect-tool.ts (DI) |
| WP-6 | 4 | Tests + Verification | all test files |

### Wave-1 File Overlap Verification

All Wave-1 WPs touch disjoint file sets:
- WP-1: `file-watcher.ts`, `index.ts` (start/stop hooks only)
- WP-2: `impact-analysis.ts`, `graph-filter.ts`, `grep-tool.ts` (schema only — no `GrepToolOptions` or `execute()`)
- WP-3: `route-extraction.ts`, `community-detection.ts`, `layer-analysis.ts`, `signals.ts`, `monorepo-detector.ts`, `incremental-index.ts`
- WP-7: `complexity-signals.ts`, `rerank.ts`, `scoring.ts`
- WP-8: `intent-read.ts`, `adr-store.ts`

**No collisions detected.** `rerank.ts` and `intent-read.ts` are not touched by WP-1, WP-2, or WP-3. All WPs can execute in parallel.

### Cross-Wave Boundary Contracts

- **grep-tool.ts**: WP-2 adds `graphFilter` to `GrepSchema` (wave 1). WP-5 adds `contextGraph` to `GrepToolOptions` and wires execution (wave 3). WP-2 must NOT touch `GrepToolOptions` or `execute()`.
- **inspect-tool.ts**: WP-4 extends schema and validation (wave 2). WP-5 adds `contextGraph` to `InspectToolOptions` and populates `input.contextGraph` (wave 3).
- **inspect-types.ts**: WP-4 extends `InspectV4Input` with `contextGraph?: ContextGraph` (wave 2). WP-5 populates it at runtime (wave 3).

---

## Risks & Implementation Notes for Workers

1. **LSP fuzzy symbol matching fallback order** — `workspace/symbol` resolution is fuzzy: `AuthService.login` may match `AuthServiceLogin` or partial names. Fallback order: (a) exact qualified-name match first, (b) if no LSP server running or no match found, fall back to `ContextGraph.findSymbolFiles()` (src/context-graph.ts:347).

2. **Louvain fallback to label-propagation** — Louvain in ~150 LOC is optimistic for correct modularity delta computation, randomization, and convergence. If Louvain proves complex, fall back to a simpler label-propagation algorithm (~80 LOC). Consider implementing label-propagation first and treating Louvain as an optimization pass if profiling shows it necessary.

3. **`fs.watch` FD cap 256 on Linux non-recursive** — Non-recursive fallback means one watcher per subdirectory. For 500+ directory repos, that's 500+ file descriptors. Add a max-watcher-count cap (e.g., 256) with a warning when exceeded. Graceful degradation: stop adding watchers beyond cap, log warning, rely on periodic scan fallback.

4. **signals.ts additive-only changes** — WP-3 modifies the shared `signals.ts` which is consumed by inspect's file mode. The existing `tests` signal output shape must not break. All changes must be additive-only with backward-compatible defaults (new fields added to output object, existing fields unchanged).

5. **IncrementalIndex null-check for old file-hashes.json** — WP-3 adds `symbolCount`/`edgeCount` to `FileHashEntry` (src/incremental-index.ts:31-35). Old `file-hashes.json` files without these fields must be treated as "unknown, needs rebuild". Workers must implement a null-check in `diff()` that treats missing fields as `undefined` and triggers a rebuild for those entries rather than crashing.
