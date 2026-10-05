# Grep judgment stage (Jev cloud / von local) — design

Status: approved direction (2026-10-05); spec pending final review.
Scope: workstream 1. The enhanced `find` tool is a separate spec
(`2026-10-05-enhanced-find-design.md`) that consumes the `Judge` interface defined here.

## Goal

Add an optional calibrated relevance judge as a **helper on top of** the existing grep
smart cascade. It never replaces retrieval. It:

1. filters fused candidates so fewer, tighter hits reach the agent (token savings);
2. answers natural-language behavioural queries better ("where do we retry failed requests?")
   by separating implementations from mentions/call sites/tests;
3. decides "nothing relevant here" (calibrated abstention);
4. emits **next-step pointers**: graph neighbours of confirmed hits, judged cheaply.

Non-goals: replacing BM25/symbol/semantic retrieval; judging literal/regex/structural
queries; a separate `locate` tool; per-repo configuration.

## Decisions (user-approved)

| Topic | Decision |
|---|---|
| Activation | Off by default. `/judge off|local|cloud|status` slash command. No repo config, no per-repo toggle. |
| Cloud | TypeSafe Jev via OpenRouter, using the user's OpenRouter key from pi's auth store (`ctx.modelRegistry.getApiKeyForProvider("openrouter")`). |
| Local | von (wfzyx/von, 395M ModernBERT-large, Apache-2.0) as a managed Python sidecar. |
| Shipping | Both backends behind one `Judge` interface. |
| Placement | Judgment stage inside `grep`'s smart-cascade path. |

## Verified facts this design depends on

Audited 2026-10-05 against primary sources (see session research artifacts).

- OpenRouter: `POST https://openrouter.ai/api/alpha/decisions`, model `~typesafe/jev-latest`
  (pinned: `typesafe/jev-1.13`). Body `{model, state, questions}`; questions use nested
  `criteria`. Response `{model, answers, usage:{input_tokens, output_tokens, cost}}`.
  $0.042/Mtok input, output free. 32k context. OpenRouter lists TypeSafe as zero-retention,
  no-training; OpenRouter does not store prompt content by default.
- von: `von serve` exposes `POST /v1/systemone`, wire-compatible (`choice|noul|score`,
  nested criteria; adds `noul_raw`, `truncation`). Python ≥3.12 + PyTorch (MPS on Apple
  Silicon). ~3 GB first download. **8,192-token window**, middle-truncated unless
  `--on-overflow refuse`. **Questions run sequentially, one forward pass each over the full
  state.** Default bind host is `0.0.0.0`. No in-process Node runtime.
- Published quality (vendor/author numbers, not ours): von 1.2 JevBench intelligence 34.5 vs
  Jev 53.1, calibration 75.7 vs 76.3. Our benchmark (below) decides whether von's local
  quality is acceptable for code.
- pi: `pi.registerCommand`, `ctx.ui.notify/select/confirm`; `getApiKeyForProvider` returns
  `undefined` for OAuth-only providers.

## Architecture

```
grep (smart cascade path only)
  └─ executeGrepQuery: hits (≤ gatherK, fused/deduped, exact-first)
       └─ judgeStage(query, hits, ctx)          ← new, src/judge/grep-judge-stage.ts
            ├─ gate: mode != off && isNaturalLanguageQuery && !literal && !regex && !structural
            ├─ unitize: hit → judgment unit (enclosing symbol range or hit ± context)
            ├─ Judge.judge(batches)              ← src/judge/judge.ts (interface)
            │    ├─ CloudJudge  (OpenRouter /decisions)
            │    └─ LocalJudge  (von sidecar /v1/systemone)
            ├─ filter p ≥ τ, merge adjacent ranges, order by p desc, tie-break by fused rank
            ├─ abstain via `exists` noul when nothing passes
            └─ pointers: graph neighbours of kept hits → one cheap noul batch
```

### Module layout (`src/judge/`)

| File | Responsibility |
|---|---|
| `types.ts` | Wire types (`NoulQuestion`, `ChoiceQuestion`, `JudgeRequest`, `JudgeAnswers`), `Judge` interface, `JudgeBackendInfo`. |
| `systemone-client.ts` | HTTP client for the shared wire shape: route, bearer key, 10 s per-attempt timeout, 3 attempts, backoff honoring `retry-after`, retries 408/429/5xx. Never logs or returns the key; errors are redacted codes. |
| `cloud-judge.ts` | OpenRouter backend: base URL, model id, shared-state batching under a token budget (≤ 28k tokens state + longest question). |
| `local-judge.ts` | von backend: per-unit small states (one passage per question) so sequential passes stay cheap; refuses units over the 8k window (pre-measured by char budget) instead of silent truncation. |
| `von-sidecar.ts` | Managed install + lifecycle (see below). |
| `judge-settings.ts` | User-level mode file `~/.pi/agent/smartread-judge.json` (`{mode, updatedAt}`), atomic tmp+rename write, mirroring `language-intelligence-config.ts`. |
| `judge-resolver.ts` | Resolves the active backend: pi path (settings file + auth store) or MCP path (env vars). |
| `judge-cache.ts` | Content-addressed verdict cache: key = sha256(stable JSON of question + unit text + model id). Per-workspace file under `.pi-smartread/judge-cache/` (runtime state, gitignored, never committed). Bounded size, LRU eviction, no new dependencies. |
| `questions.ts` | Question/criteria templates (below). |
| `query-intent.ts` | `isNaturalLanguageQuery(pattern)` heuristic. |
| `grep-judge-stage.ts` | The stage: gate → unitize → judge → filter/merge/order → abstain → pointers. |
| `judge-command.ts` | `/judge` slash command. |

### Backend resolution

| Surface | Mode source | Cloud key | Local endpoint |
|---|---|---|---|
| Pi extension | `~/.pi/agent/smartread-judge.json` set by `/judge` | `ctx.modelRegistry.getApiKeyForProvider("openrouter")` at execute time | managed sidecar |
| Standalone MCP | `PI_SMARTREAD_JUDGE_MODE=local|cloud` (default off) | `PI_SMARTREAD_JUDGE_API_KEY` (OpenRouter key) | managed sidecar, or `PI_SMARTREAD_JUDGE_BASE_URL` |

Optional user-environment overrides (both surfaces): `PI_SMARTREAD_JUDGE_BASE_URL`,
`PI_SMARTREAD_JUDGE_MODEL`. Per AGENTS.md, network destinations and keys come only from the
user environment, pi's auth store, or the user-level settings file — never from
`pi-smartread.config.json`. The OpenRouter key is sent only to the OpenRouter base URL; if
`PI_SMARTREAD_JUDGE_BASE_URL` points elsewhere, the auth-store key is not attached (an
explicit `PI_SMARTREAD_JUDGE_API_KEY` is required).

### von sidecar lifecycle

- `/judge local` checks for Python ≥ 3.12, confirms the ~3 GB download with the user, then
  installs a **pinned** `von-sdk` version into a managed venv at
  `~/.pi/agent/judge/von/` (same posture as managed language-server installs). Weights go to
  `~/.pi/agent/judge/von/hf/` via `HF_HOME`.
- SmartRead starts `von serve --host 127.0.0.1 --port <ephemeral> --on-overflow refuse`
  lazily on the first judged query, waits on a health check, reuses it for the session,
  and stops it on session shutdown. Never binds `0.0.0.0`.
- Cold start (model load) does not block grep: while the sidecar is warming, grep returns
  unjudged results with `degraded: judge_warming`.
- `PI_SMARTREAD_JUDGE_BASE_URL` skips management and uses a user-run server.

## Judgment stage

### Gate

Judge only when all hold: mode ≠ off; path is the smart cascade (not `literal`, not regex,
not `structural`); `isNaturalLanguageQuery(pattern)`; ≥ 2 candidate hits. Heuristic for NL:
≥ 3 whitespace-separated words, not a single identifier/path/glob, not quoted code. Exact
identifier queries keep today's behaviour and cost.

No tool parameters are added: grep's schema is unchanged. Judging is controlled only by
the user (`/judge` in pi, `PI_SMARTREAD_JUDGE_*` env in standalone MCP).

### Units

Each hit becomes one judgment unit: the enclosing symbol range from existing tree-sitter
tags when the hit lies inside one and the symbol is ≤ 120 lines; otherwise the hit range
± `contextLines`, capped at ~3,500 characters. Unit state carries `path`, `symbol`
(breadcrumb), `signature`, `calls` (outgoing call names, ≤ 24) and line-numbered text.
Units are deduped by range before judging.

Candidate cap: judge at most 40 units per query (top of the fused order). Sketch-first
two-wave routing (OMP) is **not** in v1: our units are already function-sized; revisit only
if the benchmark shows cost or latency problems.

### Questions (adapted from OMP's verified wording)

- Per unit, `noul`:
  `Does \`units.<key>\` substantively implement, define, or explain part of "<query>"? Apply \`criteria\`.`
  - true: `This unit contains an implementation, definition, or substantive explanation of an important part of the search. A helper implementing one requested step counts even when other steps are elsewhere.`
  - false: `This unit only mentions, calls, imports, tests, or configures the subject, or contains unrelated code sharing keywords.`
- Per query, one `noul` `exists`: `Do any of the units answer "<query>"?` (thresholds 0.70
  answered / 0.35 absent, from TypeSafe's semantic_find cookbook).
- Pointer wave (below) uses the same per-unit question over signature-only cards.

Follow TypeSafe guidance: one snap judgment per question, no arithmetic, no double
negatives, strip irrelevant fields from state.

### Decisions on results

- Keep units with p ≥ τ = 0.20; order by p desc, tie-break by fused rank; merge adjacent or
  overlapping kept ranges (max p wins); then apply the existing `topK`/`maxResults` caps.
- Exact lexical hits that the judge drops are still dropped. Rationale: NL queries only;
  the drop count is reported.
- Abstain when no unit passes **and** `exists` < 0.35: output
  `no confident match for "<query>" (judge <backend>, τ 0.20)` plus the top 3 unjudged
  candidates as one-line pointers, so the agent is never left with nothing.
- Failure handling: any judge error, timeout, missing key, or sidecar failure → return the
  unjudged results unchanged, with `degraded: judge_<code>` on grep's existing degradation
  line. The judge never makes grep fail and never drops results on error.

### Next-step pointers (SmartRead-specific)

After filtering, take kept hits' graph neighbours from the shared context graph (callees,
callers, importers; ≤ 12 total, excluding files already shown). Judge them in one batch
using signature-only cards (name, signature, path). Emit those with p ≥ 0.45 as
`next: <path>:<line> <symbol> (p)`, max 3. Skipped when the graph is not built — never
triggers a graph build.

## Output

Text (per hit line gains a probability; footer summarises the stage):

```
5 result(s) for "where do we retry failed API requests" (bm25 + symbol + semantic, judged, 1.4s)

src/net/client.ts  L42-71  executeWithRetry  p=0.91
<snippet>
...
judge: cloud jev · 24 judged · 19 below τ 0.20 · cache 6/24 · $0.0004
next: src/net/backoff.ts:12 computeBackoff (0.78) · src/net/errors.ts:30 isRetryable (0.66)
```

`details` additions (additive, optional fields): per-hit `judgeP`; per-query
`judge: { backend, model, judged, kept, belowThreshold, threshold, cacheHits, costUsd?, abstained, pointers[] }`.
Evidence: unchanged mechanism — only shown hits produce search-match evidence; dropped
candidates and pointers produce none.

## `/judge` command

`/judge status | off | local | cloud | install`
- `cloud`: verifies an OpenRouter API key exists (no network call, never printed); if the
  provider uses OAuth only, explains that an OpenRouter API key is required.
- `local`: runs install if needed (with size confirmation), starts the sidecar, runs a
  one-question smoke test.
- `status`: mode, backend, model id, sidecar state, cache size, session cost.
- Persists mode to the user-level settings file.

## Evaluation and benchmark (before default thresholds are frozen)

1. **Judge benchmark (von vs Jev)** — labelled (query, unit) pairs from this repo:
   ≥ 40 behavioural queries; per query gold implementing units, hard negatives (call sites,
   imports, tests of the same symbols) and easy negatives. Labels produced by a subagent
   and audited by a second one; ambiguous pairs dropped. Metrics: AUROC, ECE, precision /
   recall at τ 0.20 and 0.45, p50/p95 latency per query, cost per query.
2. **Grep end-to-end** — same queries through grep with judge off / local / cloud: file and
   unit Recall@5, tokens returned, abstention correctness on deliberately unanswerable
   queries (≥ 8).
3. Harness lives in `scripts/eval/judge/` with fixtures in `test/fixtures/judge-eval/`;
   it is opt-in (needs network/key or sidecar) and not part of `npm test`.

Exit criteria to keep a backend enabled for users: AUROC ≥ 0.80 and p95 grep overhead
≤ 2 s warm. If von misses them, it ships marked "experimental" in `/judge status`.

## Tests (`npm test`, no network)

- `systemone-client`: retry/backoff/timeout, redacted errors, key never in error text.
- Backend resolution matrix (pi vs MCP; key present/absent/OAuth; base URL override does not
  receive the auth-store key).
- Stage: gate cases; unitization; threshold/merge/order; abstention; failure → unjudged +
  degradation code; cache hit path; pointer wave skipped without a built graph.
- Settings file atomic write; `/judge` command parsing.
- Sidecar manager with a fake server binary (bind host is 127.0.0.1, refuse-overflow flag,
  shutdown on dispose).
- Schema: grep schema unchanged (asserted by the existing schema/MCP parity tests).

## Rollout / compatibility

- Off by default; with mode off, grep output and `details` are byte-identical to today
  (asserted by a snapshot test).
- No schema change. Update the grep tool description, `skills/` and README to describe the
  judged output fields and `/judge`, in the same change.
- Rollback: `/judge off`, or remove the stage call; no persisted state outside the
  settings file, the cache directory and the managed venv.

## Open risks

- von quality on code is unknown until the benchmark; author-reported numbers are weaker
  than Jev.
- 3 GB local install and Python ≥ 3.12 prerequisite.
- OpenRouter `/api/alpha/` route is alpha; pin model ids and cover with a contract test
  against recorded responses.
- NL-intent heuristic misclassification (no per-call override by design; tune the
  heuristic against the eval set).
