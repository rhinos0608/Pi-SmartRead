> **Correction 2026-10-07 (review P1s):** the 16:36 artifact below used one
> process for all cases (imports cached after the first case), so its "cold"
> samples are NOT fresh-process costs and its x4-derived caps are NOT stage
> budgets. That artifact is PRESERVED unchanged for auditability, but its
> numbers must be read as legacy-combined in-process observations only.
> Corrected fresh-process samples: `inspect-affordance-2026-10-07T16-52-42-066Z.json`
> (sha256 `d99bb2daf2303542ad5abf237dd9ebb106fa3ddd9158a57ce44343dd3ef6a47c`),
> report version 2. Corrected table in §"Corrected baseline (fresh-process,
> report v2)"; no before/after gain claim (nothing was optimized) and no
> p95 (n=1 cold per case, n=2 warm).

# Inspect resource baseline: source-size census + engine microbenchmarks

Date: 2026-10-07/08. Owner: inspect-affordance microbench worker.
Oracle: `6654f438-1436-4802-ab64-05ed70df3b3f_oracle_output.md` (approach 2 bundle;
construction-time budget contract required before agent pilot).

## Objective (non-objectives explicit)

- IN SCOPE: local source-size census of pinned TEB checkouts; reproducible
  baseline durations/resources for the CURRENT file/directory structural paths
  behind the five approved views (overview, dependencies, architecture,
  change-review, routes); projected candidate stage caps derived from
  observations for construction-time recipe budgets.
- OUT OF SCOPE: agent benchmarks, product optimization, before/after gain
  claims (no optimization ran), task/gold selection (source-witness
  selection must NOT use these measurements; scope/corpus inclusion stays
  source-defined independently), universal timeouts, p95 claims.

## Method and isolation

- Census: bounded `lstat` traversal of pinned originals; symlinks never
  followed; `.git`/`node_modules`/runtime-cache dirs skipped; 500k-file cap
  per repo. Pinned originals otherwise touched only by read-only
  `git rev-parse HEAD`. No gold/query file was opened (census reads
  directories + stat metadata only).
- Baseline: `executeFileInspect` / `executeDirectoryInspect` invoked directly
  (no CLI extension bootstrap, no embeddings, no indexing) with
  `cwd` inside fresh `mkdtemp` scratch copies, a temp session file in scratch,
  and NO `contextGraph` / LSP provider — structural paths only. Scratch dirs
  removed after each case. No writes to the developer checkout, pinned
  originals, or live user caches.
- Samples: `--cold-samples 1 --warm-samples 2` defaults. CORRECTED (report
  v2): cold = one independent FRESH child process per sample (own PID,
  engine modules imported per child; `importMs` recorded separately from
  `engineMs` and parent-measured spawn-inclusive `wallMs`); warm = repeats
  WITHIN one controlled child process. Children execute SEQUENTIALLY
  (benchmark only). Failed/timed-out child samples stay visible with
  `error`/`timeout` status, never dropped. SUPERSEDED (report v1, 16:36
  artifact): cold = first run in the shared parent process — imports were
  cached across cases, so those maxima are not fresh-process costs.
- View → flag mapping (`mapViewToFlags`, unit-tested): overview/file `{}`,
  overview/dir `{mapTokens:1024}`, dependencies/file
  `{callDepth:1,callDirection:"both"}`, architecture/dir
  `{layers:true,boundaries:true}`, change-review `{diff:"HEAD"}` (scratch git
  repo initialized + one dirtyed `.ts` file for a deterministic diff surface),
  routes `{routes:true}`.

## Exact invocations and versions

- `npx tsx scripts/eval/inspect-affordance/microbench.ts --census-only`
- `npx tsx scripts/eval/inspect-affordance/microbench.ts` (census + corrected fresh-process baseline)
- `npx vitest run test/unit/eval/inspect-affordance-microbench.test.ts` → 4 passed
- `npx vitest run test/unit/inspect/inspect-bounded-scope.test.ts` → 10 passed
- `npm run typecheck` → 7 errors, all in concurrent peer-owned files
  (`src/lsp/lsp-executor.ts`, `src/lsp/lsp-response-normalizer.ts`,
  `test/unit/lsp/response-normalizer.test.ts`); zero in owned files.
  (Earlier notes calling these "pre-existing baseline defects" were wrong:
  they are concurrent peer state, not baseline repo defects. Peer files
  were not touched.)
- Node v25.9.0 (PINNED actual benchmark runtime), npm 11.12.1,
  git 2.54.0 (Apple Git-157), pi-smartread 0.5.0, darwin.
  (CI pins Node 20; Node 20 numbers are explicitly UNVERIFIED and the
  maxima below do not generalize beyond the pinned runtime.)

## Frozen raw artifact (SUPERSEDED reading; preserved for audit)

- Path:
  `/Users/rhinesharar/.cache/pi-smartread-bench/reports/inspect-affordance-2026-10-07T16-36-12-285Z.json`
- sha256:
  `85f8ebd019d3947fc109b74e925b39cf1a7c9d3fbf4e5f96b5b7e469edd4f466`
- CORRECTED INTERPRETATION: legacy-combined IN-PROCESS observations, not
  fresh-process cold costs, not selective-view stage costs. Do not budget
  from this artifact.
- Census-only artifact (same method, baseline omitted):
  `.../inspect-affordance-2026-10-07T16-36-08-408Z.json`
  sha256 `60c6835c7a4fc4b39d8563a16034eacc6bde52142252830fe15be59b47fd025c`

## Census (pinned commits verified: 6/6 `git rev-parse HEAD` match)

| Repo | Files | Bytes | Supported (ts/tsx/js/jsx/mjs/cjs/py/go/rs) | Symlinks skipped |
|---|---|---|---|---|
| reactivex/rxjs@7.8.2 | 1,288 | 13,646,585 | 930 f / 3,895,851 B | 0 |
| prettier/prettier@3.9.9 | 9,331 | 24,084,747 | 5,771 f / 6,926,109 B | 0 |
| withastro/astro@astro@7.3.6 | 6,954 | 51,530,838 | 3,102 f / 8,503,216 B | 2 |
| TanStack/query@v5.90.3 | 1,837 | 23,864,378 | 868 f / 3,072,120 B | 33 |
| egoist/tsup@v8.5.1 | 81 | 10,130,450 | 48 f / 176,601 B | 0 |
| drizzle-team/drizzle-orm@0.44.7 | 1,372 | 18,151,088 | 966 f / 10,346,918 B | 0 |

No census truncation hit (caps not reached). Note: tsup's 10 MB over 81 files
is dominated by non-source bytes (supported TS is only ~177 kB) — recipe
scopes should budget on scoped files/bytes, not repo working-tree size.
`.d.ts` counted as supported TypeScript (JS→`.d.ts` declaration-resolution
convention per repos.json corpus notes).

## Baseline (v1 table, SUPERSEDED reading: legacy-combined in-process; NOT fresh cold, NOT selective-view stage costs)

| View/mode | Scope (scratch copy) | Scope size | Cold | Warm | Output | Status |
|---|---|---|---|---|---|---|
| overview/file | tsup `.` → `src/index.ts` | 81 f / 10.1 MB | 227 ms | 187 ms | 1,773 B | ok |
| overview/dir | tsup `src` | 34 f / 111 kB | 60 ms | 7 ms | 3,490 B | ok |
| dependencies/file | tsup `.` → `src/cli-main.ts` | 81 f / 10.1 MB | 249 ms | 243 ms | 1,097 B | ok |
| routes/file | tsup `.` → `src/index.ts` | 81 f / 10.1 MB | 197 ms | 188 ms | 1,820 B | ok |
| routes/dir | tsup `src` | 34 f / 111 kB | 41 ms | 10 ms | 3,525 B | ok |
| architecture/dir | query `packages/query-core/src` | 47 f / 559 kB | 191 ms | 18 ms | 7,230 B | ok |
| change-review/dir | tsup `src` (scratch git + 1 dirty file) | 34 f / 111 kB | 162 ms | 137 ms | 3,553 B | ok |

Setup (scope copy + optional git init/commit) is timed separately per case in
JSON (`setupMs`); module load is process-level, not per-case.

## Corrected baseline (fresh-process, report v2; parent-wall includes tsx spawn+import — see engine split)

- New artifact: `.../inspect-affordance-2026-10-07T16-52-42-066Z.json`
  sha256 `d99bb2daf2303542ad5abf237dd9ebb106fa3ddd9158a57ce44343dd3ef6a47c`
- 7/7 ok, 0 failed/timed-out samples; 14 distinct PIDs over 21 samples
  (7 cold x 1 fresh PID + 7 warm children x 2 repeats); no env/credential
  values in artifact (checked).
- Parent-wall is spawn-dominated (~700-1170 ms: `npx tsx` boot + engine
  import ~200-300 ms inside the child); the honest engine signal is the
  `engineMs` column. Warm parent-wall ≈ cold parent-wall for the same
  reason; warm engine repeats are the in-child signal.

| View/mode | Scope | Cold parent-wall (engine) | Warm parent-wall mean | Output | Seam routes-scan (isolated) |
|---|---|---|---|---|---|
| overview/file (tsup `src/index.ts`) | 81 f / 10.1 MB | 1052 ms (210 ms) | 1045 ms | 1,773 B | 7 ms |
| overview/dir (tsup `src`) | 34 f / 111 kB | 735 ms (68 ms) | 698 ms | 3,490 B | 5 ms |
| dependencies/file (tsup `src/cli-main.ts`) | 81 f / 10.1 MB | 953 ms (269 ms) | 1167 ms | 1,097 B | 7 ms |
| routes/file (tsup `src/index.ts`) | 81 f / 10.1 MB | 874 ms (215 ms) | 1051 ms | 1,820 B | 7 ms |
| routes/dir (tsup `src`) | 34 f / 111 kB | 765 ms (76 ms) | 731 ms | 3,525 B | 4 ms |
| architecture/dir (query `packages/query-core/src`) | 47 f / 559 kB | 955 ms (240 ms) | 783 ms | 7,230 B | 15 ms |
| change-review/dir (tsup `src`, scratch git + 1 dirty file) | 34 f / 111 kB | 901 ms (212 ms) | 1023 ms | 3,553 B | 5 ms |

Setup (scope copy + optional git init/commit) is timed separately per case
in JSON (`setupMs`); engine import is per-child (`importMs` in JSON).
Every directory row above is a LEGACY COMBINED baseline (includes baseline
repo-map work) — NOT a selective-view stage cost. The only isolated
selective-view constituent measured is the routes `scanRoutes` seam.
No before/after product-gain claim: nothing was optimized. No p95: n=1
cold, n=2 warm per case.

## Provisional safety caps (census-derived, NOT frozen budgets)

From census maxima (9331 files, 51,530,838 B working tree):
`maxFilesPerScope=9331, maxBytesPerScope=51530838` (recorded as
`provisionalCaps` in the v2 artifact). Provisional engineering limits
only — NOT experimentally proven defaults. No wall-time budget is set
from these observations, and no budget freeze for graph/selective views
may be built on them until those stages are measured in isolation.

## Cancellation / admission feasibility

- Feasible today: per-stage file/byte/output caps and wall-time admission
  checks BEFORE work (all inputs to the check are known: scope file list,
  `mapTokens`, flag set). File/directory structural sections already degrade
  to unavailable without a graph rather than hanging.
- Unknown / not demonstrated: whether graph construction + full-directory
  traversal honor mid-flight cancellation and propagate it through sequential
  gather stages (oracle §"bounding investigations" requires this). The
  current engine entry points accept `signal?: AbortSignal`, but no
  cancellation-under-load run was performed here.
- Policy: no uncancellable full-graph fallback may ship as a default. If a
  recipe stage cannot expose bounded traversal + cancellation, that stage is
  blocked pending engine work — do not silently widen to "scan everything".

## Explicitly unmeasured (do not budget from this baseline)

1. Call-graph-backed sections (callers/callees BFS, impact blast radius,
   hotspots fan-in): no `contextGraph` was built, so these degraded; graph
   construction cost unknown.
2. Script-mode composition, LSP navigation/diagnostics, embeddings/indexing:
   not invoked; costs unknown.
3. Full-repo HEAD diff on large corpora; change-review ran on a 34-file
   scratch repo only.
4. Node 20 / Linux / Windows numbers (measured here: macOS, Node 25).
5. Anything resembling p95, steady-state throughput, or pilot agent behavior.

## Residual risks / next steps

- Re-run under Node 20 (CI version) and, if pilot targets differ, on Linux;
  confirm numbers before freezing recipe defaults.
- Measure graph-construction cost and cancellation propagation in isolation
  before any gather recipe depends on them.
- Keep task/gold selection source-defined; this baseline must not leak into
  corpus inclusion decisions.

## Superseded v1 worker report — historical, not accepted evidence

The report below belongs to the withdrawn in-process v1 measurements. Its
“cold” timings, projected ×4 caps, and acceptance claims are invalid for
budgeting. Peer-file typecheck errors were concurrent work, not established
pre-existing defects. Use the fresh-process v2 results and provisional caps
above; this historical report does not override them.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Only 3 new files owned (script, unit test, this doc); git status shows no modifications to other source/plan files by this worker"
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "Frozen raw JSON artifact path+sha256 recorded above; census table (6/6 pins match) and raw per-case timings reproduced from artifact; test 3 passed; typecheck shows zero errors in new files"
    }
  ],
  "changedFiles": [
    "scripts/eval/inspect-affordance/microbench.ts",
    "test/unit/eval/inspect-affordance-microbench.test.ts",
    "docs/plans/2026-10-08-inspect-resource-baseline.md"
  ],
  "testsAddedOrUpdated": [
    "test/unit/eval/inspect-affordance-microbench.test.ts"
  ],
  "commandsRun": [
    {
      "command": "npx tsx scripts/eval/inspect-affordance/microbench.ts --census-only",
      "result": "passed",
      "summary": "6/6 pins match, no truncation"
    },
    {
      "command": "npx tsx scripts/eval/inspect-affordance/microbench.ts",
      "result": "passed",
      "summary": "7/7 baseline cases ok, artifact sha 85f8ebd0..."
    },
    {
      "command": "npx vitest run test/unit/eval/inspect-affordance-microbench.test.ts",
      "result": "passed",
      "summary": "3 passed"
    },
    {
      "command": "npm run typecheck",
      "result": "failed",
      "summary": "7 pre-existing errors in peer-owned lsp test files; zero in new files"
    }
  ],
  "validationOutput": [
    "census: rxjs 1288f, prettier 9331f, astro 6954f, query 1837f, tsup 81f, drizzle 1372f; all pins match",
    "baseline max cold 249ms (dependencies/file), max output 7230B (architecture/dir)",
    "projected candidate caps: 324 files / 40521800 B / 28920 out-B / 998ms per stage (x4 headroom)"
  ],
  "residualRisks": [
    "Measured on macOS Node 25; CI Node 20 + Linux/Windows numbers still needed before freezing pilot budgets",
    "Graph construction cost and mid-flight cancellation unmeasured — blocked for gather recipes pending engine work",
    "npm run typecheck fails repo-wide from pre-existing peer-file errors (untouched by this worker)"
  ],
  "noStagedFiles": true,
  "diffSummary": "new microbench script + unit test + baseline doc; no edits to existing files",
  "reviewFindings": [
    "no blockers in new files: typecheck clean for owned paths, scratch isolation verified, no network/credential access"
  ],
  "manualNotes": "Raw artifacts live in ~/.cache/pi-smartread-bench/reports/ (not committed). Did not commit anything. Never staged files; confirm with git status."
}
```
