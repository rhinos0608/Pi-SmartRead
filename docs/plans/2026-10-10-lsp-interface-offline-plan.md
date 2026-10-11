# LSP B/C: bounded offline prototype plan

Status: owner approved implementing B and benchmarking C; this plan authorizes offline prototype work only. It is not a trial preregistration, a spending admission, a release decision, or authorization to run agent sessions.

## Contract and unchanged behavior

A is the current accepted affordance surface, not the historical TEB baseline. B adds exact usage addressing and diagnostics/action composition. C presents the same backend through an intent-first facade. All expose exactly one tool named `LSP`.

Production `src/` contracts, strict/off schemas, default selection, exact server routing, zero-based negotiated `position`, and declaration `symbol` semantics remain unchanged. Explicit file reads are not newly jailed to a workspace. No command execution, guessed targets, automatic action selection/application, or direct WorkspaceEdit writes. Advanced requests and existing requests delegate through the original tool's `execute`, not directly through the strict executor: the tool owns SmartEdit staging and `applyProposal` routing.

Initial code belongs under `scripts/eval/lsp-ergonomics/` with corresponding `test/unit/eval/lsp-ergonomics-*.test.ts`. No edits to frozen TEB tasks, grading, splits, historical protocols, the retrieval engine, or the sister SmartEdit repository.

## Source-grounded decisions

- `src/lsp/affordance-contract.ts:36–48` defines the five existing navigation recipes; `:63–70` defines the six declaration-anchor operations. New source addressing initially covers those same six operations and the five recipes, not every positional operation.
- `type` means the existing hover/inferred-type recipe, not `goToTypeDefinition`.
- Existing recipe bounds (`affordance-contract.ts:72–83`) are six underlying requests, 15 s admission deadline, 100 per-step results, and 48 KiB model-facing projection. Preserve full step envelopes in details and disclose omissions. Bootstrap requests count toward the same six-request budget; nested work cannot reset it.
- The installed WASM runtime `web-tree-sitter@0.22.6` rejected ABI-15 grammars. The prototype uses already-declared native `tree-sitter@0.21.1` and pinned native grammars; it does not repair or upgrade the production WASM path. Treat that separate capability gap as a follow-up recommendation.
- `src/lsp/lsp-position-codec.ts:90–95` provides `convertOffset(line, offset, from, to)`. Validate source offsets before conversion; its clamping must not repair a guessed offset.
- Pi registration records identity from the original registry after `pi.registerTool` (`src/extension-registration.ts:201–229`). Recording transformed identity inside a wrapper is overwritten; registry-only replacement also leaves the hardcoded guidance identity wrong. Neither scouting proposal is accepted as an identity seam.

## File ownership and stages

One writer per owned file set. Read-only review follows each completed stage; parent reruns a named check before accepting it.

### 1. Exact source locator — implemented, locally reviewed

Owned files: `source-locator.ts` and `lsp-ergonomics-source-locator.test.ts`.

Input is `{ path, line, identifier, occurrence? }`: physical line and explicit occurrence are one-based; identifier matching is exact and case-sensitive. More than one eligible token without an occurrence is ambiguous. A missing ordinal never falls back to the first token. Output identifies zero-based source rows and UTF-16 offsets separately from negotiated LSP coordinates, with canonical path and original-byte SHA-256. It grants no source/evidence authorization.

Defaults: regular UTF-8 source up to 1 MiB, 100,000 traversed nodes, 100 matches, ten displayed ambiguity candidates, and 15 s checked admission/native-parser CPU budget. Filesystem waits are not claimed to be interruptible. Unsupported grammars, recovery, cancellation, and exhausted bounds cannot become false absence claims.

The 24 real-parser fixtures cover the admitted TS/TSX/JS/Python/Rust/Go families, extensions, Unicode, BOM, CRLF/bare CR, exact ordinals, token decoys, malformed input, canonical paths, and bounds. Parent verification of the integrated source-addressing slice passed 80 focused cases and typecheck; owned-file lint has zero errors and five complexity/size warnings. Node 20, three-OS execution, and real-server behavior still require authorized CI.

### 2. Shared bounded backend

Own `shared-backend.ts`, `diagnostic-actions.ts`, and `lsp-ergonomics-backend.test.ts`.

A source target uses a separate `source: { path, line, identifier, occurrence? }` object. It is mutually exclusive with top-level `path`, `position`, and `symbol`; routing/budget fields remain explicit. Resolve relative paths against invocation cwd before calling the locator. Preserve old target forms byte-for-byte through the original tool.

For new source targets, obtain actual initialized server identity/encoding through a position-free original `documentSymbols` request. Do not infer encoding from a default or switch servers. If usable metadata cannot be established, refuse source dispatch explicitly. Recheck the original source digest, convert its validated UTF-16 column using the exact line, pin subsequent calls to that descriptor, and recheck freshness after dispatch. Preserve step envelopes and report stale/incomplete outcomes rather than usable results. No cross-process source lock is claimed.

The source-addressing slice is implemented separately in `source-routing.ts` with routing, bootstrap, bounded-snapshot, and runtime tests. Local regression checks cover pre-dispatch validation, negotiated encoding, admission counts, metadata drift on successful and failed replies, retained completed-call traces, unknown exception propagation, and cancellation/deadline expiry during pending snapshot reads. Review `0f591eae` closed the last two confirmed findings only; this is not a release, cross-platform, or real-server acceptance. A discovery-only implementation now exists in `diagnostic-actions.ts`. Review `fa0281ad` closed only the four reproduced malformed-diagnostic/coverage/count findings. Worker `21025a90` then extracted validation, runtime, diagnostic confirmation, action grouping, and output helpers. Parent reproduced and corrected an added async rendering yield with a scheduling regression; 37 discovery/runtime/encoding/coverage cases and typecheck passed after that correction. Source lint has zero errors and four warnings: validation complexity 17, collection complexity 20 and six parameters, discovery complexity 29 (previously 100). The expanded runtime test also has a describe-length warning. Read-only review `ba9fc749` found no confirmed current-contract failure but did not rerun checks; exhaustive refactor equivalence remains unproven without an immutable before-file comparison. This closes a locally checked discovery checkpoint, not integration, release, Node 20/cross-OS, or real-server acceptance. Preparation and staging remain unbuilt.

The diagnostics/action workflow has two phases, an explicit regular-file `path`, optional negotiated-encoding `range`, and `kind: "quickfix" | "source.fixAll" | "source.organizeImports"` (default quickfix). `prepare` requires `selection: { actionId, sourceSha256 }`; both are 64-hex strings. Routing fields are unchanged. Selection identities bind canonical source path/digest, exact descriptor/encoding, discovery range/kind, and the action payload. Canonicalization must preserve all untrusted JSON keys, including `__proto__`; no prototype setters, raw payload logs, or expectation derived from evaluated output.

The pure `action-identity.ts` substep is locally checked with 17 parent cases, typecheck, and zero lint errors; its two complexity warnings and broader integration acceptance remain open. Its canonical binding budget is the existing 48 KiB output bound, with a depth-64 processing limit; these are offline prototype assumptions, not a trial freeze. Over-budget identities must be refused rather than truncated, and discovery must disclose any resulting coverage omissions. Bind the received normalized action, preserving every JSON key present there, including nested `data`; the production action normalizer intentionally does not retain unknown top-level wire fields.

- `discover`: capture bounded canonical source fingerprint, obtain diagnostics, query bounded code actions with diagnostic context, and return eligible options with deterministic action identities and provenance. Distinguish diagnostics from action coverage; no diagnostics does not prove no source actions. Caller range, if present, remains zero-based in negotiated encoding. A computed full-file range requires actual negotiated metadata.
- `prepare`: caller supplies the chosen action identity and discovery source digest. Refuse changed source before semantic requests. Re-query the same bounded discovery, require one distinct matching current action, and resolve only that explicit choice. Identical payload duplicates may be deduplicated; distinct candidates or identity collisions are refused. A changed/nonmatching action is stale, never a first-action fallback. Command-only, disabled, or command-bearing actions are not prepared by this workflow. Preserve raw results and explain unavailable preparation. Do not merge alternative edits.

For this new recipe's resolution step, use the strict executor's read-only result rather than the auto-staging tool wrapper; source freshness and command checks must happen before staging. This does not change the requirement that legacy and advanced calls delegate through original tool execution. Stage a valid selected edit only through the existing SmartEdit proposal RPC, with the existing UTF-16-only staging constraint. Reuse `src/lsp/lsp-workspace-edit.ts` and read `docs/lsp-smartedit-contract.md` completely before implementing this binding. If staging cannot be established, return an honestly unstaged/read-only result. Never synthesize a successful language-server response or apply edits. `applyProposal` remains separate and original-tool-mediated.

Verified staging ownership: `stageWorkspaceEdit` (`src/lsp/lsp-workspace-edit.ts:232–253`) checks bus/session-path presence and handles RPC replies; it does not independently check session-file existence, envelope freshness, negotiated encoding, commands, or source fingerprints. The new recipe must enforce those gates before calling it. Use `envelopeResultToWorkspaceEdit` for conversion, not an invented staging API; do not infer these checks from the inventory scout's report.

Preparation is split into a read-only selection/re-discovery/resolution gate, then a separate SmartEdit staging adapter. Scout `d24bcae6` and parent source checks established a current blocker: strict `resolveCodeAction` forbids `path`, and `resultMetaForPath` returns no freshness for pathless requests (`lsp-executor.ts:176,919`). Preserve the required fresh-envelope gate: unresolved choices remain unconfirmed, not usable proposals. Do not adopt the scout's contrary recommendation to remove that gate. Route any explicit resolution through the selected live descriptor and actual workspace; do not spawn or guess a fallback. Neither default metadata nor a source snapshot may be relabelled as a fresh server response. Resolving this capability gap requires a separately approved core/contract change. Repaired scout retry `adc1fa8f` recommends an internal executor binding, but this is not accepted: descriptor/path/hash alone omit connection identity and encoding; store hashes can represent unsent changes (`lsp-document-store.ts:204–259`, `lsp-connection.ts:544–588`); dead-request retries can acquire a new connection (`lsp-executor.ts:959–989`). Parent also refuted the proposed source-path use for `sessionFilePath`: staging actually uses `resolveSessionFilePath(opts,ctx)` (`lsp-tool.ts:351–362`). Oracle workflow `8af88d51` is checking the smallest safe action-origin receipt/preparation seam; no implementation or protocol change is authorized by this research alone.

The admission substep now provides optional internal discovery guards for the expected source SHA and an absolute logical-clock deadline, and exposes the existing validators additively for preparation reuse. Parent verification passed 48 cases and typecheck, including both abort and deadline expiry during an actual initial read with all handles closed. Scoped private-index whitespace passed without changing the original index. Review `4ff188bf` found no confirmed issue within these guard changes; platform/real-server acceptance remains unverified. Source lint has zero errors and four warnings, with discovery complexity now 31; the expanded guard test adds a describe-length warning. Old calls retain their behavior. These guards are backend-library inputs, not new registered-tool fields. The next isolated selector owns `action-selection.ts` and `lsp-ergonomics-selection.test.ts`, with no resolution, conversion, staging, or registered-tool changes. Workspace-edit validation evidence currently comes from SmartRead's local `src/workspace/workspace-edit-validator.ts`; the scout did not establish that this is an installed protocol-package validator.

Preparation threat boundary: the caller's identity is a selection, not authorization. Recheck source digest before semantic dispatch and publication; bind the exact descriptor/encoding and full normalized JSON action; refuse ambiguous or changed choices, command-bearing/disabled results, and incomplete or malformed edits. Nested discovery and resolution share the six-request/15 s budget. Staging remains SmartEdit-only, UTF-16-only, separately gated, and never implies permission to apply. No cross-process lease or physically interruptible filesystem wait is claimed.

Tests must fail on guessed/ambiguous/stale dispatch, encoding mismatch, source mutation between phases, exact-server fallback, hidden requests/output truncation, forbidden commands, merged alternatives, unavailable staging, or disk mutation. Use fake executors/bus and real source fixtures, not local real servers.

### 3. B/C schemas and translation

Own `facades.ts` and `lsp-ergonomics-facades.test.ts`.

B preserves the current strict and `investigate` requests and adds the source target plus `operation: "diagnosticActions"`, with `phase: "discover" | "prepare"` (default discover).

C exposes nine tasks: `definition`, `type`, `references`, `implementations`, `callers`, `symbols`, `diagnostics`, `actions`, `advanced`. The five navigation tasks map to the identical B recipes; symbols uses explicit path/query XOR; diagnostics uses explicit file/workspace selection; actions maps the identical diagnostics/action workflow. Advanced carries an exact strict request, rejects recursive wrappers and facade-only fields, and forwards through original execution.

C also retains a compatibility-only top-level `operation` branch for already accepted strict/current-affordance calls. It never reinterprets an existing `position` or declaration `symbol`. Validate that branch with the original contract; a broad compatibility schema is not permission to accept unknown operations/fields. Mixed branches fail except the existing `operation: "investigate", task: ...` form.

B/C must produce equivalent normalized requests, results, internal counts, rendering, failure categories, deadlines, and staging for equivalent inputs. Invocation hints may translate interface syntax only, not substantive content, candidate ranking, or selection. Freeze table-driven traces, strict/off snapshots, foreign-field/XOR/recursive-advanced rejection, raw allowlist rejection, and explicit SmartEdit-only apply fixtures.

### 4. Isolated registration and actual identity

Own `extension.ts`, `prototype-identity.ts`, and `lsp-ergonomics-extension-identity.test.ts`.

Use a narrow API proxy around the original extension factory, transforming only its final LSP definition. Preserve API methods/properties, receivers, all other registrations/events, and full execute context. Test non-enumerable/prototype methods; do not spread-copy the API or bootstrap a guessed duplicate lifecycle. Register LSP once.

All three trial arms explicitly disable the product's opt-in core logger and opt into a dedicated prototype identity logger. This is a separate, uniformly opted-in trial contract, not a modification or bypass of the legacy TEB identity contract. No runtime environment mutation, stderr filtering, or replacement of an already emitted line.

After original registration completes, capture the actual registered LSP and inspect schemas, descriptions and Pi guidance; feed them into the existing canonical recorder. Emit exactly one dedicated trial receipt containing actual canonical identity, A/B/C profile and implementation/dependency provenance. Keep prototype provenance outside the unchanged product identity shape. Expected values must be externally frozen from immutable builds, never evaluated logs. Refuse mixed logging modes, missing/malformed/duplicate records and any full-identity/build mismatch before grading.

Equivalent guidance facts, cautions and example coverage must differ only in interface syntax. Inventory original prompt/skill hooks before any real launch; do not modify user-global skills or allow stale operation-specific guidance to invalidate the comparison unnoticed.

### 5. Offline acceptance, then separate trial planning

Once new files exist, proposed focused acceptance commands are:

```sh
nice -n 10 npx vitest run test/unit/eval/lsp-ergonomics-source-locator.test.ts test/unit/eval/lsp-ergonomics-backend.test.ts test/unit/eval/lsp-ergonomics-facades.test.ts test/unit/eval/lsp-ergonomics-extension-identity.test.ts
nice -n 10 npm run typecheck
nice -n 10 npx eslint scripts/eval/lsp-ergonomics test/unit/eval/lsp-ergonomics-*.test.ts
```

Review all added files as well as tracked diff; ordinary `git diff` omits untracked additions. Run whitespace checks for both. Full tests and Node 20 Linux/macOS/Windows plus real-server conformance belong in authorized CI, not concurrent local retrieval windows. CI-only snapshots remain non-merge candidates.

No agent evaluation follows automatically. A separate preregistration/admission must resolve independent source-first navigation and diagnostic/proposal gold, reviewed graders, exact semantic-target scoring, model/build identities, paired task-level inference, correctness/safety/compatibility/cost guards, joint-rule power/feasibility, exclusions, metered costs within cap10, and a quiet window. Replicates are not independent tasks; no model averaging, score-based tuning, or retroactive threshold changes. C promotion requires the prospectively accepted winner rule; a tie/inconclusive result never authorizes unqualified B over A.

## Self-review

The offline stages cover shared addressing, diagnostics/actions, intent translation, legacy compatibility, effective identity and reviewable traces. The largest regression risks are source-coordinate drift and metadata that describes a different tool from the one registered. Real-token fixtures and matched traces address the first; post-registration canonical receipts address the second. Production integration, experiment sizing and spending are deliberately outside this plan, and remain blocked rather than represented by runnable placeholder settings.
