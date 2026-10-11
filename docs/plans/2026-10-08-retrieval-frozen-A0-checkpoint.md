# Retrieval frozen A0 checkpoint (E18, 2026-10-08)

Owner: A0-checkpoint worker. Scope: **A0 baseline ONLY** — four legs,
sequential, each with its own exit check. No arm knob changes, no A1–A8 runs,
no holdout access, no manifest rewrite, no source/config edits.

## Frozen identity

- Expected engine hash (before AND after EACH leg):
  `sha256:daf2a76ccb3a679502990209457907622296f57ba0ac64c46de4e2a5e1e4590d:281-files`
- Verified pre-leg: `npx tsx -e "import { hashEngineSources } from
  './scripts/eval/judge/grep-e2e-contract.ts';
  console.log(hashEngineSources('<repo>'))"` → matched expected.
- Node v25.9.0 (not the AGENTS.md Node 20 line; recorded, not changed).

## Frozen controls (all four legs)

- `PI_SMARTREAD_GREP_RANK_*` — all six unset (verified via `env | grep`):
  `PI_SMARTREAD_GREP_RANK_TEST_DEMOTE`, `PI_SMARTREAD_GREP_RANK_FILENAME`,
  `PI_SMARTREAD_GREP_RANK_BM25`, `PI_SMARTREAD_GREP_RANK_COVERAGE`,
  `PI_SMARTREAD_GREP_RANK_STOPWORDS`, `PI_SMARTREAD_GREP_RANK_STEM`
  (full list from `src/search/grep-ranking.ts`).
- Judge OFF (`--config off` on D46/internal legs; external leg has no judge
  path), no `PI_SMARTREAD_JUDGE_*` overrides.
- Knobs at default: demote 0.7, k1 1.2, b 0.75, filename/coverage/stopwords/
  stemming off. Ambient `PI_SMARTREAD_EMBEDDING_{BASE_URL,MODEL}` left at
  localhost defaults (same as the guard baseline); offline flags where
  supported. No paid judge/HyDE/embedding/rerank calls.
- HOME / `~/.pi` / runtime source context unchanged.

## Cold-start safety (measured, not assumed)

- Old A0-equivalent D46 reports all record `coldStart: {deleted: [],
  skippedTracked: [], count: 0}` — prior cold runs deleted nothing.
- Fresh-cohort pinned checkouts contain no `.pi*` runtime-cache dirs
  (`find ... -maxdepth 2 -name ".pi*"` → empty), so the runner's
  cold-start walk is a proven no-op there too.
- Original TEB clones never touched; new reports/caches land in owned
  guard paths (`~/.cache/pi-smartread-bench/reports`,
  `~/.cache/pi-smartread-judge-spike/bench/grep-e2e/`). No shell `cp` of
  fixtures, no gitignore masking, no fake warm/cold.

## Leg commands (from actual `--help`/source, run from repo root)

Leg 1 — A0 fresh selection cohort, 112 queries (96 positive + 16 absence):
`npx tsx scripts/eval/d46/run.ts --split selection --cohort-dir /Users/rhinesharar/.cache/pi-smartread-bench/fresh-cohort --config off --replicate 1`

Leg 2 — A0 internal-44 (35 positive file-hits + 9 negatives), judge off:
`npx tsx scripts/eval/judge/grep-e2e.ts --config off`

Leg 3 — A0 D46 dev (24x2), judge off:
`npx tsx scripts/eval/d46/run.ts --split dev --config off --replicate 1`

Leg 4 — A0 external frozen dev64, titles + bodies (64x2 = 128):
`M=/Users/rhinesharar/.cache/pi-smartread-bench/manifests/external-grep-dev64-holdout32.json`
`npx tsx scripts/eval/external/grep/run.ts --manifest $M --split dev --accept-license-review --offline`

Per-leg log required: hash before/after (must equal expected), command,
report absolute path + SHA, query counts, judge invocations = 0, cold
`deleted`/`skippedTracked`, exit code, `status=complete`.

## Results

(Filled leg by leg; each leg's row is preserved even if a later leg fails.)

- Leg 1 (fresh selection 112): exit 0, `status=complete`, 112/112 queries ok,
  overall success@5 50/96, readReady 24/96, falseEmpty 0, falseContent 16,
  correctAbstention 0/16, unexpectedJudge 0, errors 0.
  Report `/Users/rhinesharar/.cache/pi-smartread-bench/reports/d46-selection-off-2026-10-07T18-53-22-233Z-efcfafc9.json`
  (sha256 `878f9fa5a4a01a9bba66f4b09f871e72f57eb4d08eeb560a55a2e102be99d5f8`).
  Manifest `engineSourceHash` = expected; knobs default
  (demote 0.7, k1 1.2, b 0.75, filename/coverage/stopwords/stem off);
  `coldStart: {deleted: [], skippedTracked: [], count: 0}`; hash before/after
  both = expected.
- Leg 2 (internal-44): exit 0, `status=complete`, 44/44 queries, errors 0,
  fileHit@5 20/35, knownGoldR@5 0.0641 (5/78), declared 5/36, evaluable 5/35,
  renderedTok 2134.1/q, legacyTok 544.6/q, abstCorrect 0/8.
  Report `/Users/rhinesharar/.cache/pi-smartread-judge-spike/bench/grep-e2e/grep-e2e-off-2026-10-07T18-53-38-935Z-p82163.json`
  (sha256 `f3fb5f396547345ca93756bc945c409529922faa8fab7dabc34c9abcffcccee6`).
  Manifest `engineSourceHash` = expected; knobs default; `judgeUsage`
  newlyBilled all 0; hash after = expected.
- Leg 3 (D46 dev 24x2): exit 0, `status=complete`, 56 queries, errors 0,
  success@5 25/48 (C1-fixed level per E16), readReady 8/48, falseEmpty 0,
  falseContent 8, correctAbstention 0/8, unexpectedJudge 0.
  Report `/Users/rhinesharar/.cache/pi-smartread-bench/reports/d46-dev-off-2026-10-07T18-55-23-916Z-9bbd47ca.json`
  (sha256 `7605b1b2e01089656217987fa92f76e443e8b52981fe400bf1caf60cfa1ac9f3`).
  Manifest `engineSourceHash` = expected; knobs default;
  `coldStart: {deleted: [], skippedTracked: [], count: 0}`; hash after = expected.
- Leg 4 (external frozen dev64, 64x2 = 128): exit 0, 128/128 outcomes all `ok`,
  0 errors, excluded []. success@5 36/128 (titles 17/64, bodies 19/64;
  +1 title vs the 35/128 guard baseline, C1-routing level).
  meanRecall@5 0.219, meanMRR 0.163. Judge off. Ranking knobs default.
  `manifestSha256` = `9cfbf8e7...` (frozen dev64 manifest).
  Report `/Users/rhinesharar/.cache/pi-smartread-bench/reports/external-grep-dev-2026-10-07T19-01-16-112Z-3ef2b94e.json`
  (sha256 `4f586a8453d443c0a5e5477661c2c57807f59229b5969c3e60e76886e5ff4e91`).
  Manifest `engineSourceHash` = expected. Hash after leg 4 = expected.
  (This runner emits no top-level `status` field; completeness = 128 outcomes
  + 0 errors + 0 excluded.)

## Verdict

**A0-COMPLETE.** All four legs exited 0 with judge usage 0, default knobs,
and engine hash = expected before/after every leg. Cold-start deleted nothing
on every leg (D46 legs report `deleted: []`; fresh-cohort and external legs
likewise; no foreign cache touched). No source/config edits, no commits, no
A1–A8 runs. Old mixed-source `f533→7af` numbers remain exploratory, not gate
baseline. A0 recheck stands; matrix arms stay frozen for later.

## Correction appendix (2026-10-08 safety seam; history above preserved)

Per the ce86b303 readiness review, the A0 verdict's counts and hash values
stand as measured, but its provenance claims were incomplete and are
corrected here — not by re-running or re-hashing:

- Raw counts/hash valid but provenance-incomplete: per-leg numbers and
  report SHAs above are retained as measured. What they did NOT establish
  is ownership: D46 `deleted: []` records only deletion targets, not all
  roots checked or who owns them.
- Historical selection 15:53 actually deleted 8 paths: the "old reports
  all empty" generalization was false. A report at
  `~/.cache/pi-smartread-bench/reports/d46-selection-off-2026-10-07T15-53-02-211Z-3d2b3c01.json:7–15`
  records eight deletion paths. This does not contradict the later A0
  empty deletion lists; it limits what an empty list proves.
- Empty list != ownership proof: going forward every leg must record ALL
  canonical cold-checked roots and ALL planned targets BEFORE execution
  alongside actual deletions (`checkedRoots`/`planned`/`deleted` — now
  implemented in `scripts/eval/d46/run.ts` and
  `scripts/eval/external/grep/run.ts`). Unproved roots fail closed; a
  cold skip is never warming mislabeled as proof.
- Old `daf2…` A0 cannot baseline future arms: the engine-source tree has
  changed since A0 (retrieval work in progress), so the next campaign arm
  must compute the NEW hash BEFORE pairing and bind reports to it. The
  original 12-match proof above is retained as historical; no rehash
  narrowing is performed here.

## V2 source freeze (2026-10-08)

- Date: 2026-10-08.
- V2 engine hash:
  `sha256:e5fad8375eb02281e2b29ab9b12136d756b9f0a8f03f8ccfe94c95e9ea74ca4e:281-files`
  (replaces the historical `daf2…` value above; V1 numbers stay frozen
  as history).
- File count: 281 covered files — 4 root configs (`package.json`,
  `package-lock.json`, `tsconfig.json`, `pi-smartread.config.json`) +
  234 `src/**/*.ts` + 43 `scripts/eval/**/*.ts`, i.e. tracked plus
  untracked non-ignored sources selected by `isWantedSourceFile`
  (`scripts/eval/judge/grep-e2e-contract.ts`). `test/` and `docs/` are
  not covered.
- Known-set check: `isKnownSourceHash(V2)` = true. The known set is the
  fail-closed predicate `!hash.startsWith("unknown:")` — there is no
  enumerated hash list in the repo, and neither the predicate nor
  `hashEngineSources` was changed for V2.
- All owned-root guards landed: owned roots, D46 ownership,
  symlink/gitlink support, Unicode collision key, receipts, pin binding.
- Proof (throwaway mkdtemp script, `node --import tsx`): computed V2 from
  the live worktree, `isKnownSourceHash(V2) === true`, then ran the real
  `runD46Cli` with NO `engineSourceHash` override over a temp fixture —
  the written report's `manifest.engineSourceHash` recorded the V2 hash
  (PROOF_OK, exit 0).

## Cache-metadata note (2026-10-08)

Cache-metadata note (2026-10-08): legs 1/3 invoke `git status --porcelain`
which refreshes `.git/index` metadata in legacy cohort checkouts; content
integrity verified by `git fsck --connectivity-only` on all six affected
repos (result: exit 0, no diagnostics on all six — fresh-cohort
nestjs__nest, pmndrs__zustand, rollup__rollup, solidjs__solid at
2026-10-08 16:21Z and d46 honojs__hono, tj__commander.js at 16:27Z;
cross-checked with `git status --porcelain` (clean) and a
`core.quotepath=false` `ls-files` vs on-disk existence diff showing 0
missing paths); no files deleted; prior zero-mtime-change claim narrowed
to no content change.
