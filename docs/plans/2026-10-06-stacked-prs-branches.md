# Stacked PR branches — `stack/pr-01`..`stack/pr-12`

Base: `18f6463`. History is linear, so `stack/pr-NN` points at that PR's
cumulative end SHA and contains exactly the commits up to that PR. Created with
`git branch stack/pr-NN <sha>` only (no checkout, no worktree mutation).

| Branch | Head SHA | PR title | Cumulative commits (`18f6463..head`) | Push (NOT executed) |
|---|---|---|---|---|
| `stack/pr-01` | `ee33e50` | judge core, von sidecar, /judge command | 3 | `git push -u origin stack/pr-01` |
| `stack/pr-02` | `7c1b6b1` | enhanced find + grep smart-cascade judge stage | 5 | `git push -u origin stack/pr-02` |
| `stack/pr-03` | `6eca457` | Pi/MCP wiring for judge and find | 6 | `git push -u origin stack/pr-03` |
| `stack/pr-04` | `6e093ef` | eval harness: judge runner, grep e2e, metrics, curves | 10 | `git push -u origin stack/pr-04` |
| `stack/pr-05` | `ce37809` | external pipelines + comparators | 22 | `git push -u origin stack/pr-05` |
| `stack/pr-06` | `73c8f07` | regex routing work | 27 | `git push -u origin stack/pr-06` |
| `stack/pr-07` | `23f4989` | latency/parser/span fixes + symbol-unit intro | 40 | `git push -u origin stack/pr-07` |
| `stack/pr-08` | `d473a24` | ranking knobs: unit controls + BM25 | 61 | `git push -u origin stack/pr-08` |
| `stack/pr-09` | `7e21d2d` | frozen manifests, IR metrics, demote-by-default | 80 | `git push -u origin stack/pr-09` |
| `stack/pr-10` | `998c258` | variant matrix + judge hardening | 91 | `git push -u origin stack/pr-10` |
| `stack/pr-11` | `9cf9d4e` | D46 held-out set + runner/scorer + freeze tooling | 112 | `git push -u origin stack/pr-11` |
| `stack/pr-12` | `08fa6f3` (= HEAD) | abstention contract D67 + decision-log close-out (+ 4 post-plan commits, see plan appendix) | 128 | `git push -u origin stack/pr-12` |

## Verification

- `git rev-list --count 18f6463..stack/pr-NN` matches the cumulative column above
  (PR1–PR11 match the plan doc; PR12 = 128 = 123 + `344bfcf` plan commit + 4 follow-ups).
- Last branch head == HEAD (`08fa6f3`); every commit in `18f6463..HEAD` is inside
  `stack/pr-12`.
- Leftover commits: 0.
- Full SHAs: see `git rev-parse stack/pr-NN`; short SHAs above are unambiguous
  (`git rev-parse --verify <short>` resolves to the full SHA).
