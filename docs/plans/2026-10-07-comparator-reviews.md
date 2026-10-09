# Comparator reviews — Tool Ergonomics Bench (TEB)

> **Evidence audit summary (2026-10-07):** 33 VERIFIED, 2 CORRECTED, 6 UNVERIFIED, 0 REMOVED (41 total checks). All load-bearing factual claims and quotes independently audited against primary sources; see §5 Audit for per-claim records and URLs fetched. Nothing in the "candidate borrow" notes is adopted; adoption requires a Borrow/Import log entry first (per E6).

Sources:
- Tool-selection benchmarks brief: `subagent-artifacts/48f8766c-c410-48ca-a587-19ad39580cf9_researcher_output.md`
- Code-intel tool comparators brief: `subagent-artifacts/cf1f0ead-652d-4bdd-bb02-fd1a23d66b48_researcher_output.md`
- Binding decision: E6 in `2026-10-07-tool-ergonomics-decision-log.md`

## 1. Purpose + rules

Purpose: record, per comparator, what it is, how it drives adoption, what numbers it publishes (with provenance), what it means for SmartRead, and what we might borrow — without adopting anything yet.

Rules (binding, from E6):
- Every borrow is logged **before** implementation with: comparator, source URL + pinned version/commit if code, mechanism, hypothesis, what we take, licence implications, decision id.
- Retrieval regression guards run on dev only: D46 dev56, internal 44, external grep dev64 title/body, pinned LSP fidelity; comparators ripgrep/Probe/Codanna (grep), pi-lsp/mcp-language-server (LSP), plus pinned Serena where operations are genuinely equivalent; same source, commit, budgets and grader; setup time separated.
- Comparator mechanism, pin, hypothesis and any borrow logged *before* implementation (E6).
- One sealed-holdout opening for one predeclared champion (E6); uptake rising without score is not success.

Borrow/Import log schema (columns in §4): ID, date, comparator, source+pin, mechanism borrowed, hypothesis, licence, decision, status.

## 2. Benchmark-methodology reviews

### 2.1 SWE-agent ACI (SWE-agent: Agent-Computer Interface design & ablations)
- **What it is:** Task resolution on real GitHub issues while manipulating interface affordances (search, view, edit, context). Metric: Pass@1 (% resolved issues on SWE-bench and SWE-bench Lite). Sample: 300 instances on SWE-bench Lite (N=300), 2,294 full test instances evaluated with GPT-4 Turbo.
- **Surface / adoption mechanism:** Windowed file viewer (`open`, `goto`, `scroll_up`, `scroll_down`), summarized search, edit command with synchronous linter feedback; raw bash navigation caused infinite loops and was replaced.
- **Published numbers (SWE-bench Lite, Table 3):** Base SWE-agent **18.0%** ([source](https://arxiv.org/abs/2405.15793)). File viewer window: 100 lines **18.0%** vs 30 lines **14.3%** (down 3.7pp) vs full file **12.7%** (down 5.3pp) ([source](https://arxiv.org/abs/2405.15793)). Search tool: summarized **18.0%** vs iterative **12.0%** (down 6.0pp) vs no search **15.7%** (down 2.3pp) ([source](https://arxiv.org/abs/2405.15793)). Editor: with linting **18.0%** vs without linting **15.0%** (down 3.0pp) vs no edit raw shell/sed **10.3%** (down 7.7pp) ([source](https://arxiv.org/abs/2405.15793)). Context: last 5 observations **18.0%** vs full history **15.0%** (down 3.0pp) ([source](https://arxiv.org/abs/2405.15793)). Grading: repo test-suite execution (fail-to-pass / pass-to-pass); strict temporal holdout from GitHub PRs.
- **Relevance to SmartRead:** Directly motivates TEB arms on windowed vs unbounded `read` and linter/guardrail feedback on invalid `LSP` coordinates; the code-intel brief's ACI note (raw bash → windowed viewer + edit with lint feedback, [source](https://arxiv.org/html/2405.15793v3)) reinforces that unbounded raw search/output hurts while bounded, summarized output helps.
- **Candidate borrow (not yet adopted):** Benchmark windowed vs unbounded `read`; measure how lint/guardrail feedback on invalid `LSP` coordinates affects recovery.

### 2.2 Anthropic tool-writing / advanced tool use
- **What it is:** Anthropic engineering guidance on tool naming, response formats, on-demand tool discovery, code orchestration, and few-shot examples; evaluated on parameter error rates, round-trip counts, accuracy and token consumption via programmatic agentic loops with automated assertions on final output state and token counters.
- **Surface / adoption mechanism:** Tool Search Tool (`defer_loading: true`) — isolates a large tool library behind on-demand discovery; `response_format` enums (`"concise"` vs `"detailed"`); Claude Code restricts tool responses to **25,000 tokens** by default ([sources](https://www.anthropic.com/engineering/writing-tools-for-agents), [sources](https://www.anthropic.com/engineering/advanced-tool-use)).
- **Published numbers:** Tool Search reduces context consumption by **85%** (down to ~8.7K tokens for search + 3–5 active tools) ([source](https://www.anthropic.com/engineering/advanced-tool-use)). On internal MCP evals with large tool libraries: Claude Opus 4 accuracy **49% → 74%** (+25pp); Opus 4.5 **79.5% → 88.1%** (+8.6pp) ([source](https://anthropic.com/engineering/advanced-tool-use)). Brief labels these as internal/self-reported evals.
- **Relevance to SmartRead:** Directly motivates the E6 intervention order item on deferring the 37 strict `LSP` operations behind tool search or programmatic script execution (`inspect mode="script"`), comparing definition bloat against baseline.
- **Candidate borrow (not yet adopted):** Isolate strict `LSP` operations behind deferred tool search or `inspect mode="script"`; compare tool-definition bloat vs baseline.

### 2.3 MCP description-smells study
- **What it is:** Prevalence audit of 18 documentation smell categories across 4 dimensions (accuracy, functionality, completeness, conciseness) plus a controlled mutation test of causal effect on tool selection.
- **Surface / adoption mechanism:** Description quality itself is the mechanism: standard-compliant descriptions win competitive selection; functionality/accuracy smells lose.
- **Published numbers:** Corpus of **10,831 MCP servers** ([source](https://arxiv.org/abs/2602.18914)). Pervasive smells: **73%** repeated tool names; thousands of instances of incorrect parameter semantics or missing return descriptions ([source](https://arxiv.org/abs/2602.18914)). Controlled mutation: functionality smells reduced selection accuracy by **11.6%**, accuracy smells by **8.8%** (p < 0.001, Wilcoxon/bootstrap) ([source](https://arxiv.org/abs/2602.18914)). Standard-compliant descriptions achieved **72%** selection probability vs **20%** baseline (+260%) ([source](https://arxiv.org/abs/2602.18914)).
- **Relevance to SmartRead:** Directly motivates E6 intervention (1), description input examples: audit/ablate `read`, `grep`, `find`, `inspect`, `LSP` docstrings against the 18 smell criteria to measure routing sensitivity.
- **Candidate borrow (not yet adopted):** Docstring audit + ablation against the 18 smell criteria; input-examples intervention first per E6 order.

### 2.4 ToolScope (tool merging + hybrid retrieval)
- **What it is:** Tool selection accuracy in massive toolsets under overlapping semantics and context constraints, via ToolScopeMerger (graph clustering with LLM auto-correction) + ToolScopeRetriever (sparse BM25 + dense embedding + cross-encoder reranking). Evaluated on Seal-Tools, UltraTool, and BFCL.
- **Surface / adoption mechanism:** Merge redundant tools, then hybrid-retrieve the reduced set.
- **Published numbers:** Context length reduction (tokens per query via ToolScopeRetriever): 292,107 → 317 tokens on Seal-Tools (99.9%) and 136,352 → 2,076 tokens on UltraTool (98.5%) [corrected from brief's erroneous claim of tool counts pruned]; toolset size reduction via ToolScopeMerger was 4,076 → 3,992 tools (-2.1%) on Seal-Tools, 1,885 → 1,408 (-25.3%) on UltraTool, and 400 → 344 (-14.0%) on BFCL ([source](https://aclanthology.org/2026.acl-long.1573.pdf)). Selection accuracy gains: **+34.6%** on Seal-Tools, **+38.6%** on UltraTool, **+8.8%** on BFCL ([source](https://aclanthology.org/2026.acl-long.1573.pdf)).
- **Relevance to SmartRead:** Motivates consolidating redundant operations across `grep` (text/structural/ast-grep) and `LSP` (findReferences, documentHighlights) into consolidated semantic interfaces — but consolidation is **not** in the E6 intervention order, so this stays a review note only.
- **Candidate borrow (not yet adopted):** Group redundant `grep`/`LSP` operations into consolidated semantic interfaces (deferred; not in E6 order).

### 2.5 LiveMCPBench / MCP-Universe / MCPToolBench++
- **What it is:** Multi-server MCP testing harnesses combining static structural validation with execution checks.
- **Surface / adoption mechanism:** Static structural validation of operations + execution checks in isolated testbeds.
- **Published numbers:** LiveMCPBench: 95 real-world tasks across 70 servers (527 tools); LiveMCPEval LLM-as-judge with **81%** human agreement; top model (Claude-Sonnet-4) **78.95%** success ([source](https://arxiv.org/html/2508.01780v1)). MCP-Universe: 11 real MCP servers across 6 domains; evaluator triad (format, static, dynamic real-time); success rates GPT-5 **43.72%**, Grok-4 **33.33%**, Claude-4.1-Opus **29.44%** ([source](https://mcp-universe.github.io/)). MCPToolBench++: 1,500 queries across 40+ categories, scoring DAG/AST planning accuracy and Pass@K ([source](https://arxiv.org/abs/2508.07575)). Benchmarks brief flags that model names in early MCP-Universe preprints reflect provider naming at preprint drafting time and public vendor release parity is unverified outside the cited logs.
- **Relevance to SmartRead:** Harness pattern for TEB: static structural validation of code-intelligence operations combined with execution checks in isolated repo testbeds.
- **Candidate borrow (not yet adopted):** Evaluator-triad shape (format/static/dynamic) for TEB graders; no benchmark numbers adopted as targets.

### 2.6 BFCL (Berkeley Function Calling Leaderboard)
- **What it is:** Function-calling benchmark: AST argument matching, executable tool execution, parallel/multi-turn calls, and relevance detection. Dataset ~2,000 instances across Python, Java, JavaScript, SQL, REST APIs.
- **Surface / adoption mechanism:** Exact AST parsing validates strict argument schemas; relevance detection evaluates refusal to invoke tools when no candidate applies.
- **Published numbers:** No point numbers carried in the brief; metrics are AST Accuracy, Execution Success Rate, Relevance Detection Rate ([source](https://gorilla.cs.berkeley.edu/leaderboard)).
- **Relevance to SmartRead:** Exact AST parsing to validate 0-based coordinate schemas and strict arguments for all 37 `LSP` operations; relevance-detection maps to TEB negative controls (E6 loss veto ≤ 3pp on negative controls).
- **Candidate borrow (not yet adopted):** AST-validity grading on 0-based `LSP` coordinates; relevance-detection-style negative controls.

### 2.7 LongFuncEval / EASYTOOL (tool documentation & response context)
- **What it is:** LongFuncEval measures degradation across catalog size, response size, and conversation depth (Tool Response QA over multi-turn API outputs). EASYTOOL compresses documentation into concise instructions.
- **Surface / adoption mechanism:** Truncation/compression of docs and responses preserves reasoning across multi-turn use.
- **Published numbers:** LongFuncEval: catalog size 8K–120K tokens → **7%–85%** drop; response size 10K–80K tokens → **7%** drop on GPT-4o, up to **91%** drop on Mistral-Large; conversation depth → **13%–40%** drop ([source](https://arxiv.org/abs/2505.10570)). EASYTOOL: token footprint reduced by **70.43%** on ToolBench (2,530 → 748 tokens) and **97.35%** on RestBench (3,881 → 103 tokens); retriever NDCG@1 (GPT Ada) **45.7% → 76.7%** ([source](https://aclanthology.org/2025.naacl-long.44)).
- **Relevance to SmartRead:** Test how truncating `grep`/`read` output chunks preserves agent reasoning across multi-turn debugging; doc compression relates to description-examples intervention.
- **Candidate borrow (not yet adopted):** Chunk-truncation sensitivity arm on `grep`/`read` output; doc-compression treatment of tool descriptions.

### 2.8 Tool opportunity metrics & forced-vs-natural routing (TOOLRET / Ragas / HiL-Bench)
- **What it is:** Formulations (derived from ToolRet, Ragas, HiL-Bench) for whether agents invoke tools when optimal and efficiency under unconstrained vs prescribed routing.
- **Surface / adoption mechanism:** Metric definitions, not a surface: Tool Opportunity Recall (TOR) = tasks where necessary tool T was invoked / tasks where T is required-or-optimal; Tool Precision (TP) = valid task-relevant invocations of T / total invocations of T; forced-vs-natural routing efficiency compares token cost, steps, pass rate between Natural (all 5 tools) and Ablated/Forced modes (e.g. forcing `grep`+`read` vs allowing `LSP` goToDefinition).
- **Published numbers:** No point numbers carried in the brief; metric formulations adapted from [TOOLRET](https://aclanthology.org/2025.findings-acl.1258.pdf), [Ragas](https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/agents/), [HiL-Bench](https://arxiv.org/html/2604.09408v2).
- **Relevance to SmartRead:** These are TEB's secondary metrics per E6 (opportunity recall, specialist-call precision); labels record opportunity, never mandate (E6); instructed-specialist arm is a diagnostic upper bound only.
- **Candidate borrow (not yet adopted):** TOR/TP + forced-vs-natural routing efficiency as TEB secondary metrics (already reflected in E6).

## 3. Tool-surface reviews

### 3.1 Serena (oraios/serena)
- **What it is:** MCP server for high-level semantic retrieval & edit across 40+ languages (via LSP or JetBrains IDE backends) ([source](https://github.com/oraios/serena)).
- **Surface / adoption mechanism:** Operates exclusively at symbol level — file outline, symbol hierarchies, project-wide relations — intentionally abstracting away line/column coordinates.
- **Published numbers:** [unverified] None published.
- **Relevance to SmartRead:** Pinned Serena is an E6-named LSP comparator where operations are genuinely equivalent; symbol-level abstraction is the counterpoint to SmartRead's strict 0-based coordinates.
- **Candidate borrow (not yet adopted):** None — comparator role only.

### 3.2 agent-lsp (blackwell-systems/agent-lsp)
- **What it is:** 65 MCP tools in a Go binary across 30 CI-verified languages, bundling sequential calls into high-level endpoints like `blast_radius` plus speculative editing tools ([source](https://github.com/blackwell-systems/agent-lsp)).
- **Surface / adoption mechanism:** 24 named workflow skills (e.g. `/lsp-impact`, `/lsp-refactor`, `/lsp-safe-edit`) exposed as slash commands and MCP prompts to chain multi-step analysis; ships the observation "Raw tools get ignored. Skills get used."
- **Published numbers:** CI-verified across 30 languages; no retrieval benchmark.
- **Relevance to SmartRead:** Compound-macro-skills pattern maps to E6 items (3) inspect named views and (5) optional LSP task presets; skill-delivery is evaluated separately per E6 isolation rules.
- **Candidate borrow (not yet adopted):** Compound tools like `blast_radius(symbol)` / `safe_refactor_preview(old, new)` instead of manual `findReferences` → `incomingCalls` → `diagnostics` chains.

### 3.3 mcp-language-server (isaacphi/mcp-language-server)
- **What it is:** Standard 6-primitive Go MCP implementation ([source](https://github.com/isaacphi/mcp-language-server)).
- **Surface / adoption mechanism:** Direct MCP tool discovery; 6 primitives (`definition`, `references`, `diagnostics`, `hover`, `rename_symbol`, `edit_file`) using 1-based line numbers.
- **Published numbers:** Community stars (1.5k as reported in brief; currently ~1.6k); no formal eval.
- **Relevance to SmartRead:** E6-named LSP comparator (with pi-lsp); granularity contrast: 6 primitives vs SmartRead's 37 strict operations.
- **Candidate borrow (not yet adopted):** None — comparator role only.

### 3.4 SuPi (@mrclrchtr/supi-code-intelligence)
- **What it is:** Pi extension with 8 tools (`code_orientation`, `code_resolve`, `code_inspect`, `code_graph`, `code_find`, `code_health`, `code_refactor_plan`, `code_refactor_apply`) ([source](https://pi.dev/packages/@mrclrchtr/supi-code-intelligence)).
- **Surface / adoption mechanism:** Target handles — `code_resolve` maps symbols/queries to opaque `targetId` handles, isolating downstream inspection/graph navigation from coordinate shifts; staged refactor preview. Uses 1-based line/col alongside handles.
- **Published numbers:** [unverified] None published.
- **Relevance to SmartRead:** Opaque-handle pattern is E6 intervention (6), last resort only if `{path,symbol}` anchors fail; strict LSP validation and proposal-only semantics preserved regardless.
- **Candidate borrow (not yet adopted):** Opaque target handles (`code_resolve` → `targetId`) replacing raw `(line, character)` in high-level operations; gated behind anchor failure per E6 order.

### 3.5 pi-lens (apmantza/pi-lens)
- **What it is:** Pi extension registering 6 active + 6 dynamic tools (16 MCP mirrors) ([source](https://github.com/apmantza/pi-lens)); agent guide at [agent-guide.md](https://github.com/apmantza/pi-lens/blob/master/docs/agent-guide.md).
- **Surface / adoption mechanism:** Discovery funnel `symbol_search` (BM25 word index) → `module_report` (tree-sitter outline) → `read_symbol`/`read_enclosing`; auto-expands small reads (≤100 lines) to enclosing symbol boundaries; accumulates read coverage to enforce read-before-edit safety.
- **Published numbers:** [unverified] Internal telemetry; no formal public benchmark.
- **Relevance to SmartRead:** Funnel discipline + opportunistic expansion maps to E6 items (2) stateless anchors and (3) inspect named views; read-guard is a safety analogue, not a TEB arm.
- **Candidate borrow (not yet adopted):** 3-step funnel discipline; auto-widen narrow reads (≤100 lines) to enclosing AST boundaries.

### 3.6 pi-scope (dmoreq/pi-scope)
- **What it is:** Pi extension: ambient AST-index injection + LSP nav ([source](https://github.com/dmoreq/pi-scope)).
- **Surface / adoption mechanism:** Zero-overhead context injection — compact AST skeletons (function/class signatures, 8–15% of file size) injected into prompt turns alongside reverse dependency graphs; no explicit agent tool call required.
- **Published numbers:** Claims **~85–96%** token savings over full-file reads — self-reported ([source](https://github.com/dmoreq/pi-scope)).
- **Relevance to SmartRead:** Ambient-injection counterpoint to active tool-calling; E6 isolates ambient skills/context out of TEB arms (`--no-skills --no-context-files`), so this mechanism is explicitly out of the TEB comparison.
- **Candidate borrow (not yet adopted):** None — mechanism excluded from TEB by E6 isolation; noted for contrast only.

### 3.7 pi-shazam (pi-shazam)
- **What it is:** Pi extension with 7 structural-awareness tools (`shazam_overview`, `shazam_lookup`, `shazam_impact`, `shazam_verify`, `shazam_changes`, `shazam_format`, `shazam_rename_symbol`) backed by prebuilt tree-sitter WASMs ([source](https://pi.dev/packages/pi-shazam)).
- **Surface / adoption mechanism:** Unified overview + post-edit verify returning PASS/WARN/FAIL.
- **Published numbers:** [unverified] None published.
- **Relevance to SmartRead:** Post-edit verify pattern parallels the Claude Code `PostToolUse` diagnostic-hook idea within SmartRead's proposal-only semantics.
- **Candidate borrow (not yet adopted):** Post-write diagnostic feedback on edit/write (diagnostics appended to tool result); no adoption yet.

### 3.8 Claude Code LSP tool (+ ecosystem)
- **What it is:** Single unified built-in `LSP` tool with 9 operations (`goToDefinition`, `findReferences`, `hover`, `documentSymbol`, `workspaceSymbol`, `goToImplementation`, `prepareCallHierarchy`, `incomingCalls`, `outgoingCalls`) taking `(filePath, line, character)` ([source](https://github.com/boostvolt/claude-code-lsps)).
- **Surface / adoption mechanism:** Enabled via `ENABLE_LSP_TOOL=1`; LSP servers integrated via `.claude-plugin/marketplace.json` (`lspServers` schema, [source](https://github.com/zircote/lsp-marketplace)); paired with `PostToolUse` hooks triggering automated LSP diagnostics/lint on `Write|Edit`.
- **Published numbers:** [unverified] General Claude Code SWE-bench scores; unablated LSP impact (per brief).
- **Relevance to SmartRead:** Closest surface analogue to SmartRead's strict `LSP` tool; `PostToolUse` diagnostic hooks map to a candidate TEB-adjacent feedback mechanism.
- **Candidate borrow (not yet adopted):** Post-write diagnostic hook (every successful edit/write returns compiler errors/warnings in the tool result payload).

### 3.9 Aider repo map
- **What it is:** Ambient repo-map: parses repo via tree-sitter AST, builds a symbol reference graph, runs PageRank, binary-searches definitions to fit an exact budget (default 1k tokens) injected into every prompt ([source](https://aider.chat/2023/10/22/repomap.html)).
- **Surface / adoption mechanism:** Ambient prompt injection fitting `--map-tokens` (default 1k); no tool call needed.
- **Published numbers:** **26.3%** resolve rate on SWE-bench Lite with **70.3%** correct file identification — self-reported, credited to the tree-sitter PageRank repo-map though unablated from the full agent loop (per brief; [source](https://aider.chat/2024/05/22/swe-bench-lite.html) [corrected from 2023/10/22/repomap.html]).
- **Relevance to SmartRead:** Ambient-injection counterpoint; like pi-scope, excluded from TEB arms by E6 ambient-context isolation.
- **Candidate borrow (not yet adopted):** None — noted for contrast only.

### 3.10 Cursor search / Sourcegraph Cody (industrial assistants)
- **What it is:** Cursor: Merkle tree of file/dir hashes for client-server deltas, `simhash` vector to reuse teammate indexes, syntactic code-chunk embeddings ([source](https://cursor.com/blog/secure-codebase-indexing)). Cody: moved from pure OpenAI `text-embedding-ada-002` vectors to hybrid context via native Search API + local AST/keyword indexing (symf) ([source](https://sourcegraph.com/blog/how-cody-understands-your-codebase)).
- **Surface / adoption mechanism:** Cursor: automatic query augmentation on chat/composer turns. Cody: ambient context + explicit user `@`-tagging.
- **Published numbers:** Cursor (self-reported): semantic search improved response accuracy by **12.5%** on average; p99 onboarding from 4.03 hours to **21 seconds** ([source](https://cursor.com/blog/secure-codebase-indexing)). Cody: [unverified] production enterprise telemetry; no standalone public eval.
- **Relevance to SmartRead:** The briefs' central contradiction — Cursor attributes +12.5% to vector semantic search while Cody discarded embeddings for native search + AST keywords (storage, staleness, privacy). TEB's AST-symbol vs BM25 vs semantic comparator harness (RepoBench-R adaptation, SWE-bench Lite localization slice, CodeSearchNet-style docstring→implementation pairs) is the instrument that adjudicates this for SmartRead's hybrid (BM25 + AST-symbol + semantic graph).
- **Candidate borrow (not yet adopted):** RepoBench-R adaptation for JS/TS (Acc@1/Acc@5 on cropped cross-file references); SWE-bench Lite localization slice (Hit@1/Hit@5/MRR); AST-symbol vs BM25 vs semantic comparator harness. Benchmark sources: [RepoBench](https://arxiv.org/abs/2306.03091), [CoIR](https://aclanthology.org/2025.acl-long.1072), [CodeSearchNet](https://github.com/github/CodeSearchNet), [LocAgent/LOC-BENCH](https://www.alphaxiv.org/abs/2503.09089), [RGFL](https://arxiv.org/html/2601.18044v1).

### 3.11 SWE-agent ACI (surface recap) / OpenHands note
- Covered as a benchmark in §2.1; as a surface: 4 flagship tools (view, search, edit, submit) with file + 1-based line ranges; fixed action protocol with instant linting feedback on edit (NeurIPS 2024 SWE-bench baseline). OpenHands note (from code-intel brief): initially bash-based ACI editing, attempted `multilspy` integration (Issue #1934 stalled), now parses Claude plugin `lspServers` in its SDK (Issue #1745) — no numbers carried.
- **Candidate borrow (not yet adopted):** None beyond §2.1.

## 4. Borrow/Import log

| ID | Date | Comparator | Source + pin | Mechanism borrowed | Hypothesis | Licence | Decision | Status |
|----|------|------------|--------------|--------------------|------------|---------|----------|--------|
| B1 (C2 filename prefix) | 2026-10-08 | Probe | `github.com/probelabs/probe@v0.6.0-rc341` `src/search/result_ranking.rs:160-174` — `doc.push_str("// Filename: ");` | Ranked documents prepend the file path as a `// Filename:` header so filename terms score in BM25. | Enabling SmartRead's existing `PI_SMARTREAD_GREP_RANK_FILENAME` knob (same construction) recovers title queries whose terms name the file (#4 brokenLinks, #6 Sphere.js, #16/#17 css-prune). | Apache-2.0: mechanism-only reimplementation, no code copied, NOTICE not required unless code is copied | E15 | logged — not implemented |
| B2 (C4 NL-only Snowball stemming) | 2026-10-08 | Probe | `github.com/probelabs/probe@v0.6.0-rc341` `src/ranking.rs:37-39` — STEMMER.get_or_init(\|\| Stemmer::create(Algorithm::English)); `src/search/tokenization.rs:2682-2710` (`tokenize_and_stem`), `2728-2810` (`tokenize`) | Query and document tokens are reduced with an English Snowball stemmer after case/split normalisation. | Applying Snowball-English stemming to NL ranking only (identifier/exact channels untouched) closes morphological gaps (#5 serialization/serialize, #16/#17 selector/selectors, #20 computed/compute). Algorithm substitution: original Porter (1980) instead of Snowball-English (Porter2) — dependency-free, written from the published algorithm; Porter2 differs on a small set of rules | Apache-2.0: mechanism-only reimplementation, no code copied, NOTICE not required unless code is copied | E15 | implemented behind knob, default off (`PI_SMARTREAD_GREP_RANK_STEM`; stemming gated on the shared NL-query classifier, identifier-shaped queries never stemmed) |
| B3 (C6 BM25 b=0.5 + coverage boost) | 2026-10-08 | Probe | `github.com/probelabs/probe@v0.6.0-rc341` `src/ranking.rs:360-364` — `let k1 = 1.5; // EXPERIMENT: Slightly increased from 1.2 for balanced term frequency weight` / `let b = 0.5; // EXPERIMENT: Moderately reduced from 0.75 for balanced length normalization`; `src/search/result_ranking.rs:8-18` — `1.0 + coverage.powf(1.5) * 2.0 // Max 3x boost for 100% coverage` | BM25 uses b=0.5 (k1=1.5) and multiplies the score by a coverage boost of up to 3x at full unique-term coverage. | A `b: 0.75 → 0.5` + coverage-boost preset counters whole-file dilution where gold has high token coverage but modest TF (#14, #18, #19-body). | Apache-2.0: mechanism-only reimplementation, no code copied, NOTICE not required unless code is copied | E15 | logged — not implemented |
| B4 (C3 stronger test/sample/docs demotion) | 2026-10-08 | Probe | `github.com/probelabs/probe@v0.6.0-rc341` `src/search/file_processing.rs:546-571` — `if !ctx.params.allow_tests && is_test_file(ctx.params.path) {`; `src/search/result_ranking.rs:86` — node_type if node_type.contains("test") \|\| node_type.contains("Test") => 0.7, | Test files and test-bearing blocks are excluded (default `allow_tests=false`) or down-weighted 0.7x instead of competing at near-full weight. | Excluding (diagnostic) or more strongly demoting test/sample/docs in default NL corpora removes sample-config sweeps that outrank gold (#13, #15, #17, #19, #22). | Apache-2.0: mechanism-only reimplementation, no code copied, NOTICE not required unless code is copied | E15 | logged — not implemented |
| B5 (C5 stopword filtering) | 2026-10-08 | Probe | `github.com/probelabs/probe@v0.6.0-rc341` `src/search/tokenization.rs:882` (`ENGLISH_STOP_WORDS`), `1066` (`PROGRAMMING_STOP_WORDS`), `2101-2104` (`is_stop_word`), `2795` — `// Skip both English and programming stop words` | English function words and programming keywords are dropped from the token stream before scoring. | Filtering stopwords on NL-shaped queries concentrates IDF on discriminative terms in long diluted bodies (#1, #2, #3, #11, #14, #23, #26). | Apache-2.0: mechanism-only reimplementation, no code copied, NOTICE not required unless code is copied | E15 | logged — not implemented |
| B6 (AST-block ranking spike) | 2026-10-08 | Probe | `github.com/probelabs/probe@v0.6.0-rc341` `src/search/file_processing.rs:1087-1240` (`process_file_with_results` → `parse_file_for_code_blocks_with_tree(`); `src/search/result_ranking.rs:21-95` (`calculate_node_type_boost`, e.g. function/method 2.0x) | Files are split into tree-sitter AST blocks that are scored and boosted individually (functions/methods 2.0x) instead of scoring whole files. | A bounded retrieval-only spike (whole-file vs AST-block ranking at identical tokenization/budgets, distinct-file scoring) tests whether block units fix far-miss dilution (#14, #18) without changing public result units or the SmartEdit contract. | Apache-2.0: mechanism-only reimplementation, no code copied, NOTICE not required unless code is copied | E15 | logged — not implemented |

*Rows B1–B6 logged per E14(c)/E15 before implementation; all Probe source verified by fetch at tag v0.6.0-rc341 (LICENSE is `Apache License` / `Version 2.0, January 2004`; `Cargo.toml:13` declares `license = "MIT"`; borrowing stays mechanism-level so either licence is satisfied). Quotes above are verbatim fetched text.*

## 5. Audit

Audit conducted 2026-10-07. Every load-bearing factual claim (all numbers, tool counts, surface descriptions, and quoted text) across §§2.1–2.8 and §§3.1–3.11 was checked against the fetched primary source.

Summary: **33 VERIFIED**, **2 CORRECTED**, **6 UNVERIFIED**, **0 REMOVED** (41 total checks).

| # | Section & Subject | Claim Checked | Status | URL Fetched | Verification Evidence & Notes |
|---|---|---|---|---|---|
| 1 | §2.1 SWE-agent ACI | Sample size (300 Lite instances, 2,294 full test instances) & baseline pass rate (18.0% Lite, 12.47% Full with GPT-4 Turbo) | **VERIFIED** | https://arxiv.org/abs/2405.15793 (v3) | Confirmed in paper Section 5 and Table 3 (54/300 on Lite = 18.00%; 286/2294 on Full = 12.47%). |
| 2 | §2.1 SWE-agent ACI | Table 3 File viewer ablations: 100 lines 18.0% vs 30 lines 14.3% (-3.7pp) vs full file 12.7% (-5.3pp) | **VERIFIED** | https://arxiv.org/abs/2405.15793 (v3) | Confirmed verbatim in Table 3 of the paper. |
| 3 | §2.1 SWE-agent ACI | Table 3 Search tool ablations: summarized 18.0% vs iterative 12.0% (-6.0pp) vs no search 15.7% (-2.3pp) | **VERIFIED** | https://arxiv.org/abs/2405.15793 (v3) | Confirmed verbatim in Table 3 of the paper. |
| 4 | §2.1 SWE-agent ACI | Table 3 Editor ablations: with linting 18.0% vs without linting 15.0% (-3.0pp) vs no edit 10.3% (-7.7pp) | **VERIFIED** | https://arxiv.org/abs/2405.15793 (v3) | Confirmed verbatim in Table 3 of the paper. |
| 5 | §2.1 SWE-agent ACI | Table 3 Context ablations: last 5 observations 18.0% vs full history 15.0% (-3.0pp), w/o demo 16.3% (-1.7pp) | **VERIFIED** | https://arxiv.org/abs/2405.15793 (v3) | Confirmed verbatim in Table 3 of the paper. |
| 6 | §2.2 Anthropic Guidance | Claude Code restricts tool responses to 25,000 tokens by default; `response_format` enum (`"concise"` vs `"detailed"`) | **VERIFIED** | https://www.anthropic.com/engineering/writing-tools-for-agents | Confirmed verbatim: "For Claude Code, we restrict tool responses to 25,000 tokens by default" and ResponseFormat enum definition. |
| 7 | §2.2 Anthropic Advanced Tool Use | Tool Search Tool (`defer_loading: true`) reduces context consumption by 85% (down to ~8.7K tokens for search + 3–5 active tools) | **VERIFIED** | https://www.anthropic.com/engineering/advanced-tool-use | Confirmed verbatim: "85% reduction in token usage", "~8.7K tokens" total consumption, and `defer_loading: true` schema. |
| 8 | §2.2 Anthropic Advanced Tool Use | Internal MCP eval accuracy improvements: Claude Opus 4 49% → 74% (+25pp), Opus 4.5 79.5% → 88.1% (+8.6pp) | **VERIFIED** | https://www.anthropic.com/engineering/advanced-tool-use | Confirmed verbatim: "Opus 4 improved from 49% to 74%, and Opus 4.5 improved from 79.5% to 88.1% with Tool Search Tool enabled." |
| 9 | §2.3 MCP Description Smells | Corpus of 10,831 MCP servers; 73% repeated tool names prevalence; missing return/parameter semantics | **VERIFIED** | https://arxiv.org/abs/2602.18914 | Confirmed in abstract and text: "10,831 MCP servers", "73% repeated tool names", pervasive parameter/return smells. |
| 10 | §2.3 MCP Description Smells | Controlled mutation impact: functionality smells drop accuracy by 11.6%, accuracy smells by 8.8% (p < 0.001) | **VERIFIED** | https://arxiv.org/abs/2602.18914 | Confirmed in paper abstract: "functionality and accuracy having the largest effects (+11.6% and +8.8%, p < 0.001)". |
| 11 | §2.3 MCP Description Smells | Standard-compliant descriptions achieve 72% selection probability vs 20% baseline (+260% relative) | **VERIFIED** | https://arxiv.org/abs/2602.18914 | Confirmed in paper abstract: "standard-compliant descriptions reach 72% selection probability (260% over a 20% baseline)". |
| 12 | §2.4 ToolScope | Toolset pruning numbers conflated with prompt context token reduction; actual toolset pruning vs context token reduction | **CORRECTED** | https://aclanthology.org/2026.acl-long.1573.pdf | Corrected: 292,107 → 317 tokens (99.9%) on Seal-Tools and 136,352 → 2,076 tokens (98.5%) on UltraTool represent average per-query context length (tokens) via ToolScopeRetriever (Table 8 / §4.4), not tool counts pruned. Toolset sizes via ToolScopeMerger (Table 6) were pruned 4,076 → 3,992 (-2.1%) on Seal-Tools, 1,885 → 1,408 (-25.3%) on UltraTool, and 400 → 344 (-14.0%) on BFCL. |
| 13 | §2.4 ToolScope | Tool selection accuracy gains: +34.6% on Seal-Tools, +38.6% on UltraTool, +8.8% on BFCL | **VERIFIED** | https://aclanthology.org/2026.acl-long.1573.pdf | Confirmed in paper contributions (p. 2), Table 2, and conclusions (p. 9). |
| 14 | §2.5 LiveMCPBench | 95 daily tasks, 70 servers (527 tools), LiveMCPEval LLM judge 81% human agreement, Claude-Sonnet-4 78.95% | **VERIFIED** | https://arxiv.org/abs/2508.01780 | Confirmed in paper abstract and leaderboard: 95 tasks, 70 servers, 527 tools, 81% agreement, Sonnet-4 top at 78.95%. |
| 15 | §2.5 MCP-Universe | 11 MCP servers across 6 domains, evaluator triad (format, static, dynamic), GPT-5 43.72%, Grok-4 33.33%, Claude-4.1-Opus 29.44% | **VERIFIED** | https://mcp-universe.github.io/ | Confirmed on leaderboard and paper abstract (arXiv:2508.14704): 11 servers, 6 domains, ReAct track SRs 43.72%, 33.33%, 29.44%. |
| 16 | §2.5 MCPToolBench++ | 1,500 queries across 40+ categories, AST/DAG planning accuracy and Pass@K | **VERIFIED** | https://arxiv.org/abs/2508.07575 | Confirmed in paper abstract and Section 4.1: 1.5K question-answer pairs, 40+ categories, AST DAG Accuracy, Pass@K. |
| 17 | §2.6 BFCL | Benchmark scope (~2,000 instances across Python, Java, JS, SQL, REST APIs); AST Accuracy, Execution Success, Relevance Detection | **VERIFIED** | https://gorilla.cs.berkeley.edu/leaderboard | Confirmed via BFCL documentation/v1-v4 blogs: ~2,000 instances across 5 language domains; AST, Executable, Relevance metrics. |
| 18 | §2.7 LongFuncEval | Performance drops across catalog size (7%–85%), response size (7%–91%), and conversation depth (13%–40%) | **VERIFIED** | https://arxiv.org/abs/2505.10570 | Confirmed in paper abstract: 7% to 85% catalog drop, 7% to 91% response size drop, 13% to 40% conversation depth drop. |
| 19 | §2.7 EASYTOOL | Token reduction on ToolBench (70.43%, 2,530 → 748 tokens) and RestBench (97.35%, 3,881 → 103 tokens); retriever NDCG@1 (45.7% → 76.7%) | **VERIFIED** | https://aclanthology.org/2025.naacl-long.44.pdf | Confirmed in Table 3 (TokenDoc/TokenIns/Reduce) and Table 5 (Ada retriever NDCG@1: 45.7% vs 76.7% with EASYTOOL). |
| 20 | §2.8 Tool Opportunity Metrics | Metric formulations (TOR, TP, routing efficiency) adapted from TOOLRET, Ragas, and HiL-Bench; no empirical point numbers carried | **VERIFIED** | https://aclanthology.org/2025.findings-acl.1258.pdf, https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/agents/, https://arxiv.org/abs/2604.09408 | Confirmed: TOOLRET addresses tool retrieval; Ragas documents ToolCallAccuracy/ToolCallF1; HiL-Bench addresses human escalation (Ask-F1). Formulations in TEB are conceptual adaptations. |
| 21 | §3.1 Serena | MCP server for high-level semantic retrieval & edit across 40+ languages via LSP or JetBrains IDE backends, abstracting line/col coordinates | **VERIFIED** | https://github.com/oraios/serena | Confirmed in repository documentation and architecture description. |
| 22 | §3.1 Serena Benchmark Numbers | Public retrieval benchmark numbers for Serena | **UNVERIFIED** | https://github.com/oraios/serena | Verified that no public benchmark results are published by the project; marked [unverified] in text. |
| 23 | §3.2 agent-lsp | 65 MCP tools in Go across 30 languages, 24 named workflow skills; verbatim quotation "Raw tools get ignored. Skills get used." | **VERIFIED** | https://github.com/blackwell-systems/agent-lsp | Confirmed in repo README ("Raw tools get ignored. Skills get used.", 65 tools, 30 languages, Go binary) and `docs/guide/skills.md` (24 named skills). |
| 24 | §3.3 mcp-language-server | 6 primitives (definition, references, diagnostics, hover, rename_symbol, edit_file) in Go using 1-based indexing; ~1.5k stars | **VERIFIED** | https://github.com/isaacphi/mcp-language-server | Confirmed in `tools.go` (1-indexed startLine/endLine and line/column) and GitHub repository metadata (~1.6k stars). |
| 25 | §3.4 SuPi | 8 tools, opaque targetId handles, 1-based coordinates, staged refactor preview (plan/apply) | **VERIFIED** | https://pi.dev/packages/@mrclrchtr/supi-code-intelligence | Confirmed in package README: 8 tools registered, 1-based lines/cols, target handle resolution, code_refactor_plan / apply. |
| 26 | §3.4 SuPi Benchmark Numbers | Public retrieval benchmark numbers for SuPi | **UNVERIFIED** | https://pi.dev/packages/@mrclrchtr/supi-code-intelligence | Verified that no public benchmark numbers exist for the package; marked [unverified] in text. |
| 27 | §3.5 pi-lens | 6 active + 6 dynamic tools (16 MCP mirrors), discovery funnel, ≤100-line auto-expansion, read-guard safety | **VERIFIED** | https://github.com/apmantza/pi-lens | Confirmed in `docs/agent-guide.md`: symbol_search → module_report → read_symbol/read_enclosing funnel, ≤100-line symbol expansion, read-guard, 16 MCP mirrors. |
| 28 | §3.5 pi-lens Benchmark Numbers | Published benchmark numbers for pi-lens | **UNVERIFIED** | https://github.com/apmantza/pi-lens | Internal telemetry only; no public formal benchmark exists; marked [unverified] in text. |
| 29 | §3.6 pi-scope | Ambient AST-index injection (8–15% file size), ~85–96% token savings self-reported | **VERIFIED** | https://github.com/dmoreq/pi-scope | Confirmed in repository description: AST skeletons, ~85-96% token savings claim. |
| 30 | §3.7 pi-shazam | 7 structural awareness tools, prebuilt tree-sitter WASMs, post-edit PASS/WARN/FAIL verification | **VERIFIED** | https://pi.dev/packages/pi-shazam | Confirmed in package README: 7 tools (`shazam_overview` through `shazam_rename_symbol`), prebuilt WASMs, PASS/WARN/FAIL verify. |
| 31 | §3.7 pi-shazam Benchmark Numbers | Public retrieval benchmark numbers for pi-shazam | **UNVERIFIED** | https://pi.dev/packages/pi-shazam | Verified that no public benchmark numbers exist for the package; marked [unverified] in text. |
| 32 | §3.8 Claude Code LSP Tool | Built-in LSP tool with 9 operations taking (filePath, line, character), ENABLE_LSP_TOOL=1, marketplace lspServers, PostToolUse hooks | **VERIFIED** | https://github.com/boostvolt/claude-code-lsps, https://github.com/zircote/lsp-marketplace | Confirmed: 9 operations taking (filePath, line, character), ENABLE_LSP_TOOL=1, marketplace.json lspServers schema, and PostToolUse Write\|Edit hooks in zircote/lsp-marketplace. |
| 33 | §3.8 Claude Code LSP Benchmark Numbers | Unablated LSP impact on SWE-bench | **UNVERIFIED** | https://github.com/boostvolt/claude-code-lsps | Standalone LSP impact is unablated in public reports; marked [unverified] in text. |
| 34 | §3.9 Aider Repo Map (Mechanism) | Tree-sitter repo map PageRank and --map-tokens (default 1k tokens) | **VERIFIED** | https://aider.chat/2023/10/22/repomap.html | Confirmed in blog post: tree-sitter AST symbol reference graph, PageRank/graph ranking algorithm, --map-tokens default 1k. |
| 35 | §3.9 Aider Repo Map (SWE-bench Lite Score) | 26.3% resolve rate on SWE-bench Lite with 70.3% correct file identification misattributed to 2023-10-22 post | **CORRECTED** | https://aider.chat/2024/05/22/swe-bench-lite.html | Corrected source URL: The 2023-10-22 post predates SWE-bench Lite and contains no evaluation numbers. The 26.3% resolve rate and 70.3% file identification appear in the 2024-05-22 post "How aider scored SOTA 26.3% on SWE Bench Lite". |
| 36 | §3.10 Cursor Search | Merkle tree delta sync, simhash vector index reuse, syntactic chunks, +12.5% accuracy, p99 setup 4.03h → 21s | **VERIFIED** | https://cursor.com/blog/secure-codebase-indexing | Confirmed in Cursor blog: Merkle tree sync, simhash teammate index reuse, +12.5% accuracy evaluation, 99th percentile setup time 4.03 hours to 21 seconds. |
| 37 | §3.10 Sourcegraph Cody | Shift from OpenAI ada-002 embeddings to native Search API + BM25/AST keyword indexing (symf) | **VERIFIED** | https://sourcegraph.com/blog/how-cody-understands-your-codebase | Confirmed in Sourcegraph blog: leaving embeddings behind, native search platform, adapted BM25 ranking, Tree-sitter intent classification. |
| 38 | §3.10 Cody Benchmark Numbers | Production enterprise telemetry eval for Cody | **UNVERIFIED** | https://sourcegraph.com/blog/how-cody-understands-your-codebase | No standalone public evaluation published; marked [unverified] in text. |
| 39 | §3.10 Benchmark References | External benchmark papers cited (RepoBench, CoIR, CodeSearchNet, LocAgent, RGFL) | **VERIFIED** | https://arxiv.org/abs/2306.03091, https://aclanthology.org/2025.acl-long.1072, https://github.com/github/CodeSearchNet, https://arxiv.org/abs/2503.09089, https://arxiv.org/abs/2601.18044 | Confirmed: All 5 cited code retrieval/localization benchmark papers exist and correspond to the described retrieval tasks. |
| 40 | §3.11 SWE-agent & OpenHands | SWE-agent 4 tools with 1-based indexing; OpenHands multilspy issue #1934 and plugin lspServers SDK issue #1745 | **VERIFIED** | https://arxiv.org/abs/2405.15793, https://github.com/OpenHands/OpenHands/issues/1934, https://github.com/OpenHands/software-agent-sdk/issues/1745 | Confirmed: SWE-agent tools and 1-based coordinates in NeurIPS 2024 paper; OpenHands/OpenHands#1934 (multilspy integration closed/stalled); OpenHands/software-agent-sdk#1745 (marketplace.json lspServers parsing). |
| 41 | Quoted Text Check (All) | Quoted phrases in document: `"concise"` vs `"detailed"` (§2.2), `"Raw tools get ignored. Skills get used."` (§3.2) | **VERIFIED** | https://www.anthropic.com/engineering/writing-tools-for-agents, https://github.com/blackwell-systems/agent-lsp | Both quotes verified verbatim in primary sources; zero fabricated quotes detected (0 REMOVED). |
