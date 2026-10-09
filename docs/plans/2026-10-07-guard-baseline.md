# Retrieval regression-guard baseline — main vs feat/teb-bench (2026-10-07)

Owner: guard-benchmark worker. No repository source was edited; all runs are
read-only benchmark executions. No holdout split was touched: every external
run used `--split dev` without `--open-holdout`, and D46 used `--split dev`
only. Judge OFF / default config everywhere (no `PI_SMARTREAD_JUDGE_*`
overrides; `PI_SMARTREAD_EMBEDDING_{BASE_URL,MODEL}` left at ambient defaults,
identical for both states).

## Code states

| State | Location | HEAD | Engine identity emitted by runners |
|---|---|---|---|
| Baseline (main) | `/Users/rhinesharar/Pi-SmartRead-baseline` (detached worktree at `3aa32fd`, `npm ci` clean, `git status` clean) | `3aa32fd6262426e0dc47d9e4438b116957ea586b` | `sha256:ece23b54…:275-files` |
| Branch | `/Users/rhinesharar/Pi-SmartRead-ergonomics` (`feat/teb-bench`) | `ccbb39c71115c8012a8bbd93751dc3a02c7cb5e0` | `sha256:f356c5e3…:278-files` |

Note: the baseline already ships the demote-0.7 default — the baseline
external-dev report records
`rankingKnobs = {rankTestDemote: 0.7, rankFilename: false, rankBm25k1: 1.2,
rankBm25b: 0.75, rankCoverage: false, rankStopwords: false}`, identical to the
branch. Engine file-count delta (275 vs 278) is harness/source inventory, not
a retrieval change (branch adds `src/runtime/tool-guidance.ts`-era files).

## Results table (baseline vs branch, delta)

| # | Benchmark | Command (identical both states) | Baseline report | Branch report | Baseline metrics | Branch metrics | Δ (branch − baseline) |
|---|---|---|---|---|---|---|---|
| 1 | D46 dev, judge off | `npx tsx scripts/eval/d46/run.ts --split dev --config off` | `reports/d46-dev-off-2026-10-07T12-54-16-517Z-2a315b1a.json` (exit 0, 32 s) | `reports/d46-dev-off-2026-10-07T12-35-17-227Z-835ae147.json` (exit 0, 33 s) | success@5 24/48, recall@5 .420, MRR .356, nDCG@5 .373, read-ready@5 7/48, false-empty 2, false-content 8/8, errors 0; lat p50/p90 340/915 ms, tok p50/p90 1668/2124 | identical aggregates: 24/48, .420, .356, .373, 7/48, 2, 8/8, 0; lat p50/p90 365/951 ms, tok p50/p90 1668/2124 | **0 on every quality metric; 56/56 queries paired-identical** (only `elapsedMs`/`engineSourceHash`/rendered-timing text differ) |
| 2 | Internal 44 (`grep-e2e`), judge off | `npx tsx scripts/eval/judge/grep-e2e.ts --config off` | `~/.cache/pi-smartread-judge-spike/bench/grep-e2e/grep-e2e-off-2026-10-07T12-54-19-114Z-p35796.json` (exit 0, 51 s) | `…/grep-e2e-off-2026-10-07T12-35-34-728Z-p98806.json` (exit 0, 55 s) | file-hit@5 20/35, knownGoldR@5 0.0641 (5/78), covered 5/36, declared 5/35, renderedTok 2134.1/q, legacyTok 544.6/q, abstCorrect 0/8, errors 0; runFingerprint `7c8867da…` | file-hit@5 20/35, same 5/78, 5/36, 5/35, 2134.1/q, 544.6/q, 0/8, 0; runFingerprint `a84aaedd…` | **0; 44/44 queries semantically identical** (only temp-corpus paths + timing text differ; corpus `18f6463`, 626 files both) |
| 3 | External grep frozen dev64, titles + bodies | `npx tsx scripts/eval/external/grep/run.ts --manifest ~/.cache/pi-smartread-bench/manifests/external-grep-dev64-holdout32.json --split dev --accept-license-review --offline` | `reports/external-grep-dev-2026-10-07T13-00-15-400Z-7945303c.json` (exit 0, 4 m 57 s) | `reports/external-grep-dev-2026-10-07T12-42-08-765Z-5fba8550.json` (exit 0, 5 m 39 s) | titles 16/64, bodies 19/64, total 35/128, recall@5 .211, MRR .158, hunkOverlap .0625, tokens 1908.2/q, errors 0 | titles 16/64, bodies 19/64, total 35/128, .211, .158, .0625, 1908.2/q, 0 | **0; 128/128 outcomes paired-identical** excl. `elapsedMs` (branch mean elapsed 2524 ms vs baseline 2210 ms — wall-clock noise, same-machine sequential runs) |
| 4a | LSP fidelity, ours, self | `node --import tsx scripts/eval/external/lsp/run.ts --corpus self --limit 150 --seed 20261005` | `reports/lsp-self-2026-10-07T13-00-34-985Z.json` (exit 0, 13 s) | `reports/lsp-self-2026-10-07T12-50-52-126Z.json` (exit 0, 13 s) | defExact .9930, defStart .9930, meanF1 .9872, hoverSig .9533, agreement .9930 (1 other), ok 581 / empty 19 | identical: .9930 / .9930 / .9872 / .9533 / .9930, ok 581 / empty 19 | **0** |
| 4b | LSP fidelity, ours, mitt | `… --corpus mitt --limit 150 --seed 20261005` | `reports/lsp-mitt-2026-10-07T13-00-38-774Z.json` (exit 0, 4 s) | `reports/lsp-mitt-2026-10-07T12-50-59-778Z.json` (exit 0, 4 s) | defExact 1.0, defStart 1.0, meanF1 1.0, hoverSig .7467, agreement 1.0, ok 476 / empty 124 | identical | **0** |

All report paths are under `/Users/rhinesharar/.cache/pi-smartread-bench/`
(`reports/` for 1/3/4, `~/.cache/pi-smartread-judge-spike/bench/grep-e2e/`
for 2). Every command exited 0 with `status=complete` and 0 errors.

## Comparators (run once, from the branch tree)

No comparator binary is missing. All present and working:
`rg` (ripgrep 15.1.0, system binary), Probe `v0.6.0-rc341` (pinned cache
tools dir), Codanna `v0.16.0` (pinned cache tools dir), pi-lsp `0.0.48`,
mcp-language-server (pinned cache tools dir), reference
`typescript-language-server 6.0.0` + TS 5.9.2.

Caveat: the grep comparator runner
(`scripts/eval/external/grep/comparators/run-comparators.ts`) has **no
`--manifest` flag** — it only runs the stale provisional freeze
(`external-grep-freeze.json`: pilot=12, dev=31, zero overlap with the frozen
dev64 per D47). Comparator numbers below are therefore **not comparable** to
the ours dev64 rows; they are recorded as binary-availability + reference
evidence only:

| Comparator | Report | success@5 (provisional dev31, title+body) | Split detail |
|---|---|---|---|
| ripgrep | `reports/external-grep-ripgrep-dev-2026-10-07T12-43-37-094Z-6a3ffe97.json` (78 s) | 3/62, recall .040, MRR .060 | titles 2/31, bodies 1/31 |
| Probe | `reports/external-grep-probe-dev-2026-10-07T12-47-09-457Z-b4bbcefa.json` (3 m 13 s) | 22/62, recall .304, MRR .213 | titles 10/31, bodies 12/31 |
| Codanna | `reports/external-grep-codanna-dev-2026-10-07T12-50-33-052Z-d3b971a3.json` (3 m 24 s, setup 199 s) | 5/62, recall .062, MRR .074 | titles 5/31, bodies 0/31 |

LSP comparators (same 150-position samples as ours arms, `--seed 20261005`):

| Comparator | self (150) | mitt (150) |
|---|---|---|
| pi-lsp | def exact .9860 / start .9860, refs meanF1 .9901, hoverSig .9533; ok 436 / unsupported 150 / empty 14 (`reports/lsp-pi-lsp-self-2026-10-07T12-51-11-248Z.json`) | def 1.0/1.0, refs F1 1.0, hoverSig .7467; ok 372 / unsupported 150 / empty 78 (`…-mitt-2026-10-07T12-51-14-141Z.json`) |
| mcp-language-server | def exact 0 / start 0 (whole-definition spans, known per X0b), refs meanF1 .033 (start-anchored .498), hoverSig .9533; ok 411 / unsupported 150 / empty 39 (`reports/lsp-mcp-language-server-self-2026-10-07T12-53-30-150Z.json`, 2 m 10 s) | def 0/0, refs F1 .207 (start .547), hoverSig .7467; ok 321 / unsupported 150 / empty 129 (`…-mitt-2026-10-07T12-53-39-687Z.json`) |

## Verdict

**Phase-1 is retrieval-neutral: every guard delta is exactly zero.**
D46 dev 56/56, internal-44 44/44, and external dev64 128/128 outcomes are
paired-identical between `3aa32fd` and `ccbb39c` after excluding run-identity
fields (engine hash, elapsed/latency ms, temp-corpus paths, rendered timing
text). LSP fidelity is bit-identical on both corpora. No flag raised; no
benchmark failed to run and no numbers are fabricated. Residual risk: latency
comparisons are wall-clock on one shared machine (sequential runs) — treated
as noise, not signal. Known harness gap (pre-existing, not introduced here):
grep comparator runner cannot target the frozen manifest, so comparator
success rates are on a different split and must not be compared to ours dev64.

## Audit

Audited against cited raw JSON reports in `/Users/rhinesharar/.cache/pi-smartread-bench/` and `~/.cache/pi-smartread-judge-spike/bench/grep-e2e/`. Rounded values below match the cited full-precision report values.

### Runs, identities, and splits

- **VERIFIED** — Baseline HEAD is `3aa32fd6262426e0dc47d9e4438b116957ea586b`; branch HEAD is `ccbb39c71115c8012a8bbd93751dc3a02c7cb5e0`, on `feat/teb-bench`. Direct `git rev-parse HEAD` checks matched both. D46/external reports have the matching engine source hashes (`ece23b54…:275-files` baseline; `f356c5e3…:278-files` branch); both grep-e2e reports also record the corresponding full HEAD and engine identity.
- **VERIFIED** — D46 raw reports are `split=dev`, `status=complete`, `queryCount=56`. External grep reports are `split=dev`, `status=complete`, with 128 title/body outcomes using the cited `external-grep-dev64-holdout32.json` manifest. Grep-e2e reports are complete with 44 queries and corpus ref `18f6463caa78e6657b1af6c7eb86b711bc2364f8`; they do not have a split field. Comparator grep reports record `split=dev`, 62 runs, zero errors.
- **UNVERIFIABLE** — “No holdout split was touched” as an assertion about all process activity, plus shell exit codes and command wall-clock durations: reports establish the recorded dev splits/results but not all process history or holdout access. The plan's commands specify `--split dev` and omit `--open-holdout`, but are not retained execution logs.

### Retrieval metrics

- **VERIFIED** — D46 baseline and branch: success@5 `24/48`; recall@5 `0.4201388888888889` (`.420`); MRR `0.35565476190476186` (`.356`); nDCG@5 `0.3728049182154783` (`.373`); read-ready `7/48`; false-empty `2`; false-content `8`; errors `0`. Both report summaries agree.
- **VERIFIED** — Internal grep-e2e baseline and branch: file-hit@5 `20/35`; known-gold recall `5/78 = 0.0641025641025641`; rendered tokens/query `2134.1363636363635`; legacy top-5 tokens/query `544.5909090909091`; correct abstention `0/8`; errors `0`; `626` inventory files. Reported metrics match.
- **MISMATCH** — Internal grep-e2e table labels/value pairs: it says “covered 5/36, declared 5/35.” The raw report has `declaredQueryCoverage=5/36` and `evaluableQueryCoverage=5/35`; correct labels/values are **declared 5/36; evaluable (covered evaluable queries) 5/35**. File-hit `20/35` is correct.
- **VERIFIED** — External grep baseline and branch: titles `16/64`, bodies `19/64`, total success@5 `35/128`; mean recall@5 `0.21119791666666665` (`.211`); mean MRR `0.15803487401240407` (`.158`); hunk overlap `0.0625`; rendered tokens/query `1908.15625`; errors `0`. Both summaries agree and each has 128 outcomes.
- **VERIFIED** — D46 and external outcome counts are `56/56` and `128/128`, respectively. External per-outcome success/recall/MRR fields match. D46 aggregate quality metrics match; timing and engine identity differ.
- **UNVERIFIABLE** — The stronger descriptions “56/56 queries paired-identical” for D46 and “44/44 queries semantically identical” for grep-e2e were not independently reproduced as a complete normalized semantic comparison; aggregate metrics above were compared directly.

### LSP metrics and comparator figures

- **VERIFIED** — Ours/self, baseline and branch: defExact/defStart `0.993006993006993` (`.9930`); references mean F1 `0.9872380952380952` (`.9872`); hover signature `0.9533333333333334` (`.9533`); agreement `0.993006993006993`; 581 ok / 19 empty. Reports contain 150 positions and seed `20261005`.
- **VERIFIED** — Ours/mitt, baseline and branch: defExact/defStart `1.0`; references mean F1 `1.0`; hover signature `0.7466666666666667` (`.7467`); agreement `1.0`; 476 ok / 124 empty. Reports contain 150 positions and seed `20261005`.
- **VERIFIED** — pi-lsp comparator: self def exact/start `0.986013986013986` (`.9860`), refs F1 `0.9901176470588234` (`.9901`), hover `.9533333333333334`, statuses 436/150/14; mitt def exact/start `1.0`, refs F1 `1.0`, hover `.7466666666666667`, statuses 372/150/78.
- **VERIFIED** — mcp-language-server comparator: self def exact/start `0`, refs exact mean F1 `0.03333333333333333` (`.033`), start-anchored F1 `0.49754449421086266` (`.498`), hover `.9533333333333334`, statuses 411/150/39; mitt def exact/start `0`, refs exact F1 `0.20666666666666667` (`.207`), start-anchored F1 `0.5469158555596324` (`.547`), hover `.7466666666666667`, statuses 321/150/129.
- **VERIFIED** — Grep comparator reports: ripgrep success `3/62`, recall `.04032258064516129` (`.040`), MRR `.0597237710846053` (`.060`); Probe `22/62`, `.3037634408602151` (`.304`), `.21301423838875147` (`.213`); Codanna `5/62`, `.06182795698924731` (`.062`), `.07442396313364055` (`.074`). Reports show dev split and zero errors.
- **UNVERIFIABLE** — Comparator title/body subcounts, pilot/dev inventory sizes and zero-overlap claim, runner's lack of `--manifest`, tool versions/availability and total setup/runtime durations are not established by cited summary metrics alone; the cited manifest, runner, and binary artifacts were not independently inspected. Raw comparator reports do establish the overall metrics above; `totalSetupMs` is available where present but not independently compared to the prose values.

### Other environment numbers

- **UNVERIFIABLE** — Individual process durations in the report table (32/33 s, 51/55 s, 4m57/5m39, 13/13 s, 4/4 s, 78 s, 3m13, 3m24, setup 199 s), `npm ci clean`, and “all comparator binaries present and working”: the cited JSON lacks execution logs for those claims. Per-query `meanElapsedMs` in benchmark reports is not total process duration.
- **VERIFIED** — D46 baseline/branch and both external-grep reports record the shared ranking values: `rankTestDemote=0.7`, `rankFilename=false`, `rankBm25k1=1.2`, `rankBm25b=0.75`, `rankCoverage=false`, `rankStopwords=false`.
