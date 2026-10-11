# Evaluation Protocol: Perplexity Decider V1 27B and OpenAI GPT-6 Luna Decisions vs. TypeSafe Jev

**Document ID:** `docs/plans/2026-10-08-judge-decider-protocol.md`  
**Date:** 2026-10-08  
**Status:** Preregistered Protocol & Benchmark Specification  
**Branch:** `feat/judge-decider-benchmark` (from `5e68459`)  
**Worktree:** `/Users/rhinesharar/Pi-SmartRead-judges`  
**Isolation Scope:** Runtime isolation active; protects installed runtime and the frozen E18 retrieval experiment matrix (`~/.cache/pi-smartread-bench/fresh-cohort/MANIFEST.sha256.json`). No source edits, zero paid calls, zero installations, zero commits, and zero subagents permitted in this stage.

---

## 1. Executive Summary & Preregistration Scope

### 1.1 Objective
This protocol establishes an empirical, preregistered benchmark comparing two prospective cloud decision models—**Perplexity Decider V1 27B** (`perplexity/pplx-decider-v1-27b`) and **OpenAI GPT-6 Luna Decisions** (`openai/gpt-6-luna-decisions`)—against Pi-SmartRead's incumbent cloud judge model, **TypeSafe Jev** (`~typesafe/jev-latest`), accessed via OpenRouter's native Decisions API (`POST https://openrouter.ai/api/alpha/decisions`).

The default cloud model will be updated **only if conclusive empirical evidence** proves improvement or non-inferiority under strict preregistered quality, safety, and operational gates. If results are inconclusive, show regression on safety vetoes, or demonstrate operational instability, the default will remain `~typesafe/jev-latest`.

### 1.2 Boundary Conditions & Invariants
1. **No Source Edits in Benchmark Stage:** The product codebase (`src/**`) remains frozen. Existing wire implementations in `src/judge/cloud-judge.ts` and `src/judge/systemone-client.ts` already consume the shared SystemOne/Decisions schema.
2. **Runtime Isolation & Protection:** The frozen E18 retrieval matrix and sealed generalization holdouts (`~/.cache/pi-smartread-bench/d46/holdout/` and `~/.cache/pi-smartread-bench/fresh-cohort/`) must remain completely untouched and unread.
3. **Generalization Status (Spent DEV Declaration):** The 44-query / 314-item labeled dataset (`set-a.jsonl` and `set-b.jsonl`) is formally designated as **spent development data** (DEV), as established in Decision D46. Performance on this set demonstrates internal calibration and retrieval guard behavior, **not fresh generalization**. Any promotion claim to production default requires explicit human owner confirmation.
4. **No Chat-Completion Substitution:** All evaluation must run strictly against OpenRouter's Decisions API route (`/api/alpha/decisions`). Substituting chat completion models (e.g., standard GPT-6 Luna or Perplexity Sonar via `/v1/chat/completions`) is strictly forbidden.
5. **No Decider V1.1 Substitution:** Although Perplexity Decider V1.1 27B is cataloged, the evaluation is explicitly pinned to the requested `perplexity/pplx-decider-v1-27b`.
6. **Owner-Authorised Spend (Aggregate $2 Cap, Staged):** The owner explicitly approved the probe plus any subsequent benchmark UNDER a $2 aggregate total (not $2 each). Stage A executes ONLY the tiny metering probe (1 actual HTTP attempt/model, 3 total, spend <= $0.01); the full scored benchmark runs in a separate future stage and only after the measured probe usage/cost/latency and the conservative full-run estimate are audited against the remaining budget.
7. **Runtime Mode Invariant:** Runtime judge mode remains `off` by default. Changing the cloud judge model default alias only takes effect when a user or test explicitly configures cloud judging.

---

## 2. Official Model Profiles, Endpoints & Verified Wire Specifications

Authoritative sources were verified directly from official OpenRouter model pages and Decisions API documentation (`https://openrouter.ai/perplexity/pplx-decider-v1-27b`, `https://openrouter.ai/openai/gpt-6-luna-decisions`, and `https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-questions-and-answers-request`).

### 2.1 Model Profile Matrix

| Attribute | Incumbent: TypeSafe Jev | Challenger 1: Perplexity Decider V1 27B | Challenger 2: OpenAI GPT-6 Luna Decisions |
| :--- | :--- | :--- | :--- |
| **Model Slug** | `~typesafe/jev-latest` (or `typesafe/jev-1.13`) | `perplexity/pplx-decider-v1-27b` | `openai/gpt-6-luna-decisions` |
| **Upstream Provider** | TypeSafe | Perplexity | OpenAI |
| **OpenRouter Hosting** | 1 provider (direct forward) | 1 provider (direct forward) | 1 provider (direct forward) |
| **API Endpoint** | `POST https://openrouter.ai/api/alpha/decisions` | `POST https://openrouter.ai/api/alpha/decisions` | `POST https://openrouter.ai/api/alpha/decisions` |
| **OpenRouter Modalities** | Text state $\to$ structured decisions | Text and JSON state $\to$ structured decisions | Text, JSON, image state $\to$ structured decisions |
| **Context Window** | 32,000 tokens | 262,144 tokens (262K) | 1,050,000 tokens (~1.1M) |
| **Question Limit / Req** | Up to 128 questions (token budget capped) | Up to 128 questions | Up to 200 questions |
| **Advertised Input Price** | **$0.042 / 1M tokens** | **$0.040 / 1M tokens** | **$0.100 / 1M tokens** |
| **Advertised Output Price**| **Free ($0.00)** | **Free ($0.00)** | **Free ($0.00)** |
| **Advertised Latency (p50)**| 0.294 s (measured historical) | 0.30 s (advertised) | 0.21–0.22 s (advertised) |
| **Advertised Availability** | 99.9%+ | 99.98% (3-day availability) | **96.35% (3-day availability)** *(Warning: elevated error rate)* |
| **Served Snapshot ID (measured 2026-10-07)** | `typesafe/jev-1.13-20260917` | `perplexity/pplx-decider-v1-27b-20261001` | `openai/gpt-6-luna-decisions-20261006` |

*Note on Pricing:* Listed prices ($0.04/M, $0.10/M) are advertised baseline provider cards, not measured usage. Historical Jev cloud benchmarks measured $0.00717 across 314 judgments (~$0.000023/judgment). Measured costs will be captured directly from response `usage.cost` during evaluation.

### 2.2 Decisions API Wire Contract (`POST /api/alpha/decisions`)

The wire format is strictly unified across all three models:

#### Request Headers
```http
POST /api/alpha/decisions HTTP/1.1
Host: openrouter.ai
Authorization: Bearer <OPENROUTER_API_KEY>
Content-Type: application/json
```

#### Request Body Structure
```json
{
  "model": "<model_slug>",
  "state": {
    "query": "<search_query>",
    "units": {
      "<unit_id>": {
        "path": "<file_path>",
        "symbol": "<symbol_name>",
        "text": "<line_numbered_code_excerpt>"
      }
    }
  },
  "questions": {
    "<unit_id>": {
      "type": "noul",
      "instructions": "Does `units.<unit_id>` substantively implement, define, or explain part of \"<query>\"? Apply `criteria`.",
      "criteria": {
        "true": "This unit contains an implementation, definition, or substantive explanation of an important part of the search. A helper implementing one requested step counts even when other steps are elsewhere.",
        "false": "This unit only mentions, calls, imports, tests, or configures the subject, or contains unrelated code sharing keywords."
      }
    }
  }
}
```

#### Success Response Structure (`200 OK`)
```json
{
  "id": "gen-dec-1789738314-X5e5eKGQdvR9rblyX250",
  "model": "typesafe/jev-1.13-20260917",
  "provider": "TypeSafe",
  "answers": {
    "<unit_id>": {
      "type": "noul",
      "noul": 0.96
    }
  },
  "usage": {
    "input_tokens": 476,
    "output_tokens": 70,
    "cost": 0.000019992
  }
}
```

#### Compatibility with Existing Pi-SmartRead Client
As verified in `src/judge/systemone-client.ts` (`validateAnswers` and `postSystemOneDecisions`):
1. `validateAnswers` accepts both primitive numbers `answers[k] = 0.96` and object answers `answers[k] = { "type": "noul", "noul": 0.96 }`.
2. `usage.cost` maps automatically to `usage.costUsd`.
3. `usage.input_tokens` maps automatically to `usage.inputTokens`.
4. All three models match the existing wire parser without requiring client adaptations.

---

## 3. Benchmark Corpus, DEV Fixture Inventory & Provenance

### 3.1 Exact Fixture Location & Provenance
The benchmark uses the audited unit relevance fixtures created for the SmartRead judge spike on 2026-10-05:

- **Location:** `~/.cache/pi-smartread-judge-spike/eval/`
  - Set A: `~/.cache/pi-smartread-judge-spike/eval/set-a.jsonl` (159 rows, 22 queries)
  - Set B: `~/.cache/pi-smartread-judge-spike/eval/set-b.jsonl` (155 rows, 22 queries)
- **Total Corpus Size:** 314 labeled units across 44 queries (78 gold positives, 236 negatives: mixture of `hard_negative` and `easy_negative`).
- **Target Repository Revision:** Commit `18f6463caa78e6657b1af6c7eb86b711bc2364f8`. Source lines and code units are extracted deterministically via `git show 18f6463caa78e6657b1af6c7eb86b711bc2364f8:<file>` as implemented in `scripts/eval/judge/run.ts:sourceRange`.
- **Fixture Hash Binding:** Per `scripts/eval/judge/grep-e2e.ts:726-729`, the canonical fixture hash is computed as:
  $$\text{fixtureSha} = \text{SHA256}(\text{bytes}(\text{set-a.jsonl}) \parallel \text{bytes}(\text{set-b.jsonl}))$$
- **Historical Baseline Record (Jev):** Mode `0600` run report at `~/.cache/pi-smartread-judge-spike/bench/results-2026-10-05T14-09-25-547Z-p95695.json`:
  - AUROC: $0.9592$ (set-a: $0.9704$, set-b: $0.9495$)
  - ECE: $0.1368$
  - Precision / Recall at $\tau = 0.20$: $0.4968$ / $1.0000$ (78 TP, 79 FP, 0 FN)
  - Precision / Recall at $\tau = 0.40$ (multi-run pooled): $0.6055$ / $0.9936$ (310 TP, 202 FP, 2 FN)
  - Precision / Recall at $\tau = 0.45$: $0.6210$ / $0.9872$ (77 TP, 47 FP, 1 FN)
  - Latency: p50 $294\text{ ms}$, p95 $470\text{ ms}$, warmup $778\text{ ms}$
  - Billed Cost: $\$0.00717$ ($170,832$ input tokens + $1,078$ warmup tokens)

### 3.2 Sealed Retrieval Holdouts Boundary
To strictly prevent gold leakage and maintain evaluation integrity:
- **PROHIBITED:** Any access to `~/.cache/pi-smartread-bench/d46/holdout/` (210 queries, manifest `4eb3f560...55b3e`).
- **PROHIBITED:** Any access to `~/.cache/pi-smartread-bench/fresh-cohort/` (112 queries, manifest `e77681c7789d4af8750ee1a2fd2ea484610150db1c41a26ea9e72b9c973b4978`).
- **PROHIBITED:** Any new dataset labeling or ad-hoc query authoring in this task.
- **Spent DEV Status Declaration:** Because the $\tau = 0.40$ keep gate was tuned on `set-a`/`set-b` during D4, these fixtures cannot serve as an independent test of general retrieval performance. They serve exclusively as a **calibration and unit-level regression harness**.

---

## 4. Preregistered Evaluation Methodology & Decision Gates

All comparison criteria, veto rules, and statistical metrics are frozen **before any scored runs take place**.

### 4.1 Evaluation Sequence
1. **Operating Point (Same Threshold First):** Evaluate all models first at the established production operating points without retuning:
   - Full-text keep gate: $\tau_{\text{keep}} = 0.40$
   - Signature pointer gate: $\tau_{\text{pointer}} = 0.45$
   - Existence abstention floor: $\tau_{\text{exists}} = 0.35$
2. **Development Calibration Analysis:** Evaluate probability distributions, raw calibration curves, and optimal thresholds on DEV separately. No threshold tuning on holdout data.
3. **Replicate Protocol:** For each model, execute 5 independent, cache-disabled replicates interleaved in balanced order to account for OpenRouter server-side score noise ($\pm 0.04$ observed in Jev).

### 4.2 Primary Metrics & Quality Gates

#### Metric Definitions
- **AUROC (Area Under the ROC Curve):** Computed with exact tie-handling:
  $$\text{AUROC} = \frac{1}{|P| \cdot |N|} \sum_{i \in P} \sum_{j \in N} \left( \mathbf{1}_{p_i > p_j} + 0.5 \cdot \mathbf{1}_{p_i = p_j} \right)$$
  Evaluated for Gold vs. All Negatives and Gold vs. Hard Negatives only.
- **Expected Calibration Error (ECE):** 10 equal-width bins over $[0, 1]$:
  $$\text{ECE} = \sum_{b=1}^{10} \frac{|B_b|}{N} \left| \overline{p}_b - \overline{y}_b \right|$$
- **Brier Score:** Mean squared error of probabilities against binary labels ($y \in \{0, 1\}$):
  $$\text{Brier} = \frac{1}{N} \sum_{i=1}^N (p_i - y_i)^2$$
- **Hard-Negative Precision at $\tau = 0.40$:** Precision evaluated over the subset of gold and hard negatives, measuring resistance to distractor code sharing keywords.
- **Expected Utility Loss:** Prespecified search loss function with a $6:1$ false-negative to false-positive penalty:
  $$\mathcal{L} = 6 \cdot \text{FN} + 1 \cdot \text{FP}$$
- **Query-Cluster Paired Bootstrap CIs:** 2,000 bootstrap iterations resampled with replacement at the query cluster level (`qid`), seeded with PRNG `mulberry32` (via `scripts/eval/judge/ir-metrics.ts`).

#### Mandatory Decision Gates

```
                                  [Scored DEV Evaluation]
                                             │
                                    ┌────────┴────────┐
                                    ▼                 ▼
                         [Gold-Recall Harm Veto]   [Operational Veto]
                         Lower CI(ΔRecall) < -0.02  Availability < 99.5%
                         or Net FN > 1             or Unjudged > 1%
                                    │                 │
                           YES ─────┴────────┬────────┴───── YES
                            │                │
                            ▼                ▼
                       [DISQUALIFIED]   [DISQUALIFIED]
                       (Keep Jev)       (Keep Jev)
                                             │ NO
                                             ▼
                                  [Non-Inferiority Checks]
                                  • AUROC non-inferior (Δ ≥ -0.02)
                                  • Hard-Neg Precision (Δ ≥ -0.03)
                                  • Brier non-inferior (Δ ≤ +0.02)
                                  • Utility Loss ≤ Jev
                                             │
                                    ┌────────┴────────┐
                             PASSES │                 │ FAILS
                                    ▼                 ▼
                          [Candidate Qualified]  [Inconclusive]
                          (Compare Cost/Latency)  (Keep Jev)
```

1. **Gate 1: Gold-Recall Harm Veto (Hard Veto):**
   In code retrieval, dropping relevant code is catastrophic. If a challenger causes a statistically significant decrease in gold recall at $\tau = 0.40$ (paired difference 95% CI lower bound $< -0.02$) or adds more than 1 net false negative compared to Jev across the 44 queries, **the challenger is vetoed immediately**, regardless of precision or cost gains.
2. **Gate 2: Operational Reliability & Availability Veto (Hard Veto):**
   - Inference availability over the run must be $\ge 99.5\%$.
   - Any rate of unjudged items (`bad_response`, timeouts, or drops) exceeding $1.0\%$ fails this gate. (Note: OpenAI Luna's 3-day advertised availability of 96.35% represents a known risk factor).
3. **Gate 3: Quality Non-Inferiority Criteria:**
   To qualify for selection, the challenger must meet all of:
   - Paired $\Delta\text{AUROC}$ 95% CI lower bound $\ge -0.02$
   - Paired $\Delta\text{Hard-Negative Precision}$ 95% CI lower bound $\ge -0.03$
   - Paired $\Delta\text{Brier}$ 95% CI upper bound $\le +0.02$
   - Mean utility loss $\mathcal{L} \le \mathcal{L}_{\text{Jev}}$
4. **Gate 4: Deterministic Winner Selection (Preregistered Before Any Scored Run):**
   If exactly one challenger passes Gates 1-3, it is selected subject to owner confirmation (promotion is never automatic: thresholds were DEV-tuned, and the scored corpus is spent DEV - see Section 3.2). If both challengers pass, the winner ranks first by the ordered tie-break:
   1. Lowest total cost per 1,000 judgments based on measured `usage.cost`.
   2. Lowest p95 latency.
   3. Lowest ECE (best calibration).

   Keep-Jev (no selection) cases: no challenger passes all gates; any hard veto fires (recall collapse, expected-utility CI below -0.05/query, or ECE > 0.30); availability accounting is incomplete (missing `usage.cost` leaves `costComplete: false`, and the cost rank falls back to the conservative reservation bound); query-cluster CIs overlap Jev on every non-inferiority margin; or the 3-sample probe is anyone's only evidence. The probe preregisters wire/billing/identity facts and NEVER selects a default, enables no judge mode, and reads no holdout.
5. **Default Inconclusive Rule:**
   If no challenger passes all gates with statistically significant improvement or non-inferiority, **TypeSafe Jev remains the product default**.

### 4.3 Unknown-Answer & Failure Policy
- Any response where a unit's answer is missing, non-numeric, or outside $[0, 1]$ is recorded as `unjudged: bad_response`.
- In product execution, unjudged units **must never be dropped**; they bypass the judge gate and remain in the candidate list with their original retrieval rank.
- In evaluation, unjudged units are treated as failures that count against model availability.

### 4.4 Statistics policy (frozen 2026-10-08, pre-data)

Owner-approved on 2026-10-08 and frozen before any full-comparison data was collected. These rules bind the execution, statistics, and selection stages; the machine-readable counterpart (typed DTOs plus fail-closed runtime validators) lives in `scripts/eval/judge/model-comparison-types.ts`. Items marked **parent-frozen 2026-10-08 pre-data** resolve audit open questions with the most conservative reasonable definition.

**Frozen inputs:** arms are exactly `~typesafe/jev-latest` (incumbent), `perplexity/pplx-decider-v1-27b`, `openai/gpt-6-luna-decisions`; corpus 314 units / 44 query groups with 78 gold, 148 hard-negative, 88 other negatives; fixture sha256 `2e9fa4117b7003e50581ec1c32d2b17c9c211b655bd9a9002a47961f2b871f9b`; five cache-disabled replicas per arm; thresholds keep .40 / pointer .45 / exists .35; aggregate $2 campaign cap (existing budget module), missing cost = UNKNOWN with its reservation retained, never $0.

**Estimand**
1. Per-unit score = mean probability across the five replicas; every metric is computed on replica-averaged scores (never on pooled repeated rows, never as per-replica metrics averaged afterwards).
2. Class denominators: gold recall over the 78 gold units; hard-negative precision over predictions on gold + 148 hard negatives; AUROC over gold vs. all negatives (236) and gold vs. hard negatives (148) as in §4.2; availability = successful responses / attempted requests including retries; unjudged = units with no valid replica-averaged probability / 314.
3. Net FN increase = challenger FN − Jev FN, pooled over the 78 gold units at τ_keep = .40 on replica-averaged scores (mean-replica and worst-replica variants are not used). **parent-frozen 2026-10-08 pre-data**
4. Utility loss is the pooled total `6·FN + 1·FP` over the corpus at the frozen thresholds (equivalently its per-query mean: the denominator, 44, is identical for both arms).

**Confidence intervals**
5. Paired cluster bootstrap with the 44 `set:qid` query groups as the independence unit: each draw resamples 44 groups with replacement and applies the *same* draw to both arms; pooled metrics (recall, AUROC, precision, Brier) are recomputed on the resampled unit multiset per arm, with per-draw difference = challenger − Jev. The five replicas are five observations of one unit, not 220 independent queries; inference is conditional on this spent-DEV corpus.
6. B = 10,000 draws; fixed numeric seed `20261008` (**parent-frozen 2026-10-08 pre-data**); two-sided percentile 95% CI using the nearest-rank convention of `percentileSorted` in `scripts/eval/judge/ir-metrics.ts` (index `ceil(q·B) − 1`, q = .025 / .975). This supersedes the 2,000-iteration figure in §4.2 (changed pre-data, before any scored run).
7. Degenerate draws (metric undefined on the resample, e.g. no gold unit drawn) are redrawn, up to 100·B total attempts; exhaustion blocks the arm's CI with blocked reason `degenerate_bootstrap`. **parent-frozen 2026-10-08 pre-data**
8. Passing a frozen non-inferiority margin on the governing CI bound is sufficient for that gate even when the CI overlaps Jev; overlap never blocks. Exact ties (all gates equal) keep Jev.

**Missing data (operationalization of policy point 3)** **parent-frozen 2026-10-08 pre-data**
- **Recorded** outcomes are complete observations: an `unjudged` unit (probability `null` with an error class) and an `unknown` cost with its retained reservation do not by themselves block qualification; they are counted by the unjudged/availability gates and keep `costComplete: false`, respectively.
- A **capture gap** blocks qualification: any planned unit with no attempt records or an attempt record missing its probability field; any attempt record whose cost field is absent or malformed (neither `{status:'known',usd}` nor `{status:'unknown',reserveUsd}`); or an aborted run. Blocked ⇒ the arm cannot qualify regardless of gate values. No imputation (never p = .5, never $0), no dropping; blocked reasons are recorded in the qualification DTO.
- An unresolved `unknown` cost also prevents cost-based ranking at selection time (see tie-break below); the reservation is budget safety, never a ranking input.

**Utility**
- Utility gain per query = (Jev loss − challenger loss) / 44 on replica-averaged scores at the frozen thresholds. Harm stop when the two-sided 95% CI **lower bound** on mean utility gain < −.05/query (same lower-bound veto convention as Gate 1). **parent-frozen 2026-10-08 pre-data** No alternative penalty weights may be invented.

**Reliability denominators** **parent-frozen 2026-10-08 pre-data**
- Availability denominator = every attempt actually dispatched to the wire, including retries, warmups, HTTP/transport failures, timeouts, and post-admission budget cancellations. Numerator = attempts that returned HTTP 2xx with a parseable envelope; a malformed 200 is `bad_response`, never a success. Pre-wire local refusals (missing key, endpoint rejection) are never dispatched: excluded from the denominator but reported.
- Each retry is its own attempt (failure then success = 1 unsuccessful + 1 successful attempt); a malformed or extra-answer batch response poisons the whole response (`bad_response`), never a partial success.
- Warmups are identified by the attempt `warmup` flag — the packed unit id `u0` is **not** the discriminator. Warmups count in availability, carry no query group, and never enter scored metrics or the unjudged denominator.
- Planned-versus-attempted, retry, warmup, refusal, and cancellation counts are all reported regardless of gate outcomes.

**ECE binning** **parent-frozen 2026-10-08 pre-data**
- ECE = the §4.2 formula over 10 equal-width bins on replica-averaged scores across all 314 units: [0,.1), [.1,.2), …, [.9,1.0] — left-closed, right-open, with the final bin including 1.0. Capture gaps block per the missing-data rule instead of being excluded from the denominator.
- ECE > .30 is a harm stop for **any** arm (challenger or incumbent): no selection, keep Jev.

**Tie-break cost denominator** **parent-frozen 2026-10-08 pre-data**
- Cost per 1,000 judgments = (all campaign-attributed spend for the arm — warmups, retries, and failures included; known `usd` plus `unknown` costs at their retained reserve value, never $0) / (1,570 planned judgments = 314 units × 5 replicas) × 1,000.
- Each tie-break step (cost → p95 → ECE) requires strict improvement; there is no numeric tie tolerance. Exact ties keep Jev.
- The cost step runs only when `costComplete` is true for every contender: an unresolved `unknown` cost means no ranking and no selection (reservation-fallback ranking is not authorized). p95 latency is the nearest-rank 95th percentile over non-warmup attempt latencies including retries; probe-scale evidence (e.g. n = 3) can never select.

**Decision rule order** (per challenger, then selection; every count is reported even after a stop)
0. **Completeness pre-check (policy point 3):** capture-gap missing probability, structurally incomplete cost record, or aborted run ⇒ arm `blocked` — cannot qualify, no imputation, no dropping.
1. **Gate 1 — gold-recall harm veto:** recall Δ CI lower bound ≥ −.02 **and** net FN increase ≤ 1 (else disqualified).
2. **Gate 2 — operational:** availability ≥ 99.5% **and** unjudged ≤ 1% (else disqualified).
3. **Safety harm stops:** ECE > .30 (any arm) **or** utility-gain CI lower bound < −.05/query ⇒ no selection (keep Jev).
4. **Gate 3 — non-inferiority:** AUROC Δ CI lower ≥ −.02; hard-negative precision Δ CI lower ≥ −.03; Brier Δ CI upper ≤ +.02; loss `6FN + FP` ≤ Jev's loss.
5. **Gate 4 — selection:** exactly one qualified challenger ⇒ recommend it (owner confirmation required, never automatic); several ⇒ ordered tie-break cost/1,000 → p95 → ECE under the tie-break rules above; any exact tie ⇒ keep Jev.
6. **Default:** no qualified challenger, or any block/veto/harm stop ⇒ TypeSafe Jev remains the product default (inconclusive; the keep-Jev cases of §4.2 Gate 4).

**Pre-data metric & selection decisions** **parent-frozen 2026-10-08 pre-data**
1. The single `auroc_ni` gate uses gold-vs-all-negatives AUROC (78 gold vs. 236 negatives); gold-vs-hard-negatives AUROC is reported as a descriptive metric only and is never gated.
2. Unjudged units are excluded from quality metrics (recall, AUROC, hard-negative precision, Brier, ECE, utility) and counted only by the `unjudged` and `availability` gates; an undefined governing metric blocks the arm with `missing_probability`.
3. Degenerate bootstrap draws are accepted per metric inside one shared draw loop — all metrics share a single cap of 100·B total attempts; cap exhaustion blocks the arm with `degenerate_bootstrap`.
4. `costComplete` must be true for every qualified challenger at selection time; otherwise there is no selection and Jev is kept (reservation-fallback ranking remains unauthorized).
5. ECE > .30 for ANY challenger arm — qualified or not — forces no selection (keep Jev), regardless of that arm's gate outcomes.

**Scored-outcome records (machine-readable metric inputs)** **parent-frozen 2026-10-08 pre-data**
- The validated metric input is `ComparisonScoredOutcome` (one record per arm × unit × replica): arm, `set:qid` query group, packed unit id, fixture candidate identity (the fixture row's `file` path — `PlanFixtureRow.file` in `model-comparison-plan.ts`), fixture-derived truth class, probability or `null`, and the linked attempt ids (`ComparisonAttemptRecord.attemptId`). Truth is derived from the fixture label only via `truthClassFromFixtureLabel` (`gold` → `gold`, `hard_negative` → `hard-negative`, `easy_negative` → `other-negative`); unknown labels fail closed.
- `ComparisonUnitAverage` is the replica-averaged per-unit record: a non-null average requires all five replicas with valid probabilities (mean in ascending replica order), otherwise it is `null`; `isComparisonUnitAverageDerivedFrom` rejects tampered, unlinked, or duplicate-replica derivations. The legacy `ScoreRow` DTO is legacy-only (no in-repo users) and must not receive new metric inputs.

**Identity / provenance** **parent-frozen 2026-10-08 pre-data**
- Served-model allowlist: `COMPARISON_SERVED_MODEL_ALLOWLIST` is keyed by the exact requested slug and carries the pre-data served snapshot recorded on 2026-10-07 (equal to `PLAN_SERVED_PINS`, enforced by test). **Parent-confirmed 2026-10-08:** the allowlist is exactly this pinned served snapshot keyed by the exact requested slug — accepted by the parent after blocking review. Every attempt records the served identity verbatim from the response body; any served identity not equal to the allowlisted value for that arm blocks the arm with reason `served_identity_drift` — no waiver (a provider-side re-pin requires a new pre-data freeze, never an in-run exception).
- Missing served identity on a response attempt (any received HTTP status, including a 2xx with a parseable envelope) is rejected by `isComparisonAttemptRecord`: a fail-closed capture rejection at validation, chosen over a dedicated `missing_served_identity` block reason, so such a record is never accepted and never reaches drift detection. Only a transport failure (`httpStatus` null) may record `servedModel: null`.
- `provider` is recorded only when the response returned it: nullable, never inferred from the requested slug.
- `payloadSha256` is the lowercase hex SHA-256 over the exact request bytes sent for each attempt. Retries and all five replicas of the same unit must carry the identical payload hash; any mismatch blocks the arm with reason `payload_drift`. Different query groups and warmups are separate payload units.
- `served_identity_drift`, `payload_drift`, and `undefined_precision` are members of `COMPARISON_BLOCKED_REASONS`; `detectComparisonAttemptDrift` computes the first two from attempt records.

**Zero-selection precision** **parent-frozen 2026-10-08 pre-data**
- If no item is predicted positive, hard-negative precision is undefined: the gate's point estimate and CI are `null`, `pass` must be `null`, and the arm is blocked with reason `undefined_precision`. The conventions `1.0` or `0` for zero selections are forbidden; validators reject any `pass` that disagrees with a `null` governing input. The qualification's `blockedReasons` must contain `undefined_precision` specifically whenever the precision gate's point estimate is `null` — blocking for an unrelated reason alone is rejected by `isComparisonQualificationResult`.

**Unknown-cost reserve invariant** **parent-frozen 2026-10-08 pre-data**
- `unknownCostAttempts > 0` requires `unknownCostReserveUsd > 0` and `unknownCostReserveUsd ≥ unknownCostAttempts × requestReserveUsd(arm)` (enforced in `isComparisonArmRunSummary`). `model-comparison-budget.ts` freezes no scalar per-attempt constant: the frozen per-attempt reserve is `requestReserveUsd(model)` over the frozen context-window/rate tables.

**End-to-end report binding (parent-confirmed 2026-10-08)**
- The final report must pass the pure binder `isComparisonQualificationConsistentWith(qualification, attempts, summaries)` and the full report gate `isComparisonReportConsistent({ qualification, attempts, summaries, outcomes, unitAverages, plannedUnits })` in addition to the per-record validators. It recomputes `detectComparisonAttemptDrift` from the arm's attempt records and requires every detected reason in both the qualification's and the arm run summary's `blockedReasons`; a drift reason declared by either but not produced by the records is rejected; a blocked arm is never qualified or selected (`blocked ⇒ ¬qualified`). `qualified` must equal the gate outcome in both directions: every frozen gate `pass === true` with empty `blockedReasons` ⇔ `qualified: true` (harm-stop gates are among the frozen gates, so a fired harm stop keeps `qualified` false). Recording `qualified: false` for a passing unblocked arm is rejected by `isComparisonQualificationResult` exactly as `qualified: true` with a failed/undecided gate or any block reason is — selection-stage outcomes (cost, tie-breaks, cross-arm harm stops) never back-channel through a false qualification claim.
- The binder also derives the arm summary's counts from the same attempt records — `attemptedRequests`, `warmupAttempts`, `successfulResponses` (2xx with a parseable envelope), the known/unknown cost partition, and `unknownCostReserveUsd` as the sum of the unknown records' retained `reserveUsd` — and rejects any disagreement. Invalid or foreign-arm attempts, a missing/duplicated arm summary, a qualification that omits a detected drift reason, and a summary whose counts disagree with the records all fail closed.
- The full report gate calls `isComparisonQualificationConsistentWith` first and additionally binds planned scored-outcome coverage: the planned unit set must be exactly the frozen corpus — 314 unique `set:qid` × packed-unit-id units (the unit id set produced by `toItems` in `model-comparison-plan.ts`; unit ids repeat per group, so group + id is the identity) across 44 query groups with the frozen 78/148/88 truth-class composition, each carrying its fixture `file` and fixture-derived truth class — and the qualification's `baseline` must be the incumbent `~typesafe/jev-latest`. Composition alone does not bind identity: the canonical digest of the planned unit list must also equal `FROZEN_PLANNED_UNITS_DIGEST` = `ac30e32d446e8a22ff5bd67f31e05acee7cc2f3902d880b55eeea9e6db4b8fa1` — SHA-256 over the compact JSON array of `[queryGroup, unitId, file, truth]` tuples sorted ascending by tuple (fields compared as UTF-16 code-unit strings in that order), derived once from the real fixture through `loadSetRows` in `model-comparison-plan.ts` — so a report with renamed groups or fabricated paths fails even when its attempts, outcomes, and averages are internally consistent.
- Every planned unit must have exactly `FROZEN_REPLICA_COUNT` scored outcomes for the qualification's arm covering replica indices 0..4, with `file`/`truth` equal to the planned unit and no unplanned or foreign-arm outcome. Each outcome's `attemptIds` must be exactly that unit/replica's non-warmup attempt records — `attemptId` unique across the arm, every attempt inside the planned corpus, and the per-unit/replica retry ledger exactly `attemptIndex` 1..n (a gap or duplicate means a dropped or double-counted dispatched record) — and `probability` must equal the linked successful attempt's probability, `null` exactly when no linked attempt succeeded. Each planned unit must have exactly one `ComparisonUnitAverage`, derived from those outcomes by `isComparisonUnitAverageDerivedFrom`.
- The gate then recomputes the arm summary's coverage and cost claims — `unitsWithValidAverage`, `unitsUnjudged`, `replicasObserved`, and `knownCostUsd` — plus the coverage-derived gate point estimates (availability = successful responses / attempted requests, unjudged = unjudged units / 314) and requires exact agreement. Any capture gap (a missing outcome, replica, attempt link, or average; a coverage, cost, or identity disagreement) fails the gate closed, so a report can never claim coverage its records do not show — including the zero-attempt/313-valid-unit case — and the arm cannot qualify per the missing-data rule above. As with `isComparisonQualificationConsistentWith`, the attempts/outcomes/averages passed to the gate are the qualification arm's records; other arms' summaries are checked for internal consistency only.
- **Final report gate = `isComparisonReportConsistent` AND the stats verifier.** The types-module gate binds coverage, identity, cost, and per-gate self-consistency but stays metric-free by design; it does not bind quality-gate values, so a report whose 314 scores are all `0.99` could claim passing AUROC/precision/Brier/loss and ECE `0.13` while passing `isComparisonReportConsistent` alone. The statistics module's `verifyComparisonReport({ qualification, attempts, summaries, outcomes, unitAverages, plannedUnits, baselineOutcomes, baselineUnitAverages })` (`model-comparison-stats.ts`) closes this: it requires `isComparisonReportConsistent` to pass FIRST, then deterministically recomputes from the bound challenger and incumbent (`~typesafe/jev-latest`) scored outcomes/unit averages — with the frozen bootstrap seed 20261008 and B = 10,000, no override — every gate's point estimate, CI bound, threshold (including the Jev-derived `loss` threshold), and `pass`, the harm-stop values (`ece_harm_stop`, `utility_harm_stop`), and `blocked`/`blockedReasons`/`qualified`, and requires EXACT equality with the reported qualification: exact equality for integers/counts, IEEE `===` equality for floats (both sides are produced by the same deterministic code path over the same inputs, so bitwise equality holds; no tolerance is used, because a tolerance would re-open the tampering window this gate closes), and `blockedReasons` compared in order. The types report shape carries only the qualification arm's records, so the incumbent arm's `baselineOutcomes`/`baselineUnitAverages` are required verifier inputs — bound to the planned corpus and to each other (`file`/`truth` identity, five distinct-replica outcomes, one derived average) by `bindBaselineReportArm`; no types-module change. Any binding or equality failure returns false (fail closed); a final report must pass both gates before the arm may be treated as qualified.
- `verifyComparisonReport` binds the challenger arm to attempt records; incumbent/baseline attempt binding and all-arm recomputation from wire records are required in the Stage G confirmation verifier (Amendment A1) before any result is treated as qualified.
- **Selection inputs (parent decision, 2026-10-08).** `selectComparisonArm` is a pure policy function over its inputs (roster, any-challenger ECE stop, `costComplete`, cost → p95 → ECE tie-break, exact tie keeps Jev); it does not authenticate them. Every selection input — each qualification, `costComplete`, cost per 1,000 judgments (from the wireId-deduplicated campaign aggregate), p95 latency, and the incumbent's ECE — MUST be derived by the Stage G confirmation verifier from the method-aware wire records of all arms; caller-supplied selection inputs never constitute a result.

**Frozen policy constants** **parent-frozen 2026-10-08 pre-data**
- `COMPARISON_GATE_THRESHOLDS`, `COMPARISON_GATE_IDS`, `COMPARISON_BLOCKED_REASONS`, `COMPARISON_TRUTH_CLASSES`, and `COMPARISON_SERVED_MODEL_ALLOWLIST` are `Object.freeze`d with readonly types; validators read only the frozen values, strict-mode mutation throws, and sloppy-mode mutation has no effect. (`FROZEN_REPLICA_COUNT`/`FROZEN_CORPUS_UNITS` are number primitives and need no freeze; `COMPARISON_MODELS` is exported from `model-comparison.ts`, which was outside this change's file set.)

---

## 5. Tiny Metering Probe Specification (Pre-Benchmark Safety Check)

Before any substantial spend or full benchmark run, a minimal metering probe must be executed to verify wire compatibility, measure true token billing, and record the exact served snapshot model IDs.

### 5.1 Probe Constraints & Guardrails
- **Max Attempts:** Exactly 1 actual HTTP attempt per model (3 total). The cloud client's retry ceiling is disabled in-probe (`noRetrySleep`), so retries cannot silently exceed the budget; every fetch is ledger-admitted first (failures count).
- **Budget Cap:** Total spend $\le \$0.01$ within the owner-approved $2 aggregate (probe + later benchmark). Pre-request reservation uses a 4x margin over the dearest-rate estimate (chars/4 is a heuristic, not a bound); missing `usage.cost` stays UNKNOWN and keeps its reservation.
- **No Full Benchmark:** Scored benchmark runs over all 314 units are prohibited in this stage.

### 5.2 Probe Payload Definition
The probe submits a single representative query from Set A (`q01`) with exactly two candidate units (1 gold positive, 1 hard negative). Wire IDs are neutral (`u0`/`u1`, as in the scored runner); no `gold`/`hard_negative`/`expected`/`label` string appears in the payload (unit-tested on captured bodies). Criterion hash binds ALL submitted question objects with their real `units.<id>` refs plus shared (`50e398ca…bc02d6d5`); shared hash `15a6b082…7895fb5794b7`; candidate hash `627016ae…be09095fd09`.

- **Query (`q01`):** `"How does text search fall back through engines when no semantic index is available?"`
- **Unit 1 (Gold):** `src/search/grep-cascade.ts:262-285` (`runNoIndexCascade`)
- **Unit 2 (Hard Negative):** `src/search/find-symbol-tool.ts:50-76` (`handleSymbol`)
- **Estimated Input Size:** $\approx 1,800$ tokens total ($400$ chars query/instructions + $\approx 3,400$ chars source snippets $\approx 950$ tokens $\times 2$).
- **Measured Input Size (2026-10-07):** 676-738 tokens/request, 2143/run.

### 5.3 Cost Estimation Table (Estimated vs Measured 2026-10-07)

| Model | Probe Attempts | Est. Input Tokens | Advertised Input / 1M | Max Probe Cost (est.) | Measured Probe Cost | Full Run Cost (314 units) | 5-Replicate Cost |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| `~typesafe/jev-latest` | 1 | 1,800 | $0.042 | **$0.000076** | $0.00003062 (729 tok) | $0.0072 | $0.0359 |
| `perplexity/pplx-decider-v1-27b` | 1 | 1,800 | $0.040 | **$0.000072** | $0.00002952 (738 tok) | $0.0068 | $0.0342 |
| `openai/gpt-6-luna-decisions` | 1 | 1,800 | $0.100 | **$0.000180** | $0.00006760 (676 tok) | $0.0171 | $0.0854 |
| **Total** | **3** | **5,400** | — | **$0.000328** | **$0.00012774** | **$0.0311** | **$0.1555** |

*Analysis:*
- The 3-request probe spends $\approx \$0.00033$, consuming only **3.3%** of the $\$0.01$ budget cap.
- A full 314-item benchmark of all 3 models costs $\approx \$0.031$ (~3.1 cents).
- A 5-replicate stability evaluation costs $\approx \$0.157$ (~15.7 cents).
- **Owner Presentation Rule:** The complete estimated spend ($\approx \$0.16$) must be presented to and approved by the owner before initiating the full benchmark. Generic instructions do not permit unmetered spend.

### 5.4 Probe Verification Objectives
Each probe request must capture and record:
1. HTTP status (`200 OK`) and header round-trip latency.
2. Returned `model` string (recording the exact served dated snapshot ID).
3. Returned `provider` string (`TypeSafe`, `Perplexity`, `OpenAI`).
4. Parsed probabilities $p(\text{gold})$ and $p(\text{negative})$.
5. Exact reported `usage.input_tokens` and `usage.cost`.
6. Confirm absence of errors (`400`, `401`, `402`, `429`, `502`) — or record the exact error code with coverage (`model_served`, status); refusals/malformed answers are `bad_response`, never a valid p.

Measured 2026-10-07: 3/3 `ok`, 6/6 judged, 0 unjudged; served IDs `typesafe/jev-1.13-20260917` / `perplexity/pplx-decider-v1-27b-20261001` / `openai/gpt-6-luna-decisions-20261006`; $0.00012774 over 2143 tokens per run (see the cost-probe plan for the full measured ledger).

---

## 6. Execution Architecture, Tooling, & Security Controls

### 6.1 Disjoint Runnable Tooling Architecture

```
                  ┌────────────────────────────────────────┐
                  │    PI_SMARTREAD_JUDGE_API_KEY (Env)    │
                  └──────────────────┬─────────────────────┘
                                     │
                 ┌───────────────────┴───────────────────┐
                 │                                       │
                 ▼                                       ▼
    [Offline / Mock Tests]                    [Metering Probe CLI]
    test/unit/judge/model-comparison.test.ts    scripts/eval/judge/model-comparison.ts
    • Mock Response Validation               • Max 1 attempt / model (no retry)
    • Parser Fidelity                        • Captures Served Snapshot ID
    • Error Envelope Mapping                 • Verifies Actual Cost / Tokens
    (NO Network / NO Cost)                   (Cost <= $0.01)
                                                         │
                                                         ▼
                                              [Scored Benchmark CLI]
                                              scripts/eval/judge/run.ts
                                              • --backend cloud
                                              • PI_SMARTREAD_JUDGE_MODEL=<model>
                                              • 5-Replicate Interleaving
                                              (REQUIRES OWNER SIGN-OFF)
```

### 6.2 Implementation Plan for Runnable Files

#### 1. Standalone Metering Probe Script (`scripts/eval/judge/model-comparison.ts`)
A dedicated, self-contained probe script that executes 1 actual HTTP attempt per model (client retries disabled in-probe) and outputs a structured verification record:
```typescript
// scripts/eval/judge/model-comparison.ts (probe mode)
import { CloudJudge } from "../../../src/judge/cloud-judge.js";
import { unitRelevanceQuestion } from "../../../src/judge/questions.js";

const MODELS = [
  "~typesafe/jev-latest",
  "perplexity/pplx-decider-v1-27b",
  "openai/gpt-6-luna-decisions",
] as const;

// Executes 1 request per model against 2 pinned units from q01
// Enforces max spend <= $0.01 fail-closed
```

#### 2. Offline Unit Test Suite (`test/unit/judge/model-comparison.test.ts`)
A zero-cost test suite verifying wire parsing, error mapping, and question packing across the three model profiles using Vitest mocks:
- Verifies that responses from Perplexity and OpenAI map correctly to `JudgeNoulResult`.
- Confirms that non-numeric answers trigger `unjudged: bad_response`.
- Confirms retry and backoff behavior under simulated 429 and 502 responses.

#### 3. Benchmark Runner Invocations (`scripts/eval/judge/run.ts`)
The existing benchmark runner supports model overrides via environment variable `PI_SMARTREAD_JUDGE_MODEL`. Verification commands:

```bash
# 1. Run offline unit tests (Zero network calls, zero cost)
npx vitest run test/unit/judge/cloud-judge.test.ts test/unit/judge/systemone-client.test.ts

# 2. Run tiny metering probe (Max 3 attempts, spend <= $0.01; full mode refuses)
npx tsx scripts/eval/judge/model-comparison.ts --mode probe

# 3. Full benchmark run (AFTER OWNER CONFIRMATION ONLY)
# Jev baseline
PI_SMARTREAD_JUDGE_API_KEY="$OPENROUTER_API_KEY" PI_SMARTREAD_JUDGE_MODEL="~typesafe/jev-latest" \
  npx tsx scripts/eval/judge/run.ts --backend cloud --data-dir ~/.cache/pi-smartread-judge-spike/eval --set both

# Perplexity Decider V1 27B
PI_SMARTREAD_JUDGE_API_KEY="$OPENROUTER_API_KEY" PI_SMARTREAD_JUDGE_MODEL="perplexity/pplx-decider-v1-27b" \
  npx tsx scripts/eval/judge/run.ts --backend cloud --data-dir ~/.cache/pi-smartread-judge-spike/eval --set both

# OpenAI GPT-6 Luna Decisions
PI_SMARTREAD_JUDGE_API_KEY="$OPENROUTER_API_KEY" PI_SMARTREAD_JUDGE_MODEL="openai/gpt-6-luna-decisions" \
  npx tsx scripts/eval/judge/run.ts --backend cloud --data-dir ~/.cache/pi-smartread-judge-spike/eval --set both
```

### 6.3 Security & Credential Hygiene
- **Zero Key Persistence:** API tokens must originate exclusively from `process.env.PI_SMARTREAD_JUDGE_API_KEY` or the trusted Pi OpenRouter auth store.
- **Header Boundary:** Authorization bearer tokens are attached exclusively to requests outbound to `https://openrouter.ai/api/alpha`. Requests to any other origin fail closed with `endpoint_not_allowed`.
- **Error Redaction:** Client error paths (`src/judge/systemone-client.ts`) explicitly redact authorization headers, request bodies, and token substrings from all logs and error messages.
- **Filesystem Invariants:** No modification of `~/.pi/agent/`, `~/.bashrc`, or environment profiles. No persistent credentials written to git or temporary directories.

---

## 7. Residual Unknowns & Risk Ledger

1. **OpenAI Provider Availability Risk:** OpenRouter reports GPT-6 Luna Decisions availability at **96.35%** over the past 3 days (compared to 99.98% for Perplexity and 99.9%+ for TypeSafe). If an upstream provider fails on $\approx 3.65\%$ of requests, retry loops may saturate the 3-attempt limit and degrade into `bad_response` or `http_502`. This is a primary risk factor to be observed during probing.
2. **Score Scale & Calibration Mismatch (CONFIRMED on probe 2026-10-07):** TypeSafe Jev produces probabilities with a known standard deviation of $\approx \pm 0.01$ and good spread across $[0.01, 0.99]$. Luna snapped this probe pair to $1.0$/$0.0$ extremes while Jev (0.97/0.09) and Perplexity (0.9973/0.0671) kept spread — the hardcoded keep threshold ($\tau = 0.40$) misfire risk is real and must be gated by Gate 1/2 CIs, not eyeballed.
3. **Advertised vs. Actual Billing (RESOLVED for probe scope 2026-10-07):** No hidden request fees, rounding minimums, or unadvertised overhead appeared: measured probe cost $0.00012774 over 2143 tokens matches advertised input rates at these sizes. Full-run billing stays estimated until the scored stage.
4. **Generalization Gap:** Because the 314-item fixture is spent development data, parity or superiority on this suite does not guarantee non-inferiority on arbitrary agent code queries. A formal decision to change the production default must be framed conservatively: **valid on DEV stability fixtures; generalization unproven**.

---

## 8. Summary Checklist Before Proceeding to Execution

- [x] Authoritative Decisions API endpoint verified (`https://openrouter.ai/api/alpha/decisions`).
- [x] Wire schema compatibility confirmed across all 3 models (`noul`, `choice`, `score`).
- [x] DEV fixture inventory, locations, and provenance verified (314 judgments, commit `18f6463`).
- [x] Sealed holdouts identified and explicitly quarantined.
- [x] Quality metrics, gold-recall veto, and decision gates preregistered.
- [x] Tiny metering probe (3 attempts, $0.00012774/run measured) executed under the $2 aggregate approval; full paid benchmark NOT run (separate future stage).
- [x] Full run estimate audited from measured probe + exact corpus (135 planned / 405 upper for 3 arms; $0.0311 single, $0.1555 5-replicate, $0.466 conservative upper).
- [x] Deterministic winner selection preregistered (Gate 4: single-passer + owner confirmation; multi-passer cost/latency/ECE order; keep-Jev cases).
- [x] Security controls, token handling, and runtime isolation confirmed.
- [x] Protocol documented in `docs/plans/2026-10-08-judge-decider-protocol.md`.

---

## 9. Amendment A1 (2026-10-08, pre-data): method-selection pilot and $3 hard cap

**Status:** Preregistered pre-data amendment, frozen 2026-10-08 before any pilot data was collected. This section is additive: §4.4 and all earlier sections remain binding EXCEPT where this amendment explicitly supersedes them (A1.4 supersedes the earlier $2 aggregate cap; A1.5 supersedes the earlier prohibitions it names) — §4.4 continues to govern the 44-query/314-unit model comparison; this amendment adds the method-selection pilot, its selector, and the $3 aggregate campaign cap. Companion stage document: `docs/plans/2026-10-08-judge-method-pilot-plan.md`. Nothing here authorizes product-source (`src/**`) changes, holdout access, paid execution without the applicable sealed stage authorization, automatic promotion, or automatic change of the deployed method or model.

### A1.1 Preregistered method-selection selector

**Primary metric:** pooled weighted classification loss at the frozen keep threshold `.40`, equally averaged over the three models. For model $a$, method $m$, candidate $i$:

- M0/M1 score = mean of its two pilot-replica probabilities; M2 replica score = `(forward + reverse) / 2`, then average its two replica scores.
- Keep iff the resulting probability is **≥ .40**; gold is positive, both negative classes are negative.
- $L_{a,m}=6FN_{a,m}+FP_{a,m}$ and $S_m=\frac{1}{3Q}\sum_{a=1}^{3}L_{a,m}$ with $Q=40$: $S_m$ is **weighted errors per query, averaged equally over models**; improvement is $D_m=S_0-S_m$.

**Qualification (all conditions required):**

1. **Practical margin:** $D_m \ge 0.10$ weighted errors/query (at 40 queries: at least four fewer weighted errors averaged over the models).
2. **Evidence against noise:** the Bonferroni-adjusted, one-sided **97.5% paired query-bootstrap lower bound** for $D_m$ is **strictly greater than zero**. Bootstrap: 10,000 draws; fixed seed `20261008`; `mulberry32`; query IDs sorted lexicographically; each draw resamples 40 query clusters with replacement; the same sampled queries are used for every method and model; replicas and models are not independent query samples; nearest-rank `.025` percentile; the correction covers the two comparisons (M1 vs M0, M2 vs M0).
3. **Recall (FN) guard:** no model has more than **one additional FN** versus that model's M0 result.
4. **Complete numeric coverage:** every candidate has all required probabilities for both replicas across all three models — no partial averages, no candidate exclusion.
5. **Integrity:** no served-identity drift, payload drift, capture gap, or aborted alternative run.

The practical margin is a preregistered decision threshold, **not a measured power guarantee**; this pilot does not establish `.02` recall non-inferiority.

**Selection and default:** the default method is **M0**. Neither alternative qualifies → M0; exactly one qualifies → select it; both qualify → select the lower $S_m$; exact alternative tie → **M2** (fixed preference for fewer requests than M1); invalid/incomplete M0 baseline → report the pilot inconclusive and retain M0; an incomplete alternative is ineligible and its missing candidates are never dropped. UNKNOWN billing retains its reservation and does not by itself invalidate a complete quality comparison — **cost is not a method-selection metric**.

**Prohibited:** per-model method choice; retuning `.40`, the 6:1 penalty, the improvement margin, bootstrap policy, or the tie rule after seeing results; selecting via AUROC, Brier, latency, cost, or a preferred model's result; averaging binary decisions rather than probabilities; treating replicas as independent queries; using the 44-query results to choose or revisit the method; adding methods, replacement queries, or extra scored pilot replicas after paid execution begins; automatically changing the deployed method or model. AUROC, Brier, calibration, latency, and per-model effects remain descriptive secondary outputs only.

### A1.2 Pilot corpus construction (summary)

- **Repository and pin:** Pi-SmartRead only, pinned to `18f6463caa78e6657b1af6c7eb86b711bc2364f8`. Reusing the same repository/commit is acceptable only if queries are semantically disjoint; it is **not** repository-independent generalization evidence. The quarantined retrieval holdouts and fresh-cohort fixtures remain untouched and unread.
- **Queries:** subsystem/behavior inventory from pinned source; review the existing 44 query texts only to exclude duplicates and near-paraphrases; draft ~48 candidate questions and retain the first 40 passing the preregistered checks — **32 answerable and 8 absence**. Behavioral user questions with a disjointness audit per accepted query; absence questions require a bounded source investigation. Query authors may inspect old wording/source but not historical judge scores.
- **Candidates:** source-authored, target **~7 candidates/query** (280 if exact: 64 gold, 136 hard negatives, 80 easy negatives; 6–8 per query allowed where the source requires it; the actual count is frozen before paid calls). Neutral stable IDs and label-independent order; ranges 1-based inclusive, ≤120 lines, 3,500-character excerpt convention; a gold label must be justified by the visible excerpt. Retrieval may contribute candidates with provenance recorded but **never determines gold**.
- **Source-first gold, two blind labelers + adjudicator:** Labeler A and Labeler B independently inspect pinned raw source and see neither each other's labels nor author-proposed labels, retrieval annotations, or judge outputs; each returns `gold | hard_negative | easy_negative` with a `file:startLine-endLine` rationale, range validity, and ambiguity flag. The adjudicator first forms its own source-based judgment, then reviews both assessments and resolves disagreements; absence claims are audited at query level.
- **Label gates (before adjudication):** gold-versus-negative agreement **≥90%**; binary Cohen's κ **≥.75**; three-class agreement **≥85%**; each labeler identifies both positive and negative examples. A failed gate requires rubric/dossier revision and relabeling of the **entire affected batch before paid calls**; earlier assessments are preserved and disagreements are never selectively discarded. Final acceptance requires two assessments per retained candidate, source-cited adjudication for every dispute, no unresolved ambiguity or invalid range, ≥1 visible gold per answerable query, zero gold plus an absence audit per absence query, and pre-paid recording of all exclusions/replacements.
- **Seal-before-paid:** fixtures, excerpts, labels, selector settings, schedules, and request payload hashes are sealed in a manifest with exact-byte SHA-256 digests bound to the source pin and protocol amendment; manifest and payload hashes are verified before the **first paid attempt** and again before resuming.

### A1.3 Reference arm, spent-DEV gates, and quarantine

- The deployed **Jev/M0 configuration is the non-selectable default reference.** Every selectable model/method configuration (including Jev under a selected alternative method) is compared against it; the reference itself cannot win; **when M0 is selected, the reference collapses with incumbent Jev.** This avoids silently changing the model-gate baseline to experimental Jev.
- The 44-query/314-unit corpus remains intact and **spent DEV** for the subsequent model gates: existing gate thresholds, margins, and bootstrap policy are unchanged; replica averaging and cost denominators use the sealed replica count. Pilot findings do not establish model qualification or generalization.
- Holdout quarantine remains in force (`~/.cache/pi-smartread-bench/d46/holdout/`, `~/.cache/pi-smartread-bench/fresh-cohort/`). Production promotion still requires explicit owner confirmation.

### A1.4 Budget: $3 aggregate hard cap

- **$3 HARD aggregate cap** for the campaign, including historical spending, retries, warmups, UNKNOWN reservations, in-flight reservations, and admission headroom. **$2** is retained only as an advisory planning target (superseding the owner's $2 aggregate as the binding cap for this campaign).
- Confirmation starts at **five** equal replicas. Reduction to **four**, then **three**, is permitted **only** when the post-pilot **MEASURED** projection exceeds $3. If three replicas do not fit, **stop before confirmation**. **Never shrink the corpus or drop arms.** The selected method, corpus, arms, reference configuration, and replica count are frozen before any confirmation scores are collected.
- **Ledger handling (measured 2026-10-08): no campaign ledger exists, therefore no cap-migration tool is built** — a parent deviation from the design plan's Stage A. An absent ledger is initialized with cap $3 and the verified historical seed; a persisted cap-$3 ledger is used unchanged; **any ledger with a non-$3 cap (including $2) is refused.** Never reset spend, discard UNKNOWN/in-flight reservations, remove another process's lock, or switch campaign roots to obtain headroom.
- Dry-run remains the default (stub fetches, no credentials). Paid pilot requires explicit authorization bound to the sealed manifest; pilot authorization cannot enable confirmation; the existing `model-comparison.ts --mode full` refusal stays intact. A separate confirmation entry point requires a completed pilot report with the selected method, a measured post-pilot projection, a sealed equal replica count, the unchanged 44-query digest, and owner authorization bound to that confirmation manifest.

### A1.5 Amendment text (design plan §5)

> ### Method-selection pilot amendment
>
> This amendment supersedes earlier stage-specific prohibitions on constructing the new method pilot and the aggregate $2 cap. It does not authorize product-source changes, holdout access, automatic promotion, or paid execution without the applicable sealed stage authorization.
>
> A new source-labeled pilot of 40 semantically disjoint behavioral queries, approximately 280 candidates, and two cache-disabled replicas per model selects one common method for all three requested Decisions API models. Methods are M0 production packed noul, M1 singleton noul, and M2 forward/reverse packed noul averaging, reusing M0's forward calls.
>
> Method selection minimizes pooled `6FN+FP` at `.40`, equally averaged over the three models and divided by 40 queries. An alternative requires improvement at least `.10` weighted errors/query, a one-sided 97.5% paired query-bootstrap lower bound strictly above zero, no model adding more than one FN, and complete valid component probabilities. Bootstrap uses 10,000 draws, seed `20261008`, and common query draws across all models/methods. If both alternatives qualify, lower loss wins; exact alternative ties prefer M2. Otherwise retain M0. Per-model method choice, threshold tuning, post-result corpus changes, and selection on secondary metrics are prohibited.
>
> Source-first labels require two blinded independent labelers, source-cited adjudication, and sealed provenance. All fixtures, excerpts, labels, selector settings, schedules, and request hashes are sealed before paid calls. SmartRead retrieval may supply candidates but never gold labels.
>
> The aggregate campaign hard cap is $3, including historical spending, retries, warmups, UNKNOWN reservations, in-flight reservations, and admission headroom. The planning target remains $2. Existing ledgers retain their balances and receive only an audited cap amendment when necessary.
>
> After the pilot, confirmation starts at five equal replicas. Only a measured projection exceeding $3 permits reduction to four, then three. If three do not fit, stop before confirmation. Freeze the selected method, corpus, arms, reference configuration, and replica count before collecting any confirmation scores.
>
> The 44-query/314-unit corpus remains intact and spent DEV. Existing model-gate thresholds, margins, and bootstrap policy remain unchanged; replica averaging and cost denominators use the sealed replica count. Deployed Jev/M0 remains the non-selectable baseline reference, collapsing with incumbent Jev when M0 is selected. Method-aware records preserve unique wire accounting and auditable probability derivations. Pilot findings do not establish model qualification or generalization. Production promotion still requires explicit owner confirmation.

*Note:* the sentence "Existing ledgers … receive only an audited cap amendment when necessary" is superseded by A1.4 — measured 2026-10-08, no ledger exists, so no migration tool is built and non-$3 ledgers are refused.

### A1.6 Cost table (measured vs assumed)

**Measured / observed (recorded, not remeasured in this amendment):** advertised input rates `.042` / `.040` / `.100` dollars per million input tokens; historical seed `$0.000255476`; probe measurement from §5.3 ($0.00012774 over 2,143 tokens, measured 2026-10-07); context-window reserves and the three-attempt client ceiling observed in current source.

**Unmeasured planning assumptions:** approximately 280 pilot candidates; 1,500 input tokens per isolated request; 5,000 per shared request; 1,000 per pilot warmup; confirmation warmups are ordinary method-sized requests. Current prices and served pins must be verified before paid execution.

**Request arithmetic** (exactly 40 queries / 280 candidates, no splits): 722 requests per model (560 isolated + 160 shared + two warmups); **2,166 requests** for the three-model pilot, up to **6,498 attempts**; two pilot replicas still provide **40 independent query clusters, not 80**.

| Component | Cost (USD) | Basis |
|---|---:|---|
| Complete three-model pilot | $0.298844 | assumed (planning) |
| Five-replica M1 confirmation | $0.429975 | assumed (planning) |
| Separate deployed-Jev reference | $0.047250 | assumed (planning) |
| Historical seed | $0.000255476 | measured (historical ledger) |
| **Nominal M1 campaign total** | **$0.776324476** | assumed (planning) |

Under the same assumptions: **M0** with collapsed reference ≈ **$0.504** nominal; **M2** with separate reference ≈ **$0.751** nominal (both assumed).

Stress envelope for the most expensive M1 path (all assumed): every new planned request billed for three attempts `$2.328207`; two additional UNKNOWN reserves/model `$0.23365952`; largest next-call admission reserve `$0.105`; historical seed `$0.000255476` — **total ≈ $2.667**, leaving ≈ `$0.333`. Illustrative M1 stress projections at five/four/three confirmation replicas ≈ **$2.667 / $2.381 / $2.094**; these are assumptions, not spend guarantees. Post-pilot projections must use measured request costs and token usage, actual sealed payload sizes, current ledger spending/reservations, the three-attempt envelope, additional UNKNOWN contingency, and next-call admission headroom, without double-counting retained reservations.

---

## 10. Amendment A2 (2026-10-09, pre-data for the PPLX arm): PPLX decider v1 -> v1.1

**Status:** Preregistered pre-data amendment, owner-authorized 2026-10-09, adopted before any PPLX answer data existed. This section is additive: all earlier sections remain binding EXCEPT where they name `perplexity/pplx-decider-v1-27b` (or its snapshot `perplexity/pplx-decider-v1-27b-20261001`) as a live target — those arm identity and served-pin references now resolve to the v1.1 replacement below. Historical measurement sections (the 2026-10-07 probe tables in §2/§5 and the cost-probe/foundation-evidence documents) are NOT rewritten; they remain as recorded history of what v1 actually served on 2026-10-07.

### A2.1 Trigger: v1 withdrawn from OpenRouter's decision catalog

- `perplexity/pplx-decider-v1-27b` is gone from OpenRouter's live decision catalog (`GET https://openrouter.ai/api/v1/models?output_modalities=decisions` returns 16 decision models and does not include v1).
- Its endpoints list is empty: 404 on both decision routes (`/api/alpha/decisions` and `/api/v1/systemone`).
- Timeline: 2026-10-09 02:58-05:49 AEDT (the capture window containing all 10 PPLX `capture_gap` 404 wire records) plus the 2026-10-09 morning probes confirming the withdrawal.

### A2.2 Replacement: Perplexity Decider v1.1 (re-verified 2026-10-09)

| Attribute | Value |
| :--- | :--- |
| Arm slug | `perplexity/pplx-decider-v1.1-27b` |
| Canonical slug (served pin) | `perplexity/pplx-decider-v1.1-27b-20261006` |
| Price | $0.00000002 per input token ($0.02 per 1M input tokens) |
| Context window | 262,144 tokens |
| Provider | 1 live provider (Perplexity, direct forward) |

Jev (`typesafe/jev-1.13-20260917`) and Luna (`openai/gpt-6-luna-decisions-20261006`) pins were re-verified unchanged and still served at the same probe.

### A2.3 Scope of the switch

- The comparison's PPLX arm now tests `perplexity/pplx-decider-v1.1-27b` against the pin above. The frozen constants carry the new identity: `COMPARISON_MODELS`, `PLAN_SERVED_PINS`, `COMPARISON_SERVED_MODEL_ALLOWLIST`, `FROZEN_CHALLENGER_ARMS`, the budget module's per-model tables, and the pilot selector arm map.
- All frozen gates, thresholds, statistics (bootstrap policy, margins, penalties), the 44-query/314-unit corpus and its fixture digests, and the other two arms (Jev incumbent, Luna challenger) are unchanged.
- **No post-hoc selection:** no PPLX answer data existed at amendment time — all 10 PPLX wire records in the original records file are `capture_gap` 404s, i.e. zero answers — so switching arms cannot have been chosen on PPLX results.
- The 10 v1 gap records are retained as history in the original records file (`pilot-plan-20261009.json.wire-records.jsonl`); they are not copied into the A2 plan's sidecars.
- The per-attempt budget reserve for the PPLX arm stays at the conservative v1 rate — 0.04 USD per 1M input tokens, i.e. `(262_144 x 0.04) / 1e6 = 0.01048576` per attempt — even though v1.1 advertises 0.02; the reserve floor is pinned in `scripts/eval/judge/model-comparison-budget.ts` while the price tables record v1.1's real 0.02 rate.

**Authorization:** owner-authorized 2026-10-09 (use the correct current Perplexity decision model ID); the switch is pre-data for the PPLX arm.

---

## 11. Pilot outcome record (2026-10-09)

Owner decision A, recorded 2026-10-09. The preregistered A1.1 selector returned `chosenMethod: "M0"` with `inconclusive: false`; M1 and M2 were disqualified by A1.1 qualification condition 5 (integrity) — both carry the verdict reason `integrity_failed`, because one bound wire record each carries `errorClass: "capture_gap"` — so the practical margin, bootstrap lower bound, and FN guard were never evaluated. Outcome record (verbatim verdict quotes, record-level root cause, exploratory point estimates, decision, provenance): `docs/plans/2026-10-09-method-pilot-outcome.md`. M0 is frozen as the preregistered outcome; no retroactive reclassification or re-selection on this data; follow-ups are prospective (capture-rule amendment A3, fresh held-out M0-vs-M1 confirmation).

---

## 12. Amendment A3 (2026-10-09, prospective): recovered transport errors

**Status:** Owner-directed capture-rule amendment, adopted AFTER the §11 outcome record was appended and BEFORE any new pilot, confirmation, or reference data was collected. This amendment is strictly **PROSPECTIVE**: it changes how future wire records are classified and how future runs' integrity flags are derived. **It does not alter the 2026-10-09 pilot verdict.** `method-verdict-20261009.json` remains an A1/A2-era artifact (`chosenMethod: "M0"`, M1/M2 `integrity_failed` by capture gap); no re-derivation, reclassification, or re-selection on that data is permitted under this amendment, and the A1/A2-era derivation path reproduces that verdict byte-identically (regression-guarded).

### A3.1 Rationale (pilot incident, owner-directed)

The 2026-10-09 pilot recorded two transient transport errors — a Jev M1 replica-1 `P-search-02` request answered HTTP 529 and a PPLX M2 replica-1 `P-search-03` request answered HTTP 503 — whose response bodies carried no served model. The A1/A2 capture rule classified every received response without a served model as `capture_gap`, so those two transport errors set the A1.1 qualification-5 integrity flag and disqualified M1 and M2 even though both planned requests were retried and succeeded on attempt 2 with fully verified served identities. `capture_gap` was designed to mark a genuinely missing or unverified output, not a transport error whose retry succeeded; conflating the two is a measurement defect. Owner-directed correction, locked before any new data: transport errors and capture gaps are now distinct classes (below), and recovery of a transport error is no longer an integrity violation.

### A3.2 Classification rule

- A received **NON-2xx** response whose body carries no served model is a **transport-class failure**: it records the REAL `httpStatus` with `errorClass: "http_<status>"` (e.g. `http_529`, `http_503`), null identity/provider, and all-null answers, settles its admission UNKNOWN with the reserve retained, and is retried per the frozen per-status retry policy within the three-attempt ceiling. This reuses the existing additive `http_<status>` classes of `ComparisonErrorClass` (consistent with `JudgeErrorCode`); **no new error class is introduced**.
- `capture_gap` remains reserved for exactly one case: a received **2xx** response whose served identity cannot be captured. Its A1 semantics are unchanged — durable record with REAL status and null identity, run halt via `MethodCaptureGapError`, and the integrity flag.
- A received NON-2xx whose body DID carry a served model is unchanged (transport failure with captured identity recorded verbatim).

### A3.3 Integrity rule (recovered transport errors)

- A transport error is **RECOVERED** when a later attempt for the same planned payload (same arm, method, replica, query group, and payload hash, with a higher attempt index) is a **verified success**: a 2xx settlement with no error class and a served model on the arm's allowlist. **Recovered transport errors do not set any integrity flag.**
- The A1.1 qualification-5 integrity gate still fires for: any `capture_gap` (a 2xx without captured identity, recovered or not — the gap means an output is missing or unverified regardless of later attempts); **any planned component whose final attempt is not a verified success** (the fail-closed complement of the recovery rule — an UNRECOVERED transport error still disqualifies); served-identity drift; payload drift; and aborted runs. Selector input gains exactly one additive boolean, `finalAttemptUnverified`, implementing the final-attempt rule; a true flag disqualifies exactly like any other integrity flag.

### A3.4 Ruleset versioning and the fail-closed era boundary

- Every wire record the executor emits after this amendment carries `rulesetVersion: "A3"`, and a select verdict derived from A3-era records carries `rulesetVersion: "A3"`. Records and verdicts without the field are A1/A2-era; their presence/absence is what makes A3-era and A1/A2-era artifacts distinguishable.
- The selector-input derivation applies A3 integrity rules **only when every wire record in the run is A3-stamped**. Unstamped records take the A1/A2 path unchanged (A3-era semantics are never applied to pre-A3 artifacts); an unknown stamp value, a file mixing stamped and unstamped records, or an explicit A3 ruleset request against an unstamped file is **refused (fail closed)**. The 2026-10-09 pilot records and verdict are unstamped and therefore permanently A1/A2-era.
- The frozen §4.4 comparison-attempt projection is unchanged: capture-gap records and A3 transport-class records (absent identity on a received status) never project; §4.4's fail-closed capture rejection stands.

