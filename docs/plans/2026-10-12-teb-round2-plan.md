# TEB round 2 plan: repair the benchmark, then rebuild the LSP bundle (2026-10-12)

Status: **approved direction (owner, 2026-10-12): Option 1 then Option 2** from the redesign review
that followed `2026-10-12-teb-lsp-affordance-pilot-finding.md`. This plan fixes the decisions that
shape the work; the evaluation pre-registration (gates, holdout size, budgets) is a separate document
written after dev calibration and frozen with the owner before any holdout session.

## What round 1 taught us (audited)

- The bundle's new features were used in 2 of 60 sessions. Pilot tasks gave exact coordinates, so
  name anchors were never needed, and nobody discovered `investigate` for callers or references.
  Round 1 compared description wording, not capabilities.
- Agents reach for the operations whose names match the question (`findReferences` 43 calls,
  `goToDefinition` 34, `hover` 18 across both arms). Improvements must land in those outputs, not
  only in new operations.
- `callers-002` was solved once, by `prepareCallHierarchy` + `incomingCalls` (38 ms); read-based
  attempts that tried to identify the enclosing function of each reference ran out of time.
- Unscoped `findReferences` returned 203 bare locations (~73 KB): no enclosing symbol, no indication
  of which hits are imports, no truncation signal.
- Benchmark defects distorted or blurred measurement: false timeouts after settle (harness), exact
  hover-string grading for types (0/12, measured the grader), subpackage-relative paths (18/18
  drizzle sessions began with a path error), undefined "reference" scope for imports.

Design principles kept after source audit (Anthropic "Writing effective tools for agents",
2025-09-11; MetaTool, ICLR 2024; CORE-Bench, arXiv 2606.11864; Xu, arXiv 2608.13568): distinct tool
purposes; high-signal outputs with filtering and explicit truncation plus a follow-up path;
actionable errors; evaluate formats with the target agent; task success is primary, tool-choice
rates are diagnostics; held-out evaluation. Claims the audit could not verify (SWE-agent search
ablation; OpenAI function-calling guidance) are not used.

## Part 1: benchmark repair (prerequisite for any session)

1.1 **Harness: settle-terminated sessions.** After `agent_settled`, wait a bounded grace for exit
    and drain, then reap the process group and record `postSettleReap`; never grade a settled
    session as timed out. Genuine non-settling sessions keep the 240 s watchdog. (In progress.)
1.2 **Why `pi` stays alive after settle.** Diagnose from code now; reproduce locally after the
    retrieval measurement window. If the cause is in SmartRead, fix it in the product with a
    regression test; report the per-arm post-settle reap count in every run regardless.
1.3 **Task-contract rules for all new tasks:**
    - All paths are repository-root relative, in prompts, gold and answers.
    - Reference tasks state explicitly whether import/re-export bindings count; gold follows.
    - Type tasks ask for one specified form (the declared type as written at the declaration, or
      the compiler-reported type of an expression) and the gold lists every adjudicated acceptable
      spelling of that form; grading stays exact over normalized forms (no similarity threshold).
    - At least half of the semantic tasks are coordinate-free: they name the symbol and, where
      needed for uniqueness, its declaring file, but give no line or column.
    - Gold sets for set-valued answers follow explicit inclusion rules stated in the prompt; we do
      not relax `minRecall` to absorb ambiguity — we remove the ambiguity.
1.4 **New task set, authored blind.** Authors receive the family specifications and these rules,
    not the round-1 transcripts, analyses or bundle design. Repositories exclude the six round-1
    repositories. Two independent labelers plus adjudication, as in round 1. Tasks are split into
    a dev set (used to iterate the bundle and calibrate variance) and a holdout sealed by hash before
    any bundle iteration. The 20 round-1 tasks are retired to calibration only.
1.5 **Exposure is measured, not assumed.** Every report gives, per arm and family, the share of
    eligible sessions that used each new capability. If exposure is low, the result is reported as
    "not exercised", not as "no effect".

## Part 2: bundle rebuild

Changes land where agents already are. Each is independently switchable for diagnosis but is
evaluated as one bundle against baseline.

2.1 **Reference results with context.** `findReferences` (and reference-shaped `investigate`
    output) returns hits grouped by file, each with the trimmed source line, the enclosing
    declaration (name and kind), and a role tag: `import`/`export` binding, `declaration`, or `use`.
    Classification is syntactic and fail-open to `use`; it never drops a hit.
2.2 **Scope, budget and truncation.** Reference-shaped results accept a scope (an existing
    workspace-relative file or directory, as for `investigate`) and a result limit, report total
    vs returned counts, state truncation explicitly, and return a cursor for the remainder that is
    bound to the original query and scope.
2.3 **Callers as a first-class answer.** A request for callers (call hierarchy, or references with
    the enclosing declaration) returns caller declarations directly, de-duplicated, with call-site
    lines, so no file reads are needed to name the caller.
2.4 **Type answers.** `hover` returns the declared or compiler-reported type as plain text alongside
    the raw banner, so the agent need not parse markdown or alias banners.
2.5 **Purpose-based descriptions.** Rewrite the LSP description and guidance to state what each
    operation answers and what its output contains, and when grep/read remains the right tool
    (textual occurrences, comments, config). No wording that prefers LSP in general.
2.6 **Kept from round 1:** declaration-name anchors and `investigate`, re-exposed through the
    purpose-based description. Dropped: nothing silently; any removal is listed in the change
    description with its reason.

All changes remain read-only semantics (no mutation paths) and must respect the strict LSP
contract (`docs/lsp-conformance.md`): unknown fields stay caller errors, positions stay 0-based in
the negotiated encoding, and output stays bounded.

## Sequencing and constraints

1. Part 1.1 and 1.2 diagnosis now (no real servers or sessions while retrieval measurement runs).
2. Part 1.3/1.4 task authoring and Part 2 implementation in parallel, on disjoint repositories and
   files. Bundle work branches from PR #50 (`c388cc5` stays unchanged as the round-1 producer).
3. Dev iterations of the bundle on the dev task set only, after the retrieval arms finish (agent
   benchmarks are excluded while retrieval arms run, §9.11).
4. Evaluation pre-registration written from dev variance; owner freezes gates, holdout size and
   budgets; then one holdout run with live-captured identity pins.

Every research or analysis wave is followed by an evidence-audit wave before its claims are used
(campaign decision D-85).

## Open items for the owner (later, with data)

- Holdout size and gate values (after dev calibration).
- Whether to add a second model for transfer once the bundle is stable.
