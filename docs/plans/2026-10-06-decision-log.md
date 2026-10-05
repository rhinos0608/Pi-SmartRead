# Decision log — grep/LSP overhaul, judge, enhanced find

Owner: orchestrating agent. Reader: maintainer reviewing the final PR stack.
Format: date · decision · why (evidence) · reversibility. Newest last. Evidence labels:
VERIFIED (directly observed this session), REPORTED (subagent/artifact, not re-run by parent), INFERENCE.

## Standing authority (from maintainer, 2026-10-06)

- Commit freely in this worktree (`feature/judge-and-find`), split by concern; no design/scope check-ins; resolve issues locally; lay all work up as stacked PRs at the end.
- Orchestrator does not write code directly; subagents implement. Scope for the external program: grep and LSP pipelines. Load-bearing external claims require independent evidence audit. Jev in inspect/script/other modes is deferred until after the external program.
- Ambiguity or design concerns: consult the `oracle` subagent before proceeding. Oracle is a consultant, not an authority; the orchestrator decides and records the decision here with the oracle's input and any disagreement.

## Decisions

| # | Date | Decision | Why / evidence | Reversible? |
|---|---|---|---|---|
| D1 | 10-05 | Judge refines NL grep after fusion/dedup; never replaces retrieval. `find` stays discovery-only. | Design docs `2026-10-05-grep-judge-design.md`, `-enhanced-find-design.md`. | Yes |
| D2 | 10-05 | Cloud judge only for parsed OpenRouter origin; key never read for other origins; von sidecar gets allowlisted env. | Security review found Azure identity env leak with denylist (VERIFIED tests). | Yes |
| D3 | 10-05 | Local von requests serialized per endpoint. | Reproduced MPS crash under concurrency 2; maxLive 4→1 after fix (VERIFIED). | Yes |
| D4 | 10-05 | Full-text grep keep gate .40 (pointer .45, exists .35, find .40 unchanged, separately). | Pooled cloud classification: .40→.45 trades 17 FP for 3 FN; recall-biased default. Same-fixture repeats ≠ generalization. | Yes (env seam) |
| D5 | 10-06 | Fix measurement before ranking (R1 before any cascade change). | Old harness counted synthetic top-5 snippets only, dropped errors from denominators, stored no cards, ran on dirty tree (VERIFIED source + probes). | — |
| D6 | 10-06 | q02 kept as `answerable_without_gold`; report declared 36 and evaluable 35; never drop/relabel. | Fixture audit: only answerable qid with zero gold (VERIFIED). | Yes |
| D7 | 10-06 | Metric renamed `knownGoldRecallAt5`; not a lower bound on true recall. | Unknown positives can enlarge the denominator. | Yes |
| D8 | 10-06 | Benchmark corpus = `git archive 18f6463` snapshot; engine identity = content hash of tracked+untracked non-ignored sources; unknown identity refuses resume. | Tracked-only hash missed untracked `src/judge/*` (VERIFIED). | Yes |
| D9 | 10-06 | Error status passed raw to classifier (`error:*` → `execution_error`). | Re-review repro: helper mapped to `execution_error` string the classifier ignored → `retrieval_unobserved` (VERIFIED red→green). | Yes |
| D10 | 10-06 | LSP child retention on smart grep is a lifecycle defect, deferred until after R1 benchmark; benchmark kills only owned PIDs and records lingering. | Handle audit traced ProcessWrap+Timeout to `lsp-connection.ts:360/447` (REPORTED). | — |
| D11 | 10-06 | External research quarantined until independent audit. | Prior research contained fabricated quotations (REPORTED by auditor; parent re-fetched two sources). | — |
| D12 | 10-06 | External shortlist accepted from audit (57 claims: 52 verified, 5 overstated, 0 fabricated) EXCEPT Multi-SWE-bench license: HF card shows "License: other" (VERIFIED by parent fetch) vs audit's Apache-2.0 → unresolved; license researcher assigned. Datasets cached at runtime, never vendored. SWE-bench Multilingual (MIT) usable meanwhile. | Parent fetch of HF dataset card. | Yes |
| D13 | 10-06 | Grep external protocol: two preregistered non-agentic formulations — issue title (primary) and full issue text (stress); literal/identifier queries a separate track; same source text to every comparator, ripgrep preprocessing disclosed. No first-N truncation. | Oracle consult `814d448e` (agreed). | Yes |
| D14 | 10-06 | Gold = production (non-test, non-doc) files in the fix patch at base commit, named **known-patch-file** gold. Primary metric success@5 within a common rendered-token cap; also macro known-patch-file recall@5, MRR, hunk/symbol overlap, tokens, latency, failures; ranks deduplicated by first file appearance. **Divergence from oracle:** no up-front full adjudication; a reviewer adjudicates the 12-case pilot to estimate label noise, and full adjudication is added only if pilot noise is material. | Oracle recommended adjudicated relevant files; cost vs value judged by orchestrator. | Yes |
| D15 | 10-06 | Sample: 12-case pilot → frozen 64 dev + 32 repository-disjoint holdout JS/TS; holdout opened only at declared milestones with repo-clustered intervals. Sized for large effects only. | Oracle consult (agreed). | Yes |
| D16 | 10-06 | LSP reference = the same pinned language server called directly; ts.LanguageService + scip-typescript snapshots as independent cross-check where semantics match. Unsupported/unavailable/timeout/proposal-only scored separately from wrong locations. | Oracle: shared TS semantics is not an independent oracle. | Yes |
| D17 | 10-06 | Comparators round 1: grep — ripgrep (floor), Probe, Codanna; LSP — @spences10/pi-lsp and mcp-language-server on common operations with the same pinned server. Zoekt and ast-grep MCP deferred. Tools installed under a cache tools dir, not globally. | Oracle consult (agreed). | Yes |
| D18 | 10-06 | Sequence: finish R1 matrix → external baselines → R2 fixes one at a time with paired reruns. LSP-child retention fixed in harness teardown only as a termination prerequisite; product lifecycle decision separate. | Oracle consult (agreed). | — |

## Round ledger

| Round | Changed | Benchmark | Outcome |
|---|---|---|---|
| R0 | audits only | historical off/.35/.40/.45 (pre-fix, diagnostic only) | known-gold 3/78 off, 5/78 judged |
| R1 | eval fidelity harness/metrics/contract | four-config matrix pending (workflow `9a6e2cf9`) | — |
