# Retrieval holdout v2 — preregistration (A5 vs A0, run once on the sealed holdout)

**Status: PREREGISTRATION — to be frozen BEFORE any holdout arm runs and before
the holdout manifest is unsealed/opened.** Study owner approval: owner decision 1
below ("approved"). Analysis + simulation live in
`scripts/stats/retrieval-holdout-v2.ts` (deliberately outside `src/**` and
`scripts/eval/**` so the frozen V2 engine hash is untouched); unit tests in
`test/unit/stats/retrieval-holdout-v2.test.ts`.

## 0. Order of operations (recorded for audit)

1. This document's claims, estimand, test, guardrails, reporting, run protocol,
   **and the simulation PASS criteria (§6.1) were written first** — timestamp of
   this writing: 2026-10-09T00:50:30Z — **before the simulation was executed**.
2. Analysis/simulation script written (`scripts/stats/retrieval-holdout-v2.ts`).
3. Simulation executed; results appended to §6.3 (same session, after step 1).
4. Script sha256 computed and recorded in §7 (before any unsealing).
5. Only then: holdout freeze (if not yet frozen), unsealing, and the single
   A0 then A5 run (§5).

The PASS criteria in §6.1 were therefore fixed in this file prior to any
simulation output existing. Results in §6.3 were appended afterwards and no
criterion was edited after execution.

## 0.1 Owner decisions (verbatim; binding)

1. "Retrieval holdout v2 study A5 vs A0, run once on the sealed holdout:
   approved."
2. "Conditional approval. Use weighted success@5 with G−2L. Primary paired
   instance-level t-test, subject to simulation validation. Retain hard
   guardrails and report repository heterogeneity."
3. "Conditional approval. Preregister one challenger per model using the pilot.
   Apply Holm across three tests. Assess power and cost."
4. "Approve. Retain 6:1 and τ=0.40. Separate future calibration by model and
   method."
5. "Conditional approval. Isolate transport failures, preserve valid retries,
   and forbid unplanned complete-case exclusions."

**Scope mapping:** decisions 1, 2, 5 govern this preregistration. Decision 3
(one challenger per model, Holm across three tests) belongs to the separate
challenger/pilot program, not this single-test study — recorded here verbatim,
not applied. Decision 4 (6:1, τ=0.40 — judge calibration) is retained for the
judge track; this study runs with the judge OFF, so 6:1/τ=0.40 do not apply
here; "separate future calibration by model and method" is noted for future
work.

## 1. Claim (a)

**NEW v2 study.** On the sealed retrieval holdout (engine V2, judge off, all
other knobs default, single run each), does arm **A5** (BM25 `b=0.5` +
coverage) improve weighted success@5 (G−2L utility) over arm **A0** baseline?

- Exact A5 knobs (from `docs/plans/2026-10-09-retrieval-matrix-results.md` §2,
  the frozen A5 set): env
  `PI_SMARTREAD_GREP_RANK_BM25=1.2,0.5` (k1=1.2, b=0.5) and
  `PI_SMARTREAD_GREP_RANK_COVERAGE=1`; every other
  `PI_SMARTREAD_GREP_RANK_*` unset (defaults; test demote 0.7).
  A0: no `PI_SMARTREAD_GREP_RANK_*` env set (all defaults, test demote 0.7).
- Engine: V2 freeze hash
  `sha256:e5fad8375eb02281e2b29ab9b12136d756b9f0a8f03f8ccfe94c95e9ea74ca4e:281-files`
  on both arms (checked before/after, §5). Judge: off (`judge.config=off` /
  `judge="off"`, judge invocations must be 0).

Plainly disclosed, as required:

- This is a **NEW v2 study**; it does not revive or override the selection
  program.
- **E18's failure stands:** no arm passed the frozen E18 selection gate
  (`2026-10-07-tool-ergonomics-decision-log.md` E18; matrix results §5: "No arm
  passes the E18 gate … the holdout is not opened and defaults stay"). This
  study runs only because the owner explicitly approved it as a new study
  (decision 1); it does not claim a champion was crowned.
- **A5 was chosen after inspecting screening data** (the dev matrix: A5 was the
  best arm on the screening sets — e.g. L1 67/96, L4 47/128). The holdout
  estimate may therefore be optimistic relative to the dev effect (winner's
  curse); power at 50% shrinkage is simulated (§6.2).
- **No backup arm:** A5 is the only challenger; if it fails, defaults stay and
  the miss is never retuned (E15 "a miss is never retuned").
- **The result will be published regardless of outcome** (confirm or miss).

## 2. Unit and estimand (b)

- Formulations per instance: f ∈ {title, body} (holdout instances carry both a
  title query and a body query).
- Per formulation outcome: success@5 ∈ {0,1} for each arm.
- Instance×formulation difference: `d_if = success@5(A5) − success@5(A0)` ∈
  {−1, 0, 1}.
- Weighted utility (owner's G−2L: a win counts +1, a loss counts −2):
  `u_if = d_if if d_if ≥ 0 else 2·d_if` (so u_if ∈ {1, 0, −2}).
- Instance-level: `u_i = mean(u_if over formulations present)`. With both
  formulations present u_i ∈ {−2, −1.5, −1, −0.5, 0, 0.5, 1}.
- **Primary estimand:** μ = E[u_i] over holdout instances (instance-weighted).
  H0: μ ≤ 0; H1: μ > 0.

**Missing formulation:** if exactly one formulation is validly present for an
instance, `u_i` is the mean over the formulations present (i.e. `u_if` for the
single valid formulation). If neither formulation is validly present, the
instance is invalid and excluded by the pre-run validity check below (never by
results).

**Allowed exclusions (exhaustive, fixed here, before any arm result is seen):**

1. **Pre-run validity failures only:** instances that fail the pre-run validity
   check — base-commit materialization failure, missing/absent gold at base,
   `manifest-id-unresolved`, `pin-mismatch`, empty/absent title or body query
   bytes — recorded by the runner's exclusion receipts **before either arm's
   results are examined**, and the exclusion set is **identical for both arms**
   (paired set fixed pre-run). An instance failing one formulation but not the
   other stays in with the surviving formulation (above).
2. **Transport/infrastructure failures** (owner decision 5): transport failures
   are isolated as a predeclared infrastructure class — never scored as
   retrieval outcomes, never silently dropped: each is retried under the frozen
   retry budget (§5), and **valid retries are preserved** (a retry that completes
   is a legitimate result and is kept). An instance still missing after the
   retry budget is disclosed per arm with artifacts.
3. **No unplanned complete-case exclusion (owner decision 5):** after both arms
   complete, the paired instance set is whatever survived the *pre-run* check;
   excluding any further instance from the primary analysis because of its
   outcome is forbidden. If post-run attrition occurs, the primary set is
   reported alongside a worst-case sensitivity (every attrited instance scored
   as an A5 loss, u = −2); any attrition is a protocol deviation reported
   loudly.

## 3. Primary test (c)

- **One-sided paired instance-level t-test** on the instance utilities u_i:
  H0: μ ≤ 0 vs H1: μ > 0, **α = .05**, df = n−1 (n = instances in the paired
  analysis set).
- **Margin: 0.** No frozen non-inferiority/superiority margin exists anywhere in
  E15/E16/E18 — none is invented here. (Open owner question, §8: confirm
  margin = 0.)
- Report the **one-sided 95% lower confidence bound**:
  `LB = ū − t_{0.95, n−1} · s/√n`.
- **Confirm iff LB > 0 AND every hard guardrail in §4 holds.** Otherwise the
  result is a MISS: defaults stay, no retuning, published regardless.
- The t-test is frozen as primary **only after passing the simulation
  validation in §6** (owner decision 2, "subject to simulation validation").
  **Resolution recorded in §6.4:** the t-test did NOT pass; the frozen primary
  is the stratified bootstrap-t validated under the pre-written §6.1 rule.
  Everything else in §3 (estimand, α, margin 0, one-sided LB reporting, confirm
  rule shape) is unchanged.

## 4. Hard guardrails (d) — retained from E15/E18/E16

E18 gate (verbatim, from `2026-10-07-tool-ergonomics-decision-log.md` E18,
"written before any arm runs"):

> **Gate** (exactly as E15, not relaxed): net success gain ≥ +2 on the fresh
> cohort AND net file-hit gain ≥ +2 on internal-44; ≤ 1 previously successful
> query lost per set/formulation (fresh cohort, internal-44, D46 dev, dev64
> titles, dev64 bodies); no net read-ready regression on any set; no increase in
> absence false-content or exact_ish losses; no unexpected judge invocation.
> **Champion tie-break:** largest fresh-cohort net gain → fewest total lost
> queries → fewest knobs → lowest mean rendered tokens. If no arm passes, no
> champion: the holdout is not opened and defaults stay.

Hard guardrails retained for the holdout study, each with its evaluation site:

| # | Guardrail | Evaluated on the holdout? | How / where evaluated |
|---|---|---|---|
| G-A | **Absence false-content not increased** | **No — external holdout has no absence class** | Already evaluated on screening sets (fresh cohort absence queries, D46 dev absence; results doc G5: A5 no increase, L1 16=16, L3 8=8). Not re-evaluable on the holdout; a run-time absence on a holdout instance is a validity failure (§2), not an absence-class probe. |
| G-B | **No exact_ish losses** | **No — external reports carry no exact_ish field** | Evaluated on screening sets (fresh cohort, D46 dev): A5 exact_ish losses vs A0 = 0 (results doc G5). Recorded as previously evaluated; not re-evaluable on holdout. |
| G-C | **No unexpected judge invocation** | **Yes** | Judge off on both arms; report receipts must show judge invocations = 0 (L1/L3-style `judgeInvoked` / L2-style `judgeUsage` / L4 `judge="off"` equivalents). Any invocation → fail. |
| G-D | **No net read-ready regression** | **No — external L4 reports have no read-ready field** (results doc §5 not-evaluable #1) | Retained on the sets that measure it (fresh cohort, internal-44, D46 dev) — screening evidence: A5 read-ready ≥ A0 on all three (results doc G4: 28≥24, 6≥5, 8≥8). Recorded as previously evaluated; not evaluable on holdout. |
| G-E | **E16 frozen confirmation clause** (verbatim): "add to the confirmation gate that the champion's title delta is non-negative in at least two repos (E15 'gains confined to one repo' stop rule made concrete)." | **Report only** (owner decision 2026-10-09, §8.1) | Per-repo title (title-formulation) net delta of A5−A0, and whether it is ≥ 0 in at least two repositories, computed from the per-repo table in §4.1 and reported with the leave-one-repo-out analysis. Not a gate. |
| G-F | **E15 loss veto**: "≤ 1 previously successful query lost per set/formulation" applied to the holdout's sets (= holdout titles, holdout bodies) | **Report only** (owner decision 2026-10-09, §8.1) | Instances successful under A0 but not A5: count and ids per formulation, and whether each count is ≤ 1, are reported (§6 Reporting). Not a gate: losses are already penalised ×2 in the G−2L primary. |
| G-G | **No transport-induced asymmetry / unplanned complete-case exclusion** (owner decision 5) | **Yes** | §2 exclusions; paired set identical across arms; any post-run attrition disclosed + worst-case sensitivity. |

E15 also froze "confirmation also needs a positive paired 95% CI on titles".
Owner decision 2 supersedes the primary confirm rule with the weighted G−2L
instance-level test (§3); E15's title-CI is reported, not gated (owner
decision §8.1).

### 4.1 Repository heterogeneity reporting (e)

Reporting, not gating (G-E is report-only per the §8.1 owner decision):

- Per repository: n, mean u, W/L/T (win = d=+1, loss = d=−1, tie = d=0, over
  both formulations pooled and per formulation), title-formulation net delta.
- **Cluster-robust (repo-clustered) SE** for μ with the few-clusters caveat
  (5 repos; sandwich SE with n_g−1 small-sample correction is downward-biased
  here — reported as a sensitivity, never as the primary test).
- **Leave-one-repo-out:** μ and the t-test re-computed five times, each omitting
  one repository; all five reported.

## 5. Run protocol (g)

1. **Freeze first:** the holdout manifest is frozen (freezer
   `scripts/eval/external/grep/freeze-instance-holdout.ts --run-freeze`,
   E16 decision n=400 + reserve) only after this prereg is frozen; manifest
   path/sha256 recorded via `ls`/`shasum` only — **instance ids, gold, patches
   and snapshots are never read by this document or by the analysis script.**
   *(Freeze status at prereg time: NOT YET FROZEN — no
   `external-grep-retrieval-holdout.json` under
   `~/.cache/pi-smartread-bench/manifests/`; only the three historical dev
   manifests exist. Verified by `ls`, contents never printed.)*
2. **Owned state root, offline:** every arm runs in a **freshly claimed**
   owned state root (`--state-root <new dir>` + ownership marker,
   `2026-10-08-retrieval-owned-roots.md`), `--offline`, `--manifest <frozen
   holdout>`, judge off, `--replicate 1`. Legacy homedir caches are never read.
3. **Clean-tree preflight (before EACH arm):** recursively scan every snapshot
   tree under the state root for SmartRead runtime state
   (`.pi-smartread*`, `.pi-smartread.tags.cache`, `.pi-smartread.embeddings.cache`,
   `.pi/`, `.smart-edit-undo/`) — a separate investigation found SmartRead state
   dirs inside legacy benchmark snapshots. Any hit → STOP, do not run; resolve
   and re-preflight. Record the scan result in the per-arm log.
4. **Fresh cold state each arm:** A0 runs in state-root #1, A5 in state-root
   #2 — both freshly created (fresh-claim), populated per the approved
   seeding/hydration receipts, with SmartRead runtime caches provably absent at
   preflight (step 3) and cold-start receipts (`coldStart.checkedRoots` /
   `planned` / `deleted`) recorded in the report. **Order: A0 first, then A5**
   (fixed; no interleaving; no other eval processes running).
5. **Engine-hash check:** `hashEngineSources` recorded before and after each
   arm; both must equal the V2 hash (§1). Any mismatch → stop, study void.
6. **Retry budget:** transport failures retried up to 3 attempts per instance
   per arm (attempts logged); valid retries preserved (§2.2).
7. **Analysis-script sha256** recorded in §7 of this doc **before unsealing**
   (before any holdout result exists).
8. **Completeness bar per report:** 128-style outcome accounting generalized to
   n instances × 2 formulations, `errors = 0` or every error disclosed as a
   transport exclusion, judge invocations = 0, report path + sha256 logged.
9. **Analysis:** run `scripts/stats/retrieval-holdout-v2.ts` on the two report
   files, passing the frozen holdout manifest's instance id list to
   `analyzeReports` as `expectedInstanceIds` (the run protocol supplies the
   manifest ids; any outcome id outside that list is rejected, and every
   expected id absent from either arm report or with no matched formulation
   is treated as post-run attrition in the §2 worst-case sensitivity);
   produce §6 reporting list; fill §4.1 tables; apply §3 confirm rule +
   §4 guardrails; publish regardless.

Per-arm log must contain: command, engine hash before/after, report absolute
path + sha256, outcome/exclusion counts, judge invocations, cold-start receipt
summary, exit code.

## 6. Simulation validation (owner condition: "subject to simulation validation")

### 6.1 PASS criteria — WRITTEN BEFORE THE SIMULATION WAS RUN (see §0 order)

> **PASS iff Type I error ≤ 0.06 in EVERY null scenario AND (two-sided 95% t CI)
> coverage ≥ 0.94 in EVERY scenario (null and power).**
>
> If it FAILS: exactly ONE alternative primary procedure, valid for an
> asymmetric-utility null, is named and validated the same way (≥20,000 reps,
> same scenarios, same thresholds): **stratified bootstrap-t** — resample
> instances within repository strata, studentize, one-sided α=.05, with
> bias-correction at the null boundary. The choice between t-test and the
> alternative is frozen in §6.4 before unsealing.

Coverage is the two-sided 95% t interval for μ; one-sided LB coverage
(P(LB ≤ μ)) is additionally reported. Both criteria fixed here before any
simulation output existed.

### 6.2 Design

Deterministic Monte Carlo, seeded PRNG (mulberry32), **20,000 reps per
scenario**:

1. **Type I (null, μ = 0 exactly):** per-formulation marginals satisfy
   P(win) = 2·P(loss) so E[u_if] = 0 exactly (asymmetric-utility null);
   grid over:
   - discordance d ∈ {0.078, 0.15625 (dev64-observed), 0.313} (census/dev
     profile range, `2026-10-08-retrieval-holdout-census.md`),
   - title/body dependence: latent-Gaussian ρ calibrated so simulated
     phi(d_title, d_body) matches {0, −0.0534 (dev64-observed)},
   - repository clustering: census composition (svelte 252 / mui 158 / dayjs
     45 / vue 27 / github-readme-stats 10 = 492) scaled to n = 400 →
     [205, 128, 37, 22, 8], with **between-repo heterogeneity whose repo
     effects average to μ = 0 exactly** (per-repo utility means
     μ_r = 0.5·d·(δ_r − w̄δ)/max|δ − w̄δ| over δ = [+1, +1, −1, −1, −1],
     census-weighted; per-repo marginals p_w,r = p_w + μ_r/3,
     p_l,r = p_l − μ_r/3, asserted in-bounds).
   → 3 × 2 × 2 = 12 null scenarios.
2. **Power:** (i) at A5's dev effect (dev64 per-formulation marginals:
   title p_w=0.140625/p_l=0.015625, body p_w=0.109375/p_l=0.046875 →
   E[u] = 0.0625) and (ii) at 50% shrinkage of that effect (winner's curse),
   each × clustering {off, on} at dev dependence → 4 scenarios.
3. **CI coverage:** two-sided 95% t CI and one-sided 95% LB coverage in every
   scenario.

**Calibration inputs (screening/external dev64 only — shas verified against the
results-doc appendix in this run):**

| Report | sha256 (verified) |
|---|---|
| A0 L4 `…/reports/external-grep-dev-2026-10-08T19-19-30-779Z-80820a88.json` | `7462a1441ac2d5a9fc5ec974ea8ca98bcaa3e09d7b9c0acdd2200e2ff6eddb6a` |
| A5 L4 `…/reports/external-grep-dev-2026-10-08T21-38-32-544Z-1b8d3e70.json` | `d62becce7ab5409ff0fca5d6641c6fecb9412cd10f923367c1848cfc3ce00bb5` |

(dev64 = screening, not holdout; reading it for calibration is allowed.)

Extracted calibration (n = 64 instances, both formulations):

| Formulation | wins (A5↑) | losses (A5↓) | ties | P(win) | P(loss) | discordance |
|---|---|---|---|---|---|---|
| title | 9 | 1 | 54 | 0.140625 | 0.015625 | 0.15625 |
| body | 7 | 3 | 54 | 0.109375 | 0.046875 | 0.15625 |

- phi(d_title, d_body) = **−0.053376**; joint table (t,b):
  (0,0)=44, (0,1)=7, (0,−1)=3, (−1,0)=1, (1,0)=9 (no co-discordant instance).
- Instance mean u = **0.0625**, sd(u) = 0.350736 (n=64) → dev effect for power.
- **n assumed: 400** (E16 frozen decision; holdout manifest not yet frozen at
  prereg time; census pool = 492). Composition assumed census-proportional
  (open question §8: whether the freezer's round-robin deviates materially).

### 6.3 Results (APPENDED AFTER the run — see §0 order)

Appended 2026-10-09T01:29:23Z (criteria in §6.1 were already on disk at the
§0 timestamp 2026-10-09T00:50:30Z and were not edited afterwards). Commands:
`node --import tsx scripts/stats/retrieval-holdout-v2.ts` (procedure `t`) and
`node --import tsx scripts/stats/retrieval-holdout-v2.ts bootstrap-t`
(procedure `bootstrap-t`), both with reps = 20,000 per scenario, baseSeed
20261009, scenario seed = baseSeed + i·1000003, n = 400; bootstrap inner
replicates B = 199, p = (1 + #{T* ≥ T_obs})/(B+1), nearest-rank quantiles.

**Candidate 1 — one-sided paired instance-level t-test: FAIL.** Three null
scenarios at the sparse discordance d = 0.078 exceed Type I 0.06; all
coverages pass (≥ 0.9452).

| scenario | kind | mu | rejectRate | coverage2 | coverageLB | meanEst |
|---|---|---|---|---|---|---|
| null-d0.078-independent-pool | null | 0.0000 | **0.0619** | 0.9492 | 0.9382 | 0.0000 |
| null-d0.078-independent-cluster | null | 0.0000 | 0.0590 | 0.9487 | 0.9410 | -0.0001 |
| null-d0.078-dev-pool | null | 0.0000 | **0.0632** | 0.9452 | 0.9368 | 0.0000 |
| null-d0.078-dev-cluster | null | 0.0000 | **0.0613** | 0.9481 | 0.9387 | -0.0000 |
| null-d0.15625-independent-pool | null | 0.0000 | 0.0580 | 0.9504 | 0.9419 | -0.0000 |
| null-d0.15625-independent-cluster | null | 0.0000 | 0.0588 | 0.9490 | 0.9412 | 0.0000 |
| null-d0.15625-dev-pool | null | 0.0000 | 0.0566 | 0.9506 | 0.9434 | 0.0002 |
| null-d0.15625-dev-cluster | null | 0.0000 | 0.0563 | 0.9505 | 0.9436 | 0.0001 |
| null-d0.313-independent-pool | null | 0.0000 | 0.0591 | 0.9486 | 0.9409 | 0.0001 |
| null-d0.313-independent-cluster | null | 0.0000 | 0.0585 | 0.9495 | 0.9415 | 0.0002 |
| null-d0.313-dev-pool | null | 0.0000 | 0.0563 | 0.9485 | 0.9437 | -0.0000 |
| null-d0.313-dev-cluster | null | 0.0000 | 0.0524 | 0.9528 | 0.9476 | -0.0001 |
| power-shrink100-pool | power | 0.0625 | 0.9717 | 0.9466 | 0.9417 | 0.0624 |
| power-shrink100-cluster | power | 0.0625 | 0.9729 | 0.9527 | 0.9478 | 0.0623 |
| power-shrink50-pool | power | 0.0313 | 0.5264 | 0.9487 | 0.9416 | 0.0311 |
| power-shrink50-cluster | power | 0.0313 | 0.5275 | 0.9484 | 0.9414 | 0.0314 |

**Candidate 2 (the ONE alternative named in §6.1) — stratified bootstrap-t:
PASS.** Every null scenario Type I ≤ 0.06 (range 0.0500–0.0541) AND every
scenario coverage ≥ 0.94 (min 0.9445).

| scenario | kind | mu | rejectRate | coverage2 | coverageLB | meanEst |
|---|---|---|---|---|---|---|
| null-d0.078-independent-pool | null | 0.0000 | 0.0521 | 0.9472 | 0.9479 | -0.0001 |
| null-d0.078-independent-cluster | null | 0.0000 | 0.0523 | 0.9466 | 0.9477 | -0.0001 |
| null-d0.078-dev-pool | null | 0.0000 | 0.0503 | 0.9492 | 0.9497 | -0.0001 |
| null-d0.078-dev-cluster | null | 0.0000 | 0.0515 | 0.9458 | 0.9485 | -0.0001 |
| null-d0.15625-independent-pool | null | 0.0000 | 0.0507 | 0.9515 | 0.9493 | 0.0001 |
| null-d0.15625-independent-cluster | null | 0.0000 | 0.0510 | 0.9482 | 0.9490 | -0.0001 |
| null-d0.15625-dev-pool | null | 0.0000 | 0.0541 | 0.9463 | 0.9459 | 0.0001 |
| null-d0.15625-dev-cluster | null | 0.0000 | 0.0504 | 0.9486 | 0.9496 | 0.0000 |
| null-d0.313-independent-pool | null | 0.0000 | 0.0500 | 0.9477 | 0.9499 | -0.0000 |
| null-d0.313-independent-cluster | null | 0.0000 | 0.0522 | 0.9482 | 0.9478 | 0.0002 |
| null-d0.313-dev-pool | null | 0.0000 | 0.0523 | 0.9465 | 0.9477 | -0.0000 |
| null-d0.313-dev-cluster | null | 0.0000 | 0.0524 | 0.9467 | 0.9476 | -0.0003 |
| power-shrink100-pool | power | 0.0625 | 0.9645 | 0.9465 | 0.9450 | 0.0625 |
| power-shrink100-cluster | power | 0.0625 | 0.9651 | 0.9470 | 0.9473 | 0.0625 |
| power-shrink50-pool | power | 0.0313 | 0.5032 | 0.9472 | 0.9494 | 0.0314 |
| power-shrink50-cluster | power | 0.0313 | 0.5034 | 0.9445 | 0.9477 | 0.0312 |

Reading: the t-test's anti-conservatism is concentrated in the sparse-
discordance regime (≈ 31 discordant formulation-pairs per 400 instances at
d = 0.078) where u is heavily discrete/skewed; the bootstrap-t removes it.
Power: 0.965 at A5's dev effect (winner's-curse-adjacent), ≈ 0.50 at 50%
shrinkage under either procedure — reported as-is (no re-tuning).

### 6.4 Frozen choice after validation

**FROZEN BEFORE UNSEALING: primary = stratified bootstrap-t** (validated PASS
under the §6.1 rule exactly as written; the candidate paired t-test FAILED the
rule and demotes to pre-specified SECONDARY, reported alongside with its
one-sided 95% LB). Implementation details now frozen:

- Resample instances with replacement within repository strata (strata =
  frozen census composition [205, 128, 37, 22, 8] at n = 400); **B = 1999
  inner replicates** (raised pre-unsealing from the originally frozen 199 —
  see §9 amendment; validated at B = 1999 in §9.4); studentize each
  replicate; T_obs = μ̂/SÊ evaluated at the null
  boundary μ = 0 (centered bootstrap statistic (μ̂* − μ̂)/SE*, not a percentile
  interval around μ̂ — the §6.1 "bias-correction at the null boundary").
- p = (1 + #{T* ≥ T_obs})/(B + 1); one-sided α = .05; one-sided 95% lower
  bound LB* = μ̂ − q₀.₉₅(T*)·SÊ (nearest-rank quantile).
- **Confirm iff LB* > 0 AND p ≤ .05 AND every §4 hard guardrail holds** (if LB*
  and p ever disagree, treat as MISS). Otherwise MISS: defaults stay, no
  retuning, published regardless.
- Only this one alternative was named and validated, as required. No further
  procedure shopping after unsealing.

## 7. Verification record

- Engine hash **before** this work:
  `sha256:e5fad8375eb02281e2b29ab9b12136d756b9f0a8f03f8ccfe94c95e9ea74ca4e:281-files`
  (equals the V2 hash; matched — work proceeded).
- Engine hash **after** this work:
  `sha256:e5fad8375eb02281e2b29ab9b12136d756b9f0a8f03f8ccfe94c95e9ea74ca4e:281-files`
  — identical to before and to the V2 freeze value (recomputed after tests and
  both simulation runs; the new files are outside the hashed set by design).
- Analysis-script sha256 (recorded before unsealing; **superseded by the §9
  pre-unsealing amendment — current value in §9.5**, no script edits after
  that record): `b61380c6eaeb87e6523c89d6ebdbb3997d95e3ad5f5ec87a3fba6a3f313adf8a`
  (`scripts/stats/retrieval-holdout-v2.ts`).
- Test-file sha256 (pre-amendment value; current value in §9.5):
  `00868c55cc6704713962eeb4f014009bccf69f6a92fde0c4cbc2916ef51b57fa`
  (`test/unit/stats/retrieval-holdout-v2.test.ts`).
- Holdout freeze status (checked by `ls`/`shasum` only, contents never read):
  NOT FROZEN at prereg time — `~/.cache/pi-smartread-bench/manifests/` contains
  only the three historical dev manifests; `external-grep-retrieval-holdout.json`
  and any opening ledger are ABSENT.
- Commands run (exit codes read directly):
  | Command | Result |
  |---|---|
  | `node --import tsx -e '…hashEngineSources(…)…'` (before) | exit 0 — V2 hash |
  | `npx vitest run test/unit/stats/retrieval-holdout-v2.test.ts` | exit 0 — 34/34 passed (43/43 after the §9 amendment) |
  | `npm run typecheck` (`tsc --noEmit`) | exit 0 — no errors (incl. these files) |
  | `npx eslint scripts/stats/retrieval-holdout-v2.ts test/unit/stats/retrieval-holdout-v2.test.ts` | exit 0 — 0 problems |
  | `node --import tsx scripts/stats/retrieval-holdout-v2.ts` (t suite) | exit 0 — PASS: NO (3 Type-I failures) |
  | `node --import tsx scripts/stats/retrieval-holdout-v2.ts bootstrap-t` | exit 0 — PASS: YES |
  | `node --import tsx -e '…hashEngineSources(…)…'` (after) | exit 0 — V2 hash (unchanged) |
  | `shasum -a 256` on dev64 A0/A5 calibration reports | both match §6.2 shas |

## 8. Open owner questions (before unsealing)

1. **Margin:** no margin exists in E15/E16/E18 — this prereg uses margin 0.
   Confirm.
2. **E15 "positive paired 95% CI on titles":** superseded by owner decision 2's
   weighted G−2L primary, or additionally retained as a guardrail? (Not applied,
   not dropped — awaiting owner.)
3. **n:** simulation assumes n = 400 (E16 freeze decision) with
   census-proportional repo composition; confirm if the freezer's round-robin
   yields a materially different composition (then re-run the simulation with
   the frozen counts — cheap, deterministic).

### 8.1 Owner decisions (2026-10-09, before the holdout manifest was frozen)

Approved by the owner after the orchestrator's recommendation, before any
holdout instance id or result existed:

1. **Margin = 0.** Confirm iff the one-sided 95% lower bound of μ (G−2L
   instance utility) is > 0 and the hard guardrails hold.
2. **E15 "positive paired 95% CI on titles": report only**, not a gate
   (computed and published alongside the primary).
3. **E16 two-repository title clause (G-E): report only**, not a gate; the
   per-repo tables, CR1 sensitivity and leave-one-repo-out analysis expose a
   gain confined to one repository.
4. **Freeze, then re-validate:** freeze the holdout manifest with the existing
   freezer, record its per-repo counts (ids never read here), re-run the
   null-scenario validation of the frozen primary (bootstrap-t, B = 1999,
   R = 20,000, unchanged pass rule) with those counts, and unseal only on PASS.
   On FAIL: stop and return to the owner; no procedure switch.

5. **G-F (E15 "≤ 1 previously successful query lost per formulation"):
   report only**, not a gate. Reason recorded before freezing: at the
   screening loss rates (A5 lost 1/64 titles and 3/64 bodies on dev64), a
   ~400-instance holdout implies ~6 title and ~19 body losses, so P(≤ 1) ≈
   0.01 (titles) and ≈ 1e-7 (bodies) under Poisson approximations; as a gate
   it would predetermine a MISS regardless of the primary, and it would
   override the owner's G−2L loss weighting. Gating guardrails remaining:
   G-C (no judge invocation) and G-G (no transport asymmetry / unplanned
   exclusion) on the holdout; G-A, G-B, G-D were evaluated on screening sets.

## 9. Amendment — pre-unsealing revision after review, 2026-10-09

**"pre-unsealing revision after review, 2026-10-09."** Trigger: a reviewer
BLOCK (P1) against this preregistration, raised while the holdout is still
frozen/unopened (§7 freeze status unchanged). Order record required by the
common rules: **the validation plan in §9.3 was written into this file BEFORE
the B = 1999 validation run was executed**; the §6.1 pass thresholds are
unchanged and predate every run (§0).

### 9.1 What changed

1. **Analysis outputs completed so `analyzeReports` reproducibly produces
   every output this prereg promises:**
   - Per-repo W/L/T **per formulation (title, body)** in addition to the
     pooled per-repo row (§4.1) — `RepoSummary.byFormulation`.
   - A **repo-clustered sensitivity, stated exactly**: **CR1 cluster-robust
     SE** for μ (sandwich for the intercept-only mean with the CR1
     small-sample correction G/(G−1)·(n−1)/(n−K), K = 1; df = G−1; the
     one-sided 95% LB is reported) **with the few-clusters caveat** — G = 5
     clusters at the census composition, so the CR1 SE is downward-biased
     here and is reported as a sensitivity only, never as the primary test
     (§4.1); **AND leave-one-repo-out**: μ and the paired t-test recomputed
     omitting each repository, every estimate reported (§4.1).
   - **Post-run attrition worst-case sensitivity (§2.3):** every distinct
     instance in `build.excluded ∪ build.unmatched` is imputed at **u = −2**
     (worst utility — the doc's "every attrited instance scored as an A5
     loss") and, separately, at **u = 0**; both are reported alongside the
     primary estimate and test. **Reporting only — not a gate** (§2.3
     requires disclosure, not a decision rule; §3/§6.4 confirm logic
     untouched). The imputed id set is a conservative superset of true
     post-run attrition: it also contains pre-run-invalid ids and, when only
     one formulation of a surviving instance is unmatched, one extra
     imputed copy for that instance; stated here so the reported numbers are
     interpretable.
2. **Production bootstrap-t B: 199 → 1999.** B = 199 makes the smallest
   achievable p = 1/200 = 0.005, too coarse for the frozen decision rule
   p ≤ .05. Production **B = 1999** (smallest p = 1/2000 = 0.0005).
   §6.4's implementation bullet is updated to match; the §6.3 record of the
   B = 199 run stays untouched as the history of that run.
3. **Script emits Monte Carlo standard errors** (MCSE = sqrt(p̂(1−p̂)/reps))
   for rejectRate and coverage2 on every scenario row, so reduced-reps
   validation can be judged with its precision stated.
4. **New hand-computed unit tests** for all of the above.
5. Script/test sha256 records in §7 updated after these edits (§9.5).
6. **Attrition completeness (reviewer P1):** `analyzeReports` now requires the frozen expected instance id list (holdout manifest ids, passed in by §5 step 9); any expected id absent from either arm report or with no matched formulation is treated as attrited and imputed in the u = −2 and u = 0 sensitivities, and any outcome id outside the expected list is rejected (throws).

### 9.2 What did NOT change (explicitly)

- §6.1 pass criteria (Type I ≤ 0.06 in every null scenario; coverage ≥ 0.94
  in every scenario) — untouched, same thresholds.
- Estimand, G−2L utility, unit, exclusions (§2), primary/confirm decision
  rules (§3, §6.4 confirm rule), guardrails (§4).
- The t-test failure record in §6.3 — untouched.
- The alternative procedure remains the pre-declared stratified
  bootstrap-t; no procedure shopping.

### 9.3 Validation plan for the production B — WRITTEN BEFORE RUNNING

- Procedure: the frozen §6.1/§6.4 stratified bootstrap-t at **B = 1999**.
- Same §6.2 grid (16 scenarios: 12 null + 4 power), same baseSeed 20261009,
  scenario seed = baseSeed + i·1000003, n = 400, same scenario generator
  (seeds preserved under scenario filtering — verified by unit test).
- **Monte Carlo reps reduced from 20,000 to R = 5,000 per scenario** (fixed
  here, before the run; runtime probe at B = 1999 measured ~5.4 ms/rep →
  ~7–8 min for 16 × 5,000). Each row reports **MCSE = sqrt(p̂(1−p̂)/R)** for
  rejectRate and coverage2 (at R = 5,000: MCSE ≈ 0.0031 at p = 0.05,
  ≈ 0.0034 at p = 0.94). Exact command:
  `node --import tsx scripts/stats/retrieval-holdout-v2.ts bootstrap-t --reps=5000`
- Judgment: §6.1 thresholds applied to the point estimates exactly as
  written (unchanged criteria), with MCSE printed per row so the margin to
  each threshold is explicit; any row within ~2·MCSE of a threshold is
  flagged borderline in the reading.
- Fail-safe: if the budget runs out before all 16 scenarios finish, the
  completed output is recorded as-is and §9.4 states exactly which
  scenarios were validated (the 12 null scenarios are the required minimum
  for the Type I criterion).
- Note on §6.1's ≥20,000-reps clause: that clause gated the choice of
  procedure, already validated at B = 199 with 20,000 reps (§6.3, record
  untouched). This §9 revalidation fixes the production B only; the reviewer
  authorized reduced reps here provided the MCSE is reported and the
  thresholds are still judged — done above and below.

### 9.4 Validation results (APPENDED AFTER THE RUN)

Run completed 2026-10-09, **exit 0**, wall time 8m32s, exact command from
§9.3 (`node --import tsx scripts/stats/retrieval-holdout-v2.ts bootstrap-t
--reps=5000`). Output header: `procedure=bootstrap-t B=1999`,
`reps=5000 baseSeed=20261009`, `PASS: YES`.

| scenario | kind | mu | rejectRate ± MCSE | coverage2 ± MCSE | coverageLB | meanEst |
|---|---|---|---|---|---|---|
| null-d0.078-independent-pool | null | 0.0000 | 0.0582 ± 0.0033 | 0.9420 ± 0.0033 | 0.9418 | 0.0000 |
| null-d0.078-independent-cluster | null | 0.0000 | 0.0566 ± 0.0033 | 0.9450 ± 0.0032 | 0.9434 | 0.0002 |
| null-d0.078-dev-pool | null | 0.0000 | 0.0532 ± 0.0032 | 0.9470 ± 0.0032 | 0.9468 | 0.0001 |
| null-d0.078-dev-cluster | null | 0.0000 | 0.0528 ± 0.0032 | 0.9462 ± 0.0032 | 0.9472 | -0.0001 |
| null-d0.15625-independent-pool | null | 0.0000 | 0.0546 ± 0.0032 | 0.9426 ± 0.0033 | 0.9454 | 0.0008 |
| null-d0.15625-independent-cluster | null | 0.0000 | 0.0504 ± 0.0031 | 0.9448 ± 0.0032 | 0.9496 | 0.0003 |
| null-d0.15625-dev-pool | null | 0.0000 | 0.0536 ± 0.0032 | 0.9542 ± 0.0030 | 0.9464 | 0.0004 |
| null-d0.15625-dev-cluster | null | 0.0000 | 0.0542 ± 0.0032 | 0.9456 ± 0.0032 | 0.9458 | 0.0001 |
| null-d0.313-independent-pool | null | 0.0000 | 0.0488 ± 0.0030 | 0.9522 ± 0.0030 | 0.9512 | -0.0003 |
| null-d0.313-independent-cluster | null | 0.0000 | 0.0510 ± 0.0031 | 0.9438 ± 0.0033 | 0.9490 | -0.0001 |
| null-d0.313-dev-pool | null | 0.0000 | 0.0552 ± 0.0032 | 0.9470 ± 0.0032 | 0.9448 | -0.0002 |
| null-d0.313-dev-cluster | null | 0.0000 | 0.0476 ± 0.0030 | 0.9498 ± 0.0031 | 0.9524 | -0.0006 |
| power-shrink100-pool | power | 0.0625 | 0.9662 ± 0.0026 | 0.9434 ± 0.0033 | 0.9498 | 0.0624 |
| power-shrink100-cluster | power | 0.0625 | 0.9688 ± 0.0025 | 0.9454 ± 0.0032 | 0.9458 | 0.0624 |
| power-shrink50-pool | power | 0.0313 | 0.5068 ± 0.0071 | 0.9472 ± 0.0032 | 0.9492 | 0.0313 |
| power-shrink50-cluster | power | 0.0313 | 0.5046 ± 0.0071 | 0.9510 ± 0.0031 | 0.9488 | 0.0312 |

Reading against the UNCHANGED §6.1 thresholds, MCSE reported per row:

- **Type I ≤ 0.06 in every null scenario: PASS.** Max 0.0582
  (null-d0.078-independent-pool, MCSE 0.0033); min 0.0476.
- **Coverage2 ≥ 0.94 in every scenario: PASS.** Min 0.9420 (MCSE 0.0033);
  max 0.9542.
- **Borderline flags (rule from §9.3):** six null rows have Type I within
  2·MCSE of 0.06 (0.0536–0.0582) and nine rows have coverage2 within
  2·MCSE of 0.94 (0.9420–0.9462). Every point estimate satisfies §6.1; the
  flags only make the reduced-reps precision explicit.
- Power rows are informational here (same structure as the §6.3 B = 199
  run): 0.966/0.969 at the dev effect, 0.507/0.505 at 50% shrinkage.
- **Frozen outcome: production bootstrap-t B = 1999, validated on the §6.2
  grid at R = 5,000 with MCSE reported; PASS: YES.**

### 9.5 Updated records (APPENDED AFTER all edits/checks)

- Engine hash re-verified AFTER the amendment:
  `sha256:e5fad8375eb02281e2b29ab9b12136d756b9f0a8f03f8ccfe94c95e9ea74ca4e:281-files`
  — identical to the §7 before/after values (the three edit targets are
  outside the hashed set by design). Holdout freeze status unchanged: still
  NOT frozen/unopened; no holdout data read.
- **Current analysis-script sha256 (supersedes §7):**
  `9e8a0431c9e999a65085312045db437b30e0eb5bfc06a022411395561c93faf8`
  (`scripts/stats/retrieval-holdout-v2.ts` — updated for the §9.7
  `--composition` change; supersedes the pre-composition record
  `51c1ca1d08ccfea277dddeb1f3316ef819512a2ff804b00a213fe7af8df4eec5`).
- **Current test-file sha256:**
  `590cce30bb74953c1ff8c4193b11f0fe591a774b2025370ed6dd7773e842502d`
  (`test/unit/stats/retrieval-holdout-v2.test.ts` — updated for the §9.7
  composition tests; supersedes the pre-composition record
  `4f1db6882868a9cfcec66309f26182f3284bb631bd16c58f113b1aaa580530f5`).
- Commands run for this amendment (exit codes read directly):

  | Command | Result |
  |---|---|
  | `node --import tsx scripts/stats/retrieval-holdout-v2.ts bootstrap-t --reps=5000` | exit 0 — PASS: YES (§9.4 table) |
  | `npx vitest run test/unit/stats/retrieval-holdout-v2.test.ts` | exit 0 — 43/43 passed |
  | `npm run typecheck` (`tsc --noEmit`) | exit 0 — no errors |
  | `npx eslint scripts/stats/retrieval-holdout-v2.ts test/unit/stats/retrieval-holdout-v2.test.ts` | exit 0 — 0 problems |
  | `node --import tsx -e '…hashEngineSources(…)…'` (after) | exit 0 — V2 hash unchanged |
  | `npx vitest run test/unit/stats/retrieval-holdout-v2.test.ts` (P1 attrition fix round) | exit 0 — 47/47 passed |
  | `npm run typecheck` (`tsc --noEmit`, P1 attrition fix round) | exit 0 — no errors |
  | `npx eslint scripts/stats/retrieval-holdout-v2.ts test/unit/stats/retrieval-holdout-v2.test.ts` (P1 attrition fix round) | exit 0 — 0 problems |

### 9.6 Full-precision validation of the frozen primary (orchestrator, 2026-10-09)

Why: the paired t-test was failed on 20,000 reps (§6.3), whereas the
bootstrap-t at the production B passed at R = 5,000 (§9.4) with rows
borderline at that precision. A fresh reviewer's reduced R = 500 rerun read
`PASS: NO` within MC error. To judge both procedures at the same precision,
the orchestrator ran the null grid at R = 20,000 on the FINAL script. The
pass rule was unchanged and was recorded in the run metadata before launch.

- Script sha256 at launch: `51c1ca1d08ccfea277dddeb1f3316ef819512a2ff804b00a213fe7af8df4eec5`
  (= §9.5 current).
- Command: `node --import tsx scripts/stats/retrieval-holdout-v2.ts bootstrap-t --reps=20000 --null-only`.
  Started 2026-10-09T02:35:57Z, finished 03:01:18Z, exit 0.
- Outputs (mode 0600): `~/.cache/pi-smartread-retrieval-owned-20261008/reports/holdout-v2-validation/bootstrap-t-r20000-null.out`
  (sha256 `31d5f8db4782107298d225bd512929a5545ab3e9265d85b42d3e4601021fc369`) and `.meta`
  (sha256 `750e9eaad8bfad0ec916690a58153b9d28b4ed53d825484674812ce158bedbd6`).
- Result: all 12 null scenarios. **Max Type I 0.0573 ± 0.0016**
  (null-d0.078-independent-pool); **min coverage2 0.9426 ± 0.0016**; output
  `PASS: YES`. The worst row sits ~1.7 MCSE inside the 0.06 limit. For
  comparison, the t-test's failing rows were 0.0613–0.0632 at the same R.
- Frozen primary unchanged: stratified bootstrap-t, B = 1999.

### 9.7 `--composition` override for the frozen-count re-validation (2026-10-09)

- 2026-10-09 — change list (§8.1 item 4 preparation; pre-unsealing, no
  holdout data read): added CLI option
  `--composition=<comma-separated positive integers>` to
  `scripts/stats/retrieval-holdout-v2.ts`:
  (a) `TOTAL_N` now derives from `REPO_COMPOSITION` (the composition's sum)
  instead of a literal `400`; (b) new `parseComposition`/`assertComposition`
  validate every value — at least 2 repos, positive integers only, and a sum
  equal to the **declared n = 400** (E16/§6.2), so all four rejections are
  enforced before any simulation work runs; (c) the composition threads
  through `buildScenarios`, `repoUtilityShifts`, `thresholdGrid`,
  `repoPrefixSums`, `compositionPrefix` and the bootstrap strata via
  `SimulateOptions.composition` — clustering effects and stratum boundaries
  follow the supplied split while `sc.n` stays the declared design size;
  (d) the `REPO_DELTA` constant became `repoDelta(composition)`.
- **`REPO_DELTA` generalisation to k repos, stated precisely:** with counts
  `c` summing to n, δ_r = +1 if c_r ≥ n/k (the mean count) and δ_r = −1
  otherwise; if every sign would be identical (all counts equal), fall back
  to alternating δ = (+1, −1, +1, −1, …) by repo index. The effects are then
  centred exactly as before: w̄δ = Σ_r (c_r/n)·δ_r,
  dev_r = δ_r − w̄δ (census-weighted mean exactly 0 by construction, since
  Σ_r (c_r/n)·dev_r = w̄δ − w̄δ·Σ_r (c_r/n) = 0), and
  μ_r = 0.5·d·dev_r / max|dev|. At the census split this reproduces the
  frozen δ = [+1, +1, −1, −1, −1] bit-for-bit (400/5 = 80; 205, 128 ≥ 80 >
  37, 22, 8), which is what makes the default run unchanged.
- **Rejection paths (each verified by CLI probe, exit 1):**
  `--composition=1.5,398.5` → "composition entries must be positive
  integers (got 1.5)"; `--composition=0,400` → "…positive integers (got 0)";
  `--composition=400` → "composition needs at least 2 repos (got 1)";
  `--composition=100,50,50` → "composition must sum to the declared n=400,
  got sum=200". The declared-n guard also fires inside the run:
  `buildScenarios([100,50,50])` and a clustered scenario simulated with a
  composition summing to 350 both throw.
- **Default-invariance proof:** `node --import tsx
  scripts/stats/retrieval-holdout-v2.ts --null-only --reps=200` before vs
  after the change: `cmp` exit 0 (byte-identical), both outputs 6523 bytes
  with sha256
  `c52991737206daa9a02fa57604758cdc83cfbcfb37d66be940674942ab3bf0f5`.
- **Exact validation command shape for §8.1 item 4 (orchestrator to run,
  R = 20,000):** `node --import tsx
  scripts/stats/retrieval-holdout-v2.ts bootstrap-t --reps=20000
  --null-only --composition=<frozen selected per-repo counts>` (the counts
  must sum to the declared n = 400; the option is rejected otherwise). This
  20,000-rep run was NOT executed here — only the orchestrator runs it.
- **Commands and records after this change (exit codes read directly):**

  | Command | Result |
  |---|---|
  | `npx vitest run test/unit/stats/retrieval-holdout-v2.test.ts` | exit 0 — 53/53 passed |
  | `npm run typecheck` (`tsc --noEmit`) | exit 0 — no errors |
  | `npx eslint scripts/stats/retrieval-holdout-v2.ts test/unit/stats/retrieval-holdout-v2.test.ts` | exit 0 — 0 problems |
  | `node --import tsx -e '…hashEngineSources(…)…'` (after) | exit 0 — `sha256:e5fad8375eb02281e2b29ab9b12136d756b9f0a8f03f8ccfe94c95e9ea74ca4e:281-files` unchanged |
  | CLI acceptance probe `--composition=210,120,40,20,10 --null-only --reps=2` | exit 0 |

- **sha256 after this change (supersedes §9.5):** script
  `9e8a0431c9e999a65085312045db437b30e0eb5bfc06a022411395561c93faf8`;
  test file
  `590cce30bb74953c1ff8c4193b11f0fe591a774b2025370ed6dd7773e842502d`.

### 9.8 Frozen-count re-validation result (orchestrator, 2026-10-09; §8.1 item 4)

The holdout manifest was frozen before this run (`retrieval-holdout-v2-20261009.json`, file sha256
`57f363b0e7aae050b467e76db6df5a3fb0033e8ed7b356ddb14aed94584ed495`). Its selected per-repo counts are svelte
160, mui 158, dayjs 45, vue 27, github-readme-stats 10 (sum 400). Only the counts were read; no instance
IDs, queries, or gold were read or printed. The pass rule is §6.1 unchanged, and was recorded in the run
metadata before launch.

- Script sha256 at launch and after: `9e8a0431c9e999a65085312045db437b30e0eb5bfc06a022411395561c93faf8`
  (= §9.7 current). Engine hash verified at launch:
  `sha256:e5fad8375eb02281e2b29ab9b12136d756b9f0a8f03f8ccfe94c95e9ea74ca4e:281-files`.
- Command: `node --import tsx scripts/stats/retrieval-holdout-v2.ts bootstrap-t --reps=20000 --null-only
  --composition=160,158,45,27,10`. Started 2026-10-09T05:23:27Z, finished 05:48:23Z, exit 0, stderr empty.
- Outputs (mode 0600) under
  `~/.cache/pi-smartread-retrieval-owned-20261008/reports/holdout-v2-validation/`:
  - `bootstrap-t-r20000-null-frozen.out`, sha256
    `e7813d216df05c76ac8782084d587bd3f86ca79dd5d1302264f33b9ae07c7787`
  - `.meta`, sha256 `4c995590acee6be0771024925dbcd67d3146a06bae40a9912c4e425bc47618ca`
- Result over all 12 null scenarios:
  - **Max Type I 0.0576 ± 0.0016** (null-d0.078-independent-pool; 0.05755).
  - **Min coverage2 0.9430 ± 0.0016** (same row).
  - Output `PASS: YES`, `failures: []`.
- The worst row sits ~1.5 MCSE inside the 0.06 limit, similar to the census-split run in §9.6 (0.0573).
  The frozen composition therefore does not change the procedure's validity.
- **Frozen primary unchanged:** stratified bootstrap-t, B = 1999. The holdout may be unsealed for the A0
  and A5 arms under §5.

### 9.9 Operational method for the §5.6 retry budget (orchestrator, 2026-10-09, BEFORE unsealing)

The runner (`run.ts`) performs no automatic retries and has no instance-targeted retry mode. Adding one
would change the frozen engine hash (§5.5) and void the A0 baseline. In this offline, judge-off run, a
"transport failure" can only be a per-query timeout (60,000 ms, the runner default) or a grep
process/runtime error. Both are counted in the report's `summary.errors`. Every earlier owned dev run
(11 reports, 128 outcomes each) had `errors = 0`. Rule, fixed before any holdout result exists:

1. Each arm runs once, with the prepared command (`/tmp/holdout-prep/arm-commands.md`, sha256
   `d44e73c0a603cdd29d9d61ad1033582fe0946734bb0863466331209c7960ed19`).
2. If that report has `errors = 0`, §5.6 is satisfied with no retry needed, and that report is the arm's
   report.
3. If `errors > 0`, the arm is re-executed WHOLE with the identical command in a new freshly claimed
   state root, prepared exactly as the first: seeded, clean-tree preflight, engine hash checked. At most
   2 re-executions, i.e. 3 attempts total. For each (instance, formulation), the outcome used is the one
   from the earliest attempt in which that pair has no error. This preserves valid results under §2.2:
   ranking is deterministic given the snapshot, so an error-free pair has the same outcome in every
   attempt. A pair still erroring after 3 attempts is a disclosed transport exclusion, handled by the §2
   attrition sensitivity analysis.
4. Any merge of attempts is done by a script outside the hashed engine paths. Every attempt's report
   path, sha256, and per-pair error list are published. Re-executions are triggered only by
   `summary.errors > 0`, never by scores.
5. Arms run with no other eval or test processes on the machine (§5.4), to avoid load-induced timeouts.

Preparation record (no arm run; holdout still sealed):

- v2 manifest `retrieval-holdout-v2-20261009.v2.json`, sha256
  `bb28dbd20a09e65ffcd4e67e22e6335b79512c56adffaa89b0860a6173166611`. Converter sha
  `e727aba5…c76faf`. 400 entries, all `multi-swe-bench`.
- 375 distinct base commits, all present and archivable offline, in non-promisor owned clones.
- State roots `~/.cache/pi-smartread-retrieval-holdout-{A0,A5}-20261009`: ownership markers 0600, dataset
  seed receipts 0600. Seed receipt sha256: A0 `c8dfd3b7…a2db1`, A5 `a9199706…e80d1`.
- Clean-tree preflight: 0 hits in each root (re-run by the orchestrator).
- The runner refuses the holdout split without `--open-holdout` (exit 2).
- Engine hash before and after preparation, measured from this worktree:
  `sha256:e5fad8375eb02281e2b29ab9b12136d756b9f0a8f03f8ccfe94c95e9ea74ca4e:281-files`.

### 9.10 Protocol deviation during A0 attempt 1 (orchestrator, 2026-10-09; disclosure only, no rule change)

Recorded while A0 attempt 1 was still running, before any A0 or A5 report existed and before any
outcome-level result was examined.

- **Deviation from §9.9 item 5 / §5.4.** For roughly 11:00–11:30 UTC the orchestrator ran parallel
  development workers on the same machine (unit tests, typecheck, lint, one long vitest run).
  Load average rose to 17–19 on 10 cores. The orchestrator had wrongly concluded the runner had no
  per-query deadline. It does: 60,000 ms (§9.9 above).
- **Observed effect.** A0 attempt 1 recorded 3 (instance, formulation) pairs with status
  `error:Operation aborted` (classified by status token only; no IDs or scores viewed). These are
  counted in `summary.errors`. Cause is inferred to be load-induced timeouts, not proven.
- **Containment.** Workers were stopped from running checks; the orchestrator terminated the long
  vitest process. Ranking code has no time-budget degradation, so pairs that did not error are
  unaffected by load (§9.9 item 3 reasoning).
- **Handling.** Unchanged frozen rules apply. A0 has `errors > 0`, so the chain does not start A5.
  A0 is re-executed whole under §9.9 item 3 in a fresh root, with no other eval or test processes
  running. The merge keeps the earliest error-free outcome per pair. A5 also runs exclusively.
  The final report discloses this deviation, every attempt's report path and sha256, and the
  per-pair error lists, and treats it under G-G.
- **Further load source (found 2026-10-10 ~01:56 local, still during attempt 1).** "Edit-only"
  development agents were not CPU-free: the editing tool runs a full-project `tsc --noEmit` after
  each TypeScript edit. One burst raised load average to 14.7 for under a minute. No new error pairs
  appeared (467 ok + 3 error at the next count). That interim rule is superseded by §9.11.
- **Merge tooling.** The §9.9 item 4 merge script did not exist when this section was written. It is
  built and tested on synthetic reports only, outside the hashed engine paths, before attempt 2 is
  merged. The engine hash is re-checked after it lands.

### 9.11 Amendment: concurrent low-priority development during arms (owner-approved, 2026-10-10)

Approved by the owner before any A0 or A5 report existed and before any outcome-level result was
examined. Prospective: it applies to the rest of A0 attempt 1 and to every later execution.

- **Rationale.** This study measures retrieval accuracy (success@5 under G−2L); latency is not an
  estimand. In the frozen configuration (offline, judge off, no graph dependencies, no
  `graphFilter`, no embedding or reranker configuration), ranking has no time budget. The
  time-limited paths (context-graph git population 10 s, repo-map LSP fallback 1 s, embeddings,
  external reranker) are not reached by the benchmark adapter (`adapter.ts:76–89`). Load
  therefore cannot change a completed ranking. Its only effect is the 60,000 ms per-query deadline
  turning a slow pair into an explicit `error`, which §9.9 already retries and discloses.
- **Replaces §9.9 item 5 / §5.4 ("no other eval or test processes").** Development processes
  (editing agents, the post-edit compiler check, unit tests, typecheck, lint, CI collection) may
  run during an arm only at reduced CPU priority (nice ≥ 10; the orchestrator session and its
  descendants run at nice 10). Agent evaluations, paid model runs, benchmarks, real
  language-server conformance suites, and other retrieval arms remain excluded during an arm.
- **Load record.** A sampler logs the 1-minute load average every 60 s while an arm runs
  (`/tmp/holdout-run/loadavg.log`, started 2026-10-09T15:16:56Z; earlier attempt-1 load is
  undocumented apart from the §9.10 observations).
- **Reporting.** For each arm and attempt the report lists error pairs (status token only), the
  per-pair elapsed time, and the load samples covering each error pair. Latency outliers
  (elapsed > 30,000 ms, half the deadline) are flagged descriptively next to the load record.
  Latency is report-only; no inference is drawn from it. Results carry the caveat that
  development work ran concurrently.
- **Unchanged.** Primary outcome, margin, G−2L, bootstrap-t, hard gates G-C and G-G, the §9.9
  retry and merge rules (errors are the only trigger; earliest error-free outcome per pair; at
  most 3 executions), timeout, knobs, manifest, and engine hash. A pair that errors in every
  allowed execution remains a disclosed exclusion under G-G.
- **Separate latency benchmark.** If retrieval latency becomes a decision input, it is measured in
  a separately preregistered study run in an exclusive window, not inferred from this run.

### 9.12 Amendment: judge confirmation may run concurrently with arms (owner-approved, 2026-10-11)

Approved by the owner ("go alongside it") after A0 attempt 1 completed (rc 0, `summary.errors` = 3,
observed as a count only) and before A0 attempt 2, A5, the attempt merge, or any outcome-level
retrieval result was examined. Prospective: applies to A0 attempt 2 onward.

- **Change.** The preregistered judge confirmation run (owner approval D-36, judges prereg) may
  execute during retrieval arms. It is a network-bound HTTP client with low local CPU use, run at
  nice ≥ 10. Agent evaluations, benchmarks, real language-server conformance suites, and other
  retrieval arms remain excluded during an arm, as in §9.11.
- **Load record and stop rule.** The §9.11 load sampler covers the overlap. If an arm execution
  that overlaps the judge run records any error pair, the orchestrator pauses the judge run at the
  next resumable boundary and discloses the overlap next to those error pairs. The §9.9 retry rule
  is unchanged: errors remain the only re-execution trigger, never scores.
- **Unchanged.** Every frozen retrieval rule listed in §9.11, and every frozen judge-study rule.

### 9.13 Operational record for A0 attempt 2 (orchestrator, 2026-10-11; disclosure only, no rule change)

- **Delay.** Attempt 2 should have followed attempt 1 (finished 2026-10-10T07:01:26Z). It was not
  launched for about 34 h. This was an orchestration lapse, not a protocol decision; no result was
  examined in between (attempt 1 was observed only as rc 0 and `summary.errors` = 3).
- **Root preparation.** `/tmp/holdout-prep/prepare-root-attempt.mjs` is a copy of the original
  two-root `prepare-roots.mjs`. Its only differences: it takes roots from argv and refuses any root
  that already exists. Each new root's seed receipt is equal to the original A0 root's receipt
  (manifest, dataset files and hashes, runner-API checks, repository seeds); runtime-state preflight
  0 hits. Wrapper `/tmp/holdout-run/run-arm-attempt.sh` uses the identical runner command, env and
  checks as `run-arm.sh`; only `--state-root` and log names differ. Chain `chain-attempts.sh`
  re-executes only on `summary.errors > 0`, at most 3 executions per arm, then runs A5.
- **Aborted start.** The first launch (06:44:02Z, root `…-A0-attempt2-20261011`) inherited the
  orchestrator session's nice 10, which removes the priority gap §9.11 relies on. It was stopped about
  1 min in. No report was written; its partial stdout (9,418 bytes) was not read and is kept as
  `aborted-nice10-A0-attempt2.*`. Stopping it was not triggered by any score or error. The used root is
  preserved, not reused.
- **Execution.** Attempt 2 relaunched 06:45:35Z at nice 0 under launchd (parent PID 1) in fresh root
  `…-A0-attempt2b-20261011`; engine hash before = V2, preflight 0, env check judge-off only.
- **§9.12 stop rule triggered.** A count-only check at 07:46Z found 1 error pair in attempt 2 (0 at the
  ~07:05Z check). The judge run overlapped it, so it was suspended at 07:46:41Z (SIGSTOP on the runner
  processes; journal and ledger intact, resumable). The load record for the window shows the 1-minute
  load average reached ~22 around 07:00Z, while LM Studio (~2 cores, nice 0, not part of this study)
  and up to nine nice-10 development agents were active; the judge runner itself used under 5% CPU.
  The cause of the error pair is not established. No error identity or score was read. The §9.9 rule is
  unchanged: attempt 2 completes, and since `summary.errors > 0` the chain runs attempt 3 before A5.
  *Superseded by §9.14 for the attempt-3 decision; judge resumed 07:51Z after the owner quit LM Studio.*

### 9.14 Amendment: re-execution decided from merged missingness (owner-directed, 2026-10-11)

Directed by the owner at about 08:00Z, during A0 attempt 2 (started 06:45Z, still running) and before
any A0 attempt-2 report, any A5 execution, any attempt merge, or any outcome-level retrieval result
existed. Observed so far: aggregate error counts only (attempt 1: 3 of 800 pairs; attempt 2 in progress:
1). The thresholds below are the owner's and are fixed now, before outcomes, but after those counts.

- **Why.** §9.9 re-executes a whole arm (~24 h) whenever the latest execution has any error, although
  the runner has no instance-level retry and the merge only ever uses an execution for pairs that
  errored in every earlier one. A later execution therefore cannot change any pair already resolved.
- **Trigger change (outcome-neutral).** Re-execution is decided from the *merged unresolved set*: pairs
  with no error-free outcome in any execution so far (exactly the `merge-attempts.ts` exclusions).
  If it is empty, no further execution is run. This yields the identical analysed dataset to §9.9.
- **When pairs remain unresolved** (counts only; no ids or scores read):
  - ≤ 0.5% of the arm's pairs (≤ 4 of 800): no further execution; the pairs are excluded from BOTH
    arms, disclosed, and covered by the G-G worst-case sensitivity analysis.
  - 0.5–1%: stop and investigate the distribution with the owner before deciding.
  - > 1%: stop for owner review.
  - Concentration, regardless of fraction: ≥ 3 unresolved pairs in one repository, or one instance
    unresolved in every formulation → stop and investigate (possible systematic missingness, e.g. a
    deterministically slow instance that would also fail any further execution).
  - At most 3 executions per arm (unchanged); engine-hash or knob mismatch invalidates (unchanged).
- **Analysis.** The primary analysis (G−2L, margin 0, bootstrap-t B=1999) is unchanged and runs on the
  merged set after symmetric exclusion. The report states for each arm the executions run, the merged
  unresolved count, and whether §9.9 as originally written would have run another execution. If the
  verdict is not robust to the G-G worst-case and best-case imputation of the excluded pairs, the
  remaining §9.9 executions for the affected arm are run before the verdict is declared. Ranking is
  deterministic per pair, so such a run only recovers fixed values; it cannot re-draw outcomes.
- **Judge overlap (replaces the §9.12 stop rule).** The judge run continues during arms at nice ≥ 10. It
  pauses only if an overlapping execution's error pairs exceed 0.5% of its pairs (≥ 5 of 800), or if the
  judge processes themselves exceed one core for 10 minutes. Load above the core count is answered first
  by reducing development concurrency (≤ 3 concurrent development agents during arms) and is recorded.
- **First check (disclosed).** A count-only run of the new check on A0 attempt 1 alone gives 3 unresolved
  of 800, all in one repository, with one instance errored in both formulations, i.e. the concentration
  trigger. Whether those pairs recovered in attempt 2 is unknown until attempt 2 completes.
- **Operation.** `/tmp/holdout-run/unresolved-count.mjs` (count-only) and `chain-914.sh` (launchd, nice 0)
  take over when `chain-attempts.sh` stops: a hold file makes the original chain refuse attempt-3 root
  preparation before any change. `chain-914.sh` never re-executes on its own; it proceeds to A5 or stops
  for review, and applies the same rule to A5.
- **Future studies.** Use instance-targeted retry in the runner (a new engine identity), with these
  thresholds preregistered before any execution.
- **A5 is not held by an A0 investigation (owner decision, 2026-10-11 ~08:08Z, same pre-outcome state).**
  A5 is required whatever A0's missing-pair review concludes. An A0 "investigate" outcome (concentration
  or 0.5–1%) is recorded as a review item and A5 starts; the A0 re-execution decision is made by the owner
  during A5, before any merge or analysis. Only > 1% unresolved in A0 (a possible environment fault that
  would also affect A5), a failed count, or an invalid execution stops before A5. A5's own outcome still
  follows the rules above. `chain-914.sh` was restarted at 08:08:52Z with this branch; the running A0
  attempt-2 arm was not affected.

### 9.15 Amendment: hung execution, stall watchdog, A5 before the A0 re-execution (owner-approved, 2026-10-11)

Approved by the owner at about 08:48Z, during A0 attempt 2 and before any A5 execution, attempt merge, or
outcome-level result.

- **What happened.** A0 attempt 2 stopped producing output at 08:26:25Z inside one pair, after 254 of
  800 pairs (1 error). For 20 minutes the runner and its 15 language-server children used no CPU; a
  native sample showed the main thread idle in the event loop, i.e. awaiting work that ignores the
  per-pair `AbortSignal.timeout(60000)`. Attempt 1 completed the same pair normally, so the hang is a
  nondeterministic run fault, not input-determined. The cause is under investigation.
- **Disposition.** The runner was stopped at 08:48:32Z (exit 143; engine hash unchanged; no report). The
  partial attempt-2 output is preserved and excluded from analysis. A fault-aborted execution that
  produced no report counts as no execution: it does not use one of the three executions per arm.
- **Order.** A5 started at 08:53:17Z. The owner-approved A0 re-execution (attempt `2c`, fresh root,
  identical command) runs after A5; the §9.14 rules then apply to the merged A0 executions
  (attempt 1 + 2c) and separately to A5.
- **Stall watchdog.** Each execution runs under a watchdog. A stall is 15 consecutive one-minute checks
  with no new runner output and under 5 CPU-seconds across the runner's process tree; a wall-clock gap
  over 3 minutes between checks (system sleep) resets the count. On a stall it saves a native sample,
  stops the runner, lets the wrapper record the exit, and stops for owner review. It never restarts an
  arm by itself. Legitimate long work burns CPU, so the CPU condition prevents killing slow pairs.
- **Blinding disclosure.** While checking health the parent saw A0 per-pair scores (one attempt-1 record
  and about eight attempt-2 progress lines). Engine, knobs and manifest are frozen and ranking is
  deterministic, so no tuning path exists; nothing was used in any decision. Later checks print counts,
  statuses and timings only.
