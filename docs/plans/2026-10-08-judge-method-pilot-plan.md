# Judge method-selection pilot — stage plan (Amendment A1)

**Protocol:** `docs/plans/2026-10-08-judge-decider-protocol.md` §9, *Amendment A1 (2026-10-08, pre-data)*. The amendment contains the binding selector (A1.1), corpus construction rules (A1.2), reference/spent-DEV rules (A1.3), budget rules (A1.4), amendment text (A1.5), and cost table (A1.6). This document records stage ownership, acceptance, the data root, and parent deviations.

**Scope:** harness, fixtures, tests, and protocol only, in `/Users/rhinesharar/Pi-SmartRead-judges`. No product-source (`src/**`) changes, no paid execution, no network, no credential access in planning stages.

## Stage table (A–H)

| Stage / file owner | Deliverable | Acceptance |
|---|---|---|
| **A — budget** (stage-A worker): `model-comparison-budget.ts`, `model-comparison-budget.test.ts` | `$3` cap, explicit `$2` advisory planning target; ledger rules per *Parent deviations* below (no migration tool) | Budget tests; preservation comparison of old/new ledger excluding `capUsd`; crash/idempotency tests; non-$3 persisted ledgers refused |
| **B — corpus tooling** (stage-B worker): new `method-pilot-fixture.ts`, matching test | Dossier validation, pinned materialization, disjointness checks, label gates, sealing | Reject bad ranges, near-duplicate queries, unresolved labels, absent citations, and modified sealed bytes |
| **C — method contract** (stage-C worker): new `method-comparison-contract.ts`, matching test | Method-aware envelopes, unique wire accounting, frozen-DTO projections, derivation binder | Reject forged M2 averages, duplicated costs, cross-method links, missing replicas, incorrect hashes |
| **D — executors** (stage-D worker): new `method-comparison-executor.ts`, matching test | M0/M1/M2 builders and instrumented client execution | M0 byte-equivalent to captured production builder; M1 singleton; reverse order correct; forward reuse; retries separately reserved |
| **E — selector** (stage-E worker): new `method-pilot-selector.ts`, matching test | Exact metric, corrected bootstrap, margin/default/tie rules per A1.1 | Synthetic fixtures covering every selector branch, fixed bootstrap output, threshold equality, missing cells, FN guard |
| **F — pilot runner** (stage-F worker): new `method-pilot.ts`, matching test | Default offline planning; sealed authorized paid mode; immutable report | No-network tests, no auth access offline, admission-before-fetch, UNKNOWN retention, interruption/resume, manifest mismatch refusal |
| **G — confirmation integration** (stage-G worker): new `method-confirmation.ts`, `method-confirmation-stats.ts`, matching tests | Selected method, deployed reference, measured projection, 5→4→3 freeze, revised report binding | Reject pilot-only authorization, score-driven replica changes, arm removal, incomplete corpus; exercise 3/4/5 and reference collapse |
| **H — protocol** (stage-H worker): this protocol amendment; this pilot-plan document | Amendment A1 and this stage scope document | Documentation agrees with the machine-readable selector and budget; explicitly preserves spent-DEV status and holdout quarantine |

**Ownership rule:** no worker edits another owner's files. The corpus author, labeler A, labeler B, and adjudicator each own separate construction artifacts; the fixture integrator alone writes the final fixture and manifest.

**Dependencies:** A/B/C precede paid readiness; D/E can proceed after their contracts settle; F integrates A–E; G follows F; H must be sealed before paid execution.

## Data root

- `~/.cache/pi-smartread-judge-pilot-20261008/` — **task-owned**, created by the parent.
- Contains `PROVENANCE.md` and the `authoring/` area (observed 2026-10-08).
- Pilot construction artifacts (`pilot-queries.jsonl`, `pilot-candidates.jsonl`, `pilot-source-snapshots.jsonl`, `labels-a.jsonl`, `labels-b.jsonl`, `adjudications.jsonl`, `pilot-fixture.jsonl`, `pilot-disjointness.jsonl`, `pilot-manifest.json`, `pilot-manifest.json.sha256`) are produced under this root and sealed there before paid calls. Runtime caches and sealed outputs are never hand-edited or committed.

## Parent deviations from the design plan

1. **No ledger migration tool** (recorded 2026-10-08): the design plan's Stage A called for `campaign-cap-amend.ts`, an audited cap-only migration for existing `$2` ledgers. Measured 2026-10-08: **no campaign ledger exists**, so the migration tool is not built. Ledger rules are:
   - ledger absent → initialize at the usual ledger location with cap **$3** and the verified historical seed;
   - persisted ledger with cap **$3** → use unchanged;
   - **any non-$3 ledger (including `$2`) → refuse.**
   - No cap-only amendment operation is ever applied; balances, UNKNOWN/in-flight reservations, locks, and campaign roots are preserved as before.
2. Consequently, stage A's acceptance reduces to the `$3` cap constant, the explicit `$2` advisory planning target, budget tests, preservation checks, and the non-$3 refusal path; the migration idempotency/crash tests are not applicable.
