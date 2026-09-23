# SmartEdit consumption contract — SmartRead LSP strict substrate (Waves 4-5)

Stop-and-approve deliverable, 2026-09-22. This doc is the exact contract a
SmartEdit owner needs to consume SmartRead executor proposals. It edits
nothing in the sister repo. Approval required before SmartEdit implements
against it.

## 1. What SmartRead guarantees

- Single entry point: `executeLspOperation(req, deps)` in
  `src/lsp/lsp-executor.ts`. Pipeline: validate, route, gate, prepare,
  issue, normalize, envelope. No fallback server guessing inside the
  executor (hintless pathless request returns `unavailable`).
- Model-facing surface is exactly one tool: `lsp` (`src/lsp/lsp-tool.ts`,
  registered once via `registerLspTool()` in `src/extension-registration.ts`
  as READ). Flat TypeBox schema, no anyOf; per-operation shape enforced at
  runtime by `validateStrictRequest`; validation failures are tool errors,
  unroutable requests are `unavailable` envelopes.
- Proposal ops NEVER write files. Rename, codeAction, and format ops return
  normalized `WorkspaceEdit` proposals only. Verified:
  `test/unit/lsp/executor.test.ts` ("rename returns proposal, zero disk
  writes (no fs access)").
- Raw `request` op is fail-closed: `workspace/executeCommand`,
  `workspace/applyEdit`, unknown, and empty methods are rejected (caller
  error). Only the observational allowlist issues. Verified:
  `test/unit/lsp/strict-contract.test.ts` (`isRawMethodAllowed`),
  `test/unit/lsp/executor.test.ts` (raw allow/deny).
- SmartRead never applies edits: unsolicited `workspace/applyEdit` is
  answered `applied:false` and retained only as a bounded in-memory
  proposal record (FIFO, 256 cap, `APPLY_EDIT_PROPOSAL_LIMIT` in
  `src/lsp/lsp-connection.ts`). SmartEdit is the sole mutation authority.

## 2. StrictEnvelope proposal ops SmartEdit consumes

Envelope shape (`src/lsp/lsp-strict-contract.ts`):

```ts
interface StrictEnvelope<T = unknown> {
  status: StrictStatus; // ok | empty | unsupported | unavailable | not_ready | timeout | cancelled | error | ambiguous
  operation: StrictOperation;
  method: string;       // wire method, e.g. textDocument/rename
  server: StrictServerInfo; // descriptorId, name, languageId, projectRoot, positionEncoding
  result: T | null;
  meta: StrictMeta;     // documentVersion?, freshness?, readiness?, source?, truncated, nextCursor?
  error?: StrictError;  // code?, message, data?
}
```

Proposal ops and their wire methods (`src/lsp/lsp-operation-registry.ts`):

| StrictOperation | Wire method | Request fields (required) | Result shape (`result` on `ok`) |
| --- | --- | --- | --- |
| `prepareRename` | `textDocument/prepareRename` | `path`, `position` (0-based, negotiated encoding) | range-or-placeholder object (read, not mutation) |
| `rename` | `textDocument/rename` | `path`, `position`, `newName` | normalized `WorkspaceEdit` proposal `{ changes: [{ uri, edits: [{ range, newText }] }] }` |
| `codeActions` | `textDocument/codeAction` | `path`, `range` (+ optional `context`) | action list; each entry may carry a `workspaceEdit` proposal |
| `resolveCodeAction` | `codeAction/resolve` | `codeAction` (exact returned item) | resolved action, same shape |
| `formatDocument` | `textDocument/formatting` | `path` (+ optional `formatting { tabSize, insertSpaces }`) | `TextEdit[]` proposal for the whole document |
| `formatRange` | `textDocument/rangeFormatting` | `path`, `range` | `TextEdit[]` proposal for the range |
| `formatOnType` | `textDocument/onTypeFormatting` | `path`, `position` | `TextEdit[]` proposal at the trigger position |

Validated-shape guarantees (field matrix + value checks in
`validateStrictRequest`): unknown operations rejected; foreign fields
rejected per-op (e.g. `rename`+`query` rejected, `codeActions` requires
`path`+`range`, `formatRange` requires `path`+`range`, `formatDocument`
requires `path`); `position`/`range` must be 0-based non-negative integers;
`newName`/`query`/`method` non-empty strings; `formatting` must be
`{ tabSize: positive int, insertSpaces: boolean }`; `item`/`context`/
`codeAction`/`params` must be records. Anything else is a tool error —
SmartEdit will never receive a malformed proposal request result, only an
error or a validated envelope.

Retry policy SmartEdit must know: pure observational reads retry exactly
once on server crash; `rename` and raw `request` NEVER auto-retry
(non-idempotent). Verified: `executor.test.ts` ("retry-once on crash for
idempotent read", "no-retry for rename (non-idempotent)", "no-retry for
raw request even on crash").

## 3. Evidence and freshness fields SmartEdit must check

On every envelope, before using a proposal:

1. `status` MUST be `ok`. `empty` means supported-but-nothing-returned
   (no proposal — do not treat as success-with-edits). `unsupported`,
   `unavailable`, `not_ready`, `timeout`, `cancelled`, `error`,
   `ambiguous` all mean NO usable proposal.
2. `server` provenance: record `descriptorId`, `name`, `languageId`,
   `projectRoot`, `positionEncoding`. Positions in the proposal are in
   `server.positionEncoding` (0-based) — convert before applying to a
   buffer with a different encoding.
3. `meta.freshness.state`: direct strict-`lsp` consumers MUST use a
   proposal only when `meta.freshness.state === "fresh"`. The
   language-intelligence RPC does not expose the strict envelope; SmartRead
   therefore enforces the same gate before returning any rename/format/
   organize-imports/code-action WorkspaceEdit. `stale`/`unknown` becomes
   RPC error `unconfirmed`, never a usable proposal.
4. `meta.documentVersion` + `meta.readiness`: for direct strict-`lsp`
   use, if `documentVersion` does not match the buffer SmartEdit is about
   to mutate, discard the proposal and re-request. `readiness`, when
   present, is additional indexing evidence, not a substitute for freshness.
5. `meta.truncated` + `meta.nextCursor`: list-bearing results
   (`codeActions`, `completion`) may paginate. Cursors are opaque
   base64url random-id tokens (256-entry store, 10-min TTL,
   `src/lsp/lsp-cursor-store.ts`) — pass `nextCursor` back verbatim as
   `cursor`; never construct or decode them. Invalid/expired cursor is a
   caller error: restart pagination.
6. `result` shape: `rename` and code-action embedded edits arrive
   as normalized `{ changes: [{ uri, edits }] }` with `file://` URIs.
   Formatting follows LSP and returns normalized `TextEdit[]`; the
   SmartRead RPC adapter wraps those edits into a one-file WorkspaceEdit
   before `validateWorkspaceEdit`. Null/empty results mean nothing
   actionable — surface "no proposal", not an empty edit.
7. `error` on non-`ok` envelopes carries `code`/`message`/`data` — log
   `server.descriptorId` + `method` + `error.code` for routing bugs.

## 4. Language-intelligence RPC mapping (existing handlers to executor ops)

Transport: RPC channel `languageIntelligence`
(`RPC_CHANNELS.languageIntelligence`), method names from
`LANGUAGE_INTELLIGENCE_RPC_METHODS` in
`@rhinos0608/pi-workspace-protocol`. Every handler below already sources
via `runExecutor -> executeLspOperation` with zero disk writes
(`src/language-intelligence/language-intelligence-provider.ts`).

| RPC method (wire string) | Executor op + params | Handler behavior |
| --- | --- | --- |
| `language_intelligence_capabilities` (`capabilities`) | none (static capability advertisement) | returns provider capabilities; no LSP call |
| `check_post_edit_diagnostics` (`checkPostEditDiagnostics`) | `diagnostics` with `{ path: canonicalPath, workspace: canonicalWorkspaceRoot, timeoutMs: 10000 }` | pre-hash file, require `expectedContentSha256` match; executor call; only `fresh` + `ok`/`empty` count as `confirmed`/`empty`, everything else `unconfirmed`/`unavailable`; post-hash re-check; normalize diagnostics (severity 1-4, ranges, source cap 256, message cap 16384, maxDiagnostics cap with `truncated`) |
| `rename_preview` (`renamePreview`) | `rename` with `{ path: filePath, position: 0-based {line, character}, newName, workspace: workspaceRoot, timeoutMs: 10000 }` | requires fresh envelope; converts normalized edit to file edits, `validateWorkspaceEdit`, returns `{ ok: true, workspaceEdit }` or `{ ok: false, error }`; never writes |
| `organize_imports` (`organizeImports`) | `codeActions` with full-document range + `context: { only: [\"source.organizeImports\"] }` | requires fresh envelope; takes first actionable edit, `validateWorkspaceEdit`, returns `{ ok: true, workspaceEdit }`; never writes |
| `formatting` (`formatting`) | `formatDocument` with `{ path: filePath, formatting: { tabSize, insertSpaces }, workspace: workspaceRoot, timeoutMs: 10000 }` | requires fresh envelope; converts protocol `TextEdit[]` into one-file WorkspaceEdit, validates it, returns `{ ok: true, workspaceEdit }`; never writes |
| `code_action` (`codeAction`) | `codeActions` with `{ path: filePath, range, context, workspace: workspaceRoot, timeoutMs: 10000 }` | requires fresh envelope; returns action list with per-action validated `workspaceEdit` where present; never writes |

All six handlers inject a fake executor in unit tests via
`__setLanguageIntelligenceExecutorForTests`; production dynamically
imports the canonical executor. That seam is the integration point
SmartEdit mirrors on its side (inject fake envelopes in SmartEdit tests).

## 5. Explicit UNMET needs — SmartEdit-side approval required (PENDING sister-repo owner decision)

1. **Transaction-owned workspace/applyEdit approval flow.** There is no
   agreed two-phase apply: SmartRead answers `workspace/applyEdit` with
   `applied:false` and keeps only a bounded proposal record; SmartEdit
   applies via its own path. UNMET: who owns the transaction id, what
   "preview token -> approved apply" round-trip looks like, rollback on
   partial failure, and where the audit record lives. SmartEdit owner
   must approve the flow design before implementation; do NOT build a
   SmartRead-side apply path in the meantime (criterion 13 forbids it).
2. **Cross-operation freshness/lease token.** `documentVersion` +
   `freshness` + `readiness` are per-envelope advisory fields; there is
   no session lease token SmartEdit can hold across prepare-then-apply.
   UNMET: lease issuance/renewal/expiry semantics and clock source.
3. **Proposal lifetime/TTL contract.** Cursor TTL (10 min) is specified;
   proposal (WorkspaceEdit) staleness horizon is NOT: how long a rename
   preview stays valid, and what invalidates it (any write? any
   diagnostic change?). SmartEdit owner must set the TTL/invalidation
   rule.
4. **Multi-file proposal atomicity — split verdict (2026-09-23).** (a) Handled-failure rollback is **deliberately out-of-scope for SmartRead** (owner: SmartEdit, 2026-09-23): any preview TTL/retention and any rollback after a partially applied proposal are SmartEdit-owned behaviors (§6a), not visible on the wire. (b) Process-crash all-or-nothing apply across files is UNMET: no contract yet, SmartEdit-owner decision required before implementation.
5. **Encoding conversion ownership — PENDING sister-repo owner decision (owner: SmartEdit, 2026-09-23).** Proposals are in
   `server.positionEncoding`; SmartEdit buffers may differ. UNMET:
   confirm SmartEdit owns conversion (using `lsp-position-codec`
   semantics) and which encoding mismatches are hard errors. Until decided, the RPC proposal path stays UTF-16-only fail-closed (§6a); a wire-level explicit encoding field does NOT exist yet (see §6b).
6. **Progress/cancellation propagation — PENDING sister-repo owner decision (owner: SmartEdit, 2026-09-23).** Executor honors AbortSignal
   (`cancelled` status); no RPC-level progress/cancel wire exists on the
   language-intelligence channel. UNMET: cancel RPC shape + deadline
   propagation (`timeoutMs` per call is currently fixed at 10s in the
   provider).
7. **Diagnostic continuity token.** Provider passes `previousResultId`
   only when cached (`executor.test.ts` pull-continuity test); no
   cross-process resultId handoff exists for SmartEdit. UNMET if SmartEdit
   wants incremental post-edit diagnostics.

Concrete enough to implement: for each RPC row in section 4, SmartEdit
sends the listed params, checks section 3 gates in order, validates with
`validateWorkspaceEdit`, then applies via its own mutation path. Anything
in section 5 needs a SmartEdit-owner decision first — do not assume.

Phase-completion scope (2026-09-23, Round 3/8 lane docs): this phase completes the SmartRead-side
guarantees only (sections 1–4 + §6a local behaviors). SmartEdit-side
consumption, the proposal-approval flow (§5.1), process-crash multi-file atomicity (§5.4b),
and all other §5/§6b items remain PENDING sister-repo owner decision (owner: SmartEdit, 2026-09-23). No
cross-repo policy is invented here — SmartEdit owns its transaction,
TTL/invalidation, atomicity, and conversion rules.

## 6. Local behaviors (already owned) vs unresolved cross-repo guarantees

Do not confuse what each side already does locally with what the wire
promises. The left column holds without any new agreement; the right
column has no contract yet — do not assume it.

### 6a. Local behaviors — hold today, no agreement needed

- **UTF-16-only RPC proposal positions (SmartRead-local, fail-closed).**
  RPC edit DTOs carry no encoding and the SmartEdit planner assumes
  UTF-16, so proposal paths reject non-UTF-16 negotiated encodings with
  `unsupported-encoding` instead of converting (`RPC_PROPOSAL_POSITION_ENCODING`,
  `isRpcProposalEncodingSupported` in
  `src/language-intelligence/language-intelligence-provider.ts`; verified:
  `test/unit/language-intelligence/language-intelligence-encoding-guard.test.ts`).
  The direct strict-`lsp` path is unaffected — negotiated encoding stays
  surfaced via `server.positionEncoding`.
- **Fixed local timeouts (SmartRead-local).** Every provider call passes
  `timeoutMs: 10000` to `runExecutor`
  (`src/language-intelligence/language-intelligence-provider.ts`); there is
  no per-call deadline negotiation and no wire propagation of SmartEdit
  deadlines.
- **SmartRead-session resultId continuity (SmartRead-local).** The executor
  threads `previousResultId` only when its own broker holds pull cache
  (verified: `test/unit/lsp/executor.test.ts` "diagnostics: pull continuity
  passes previousResultId only with cache"). Continuity does not cross
  processes — a SmartEdit restart or a different SmartRead session starts
  with no `previousResultId`.
- **Preview cache, handled-failure rollback (SmartEdit-local).** Any
  proposal TTL/retention on the SmartEdit side and any rollback after a
  partially applied proposal are SmartEdit-owned behaviors: they are not
  visible on the wire, not negotiated here, and SmartRead makes no promise
  about proposal lifetime beyond cursor TTL (10 min, `src/lsp/lsp-cursor-store.ts`).

### 6b. Unresolved guarantees — no contract yet, owner decision required

- **Cross-repo lease.** No session lease token spans SmartRead + SmartEdit
  (extends §5.2): SmartRead-side session leases
  (`test/unit/lsp/session-lease.test.ts`) protect against local eviction
  only.
- **Crash atomicity (process crash — UNMET, owner: SmartEdit, 2026-09-23).** Multi-file proposals are shape-validated only;
  all-or-nothing apply across a process crash is unagreed (extends §5.4b). Contrast handled-failure rollback, which is deliberately out-of-scope for SmartRead / SmartEdit-owned (§5.4a, §6a). Crash journaling (durability/replay log for interrupted applies) is likewise SmartEdit-owned — it is not a SmartRead gate and no journal contract is defined here.
- **Wire encoding field (UNMET, owner: SmartEdit, 2026-09-23).** Proposals are implicitly UTF-16 (see §6a); there
  is no explicit encoding field on the RPC DTO, so a future non-UTF-16
  server would surface as `unsupported-encoding`, never converted
  (extends §5.5).
- **Wire cancel/progress + per-call deadline (UNMET, owner: SmartEdit, 2026-09-23).** Executor honors AbortSignal locally
  (`cancelled` status); no RPC-level cancel/progress shape exists on the
  language-intelligence channel, and provider→executor deadlines are clamped locally (`clampLanguageIntelligenceTimeout` [250, 30000]ms, default 10s, exact pass-through) with no wire deadline propagation from SmartEdit (extends §5.6).
- **Cross-process continuity.** No resultId handoff exists across SmartEdit
  restarts or SmartRead sessions (extends §5.7; contrast §6a).
