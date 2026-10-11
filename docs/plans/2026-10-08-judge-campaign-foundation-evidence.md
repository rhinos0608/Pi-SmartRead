# Judge Campaign Foundation Evidence (Offline Closure, 2026-10-08)

**Document ID:** `docs/plans/2026-10-08-judge-campaign-foundation-evidence.md`
**Date:** 2026-10-08
**Status:** Evidence foundation only — documentation, not a benchmark effect
**Scope:** OFFLINE ONLY. No TS/test edits in this stage, no paid calls, no
statistical runner, no probes, no holdout access, no auth reads, no commits,
no children. This document closes the evidence trail left by the prior
runtime stage (9 untracked modules/docs/tests preserved as-is) so a future
scored stage can proceed from verified facts.

**Verdict: EVIDENCE-FOUNDATION-READY** — every load-bearing check below is
measured against actual bytes/code, with the ledger arithmetic fitting a
future full attempt inside the owner-approved $2 aggregate. A full scored run
remains a separate future stage requiring owner sign-off and a deterministic
champion selected only after passing runs (never from the probe).

---

## 1. Historical probe artifacts: CONTENT-ONLY-VERIFIED (never BYTE-VERIFIED)

The two original 2026-10-07 probe JSON files and their sidecars still exist at
their saved paths, mode `0600`, and were not modified during THIS review
(sizes/modes re-`stat`ed 2026-10-08; secret scan counts only). No
capture-time byte digest exists, so equality with the 2026-10-07 capture-time
bytes is unverifiable — the proof below is CONTENT-ONLY under the exact
original algorithm, never byte equality:

- `…/T/judge-model-comparison-2026-10-07T17-30-25-596Z.json` (3724 B) + `.sha256`
- `…/T/judge-model-comparison-2026-10-07T17-30-33-052Z.json` (3719 B) + `.sha256`

Reconstructed OLD hash algorithm (from the actual code-writing transcript and
`verifyLegacyCanonicalSidecar` in `scripts/eval/judge/model-comparison-budget.ts`,
targeted read only — no full dump, no auth material touched):

```
sidecarDigest = SHA256( JSON.stringify( JSON.parse(fileBytes) ) )   # compact canonical
```

Measured 2026-10-08 (hash tokens only, file contents never printed):

| Run artifact | Sidecar token (prefix) | Canonical digest | Byte digest | Sidecar == canonical? |
| :--- | :--- | :--- | :--- | :---: |
| `…25-596Z.json` | `e73f5de5…` | `e73f5de56501be808fceb59059e6dca7debabf2350126b7cfdf3b0cdec69f6a2` | `d0416423a1264a0a8ac3c2bf7f4ecf55af6b0cb72b017fd8da3b168c55505af5` | YES |
| `…33-052Z.json` | `0bb01ec4…` | `0bb01ec4c83fe69ee941ca9f5d5bb7d0cef6e91c9a59d7759e42d82657439bf3` | `638f18ab1752b964e25398991ccd8a1a42f62cce507dc4c3e1348df568f7b65a` | YES |

Both digests match the values already pinned in
`test/unit/judge/model-comparison-budget.test.ts:117-118`. Because the sidecar
equals the compact-canonical digest and NOT the file-byte digest
(`canonical != bytes` in both cases), the legacy projection is
**CONTENT-ONLY-VERIFIED under the exact original algorithm** — it is NEVER
`original BYTE-VERIFIED`, and no such claim is made. The stale-sidecar report
in the cost-probe doc therefore stands as stated; no field-subset guessing was
performed to force a byte match, and none is authorised.

Preservation proof (THIS review only): sizes/modes above re-`stat`ed 2026-10-08 (both `0600`,
not rewritten during this review); secret scan over both JSON files and both sidecars returns
**0** `bearer`/`sk-or`/`api_key`/`authorization` hits (counts only, no
content reproduced). A synthetic unit test is NOT verification of these
historical files — the verification above is against the actual original
bytes, which were never rewritten.

Per-run measured totals (targeted fields only): each run `httpAttempts: 3`,
`totalInputTokens: 2143`, `costComplete: true`, `validCoverage:
{judged: 6, unjudged: 0}`, `totalCostUsd: 0.000127738`. Aggregate seed:
**6 calls / $0.000255476** (`2 × 0.000127738`), already on the campaign
books — no reset, no re-recorded paid calls. (The protocol/cost-probe docs
round these to `$0.00012774`/`$0.00025548`; the exact ledger seed is
`0.000255476` per `VERIFIED_PRIOR_SEED`.)

Per-model served identities and sample-of-one scores (wire/billing facts,
not quality claims — server-side noise ±0.04 observed on Jev):

| Model | Served snapshot | Provider | p(u0) run1/run2 | p(u1) run1/run2 | Latency run1/run2 |
| :--- | :--- | :--- | ---: | ---: | ---: |
| `~typesafe/jev-latest` | `typesafe/jev-1.13-20260917` | TypeSafe | 0.97 / 0.97 | 0.10 / 0.09 | 975 / 704 ms |
| `perplexity/pplx-decider-v1-27b` | `perplexity/pplx-decider-v1-27b-20261001` | Perplexity | 0.9973 / 0.9973 | 0.0671 / 0.0671 | 704 / 1017 ms |
| `openai/gpt-6-luna-decisions` | `openai/gpt-6-luna-decisions-20261006` | OpenAI | 1.0 / 1.0 | 0.0 / 0.0 | 924 / 609 ms |

Auth hygiene: both runs resolved via the Pi SDK `AuthStorage` OpenRouter
credential (`authSource: pi-auth-store:openrouter`); no explicit key env was
set, no raw auth JSON was read, no credential string appears in either
artifact (see secret scan above). The SDK credential was never read and no
transcript secret was logged.

---

## 2. Corpus counts re-verified from fixture bytes (offline)

Computed 2026-10-08 directly from
`~/.cache/pi-smartread-judge-spike/eval/set-{a,b}.jsonl` (spent DEV, D46):

- `fixtureSha = SHA256(bytes(set-a) ∥ bytes(set-b))` =
  `2e9fa4117b7003e50581ec1c32d2b17c9c211b655bd9a9002a47961f2b871f9b`
- **314 units in 44 query groups**: set-a 159 rows / 22 queries, set-b 155 rows / 22 queries
- Labels: **78 gold, 148 hard_negative, 88 easy_negative**
- Source materialisation pinned to code ref `18f6463caa78e6657b1af6c7eb86b711bc2364f8`
  (same `git show` path as the scored runner)

---

## 3. Actual OFFLINE packing over ALL 44 groups (no hand-coded assumptions)

Derived 2026-10-08 via the NEW module's **actual exports** (inspected before
calling — `COMPARISON_MODELS`, `PLAN_SOURCE_REF`, `PLAN_MAX_REPLICATES`,
`PLAN_CLIENT_ATTEMPTS_PER_REQUEST`, `PLAN_PACKING_SDK`,
`PLAN_QUESTION_BUILDER`, `PLAN_SERVED_PINS`): `deriveFullRunPlan({ repoRoot })`
exercised the real `CloudJudge.judgeNouls` batching over the ~24k-token
budget across all 44 groups plus the scored-runner-mirror warmup, for exactly
the 3 requested models, with a capturing stub fetch returning constant
`p = 0.01` (explicitly NOT performance gold — no fixture score consulted, no
quality metric computed). **No network, no global-`fetch` fallthrough**
(stub injected as `fetchFn`; a throwing `sleepFn` proves zero retries), no
fixture gold on the wire, no paid calls. The scratch driver lived at
`/tmp/derive-plan.mts` (outside hashed `src`, removed after use); no new
runner was authored into the repo.

Measured plan (not the `estimateFullRun` heuristic):

- Single-run wire requests: **135 = 3 warmup + 132 group** (i.e. 45/arm =
  1 warmup + 44 groups — measured, not assumed; per-group call counts came
  from the packing code, including the 45-call / 3- and 9-attempt bounds)
- Groups requiring oversized split: **none** (`groupsRequiringSplit: []`)
- `maxRequestBytes: 18402`, `maxEstimatedTokensPerRequest: 4601`
  (chars/4 heuristic — an estimation aid, NOT a token bound)
- 5-replicate planned: **675** wire requests; attempt upper bound:
  **2031 = 675 × 3 + 6** historical seed attempts
- 132 wire observations recorded (question/state hashes per group × model)

Out-of-band Gold discipline (probe + plan): wire IDs are neutral (`u0`/`u1`,
as in the scored runner); no `gold`/`hard_negative`/`expected`/`label`
string appears in any payload (unit-tested on captured bodies). Frozen probe
hashes: body+criteria `candidateHash` `627016ae…be09095fd09`, ALL-questions
`criterionHash` `50e398ca…bc02d6d5`, shared `15a6b082…7895fb5794b7`
(re-observed on live captures §1: `cand 627016ae3910`, `crit 50e398ca6958`).

Model token/question bounds (advertised, snapshot 2026-10-07/08 — re-verify
against official model pages before any paid stage): Jev 32k tokens / ≤128
questions, Perplexity 262k / ≤128, Luna ~1.05M / ≤200. The probe enforces its
own stricter ≤3000-estimated-tokens/request pre-check (`over_token_budget`,
no request sent); oversized groups would split per client packing, and none
occur in this corpus (§3 `splits: []`).

---

## 4. Budget ledger: seed, reserves, and fit for a future full attempt

- **Seed (already counted, never reset):** 6 attempts / `$0.000255476`
  (`VERIFIED_PRIOR_SEED`); `seedCampaignLedger` is seed-once — re-seeding an
  existing ledger returns it unchanged, `campaignUsedUsd` monotonic.
- **Per-request reserves** (`maxContext × fixed advertised rate`,
  `requestReserveUsd`): Jev `$0.001344` (32k × $0.042/M), Perplexity
  `$0.01048576` (262144 × $0.040/M), Luna `$0.105` (1050000 × $0.100/M).
  This reserve model deliberately over-bounds the chars/4 heuristic. Output
  cost is NOT modelled (advertised $0.00 on all three arms); any future
  billed output token surfaces as actual-over-reserve and halts the campaign
  via `reserveBreached`.
- **Measured-based full-run extrapolation:** single 3-arm run `$0.0311`,
  5-replicate `$0.1555`, conservative upper (all retries bill full)
  **$0.4664**. Campaign headroom: `$2 − $0.000255476 − $0.47 ≈ $1.53` —
  a future full attempt **fits** the estimate with margin.
- **Labels, not guarantees:** estimated tokens are NOT actual billing; the
  `$0.466` conservative upper carries NO human-billing guarantee. Reserves
  assume advertised pricing and snapshot service compliance — no absolute
  billing guarantee if the API bills differently. UNKNOWN actuals keep their
  reserve and flip `costComplete: false`; the cost rank then falls back to
  the conservative reservation bound (Gate 4 keep-Jev case).
- **GlobalLedgerPath (verified in current implementation, no TS change
  made):** the ledger root is the FIXED campaign path
  `~/.cache/pi-smartread-judge-campaign/` (`defaultCampaignRoot()`); the CLI
  exposes no campaign-root flag (`--out` moves only the report artifact, not
  the ledger), and admissions always `load → admit → atomic write` against
  that path, so CLI restarts / new `--out` dirs cannot reset
  `campaignUsedUsd`. No `~/.cache/pi-smartread-judge-campaign/` ledger file
  exists in this environment yet (expected — no scored stage has run); the
  seed above is the carried book value. Documented as implemented; any future
  deviation is a BLOCK, not a silent policy change.

Root cause of the previous spend-cap test change (valid test change, recorded
so it is not re-litigated): the ORIGINAL fake Jev actual (`$0.009`) exceeds
the Jev full-window reserve (`32000 × 0.042/1M = $0.001344`), so admission
correctly rejects it — the test fixture was unadmittable, not the ledger
wrong. The UPDATED test values (Jev `$0.0012`, Perplexity `$0.009`) sit
inside campaign bounds. The legacy per-probe soft cap (`$0.01`, overshoot
`$0.0102`) remains a per-probe soft cap — NOT a promised strict stage cap;
the USER hard aggregate (`$2`) is enforced globally before every fetch, and
new campaign admission errors **rethrow** instead of returning a misleading
`aborted` record. No assumption is made that real billing always matches one
sample.

---

## 5. Frozen gates and campaign rules (unchanged, no post-hoc relaxation)

Original preregistered gates stand as written in the protocol doc; the
per-replica / availability machinery already in plan/types is included ONLY
where it does not relax them — where semantics were unresolved, they are
reported unresolved, not chosen post-hoc:

- **Recall veto:** paired ΔRecall 95% lower bound ≥ −0.02 AND net FN ≤ 1
  (query-cluster bootstrap, 2000 resamples at `qid` level)
- **Operational veto:** availability ≥ 99.5%, unjudged (`bad_response` /
  timeout / drop) ≤ 1 item; missing `usage.cost` leaves `costComplete: false`
- **Non-inferiority:** ΔAUROC lower ≥ −0.02, Δhard-neg-precision lower ≥
  −0.03, ΔBrier upper ≤ +0.02, utility loss ℒ = 6·FN + FP ≤ ℒ_Jev
- **Calibration/shape:** AUROC (exact tie-handling), Brier, ECE (10
  equal-width bins), query-cluster CIs; cost/latency/ECE only break ties
  between passers (Gate 4: lowest measured cost/1k judgments → lowest p95 →
  lowest ECE)
- **Preconditions for ANY scored run:** deterministic champion selection
  must already be preregistered (it is — Gate 4, §4.2.4); judge mode stays
  `off` (E18 frozen retrieval matrix untouched); the 3-sample probe is
  wire/billing/identity evidence ONLY and never selects a default.

---

## 6. Environment provenance for this closure

macOS 26.6.2, Node v25.9.0, npm 11.12.1, repo HEAD `5e68459`
(`feat/judge-decider-benchmark`), worktree
`/Users/rhinesharar/Pi-SmartRead-judges`, `git diff --check` exit 0, no
staged files. Prior stage: 19 + 13 focused tests / typecheck exit 0 (not
re-run here per the no-reassurance-repeat rule — code is byte-observed
unchanged since). No paid requests were made or recorded in this stage.

## 7. Offline filesystem-seam closure (2026-10-08 addendum — still NOT benchmark-ready)

Two fail-closed seams in `scripts/eval/judge/model-comparison-budget.ts`
were closed with no API/schema/price/default change, verified by two
independent REDs (each new test fails on the pre-fix behaviour, passes
post-fix; canonical normal-root, refunds/UNKNOWN/in-flight/seed-6 and
fixed-global-2 behaviour unchanged):

- **Symlink redirection rejected:** the leaf (root/ledger/output/artifact
  path, when it exists) must not be a symlink, and the nearest existing
  ancestor of every created path must itself be a genuine directory:
  everything created below it cannot be redirected through an adversary
  link, while stable platform aliases above it (macOS `/var`→`/private/var`)
  are not judged — sibling suites keep their non-canonical ephemeral roots.
  `/parent-link/campaign` throws with zero link-target mutation, and only
  the ledger root itself is chmodded (0700); unrelated parents untouched.
  Fixture roots still use canonical `realpath`. POSIX-only fail-closed
  remains explicit; no claims against a malicious same-UID owner moving
  private state.
- **Directory-fsync failure propagates:** `writeLedgerAtomic` no longer
  swallows directory open/fsync errors. Failure throws BEFORE any fetch is
  sent (no attemptId escapes, no wire, no misleading successful admission);
  the already-renamed ledger is retained conservatively so the reserve
  stays on the books, and lock cleanup releases only the holder's own
  nonce. `openSync(path, "r")` / `fsyncSync(fd)` signatures are stable
  Node20 APIs (unchanged since Node 0.x; typecheck-clean).

No scored execution, no statistical result, and no winner finding follow
from this closure — benchmark readiness is NOT marked.

## 8. Settlement/ancestry final correction (2026-10-08 addendum — still NOT benchmark-ready)

Two fail-loud seams in `scripts/eval/judge/model-comparison.ts` plus the
ancestry-gap parent-confirm in `model-comparison-budget.ts` were closed with
no API/schema/price/default/output-flag change, verified by three
independent REDs (each new test fails on the pre-fix behaviour, passes
post-fix; the 6-seed / $0.000255476 / known-refunds / UNKNOWN reserves /
full-reserve / cross-proc-lock / $2-cap behaviour unchanged):

- **Exactly-one settlement with ORIGINAL error identity:** the settle handle
  is now marked attempted BEFORE the ledger write and cleared only on
  success, and every settlement I/O throw rides the existing `campaignHalt`
  channel. A post-rename directory EIO (ledger already persisted: known
  actual retained, `inFlight 0 / settled 1`) and a pre-persistence rename
  EIO (nothing persisted: original reserve retained `inFlight 1`) both halt
  loudly with the ORIGINAL error — no second UNKNOWN settlement (which threw
  `Cannot settle without…` and masked it), no next model/fetch, and
  financial I/O is never converted into a per-model network result.
- **ALL-ancestor symlink rejection:** `rejectRedirectedBase` now walks every
  existing ancestor to the filesystem root (missing components skipped, walk
  continues above them) instead of stopping at the nearest existing parent.
  `/evil-link/real-dir/campaign` (nearest parent regular, higher link) is
  refused with zero link-target mutation. Stable platform aliases
  (macOS `/var`→`/private/var`) are canonicalized once at the CALLER
  boundary (`realpathSync(tmpdir())` for ephemeral/probe/sidecar roots;
  budget fixtures already canonical) and never judged as adversary links.
  The fixed global root still derives from the TRUSTED home base with no
  output overrides and no cap bypass. POSIX-only fail-closed remains
explicit; no claims against an active same-UID mover.

Node20 official `fs` docs vs APIs: `openSync`/`fsyncSync`/`renameSync` /
`lstatSync` / `isSymbolicLink` / `isDirectory` / `realpathSync` signatures
stable (typecheck-clean). No source/API/deps/commits/auth/raw-data/model
substitution. Small 2-function behavior change + regressions; no new
framework. Untracked `decider-protocol.md` untouched (whitespace-only
allowance unused — zero bytes changed). No existing global state required
migration (`~/.cache/pi-smartread-judge-campaign/` still absent — no user
durable data mutated). No scored run; benchmark readiness is NOT marked.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Docs-only change: new evidence doc + max one precision footnote; zero TS/test edits (git status shows 9 pre-existing untracked runtime files untouched)"
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "Sidecar==canonical both artifacts (e73f5de5…/0bb01ec4…), bytes d0416423…/638f18ab…, 0600 preserved, 0 secret hits; corpus 314/44 + fixtureSha 2e9fa411…; offline packing 135/675/2031 via actual deriveFullRunPlan exports; seed 6/$0.000255476; ledger fit $0.4664<<$2 headroom ~$1.53"
    }
  ],
  "changedFiles": [
    "docs/plans/2026-10-08-judge-campaign-foundation-evidence.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "node targeted hash/secret/corpus verification (no content dump)",
      "result": "passed",
      "summary": "legacy canonical match both runs; byte digests as pinned; 0 secret hits; 314/44/78-148-88; fixtureSha match"
    },
    {
      "command": "npx tsx /tmp/derive-plan.mts (offline, stub fetch, removed after use)",
      "result": "passed",
      "summary": "single 135 (3 warm+132 group), splits none, fiveRep 675, attemptUpper 2031"
    },
    {
      "command": "git diff --check",
      "result": "passed",
      "summary": "exit 0, no staged files"
    }
  ],
  "validationOutput": [
    "PLAN-RESULT single:135 warm:3 groupWire:132 splits:[] maxBytes:18402 maxTok:4601 fiveRep:675 attemptUpper:2031 obs:132",
    "Seed 6 attempts / $0.000255476 (2x $0.000127738); reserves Jev $0.001344 / Pplx $0.01048576 / Luna $0.105; full-run fit $0.4664 upper vs ~$1.53 headroom"
  ],
  "residualRisks": [
    "Legacy sidecars are CONTENT-ONLY-VERIFIED, never BYTE-VERIFIED — byte equality with 2026-10-07 capture-time bytes cannot be proven post-hoc",
    "Advertised pricing snapshot (2026-10-07/08) must be re-verified against official model pages before any paid stage; no absolute billing guarantee",
    "Luna 96.35% 3-day availability and 1.0/0.0 single-pair snapping are open risks for Gate 1/2, not findings",
    "Corpus is spent DEV (D46) — parity proves calibration stability, not fresh generalisation; promotion needs human owner confirmation"
  ],
  "noStagedFiles": true,
  "diffSummary": "New evidence-foundation doc only; no source, test, or config edits",
  "reviewFindings": [
    "no blockers"
  ],
  "manualNotes": "If the cost-probe doc's rounded $0.00025548 is ever reconciled to the exact $0.000255476 seed, do it as a docs-only footnote in a later stage; not done here to keep this diff to one logical concern."
}
```

## Addendum 2026-10-08: caller `--out` tmp-alias normalization (offline, positive compat bug)

Legit documented `--out /tmp/report.json` was rejected on macOS because
`/tmp` is itself a stable OS symlink (`/tmp`→`/private/tmp`) and the
writer's all-ancestor rejection judges every existing ancestor. This is a
positive caller-compat bug, not a root-guard redesign: `budget.ts` writer
guards are UNCHANGED (all-ancestor + leaf-symlink rejection, no new
exceptions, arbitrary nested links never resolved).

- Before: `runModelComparisonProbe` used `resolve(opts.outPath ??
  defaultOutPath())` verbatim, so a literal `/tmp/...` path failed at
  write time with `Refusing symlinked artifact ancestor: /tmp` — after
  outgoing requests had already been sent.
- After: `normalizeCallerOutPath` (in `scripts/eval/judge/model-comparison.ts`)
  rewrites ONLY the two fixed OS-known prefixes — the literal string
  `/tmp` via `realpathSync("/tmp")` and the exact `tmpdir()` value via
  `realpathSync(tmpdir())` — to their canonical targets (Node20
  `tmpdir()`/`realpathSync`; longest-prefix match). The caller path itself
  is never realpath'd, so `/tmp/<evil-parent>/...` (nested hostile link),
  leaf symlinks (even under the OS alias), and arbitrary user alias
  ancestors stay fail-closed. `bindOutPathExclusive` (normalized path +
  leaf/sidecar-exists precheck + caller-side ancestor walk, no files
  created) runs BEFORE any fetch/admission alongside the existing
  duplicate-slug guard, so a bad `--out` fails with zero outgoing
  requests; the writer still owns exclusive 0600 creation + sidecar.
- `--out` remains a plain artifact path (no ledger/root choice); fixed
  global root, 6-attempt seed, and $2 cap unchanged. Library function
  stays injectable with mocked fetch only.
- Regression: 6 new tests in `test/unit/judge/model-comparison.test.ts`
  (literal-`/tmp` positive incl. 0600 + exact-bytes sidecar, canonical
  positive, evil-parent negative, leaf-symlink negative, user-alias
  negative, existing-path refusal with zero fetches and no overwrite).
- Source SHA256 (`scripts/eval/judge/model-comparison.ts`, post-fix):
  `52688f19751db0c0053e81d83f16fe4bb5af3462b997374fdfbc69f95a2b3554`.
