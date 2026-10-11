# Canonical action-origin freshness — clean migration

Status: **Owner authorized clean migration; source-backed implementation seams being finalized.**

Owner states there are no consumers outside these repositories and explicitly authorizes breaking cleanup across SmartRead, SmartEdit, and Workspace Protocol where necessary. No legacy adapters, optional compatibility paths, or another approval gate for reversible implementation choices. This supersedes the earlier additive-only proposal. It does not authorize publication, commits, destructive data operations, paid evaluations, or changing historical study verdicts.

## Verified problem

The current API cannot establish action-origin freshness merely by attaching a path/hash to pathless resolution:

- `ExecutorConnection.getDocumentStore()` exposes attempted version/hash only (`src/lsp/lsp-executor.ts:42–50`).
- Store content/version change before notification submission; no-sync changes are tracked locally (`src/lsp/lsp-document-store.ts:204–259`).
- `notify()` can return after failed initialization, and `sendFrame()` can write nothing on a closed/missing transport (`src/lsp/lsp-connection.ts:468–491`). A resolved preparation promise therefore does not prove successful local submission.
- Current freshness compares disk/store only after the request (`src/lsp/lsp-executor.ts:166–198`). Descriptor/path/hash do not identify the live connection or the origin of a returned action.
- Both action operations already prohibit retry (`src/lsp/lsp-operation-registry.ts:241–257`); generic executor retry concerns must not be presented as current action retry behavior.
- Staging uses the Pi session file, not the source document (`src/lsp/lsp-tool.ts:351–362`), and the tool staging helper does not itself enforce freshness (`322–378`). The prototype must call the read-only executor and gate staging separately.

Evidence: scout `adc1fa8f` and oracle `39893a08`, with parent targeted source verification. Their recommendations are not implementation acceptance.

## Chosen direction

One canonical submitted-document preparation path and explicit action-origin binding, migrating every in-repository consumer. Delete superseded contracts and migrate tests/docs instead of maintaining old and new paths. Change shared staging contracts only where source inspection establishes a necessary integrity precondition; do not expand unrelated features.

A path/hash-only binding or removal of the fresh-envelope gate remains unacceptable. Parent verified an additional wire defect: current `buildParams` wraps resolution as `{codeAction: ...}` (`lsp-executor.ts:247–248`), while official LSP3.17 requires the CodeAction itself as params. Correct this in the clean cut with exact raw/normalized correspondence and preserved server `data`; do not keep the incorrect wire shape as a compatibility branch. Source: https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#codeAction_resolve .

## Proposed contract

### Submitted document receipt

Track successful local submission separately from attempted document state. Receipt binds canonical document/state identity, submitted version/hash/generation, synchronization configuration, submission stamp, exact connection/store/transport incarnation, negotiated encoding, and canonical root.

Record submission only after the writable callback succeeds; `write() === false` is backpressure, not failure. Failed/skipped submission, close/replacement/configuration change, and uncertain preparation invalidate the receipt. Unchanged preparation may reuse only an independently valid submitted snapshot. Refuse no-sync and `openClose:false`. Do not silently recover uncertain server state using incremental changes against an unproven base.

Replace the ambiguous preparation contract with the canonical submitted-state contract and migrate callers/tests. Preserve exact routing, bounded work, fail-closed validation, and action no-retry policy—not obsolete envelopes or request quirks. No parallel `prepareDocumentWithReceipt` compatibility API. Final signatures are frozen for each implementation handoff after source-backed consumer mapping.

### Action-origin receipt

In an invocation-local executor context, capture the exact submitted receipt before `codeActions`, revalidate after its response and final bounded awaited source read, and privately bind it to the complete selected candidate. Receipt never appears in model envelopes/options/action payloads or a global cache.

Selection uses the receipt from its own rediscovery, not an earlier invocation or a reconstructed descriptor/hash. Pathless resolution requires the same live registered connection, transport/store/document identities, version/generation/submission stamp/configuration, encoding/root/path/digests, and complete action identity before and after dispatch. Do not prepare a changed document and rebind an old action. Refusal uses non-success strict statuses with null result; successful bound resolution populates client-observed freshness/version fields. Migrate the actual request/result contract and every consumer as needed; unsupported unbound resolution is not retained as a compatibility route.

One absolute deadline spans acquisition, queued preparation, submission, wire request, and final source read. Cancellation precedes timeout, both precede stale classification after every await. Late acquisitions release leases; aborted queued work cannot send or publish a receipt. Raw-byte and decoded-text digests remain distinct and checked against the corresponding representation, including BOM/UTF-8 behavior.

### Separate staging

Only validated, explicitly selected, command-free, fresh, UTF-16 edits can reach the existing SmartEdit staging RPC. The Pi session file remains separate from the document path. No automatic application or prepare-to-apply authority is granted.

## Threats and deterministic checks

| Boundary | Threat | Required negative check |
|---|---|---|
| Model selection → internal receipt | Reconstruct/alter origin or opaque action data | Modified/duplicate candidate refused; no resolution dispatch |
| Attempted store → submitted transport | Unsent or failed synchronization presented as fresh | Failed init, absent/closed stdin, callback error, uncertain prior change yield no receipt |
| Live session → deferred action | Same descriptor on replacement connection, ABA state | Replacement/close/reopen/config/encoding/root/generation drift refused |
| Await → publication | Cancellation/deadline loses to stale or late work publishes | Deferred acquisition/queue/submission/wire/final-read tests; drain and release all resources |
| Prepared edit → mutation | Receipt mistaken for authority or cross-file guarantee | Zero stage/apply/file-write calls in receipt/preparation tests |

Use fake transports, clocks, deferred promises, and temporary source files; no local real servers or evaluations during active retrieval. Migrate strict contract/caller tests to the intended new behavior; add valid full-chain, rejected superseded inputs, BOM/invalid-UTF8/canonical rebinding tests. Tests must first demonstrate the relevant attempted-vs-submitted failure; missing APIs alone are not a behavioral red.

## Implementation partitions

1. Connection/store submission truth and focused transport/document tests, one exclusive writer for these coupled files.
2. Executor invocation-local origin capture/resolution gates and focused executor tests, after partition1 acceptance.
3. Prototype selection/preparation integration and tests, after partition2 acceptance; separate staging adapter afterward.

Parent verifies focused tests/typecheck/private-index diff checks; a fresh reviewer challenges each accepted seam. Native Windows/Node20/real-server acceptance stays in current-build CI. Preserve dirty code and original indexes; nice>=10 focused work only under the existing resource policy.

## Limits and exclusions

Local successful submission is **not server acknowledgement or completed indexing**. No other-file freshness, uninterrupted disk stability, cross-process lease, durability, or apply authority is promised. Necessary sister-repository/schema/RPC migrations are authorized, with coordinated local verification; publication/version-tag operations are separate. Historical frozen engine/cohorts/verdicts remain untouched. All newly compared surfaces must use the same corrected backend and matched capabilities; regenerate immutable surface pins and preregister adoption before admitted outcome runs. Passing implementation tests alone cannot justify promotion.
