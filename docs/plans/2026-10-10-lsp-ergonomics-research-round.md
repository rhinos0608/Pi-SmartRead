# LSP ergonomics: source-grounded research and proposed next round

Status: owner approved option B as the implementation baseline and option C as a benchmark challenger, with instruction to use C if it wins. Exact contracts, statistical adoption criteria, cost admission and benchmark specification are not yet frozen. No agent evaluation or paid benchmark has run. Existing strict LSP contracts and historical TEB task/gold freezes remain authoritative.

## Direction

Keep one model-facing `LSP` tool. Improve addressing and high-value workflows rather than reproducing every JSON-RPC method as another tool. Do not infer that a smaller tool catalog necessarily improves this particular tool's operation enum.

## Primary-source findings

### pi-lens: easier addressing with permissive fallback

Source: https://github.com/apmantza/pi-lens/blob/master/tools/lsp-navigation.ts (resolveSymbolColumn and dispatch coordinate conversion; parent retrieved source).

The resolver accepts 1-based line/character inputs, derives a character from a symbol, supports occurrence suffixes, and internally subtracts one. However, it falls back from a missing requested occurrence to the first occurrence, tries case-insensitive matching, and ultimately uses the first non-whitespace column when the symbol is absent. This is not exact semantic resolution. Borrow the reduction in model arithmetic, not silent fallback.

One-based coordinates do not eliminate stale locations, wrong lines, duplicate identifiers or encoding differences. Those need separate handling and tests. Our existing declaration-name anchors already remove coordinates for declaration-based navigation, but do not select an arbitrary usage occurrence on a source line.

### @narumitw/pi-lsp: workflow-shaped diagnostics and source actions

Sources:
- https://github.com/narumiruna/pi-extensions/blob/main/packages/pi-lsp/src/pi-lsp.ts
- https://github.com/narumiruna/pi-extensions/blob/main/packages/pi-lsp/src/runner.ts (parent retrieved source)

Its two tools focus on diagnostics and source fixes. The fix implementation requests diagnostics, requests/resolves code actions, filters by kind (default `source.fixAll`), rejects overlapping edits, and previews changed text. With `write` enabled it writes directly. Source actions such as `source.fixAll` are not synonymous with resolving every diagnostic; applicability is server-dependent.

Borrow workflow composition and explicit action-kind selection. Do not borrow direct writes: SmartRead must continue to stage proposals and let SmartEdit perform evidence-checked application. No automatic selection/application of an ambiguous action and no unrestricted executeCommand.

### Vendor and paper evidence: relevant, not decisive

- Anthropic, *Writing effective tools for agents*: https://www.anthropic.com/engineering/writing-tools-for-agents (parent retrieved relevant sections). Recommends a few workflow-focused tools, composing frequent call chains, and measuring task success, calls, tokens and tool errors. It does not establish an optimal enum size or prove a universal three-/four-tool architecture.
- *RAG-MCP*: https://arxiv.org/abs/2505.03275 (parent verified abstract). Measures retrieval of relevant tool definitions from a larger catalog. This is evidence about tool selection/catalog exposure, not a controlled test of 37 operations inside one LSP tool.
- *Language Server CLI Empowers Language Agents with Process Rewards*: https://arxiv.org/html/2510.22907v1 (parent retrieved selector section). Describes explicit cursor/range/symbol/content-anchor forms and optional document-version binding. Useful addressing mechanisms, not proof of a frontier-model 0-based versus 1-based advantage.

No confirmed isolated LSP ablation establishes the accuracy gain from changing coordinate base or shrinking one operation enum. Discard the research child's unsupported numerical targets (>70% fewer coordinate errors, >20% symbolic improvement, >50% fewer repeated errors) and its claim that three/four tools are empirically optimal.

## Our current surface: corrected measurement

Parent command, executed in the bets worktree without starting any language server:

`nice -n 10 node --import tsx --input-type=module -e '<import getLspToolSchema/getLspToolDescription; print JSON.stringify(schema).length and description.length>'`

| Surface | Description characters | Serialized schema characters | Total | Estimated tokens (chars/4, rounded up) |
| --- | ---: | ---: | ---: | ---: |
| Strict/off | 1,516 | 5,892 | 7,408 | 1,852 |
| Current affordances/on | 1,755 | 4,978 | 6,733 | 1,684 |

These are static definition sizes, not provider tokenizer measurements or runtime benchmarks. They supersede the scout's estimated ~1,000/~1,140 tokens. Adding capabilities does not necessarily enlarge the serialized definition: the two schema constructions differ.

Off mode has 37 operations. Current affordances add declaration-name anchoring and a bounded `investigate` recipe for definition/type/references/implementations/callers. Strict positions remain 0-based in negotiated server encoding; positive one-based values are structurally valid, so a wrong target can be queried without a validation error.

Relevant implementation: bets `src/lsp/{lsp-tool,affordance-anchor,affordance-investigate}.ts`. Declaration anchors require server-provided selection ranges, exact names and explicit ambiguity/staleness handling. Preserve those properties.

## Approved direction and alternatives

1. **Guidance/errors only.** Keep all inputs unchanged; improve operation grouping, examples and actionable failures. Cheapest and safest, but does not remove coordinate arithmetic or diagnostic/action call chains.
2. **Additive ergonomic front doors (recommended).** Retain strict operations, zero-based `position`, exact routing and proposal application. Experiment with a separately distinguished one-based source-line + exact identifier locator, and a bounded diagnostics-to-action/proposal recipe within the same tool. No silent target guessing and no automatic writes. Existing declaration anchors remain distinct.
3. **Intent-first replacement facade (approved challenger C).** Expose a smaller top-level task vocabulary with an advanced strict-request branch. Benchmark it against B using identical backend capabilities, outputs, budgets and safety constraints. Adopt C if it meets prospectively frozen correctness/safety/compatibility criteria; inconclusive results retain B. Production promotion remains evidence-gated.

Owner authorization covers prototyping and comparing B/C, not an unmeasured default change. Freeze exact field/operation names, limits and winner rule before evaluation. Never silently reinterpret the existing `position.line` or overload existing declaration `symbol` semantics without an explicit discriminator.

## Proposed benchmark, not a preregistration

Use a current-affordances control plus B and C candidates. Match B/C backend capabilities and behavior so their comparison isolates the facade; keep separate paired experiments for addressing/workflow benefits to avoid confounding them with prose changes:

- **Navigation:** current affordances versus the additional source-line locator. Use a new independent cohort without supplied LSP coordinates; retain the existing frozen TEB comparison as a separate historical baseline, not a rewritten cohort.
- **Diagnostics/action proposals:** current explicit diagnostics → codeActions → resolve workflow versus one bounded recipe. Include source actions and individual quick fixes as separate cases. New task family/gold is required; current TEB's LSP families cover navigation, not this workflow.
- **Guidance control:** assess description-only changes separately if introduced. Do not attribute their gains to input/schema changes.

Primary outcomes: independently graded task correctness and exact semantic-target correctness. Secondary: schema/argument failures, silent wrong-target calls, calls/tokens to first correct evidence, task-success denominator, and recovery after input errors. Separate expected ambiguity/unsupported responses from caller-invalid inputs; the existing `invalidCallRate` aggregates several such statuses and cannot answer this distinction by itself.

Controls: absent/ambiguous symbols, duplicate same-line occurrences, comments/string decoys, shadowing, stale source, CRLF and Unicode before a token, exact-server unavailable cases, no-op source actions, multiple eligible actions, unresolved command-only actions, overlapping/multifile proposals, and negative tasks where LSP is unnecessary. Gold comes from pinned source and independent labels, never the production resolver or graph.

Freeze model/provider/thinking, arms, replicate count, ordering, task cap, exclusion rules, cost admission, grading, paired analysis and adoption criteria before results. Do not pool models to hide heterogeneous outcomes or exclude timeouts as mere infrastructure. Admit only comparisons with validated product identities for every arm.

Agent evaluations wait for a quiet window and an audited cost projection/authorization under the existing campaign cap. Latency stays descriptive; if it becomes a decision input, use a separate exclusive latency experiment. No default change until accepted evidence supports it.

Next: specify shared locator/diagnostic backend seams and exact B/C frontends; build disposable, opt-in adapters for the experiments; run fixture/contract and CI checks; freeze independent gold, measurement and adoption rules; benchmark in an admitted quiet window; integrate B or the winning C into production only after acceptance, with Pi/MCP/skills/docs parity and unchanged off-mode snapshots.

## Research provenance

Native research workflow: `9fe833ce-6788-43bc-b4f0-04c2e9c8910b`.

Retained child artifacts (external designs, evidence, current-surface map):
- `d128c41a-0ed4-4f36-8f5d-0bf754c6b3f3_researcher_output.md`
- `621714f5-d1ec-4f32-9acc-ee1853ea45c2_researcher_output.md`
- `e924bb13-9574-4af9-a6e1-c567cfb951a6_scout_output.md`

They live under the parent session's `subagent-artifacts/`. Child reports are research inputs, not authoritative proof; corrected/spot-checked claims are recorded above. Repository links reference mutable upstream branches, not immutable experiment pins. Pin implementations before any comparator experiment.
