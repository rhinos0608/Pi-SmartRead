# Retrieval freeze manifest (2026-10-08)

Byte-identical copy of 12 frozen files from `Pi-SmartRead-ergonomics`
(dirty, user-owned, never edited) into `Pi-SmartRead-retrieval`
(`feat/retrieval-frozen-matrix` at `5e68459`). Read-backed text
edit/write only; no transfer tool, no shell copy, no commits.

## Base

- Retrieval base commit: `5e6845979ab1caed1e56c9e997f02953ac44f93b`
  ("docs: tool-ergonomics decision log E1-E18")
- Node: `v25.9.0` (CI canonical is Node 20; matrix runs on this host)
- Lock: `package-lock.json` present (md5 prefix `9c0fa6df389ac26c`)
- Relevant config: `pi-smartread.config.json` (embeddings
  `text-embedding-embeddinggemma-300m`, probe/rerank/hyde enabled);
  no `PI_SMARTREAD_GREP_RANK_*` knob overrides set in the environment
  (all rank knobs default; test demote defaults to 0.7).

## Frozen file SHA256 (source == destination, verified after copy)

- `src/scoring.ts`: `cfbe6da4a859ed62ffdf36ee387d312d86b9ab36f40014072e62bb1760a50e97`
- `src/search/grep-cascade.ts`: `15d6a05b29aa8e50d6623684006972f67cf51a17c70d78decfc109c6dde3ed8b`
- `src/search/grep-ranking.ts`: `6ba2e9f2b6ab396962eafd4e946dc3b323e9514457f19100c44071357163ae63`
- `src/search/english-stemmer.ts` (new): `8d487e9f68c1a5a2fdaf7b98148d04cc4bea3421144b6ad6f8d95077e736ddb2`
- `scripts/eval/d46/run.ts`: `56b98c25d4b98ec70dd3193a72577b2b25980b4d8ec013b14d1e0a161118ca39`
- `scripts/eval/d46/schema.ts`: `f81976cb78b259e7091f84f5da9dcf4b77b5e9f4b8aca29ac06e2018bd99ada4`
- `scripts/eval/judge/grep-e2e-contract.ts`: `2d322e3a231edf1cd59a4e074521351d5858e88f4c6944ba2a9e0001f60cbe33`
- `scripts/eval/judge/variant-matrix.ts`: `10e91fada83afde05f684e6a98adba7c4466b7f3fbf05abf6eb4e32c064da905`
- `test/unit/eval/d46-run.test.ts`: `ea9ecd9960ac86a5f6e32b3388cdff6652966e6d31176d8305601a5acc5e8ac1`
- `test/unit/judge/grep-e2e-rank-knobs.test.ts`: `c38ceae2dbde79267bb9e8fe0bac225c3abb998373ebd1953c03e36fde90a4d4`
- `test/unit/search/grep-ranking.test.ts`: `33bd7d1ea3beeb8b8bb572d625e1f2d72b4d0580b178ce62b43bf3dc1816e17c`
- `test/unit/search/grep-stemming.test.ts` (new): `8d2e88afcf36168d71295a79534b370edc20082924998d9d27d9ca0801114ed0`

Source SHAs re-verified unchanged after copy (stable snapshot).
`query-intent.ts` (transitive import, shared classifier) confirmed
identical on both sides by the pre-copy check; untouched.

## Broad engine hash (`hashEngineSources`, existing helper)

- Before tests: `sha256:daf2a76ccb3a679502990209457907622296f57ba0ac64c46de4e2a5e1e4590d:281-files`
- After tests: identical (stable).

## E18 frozen matrix arms (from `2026-10-07-tool-ergonomics-decision-log.md`)

Each arm alone vs a fresh same-engine baseline (judge off, all other
knobs default). No additions or sweeps after results.

- A0 baseline (test demote 0.7)
- A1 C2 filename prefix (`PI_SMARTREAD_GREP_RANK_FILENAME`)
- A2 C4 stemming (`PI_SMARTREAD_GREP_RANK_STEM`)
- A3 C6a BM25 `b=0.5`
- A4 C6b coverage boost
- A5 C6c `b=0.5` + coverage
- A6 C3 stronger demotion `0.5` (single predeclared value)
- A7 C5 stopwords
- A8 interaction challenger C2 + C4 + C6c

Selection sets: fresh cohort (sealed, 112, `--split selection
--cohort-dir`) and internal-44. Gate exactly as E15 (not relaxed):
net success gain >= +2 on the fresh cohort AND net file-hit gain >= +2
on internal-44; <= 1 previously successful query lost per
set/formulation; no net read-ready regression; no increase in absence
false-content or exact_ish losses; no unexpected judge invocation.

## Validation run at freeze

- Narrow tests (4 files, 138 tests): passed.
- `npm run typecheck`: passed.
- `git diff --check`: clean.
- Working tree contains ONLY the 12 frozen source/test files (10 modified, 2 new) PLUS this manifest;
  no unrelated TEB/freezer/product/LSP/inspect/judge-default/hook
  changes. No commits, no staged files.

## A0 handoff (single bounded baseline arm)

From the runner `--help` surface in `scripts/eval/d46/run.ts`
(judge off, all rank knobs at defaults = A0, test demote 0.7):

```sh
cd /Users/rhinesharar/Pi-SmartRead-retrieval
npx tsx scripts/eval/d46/run.ts --split selection --cohort-dir <COHORT_DIR> --config off --replicate 1
```

with no `PI_SMARTREAD_GREP_RANK_*` env vars set. Future fixed matrix:
ALL A0-A8 + baseline recheck under this same frozen hash; source stays
frozen (no writers) while the matrix runs.
