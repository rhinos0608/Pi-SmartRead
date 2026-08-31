# Capability Parity Matrix: apmantza/pi-lens vs Pi-SmartRead + Pi-SmartEdit

> **Reference:** apmantza/pi-lens (TypeScript Pi extension, 363★, MIT) — real-time
> LSP diagnostics, linters/formatters/autofix, ast-grep structural search/replace,
> read-before-edit guard, security scanners, MCP mirror.
> **Target:** Pi-SmartRead (`read`/`grep`/`inspect`) + Pi-SmartEdit (`edit`, wraps
> host `write`) — evidence-gated code-intelligence extensions for the same Pi
> coding agent.
> **Goal:** Agent-facing capability parity, **same tool surface** — extend
> `read`/`grep`/`inspect`/`edit` params, add zero new tool names, unless a
> capability is judged out of scope.

Compiled from `apmantza/pi-lens` docs (`agent-tools.md`, `features.md`,
`agent-guide.md`, `word-index.md`, `module-report-read-symbol.md`) and direct
inspection of `Pi-SmartRead/src` + `Pi-SmartEdit/src`.

---

## 1. Current Tool Surface (both sides)

| Tool | Owner | Registered as |
|---|---|---|
| `read` | Pi-SmartRead (`src/hook.ts`, wraps host read) | single/`paths[]`/`query`/`symbol` dispatch |
| `grep` | Pi-SmartRead (`src/grep-tool.ts`) | BM25+AST+semantic cascade, `graphFilter` |
| `inspect` | Pi-SmartRead (`src/inspect-tool.ts`) | directory repo-map / file structural-facts+signals |
| `edit` | Pi-SmartEdit (`src/patch.ts`) | evidence-gated mutation |
| `write` | Pi host builtin | Pi-SmartEdit listens on `tool_call`/`tool_result`, does not register it |

No `LSP`, no `ast_grep_*`, no `diagnostics` tool exists on either side today.
Pi-lens registers 6 always-active + 6 dynamically-activated tools plus 16 MCP
mirrors — a much wider tool surface. **Parity here explicitly means folding
pi-lens's capabilities into the 4 existing tool names, not adding pi-lens's
tool count.**

---

## 2. Matrix

### Diagnostics & LSP

> **Corrected 2026-08-30** — the original pass of this matrix missed existing
> capability. Pi-SmartEdit already runs post-write/edit LSP + compiler + ESLint
> + structural + fake-logic diagnostics synchronously (`src/index.ts`,
> `src/lsp/*`, `src/verification/auto-validate.ts`), and Pi-SmartRead already
> supplies an unclaimed-mutation LSP fallback (`src/post-edit-fallback.ts`).
> Verified against source; see oracle decision log in
> `docs/parity/pi-lens-oracle-decisions.md` §2.

| Capability | pi-lens | SmartRead/SmartEdit | Status |
|---|---|---|---|
| Live LSP diagnostics on every write/edit (45 servers) | `lens_diagnostics`/`lsp_diagnostics`, always-on pipeline | SmartEdit already runs LSP + compiler + ESLint diagnostics synchronously post-write/edit (`checkPostEditDiagnostics`, `getCompilerForLanguage`, `eslint-runner.ts`); SmartRead has a fallback path for unclaimed mutations | **PARTIAL — foundation exists, honesty labeling is the gap** (empty/timeout LSP result can be read as "pass" today) |
| LSP navigation: definition/references/hover/documentSymbol/workspaceSymbol | `lsp_navigation` (agent tool) | `lsp-bridge.ts` has the same client capabilities but is **internal-only** (symbol resolution for `read{symbol}`, repomap, deep-search) — not agent-facing | **PARTIAL** |
| LSP navigation: rename/renameFile/signatureHelp/prepareCallHierarchy/incomingCalls/outgoingCalls/executeCommand/capabilities | `lsp_navigation` | Not implemented anywhere, internal or agent-facing | **GAP** |
| Impact-cascade diagnostics (re-check reverse-dependency neighbors after edit) | Automatic, turn-end | `inspect { impact: true }` computes blast radius **on request**, doesn't run LSP diagnostics on neighbors | **PARTIAL** |
| Diagnostic honesty labels (partial/stale/cold/unconfirmed) | Core invariant (#533) | No diagnostic concept exists to label | **N/A** (no diagnostics yet) |
| Diagnostic triage (`lens_diagnostic_mark`: false-positive/suppress/defer/flagged) | Content-anchored, cross-surface | No diagnostics → nothing to triage | **GAP** (blocked on diagnostics existing) |

### Linting, Formatting, Autofix

| Capability | pi-lens | SmartRead/SmartEdit | Status |
|---|---|---|---|
| Auto-format on write (34 formatters, config-gated, nearest-wins) | Immediate (write) / deferred to `agent_end` (edit) | None — `edit`/`write` never mutate beyond the requested diff | **GAP** |
| Auto-fix (biome/ruff/eslint/… `--fix`) | Same timing model as format | None | **GAP** |
| Structural rules (tree-sitter + ast-grep) blocking/advisory on write | Inline at write time | None | **GAP** |
| Fix provenance / bus events for out-of-band mutation (`pilens:files:touched`) | `v:1` additive bus event | Internal `pi.events` bus exists (context-hygiene, doom-loop) but no public "files touched by non-agent-tool-call" contract, because nothing mutates out-of-band | **N/A** (no autofix → no need yet) |

### Structural Search / Replace

| Capability | pi-lens | SmartRead/SmartEdit | Status |
|---|---|---|---|
| AST-aware structural search (`ast_grep_search`, metavariables, strictness modes, pagination) | Dedicated tool, ~40 languages via `sg` CLI | `grep` does BM25+AST-symbol+semantic, not shape-based pattern matching; no metavariable capture — this half is a real gap | **GAP** |
| AST-aware structural replace (`ast_grep_replace`, stale-preview revalidation) | Dedicated tool | **Already exists**: `edit.edits[].target.{pattern,replacement}` resolves ast-grep template transforms against the current preimage, with freshness/authority checks, in `edit-contract.ts`/`edit-planner.ts`/`astgrep-anchor.ts` | **PARITY** |
| AST dump / outline (`ast_grep_dump`, `ast_grep_outline`) | Dedicated tools | `inspect` file mode returns structural facts (parent/children/overrides) via tree-sitter, not a raw AST dump or syntax-only outline | **PARTIAL** |

### Read-Substitute / Discovery Funnel

| Capability | pi-lens | SmartRead/SmartEdit | Status |
|---|---|---|---|
| Ranked identifier search (`symbol_search`, BM25 + priors + centrality, `lang:`/`file:`/`ext:` filters) | Word-index tool | `grep` (BM25 + AST symbol + semantic + graphFilter) — SmartRead's version is broader (adds semantic + graph) but has no `lang:`/`file:` prefix-filter query syntax | **PARTIAL (SmartRead ahead on ranking, behind on query syntax)** |
| Module outline (`module_report`: symbols, signatures, decorators, callbacks, `usedBy`, `recommendedReads`, doc summaries, `view: compact`) | Dedicated tool | `inspect` file mode: callers/parent/children/overrides/re-exports + quality signals — no decorators, no callbacks section, no `recommendedReads`, no compact text view | **PARTIAL** |
| Symbol body read (`read_symbol`, records read-guard coverage, did-you-mean, `Class.method` qualification) | Dedicated tool | `read { symbol }` resolves via LSP/context-graph then reads with contextual enrichment — no did-you-mean, no dotted-qualifier disambiguation | **PARTIAL** |
| Enclosing-symbol read from `path+line` (`read_enclosing`) | Dedicated tool | No equivalent — nearest is `inspect` file mode which returns ranges but not "give me the enclosing body for this line" | **GAP** |
| Opportunistic read expansion (small read → widen to enclosing symbol) | Transparent, ≤60-line reads | No equivalent in `read` | **GAP** |

### Read-Before-Edit / Mutation Safety

| Capability | pi-lens | SmartRead/SmartEdit | Status |
|---|---|---|---|
| Read-before-edit enforcement | Zero-read block / stale-file block / out-of-range block, coverage accumulates across reads | Workspace evidence envelope system: schema-versioned, SHA-256 content-hash freshness, per-symbol `coverage: "search-match"` (weak) vs full-read (strong), RPC-resolved at edit time | **PARITY (different mechanism, SmartEdit's is stronger — cryptographic freshness vs pi-lens's line-hash)** |
| Markdown/`.txt`/`.log` exemptions | Explicit exemption list | Not modeled — evidence system doesn't special-case file type | **PARTIAL** |
| Human escape hatch (`/lens-allow-edit`) | Slash command | No slash-command surface in this extension pair | **OUT-OF-SCOPE-CANDIDATE** — no interactive slash-command layer exists here |

### Security / Dependency Scanning

| Capability | pi-lens | SmartRead/SmartEdit | Status |
|---|---|---|---|
| Opengrep/gitleaks/trivy/govulncheck session scans | Auto-installed, opt-in gated, turn-end surfaced | None | **GAP** |
| Commit/push guard (`--lens-guard`) blocking on unresolved blockers | Experimental, opt-in | No bash/git command interception anywhere in either extension | **GAP** |

### Session / Observability

| Capability | pi-lens | SmartRead/SmartEdit | Status |
|---|---|---|---|
| Runtime health tool (`lens_health`, degradation ledger, LSP status) | Agent tool + slash command | `runtime-health.ts` exists **internally** (`DegradationBackend` tracking for bm25/symbol/semantic/lsp/lexical) but not agent-facing | **PARTIAL** |
| Latency telemetry (`/lens-perf`, `pilens_latency`) | Slash command + MCP tool | No equivalent surface | **GAP** |
| Cheap project-wide scans (`lens_project_scan`: knip/jscpd/duplicates) | Agent tool | `near-clone.ts` (MinHash/LSH) exists but isn't wired into a project-scan surface; no knip/jscpd equivalent | **PARTIAL** |
| MCP server mirror (16 tools) | Second host adapter, same engine seam | Pi-SmartRead already has `mcp-server.ts`/`mcp-registry.ts`; scope of parity vs pi-lens's specific 16-tool mirror is undetermined — see open questions | **PARTIAL (needs scoping)** |

### Distribution / Ergonomics (scoping judgment — same posture as prior parity doc)

| Capability | Why out of scope |
|---|---|
| Dynamic tool activation (`pi_lens_activate_tools`, 6 situational tools) | Directly conflicts with "same tool surface" mandate — this parity effort folds capability into existing tools instead |
| 45 language-server auto-install + interactive install prompts | Large ops surface (server discovery/install/idle-management); candidate for a later phase, not initial parity |
| Slash commands (`/lens-toggle`, `/lens-map`, `/lens-tdi`, `/lens-perf`, `/lens-widget-toggle`) | Neither extension has a slash-command/UI-widget layer; would be new surface, not tool-param extension |
| 3D/HTML dependency map (`/lens-map`) | Consumer is the agent; text/JSON output is the existing ergonomic posture |
| Helm/K8s/Docker/Terraform IaC scanning | Highly specialized scanner surface; revisit only if security scanning (GAP above) is greenlit and mature |

---

## 3. Ranked Gap List (in-scope GAPs and PARTIALs, excludes OUT-OF-SCOPE)

| # | Capability | Why it matters | Size | Repo | Tool surface fit |
|---|---|---|---|---|---|
| 1 | Expose LSP navigation ops as agent-facing (`lsp-bridge.ts` already has definition/references/hover/documentSymbol/goToImplementation/workspaceSymbol) | Biggest single lever — client already built, just not surfaced | S | SmartRead | New `inspect` signal or `read` mode? **oracle** |
| 2 | Live LSP diagnostics collection + surfacing | Core pi-lens value prop; currently zero diagnostic capability | L | SmartRead (collect) + SmartEdit (surface post-edit?) | **oracle** — which tool, which repo owns it |
| 3 | ast-grep structural search | High agent value: shape-based search beats regex/BM25 for refactors | M | SmartRead | Fold into `grep` (new param) vs separate concern — **oracle** |
| 4 | ast-grep structural replace | Pairs with #3 for structural refactors | M | SmartEdit | Fold into `edit` (new mode) — **oracle** |
| 5 | LSP rename / rename_file / incomingCalls / outgoingCalls / prepareCallHierarchy | Extends #1; incomingCalls/outgoingCalls overlaps existing `inspect{callDepth,callDirection}` (tree-sitter-based) — dedup risk | M | SmartRead | **oracle** — does this replace or complement the tree-sitter callgraph? |
| 6 | `module_report` parity gaps: decorators, callbacks, `recommendedReads`, doc summaries, `view:compact` | Cheaper "read substitute" is pi-lens's headline ergonomics win | M | SmartRead | Extend `inspect` file mode output — no new tool | 
| 7 | `read_enclosing` (path+line → enclosing symbol body) | Bridges diagnostic/grep-hit locations to a body read | S | SmartRead | New `read` param (`line` without full symbol name?) — **oracle** |
| 8 | Opportunistic read expansion (small read → widen to enclosing symbol) | Reduces read-then-reread churn, cheap win | S | SmartRead | `read` behavior change — check interaction with evidence envelope ranges |
| 9 | Auto-format/autofix pipeline on `write`/`edit` | Pi-lens's other headline feature; **directly conflicts** with SmartEdit's evidence-hash freshness contract (a mutation the agent didn't request would invalidate its own evidence) | L | SmartEdit | **oracle — hard architecture conflict, must resolve before any implementation** |
| 10 | Structural/security rule scanning on write (tree-sitter smells, opengrep, gitleaks, trivy, govulncheck) | Valuable but heavy: new scanner integrations, auto-install policy, opt-in gating | L | SmartEdit (trigger) / SmartRead (compute?) | **oracle** — scope for v1 vs later phase |
| 11 | Diagnostic disposition/triage (`lens_diagnostic_mark` equivalent) | Blocked on #2 existing first | M | SmartEdit (mutation-owning) | Blocked — sequence after #2 |
| 12 | Commit/push guard | Requires bash/git command interception, a surface neither extension currently touches | L | Unclear — neither repo currently intercepts bash | **oracle** — is this in scope at all? |
| 13 | `lens_health`/`/lens-perf` equivalent (surface existing internal `runtime-health.ts`/`DegradationBackend`) | Cheap: data already collected internally, just not exposed | S | SmartRead | Which tool surfaces it — `inspect` on a synthetic path, or a `read` mode? **oracle** |
| 14 | `symbol_search` query-prefix syntax (`lang:`, `file:`, `ext:`) on `grep` | Ergonomic filter syntax; SmartRead's ranking is already ahead | S | SmartRead | Extend `grep` pattern parsing |
| 15 | MCP server capability parity scoping (which of the 16 pi-lens MCP tools map to SmartRead's existing MCP surface) | Needs explicit scope decision before any MCP work | — | SmartRead | **oracle** |

---

## 4. Design Ambiguities Requiring Oracle Decision

These are architecture-shaping and cannot be resolved by convention alone:

1. **LSP navigation surfacing (#1, #5):** Fold into `inspect` (new `navigate` signal/param on file mode) or into `read` (new `symbol` sub-modes)? Does this replace or sit alongside the existing tree-sitter `callgraph.ts`-backed `inspect{callDepth,callDirection}`?
2. **Diagnostics ownership (#2, #11):** SmartRead is read-only/analysis; SmartEdit is the mutation gate. Does live-diagnostics collection belong in SmartRead (as an `inspect` capability, computed on demand) or does it need a persistent per-session diagnostic cache more like pi-lens's (which would be a new architectural component, arguably violating "read tools don't hold session-mutating state")?
3. **Structural search/replace (#3, #4):** Extend `grep` with a `structural`/`astPattern` param, or is a shape-based rewrite fundamentally different enough from hashline/anchor edits that it needs its own code path inside `edit` even while keeping the tool *name* `edit`?
4. **Autofix/format pipeline vs evidence-hash contract (#9):** This is a genuine conflict — pi-lens mutates files outside the agent's tool call and relies on `pilens:files:touched` nudges to tell the agent to re-read. Pi-SmartEdit's evidence contract requires SHA-256 freshness at edit time. Would pipeline-driven autofix need to auto-refresh evidence for its own mutation, and is that a security-relevant precedent (self-authorizing mutation) worth flagging?
5. **Security/scanner integration scope (#10, #12):** Full pi-lens scanner parity is a large, ops-heavy surface (auto-install policies, per-scanner config). Is v1 scope limited to structural/tree-sitter rules only (no external binaries), deferring gitleaks/trivy/opengrep/commit-guard to a later phase?
6. **MCP surface scope (#15):** Should Pi-SmartRead's existing MCP mirror be extended toward pi-lens's 16-tool mirror, or is MCP explicitly out of scope for this parity pass (Pi-native agent surface only)?

---

*Matrix compiled from: apmantza/pi-lens `docs/agent-tools.md`, `docs/features.md`,
`docs/agent-guide.md`, `docs/word-index.md`, `docs/module-report-read-symbol.md`
(fetched 2026-08-31); direct inspection of `Pi-SmartRead/src/{lsp-bridge,inspect,
inspect-tool,grep-tool,hook,callgraph,runtime-health}.ts` and
`Pi-SmartEdit/src/{index,patch}.ts`.*
