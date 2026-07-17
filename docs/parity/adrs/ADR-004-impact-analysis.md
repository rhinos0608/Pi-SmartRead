# ADR-004: Impact Analysis / Risk Classification Surface

**Status:** Proposed
**Date:** 2026-07-16
**Deciders:** Pi-SmartRead parity design

## Context

DeusData/codebase-memory-mcp provides `detect_changes` (maps git diff → affected symbols with risk: critical/high/medium/low) and `trace_path` (BFS call graph traversal with impact_summary). The reference computes risk from call-graph centrality (PageRank) and blast radius (hop depth).

Pi-SmartRead has `ContextGraph.getMutationNeighbours()` (breakage/co-change lookup), `callgraph.ts` (callers/callees per function), and `signals.ts` (quality signals including complexity and public-api). No pre-computed impact scoring. No risk classification.

The parity target includes: BFS call graph traversal (depth-limited), impact analysis/blast radius, git diff → affected symbol mapping with risk, and dead code detection.

## Decision

**Add impact computation as new `inspect` parameters that leverage the existing call graph, context graph, and git diff modules.** Risk classification is computed at query time from graph centrality and edge topology — no pre-computed scores stored.

### Param surface

All new params on `inspect` (see ADR-001 for full list). Key ones for this ADR:

| Param | Behavior | Compute Path |
|---|---|---|
| `callDepth` (1–5) | BFS traversal depth | `callgraph.ts` → BFS from file symbols |
| `callDirection` | "callers" / "callees" / "both" | BFS direction filter |
| `impact` (boolean) | Blast radius: all files reachable via call+import | `ContextGraph.getFileNeighbours()` (file-level expansion) + `ContextGraph.findSymbolFiles()` (symbol→file resolution) |
| `deadCode` (boolean) | Zero-caller functions in scope | Symbol index + call graph difference set |
| `diff` ("unstaged"\|"staged"\|"HEAD") | Git diff → affected symbols + risk | `git-context.ts` diff + `IncrementalIndex` changed files → `callgraph.ts` callers → risk classify |

### Risk classification algorithm

Simple, deterministic, no learned weights:

1. **Function centrality:** PageRank score from the import/call graph (already computed by `repomap-ranking.ts`)
2. **Fan-in count:** Number of distinct callers (from `callgraph.ts` CallGraphResult)
3. **Blast radius depth:** Maximum hop distance of affected symbols from changed file
4. **File tier:** Is the file an entry point, public API export, or test? (from `signals.ts`)

Risk levels:
- **critical:** PageRank > 0.9 OR fan-in > 50 OR entry point + blast radius ≥ 3
- **high:** PageRank > 0.7 OR fan-in > 20 OR public API
- **medium:** fan-in > 5 OR blast radius ≥ 2
- **low:** everything else

### Output shape for impact analysis

```typescript
interface ImpactResult {
  target: string;              // file or symbol path
  risk: "critical" | "high" | "medium" | "low";
  affectedFiles: string[];     // file paths ranked by risk
  affectedSymbols: string[];   // fully qualified symbol names
  blastRadiusDepth: number;    // max hop distance
  callGraphSummary: {
    directCallers: number;
    transitiveCallers: number;
    directCallees: number;
    transitiveCallees: number;
  };
}
```

## Consequences

### Positive
- Reuses existing modules — no new graph engine
- Risk classification is transparent (no ML, no learned weights) — agent can understand why something is "critical"
- All computation is query-time, no stale cached scores
- `impact` and `diff` are orthogonal — agent can compute impact of hypothetical changes before making them, then validate actual changes after

### Negative
- PageRank recomputation on every impact query for large repos (>5K files) could be slow (~500ms). Mitigated by: PageRank is already computed for repo map; cache the vector for the session.
- Dead code detection requires full call graph to be built. Mitigated by: lazy build; if call graph is already in memory from earlier `buildContextGraph({ includeCalls: true })`, it's O(1) lookup.
- Risk thresholds (0.9, 0.7, 50, 20) are opinionated. Future: make configurable via `.pi-smartread.json` but start with hardcoded defaults.

### Alternatives Considered

1. **Pre-computed impact scores stored in EdgeStore (rejected):** Stale scores are worse than no scores. Query-time computation is correct by construction.
2. **ML-based risk model (rejected):** Opaque to the agent, requires training data, overkill for the use case.
3. **Dedicated `impact` tool (rejected):** Violates "extend not add" constraint. Impact is semantically a property of a file/directory — inspect is the right surface.

## Validation

- [ ] `inspect { impact: true }` on known file returns affected files ranked by risk
- [ ] `inspect { diff: "unstaged" }` after making changes correctly maps to affected symbols
- [ ] `inspect { deadCode: true }` returns zero-caller functions, excludes entry points
- [ ] `inspect { callDepth: 3, callDirection: "callers" }` returns 3-hop caller tree
- [ ] Risk classification aligns with manual assessment for known test fixtures
- [ ] Evidence envelopes: impact mode uses `mode: "symbol"`, resources list affected files with `coverage: "search-match"`
