# LSP Conformance Matrix

**Date:** 2026-09-23
**Status:** Round 5/8 final docs sweep (2026-09-23) — protocol v0.6.0 / schema 5 pinned; T12 barrier implemented+tested; workspaceDiagnostics identifier + continuity implemented+tested; R4 PASS (exact descriptorId, no name alias, multi-session ambiguous); deadline clamp live (250/10s/30s, provider→executor exact, diagnostics 4s service/5s transport); UTF-16 explicit on proposals (P7 fail-closed guard); skills 9 validated; RS2–RS5 strict CI matrix exists (4 lanes, pins, fail-on-skip); crash journal SmartEdit-owned (not a SmartRead gate). Waves 4–5 landed — canonical executor, strict contract, affinity, cursors, single `lsp` tool, inspection/provider migration sourced from the executor (see §8 S1–S11 implemented+tested); R5 multi-role routing implemented+tested (`test/unit/lsp/multi-role-routing.test.ts`); D9 strict file-diagnostics paired case implemented+tested (`test/unit/lsp/executor.test.ts`); RPC proposal-path encoding guard implemented+tested (`test/unit/language-intelligence/language-intelligence-encoding-guard.test.ts`); real-server suite RS1–RS7 created, RS1/RS6/RS7 implemented+tested (opt-in suite), RS2–RS5 externally constrained (skip-honest without pinned binaries; strict enforcement lives in `.github/workflows/lsp-conformance.yml`, see Wave D).
**Source plan:** `docs/plans/2026-09-22-lsp-semantic-substrate-plan.md` (§ Conformance-oriented testing)
**Owner:** Pi-SmartRead

This document is the executable conformance matrix promised by the plan. Every row names the
test file that proves it. Rows marked **implemented+tested** point at an existing test file that proves it.
Rows marked **phase gate** name the blocking condition and the verdict that
unblocks them. Rows marked **externally constrained** name the missing
external prerequisite (binary, CI lane, sister-repo decision) — their tests
exist and skip honestly until it arrives. Rows marked **deliberately
out-of-scope** name the owner and date of the scoping decision; no test will
ever be written for them here.

## Legend

| Label | Meaning |
| --- | --- |
| **implemented+tested** | Existing test file proves it, runs today (default suite) or opt-in suite where noted. |
| **deliberately out-of-scope** | Not built by design; names owner + date. Do not build without owner decision. |
| **externally constrained** | Blocked by environment outside repo (binaries, CI); skip/evidence cited, never counted as pass. |
| **phase gate** | Implemented but awaiting fresh verdict before counted complete. |

Status vocabulary and semantics come from the plan's result envelope (`ok | empty | unsupported |
unavailable | not_ready | timeout | cancelled | error | ambiguous`). Existing tests use the older
`degraded` bridge vocabulary; rows relying on them are noted where the vocabulary differs.

## Naming conventions (inspected from current tree)

- Unit tests: `test/unit/lsp/<subject>.test.ts` — e.g. `lsp-bridge-diagnostics.test.ts`,
  `lsp-uri-path.test.ts`. Kebab-case subject, `.test.ts` suffix, `describe` names either the
  module (`"lspUriToPath"`) or a scoped label (`"LSPConnection diagnostics plumbing"`).
- Related non-`lsp/` LSP tests live near their subject:
  `test/unit/repomap/repomap-lsp-fallback.test.ts`, `test/unit/inspect/inspect-focus-lazy-lsp.test.ts`.
- Vitest include is `test/**/*.test.ts`, so planned integration files go under
  `test/integration/lsp/` and are picked up automatically.
- Fake-server fixture pattern already exists: `FakeProc` + `encodeMessage` helpers in
  `test/unit/lsp/lsp-bridge-diagnostics.test.ts`, reused by `lsp-bridge-rename.test.ts` and
  `lsp-bridge-semantic-actions.test.ts` (each file defines its own copy today).

---

## 1. Transport matrix

| # | Conformance requirement | Status | Test file |
| --- | --- | --- | --- |
| T1 | response vs server request vs notification classification (`id`+no `method` / `id`+`method` / `method`+no `id`) | **implemented+tested** | `test/unit/lsp/transport-classification.test.ts` |
| T2 | server request ID collision with client-issued pending IDs | **implemented+tested** | `test/unit/lsp/transport-classification.test.ts` |
| T3 | `workspace/configuration` server request answered from descriptor settings | **implemented+tested** | `test/unit/lsp/transport-classification.test.ts` (ordered null replies + per-item fingerprint settings) |
| T4 | `workspace/workspaceFolders` server request handling | **implemented+tested** | `test/unit/lsp/transport-classification.test.ts` (reply path) + `test/unit/lsp/initialize-capabilities.test.ts` (init advertises workspace folders) |
| T5 | dynamic `client/registerCapability` / `client/unregisterCapability` | **implemented+tested** | `test/unit/lsp/transport-classification.test.ts` (register feeds registry, unregister stops issuance) |
| T6 | `$/cancelRequest` distinguished from timeout and caller abort | **implemented+tested** | `test/unit/lsp/transport-classification.test.ts` (abort settles cancelled, sends $/cancelRequest, bounded tombstone absorbs late response) |
| T7 | process crash/error rejects every pending request with typed transport error | **implemented+tested** | `test/unit/lsp/lsp-bridge-diagnostics.test.ts` (process error/exit rejection + FRAME-OVERFLOW) |
| T8 | graceful `shutdown` request then `exit` notification ordering | **implemented+tested** | `test/unit/lsp/lsp-connection.test.ts` ("sends shutdown request then exit notification in order", asserts shutdown index < exit index) |
| T9 | malformed frame/JSON ignored; buffered framing; buffer limits | **implemented+tested** | `test/unit/lsp/lsp-bridge-diagnostics.test.ts` (FRAME-MALFORMED-JSON, FRAME-BUFFERED, FRAME-EXTRA-HEADER, FRAME-OVERFLOW, FRAME-HANDLER-ISOLATION) |
| T10 | `$/progress` / work-done token tracking exposed as readiness evidence | **implemented+tested** | `test/unit/lsp/workdone-progress.test.ts` (create handler registers token, returns null) + `test/unit/lsp/readiness-tracker.test.ts` (begin/report settling, end confirmed) + `test/unit/lsp/initialize-capabilities.test.ts` (create → progress → readiness chain) |
| T11 | `workspace/applyEdit` rejected `applied: false`, never mutates disk | **implemented+tested** | `test/unit/lsp/transport-classification.test.ts` (unsolicited applyEdit block; retained-proposal bound `APPLY_EDIT_PROPOSAL_LIMIT`) |
| T12 | send-before-handshake ordering (requests issued before init completes): handshake barrier queues, `initialized` precedes queued frames, abort sends nothing, init failure rejects queued, server `workspace/configuration` during init answered immediately | **implemented+tested** | `test/unit/lsp/lsp-connection-handshake.test.ts` ("LSPConnection handshake barrier (T12)", 5 cases) |
| T13 | unknown server-request method answered `-32601`; unknown raw method rejected fail-closed | **implemented+tested** | `test/unit/lsp/transport-classification.test.ts` ("unknown still -32601") + `test/unit/lsp/raw-method-policy.test.ts` ("rejects unknown methods, including custom and lifecycle methods", `unknown-method` reason) |

## 2. Position matrix

| # | Conformance requirement | Status | Test file |
| --- | --- | --- | --- |
| P1 | ASCII positions, 0-based strict-tool contract vs 1-based inspect adapter seam | **implemented+tested** (adapter seam only) | `test/unit/lsp/lsp-inspection.test.ts` ("1-based line/character translated to 0-based internally"), `test/unit/lsp/lsp-bridge-diagnostics.test.ts` ("1-based public pos translated to 0-based internally") |
| P2 | negotiated `utf-8` encoding recorded on session and returned in envelope | **implemented+tested** | `test/unit/lsp/position-codec.test.ts` (defaults utf-16, honors server positionEncodings, standard positionEncoding) |
| P3 | emoji/astral code points round-trip under each negotiated encoding | **implemented+tested** | `test/unit/lsp/position-codec.test.ts` (astral counts, emoji ZWJ round-trip) |
| P4 | combining marks round-trip under each negotiated encoding | **implemented+tested** | `test/unit/lsp/position-codec.test.ts` (combining mark counts per encoding) |
| P5 | mixed UTF-8/UTF-16-sensitive positions | **implemented+tested** | `test/unit/lsp/position-codec.test.ts` (mixed script converts source-first) |
| P6 | returned position reusable directly as input to the next `LSP` operation (no display conversion) | **implemented+tested** | `test/unit/lsp/position-codec.test.ts` (round-trips every boundary offset) |
| P7 | RPC proposal path is UTF-16-only and fail-closed: non-UTF-16 negotiated encoding rejects `unsupported-encoding`, never converts; strict direct path unaffected | **implemented+tested** | `test/unit/language-intelligence/language-intelligence-encoding-guard.test.ts` (utf-16 passes; utf-8/utf-32 rejected on renamePreview/codeAction/formatting/organizeImports; strict utf-8 envelope reaches executor unconverted; non-UTF-16 diagnostics degrade to unconfirmed) — guard: `RPC_PROPOSAL_POSITION_ENCODING` in `src/language-intelligence/language-intelligence-provider.ts` |

## 3. Capability matrix

| # | Conformance requirement | Status | Test file |
| --- | --- | --- | --- |
| C1 | static supported capability → request issued | **implemented+tested** | `test/unit/lsp/capability-registry.test.ts` (static caps enable typed ops) |
| C2 | static unsupported capability → `unsupported` (not `empty`) | **implemented+tested** | `test/unit/lsp/capability-registry.test.ts` (absent caps deny typed ops) |
| C3 | dynamically added capability becomes available without restart | **implemented+tested** | `test/unit/lsp/capability-registry.test.ts` (dynamic register enables) |
| C4 | dynamically removed capability stops request issuance | **implemented+tested** | `test/unit/lsp/capability-registry.test.ts` (unregister stops issuance) |
| C5 | raw `request` operation independent of typed capability adapters | **implemented+tested** | `test/unit/lsp/raw-method-policy.test.ts` |
| C6 | raw `request` fails closed on mutating methods (`workspace/executeCommand`, `workspace/applyEdit`, unknown custom) | **implemented+tested** | `test/unit/lsp/raw-method-policy.test.ts` |

## 4. Document/diagnostic matrix

| # | Conformance requirement | Status | Test file |
| --- | --- | --- | --- |
| D1 | cold `didOpen` on first touch | **implemented+tested** | `test/unit/lsp/lsp-bridge-diagnostics.test.ts` ("sends didOpen (not didChange) on first touch") |
| D2 | subsequent touch sends `didChange`, not re-`didOpen` | **implemented+tested** | `test/unit/lsp/lsp-bridge-diagnostics.test.ts` |
| D3 | `didChange` serialized per document; monotonic version | **implemented+tested** | `test/unit/lsp/document-store.test.ts` (per-document serialization, monotonic versions, mutation generation) |
| D4 | stale cached diagnostics cleared on `didChange` (edit invalidates stale results) | **implemented+tested** | `test/unit/lsp/lsp-bridge-diagnostics.test.ts` ("clears cached diagnostics on didChange", "getFreshDiagnosticsOutcome clears stale cached diagnostics") |
| D5 | push-only diagnostics cache with receipt/version tracking | **implemented+tested** | `test/unit/lsp/diagnostics-broker.test.ts` (push cache source push + receipt; version optional; post-edit invalidation) |
| D6 | pull-only `textDocument/diagnostic` support | **implemented+tested** | `test/unit/lsp/diagnostics-broker.test.ts` (pull source, unsupported stays unconfirmed, null failure vs confirmed-empty) |
| D7 | push + pull coexistence with `source: pull \| push \| workspace-pull` | **implemented+tested** | `test/unit/lsp/diagnostics-broker.test.ts` (workspace pull source workspace-pull, identifier/previousResultId threading) |
| D8 | dynamic pull-diagnostic registration | **implemented+tested** | `test/unit/lsp/diagnostics-broker.test.ts` (registry-driven dynamic workspace/diagnostic registration) |
| D9 | confirmed empty result distinguished from no-evidence (no receipt → never reported clean) | **implemented+tested** | `test/unit/lsp/lsp-bridge-diagnostics.test.ts` ("distinguishes confirmed-empty from unconfirmed no-response", "closed connection null pull returns degraded not empty"), `test/unit/lsp/executor.test.ts` ("diagnostics (file): confirmed-empty pull → empty+fresh; absent/null/unsupported-pull → not_ready+null+unknown" paired case; "diagnostics: pull-unconfirmed falls back to unconfirmed push → not_ready"; "publishedDiagnostics: unconfirmed push → not_ready (not empty)"; "workspaceDiagnostics via explicit server: confirmed-empty stays empty, items stay ok with reports") |
| D10 | `resultId` reuse and invalidation: broker persists per-uri last pull (`getPullState`); `kind:"unchanged"` WITH cache replays cached diagnostics confirmed, WITHOUT cache stays unconfirmed (never clean); `invalidate`/`clear` drop pull cache, `clearPush` preserves it; bridge pre-refresh uses `clearPush` and sources `previousResultId` broker→store→null | **implemented+tested** | `test/unit/lsp/diagnostics-broker.test.ts` (persistence/replay/invalidation) + `test/unit/lsp/lsp-bridge-diagnostics.test.ts` (replay + `previousResultId` wiring, unmasked) |
| D11 | `readiness.state`/`basis` evidence (`confirmed \| settling \| unknown`) | **implemented+tested** | `test/unit/lsp/readiness-tracker.test.ts` (unknown/settling/confirmed per-token, no universal gate) |
| D12 | `freshness.state` on diagnostics/proposal results (`fresh \| stale \| unknown`) with document version evidence | **implemented+tested** | `test/unit/lsp/executor.test.ts` (post-request file-hash freshness, fresh/stale states + documentVersion) + `test/unit/language-intelligence/language-intelligence-provider.test.ts` (stale/unknown proposal rejection) |

## 5. Normalization matrix

| # | Conformance requirement | Status | Test file |
| --- | --- | --- | --- |
| N1 | `Location \| Location[] \| LocationLink[]` variants | **implemented+tested** | `test/unit/lsp/response-normalizer.test.ts` |
| N2 | `DocumentSymbol[] \| SymbolInformation[]` variants | **implemented+tested** | `test/unit/lsp/response-normalizer.test.ts` |
| N3 | `MarkupContent \| MarkedString \| MarkedString[]` hover variants | **implemented+tested** | `test/unit/lsp/response-normalizer.test.ts` |
| N4 | `CompletionItem[] \| CompletionList` variants | **implemented+tested** | `test/unit/lsp/response-normalizer.test.ts` |
| N5 | `CodeAction \| Command` variants | **implemented+tested** (CodeAction path also implemented+tested) | `test/unit/lsp/response-normalizer.test.ts`; existing partial: `test/unit/lsp/lsp-bridge-semantic-actions.test.ts` (codeActions mapping, null → empty) |
| N6 | WorkspaceEdit `changes` vs `documentChanges`, fail-closed on malformed entries, resource-operation rejection, URI handling | **implemented+tested** | `test/unit/lsp/lsp-bridge-diagnostics.test.ts` (WS-FAIL-CLOSED, WS-RESOURCE-OPS, WS-PRECEDENCE, WS-URI-PATH, WS-INVALID-URI, WS-FILEPATH-DUP), `test/unit/lsp/lsp-bridge-rename.test.ts` |
| N7 | `prepareRename` result variants (range / direct Range / null) | **implemented+tested** | `test/unit/lsp/lsp-bridge-rename.test.ts` |
| N8 | semantic-token full/range/delta variants | **implemented+tested** | `test/unit/lsp/response-normalizer.test.ts` |
| N9 | call/type hierarchy items preserve opaque server `data` | **implemented+tested** | `test/unit/lsp/response-normalizer.test.ts` |

## 6. Routing/lifetime matrix

| # | Conformance requirement | Status | Test file |
| --- | --- | --- | --- |
| R1 | extension/filename → language routing; project-marker root detection | **implemented+tested** | `test/unit/lsp/lsp-bridge-catalog.test.ts` (routing + project marker detection blocks) |
| R2 | nested project-root detection | **implemented+tested** | `test/unit/lsp/session-identity.test.ts` (nearest ancestor marker wins) |
| R3 | two valid same-language servers → `ambiguous`, never silent pick | **implemented+tested** | `test/unit/lsp/session-identity.test.ts` (multi same-language throws without explicit selection) |
| R4 | explicit `server` selection routes exactly: exact `descriptorId` match, no display-name alias, multi same-language sessions without selection stay ambiguous | **implemented+tested** | `test/unit/lsp/r4-exact-routing.test.ts` (7 cases: pathful two-server selects exactly B; pathless descriptorId selects matching live session; connection-name differing from descriptorId does NOT select — no name alias; missing descriptor never spawns/falls back; two live same-descriptor sessions → ambiguous not first-match; lease held; provenance returns selected descriptorId exactly) + `test/unit/lsp/session-identity.test.ts` (multi same-language `AmbiguousServerError` without selection) |
| R5 | semantic server + linter/formatter roles coexist: role-tagged configs throw `AmbiguousServerError` without explicit selection; `role` or `descriptorId` selects exactly; same-role duplicates stay ambiguous; no public `role` field on the strict tool (internal session-selection only) | **implemented+tested** | `test/unit/lsp/multi-role-routing.test.ts` ("R5 multi-role routing": ambiguous without selection, exact role pick semantic-vs-linter, exact descriptorId pick, distinct session keys per role, ambiguous-within-one-role, resolver preserves descriptor `roles[0]` metadata) |
| R6 | active lease survives cache pressure (no eviction mid-request) | **implemented+tested** | `test/unit/lsp/session-lease.test.ts` (leased session survives reap; leased manager refuses eviction) |
| R7 | zero-lease idle reaping closes only idle sessions | **implemented+tested** | `test/unit/lsp/session-lease.test.ts` (zero-lease idle reaped; fresh entries survive; acquire/release counts) |
| R8 | config fingerprint creates/replaces the correct session | **implemented+tested** | `test/unit/lsp/session-identity.test.ts` (settings/initOptions change replaces key; schema version pinned; stale zero-lease invalidated) |
| R9 | idempotent observational read retries exactly once after typed crash | **implemented+tested** | `test/unit/lsp/session-lease.test.ts` (dead-connection retries idempotent once, non-idempotent rethrows) |
| R10 | mutation/proposal/unknown raw request never auto-retries | **implemented+tested** | `test/unit/lsp/session-lease.test.ts` (non-idempotent rethrows) + `test/unit/lsp/raw-method-policy.test.ts` (mutating methods fail closed) |
| R11 | lazy start: no spawn on module load or non-semantic inspect | **implemented+tested** | `test/unit/lsp/lsp-bridge-lazy-start.test.ts`, `test/unit/inspect/inspect-focus-lazy-lsp.test.ts`, `test/unit/repomap/repomap-lsp-fallback.test.ts` |
| R12 | descriptor initialization options/settings reach session creation | **implemented+tested** (session-key/fingerprint level; real-server delivery stays RS-gated) | `test/unit/lsp/session-identity.test.ts` (fingerprint replaces on settings/initOptions change); init advertisement: `test/unit/lsp/initialize-capabilities.test.ts` |

## 7. Real-server integration suite (plan: "Protocol conformance bugs frequently appear only against real server behavior")

All rows opt-in: gated `describe.skipIf(!REAL_LSP_ENABLED)` where `REAL_LSP_ENABLED =
PI_SMARTREAD_LSP_CONFORMANCE=1 || PI_REAL_SERVER=1` (shared harness
`test/integration/lsp/real-server-harness.ts`), skipped in default `npm test`, require the
binary on `PATH` (per-case `ctx.skip()` with explicit reason when absent — skips are
never counted as passes). Verified 2026-09-23 against installed
`typescript-language-server` v5.1.3 (`/opt/homebrew/bin`): 12 passed / 1 skipped.
Harness notes: fixture roots are `realpathSync`ed (`/tmp` → `/private/tmp` symlink
otherwise makes tsserver report "Unexpected resource" for every didOpen);
`prepareDocument` re-syncs from disk, so formatting/codeAction fixtures are written
to disk rather than via `didChange`.

| # | Server | Status | Test file |
| --- | --- | --- | --- |
| RS1 | TypeScript language server (`typescript-language-server`) | **implemented+tested** (opt-in suite) (doc sync, hover, formatting, codeAction, push diagnostics, cancel, shutdown, provenance; 6 cases, v5.1.3) | `test/integration/lsp/real-server-typescript.test.ts` |
| RS2 | Pyright | **externally constrained — controlled CI required** (init + doc sync, hover, encoding + provenance; 3 cases; SKIPs honestly when `pyright-langserver` absent from PATH — skip is environment evidence, not a pass) | `test/integration/lsp/real-server-pyright.test.ts` |
| RS3 | gopls | **externally constrained — controlled CI required** (init + doc sync, hover, encoding + provenance; 3 cases; SKIPs honestly when `gopls` absent from PATH — skip is environment evidence, not a pass) | `test/integration/lsp/real-server-gopls.test.ts` |
| RS4 | rust-analyzer | **externally constrained — controlled CI required** (init + doc sync, hover, encoding + provenance; 3 cases; SKIPs honestly when `rust-analyzer` absent or not runnable — skip is environment evidence, not a pass) | `test/integration/lsp/real-server-rust-analyzer.test.ts` |
| RS5 | clangd | **externally constrained — controlled CI required** (init + doc sync, hover, encoding + provenance; 3 cases; SKIPs honestly when `clangd` absent or hover contents unavailable — skip is environment evidence, not a pass) | `test/integration/lsp/real-server-clangd.test.ts` |
| RS6 | server heavy on dynamic configuration/registration | **implemented+tested** (opt-in suite) (didChangeConfiguration + workspaceFolders pass; 3 cases; `client/registerCapability` case skips honestly when the server sends no registration within 12s — skip is the designed verdict, not a gap) | `test/integration/lsp/real-server-dynamic-config.test.ts` |
| RS7 | initialization gate: servers that request `workspace/configuration`/`workspace/workspaceFolders` initialize without deadlock or silent request loss (plan § Implementation order, gate 1) | **implemented+tested** (opt-in suite) (init, framing, configuration liveness, shutdown ordering; 4 cases, v5.1.3) | `test/integration/lsp/real-server-initialize.test.ts` |

---

## Current Wave 3 coverage summary (2026-09-23: LSP unit 29 files — `multi-role-routing.test.ts` landed since the 28-file/514-passed run; typecheck exit 0)

Waves 1–3 landed unit coverage: transport classification + server requests + cancellation (T1–T6, T8, T10–T13), raw-method policy (C5/C6), response normalization (N1–N5, N8/N9), capability registry (C1–C4), position codec + negotiation + RPC encoding guard (P2–P7), document store + sync encoding (D3/D4), diagnostics broker + readiness (D5–D11 incl. D9 paired case), session identity/leases/retry + multi-role routing (R2–R10, R12, R5).

Implemented+tested today (existing files, default `npm test`):

- `test/unit/lsp/lsp-bridge-diagnostics.test.ts` — framing robustness, didOpen/didChange/didSave, push-cache invalidation, confirmed-empty vs no-response, timeout/AbortSignal, WorkspaceEdit characterization.
- `test/unit/lsp/lsp-bridge-rename.test.ts` — rename/prepareRename result variants.
- `test/unit/lsp/lsp-bridge-semantic-actions.test.ts` — codeAction/organizeImports/formatting request shapes and mapping.
- `test/unit/lsp/lsp-inspection.test.ts` — coordinate seam, outcome statuses, timeout bounding, call-hierarchy convenience.
- `test/unit/lsp/lsp-bridge-catalog.test.ts` — descriptor catalog, language routing, project markers.
- `test/unit/lsp/workdone-progress.test.ts` — T10 `window/workDoneProgress/create` handler (Wave 3, new).
- `test/unit/lsp/initialize-capabilities.test.ts` — init honesty (dynamicRegistration, workDoneProgress, workspace folders/configuration, positionEncodings, publishDiagnostics versionSupport) + create→progress→readiness chain (Wave 3, new).
- `test/unit/lsp/capability-registry.test.ts` — C1–C4 static/dynamic gating (Wave 3).
- `test/unit/lsp/document-store.test.ts` — D3/D4 openClose/change split, baseText ranges, monotonic versions, serialization (Wave 3).
- `test/unit/lsp/document-sync-encoding.test.ts` — multibyte incremental ranges utf-8/utf-32 (Wave 3, new).
- `test/unit/lsp/diagnostics-broker.test.ts` — D5–D8, D10 push/pull/workspace-pull + invalidation (Wave 3).
- `test/unit/lsp/readiness-tracker.test.ts` — D11/T10 settling/confirmed per-token (Wave 3).
- `test/unit/lsp/position-codec.test.ts` — P2–P6 encodings, astral/emoji/combining, round-trips (Wave 3).
- `test/unit/lsp/session-identity.test.ts` — R2–R4 routing, R8 fingerprint, R12 settings reach (Wave 3).
- `test/unit/lsp/session-lease.test.ts` — R6/R7 leases/reaping, R9/R10 exactly-once retry, strict no-install (Wave 3).
- `test/unit/lsp/lsp-bridge-lazy-start.test.ts` — no spawn on import / non-semantic inspect.
- `test/unit/lsp/lsp-uri-path.test.ts` — URI ↔ path conversion.
- `test/unit/lsp/transport-classification.test.ts` — T1/T2 classification + T3 configuration replies + T4 workspaceFolders + T5 register/unregister + T6 cancel/tombstone + T11 applyEdit rejection + T13 unknown-method `-32601` + retained-proposal FIFO bound (Waves 1–3).
- `test/unit/lsp/multi-role-routing.test.ts` — R5 role-tagged exact/ambiguous routing (new).
- Adjacent: `test/unit/language-intelligence/language-intelligence-encoding-guard.test.ts` — P7 RPC UTF-16-only fail-closed guard (new).
- `test/unit/lsp/raw-method-policy.test.ts` — C5/C6 raw-policy gates (Wave 1).
- `test/unit/lsp/response-normalizer.test.ts` — N1–N9 normalizer variants (Wave 1).
- Adjacent: `test/unit/inspect/inspect-focus-lazy-lsp.test.ts`, `test/unit/repomap/repomap-lsp-fallback.test.ts`, `test/unit/language-intelligence/language-server-catalog.test.ts`.

Known honesty gaps (documented, not papered over):

- T1/T2/T11/T13: transport classification, applyEdit rejection, and unknown-method handling are implemented+tested (`test/unit/lsp/transport-classification.test.ts`, incl. retained-proposal FIFO bound `APPLY_EDIT_PROPOSAL_LIMIT` and "unknown still -32601"; `test/unit/lsp/raw-method-policy.test.ts` `unknown-method` reason); T12 handshake barrier is implemented+tested (`test/unit/lsp/lsp-connection-handshake.test.ts`, 5 cases). No accepted deferrals remain in §1.
- R4 explicit-server routing is **implemented+tested** (exact `descriptorId`, no name alias, multi-session ambiguous — `session-identity.test.ts` case above). No phase gates remain in §4.
- RS2–RS5 are **externally constrained — controlled CI required** (tests exist and skip honestly without pinned binaries; skips are environment evidence, never passes). RS1/RS6/RS7 are implemented+tested (opt-in suite) (verified 2026-09-23 against `typescript-language-server` v5.1.3: 12 passed / 1 skipped).
- Existing bridge tests use the legacy `degraded` status. Strict-envelope re-assertion under the plan's status vocabulary now lives in §8 (`executeLspOperation()` landed: `src/lsp/lsp-executor.ts`); D9 strict file/workspace confirmed-empty vs no-evidence is now implemented+tested (`test/unit/lsp/executor.test.ts` paired file case + fallback/published/workspace cases). D12 freshness/version evidence is now implemented+tested at the strict executor/provider boundary.
- Waves 4–5 landed: canonical executor (`src/lsp/lsp-executor.ts`), strict contract + field matrix (`src/lsp/lsp-strict-contract.ts`), advisory affinity (`src/lsp/lsp-affinity.ts`), opaque cursors (`src/lsp/lsp-cursor-store.ts`), single model-facing `lsp` tool (`src/lsp/lsp-tool.ts`; P2 validation + READ registration via `test/unit/lsp/lsp-tool.test.ts`), inspection/provider migration via `runExecutor` (`src/lsp/lsp-inspection.ts`, `src/language-intelligence/language-intelligence-provider.ts`), bridge-as-adapter import (`src/lsp/lsp-bridge.ts`). Landed since: R5 multi-role routing (`test/unit/lsp/multi-role-routing.test.ts`), RPC encoding guard (`test/unit/language-intelligence/language-intelligence-encoding-guard.test.ts`), local capability ops `capabilities`/`sessionStatus`/`publishedDiagnostics` (`test/unit/lsp/operation-registry.test.ts`, `test/unit/lsp/lsp-tool.test.ts`), skills (`skills/lsp-*/SKILL.md`, `skills/README.md`; validator evidence: `scripts/validate-skills.mjs` — all 9 skills pass, verified 2026-09-23; no vitest coverage), real-server suite RS1–RS7 (`test/integration/lsp/`, opt-in). No accepted deferrals remain: T12 barrier, strict `workspaceDiagnostics` identifier threading (see §8), workspace pull continuity (`executor.test.ts` "pull continuity passes previousResultId only with cache"), R4 exact-descriptorId routing, provider→executor deadline clamp (`clampLanguageIntelligenceTimeout` [250, 30000]ms, exact pass-through; diagnostics 4s service), and UTF-16-explicit proposals (P7 `RPC_PROPOSAL_POSITION_ENCODING` guard) are all implemented+tested. Cross-process wire propagation of SmartEdit deadlines + wire encoding-field explicitness stay SmartEdit-owner pending (see `docs/lsp-smartedit-contract.md` §5–§6b, owner: SmartEdit, 2026-09-23); crash journaling is likewise SmartEdit-owned, not a SmartRead gate.

## 8. Strict substrate matrix (Waves 4-5)

Unit evidence, self-run 2026-09-23: `npx vitest run test/unit/lsp/` — 30 files / 525 passed (refreshed 2026-09-23). Each row verified against a real test body, not name-matched. S1–S11 implemented+tested (incl. S9 `test/unit/lsp/bridge-adapter-isolation.test.ts`); RS1–RS7 implemented+tested (opt-in suite) via `PI_SMARTREAD_LSP_CONFORMANCE=1` (same gate as §7; absent/unrunnable binaries skip honestly, never counted as passes).

| # | Conformance requirement | Status | Test file (verified body) |
| --- | --- | --- | --- |
| S1 | 9 statuses distinct: `classifyStatus` maps 10 transport kinds to 9 distinct `StrictStatus` values (`ok \| empty \| unsupported \| unavailable \| not_ready \| timeout \| cancelled \| error \| ambiguous`) | **implemented+tested** | `test/unit/lsp/strict-contract.test.ts` ("all 9 statuses reachable and distinct" + per-kind mapping) |
| S2 | field-matrix validation: per-operation allowed/required fields enforced, foreign fields rejected, `request` requires `method` | **implemented+tested** | `test/unit/lsp/strict-contract.test.ts` (hover+query, workspaceSymbols+position, documentSymbols+position, incomingCalls+position, rename+query, diagnostics+newName, raw request+path/query rejections; valid hover/raw accepts) |
| S3 | affinity bounds + advisory-only: 64-scope / 8-descriptor LRU eviction; `preferred()` hint-or-null, explicit selection wins, ambiguity reporting unaffected | **implemented+tested** | `test/unit/lsp/affinity.test.ts` (65th-scope eviction, 9th-descriptor eviction, advisory-wins + ambiguity-unaffected) + `test/unit/lsp/executor.test.ts` ("affinity tiebreak advisory only: ambiguity remains", "affinity notes success after ok") |
| S4 | cursor bounds + opacity + TTL: non-negative-integer offsets, opaque base64url tokens (no plaintext offset), unknown/tampered rejection, 256-entry eviction, TTL expiry via injected clock | **implemented+tested** | `test/unit/lsp/cursor-store.test.ts` (round-trips, unknown/empty/tampered null, negative/non-integer throw, no-plaintext-leak, 257th-create eviction, TTL expiry, size) + `test/unit/lsp/executor.test.ts` ("cursor pagination round-trip", "invalid cursor throws caller error") |
| S5 | no-fallback inside executor: typescript fallback deleted, hintless pathless request returns `unavailable`, never a guessed server | **implemented+tested** | `test/unit/lsp/executor.test.ts` ("hintless pathless request is unavailable", "unavailable passes allowInstall:false") |
| S6 | read-only proposals: rename/codeAction edits are normalized `WorkspaceEdit` proposals; formatting is protocol-faithful `TextEdit[]` and is wrapped into one-file WorkspaceEdit only by the legacy/SmartEdit adapters; zero disk writes; malformed normalization becomes `error` | **implemented+tested** | `test/unit/lsp/executor.test.ts` + `test/unit/lsp/bridge-adapter-isolation.test.ts` + `test/unit/language-intelligence/language-intelligence-provider.test.ts` |
| S7 | raw fail-closed: `workspace/executeCommand`, `workspace/applyEdit`, unknown/empty methods rejected; observational methods issue | **implemented+tested** | `test/unit/lsp/strict-contract.test.ts` (`isRawMethodAllowed` rejections + observational allows) + `test/unit/lsp/executor.test.ts` ("raw deny: executeCommand throws", "raw deny: unknown custom method throws", "raw allow: observational method issues", "no-retry for raw request even on crash") |
| S8 | single `lsp` tool registration: unknown/missing operation, foreign fields, missing required fields are tool errors; unroutable/exact-missing server is an `unavailable` envelope; envelope returned verbatim with provenance intact | **implemented+tested** | `test/unit/lsp/lsp-tool.test.ts` (validation errors, empty-path unavailable, explicit missing-server unavailable with provenance, verbatim envelope keys, READ registration via `registerOrReplace`) |
| S9 | bridge-as-adapter: bridge imports executor for migration path, contributes no unique new protocol implementation; deletion of the bridge removes no unique semantic implementation | **implemented+tested** | `test/unit/lsp/bridge-adapter-isolation.test.ts` (thin executor adapter: goToDefinition/findReferences/hover/getDocumentSymbols/workspaceSymbol/rename/codeActions/Outcome navigation call `executeLspOperation` with no manager acquisition; executor-unavailable maps to legacy null/[]/`degraded` without throw; executor sole acquisition seam) |
| S10 | inspection/provider migration: every navigation/diagnostics outcome and every SmartEdit-facing proposal (renamePreview, organizeImports, formatting, codeAction, checkPostEditDiagnostics) sourced from `executeLspOperation`; provider validates edits and gates freshness (`fresh` else `unconfirmed`) | **implemented+tested** | `test/unit/language-intelligence/language-intelligence-provider.test.ts` + `test/unit/language-intelligence/language-intelligence-runtime.test.ts` (executor-sourced proposals, validator pass, freshness gate) + `test/unit/lsp/lsp-inspection.test.ts` |
| S11 | SmartEdit boundary: SmartRead never applies; `workspace/applyEdit` answered `applied:false`; check-post-edit-diagnostics requires content-hash match + fresh diagnostics, degrades (never false-clean) otherwise | **implemented+tested** (SmartRead side) | `test/unit/lsp/transport-classification.test.ts` (unsolicited applyEdit block) + `test/unit/language-intelligence/language-intelligence-provider.test.ts` (hash/freshness gates) — sister-repo consumption is STOP-AND-APPROVE via `docs/lsp-smartedit-contract.md` |

RS1-RS7 are **implemented+tested** (opt-in suite) (same status as §7: pass where the binary is present, skip honestly where absent/unrunnable — skips never counted as passes).

Strict `workspaceDiagnostics` identifier threading is **implemented+tested**: `identifier` is a strict-contract field (`src/lsp/lsp-strict-contract.ts` allowed-fields + non-empty-string check; `src/lsp/lsp-operation-registry.ts` `workspaceDiagnostics` op), the executor threads it (`src/lsp/lsp-executor.ts` `req.identifier ? { identifier } : {}`), and `test/unit/lsp/executor.test.ts` proves "threads identifier; omits when absent" plus "rejects query (identifier surface only)". Workspace pull continuity is implemented+tested ("pull continuity passes previousResultId only with cache"); continuity does not cross processes (see `docs/lsp-smartedit-contract.md` §6a/§6b).

## How to run

```bash
npm test                                  # default suite, all "implemented+tested" rows
npx vitest run test/unit/lsp              # LSP unit subset only
PI_SMARTREAD_LSP_CONFORMANCE=1 npx vitest run test/integration/lsp   # opt-in rows RS1-RS7 (needs binaries on PATH; absent/unrunnable binaries skip honestly)
```

### Wave D strict CI (RS2–RS5, Linux-only matrix)

`.github/workflows/lsp-conformance.yml` runs one lane per server (pyright/gopls/rust-analyzer/clangd).
Each lane installs the pinned toolchain, runs `node scripts/check-lsp-conformance-binaries.mjs --server <name>`
(version evidence + early FAIL on absent/unusable/mismatched), then runs only that server's file with
`PI_SMARTREAD_LSP_CONFORMANCE=1` + `PI_SMARTREAD_LSP_CONFORMANCE_STRICT=1` and fails the lane on any
vitest skip (strict: absent→FAIL, unusable→FAIL, hover-unavailable→FAIL, unexpected skip→FAIL).
Pins live in one place (`PINS` in the script). Local dev keeps honest `ctx.skip()` (no STRICT env).
RS6 `client/registerCapability` skip stays designed-verdict, separate from RS2–RS5 env skips.

Proposal-only (Wave A owns `src/`): native strict fail inside the harness needs a `src`-level edit —
e.g. a `STRICT_LSP` flag in `test/integration/lsp/real-server-harness.ts` (`REAL_LSP_ENABLED`, line 15)
that throws instead of `ctx.skip()` at each skip site in `real-server-{pyright,gopls,rust-analyzer,clangd}.test.ts`
(binary-absent/unusable lines + hover-unavailable lines). Until Wave A lands it, the workflow's
skip-grep is the strict enforcement; no `src/lsp/*` change is made here.
