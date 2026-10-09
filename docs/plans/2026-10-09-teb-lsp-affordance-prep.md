# TEB LSP-affordance comparison preparation

Status: preparation only; no benchmark runs authorized or performed.

## Arms and eligibility

Use `scripts/eval/teb/arms/lsp-affordance.json` with `--arms baseline,lsp-affordance --arms-config <path>`. The arms use identical task prompts and differ only in `PI_SMARTREAD_AFFORDANCES` (`0` vs `1`); `PI_SMARTREAD_INSPECT_AFFORDANCES` is pinned to `0` in both. Use the existing TEB `instructed` arm only as its diagnostic positive-task control; it is not part of the natural-choice comparison.

Eligible frozen TEB families are the semantic LSP families: `definition`, `all-references`, `implementations`, `callers`, and `type-of-symbol` (protocol §2, lines 144–150). Keep their frozen task definitions, splits, gold, and gates unchanged. Natural-choice outcomes use existing TEB metrics: specialist precision, opportunity recall, task success, negative overuse where applicable, invalid calls, model tokens/cost separately from tool-nested usage, and first-correct latency (protocol §§5, 10–12). No new task content or gold is defined here.

The runner records effective general/inspect selectors and a SHA-256 surface identity for the loaded extension entry file on each session. The latter is a preparation-stage identity proxy; the affordance product's canonical selector/surface/schema/guidance identity interface is not yet available in this worktree. Do not interpret the file hash as the canonical product surface identity. Invalid selector values are recorded under `selectors.invalid` and must be excluded from comparisons by the scoring/reporting stage; confirm that behavior before any run.

## Session envelope and cost projection

No session count is authorized by this preparation. For a selected task set of size `N` and `R` replicates, the natural comparison envelope is `2 × N × R` sessions; an instructed diagnostic adds `R` sessions per eligible positive task, following TEB §9.1–9.3. The TEB maximum roster is 24 pilot × 8 arms × 3 = 576 sessions (protocol §13, lines 746–767), but that is not authorization for this comparison.

Cost projection method: use existing, audited metered-smoke records, summing per-session model `message_end` usage cost and tool-nested usage separately, then report observed per-session distribution and projected arm totals for the exact proposed session count. Existing TEB metering is defined in protocol §10 and implemented in `scripts/eval/teb/extract.ts` (`usageNumbers`/`extractRun`) and `scripts/eval/teb/metrics.ts` (`costTotal`). The scout audit found no completed pilot artifact; decision-log E22 says cost approval and label audit remain pending. Therefore no valid smoke dataset, rate sheet, or numerical projection is available here; any numbers must be marked PROVISIONAL and derived from the actual metered-smoke artifacts before requesting owner approval. No spend is authorized.

## Resource window and blockers

Latency collection requires an exclusive parent-scheduled resource window: no concurrent retrieval, inspect, or judge measurements (common rules §14–17). No latency/resource measurements or runs are performed as part of this preparation.

Blockers before any pilot: TEB label audit and explicit owner cost ceiling approval remain pending (decision log E22, §13); LSP affordance bundle WP-A2/WP-D wiring readiness must be confirmed; WP-B advisory actions and WP-C routes-only remain unbuilt and are not assumed present. The existing protocol is frozen; this lane makes no edits to TEB task/split/gold/gate definitions.
