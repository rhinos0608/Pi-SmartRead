# Campaign reconciliation — 2026-10-10

Evidence collected in this session: Git branch/HEAD/status, process metadata, aggregate-only A0 stdout classification, GitHub PR checks, private ledger projection, and focused local verification. Historical decision-log entries are records, not fresh verification. No holdout IDs, rankings, scores, labels, or credentials were exposed.

## Live state

- Main is clean at `3aa32fd6262426e0dc47d9e4438b116957ea586b`; fetched `origin/main` without switching or merging.
- Bets, ergonomics, judges, and retrieval remain dirty development worktrees at `5e6845979ab1caed1e56c9e997f02953ac44f93b`. Their uncommitted files were preserved.
- A0 wrapper PID4554 and runner PID4588 are present. Runner was runnable at 67.5% CPU after 20h40m; aggregate observation: 729 ok + 3 errors / expected800, stderr0bytes, wrapper unfinished, no final report found. These observations do not establish final receipt acceptance.
- A5 chain PID13980 is present; no A5-start marker. Do not start A5 against this errored attempt. Observe completion receipts, then use the frozen whole-arm retry/merge rules without query reruns or score access.
- Pi PID4520 remains nice10. No competing benchmark or paid run was launched.
- Ledger is a regular0600 file with unchanged post-migration SHA `6d071138b903a9aed6ba28711d66711d89d5343fc9b1c1c7cc88c2cea6f411bf`: cap$10, reserved/used$0.36129612, actual$0.24460876, headroom$9.63870388, zero in-flight, no reserve breach. UNKNOWN accounting is not cleared.

## Acceptance ledger

| Milestone | Actually completed / evidence | Original acceptance met? | Blocker / next action |
|---|---|---|---|
| LSP source + identity + discovery | Offline code exists. Earlier records report source80 and identity17 checks. Current parent observed discovery48/typecheck/whitespace and scoped guard review4ff188bf. Complexity reduced100→31 but warnings remain. | Local guard checkpoint only; **not B/C acceptance**. | Selector local seam closed before core migration. Owner now authorizes clean breaking migration across all three repos; no legacy shims. Finish canonical submitted-state/action-origin proof and required source-generation staging/apply checks, then preparation/facades/registration/current-build CI. Historical studies remain frozen. |
| Explicit action selection | Corrected discovery7 vs selection8 seam; two genuine stale-vs-cancelled/timeout reds. Stop priority fixed; post-await action identity rechecked; known-empty actions return no-match. Final parent16/16/typecheck after finally-release/await/actual-handle-close cleanup. | **Local five-runtime-case checkpoint met; not preparation/B/C acceptance**. | Prior16/typecheck checkpoint predates core migration. Submission writer26 parent tests green but not accepted (invented callback success and invalid-receipt fallback); repair active. Protocol0.8/schema6 parent85/typecheck/build and scoped review+UNC red/green completed. SmartEdit three stale-origin reds reproduced; consumer stage/apply migration active in isolated worktree. Full action-origin/resolve/facade and Node20/crossOS/real-server/current-build CI remain unverified. |
| A/B/C outcome comparison | Approved design direction exists; no comparison run was launched here. | **No**. | Freeze independent task/gold/graded outcomes, immutable identities, matched-capability scoring, statistical winner/tie rules, power/feasibility and shared-cap admission before a quiet-window evaluation. Inconclusive is not evidence for B or C promotion. |
| Retrieval A0/A5 | Manifest/inference/retry rules frozen. Last permitted observation: A0 attempt1 active with three errors; no later completion receipt accepted here. Engine-before receipt matched frozenV2. | **No**. | Final rc/error/exclusion/knob/fixity receipts; fresh whole-arm retry within max3; clean admitted A0 before A5. Fresh merger reviewer84a3425f READY/10 synthetic tests; parent checked implementation against frozen§9.9. Local scoped review closed, Node20/crossOS/TOCTOU/durability remain unproven. Final blinded analysis with frozen uncertainty/regression reporting. |
| Judge confirmation | Decision log records sealed400-query/2800-candidate corpus, dry plan21612requests, runner safeguards and analyzer22 checks/review. No new paid call here. | **No**. | PR43 Windows failure, runner final review, nontrivial seeded oracle, exact-build CI and analysis freeze; then resource/spend admission for approved three-model/three-replica run. Preserve historical pilot verdict. |
| Node20 / three-OS / real-LSP CI | Live GitHub checks: old PR41/42 snapshots have three-OS functional and four-server conformance success. PR43 Windows fails; Linux/macOS and conformance pass. | **No for current code**. | Old snapshots omit latest local work. Windows tests repaired without enabling Windows ledger support: parent160/1skip/typecheck before native-only noop correction; corrected refusal module9/1explicit skip; fresh reviewer94303a3e reports159/2skips across six suites, no confirmed findings. Serena parent7 tests. Private-index whitespace/index preservation checked. Refresh current-build CI snapshots; native Windows acceptance and quality gates remain outstanding. |
| TEB / inspect | Decision log records inspect integration and cohort/identity tooling; newest full-pin repairs are local, not current PR42 content. | **No outcome acceptance**. | Independent cohort labels/adjudication/grader audit; current immutable runtime identity; advisory-action/routes-only work; admitted quiet-window outcome evaluations. |
| Shipping / provenance | PR41/42/43 are still open drafts at the same CI-only heads. | **No merge/release acceptance**. | Reconcile records, finish scoped gates, refresh CI-only snapshots, retain separate logical PR stacks; no WIP merges or default flips. |

## Current CI pins (queried live)

- PR41: `e393a355ef41dd641e98728976143636c14efffd`; CI37957408990 and conformance37957408857 success. CodeScene and SonarCloud Code Analysis fail.
- PR42: `c9cee3f73c03ce06b0244dd34ce828b1ed558f7d`; three-OS CI and conformance success. CodeScene and SonarCloud Code Analysis fail. Predates local full-pin repairs.
- PR43: `aba569074ab82d1e48545c2f8ebb2f18c7763c2d`; CI37957157820 Windows failure (job113910471083); conformance37957157720 success. CodeScene and SonarCloud Code Analysis fail.
- Windows failed-job output confirms POSIX-only ledger refusal in tests plus hardcoded `D:\\tmp` fixture failures. This does not justify weakening production fail-closed behavior.

## Execution priorities

1. Local selector16/typecheck and merger scoped review closed. Windows test repair locally checked/reviewed, native CI pending. Workflow e607ba7e completed1/failed1: Windows review passed; scout freshness design failed before execution on unknown model claude-bridge/claude-haiku-5-5. Owner subsequently repaired Fleet mapping; same-protocol scout retry b320ae7d completed. No silent fallback. Owner-authorized clean migration now follows `2026-10-10-lsp-clean-migration-implementation.md`; workflow8a0c2e8a repairs submission and migrates SmartEdit after required protocol precondition acceptance. See D67–D68 for parent reds/greens/artifact supersession and reported prohibited child full-suite deviation. Preserve nice>=10.
2. Finish LSP preparation/staging/facades after the selection gate; resolve the freshness design explicitly, never synthesize fresh server metadata.
3. Retrieve A0 completion receipts on a new completion signal; follow frozen retries. No repeated status polling or another arm while A0 is active.
4. Close judge runner/oracle/CI/freeze gates, then admitted paid confirmation after resource gates clear.
5. Freeze independent B/C and inspect/TEB studies in parallel with implementation, but do not dispatch them early or consume the judge reservation unknowingly.
6. Update exact-build CI/provenance and separate PRs after scoped checks. No speculative optimization or frozen-engine edits.
