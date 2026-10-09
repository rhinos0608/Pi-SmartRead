# Inspect peer plan (oracle-contract implementation)

Date: 2026-10-08. Authority: oracle `6654f438…_oracle_output.md` (approach 2 bundle);
resource numbers: `docs/plans/2026-10-08-inspect-resource-baseline.md` + raw artifact
`~/.cache/pi-smartread-bench/reports/inspect-affordance-2026-10-07T16-36-12-285Z.json`
(sha256 `85f8ebd0…`). This plan is design + contract only; it changes no runtime.

## 1. Scope contract

Views: `overview | dependencies | architecture | change-review | routes`.
Fixed gather recipes: one per view (`gather:true` selects the view's recipe, no other knob).
Modes: `file | directory` explicit; script mode unchanged and separate.

Compatibility matrix (reject before work, never silently repair):

| view | file | directory | required | rejected |
|---|---|---|---|---|
| overview | yes | yes | — | view+analysis, view in script mode |
| dependencies | yes | no | — | same + directory |
| architecture | no | yes | — | same + file |
| change-review | yes | yes | `diff: unstaged\|staged\|HEAD` | missing diff, view+analysis, script |
| routes | yes | yes | — | view+analysis, script |

`view` XOR `analysis`; `view` in script mode is a caller error. Keep explicit
filesystem-type checks (file view on directory path and vice versa = error).

Selector: `PI_SMARTREAD_INSPECT_AFFORDANCES`, captured once at construction
(factory/env read at tool-build time, frozen for the session):

| inspect selector | `PI_SMARTREAD_AFFORDANCES` (existing, frozen) | behavior |
|---|---|---|
| on | either | complete inspect bundle; full-inspect-on **supersedes** routes-only WP-C |
| off | on | existing WP-C routes-only surface (unchanged) |
| off | off | existing baseline (unchanged) |

Exactly one schema + guidance variant + dispatcher + inspect-action emitter per
selector value. Never concatenate routes-only and full-bundle guidance or
partially activate gathering. Freeze `PI_SMARTREAD_AFFORDANCES=0` (i.e. existing
general/LSP affordance state = off) across all inspect benchmark arms; vary only
the inspect selector + diagnostic prompts. Record effective selectors, build
identity, schema hash, guidance hash per run.

## 2. Typed exports (new files only)

- `src/inspect/inspect-task-contract.ts` — `InspectTaskView`, `GatherRecipe`,
  `InspectBudget` (stage count, candidate count, scanned files/bytes,
  corroboration files, wall ms, output bytes), field-compat matrix, coverage and
  error taxonomy, stage-record type, admission-check function signature.
- `src/inspect/inspect-task-views.ts` — `executeTaskView(input)`: isolated
  execution per view; builds only constituent sections, never the baseline
  map/signals pipeline by default; canonical requested scope (fixes legacy cwd
  boundary — §6, opt-in path only).
- `src/inspect/inspect-structural-gather.ts` — `runGatherRecipe(view, budget)`:
  fixed stages (candidates → deterministic-order corroboration targets → source
  checks → corroborated relations + unresolved + followups); sequential stages,
  cancellation propagation, per-stage records (args, derivation, status,
  observed files/bytes/ms/output).

Output statuses per section/stage: `ok | partial | unavailable | unsupported | failed`.
Per-section record: canonical scope, relation kind, inspected/displayed counts,
omissions, unresolved resolutions, failures, sampling/truncation reason, coverage
(`complete | partial | unknown` within declared supported scope), citations
(source path + range or manifest specifier + resolution rule). Failed stages stay
visible; partial never renders as exhaustive success; unknown counts stay unknown.

## 3. REAL source seams (reuse, no duplicates)

Selective-view execution must reuse, not reimplement:

- Dispatch: `src/inspect/inspect.ts` (`executeInspectV4`), `src/inspect/inspect-file-core.ts`
  (`executeFileInspect`), `src/inspect/inspect-directory.ts` (`executeDirectoryInspect`).
- Section builders: `src/inspect/inspect-file-sections.ts`,
  `src/inspect/inspect-directory.ts` (directory builders), `src/inspect/inspect-diff.ts`
  (`runGitDiff`, `renderDiffSection`).
- Budget/admission/evidence: `src/inspect/inspect-budget.ts` (token admission,
  evidence auth), `src/inspect/inspect-runtime.ts` (canonical/range/token/callgraph
  helpers), `src/inspect/inspect-mode-contract.ts` (mode twins / rejection rules).
- Routing-relevant sources: `src/inspect/route-extraction.ts` (registration matching),
  `src/repository/layer-analysis.ts` (heuristic layers), `src/inspect/inspect-tool.ts`
  (flat root schema + `rejectForeignKeys`-style runtime rejection, lines ~98–125, 301–325).
- Recognition: existing pure recognition/action seam (bounded classification,
  abstention on ambiguity; prefill observed paths/ranges/diff targets only; keep
  action/hint caps + suppression). No new classifier, planner, or per-view feature
  switches. No duplicate registries.

Deep helper seams to reuse for corroboration: source import/re-export statement
readers behind file sections, manifest readers behind boundaries, diff-range
helpers in `inspect-diff.ts`. Gather recipe step 3 checks actual specifiers with
recorded resolution conventions — a graph edge is a hypothesis, never corroboration.

## 4. Admission budgets + cancellation (provisional; NO frozen defaults)

Baseline (small-scope, structural-only, no graph/LSP/embeddings; pinned
Node v25.9.0 on darwin — Node 20 / Linux / Windows explicitly unverified):
max cold parent-wall 1052 ms with engine-max 269 ms (`dependencies/file`),
max output 7230 B (`architecture/dir`), 7/7 ok, 0 failed samples, report v2
artifact `inspect-affordance-2026-10-07T16-52-42-066Z.json`
(sha256 `d99bb2da…`). Directory rows are LEGACY COMBINED (baseline
repo-map work included) — NOT selective-view stage costs. The only
isolated selective-view constituent measured is the routes `scanRoutes`
seam (4–15 ms on the small scopes). Census: rxjs 1288 f … prettier
9331 f (largest file count), astro 51.5 MB working tree, drizzle 10.3 MB
supported bytes (largest supported-bytes scope).

Provisional census-derived safety caps (engineering starting points, NOT
experimentally proven defaults, NOT frozen stage budgets):

```
maxFilesPerScope = 9331
maxBytesPerScope = 51_530_838
```

No wall-time budget is set from these observations. NO BUDGET FREEZE for
graph/selective views until those stages are measured in isolation
against reusable exported functions. The earlier max-observed-x4
"frozen" table (maxWallMsPerStage=998 and friends) is WITHDRAWN — it
was derived from in-process samples whose imports were cached across
cases, and wall time may not be frozen from such observations.

Admission checks run BEFORE work. Count admission (`checkScopeAdmission`
in `src/inspect/inspect-bounded-scope.ts`) decides on file/byte counts
before anything is consumed. Scope enumeration itself is bounded by
`enumerateBoundedScope` (unit-tested: dir/entry/depth/file/byte caps,
realpath+lstat, incremental `opendir` iteration, symlinks never followed,
cooperative cancellation with BEFORE/AFTER signal checks, deadline,
`complete` only on actual full traversal — otherwise `partial`/`unknown`
with explicit reasons). Over-budget scopes are refused with `partial` +
followup (scoped sub-path), never silently widened. Bounded-source
fallback vs pending graph stage: recipes run on the bounded admitted
universe; any stage whose real shared builder (ContextGraph) cannot obey
mandatory file/byte/wall bounds or `AbortSignal` mid-flight returns
`unsupported` (blocked pending engine work) — propose bounded
partial/unsupported outcomes, never claim a hard deadline over a
blocking operation, never fall back to an uncancellable full-graph scan. File/directory sections already degrading to
`unavailable` without a graph keep that behavior.

## 5. Corroboration, import proofs, honesty rules

- Dependency relations: cite importing-file path+range, literal specifier, and
  recorded resolution rule (relative / workspace alias / manifest-declared).
  Unresolved aliases stay `unresolved` with reason.
- Architecture relations: cite workspace declarations + manifests and source
  import relations; layers/clusters are heuristics (naming/import), never stated
  as architectural fact.
- Routes: supported-source registrations/convention matches with path+range;
  never claim mounted runtime endpoints.
- Zero-caller (deadCode) output is a candidate list, not safe-deletion proof.
- Never silently omit: fs errors, symlink scope gaps (lstat, never follow;
  census found 33 skipped in query, 2 in astro), unsupported syntax, unresolved
  aliases, failed reads. Absence claims require complete supported-scope
  enumeration; otherwise coverage is `partial`/`unknown`.
- All gathering metadata, corroboration records, and advisory actions are
  discovery-only evidence. Focused `read` of rendered source is the sole path to
  strong evidence. Pi wording: recommend focused `read`. MCP wording: host reader
  in prose only; no read actions (MCP exposes no read), no SmartEdit-authority claim.
- `src/runtime/tool-guidance.ts` stays the single Pi+MCP wording authority;
  replace selected inspect guidance, do not append duplicates; keep advisory text
  out of evidence/scoring regions. No graph-as-gold claims anywhere (oracle
  scout-correction: depth-1 imports cannot validate transitive impact; top-15
  display limits never define gold).

## 6. Legacy fixes — opt-in path only

1. Directory boundary rendering uses cwd instead of requested scope
   (`inspect-directory.ts:262–264,378–380`): fix to canonical requested scope in
   the new task-view path only; legacy `analysis` path untouched.
2. Routes silently omit failed reads/directories + symlinks
   (`route-extraction.ts:28–33,202–235`): surface as omissions/failures with
   counts in the new path only; legacy path untouched.
3. Graph impact top-15 vs fallback top-20 display
   (`inspect-file-sections.ts:125–128,175–177`): report inspected/displayed
   counts + truncation reason; never treat display cap as universe.

## 7. Ownership (disjoint files; anchor worker owns the rest)

New-plan files (this worker): `docs/plans/2026-10-08-inspect-peer-plan.md` (this doc).
Implementation files (codebuild stages §8): `src/inspect/inspect-task-contract.ts`,
`src/inspect/inspect-structural-gather.ts`, `src/inspect/inspect-task-views.ts`,
`src/inspect/inspect-bounded-scope.ts` (DONE + unit-tested: bounded scope
enumerator + count admission; no tool integration, no graph build),
plus scoped additions inside `src/inspect/inspect-tool.ts` + factories/registration/
guidance/MCP wiring (integration stage only).

Do NOT touch: `src/lsp/**` (anchor worker), old bundle plan/log docs, `src/inspect/route-extraction.ts`
(WP-C owner), shared classifier/actions (recognition owner), frozen TEB / eval
protocol / cohort config (ergonomics owner). Max 2 codebuild workers concurrently;
integration stage is the sole owner of `inspect-tool.ts`/runtime wiring/guidance.

## 8. Codebuild stages (each independently testable)

- S1 contract: `inspect-task-contract.ts` — view/mode compat matrix, budget type +
  admission check, coverage/error taxonomy, recipe + stage-record types. Tests:
  compat accept/reject table, admission over/under budget, record-shape.
- S2 views: `inspect-task-views.ts` — isolated per-view execution + canonical
  requested scope on the new path. Tests: per-view section allowlist (no baseline
  map leakage), scope-correctness (requested dir, not cwd), `diff`-required,
  view-XOR-analysis, no-script-view errors.
- S3 gather: `inspect-structural-gather.ts` — fixed recipes, deterministic order,
  sequential cancellable stages, admitted-universe scoping, partial/unsupported
  outcomes. Tests: recipe determinism, cancellation propagation, over-budget
  refusal, unresolved-alias surfacing, no full-graph fallback.
- S4 integration (sole wiring owner): selector capture at construction, schema/
  dispatcher/guidance variant selection, `PI_SMARTREAD_AFFORDANCES=0` freeze
  handling, Pi+MCP guidance replacement, README/skills updates. Tests: selector
  composition matrix (§1), off-mode snapshots (schema/text/details/errors),
  guidance-hash divergence, MCP no-read-actions.

Defaults (budgets §4 provisional values, bundle on/off) are selected only after S4
verification + Node 20 re-run + isolated selective-view/graph measurement +
audited benchmark; this plan ships no default flip and NO budget freeze.

## 9. Requirements → tests

| # | Requirement (oracle §) | Test (stage) |
|---|---|---|
| R1 | view XOR analysis; no script views; diff required for change-review | S2 compat table: accept 7 legal combos, reject view+analysis, script+view, change-review-without-diff, dependencies/dir, architecture/file |
| R2 | views run only constituent sections | S2 isolation: dependencies/file emits no repo-map/cluster/layer sections; architecture/dir emits no call-graph sections |
| R3 | canonical requested scope (not cwd) | S2 scope test: directory view on sub-path reports that path as canonical scope |
| R4 | exactly one construction-time selector; supersede/retain/baseline rows | S4 composition: on/either→full; off/on→routes-only; off/off→baseline; single guidance variant each |
| R5 | freeze general/LSP state off across arms; shared-helper reuse changes nothing | S4: arms differ only in inspect selector; LSP/generic snapshots unchanged |
| R6 | admission budgets before work; concrete §4 values | S1+S3: over-files/bytes/output/wall refused pre-work with partial+followup |
| R7 | sequential cancellable stages; graph honors bounds+signal else unsupported | S3: abort mid-recipe stops subsequent stages; unbounded-builder stub → `unsupported`, no silent scan |
| R8 | import proofs with specifier+resolution; layers/clusters heuristic-labeled | S3: corroborated relation carries path+range+specifier+rule; layer output carries heuristic disclaimer |
| R9 | no silent omissions (fs/symlink/syntax/alias/reads); absence only on full enumeration | S2+S3: injected read failure + symlink + unresolved alias all surfaced; empty result with incomplete enumeration → coverage partial/unknown |
| R10 | discovery-only gathering; Pi read / MCP host-reader wording; guidance authority | S4: evidence regions contain no advisory actions; MCP guidance has zero read-action references; `tool-guidance.ts` single-source |
| R11 | legacy fixes opt-in only | S2: legacy analysis path snapshots unchanged; new path shows scope fix + route omission counts |
| R12 | no duplicate registries / per-view switches / caches / concurrency without need | Review gate: S2–S4 diffs reuse §3 seams; no new cache, thread, dep, or feature flag |

Verification commands (run narrowest first; same order per stage):

```
npx vitest run test/unit/inspect/<new-test>.test.ts
npm run typecheck
npm test   # before closing S4 / any broad runtime change
git status --short   # expect only owned files; no staged files
```

Blockers remaining (real, not TBD-budgets): (a) re-run microbench under CI Node 20
(+Linux if pilot differs) — current maxima are pinned Node v25.9.0/darwin
and do NOT generalize; no budget freeze until then; (b) isolated graph-construction cost +
mid-flight cancellation measurement — gather stages depending on graph stay
`unsupported` until proven (bounded-source fallback in §4 applies meanwhile);
(c) repo-wide typecheck currently fails on concurrent peer-owned
`src/lsp/*` + `test/unit/lsp/*` errors (untouched; zero errors in owned files required).

The full approved inspect program is retained: gathering stays a
first-class stage with bounded-source fallback now and graph-backed
corroboration when (b) is proven. Nothing in this plan silently drops
gathering as a permanent unsupported feature.
