# Judge confirmation v2 — preregistration (2026-10-09)

**Status: PRE-DATA.** This document freezes the design, estimands, tests,
challengers, integrity rules, power/cost assessment, and the simulation
pass criteria for a fresh, held-out judge-method confirmation study. No
confirmation query has been authored, labeled, sealed, or executed against a
paid endpoint at the time of writing. It changes no pilot verdict, no deployed
method, and no deployed model: the 2026-10-09 pilot outcome
(`docs/plans/2026-10-08-judge-decider-protocol.md` §11, lines 603–605) stands,
the 44-query corpus remains spent DEV, and adoption in production still
requires explicit owner confirmation.

*Simulation validation status (2026-10-09): run — see §7.1. The paired
t-test candidate failed its frozen per-test Type-I criterion; the
pre-committed sign-flip fallback passed and is frozen as the primary
per-model procedure (100,000 draws, seed 20261010, Holm across three).*

Companion artifacts (created together with this document):

| Artifact | sha256 |
|---|---|
| `scripts/eval/judge/method-confirm-analysis.ts` | `f775047dbbfc24f5d8924f6b28beda6f517bfb6aa898b4f5085a9a26e80ca431` |
| `test/unit/judge/method-confirm-analysis.test.ts` | `cef85e7d8b42b5246c692fcd2cd376c91aea4af43cf4056f16206d6cf02fea7e` |

Reproduce (offline, no credentials, no network):

```
npx tsx scripts/eval/judge/method-confirm-analysis.ts \
  --pilot-root ~/.cache/pi-smartread-judge-pilot-20261008 \
  --records ~/.cache/pi-smartread-judge-pilot-20261008/pilot-plan-20261009-a2.json.wire-records.jsonl \
  --plan ~/.cache/pi-smartread-judge-pilot-20261008/pilot-plan-20261009-a2.json \
  --verdict ~/.cache/pi-smartread-judge-pilot-20261008/method-verdict-20261009.json \
  [--simulation] [--procedure sign-flip|paired-t]   # simulation only; default sign-flip
```

Exit 0 on success (one JSON document on stdout), 2 for validation failures,
3 for a corpus/plan gate refusal. The CLI fail-closes unless the loss table
it derives reproduces the sealed verdict's `perModelPerMethod`
byte-for-value, so every pilot-derived number below is on the identical
derivation as `method-verdict-20261009.json`.

---

## 1. Binding owner decisions (verbatim)

1. Retrieval holdout v2 study A5 vs A0, run once on the sealed holdout:
   "approved". *(Governs the retrieval study, not this one; quoted for
   completeness.)*
2. "Conditional approval. Use weighted success@5 with G−2L. Primary paired
   instance-level t-test, subject to simulation validation. Retain hard
   guardrails and report repository heterogeneity." *(Governs the retrieval
   study; the "subject to simulation validation" pattern is mirrored here as
   §7.)*
3. "Conditional approval. Preregister one challenger per model using the
   pilot. Apply Holm across three tests. Assess power and cost."
   **(Governs this study — §§4, 5, 6, 7.)**
4. "Approve. Retain 6:1 and τ=0.40. Separate future calibration by model and
   method." **(Governs this study — §§4.2, 8.)**
5. "Conditional approval. Isolate transport failures, preserve valid retries,
   and forbid unplanned complete-case exclusions." **(Governs this study —
   §6.)**

Supporting 2026-10-09 owner decisions recorded in the confirmation corpus
provenance (`~/.cache/pi-smartread-judge-confirm-20261009/PROVENANCE.md`):
400 queries, per-model method selection as the primary estimand, multiple
repositories, budget cap raised to **$10**.

## 2. Background and evidence

- Methodology audit synthesis:
  `/Users/rhinesharar/.pi/agent/sessions/--Users-rhinesharar-Pi-SmartRead--/subagent-artifacts/e9463313-b83e-446c-ac0e-ae14507789c2_oracle_output.md`
- Confirmation-design oracle (estimands, budget-envelope method):
  `…/subagent-artifacts/d9960866-d3c7-4872-ab4e-dd760942793b_oracle_output.md`
- Evidence ledgers: `/tmp/evidence-audit/{risk,stats,metrics-llm,harness,project-external}.md`.
  External claims below cite ledger IDs; nothing marked REFUTED or
  MISATTRIBUTED is relied on (notably risk R6 — never cite it).
- **Ledger S7 (stats, CORRECTED):** no primary IR source evaluates coverage
  of percentile query-cluster bootstrap CIs for paired differences at
  n ≈ 40–400; Urbano 2019 / Smucker 2007 evaluated the bootstrap-shift
  test / paired t and permutation for mean differences. Hence the primary
  test here is a **paired query-level t-test**, and the owner's
  simulation-validation condition (§7) is mandatory, not decorative.
- **Ledger P5 (project-external, VERIFIED, 2026-10-09):** input prices Jev
  $0.042/M, PPLX decider v1.1 $0.02/M, Luna $0.10/M, output $0 for all three.
  These equal the budget module's pinned tables
  (`scripts/eval/judge/model-comparison-budget.ts:131-135`).

## 3. Scope of this study

A fresh study on **400 new held-out queries** that tests, per model, exactly
one pilot-chosen challenger against M0. It can adopt a challenger *for that
model* (§4.4) or retain M0; it cannot establish a common-method claim, cannot
compare models, and cannot re-litigate the pilot. Interactions
(model × method) are exploratory only.

This is a **prospective amendment** of protocol §9 A1.1's per-model
prohibition ("Prohibited: per-model method choice …", `docs/plans/2026-10-08-judge-decider-protocol.md`
line 503): owner decision 3 authorizes one preregistered per-model comparison
in this fresh study. The prohibition stays in force for the pilot verdict,
the 44-query DEV corpus, and every other stage.

---

## 4. Preregistered design

### 4.1 Challenger selection from the pilot (owner decision 3)

**Rule (frozen):** per model, the challenger is the method in {M1, M2} with
the **lowest pilot weighted loss** (6·FN + FP at τ = 0.40 on
replica-averaged probabilities); an exact tie goes to the **lower projected
cost per query**; a tie on both fails closed (no preference is invented).
Losses are recomputed from the bound pilot rows through the exploratory
module's exported derivation (`buildExploratoryClusterTable` in
`scripts/eval/judge/method-pilot-exploratory.ts`) — no duplicated loss logic
— and pinned to the sealed verdict byte-for-value at run time.

**Result (computed 2026-10-09; the brief's expectation is confirmed exactly,
nothing corrected):**

| Model | M1 loss | M2 loss | Chosen | Rule | Pilot δ̂ = mean(d) | sd(d) | W/T/L vs M0 | ΔFN | ΔFP |
|---|---:|---:|---|---|---:|---:|---|---:|---:|
| `~typesafe/jev-latest` | 59 | 62 | **M1** | loss | −0.275 | 1.5523 | 6 / 27 / 7 | −2 | +1 |
| `perplexity/pplx-decider-v1.1-27b` | 63 | 55 | **M2** | loss | 0.000 | 0.3922 | 2 / 37 / 1 | 0 | 0 |
| `openai/gpt-6-luna-decisions` | 42 | 56 | **M1** | loss | −0.550 | 2.6111 | 13 / 16 / 11 | −4 | +2 |

(d = L_challenger − L_M0 per query, n = 40 pilot queries, 2 replicas
averaged within candidate before thresholding; W/T/L counts negative/zero/
positive d; ΔFN/ΔFP = challenger − M0.)

**The pilot is used only to choose WHICH comparison to test.** Nothing in
§4.1 is an effect claim: the pilot's intervals all span 0
(`docs/plans/2026-10-09-method-pilot-exploratory-analysis.md` §4.2), its
selection gates were never reached (§11 of the protocol), and its point
estimates enter this document only as planning inputs.

### 4.2 Fresh study

- **Corpus:** 400 new held-out queries = 320 answerable + 80 absence across
  8 repositories (`~/.cache/pi-smartread-judge-confirm-20261009/allocation.json`;
  Pi-SmartRead at pin `18f6463caa78e6657b1af6c7eb86b711bc2364f8` plus seven
  license-cleared repositories at predeclared pins). Queries are **being
  authored and must be sealed (fixtures, labels, adjudications, ordering,
  payload hashes, schedule, replica count, analysis code, seed, decision
  rule) before any paid call.** Disjointness covers all 84 prior query groups
  (44 DEV + 40 pilot), exclusion-only reads of old wording, and no old judge
  outputs.
- **Arms:** each model runs **M0 and its §4.1 challenger only** (Jev M0+M1,
  PPLX M0+M2, Luna M0+M1). PPLX's M2 forward leg reuses M0's packed calls
  (two packed calls per query per replica for the method; only the reverse
  leg is marginal — protocol line 533).
- **Replicas:** 3 (or the ladder's frozen count — see open question Q1).
- **Payload/ordering conventions:** identical to the pilot (same pack shape,
  neutral label-independent candidate order, cache disabled, per-status retry
  policy within the three-attempt ceiling, warmups identified by the warmup
  flag).
- **Thresholds/penalties:** frozen at τ = 0.40 and 6:1 (owner decision 4;
  protocol lines 486–489). No retuning.

### 4.3 Per-model estimand and test (owner decisions 3, 4)

For query q and model a:

```
d_{a,q} = L_{a,C,q} − L_{a,M0,q},   L = 6·FN + FP at τ = 0.40
            on replica-averaged probabilities
δ_a = E_q[d_{a,q}]                     (negative favours the challenger)
```

- **Test:** one-sided paired **query-level t-test**, H0: δ_a ≥ 0 vs
  H1: δ_a < 0, per model. *(§7.1: this t-test candidate later failed its
  simulation-validation criterion, and the pre-committed sign-flip
  permutation test of the same mean d — same hypotheses, same Holm
  step-down — became the frozen primary procedure; §7.1 records the
  choice.)*
- **Multiplicity:** **Holm step-down across the three models at FWER 0.05**
  (thresholds α/3, α/2, α by ascending p; ties broken by fixed model order
  Jev → PPLX → Luna; stop at the first non-rejection).
- **Adoption rule:** adopt the challenger for model a **iff** Holm rejects
  for a **and** the inherited FN guard holds — protocol §9 A1.1
  qualification 3, line 495: *"**Recall (FN) guard:** no model has more than
  **one additional FN** versus that model's M0 result."* Applied per model:
  challenger FN for model a must not exceed M0's FN for model a by more
  than one. Otherwise retain M0 for that model.
- **Report all three models regardless of outcome.** No common-method claim;
  model × method interactions are exploratory. Every p-value, effect, and
  interval is reported whether or not it rejects (no outcome-dependent
  reporting).

### 4.4 Integrity (owner decision 5)

Amendment **A3** is adopted and live: protocol §12, lines 609–633.
Cross-references (recorded here because §12 is appended concurrently by
another writer; the section exists in
`docs/plans/2026-10-08-judge-decider-protocol.md` as of this writing):

- **Classification (§12 A3.2, lines 617–621):** a received NON-2xx whose body
  carries no served model is a **transport-class failure** (`http_<status>`,
  real status, null identity, UNKNOWN cost settled with its reserve
  retained), retried per the frozen policy within the three-attempt ceiling;
  `capture_gap` is reserved for exactly one case — a received **2xx** whose
  served identity cannot be captured (lines 620).
- **Recovery (§12 A3.3, lines 623–626):** a transport error is RECOVERED when
  a later attempt for the same planned payload (same arm, method, replica,
  query group, and payload hash, higher attempt index) is a verified success;
  **recovered transport errors set no integrity flag.** The integrity gate
  still fires for any `capture_gap`, any planned component whose **final
  attempt is not a verified success**, served-identity drift, payload drift,
  or an aborted run (line 626).
- **Era boundary (§12 A3.4, lines 628–632):** A3 semantics apply only to
  A3-stamped records; the pilot artifacts are unstamped and permanently
  A1/A2-era. This confirmation will run A3-stamped and is prospective only.

Applied to this study:

- **Transport failures are isolated** from quality outcomes: they live in
  the attempt/cost/reliability ledgers, never as scored probabilities.
- **Valid retries are preserved** (attempt 2 success counts; both attempts
  stay in the ledgers; the scored cell comes from the verified success).
- **No unplanned complete-case exclusions.** Every planned
  query × model × method × replica cell must be present: no partial
  averaging, no candidate dropping, no score substitution, no selective
  removal, no favourable rerunning (§12 A3.3 line 626; A1.1 qualification 4,
  line 496). A missing cell **after the retry budget is exhausted blocks
  that model's test only** — that model reports "blocked: incomplete", the
  other two models' tests still run, and nothing is silently dropped.
  UNKNOWN billing keeps its reservation; missing cost is never $0.

### 4.5 Calibration (owner decision 4)

"Retain 6:1 and τ=0.40. Separate future calibration by model and method."
No threshold, penalty, or calibration change is made or implied here. Any
τ/calibration change is a **separate future study, per model and method**,
preregistered before its own data.

### 4.6 Reporting

For each model: δ̂ with a two-sided 95% t-interval, the FN/FP split of d,
W/T/L counts, the raw and Holm-adjusted p-values, and the adopt/retain
decision with its reason. Additionally, overall:

- **Repository heterogeneity across the 8 repos** in `allocation.json`
  (per-repo δ̂ descriptive breakdown; repository is not an inference unit).
- **First-attempt vs eventual completion** (availability, retries, recovered
  transport errors, blocked cells — A3's ledgers).
- **Cost:** known spend, UNKNOWN reservations, per-model per-method token
  totals, and the ledger position against the cap.
- All three models are reported even when one is blocked.

---

## 5. Power assessment (owner decision 3)

Analytic planning numbers from the pilot per-query d distributions of the
**chosen** challengers, at n = 400, one-sided level α/3 = 0.0167 (Holm's
first step / Bonferroni level — the conservative per-test planning number;
actual Holm-procedure power comes from the §7 simulation). Normal
approximation with the pilot query-level sd:

| Model (challenger) | δ̂ | sd | Power @ n=400, pilot effect | Power @ n=400, 50% shrinkage | n for 80% (pilot effect) | n for 80% (50% shrinkage) |
|---|---:|---:|---:|---:|---:|---:|
| Jev (M1) | −0.275 | 1.5523 | **0.921** | 0.361 | **281** | 1124 |
| PPLX (M2) | 0.000 | 0.3922 | **0.0167 (≈ α)** | 0.0167 | **∞** | ∞ |
| Luna (M1) | −0.550 | 2.6111 | **0.981** | 0.491 | **199** | 796 |

Read plainly:

- **Jev and Luna** have roughly adequate directional power at their pilot
  magnitudes (92% / 98%), and are underpowered at half the effect (36% /
  49%) — shrinkage is the main risk.
- **PPLX's challenger effect is exactly 0 in the pilot** (M2 total loss 55 =
  M0's 55; 37 of 40 queries tie): **its power is ≈ α (0.0167).** Under the
  pilot point estimate the PPLX test is a formality — a Holm rejection would
  be surprising, and realistically PPLX retains M0 unless the fresh data
  show a real effect. The PPLX d-sd is very small (0.392), so a *nonzero*
  effect would be detected: at δ = −0.05 the same approximation gives ≈
  0.66 and at δ = −0.10 ≈ 0.999. The honest statement is: **the pilot
  provides no evidence of any PPLX M2 benefit, so this test is powered to
  find an effect if one exists on the fresh corpus, but has nothing to find
  at the pilot's point estimate.**
- These are planning calculations conditional on transferable pilot
  variance and independent queries across 8 repositories (they may not
  transfer — the oracle flags correlated behaviours and optimistic pilot
  effects as principal risks). Replicas do not multiply n; the query is the
  independence unit.
- The §7 simulation resamples the empirical pilot d (it preserves skew and
  sparsity that the normal approximation hides) and must PASS its criteria
  before this design is executed. *(§7.1: the paired t-test failed its
  per-test Type-I criterion; the pre-committed sign-flip permutation
  procedure passed and is now the frozen primary — same hypotheses, same
  Holm step-down.)*

## 6. Cost assessment (owner decision 3)

Method: wireId-deduplicated pilot aggregation (first row per wireId; the
method of the pilot aggregation script, not a copy of the file), scored
(non-warmup) input tokens ÷ (40 queries × 2 replicas) × live input price
(ledger P5; output $0). Packed requests bill ≈5× tokens per request — the
PPLX rows carry 22,976 input tokens/request vs ≈4.5k elsewhere — which is
why token-derived cost, not headline prices, drives M0.

**Cost per query per replica (pilot-derived, 2 replicas normalized out):**

| Model | Method | $/query/replica | Mean input tokens/request |
|---|---|---:|---:|
| Jev | M0 (packed) | $0.00018832 | 4,484 |
| Jev | **M1 (challenger, singletons)** | $0.00026470 | 900 |
| PPLX | M0 (packed) | $0.00045952 | 22,976 |
| PPLX | **M2 full (forward + reverse packed)** | $0.00091904 | 22,976 reverse (forward = M0's calls) |
| PPLX | M2 marginal (reverse only; forward shared with M0) | $0.00045952 | 22,976 |
| Luna | M0 (packed) | $0.00045777 | 4,578 |
| Luna | **M1 (challenger, singletons)** | $0.00048271 | 690 |

**Campaign envelope (400 queries × 3 replicas; challenger = marginal cost):**

| Line | USD |
|---|---:|
| Scored requests (400 × 3 × Σ(M0 + marginal challenger) = $0.0023125/query/replica) | $2.7751 |
| Warmup allowance (3 replicas: pilot-observed M0 warmups + 1 assumed reverse-packed warmup/replica for PPLX; M1 warmed nothing in the pilot) | $0.00166 |
| Deferred 44-query three-model M0 suite (oracle §5 approximation at 3 replicas; must be re-projected from its own payload before authorization) | $0.14 |
| **Nominal total** | **$2.9167** |
| ×3 billed attempts per planned request | $8.7501 |
| + 2 UNKNOWN reservations per model (budget-module `requestReserveUsd`: 0.001344 + 0.01048576 + 0.105) | $0.23366 |
| + largest next-call admission reserve (Luna full-context) | $0.105 |
| **Stress total (oracle envelope conventions)** | **$9.0888** |

Against the raised cap: **$10 − $0.3613 = $9.6387 remaining.** Nominal fits
(leaving ≈$6.72); the stress envelope fits (leaving ≈$0.55). No double
counting: retained UNKNOWN reservations are not re-counted as spend, and the
M2 forward leg is billed once (as M0).

`CAMPAIGN_TOTAL_CAP_USD = 3` in
`scripts/eval/judge/model-comparison-budget.ts:97` **must be amended
prospectively to 10 before any paid execution** (owner-raised cap,
2026-10-09). Not edited here — see open question Q2.

---

## 7. Simulation validation (Monte Carlo)

<!-- SIM-CRITERIA-START -->
**Purpose:** validate that the frozen primary procedure (one-sided paired
query-level t-test + Holm step-down, n = 400) keeps its error rates under
the *empirical* pilot per-query d distributions — the paired t-test's
normal-theory p-values are unvalidated at these sizes and distributions
(ledger S7).

**Design (frozen):**

- Seed **20261009**, PRNG mulberry32 (the selector's exported helper),
  **reps = 20,000** (≥ the required 20,000), n = 400 draws with replacement
  per model per rep from that model's 40 pilot per-query d values.
- **Type I:** each model's d is centred to its own mean first (δ = 0
  exactly), then resampled. Per-test Type I = rejection rate of raw
  p < 0.05; FWER = rate of ≥1 rejection under Holm across the three models.
- **Power:** the same centred resample shifted by (i) the pilot point
  estimate δ̂ and (ii) 0.5·δ̂; per-model power = Holm rejection rate for that
  model. (Adding a constant moves only the sample mean, so one sample
  mean/sd per rep serves all three scenarios; draws are shared across
  scenarios — deterministic and unbiased per scenario.)
- Reported per model: Type I, power@point, power@half; plus Holm FWER.

**PASS criteria (written 2026-10-09 before the simulation was executed):**

> **PASS ⟺ per-test Type I ≤ 0.06 for every model AND Holm FWER ≤ 0.06.**

**Pre-committed fallback:** if the criteria fail, the one alternative to be
named and validated (frozen before any confirmation data exists or is
unsealed) is the **paired query-level sign-flip permutation test of the mean
d (exact null by construction, 100,000 draws, seed 20261010) with the same
Holm step-down across the three models**, re-validated under the identical
simulation design before adoption. It is chosen now, pre-data, because
ledger S7 supports permutation tests for paired mean differences; no other
alternative will be considered post-hoc.

**Scope:** the simulation validates the statistical test only. It does not
model the FN guard, integrity blocking, or adoption, so simulated "power" is
an upper bound on adoption probability.

**Order of operations (recorded):** (1) this §7 criteria block was written;
(2) its sha256 was computed (block between `SIM-CRITERIA-START/END`
markers); (3) the simulation was executed with the frozen seed; (4) results
were appended in §7.1 together with that hash. The §7.1 results could not
have influenced §7.
<!-- SIM-CRITERIA-END -->

### 7.1 Simulation results (appended after the run)

**Fixity of the criteria block.** sha256 of the §7 criteria block,
taken from the criteria-block START marker comment line through its END
marker comment line (currently lines 340–384, inclusive — 45 lines):
`3dd410ad2689a1c06da7456a0bfc7e970fee2d3b42183e8bff2c3827d4ca4454`,
computed 2026-10-09T02:16Z when these results were recorded.

**Erratum to §7's order-of-operations statement (orchestrator, 2026-10-09).**
Step (2) did not happen as written: no hash of the criteria block was taken
before the simulation; the hash above was computed afterwards (02:16Z). The
block is left byte-unchanged so that hash stays valid. Pre-run fixity rests
instead on the authoring worker's tool transcript (run `c3566cbf`, archived
mode 0600 at
`~/.cache/pi-smartread-judge-confirm-20261009/provenance/prereg-judge-worker-c3566cbf-transcript.jsonl`,
sha256 `caefd52c3e8c30a78577b6d56fe76b4ecad116cbe77823e0113ba19deac02c0e`):
the document was first written at **2026-10-09T01:06:37Z** (transcript
entry 189), including the PASS criteria and the pre-committed sign-flip
fallback (100,000 draws, seed 20261010); the first simulation command ran
at **01:08:15Z** (entry 213). That 01:06:37Z document is archived as
`provenance/judge-prereg-snapshot-20261009T010637Z.md` (sha256
`d78c26a9c1d797016ca1f85349476039dd0bf3875bb920d93a79bf02a77102b5`), and
its PASS-criteria + fallback paragraphs are byte-identical to the current
§7 text (verified by `diff`). Both runs
use exactly the frozen design: seed 20261009 (mulberry32), 20,000 reps,
n = 400 with-replacement draws per model from that model's 40 centred
pilot per-query d values. Every rate below reports Monte-Carlo standard
error MC SE = √(p(1−p)/20 000).

**The fallback was pre-committed before these results.** §7 (lines
366–373, inside the criteria block above) names the *only* fallback,
written pre-run: "the **paired query-level sign-flip permutation test of
the mean d** (exact null by construction, 100,000 draws, seed 20261010)
with the same Holm step-down across the three models … no other
alternative will be considered post-hoc." It was pre-registered in this
document before §7.1 existed — it is not a post-hoc choice.

**Run A — paired t-test (the §4.3 primary candidate), 2026-10-09.**
Reproduce command = the block at the top of this document plus
`--simulation --procedure paired-t`. Start 02:05:45Z, end 02:05:46Z
(wall ≈ 0.9 s), exit 0. An independent reviewer rerun earlier the same
day reported the identical values (per-test Type I 0.0652, FWER 0.0503),
and a rerun at 02:15:48Z was byte-identical to Run A.

| Model | Type I (MC SE) | Power @ pilot δ̂ (MC SE) | Power @ 0.5·δ̂ (MC SE) |
|---|---:|---:|---:|
| Jev (M1) | 0.03605 (0.00132) | 0.9732 (0.00114) | 0.3778 (0.00343) |
| PPLX (M2) | **0.0652 (0.00175)** | 0.06435 (0.00174) | 0.0415 (0.00141) |
| Luna (M1) | 0.04545 (0.00147) | 0.9916 (0.00065) | 0.5230 (0.00353) |
| **Holm FWER / any-rejection** | **0.0503 (0.00155)** | 0.99945 | 0.6761 |

**Run A verdict: FAIL.** PPLX per-test Type I 0.0652 > the frozen 0.06
limit (excess 0.0052 ≈ 3.0 MC SE — not simulation noise); FWER 0.0503
passes, but PASS requires both conjuncts. The paired t-test does not
validate at these empirical distributions, consistent with ledger S7.

**Run B — the pre-committed sign-flip fallback, 2026-10-09.** Start
02:06:23Z, end 02:07:23Z (wall ≈ 60 s), exit 0; command = the top block
plus `--simulation --procedure sign-flip`. Parameters: resample seed
20261009 (as §7); inner sign-flip null B = 10,000 draws per p-value
(`CONFIRM_SIMULATION_SIGN_FLIP_DRAWS`, fixed in the script before this
run; p-value granularity 10⁻⁴), sign-matrix seed 20261010
(`CONFIRM_SIGN_FLIP_SEED` — the §7-precommitted seed), one shared sign
matrix across reps. The *production* test for the real study remains the
§7-frozen 100,000 draws / seed 20261010. Determinism: reruns
02:09:58–02:11:00Z, 02:14:45–02:15:48Z, and after the final lint-only
refactor ≈02:17Z all exited 0 with byte-identical output.

| Model | Type I (MC SE) | Power @ pilot δ̂ (MC SE) | Power @ 0.5·δ̂ (MC SE) |
|---|---:|---:|---:|
| Jev (M1) | 0.0400 (0.00139) | 0.97485 (0.00111) | 0.40355 (0.00347) |
| PPLX (M2) | 0.0554 (0.00162) | 0.0545 (0.00161) | 0.0352 (0.00130) |
| Luna (M1) | 0.0509 (0.00155) | 0.99185 (0.00064) | 0.5425 (0.00352) |
| **Holm FWER / any-rejection** | **0.0492 (0.00153)** | 0.99955 | 0.6984 |

**Run B verdict: PASS** — every per-model Type I ≤ 0.06 and Holm FWER
0.0492 ≤ 0.06. Reading of the PPLX row: its pilot δ̂ is exactly 0, so
both power scenarios are literally the null resample (identical p-value
vectors); both rows measure size, and their gap comes only from Holm's
dependence on Jev's and Luna's scenario-specific p-values plus MC noise
— exactly the §5 statement that this test has power ≈ α at the pilot's
point estimate.

**Frozen choice.** The paired-t candidate failed its criterion, so the
§7 pre-committed fallback becomes the **PRIMARY procedure**: one-sided
paired query-level **sign-flip permutation test of the mean d**, per
model (H0: δ_a ≥ 0 vs H1: δ_a < 0), **Holm step-down across the three
models at FWER 0.05**, production **100,000 draws, seed 20261010**, in
force from this document onward; the analysis script defaults to
`--procedure sign-flip`. The paired-t results are retained above as the
failed candidate and remain runnable for transparency. No third
procedure was considered, per §7. (A timed-out worker's prototype had
reported 0.041/0.057/0.050 with FWER 0.0528 for sign-flip; those
prototype numbers are superseded by Run B from the integrated script,
which is authoritative.)

**Scope** (unchanged from §7): the simulation validates the statistical
test only — not the FN guard, integrity blocking, or adoption — so the
power columns are an upper bound on adoption probability.

---

## 8. Open owner questions

**Budget position (context for Q2/Q3):** the oracle stress envelope totals
**$9.0888** against **$9.6387** remaining ($10 − $0.3613) → **≈$0.55
headroom** (§6). `CAMPAIGN_TOTAL_CAP_USD = 3`
(`scripts/eval/judge/model-comparison-budget.ts:97`) **must be raised to
10 prospectively, before any paid execution**; it is deliberately *not*
edited in this worktree — see Q2.

1. **Replica count.** A1.4 (protocol line 523) says confirmation starts at
   **five** equal replicas, reducible 5→4→3 only when the *measured*
   projection exceeds the cap. This preregistration freezes **3** per the
   confirmation brief and the 2026-10-09 confirmation design. Under the $10
   cap a five-replica projection fits nominally (400 × 5 × $0.0023125 +
   warmups + $0.14 ≈ $4.77) but the oracle's stress envelope at five
   replicas (≈ $14.7) does not fit, so the ladder's measured projection
   would reduce it anyway. **Ruling needed: is 3 frozen outright for this
   study, or does A1.4's ladder (5 by default, reduced by measured
   projection) apply?**
2. **Cap amendment.** `CAMPAIGN_TOTAL_CAP_USD` must move 3 → 10
   prospectively (pre-execution, before the first paid attempt); confirm who
   applies and reviews it.
3. **Deferred 44-query M0 suite.** Carried at the oracle's $0.14 (3
   replicas) approximation; its payload-specific projection must replace
   this before authorization (oracle §5).
4. **PPLX test.** Power ≈ α at the pilot's exact-zero effect (§5). Run
   anyway (preregistered; a real fresh-corpus effect would be found), or
   drop PPLX to two tests and simplify Holm to m = 2? This document assumes
   **run all three**; changing it is a pre-data owner decision.

---

*Generated 2026-10-09 by the confirmation-prereg worker. Analysis:
`scripts/eval/judge/method-confirm-analysis.ts` (pure/deterministic core;
unit tests in `test/unit/judge/method-confirm-analysis.test.ts`).*
