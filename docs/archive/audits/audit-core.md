# Core Retrieval/Read/Search Audit

Scope: `read-many.ts`, `intent-read.ts`, `search-tool.ts`, `deep-search*.ts`, `repomap-*.ts`, `context-graph.ts`, `file-discovery.ts`, `fs-scan-cache.ts`.

Severity legend: **B**locker (wrong output or can corrupt state), **H**igh (significant incorrectness / silent loss), **M**edium (latent bug, narrow window), **L**ow (hygiene / minor inefficiency). Evidence cites file:line.

---

## Blocker

### B1. `search-tool.ts:651` — `handleCode` top-K is not globally sorted across `scored` ∪ `bm25Only`
```ts
const allResults = [...scored, ...bm25Only.sort((a, b) => b.score - a.score)];
// …
const top = allResults.slice(0, maxResults); // search-tool.ts:691
```
Both halves are individually sorted by `b.score - a.score`, but the concatenation is **not** re-sorted. If the last item of `scored` has score 0.4 and the first item of `bm25Only` has score 0.9, the final `allResults` is `[…, 0.4, 0.9, …]` and `top = allResults.slice(0, maxResults)` will include the 0.4 while excluding 0.9. The subsequent `lspResults` re-sort at line 688 only runs when LSP results are added, so the common case leaks the bug. The model receives lower-confidence defs and may miss the top match.

**Repro:** run `search mode=code query=...` on a repo where the highest-scoring definitions cross the `preFilterN` boundary (default `Math.min(maxResults*5, 200) = 100` for `maxResults=20`). Top hit can be from `scored` even when a higher-scored def sits just below the cut in `bm25Only`.

**Fix:** `const allResults = [...scored, ...bm25Only].sort((a, b) => b.score - a.score);` before `top = allResults.slice(...)`. Then re-sort after LSP merge.

---

### B2. `read-many.ts:253-255` — `stopOnError: true` does not actually stop on first error
```ts
for (let chunkStart = 0; chunkStart < params.files.length; chunkStart += CHUNK_SIZE) {
    for (let i = chunkStart; i < chunkEnd; i++) {
        try { … } catch (error) {
            …
            if (params.stopOnError) {
                break;   // ← only breaks the inner for-i, outer chunked loop continues
            }
        }
    }
    if (largeRequest && chunkStart + CHUNK_SIZE < params.files.length) {
        await new Promise(r => setImmediate(r));
    }
}
```
The `break` exits the inner `for (let i = …)` only; control then falls through to the event-loop yield and the outer `for (let chunkStart = …)` continues to the next chunk. So with `files.length > 500` (the `CHUNK_SIZE`) and a failure on file index 0, the call still processes files 500..999 in the next chunk. This contradicts the schema description `Stop on first error (default false)` (`read-many.ts:60`).

**Repro:** call `read_files` with `>500` files, `stopOnError: true`, and a single unreadable file in the first chunk. The call does not throw; it returns after every chunk finishes.

**Fix:** replace the bare `break` with a labeled break (`outer: for { … break outer; }`), or set a flag checked by the outer loop, or `throw` instead of `break` (the catch already has the error in scope). Prefer the throw — it’s the only way to guarantee downstream phases don’t run on partial failure.

---

## High

### H1. `intent-read.ts:723-750` — empty-chunk file loop: invariant currently synchronized, no fix (Medium-architecture)
```ts
for (let fi = 0; fi < fileChunks.length; fi++) {
    const numChunks = fileChunks[fi]!.length;
    totalChunks += numChunks;
    if (numChunks > 0) {
        filesChunked++;
        const myChunkVecs = chunkVecs.slice(chunkIdx, chunkIdx + numChunks);
        const { maxScore, bestChunkIndex } = maxChunkSimilarity(queryVec, myChunkVecs!);
        semanticScores.push(maxScore);
        const path = successfulFiles[fi]!.path;
        const fileDetail = fileDetails.get(path)!;
        fileDetail.chunkIndex = bestChunkIndex;
        …
    } else {
        semanticScores.push(-Infinity);
    }
    chunkIdx += numChunks;
}
```
**Reclassified (no fix):** the array loop is **currently synchronized**. `fileChunks` is populated by iterating `successfulFiles` directly, so both arrays have the same length and `chunkIdx` advances by `numChunks` every iteration regardless of branch — the chunk-vector mapping stays aligned. `semanticScores` is filled in **both** branches (`maxScore` or `-Infinity`), so the later `semanticScores[i]!` read (guarded by `embeddingStatus === "ok"`) is safe; on the BM25-fallback path the read is skipped entirely. The `else` branch is reachable when a file yields zero chunks.

The only risk is the implicit coupling: if a future change drops files from `successfulFiles` after the chunk build, the chunk map would drift. **No fix needed today**; document the invariant (walk both arrays in lockstep) if the coupling is ever touched. Reclassify from High to **Medium-architecture** (tight coupling, not a runtime bug).

---

### H2. `deep-search.ts:622-626` — re-ranking inside `fuseCandidates` uses pre-fusion rank
```ts
const ranks = computeRanks(candidates.map(c => c.rawScore), candidates.map(c => c.file));
candidates.forEach((candidate, index) => { candidate.rank = ranks[index] ?? candidate.rank; });
```
This re-ranks per-channel candidates. `computeRanks` ties broken by index, so two candidates with equal score get ranks 1 and 2 based on the order they entered the list. **Issue:** candidates from each channel enter the `channelResults` array in whatever order the `Promise.allSettled` resolved them — non-deterministic across runs. Re-ranking with this ordering produces non-deterministic Ranks when scores tie, which cascades into the RRF contribution `1 / (RRF_K + candidate.rank)` in `fuseCandidates` and changes which matches surface. For a deterministic agent, this is a real source of variation.

**Fix:** add a tie-breaker using `(channel, file, name)` so the order is stable, or use a separate ordering rule that does not depend on the `Promise.allSettled` order.

---

### H3. `search-tool.ts:232` — `scoreDefinitions` strict length check rejects valid results
```ts
if (vectors.length >= embedTexts.length + 1) { … }
```
Actually the check is `>=`, so it accepts longer responses. **But** the strict equality check in `intent-read.ts:698` (`vectors.length === allChunkTexts.length + 1`) drops results if the server returns even one extra vector. This silently falls to BM25 with `embeddingError: "Expected N vectors, got M"`. **This is a real silent regression** — some embedding APIs (vLLM with `truncate='NONE'`, certain Ollama versions) duplicate the input or return `len(input) + N` vectors when echo is on. The intent-read tool should be more lenient.

**Fix:** change the condition to `vectors.length >= allChunkTexts.length + 1` and slice to the expected length:
```ts
if (vectors.length >= allChunkTexts.length + 1) {
    const queryVec = vectors[0]!;
    const chunkVecs = vectors.slice(1, allChunkTexts.length + 1);
    …
}
```

---

### H4. `context-graph.ts:170-181` — `forceRefresh: true` with empty file set leaves stale indices
```ts
if (options.forceRefresh) {
    this.symbolIndex = null;
    this.fileIndex = null;
    …
}
…
const allFiles = await findSrcFiles(this.root);
…
if (allFiles.length === 0) {
    this.symbolIndex = new LruCache(1);
    this.fileIndex = new LruCache(1);
    return;
}
```
When `forceRefresh` is true and `findSrcFiles` returns empty, the indices are set to empty LRU(1) caches. The next `buildContextGraph` call (without `forceRefresh`) hits the `if (this.symbolIndex !== null) return;` at line 175 and skips re-population. If files were created in the meantime, the indices stay empty until the next `forceRefresh`. This is the cache-coherency problem the `fs-scan-cache` was supposed to solve.

**Fix:** invalidate or set `symbolIndex = null` when `findSrcFiles` returns a different length than the last call. Or always rebuild when `allFiles.length` differs from the previous run.

---

### H5. `context-graph.ts:158-167` — async git population races with the user
```ts
if (this.mutationEdges.size === 0 && !options.skipGitPopulation) {
    const config = loadGitContextConfig(this.root);
    const limit = config.coCommitAnalysisLimit ?? 100;
    findGitRoot(this.root).then(async (gitRoot) => { … }).catch(() => {});
}
```
This is fire-and-forget. The `ContextGraph` instance is returned to the caller before git co-commit analysis finishes. Any `getMutationNeighbours` call within the same session will see empty results on the first invocation, regardless of whether co-commit data exists. Worse: concurrent calls may both see the same empty `mutationEdges` and both kick off the population.

**Fix:** either await the population (with a bounded timeout) or expose a `ready` promise that callers can `await`.

---

## Medium

### M1. `read-many.ts:188-208` — summary path records the summary as the file's content
```ts
if (!selector && !rawMode && body && body.length > 8192) {
    if (canSummarize(resolvedPath, body.length, bodyLines)) {
        try {
            const summary = await summarizeCode({ code: body, path: resolvedPath });
            if (summary.parsed && summary.elided) {
                const rendered = renderSummary(summary, resolvedPath);
                body = rendered.text;
            }
        } catch { /* fall through to raw body */ }
    }
}
…
const rawBody = alreadyAnchored ? stripHashlineAnchors(body) : body;
…
const rawLines = rawBody.split("\n");
recordContiguous(sessionKey, resolvedPath, startLine, rawLines);
```
When the file is large enough to trigger summarization, `body` is replaced with the rendered summary. `rawBody` is then derived from the summary, and `recordContiguous` stores the **summary lines** in the file-read cache against `resolvedPath` and the **original** `startLine`. The next read of the same file (no selector) will look up the cache by `path + startLine` and may return the summary content, which no longer matches the file's actual content at those line numbers. Hashline-anchor stale-recovery will then propose invalid edits.

**Fix:** skip `recordContiguous` when the file was summarized (`if (summaryApplied) { /* do not record */ }`) or record under a different key (e.g. include a `summarized: true` flag).

---

### M2. `search-tool.ts:651` vs `search-tool.ts:688` — LSP merge re-sort, but only when LSP added
Documented above in B1. The fix in B1 covers M2 as well.

---

### M3. `deep-search-symbol.ts:30-105` — fallback parser formatting causes maintainability risk
The function has three branches (early-return at line 54, text-regex loop at 60–76, path-line fallback at 77–103) with inconsistent indentation and a missing closing brace at line 102 that is only "correct" because of the right number of `}` tokens. The TS compiler accepts it; a refactor that adds a nested `if` will break the brace count silently. No runtime bug today.

**Fix:** reformat the block. Add a unit test that invokes `parseGrepCandidates` with various text shapes (no results, text-format matches, plain text) to lock the behavior before refactoring.

---

### M4. `repomap-pipeline.ts:766-803` — `searchIdentifiers` permanently disables tree-sitter on first failure
```ts
} catch {
    this.searchTreeSitterAvailable = false;
    allTags = [];
}
```
A single transient init failure (`initParser()` throws) sets the instance flag to `false` forever. The `searchIdentifiers` method then uses the text fallback for the lifetime of the `RepoMap` instance, even after the user re-tries and tree-sitter would succeed. This is correct as a degradation strategy, but the user has no signal that the path was taken.

**Fix:** keep the flag but expose a `getActiveRankingMethod()` method, or retry on every Nth call. Document the permanent-fallback behavior in the `searchIdentifiers` docstring.

---

### M5. `fs-scan-cache.ts:191-203` — expired entries not deleted before rescan (FIXED)
```ts
const cached = this.cache.get(key);
const entryData = this.cacheGetWithAge(key);
if (cached !== undefined && entryData !== undefined) {
    const now = Date.now();
    const age = now - entryData.createdAt;
    const ttl = isArrayResult(entryData.data) && entryData.data.length === 0
        ? this.emptyRecheckMs
        : this.ttlMs;
    if (age < ttl) {
        return { entries: cached, cacheAgeMs: age };
    }
    // Expired — delete before rescan to prevent stale refs and race conditions
    this.cache.delete(key);
}
// Cache miss or expired — run the scan
const result = await scanFn();
```
**Status: PARTIALLY FIXED.** The stale-entry deletion is fixed independently: `fs-scan-cache.ts:202-203` now calls `this.cache.delete(key)` before the rescan, so a racing caller can no longer observe the expired entry. However, the duplicate-scan race itself is NOT closed — `getOrScan` has no separate in-flight promise guard, so concurrent callers with an expired/missing entry can still both run `scanFn()`. The finding remains open until a per-key in-flight promise deduplicates concurrent `scanFn()` calls.

---

### M6. `intent-read.ts:264-266` — duplicate file paths silently overwrite detail map
```ts
} else {
    resolvedFiles = params.files!;
}
…
const fileDetails = new Map<string, Partial<WorkingIntentReadFileDetail>>();
for (const f of fileResults) {
    fileDetails.set(f.path, { path: f.path, ok: f.ok, error: f.error, rankedBy: "bm25" });
}
```
If `params.files` contains the same path twice, both reads land in `orderedResults` at different indices but the Map key is the path — the second write wins. The `topKPaths` set (line 843) will be missing the duplicate. The user sees a single result for what they asked to read twice.

**Fix:** key the detail map on a unique request id (e.g. `resolvedPath#i` or an explicit `requestKey`).

---

### M7. `context-graph.ts:393` — `nodes` set vs `edges` keys
```ts
const nodes = new Set(allFiles.map((f) => path.relative(root, f)));
```
`allFiles` from `findSrcFiles` is absolute. `path.relative(root, abs)` is relative. The edges built in `repomap-ranking` (line 333) use `relFname` (already relative) on both sides. So if `path.relative(root, abs)` produces a path that differs from the `relFname` used during tag extraction (e.g. on Windows where root and abs differ only in case), edges won’t match nodes. PageRank will silently drop those nodes.

**Fix:** normalize via `realpathSync` once at construction time, or have `findSrcFiles` return rel-paths.

---

### M8. `deep-search.ts:638-640` — `discoveredFiles` awaits before channels start
```ts
const discoveredFiles = await discoverCandidateFiles(cwd, scope, signal);
const candidatePathFilter = new Set(discoveredFiles.map((path) => toRelativePath(cwd, path)));
…
const phase1Promise = (async () => { … })();
```
The comment at line 670 says "Phase 2: semantic in parallel with phase 1". But `discoverCandidateFiles` is awaited first, then phase 1 and 2 are kicked off as concurrent tasks. This is a `fire-after-discovery` pattern, not true parallelism between discovery and phase 1. For a 2 000-file repo, the discovery walk can take seconds. The user sees no partial progress.

**Fix:** start phase 1 with the first N files as they arrive (or accept the current design but document that discovery is a serial precondition).

---

## Low

### L1. `search-tool.ts:503-505` — `handleGrep` reads the entire file before scanning
```ts
content = await fs.readFile(filePath, "utf-8");
…
const lines = content.split(/\r?\n/g);
```
A multi-GB log file would be loaded entirely before any work begins. Add a size cap (e.g. `if (stat.size > MAX_FILE_BYTES) continue;`).

### L2. `deep-search-symbol.ts:81` — `console.warn` in the parser
`parseGrepCandidates` writes a `console.warn` to stderr when it can’t parse. The tool runner intercepts stderr noise and may surface it to the user. Use a debug logger instead.

### L3. `fs-scan-cache.ts:289-298` — singleton `_defaultInstance` is shared across all roots
The shared default cache pools entries from every project. With `maxEntries = 16`, a developer who opens 17 different repos in one session evicts the oldest. The LRU eviction is global, not per-root. For multi-project users this thrashes. Consider per-root partitioning.

### L4. `intent-read.ts:269-278` — `sharedGraph` lives on a module-level `LruCache(10)` keyed by `ctx.cwd`
```ts
const contextGraphCache = new LruCache<ContextGraph>(10);
…
let sharedGraph = contextGraphCache.get(ctx.cwd);
if (!sharedGraph) {
    sharedGraph = new ContextGraph(ctx.cwd);
    contextGraphCache.set(ctx.cwd, sharedGraph);
}
```
The `ContextGraph` constructor calls `new TagsCache(root)`, which is non-trivial. With 10 roots and 11+ project switches, the oldest is evicted. But the `TagsCache` itself keeps an on-disk cache, so a rebuild is cheap — except the in-memory `symbolIndex` and `fileIndex` are lost. Subtle perf cliff when a user hops between repos.

### L5. `search-tool.ts:140-150` — `extractCodeDefinitions` builds a fresh `Parser` per file
`new Parser()` + `setLanguage` is called for every file. `tree-sitter` parsers are reusable; the cost is small per call but adds up across thousands of files. A parser pool keyed by language would amortize.

### L6. `repomap-pipeline.ts:339-370` — `forceRefresh` and `delta` interact oddly
```ts
if (!forceRefresh && !options.delta) {
    if (refresh === "manual" && this.lastMap !== null) { return … }
    …
}
…
if (options.delta && this.lastMap !== null && fullMap !== null) {
    const deltaMap = diffMaps(this.lastMap, fullMap);
    this.lastMap = fullMap;
    …
}
```
With `forceRefresh: true, delta: true`, the cache is bypassed but `this.lastMap` is updated to the new map. The next call with `delta: true` will diff against the just-computed map, returning `(no changes since last call)`. That’s actually correct, but the wording is confusing.

### L7. `deep-search.ts:412-414` — typo in `generateSearchGuidelines` line:
```ts
`   - ❌ "${notFoundTerms.slice(0, 2).join('" or "') || 'entry point'}" (concept)`,
```
If `notFoundTerms` is non-empty, the template renders `❌ "term1" or "term2"`. If empty, `||` falls back to `'entry point'`. The fallback path triggers only when `notFoundTerms` is empty, but at that point the surrounding code already skipped this block (`if (notFoundTerms.length > 0)` at line 309). Dead code.

---

## Cross-cutting observations (not bugs)

- **Path normalization drift.** `toRelativePath` is defined identically in `deep-search.ts`, `deep-search-semantic.ts`, `deep-search-graph.ts`, `deep-search-lsp.ts`. Any fix to the relative-path computation must be replicated in 4 places. Hoist to `utils.ts`.
- **Cache keys are not normalized across the stack.** `fs-scan-cache` uses `resolvedRoot`, `search-tool` uses no cache, `intent-read` caches embeddings by JSON.stringify of inputs. None of them invalidate on `forceRefresh` from above. Document the ownership boundaries.
- **Stop signals are not always honored.** `findSrcFiles` does not accept an abort signal; `fs-scan-cache` does not plumb signals; the `find` tool’s discovery phase can dominate the runtime budget.

---

## Recommended fix order

1. B1 — `search-tool.ts:651` sort union
2. B2 — `read-many.ts:253-255` stopOnError throw, not break
3. H3 — `intent-read.ts:698` lenient length check
4. M1 — `read-many.ts:188-208` skip cache record on summary
5. M4 — `repomap-pipeline.ts:766-803` expose degradation
6. H4 — `context-graph.ts:170-181` invalidate on size change
7. H5 — `context-graph.ts:158-167` await git population
8. M5 — `fs-scan-cache.ts:191-200` delete expired entries
9. M6 — `intent-read.ts:264-266` unique detail keys
10. M7 — `context-graph.ts:393` normalize rel paths
11. L1, L2, L3 — hygiene pass
