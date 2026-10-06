# Stacked PR plan: judge + find (base `18f6463` → HEAD, 123 commits)

Base: `18f6463`. Branch: `feature/judge-and-find` (~122–123 commits later).
Stack order below IS the review/merge order; each PR builds on the previous.
No push, no branch creation — document only.

## PR1 — judge core, von sidecar, /judge command (`1af3297..ee33e50`, 3 commits)

Foundation for everything judge-related: relevance-judge library, managed von
sidecar with runtime resolvers, and the `/judge` command (design doc included).
Key files: `src/judge/*` (types, questions, local/cloud judges, von-sidecar,
judge-command, resolvers, runtime, settings, cache), `docs/plans/2026-10-05-grep-judge-design.md`.
Tests: `test/unit/judge/{questions,local-judge,cloud-judge,systemone-client,judge-command,judge-settings,judge-resolver,von-sidecar}-*.test.ts`.
Risk: new network-adjacent surface (cloud endpoint, von sidecar install); verify
managed-install pinning and that judge defaults to off.

## PR2 — enhanced find + grep smart-cascade judge stage (`6d787ce..7c1b6b1`, 2 commits)

Find gains glob, fuzzy-name, and NL discovery modes; grep gains the
natural-language smart-cascade judge stage on top of PR1.
Key files: `src/search/find-{tool,modes,candidates,format,fuzzy-path-score}.ts`,
`src/search/query-intent.ts`, `src/judge/grep-judge-stage.ts`, `docs/plans/2026-10-05-enhanced-find-design.md`.
Tests: `test/unit/search/{find-*,query-intent}.test.ts`, `test/unit/judge/grep-judge-stage.test.ts`.
Risk: shared NL query detector spans both features — review its routing contract first.

## PR3 — Pi/MCP wiring for judge and find (`6eca457`, 1 commit)

Registers judge/find tools in the Pi extension and standalone MCP server.
Key files: `src/index.ts`, `src/extension-registration.ts`,
`src/extension-lifecycle.ts`, `src/mcp-server.ts`, `src/mcp-registry.ts`.
Tests: `test/unit/index-registration.test.ts`, `lifecycle-activation`,
`test/unit/mcp/*`, judge lifecycle/cache-integration tests.
Risk: public tool-schema surface; any schema change must update skills/README/tests together.

## PR4 — eval harness: judge runner, grep e2e, metrics, curves (`e79da6d..6e093ef`, 4 commits)

Judge classification benchmark runner with metrics/curves plus the grep
end-to-end fidelity harness and program decision notes (D12–D18).
Key files: `scripts/eval/judge/*`, `docs/plans/2026-10-05-agent-evaluation-harness-notes.md`.
Tests: `test/unit/judge/{eval-metrics,ir-metrics,grep-e2e-*}.test.ts`.
Risk: harness defines "correct" for later PRs — scrutinize metric definitions
(nDCG ideal-ranking fix lands later in PR8, so baselines shift).

## PR5 — external pipelines + comparators (`8fdab62..ce37809`, 12 commits)

External grep/LSP benchmark datasets, gold/sampling pipelines, ripgrep/probe/
codanna and pi-lsp/mcp-language-server adapters, corpus-root/teardown fixes,
plus interleaved docs (D19–D28) and two RED regression tests (`ceb7e65`,
`915627e`) fixed in PR6–PR7.
Key files: `scripts/eval/external/{grep,lsp}/*`, `src/search/deep-search*.ts`.
Tests: `external-{grep,lsp}*.test.ts`, `deep-search-symlink-cwd` (RED here).
Risk: RED tests are green only after later PRs — do NOT merge standalone;
verify `git log` ordering, not just the final tree. **Squash candidate:** keep whole.

## PR6 — regex routing work (`213e30e..73c8f07`, 5 commits)

Routes prose/multi-line patterns away from auto-regex, honors backslash parity
(later), treats bracketed prose prefixes as text, with explicit regex override;
strays: deep-search cwd canonicalization, ripgrep/LSP-comparator latency fixes.
Key files: `src/search/grep-tool.ts`, `grep-cascade.ts`, `query-intent.ts`,
`scripts/eval/external/*comparator*`.
Tests: `test/unit/search/grep-regex-routing.test.ts` (turns PR5 RED green),
`grep-symlink-cwd`, comparator tests.
Risk: routing changes what users' patterns mean — check the decline-reason
rendering contract and the override escape hatch first.

## PR7 — latency/parser/span fixes + symbol-unit intro (`18617b7..23f4989`, 13 commits)

Per-operation latency comparability, token-budget accounting, read-ready span
metrics over displayed lines, parser/query reuse, enclosing-definitions
perf, and enclosing-symbol result units behind `PI_SMARTREAD_GREP_UNIT_MODE`.
Key files: `src/search/grep-units.ts`, `src/search/search-tool.ts`,
`scripts/eval/judge/grep-e2e*.ts`, `scripts/eval/external/lsp/*`.
Tests: `grep-unit*.test.ts`, `grep-diagnostics`, `grep-e2e-*`, LSP comparator tests.
Risk: metric redefinitions (span counting, latency split) move every downstream
number — confirm old-vs-new values are not mixed in one report.

## PR8 — ranking knobs: unit controls + BM25 (`78e3c34..d473a24`, 21 commits)

Experimental unit-per-file/excerpt-length knobs, unit-mode reporting, JS-tags
query fix, coverage-predicate unification, unjudged-units visibility, unit cap,
and Probe-adapted BM25 knobs (default off) with cache-key and details reporting.
Key files: `src/search/grep-{ranking,units,tool,structural-executor}.ts`,
`src/queries/tree-sitter-*/javascript-tags.scm`, `src/scoring.ts`.
Tests: `grep-{ranking,unit-knobs,unit-details,ranking-details}`,
`grep-judge-{max-units,unjudged,unit-mode}`, `javascript-tags`, `query-intent`.
Risk: knobs multiply the test matrix — check knob fingerprinting/pairing
tolerance and that defaults reproduce pre-knob behavior exactly.

## PR9 — frozen manifests, IR metrics, demote-by-default (`732b0bf..7e21d2d`, 19 commits)

Frozen 64-dev/32-holdout external-grep manifest with holdout guard, search-level
IR metrics + bootstrap, ranking knobs in run identity, engine-hash recording,
and the behavior change: demote test/spec/doc files by default (0.7).
Key files: `scripts/eval/external/grep/{frozen-manifest,freeze-dev-holdout,metrics,run-identity}.ts`,
`src/search/grep-{ranking,tool}.ts`.
Tests: `external-grep-{frozen-manifest,run-args,engine-hash}`, `grep-e2e-rank-knobs`, `ir-metrics`.
Risk: **demote default is a user-visible behavior change** — needs explicit
sign-off; also `066c053` makes value-less `--manifest` fail closed (CLI break).

## PR10 — variant matrix + judge hardening (`547331f..998c258`, 11 commits)

Paired variant-matrix tool (replication, leave-one-out), unavailable-metric
reporting, verdict-cache age bound + backend/endpoint keying, excerpt-based
`exists` evidence behind a flag, `/judge` experimental labelling.
Key files: `scripts/eval/judge/variant-matrix.ts`, `src/judge/{judge-cache,grep-judge-stage,judge-command}.ts`.
Tests: `variant-matrix`, `judge-cache*` (incl. integration), `grep-judge-stage-exists-excerpts`.
Risk: cache-key changes invalidate prior verdict caches silently — confirm
version/age handling; excerpt-exists flag gates the D42 evidence contract.

## PR11 — D46 held-out set + runner/scorer + freeze tooling (`2c20d08..9cf9d4e`, 21 commits)

D46 schema/validator/sealing/second-label sampler, pinned repos + authoring
protocol, runner + scorer with sealed-split integrity and holdout-freeze guard,
cold-start deletion policy (fail-closed, preflight-gated, never tracked files),
top-5 file metrics, report isolation.
Key files: `scripts/eval/d46/*`, `docs/plans/2026-10-06-d46-heldout-protocol.md`.
Tests: `test/unit/eval/d46-*.test.ts`.
Risk: **holdout tooling must be read-only w.r.t. the freeze** — verify the
seal/validator path and that cold-start deletion cannot touch tracked files or
survive a failed preflight. **Squash candidates:** `e93ed54+9aa8d6e` (first
commit alone fails tests — squash); `32e194f` is harness-only but changed the
engine hash, so keep it separate and visible.

## PR12 — abstention contract D67 + decision-log close-out (`baa24df..1437a3c`, 11 commits)

D67 chain: abstention renders no location pointers, message-only batch
abstention keyed by query entry, dropped pattern-string fallback for
provenance-less hits; per-query judge details capture; oracle/exists/D42–D70
decision-log close-out (D63–D70, holdout verdict HARMS).
Key files: `src/search/grep-tool.ts`, `grep-judge-stage.ts`, `scripts/eval/d46/*`,
`docs/plans/2026-10-06-decision-log.md`.
Tests: `test/unit/search/grep-tool-abstain.test.ts`, `d46-run-judge`.
Risk: **D67 rendering contract** — reviewers check abstention output first
(no pointers, no hits, entry-keyed); confirm no retrieval evidence is masked
(`18617b7` precedent).

## Suggested review order / check-first per PR

PR1→PR12 in stack order. Check first: PR1 sidecar install + off-default; PR2 NL
detector contract; PR3 schema diffs; PR4 metric definitions; PR5 RED-test
provenance; PR6 override hatch; PR7 old-vs-new metric parity; PR8 default-off
reproduction; PR9 demote sign-off; PR10 cache invalidation; PR11 freeze
read-only guarantees; PR12 abstention rendering fixtures. Leftovers: none.

## Appendix: commit → PR

| Commits (inclusive ranges, oldest→newest) | PR |
|---|---|
| `1af3297..ee33e50` | PR1 |
| `6d787ce..7c1b6b1` | PR2 |
| `6eca457` | PR3 |
| `e79da6d..6e093ef` | PR4 |
| `8fdab62..ce37809` | PR5 |
| `213e30e..73c8f07` | PR6 |
| `18617b7..23f4989` | PR7 |
| `78e3c34..d473a24` | PR8 |
| `732b0bf..7e21d2d` | PR9 |
| `547331f..998c258` | PR10 |
| `2c20d08..9cf9d4e` | PR11 |
| `baa24df..1437a3c` | PR12 |

Ranges partition `18f6463..HEAD` with no gaps/overlaps (123 commits, 0 leftover).
