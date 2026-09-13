# inspect script-mode design

**Date:** 2026-09-13
**Status:** Draft — pending oracle attack
**Owner:** Pi

## Goal
Let `inspect` accept a bounded, read-only JS script that composes several retrieval/graph/LSP operations (grep, read, file/dir inspect, LSP navigation, graph impact/deadCode/callgraph) inside one tool call, instead of forcing N sequential tool round trips.

## Non-goals
- No write/mutate host bindings, ever. Script mode cannot call `edit`/`write`/`patch` — read-only by construction, not by policy check.
- No general Node access inside the sandbox (no `fs`, `net`, `process`, `require`).
- No new `inspect` output modes for existing path-based dispatch — script mode is a fully separate branch, not a third `InspectV4Mode` value.
- No protocol version bump — script mode must fit inside `@rhinos0608/pi-workspace-protocol` v3 as-is (confirmed feasible, see Evidence section).

## Context
- Current `inspect` dispatches by `statSync(path)`: directory → repo map, file → structural facts. Schema in `src/inspect/inspect-tool.ts`, dispatch in `src/inspect/inspect.ts`.
- Evidence contract: every tool result's `details.workspaceEvidence` is a `WorkspaceEvidenceEnvelope` (schema v3, `@rhinos0608/pi-workspace-protocol`). `mode` is a closed, runtime-validated enum: `"path" | "query" | "symbol" | "map"` (`contract.ts` `validateInspectionEnvelope`). `query`/`symbol`/`map` already permit zero resources; `path` (or omitted mode) requires ≥1.
- `resourceIdFor({kind, canonicalPath, range})` hashes kind+path+range — a full-file read and a range/search-match hit on the same path get *different* resourceIds. This means naive union-dedupe-by-resourceId across many calls is already correct; no "strongest coverage wins" merge pass is needed.
- `src/evidence/read-many-evidence.ts`'s `buildBatchWorkspaceEvidence()` already solves "merge N per-call envelopes into one batch envelope" for `read({ paths: [...] })`. It hardcodes `mode: "path"`.
- `executeInspectV4()` (`src/inspect/inspect.ts`) and grep's compute layer already build a complete `WorkspaceEvidenceEnvelope` per call, independent of the tool wrapper's `resolver.publishInspection()` side effect. The *-tool.ts wrappers only relay + publish that envelope once per execute() call — publishing is tied to a single outer `pi.tool_result.*` event, not to how many internal ops ran.
- No sandbox dependency exists in this repo today (`package.json` has none of vm2/isolated-vm/quickjs/starlark).

## Recommended approach
QuickJS via `quickjs-emscripten` (justjake, `@jitl/*` variants), WASM-isolated interpreter, no Node builtins exposed, host functions injected as the *only* API surface. Read-only host API removes the worst blast-radius concern (no corrupted repo state possible — worst case is wasted CPU/time inside a bounded run).

Host API: fine-grained typed namespaced functions mirroring existing `InspectV4Input` fields 1:1 — no new capability, only a new calling convention:
- `grep(pattern, opts)`
- `read(path, opts)`
- `inspectFile(path, opts)` / `inspectDir(path, opts)`
- `lsp.definition/references/implementation/hover/documentSymbols/workspaceSymbols/prepareCallHierarchy/incomingCalls/outgoingCalls(...)`
- `graph.impact/deadCode/callGraph/hotspots/routes/diff/clusters/layers/boundaries(...)`

Rejected: generic `call(op, args)` dispatcher — same power, worse ergonomics, no benefit since the op set is closed and small (matches Anthropic/Cloudflare code-exec-with-MCP precedent of exposing typed per-tool functions, not one generic invoker).

## Alternatives considered
1. **Declarative JSON step-plan (no eval)** — safest/most staticaly auditable, but no loops/branches without hand-adding step types one by one; less expressive for genuinely exploratory multi-hop investigation. Rejected per explicit user direction (read-only removes the main reason to prefer this).
2. **isolated-vm** — true V8 isolate, but native addon (node-gyp build), Node-version lockstep, "maintenance mode" upstream, and a real escape surface if `Reference`/`ExternalCopy` misused. Rejected: not worth the operational risk for a read-only use case where QuickJS's weaker JS-feature fidelity is a non-issue.
3. **Starlark** — deterministic/hermetic by design (ideal semantics), but no mature JS binding (npm `starlark` is a dead v0.0.0 placeholder; real path is a Go/Rust sidecar process). Rejected: too much integration cost for an in-process TS tool.
4. **vm2 / bare node:vm** — excluded outright. vm2 has a history of sandbox escapes (CVE-2026-22709, CVSS 9.8) and is not a real security boundary; `node:vm` was never a security boundary.

## Design

### Schema (src/inspect/inspect-tool.ts)
New optional top-level param `script: string`. When present:
- `path` becomes optional — used only as the cwd-anchor/default arg for host calls that omit an explicit path.
- All other mode-specific params (`signals`, `mapTokens`, `focus`, `compact`, `callDepth`, `callDirection`, `deadCode`, `impact`, `diff`, `clusters`, `graphSchema`, `hotspots`, `boundaries`, `routes`, `layers`, `navigation`, `diagnostics`) are rejected with the same "Error: inspect param X requires Y" pattern already used by `validateDirOnlyParams`/`validateCrossParams`.
- Dispatch: `executeInspectV4` gains a script branch checked before `resolveInspectV4Mode()`'s stat-based dispatch — script mode never touches the file/dir mode machinery.

### Execution
- Sandbox: one QuickJS context per script call. Hard caps (tune after spike): wall-clock deadline ~3-5s via `shouldInterruptAfterDeadline`, memory 8-16MB via `memoryLimitBytes`, instruction-count interrupt as backstop, host-call count cap ~50/run enforced host-side (not by the interpreter).
- Host bindings call the underlying **compute-layer** functions directly (`executeInspectV4`, grep's `executeGrepQuery`, the LSP inspection provider) — never the registered tool-level wrappers. This is load-bearing: tool wrappers call `resolver.publishInspection()` themselves, and that publish is meant to happen exactly once per real `pi.tool_result.inspect` event. Calling N tool wrappers inside one script would either be wasted redundant publish attempts or invite inspectionId collisions within a single synchronous run.
- Concurrency: `Promise.all` over multiple host calls is supported — QuickJS's own microtask queue resolves pending host promises as they settle; the host-call-count budget bounds fan-out abuse regardless of concurrency.
- Every host call appends `{op, args, envelope}` to an in-run call log (the `envelope` being that call's own already-built per-call `WorkspaceEvidenceEnvelope`).

### Evidence synthesis
After the script returns (or is cut off by a budget), the call log's per-call envelopes get merged with a **generalized** `buildBatchWorkspaceEvidence` (add an optional `mode` param, default `"path"` to preserve read-many's existing behavior; script mode passes `"query"`, matching contract.ts's already-permitted "may legitimately have zero resources" bucket). Dedup-by-resourceId is already correct as-is because `resourceIdFor` hashes kind+path+range — a `search-match` hit and a later `full-file` read of the same path naturally coexist as two distinct resource entries; nothing needs to be "upgraded". The single merged envelope becomes `details.workspaceEvidence` on the one real tool result, and the existing `resolver.publishInspection()` call in `inspect-tool.ts` (already best-effort, already unconditional on `details.workspaceEvidence`) needs no changes.

### Output
Script's returned JS value (JSON-serializable) becomes the structured `details` payload; a rendered text form becomes `contentText`, following existing truncation/byteLength/lineCount conventions in `InspectV4Result`. `console.log` calls inside the script, if exposed, are captured as a side-channel log rather than the primary return value.

### Error handling
Interrupted runs (timeout / step limit / host-call budget / memory limit) return a structured degraded result — following the existing `NavigationStatus`/`DiagnosticsStatus` pattern (`"ok" | "degraded" | "unavailable" | ...` open string union) — not a thrown tool-level error. Script-level JS exceptions are caught and surfaced the same way, with whatever partial call log/envelope had accumulated before the throw still returned (partial evidence is valid evidence — same principle as `read-many`'s "only complete rendered blocks get authority").

## Testing and verification
- Sandbox spike: pin exact `quickjs-emscripten` variant, prove deadline/memory/step interrupts fire, benchmark p95 latency for a 5-host-call script.
- Escape/DoS fuzz: infinite loops, huge string allocation, deep recursion, `Promise.all` fan-out past the host-call cap — confirm all degrade cleanly, none corrupt the resolver cache or leak beyond the sandbox.
- Evidence contract test: script that calls `grep` then `read` on the same file — confirm merged envelope contains both distinct resourceIds and patch can address either via `evidenceRef`.
- Existing `test/unit/inspect/*` and `test/unit/retrieval-boundary.test.ts` must stay green (script mode is additive, not a change to path-based dispatch).

## Risks and open questions
- Exact `quickjs-emscripten` package/variant to pin — root `quickjs-emscripten` npm listing looked stale; live line is via GitHub `justjake`/`@jitl/*` packages. Needs a spike to pin precisely.
- Sub-second budget feasibility with asyncify host-call round trips under real LSP latency (LSP calls can be slow) — needs benchmarking, may need a lower host-call cap or longer deadline specifically when `lsp.*` ops are used.
- Whether `console.log`-style side-channel output is worth exposing at all, or whether return-value-only keeps the contract simpler.
