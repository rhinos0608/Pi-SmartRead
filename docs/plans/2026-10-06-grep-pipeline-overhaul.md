# Grep pipeline overhaul — living plan / ledger (2026-10-06)

Worktree boundary: `/Users/rhinesharar/Pi-SmartRead-judge-find`, branch `feature/judge-and-find`.
Dirty user-owned tree: no commits/staging/publication. No edits to the original checkout.
Constraints: four thresholds preserved (full-text `.40`, pointer `.45`, exists `.35`, find `.40`);
grep schema unchanged; no new dependencies. Material public-interface/architecture changes need check-in.

## Goal

End-to-end grep overhaul via sustained **audit → red repro → fix → benchmark** rounds until evidence
converges or blocked. Stacked-PR deliverable prepared only; parent resolves authorization/base/commit grouping.

## Claim tags

- **REPORTED**: subagent findings, historical benchmark numbers — pending independent evidence audit.
  Reading verifies artifact existence/content, not source, repro, or measurement.
- **VERIFIED-source** (only two narrow facts, directly read this lane):
  (1) `scripts/eval/judge/grep-e2e.ts:209-226` — harness token estimate is top-5-only
  `ceil(chars/4)`, not full rendered output. (2) `scripts/eval/judge/run.ts:187-195` —
  totals accumulate warmup usage (`costUsd`/`inputTokens` seeded from warmup).
- Everything else below from reports/docs is REPORTED until re-verified.

## REPORTED baseline (not full rendered tokens; causes unresolved)

- REPORTED e2e: off 505.1 top5-est-tok 3/78 gold; t035 291.7 5/78; t040 277.5 5/78.
- REPORTED classification AUROC .9589–.9598: repeatability on the SAME fixture, not out-of-domain generalization.
- REPORTED audit (`/tmp/smartread-grep-audit/FINDINGS.md`): F1 q02 answerable with 0 golds;
  F2 no raw hit cards (44 file-match UNKNOWN); F3 token scope gap; F4 pinned→dirty drift small;
  F5 harness fidelity notes. REPORTED prior workflow: b131ac9b/f94e6e7a/cascade-judge-pending,
  t045 child 00ab4447 read-only, 05c5f6ea timeouts with partial artifacts.

## Open

1. **q02**: invalid/incomplete evaluation row. Missing-gold policy not explicit — do not declare
   denominator wrong. Report both declared-answerable (36) and evaluable-with-gold (35) counts; never drop q02 silently.
2. **Poor coverage causes** undiscriminated (retrieval vs ranking vs vocabulary mismatch vs labels).
3. **Fidelity**: first draft instruments production output, but independent review blocks R1 on error denominators, error-cause inference, discarded candidate cards, and stale resume identity. Remediation active.
4. **Dirty-tree eligibility**: contamination hypothesis untested — do not declare confirmed until tested.
5. **Pointer/exists/find thresholds** uncalibrated for their own state/question shapes.
6. **von local** REPORTED near-chance — experimental.

## Scope map (paths verified this lane via directory listing)

| Stage | Owner |
|---|---|
| Routing/gating (NL heuristic, literal/regex/structural bypass) | `src/search/grep-tool.ts`, `src/search/query-intent.ts`, `src/search/grep-cascade.ts` |
| Lexical/BM25 | `src/search/*`, `src/indexing/orama-search.ts` |
| AST/structural | `src/search/grep-structural-executor.ts` + tags cache |
| Semantic | `src/indexing/*`, `src/retrieval/*` (indexing scope/behavior awaits lifecycle audit) |
| Graph | `src/graph/*`, `src/context-graph.ts` (pointer peek must not trigger build) |
| Fusion/ranking/dedup | `src/search/grep-cascade.ts`, `src/ranking/*`, `src/retrieval/runner.ts` |
| Judge full-text/exists/pointers | `src/judge/grep-judge-stage.ts`, `src/judge/*` |
| Rendering/evidence | `src/search/grep-tool.ts`, `src/evidence/*` |
| Eval harness | `scripts/eval/judge/*` only (+ new `*.test.ts` per validation change) |
| Find NL (shared seams only) | `src/search/find-tool.ts`, `src/search/find-modes.ts` |

Out of bounds: sister repo, protocol bumps, LSP proposal behavior, network/key trust changes.

## Method

Per round: manifest (corpus content hash + pinned ref, actual engine source/lockfile hashes + dirty disclosure,
fixture sha256/counts, model/gates/params/retrieval conditions, private raw artifact paths outside repo) → failing-first red gate →
minimal fix → benchmark before next round. Benchmark records per-query + aggregate metrics,
abstention correctness, latency p50/p95, cost, completeness (no silent degradation/drops/hidden queries).
Bounded review/research slices; no polling waits. Independent evidence audit + research gates per round.

## Ledger

| Round | Slice | Benchmark |
|---|---|---|
| R1 (active, review remediation) | Diagnostic seam drafted; writer workflow `88174a63` interrupted on seconds/milliseconds mistake. Parent passed 476 tests + typecheck/diff-check. Review blockers addressed by artifact writer `6d7da03b` and metric worker workflow `4c0ae09b` | still open; full four-config matrix only after contract re-review, before runtime/ranking/gate fixes |
| R2+ | Retrieval/cascade/judge slices, one seam per round with red gate + benchmark | not yet run; required before closure |

## Stop criteria

Two fresh independent passes across checked seams, no confirmed unresolved defect; benchmark
complete (all queries accounted, no silent degradation/drops/hidden queries); q02 disposition explicit
per §Open-1; thresholds preserved unless task-specific evaluation + check-in; polish separate.

## PROPOSED PR stack (boundaries only, architecture open)

1. Evaluation fidelity. 2. Retrieval/cascade correctness slices. 3. Judge/integration correctness.
4. Evidence/docs. Slices land only with measured evidence; no fabricated issues.

## Next

R1 artifact writer owns harness/new contract helper/tests; metric writer owns pure metric helper/tests. No competing writers on `grep-tool.ts` or judge stage. Review amended contract, then commission frozen off/.35/.40/.45 matrix before any runtime/cascade fix.

## Round 0 dispositions (2026-10-05)

- Independent evidence audit: `/tmp/smartread-grep-audit/evidence-dispositions.md`.
- VERIFIED-source: BM25 `runFallbackBm25` emits one anchor line/file (snippet has context); comment-anchor range misses do not establish the right fix. Broader retrieval causes remain hypotheses.
- REPORTED lifecycle temp probes retracted profile/revision-cache defects; watcher freshness remains unproven. No lifecycle runtime fixes commissioned.
- VERIFIED-artifact: historical t045 report now accounts for 44 queries, zero reported errors, 5/78 known-gold overlap, 5/36 declared coverage, 5/8 abstention, 243.4 top5-only estimated tokens/query. Diagnostic only, not production-output accounting.
- External research citations remain quarantined: independent audit reported fabricated quotations; parent fetched cookbook tune warning and candidate-document existence scope. Current von model card warns its calibration does not carry to other distributions; not evidence of version-specific universal calibration.
- Reviewer home-directory discovery was interrupted; revived as `20307fb2`, completed the scoped evidence audit. No alternate execution mode or source mutation.

## R1 / queued correctness evidence

- VERIFIED-probe: missing-probability fake provider returned unjudged `u1`; stage omitted its hit (`missing-prob-repro.mts`, parent exit 0). R2 must preserve unscored fallback without relabeling missing scores as zero.
- VERIFIED-source: exists request supplies only `candidateCount`, while question asks about unit content. R2 must supply bounded evidence; not a proved cause of historical B13/B6 misses.
- REPORTED source/probes: `/tmp/smartread-grep-audit/grep-cli-handles-findings.md` traces completed smart-query retention to LSP child/timers. No production teardown/opt-out change commissioned.
- VERIFIED-probe: error-denominator fixture produced reported 1/1 instead of true known-fixture 1/2 (parent expected-red exit 1). R1 must count failed queries but label retrieval evidence unknown.
- VERIFIED-source: qid-only checkpoint fingerprint and HEAD/dirty-only engine metadata cannot distinguish changed uncommitted source. R1 content identity + checkpoint validation required.
- Metric correction: use **known-gold recall**, not a claimed lower bound on true recall; incomplete positives can expand numerator and denominator. Historical files remain untouched.
- Metrics reviewer `e8feec64` lacked `edit`, made no source writes, released ownership. Native-worker repair uses the same subagent protocol; no shell editing or external fallback.
- VERIFIED-probe (post-fix): failure-denominator fixture now reports known-gold 1/2, recall .5, file-hit 1/2 (parent exit 0); metrics tests 16/16.
- VERIFIED-source: engine identity uses `git ls-files --cached --others --exclude-standard`; unknown identity refuses resume (`grep-e2e-contract.ts:79-107`).
- VERIFIED-run (parent): judge+search 39 files / 497 tests, typecheck, diff-check all exit 0; nothing staged. Fresh R1 re-review workflow `5887201c` pending before the four-config matrix.

## Final round ledger / campaign status (2026-10-07)

- R1 (eval fidelity): harness contract, engine/file identity, failure denominators, known-gold recall; red-gated fixes landed before any runtime ranking change.
- R2 (retrieval/cascade/judge): unscored-fallback preservation, exists-evidence capture (`judge.*` per-query details), faithful abstention rendering (zero pointers on abstain), fine-grid sweeps.
- External program: Probe/ripgrep/Codanna pilots plus LSP parity checks; baselines only, gaps recorded (ranking/latency) — no shipping claims.
- D46 campaign: dev baselines (D64), judge-off gates (D65, challenger rejected on loss veto), exists capture/sweep (D66), oracle variant + semantics verdicts (D67),
  abstention contract (D68), single-opening freeze at exists 0.04 / excerpts / keep 0.40 (D69) — opening spent once.
- D70 verdict: holdout (210 queries, 8 repos) HARMS under the frozen 6:1 FN:FP rule (paired Δ +0.80/query, 95% CI [+0.55,+1.06]);
  false-empty ~2.4%→17.3% dominates false-content gains; kept queries gain precision/read-ready. Default stays OFF;
  `/judge cloud` output + README surface the finding; keep-gate work continues on dev only, never retuned against the holdout.
- Pointers: full per-round record in `docs/plans/2026-10-06-decision-log.md` rows D57–D70 (verdict D70; freeze D69; gate/semantics D65–D68);
  this section is a status summary only and does not duplicate the log.
- Campaign closed: no further holdout access; future judge work needs a fresh predeclared cohort.
