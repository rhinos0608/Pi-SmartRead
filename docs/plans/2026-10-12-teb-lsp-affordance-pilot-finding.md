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

## Corrections after evidence audit (2026-10-12)

A mechanism analysis of the transcripts and a second-wave audit of it (raw event logs, harness code)
change how this result should be read. The primary numbers above stand.

- **The pilot barely exercised the bundle.** Only 2 of 60 `lsp-affordance` sessions used a new
  feature (`investigate`: 3 calls, all `task: "definition"`; `symbol` anchors: 4 calls). Both arms
  otherwise made ordinary LSP calls in a similar share of sessions (26 vs 24 of 60). Pilot tasks give
  exact coordinates, so name anchors were never needed. The comparison therefore mostly tested
  different LSP description and guidance text, not anchors or composite recipes.
- **Neither lost task is attributable to the bundle.** `package-exports-001`: no LSP or `inspect`
  call in any of the 6 sessions; the difference is whether the `./standalone` export was included
  (baseline 2/3, arm 1/3), consistent with sampling noise. `all-references-003`: both arms called
  `findReferences` and received identical results; the arm dropped the in-scope `import` binding in
  3 of 3 replicates, baseline in 1 of 3. The task text does not say whether imports count as
  references, and 3 replicates cannot separate an arm effect from chance.
- **Harness false-timeout defect.** 5 of the 10 timeouts were sessions that had already finished
  (agent settled at 8.3, 28.3, 36.1, 46.8 and 46.8 s): `launch.ts` waits for the `pi` process to
  exit before reaping its process group, and `pi` stayed alive until the 240 s watchdog killed it.
  Why `pi` did not exit is not yet established. A post-hoc sensitivity regrade of those 5 sessions
  with the harness's own grader leaves the task-level result unchanged (15/20 vs 13/20, −10 pp, CI
  −25 to 0); run-level becomes 43 vs 41. The other 110 completed sessions show a 3.0–3.8 s gap
  between settle and exit, so no other session was affected.
- **Benchmark validity limits.** `type-of-symbol` (0 of 12 runs) is scored by exact string equality
  against the hover banner; every answer gave a declared or structural type instead, so this family
  measured the grader, not the tools. All 18 `drizzle-orm` sessions began with a path error because
  task paths are relative to a package subdirectory while the session starts at the repository
  root. Small gold sets with `minRecall` 1.0 turn one omitted item into a task failure.
- **Retracted interpretation.** The lower invalid-call rate in the arm is not evidence that the
  bundle reduced path guessing: path errors were 9 vs 9, LSP errors 4 (baseline) vs 6 (arm); the
  difference came from `grep` parameter errors.
- **Signal worth keeping.** The only `callers-002` pass came from `prepareCallHierarchy` +
  `incomingCalls` (38 ms), where read-based approaches ran out of time. One unscoped
  `findReferences` returned 203 references (~73 KB of result text).

## Decision (owner, 2026-10-12)

Record this round as a finding, do not enlarge the holdout or start dev runs for this bundle, and
take a different approach: research and redesign the affordances, then re-run under a new
pre-registered plan.
