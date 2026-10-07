# D46 held-out evaluation set: authoring protocol

Owner: evaluation lane. Authority: D46 (methodology) + D55 (construction start,
gold-isolation rule, dev repos). Read both rows fully before authoring.

## Splits and quotas

- **Holdout:** 210 queries = 7 classes x 30, over 8 repos, near-balanced
  (each class spread across repos, not clustered on one or two).
- **Dev:** 56 queries = 7 classes x 8, over 2 repos (hono, commander.js).
- Classes: `behaviour`, `architecture`, `configuration`, `error_retry`,
  `multi_file`, `exact_ish`, `absence`.
- Tune only on set-a/b, external dev64, and dev56. Freeze everything
  (thresholds, routing, prompts, units/cap, ranking, model/version, budgets,
  gold protocol, metrics) before opening either holdout once, no retuning.

## Repo pins

Clones live at `~/.cache/pi-smartread-bench/d46/repos/<owner>__<name>`;
pins (sha, licence, corpus root) in `~/.cache/pi-smartread-bench/d46/repos.json`
(mode 0600). All licences rechecked at the pinned commit: 9x MIT,
TypeScript Apache-2.0. No exclusions were needed: none of the 10 repos
appears in the frozen external manifest
(`external-grep-dev64-holdout32.json` pilot/dev/holdout names).

microsoft/TypeScript is pinned to tag `v5.9.2` (commit `5be3346`;
HEAD has since moved to the Go port, which would silently put a Go
corpus into a JS/TS set). The corpus is restricted to `src/`
(735 files, 701 `.ts`, no Go; licence `LICENSE.txt` Apache-2.0 at
that commit). Gold paths are relative to the corpus root.

## Gold-isolation rule (D55, binding on authors and labellers)

- Allowed: file reads, plain `rg` / `git grep`, LSP-free source reading.
- Forbidden: SmartRead `grep` / `inspect` / `find`, any judge, and any
  system run on a holdout repo before the freeze. This is the one
  sanctioned exception to the "use grep, not rg" tooling preference.
- Rationale: no system output may leak into gold. Queries and gold spans
  are authored from source **before any system output**.

## Authoring steps (per repo)

1. Check out the pinned sha; confirm `git rev-parse HEAD` matches `repos.json`.
2. Draft queries per class from source reading only. Write the query a
   user would plausibly ask, not a paraphrase of a symbol name.
3. Record gold as `{path, startLine, endLine, grade}` spans (grade 1 =
   primary evidence, 2 = supporting). Paths are relative to the corpus
   root at the pinned commit.
4. `exact_ish`: set `exactForm` (`literal` | `regex` | `identifier`).
   These measure routing/search; an unexpected judge invocation on one
   is a routing failure.
5. `absence`: leave `gold` empty and record `absenceEvidence`
   (searches run + synonyms checked). Absence must be verified
   exhaustively; report it as "verified absence under this scope".
6. Fill `rationale`, `author`, `authoredAt` (UTC ISO-8601) for every query.
7. Run the validator (structure, class quotas, unique ids, required
   fields, path containment, paths-at-commit, line ranges):
   `npx tsx scripts/eval/d46/validate.ts --split dev|holdout`
   (add `--repo <owner__name>` to check one repo; skips the quota).
   Paths must be relative to the corpus root: absolute paths, any
   `..` segment, and symlink escapes are rejected. Failures print to
   stderr with exit 2.
8. Store dev/holdout files ONLY under
   `~/.cache/pi-smartread-bench/d46/{dev,holdout}/` (mode 0600), never
   in the repo. Seal with
   `npx tsx scripts/eval/d46/validate.ts --split dev|holdout --seal`,
   which writes `MANIFEST.sha256.json` (0600) after a green validation.
   The manifest's `files` section seals per-query-file sha256 plus
   query counts per class/repo and repo pins; its `artifacts` section
   seals every other artifact in the split dir by sha256 with role
   labels, excluding the manifest itself: query JSONL (`queries`),
   `second-label-<repo>.json` (`second-label-sample`), second-labels
   JSONL (`second-labels`), `adjudication.jsonl` and per-repo
   `adjudication-<repo>.jsonl` / `adjudication-<repo>-rest.jsonl`
   (`adjudication`), `.pre-adjudication` copies including
   `<repo>.jsonl.pre-adjudication-rest` (`pre-adjudication`), and any
   other file (`other`, still hashed). A query file is exactly
   `<owner>__<name>.jsonl` for a repo pinned in `repos.json` for that
   split; a stray `.jsonl` matching no pinned repo is a validation
   error, not silently ignored. Validation parses
   only query JSONL; second-label/adjudication/pre-adjudication files
   are matched by name and never parsed as queries.
9. Draw the second-label sample with
    `npx tsx scripts/eval/d46/sample-second-label.ts --split dev|holdout --seed <n> [--repo <owner__name>]`:
   deterministically selects 25% of answerable queries per repo
   (rounded up) plus ALL absence queries and writes the id list
   (without gold) per repo to `second-label-<owner>__<name>.json`
   (0600). Re-running with the same seed reuses the existing files
   untouched; a different seed rewrites them. Record the seed with
   the second-label files.

## Double-labelling and adjudication

- Independent second labels for 25% of positives (seeded random sample,
  seed recorded in the manifest) plus ALL absence queries.
- Second labellers follow the same gold-isolation rule and work blind
  to the first labels.
- Disagreements go to adjudication by a third reader; the adjudicated
  label is final and the disagreement rate per class is reported as
  label-noise evidence.
- Second labels and adjudication records are sealed alongside the
  queries (same directory, same 0600, covered by the hash manifest).

## Freeze checklist (D53 protocol + margin)

1. D42 exists threshold finished and dev-tuned before the freeze.
2. Threshold(s), routing, prompts, units/cap, ranking, model/version,
   budgets, gold protocol, and metrics all frozen and recorded.
3. Validator green on both splits: quotas, unique ids, paths at pinned
   commits, line ranges, sealed sha256 manifest written.
4. `findRepoQueryFiles` clean on the repo tree (enforced by
   `test/unit/eval/d46-schema.test.ts`).
5. Judge-off cohorts must reproduce exactly per engine/fixture; D41's
   exact "≤1 previously-successful loss" veto stays for judge-off.
6. Judge-on cohorts: 5 independent cache-disabled replicates per arm,
   interleaved balanced order, per-unit scores retained; noninferiority
   iff the 95% lower bound of the paired mean difference in file-hit@5
   and read-ready@5 exceeds −2/35.
7. Open each holdout once. A miss is *inconclusive*, never retuned.
