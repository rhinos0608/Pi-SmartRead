# Inspect-Opportunity Cohort — preregistration protocol

Status: preregistered 2026-10-08 (pre-engine-results). Owner approvals: complete inspect bundle; separate independently labelled cohort; benchmark-selected defaults.
Frozen TEB (`2026-10-07-teb-protocol.md`, E6/E7/E10/E13/E22) is UNCHANGED and not owned here. No query/gold/holdout inspection, no labels, no source changes, no installs, no commits, no paid runs were performed to author this file.
Binding inputs: oracle `6654f438-1436-4802-ab64-05ed70df3b3f_oracle_output.md` (approach 2 bundle); E21–E22 (`2026-10-07-tool-ergonomics-decision-log.md`); resource baseline `/Users/rhinesharar/Pi-SmartRead-bets/docs/plans/2026-10-08-inspect-resource-baseline.md` (source-size census + engine microbenchmarks; measurement only, NOT an effectiveness claim and NOT a corpus-inclusion input).

## 0. Non-goals and ownership boundary

- This file owns ONLY the inspect-opportunity cohort design. It does not modify any frozen TEB task, split, gold, gate, or file.
- Corpus eligibility, family quotas, gold, and grading below are preregistered BEFORE any inspect-agent result is observed.
- Gold comes from independent typed source relations + witnesses. Production `extractRoutes` output, shared-regex agreement, `ContextGraph` edges, layer/cluster membership, risk labels, and rendered top-N output are NEVER truth.
- Future implementation seams are NAMED here (§12) for a later worker; they are not owned or built here.

## 1. Corpus eligibility (source-first, frozen before engine runs)

Eligible repositories: the six pinned TEB checkouts ONLY (rxjs@7.8.2, prettier@3.9.9, astro@astro@7.3.6, query@v5.90.3, tsup@v8.5.1, drizzle-orm@0.44.7; full shas in `teb/repos.json` v1). No new repos may be added after the first engine run; any addition requires a protocol amendment + re-seal before labels.
Eligibility rules (labeler-enforced, validator-rejected otherwise):

1. No-install default. Tasks must use symbols/relations resolvable from the pinned working tree without `npm install`. Workspace cross-package aliases that do not resolve without install are EXCLUDED unless a pinned install step (exact command with `--ignore-scripts` + lockfile sha) is recorded per repo — none is recorded in this protocol, so all such tasks are excluded.
2. prettier is discovery + negative-control ONLY (JS-heavy; semantic gold would land in `.d.ts` shims). No positive structural-conclusion tasks on prettier that depend on TS semantics.
3. Monorepo subpaths pinned per task: astro → `packages/astro`; query → `packages/query-core` default; drizzle → `drizzle-orm/`; rxjs → `src` default. `repo` field is `<owner>__<name>`; `subpath` is the task root.
4. Supported syntax for gold enumeration (closed list): TypeScript/TSX `import`/`export … from` (static string specifiers), CommonJS `require("…")` with a static string literal, `package.json` `exports`/`main`/`types`/`workspaces`, Express/Fastify `app|fastify|router|server|api.get|post|put|delete|patch|options|head|all(` with a static string path first argument, Next.js App-router `app/**/route.ts` + `export GET|POST|…` and Pages-router `pages/api/**`, tRPC `router({ name: procedure… })` / `t.router({…})` call-object keys. Everything else (dynamic specifiers, template-string routes, decorator routers, glob-re-export `export *` as a point answer, inferred compiler relations) is OUT OF SCOPE and excluded or used only as decoys/negatives (§4).
5. Unresolved-alias policy: relative specifiers resolve by filesystem walk (exact file, `index.*` fallback, `.ts`/`.tsx`/`.js`/`.d.ts` correspondence recorded); workspace alias map is per-repo-recorded and frozen at seal (no silent extension). Any import whose specifier does not resolve under the frozen rules is recorded `resolution: "unresolved"` with the reason, counts toward the unresolved-candidate quota, and is NEVER silently dropped or guessed.
6. Snapshot provenance: per-repo `git rev-parse HEAD` + `git status --porcelain` (must be clean) recorded in each split sealing manifest; licence file + sha256 carried from `repos.json`.

## 2. Episode families (5 positive + matched negatives)

Five positive families (P1–P5), each with a matched negative (N1–N5) on the same repo/subpath class where read/grep is preferable:

| ID | Positive episode | Independent gold (typed source relations + witnesses) | Matched negative (first-line optimal) |
|---|---|---|---|
| P1/N1 | Multi-file route inventory: list registrations in scope S | `route-set`: (method, path, file, line) enumerated by frozen route-pattern script + manual review (§6) | N1: exact-string location ("where does literal S appear?") — `grep` literal; dynamic/unsupported routing decoy present |
| P2/N2 | Package boundaries / dependency relations: which packages exist and what imports what | `relation-set`: (from-file, to-specifier, resolved-path\|unresolved, kind: import\|re-export\|require\|manifest-dep) from import-scan + manifest read | N2: single manifest scalar ("what value does key K have?") — `read` only; one-entry-file decoy |
| P3/N3 | File dependency-neighbourhood review: direct imports + direct importers of module M | `relation-set` depth-1 both directions, exhaustive within scope | N3: exhaustive reverse-importer request over a scope where the answer exceeds the rendered bound — correct behaviour is scoped `grep`, and any claim of engine-exhaustiveness fails |
| P4/N4 | Cross-module structural conclusion: "does A (transitively) depend on B through supported relations?" with witness path | `conclusion`: boolean + `path` (ordered edge list, each edge typed + witnessed by file:line source text) from independent traversal (§6) | N4: exact symbol definition/type question — LSP territory; inspect must not answer it |
| P5/N5 | Change-review evidence chain: what structural relations touch frozen patch P? | `evidence-chain`: frozen patch ranges (diff sha + file ranges) + independently enumerated relations intersecting them | N5: single-line config change — `read`/diff only; no structural conclusion warranted |

Decoys (required in every split): misleading filenames, comments/string decoys containing route-like or import-like text, unsupported-syntax specimens (dynamic imports, template routes), and unresolved aliases. Minimum decoy density: ≥1 decoy file or decoy match inside the scope of every P1–P4 task; labelers record decoy ids per task.

## 3. Splits, quotas, scope, inclusion (frozen before labels)

| Split | n (provisional pilot) | Purpose | Sealing |
|---|---|---|---|
| pilot | ~30 (≥10 negative: ≥2 per N-family) | variance calibration, cost metering, gate calibration | unsealed; prompts may change after |
| dev | ~70 (≥40% negative) | bundle iteration | frozen prompts/gold; visible |
| holdout | ~130 (≥44 negative) | ONE opening, ONE predeclared champion | sealed §10 |

Provisional family quotas (pilot 30): P1:4, P2:4, P3:4, P4:2, P5:2, N1–N5:2 each (=10 negatives). Dev/holdout quotas scale proportionally with every family present ≥2 per split (pilot ≥1 attempted; families that cannot meet §1 bounds on any repo are recorded absent, never filled with ambiguous tasks).
Stratification: repo × family; every repo appears in every split (prettier positives excluded per §1.2 — compensated by extra negatives on prettier).
Power/confirmation sizing: confirmation n is driven by pilot-measured task-level within-cohort off/on discordance at the preregistered effect (§8); replicates are NOT independent tasks. If required n exceeds the preregistered holdout, ENLARGE the still-unopened holdout before any dev run and disclose achievable power/MDE. Freeze methods + thresholds before dev; no outcome-based gate relaxation.
Sample-candidate universe is fixed FROM SOURCE before engine runs: each task pins `scope` (subpath-relative; "" = whole subpath) and the labeler-enumerated candidate universe id + hash at seal. Exhaustive gold requires demonstrated enumeration + renderer coverage (§7), never cardinality alone.

## 4. Task schema (new, disjoint from TEB)

```ts
interface InspectTask {
  id: string;              // "insp-<split>-<family>-<nnn>"
  split: "pilot" | "dev" | "holdout";
  repo: string; commit: string; subpath: string;
  family: "P1"|"P2"|"P3"|"P4"|"P5"|"N1"|"N2"|"N3"|"N4"|"N5";
  prompt: string;          // frozen per split; includes explicit scope + supported-syntax boundary
  scope: string;
  answerType: "route-set" | "relation-set" | "conclusion" | "evidence-chain" | "location-set" | "file" | "scalar";
  gold: InspectGold;      // §6; canonical normalized form
  candidateUniverse: { id: string; sha256: string; count: number };
  decoys: string[];        // decoy ids in scope
  negativeControl: boolean;
  derivation: string;     // exact script+version+commands
  agreement: "agree" | "adjudicated";
  labelers: [string, string];
  adjudication: string;   // "agree" | "adjudicated:<note>"
  snapshot: { head: string; clean: boolean };
  note?: string;           // never shown to agent
}
type InspectRelation = {
  from: string; specifier: string; kind: string; line: number;
  witness: { path: string; line: number };
} & (
  | { resolved: string; unresolvedReason?: never }
  | { resolved: null; unresolvedReason: "dynamic-specifier" | "re-export-ambiguous" | "generated" | "out-of-scope" }
);
type InspectGold =
  | { kind: "route-set"; routes: Array<{ method: string; path: string; file: string; line: number }>; minRecall: number; minPrecision: number }
  | { kind: "relation-set"; relations: InspectRelation[]; minRecall: number; minPrecision: number }
  | { kind: "conclusion"; verdict: "supported-true" | "supported-false" | "cannot-establish"; claim?: boolean; // REQUIRED except cannot-establish, where it MUST be omitted (unknown, never false)
    reason: string; scope: string; path: Array<{ from: string; to: string; kind: string; witness: { path: string; line: number } }>; enumeratedFiles?: string[] }
  | { kind: "evidence-chain"; patch: { sha: string; ranges: Array<{ path: string; start: number; end: number }> }; relations: InspectRelation[]; minRecall: number; minPrecision: number }
  | { kind: "location-set"; locations: Array<{ path: string; line: number; character: number }> }
  | { kind: "file"; path: string }
  | { kind: "scalar"; value: string };
```

Final-answer contract (runner prompt = `prompt` + one shape block only; the sealed `candidateUniverseSha256` / sealed universe file list is OFFLINE grader metadata only and MUST NOT appear in any runner prompt — an isolated runner never sees gold; the agent MUST NOT know, print, or reproduce a sealed hash): positives `route-set` → `{"answer":[{"method","path","file","line"}],"coverage":{"claim":"exhaustive"|"partial","scope":string,"enumeratedFiles":string[]}}`; `relation-set` → `{"answer":[{"from","specifier","resolved","unresolvedReason?","kind","line","witness":{"path","line"}}],"coverage":{"claim":"exhaustive"|"partial","scope":string,"enumeratedFiles":string[]}}` (`unresolvedReason` REQUIRED iff `resolved` is null — enum `dynamic-specifier|re-export-ambiguous|generated|out-of-scope` per §1 item 5 — else MUST be absent; `witness.path`/`witness.line` MUST equal the source citation establishing the relation); `conclusion` → `{"verdict":"supported-true"|"supported-false"|"cannot-establish","claim":boolean,"reason":string,"scope":string,"path":[{"from","to","kind","witness":{"path","line"}}],"enumeratedFiles?":string[]}` (`supported-true`: path witnesses inside scope; `supported-false`: `claim:false`, `path:[]`, non-empty `reason` citing the checked boundary, PLUS `enumeratedFiles` sorted subpath-relative covering the scope; `cannot-establish`: `claim` MUST be omitted (unknown, never graded as false), `path:[]`, non-empty `reason`, no `enumeratedFiles` required); `evidence-chain` → `{"answer":{"ranges":[{"path","start","end"}],"relations":[...]}}` (every range is `{path,start,end}` with `path` a normalised scope-relative path and `start`/`end` 1-based inclusive line numbers; range identity is exact path+start+end; `patch.sha` in gold is grader-only frozen metadata — no model hash is required or accepted; inherits relation unresolved/witness rules for its relations entries; coverage required on exactly the same contract as every other positive set). Route match identity = (`METHOD-UPPER`, `path`, `file`, `line`); relation match identity = (`from`,`specifier`,`resolved ?? ("UNRESOLVED:"+unresolvedReason)`,`kind`,`line`); source-citation check: every route/relation/path witness `path:line` must resolve to a real source line in scope (else item counts as hallucinated, §7); enumeration coverage (offline) = |agent enumeratedFiles ∩ sealed scope universe| / |sealed scope universe|, computed against the sealed source-derived universe (§10). False-completeness is a separate boolean: an exhaustive claim with incomplete enumeration, a known truncation/omission, or missing gold items; its rate uses all eligible positive task outcomes as denominator. An empty universe yields coverage 1 only when independent enumeration affirmatively confirms complete scope, otherwise completeness is unknown. Negatives reuse TEB shapes and carry NO `coverage` field. Unknown top-level keys → malformed (score 0, reason `malformed`); no per-item invented counts, no free-prose oracle — only the fields above are read. Every advertised field has a grader rule in §7. No contract field is a placeholder: there are no TBD-graded fields.

## 5. Arms, models, controls, caps (identical except inspect selector)

- Arms (4): **off** (baseline, natural choice); **on** (complete inspect bundle, natural choice); **instructed** (off surface + frozen inspect instruction on POSITIVES ONLY — diagnostic, never an upper bound); **generic-prompt control** (off surface + token-matched non-inspect investigation advice, e.g. "systematically list candidate files, check each candidate in source, and report what you verified with file:line citations" — matched ±10% tokens to the instructed text).
- Frozen instructed text names the inspect bundle only (no operations/args/sequences); generic control names no tool. Instructed/generic run on positives only.
- `PI_SMARTREAD_AFFORDANCES=0` fixed across ALL arms/runs. Selector `PI_SMARTREAD_INSPECT_AFFORDANCES` takes ONLY the values `0`/`1` (never the strings `on/off/instructed-text/generic-text`); arms `off`/`instructed`/`generic` ALL set the selector `0` and differ ONLY in prompt text (off: no mention; instructed: one short paragraph instructing when/how to use inspect; generic: matched-length control paragraph naming no tool — token/length control, no outcome-based calibration). Only arm `on` sets the selector `1`, with prompts IDENTICAL to `off` (pure affordance effect). Capture the effective selector once at construction. Record effective selectors, build identity, schema + guidance hashes per run.
- Models: primary `opencode-go/deepseek-v4-flash`, transfer `openai-codex/gpt-6-luna`; exact pins (provider, model id, `--thinking`, resolved `responseModel`/`providerThinkingLevel`) frozen BEFORE the pilot (primary thinking identity pins freeze before — not after — pilot identity checks); mismatch = excluded + rerun. Same build for all arms in a comparison.
- Identical tool allowlist, total context/output limits, turn cap, per-task wall cap across arms. Env HOME/auth unchanged. Tool allowlist INCLUDES the host reader available in that harness.
- Pi primary now. MCP mirror parity is checked via tests only in this protocol; any MCP agent cohort is separately budgeted and reported apart (never pooled with Pi) to avoid conflating available host readers.
- Launch mirrors TEB §9.2 with the inspect selector added; runner builds prompt from `prompt` + shape block only (unit-tested gold isolation).

## 6. Gold derivation (independent, engine-blind)

Two independent source-first labelers, blind to SmartRead output/enrichment; third adjudicator on any disagreement; label histories sealed.
- P1: frozen route-pattern script (exact patterns = §1.4 list; script version + diff sealed) over pinned tree + manual review of every candidate including decoys.
- P2/P3: import-scan script (static specifiers + frozen alias map) + `package.json` reads + manual review; `resolved:null` + reason for unresolved.
- P4: independent transitive traversal over the labeler-enumerated typed edge set (NOT the engine graph); every path edge carries kind + file:line witness quoted from source. No path without per-edge witnesses passes review.
- P5: frozen patch (`git diff` sha + ranges) + independent relation enumeration intersecting the ranges; patch hash sealed.
- N1–N5: exhaustive `rg`/file enumeration; commands recorded in `derivation`.
- Unanswerable/unsupported controls: each split includes ≥2 tasks whose correct answer is "cannot be established within supported scope" (unsupported syntax only, or empty intersection with a fully enumerated scope). Forcing a closed-world claim on these is graded wrong; the correct conclusion cites the scope boundary + enumeration proof. Grading policy is fully specified in §7 — no hidden TBD.

## 7. Grading (source-supported conclusion / citation / completeness)

Grader: pure functions + fixtures BEFORE labels (§12). Per-type pass (binary, primary input):
- `route-set` / `relation-set`: recall = |P∩G|/|G|, precision = |P∩G|/|P|; pass iff recall ≥ minRecall AND precision ≥ minPrecision. Route match: method (upper) + path + file + line. Relation match: from + specifier + resolved-or-UNRESOLVED:reason + kind + line (±0 lines; character not graded), with the same witness contract for relation-set and evidence-chain. Labeler-authored minRecall/minPrecision required on every task (pre-fill defaults: minRecall 1.0 for |G|≤5 else 0.8; minPrecision 0.5; relaxations justified in `note`).
- `conclusion`: tri-state `verdict` graded as its own outcome — `supported-true` requires claim true AND every path edge matches a gold edge with a valid source witness; `supported-false` requires claim false + path `[]` + non-empty `reason` citing the checked scope boundary + `enumeratedFiles` (sorted, subpath-relative), graded true iff offline enumeration covers the sealed scope universe AND an independent reference enumeration (independent parser-derived reachability over source — NOT production graph/cluster code, NOT a regex copy of the agent) also finds no path; `cannot-establish` requires path `[]` + non-empty `reason`, graded as unknown — NEVER coerced to false (unsupported ≠ false). Reason/scope/source witnesses are machine-checked for presence and scope-equality, never LLM-judged for prose quality.
- `evidence-chain`: patch-range recall ≥ 1.0 on frozen ranges AND relation recall/precision vs thresholds; citing a file outside the patch without a witnessed relation fails precision. Range identity is exact path+start+end: every range is `{path,start,end}` with `path` a normalised scope-relative path and `start`/`end` 1-based inclusive line numbers; every claimed range must name a tracked source file within the patch scope, and extra, outside-scope, or unwitnessed claimed ranges penalise precision/support and are never ignored. `patch.sha` is grader-only frozen metadata identifying the sealed diff — no model hash is required or accepted. Coverage is required on exactly the same contract as every other positive answer set.
- Citation rule: every positive answer must include file:line citations for each claimed item (routes: `file`+`line`; relations: `witness.path`+`witness.line` == establishing source line; conclusion path edges: `witness.path`+`witness.line`); items without resolving citations do not match (hallucinated → precision penalty). Relation match identity = (from, specifier, resolved ?? ("UNRESOLVED:"+unresolvedReason), kind, line) — unresolvedReason mismatch, missing-required reason (resolved:null without reason), or present-when-forbidden reason (resolved:string with reason) FAILS that item. Completeness: `coverage.claim: exhaustive` is checked offline against the independent sealed scope universe and gold items. Enumeration coverage is descriptive; the false-completeness boolean/rate defined in §4 is gated separately in §8, never mistaken for coverage or merged into recall; the agent MUST NOT know, print, or reproduce the sealed hash. False-completeness (claiming exhaustiveness over an incompletely enumerated scope) is a SEPARATE gated metric (§8), not merged into recall. No per-item invented counts read; no free-prose oracle; unknown top-level keys → malformed, score 0.
- Negatives: graded by their shapes; specialist overuse tracked separately.

## 8. Outcomes, inherited gates, calibration rules

Primary: paired task success with required evidence (task-level majority over matched surviving replicates, E22). Secondary: appropriate recall (specialist use on positives), precision/over-routing, lost priors, false-completeness rate, invalid-call rate, model/tool tokens, cost, cold/warm latency, setup/index work — raw OUTER agent calls vs INNER engine steps vs index/setup time vs bytes vs model cost measured SEPARATELY; evidence-receipt timing from runner stamps only (no invented internal times).
Inherited gates (targets carried from TEB Lane-P per oracle §152, frozen numerically before dev): positive success +5pp with positive paired CI; appropriate recall +15pp; precision ≥80%; lost priors ≤5% of baseline-passed; paired negative-harm veto: point deterioration >3pp AND exact McNemar p<0.05 on paired task outcomes (approved TEB protocol §11 and §12 gates; E10 table R9). No other per-family promotional deltas are approved or frozen here.
Study-gate denominators (reconciliation): positive-success gate uses POSITIVE TASKS ONLY as denominator (route F1 / relation F1 / conclusion tri-state accuracy where cannot-establish is its own outcome, never merged into false); negatives are graded by frozen TEB matchers on a SEPARATE negative denominator under the paired negative-harm veto and never inherit positive coverage fields. The generic arm is a token/length control (prompt-length parity check only) — NO outcome-based calibration. CALIBRATION RULES (rules frozen before pilot; numerical caps frozen before dev — no fabricated universal numbers in this file): (a) false-completeness gate: champion false-completeness rate must not exceed baseline (paired test, same veto structure as harm gate); cap value frozen post-pilot. (b) invalid-call gate: champion invalid-call rate must not exceed baseline + frozen margin; margin frozen post-pilot. (c) cost gate: per-task model-cost + tool-cost ceiling frozen post-pilot from metered pilot means; champion must stay under ceiling on matched tasks. (d) latency gate: p95-equivalent (ordered-statistic with stated n, no asymptotic p95 claim at small n) wall-latency ceiling frozen post-pilot; champion must stay under ceiling. Uptake (inspect-call count) alone can never pass. Thresholds shown to owner with pilot cost extrapolation before any dev run; never relaxed after holdout opens. No per-family promotional deltas beyond the §8 inherited gates are approved or frozen here. Source-first labels (§1) and the original frozen TEB distribution are preserved — no relabelling graph/output-derived wins as source-first, no TEB edits. Source budget/resource measurements (resource-baseline doc) remain PRELIMINARY engine-only evidence (fresh-child cold samples with separate setup/import/engine/parent-wall timings and controlled same-child warm repeats (v2), no agent loop, no model cost; directory figures remain legacy-combined costs including baseline map work, not isolated selective views) — scope/cost input only, never frozen selective-view caps.

## 9. Replicates, timeouts, exclusions, contamination

Replicates: 3 independent fresh-process launches per task×arm (no seed flag); pairing by logical task + replicate after attempt/exclusion filtering (E22); majority >0.5, ties fail. Ordinary timeouts (incl. double) stay 0/0 in the denominator. Infra exclusions predeclared + narrow (pre-first-token provider/auth failure; extension load failure; runner crash) — excluded, listed, rerun; >5% excluded invalidates the batch. Identity mismatch = excluded + rerun. Contamination (bench-cache/task-file reference in tool args or bash): GRADED AS FAILURE, listed, never excluded. Holdout exposure blacklist: pilot/dev task prompts, gold files, grader internals, sealed holdout ids, and the bench cache paths are forbidden strings in agent-visible prompts and in labeler-to-runner handoffs; runner scans and fails contaminated sessions.

## 10. Sealing and audit

Grader fixtures + contamination guards BEFORE labels (§12 exit criterion). Sealing manifest per split: task JSONL sha256, enumeration-script versions + output diffs, label histories + adjudication notes, agreement rates per family, candidate-universe hashes, snapshot heads + clean flags, patch shas, selector/build/guidance hashes, model pins. Gold files `0600` + sha256 manifest; independent custodian SHOULD hold holdout. Single holdout opening for one predeclared champion, recorded with date/champion/gates. Auditors verify exposure, gold isolation (no engine-derived gold), grader-test passage, cost accounting, paired-claim validity before any promotion claim.

## 11. Pilot quotas, budgets, spending ceiling — NO PAID ACTION IN THIS LANE

Provisional pilot: 30 tasks × 4 arms × 3 replicates = 360 sessions max (instructed + generic run positives-only: 20×2×3=120 of the 360; actual ≤ 30×2×3 + 20×2×3 = 300). Per-task wall/turn caps mirror TEB pilot defaults (240s / 25 turns) pending pilot confirmation.

Paid-authorization rule (binding): ANY paid pilot session — including probes, smoke runs, and single-task checks — requires (a) prior owner-approved session count AND model-cost ceiling, (b) exact usage/rates/prompt-delta shown before spending, and (c) an explicit stop condition (session or spend cap that halts the pilot). The "300 sessions max" figure above is a design envelope, NOT an authorization; larger-pilot-300 sessions are NOT implicitly authorised. No paid runs were performed to author this file. Existing measured smokes (resource-baseline doc) may inform a PRELIMINARY cost estimate only, with stated limitations (engine-only microbench, no agent loop, no model cost); they do not authorise spend. The cost gate is frozen post-pilot from metered pilot means (§8c) and shown to owner before any dev run.

## 12. Disjoint implementation seams (named for a future worker; not built here)

New files only (no edits to frozen TEB seams): `scripts/eval/inspect-cohort/schema.ts` (InspectTask types + validator — PENDING VALIDATION toward SCHEMA-CONTRACT-READY only: shape contracts are not closed until the runtime validator gaps are fixed and fixtures pass; semantic grading still future `Grader:` predicates; no pilot/benchmark readiness is implied); `scripts/eval/inspect-cohort/grade.ts` (pure grader §7 + citation/completeness checks); `scripts/eval/inspect-cohort/run.ts` (durable runner §5/§9 + selector capture + contamination scan); `scripts/eval/inspect-cohort/metrics.ts` (outer/inner/setup-bytes-cost split extractors); `scripts/eval/inspect-cohort/stats.ts` (task-level majority, paired bootstrap, McNemar vetoes, power sizing); `scripts/eval/inspect-cohort/enumerate.ts` (route/import/alias/traversal enumeration scripts); `test/unit/eval/inspect-cohort-*.test.ts` (grader fixtures for EACH output variant — route success / malformed-unknown-key / partial / exhaustive-claim; relation success / unresolved-with-reason / malformed-null-without-reason; conclusion supported-true / supported-false-with-enumeration-and-reference-confirmation / cannot-establish-graded-unknown-not-false; plus correct / near-miss / decoy-fooled / false-completeness / unsupported-claim / negative over-refusal probe); holdout blacklist test asserting forbidden strings never reach prompts. Exact commands: `npx vitest run test/unit/eval/inspect-cohort-*`, `npm run typecheck`, `node scripts/eval/inspect-cohort/enumerate.ts --check`, full `npm test` before any dev run. Adversarial tests required: decoy-fooled answer must fail; renderer-truncated "complete" claim must fail false-completeness; unsupported-syntax claim must fail; unanswerable-with-boundary-citation must pass; contaminated session fixture must grade failure; selector-leakage fixture (guidance hash mismatch) must exclude. Gold-source leakage scan (fair to anchors): task `query`/`input` anchor fields (file paths, symbol names needed to pose the task) MAY appear in prompts; task `answer`-specific hidden content (gold routes/relations/paths/reasons/enumerated universes/hashes) MUST NOT appear in any prompt, log, or fixture input.

## 13. Residual risks

Six pinned repos + TS-centric supported syntax limit generalisation (sensitivity only). Transfer slice is comparability, not superiority. Schema status is pending validation: SCHEMA-CONTRACT-READY will describe closed runtime shape contracts ONLY — never pilot readiness, benchmark improvement, and never an implemented semantic grader — and applies only after the validator gaps are closed and fixtures pass.

## 14. Amendment A1 — latency separated from the effectiveness study (owner-approved 2026-10-10, pre-pilot)

Approved before any inspect pilot, dev, or holdout session ran and before any §8 calibration value was frozen, so no outcome informed it. The owner's priority is accuracy and recall.

- **§8 (d) latency gate becomes report-only.** Cold/warm latency stays in the §8 secondary metrics and is reported per arm with its stated n, but it is not a promotion gate in the pilot, dev, or holdout study. Gates (a) false-completeness, (b) invalid-call, (c) cost, and all inherited gates are unchanged.
- **Separate latency benchmark.** If latency becomes a decision input, it is measured in a separately preregistered benchmark run in an exclusive measurement window (no concurrent development, retrieval, judge, or agent work), reusing the §8 latency definitions.
- **Quiet windows still required for agent sessions.** Pilot, dev, and holdout agent sessions run with no concurrent development or benchmark processes. Reason: the per-task wall cap (§11, 240 s) turns load-induced slowness into ordinary timeouts, which count as task failures (§9), so load could bias accuracy. Paid sessions also cost money to rerun.
- **Disclosure.** Every session records the 1-minute load average at start and end; sessions with load above 2× the machine's idle baseline are flagged descriptively. This amendment does not license reruns based on outcomes.
