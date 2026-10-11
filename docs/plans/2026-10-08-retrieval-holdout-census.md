# Retrieval holdout census (E15)

Census of the eligible pool for the sealed instance-disjoint retrieval
holdout. No freezing was performed: this step only measures the pool.
Owner: the E15 freezer worker. Freezer:
`scripts/eval/external/grep/freeze-instance-holdout.ts` (census is the
default action; `--run-freeze` seals and is NOT run here).
Blacklist: `scripts/eval/external/grep/exposure-blacklist.ts`.

Command (read-only, offline, writes nothing):

```sh
npx tsx scripts/eval/external/grep/freeze-instance-holdout.ts --accept-license-review --offline
```

## Eligible count: 492 titles

| Stage | n |
|---|---|
| Loaded (SWE-bench Multilingual JS/TS + Multi-SWE-bench js/ts, deduped across datasets) | 616 |
| Loader-excluded (missing title/patch/base, no production gold) | 2 |
| Blacklist-excluded (all `blacklist:instance-id`; zero repo/patch hits) | 116 |
| Eligible after blacklist | 500 |
| Missing-at-base (gold absent at base commit, excluded with paths recorded) | 8 |
| Unverifiable offline (missing clone / git error) | 0 |
| **Eligible and verified at base** | **492** |

The pool exceeds the E15 target of ~400 titles, so the full remainder
can be used and no shortfall protocol is needed.

## Blacklist coverage

Built from every historical manifest/report plus all D46 repos:

- 3 manifests in `~/.cache/pi-smartread-bench/manifests/`
  (`external-grep-freeze.json` pilot-12 + provisional dev31,
  `external-grep-dev64-holdout32.json`, superseded `…c884064c.json`) —
  116 unique instance ids, 116 linked-issue keys (`org/repo#number`
  derived from each id, so the same issue under a different dataset id
  is also blocked).
- 48 `reports/external-grep-*.json` reports (outcome instance ids;
  subset of the manifest ids, no new identities).
- 10 D46 repos from `d46/repos.json` — **zero overlap** with the
  external JS/TS repos, so the repo arm is currently a no-op; it is
  still enforced in code for future-proofing.
- Patch-hash arm: no exposed patch bytes are recorded historically, so
  the arm is empty; the freezer records per-entry gold hashes so future
  freezes can dedupe on patch identity.

All 116 exclusions hit on `instance-id` directly; the issue-key arm
fired on zero additional candidates (no cross-dataset renames present).

## Composition of the 492

By repo:

| Repo | n |
|---|---|
| sveltejs/svelte | 252 |
| mui/material-ui | 158 |
| iamkun/dayjs | 45 |
| vuejs/core | 27 |
| anuraghazra/github-readme-stats | 10 |

By language (gold-file extension): js 326, mixed 97, ts 69.

By patch-size bucket (shared `patchSizeBucket`: 0 single-file
single-hunk / 1 small / 2 large): 147 / 166 / 179.

Concentration note: two repos (svelte, mui) hold 83% of the pool, and
genuine TS gold is thin (69 + part of 97 mixed). The freezer's seeded
repo round-robin with TS-first/bucket balancing spreads the 400-head
selection across all five repos; gains confined to one repo remain a
stop condition per E15. The 8 missing-at-base instances are
mui-heavy (7 mui, 1 svelte); the ranked reserve list replaces them in
stratification order.

## Minimum detectable effect at n = 492

Normal approximation n ≈ (1.96+.84)² × d / effect², plus exact
McNemar (two-sided exact binomial p < 0.05) power by seeded simulation
(20k sims, `pairedPowerSimulation` in the freezer):

| Discordance d | MDE (pp) | Power at +7.8pp target |
|---|---|---|
| .078 | 3.5 | ~1.000 |
| .219 | 5.9 | ~0.957 |
| .313 | 7.1 | ~0.858 |

Power at the MDE itself is ~0.78 in all three rows, as expected for a
correctly calibrated approximation. At the E15 target effect (+7.8pp)
power is ≥ 0.86 across the whole discordance range, so n = 492 is
adequately powered without needing the shortfall clause (≈9pp at 300,
≈11pp at 200 do not apply).

## Freezer status (implemented, unit-tested, NOT run)

`freeze-instance-holdout.ts --run-freeze` performs seeded stratified
selection (`selectRetrievalHoldout`: repo round-robin, TS-first, bucket
balance via the shared `rankForSplit`), takes the head as the holdout
and the next-ranked tail (default 80) as the reserve for
missing-at-base replacements, and writes a NEW non-overwriting 0600
v3 manifest with per-entry `querySha256` (title + body bytes),
`goldSha256` (canonical gold JSON derived from the fix patch),
literal `baseCommit`, dataset revisions, and blacklist provenance, plus
a manifest-sha binding check (`bindToManifest`) for the runner and a
single-opening ledger (`recordOpening`, second opening refused).
Unit tests: `test/unit/eval/external-grep-instance-holdout.test.ts`
(24 tests). The real freeze awaits program authorization.
