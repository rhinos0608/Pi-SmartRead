# Advanced Repository Retrieval Implementation Plan

**Status:** Proposed plan
**Inputs:** `docs/advanced-retrieval-research.md`, `docs/advanced-retrieval-spec.md`, current TypeScript source.

## Guiding principle

Build the smallest useful graph-aware retrieval layer first. Keep `intent_read` reliable, deterministic, and bounded. Treat CodeRAG-style logprob probing and preference reranking as optional experiments until local evaluation proves they help.

## Phase 0 — Baseline and evaluation harness

**Goal:** Establish current behavior before changing retrieval.

### Work

- Add or update retrieval fixtures under `test/unit` for:
  - direct lexical match,
  - semantic-only match,
  - imported neighbour match,
  - symbol definition in a different file,
  - caller/callee relation.
- Add a small evaluation script or test helper that records:
  - selected files,
  - ranking order,
  - inclusion status,
  - graph/probe/rerank metadata.
- Capture current `intent_read` behavior as baseline snapshots where stable.

### Files likely touched

- `test/unit/intent-read.test.ts`
- `test/unit/repomap-tool.test.ts`
- `test/unit/callgraph.test.ts` or a new focused test file
- optional `test/unit/fixtures/...`

### Exit criteria

- Baseline tests pass with no feature changes.
- At least one fixture demonstrates the current limitation: relevant symbol/call context is missed unless explicitly listed or imported.

## Phase 1 — Shared repository context graph service

**Goal:** Provide one reusable graph service for retrieval and future adapters.

### Work

- Add a service module, e.g. `context-graph.ts`, that exposes:
  - `buildContextGraph(root, options)`,
  - `getFileNeighbours(path, options)`,
  - `findSymbolFiles(queryOrIdentifier, options)`,
  - `explainPathAddition(path)`.
- Reuse existing components first:
  - `findSrcFiles` from `file-discovery.ts`,
  - tags from `tags.ts`/`cache.ts`,
  - PageRank/reference graph ideas from `repomap.ts`,
  - direct import resolution logic from `intent-read.ts` or a shared helper.
- Move direct import-neighbour logic out of `intent-read.ts` into a reusable module if needed.
- Preserve workspace and realpath safeguards.

### Design constraints

- Do not parse the full call graph by default in this phase.
- Cache by repo root and invalidate by mtime/content cache rules already used by tags.
- Return provenance objects, not just paths.

### Tests

- Unit-test import expansion.
- Unit-test symbol definition/reference file lookup.
- Unit-test workspace escape rejection.
- Unit-test deterministic ordering and caps.

### Exit criteria

- `intent_read` can still use existing import expansion through the shared service without output regression.
- Graph service exposes typed edges for imports and definitions/references.

## Phase 2 — Graph-aware `intent_read` expansion

**Goal:** Expand candidates with verified graph neighbours before reading/ranking.

### Work

- Replace `findDirectImportNeighbours` call in `intent-read.ts` with context graph expansion.
- Keep current direct-import behavior as the default minimum.
- Add optional graph modes internally:
  - `imports`: equivalent to current behavior,
  - `symbols`: import + definition/reference neighbours,
  - `calls`: import + symbol + call neighbours when cached/cheap,
  - `auto`: bounded combination.
- Preserve `MAX_INTENT_READ_FILES` and add per-mode caps.
- Extend `details.graphAugmentation` with edge provenance.

### Ranking

- Start by adding graph neighbours as candidates only.
- Do not change RRF yet. Isolate candidate expansion effects first.

### Tests

- Query mentions a symbol; definition file is added before embeddings.
- Import neighbour behavior remains unchanged.
- Added files never exceed the 20-file candidate cap.
- Details identify edge type and source.

### Exit criteria

- Existing `intent_read` tests pass.
- New graph-expansion tests prove symbol/reference neighbours can enter candidate set.

## Phase 3 — Deterministic probe phase

**Goal:** Add CodeRAG-inspired query probing without requiring logprobs.

### Work

- Add `query-probe.ts` with local strategies:
  - tokenize query using `scoring.ts` tokenizer,
  - detect probable identifiers, path fragments, and quoted names,
  - search `RepoMap`/context graph for definitions and references,
  - resolve high-confidence symbols through `symbol-resolver.ts` or shared graph APIs.
- Reuse `symbol-resolver.ts` for existing symbol/import resolution behavior rather than rebuilding that logic in the probe layer.
- Insert probe phase in `intent-read.ts` before graph expansion or as an expansion seed provider.
- Add `details.probing` metadata.

### Optional config

Feature flags can start in config rather than public tool schema:

```json
{
  "advancedRetrieval": {
    "probing": "off",
    "maxProbeAdded": 4
  }
}
```

Expose public schema only after stable behavior.

### Tests

- Query `authentication middleware` finds `Authenticator`/auth-like definitions in fixtures.
- Probe additions are validated files.
- Probe failure falls back to no additions.
- Deterministic ordering under equal confidence.

### Exit criteria

- Local probe adds useful candidates in at least one fixture where baseline misses them.
- No model dependency is required.

## Phase 4 — Call graph and future dataflow edges

**Goal:** Add richer structural context without making every query expensive.

### Work

- Integrate `callgraph.ts` through the context graph service.
- Build call graph only for:
  - explicitly requested files,
  - cached repo graph,
  - or focused TS/JS/TSX subsets.
- Add caller/callee expansion for high-confidence function symbols.
- Defer full dataflow until call graph behavior is measured.

### Future dataflow spike

Evaluate options before implementation:

- TypeScript compiler API for import/type/symbol resolution,
- tree-sitter-based local variable/reference approximation,
- language-server integration,
- external static-analysis service.

### Tests

- `find_callers` behavior remains stable.
- Caller/callee neighbour expansion adds expected files.
- Unsupported languages degrade cleanly.

### Exit criteria

- Call graph expansion is useful and bounded in TS/JS/TSX fixtures.
- No unacceptable latency regression in default `intent_read` path.

## Phase 5 — Structural reranker

**Goal:** Improve ordering after RRF with cheap local signals.

### Work

- Add `rerank.ts` with a pure structural reranker.
- Inputs:
  - RRF score,
  - keyword score/rank,
  - semantic score/rank,
  - graph distance/type,
  - probe confidence,
  - repo-map PageRank or in-degree where available,
  - path proximity.
- Apply after current `rankedSuccessOrder` calculation and before packing.
- Add `details.reranking`.

### Strategy

Start conservative:

- only rerank top N candidates,
- preserve original order unless structural confidence exceeds a threshold,
- report changed order.

### Tests

- Reranker promotes verified symbol-definition file over unrelated semantic hit.
- Exact keyword matches are not demoted below irrelevant graph neighbours.
- Failure or disabled mode returns original order.

### Exit criteria

- Local fixtures show at least one improved ordering without regressing exact-match cases.

## Phase 6 — Optional external/preference reranker

**Goal:** Evaluate CodeRAG-style preference-aligned or cross-encoder reranking as an optional provider.

### Work

- Add config for a reranker endpoint:

```json
{
  "advancedRetrieval": {
    "reranker": {
      "baseUrl": "http://localhost:PORT",
      "model": "...",
      "timeoutMs": 5000,
      "maxCandidates": 20
    }
  }
}
```

- Define a provider interface independent of any vendor.
- Send query + compact snippets, not full files by default.
- Add timeout/fallback and metadata.

### Security requirements

- Document that snippets may be sent to the reranker provider.
- Do not enable remote providers by default.
- Do not log request bodies.

### Tests

- Mock successful rerank response.
- Mock timeout and malformed response.
- Verify fallback to structural or RRF order.

### Exit criteria

- Optional provider can improve fixture ranking under test.
- Default install has no new external dependency.

## Phase 7 — Context packing and positional ordering

**Goal:** Make packed output more useful under long-context position effects.

### Work

- Keep highest-confidence files/snippets early in output.
- Consider an optional short evidence index at the top:
  - path,
  - why included,
  - key symbols/edges.
- Avoid duplicating large content solely for anchoring.
- Keep current adaptive packing semantics unless tests justify changes.

### Tests

- Packing still respects `DEFAULT_MAX_BYTES` and `DEFAULT_MAX_LINES`.
- Details remain complete when files are omitted or partial.
- Highest-confidence result is not displaced by smallest-first coverage optimization unless documented.

### Exit criteria

- Output remains compact and attributed.
- Packing changes are covered by tests.

## Phase 8 — MCP adapter spike

**Goal:** Decide whether MCP packaging is worth shipping.

### Work

- Extract shared core APIs from Pi tool wrappers if not already done.
- Build a minimal stdio MCP server in a separate entrypoint or package script.
- Expose read-only code intelligence tools first:
  - search,
  - map,
  - symbols,
  - callers,
  - impact.

### Constraints

- MCP adapter must not replace Pi extension behavior.
- No duplicated indexing code.
- Same cache invalidation and workspace guards.

### Exit criteria

- A local MCP client can call the shared services.
- Pi extension tests still pass.
- README clearly distinguishes Pi install from MCP usage.

## Cross-cutting validation

Run relevant checks after each phase:

```bash
npm test
npm run typecheck
git diff --check
```

For retrieval quality, add small scenario tests rather than relying on subjective manual reads.

Suggested scenario matrix:

| Scenario | Expected improvement |
|---|---|
| Query names concept but not file | Probe/symbol expansion finds definition file. |
| Query starts from handler | Call graph expansion finds called service/helper. |
| Query asks blast radius | Graph expansion returns callers/importers/references. |
| Embedding endpoint fails | BM25 fallback still works. |
| Graph parse fails | Existing import/BM25/embedding path still works. |

## Rollout strategy

1. Keep advanced retrieval off or imports-only by default.
2. Enable graph/symbol expansion behind config after tests pass.
3. Enable structural reranking only after baseline fixtures improve.
4. Keep model/logprob/external rerank features explicitly opt-in.
5. Update README after any public schema/config change.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Graph expansion adds noisy files | Typed edge weights, caps, provenance, tests. |
| Latency regresses | Cache graph data, avoid full call graph by default, timeouts. |
| Public schema churn | Start with internal/config flags before tool parameters. |
| External provider leaks code | Off by default, explicit config, privacy docs. |
| Overfitting to papers | Local fixtures and metrics decide defaults. |
| MCP rewrite distraction | Adapter only after shared core is stable. |

## First implementation slice

The lowest-risk slice is:

1. Extract direct import expansion into a shared context-graph helper.
2. Add definition/reference file lookup using existing `tags.ts` and `RepoMap` infrastructure.
3. Extend `intent_read` candidate expansion with symbol-neighbour files behind an internal flag.
4. Add details provenance and unit tests.

This slice creates real GraphRAG-adjacent value without needing logprobs, a reranker service, a vector database, or an MCP rewrite.
