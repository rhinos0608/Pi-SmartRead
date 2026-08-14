# Tool Consolidation (Option A) + Contextual Nudges (Option C) Implementation Plan

> **For agentic workers:** Implement this plan task-by-task in order. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shrink the SmartRead tool surface from 8 core tools to 5 (`read`, `read_files`, `search`, `symbol`, `repo_map`) and inject contextual nudges at the moment of need so agents discover the deeper modes.

**Architecture:** `find_symbol` + `symbol_info` merge into one `symbol` tool with an `action` param (default `find`). `deep_search` becomes `depth: "deep"` on `search`. `intent_read` becomes an optional `query` param on `read_files`. The underlying engines (`deep-search.ts`, `intent-read.ts`) are unchanged — only the tool registration surface changes. Nudges: weak-result hints appended directly in tool output, plus an updated doom-loop suggestion table.

**Tech Stack:** TypeScript, TypeBox schemas, vitest, pi-coding-agent ToolDefinition contract.

## Global Constraints

- **DO NOT COMMIT.** The working tree contains ~5,000 lines of pre-existing uncommitted WIP touching the same files. All changes stay uncommitted; the user decides how to commit.
- Baseline is green: `npm run typecheck` clean, `npm test` 829/829 passing. Keep it green after every task.
- No backwards-compatibility shims: old tool names (`find_symbol`, `symbol_info`, `deep_search`, `intent_read`) are removed completely from registration, guidance text, and tests.
- `intent-read.ts`'s `createIntentReadTool` factory MUST survive (deep-search-semantic.ts:6 imports it for the semantic channel; read-many.ts will too).
- History note: `deep_search` was previously split OUT of search (deep-search-tool.ts:4-5) and unified-read was previously split into 3 tools (unified-read.ts:4-5). This plan folds back differently — optional params on generic-named tools, not mode-dispatch unions. Keep added schema surface minimal.

---

### Task 1: Merge `find_symbol` + `symbol_info` → `symbol`

**Files:**
- Modify: `find-symbol-tool.ts` (schemas at 19-40, tool defs at 873-935, registration at 942-955)
- Modify: `mcp-registry.ts` (no change to `registerFindSymbolTool()` call, but verify)
- Test: `test/unit/index.test.ts`, `test/unit/mcp-server.test.ts`, `test/unit/mcp-advanced.test.ts`

**Interfaces:**
- Produces: single tool `symbol` with schema `{ action?: "find"|"outline"|"declaration"|"references"|"implementations", query?, path?, directory?, include_body?, maxResults?, childDepth? }`. Action defaults to `"find"` so `{ query: "AuthService.login" }` behaves exactly like old `find_symbol`.
- Exports unchanged: `registerFindSymbolTool()` still registers, just one tool instead of two.

- [ ] **Step 1: Update test expectations first**

In `test/unit/index.test.ts` (~line 37-41) replace `expect(names).toContain("find_symbol")` / `"symbol_info"` with `expect(names).toContain("symbol")` and add `expect(names).not.toContain("find_symbol")`, `expect(names).not.toContain("symbol_info")`. Do the equivalent in `mcp-server.test.ts` and `mcp-advanced.test.ts` tool-list assertions.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/index.test.ts` — expected FAIL (registry still has old names).

- [ ] **Step 3: Replace the two schemas with one**

In `find-symbol-tool.ts` replace `FindSymbolSchema` + `SymbolInfoSchema` (lines 19-40) with:

```typescript
const SymbolSchema = Type.Object({
  query: Type.Optional(Type.String({ description: "Symbol name or pattern. Supports qualified paths like 'ClassName.methodName'. Required for every action except outline." })),
  action: Type.Optional(Type.Union([
    Type.Literal("find"),
    Type.Literal("outline"),
    Type.Literal("declaration"),
    Type.Literal("references"),
    Type.Literal("implementations"),
  ], { description: "find (default): locate candidate symbols by name via AST + LSP. outline: file structure. declaration: canonical definition. references: all usages. implementations: interface/class implementors.", default: "find" })),
  path: Type.Optional(Type.String({ description: "File path (required for outline; optional disambiguation context for declaration/references/implementations)." })),
  directory: Type.Optional(Type.String({ description: "Root directory to scope the search (default: extension working directory).", default: "." })),
  include_body: Type.Optional(Type.Boolean({ description: "Include symbol source body (find/declaration/implementations). Default: false." })),
  maxResults: Type.Optional(Type.Number({ description: "Max results (find/references/implementations, default: 30).", minimum: 1, maximum: 10000, default: 30 })),
  childDepth: Type.Optional(Type.Number({ description: "Child depth for outline (default: 0).", minimum: 0, maximum: 5, default: 0 })),
});
```

- [ ] **Step 4: Replace the two tool factories with one `createSymbolTool()`**

Delete `createFindSymbolSearchTool()` and `createSymbolInfoTool()` (lines 873-935); add:

```typescript
function createSymbolTool(): ToolDefinition {
  return toToolDefinition({
    name: "symbol",
    label: "symbol",
    description: "Navigate code symbols: find candidates by name (default), or get outline/declaration/references/implementations. E.g. { query: \"AuthService.login\" } to locate a symbol, { action: \"references\", query: \"AuthService.login\" } for usages, { action: \"outline\", path: \"src/auth.ts\" } for file structure. Prefer search for raw text or when the name is uncertain, and read/read_files for known paths.",
    parameters: SymbolSchema,

    async execute(_toolCallId: string, params: any, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
      if (signal?.aborted) throw new Error("Operation aborted");
      const startTime = Date.now();
      const root = resolveDirectory(params.directory, ctx.cwd);
      const action = (params.action as string | undefined) ?? "find";

      switch (action) {
        case "find": {
          if (!params.query) throw new Error('action "find" requires "query" parameter');
          const data = await handleSymbol(params.query, params.maxResults ?? 30, params.include_body ?? false, root, ctx.cwd, signal);
          let text = formatSymbolResult(data, params.query, startTime);
          if (data.total_found === 0) {
            text += `\n[hint] No symbols named "${params.query}". Try search { query: "${params.query}" } for text matches, or search { query: "...", depth: "deep" } if the name is uncertain.\n`;
          }
          return { content: [{ type: "text" as const, text }], details: data };
        }
        case "outline": {
          if (!params.path) throw new Error('action "outline" requires "path" parameter');
          const data = await handleOverview(params.path, params.childDepth ?? 0, root);
          return { content: [{ type: "text" as const, text: formatOverviewResult(data, startTime) }], details: data };
        }
        case "declaration": {
          if (!params.query) throw new Error('action "declaration" requires "query" parameter');
          const data = await handleDeclaration(params.query, params.path, params.include_body ?? false, root, ctx.cwd);
          return { content: [{ type: "text" as const, text: formatDeclarationResult(data, params.query, startTime) }], details: data };
        }
        case "references": {
          if (!params.query) throw new Error('action "references" requires "query" parameter');
          const data = await handleReferences(params.query, params.path, params.maxResults ?? 30, root, ctx.cwd);
          return { content: [{ type: "text" as const, text: formatReferencesResult(data, params.query, startTime) }], details: data };
        }
        case "implementations": {
          if (!params.query) throw new Error('action "implementations" requires "query" parameter');
          const data = await handleImplementations(params.query, params.path, params.include_body ?? false, params.maxResults ?? 30, root, ctx.cwd, signal);
          return { content: [{ type: "text" as const, text: formatImplementationsResult(data, params.query, startTime) }], details: data };
        }
        default:
          throw new Error(`Unknown action: ${action}. Use find, outline, declaration, references, or implementations.`);
      }
    },
  });
}
```

(The `[hint]` block in `find` is the Task 4 weak-result nudge — included here so this file is touched once.)

Update `registerFindSymbolTool()` to register only `createSymbolTool()`. Rename the exported function to `registerSymbolTool` and update the two import sites (`index.ts:8,30`, `mcp-registry.ts:13,31`).

- [ ] **Step 5: Typecheck + run the failing tests**

Run: `npm run typecheck && npx vitest run test/unit/index.test.ts test/unit/mcp-server.test.ts test/unit/mcp-advanced.test.ts` — expected PASS. (Cross-reference cleanup in other files lands in Task 5; nothing else imports the deleted factories directly.)

---

### Task 2: Fold `deep_search` into `search` as `depth: "deep"`

**Files:**
- Modify: `search-tool.ts` (schema ~line 40-70, execute ~line 1802-1876)
- Delete: `deep-search-tool.ts`
- Modify: `mcp-registry.ts` (remove line 43 `reg("deep_search", ...)` and the `createDeepSearchTool` import)
- Test: `test/unit/index.test.ts`, `test/unit/search-tool-schema.test.ts`, `test/unit/deep-search.test.ts`

**Interfaces:**
- Consumes: `executeDeepSearch(options, signal, ctx)` from `deep-search.ts` (unchanged engine).
- Produces: `search` schema gains `depth?: "quick" | "deep"` (default `"quick"`) and `scope?: "code" | "docs" | "tests" | "all"` (deep only). Old deep-only params (`limit`, `maxSnippetChars`, `outputBudget`, `includeRelationships`, `focusFiles`) are NOT exposed — deep mode uses `maxResults` for limit and engine defaults for the rest.

- [ ] **Step 1: Update tests first**

`test/unit/deep-search.test.ts`: tests that exercise `executeDeepSearch` directly stay untouched. Tests that construct the `deep_search` **tool** (grep for `createDeepSearchTool`) switch to `createSearchTool()` with `{ depth: "deep" }` input. `test/unit/index.test.ts:39` (`toContain("deep_search")`) becomes `not.toContain("deep_search")`; the bash-guard test at index.test.ts:56-81 that uses `toolName: "deep_search"` switches to `toolName: "search"` (guard profile merges in Task 5). `test/unit/search-tool-schema.test.ts`: add assertions that the schema enumerates `depth` values `["quick","deep"]`. `test/unit/mcp-server.test.ts:168` (`toContain("deep_search")`) becomes `not.toContain`; remove `deep_search` from the `guidedTools` array at mcp-server.test.ts:187.

- [ ] **Step 2: Run to verify failures**

Run: `npx vitest run test/unit/deep-search.test.ts test/unit/search-tool-schema.test.ts test/unit/index.test.ts` — expected FAIL.

- [ ] **Step 3: Add `depth`/`scope` to SearchSchema in search-tool.ts**

```typescript
depth: Type.Optional(
  Type.Union([Type.Literal("quick"), Type.Literal("deep")], {
    description: "quick (default): grep + AST code search. deep: fused structural, semantic, symbol, graph, and LSP channels with provenance — use for broad or uncertain questions, or when quick returned nothing.",
    default: "quick",
  }),
),
scope: Type.Optional(
  Type.Union([Type.Literal("code"), Type.Literal("docs"), Type.Literal("tests"), Type.Literal("all")], {
    description: "File scope for depth: \"deep\" (default: all).",
    default: "all",
  }),
),
```

- [ ] **Step 4: Add the deep branch at the top of search execute (after query validation)**

Port the body of deep-search-tool.ts's execute (executeDeepSearch call + sparse-cache match recording, lines 96-159) into a module-level helper `async function runDeepSearch(toolCallId, params, cwd, signal, ctx)` in `search-tool.ts`, mapping `limit: params.maxResults ?? 15` (the engine's `clampInteger` already clamps to 1-50), `depth: "standard"`, `scope: params.scope ?? "all"`. Then in execute:

```typescript
if (params.depth === "deep") {
  return runDeepSearch(toolCallId, params, cwd, signal, ctx);
}
```

Copy the `recordSparse`/`resolveSessionKey` usage verbatim from deep-search-tool.ts (both are already imported in search-tool.ts:31).

- [ ] **Step 5: Add the weak-result nudge to the quick path (Task 4/Option C)**

In the `parts.length === 0` branch of search execute (~line 1850), replace the bare no-matches line with:

```typescript
parts.push(`[No matches for "${query}" across ${files} files.]`);
parts.push(`[hint] Retry with depth: "deep" to engage semantic + symbol + graph channels, or symbol { query: "${query}" } if this is a known identifier.`);
```

- [ ] **Step 6: Delete deep-search-tool.ts, deregister, update description + in-body hints**

`rm deep-search-tool.ts`; remove import + `reg("deep_search", ...)` from mcp-registry.ts; update `search`'s description to absorb deep_search's job ("depth: \"deep\" for broad cross-file investigations with provenance") and drop the "use the dedicated deep_search tool" sentence and header comment (search-tool.ts:5-7).

**Also update the three existing in-body low-result hint strings** at search-tool.ts:677, 1506, 1766 — each currently reads `` `deep_search query="${query}"` for multi-channel semantic search + graph expansion. `` Replace with `` retry with depth: "deep" for multi-channel semantic search + graph expansion. `` These are agent-facing guidance inside handleGrep/handleCode/handleAstPattern.

Schema descriptions must state that `matchMode` and `contextLines` apply to quick depth only (the deep branch ignores them); do not throw on the combination — the retry-with-deep nudge must work regardless of prior params.

- [ ] **Step 7: Typecheck + tests**

Run: `npm run typecheck && npx vitest run test/unit/deep-search.test.ts test/unit/search-tool-schema.test.ts test/unit/search-tool-grep.test.ts test/unit/search-tool-boolean.test.ts test/unit/index.test.ts` — expected PASS.

---

### Task 3: Fold `intent_read` into `read_files` as `query` param

**Files:**
- Modify: `read-many.ts` (schema at 48-63, execute at 96+)
- Modify: `intent-read.ts` (description only — tool stays as internal engine)
- Modify: `mcp-registry.ts` (remove line 41 `reg("intent_read", ...)`)
- Modify: `unified-read.ts` (drop `createIntentReadTool` re-export)
- Test: `test/unit/read-many.test.ts`, `test/unit/intent-read.test.ts`

**Interfaces:**
- Consumes: `createIntentReadTool()` from `intent-read.ts` — read-many holds ONE lazily-created instance per `createReadManyTool()` closure so embedding caches persist across calls.
- Produces: `read_files` schema `{ files?, query?, directory?, topK?, stopOnError? }`. Rules: no `query` → `files` required, exact current behavior. With `query` → delegate wholesale to the intent_read execute with `defaultToCwd: true`.

- [ ] **Step 1: Update tests first**

`test/unit/read-many.test.ts`: add cases — (a) `{ query: "..." , files: [...] }` returns ranked/packed output (assert `details.files` present and success), (b) `{ }` with neither files nor query throws, (c) `{ directory: "." }` without query throws. `test/unit/intent-read.test.ts`: keep engine tests but any assertion on tool listing/registration of `intent_read` flips to absent; tests calling `createIntentReadTool().execute` directly stay. `test/unit/mcp-server.test.ts:163` (`toContain("intent_read")`) becomes `not.toContain`; remove `intent_read` from the `guidedTools` array at mcp-server.test.ts:187 (the loop at 188-192 asserts on `tool?.description` and would hit undefined).

- [ ] **Step 2: Run to verify failures**

Run: `npx vitest run test/unit/read-many.test.ts` — expected FAIL (unknown params rejected / files required).

- [ ] **Step 3: Extend ReadManySchema**

```typescript
const ReadManySchema = Type.Object({
  files: Type.Optional(Type.Array(
    Type.Object({
      path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
      offset: Type.Optional(Type.Number({ minimum: 1, description: "Line number to start reading from (1-indexed)" })),
      limit: Type.Optional(Type.Number({ minimum: 1, description: "Maximum number of lines to read" })),
    }),
    { minItems: 1, maxItems: 10000, description: "Files to read in the exact order listed (max 10000). Required unless query is set." },
  )),
  query: Type.Optional(Type.String({ description: "Natural-language intent. When set, candidate files (from files, directory, or cwd) are ranked by hybrid BM25 + semantic relevance and only the most relevant are packed. Use when you know the goal but not the exact files." })),
  directory: Type.Optional(Type.String({ description: "Directory to scan for candidates (only valid with query; default: cwd)." })),
  topK: Type.Optional(Type.Number({ minimum: 1, maximum: 100, description: "Max files to pack when query is set (default: 20)." })),
  stopOnError: Type.Optional(Type.Boolean({ description: "Stop on first error (default false)" })),
});
```

- [ ] **Step 4: Dispatch in execute**

At the top of `createReadManyTool`'s returned execute:

```typescript
if (params.query?.trim()) {
  if (!intentTool) intentTool = createIntentReadTool(readToolFactory);
  return intentTool.execute(toolCallId, {
    query: params.query,
    files: params.files,
    directory: params.directory,
    topK: params.topK,
    stopOnError: params.stopOnError,
    defaultToCwd: true,
  }, signal, _onUpdate, ctx);
}
if (params.directory || params.topK !== undefined) {
  throw new Error("directory/topK are only valid together with query");
}
if (!params.files || params.files.length === 0) {
  throw new Error("Provide files to read, or query to rank and read by intent");
}
```

with `let intentTool: ToolDefinition | undefined;` declared inside `createReadManyTool` before the return, and `import { createIntentReadTool } from "./intent-read.js";` added. Update the `read_files` description to mention the query mode and stop referencing `intent_read`. Also strip the `find_symbol/symbol_info/deep_search` cross-refs from the now-internal `intent_read` description (intent-read.ts:187).

- [ ] **Step 5: Deregister intent_read**

Remove `reg("intent_read", ...)` + import from mcp-registry.ts (line 14, 41); remove the re-export from unified-read.ts:19 (deep-search-semantic.ts imports from `./intent-read.js` directly — verify with grep, no other importer of the re-export besides mcp-registry).

- [ ] **Step 6: Packing nudge (Task 4/Option C)**

In read-many.ts where `ReadManyDetails.packing.omittedPaths` is populated for the non-query path, append to the rendered output when `omittedPaths.length > 0`:

```typescript
`[hint] ${omittedPaths.length} file(s) omitted by the output budget. Add query: "<your intent>" to rank files by relevance and pack the best ones instead.`
```

- [ ] **Step 7: Typecheck + tests**

Run: `npm run typecheck && npx vitest run test/unit/read-many.test.ts test/unit/intent-read.test.ts test/unit/deep-search.test.ts` — expected PASS.

---

### Task 4: Doom-loop suggestion table for the new surface

**Files:**
- Modify: `doom-loop-suggestions.ts` (whole SUGGESTIONS + SUGGESTIONS_LEGACY tables)
- Modify: `doom-loop.ts` (tool-name list at lines 147-156)
- Test: `test/unit/doom-loop.test.ts`

(The in-result weak-result nudges already landed inside Tasks 1-3 so each file is edited once.)

- [ ] **Step 1: Update doom-loop tests first**

`test/unit/doom-loop.test.ts`: rename tool keys in expectations (`find_symbol`/`symbol_info` → `symbol`, `deep_search` → gone, `intent_read` → gone); add expectation that `search` suggestions include a `depth` hint and `read_files` suggestions include a `query` hint.

- [ ] **Step 2: Verify failures**

Run: `npx vitest run test/unit/doom-loop.test.ts` — expected FAIL.

- [ ] **Step 3: Rewrite the suggestion tables**

```typescript
export const SUGGESTIONS: Record<string, readonly Suggestion[]> = {
  read: [
    str("if file is large, try offset + limit"),
    str("if file keeps being read identically, the content may already be what you expect"),
    { text: "if searching for a symbol, use symbol { query: \"name\" }", toolHint: "symbol" },
    { text: "use read_files with query: \"...\" to rank and read relevant files", toolHint: "read_files" },
    { text: "use repo_map to discover related files", toolHint: "repo_map" },
  ],
  read_files: [
    str("try reducing the number of files or use offset/limit to narrow focus"),
    { text: "add query: \"your intent\" to rank files by relevance instead of reading everything", toolHint: "read_files", toolInput: { query: "<describe what you are looking for>" } },
    { text: "use repo_map to discover related files", toolHint: "repo_map" },
  ],
  search: [
    str("try a more specific query"),
    str("try matchMode=literal if regex characters are accidental"),
    { text: "retry with depth: \"deep\" for fused semantic + symbol + graph search", toolHint: "search", toolInput: { depth: "deep" } },
    { text: "use symbol { query: \"name\" } if this is a known identifier", toolHint: "symbol" },
  ],
  symbol: [
    str("try a shorter or unqualified name (e.g. \"login\" instead of \"AuthService.login\")"),
    str("use action=outline for file structure, action=references for usages, action=implementations for subclasses"),
    { text: "try search with depth: \"deep\" when the symbol name is uncertain", toolHint: "search", toolInput: { depth: "deep" } },
  ],
  repo_map: [
    str("try compact: true for more token-efficient output"),
    str("use focus to boost relevant symbols or files"),
    str("use mapTokens to increase the token budget for larger repos"),
  ],
  graph_mutate: [
    str("verify the from/to paths exist"),
    str("use absolute paths for cross-directory edges"),
  ],
};
```

Mirror the same content string-only in `SUGGESTIONS_LEGACY`. Update the tool-name array in doom-loop.ts:147-156 (drop `intent_read`, `deep_search`, `find_symbol`, `symbol_info`; add `symbol`).

- [ ] **Step 4: Typecheck + tests**

Run: `npm run typecheck && npx vitest run test/unit/doom-loop.test.ts` — expected PASS.

---

### Task 5: Cross-reference sweep (guards, hygiene, guidance, docs)

**Files:**
- Modify: `index.ts:63-74` (SMARTREAD_GUARD_TOOLS set), `index.ts:389` (stale comment)
- Modify: `bash-context-guard.ts:37-41,220` (profiles + deep-search hint)
- Modify: `context-hygiene.ts:278-286` (switch cases)
- Modify: `context-application.ts:36-41` (tool list)
- Modify: `tool-guidance.ts:3-14` (tool guide lines)
- Modify: `hook.ts:571` (read tool description cross-refs)
- Modify: `repomap-tool.ts:76` (description cross-refs)
- Modify: `graph-mutate.ts:40` (description says "Prefer search/deep_search/repo_map")
- Modify: `deep-search.ts:290-528` (next-step hint strings; also line 512 `createDeepSearchTool` example)
- Modify: `mcp-server.ts:10-15` (header comment), `mcp-resources.ts:360` (comment), `README.md` (tool table lines 15-19, full `## intent_read` section at line 93, `## find_symbol` section at line 231, prose at 304/473/475)
- Test: `test/unit/bash-context-guard.test.ts`, `test/unit/context-application.test.ts`, `test/unit/hook.test.ts`, `test/unit/retrieval-benchmark.test.ts`, `test/unit/advanced-retrieval-baseline.test.ts`, `test/unit/mcp-advanced.test.ts:263-264` (guide-text `toContain("intent_read")`/`toContain("deep_search")` → assert new guide mentions `depth: "deep"` and `query`)

**Interfaces:** none new — mechanical rename/removal sweep.

- [ ] **Step 1: Guard + hygiene sets**

`index.ts` SMARTREAD_GUARD_TOOLS → `{"read","read_files","search","repo_map","symbol","git_notes_read"}`. `bash-context-guard.ts`: replace `intent_read`/`deep_search`/`find_symbol`/`symbol_info` profile keys with `symbol: { maxLines: 1500, maxBytes: 40*1024, headLines: 60, tailLines: 80 }` and raise `search` to `{ maxLines: 2500, maxBytes: 60*1024, headLines: 100, tailLines: 140 }` (search now carries deep output); line 220's deep_search hint keys off `toolName === "search"`. `context-hygiene.ts` cases: `intent_read`/`find_symbol`/`symbol_info` → `symbol` (keep `read`/`read_files`/`search` as-is; fold the `deep_search` case into `search`'s). `context-application.ts` list → `["read","read_files","search","symbol", ...]`. `doom-loop.ts` list already done in Task 4.

- [ ] **Step 2: Guidance + descriptions**

`tool-guidance.ts` TOOL_GUIDE_LINES:

```typescript
const TOOL_GUIDE_LINES = [
  "Use SmartRead tools by job:",
  "- read: exact file by path; use offset/limit for large files.",
  "- read_files: several known files in one call; add query: \"...\" to rank unknown files by intent.",
  "- search: exact text, identifiers, regex, AST patterns; depth: \"deep\" for broad questions with semantic + graph evidence.",
  "- symbol: known symbol names — find, outline, declaration, references, implementations.",
  "- repo_map: quick repository structure orientation; use focus for relevant files or symbols.",
  "Prefer narrow params. After code changes, re-run reads/searches that informed decisions.",
];
```

Sweep remaining description strings (`hook.ts:571`, `repomap-tool.ts:76`, `graph-mutate.ts:40`, `search-tool.ts` description, `read-many.ts` description — some already updated in Tasks 2-3) so no registered description mentions a removed tool. Update `deep-search.ts` next-step hints (lines 290, 293, 314, 317, 441, 442, 512, 526, 528): `find_symbol action=declaration query=X` → `symbol action=declaration query=X`, `find_symbol action=references query=X` → `symbol action=references query=X`, and line 526's `find_symbol action=symbol query=term` → `symbol query=term` (default action is find; there is no action=symbol). Line 512's `createDeepSearchTool` example → a still-existing symbol (e.g. `createSearchTool`). Update comments in mcp-server.ts/mcp-resources.ts, rewrite the README tool table and merge/remove the `## intent_read` and `## find_symbol` sections into the `read_files`/`symbol` docs.

- [ ] **Step 3: Fix remaining test files**

Update `test/unit/bash-context-guard.test.ts` (3 refs), `context-application.test.ts` (4), `hook.test.ts` (2), `retrieval-benchmark.test.ts` (1), `advanced-retrieval-baseline.test.ts` (1), `mcp-advanced.test.ts:263-264` to the new names. Grep to confirm zero remaining references (broad pattern, includes README):

Run: `grep -rn "find_symbol\|symbol_info\|deep_search\|intent_read" *.ts test/unit/*.ts README.md` — expected: zero hits except engine-internal identifiers/imports that contain no tool-name string in agent-facing text (file names like `deep-search.ts` use a hyphen and won't match). Manually justify any remaining hit.

- [ ] **Step 4: Full verification**

Run: `npm run typecheck && npm test` — expected: clean typecheck, all tests pass (same 54 files, count may change with added/removed cases).

---

## Review Loop Protocol

1. Reviewer subagent reviews this plan before implementation (fresh context, plan + repo access).
2. After all tasks: reviewer subagent reviews `git diff` scoped to this work, with the plan as acceptance criteria.
3. Fix findings, re-run `npm run typecheck && npm test`, re-review until the reviewer has no blocking findings.
