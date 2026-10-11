# Retrieval owned-roots seam (E18 safety gate, 2026-10-08)

Owner: safety-seam worker. Scope: **ownership + receipt plumbing ONLY** —
`scripts/eval/external/grep/{run,repos,multi-swe-bench,swebench-multilingual}.ts`,
`scripts/eval/d46/{run,schema}.ts` (receipt fields only), two new unit
tests, this doc, and a correction appendix on the A0 checkpoint doc. No
`src/` rank knobs, no hash-algorithm change, no shared judge/gold/TEB
changes, no benchmark queries, no holdout/data labels opened, no paid
calls, no commits.

## What changed and why (ce86b303 review findings)

1. D46 `coldStart: {deleted: []}` records only deletion targets, not all
   roots checked or who owns them. A historical 15:53 selection report
   records **eight** deletion paths, so "old reports all empty" was false.
   Fix: reports now carry `coldStart.checkedRoots` (every canonical
   checkout root) + `coldStart.planned` (every planned target) alongside
   `deleted`/`skippedTracked`/`count`, plus canonical `manifest.splitDir`,
   `manifest.reposRoot`, `manifest.reportsDir`. Empty `deleted` alone
   proves nothing; only `checkedRoots` + `planned` bound the claim.
2. External runner paths (repos, snapshots, datasets, reports) derived
   from `homedir()` with no override; a marker mismatch deletes and
   recreates the snapshot; `--offline` did not stop `ensureBareClone`
   from cloning. Fix: `--state-root <dir>`
   (`$PI_SMARTREAD_EXTERNAL_STATE_ROOT`) claims a fresh private root with
   an ownership marker and threads it through EVERY writable path.
3. Internal-44 (`grep-e2e.ts`) mkdtemp + managed cleanup was already
   correct and is **untouched**.

## External owned mode (contract, boundary-first correction)

- `ensureOwnedStateRoot(dir)`: FRESH-CLAIM ONLY. The dir must be newly
  created by the call, or carry existing VALID root-bound provenance.
  Pre-existing directories are NEVER adopted for being empty or UID-ours:
  an existing dir without a valid marker is foreign (`no ownership
  marker`). Symlink roots refused; EVERY existing ancestor (whole chain,
  not just the nearest) is checked for symlinks before any
  mkdir/chmod/open/removal, and paths bind to the PHYSICAL canonical
  root (realpath) — resolve()-only prefixes are not canonical.
- Marker `.smartread-owned-state.json` (`external-grep-v1`, version 1) lives
  at the root, OUTSIDE any snapshot: `{owner, version, canonicalRoot,
  nonce>=16hex, createdAt}`. Exclusive mode-0600 regular non-link file;
  root and managed subdirs mode-0700. A symlinked/non-file marker, owner
  or version mismatch, canonicalRoot mismatch, or short nonce is foreign.
  `repos/ snapshots/ datasets/{swe-bench-multilingual,multi-swe-bench}/
  reports/` subtrees are refused when ANY existing child-or-deeper entry
  is a symlink (checked on every claim, before any write). Narrowed by
  Stage 4 below: symlinks are allowed only as CONTENT inside a completed
  (marker-verified) snapshot; instance-root and unmarked directories keep
  the strict rule.
- `ExternalStatePaths` (`root/reposDir/snapshotsDir/multilingualDir/
  multiSweBenchDir/reportsDir`) is the stable minimal structuredRoot API
  for later D46 reuse (claim BEFORE any materialize/delete).
- Legacy homedir caches are NEVER read or written in owned mode (no
  `cp`/shell copy/fs recreation of sources). Populate once online, then
  `--offline` fails before any network when owned data is missing
  (dataset pages, bare clones).
- Snapshot recreation is REFUSED, never delete-and-recreate: a mismatched
  commit throws `refuses-mismatched-snapshot`, an unmarked non-empty dir
  throws `refuses-unowned-snapshot`, symlinked roots/markers throw — all
  WITHOUT deletion (files retained, ask for a fresh root). Re-creating a
  retained snapshot would require proving exact campaign-created binding
  outside the snapshot dir; that binding does not exist, so refusal is
  the only safe behavior. Every successfully materialized snapshot root
  is recorded canonical in `checkedRoots` even though nothing is deleted.
- Owned mode requires `--manifest <frozen>` (the pilot freeze path writes
  into the legacy manifest cache and is refused with exit 2).
- `run.ts` is import-safe: the campaign lives in exported
  `runExternalGrepCli(argv)` behind the established `invokedAsCli` guard
  (same pattern as `d46/run.ts`); importing the module under vitest/tsx
  parses no argv and starts no corpus/engine/network/dataset/report/cache
  work. Legacy general CLI remains, but a campaign is always
  `--manifest + --state-root + --offline` (offline never remote).
- Report receipt: `state` (mode/stateRoot/ownership/canonical subdirs),
  `inputs` (canonical manifest path, dataset revision, pinned
  `repo@baseCommit` refs), `deletion` (`checkedRoots` for EVERY
  materialized snapshot, `planned: []`, `deleted: []` — the empty lists
  PROVE the no-clean claim only together with `checkedRoots`).

**Parent decision (additive receipts accepted).** The reviewer's second
P1 finding — the legacy report gaining `manifestCanonical` / `state` /
`inputs` / `deletion` fields — is ACCEPTED as additive receipts, and the
contract is narrowed to: legacy materialization result shapes unchanged;
legacy report JSON may gain additive receipt fields; owned-only fields
(`deletion.attempts`) remain owned-only.

**Parent decision (deliberate legacy behavior change).** Legacy
materialization no longer deletes-and-recreates a snapshot whose
`.snapshot-commit` pins a different commit, nor a non-empty snapshot dir
without a marker: it throws `refuses-mismatched-snapshot` /
`refuses-unowned-snapshot` and retains the files (`repos.ts`
`materializeLegacyInstance`). `HEAD` silently `rmSync`ed such dirs; that
deletion without ownership proof was itself a blocking review finding, so
safety supersedes byte-identical legacy behavior. Recovery is manual (use
a fresh `--state-root`, or remove the stale legacy snapshot yourself).

**Noncanonical-pin refusal scope.** In owned mode a noncanonical
`baseCommit` is refused before any `git clone`/git network access and
before any repo or snapshot write. It is NOT ordered before dataset-row
loading (`fetchAllRows`), which is independent of the pin and is a normal
online-mode network operation (offline mode reads cached rows only).

## D46 owned path (no new flags needed — existing controls suffice)

- Selection leg: `--cohort-dir <owned-cohort>` (pins from
  `<cohort>/repos.json` with `reposDir` → owned cloned pinned roots) +
  `--reports-dir <owned-reports>`.
- Dev leg: same shape — assemble an owned bench root
  (`repos.json` + `dev/*.jsonl` + sealed `MANIFEST.sha256.json`) whose
  `reposDir` points at owned checkouts, pass it as the bench root, and
  `--reports-dir` under owned state. No `--repos-root` flag was added;
  add one only if a future arm proves these controls insufficient.
- **Cold start is ownership-gated (blocking-review fix).** Runtime-cache
  deletion happens ONLY when `proveColdStartOwnership` finds the canonical
  checkout root physically contained (`assertPathWithinRoot`, symlink-safe)
  in a state root validated by `ensureOwnedStateRoot` (never reimplemented —
  marker logic stays in `repos.ts`) AND the root carries a `.snapshot-commit`
  completion marker whose content is a canonical sha
  (`assertCanonicalBaseCommit`). Everything else is refused: nothing
  deleted, refusal recorded.
- Deletion has a single site (`deleteOwnedColdStartTargets`): the plan root
  must match the ownership-proven root, only SmartRead runtime-cache
  entries are ever targets (never the repo itself), and each target is
  re-contained and lstat'd (never following the leaf) immediately before
  `rmSync`. A target swapped to a symlink between plan and delete is
  refused, link target untouched.
- Receipt: `coldStart.{checkedRoots, planned, deleted, refused}` — every
  examined root appears in `checkedRoots`, every planned target is recorded
  BEFORE execution, and every refusal is `{root, reason}` naming an examined
  root. Empty `deleted` alone proves nothing; `checkedRoots` + `planned` +
  `refused` together bound the claim.
- Non-owned roots (a developer's checkout, legacy caches): the run stays
  possible with cold-start disabled-and-refused — an explicit
  `coldStart.refused` entry, never a silent deletion. No existing CLI flag
  requires deletion, so no flag path can label warm results as cold; a
  refused root is an explicitly warm run in the receipt. Unresolvable
  checkouts / git failures still fail closed with nothing deleted;
  symlinked cache dirs are refused at plan time, never warmed past; the
  `.snapshot-commit` marker is tolerated as untracked state by the
  clean-tree check (top-level name only) so marked owned checkouts pin
  cleanly — it is provenance, never dirt, never a deletion target.

## Controlled four-leg handoff (future arm, NOT run here)

Preconditions per leg: fresh private `--state-root` (external) or owned
bench/cohort root + owned reports dir (D46); record the engine hash
BEFORE the leg and pair the report with that hash — never with the old
`daf2…` A0 value (source has changed since; see A0 correction appendix).

- Leg 1 — fresh selection cohort (owned `--cohort-dir`, `--config off`):
  receipt must show canonical `splitDir`/`reposRoot`/`reportsDir` and
  full `checkedRoots`/`planned`/`deleted`.
- Leg 2 — internal-44 (`--config off`): managed `mkdtemp` snapshot only;
  no flags needed; disappearance of the temp corpus root is expected
  cleanup, not an ownership signal.
- Leg 3 — D46 dev (owned bench root, `--config off`): same receipt bar
  as leg 1.
- Leg 4 — external frozen dev64 (`--manifest <frozen> --split dev
  --accept-license-review --offline --state-root <fresh-owned>`):
  populate the owned root with one online run first; the offline campaign
  run must fail before any network when owned data is missing. Receipt
  must show `state.mode: "owned"`, canonical inputs, pinned refs, and
  `checkedRoots`/`planned`/`deleted`.

Per-leg log (retained after owned temp cleanup): command, engine hash
before/after, report absolute path + SHA, query counts, judge
invocations = 0, cold `checkedRoots`/`planned`/`deleted`/`skippedTracked`,
exit code, `status=complete` (D46/internal) or 128-outcomes + 0-errors +
0-excluded completeness (external).

## Stage 2 — snapshot archive + materialization receipts (bounded)

Owner: archive-receipt worker. Scope: `repos.ts`
`materializeInstance`/archive/`listFiles` sections plus new focused test
`test/unit/eval/external-snapshot-safety.test.ts`; `run.ts` snapshot
loop/checked-receipt capture only; this section's notes. No
bootstrap/clone-routing rewrite, no test-history discard, no
datasets/manifest-pin verifier/D46/ranking/hash changes.

- Archive authority BEFORE untar: `preflightSnapshotTree(bare, baseCommit)`
  resolves ONE immutable canonical sha (`rev-parse --verify
  <commit>^{commit}`, hex-checked) and validates the FULL recursive tree
  (`ls-tree -z -r -t`, NUL-split so tabs/newlines survive) of that exact
  scope. (Stage 2 rejected 120000 symlinks and 160000/type-commit
  gitlinks outright; Stage 4 below replaced that with the
  validated-support rules — this bullet records the original state.) It
  rejects other
  modes, unsafe components (empty/dot/dotdot/absolute, win32 extras),
  duplicates/prefix collisions, and reserved `.snapshot-commit` names — all
  BEFORE any archive/extract/snapshot write (rejection invokes no tar and
  creates no snapshot). Pure `validateSnapshotTreeRecords` is unit-tested
  over raw metadata for shapes real git cannot produce (duplicates,
  prefixes, bad modes).
- `git archive` runs ONLY the preflighted sha under a no-network env
  (`GIT_TERMINAL_PROMPT=0`, `GIT_ALLOW_PROTOCOL=none` — a sentinel no real
  transport matches, behaving as `protocol.allow=never` so every transport
  (including a reachable local promisor) is blocked version-independently —
  `GIT_SSH_COMMAND=false`, plus `GIT_NO_LAZY_FETCH=1` when git >= 2.44;
  no HOME/auth-store overrides) so partial-clone lazy fetch fails loudly
  without touching the network.
- Post-extract `assertSafeExtractedTree` rechecks every descendant with
  lstat (never stat): only regular files/dirs survive; the completion
  marker is written exclusive (`wx`, mode 0600) ONLY after a fully
  validated extraction, never on an incomplete phase. `listFiles` likewise
  uses lstat and refuses links/non-regular entries instead of walking
  through them. (Stage 4 supersedes the link clauses: validated in-tree
  symlinks survive postcheck, and listing never walks through them.)
- Nothing pre-existing is ever deleted: the old `rmSync` of an existing
  (even empty unmarked) snapshot is gone; an empty unmarked dir is reused
  as-is, a non-empty one is refused with files retained.
- Every owned attempt returns a `MaterializeResult` receipt
  (`{root, createdFresh}` | `{excluded, reason, missing, root,
  createdFresh}` | `{failed, root, createdFresh, completedStage, error}`)
  covering preflight/archive/extract/postcheck/marker/gold-exclusion and
  temp-cleanup failures. Refusals of foreign/mismatched state still throw
  (never adopted). Staging-temp cleanup is recorded separately and never
  masks the primary error. `run.ts` records EVERY returned root
  (canonical, realpath-with-fallback) in `checkedRoots` before any
gold-dependent step — no success-only omission — and carries
  root/creation/stage into the `excluded` entries.
- Verification: new 15-test suite (synthetic owned local git fixtures
  only) + existing owned/import-safe suites (38 tests) + `npm run
  typecheck` + `git diff --check`. `external-grep.test.ts:475–510` legacy
  fixture NOT run (out of scope).
- Still open (NOT claimed here): D46 / resource-cold receipts, full
  source freeze, A0 — foundation remains BLOCKED pending those reviews
  and the metadata-only feasibility gate on later approved owned clones
  (legit links/submodules need explicit handling approval; never drop
  cases or patch pins — links/submodules approval RESOLVED by Stage 4
  below). **Dataset-failure receipts and manifest-pin
  binding are DONE** — see "Stage 3" below.

## Stage 3 — dataset-failure receipts + frozen-pin binding (done)

Owner: bounded worker. Scope: `run.ts` dataset/selection/receipt logic,
new tests in `external-grep.test.ts` and `external-snapshot-safety.test.ts`,
this section. `repos.ts` untouched (the empty-unmarked-dir reuse fix is
regression-tested, not re-edited).

- **Legacy inode regression** (`external-grep.test.ts`, temp HOME):
  a pre-existing EMPTY unmarked legacy snapshot dir is reused in place —
  `statSync(...).ino` is identical before/after `materializeInstance`, and
  the snapshot ends up populated and `.snapshot-commit`-marked. A
  NON-empty unmarked dir still throws `refuses-unowned-snapshot` with
  its files retained (dir contents unchanged, no marker written).
- **No silent drops (receipts).** Every selected id that disappears
  between manifest selection and materialization gets an explicit
  `excluded` receipt with stage `dataset`: loader skips
  (`no-production-gold`, …), `byId` misses
  (`manifest-id-unresolved`), and pin disagreements
  (`pin-mismatch`). Skips outside the selection keep their historical
  stage-`loader` shape, so non-manifest legacy reports stay identical;
  manifest-mode legacy reports relabel these entries to stage `dataset`
  and no longer double-count a skipped unresolved id (receipt-shape
  change only; materialization unchanged).
- **Owned `datasetFailures` receipt** (top-level, independent of
  `deletion.attempts`; legacy reports carry no such field): entries
  `{dataset, revision, file?, error, instanceIds affected}` where
  `error` is the loader message truncated to 200 chars (these loader
  messages embed no credentials) and `revision` is `"unknown"` exactly
  when the rows behind the receipt never loaded. It indexes load throws
  (`fetchAllRows`, Multi-SWE-bench `ensureDatasetFileCached` /
  `readCachedRows`, per file), conversion failures of selected rows,
  pure `manifest-id-unresolved` misses, and pin disagreements.
  Owned mode records a failed load and continues: affected ids are
  excluded, the report is written, exit 0 (same contract as every other
  exclusion). Legacy keeps the historical fail-loud throw (no report
  exists at that point).
- **Frozen-pin binding (decision).** In `--manifest` mode every
  materialized instance's `repo`/`baseCommit` MUST equal the frozen
  manifest entry; a disagreeing dataset row is excluded with reason
  `pin-mismatch` (stage `dataset`) recording BOTH values (`pinned` and
  `row`) BEFORE any clone or materialize — neither value is ever
  silently used. `inputs.pinnedRefs` is now sourced from the frozen
  entries, not the rows. The gate applies to ALL `--manifest` runs,
  legacy included: task-3 states the MUST for `--manifest` mode
  without a mode qualifier, mirroring the documented "safety supersedes
  byte-identical legacy behavior" precedent above; `repos.ts`
  `materializeLegacyInstance` behavior itself is untouched.
- **Verification:** new tests follow the offline cached-row campaign
  fixtures in `external-snapshot-safety.test.ts` (temp state roots,
  owned receipts: empty-cache load failure → per-loader
  `datasetFailures`; unconvertible selected row → conversion receipt
  with the run revision; pin-mismatch → both values + manifest-sourced
  `pinnedRefs` + empty managed dirs + zero clone/tar calls; matching
  pins still materialize with `datasetFailures: []`). Run:
  `npx vitest run test/unit/eval` (18 files / 326 tests),
  `npx eslint scripts/eval/external/grep/run.ts scripts/eval/external/grep/repos.ts`
  (0 errors), `npm run typecheck`, `git diff --check`.

## Verification here

- `npm run typecheck` clean.
- `test/unit/eval/external-owned-state-root.test.ts` (own temp dirs;
  canonical realpath fixture bases sidestepping the /var OS alias; fresh
  child claims only; empty pre-existing dirs refused; higher ancestor
  aliases refused; child AND deeper symlinks refused under every managed
  dir; symlinked ownership/snapshot markers refused; mismatched snapshot
  commits refused with files AND marker retained; normal owned root
  succeeds; offline cannot network; in-process offline campaign writes a
  complete no-clean receipt with `planned: [] deleted: []`).
- `test/unit/eval/external-run-import-safe.test.ts` (importing run.ts
  parses/starts nothing; isolated subprocess sentinel with temp HOME and
  wrapper argv proves zero filesystem effects and no legacy interaction).
- `npm run typecheck` clean.
- `test/unit/eval/d46-owned-cold-receipt.test.ts` (8 tests: canonical
  roots/planned recorded; unresolvable checkout is an error, not a cold
  proof; git-failure fail-closed; symlink refusal).
- Existing suites still pass: `external-grep`, `external-grep-run-args`,
  `d46-run`, `d46-schema` (125 tests).
- No benchmark queries run; no original caches/sources removed. One
  incident disclosed: early test drafts imported `run.ts` directly, whose
  top-level runner executed five pilot runs into the legacy cache; the
  five campaign-created pilot reports were deleted (only those files),
  snapshots/datasets/frozen manifests otherwise untouched — see
  manualNotes in the acceptance report. Follow-up correction: run.ts now
  exposes runExternalGrepCli() behind an invokedAsCli guard (same pattern
  as d46/run.ts), so module import under vitest/tsx parses no argv and
  starts no work; locked by
  test/unit/eval/external-run-import-safe.test.ts.

## Stage 4 — safe symlinks + gitlink placeholders (owner decision 2026-10-08, done)

Owner decision (option 1): owned-mode snapshots must support the **6
refused dev instances** (5 × `symlink-120000` in facebook/docusaurus and
sveltejs/svelte, 1 × `gitlink-160000` preact benchmarks submodule) while
staying safe and matching legacy `git archive` output — symlinks are kept
as symlinks, a submodule becomes an empty directory — and cases are never
dropped. Evidence for the 6:
`/Users/rhinesharar/.cache/pi-smartread-retrieval-owned-20261008/reports/pin-feasibility-dev.json`
(read-only). Scope: `repos.ts`, `external-snapshot-safety.test.ts`, this
section. `run.ts`, datasets, ranking, hashes, D46 untouched.

### Preflight rules (validateSnapshotTreeRecords / preflightSnapshotTree)

- `preflightSnapshotTree(bare, baseCommit, {offline?})` now returns
  `{canonical, counts}` with `counts = {symlinks, gitlinks}`; every
  post-preflight `MaterializeResult` receipt carries `preflightCounts`
  (absent when preflight itself failed or the snapshot was reused without
  a preflight). A preflight-validation failure therefore has no counts to
  report — it never reaches extraction.
- Each 120000 record's target blob is read via `git cat-file blob <oid>`
  under the SAME network env as `git archive` (`ownedArchiveGitEnv`):
  offline blocks every transport so a blob:none clone missing the blob
  FAILS CLOSED at preflight (`cannot read symlink target blob`, no tar, no
  snapshot); online may lazy-fetch. 64 KiB read bound; target is never
  skipped or substituted.
- A target is accepted only when it is a relative path — no NUL, no
  leading `/`, and on win32 no backslash and no drive/ADS-colon component
  (same win32 component rules as tree paths) — whose LEXICAL resolution
  from the link's directory stays inside the snapshot root, AND whose
  physical chain resolution over the tree records also stays inside:
  components are walked kernel-style (symlink components expand in place,
  rewinding to the link's directory), bounded to 40 expansion hops —
  cycles and excessive depth refuse, and a `..` with nothing left to pop
  refuses even when the raw lexical form looked contained (a traversed
  in-tree link can deepen the path before the pop; pure-lexical checks
  miss this, which is why the physical walk exists).
- 160000/type-commit gitlinks are accepted as **empty-directory
  placeholders**: nothing is recorded to extract, `git archive` emits an
  empty dir for them (verified), and the prefix-collision logic treats the
  gitlink path as a directory position (gitlink paths join the trees/gitlinks
  sets and `dirPaths`, so blobs equal to, above, or below a gitlink
  collide in either record order).
- All other rules unchanged: unsupported modes, unsafe components,
  duplicates/prefix collisions, reserved `.snapshot-commit` names still
  refuse before any archive/extract/snapshot write.

### Post-extract and gold-listing rules (assertSafeExtractedTree / listFiles)

- Shared `extractedLinkDisposition(root, realRoot, full)`: target syntax
  (as above) + LEXICAL containment against the snapshot root; a resolvable
  link must ALSO `realpathSync`-resolve inside `realpath(root)`.
  **Documented decision: dangling in-tree links are allowed** — unresolvable
  (ENOENT/ENOTDIR) links pass iff their lexical target is inside the
  snapshot; any other realpath failure (e.g. ELOOP) fails closed. Links are
  validated but never pushed onto the traversal stack — nothing is ever
  walked through a symlink.
- Owned `listFiles` never follows links. It lists a link path as a leaf
  file entry when legacy `listFilesLegacy` would have listed it as a
  non-directory entry (it resolves to an in-tree file), plus when it is
  dangling — legacy threw ENOENT there, so parity is undefined; owner
  decision allows dangling links and the path genuinely exists at base.
  A link resolving to an in-tree DIRECTORY was walked by legacy *through*
  the link; owned listing refuses to follow, so nothing is listed under
  the link path (documented parity rule — entries under the link's REAL
  path remain listed, which covers all gold of the 6 instances; their gold
  uses real repo paths). Escaping links refuse the whole listing.
- Listing TOCTOU limitation (documented no-claim, mirrors `repos.ts`
  listFiles): the entry loop lstat's each path and the recursion
  reopens it with `readdir`, so every directory walk re-lstats
  immediately AFTER `readdirSync` returns and requires the same dev+ino,
  a directory, and never a symlink — any mismatch discards the
  enumerated names and throws fail-closed. NOT CLAIMED: an active
  same-UID mover racing INSIDE the readdir syscall itself — consistent
  with the POSIX no-claim (lstat-based checks cannot order against a
  mover with our own UID). That race shrinks to the syscall window and
  every swap detected at the verification point fails closed.
- Managed-scan relaxation (required for the decision to function at all):
  `ensureOwnedStateRoot`'s snapshots subtree keeps the strict no-symlink
  rule for direct children (instance roots) and for unmarked directories,
  but symlinks are allowed INSIDE a COMPLETED snapshot — a directory whose
  regular `.snapshot-commit` marker holds a canonical object id — because
  they are legitimate `git archive` content that postcheck/listFiles
  revalidate on every use. Existing refusal tests (symlinked snapshot root,
  `snapshots/evil`, `snapshots/nested/deep-evil` without marker) still
  hold unchanged.
- Legacy paths are untouched: `git archive` invocation, tar invocation,
  `listFilesLegacy`, and `materializeLegacyInstance` behave as before.

### Verification here

- `npx vitest run test/unit/eval` — 18 files / **335 tests pass**. New
  coverage in `external-snapshot-safety.test.ts` (8 added, 2 rewritten):
  in-tree relative symlink accepted and extracted as a symlink (+ counts
  receipt + re-claim passes the marker-gated scan); `../`-escaping link
  refused at preflight (no tar, no snapshot); absolute and NUL targets
  refused; chain-escape-through-another-link refused (raw + materialize);
  cycle refused (raw + materialize); gitlink accepted → empty dir; offline
  missing link blob fails closed at preflight before any tar (promisor
  clone, unreachable origin, blob never hydrated); gold listing parity with
  legacy on a repo containing file + directory symlinks.
- `npx eslint scripts/eval/external/grep/repos.ts scripts/eval/external/grep/run.ts`
  → exit 0 (0 errors; warnings only, matching the repo's warn-level
  guardrails), `npm run typecheck` clean, `git diff --check` clean.
- **Feasibility re-run (preflight only) of the 6 refused instances against
  the existing owned state root** (read-only clone reuse, throwaway tsx
  script under mkdtemp, online lazy fetch of link blobs allowed):
  `facebook__docusaurus-8927` ok (symlinks 2), `facebook__docusaurus-9183`
  ok (symlinks 2), `preactjs__preact-4436` ok (gitlinks 1),
  `sveltejs__svelte-10259` ok (symlinks 1), `sveltejs__svelte-9550` ok
  (symlinks 1), `sveltejs__svelte-9962` ok (symlinks 1) — **ok=6,
  refused=0** (was ok=58, refused=6).
- Not run here (out of scope): a full materialized external campaign over
  the 6; `run.ts` does not yet surface `preflightCounts` in report receipts
  (the counts are on every `MaterializeResult`; adding a report field is a
  separate `run.ts` change).

## Parent decision (2026-10-08): verified dataset seeding

The "no `cp`/shell copy/fs recreation of sources" clause above targets
SOURCE recreation — repos and snapshots, which must come from git and
never from shell copies. Frozen dataset INPUT files are a different
category: when running fully offline, those files may be provisioned
into an owned state root by verified copy from the existing legacy
caches if byte-identity to the frozen manifest is PROVEN first (per-file
sha256/rows tokens and the aggregate multilingual `datasetRevision`
compared against the manifest's embedded `datasets` revisions,
all-or-nothing, re-verified after copy through the runner's own read
APIs) and every copied file is recorded in a provenance receipt
(`<state-root>/reports/dataset-seed-receipt.json`, mode 600). This is
data-input provisioning only; it is not warm/cold labeling and touches
nothing in the legacy caches (read-only), and snapshots/repos remain
git-sourced. Decision reference: parent, 2026-10-08, option A.

## Parent decision (2026-10-08): git hydration of owned clones

The same distinction applies to repo OBJECTS: hydrating an owned bare
clone from a legacy bare clone by local `git fetch` is the git-native
offline path (objects arrive by content address, verified by git), as
opposed to shell-copying repos/snapshots. Approved by the parent (the
hydration question's option A, 2026-10-08) with a mandatory receipt.
Measured outcome of this attempt: hydration FAILED — all seven legacy
sources are themselves promisor (`blob:none`) clones, upload-pack
refuses lazy-fetch, refspec fetch transferred no new blobs, and 0/64
dev pins could archive offline from the owned clones afterwards; full
per-repo fetch/fsck/mtime and per-pin archive results are recorded in
`<state-root>/reports/git-hydration-receipt.json` (mode 600). Legacy
mtimes were unchanged (read-only proof). Consequence: offline owned
materialization requires a populated (online) owned root first; this
task ran offline, so external leg 4 fails closed at the archive stage
by design.

