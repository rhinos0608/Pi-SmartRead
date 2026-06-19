# Audit: MCP / API / Tool Schema Correctness & Integration Risks

**Scope:** MCP server, MCP tool registry, resource resolver, Pi extension wiring, and the focus tools (`find-symbol-tool`, `git-notes-tool`, `graph-mutate`, `deep-search-tool`) plus their tests.

**Date:** 2026-06-19
**Repo:** `/Users/rhinesharar/Pi-SmartRead/Pi-SmartRead/`
**Working tree state (relevant):**
- Modified: `mcp-registry.ts`, `mcp-resources.ts`, `find-symbol-tool.ts`, `git-notes-tool.ts`, `graph-mutate.ts`, `test/unit/mcp-server.test.ts`
- Untracked: `deep-search-tool.ts`

**Baseline:** `npm run typecheck` ✅, `npm test` ✅ (47 files / 615 passed / 4 skipped), `npm run lint` ❌ (2 errors, 29 warnings, pre-existing).

---

## P0 — Blockers

### P0-1. `mcp-server.ts` does not plumb `request.signal` to tool calls
- **File:** `mcp-server.ts:61-76`
- **Code:**
  ```ts
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    ...
    const result = await tool.execute(toolCallId, args ?? {}, undefined, undefined, ctx);
  ```
- **Impact:** Every focus tool checks `signal?.aborted` (e.g. `find-symbol-tool.ts:881`, `deep-search-tool.ts:94`, `handleSymbol`/`handleImplementations`). With the third arg hard-coded to `undefined`, **client-side cancel/abort has no effect on long-running tools** (deep_search, find_symbol with monorepo fan-out). The MCP SDK exposes an `AbortSignal` on the request handler.
- **Repro:** Spawn MCP server, call `deep_search` with `depth=thorough` and `directory=<large mono-repo>`, then close the client stream. Tool keeps running until completion.
- **Fix:** Forward the request signal:
  ```ts
  const result = await tool.execute(
    toolCallId,
    args ?? {},
    request.signal ?? undefined,
    undefined,
    ctx,
  );
  ```
  And pass it through to the stub `toExtensionContext` so `ctx.abort()` / `ctx.signal` are populated (see P0-2).

### P0-2. `toExtensionContext` stub silently throws on `ctx.ui.custom(...)` and may be invoked by tool code
- **File:** `types.ts:80-153`, `mcp-server.ts:74`
- **Impact:** `createMinimalContext`/`toExtensionContext` builds a stub whose `ui.custom` throws `Error("UI custom not available in MCP context")`. Several tools in the broader codebase call `ctx.ui.*` (e.g. progress notifications, editor interactions). A call from a non-focus tool would throw from inside the MCP handler, become `isError: true`, and the **MCP client receives an unhelpful "UI custom not available in MCP context"** — leaking internal context construction into the protocol error stream.
- **Repro:** Trigger any tool that calls `ctx.ui.custom` (not in focus list, but adjacent tools may).
- **Fix:** Replace throw with no-op return `undefined` (matching the rest of the stub), or wrap `ui.custom` in `try { return await ui.custom(...) } catch { return undefined }`.

### P0-3. Soft-fail tools leak `isError: false` to MCP clients for actual errors
- **Files:** `graph-mutate.ts:54-79`, `git-notes-tool.ts:84-94`, `git-notes-tool.ts:131-138`
- **Code (excerpt from `graph-mutate.ts`):**
  ```ts
  if (!existsSync(resolvedRoot)) {
    return { content: [{ type: "text", text: `❌ Root directory not found: ${resolvedRoot}` }] };
  }
  ...
  } catch (err) {
    return { content: [{ type: "text", text: `❌ Failed: ${message}` }] };
  }
  ```
- **Impact:** All three return shapes lack `isError: true`. The MCP client (Claude Code, Cursor, etc.) sees a successful tool call with an "❌" prefix in the body. **Clients that gate UI on `isError` will not display the failure**, and downstream agents may treat the response as a valid result. This is an MCP-protocol correctness defect, not a stylistic one.
- **Repro:** Call `graph_mutate` with a `directory` that doesn't exist via MCP — response has `isError: false`, body text starts with `❌`.
- **Fix:** Add `isError: true` to all error-path returns, or restructure the tool to throw and let the MCP handler set `isError: true` (which it already does in `mcp-server.ts:93-99`).

---

## P1 — High priority

### P1-1. `Type.Unsafe` enums bypass runtime TypeBox validation
- **Files:** `find-symbol-tool.ts:27-31` (`SymbolInfoSchema.action`), `graph-mutate.ts:19-25` (`relation`), `deep-search-tool.ts:21-27` (`depth`), `deep-search-tool.ts:29-35` (`scope`)
- **Impact:** `Type.Unsafe<{ type: "string", enum: [...] }>` preserves the schema shape (JSON-serialisation round-trips correctly) but **TypeBox's `Value.Check` throws `ValueCheckUnknownTypeError: Unknown type` on these schemas** (verified locally). Tools rely on type assertions (`params.action as string`) inside the execute handler, with no validation. Invalid values (e.g. `action: "BOGUS"`) propagate silently to the `switch (action)` default branch — which throws `"Unknown action: BOGUS..."`. That's an acceptable error message but the validation should happen at the protocol boundary, not deep inside the tool.
- **Fix:** Replace `Type.Unsafe<T>({ ... })` with `Type.Union([Type.Literal("outline"), ...])` (or `Type.Enum({ outline: "outline", ... })`) so both static typing and runtime validation work. Update descriptions/usage accordingly.

### P1-2. `mcp-server.ts` does not validate `tools/call` arguments against `inputSchema`
- **File:** `mcp-server.ts:61-76`
- **Impact:** Schema is advertised via `tools/list` but the server only forwards `args ?? {}` to the tool. Missing required parameters (e.g. `query` for `find_symbol`, `action` for `symbol_info`, `content` for `git_notes_write`) reach the tool as `undefined`. Most focus tools throw a clear error downstream, but the error path produces a generic message (`"query must not be empty or whitespace-only"`) rather than a JSON-RPC `-32602 Invalid params` error, which MCP clients know how to surface.
- **Fix:** Add a small validator using `@sinclair/typebox/value` (`Value.Check(tool.parameters, args)`) and return `{ code: -32602, message: "Invalid params: ..." }` on failure.

### P1-3. Experimental tool double-registration in `index.ts`
- **File:** `index.ts:334-355`
- **Code:**
  ```ts
  for (const tool of reg.getAll()) {     // includes experimental when enabled
    pi.registerTool(toolDefinition({...}));
  }
  if (experimental.graphMutate) {
    pi.registerTool(toolDefinition(createGraphMutateTool()));  // <-- duplicate
  }
  if (experimental.gitNotes) {
    for (const tool of createGitNotesTools()) {                // <-- duplicate
      pi.registerTool(toolDefinition(tool));
    }
  }
  ```
- **Impact:** When `experimental.graphMutate`/`experimental.gitNotes` is true, the first loop already registers them, then lines 346-355 register them again. Pi's `registerTool` may throw, log a warning, or silently overwrite — behaviour is undefined per the public `ExtensionAPI` contract. **Likely outcome: a console warning or an exception at extension-load time** that breaks the whole extension.
- **Repro:** Add `"experimental": { "graphMutate": true }` to `pi-smartread.config.json`, load the extension in Pi, observe the duplicate `registerTool` call.
- **Fix:** Either remove lines 346-355 entirely (the registry loop already covers them) or skip experimental tools in the registry loop and rely on the explicit block. Pick one source of truth.

### P1-4. `mcp-registry.reg()` has no dedup, will throw if called twice
- **File:** `mcp-registry.ts:32-35`
- **Impact:** `registry.register` throws on duplicate names (`tool-registry.ts:55-57`). `reg()` in `mcp-registry.ts` does not check first, so re-importing the module or running it after `index.ts` populates the registry will throw `"Tool "X" is already registered"` at module load — taking the whole process down.
- **Repro:** Any scenario where the module graph is loaded twice (HMR, tsx restart, test re-import). Currently masked because `mcp-registry.ts` runs before any other consumer in the working tree.
- **Fix:** Add `if (registry.has(name)) return;` guard, mirroring `registerFindSymbolTool` (`find-symbol-tool.ts:945`).

---

## P2 — Medium priority

### P2-1. `git-notes-tool.ts` `ToolContext` interface shadows the real `ExtensionContext`
- **File:** `git-notes-tool.ts:29-31, 48, 78`
- **Code:**
  ```ts
  interface ToolContext { cwd: string; }
  ...
  async execute(_toolCallId, params, _signal, _onUpdate, ctx: ToolContext) { ... }
  ```
- **Impact:** The execute parameter `ctx` is typed as `{ cwd: string }` (the real `ExtensionContext` is much larger). This works because `toToolDefinition` is a structural cast, but it (a) makes the tool harder to use in non-MCP contexts that pass a richer context, (b) is inconsistent with `find-symbol-tool.ts:880`, `deep-search-tool.ts:92`, `search-tool.ts` which all use `ExtensionContext`, and (c) bypasses the `types.ts` adapter.
- **Fix:** Type the parameter as `ExtensionContext` (import from `pi-coding-agent`) and use `ctx.cwd` directly.

### P2-2. `git-notes-tool.ts` write failure path returns `details: { error: ... }` but the success path returns `details: {}` — inconsistent with MCP content array conventions
- **File:** `git-notes-tool.ts:131-144`
- **Impact:** Minor — the `details` field is Pi-internal, but mixing error payloads in `details` while using `isError: false` semantics is inconsistent with P0-3.
- **Fix:** Throw on the error path so the MCP handler converts it to `isError: true` and the error is no longer hidden.

### P2-3. `deep-search-tool.ts` is uncovered by tests
- **File:** `deep-search-tool.ts` (untracked, new)
- **Impact:** The new tool is wired into the registry (`mcp-registry.ts:41`) and exposed via MCP, but `test/unit/mcp-server.test.ts:160-171` and `test/unit/index.test.ts:31-41` do not assert its presence. A future rename or removal of `deep_search` will pass tests silently.
- **Fix:** Add `expect(toolNames).toContain("deep_search")` to `mcp-server.test.ts` and `expect(names).toContain("deep_search")` to `index.test.ts`. Optionally add a unit test for the `cwd` resolution / sparse-cache wiring (`deep-search-tool.ts:96-153`).

### P2-4. `deep-search-tool.ts` `cwd` shadowing is confusing
- **File:** `deep-search-tool.ts:96-98, 144`
- **Code:**
  ```ts
  const cwd = params.directory?.trim()
    ? resolve(ctx.cwd, params.directory)
    : ctx.cwd;
  ...
  const absPath = resolve(cwd, match.file);
  ```
- **Impact:** Reassigns `cwd` to a (possibly user-overridden) absolute path. `recordSparse` is called with `absPath` derived from this — fine functionally, but a future change that wants "the original `ctx.cwd`" for a different purpose (e.g. session key) will get a surprising value.
- **Fix:** Rename the local to `searchRoot` or `resolvedDirectory`; keep `ctx.cwd` for session-keyed operations.

### P2-5. `mcp-resources.ts` `getResolvedConfig()` returns a `_note` discriminator key with leading underscore
- **File:** `mcp-resources.ts:50-57`
- **Impact:** The shape `embedding: null | { ... } | { _note: "No embedding config..." }` is hard for clients to discriminate. `_note` is a string-only convention. A client iterating `embedding` will see an object even when embedding is disabled.
- **Fix:** Use a discriminated union or null sentinel: `embedding: embedding ?? null`, plus a top-level `embeddingConfigured: boolean` field.

### P2-6. `mcp-resources.ts` `getServerStatus()` calls `buildToolRegistry()` on every read
- **File:** `mcp-resources.ts:60-77`
- **Impact:** Every `resources/read` for `smartread://status` rebuilds the full registry (calls each `reg()` factory, which in turn invokes `createReadTool()`, `createReadFilesTool()`, `createIntentReadTool()`, `createSearchTool()`, `createDeepSearchTool()`, `createRepoTool()`). These factories can be heavy (intent_read instantiates LRU caches and a per-cwd `contextGraphCache` lookup). For MCP clients that poll status, this is wasted work.
- **Fix:** Cache the result keyed on registry mutation count, or store the tool count when the registry is finalised.

### P2-7. `mcp-server.ts` returns `isError: false` with fallback "no output" when `result.content` is empty
- **File:** `mcp-server.ts:88-92`
- **Impact:** If a tool returns `{ content: [] }` (e.g. an empty search result), the MCP client receives `"Tool executed successfully (no output)"` — misleading because the tool may not have found anything, just silently produced an empty array.
- **Fix:** Allow tools to return `{ content: [], isError: false }` directly, and only add the fallback when `result` is `undefined`. Today, `result.content` always exists in practice, so the fallback is rarely triggered and may itself be a symptom of a bug.

### P2-8. `find-symbol-tool.ts` Action schema `Type.Unsafe` for `action` enum (also covered by P1-1)
- **File:** `find-symbol-tool.ts:27-31`
- **Impact:** Same as P1-1; listed again because the multi-action tool has the highest surface for enum mistakes (`outline`/`declaration`/`references`/`implementations`).

### P2-9. `mcp-prompts.ts` `explain-code` prompt declares `code` as required, server doesn't reject missing
- **File:** `mcp-server.ts:108-125`, `mcp-prompts.ts:27-30`
- **Impact:** The server reads `args?.code ?? ""` (line 120) and produces a prompt even if `code` is missing. Tests assert only that `"typescript"` is in the result, not that `code` is enforced. A client that forgets `code` gets a meaningless prompt.
- **Fix:** Throw a `-32602 Invalid params` for missing required prompt args (similar to P1-2 for tools).

### P2-10. `mcp-server.ts` `toExtensionContext` uses `cwd()` snapshot at call time
- **File:** `mcp-server.ts:74`
- **Impact:** `cwd()` is captured once per `tools/call` request. For a long-lived MCP server, if the process `cwd` changes (e.g. parent shell `cd`), tool behaviour changes too. Not necessarily wrong, but worth documenting or pinning to startup `cwd`.
- **Fix:** Capture `process.cwd()` at server start and pass that into every `toExtensionContext`, or accept a per-request `cwd` override once MCP SDK supports it.

---

## P3 — Low priority / observations

### P3-1. `mcp-registry.ts` no dedup; `find-symbol-tool.ts` has dedup — inconsistent
- **Files:** `mcp-registry.ts:32-35`, `find-symbol-tool.ts:938-954`
- **Note:** Two different registration patterns. Consolidate around the dedup-aware one.

### P3-2. `tool-registry.ts` `registerAllWithPi` is dead code
- **File:** `tool-registry.ts:82-92`
- **Note:** Never called; `index.ts:334-343` re-implements the loop inline. Either delete the method or use it in `index.ts` and remove the inline loop.

### P3-3. `mcp-server.ts` re-exports `MCP_PROMPTS` from `mcp-prompts.ts` but `MCP_RESOURCES` from `mcp-resources.ts`; description mismatch in helper
- **File:** `mcp-resources.ts:117-142`
- **Note:** Helper comment says use for `repo_map`, `deep_search`, `search` — confirm `search` tool still produces text overflow needing `resource_link` (after the `mode=deep` removal it likely does, but worth a smoke test). Description also says "Use this helper in tool result handlers" but no tool currently calls it — dead code or planned use.

### P3-4. `mcp-server.ts` error `content` text format is `"Error: <message>"` — non-standard
- **File:** `mcp-server.ts:67, 96`
- **Note:** MCP doesn't specify the body format, but many clients display the text verbatim. The `❌` emoji (in `graph-mutate.ts`) and `Error: ` prefix are two different conventions. Pick one.

### P3-5. `git-notes-tool.ts` write path silently succeeds if `findGitRoot` returns undefined
- **File:** `git-notes-tool.ts:89-91`
- **Note:** Returns a string "No git repository found." with `isError: false` (assuming P0-3 fix). User feedback: this is *intentional* graceful degradation, but should at minimum log to stderr or set `isError: true`.

### P3-6. `deep-search-tool.ts` has no upper-bound clamp on `limit`, `maxSnippetChars`, `outputBudget`
- **File:** `deep-search-tool.ts:42-59`
- **Note:** Schema description says "clamped to 1-50" but no `minimum`/`maximum` in TypeBox. Same for `maxSnippetChars` (100-1000) and `outputBudget` (1024-16384). The clamp must happen inside `executeDeepSearch` — verify in `deep-search.ts` (not in scope of this audit but the schema description lies about constraint enforcement).

### P3-7. `find-symbol-tool.ts` `Type.Unsafe` `action` + missing runtime validation
- **File:** `find-symbol-tool.ts:906-929`
- **Note:** `switch (action)` falls to a `default: throw new Error("Unknown action: ...")` — good, but the throw happens after the tool has already done no work, and the error message could be friendlier (list valid actions).

### P3-8. `mcp-server.ts` `tools.find` is O(n); called per request
- **File:** `mcp-server.ts:64`
- **Note:** Acceptable for ~8 tools, but a `Map` lookup would be O(1). Trivial improvement.

### P3-9. `git-notes-tool.ts` content length not bounded
- **File:** `git-notes-tool.ts:18-19`
- **Note:** `content: Type.String(...)` has no `maxLength`. A malicious or accidental call could write a multi-MB note to git, which then propagates to every `git fetch` peer. Add `maxLength: 64_000` (or similar).

### P3-10. `graph-mutate.ts` `confidence` schema allows any number 0-1 but doesn't reject `NaN`
- **File:** `graph-mutate.ts:27`
- **Note:** `Type.Number({ minimum: 0, maximum: 1 })` doesn't reject `NaN`. JSON Schema draft 7+ recommends explicit `type: "number"` validation. Low risk since MCP clients typically serialise JSON properly, but `NaN` would survive `Value.Check` in some TypeBox versions.

---

## Schema / Protocol Correctness Summary

| Concern | Status |
| --- | --- |
| Tool `inputSchema` published via `tools/list` | ✅ TypeBox serialises correctly |
| `inputSchema` runtime validation on `tools/call` | ❌ None (P1-2) |
| `Type.Unsafe` enum schemas valid for MCP clients | ⚠️ Structurally correct, but `Value.Check` rejects them (P1-1) |
| `isError: true` set on tool errors | ❌ Several soft-fail paths omit it (P0-3) |
| `AbortSignal` plumbed to tool calls | ❌ Always `undefined` (P0-1) |
| `_onUpdate` (progress) callback wired | ❌ Always `undefined` (no streaming) |
| Resource MIME types correct | ✅ |
| Resource resolver handles unknown URIs | ✅ Throws and is surfaced via `ReadResourceRequestSchema` error handler (test asserts) |
| Prompt required arg enforcement | ❌ No validation (P2-9) |
| Experimental tools default off in production | ✅ `loadExperimentalConfig` returns `{}` without config (default tests pass) |
| Duplicate tool registration in Pi extension | ❌ P1-3 |
| Duplicate tool registration in MCP registry | ⚠️ Masked by current call order (P1-4) |
| New `deep_search` tool covered by tests | ❌ No assertion in any test (P2-3) |

---

## Recommended Fix Order

1. **P0-3** (3 sites, small edits, high correctness value)
2. **P0-1** (one line, plumbs `request.signal` through to all tools)
3. **P0-2** (one line — replace throw with no-op)
4. **P1-3** (delete duplicate `pi.registerTool` calls or skip in loop)
5. **P1-4** (one-line dedup guard)
6. **P1-1** (replace `Type.Unsafe` with `Type.Union` / `Type.Enum` across 4 files; high churn but correctness win)
7. **P1-2** (add `Value.Check` validator at the protocol boundary)
8. **P2-1, P2-2** (small type fixes in `git-notes-tool.ts`)
9. **P2-3** (add `deep_search` test assertions — 2 lines)
10. Remaining P2 / P3 items as time permits.

---

## Test Coverage Gaps Identified

- `mcp-server.test.ts` does not assert `deep_search` is listed (P2-3).
- `mcp-server.test.ts` does not exercise a `tools/call` happy path with full `inputSchema` validation (would catch P1-2).
- `mcp-server.test.ts` does not exercise the `resources/read` error path for a tool-issued resource_link that exceeds `LARGE_RESULT_THRESHOLD` (P3-3).
- `mcp-advanced.test.ts` does not test the prompt required-arg validation path (P2-9).
- No test verifies `isError: true` is set on `graph_mutate` failures (P0-3).
- No test verifies the `request.signal` abort behaviour (P0-1).
- `index.test.ts` does not assert `deep_search` registration on the Pi path (P2-3).
