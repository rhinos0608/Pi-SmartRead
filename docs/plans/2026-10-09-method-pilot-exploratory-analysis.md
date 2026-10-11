# Judge method pilot — EXPLORATORY paired analysis (2026-10-09)

**Status: EXPLORATORY. No selection, no verdict change.** Every table here is
hypothesis-generating description of the completed pilot data. The preregistered
A1.1 selector (`scripts/eval/judge/method-pilot-selector.ts`) and its sealed
verdict (`method-verdict-20261009.json`, chosen method **M0**) remain the only
decision surface; nothing in this document qualifies, re-qualifies, or revisits
that selection. Protocol §9 A1.1's "Prohibited" list stays in force: per-model
method choice, threshold/penalty/margin retuning, and selection on secondary
metrics are not performed here and must not be inferred from these tables.

**Multiplicity warning, stated once and applied throughout:** all intervals
below are descriptive two-sided 95% nearest-rank percentile intervals from a
single shared paired query-cluster bootstrap. They are **NOT
multiplicity-corrected** across the 3 models × 3 loss contrasts (9 per-model
estimates, plus 3 equally-averaged estimates), the FN and FP difference
estimates (36 further estimates), the 3 interaction differences-in-differences,
and the spread statistic. No p-values are computed and no interval is evidence
of confirmation. The independent unit is the **query** — **n = 40 clusters,
2 replicas averaged within candidate before thresholding** (replicas are not
independent samples).

## 1. Purpose

The preregistered selector disqualified alternatives M1 and M2 on its integrity
gate (qualification 5: two wire components carried `capture_gap` error records,
because an error response carries no served model), so the margin, bootstrap,
and FN guard were never evaluated and the diagnostic questions remain
descriptively open:

1. What are the per-model and averaged loss/query contrasts D(M1−M0),
   D(M2−M0), D(M1−M2), with paired uncertainty?
2. What are the FN (missed relevant) and FP (false keep) counts and their
   paired differences?
3. Does the M1-vs-M0 effect vary by model (model×method interaction)?
4. Which queries win/tie/lose per model, and which queries drive the apparent
   Luna improvement?
5. Do the two recovered-error components (retried to success on attempt 2)
   drive any of it?

## 2. Data provenance (all read-only; nothing under the pilot root was modified)

| Artifact | sha256 |
|---|---|
| `pilot-plan-20261009-a2.json` (plan) | `7ecd9466a9905e9d23a229e514e249813418d711be82b2d6a03200bde9f2e023` (equals verdict `planSha256`) |
| `pilot-plan-20261009-a2.json.wire-records.jsonl` (2,168 rows) | `2b4fbd136bb04a6f6bdf9302ced200860ca7e90aaf3660b6494c49d340549e79` |
| `pilot-plan-20261009-a2.json.progress.jsonl` | `640ad317c5a329e8192231987793aed1d4a2ffb579ba74d7f92b5135a31efc2b` |
| `method-verdict-20261009.json` | `97fa8fe76234c5ad51c0e624394684af7c186aa95d082d976003984fc0448ebe` |
| Sealed corpus manifest (roster `manifestSha256`) | `d28e404d4a514d7e09e01d5e49b6a99b6bc14cfc17123b14e2cee031870c370f` |
| Corpus source pin (`sourceRef`) | `18f6463caa78e6657b1af6c7eb86b711bc2364f8` |
| Analysis script `scripts/eval/judge/method-pilot-exploratory.ts` | `70f513296120e58db178c608d942ac765a81715eeea902a50e18a27631c0b67b` |
| Unit test `test/unit/judge/method-pilot-exploratory.test.ts` | `d8c7c779f49548da9485609caeddb2bb52c474d6c7a19a8ea5409cfee3afa38b` |

Run facts (from the sealed run): 2,166/2,166 planned requests succeeded (722
per model; 2,168 wire rows include the two retry attempts). Two transient
errors were recorded and retried to success on attempt 2 — Jev M1 replica 1
group `P-search-02` (HTTP 529) and PPLX M2 replica 1 group `P-search-03`
(HTTP 503) — both classified `capture_gap` because error responses carry no
served model. Known spend $0.2446; used including reserves $0.3613 of the $3
hard cap (A1.4). A2 (`docs/plans/2026-10-08-judge-decider-protocol.md` §10)
froze the PPLX arm as `perplexity/pplx-decider-v1.1-27b` pre-data; all tables
use that arm.

## 3. Method

Implemented in `scripts/eval/judge/method-pilot-exploratory.ts` (pure,
deterministic, offline; no network, no credentials).

- **Scores come from the glue's own derivation.** The CLI loads the sealed
  corpus through `loadVerifiedPilotCorpus` (Stage B re-verification), the plan
  artifact, and the wire records, then calls the glue's exported
  `deriveMethodPilotSelectorInput` (`method-pilot-select.ts`). Per-candidate
  scores follow A1.1 line 484 exactly: M0/M1 score = mean of the two replica
  probabilities; M2 replica score = `(forward + reverse)/2`, then the mean over
  replicas; keep iff score ≥ .40 (equality keeps); gold positive, both negative
  classes negative; loss = 6·FN + FP.
- **Verdict-identity proof.** The CLI rebuilds the verdict's
  `perModelPerMethod` table (loss, FN, loss/query per model×method) from those
  scores and fail-closes (exit 2) unless it reproduces the stored verdict table
  **byte-for-value** (JSON.stringify equality). It did: all 9 rows match, and
  the derived S_m values equal the verdict's (M0 1.575, M1 1.366666…, M2
  1.441666…). Every number below is therefore on the identical derivation as
  the sealed verdict.
- **Unit of independence = query.** 40 query clusters (roster order replaced by
  lexicographic query-id order for resampling). Replicas are averaged within
  candidate before thresholding; models and replicas are never treated as
  independent samples.
- **Paired query-cluster bootstrap.** B = 10,000 draws, seed 20261008,
  `mulberry32`, lexicographically sorted query ids, Q picks with replacement
  per draw — the selector's own frozen conventions, using the selector's
  exported `mulberry32`/`percentileSorted` helpers. **The same query picks are
  applied to every model × method within each draw**, so all contrasts are
  paired. Intervals are two-sided 95% nearest-rank percentiles (.025/.975),
  unlike A1.1 qualification 2's Bonferroni-adjusted one-sided .025 lower bound
  (which applies only to the selector and is not reproduced or replaced here).
- **Contrast sign convention.** D(A−B) = S_B − S_A per scope (positive always
  favors the first-named method); FN/FP differences are likewise
  count(B) − count(A), so positive = fewer FN/FP under the first-named method.
  The "averaged" scope is the equally-weighted 3-model average for loss (S_m)
  and the 3-model total for FN/FP counts.
- **Sensitivity.** The two recovered-error components are located in the wire
  records themselves (any component with an `errorClass` attempt); their query
  groups (`P-search-02`, `P-search-03`) are excluded **as whole clusters** —
  the smallest pairing-preserving exclusion unit — and the entire analysis is
  re-run on the remaining 38 clusters. Cell-level exclusion would either break
  the paired structure or violate the complete-coverage rule, so it is not
  used. Cell-level detail of the affected components is reported separately.

Reproduce with:

```
npx tsx scripts/eval/judge/method-pilot-exploratory.ts \
  --pilot-root ~/.cache/pi-smartread-judge-pilot-20261008 \
  --records ~/.cache/pi-smartread-judge-pilot-20261008/pilot-plan-20261009-a2.json.wire-records.jsonl \
  --plan ~/.cache/pi-smartread-judge-pilot-20261008/pilot-plan-20261009-a2.json \
  --verdict ~/.cache/pi-smartread-judge-pilot-20261008/method-verdict-20261009.json
```

Exit 0 on success; the full JSON (all point estimates, intervals, breakdowns,
sensitivity) is written to stdout. Exit 2 includes a verdict-reproduction
mismatch; exit 3 is a corpus/plan gate refusal.

## 4. Results — full data (40 query clusters, 2 replicas)

### 4.1 Per model and averaged: loss/query for M0, M1, M2

Point estimates reproduce the verdict table byte-for-value. Intervals are the
paired cluster bootstrap's descriptive 95% percentiles.

| Model | Method | L = 6FN+FP | FN | FP | loss/query [95%] |
|---|---|---:|---:|---:|---|
| ~typesafe/jev-latest | M0 | 70 | 2 | 58 | 1.75 [1.30, 2.25] |
| ~typesafe/jev-latest | M1 | 59 | 0 | 59 | 1.475 [1.15, 1.825] |
| ~typesafe/jev-latest | M2 | 62 | 1 | 56 | 1.55 [1.175, 1.95] |
| perplexity/pplx-decider-v1.1-27b | M0 | 55 | 1 | 49 | 1.375 [0.975, 1.80] |
| perplexity/pplx-decider-v1.1-27b | M1 | 63 | 0 | 63 | 1.575 [1.25, 1.925] |
| perplexity/pplx-decider-v1.1-27b | M2 | 55 | 1 | 49 | 1.375 [0.975, 1.80] |
| openai/gpt-6-luna-decisions | M0 | 64 | 5 | 34 | 1.60 [1.00, 2.275] |
| openai/gpt-6-luna-decisions | M1 | 42 | 1 | 36 | 1.05 [0.675, 1.475] |
| openai/gpt-6-luna-decisions | M2 | 56 | 2 | 44 | 1.40 [0.95, 1.925] |
| equally averaged | M0 | — | 8 | 141 | S_0 = 1.575 [1.175, 2.008] |
| equally averaged | M1 | — | 1 | 158 | S_1 = 1.367 [1.083, 1.667] |
| equally averaged | M2 | — | 4 | 149 | S_2 = 1.442 [1.067, 1.842] |

### 4.2 Loss contrasts (positive favors the first-named method)

| Contrast | Scope | Point [95%] |
|---|---|---|
| D(M1−M0) | averaged | 0.208 [−0.217, 0.708] |
| D(M1−M0) | jev | 0.275 [−0.15, 0.80] |
| D(M1−M0) | pplx | −0.200 [−0.575, 0.25] |
| D(M1−M0) | luna | 0.550 [−0.225, 1.375] |
| D(M2−M0) | averaged | 0.133 [−0.083, 0.408] |
| D(M2−M0) | jev | 0.200 [−0.05, 0.575] |
| D(M2−M0) | pplx | 0.000 [−0.125, 0.10] |
| D(M2−M0) | luna | 0.200 [−0.30, 0.80] |
| D(M1−M2) | averaged | 0.075 [−0.30, 0.525] |
| D(M1−M2) | jev | 0.075 [−0.275, 0.50] |
| D(M1−M2) | pplx | −0.200 [−0.55, 0.25] |
| D(M1−M2) | luna | 0.350 [−0.30, 1.025] |

Every loss-contrast interval includes 0. The averaged point estimates for
D(M1−M0) (0.208) and D(M2−M0) (0.133) exceed A1.1's preregistered 0.10
margin in point value alone, but their intervals span 0 by a wide margin, and
the per-model estimates are smaller and mixed-sign — at n = 40 clusters this
pilot does not separate the methods on pooled loss, with or without
multiplicity in the picture.

### 4.3 FN (missed-relevant) and FP (false-keep) differences

Positive = fewer FN/FP under the first-named method; "averaged" scope is the
3-model total.

| Diff | Scope | Point [95%] |
|---|---|---|
| FN D(M1−M0) | averaged | 7 [0, 16] |
| FN D(M1−M0) | jev | 2 [0, 5] |
| FN D(M1−M0) | pplx | 1 [0, 3] |
| FN D(M1−M0) | luna | 4 [0, 9] |
| FN D(M2−M0) | averaged | 4 [0, 9] |
| FN D(M1−M2) | averaged | 3 [−2, 10] |
| FP D(M1−M0) | averaged | −17 [−39, 6] |
| FP D(M1−M0) | jev | −1 [−10, 9] |
| FP D(M1−M0) | pplx | **−14 [−25, −3]** |
| FP D(M1−M0) | luna | −2 [−14, 10] |
| FP D(M2−M0) | averaged | −8 [−17, 1] |
| FP D(M2−M0) | luna | **−10 [−18, −3]** |
| FP D(M1−M2) | averaged | −9 [−33, 16] |
| FP D(M1−M2) | pplx | **−14 [−24, −4]** |

The M1-vs-M0 tradeoff is visible in the counts: M1 reduces FNs on every model
(8 → 1 pooled) but adds FPs, sharply so on PPLX (49 → 63). Three FP-difference
intervals exclude 0 (PPLX FP D(M1−M0), Luna FP D(M2−M0), PPLX FP D(M1−M2)) —
but with 36 FN/FP estimates in this analysis and no multiplicity correction,
these are leads, not findings. The pooled loss contrast stays near zero
precisely because the FN gains and FP costs roughly cancel.

### 4.4 Per-query sign counts (wins/ties/losses vs own M0)

| Model | Method | Wins | Ties | Losses |
|---|---|---:|---:|---:|
| jev | M1 | 6 | 27 | 7 |
| jev | M2 | 6 | 31 | 3 |
| pplx | M1 | 4 | 20 | 16 |
| pplx | M2 | 2 | 37 | 1 |
| luna | M1 | 13 | 16 | 11 |
| luna | M2 | 5 | 25 | 10 |

M2 is mostly a tie machine (31/37/25 ties): averaging a reverse leg barely
moves most queries. M1 polarizes: on PPLX it loses 16 queries against 4 wins;
on Luna it wins 13 against 11 — the weakest margin of any M1 row, which is
worth stressing before narrating a "Luna effect."

### 4.5 Queries driving the Luna M1-vs-M0 point estimate

Top 5 by per-query contribution (L_luna,M0,q − L_luna,M1,q; the 3-model Luna
total contribution is 22):

| Rank | Query | Contribution | M0 (FN/FP) | M1 (FN/FP) |
|---|---|---:|---|---|
| 1 | P-misc-01 | 8 | loss 8 (fn 1, fp 2) | loss 0 (fn 0, fp 0) |
| 2 | P-read-inspect-01 | 7 | loss 7 (fn 1, fp 1) | loss 0 (fn 0, fp 0) |
| 3 | P-repo-mcp-07 | 6 | loss 6 (fn 1, fp 0) | loss 0 (fn 0, fp 0) |
| 4 | P-lsp-03 | 5 | loss 6 (fn 1, fp 0) | loss 1 (fn 0, fp 1) |
| 5 | P-repo-mcp-01 | 5 | loss 6 (fn 1, fp 0) | loss 1 (fn 0, fp 1) |

These five queries contribute 31 of the 22-net Luna improvement offset — i.e.,
they more than account for it: M0's Luna losses concentrate in five query
clusters (each containing one missed gold), and M1 fixes four of the five
completely. With n = 40 clusters, a handful of clusters moving this way is
exactly the fragility the paired interval reflects: the Luna D(M1−M0)
interval [−0.225, 1.375] spans 0.

## 5. Interaction findings — does D(M1−M0) vary by model?

Difference-in-differences of D(M1−M0), pairwise, and the max−min spread of the
per-model D(M1−M0) across bootstrap draws:

| Statistic | Point [95%] |
|---|---|
| DiD: jev − pplx | 0.475 [0.10, 0.90] |
| DiD: jev − luna | −0.275 [−1.05, 0.425] |
| DiD: pplx − luna | −0.750 [−1.475, −0.05] |
| Spread (max−min of per-model D) | 0.750 [0.30, 1.475] |

Reading, with all the exploratory caveats:

- The per-model D(M1−M0) point estimates differ substantially (jev +0.275,
  pplx −0.200, luna +0.550) and the spread interval excludes 0 — but
  **max−min is non-negative by construction**, so its lower bound is an
  upward-biased statistic and must not be read as a valid test. The pairwise
  DiDs are the interpretable lines.
- Two DiD intervals sit mostly away from 0 (jev−pplx; pplx−luna barely, upper
  bound −0.05): the pattern is that M1's loss effect is worst on PPLX and best
  on Luna. This is a **model×method interaction hypothesis**, not a finding:
  three DiDs, no multiplicity correction, and the pplx−luna line is fragile —
  in the sensitivity run (§6) its interval reaches +0.03 and includes 0.
- The driver of the interaction is the FP pattern in §4.3, not FN: M1's recall
  gain appears on all three models, but its false-keep cost concentrates on
  PPLX. A method×model story built on recall alone would miss it.

## 6. Sensitivity — excluding the two recovered-error components

The affected components are exactly the two expected ones, both recovered
(attempt 2, HTTP 200, no error class):

| Component | Attempts | Affected cells (score / keep / loss) |
|---|---|---|
| jev M1, replica 1, `P-search-02`, isolated `c268efba53506` | 529 → 200 | score 0.925, keep, **loss 0** |
| pplx M2, replica 1, `P-search-03`, reverse (7 candidates) | 503 → 200 | 2 golds kept (0.999, 0.970), 1 gold kept, 4 negatives dropped — **all loss 0** |

None of the 8 cells the errors touched contributes any loss under the method
they belong to, so they cannot drive any contrast directly.

Re-running the entire analysis with query groups `P-search-02` and
`P-search-03` excluded (38 clusters; same seed/B/pairing):

| Statistic | Full (40) | Sensitivity (38) |
|---|---|---|
| S_0 / S_1 / S_2 | 1.575 / 1.367 / 1.442 | 1.632 / 1.404 / 1.491 |
| D(M1−M0) averaged | 0.208 [−0.217, 0.708] | 0.228 [−0.219, 0.737] |
| D(M2−M0) averaged | 0.133 [−0.083, 0.408] | 0.140 [−0.088, 0.430] |
| D(M1−M2) averaged | 0.075 [−0.30, 0.525] | 0.088 [−0.307, 0.553] |
| D(M1−M0) jev / pplx / luna | 0.275 / −0.200 / 0.550 | 0.289 / −0.158 / 0.553 |
| DiD jev−pplx | 0.475 [0.10, 0.90] | 0.447 [0.053, 0.895] |
| DiD pplx−luna | −0.750 [−1.475, −0.05] | −0.711 [−1.474, 0.026] |
| Spread | 0.750 [0.30, 1.475] | 0.711 [0.263, 1.474] |
| Luna M1 sign counts | W13 T16 L11 | W12 T15 L11 |
| PPLX M1 sign counts | W4 T20 L16 | W4 T20 L14 |

Conclusion of the sensitivity: **nothing in the full analysis is driven by the
two recovered-error components.** Point estimates move by ≤ 0.06, every
interval keeps its sign character, and the only borderline change is the
pplx−luna DiD upper bound crossing 0 (−0.05 → +0.03), which reinforces rather
than weakens the "fragile interaction signal" reading from §5.

## 7. Limitations

1. **Exploratory, post-hoc, uncorrected.** These contrasts, interactions, and
   FP-difference leads were not preregistered; ~60 interval estimates are
   reported with no multiplicity control. Nothing here confirms anything.
2. **n = 40 clusters, 2 replicas.** The paired intervals span 0 for every loss
   contrast; the pilot was sized for a selection decision under A1.1 gates,
   not for interaction detection. Two replicas give a noisy within-candidate
   mean, and cluster resampling cannot recover information the 40 queries do
   not contain.
3. **One repository, one pin** (`18f6463c…`): no cross-repo generalization, as
   A1.2 already states. The corpus is spent for this pilot.
4. **The selector's disqualification stands.** M1/M2 failed integrity
   qualification 5 (capture-gap records exist); the descriptive numerability
   of their scores does not make them eligible, and this analysis deliberately
   does not argue otherwise.
5. **Threshold dependence.** All counts are at the frozen .40 keep threshold
   with the 6:1 penalty; sensitivity to those frozen constants is prohibited
   by A1.1 and was not explored.
6. **Sign-count and max−min caveats.** Per-query win/tie/loss counts ignore
   magnitude, and the max−min spread is upward-biased by construction (§5);
   both are descriptive summaries only.
7. **Spend/latency/cost are not evaluated** (A1.1: cost is not a
   method-selection metric); recorded spend figures in §2 are provenance, not
   results.

## 8. What a confirmation must test

A confirmation run (A1.4: five equal replicas, frozen corpus/arms/method,
owner authorization bound to a confirmation manifest) tests the **selected**
method under the existing gates; it does not re-litigate this pilot. If the
interaction hypothesis is to be tested at all, it must be preregistered
*before* confirmation data exists, with:

1. **A preregistered model×method interaction statistic** — e.g., the pairwise
   DiD of D(M1−M0) (or of S components) with a named primary pair, a
   multiplicity plan across the tested pairs, and an explicit decision rule;
   not the post-hoc spread of §5.
2. **FN/FP decomposition as a co-primary or gated secondary:** the hypothesis
   this pilot suggests is "M1's recall gain is model-general; its false-keep
   cost concentrates on PPLX." A confirmation should specify per-model FN and
   FP non-inferiority/superiority margins rather than relying on the pooled
   6·FN+FP alone, which can mask offsetting movements.
3. **Enough clusters, or acceptance of low power.** With 40 clusters every
   per-model contrast interval here spans 0; either the confirmation accepts
   descriptive estimation, or the corpus (frozen before data) must be sized
   for the interaction test — the pilot cannot be re-run or extended with new
   queries (A1.1 "Prohibited").
4. **Replica count ≥ 3** (A1.4's five, reduced only by the measured-projection
   rule) to separate within-candidate replica noise from between-query
   variance; this pilot's 2 replicas cannot.
5. **A clean integrity path** so alternatives are actually evaluated: the
   capture-gap classification of retried-success components (error responses
   carry no served model) disqualified M1/M2 here; any confirmation design
   should decide *pre-data* how retried transient errors are classified so a
   fully-recovered run is not auto-disqualified (this is a protocol question,
   recorded here as an open item, not a policy change).
6. **Nothing from §4–§6 may select anything.** M0 remains the selected method
   and the deployed Jev/M0 configuration remains the non-selectable reference
   (A1.3); production promotion still requires explicit owner confirmation.

---
*Generated 2026-10-09. Script: `scripts/eval/judge/method-pilot-exploratory.ts`
(unit-tested in `test/unit/judge/method-pilot-exploratory.test.ts`; typecheck,
eslint, and vitest clean). Output JSON is deterministic: reruns are
byte-identical.*
