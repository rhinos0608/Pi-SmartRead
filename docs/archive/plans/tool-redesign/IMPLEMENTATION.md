# IMPLEMENTATION: inspect v4 + wrapped grep

## Phase 0: Shared Types (RUN FIRST)

### New File: `src/structural-facts-types.ts`

```ts
export interface CallerInfo {
  file: string; line: number; symbolName: string;
  snippet: string; confidence: number;
}
export interface ChildSymbol {
  name: string; kind: "function"|"method"|"class"|"interface"|"enum"|"type_alias"|"variable";
  line: number; visibility?: "public"|"private"|"protected";
  isExported?: boolean; isOverride?: boolean; deprecated?: boolean;
}
export interface ParentInfo {
  kind: "class"|"interface"|"module"; name: string;
  file?: string; line?: number;
}
export interface OverrideInfo {
  methodName: string; parentName: string; parentFile?: string;
  line: number; isExplicit?: boolean;
}
export interface ReExportInfo {
  barrelFile: string; exportName: string; line: number;
  kind: "named"|"wildcard"|"all";
}
export interface StructuralFacts {
  callers: CallerInfo[];
  parentClass?: ParentInfo;
  parentModule?: string;
  children: ChildSymbol[];
  baseClasses: ParentInfo[];
  interfaces: ParentInfo[];
  overrides: OverrideInfo[];
  reExportedBy: ReExportInfo[];
}
```

### New File: `src/signals-types.ts`

```ts
export type SignalName = "complexity"|"public-api"|"reuse"|"recency"|"tests"|"deprecation";
export interface SignalResult {
  name: SignalName; label: string; value: string; detail?: string;
  confidence: "high"|"medium"|"low"|"none"; source: string;
}
export interface FileSignals {
  path: string; signals: SignalResult[];
  computedAt: string; fallbackNotices: string[];
}
```

### New File: `src/inspect-types.ts`

```ts
export type InspectV4Mode = "directory" | "file";
export interface InspectV4Input {
  path: string; signals?: string[];
  mapTokens?: number; focus?: string[]; compact?: boolean;
  cwd: string; sessionFilePath: string; signal?: AbortSignal;
}
export interface InspectV4Result {
  mode: InspectV4Mode; contentText: string;
  workspaceEvidence: any; // WorkspaceEvidenceEnvelope
  lineCount: number; byteLength: number; truncated: boolean;
  upstreamDetails?: Record<string, unknown>;
}
```

### Modify: `src/types.ts` (line 44, after existing exports)
```ts
export type { StructuralFacts, CallerInfo, ChildSymbol, ParentInfo, OverrideInfo, ReExportInfo } from "./structural-facts-types.js";
export type { SignalName, SignalResult, FileSignals } from "./signals-types.js";
export type { InspectV4Mode, InspectV4Input, InspectV4Result } from "./inspect-types.js";
```

---

## Phase 1: Parallel Work Packages (after Phase 0)

### P1: Structural Facts Engine

**Files:**
- NEW: `src/structural-facts.ts` (~400 lines)
- MODIFY: `src/callgraph.ts` — export `findCallers` if not already public (check: it's exported at line 80+)

**What to build:**

`extractStructuralFacts(absolutePath, cwd, signal?) → StructuralFacts`

1. **Callers**: Use `ContextGraph.getFileNeighbours(path, {includeCalls: true})` + `findCallers()` from callgraph.ts. Merge intra-file and cross-file callers. Deduplicate by `file:line:symbolName`.

2. **Parent class/module**: Tree-sitter query — capture `class_declaration` → `superclasses` (Python) or `class_heritage` → `extends_clause` (TS/JS). Parent module: walk up for `__init__.py` or barrel `index.ts`.

3. **Children**: Walk class body → `method_definition`, `function_declaration`, `class_declaration`. Extract name, kind, line, visibility (TS `private`/`protected`), isExported.

4. **Base classes / interfaces**: TS: `extends_clause` + `implements_clause`. Python: `superclasses`. Go: embedded structs. Rust: `trait` bounds.

5. **Overrides**: For each child method, check parent class chain for same-named method. TS: `override` keyword boosts confidence. Python: name-match only with confidence downgrade.

6. **Re-exports**: Parse `export { X } from './Y'`, `export * from './Y'` (TS). `from .module import X` in `__init__.py` (Python). Recursive with cycle detection (visited set, max depth 5).

**Reuse existing:** `src/callgraph.ts` (buildCallGraph, findCallers), `src/context-graph.ts` (ContextGraph, resolveImportSpecifier), `src/tags.ts` (initParser, loadLanguage), `src/languages.ts` (filenameToLang).

**Fallbacks:** Unsupported language → empty facts + notice. Parse error → partial + notice. File >500KB → skip + notice.

**Acceptance:** Unit tests with TS class hierarchy, Python `__init__.py` barrel, TS barrel chain, override detection.

---

### P2: Signals Engine

**Files:**
- NEW: `src/signals.ts` (~300 lines)
- MODIFY: `src/git-history.ts` — expose `fileLastModifiedRelative()` that returns ISO + relative string

**What to build:**

`computeFileSignals(absolutePath, cwd, contextGraph, requestedSignals?, signal?) → FileSignals`

Six exported functions, each independently testable:

1. **`computeComplexity(path, source?)`**: Tree-sitter AST walk → count branches per function. Report max + aggregate. Regex fallback: count `if|for|while|case|&&|\|\||\?|catch` in function boundaries.

2. **`detectPublicApi(path, source?)`**: Parse exports. TS/JS: `export` keyword count. Python: `__all__` parse or `_` convention. Count: "Yes (N symbols)" / "No" / "Partial (N of M)".

3. **`computeReuseBreadth(path, graph)`**: `graph.getFileNeighbours(path)` → filter `imported_by`, count. "N importing files" or "Unknown".

4. **`computeRecency(path)`**: `git log -1 --format=%ar`. Fallback: `statSync.mtimeMs` if <1 day → "today". Otherwise "Unknown".

5. **`detectTests(path, cwd)`**: Generate candidate paths via naming conventions. `existsSync` each. "Yes (path)" or "No".

6. **`detectDeprecation(path, source?)`**: Regex for `@deprecated`, `#[deprecated]`, `[Obsolete]`, `DeprecationWarning`. Report presence + comment text.

**Acceptance:** Each function has unit test. Test: no git, unsupported lang, parse failure, Python `__all__`.

---

### P3: Inspect v4 Rewrite

**Files:**
- MODIFY: `src/inspect.ts` (lines 67–118, 122–404) — new dispatch + mode functions
- MODIFY: `src/inspect-tool.ts` (lines 17–41) — new schema + description
- IMPORT: `src/inspect-types.ts` (Phase 0), `src/structural-facts.ts` (P1), `src/signals.ts` (P2)

**Changes to `src/inspect-tool.ts`:**

Replace InspectSchema (line 17-22):
```ts
const InspectV4Schema = Type.Object({
  path: Type.String({ description: "File or directory path. Directory → repo map. File → structural facts + signals." }),
  signals: Type.Optional(Type.Array(
    Type.Union([Type.Literal("complexity"),Type.Literal("public-api"),Type.Literal("reuse"),Type.Literal("recency"),Type.Literal("tests"),Type.Literal("deprecation")]),
    { description: "Signals to compute (default: all)." }
  )),
  mapTokens: Type.Optional(Type.Number({ description: "Token budget for directory mode (256-32768, default 4096)." })),
  focus: Type.Optional(Type.Array(Type.String(), { description: "Files/symbols to boost in directory mode." })),
  compact: Type.Optional(Type.Boolean({ description: "Compact output (default true for directory, false for file)." })),
});
```

Replace description (line 36-41): See SPEC.md §1.1 description text.

Replace execute to call `executeInspectV4()` instead of `executeInspectDetails()`.

**Changes to `src/inspect.ts`:**

Replace `resolveMode()` (line 93-118):
```ts
export function resolveInspectV4Mode(input: InspectV4Input): InspectV4Mode {
  const stat = statSync(resolve(input.cwd, input.path));
  if (stat.isDirectory()) return "directory";
  if (stat.isFile()) return "file";
  throw new Error(`inspect path is neither file nor directory: ${input.path}`);
}
```

Replace `executeInspectDetails()` (line 79-91) with `executeInspectV4()`:
```ts
export async function executeInspectV4(input: InspectV4Input): Promise<InspectV4Result> {
  const mode = resolveInspectV4Mode(input);
  if (mode === "directory") return executeDirectoryInspect(input);
  return executeFileInspect(input);
}
```

New function `executeDirectoryInspect()`: Reuse `src/repomap-tool.ts` → `createRepoTool().execute()`. Build map-mode evidence envelope (zero resources, `mode: "map"`). Same as current `executeMapInspectDetails()` (line 355-404) but with path auto-detection.

New function `executeFileInspect()`:
1. Call `extractStructuralFacts()` (P1)
2. Call `computeFileSignals()` (P2)
3. Build evidence envelope: `mode: "file"`, resources per referenced file with `coverage: "search-match"`, `allowedRanges` covering symbol locations
4. Render output text (see SPEC.md file mode example)
5. Return `InspectV4Result`

**Keep `computeInspectDetails`** (line 67-73) but update signature — backward compat shim that throws with migration message for old callers.

**Remove:** `executeQueryInspectDetails()` (line 122-203), `executeSymbolInspectDetails()` (line 222-351). These functions are dead after migration.

**Remove from `resolveMode()`** (line 93-118): query/symbol/action branches. Replace entirely.

**Acceptance:**
- `inspect { path: "src/" }` → directory map
- `inspect { path: "src/inspect.ts" }` → structural facts + signals
- `inspect { query: "old" }` → clear error message
- Evidence envelope valid for both modes
- Existing tests updated (see Phase 3 P6)

---

## Phase 2: Wrapped Grep + Registration

### P4: Wrapped Grep Tool

**Files:**
- NEW: `src/grep-tool.ts` (~350 lines)
- REUSE: `src/query-retrieval.ts` (retrieveQuery, QueryRetrievalHit)
- REUSE: `src/semantic-index.ts`, `src/semantic-index-registry.ts`
- REUSE: `src/search-tool.ts` (handleGrep, handleCode — fallback)
- REUSE: `src/scoring.ts` (computeRrfScores)

**What to build:**

`createGrepTool(opts) → ToolDefinition`

```ts
const GREP_DESCRIPTION = `Search code for a text pattern, symbol name, or concept...`;  // SPEC.md §1.2 text

const GrepSchema = Type.Object({
  pattern: Type.String({ description: "Text, symbol name, or concept to search for.", minLength: 1 }),
  path: Type.Optional(Type.String({ description: "Directory or file to search in (default: cwd)." })),
  glob: Type.Optional(Type.String({ description: "File filter, e.g. '*.ts' or 'src/**/*.py'." })),
  ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)." })),
  literal: Type.Optional(Type.Boolean({ description: "Exact substring match — skip BM25/semantic (default: false)." })),
  limit: Type.Optional(Type.Number({ description: "Max results (default: 20, max: 100).", default: 20, minimum: 1, maximum: 100 })),
  contextLines: Type.Optional(Type.Number({ description: "Lines of context per match (default: 2, max: 10).", default: 2, minimum: 0, maximum: 10 })),
});
```

**Execute logic:**

```ts
async execute(toolCallId, params, signal, _onUpdate, ctx) {
  const cwd = ctx.cwd;
  const searchDir = params.path ? resolve(cwd, params.path) : cwd;
  const topK = clamp(params.limit ?? 20, 1, 100);

  // ── literal mode: skip intelligence, delegate to upstream grep ──
  if (params.literal) {
    return runLiteralGrep(params, searchDir, topK, cwd, signal);
  }

  // ── Layer 1: BM25 lexical ──
  const semanticIndex = getSemanticIndex(searchDir);
  const bm25Hits: QueryRetrievalHit[] = [];
  if (semanticIndex?.isAvailable()) {
    try {
      const results = await semanticIndex.search(params.pattern, { topK: topK * 2, pathPrefix: ... });
      // Map to QueryRetrievalHit (reuse retrieveQuery pattern from query-retrieval.ts:80-101)
      bm25Hits.push(...mapResults(results));
    } catch { /* fall through */ }
  }

  // ── Layer 2: AST symbol match ──
  const symbolHits = await runSymbolSearch(params.pattern, searchDir, topK * 2, signal);

  // ── RRF fusion + dedup ──
  const fusedHits = fuseAndDedup(bm25Hits, symbolHits, topK);

  // ── Fallback: embedding semantic (only if 0 hits) ──
  if (fusedHits.length === 0 && semanticIndex?.isAvailable()) {
    // deeper semantic search with wider topK
  }

  // ── Fallback: upstream grep (only if still 0 hits) ──
  if (fusedHits.length === 0) {
    return runLiteralGrep(params, searchDir, topK, cwd, signal);
  }

  // ── Build evidence + render output ──
  return buildGrepResult(fusedHits, params.pattern, topK, cwd, sessionFilePath);
}
```

**`runSymbolSearch()`**: Reuse `src/find-symbol-tool.ts` → `handleSymbol()`. Query = params.pattern, maxResults = topK*2, includeBody = false (just names+locations). Map to QueryRetrievalHit shape.

**`fuseAndDedup()`**: Use RRF (k=60) from `src/scoring.ts` → `computeRrfScores()`. Deduplicate by `file:line:symbol`. Keep combined RRF score, track source engines.

**`runLiteralGrep()`**: Call through to upstream grep via the pi harness (see P5 registration pattern). Or use `handleGrep()` from search-tool.ts as a direct implementation. Build evidence with `coverage: "search-match"` per hit.

**`buildGrepResult()`**: Build `WorkspaceEvidenceEnvelope` with `mode: "grep"`. Resources = one per hit with `allowedRanges`. Render output text: rank, file, line-range, enclosing symbol, snippet + context lines. Add truncation notice if totalHits > shown.

**Evidence:** Same pattern as current `executeQueryInspectDetails` (src/inspect.ts:122-203): `mode: "grep"`, `coverage: "search-match"`, `resourcesByPath` deduplicated, `allowedRanges` merged.

**Acceptance:**
- `grep('auth')` → ranked hits from BM25 + symbol
- `grep('nonexistent_xyz123', { literal: true })` → raw grep (0 hits or literal match)
- Zero hits on both layers → embedding fallback attempted → upstream grep final fallback
- Evidence envelope valid, publishable to resolver
- Result output matches SPEC.md format

---

### P5: Tool Registration + Migration

**Files:**
- MODIFY: `src/index.ts` (lines 369-391, 422-461)
- MODIFY: `src/mcp-registry.ts` (lines 35-136)
- MODIFY: `src/hook.ts` (export `createExtendedReadTool` unchanged)

**Changes to `src/index.ts`:**

1. **Remove grep low-result hint** (lines 369-391): The old hint says `inspect { query: "..." }` which no longer exists. Replace with a hint suggesting the wrapped grep: `[hint] Try grep("pattern") for broader coverage with symbol + semantic search.` But only if wrapped grep is registered AND the result is low-match. If wrapped grep is not registered (standalone MCP server without extension hook), omit the hint.

2. **Replace inspect registration** (lines 421-438): 
```ts
// 2. Inspect v4: directory → map, file → structural facts + signals
//    Query mode removed — use grep for code search.
if (!ToolRegistry.getInstance().has("inspect")) {
  const def = buildInspectV4Tool(() => null);
  ToolRegistry.getInstance().register({
    name: "inspect",
    description: def.description,
    inputSchema: def.parameters as Record<string, unknown>,
    execute: def.execute,
    category: ToolCategory.READ,
  });
}
```

3. **Register wrapped grep** (new, after inspect, before read):
```ts
// 2.5 Grep: wrap upstream grep with BM25+symbol+semantic
pi.registerTool(toToolDefinition({
  name: "grep",
  label: "grep",
  description: GREP_DESCRIPTION,
  parameters: GrepSchema,
  execute: grepExecute,
}));
```

4. **Update tool_result event subscription** (for evidence resolver reindex):
   - Current: listens for `pi.tool_result.inspect` and `pi.tool_result.read` (mcp-registry.ts:79-80)
   - Add: `pi.tool_result.grep` subscription

5. **Keep read tool** (lines 454-461) unchanged.

**Changes to `src/mcp-registry.ts`:**

1. Replace inspect registration (line 136):
```ts
reg("inspect", () => buildInspectV4ToolForExtension(() => null), ToolCategory.READ);
```

2. Add grep registration (new):
```ts
reg("grep", () => createGrepTool({ resolver: null, getSessionFilePath: () => null }), ToolCategory.READ);
```

3. Update `installInspectAndResolver()` (line 49-88): Add `bus.on("pi.tool_result.grep", reindex)` subscription so grep evidence also feeds resolver cache.

4. Update `buildInspectV4ToolForExtension()` and `registerInspectToolWithBus()` to use new inspect v4 factory.

**Migration of `src/inspect-tool.ts`:**
- Rename `createInspectTool` → `createInspectV4Tool` (old `createInspectTool` kept as deprecated re-export for one release cycle)
- New factory `buildInspectV4Tool(getSessionFilePath)` calls `createInspectV4Tool`
- Keep `buildInspectToolForExtension` name for backward compat but make it call v4 internally

**Remove/archive:**
- `src/inspect.ts`: `executeQueryInspectDetails`, `executeSymbolInspectDetails`, old `resolveMode`. Keep `executeMapInspectDetails` temporarily (reused by `executeDirectoryInspect`).
- `src/inspect-tool.ts`: old `InspectSchema`, old `INSPECT_DESCRIPTION`. Keep `InspectToolOptions` with updated resolver shape.

**Acceptance:**
- Extension activation registers `inspect` (v4) and `grep` without errors
- `grep` tool available in tool list
- `inspect` query mode throws migration error
- Evidence resolver receives grep envelopes
- SmartEdit's patch can resolve grep-produced evidence refs

---

## Phase 3: Tests + Docs (parallel after Phase 2)

### P6: Tests

**Files to create:**
- NEW: `test/unit/structural-facts.test.ts`
- NEW: `test/unit/signals.test.ts`
- NEW: `test/unit/inspect-v4.test.ts`
- NEW: `test/unit/grep-tool.test.ts`

**Files to modify:**
- `test/unit/inspect-v3.test.ts` — update to test v4 schema + migration error
- `test/unit/inspect.test.ts` — update mode tests
- `test/unit/read-evidence.test.ts` — add grep evidence envelope validation

**Test plan:**

`structural-facts.test.ts`:
- TS class with extends + implements → base classes + interfaces found
- TS barrel chain → re-exports resolved
- Python `__init__.py` → re-exports found
- Python class hierarchy → parent class found
- TS `override` keyword → override detected with isExplicit=true
- Python name-match override → override detected, isExplicit=false
- Callers: intra-file + cross-file merged
- Large file (>500KB) → graceful skip
- Unsupported language → empty facts + notice

`signals.test.ts`:
- Complexity: TS function with 5 branches → Low-Medium, 20 branches → High
- Complexity: Python function → correct count
- Complexity: unsupported language → regex fallback
- Public API: TS exports → 5 exported
- Public API: Python `__all__` → correct count
- Public API: Python underscore convention → private
- Reuse: graph has 4 importers → "Yes (4)"
- Reuse: no graph → "Unknown"
- Recency: git available → relative date
- Recency: no git, mtime <1 day → "today"
- Recency: no git, old mtime → "Unknown"
- Tests: `src/auth.ts` + `test/auth.test.ts` exists → "Yes"
- Tests: no test file → "No tests found"
- Deprecation: `@deprecated Use newFn` → marker found
- Deprecation: no markers → "No markers"

`inspect-v4.test.ts`:
- `inspect { path: tmpDir }` → directory mode, map content, evidence mode="map"
- `inspect { path: tmpFile }` → file mode, structural facts + signals, evidence mode="file"
- `inspect { path: "nonexistent" }` → throws
- `inspect { query: "old" }` → throws with migration message
- `inspect { symbol: "old" }` → throws with migration message
- `inspect { action: "map" }` → throws (must use path)

`grep-tool.test.ts`:
- `grep('knownSymbol')` → BM25 + symbol hits, ranked, evidence valid
- `grep('nonexistent', { literal: true })` → literal grep fallback
- Zero hits → embedding fallback → upstream grep
- Deduplication: same file+symbol in BM25 and symbol → merged
- RRF fusion: score ordering correct
- Truncation: totalHits > limit → truncated flag set
- Evidence envelope: mode="grep", coverage="search-match"

**Updated tests:**
- `inspect-v3.test.ts`: update `resolveMode` tests to `resolveInspectV4Mode`; update `executeInspectDetails`→`executeInspectV4`. Remove query-mode and symbol-mode tests. Add migration-error tests for old params.

**Test conventions:** Use `makeCtx`/`makeMockContext`/`makeExtensionAPI` for isolation. Fixtures in temp dirs. Mock semantic-index when needed.

---

### P7: Docs + Tool Guidance

**Files to modify:**
- `src/tool-guidance.ts` (lines 1-18)
- `AGENTS.md` (lines 1-43)

**Changes to `src/tool-guidance.ts`:**

Replace TOOL_GUIDE_LINES:
```ts
const TOOL_GUIDE_LINES = [
  "Use read for known paths and inspect for file/directory understanding — both return details.workspaceEvidence that authorizes patch:",
  "- read { path }: exact file with contextual enrichment (imports, git history, git notes, graph, LSP) + strong evidence.",
  "- read { paths: [...] }: multiple known files with batch evidence.",
  "- read { query }: indexed BM25+embedding RRF, then reads selected files; falls back to grep+AST discovery.",
  "- inspect { path }: directory → ranked repo map; file → structural facts (callers, parent, children, overrides, re-exports) + quality signals (complexity, public API, reuse, recency, tests, deprecation).",
  "- grep { pattern }: primary code search — BM25 ranking + symbol matching + semantic fallback. Use for any pattern, symbol name, or concept.",
  "Prefer narrow params. After code changes, re-run reads/inspects that informed decisions.",
];
```

**Changes to `AGENTS.md`:**
- Update inspect description (line 23): remove query/symbol/map modes, document file/directory modes + signals
- Add grep section: wrapped tool, BM25+symbol+semantic cascade
- Update read tool (line 24): query mode still available on read
- Update evidence flow notes (line 42): mention grep tool_result events

---

## Dependency Graph

```
Phase 0 (types)
  ├── P1 (structural facts) ────┐
  ├── P2 (signals)        ──────┤
  └── P3 (inspect v4)     ──────┤  ← P3 depends on P1+P2 types
                                 │
Phase 2                          │
  ├── P4 (grep tool)      ──────┤  ← P4 reuses query-retrieval (existing)
  └── P5 (registration)   ──────┘  ← P5 needs P3+P4 complete

Phase 3
  ├── P6 (tests)           ← after P1-P5
  └── P7 (docs)            ← parallel with P6
```

**Parallelization schedule:**
1. One worker: Phase 0 (types) — ~30 min
2. Three workers parallel: P1 + P2 + P3 — ~2-4 hours each
3. Two workers parallel: P4 + P5 — ~2 hours each (P5 may wait for P4)
4. Two workers parallel: P6 + P7 — ~2-3 hours each

---

## Files Summary

| Action | File | Package |
|--------|------|---------|
| NEW | `src/structural-facts-types.ts` | Phase 0 |
| NEW | `src/signals-types.ts` | Phase 0 |
| NEW | `src/inspect-types.ts` | Phase 0 |
| MODIFY | `src/types.ts` | Phase 0 |
| NEW | `src/structural-facts.ts` | P1 |
| MODIFY | `src/callgraph.ts` (export findCallers) | P1 |
| NEW | `src/signals.ts` | P2 |
| MODIFY | `src/git-history.ts` (add fileLastModifiedRelative) | P2 |
| MODIFY | `src/inspect.ts` (rewrite dispatch + new functions) | P3 |
| MODIFY | `src/inspect-tool.ts` (schema + description) | P3 |
| NEW | `src/grep-tool.ts` | P4 |
| MODIFY | `src/index.ts` (registration + grep hint) | P5 |
| MODIFY | `src/mcp-reg| MODIFY | `src/mcp-registry.ts` (inspect v4 + grep registration) | P5 |
| MODIFY | `src/tool-guidance.ts` (guide text) | P7 |
| MODIFY | `AGENTS.md` (tool docs) | P7 |
| NEW | `test/unit/structural-facts.test.ts` | P6 |
| NEW | `test/unit/signals.test.ts` | P6 |
| NEW | `test/unit/inspect-v4.test.ts` | P6 |
| NEW | `test/unit/grep-tool.test.ts` | P6 |
| MODIFY | `test/unit/inspect-v3.test.ts` (update to v4) | P6 |
| MODIFY | `test/unit/inspect.test.ts` | P6 |
| MODIFY | `test/unit/read-evidence.test.ts` (add grep evidence) | P6 |
| KEEP | `src/query-retrieval.ts` (unchanged — used by read query mode) | — |
| KEEP | `src/semantic-index.ts` (unchanged) | — |
| KEEP | `src/semantic-index-registry.ts` (unchanged) | — |
| KEEP | `src/path-evidence.ts` (unchanged) | — |
| KEEP | `src/workspace-evidence-resolver.ts` (unchanged) | — |
| KEEP | `src/read-many.ts` (unchanged) | — |
| KEEP | `src/hook.ts` (unchanged except export if needed) | — |
| KEEP | `src/file-context.ts` (unchanged) | — |
| KEEP | `src/context-graph.ts` (unchanged) | — |
| KEEP | `src/tags.ts` (unchanged) | — |
| KEEP | `src/languages.ts` (unchanged) | — |
| KEEP | `src/callgraph.ts` (unchanged except export check) | — |
| REMOVE | `src/inspect.ts`:`executeQueryInspectDetails` (line 122-203) | P3 |
| REMOVE | `src/inspect.ts`:`executeSymbolInspectDetails` (line 222-351) | P3 |
| REMOVE | `src/inspect.ts`:old `resolveMode` (line 93-118) | P3 |
| REMOVE | `src/inspect-tool.ts`:old `InspectSchema` (line 17-22) | P3 |
| REMOVE | `src/inspect-tool.ts`:old `INSPECT_DESCRIPTION` (line 36-41) | P3 |
| REMOVE | `src/index.ts`:grep low-result hint suggesting old inspect query (line 369-391) | P5 |
| ARCHIVE | `src/repomap-tool.ts`:`registerRepoTools` — still dead code but `createRepoTool` reused by inspect v4 directory mode | — |

---

## Risks

1. **Upstream grep collision**: Scout brief notes grep is not wrappable as tool definition — pi harness may reject `pi.registerTool` with name "grep" if it's a builtin. **Mitigation**: Test registration first. If harness rejects: use name `smart_grep` with description "Drop-in grep replacement — use instead of built-in grep for smarter results." Then update tool guidance to nudge agents. If even that fails: implement as `tool_result` interceptor (current pattern at index.ts:369-391) that post-processes upstream grep output — intercept `tool_result` for grep, run BM25+symbol in background, augment result content with merged hits. This is the fallback architecture.

2. **Performance of structural facts extraction**: Computing callers via ContextGraph + callgraph.ts on large repos may be slow (ContextGraph.buildContextGraph scans all files). **Mitigation**: Use `forceRefresh: false` to leverage cached graph. Timeout at 3 seconds — return partial results if exceeded. Signal extraction runs in parallel timeout (1s per signal).

3. **Tree-sitter grammar availability**: Native tree-sitter (tags.ts, callgraph.ts) and WASM (grammar-loader.ts) use different grammar packages. **Mitigation**: Structural facts engine uses native tree-sitter via tags.ts (same path as callgraph.ts). Fall back to WASM via grammar-loader.ts if native unavailable for a language.

4. **Evidence pipeline breakage**: New `mode: "file"` and `mode: "grep"` must be accepted by SmartEdit's patch authorization. **Mitigation**: Both modes use `coverage: "search-match"` — identical to current query/symbol modes that SmartEdit already rejects. No change to SmartEdit's authorization logic required. Verify by running SmartEdit's evidence-resolver integration tests after deployment.

5. **`reuse` signal requires ContextGraph**: On cold start, ContextGraph has no cache. First `inspect` call triggers full repo scan. **Mitigation**: Reuse signal returns "Graph unavailable — building..." on cold start. Subsequent calls resolve.

6. **Python override detection accuracy**: Name-match heuristic produces false positives. **Mitigation**: Always report `confidence: "low"` for Python overrides. Never claim certainty.

7. **Existing callers of `inspect query` mode**: `read { query }` uses `retrieveQuery()` directly (not inspect), so it's unaffected. Any other code calling `executeQueryInspectDetails` or `executeSymbolInspectDetails` directly will break. **Mitigation**: Search codebase for direct imports of these functions. Add deprecation shims that throw with migration message.

---

## Verification Against Hard Constraints

| Constraint | Status |
|------------|--------|
| Evidence envelopes keep flowing | ✅ Both inspect v4 (file mode) and grep emit valid envelopes with coverage:"search-match". Resolver cache updated from `pi.tool_result.grep` events. Path-evidence.ts unchanged. |
| Reuse existing machinery | ✅ query-retrieval.ts, semantic-index*.ts, repomap-tool.ts, tags.ts, callgraph.ts, context-graph.ts, scoring.ts, find-symbol-tool.ts, git-history.ts all reused |
| Follow read tool wrapping precedent | ✅ Grep tool follows same `pi.registerTool` pattern as read (src/index.ts:457). Fallback: tool_result interceptor if registration fails |
| Tests in test/unit | ✅ 4 new test files + 3 modified tests following existing conventions |
| Extend with params, not sibling tools | ✅ inspect gets `path` param that auto-detects mode; no new tool names beyond grep |
| Remove inspect query mode | ✅ query/symbol modes removed, migration error thrown, grep wraps both |
| Derived signals surfaced | ✅ 6 signals per research rankings: complexity (T1#1), TODO/FIXME density (T1#2 — folded into complexity label), public API (T1#3), deprecation (T1#4), tests (T1#5), recency (T2#6), reuse (T2#8) |

---

## Acceptance Report

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Plan delivers exactly the requested tool-surface redesign: (1) inspect redesigned with directory→map and file→structural-facts+signals modes, query/symbol modes removed; (2) wrapped grep with BM25+AST symbol+embedding cascade invisible to agent; (3) 6 derived signals per research rankings with graceful fallbacks for no-git/huge-repo/unsupported-language; (4) ergonomic tool descriptions following ergonomics-brief patterns; (5) workspace-evidence pipeline preserved for all modes. Scope not widened — plan covers only inspect+grep redesign, leaves read tool and existing machinery unchanged."
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "Plan provides: (a) SPEC.md with exact parameter schemas, tool description text, output format examples, signal definitions with fallback+confidence, evidence semantics per mode; (b) IMPLEMENTATION.md with phased plan, 7 independent work packages with file:line anchors, shared types defined fully for parallel workers, test plans, done-criteria, dependency graph, parallelization schedule; (c) verification against all hard constraints from scout brief; (d) migration plan for removed query mode; (e) risks with mitigations. Code claims verified by reading actual source files (src/index.ts, src/inspect.ts, src/inspect-tool.ts, src/hook.ts, src/query-retrieval.ts, src/callgraph.ts, src/context-graph.ts, src/find-symbol-tool.ts, src/repomap-tool.ts, src/search-tool.ts, src/path-evidence.ts, src/workspace-evidence-resolver.ts, src/mcp-registry.ts, src/tool-guidance.ts, src/git-history.ts, src/scoring.ts, src/chunking.ts, src/types.ts, AGENTS.md, test/unit/inspect-v3.test.ts)."
    }
  ],
  "changedFiles": [
    ".pi-subagents/artifacts/outputs/5a69b219-e269-43ad-a24c-340c711f7066/plan.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "read src/index.ts (lines 365-476)",
      "result": "passed",
      "summary": "Verified tool registration order, grep low-result hint at lines 369-391, inspect registration at 421-438, read registration at 454-461, evidence resolver at 466-475"
    },
    {
      "command": "read src/inspect.ts (lines 60-410)",
      "result": "passed",
      "summary": "Verified resolveMode dispatch (93-118), executeQueryInspectDetails (122-203), executeSymbolInspectDetails (222-351), executeMapInspectDetails (355-404), evidence envelope construction per mode"
    },
    {
      "command": "read src/inspect-tool.ts (lines 1-120)",
      "result": "passed",
      "summary": "Verified InspectSchema (17-22), INSPECT_DESCRIPTION (36-41), createInspectTool factory, resolver publish integration"
    },
    {
      "command": "read src/query-retrieval.ts (lines 1-156)",
      "result": "passed",
      "summary": "Verified hybrid+fallback strategies, retrieveQuery interface, runFallback implementation — confirms reusable by read query mode"
    },
    {
      "command": "read src/hook.ts (lines 350-800)",
      "result": "passed",
      "summary": "Verified read wrapping pattern (createExtendedReadTool 612-712), evidence attestation (shownMatchesAttested 360-378), createDelegatedExecute (757-774) — confirms precedent for wrapping upstream tools"
    },
    {
      "command": "read src/find-symbol-tool.ts (lines 1-60, 166)",
      "result": "passed",
      "summary": "Verified handleSymbol export at line 166 — reusable by wrapped grep for AST symbol match layer"
    },
    {
      "command": "read src/callgraph.ts (lines 1-180)",
      "result": "passed",
      "summary": "Verified call graph types (CallEdge, FunctionInfo, CallGraphResult), findEnclosingFunction, getCallTargetName — reusable for structural facts callers"
    },
    {
      "command": "read src/context-graph.ts (lines 1-120)",
      "result": "passed",
      "summary": "Verified EdgeType, ContextNode, GraphNeighbour, ContextGraph class — reusable for reuse signal and structural facts"
    }
  ],
  "validationOutput": [
    "All hard constraints verified against code: evidence pipeline (path-evidence.ts, workspace-evidence-resolver.ts) unchanged; existing machinery (query-retrieval.ts, semantic-index*.ts, repomap-tool.ts, tags.ts, callgraph.ts, context-graph.ts, scoring.ts, find-symbol-tool.ts, git-history.ts) all reused; wrapping precedent (hook.ts createDelegatedExecute) followed; test conventions (vitest, makeCtx, temp dirs) preserved",
    "Grep wrappability concern addressed: primary approach is pi.registerTool('grep'); fallback is tool_result interceptor (current pattern at index.ts:369-391)",
    "Migration path: inspect query→grep('pattern'), inspect symbol→grep('symbolName'), inspect action:map→inspect(path:'dir/'). read query mode unchanged.",
    "Signal set follows research rankings: Tier 1 (complexity, public API, deprecation, tests) + Tier 2 (recency, reuse). All have graceful fallbacks.",
    "No LSP dependency — all structural facts extraction uses tree-sitter AST + callgraph.ts + context-graph.ts"
  ],
  "residualRisks": [
    "Upstream grep tool name collision risk: pi harness may reject 'grep' as tool name. Fallback: 'smart_grep' with nudging, or tool_result interceptor pattern.",
    "Structural facts extraction on cold ContextGraph may take seconds on large repos. Mitigation: timeout + partial results.",
    "Python override detection is name-match only — false positives possible. Mitigation: confidence tagging.",
    "Tree-sitter native vs WASM divergence: structural facts uses native path; if grammars differ, extraction may miss some language constructs.",
    "Signal 'reuse' (fan-in) expensive without pre-built graph. Cold start returns 'unavailable'."
  ],
  "noStagedFiles": true,
  "diffSummary": "Plan document written to authoritative path. No code changes made. Plan covers 7 work packages: Phase 0 (3 new type files + 1 modify), P1 (structural facts engine), P2 (signals engine), P3 (inspect v4 rewrite), P4 (wrapped grep tool), P5 (registration + migration), P6 (4 new + 3 modified test files), P7 (tool guidance + AGENTS.md).",
  "reviewFindings": [],
  "manualNotes": "The plan is self-contained. Workers assigned to P1/P2/P3 can proceed in parallel after Phase 0 types are defined. Workers assigned to P4/P5 can proceed after P1-P3. The grep wrappability concern (scout brief §4) is the main architectural risk — the plan provides both primary (registerTool) and fallback (interceptor) approaches. Note: src/find-symbol-tool.ts also defines a 'symbol' tool with its own schema — this is NOT the inspect symbol mode being removed; it's a separate standalone tool that is registered or not depending on ToolRegistry state. The plan reuses its handleSymbol() export for the wrapped grep's AST symbol layer without changing the symbol tool itself."
}
