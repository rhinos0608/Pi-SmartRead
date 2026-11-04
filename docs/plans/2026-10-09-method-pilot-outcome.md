# Method Pilot Outcome Record (2026-10-09)

**Document ID:** `docs/plans/2026-10-09-method-pilot-outcome.md`
**Date:** 2026-10-09
**Branch:** `feat/judge-decider-benchmark`
**Worktree:** `/Users/rhinesharar/Pi-SmartRead-judges`
**Governing protocol:** `docs/plans/2026-10-08-judge-decider-protocol.md` — §9 (Amendment A1, selector A1.1) and §10 (Amendment A2, PPLX v1 → v1.1).
**Status:** Outcome record of the preregistered method-selection pilot; owner decision A.

This record documents what the preregistered machinery produced, why it produced it, what it does and does not establish, and the owner's decision. It changes no protocol text, no record, and no verdict.

---

## 1. Verdict as produced by the preregistered machinery

Source: `method-verdict-20261009.json` (kind `method-pilot-select-verdict`), written offline by `scripts/eval/judge/method-pilot-select.ts` from the sealed A2 plan and its wire records.

- `chosenMethod`: **`M0`**
- `selector.selected`: `"M0"`, `selector.inconclusive`: **`false`**, `selector.baselineBlockReasons`: `[]` (the M0 baseline was valid and complete).
- `selector.queryCount`: `40`.

Both alternatives failed qualification. The verdict JSON's qualification entries, quoted verbatim:

```json
{ "method": "M1", "s": 1.3666666666666667, "d": null, "marginPass": null,
  "bootstrapLowerBound": null, "bootstrapPass": null, "fnDeltaByModel": null,
  "fnGuardPass": null, "qualified": false, "reasons": ["integrity_failed"] }
{ "method": "M2", "s": 1.4416666666666667, "d": null, "marginPass": null,
  "bootstrapLowerBound": null, "bootstrapPass": null, "fnDeltaByModel": null,
  "fnGuardPass": null, "qualified": false, "reasons": ["integrity_failed"] }
```

(Reformatted for width; field values are exact.)

- M1 and M2 are disqualified by the A1.1 **integrity condition** (qualification condition 5: "no served-identity drift, payload drift, capture gap, or aborted alternative run"), reported by the selector as `integrity_failed`. The underlying failing flag is `capture_gap` — see §3.
- **Margin, bootstrap, and FN guard were NOT evaluated**: `d`, `marginPass`, `bootstrapLowerBound`, `bootstrapPass`, `fnDeltaByModel`, and `fnGuardPass` are all `null` for both alternatives. Per the selector, integrity failure blocks the metrics stage, so no comparison statistic was computed.
- No `incomplete_coverage` reason appears for any method: numeric coverage (condition 4) passed for all methods; integrity was the only failing condition.

## 2. Interpretation

**M0 was the best-performing ELIGIBLE method under the preregistered rules.**

It is **not** established that M0 is the best method. The integrity gate tested **provenance** — whether the M1/M2 evidence satisfied the capture contract (every bound wire record recording a served identity) — **not performance**. Its failure is not evidence against M1 or M2: the two disqualifying records are transient upstream error responses, both of which were re-dispatched and succeeded (§3). The performance comparison between M0 and the alternatives was never run, so this pilot contains no measurement of which method performs better; it contains only a provenance gate that M0 passed and M1/M2 failed.

## 3. Root cause of the disqualification (record evidence)

Verified directly against `pilot-plan-20261009-a2.json.wire-records.jsonl` (2,168 rows) and `pilot-plan-20261009-a2.json.progress.jsonl` (2,166 rows).

**Exactly two non-200 attempts exist in the entire run; both are `errorClass: "capture_gap"`:**

1. `~typesafe/jev-latest` / **M1**, replica 1, group **P-search-02**, direction `isolated`, candidate `c268efba53506`, `attemptIndex: 1`, `httpStatus: 529`, `servedModel: null`, `errorClass: "capture_gap"`, cost `{status: "unknown", reserveUsd: 0.001344}`, timestamp `2026-10-08T15:56:21.784Z`.
   - Its retry: `attemptIndex: 2`, `httpStatus: 200`, `servedModel: "typesafe/jev-1.13-20260917"` (the allowlisted pin), `errorClass: null`, timestamp `2026-10-08T15:57:39.569Z`, **identical `payloadSha256`** to attempt 1.
2. `perplexity/pplx-decider-v1.1-27b` / **M2**, replica 1, group **P-search-03**, direction `reverse` (all 7 candidates), `attemptIndex: 1`, `httpStatus: 503`, `servedModel: null`, `errorClass: "capture_gap"`, cost `{status: "unknown", reserveUsd: 0.01048576}`, timestamp `2026-10-08T23:38:54.924Z`.
   - Its retry: `attemptIndex: 2`, `httpStatus: 200`, `servedModel: "perplexity/pplx-decider-v1.1-27b-20261006"` (the allowlisted pin), `errorClass: null`, timestamp `2026-10-08T23:41:34.624Z`, **identical `payloadSha256`** to attempt 1.

**Final coverage is 100%:**

- Plan `pilot-plan-20261009-a2.json`: `expectedRequestsPerModel: 722`, `requests.length: 2166` → 2,166/2,166 planned requests (722 per model) succeeded. The progress sidecar holds exactly 2,166 unique plan keys; every key has wire records, every key has at least one HTTP 2xx attempt, and attempt indices are gapless (no dropped or duplicated dispatch).
- Wire records = 2,168 = 2,166 planned requests + the 2 retries above. `errorClass` distribution: `null` × 2,166, `capture_gap` × 2.
- Served-identity drift: 0 records with a served model outside the allowlist. Payload drift: none (retry pairs share their component's payload hash).

**Classification path (why a retried-to-success transient error still disqualified):**

1. **Record level:** a response arrived at the HTTP layer with a real status (529 / 503) but its body carried no served model. The pre-data capture contract (`scripts/eval/judge/method-comparison-contract.ts`, capture rules; `scripts/eval/judge/method-comparison-executor.ts`, `captureGapOutcome`) requires a received response to carry a captured served identity and **forbids inferring identity from the requested slug**, so the attempt is recorded with its REAL `httpStatus`, `servedModel: null`, `provider: null`, `errorClass: "capture_gap"`, and cost UNKNOWN with its retained reserve. Received response without a served model ⇒ `capture_gap`, per the contract frozen before any pilot data existed. The halt is per-call; on resume the unfinished component is re-dispatched from its prior attempt base (attempt 2 above) and succeeded.
2. **Envelope level:** the select glue derives one integrity entry per arm × method: `captureGap: binding.wireRecords.some((record) => record.errorClass === "capture_gap")` (`scripts/eval/judge/method-pilot-select.ts`, `buildIntegrity`). Re-deriving all four flags per envelope from the records: only `~typesafe/jev-latest × M1` and `perplexity/pplx-decider-v1.1-27b × M2` have `captureGap: true`; every other flag on every envelope is `false`.
3. **Selector level:** the A1.1 selector requires an alternative method to be integrity-clean on **all three arms** (`scripts/eval/judge/method-pilot-selector.ts`, `accumulateIntegrity` / `buildStage`); a single flagged envelope sets the method's reason to `integrity_failed` and nulls its metrics stage. Hence M1 (flagged on Jev) and M2 (flagged on PPLX) were disqualified, margin/bootstrap/FN guard were never evaluated, no alternative qualified, and the preregistered default rule ("neither alternative qualifies → M0") returned M0 with `inconclusive: false` (the M0 baseline itself was clean and complete).

## 4. Exploratory point estimates — NOT selection evidence

**Descriptive and exploratory only.** These numbers were not used for selection: the selector never evaluated them (all gating statistics are `null` in the verdict). They are recomputed here from `method-verdict-20261009.json` and must not be cited as a qualification, a gate outcome, or a performance conclusion.

**Per-model loss/query (`loss / 40` queries; loss = `6·FN + 1·FP` at the frozen `.40` keep threshold):**

| Model | M0 | M1 | M2 |
| :--- | ---: | ---: | ---: |
| `~typesafe/jev-latest` | 70 → **1.750** | 59 → **1.475** | 62 → **1.550** |
| `perplexity/pplx-decider-v1.1-27b` | 55 → **1.375** | 63 → **1.575** | 55 → **1.375** |
| `openai/gpt-6-luna-decisions` | 64 → **1.600** | 42 → **1.050** | 56 → **1.400** |
| Equal-weight mean `S` | **1.575** | **1.3667** | **1.4417** |

(`S` = mean of the three per-model loss/query values; recomputed: 189/120 = 1.575, 164/120 = 1.3666…, 173/120 = 1.4416… — matches the verdict's `s` fields exactly.)

**M1-vs-M0 relative change in loss/query, per model (recomputed):**

- Jev: (59 − 70) / 70 = −0.15714… → **−15.7%** (lower loss than M0)
- PPLX: (63 − 55) / 55 = +0.14545… → **+14.5% (higher loss — worse than M0)**
- Luna: (42 − 64) / 64 = −0.34375 → **−34.4%** (lower loss than M0)
- Average (relative change of the equally-averaged selector score, `(S1 − S0) / S0` = (164 − 189) / 189 = −0.13227…) → **−13.2%**

Note on "average": −13.2% is the relative change of the equal-weight mean loss/query (the pilot's pooled score). The unweighted mean of the three per-model percentages above is −11.8%; the two are different aggregations of the same three numbers.

These point estimates show no consistent direction across models (M1 is better on Jev and Luna, worse on PPLX), which is one reason they are reported descriptively rather than as evidence.

## 5. Decision (owner decision A, 2026-10-09)

- **Option A chosen: freeze M0 as the preregistered outcome.** M0 remains the default method under the protocol's own default rule (no qualified alternative).
- **No retroactive reclassification** of the two `capture_gap` records and **no re-selection** — no re-run of the selector, no amended verdict — on this data. The verdict stands as produced.
- **Follow-ups are prospective only:**
  - **Capture-rule amendment A3:** a future pre-data amendment may revisit how transient upstream error responses (received status, no served model) are classified with respect to the A1.1 integrity condition. It applies to future data, never retroactively to this pilot.
  - **Fresh held-out M0-vs-M1 confirmation:** the exploratory M1-vs-M0 numbers above justify, but do not substitute for, a fresh held-out comparison on new data under a preregistered design.

## 6. Provenance

All figures verified by direct computation on 2026-10-09; the pilot data root and the campaign ledger were read only.

| Artifact | Value |
| :--- | :--- |
| Plan | `pilot-plan-20261009-a2.json` — sha256 `7ecd9466a9905e9d23a229e514e249813418d711be82b2d6a03200bde9f2e023` (equals the verdict's `planSha256`) |
| Wire records | `pilot-plan-20261009-a2.json.wire-records.jsonl` — sha256 `2b4fbd136bb04a6f6bdf9302ced200860ca7e90aaf3660b6494c49d340549e79` (2,168 rows) |
| Progress sidecar | `pilot-plan-20261009-a2.json.progress.jsonl` — sha256 `640ad317c5a329e8192231987793aed1d4a2ffb579ba74d7f92b5135a31efc2b` (2,166 rows) |
| Verdict | `method-verdict-20261009.json` — sha256 `97fa8fe76234c5ad51c0e624394684af7c186aa95d082d976003984fc0448ebe`, file mode `0600`, kind `method-pilot-select-verdict`; produced **offline** by `scripts/eval/judge/method-pilot-select.ts` — no network, no credentials, no campaign-ledger mutation |
| Sealed roster | `pilotManifestSha256` `d28e404d4a514d7e09e01d5e49b6a99b6bc14cfc17123b14e2cee031870c370f`; sourceRef `18f6463caa78e6657b1af6c7eb86b711bc2364f8`; 40 queries / 280 candidates / 2 replicas |
| Campaign ledger (read-only) | `~/.cache/pi-smartread-judge-campaign/campaign-ledger.json`: `capUsd` **$3**; known spend `actualSpentUsd` **$0.2446** ($0.24460876); used incl. retained reservations `campaignUsedUsd` **$0.3613** ($0.36129612) of $3 (headroom $2.6387); `costComplete: false`; 2,184 ledger attempts; no in-flight reservations |
| Amendment A2 | Protocol §10: PPLX arm is `perplexity/pplx-decider-v1.1-27b` (served pin `perplexity/pplx-decider-v1.1-27b-20261006`), adopted pre-data; the `a2` plan and its sidecars are the post-A2 artifacts. |
| Amendment A1 | Protocol §9: A1.1 selector, qualification conditions, selection rules, $3 hard cap (A1.4). |

Recomputations supporting this record: verdict sha256 / file mode, plan and records sha256, per-envelope integrity flags, planned-vs-attempted coverage (2,166/2,166), the two error/retry pairs, the `S` values, and the relative changes in §4.
