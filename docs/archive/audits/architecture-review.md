# Architecture / Depth Audit — Pi-SmartRead

**Scope:** Whole TypeScript codebase (root `*.ts`, `test/`, `README.md`) reviewed through module / interface / seam / locality / leverage vocabulary.
**Date:** 2026-06-22
**Constraint:** Read-only. No project/source files modified. This document is the only artifact written.
**Inputs attempted:** `plan.md`, `progress.md` (task-requested) — **neither exists** on disk at the requested paths or anywhere under the repo (verified via `find`). Review proceeded against the codebase, `README.md`, and the existing `audits/` + `audit/` notes. Findings below are **new** and not restatements of `audits/audit-core.md`, `audit-mcp.md`, `audit-quality.md`, `audit-security.md`, or `audit-oracle.md` (cross-referenced to avoid duplication).

**Severity legend:** **S1** (seam defect — wrong/ineffective behavior on a live path), **S2** (leverage/locality defect — measurable maintainability or perf risk, latent today), **S3** (interface/hygiene defect — dead code / inconsistent contract).

---

## S1-1. Abort-signal seam is severed at `RepoMap.getRepoMap` — `repo_map` cannot be cancelled mid-flight

**Files:**
- `repomap-tool.ts:80-111` (tool `execute`)
- `repomap-pipeline.ts:341-415` (`getRepoMap`), `repomap-pipeline.ts:418-…` (`generateMap`)
- `repomap-pipeline.ts:752-879` (`getRepoMapFull` / `searchIdentifiers`, abort-aware)

**Problem (seam):**
`repomap-tool.ts` receives `signal: AbortSignal | undefined` and checks it **once** at entry (`if (signal?.aborted) throw …`, line 90), then calls `rm.getRepoMap({ … })` (line 98) **without forwarding `signal`**. `RepoMap.getRepoMap(options)` (`repomap-pipeline.ts:341`) has **no `signal` parameter** in its signature, and `generateMap` (line 418) calls `findSrcFiles(this.root)` (line ~443) and the ranking path with no signal. The pipeline *does* contain fully abort-aware helpers — `searchIdentifiers` (line 752: `if (signal?.aborted) return []`), `getRepoMapFull` (lines 762/780/802/849/874 all consult `signal`) — but those helpers are only reached with a real signal from direct internal callers, **never from the tool entry path**, because `getRepoMap`/`generateMap` drop it first.

**Consequence:**
- The MCP stdio server now plumbs `extra.signal` into `tool.execute` (fix-mcp P0-1). For `repo_map` that fix is **void**: a client that cancels a `repo_map` call on a large monorepo sees the tool run to completion (full tree-sitter tag extraction + PageRank), burning CPU/disk until it finishes.
- The abort-aware code at `repomap-pipeline.ts:762/780/802/849/874` is **dead on the production path** — it can only fire if some other caller invokes `getRepoMapFull`/`searchIdentifiers` directly with a signal, which the public tool surface never does. This is a latent contradiction: the codebase looks cancellation-safe but isn't.

**Solution:**
1. Add `signal?: AbortSignal` to `RepoMapOptions` / `getRepoMap(options)` and thread it into `generateMap` → `findSrcFiles(this.root, …, signal)` and into `getRepoMapFull`/`searchIdentifiers`.
2. In `repomap-tool.ts`, pass `signal` through: `rm.getRepoMap({ …, signal })`.
3. (Optional) add a periodic `if (signal?.aborted) throw new Error("Operation aborted")` inside the tag-extraction loop in `generateMap` so cancellation is honored between files, not only at file-discovery boundaries.

**Benefits:** MCP cancel actually stops `repo_map`; removes the dead-on-path abort checks; unifies the abort seam end-to-end; frees CPU on client disconnect for the most expensive read tool.

**Validation:**
- Unit: call `getRepoMap({ signal: AbortSignal.abort() })` → expect throw `Operation aborted` (today returns a map).
- Integration (MCP): start `mcp-server.ts`, call `repo_map` on a sizable tree, abort the request; assert the server stops tag extraction within one file boundary (instrument `searchIdentifiers` with a spy). Today it runs to completion.
- Grep audit: after fix, `grep -n "signal" repomap-tool.ts repomap-pipeline.ts` should show `signal` flowing from `execute` → `getRepoMap` → `generateMap` → `findSrcFiles`/`searchIdentifiers` with no gap.

---

## S1-2. Abort-signal seam inconsistently threaded in `symbol_info` — 3 of 4 actions ignore cancellation

**Files:**
- `find-symbol-tool.ts:913-951` (`createSymbolInfoTool` execute)
- `find-symbol-tool.ts:374-455` (`handleOverview`), `459-484` (`handleReferences`), `488-569` (`handleDeclaration`), `588-…` (`handleImplementations`)
- `symbol-resolver.ts:165-172` (`resolveSymbol` — no `signal` param; `findSrcFiles(root)` called without signal)

**Problem (seam):**
`symbol_info`'s `execute` receives `signal` and gates entry (`if (signal?.aborted) throw …`, line 921), but only the `implementations` branch forwards it (`handleImplementations(…, signal)`, line 944). The other three branches drop it:
- `outline` → `handleOverview(params.path, params.childDepth ?? 0, root)` (line 929) — `handleOverview` has **no `signal` parameter**.
- `references` → `handleReferences(…, root, ctx.cwd)` (line 939) — no signal; internally calls `resolveSymbol(...)` which calls `findSrcFiles(root)` with no signal (`symbol-resolver.ts:172`).
- `declaration` → `handleDeclaration(…, root, ctx.cwd)` (line 934) — no signal; LSP-first loop (lines 503-533) has no abort check, then `resolveSymbol(...)` again with no signal.

`find_symbol` (`handleSymbol`, line 191) **does** honor the signal (passes it to `findSrcFiles` line 221 and checks `signal?.aborted` in its scan loop line 234), so the inconsistency is localized to `symbol_info`.

**Consequence:** The MCP abort fix (fix-mcp P0-1) is only ~50% effective for the symbol family. Cancelling a `symbol_info` `references` or `declaration` call on a large workspace runs `resolveSymbol` → full `findSrcFiles` scan + cross-file reference resolution to completion. Worse, the `declaration` LSP-first loop (lines 503-533) scans up to 200 lines issuing `goToDefinition` per match with no abort check, so even LSP-available repos can't cancel.

**Solution:**
1. Add `signal?: AbortSignal` to `handleOverview`, `handleReferences`, `handleDeclaration`, and to `resolveSymbol` (forward into `findSrcFiles(root, …, signal)` and inter-file loops).
2. In `createSymbolInfoTool`, pass `signal` to all four action branches.
3. Add `if (signal?.aborted) break/throw` inside the `declaration` LSP line-scan loop (lines 503-533) and the `implementations` LSP loops (which currently only check the signal in the tree-sitter fallback pass, not the LSP-first pass).

**Benefits:** Uniform cancellation for the entire symbol tool family; closes the gap opened by fix-mcp P0-1; makes `resolveSymbol` reusable in abort-sensitive contexts.

**Validation:**
- Unit: `handleReferences("X", undefined, 30, root, cwd, AbortSignal.abort())` → throws `Operation aborted` (today returns full results).
- Unit: `resolveSymbol(root, "X", undefined, undefined, 30, AbortSignal.abort())` → throws / returns early (today scans all files).
- Grep: after fix, every `handle*` function in `find-symbol-tool.ts` that can do I/O accepts and forwards `signal`; no `execute` branch discards it.

---

## S2-1. `toRelativePath` duplicated verbatim in 4 deep-search modules — locality defect

**Files:**
- `deep-search.ts:157-160`
- `deep-search-graph.ts:16-19`
- `deep-search-lsp.ts:158-161`
- `deep-search-semantic.ts:86-89`

**Problem (locality / leverage):**
The identical 3-line function is copy-pasted into four modules:
```ts
function toRelativePath(cwd: string, path: string): string {
  const rel = relative(cwd, resolve(cwd, path));
  return rel && !rel.startsWith("..") ? rel.replace(/\\/g, "/") : path.replace(/\\/g, "/");
}
```
`audit-core.md` flags this only as a "cross-cutting observation (not a bug)". It is actionable: the relative-path contract (slash normalization, `..` fallback, Windows backslash handling) is a shared invariant that any future fix must replicate 4×. A drift here silently changes which files `deep_search` considers in- vs out-of-workspace across channels — the four channels would then fuse candidates with inconsistent path keys, corrupting the RRF `candidateKey` (`deep-search.ts:202`: `${candidate.file}:${candidate.line}:${name}`).

**Solution:** Hoist into a single `deep-search-paths.ts` (or extend `utils.ts`) exporting `toRelativePath`, and import it in all four modules. Add a unit test that pins the contract (relative input, absolute input, `..` escape, backslash on POSIX).

**Benefits:** Single source of truth for the relative-path invariant; one test instead of four implicit copies; makes future channel additions safe.

**Validation:**
- `grep -rn "function toRelativePath" *.ts` returns exactly one definition after refactor.
- `npm test` — existing `deep-search.test.ts` channel-fusion assertions unchanged.
- New unit test: `toRelativePath` contract (4 cases) passes.

---

## S2-2. Three independent `ContextGraph` instance caches with no shared ownership — leverage defect

**Files:**
- `hook.ts:51` — `const contextualGraphCache = new LruCache<ContextGraph>(3);` (read enrichment), constructed at `hook.ts:372` `graph = new ContextGraph(cwd);`
- `intent-read.ts:72` — `const contextGraphCache = new LruCache<ContextGraph>(10);`, constructed at `intent-read.ts:282` `sharedGraph = new ContextGraph(ctx.cwd);`
- `graph-protocol.ts:12-28` — `const _graphCache = new Map<string, ContextGraph>();` (FIFO, manual `MAX_CACHE_SIZE = 50`), constructed at `graph-protocol.ts:19` `g = new ContextGraph(cwd);`

**Problem (leverage / locality):**
`ContextGraph` is a heavy stateful service: each instance owns a `TagsCache`, a lazily-built `symbolIndex` (`LruCache<Tag[]>`), `fileIndex`, `callGraph`, and `mutationEdges`, plus a first-build git co-commit population (`context-graph.ts:163-180`). For the **same repo**, three independent caches each construct their own `ContextGraph(cwd)` and therefore rebuild the symbol/file index up to **3×** (once when the read-enrichment hook first touches a file, once when `intent_read` expands candidates, once if a `graph://` URL is resolved). The three caches also use **inconsistent eviction policies**:
- `hook.ts`: LRU, capacity 3.
- `intent-read.ts`: LRU, capacity 10.
- `graph-protocol.ts`: plain `Map` with FIFO eviction at size > 50 (not LRU — `keys().next()` evicts insertion-order oldest, not least-recently-used).

A user switching between 4+ repos evicts the read-enrichment graph but keeps the `intent_read` one; switching back rebuilds only one of the three. The lifetimes diverge, so the "graph is built once per repo" design intent stated in `hook.ts:50` ("Build once per repo, reuse across reads") is violated across the process.

**Consequence:** Wasted work (repeated tag extraction / git population), inconsistent freshness (one cache may have `forceRefresh`-cleared indices while another holds stale ones for the same repo), and a subtle perf cliff for multi-repo users. Also a correctness seam: `graph_mutate` writes to the on-disk EdgeStore, but each `ContextGraph` loads `mutationEdges` independently at build time — a mutation observed by `intent_read`'s graph may not be visible to `hook.ts`'s graph until its own `buildContextGraph` re-runs.

**Solution:** Introduce a single `ContextGraphRegistry`/factory (e.g. `getSharedContextGraph(cwd): ContextGraph`) backed by one LRU keyed by `realpath(cwd)`. Replace the three call sites (`hook.ts:370-374`, `intent-read.ts:280-284`, `graph-protocol.ts:16-28`) with calls to it. Pick one eviction policy (LRU, capacity ~16) and one freshness contract (a `forceRefresh` on one consumer invalidates the shared instance, or document that consumers must opt in to `forceRefresh`).

**Benefits:** One symbol/file index per repo; consistent freshness; removes ~2/3 of the repeated tag-extraction cost in mixed read+intent_read sessions; eliminates the FIFO-vs-LRU policy drift; gives `graph_mutate` a single place to invalidate.

**Validation:**
- Add a counter on `ContextGraph` builds per cwd; in a session that does `read` then `intent_read` on the same repo, assert the index is built **once** (today: up to 3×).
- Unit: `getSharedContextGraph(cwd) === getSharedContextGraph(cwd)` (identity) and `getSharedContextGraph(realpath(cwd))` dedupes symlinked roots.
- `npm test` — `context-graph.test.ts`, `hook.test.ts`, `intent-read.test.ts` unchanged.

---

## S3-1. Context-hygiene seam disconnect: `search`/`deep_search`/`intent_read` results are never stale-marked; `search-context` classification is dead code

**Files:**
- `index.ts:88-100` (`resourcesForTool`, `classificationForTool`)
- `context-hygiene.ts:16-18` (defines `"search-context"` classification), `context-hygiene.ts:419` (handles `search-context`)
- `search-tool.ts:573-581` and `deep-search-tool.ts:115-149` (`recordSparse` into `file-read-cache`)
- `context-hygiene.ts`, `context-application.ts` (neither imports `file-read-cache`)

**Problem (interface / seam):**
Two parallel stale-tracking mechanisms exist and do **not** connect:

1. **Context-hygiene tracker** (`context-hygiene.ts`) drives stale-marking in the context window via `applyContextHygieneStaleContext` (`index.ts:310-316`). It records `resources` per tool result from `resourcesForTool` (`index.ts:88-94`). `resourcesForTool` only extracts `path` / `filePath` / `relative_path` — **none of which `search`, `deep_search`, or `intent_read` pass** (their inputs are `query`/`directory`/`files[]` of candidate paths, not a single `path`). So these tools record **zero resources** → they never appear in `readEventsByResource` → they are **never masked as stale** when a file they returned matches from is later mutated.
2. `classificationForTool` (`index.ts:96-100`) returns `"read-context"` for everything except `graph_mutate` (`mutation`) and `bash` (`command-output`). The `"search-context"` classification defined at `context-hygiene.ts:17` and bucketed at `context-hygiene.ts:419` (`if (event.classification === "read-context" || event.classification === "search-context")`) is **never emitted** — dead code on the read-path branch.

3. Separately, `search-tool.ts` and `deep-search-tool.ts` call `recordSparse(sessionKey, absPath, entries)` into `file-read-cache.ts`. But `context-hygiene.ts` and `context-application.ts` **do not import `file-read-cache`** (verified). So the sparse records feed the external anchor-recovery system (smart-edit) but are invisible to the in-context-window stale-masker.

**Net:** After a `search`/`deep_search`/`intent_read` call, an agent can `edit` a file whose contents were surfaced by the search, and the search result block in the context window is **not** marked stale. The `audit-oracle.md` "hygiene gives false confidence" note is confirmed and made concrete here as an actionable seam defect, not just a design smell.

**Solution (choose one, scoped):**
- **Option A (cheap, recommended):** In `index.ts` `tool_result`, for `search`/`deep_search`/`intent_read`, parse the result's `details.matches`/`details.files` (the same shape `deep-search-tool.ts:118-137` already validates) and emit one `buildFileResource(absPath)` per surfaced file via the hygiene tracker's `record`. Classify these as `"search-context"`. This wires the existing dead classification and the existing resource model.
- **Option B (deeper):** Have `context-hygiene.generateReport` consume `file-read-cache` snapshots (the sparse/contiguous records already written by the search tools) so the two mechanisms unify.

Either way, also delete the now-reachable-vs-dead ambiguity: emit `"search-context"` from `classificationForTool` for the three search tools (so the branch at `context-hygiene.ts:419` is live and intentional, not accidental).

**Benefits:** Mutations actually invalidate search/semantic/deep-search context blocks, matching the README's "Context hygiene — Tracks every read tool result; marks stale reads in the context window after file mutations" claim (today this is true only for `read`/`read_files`). Removes the dead `search-context` branch ambiguity.

**Validation:**
- New test: run `search query=X` returning file `a.ts`; then simulate a `write` to `a.ts`; assert `generateReport()` marks the search result stale (today: not marked).
- `grep -n "search-context" context-hygiene.ts index.ts` — after fix, `index.ts` emits it and `context-hygiene.ts:419` is reachable.
- `context-hygiene.test.ts` extended with a search-result-stale case.

---

## Lower-priority observation (not a standalone fix item)

**`intent-read.ts` is the highest-centrality module** (1036 lines, graph centrality 40, the largest single tool module). It inlines embedding cache keying, candidate normalization, graph expansion, BM25/RRF fusion, chunking, HyDE, probing, reranking, classification, and packing into one `createIntentReadTool` factory. This is a leverage risk (any retrieval change touches one 1000-line file) but is **not** a defect today and the existing `audits/audit-core.md` already itemizes concrete bugs inside it. Recommend a future extract of the scoring/fusion/rerank pipeline into a `retrieval-pipeline.ts` only when the next retrieval feature lands — not as part of this audit.

---

## Cross-check against existing audits (non-duplication)

| This finding | Already covered? |
|---|---|
| S1-1 repo_map signal severance | No — `audit-mcp.md` P0-1 covers `mcp-server.ts` not plumbing `request.signal`; this is the *next* seam inward (`getRepoMap`), which that fix left broken. |
| S1-2 symbol_info signal inconsistency | No — `audit-mcp.md` P0-1 is the only signal note; the per-action inconsistency inside `symbol_info` is new. |
| S2-1 `toRelativePath` duplication | `audit-core.md` lists it under "Cross-cutting observations (not bugs)". Elevated here to actionable S2 with the candidate-key corruption rationale. |
| S2-2 triple `ContextGraph` cache | No — not in any prior audit. |
| S3-1 hygiene/search-context disconnect | `audit-oracle.md` flags "search-result resource tracking still weak" as a design note; this concretizes it with file:line and a dead-code branch. |

---

## Recommended fix order

1. **S1-1** — thread `signal` through `getRepoMap`/`generateMap`. Small, high-value, unblocks MCP cancel for the most expensive tool.
2. **S1-2** — add `signal` to `handleOverview`/`handleReferences`/`handleDeclaration` + `resolveSymbol`. Completes the symbol family.
3. **S3-1** — emit `search-context` + resources for search/semantic/deep-search results. Makes hygiene honest.
4. **S2-1** — hoist `toRelativePath`. Pure refactor, low risk, add a unit test first.
5. **S2-2** — shared `ContextGraph` registry. Larger; do after S1/S3 to avoid merging while the seam contracts are in flux.

---

## Evidence / commands run

- `ls`, `read` of `index.ts`, `tool-registry.ts`, `mcp-registry.ts`, `mcp-server.ts`, `hook.ts`, `context-graph.ts`, `config.ts`, `types.ts`, `intent-read.ts`, `deep-search.ts`, `deep-search-tool.ts`, `find-symbol-tool.ts`, `repomap-tool.ts`, `repomap-pipeline.ts`, `graph-protocol.ts`, `utils.ts`, `symbol-resolver.ts`, `context-hygiene.ts`, `README.md`, and all `audits/*.md` + `audit/scout-system-map.md`.
- `grep`/`search` for `toRelativePath`, `signal`, `ContextGraph(`, `search-context`, `recordSparse`, `resolveSymbol`, `pathMatchesScope`, `findSrcFiles`.
- `git status --short` and `git diff --cached --name-only` (see acceptance report).

No source/project files were modified. The only file created is this document.