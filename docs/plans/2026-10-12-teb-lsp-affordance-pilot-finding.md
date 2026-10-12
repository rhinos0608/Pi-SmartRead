# TEB LSP-affordance pilot — finding (2026-10-12)

Status: **round paused by owner decision; redesign before any further run.** No dev or holdout run
occurred. No arm is adopted or promoted; nothing changes production defaults.

## Setup

- Protocol: `docs/plans/2026-10-07-teb-protocol.md` with pre-data amendments in §16 (model
  `openai-codex/gpt-6-luna` for both arms, 20 adjudicated pilot tasks, built arms only, subscription
  billing, classifier correction, live-captured identity pins).
- Arms: `baseline` (`PI_SMARTREAD_AFFORDANCES=0`) vs `lsp-affordance` (`=1`), both from the admitted
  producer SmartRead `c388cc5` (PR #50), pi 0.99.2 (binary sha256 `e79626f2…`). Identity check passed
  on all 120 sessions.
- Design: 20 tasks × 2 arms × 3 replicates = 120 sessions, concurrency 1, 240 s session timeout,
  25-turn cap. Run `teb-1791733605437-pid28926`, harness PR #48 `2cbc8fd`.
- Scoring: harness `scripts/eval/teb/score.ts`; task outcome = majority over replicates (ties fail);
  paired bootstrap B = 10,000, seed 20261007. Outputs:
  `~/.cache/pi-smartread-bench/teb/sessions/teb-pilot-20261012b/analysis/report.md`
  (sha256 `f25e2ace…`) and `scored.json` (`6abe95ac…`).

## Result

Valid batch: 0 of 120 sessions excluded (invalidation threshold 5%); no contamination; every checkout
verified.

| Metric | baseline | lsp-affordance |
|---|---|---|
| Tasks passed (majority of 3) | 15/20 | 13/20 |
| Runs passed | 41/60 | 41/60 |
| Opportunity recall (specialist tool used where it fits) | 42.9% | 54.8% |
| Specialist precision | 97.8% | 100% |
| Invalid-call rate | 0.066 | 0.047 |
| Negative-control tasks passed | 6/6 | 6/6 |
| Model tokens per session (mean) | ~73.5k | ~72.0k |

- Paired task success gain **−10 pp** (95% CI −25 to 0). Discordant tasks: 2, both lost by the arm
  (`all-references-003`, `package-exports-001`); none gained. Leave-one-repository-out differences
  were all negative.
- Ten sessions hit the 240 s cap (baseline 6, arm 4), concentrated on two tasks neither arm solves
  (`callers-002`, `all-references-002`). Median session ≈ 40 s.
- Gates at the harness default (E6 proposal, not owner-frozen): task success FAIL, recall gain FAIL
  (+11.9 pp vs 15 pp), precision PASS, negative veto PASS (untestable at n = 20), lost successes FAIL
  (2 of 15 = 13.3% vs 5%).

## Interpretation

The affordance bundle **increased use of the specialist LSP tool where it fit, without improving task
success**, and lost two previously passing tasks. Higher appropriate tool use is therefore not
sufficient on its own; whatever the bundle changes in guidance or schema did not translate into
better answers on these tasks.

## Limitations

- n = 20 tasks with only 2 discordant pairs: the effect estimate is very imprecise.
- Families `type-of-symbol` (0% both arms) and `callers` (floor) teach little about the bundle.
- One model (`gpt-6-luna`); results may not transfer.
- Pilot tasks are unsealed calibration data: they may inform redesign, but a redesigned bundle must
  be evaluated on tasks it was not designed against.
- Power: detecting +5 pp at 80% would need roughly 314 tasks (normal approximation from the observed
  10% discordance, itself resting on 2 discordant pairs); the planned holdout is 120.

## Decision (owner, 2026-10-12)

Record this round as a finding, do not enlarge the holdout or start dev runs for this bundle, and
take a different approach: research and redesign the affordances, then re-run under a new
pre-registered plan.
