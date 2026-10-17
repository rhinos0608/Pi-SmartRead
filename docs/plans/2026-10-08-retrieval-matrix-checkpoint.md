# Retrieval matrix checkpoint (E18) — 2026-10-07 ~17:10 UTC

Scope: recovery checkpoint only. No new runs launched, no source edited, no
holdout opened, E18 arms/gates unchanged, judge OFF everywhere (all reports
show 0 judge invocations / $0 billed). Matrix loop from the timed-out worker
is still alive and progressing (own recorded run, pid 94779 family).

## Runner loop status (observe-only)

- Launcher alive: `bash /tmp/matrix.sh $a` loop over `A0 A1 A2 A3 A4 A5 A6 A7 A8 A0r`
  (logs `/tmp/matrix-logs/<arm>.log`, sentinel `/tmp/matrix.done` absent).
- Complete: A0, A1, A2, A3, A4, A5 (all 4 legs, all exits 0).
- In progress: A6 (selection + internal-44 + D46-dev done; external dev64
  mid-run at `sveltejs__svelte-13262` title leg, ~17:07 UTC).
- Missing: A6 external tail, A7 (×4), A8 (×4), A0r (×4).

## Completed artifacts (all exits 0, `status=complete` where applicable)

| Arm | Env | Selection (112) | Internal-44 file | D46-dev | External dev64 |
|---|---|---|---|---|---|
| A0 | — | `d46-selection-off-2026-10-07T15-53-02-211Z-3d2b3c01.json` | `grep-e2e-off-2026-10-07T15-53-05-187Z-p6418.json` | `d46-dev-off-2026-10-07T15-54-25-047Z-68199171.json` | `external-grep-dev-2026-10-07T16-00-28-084Z-3c82edc6.json` |
| A1 | FILENAME=1 | `d46-selection-off-2026-10-07T16-04-56-028Z-02c338ec.json` | `grep-e2e-off-2026-10-07T16-04-58-847Z-p61370.json` | `d46-dev-off-2026-10-07T16-06-19-467Z-3df37f63.json` | `external-grep-dev-2026-10-07T16-11-38-346Z-1377a587.json` |
| A2 | STEM=1 | `d46-selection-off-2026-10-07T16-16-04-476Z-95a5aece.json` | `grep-e2e-off-2026-10-07T16-16-07-325Z-p96817.json` | `d46-dev-off-2026-10-07T16-17-38-723Z-b5b648b5.json` | `external-grep-dev-2026-10-07T16-23-47-088Z-7cf1271d.json` |
| A3 | BM25=1.2,0.5 | `d46-selection-off-2026-10-07T16-28-18-084Z-e9031459.json` | `grep-e2e-off-2026-10-07T16-28-20-876Z-p53522.json` | `d46-dev-off-2026-10-07T16-29-43-376Z-163d705f.json` | `external-grep-dev-2026-10-07T16-35-04-650Z-47164aa9.json` |
| A4 | COVERAGE=1 | `d46-selection-off-2026-10-07T16-39-37-001Z-0dc0b317.json` | `grep-e2e-off-2026-10-07T16-39-40-171Z-p79131.json` | `d46-dev-off-2026-10-07T16-41-08-269Z-16008cec.json` | `external-grep-dev-2026-10-07T16-46-56-464Z-bf7ace11.json` |
| A5 | BM25=1.2,0.5+COVERAGE=1 | `d46-selection-off-2026-10-07T16-51-18-020Z-62148f5e.json` | `grep-e2e-off-2026-10-07T16-51-20-536Z-p4529.json` | `d46-dev-off-2026-10-07T16-52-48-097Z-2bd0a783.json` | `external-grep-dev-2026-10-07T16-58-16-083Z-f2b06143.json` |
| A6 | DEMOTE=0.5 | `d46-selection-off-2026-10-07T17-02-32-489Z-4b4a866c.json` | `grep-e2e-off-2026-10-07T17-02-35-391Z-p33895.json` | `d46-dev-off-2026-10-07T17-04-00-224Z-51574b1d.json` | (running) |

Selection/internal reports under `/Users/rhinesharar/.cache/pi-smartread-bench/reports/`
and `~/.cache/pi-smartread-judge-spike/bench/grep-e2e/` respectively.
Knob identity verified per report (`manifest.rankingKnobs` /
`retrievalConditions` / top-level `rankingKnobs`): every arm shows its intended
knob and only its intended knob. Judge usage 0 in all completed reports.

## Raw headlines (NOT gate verdicts — see engine caveat)

- Selection success: A0 50/96, A1 52/96, A2 46/96, A3 55/96, A4 59/96, A5 67/96, A6 50/96.
- Internal-44 file-hit: A0 20/35, A1 20/35, A2 18/35, A3 19/35, A4 21/35, A5 22/35, A6 21/35.
- D46-dev success: A0 25/48, A1 25/48, A2 23/48, A3 27/48, A4 29/48, A5 34/48, A6 26/48.
- External total: A0 36/128, A1 33/128, A2 35/128, A3 40/128, A4 41/128, A5 48/128.

## Engine-identity caveat (decision required, blocks gate application)

`engineSourceHash` differs across arms — sibling src/scripts edits landed
mid-matrix (worktree still dirty, nothing discarded):

- A0 all legs: `f5338cd5…:296-files`
- A1, A2 all legs: `49c177fa…`
- A3 selection: `3ef45ff2…` but A3 dev/external/g2e: `7af13620…` (edit landed mid-arm)
- A4, A5, A6 (legs so far): `7af13620…`
- Tree content-md5 changed between matrix start (`98c331ed…`) and 17:07 (`92ffb134…`).

E18 requires a fresh same-engine baseline. Strictly, only same-hash pairs are
comparable (A1 vs A2; A4 vs A5 vs A6-legs-so-far vs A3-dev/ext). Steering notes
ranking inputs unchanged (bets/LSP/inspect/TEB-scorer only), but the gate must
not be applied mechanically across engine hashes without parent ruling.

## Git/process state

- `git status` dirty (ranking/TEB/d46-runner/hook files M, TEB + stemmer files ??);
  decision-log also M from orchestrator. No commit made.
- No holdout file touched (only `--split selection/dev`, fresh-cohort dir, dev64 manifest).
- No action taken on live processes (ownership shared with prior run); loop PIDs
  recorded above for the parent.

## Recommended next single bounded run

After parent freezes src (commit or stash) and rules on the engine caveat: one
bounded rerun of the FULL arm set A0–A8 + A0r on the frozen tree (~2 h,
`for a in A0 A1 A2 A3 A4 A5 A6 A7 A8 A0r; do bash /tmp/matrix.sh $a; done`),
then `/tmp/analyze.mjs` + results doc. If parent accepts current-tree data as
exploratory, the only missing bounded piece is: A6-external tail (finishing
~17:15) + A7 + A8 + A0r on whatever tree then exists — but that extends the
mixed-engine set, so prefer stopping the loop after A6 and rerunning frozen.
Suggested loop-stop (needs parent go-ahead, mine to action): `kill 94779`
after A6 END appears, before A7 START.
