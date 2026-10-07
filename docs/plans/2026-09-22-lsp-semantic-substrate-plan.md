# LSP semantic substrate plan

**Date:** 2026-09-22
**Status:** Waves 1–5 landed — real-server suite RS1–RS7 covered opt-in
**Owner:** Pi-SmartRead

> Historical implementation plan. Status notes inside the plan record intermediate waves and may describe surfaces that were later completed or renamed. Current runtime behavior is authoritative in `README.md`, `AGENTS.md`, `docs/lsp-conformance.md`, and the `src/lsp/` implementation.

## Goal

Add exactly one model-facing tool, `LSP`, that gives agents direct access to language-server semantics without inheriting the convenience/fallback behavior of `grep`, `read`, or `inspect`.

This is not a plan to bolt another navigation wrapper onto `inspect`. The long-lived goal is a semantic substrate:

- broad protocol/runtime capability underneath;
- one small, strict model-facing interface;
- ergonomic orchestration in skills and existing SmartRead tools;
- mutation authority retained by SmartEdit.

The defining invariant is:

> **If `LSP` returns an answer, that answer came from the selected language server.**

No AST fallback. No graph fallback. No semantic-search rescue. No tree-sitter fallback. No silently substituted operation.

## System shape

```text
grep       = discover useful code
read       = observe source context
inspect    = understand structure and compose intelligence
LSP        = ask a language server precisely
SmartEdit  = mutate the workspace safely
```
The public tool should stay small even if the subsystem beneath it becomes substantially more capable. External parity is a **runtime capability target**, not a requirement to copy another project's model-facing tool count.

## Locked design decisions

1. **One additional model-facing tool.** Do not create one Pi tool per LSP method.
2. **Strict provenance.** Typed `LSP` operations never fall back to non-LSP intelligence.
3. **Protocol-native coordinates.** Positions are 0-based and use the encoding negotiated for that connection.
4. **Read-only authority.** Edit-producing language-server operations return validated proposals; they never mutate disk.
5. **Raw request escape hatch.** Keep a permanent `request` operation, but fail closed around side effects.
6. **Exact routing.** A strict operation resolves to one server/session unless the operation explicitly defines aggregation.
7. **Orchestration lives above the primitive.** Multi-step developer workflows belong in skills or higher-level SmartRead surfaces.
8. **No universal readiness fiction.** Readiness/freshness are evidence attached to a result, not a boolean SmartRead invents for every server.

## Non-goals

- Replacing `grep`, `read`, or `inspect` with LSP.
- Folding SmartEdit mutation authority into SmartRead.
- Copying agent-lsp's many-tool public surface.
- Treating LSP diagnostics as equivalent to a successful compiler/test run.
- Requiring every protocol method to receive a named typed model operation.
- Adding heuristic symbol resolution to the strict `LSP` tool.
- Introducing a daemon/shared broker before the local session model is correct.
## Current SmartRead audit

The repository already contains most of the application-level LSP machinery:

- `src/lsp/lsp-connection.ts`: stdio JSON-RPC transport, open-document tracking, diagnostics cache, rename, code actions, formatting.
- `src/lsp/lsp-manager.ts`: per-root lifecycle and language routing.
- `src/lsp/lsp-server-operation.ts`: common acquisition/budget path.
- `src/lsp/lsp-navigation-adapter.ts`: definition, references, symbols, implementation, hover outcomes.
- `src/lsp/lsp-call-hierarchy-adapter.ts`: prepare/incoming/outgoing call hierarchy.
- `src/lsp/lsp-bridge.ts`: cross-caller surface.
- `src/lsp/lsp-inspection.ts`: inspect-facing convenience semantics.
- `src/language-intelligence/language-server-catalog.ts`: descriptor catalog with initialization options/settings fields.
- `src/language-intelligence/language-intelligence-provider.ts`: SmartEdit-facing semantic operations.

The problem is therefore not lack of handlers. The important gaps are lower in the stack.

### Confirmed protocol/runtime gaps

| Area | Current behavior | Required direction |
| --- | --- | --- |
| Server requests | any message with `id` is treated as a response | classify `id + method` as server request and respond |
| Dynamic registration | client advertises `dynamicRegistration: false` | maintain live registrations/capabilities |
| Position encoding | no explicit negotiation | negotiate and record encoding per session |
| Workspace folders | not fully represented | initialize and update workspace folders |
| Configuration | descriptor settings/init options are dropped | carry them through session creation and configuration responses |
| Progress/readiness | not tracked as evidence | capture progress and expose readiness basis/state |
| Manager lifetime | five-root LRU can evict active manager | lease/refcount active requests and reap only idle sessions |
| Routing identity | effectively root + language | root + descriptor + config fingerprint |
| Failure outcomes | many failures collapse into `degraded` | typed operational status and error provenance |
| Call hierarchy convenience | incoming/outgoing can prepare + choose item 0 | strict tool accepts the actual prepared item |
### Concrete transport bug to fix first

`LSPConnection.handleLspMessage()` currently behaves conceptually as:

```text
if message has id
  settle client pending request
else if message has method
  dispatch notification
```

That is incorrect for JSON-RPC server requests, which contain both `id` and `method`.

The classification must become:

```text
id + no method  -> response
id + method     -> server request
method + no id  -> notification
```

Until this is correct, some real language servers can initialize incompletely or stall when they request configuration/workspace information.

## External research synthesis

The design intentionally combines lessons rather than cloning one implementation.

| System | What to borrow |
| --- | --- |
| Claude Code / OpenCode | familiar operation vocabulary and narrow semantic query ergonomics |
| oh-my-pi | one unified `lsp` tool, broad runtime, raw request escape hatch, server-request handling |
| pi-lsp-client | leased/refcounted lifecycle, idle reaping, typed crash boundary, one retry for idempotent reads |
| samfoy/pi-lsp-extension | configuration breadth and daemon lessons; **not** its tree-sitter fallback semantics |
| agent-lsp | conformance mindset and workflow skills above protocol primitives |
| SmartRead + SmartEdit | evidence separation and validated, failure-atomic mutation boundary |
External parity should therefore mean:

> SmartRead's LSP runtime can express the useful protocol/server capabilities that mature agent clients need, while the model learns one coherent primitive.

## Public `LSP` contract

The JSON schema should remain provider-friendly and relatively flat. Avoid a top-level `anyOf` dependency if model providers reject or mishandle it. Enforce the true discriminated contract in runtime validation.

Conceptual shape:

```ts
{
  operation: string,

  workspace?: string,
  server?: string,

  path?: string,
  position?: { line: number; character: number },
  range?: { start: Position; end: Position },

  query?: string,
  includeDeclaration?: boolean,
  item?: object,
  newName?: string,
  context?: object,
  codeAction?: object,
  formatting?: { tabSize: number; insertSpaces: boolean },

  method?: string,
  params?: object,

  limit?: number,
  cursor?: string,
  timeoutMs?: number
}
```
### Strict field matrix

Foreign fields are errors, not ignored hints.

Examples:

- `hover + query` -> error.
- `workspaceSymbols + position` -> error.
- `documentSymbols + character` -> error.
- `incomingCalls + position` -> error.
- `request` without `method` -> error.
- unknown `operation` -> caller error before server execution.

Caller mistakes should throw/return the normal Pi tool error path. They are not runtime statuses such as `unsupported` or `error`.

### Position contract

All strict `LSP` positions are:

- 0-based line;
- 0-based character;
- character measured in the **negotiated LSP position encoding**.

The connection records one of `utf-8 | utf-16 | utf-32` as negotiated. If negotiation is unavailable, use the protocol compatibility default and record that fact.

Returned positions must be reusable directly as input to another `LSP` operation.

High-level `inspect` may continue exposing friendly 1-based source coordinates and converting at its adapter seam.

## Result envelope

Use one stable envelope for every operation:
```ts
{
  status,
  operation,
  method,

  server: {
    descriptorId,
    name,
    languageId,
    projectRoot,
    positionEncoding
  },

  result,

  meta: {
    documentVersion?,
    freshness?,
    readiness?,
    source?,
    truncated,
    nextCursor?
  },

  error?: {
    code?,
    message,
    data?
  }
}
```

The `result` payload is discriminated by `operation`; do not flatten everything into `items: unknown[]`.

### Status vocabulary

| Status | Exact meaning |
| --- | --- |
| `ok` | selected server completed successfully with a non-empty result |
| `empty` | selected server completed successfully with an empty/null result |
| `unsupported` | selected live server does not advertise/support the typed operation |
| `unavailable` | no eligible language-server session can be routed |
| `not_ready` | request cannot yet be issued with the operation's required document/session state |
| `timeout` | request exceeded its deadline |
| `cancelled` | caller cancellation won |
| `error` | server, transport, protocol, or normalization produced an actual error |
| `ambiguous` | more than one candidate exists where exact selection is required |
Remove `degraded` from the strict public LSP vocabulary. It is useful for synthesized high-level tools but too lossy for a precision primitive.

## Readiness and freshness semantics

Do **not** require a fictional universal `workspaceReady === true` before an empty result is legal.

LSP does not define one portable project-index-complete signal across all servers. Instead return evidence:

```ts
readiness: {
  state: "confirmed" | "settling" | "unknown",
  basis: "progress" | "diagnostic-receipt" | "request-completion" | "server-specific" | "none"
}
```

An empty references result with `readiness.state = "unknown"` is still a successful server answer, but is weaker evidence than an empty result after a server-specific indexing signal.

Diagnostics additionally carry:

```ts
freshness: {
  state: "fresh" | "stale" | "unknown",
  documentVersion?: number,
  resultId?: string
}
```

Never translate “we have no cached diagnostics” into a confirmed clean result.

## Runtime architecture

Do not big-bang replace the existing LSP stack. Deepen it behind one new canonical executor.
```text
                         LSP tool
                            |
               +------------+-------------+
               |            |             |
        inspect.navigate  inspect.script  read/other callers
               |            |             |
               +------------+-------------+
                            |
                  executeLspOperation()
                            |
                 existing/deepened LSP core
          +-----------------+-----------------+
          |                 |                 |
      SessionRouter     DocumentStore    ProtocolConnection
          |                 |                 |
     root/descriptor    versions/sync     JSON-RPC framing
     config identity    freshness         server requests
     roles/selection    overlays          cancellation
          |                                   |
          +---- CapabilityRegistry -----------+
          +---- DiagnosticsBroker ------------+
          +---- ReadinessTracker -------------+
          +---- WorkspaceEditProposalSink ----+
```

`executeLspOperation()` becomes the canonical semantic seam. Existing `LSPBridge` can initially adapt to it or wrap it; callers migrate incrementally.

The deletion test: removing the executor/kernel should force routing, capability gating, lifecycle, normalization, status classification, and freshness logic back into many callers.

## Workstream A: protocol transport correctness

Implement before widening the model-facing operation registry.

- Correct response/server-request/notification classification.
- Add a server-request dispatch table with explicit response policy.
- Support `workspace/configuration`.
- Support `workspace/workspaceFolders` where requested.
- Handle `client/registerCapability` and `client/unregisterCapability`.
- Track `$/progress` and work-done tokens.
- Support relevant refresh notifications.
- Implement `$/cancelRequest` where cancellation is propagated.
- Preserve graceful `shutdown` request then `exit` notification.
- Distinguish request timeout, caller abort, process exit, malformed response, and protocol error.
- Reject all pending requests with typed transport errors on process death.
- Never infer an empty semantic result from a transport failure.

### Server-initiated edits

`workspace/applyEdit` must not directly mutate disk.

Policy:

- parse and validate the proposed edit;
- retain it as proposal/debug information where useful;
- answer the server with `applied: false` unless an explicitly designed SmartEdit transaction owns that request;
- never let an arbitrary raw server request bypass SmartEdit authorization.

## Workstream B: session identity, routing, and lifetime

Replace manager identity that is effectively “root + language” with:

```text
(canonicalProjectRoot, serverDescriptorId, configFingerprint)
```

The fingerprint includes configuration that changes server semantics/startup.

Support:

- nested project-root detection;
- more than one server for the same language;
- semantic server + linter/formatter roles where configured;
- explicit server selection from the strict tool;
- exact ambiguity reporting rather than silently choosing;
- project/config changes invalidating the correct session.
### Leases

A session with an active request cannot be evicted.

Borrow the useful part of pi-lsp-client's model:

1. acquire session lease;
2. increment active-use count;
3. perform operation;
4. release in `finally`;
5. idle reaper can close only zero-lease sessions.

The existing five-manager hard LRU should evolve into idle/lease-aware reaping.

### Retry policy

Exactly-once retry is permitted only when all are true:

- failure is a typed dead-connection/process-exit failure;
- operation is idempotent and observational;
- no side effect may have occurred.

Examples eligible for one reconnect retry:

- hover;
- definitions/references;
- symbols;
- hierarchy reads;
- diagnostics pull;
- capabilities.

Never blindly retry rename, code-action application, formatting proposals tied to command execution, executeCommand, or unknown raw requests.

## Workstream C: descriptor and configuration parity

Make `language-server-catalog.ts` the runtime source of truth instead of descriptive data that loses fields before startup.

Carry descriptor data through resolution and session creation:
```text
catalog / user config
        |
resolved descriptor
        |
session identity + fingerprint
        |
initialize.initializationOptions
        |
workspace/configuration responses
        |
workspace/didChangeConfiguration
```

Support custom user-defined descriptors with the same validated shape as built-ins.

A descriptor should be able to define:

- id/display name;
- languages/extensions/filenames;
- root markers;
- command candidates;
- environment;
- initialization options;
- workspace settings;
- expected/static capability hints;
- optional observational server-extension methods;
- server role/priority.

Project-local executables and trust rules remain part of resolution, not the public `LSP` tool.

## Workstream D: capability registry

Maintain capabilities from both:

1. static `initialize` response;
2. dynamic registration/unregistration.

Every typed operation asks the registry before issuing a request.

Examples:

- absent `definitionProvider` -> `unsupported`;
- dynamically registered pull diagnostics -> become available without restarting;
- capability removed -> stop issuing that request.

Do not use “request returned null” as a proxy for unsupported capability when the capability can be known beforehand.
## Workstream E: document synchronization

Centralize document state instead of letting each adapter decide when to close/reopen files.

Track per session/document:

- URI/canonical path;
- language id;
- open/closed state;
- monotonically increasing version;
- last synchronized content/hash;
- synchronization mode advertised by server;
- diagnostic receipts/result IDs;
- mutation invalidation generation.

Serialize didOpen/didChange/didClose for the same document.

Prefer real incremental/full synchronization according to server capability rather than using close+open as the universal freshness mechanism.

High-level callers should ask for “prepare this document for semantic query”; only the document store decides which wire notifications achieve that state.

## Workstream F: diagnostics broker

Diagnostics need their own semantics because a clean `[]` is operationally important.

Support:

- publishDiagnostics push cache with receipt/version tracking;
- pull `textDocument/diagnostic` when supported;
- dynamic pull-diagnostic registration;
- `workspace/diagnostic` when supported;
- resultId handling where applicable;
- invalidation after edits;
- bounded settle/readiness evidence rather than fixed sleeps presented as truth.

Typed operations:

- `diagnostics(path)`: strongest file-scoped answer available;
- `workspaceDiagnostics(workspace/server)`: explicit workspace request when supported;
- optional `publishedDiagnostics`: inspect current push state without claiming freshness.

Every diagnostic result states source: `pull | push | workspace-pull`.
## Workstream G: canonical response normalization

Normalize protocol unions in one tested subsystem.

At minimum cover:

- `Location | Location[] | LocationLink[]`;
- `DocumentSymbol[] | SymbolInformation[]`;
- `MarkupContent | MarkedString | MarkedString[]`;
- `CompletionItem[] | CompletionList`;
- `CodeAction | Command`;
- WorkspaceEdit `changes | documentChanges`;
- prepareRename result variants;
- semantic-token full/range/delta variants;
- hierarchy items including opaque `data`.

Typed operation adapters consume normalized values rather than reimplementing union parsing.

## Typed operation registry

Define the conceptual registry now, but do not require every operation to be exposed before the runtime supports it correctly.

### Core semantic navigation

- `goToDefinition`
- `goToDeclaration`
- `goToTypeDefinition`
- `goToImplementation`
- `findReferences`
- `hover`
- `documentHighlights`
- `documentSymbols`
- `workspaceSymbols`

### Hierarchy

- `prepareCallHierarchy`
- `incomingCalls`
- `outgoingCalls`
- `prepareTypeHierarchy`
- `supertypes`
- `subtypes`
Hierarchy continuation operations accept the exact item returned by the prepare operation. Preserve opaque server `data`.

Do not silently re-prepare or choose item zero in the strict tool. Convenience wrappers may do so outside this seam if their contract says they do.

### Diagnostics and capability inspection

- `diagnostics`
- `workspaceDiagnostics`
- `publishedDiagnostics`
- `capabilities`
- `sessionStatus` / equivalent introspection if needed for operator/model debugging

### Semantic edit proposals

- `prepareRename`
- `rename`
- `codeActions`
- `resolveCodeAction`
- `formatDocument`
- `formatRange`
- `formatOnType`

These operations return proposals/normalized edits only. They own no filesystem write authority.

### Assistance operations eligible for typed exposure when useful

Runtime parity should support these where the server does:

- completion + resolveCompletion;
- signatureHelp;
- inlayHints + resolveInlayHint;
- semanticTokens full/range/delta;
- foldingRanges;
- selectionRanges.

Do not expose a named operation solely because LSP defines it. Add typed exposure when it buys validation, normalization, bounded rendering, or repeated model utility.
## Raw `request` escape hatch

Permanent contract:

```ts
LSP({
  operation: "request",
  server: "rust-analyzer",
  method: "rust-analyzer/expandMacro",
  params: { ... }
})
```

Typed operations provide:

- argument validation;
- capability gating;
- response normalization;
- semantic statuses;
- truncation/pagination;
- evidence/freshness metadata.

`request` provides:

- exact selected server;
- exact method + params;
- raw JSON result;
- typed transport/error envelope;
- output byte/depth limits.

### Side-effect policy

Raw requests are fail-closed.

Known observational methods may be allowed by protocol classification or descriptor metadata.

Known or potentially mutating methods such as `workspace/executeCommand`, `workspace/applyEdit`, and unknown custom methods are rejected from the read-only public path unless a separately reviewed policy proves they cannot bypass SmartEdit.

Do not trust a caller-provided `readOnly: true` flag.

## SmartEdit boundary

Language servers may **propose** edits. SmartEdit remains the authority that applies them.
```text
LSP rename / codeAction / formatting
              |
       validated proposal
              |
    read affected resources
              |
      SmartEdit transaction
      - strong read evidence
      - freshness/hash checks
      - preview/authorization
      - failure-atomic apply
      - post-edit pipeline
              |
      re-sync LSP documents
              |
       diagnostics/build/tests
```

This preserves the existing evidence model: LSP/search evidence does not become equivalent to a strong source read merely because the language server knew where a symbol lives.

### File operation hooks

Do not expose `willRenameFiles`, `willCreateFiles`, or `willDeleteFiles` as ordinary model operations.

They belong behind the SmartEdit transaction seam:

```text
SmartEdit plans resource mutation
  -> LSP workspace/will*Files
  -> validate returned WorkspaceEdit proposal
  -> incorporate into transaction if authorized
  -> apply atomically
  -> LSP workspace/did*Files
```

## Integration with existing SmartRead surfaces

### `inspect.navigate`

Keep its ergonomic semantics, but make it a wrapper over the canonical LSP executor.

It may continue:

- 1-based display coordinates;
- convenience one-shot hierarchy behavior if explicitly documented;
- high-level rendering.

It must not maintain a sibling implementation of protocol semantics.
### `inspect.script`

The `lsp.*` host bindings should call the same canonical executor directly.

Script mode remains read-only and records the primitive calls it made.

### `read`, search, and repo intelligence

High-level callers may continue policies such as:

```text
try precise LSP semantic lookup
  -> if unavailable, use graph/AST/search fallback
```

The fallback happens **outside** the LSP executor so provenance remains honest.

### Language-intelligence / SmartEdit RPC

Rename/code-action/format proposal generation should converge on the same executor rather than maintaining a second language-intelligence implementation.

## Orchestration skills

Protocol primitives should not encode complete developer workflows.

Create/maintain a skill family such as:

- `lsp-explore`: symbol search -> hover -> implementations -> callers/references -> selective reads.
- `lsp-impact`: references + call/type hierarchy + SmartRead graph impact.
- `lsp-local-symbols`: document symbols -> highlights -> hover.
- `lsp-rename`: locate -> prepareRename -> references -> rename proposal -> SmartEdit transaction -> diagnostics.
- `lsp-safe-refactor`: impact -> semantic proposal -> SmartEdit -> diagnostics/compiler/tests.
- `lsp-fix`: diagnostics -> code actions -> resolve -> one fix transaction -> re-diagnose.
- `lsp-cross-root`: establish roots/sessions -> readiness evidence -> semantic queries -> partition by root.
- `lsp-verify`: LSP diagnostics as fast semantic signal, then repository-native verification.

This is how SmartRead can approach agent-lsp workflow parity without exposing dozens of unrelated top-level tools.
## Conformance-oriented testing

Create `docs/lsp-conformance.md` as executable documentation backed by tests.

### Transport matrix

- response vs server request vs notification classification;
- server request ID collision with client-issued pending IDs;
- `workspace/configuration`;
- dynamic register/unregister;
- cancellation and timeout distinction;
- process crash and pending rejection;
- graceful shutdown ordering;
- malformed frame/JSON behavior and buffer limits.

### Position matrix

Test negotiated encodings using:

- ASCII;
- emoji/astral code points;
- combining marks;
- mixed UTF-8/UTF-16-sensitive positions.

Round-trip a returned position into a subsequent operation.

### Capability matrix

- static support;
- static unsupported;
- dynamically added capability;
- dynamically removed capability;
- raw request independent of typed capability adapters.

### Document/diagnostic matrix

- cold didOpen;
- serialized didChange;
- push-only diagnostics;
- pull-only diagnostics;
- push + pull;
- dynamic diagnostic registration;
- confirmed empty push receipt;
- no receipt / unknown freshness;
- resultId reuse/invalidation;
- edit invalidates stale results.
### Normalization matrix

- Location and LocationLink variants;
- both document-symbol forms;
- hover markup variants;
- CompletionList and CompletionItem[];
- CodeAction and Command;
- WorkspaceEdit changes/documentChanges;
- call/type hierarchy opaque data preservation.

### Routing/lifetime matrix

- nested project roots;
- two valid same-language servers -> ambiguity;
- explicit server selection;
- semantic server + diagnostics provider;
- active lease survives cache pressure;
- zero-lease idle reaping;
- configuration fingerprint creates/replaces correct session;
- idempotent read retries once after typed crash;
- mutation/proposal/unknown request does not auto-retry.

### Real-server integration suite

Exercise representative real servers, not mocks only:

- TypeScript language server;
- Pyright;
- gopls;
- rust-analyzer;
- clangd;
- at least one server that relies heavily on dynamic configuration/registration.

Protocol conformance bugs frequently appear only against real server behavior.

## Model-facing contract evaluation

Schema correctness is not enough. Test several models against the real tool description/schema.

Measure whether models:

- choose the correct operation;
- obey foreign-field rejection;
- understand raw 0-based protocol positions;
- chain hierarchy items rather than re-resolving;
- distinguish `empty` from `unavailable`;
- react appropriately to unknown readiness/freshness;
- use raw request only when typed operations are insufficient;
- pass semantic edits to SmartEdit rather than expecting LSP to mutate files.
## Implementation order

This is a dependency order, not an MVP/release ladder.

### 1. Correct the transport

Server-request classification and responses, typed transport errors, cancellation, progress plumbing, shutdown.

**Gate:** real servers that request configuration/workspace state initialize without deadlock or silent request loss.

### 2. Correct sessions and configuration

Descriptor/config propagation, exact session identity, root selection, leases, custom descriptors.

**Gate:** nested projects and simultaneous roots cannot kill or silently cross-route active requests.

### 3. Correct capability and document state

Negotiated position encoding, static/dynamic capability registry, serialized document sync.

**Gate:** typed operations can distinguish unsupported from empty and returned positions round-trip correctly.

### 4. Correct diagnostics/readiness evidence

Push/pull/workspace diagnostics, progress evidence, freshness/result IDs.

**Gate:** a clean diagnostic result cannot be produced merely from absence of cached data.

### 5. Introduce canonical executor and strict result envelope

Move adapters onto `executeLspOperation()`, centralize statuses, provenance, normalization, limits.

**Gate:** one semantic implementation is shared by direct tool and high-level callers.

### 6. Register model-facing `LSP`

Expose the stable typed operations that the runtime can honestly support, plus the guarded raw request escape hatch.

**Gate:** no typed operation has hidden fallback or hidden mutation.

### 7. Migrate high-level callers

`inspect.navigate`, script bindings, read/search semantic helpers, and SmartEdit language intelligence become adapters over the canonical executor.
**Gate:** deleting legacy direct bridge paths does not remove a unique semantic implementation.

### 8. Expand runtime parity and skills

Type hierarchy, richer diagnostics, assistance operations, file-operation hooks behind SmartEdit, server-specific observational extensions, orchestration skills.

**Gate:** expansion does not grow new protocol/lifecycle policy in callers.

## Acceptance criteria

The design is complete when:

1. Exactly one additional Pi model-facing tool provides strict LSP access.
2. Every strict result names the exact routed server/root/encoding.
3. Server requests are correctly answered or explicitly rejected.
4. Typed unsupported operations are distinguishable from genuine empty results.
5. Timeout, cancellation, unavailable server, protocol error, and ambiguity are distinct.
6. Positions returned by one LSP call are valid inputs to another without display-coordinate conversion.
7. Active requests cannot be killed by manager eviction.
8. Descriptor initialization options/settings reach the real server.
9. Dynamic capabilities change the live registry.
10. Diagnostics distinguish fresh confirmed empty from no evidence.
11. Edit-producing operations cannot write files.
12. Raw request cannot bypass the read-only authority boundary.
13. SmartEdit remains the only mutation authority for semantic edit proposals.
14. `inspect`, script mode, and SmartEdit do not implement parallel protocol semantics.
15. Multi-step developer behavior is documented in skills rather than hidden inside the primitive.
16. Real-server conformance tests cover the supported semantic core.

## Risks and explicit cautions

### Capability breadth can become schema bloat

Mitigation: runtime parity first; promote methods to typed model operations only when validation/normalization/model utility justifies the surface.

### “Readiness” can become false certainty

Mitigation: expose evidence state/basis, keep `unknown` legal, use server-specific policies only where verified.

### Raw request can become a mutation backdoor

Mitigation: observational allowlist/classification; reject unknown potentially mutating methods; never accept caller self-attestation of safety.
### Multiple servers can make results deceptively authoritative

Mitigation: exact routing by default; `ambiguous` when selection is not deterministic; explicit aggregation only for operations whose contract defines it.

### Shared daemon architecture can add authority/lifecycle complexity

Mitigation: make the session transport abstract enough to support a future broker, but do not ship one merely for architectural symmetry.

## Rejected directions

### Many individual Pi LSP tools

Rejected. It produces a shallow model interface and makes capability growth equal tool-surface growth.

### Tree-sitter/AST fallback inside `LSP`

Rejected. Useful for ergonomic tools, destructive to strict provenance.

### Hard-code UTF-16 as the permanent public contract

Rejected. Use the actual negotiated LSP encoding while retaining 0-based protocol coordinates.

### Universal “workspace ready” gate

Rejected. Not portable across servers. Return readiness evidence instead.

### Directly apply WorkspaceEdits from SmartRead

Rejected. SmartEdit already provides the stronger mutation/evidence seam.

### Big-bang replacement of LSPBridge/Manager/Connection

Rejected. Deepen and migrate behind one executor seam; delete old paths as callers converge.

## Research inputs

Primary implementation references inspected during the 2026-09-22 audit:

- `https://github.com/can1357/oh-my-pi`
- `https://github.com/code-yeongyu/pi-lsp-client`
- `https://github.com/samfoy/pi-lsp-extension`
- `https://github.com/blackwell-systems/agent-lsp`
- `https://github.com/anomalyco/opencode`
Also considered:

- Claude Code's LSP operation vocabulary and current issue reports around empty navigation results/diagnostics exposure;
- LSP 3.18 protocol semantics, including negotiated position encodings, dynamic registration, workspace configuration/folders, progress, diagnostics, and file operations;
- SmartRead's existing evidence and SmartEdit mutation contracts.

## Design principle to preserve

**Broad runtime, narrow primitive, explicit evidence, orchestration above, mutation elsewhere.**

The strict `LSP` tool should feel almost boring to call. The complexity belongs behind the seam: server lifecycle, routing, synchronization, capability negotiation, normalization, diagnostics freshness, and protocol correctness.

That gives models a precision instrument when they need to drill into compiler/language semantics without making the rest of SmartRead less forgiving.

## Execution status — 2026-09-22 PM

Approved expansion, Pi-SmartRead only. Original scope above preserved as authority; this section tracks execution state so progress is not memory-only.

- Pre-release rule: clean replacement, no legacy compat adapters/shims. Migrate every in-repo caller/test to strict substrate; delete obsolete paths once empty. Deliberate higher-level convenience/fallback (e.g. `inspect.navigate` ergonomics) lives outside strict executor on own merits.
- Sister-repo / shared-protocol (`Pi-Workspace-Protocol`, Pi-SmartEdit) changes are stop-and-approve gates. No cross-repo edits without explicit approval; never leave known consumer broken.
- Invariants (never weaken): cross-root direct reads unrestricted (`isWithinRoot` stays index-scope only); `canonicalPath` stays `realpathSync`-based (`tryCanonical`); SmartEdit sole mutation authority; strict path passes `allowInstall: false`; `workspace/applyEdit` omitted/false with always-reject handler retaining proposal only.
- Baseline (execution start): `npm run typecheck` exit 0; `npm test` 2283 passed, 1 skipped; `./node_modules/.bin/vitest run test/unit/lsp/` 91 passed; `npm run lint` 1 error + 377 warnings (pre-existing).
- Wave 1 (lanes landed uncommitted in main tree 2026-09-22 ~23:30 UTC; worktree approach abandoned after transient infra failures, T3 doc recovered from retained patch): T1 transport classification/dispatch (`src/lsp/lsp-connection.ts`, new `lsp-server-request-handlers.ts`); T2 raw fail-closed policy + canonical normalizer (4 new files); T3 `docs/lsp-conformance.md` skeleton. Researcher (LSP 3.17) + pre-lane reviewer (BLOCK, 5 P1, all T1 scope) findings folded into T1 as checklist.
- Gates per integration: typecheck, lint, `npm test`, LSP unit dir, `git diff --check`, colliding-ID regression test, applyEdit no-disk-write test, `allowInstall: false` non-invocation test, evidence-producer regression (no new read gating).
- Wave 1 gates (2026-09-22 ~23:30 UTC, parent-verified): typecheck exit 0; LSP unit 10 files / 190 passed; full `npm test` 183 passed + 1 skipped / 2382 passed + 1 skipped (baseline 2283, +99 new); `git diff --check` clean; lint 1 pre-existing error in untouched `src/extension-result-pipeline.ts`, new files 0 errors; colliding-ID + applyEdit byte-identity tests present and green. Whole-diff review PASSED after 2 P1 fixes (bounded applyEdit retention APPLY_EDIT_PROPOSAL_LIMIT=256 + test; conformance rows flipped to covered); re-verified 191 LSP tests green, typecheck clean. Remaining follow-up: shutdown-frame quirk.
- Wave 2 (landed, parent review PASS): S sessions/config/fingerprint/leases/allowInstall flag; P capability registry + source-first position codec (no lsp-types.ts edits).
- Wave 3 (landed, at integration gate 2026-09-25): document store (openClose/change split, omitted-openClose=>false, baseText range source), document-sync multibyte encoding, diagnostics broker (metadata version/identifier/reports, freshness via broker, no-sync invalidation), readiness tracker, workDoneProgress/create server-request handler, init honesty rewrite (dynamicRegistration + workDoneProgress + workspace folders/configuration + positionEncodings + publishDiagnostics versionSupport advertised).
- Wave 3 repair loops (7 findings, all fixed): range wrong-source fixed via baseText; openClose/change split with omitted-openClose=>false; workDoneProgress/create server-request handler; init honesty rewrite; broker metadata version/identifier/reports; bridge freshness via broker; no-sync invalidation.
- Wave 3 review verdicts: Phase 1 PASS after P1+P2 loop; Phase 2 PASS with P3 note; Phase 3 PASS after P1+P2+P2t+P3 loop.
- Wave 3 gates (2026-09-25, self-run): `npx vitest run test/unit/lsp/` 20 files / 274 passed; `npm run typecheck` exit 0.
- Wave 4 (landed, uncommitted tree 2026-09-22; self-run `npx vitest run test/unit/lsp/` 26 files / 451 passed): canonical `executeLspOperation()` (`src/lsp/lsp-executor.ts`) — validate, route, gate, prepare, issue, normalize, envelope. Strict contract types + field matrix + `classifyStatus` 9-status mapping (`src/lsp/lsp-strict-contract.ts`). Operation registry data-only leaf, no runtime imports from connection/manager/bridge/broker (`src/lsp/lsp-operation-registry.ts`). Advisory-only `LspAffinity` (64 scopes x 8 descriptors, `preferred()` hint-or-null) (`src/lsp/lsp-affinity.ts`). Opaque cursor store (256 entries, 10-min TTL, no plaintext offset) (`src/lsp/lsp-cursor-store.ts`). No-fallback inside executor (typescript fallback deleted; hintless pathless returns `unavailable`); hierarchy continuation takes exact prepared item, no re-prepare/item-0 (`executor.test.ts` hierarchy passthrough); no-retry for rename/raw/non-idempotent, exactly-once retry idempotent reads only.
- Wave 5 (landed, uncommitted tree 2026-09-22): single model-facing `lsp` tool (`src/lsp/lsp-tool.ts` flat TypeBox, no anyOf; `createLspTool()` via `registerLspTool()` in `src/extension-registration.ts` as READ); bridge-as-adapter — `src/lsp/lsp-bridge.ts` imports executor for migration path, no unique new protocol impl in bridge; `inspect.navigate` migration — `src/lsp/lsp-inspection.ts` sources outcomes from `runExecutor`, legacy bridge fallback-only; provider migration — `src/language-intelligence/language-intelligence-provider.ts` sources renamePreview/organizeImports/formatting/codeAction/checkPostEditDiagnostics from `runExecutor`, zero disk writes, `validateWorkspaceEdit` before returning proposal, freshness gate (`meta.freshness.state === fresh` else `unconfirmed`). Real-server suite (RS1-RS7) covered opt-in, not future — see 2026-09-23 reconciliation.
- Wave 6 (in progress, 2026-09-22, DOCS ONLY): plan execution-status append + `docs/lsp-conformance.md` section 8 strict-substrate matrix + NEW `docs/lsp-smartedit-contract.md` stop-and-approve deliverable + skills recon + 16-criteria evaluation. Zero code/test changes. Real-server suite covered opt-in (`PI_SMARTREAD_LSP_CONFORMANCE` gate, `test/integration/lsp/` exists — see 2026-09-23 reconciliation).
- Skills recon (Wave 6): repo `skills/` holds exactly one skill — `skills/inspect-script-mode/SKILL.md`. No skill registry, naming/lint convention, or `lsp-*` family exists. Deferred paths (NOT created — no convention to follow): `skills/lsp-explore/SKILL.md`, `skills/lsp-impact/SKILL.md`, `skills/lsp-local-symbols/SKILL.md`, `skills/lsp-rename/SKILL.md`, `skills/lsp-safe-refactor/SKILL.md`, `skills/lsp-fix/SKILL.md`, `skills/lsp-cross-root/SKILL.md`, `skills/lsp-verify/SKILL.md` — each a thin workflow doc over the `lsp` tool per plan Orchestration skills section. Create only after a skill convention (location, frontmatter, lint) is approved.
- Wave 6 acceptance-criteria evaluation (strict, file evidence each): 1. One model-facing tool: MET (`src/lsp/lsp-tool.ts` name `lsp`, `src/extension-registration.ts` `registerLspTool`; `lsp-tool.test.ts` factory shape + READ registration). 2. Exact server/root/encoding on every result: MET (`serverInfo()` in `src/lsp/lsp-executor.ts`; `executor.test.ts` provenance + explicit-server tests). 3. Server requests answered/rejected: MET unit (`transport-classification.test.ts`); real-server deadlock gate covered opt-in (RS7 `real-server-initialize.test.ts` 4 cases) — overall MET-opt-in. 4. Unsupported vs empty: MET (`executor.test.ts` unsupported-vs-empty; `capability-registry.test.ts`). 5. Timeout/cancelled/unavailable/error/ambiguous distinct: MET (`classifyStatus` in `lsp-strict-contract.ts`, `strict-contract.test.ts` all-9-distinct; executor timeout/cancelled/unavailable/ambiguous/error tests). 6. Positions reusable: PARTIAL (`position-codec.test.ts` round-trips; `lsp-tool.ts` 0-based native; live cross-op chaining OPEN, RS-gated). 7. Active requests survive eviction: MET unit (`session-lease.test.ts`; `executor.test.ts` lease-release); live-pressure proof OPEN — overall PARTIAL. 8. Descriptor options/settings reach server: PARTIAL (fingerprint `session-identity.test.ts`; advert `initialize-capabilities.test.ts`; real-binary delivery OPEN). 9. Dynamic capabilities change registry: MET (`capability-registry.test.ts` + T5). 10. Fresh confirmed-empty vs no-evidence: MET unit (broker confirmed/unconfirmed `diagnostics-broker.test.ts`; provider freshness gate `language-intelligence-provider.ts`; `executor.test.ts` publishedDiagnostics); strict `freshness` enum D12 future — overall PARTIAL. 11. Edit ops cannot write files: MET (`executor.test.ts` rename-proposal zero disk writes; provider `validateWorkspaceEdit`; `lsp-tool.test.ts` description). 12. Raw cannot bypass read-only boundary: MET (`strict-contract.test.ts` `isRawMethodAllowed`; `executor.test.ts` raw-deny; `raw-method-policy.test.ts`). 13. SmartEdit sole mutation authority: PARTIAL (SmartRead side holds, applyEdit `applied:false`; sister-repo acceptance STOP-AND-APPROVE via `docs/lsp-smartedit-contract.md`). 14. No parallel protocol semantics: PARTIAL (inspection + provider source via `runExecutor`; `operation-registry.test.ts` no-runtime-imports; residual legacy bridge fallback-only paths remain; script `lsp.*` bindings migration unverified). 15. Multi-step behavior in skills: OPEN (primitive holds, no orchestration in executor; skill family NOT created, deferred). 16. Real-server conformance: MET-OPT-IN (RS1 6 cases, RS7 4 cases, RS6 registerCapability honest-skip designed verdict; RS2–RS5 per-stub 3 cases each; gate `PI_SMARTREAD_LSP_CONFORMANCE=1`). Score: 8 met (1,2,4,5,9,11,12 + 10-unit) / 5 partial (3,6,7,8,13,14 folded — 3,6,8,13,14 strict, 7/10-unit folded) / 3 open (15,16 + D12-enum). Honest rollup: met 8, partial 5, open 3. See conformance section 8 for per-row test evidence.
|- End-of-roadmap conformance-honesty loop (2026-09-22, DOCS ONLY, zero code/test): reviews A+B + this loop folded into `docs/lsp-conformance.md`— (1) §7 stale "Wave 4+ stays future (no executeLspOperation() source)" bullet replaced with Waves 4–5 landed inventory (executor/strict-contract/affinity/cursors/tool/migration) + still-future list (RS1–RS7, T7/T8, D9/D12, R5, S9); legacy "when executor lands" re-assertion note updated to point at §8; (2) header status rewritten to agree with §8 (S1–S8, S10–S11 covered; S9 future; RS future-opt-in); (3) S9 flipped covered→future at time of writing — superseded: isolation test now present at `test/unit/lsp/bridge-adapter-isolation.test.ts` (S9 covered per `docs/lsp-conformance.md` §8); (4) deferred-note added: broker threads identifier/previousResultId at wire level but strict `workspaceDiagnostics` contract has no caller-supplied identifier field (allowed: `query` only), end-to-end threading deferred to Wave 6+. RS rows stay future-opt-in. No tests run (docs only).
- Reconciliation closeout (2026-09-23, DOCS ONLY, zero code/test): supersedes stale Wave 5/6 and criterion-16 lines above where they say RS1–RS7 future-opt-in / not created. Completed with evidence: RS1/RS6/RS7 covered opt-in (`test/integration/lsp/real-server-typescript.test.ts` 6 cases, `real-server-initialize.test.ts` 4 cases, `real-server-dynamic-config.test.ts` registerCapability honest-skip designed verdict; gate `PI_SMARTREAD_LSP_CONFORMANCE=1`); R5 covered (`test/unit/lsp/multi-role-routing.test.ts` exact `role`/`descriptorId` selection + `AmbiguousServerError`, no silent first-match); D9 strict file-diagnostics covered (paired confirmed-empty pull → empty+fresh vs absent/null/unsupported-pull → not_ready+null+unknown in `test/unit/lsp/executor.test.ts`); RPC encoding guard covered (`test/unit/language-intelligence/language-intelligence-encoding-guard.test.ts`, guard `RPC_PROPOSAL_POSITION_ENCODING`); ambiguity distinct covered (`classifyStatus` 9-status + `AmbiguousServerError` paths). Formally DEFERRED (accepted, not counted complete): (a) criterion 15 workflow/orchestration skills — reason: no approved skill convention exists (repo holds exactly one skill, `skills/inspect-script-mode/SKILL.md`; no registry/naming/lint convention), so the 8 `lsp-*` skill docs cannot be created correctly in this phase; (b) T12 send-before-handshake ordering — reason: no ordering implementation or regression test exists, only a note; needs connection-handshake queue + test before it can be claimed; (c) strict `workspaceDiagnostics` identifier threading — reason: broker threads identifier/previousResultId at wire level but strict contract allows `query` only, so end-to-end caller-supplied identifier threading needs a strict-contract field + registry + executor change with tests, out of scope for this docs-only closeout. SmartEdit-side consumption / proposal-approval-flow / atomicity remain PENDING sister-repo owner decision — this phase completes SmartRead-side guarantees only, no cross-repo policy invented (see `docs/lsp-smartedit-contract.md` §5 + scope note). Verification: `git diff --check` clean; no src/test edits.
- Docs-only sync (2026-09-23, zero code/test): `docs/lsp-conformance.md` — R5 flipped future→covered (`test/unit/lsp/multi-role-routing.test.ts`: exact `role`/`descriptorId` selection + `AmbiguousServerError`, no public `role` field on strict tool); D9 flipped partial→covered (strict file-diagnostics paired case in `test/unit/lsp/executor.test.ts`: confirmed-empty pull → empty+fresh vs absent/null/unsupported-pull → not_ready+null+unknown, plus pull-fallback/published/workspace cases); T9 names fixed (added FRAME-EXTRA-HEADER); T12/T13 rows added (T12 send-before-handshake still future; T13 unknown-method covered via `transport-classification.test.ts` "unknown still -32601" + `raw-method-policy.test.ts`); P7 encoding fail-closed row added (`test/unit/language-intelligence/language-intelligence-encoding-guard.test.ts`, guard `RPC_PROPOSAL_POSITION_ENCODING` in `src/language-intelligence/language-intelligence-provider.ts`); RS1/RS6/RS7 per harness reality (RS1 6 cases, RS7 4 cases covered-opt-in; RS6 covered-opt-in — registerCapability honest-skip is designed verdict); RS2–RS5 per stub reality (3 cases each, binary-absent/unrunnable + hover-indexing honest skips; clangd `--background-index=false` + hover skip-honest); test invocation updated (`PI_SMARTREAD_LSP_CONFORMANCE=1`, suites exist — dropped "once created"). `docs/lsp-smartedit-contract.md` — new §6 separates local behaviors (UTF-16-only RPC positions, fixed 10s local timeouts, SmartRead-session resultId continuity, SmartEdit-local preview/rollback) from unresolved guarantees (cross-repo lease, crash atomicity, wire encoding field, wire cancel/progress, cross-process continuity). Verification: grep file:line evidence + `git diff --check` only.
