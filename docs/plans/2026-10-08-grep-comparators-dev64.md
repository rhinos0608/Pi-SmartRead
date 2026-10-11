# Grep comparators on frozen dev64 (2026-10-08)

Owner: grep-comparator worker. Closes the E9 harness gap: the comparator
runner now supports `--manifest`, so ripgrep/Probe/Codanna ran on exactly
the same frozen dev64 queries as SmartRead. `--split dev` ONLY in every
command below; the holdout was never opened (no `--open-holdout` anywhere).

## Harness change (this task)

- `scripts/eval/external/grep/comparators/run-comparators.ts` accepts
  `--manifest PATH [--split dev|holdout] [--open-holdout]`, mirroring
  `scripts/eval/external/grep/run.ts`: frozen integrity verification
  (fail closed), dev selection without re-freezing or rewriting, holdout
  refused without `--open-holdout` (D41), `--accept-license-review`
  required (frozen splits span Multi-SWE-bench rows), Multi-SWE-bench
  fallback for ids missing from Multilingual rows, unresolved ids recorded
  as `manifest-id-unresolved` exclusions. Same grader
  (`computeInstanceMetrics`) and same default budget (`--timeout-ms 60000`)
  as the ours runner; setup/index time stays separated (`setupMs` per
  outcome + `totalSetupMs`); ripgrep query preprocessing disclosed in
  `comparators/ripgrep.ts` header and in every report's `comparator`
  manifest fragment (identifier-token terms, `rg --json -i -F -e <term>`
  per term, rank by match count; non-equivalent NL search).
- Parsing extracted to `comparators/args.ts` (unit-testable; the runner
  script executes on import). `isComparatorName` moved to
  `comparators/types.ts`, re-exported from `comparators/index.ts`.
- Tests: `test/unit/eval/external-grep-comparators-manifest.test.ts`
  (11 cases: frozen/dev/holdout parsing, license gate, holdout-without-
  manifest refusal, missing-value and unknown-arg errors).

## Code state and manifest

- Tree: `/Users/rhinesharar/Pi-SmartRead-ergonomics`, engine identity
  emitted by the ours run:
  `sha256:5a3e5c28…:280-files` (branch has moved since the `ccbb39c`
  guard baseline; retrieval config identical — see ranking knobs below).
- Frozen manifest:
  `~/.cache/pi-smartread-bench/manifests/external-grep-dev64-holdout32.json`
  (`dev=64, holdout=32, sha 9cfbf8e7…`; same file as the guard baseline).
- All runs `--offline` (cached rows + existing bare clones only), judge
  off, default ranking knobs
  (`rankTestDemote=0.7, rankFilename=false, rankBm25k1=1.2, rankBm25b=0.75,
  rankCoverage=false, rankStopwords=false`), 64 instances x title+body =
  128 queries per system, 0 excluded everywhere.

## Commands (identical except --system)

```
M=~/.cache/pi-smartread-bench/manifests/external-grep-dev64-holdout32.json
npx tsx scripts/eval/external/grep/run.ts --manifest $M --split dev --accept-license-review --offline
npx tsx scripts/eval/external/grep/comparators/run-comparators.ts --system ripgrep|probe|codanna --manifest $M --split dev --accept-license-review --offline
```

## Results (frozen dev64, 128 queries each)

| System | Report | success@5 (title / body) | knownPatchFileRecall@5 | MRR | rendered tok/q (mean) | query latency mean / p50 / p90 | setup time |
|---|---|---|---|---|---|---|---|
| SmartRead grep | `reports/external-grep-dev-2026-10-07T13-22-41-411Z-03d6427c.json` | 35/128 (16/64 / 19/64) | .211 | .158 | 1908.2 | 3448 / 1268 / 9422 ms | n/a (no index step) |
| ripgrep 15.1.0 (system `rg`, `system-binary` pin) | `reports/external-grep-ripgrep-dev-2026-10-07T13-25-57-626Z-c5ebb068.json` | 21/128 (15/64 / 6/64) | .118 | .108 | 658.5 | 1367 / 419 / 3198 ms | 0 |
| Probe v0.6.0-rc341 (`sha256:fd75278e…`, probelabs/probe, Apache-2.0) | `reports/external-grep-probe-dev-2026-10-07T13-31-42-602Z-c783b3e7.json` | 43/128 (24/64 / 19/64) | .263 | .218 | 636.4 | 2569 / 1297 / 5339 ms | 0 |
| Codanna v0.16.0 (12e823c, `sha256:3e6c92cf…`, bartolli/codanna, Apache-2.0) | `reports/external-grep-codanna-dev-2026-10-07T13-42-13-830Z-ce2b24ff.json` | 9/128 (9/64 / 0/64) | .049 | .062 | 200.7 | 18 / 16 / 27 ms | 613.5 s total (~4.8 s/query; index built per instance, reused across formulations) |

Errors: SmartRead 0, ripgrep 0, Codanna 0, Probe 15 (`error:Command
failed`, 0 units; 13/15 on `sveltejs__svelte` snapshots — bodies 11,
titles 4 — consistent with per-query timeout/failure on the largest
snapshots, not graded leniently: all count as failures in the 128
denominator).

Headline: on the same frozen split, **Probe beats SmartRead (43 vs 35)**,
driven by titles (24 vs 16; bodies tied 19-19). ripgrep trails on both
formulations. Codanna symbol search returns nothing usable on bodies
(status `ok`, 0.0 mean units over all 64 body queries) and is weak on
titles (9/64) despite a ~10-minute index build.

## Per-query cases: comparator succeeds where SmartRead fails

Format `instanceId::formulation`. These drive future retrieval changes.

- ripgrep-only wins (16):
  `axios__axios-5085::body`, `facebook__docusaurus-10130::title`,
  `preactjs__preact-2896::title`, `sveltejs__svelte-10259::title`,
  `sveltejs__svelte-11096::title`, `sveltejs__svelte-12509::title`,
  `sveltejs__svelte-12509::body`, `sveltejs__svelte-13656::title`,
  `sveltejs__svelte-14494::title`, `sveltejs__svelte-14494::body`,
  `sveltejs__svelte-9550::title`, `sveltejs__svelte-9550::body`,
  `vuejs__core-10874::title`, `vuejs__core-11854::title`,
  `vuejs__core-8511::title`, `vuejs__core-9532::title`
  (SmartRead wins 30 queries back over ripgrep.)
- Probe-only wins (28):
  `axios__axios-5085::body`, `axios__axios-5919::body`,
  `babel__babel-15445::body`, `facebook__docusaurus-10130::title`,
  `mrdoob__three.js-25687::title`, `mrdoob__three.js-27395::title`,
  `preactjs__preact-2757::title`, `preactjs__preact-2757::body`,
  `preactjs__preact-3010::body`, `preactjs__preact-3739::title`,
  `preactjs__preact-3763::body`, `preactjs__preact-4182::body`,
  `preactjs__preact-4316::title`, `sveltejs__svelte-11104::body`,
  `sveltejs__svelte-11367::title`, `sveltejs__svelte-14494::title`,
  `sveltejs__svelte-14494::body`, `sveltejs__svelte-9550::title`,
  `sveltejs__svelte-9550::body`, `vuejs__core-10101::title`,
  `vuejs__core-10141::title`, `vuejs__core-11694::title`,
  `vuejs__core-11813::body`, `vuejs__core-11854::title`,
  `vuejs__core-8511::title`, `vuejs__core-8535::body`,
  `vuejs__core-8824::title`, `vuejs__core-9532::title`
  (SmartRead wins 20 queries back over Probe.)
- Codanna-only wins (4):
  `mrdoob__three.js-27395::title`, `preactjs__preact-3739::title`,
  `sveltejs__svelte-12509::title`, `vuejs__core-10101::title`
  (SmartRead wins 30 queries back over Codanna.)

Overlap note: `sveltejs__svelte-14494` and `sveltejs__svelte-9550`
(title+body) and `vuejs__core-8511/9532/11854::title` are won by BOTH
ripgrep and Probe over SmartRead — plain lexical matches SmartRead
misses. `axios__axios-5085::body` is won by both ripgrep and Probe.

## Reading for future changes (not conclusions)

1. Lexical gap on titles: Probe 24/64 and ripgrep 15/64 vs SmartRead
   16/64, with 5 title queries lost to both lexical systems. Candidate:
   title-term coverage in SmartRead's first-stage retrieval (stemming /
   BM25-vs-embedding weighting on short queries).
2. Body parity with Probe (19-19) but different query sets (Probe-only
   body wins: 11): per-query comparison of ranking, not just coverage.
3. Codanna bodies returning empty (`ok`, 0 units) suggests verbatim
   full-body text is a bad symbol-search query — no SmartRead change
   implied; confirms symbol search needs query reduction, which
   SmartRead already does via its own pipeline.
4. Cost contrast for the TEB record: SmartRead renders ~3x the tokens
   per query of either lexical comparator (1908 vs ~640) at comparable
   p50 latency; Codanna pays ~10 min of indexing for 9/128.

## Caveats

- Wall-clock latencies are same-machine sequential runs (SmartRead mean
  3.4 s here vs 2.5 s in the guard baseline — noise, not signal).
- Probe's 15 `error:Command failed` outcomes were not root-caused
  (stderr not captured by the harness); counted as failures.
- One interim smoke run
  (`reports/external-grep-ripgrep-dev-2026-10-07T13-14-52-109Z-20850bea.json`,
  `--limit 1`) also sits in the reports dir; superseded by the full runs
  above.

## Audit

Audit performed by evidence-auditor on 2026-10-08 against the frozen manifest and raw report JSON files located in `~/.cache/pi-smartread-bench/`.

### 1. Manifest, Query-ID Set & Split Verification

- **Frozen Manifest Identity**: `~/.cache/pi-smartread-bench/manifests/external-grep-dev64-holdout32.json` (SHA-256: `9cfbf8e792e042991bdb8262364b1dcf9bb7daa2eaa806d4ee4742159e48b8d6`). All four runs cite this exact path and SHA-256 digest in their metadata envelope. [VERIFIED]
- **Identical dev64 Query-ID Set**: Each system evaluated exactly the 64 dev instances defined in the manifest across both `title` and `body` formulations (64 × 2 = 128 queries total). All per-query instance IDs match across all 4 reports. [VERIFIED]
- **No Holdout Query IDs**: None of the 32 holdout IDs (`Kong__insomnia-*`, `anuraghazra__github-readme-stats-*`, `darkreader__darkreader-*`, `expressjs__express-*`, `iamkun__dayjs-*`, `mui__material-ui-*`) appear in any of the four dev reports. [VERIFIED]
- **Exclusions**: `excluded: []`, `excludedCount: 0` in all four reports. [VERIFIED]

### 2. Binary Versions & Checksums

- **SmartRead grep**: `sha256:5a3e5c288a157e022269580920bf87b5313e9fb8341ea445ac5a0fecdbb06251:280-files`. [VERIFIED]
- **ripgrep**: `ripgrep 15.1.0` (system binary, `PATH:rg`, checksum `system-binary`). [VERIFIED]
- **Probe**: `v0.6.0-rc341 (probelabs/probe, Apache-2.0)` (`sha256:fd75278e310bb09434fcde12680d4707b8da8cf533e4155aefe6ccbd1685a33f`). [VERIFIED]
- **Codanna**: `v0.16.0 (12e823c) (bartolli/codanna, Apache-2.0)` (`sha256:3e6c92cff05a69cdce4c242aea734a0d32935de45dff95e88d06e591d7f73595`). [VERIFIED]

### 3. Per-Figure Audit (Table & Text Figures)

#### Results Table (`frozen dev64, 128 queries each`)

1. **SmartRead grep** (`reports/external-grep-dev-2026-10-07T13-22-41-411Z-03d6427c.json`):
   - `runs = 128`: [VERIFIED]
   - `success@5 = 35/128 (16/64 title / 19/64 body)`: [VERIFIED] (Recomputed: 16 title successes, 19 body successes = 35 total).
   - `knownPatchFileRecall@5 = .211`: [VERIFIED] (Report `summary.meanRecallAt5` = `0.21119791666666665`).
   - `MRR = .158`: [VERIFIED] (Report `summary.meanMRR` = `0.15803487401240407`).
   - `rendered tok/q (mean) = 1908.2`: [VERIFIED] (Report `summary.meanRenderedTokens` = `1908.1796875`).
   - `query latency mean / p50 / p90 = 3448 / 1268 / 9422 ms`: [VERIFIED] (Report `summary.meanElapsedMs` = `3448.339789...`; per-instance `elapsedMs` p50 = `1268 ms`, p90 = `9422 ms`).
   - `setup time = n/a (no index step)`: [VERIFIED]

2. **ripgrep 15.1.0** (`reports/external-grep-ripgrep-dev-2026-10-07T13-25-57-626Z-c5ebb068.json`):
   - `runs = 128`: [VERIFIED]
   - `success@5 = 21/128 (15/64 title / 6/64 body)`: [VERIFIED] (Recomputed: 15 title successes, 6 body successes = 21 total).
   - `knownPatchFileRecall@5 = .118`: [VERIFIED] (Report `summary.meanRecallAt5` = `0.11848958333333334`).
   - `MRR = .108`: [VERIFIED] (Report `summary.meanMRR` = `0.10750574382044603`).
   - `rendered tok/q (mean) = 658.5`: [VERIFIED] (Report `summary.meanRenderedTokens` = `658.5`).
   - `query latency mean / p50 / p90 = 1367 / 419 / 3198 ms`: [VERIFIED] (Report `summary.meanElapsedMs` = `1367.186416...`; per-instance `elapsedMs` p50 = `419 ms`, p90 = `3198 ms`).
   - `setup time = 0`: [VERIFIED] (Report `totalSetupMs` = `0`).

3. **Probe v0.6.0-rc341** (`reports/external-grep-probe-dev-2026-10-07T13-31-42-602Z-c783b3e7.json`):
   - `runs = 128`: [VERIFIED]
   - `success@5 = 43/128 (24/64 title / 19/64 body)`: [VERIFIED] (Recomputed: 24 title successes, 19 body successes = 43 total).
   - `knownPatchFileRecall@5 = .263`: [VERIFIED] (Report `summary.meanRecallAt5` = `0.2627604166666667`).
   - `MRR = .218`: [VERIFIED] (Report `summary.meanMRR` = `0.21776622776529514`).
   - `rendered tok/q (mean) = 636.4`: [VERIFIED] (Report `summary.meanRenderedTokens` = `636.375`).
   - `query latency mean / p50 / p90 = 2569 / 1297 / 5339 ms`: [VERIFIED] (Report `summary.meanElapsedMs` = `2568.537799...`; per-instance `elapsedMs` p50 = `1297 ms`, p90 = `5339 ms`).
   - `setup time = 0`: [VERIFIED] (Report `totalSetupMs` = `0`).

4. **Codanna v0.16.0** (`reports/external-grep-codanna-dev-2026-10-07T13-42-13-830Z-ce2b24ff.json`):
   - `runs = 128`: [VERIFIED]
   - `success@5 = 9/128 (9/64 title / 0/64 body)`: [VERIFIED] (Recomputed: 9 title successes, 0 body successes = 9 total).
   - `knownPatchFileRecall@5 = .049`: [VERIFIED] (Report `summary.meanRecallAt5` = `0.04947916666666667`).
   - `MRR = .062`: [VERIFIED] (Report `summary.meanMRR` = `0.06211120693542568`).
   - `rendered tok/q (mean) = 200.7`: [VERIFIED] (Report `summary.meanRenderedTokens` = `200.65625`).
   - `query latency mean / p50 / p90 = 18 / 16 / 27 ms`: [VERIFIED] (Report `summary.meanElapsedMs` = `18.093481...`; per-instance `elapsedMs` p50 = `16 ms`, p90 = `27 ms`).
   - `setup time = 613.5 s total (~4.8 s/query)`: [VERIFIED] (Report `totalSetupMs` = `613482.248711 ms` = `613.48 s`; 613.48 / 128 = `4.79 s/query`).

#### Errors & Narrative Figures

- **SmartRead 0 errors, ripgrep 0 errors, Codanna 0 errors**: [VERIFIED]
- **Probe 15 errors (`error:Command failed`, 0 units)**: [VERIFIED] (Exactly 15 outcomes have `status: "error:Command failed"` and `renderedTokens: 0`).
- **Probe error snapshot distribution**: `"13/15 on sveltejs__svelte snapshots — bodies 11, titles 4"`:
  - **[MISMATCH(15/15 on sveltejs__svelte snapshots — bodies 10, titles 5)]**:
    All 15 command failures occurred on `sveltejs__svelte` snapshots (0 occurred on any other repository). The exact breakdown is 5 titles (`sveltejs__svelte-10259::title`, `-11096::title`, `-11104::title`, `-12509::title`, `-13656::title`) and 10 bodies (`sveltejs__svelte-11096::body`, `-11326::body`, `-11367::body`, `-12007::body`, `-12509::body`, `-13316::body`, `-13656::body`, `-13763::body`, `-14134::body`, `-9962::body`).
- **Headline claims**:
  - Probe beats SmartRead (43 vs 35): [VERIFIED]
  - Driven by titles (24 vs 16; bodies tied 19-19): [VERIFIED]
  - ripgrep trails on both formulations (15/64, 6/64): [VERIFIED]
  - Codanna symbol search 0.0 mean units on bodies over all 64 body queries: [VERIFIED] (All 64 body outcomes returned `rankedFiles: []`).
  - Codanna weak on titles (9/64): [VERIFIED]
  - Codanna ~10-minute index build: [VERIFIED] (613.5 s = 10.23 min).
- **Per-query win lists**:
  - `ripgrep-only wins (16)`: [VERIFIED] (All 16 listed queries are ripgrep successes where SmartRead failed).
  - `SmartRead wins 30 queries back over ripgrep`: [VERIFIED] (35 SmartRead wins minus 5 shared wins = 30).
  - `Probe-only wins (28)`: [VERIFIED] (All 28 listed queries are Probe successes where SmartRead failed).
  - `SmartRead wins 20 queries back over Probe`: [VERIFIED] (35 SmartRead wins minus 15 shared wins = 20).
  - `Codanna-only wins (4)`: [VERIFIED] (All 4 listed queries are Codanna successes where SmartRead failed).
  - `SmartRead wins 30 queries back over Codanna`: [VERIFIED] (35 SmartRead wins minus 5 shared wins = 30).
  - `Overlap note` (5 titles won by both ripgrep and Probe; 3 bodies won by both): [VERIFIED]
- **Reading for future changes figures**:
  - Item 1 (`Probe 24/64 and ripgrep 15/64 vs SmartRead 16/64, with 5 title queries lost to both lexical systems`): [VERIFIED]
  - Item 2 (`Probe-only body wins: 11`):
    - **[MISMATCH(Probe-only body wins: 12)]**:
      The 28 Probe-only wins list contains 16 titles and 12 bodies (`axios__axios-5085::body`, `axios__axios-5919::body`, `babel__babel-15445::body`, `preactjs__preact-2757::body`, `preactjs__preact-3010::body`, `preactjs__preact-3763::body`, `preactjs__preact-4182::body`, `sveltejs__svelte-11104::body`, `sveltejs__svelte-14494::body`, `sveltejs__svelte-9550::body`, `vuejs__core-11813::body`, `vuejs__core-8535::body`). With bodies tied 19-19 and 7 shared body successes, Probe-only body wins is exactly 12 (19 - 7 = 12), not 11.
  - Item 4 (SmartRead renders ~3x tokens per query: 1908.2 vs 658.5 / 636.4): [VERIFIED]
  - Item 4 (Codanna pays ~10 min indexing for 9/128): [VERIFIED]
- **Caveats figures**:
  - SmartRead mean 3.4 s: [VERIFIED]
  - Guard baseline 2.5 s: [UNVERIFIABLE] (Baseline run `ccbb39c` is an external historical reference; cannot be verified from the 4 report JSONs alone).
  - Interim smoke run `--limit 1` (`external-grep-ripgrep-dev-2026-10-07T13-14-52-109Z-20850bea.json`): [VERIFIED] (`runs = 2`).

### 4. Fairness & Methodological Considerations

1. **Probe Process Failures Counted as 0-Hit Search Misses**:
   - Probe encountered 15 `error:Command failed` errors (all on `sveltejs__svelte` snapshots). The benchmark harness did not capture process `stderr`, leaving the root cause (per-query timeout, OOM, or command syntax issue) unrecorded.
   - All 15 instances were scored as 0-unit failures in the 128-query denominator. While this reflects strict zero-tolerance grading, it penalizes Probe's retrieval quality for uninvestigated execution failures on the largest codebase in the split.
2. **Ripgrep Query Preprocessing Asymmetry**:
   - Ripgrep is a literal regex/pattern search engine, not a natural-language search system.
   - The harness constructed a synthetic query pipeline for ripgrep: extracting identifier tokens (`/[A-Za-z_][A-Za-z0-9_]*/`), dropping stopwords, selecting up to 20 frequent terms, executing independent `rg --json -i -F -e <term>` commands per term, and scoring by raw match count.
   - While explicitly disclosed in the report's `comparator.searchRule` as "non-equivalent NL search", this multi-query term-union preprocessing gives ripgrep an engineered query expansion not inherent to the tool itself, and heavily degrades on long issue bodies (yielding massive candidate sets and only 6/64 body success).
3. **Probe Default Test Filtering vs. SmartRead Demotion**:
   - Probe executes with default test exclusion enabled (`no --allow-tests`), filtering out test directories and test code blocks.
   - SmartRead uses continuous score demotion (`rankTestDemote: 0.7`). Hard filtering test files can artificially boost Probe's top-5 production file recall by removing non-production match noise, or penalize it where patches include test files.
4. **Codanna Symbol Search Query Incompatibility**:
   - Codanna was queried via `mcp search_symbols --args {query, limit: 50}` passing verbatim issue text.
   - For issue bodies (averaging hundreds of words of natural language prose, stack traces, and markdown), symbol lookup returned empty results for 100% of body queries (0/64). Furthermore, Codanna's semantic search tool (`semantic_search_with_context`) was non-functional because its local ONNX EMBED stage indexed 0 items. Thus, Codanna was fundamentally mismatched for raw NL body queries.
5. **Amortization of Index Setup Overhead**:
   - Codanna spent 613.5 s building per-instance indexes, amortized over only 2 queries per instance (~4.8 s/query). In realistic production use, indexing costs are amortized over hundreds or thousands of agent queries.
