# Affordance bundle plan (Lane P) — 2026-10-08

Status: plan only. No runtime code changed. Implements oracle `bc6fcc88`
(approved per E20.6) in the isolated bets worktree (`feat/affordance-bundle`
from `5e68459`). Owner approval recorded: no public consumers, no
compatibility scaffolding; isolated worktree protects installation.

Lane law (E20): BENCHMARKS determine defaults. Build everything behind one
opt-in switch; never preselect default-on. Off-mode is byte-identical:
existing schemas, descriptions, guidance, text, details, validation errors,
execution paths. Off-mode exists to preserve a clean experimental baseline.

TEB context: E20.3 — the instructed arm is a diagnostic comparison, not an
upper bound; frozen semantic tasks already supply coordinates, so TEB
under-measures anchors' discovery value. Disclose; do not modify frozen tasks.
TEB runner/metrics/protocol amendments are ergonomics-worktree owner-only and
land only after current runner fixes are reviewed. Pin gates before results;
exclude advisory content from evidence; same-build off/bundle/instructed;
disclose coordinate-supplied tasks; measure cost before large runs.

## 0. Switch + layout (frozen)

- Env: `PI_SMARTREAD_AFFORDANCES=1`, captured once at tool construction
  (factory argument, not read per-call). `0`/unset/absent = off.
- New files only for new logic; existing files get branch-guarded edits:
  - `src/lsp/affordance-contract.ts` — shared frozen types (below).
  - `src/lsp/affordance-anchor.ts` — stateless `{symbol, path?}` resolver.
  - `src/lsp/affordance-investigation.ts` — `investigate` recipes.
  - `src/runtime/affordance-actions.ts` — pure recognition classifier +
    `nextActions` builder (no I/O).
  - `src/runtime/affordances.ts` — `isAffordancesEnabled()` + factory
    selectors (which description/schema/guidance variant to use).
  - `src/inspect/inspect-views.ts` — routes-only renderer reusing
    `src/inspect/route-extraction.ts` (`extractRoutes`, `scanRoutes`).
- Edited (branch-guarded, off-path untouched): `src/lsp/lsp-tool.ts`,
  `src/lsp/lsp-executor.ts` (anchor/investigate dispatch only),
  `src/search/grep-tool.ts`, `src/read/unified-read.ts` (+ `src/hook.ts`
  footer seam), `src/inspect/inspect-tool.ts`,
  `src/runtime/tool-guidance.ts`, `src/extension-registration.ts`,
  `src/mcp-registry.ts`, `src/mcp/mcp-instructions.ts`, README/skills.
- Reuse, do not duplicate: `src/scoring.ts` cosineSimilarity (none needed —
  classifier is phrase/token rules, no embeddings); `lsp-strict-contract.ts`
  (`validateStrictRequest`, `classifyStatus`, `StrictStatus` vocabulary);
  `lsp-operation-registry.ts` (`getOperationDef`, `listOperations` — internal
  executor inventory UNCHANGED); `lsp-cursor-store.ts` (`LspCursorStore`);
  `lsp-raw-method-policy.ts` (`evaluateRawMethodPolicy` — allowlist UNCHANGED);
  `lsp-connection.ts` negotiated encoding
  (`getNegotiatedEncoding`, default `utf-16`); `lsp-manager.ts`
  (`acquireSession`, exact-`descriptorId` routing, `cachedManager` fanout);
  `src/read/hook-enrich.ts` (`displayContent` snapshot + `contextFooter`
  separation); `src/evidence/` envelopes.
- Avoid a separate registry: extend `FIELD_MATRIX`/`REQUIRED_FIELDS` handling
  via the affordance contract's additive validation layered BEFORE
  `validateStrictRequest`, and keep one executor inventory. Only if the flat
  TypeBox schema cannot express the additive `symbol`/`investigate` shape
  without breaking off-mode validation should a bounded alternative
  (separate bundle-only schema object selected by the switch) be used —
  flag to parent, do not invent APIs.

## 1. Frozen shared types (freeze before workers begin)

```ts
// src/lsp/affordance-contract.ts (FROZEN 2026-10-07 post-review rev —
// reviewer P1/P2 gaps closed; matches implemented source)
// NOTE: resolver entry lives in src/lsp/affordance-anchor.ts; the contract
// owns the shared types. `investigateAffordanceTarget` is WP-A2-owned and
// NOT frozen here beyond its input/output shapes below.
export type AffordanceAnchorTarget =
  | { path: string; position: { line: number; character: number } }
  | { symbol: string; path?: string };
export type InvestigateTask = "definition" | "type" | "references" | "implementations" | "callers";
export interface AffordanceInvestigateInput {
  operation: "investigate"; task: InvestigateTask;
  path?: string; position?: { line: number; character: number }; symbol?: string;
  scope?: string; workspace?: string; server?: string; timeoutMs?: number;
}
export type AnchorErrorCode =
  | "ambiguous_anchor" | "anchor_not_found" | "anchor_invalid_path"
  | "stale_anchor" | "anchor_search_incomplete"; // P2: invalid-path is distinct
export interface AffordanceAction {
  tool: "LSP" | "read" | "inspect" | "grep";
  arguments: Record<string, unknown>; reason: string;
}
export const AFFORDANCE_ANCHOR_OPS = [
  "goToDefinition", "goToTypeDefinition", "goToImplementation",
  "findReferences", "hover", "prepareCallHierarchy",
] as const;
export const AFFORDANCE_BOUNDS = {
  discoveryCandidates: 100, underlyingRequests: 6, ambiguityCandidates: 10,
  aggregateDeadlineMs: 15000, perStepResults: 100, outputBytes: 48 * 1024,
  hintChars: 140, maxActions: 2, combinedRenderChars: 800, classifyChars: 256,
} as const;
export function isAffordancesEnabled(env?: NodeJS.ProcessEnv): boolean;
// Resolver + execution seams (exact exported signatures):
export interface AffordanceBudget { maxCandidates: number; maxRequests: number; deadlineMs: number; signal?: AbortSignal; }
export interface AffordanceExecContext {
  root: string; server?: string; workspace?: string; budget: AffordanceBudget;
  // INTERNAL opt-in strict dispatch seam (default: real executeLspOperation;
  // tests inject a deterministic fake). Strict requests only — never a raw
  // policy bypass, never a model-facing field.
  exec?: (req: unknown, deps?: ExecutorDeps) => Promise<StrictEnvelope>;
  now?: () => number;
}
export interface AnchorCandidate { path: string; name: string; }
export type AnchorResolution =
  // P1b: resolved carries the lookup envelope verbatim (resolution-time
  // freshness only — WP-A2 MUST re-check before dispatch).
  | { kind: "resolved"; path: string; position: { line: number; character: number }; server: StrictServerInfo; resolutionEnvelope: StrictEnvelope; }
  // Underlying strict failures propagate with their own status/code;
  // anchor conditions use AnchorErrorCode.
  | { kind: "unresolved"; status: StrictStatus; code: AnchorErrorCode | string; message: string; candidates: AnchorCandidate[]; envelopes: StrictEnvelope[]; retry?: string; };
// Symbol-only targets resolve; {path,position} targets dispatch directly
// (caller error if passed to the resolver).
export interface AffordanceSymbolTarget { readonly symbol: string; readonly path?: string; }
export function resolveAffordanceAnchor(target: AffordanceSymbolTarget, ctx: AffordanceExecContext): Promise<AnchorResolution>;
export interface InvestigationStep { id: string; args: Record<string, unknown>; envelope: StrictEnvelope; }
export interface InvestigationOutput { status: StrictStatus; result: unknown; steps: InvestigationStep[]; }
export function investigateAffordanceTarget(input: AffordanceInvestigateInput, ctx: AffordanceExecContext): Promise<InvestigationOutput>;
```
Executor entry points reused with one narrow opt-in addition:
`executeLspOperation(req, deps?: ExecutorDeps)` is the single dispatch seam;
`ExecutorDeps` carries the existing fields plus INTERNAL-ONLY
`includeSymbolProvenance?: boolean` (absent/false = byte-identical legacy
envelopes; no model-facing field, no strict-schema change). With the flag set,
`normalizeByOp` calls `normalizeDocumentSymbols(raw, { markProvenance: true })`
(`lsp-response-normalizer.ts`), marking genuine `DocumentSymbol`
`selectionRange` as `"explicit"` and collapsed `SymbolInformation` ranges as
`"collapsed"`. Resolver/recipes issue strict `documentSymbols` /
`workspaceSymbols` requests ONLY through `executeLspOperation` (pathless
`workspaceSymbols` uses the manager fanout path it already owns), then match
against the marked output. No invented resolver/dispatch APIs, no raw
requests, no server metadata fields.

Status vocabulary (existing `StrictStatus`, `lsp-strict-contract.ts:12-21`):
`ok | empty | unsupported | unavailable | not_ready | timeout | cancelled |
error | ambiguous`. New anchor conditions reuse it: `ambiguous` +
`ambiguous_anchor`; `error` + `anchor_not_found` / `anchor_invalid_path` /
`stale_anchor`; `not_ready` + `anchor_search_incomplete`. Underlying
`unavailable`, `unsupported`, `timeout`, `cancelled`, normalization errors,
and budget admission propagate with their own status/code plus verbatim
envelopes.

## 2. Work packages (disjoint ownership, max two workers at once)

### WP-A — LSP targeting + investigation (owns `src/lsp/*` bundle files)
Anchor ops: `AFFORDANCE_ANCHOR_OPS` only. No anchors on rename, formatting,
raw `request`, `applyProposal`. `{path,position}` unchanged; alternative
`{symbol, path?}` mutually exclusive with `position` (XOR enforced; both or
neither-without-symbol = tool error via existing validation path).
`symbol`: exact declaration name or `/`-separated hierarchy, JSON-Pointer
escape rules per segment (`~1`→`/`, `~0`→`~` applied after splitting).
Declaration-only, case-sensitive exact matching; no fuzzy/prefix matching.
Pathless symbol targets are discovery-only under the current server
contract (no completeness signal exists in `workspace/symbol`; no custom
completeness field is assumed; no unbounded repository scan is added).
Completeness rule (fail-closed; a short list or `meta.truncated=false`
never proves uniqueness):
- Normalize every candidate first against the provenance-marked
  `normalizeDocumentSymbols` output. Only entries with
  `selectionProvenance === "explicit"` (genuine `DocumentSymbol`
  `selectionRange`) may anchor dispatch. Collapsed `SymbolInformation`
  entries (`"collapsed"`) and provenance-less shapes are unusable and
  yield `anchor_search_incomplete` — never a dispatch, never a heuristic
  comparing equal ranges.
- Completeness is established ONLY by a usable, complete normalized
  `documentSymbols` result for an explicit `path` (single server, genuine
  `selectionRange` on every matched entry) AFTER validating that path is
  an existing regular file (canonicalized via realpath); otherwise
  `anchor_invalid_path` precedes any lookup.
- `workspaceSymbols` results are discovery, not enumeration: client-side
  `limit`/`cursor` pagination (`lsp-executor.ts:895-903`, only when the
  caller supplies them) is distinct from silent server-side truncation or
  fuzzy-ranked cutoffs (`buildParams` sends only `{ query }`,
  `lsp-executor.ts:233-234`; LSP 3.17 returns an array or `null`, with
  partial results requiring a client-provided progress token the strict
  surface does not expose). Reaching the candidate cap (100) therefore
  means `anchor_search_incomplete`, and staying under the cap still does
  NOT prove the server enumerated every matching declaration.
- Multi-server: pathless `workspaceSymbols` fans out at manager level
  (`LSPManager.workspaceSymbol` queries all live connections) but the
  strict envelope carries a single server (explicit `descriptorId`, or
  `"unknown"` for fanout, `lsp-executor.ts:695-751`); results from
  several servers cannot establish a unique workspace-wide declaration.
  Preserve original coordinates and server routing on dispatch.
Resolution (bounded, fail-closed):
1. With explicit `path`: validate the file FIRST (resolve against the
   effective workspace — `ctx.workspace` when supplied, else `ctx.root` —
   with the same semantics as the strict executor
   (`resolve(workspace ?? cwd, path)`, `lsp-executor.ts:498-501`: absolute
   and `../` targets outside the root stay valid when the exact server can
   serve them — NO root jail on explicit files), require an existing regular
   file, realpath-canonicalized with realpath failure fail-closed, revalidate
   the canonical target, and dispatch the canonical path so validation and
   the request share one identity) — violations → `error`/`anchor_invalid_path`
   with zero server requests. Root-scoping applies only to pathless
   `workspaceSymbols` discovery and the future `investigate` `scope` filter,
   never to explicit anchor files. Then strict `documentSymbols` via
   `executeLspOperation` with the internal `includeSymbolProvenance` flag,
   traverse normalized children, exactly one exact match with
   `selectionProvenance === "explicit"` required; zero matches →
   `error`/`anchor_not_found` (file-scoped); multiple →
   `ambiguous`/`ambiguous_anchor` with ≤10 candidates and a
   path-qualified retry hint. The resolved outcome carries the lookup
envelope verbatim as `resolutionEnvelope` (resolution-time freshness
   only — WP-A2 MUST re-check before dispatch).
2. Without `path`: return bounded candidates (≤100) with
   `not_ready`/`anchor_search_incomplete` plus an actionable
   path-qualified retry (e.g. re-issue with `path` from a candidate);
   NEVER auto-dispatch even a single candidate when completeness is
   unknown; NEVER report empty as workspace-wide `anchor_not_found`
   (empty discovery = `anchor_search_incomplete`, not proof of absence).
3. Missing/unusable provenance (collapsed `SymbolInformation` range or
   provenance-less shape) → candidate unusable →
   `anchor_search_incomplete`, never fall back to a broad range as an
   identifier position, never compare equal ranges heuristically.
4. Dispatch (WP-A2) at the resolved `selectionRange.start` in that server's
   negotiated encoding (`getNegotiatedEncoding`, `lsp-connection.ts:287`)
   without transcoding.
5. Stale = observed within-request race only: re-check document
   version/hash between resolution and dispatch (`resultMetaForPath` /
   `sha256OfText` pattern, `lsp-executor.ts:157-189`); statelessness cannot
   detect earlier-turn edits. Mismatch → `error`/`stale_anchor`.
6. Bounds: ≤100 candidates, ≤6 underlying requests total; any cap hit or
   otherwise-unprovable enumeration → `not_ready`/`anchor_search_incomplete`.
7. Validate full field matrix BEFORE translation; re-validate translated
   request through `validateStrictRequest`; unknown fields never dropped.
   Do NOT reuse `resolveSymbolForReadTool`
   (`src/extension-registration.ts:69-98` — first-match + graph fallback,
   unsuitable for fail-closed addressing).
`investigate`: one model-facing op layered over strict ops (TEB allowlist
preserved). Same target XOR; `scope` = canonical file/dir filter inside the
chosen workspace. Recipes: definition→`goToDefinition`; type→`hover` at
target (never relocate use-site hover to definition); references→
`findReferences` excluding declarations; implementations→
`goToImplementation`; callers→declaration target required,
`prepareCallHierarchy` → `incomingCalls` for EVERY returned item (max 3),
passing exact items unchanged. Output: concise locations/types +
completeness + status; EVERY actual strict envelope preserved verbatim in
`details.investigation.steps[]` (step id + args), including anchor steps.
Partial evidence stays visible but never a successful exhaustive answer.
Defaults: ≤6 requests incl. resolution, 15 s aggregate deadline, sequential,
cancellation propagation, 100 results/step. Opt-in executor output guard →
small `output-limit` error envelope (existing executor spelling,
`lsp-executor.ts:877-882`) before oversized normalized results
become envelopes; preserve verbatim. Cap 6 envelopes at 48 KiB (64 KiB
response budget with rendering/provenance headroom).
No SmartEdit protocol changes. Raw allowlist unchanged
(`lsp-raw-method-policy.ts:45-93`). Existing pagination stays on legacy
ops (`paginate` + `LspCursorStore`, `lsp-executor.ts:1110-1129`).

### WP-B — Recognition + actions + read boundaries (owns grep/read/footer seam)
Pure classifier in `src/runtime/affordance-actions.ts`: no LLM, no server
startup, no indexing, no search. Inspects ≤256 chars of the tool's own
query/target text only (grep query / read target — NOT the user's unseen
question; ordinary path reads emit no semantic hint merely for being TS):
`defined|references|implements|callers|inferred type` → semantic route;
HTTP registration / package-entry questions → structural/content route;
else abstain. At most one 140-char hint + two actions, 800-char combined
cap: `{tool, arguments, reason}`. Actions in `details.nextActions` + a
clearly separated advisory footer reusing the `contextFooter` separation
pattern (`src/read/hook-enrich.ts:152-186`); prefill only observed paths,
rendered ranges, declaration identities — never invented columns. Uncertain
semantic targets → `documentSymbols` or focused read, never guessed jump.
Suppress on: literal/`regex:true` queries, absence/location-only queries,
config/scalar reads, conflicting classifications, routine successful narrow
reads. Inspect actions only for actionable structural results or explicit
truncation. No auto-execution; no evidence authority; advisory footers
excluded from first-correct-evidence scoring. Batch reads: dedup + caps;
partial/omitted batch blocks gain no authority (existing batch coverage
semantics unchanged).

### WP-C — Inspect routes view (owns `src/inspect/inspect-views.ts` + tool guard)
`{mode:"file"|"directory", path, view:"routes"}` mutually exclusive with
`analysis`; invalid in script mode (foreign-key rejection alongside
existing `rejectForeignKeys`, `inspect-tool.ts:152-168`). Reuses
`extractRoutes`/`scanRoutes`; renders routes only; bypasses unrelated
map/graph work (`needsContextGraph` stays false for view-only —
`inspect-mode-contract.ts:31-36`); preserves truncation + discovery-only
evidence. TEB matcher extended (ergonomics worktree) to recognize this
equivalent routes request. No generic impact/importer views (protocol
rejects bounded impact samples as exhaustive import evidence); no
package-export views (`read package.json` suffices).

### WP-D — Integration / guidance / evaluation (owns wiring ONLY)
`src/runtime/affordances.ts` switch; factory selection of matching
description/schema/guidance. `tool-guidance.ts` stays the wording authority:
under the switch REPLACE (not append) relevant bullets with anchor
semantics, investigation tasks, advisory actions, routes-view usage + two
short examples (declaration-name callers; coordinate-based inferred type).
Registration MUST use factory descriptions, not the fixed
`GREP_DESCRIPTION` constant (`grep-tool.ts:102`; existing trap:
`extension-registration.ts:156-158` pins `GREP_DESCRIPTION`). Render Pi
guidelines + MCP instructions from the same selected guidance
(`mcp-instructions.ts:17-21`). MCP actions must never recommend `read`
(MCP has no wrapped read — `MCP_READ_NOTE`). Complete off-mode snapshots
in tests. If existing registry supports safe integration, no separate
registry.

## 3. Targeting/anchor seam split
WP-A splits if large: WP-A1 resolver/contract (`affordance-anchor.ts` +
contract deltas + narrow opt-in provenance additions to
`lsp-response-normalizer.ts`/`lsp-executor.ts`, one owner) vs WP-A2
recipes/tool integration (`affordance-investigation.ts` + `lsp-tool.ts` +
further executor wiring, one owner). Seam is the frozen
`AnchorResolution`/`AffordanceExecContext` + `executeLspOperation` dispatch
above — resolver outputs resolved (with verbatim `resolutionEnvelope`) or
unresolved (status/code/candidates/verbatim `envelopes`); investigation
consumes only that. No public consumers exist (owner-confirmed): no
compatibility scaffolding; off-mode stays byte/bench attribution-identical
per §4 snapshots.

## 4. Counting, completeness, failure, isolation rules
- Count outer tool calls AND underlying RPCs separately; composite evidence
  timing = receipt time, never invented internal timestamps.
- Bounded candidate completeness: state bounds in output; partial failure
  propagates (failed step → step envelope + degraded overall status, never
  silent drop or success).
- Exact hierarchy items passed unchanged (`incomingCalls` etc. consume
  exact `item` — `lsp-tool.ts:95-98`); exact `server` routing, no fuzzy
  fallback (`lsp-executor.ts:428-448`, `576-630`).
- Hint suppression + evidence isolation per WP-B; raw request allowlist
  unchanged; off-mode equality tests (snapshots of schema/description/
  guidance/details/validation errors); MCP parity except no read
  nextActions on MCP.

## 5. Verification (exact commands; run narrowest + typecheck)
- `npm run typecheck`
- `npx vitest run test/unit/lsp` (anchor XOR/foreign fields, duplicates,
  missing symbols, truncated discovery, encoding, content races, exact
  server routing, exact hierarchy items, deadlines/output limits, legacy
  unchanged)
- Focused new suites per package (actions suppression/matrix, routes-view
  equivalence/no-graph-build/truncation, switch/registration/guidance
  parity, off-mode snapshots) + `npm test` for broad changes.
- No installs, no commits, no paid benchmarks in this lane. TEB runs need
  measured cost + owner ceiling first (E6/E19). Retrieval guards stay
  dev-only (D46 dev56, internal-44, external dev64, pinned LSP fidelity).

## 6. Contract examples (pathless = discovery-only)
Success (path-qualified anchor callers):
`{operation:"goToDefinition", symbol:"start", path:"src/server.ts"}` →
`{status:"ok", operation:"goToDefinition", …, result:[…],
meta:{…}, }` with `details.investigation.steps[]` holding the
`documentSymbols` resolution envelope + the dispatch envelope verbatim.
Guidance/examples MUST label pathless targets discovery-only:
`{ operation: "investigate", task: "references", symbol: "start" }` →
`{status:"not_ready", error:{code:"anchor_search_incomplete",
data:{candidates:[≤100], retry:"re-issue with path from a candidate"}}}`
— never auto-dispatch, never workspace-wide `anchor_not_found` on empty.
Failure (ambiguous): `{status:"ambiguous",
error:{code:"ambiguous_anchor", message:"…", data:{candidates:[≤10]}}}`.
Failure (incomplete): `{status:"not_ready",
error:{code:"anchor_search_incomplete", …}}`.
Proposed failing tests (red before implementation, green 2026-10-07):
T1 single-discovery-no-dispatch; T2 empty-discovery-not-not_found;
T3 cap-hit-incomplete; T4 missing-selectionRange-unusable (+ provenance-less
legacy shapes fail closed); T5 `output-limit` hyphen spelling;
T6 multi-server-ambiguous. Provenance/off-mode: default
`normalizeDocumentSymbols` output carries no `selectionProvenance` key
(byte-identical JSON); `includeSymbolProvenance` absent yields identical
envelopes; opt-in marks genuine `"explicit"` vs collapsed `"collapsed"`.
Off-mode: `LSP` schema/description/guidance identical to `main@5e68459`
snapshots; unknown `symbol` field on legacy ops = foreign-field tool error.

Erratum 2026-10-09 (parent): an earlier revision of this section showed a
`{ target: {...}, investigate: [...] }` shape. That contradicted the frozen
§1 `AffordanceInvestigateInput` (flat, singular `task`) and the implemented
`investigateAffordanceTarget`. §1 governs; the example above now uses it.

## 7. Self-review (writing-plans)
- Coverage: oracle §§1A–D → WP-A/B/C; §2 ownership → §2 headers; §3
  guidance → WP-D; §4 TEB → header + §4/§5; MCP parity → WP-D + §4.
- No placeholders: all bounds, codes, paths, commands named.
- Seams: `AffordanceAnchorTarget` between resolver/recipes; `AffordanceAction`
  between classifier and grep/read/inspect emitters; routes renderer behind
  `inspect-views.ts`.
- Unknowns needing parent decisions: (a) RESOLVED — bundle-only schema
  object authorised as internal detail, no extra approval; (b) any new
  dependency (none proposed — default: none, separately approved if ever
  needed). Blockers resolved in-plan: P1 completeness rule (§2) + P2
  `output-limit` spelling; open: corrected borrow log pending from
  researcher (consumed on arrival, not edited here).
- Summary: adds an opt-in recognize→resolve→investigate bundle behind one
  switch; strict validation, exact routing, proposal-only mutation, evidence
  ownership, and off-mode behavior unchanged; largest regression risk is
  schema/guidance drift leaking into off-mode — guarded by snapshot tests;
  success = frozen types + four packages + typecheck/unit/green + TEB-gated
  pilot calibration.

## 9. WP-A2 implementation status (2026-10-07)

Recipe engine implemented (not wired): `src/lsp/affordance-investigate.ts`
plus `test/unit/lsp/affordance-investigate.test.ts` (21 tests, fake
strict executor + tempfiles; `test/unit/lsp` 616 green, typecheck clean).
No changes to lsp-tool / strict validator / operation registry /
normalizer / executor / anchor / contracts / guidance / MCP / index.
Exact exported signatures:
`investigateAffordanceTarget(input: AffordanceInvestigateInput,
ctx: AffordanceExecContext): Promise<InvestigationOutput>`;
`resolveInvestigateScope(scope: unknown,
workspaceRoot: string): AffordanceScope`. Target XOR is
`{symbol, path?}` mutually exclusive with `position` (plan §2).

## 8. TEB protocol hooks (ergonomics worktree, after runner fixes reviewed)
Amend `2026-10-07-teb-protocol.md` §§9/10 before runs: E20 supersedes
isolated-arm ordering. Arms (same build): off baseline / bundle (natural
choice) / baseline-instructed (frozen per-family one-liner, tool only, no
negatives). Metrics: paired success, family losses, opportunity recall,
precision, invalid calls, unavailable outcomes, first evidence, tokens,
latency, negative overuse; outer calls vs RPCs counted separately. Gates
(pinned pre-dev, never relaxed): +5pp success w/ positive paired CI, +15pp
recall, ≥80% precision, ≤5% lost baseline successes, negative deterioration
veto + pilot-frozen invalid-call/latency harm thresholds. If win: dev-only
ablations (recognition/actions → named view → anchors → composites), one
champion, single holdout opening, no holdout tuning.
