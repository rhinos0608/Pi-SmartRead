# Judge Decider Cost Probe: Frozen Plan & Measured Stops

**Document ID:** `docs/plans/2026-10-08-judge-decider-cost-probe.md`
**Date:** 2026-10-08
**Status:** Frozen probe plan; protocol frozen before first scoring
**Parent protocol:** `docs/plans/2026-10-08-judge-decider-protocol.md` (preregistered, unchanged)
**Scope:** New files only — `scripts/eval/judge/model-comparison.ts`,
`test/unit/judge/model-comparison.test.ts`, this document. No edits to the
default/runtime cloud client, variant matrix, ergonomics bets, fixtures, or
sealed holdouts.

## 1. Freeze statement

The parent protocol (`2026-10-08-judge-decider-protocol.md`) is frozen before
any scored run. This probe does not tune thresholds, does not label data, and
does not read the sealed holdouts (`d46/holdout/`, `fresh-cohort/`) or the
frozen E18 retrieval matrix. The probe input below was fixed without consulting
prior candidate scores.

## 2. Fixed probe input (same across all 3 models)

- Query (protocol q01 wording):
  `"How does text search fall back through engines when no semantic index is available?"`
- Unit `u0` (local label `gold` only, never on the wire): `src/search/grep-cascade.ts`, symbol
  `runNoIndexCascade`, 267-char synthetic fallback-chain excerpt.
- Unit `u1` (local label `hard_negative` only, never on the wire): `src/search/find-symbol-tool.ts`,
  symbol `handleSymbol`, 163-char synthetic symbol-lookup excerpt.
- Wire IDs are neutral (`u0`/`u1`, as in `scripts/eval/judge/run.ts`); no
  `gold`/`hard_negative`/`expected`/`label` string appears in the payload
  (unit-tested on captured bodies).
- `candidateHash` (sha256): `627016ae391000361c156f068bf6dd16ce36538f91218ecb61c46be09095fd09`
- `criterionHash` (sha256 over `{shared, questions}` for ALL submitted
  questions with their real `units.<id>` refs):
  `50e398ca69583f47b55187eb5110c8a96248e61cb02a0bab3bd0b7b0bc02d6d5`
- `sharedHash` (sha256 over `{query}`): `15a6b082e8ab79eccd3a5ed71c4e7bd228955fb60c9f4b60c6517895fb5794b7`
- Built by `buildProbeInput()` with the normal `unitRelevanceQuestion`
  builder (same as the scored runner); hashes stable across runs (tested).

## 3. Hard stops (enforced in code, fail-closed)

| Stop | Limit | Enforcement |
| :--- | :--- | :--- |
| Duplicate slugs | reject before any fetch | pre-loop set check throws, zero admissions |
| Requests per model | 1 actual HTTP attempt | ledger admission + `noRetrySleep` (client retry ceiling disabled in-probe) |
| Total attempts | 3 (every fetch, incl. failures) | synchronous admission ledger; 2nd attempt throws before send |
| Network | pinned `https://openrouter.ai` decisions only | origin+protocol check, `redirect: "error"` (fail-closed) |
| Input tokens per request | 3000 est. | pre-request `estimateTokens` refusal (`over_token_budget`, no request sent) |
| Total spend | $0.01 within $2 aggregate | pre-request 4x-margin reservation + post-response true-up; unknown cost keeps reservation |
| Missing `usage.cost` | UNKNOWN, never 0 | per-model `costUsd?: number`; totals incomplete (`costComplete: false`) |
| Auth | explicit key or Pi SDK store (OpenRouter api_key only) | `resolveProbeApiKey`; OAuth-only stops `oauth_only`; no raw auth.json parsing |
| Cache | disabled | `CloudJudge({ cache: null })` |
| Concurrency | none added | strictly sequential `await` per model; `CLOUD_JUDGE_CONCURRENCY` untouched |
| Full comparison | NOT authorised | `--mode full` exits 3 before any request |

CLI: `npx tsx scripts/eval/judge/model-comparison.ts [--mode probe|full]
[--models a,b] [--out PATH]`. Unknown args exit 2. Missing auth (no
explicit key, no usable Pi SDK OpenRouter api_key) prints `presence=false`
and exits 2; OAuth-only storage exits 2 with `oauth_only` — no credential
scraping, no `HOME`/`PI_CODING_AGENT_DIR` mutation, no secrets in output.

## 4. Captured per-model record

`requestedModel`, `resolvedIdentity` (served snapshot via cloned response body,
`"unavailable"` when absent), `provider`, `status` (`ok` | `bad_response` |
`http_*` | `timeout` | `network` | `over_token_budget`, code only),
per-item `scores` (strict `[0,1]` numerics; refusals/missing stay `unjudged`,
never `p=0.5`), `usage` (`inputTokens`, `costUsd`), `requestTimestamp`,
`latencyMs`, `candidateHash`, `criterionHash`. Diagnostics contain no secrets,
no source PII, no raw authorization values, no error bodies. Artifact written
`0600` plus `.sha256` sidecar to a private tmp path (or `--out`).

## 5. Execution status: MEASURED (2026-10-07, two identical-payload runs)

Authorisation: owner-approved probe + subsequent benchmark UNDER $2
aggregate (not $2 each). Stage A = tiny probe only; the full run is a
separate future stage after this measured-estimate audit.

Run 1 (`...17-30-25-596Z`) and run 2 (`...17-30-33-052Z`) each sent the
same fixed payload once per model (3 actual HTTP attempts each, 6 total —
run 2 was a redundant re-capture by the operator, disclosed here; no
further paid calls in this stage). Auth resolved via the Pi SDK
`AuthStorage` OpenRouter credential (`authSource: pi-auth-store:openrouter`;
no explicit key env was set). Billing was deterministic across runs
(identical token/cost figures; only latency varied).

| Model | Served identity | Provider | p(u0) | p(u1) | In tok | Cost USD | Latency (run1/run2) |
| :--- | :--- | :--- | ---: | ---: | ---: | ---: | ---: |
| `~typesafe/jev-latest` | `typesafe/jev-1.13-20260917` | TypeSafe | 0.97 | 0.09 | 729 | 0.00003062 | 975 / 704 ms |
| `perplexity/pplx-decider-v1-27b` | `perplexity/pplx-decider-v1-27b-20261001` | Perplexity | 0.9973 | 0.0671 | 738 | 0.00002952 | 704 / 1017 ms |
| `openai/gpt-6-luna-decisions` | `openai/gpt-6-luna-decisions-20261006` | OpenAI | 1.0 | 0.0 | 676 | 0.00006760 | 924 / 609 ms |

Per run: `httpAttempts: 3`, `totalInputTokens: 2143`, `totalCostUsd:
0.00012774` (`costComplete: true`), `reservedUsd: 0.00021720`. Aggregate
spent across both runs: **$0.00025548 over 6 attempts** — 0.013% of the
$2 approval. Coverage: 6/6 judged, 0 unjudged (all statuses `ok`). Verified
offline + live (mocked transport, 19 tests passing): identical
state/questions bodies across models (model field only differs), 1
attempt/model, malformed answers recorded as `bad_response` (never 0.5),
error records carry codes only, spend-cap stops further models, `--mode
full` and unknown args refuse without network.

Notable (sample-of-one, not a quality claim): Luna snapped to 1.0/0.0
calibration extremes on this pair (cf. protocol risk: hardcoded tau=0.40
misfire); Jev and Perplexity returned spread probabilities.

Artifacts (mode 0600, hash sidecars; no credential strings in either —
verified zero `bearer`/`sk-or`/`api_key` matches):
- `/var/folders/.../T/judge-model-comparison-2026-10-07T17-30-25-596Z.json`
  (sidecar STALE: predates the exact-bytes fix; file bytes sha256 `d0416423…`)
- `/var/folders/.../T/judge-model-comparison-2026-10-07T17-30-33-052Z.json`
  (sidecar STALE likewise; file bytes sha256 `638f18ab…`)
- A unit test now pins sidecar == sha256(exact file bytes) for future runs.

## 6. Conservative full-run extrapolation (measured probe + exact corpus)

Corpus independently verified from fixture bytes: 314 units in 44 query
groups (78 gold, 148 hard_negative, 88 easy_negative); sha256 over
`set-a.jsonl || set-b.jsonl` = `2e9fa411…f2b871f9b`. Per the scored
runner's structure (1 warmup + 1 request per query group per arm; each
group packs into one <=24k-token batch):

| Scope | Planned calls | Upper (3 attempts each) |
| :--- | ---: | ---: |
| Per model arm | 45 | 135 |
| 3-arm single run | 135 | 405 |
| 3-arm x 5 replicates | 675 | 2025 |

Basis: measured Jev baseline 170,832 input tokens (≈544/judgment);
advertised input rates $0.042 / $0.040 / $0.100 per 1M (output free).

| Model | Single full run (314 units) | 5 replicates |
| :--- | :---: | :---: |
| `~typesafe/jev-latest` | $0.00717 | $0.0359 |
| `perplexity/pplx-decider-v1-27b` | $0.00683 | $0.0342 |
| `openai/gpt-6-luna-decisions` | $0.01708 | $0.0854 |
| **Total** | **$0.0311** | **$0.1555** |
| **Conservative upper (all retries bill full)** | — | **$0.4664** |

Global budget ledger vs the $2 aggregate approval: used $0.00025548
(measured probe, 6 attempts) + probe reserve $0.01 (cap) +
5-replicate conservative reserve $0.47 → headroom ≈ $1.52. No full paid
benchmark has run; it remains a separate future stage after this
measured-estimate audit. chars/4 is an estimation heuristic, not a token
bound — the 4x pre-request margin and the x3 retry upper are what make
the reserve conservative.

- Tiny probe (3 requests): ≈$0.00003, ~0.3% of the $0.01 cap.
- Call upper bound: 3 planned calls × 3 client attempts = **9** (retries on
  408/429/5xx + timeout, then fail-closed; accounted in the bound, not
  executed speculatively).
- Token routing limit: CloudJudge packs to a ~24k-token budget, but this
  probe enforces its own stricter ≤3000/request pre-check.
- Sample uncertainty: server-side score noise ±0.04 observed on Jev means a
  single-shot probe score is a sample of one — wire-compatibility and billing
  signal only, not a quality claim. Valid coverage and failure accounting
  (`validCoverage.judged/unjudged`) ship in every report; no happy-only
  metrics.

## 7. Default gate status

**Unchanged.** Cloud judge default remains `~typesafe/jev-latest`; judge mode
remains `off` by default. No promotion until the preregistered gates
(recall veto, operational veto, non-inferiority, tie-break) pass on scored
runs with owner sign-off. If any model's wire schema proves incompatible, the
plan is a failing contract test + escalation — not a silent adapter rewrite.
