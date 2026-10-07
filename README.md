# Pi-SmartRead

Code intelligence for [Pi](https://github.com/mariozechner/pi-coding-agent): evidence-bearing reads, hybrid code search, structural inspection, repository intelligence, bounded multi-hop investigation, and strict read-only LSP access.

Pi-SmartRead is both:

- a **Pi extension** with the full model-facing surface, including wrapped `read` and strict `LSP`;
- a **standalone MCP stdio server** exposing the shared discovery tools, prompts, and `smartread://` resources.

It began as a fork of `pi-read-many` and has since become a broader local code-intelligence runtime.

## Install

Requirements: Node.js 20+ and Pi `^0.70.2`.

```bash
pi install github:rhinos0608/Pi-SmartRead
```

If Pi is already running:

```text
/reload
```

For a local checkout:

```bash
git clone https://github.com/rhinos0608/Pi-SmartRead.git
cd Pi-SmartRead
npm ci
pi -e ./src/index.ts
```

## Surface at a glance

| Surface | Pi extension | MCP server | Purpose |
|---|---:|---:|---|
| `read` | ✓ | — | Strong-evidence file, batch, intent, and symbol reads |
| `inspect` | ✓ | ✓ | File/directory analysis, LSP navigation, bounded script composition |
| `grep` | ✓ | ✓ | Text, symbol, semantic, structural, and graph-filtered code search |
| `LSP` | ✓ | — | Strict read-only Language Server Protocol operations |
| `skill` | ✓ | ✓ | Discover and read procedural agent skills |
| `graph_mutate` | opt-in | opt-in | Persist observed breakage/co-change edges |
| `git_notes_read/write` | opt-in | opt-in | Git-backed durable AI notes |
| MCP prompts/resources | — | ✓ | Prompt templates and repository/status/config resources |

The Pi extension also installs runtime hooks for context hygiene, repo-map/tool guidance injection, file watching, doom-loop detection, bash-output guarding, evidence publication, and SmartEdit RPC services.

## Which tool should I use?

- **Know the file?** Use `read`.
- **Know a literal/string/symbol/concept?** Use `grep`.
- **Need structure or architecture?** Use `inspect` in `file` or `directory` mode.
- **Need semantic navigation or diagnostics?** Use strict `LSP`, or `inspect` `navigate` when you want navigation folded into inspect output.
- **Need a dependent multi-hop chase?** Use `inspect { mode: "script", ... }`.
- **Need a reusable workflow?** Search/read a `skill`.

A critical distinction: `read` is the strong-evidence surface. Search/inspect results are discovery evidence and normally need a follow-up read before mutation.

---

## `read`

Pi-SmartRead replaces Pi's built-in read tool with an evidence-emitting, context-enriched wrapper.

Exactly one selector is allowed per call.

### Single file

```json
{"path":"src/auth.ts"}
```

Or a specific line range:

```json
{"path":"src/auth.ts","offset":120,"limit":80}
```

`offset` is 1-based.

### Multiple known files

```json
{
  "paths":[
    {"path":"src/auth.ts"},
    {"path":"src/session.ts","offset":40,"limit":90}
  ],
  "stopOnError":false
}
```

Up to 100 file entries are accepted. Batch evidence covers only complete rendered blocks; omitted or partial packed blocks do not gain edit authority.

### Intent/query read

```json
{"query":"authentication request flow","directory":"src","topK":12}
```

The indexed path ranks the corpus with lexical and semantic channels, fuses ranks, optionally applies ADR/structural/reranker signals, then reads the selected files. When the semantic index is unavailable it degrades to lexical/structural candidate discovery.

### Symbol read

```json
{"symbol":"AuthService.login","limit":120}
```

Qualified symbols resolve via LSP first and the context graph as fallback, then the source is read through the same evidence-producing path.

### Large-file AST outline

An unbounded single-file read of a supported source file above the configured threshold defaults to a compact structural outline instead of flooding context with the whole body.

The outline contains declarations, signatures, nesting, and line ranges. Its evidence covers only the rendered declaration ranges. Use `offset`/`limit` or a symbol read for the implementation body.

Environment controls:

- `PI_SMARTREAD_AST_OUTLINE=0` disables this behavior.
- `PI_SMARTREAD_AST_OUTLINE_BYTES` changes the default 20 KB threshold.

### Read enrichment

Reads can append non-authoritative context such as imports, git recency/history, git notes, graph knowledge, and language-server context. Evidence still describes the rendered source content, not the enrichment footer.

---

## `grep`

`grep` is the primary code-search surface.

### One query

```json
{"pattern":"handleAuth","path":"src"}
```

### Batch queries

```json
{
  "path":"src",
  "queries":[
    {"pattern":"handleAuth"},
    {"pattern":"DATABASE_URL","literal":true}
  ],
  "perQueryLimit":20,
  "maxResults":80
}
```

Provide exactly one of `pattern` or `queries`. Batch mode accepts 1-10 query objects.

### Matching behavior

By default, a normal-looking pattern is treated as a literal substring. Common regex syntax triggers regex interpretation. A bare `.` is not enough to make the pattern regex.

Set `literal: true` to force deterministic substring matching and skip hybrid semantic expansion.

Without `literal: true`, the cascade combines:

1. exact-text priority matches;
2. lexical BM25-style ranking;
3. AST/symbol matching;
4. reciprocal-rank fusion and deduplication;
5. embedding fallback when the semantic index is available and fused search is empty.

### Options

| Field | Meaning |
|---|---|
| `path` | Directory or file scope; defaults to cwd |
| `glob` | File filter such as `src/**/*.ts` |
| `ignoreCase` | Case-insensitive text matching |
| `literal` | Force exact substring path |
| `perQueryLimit` | Per-query cap, default 20, max 50 |
| `limit` | Deprecated per-query alias |
| `maxResults` | Merged render cap, default 100, max 200 |
| `contextLines` | Context around each hit, 0-20 |
| `graphFilter` | Relationship filter such as `CALLS->auth.login` |
| `structural` | ast-grep options: `language`, `skip`, `groupByFile` |
| `skip` | Structural pagination shortcut |

Every rendered hit gets search-match evidence, not full-file evidence.

---

## `inspect`

`inspect` has **four explicit modes**. The mode is required and is not inferred from the path.

### File mode

```json
{
  "mode":"file",
  "path":"src/inspect/inspect.ts",
  "analysis":{
    "signals":["complexity","tests","reuse"],
    "callDepth":2,
    "callDirection":"both",
    "impact":true,
    "hotspots":true
  }
}
```

File mode can return structural facts such as dependencies/dependents, callers, parent/children, inheritance/implementation relationships, overrides, re-exports, and quality signals.

Optional analysis fields include:

- `signals`
- `compact`
- `callDepth` and `callDirection`
- `deadCode`
- `impact`
- `diff: "unstaged" | "staged" | "HEAD"`
- `graphSchema`
- `hotspots`
- `routes`

### Directory mode

```json
{
  "mode":"directory",
  "path":"src",
  "analysis":{
    "mapTokens":6000,
    "clusters":true,
    "layers":true,
    "boundaries":true,
    "routes":true
  }
}
```

Directory mode builds a ranked repository map and can add architecture views such as communities, inferred layers, service boundaries, routes, hotspots, graph schema, and dead-code observations.

Directory-specific fields include `mapTokens`, `focus`, `clusters`, `layers`, and `boundaries`, plus several shared analysis flags.

### Navigate mode

```json
{
  "mode":"navigate",
  "path":"src/auth.ts",
  "navigation":{
    "operation":"definition",
    "line":42,
    "character":10
  },
  "diagnostics":{"waitMs":1200,"maxPerFile":12}
}
```

Navigate mode uses the inspect navigation adapter. Supported navigation operations include:

`definition`, `references`, `implementation`, `hover`, `documentSymbols`, `workspaceSymbols`, `prepareCallHierarchy`, `incomingCalls`, and `outgoingCalls`.

**Inspect-navigation coordinates are 1-based.** This differs from the strict `LSP` tool below.

### Script mode

```json
{
  "mode":"script",
  "script":"const g = await grep(\"handleAuth\", { literal: true }); const r = await read(\"src/auth.ts\"); return { hits: g.totalHits, lines: r.totalLines };"
}
```

Script mode runs a bounded read-only JavaScript program in QuickJS so dependent retrieval steps can happen inside one tool call.

Host API:

- `grep(pattern, opts)`
- `read(path, opts)`
- `inspectFile(path, opts)`
- `inspectDir(path, opts)`
- `lsp.definition/references/implementation/hover/documentSymbols/workspaceSymbols/prepareCallHierarchy/incomingCalls/outgoingCalls`
- `graph.impact/deadCode/callGraph/hotspots/routes/diff/clusters/layers/boundaries`

There is no edit/write/patch/eval escape hatch.

Default budgets are 50 total host calls, 10 LSP calls, 5 concurrent calls, about 5 seconds wall time, 200 KB per call/final result, and 1 MB total returned bytes. Over-budget/timeout execution returns a degraded result with an audit log and any successfully accumulated evidence.

The script-mode `lsp.*` namespace follows the inspect-navigation coordinate contract, not the strict `LSP` tool contract.

---

## Strict `LSP` tool

The Pi extension exposes one model-facing strict language-server tool named **`LSP`**.

```json
{
  "operation":"goToDefinition",
  "path":"src/auth.ts",
  "position":{"line":41,"character":9}
}
```

Strict LSP positions are **0-based** in the server's negotiated encoding, which is returned in `server.positionEncoding`.

### Operation families

**Navigation**

- `goToDefinition`
- `goToDeclaration`
- `goToTypeDefinition`
- `goToImplementation`
- `findReferences`
- `hover`
- `documentHighlights`
- `documentSymbols`
- `workspaceSymbols`

**Hierarchy**

- `prepareCallHierarchy`
- `incomingCalls`
- `outgoingCalls`
- `prepareTypeHierarchy`
- `supertypes`
- `subtypes`

**Diagnostics/session**

- `diagnostics`
- `workspaceDiagnostics`
- `publishedDiagnostics`
- `capabilities`
- `sessionStatus`

**Proposal operations**

- `prepareRename`
- `rename`
- `codeActions`
- `resolveCodeAction`
- `formatDocument`
- `formatRange`
- `formatOnType`

**Editor semantics**

- `completion`
- `resolveCompletion`
- `signatureHelp`
- `inlayHints`
- `resolveInlayHint`
- `semanticTokens`
- `foldingRanges`
- `selectionRanges`

**Escape hatch**

- `request` for explicitly allowlisted observational raw LSP methods.

The strict request validator rejects unknown operations, foreign fields, invalid positions/ranges, and missing operation-specific fields.

### Strict envelope

Every successful dispatch returns a provenance-bearing envelope with:

- `status`: `ok | empty | unsupported | unavailable | not_ready | timeout | cancelled | error | ambiguous`
- `operation` and wire `method`
- `server`: descriptor id, name, language id, project root, position encoding
- `result`
- `meta`: freshness, readiness, document version, truncation, cursor
- optional structured `error`

An exact `server` field routes to that descriptor id only. Unroutable requests return `unavailable`; SmartRead does not silently guess another server.

### Proposal-only mutation boundary

Rename, code-action, and formatting operations return proposals. They never write files.

Unsolicited `workspace/applyEdit` is rejected, and raw `workspace/executeCommand` / `workspace/applyEdit` calls are fail-closed.

SmartEdit is the mutation owner. See [docs/lsp-smartedit-contract.md](docs/lsp-smartedit-contract.md).

---

## `skill`

The `skill` tool lists, searches, and reads reusable procedural instructions.

```json
{"action":"search","query":"safe rename"}
```

Or:

```json
{"name":"lsp-rename"}
```

Discovery includes:

- `~/.pi/agent/skills`
- `~/.agents/skills`
- ancestor `.pi/skills`
- ancestor `.agents/skills`
- ancestor/package `skills/`
- `package.json -> pi.skills`
- configured paths from Pi settings

Skills with `disable-model-invocation: true` are hidden unless explicitly requested with `includeHidden`.

The repository ships:

| Skill | Purpose |
|---|---|
| `inspect-script-mode` | Multi-hop read-only composition |
| `lsp-explore` | Symbols, definition, hover |
| `lsp-impact` | References, implementations, call hierarchy |
| `lsp-local-symbols` | Document outline before targeted reads |
| `lsp-rename` | Fresh semantic rename proposal |
| `lsp-safe-refactor` | Code-action/refactor proposal triage |
| `lsp-fix` | Diagnostics to code-action proposal |
| `lsp-cross-root` | Explicit workspace/server routing |
| `lsp-verify` | Post-edit semantic verification |

Validate repository skills with:

```bash
node scripts/validate-skills.mjs
```

---

## Experimental tools

Experimental tools register only when enabled in `pi-smartread.config.json`.

### `graph_mutate`

Records durable semantic coupling observations such as:

- `breakage`: editing A caused failure in B;
- `co-change`: A and B are known to move together.

```json
{
  "from":"src/types/user.ts",
  "to":"src/services/auth.ts",
  "relation":"breakage",
  "context":"renamed User.id",
  "confidence":0.9
}
```

### Git notes

`git_notes_read` and `git_notes_write` store durable AI context on git commits/branches. They are intended for decisions, constraints, rejected approaches, and continuation context, not as a replacement for normal git history.

Enable both families independently:

```json
{
  "experimental":{
    "graphMutate":true,
    "gitNotes":true
  }
}
```

---

## Workspace evidence and SmartEdit

Pi-SmartRead produces versioned `WorkspaceEvidenceEnvelope` objects from `@rhinos0608/pi-workspace-protocol`.

The important semantics are:

- complete source reads can provide strong file/range evidence;
- partial reads authorize only rendered ranges;
- AST outlines authorize rendered declaration lines;
- grep and inspect results are discovery/search-match evidence;
- directory maps do not authorize arbitrary file edits;
- canonical evidence paths use real paths with symlinks resolved;
- tool-result `details.workspaceEvidence` is the durable source of truth;
- the resolver cache is rebuilt from tool-result events and serves SmartEdit over RPC.

Direct file reads are intentionally not gated by `PI_SMARTREAD_ALLOWED_ROOT`. That variable scopes automatic semantic indexing/retrieval, not direct tool access.

The shared protocol package is pinned in `package.json`; code should use the imported protocol schema/version constants rather than hardcoding a schema number.

---

## Language intelligence runtime

Pi-SmartRead owns language-server processes and routes requests through a strict executor.

### Server resolution

For a file, the resolver tries:

1. explicit user override;
2. project-local binary, only for a trusted project root;
3. system/PATH binary;
4. Pi-managed binary;
5. degraded/unavailable result.

No server process is spawned merely to probe PATH.

### Built-in descriptor catalog

Current descriptors include TypeScript/JavaScript, Python, Rust, Go, C/C++, C#, Java, PHP, Bash, JSON, YAML, HTML, CSS, Lua, and Ruby servers.

Managed npm installs are available for:

| Descriptor | Managed package |
|---|---|
| `typescript` | `typescript-language-server@6.0.0` |
| `python` | `pyright@1.1.413` |
| `bash-language-server` | `bash-language-server@5.6.0` |
| `vscode-json-language-server` | `vscode-langservers-extracted@4.10.0` |
| `yaml-language-server` | `yaml-language-server@1.24.0` |
| `vscode-html-language-server` | `vscode-langservers-extracted@4.10.0` |
| `vscode-css-language-server` | `vscode-langservers-extracted@4.10.0` |

Other catalog entries resolve from project-local or system installations.

### Trust and managed installs

Project-local executables run only from trusted roots.

Trust store:

```text
~/.pi/agent/language-intelligence/trust.json
```

Managed runtime:

```text
~/.pi/agent/language-intelligence/
  packages/
  bin/
  locks/
  logs/
  runtime.lock.json
```

Managed installs use exact package versions, `--ignore-scripts`, atomic swaps, integrity checks, and cross-process locking.

### Operator command: `/lsp`

The slash command is lowercase even though the model-facing tool is uppercase `LSP`.

| Command | Purpose |
|---|---|
| `/lsp status` | Language/server resolution summary |
| `/lsp doctor [lang]` | Detailed resolution diagnosis |
| `/lsp trust [path]` | Trust a project root for project-local binaries |
| `/lsp restart [server]` | Evict/restart the current root manager |
| `/lsp install <server>` | Install one managed server |
| `/lsp install auto` | Enable auto-install and install missing managed candidates |
| `/lsp update <server>` | Reinstall the pinned managed version |
| `/lsp update --all` | Update installed managed servers |
| `/lsp uninstall <server>` | Remove a managed server |

Configuration is stored under `~/.pi/agent/language-intelligence.json`.

### SmartEdit RPC provider

Pi-SmartRead also exposes the SmartEdit-facing language-intelligence RPC channel. It provides capabilities, post-edit diagnostics, rename preview, organize imports, formatting, and code-action proposals.

The RPC proposal path validates WorkspaceEdits and currently fails closed unless proposal coordinates are UTF-16 compatible. Direct strict `LSP` calls still expose the negotiated server encoding.

See:

- [docs/lsp-conformance.md](docs/lsp-conformance.md)
- [docs/lsp-smartedit-contract.md](docs/lsp-smartedit-contract.md)

---

## Retrieval and repository intelligence

### Semantic index

When embedding configuration is available, SmartRead maintains an ignore-aware persistent semantic index under `.pi-smartread/`, with:

- incremental file state;
- embedding/config/model fingerprinting;
- persistent vector storage;
- file-hash tracking;
- coverage diagnostics;
- deleted-file cleanup;
- retry on failed embeddings.

Without embeddings, retrieval degrades to lexical/structural paths rather than hard-failing.

### Context graph

The context graph combines static structure and persisted observations for graph-aware retrieval and analysis.

Graph-backed features include:

- centrality and PageRank;
- import/call relationships;
- community detection;
- impact analysis;
- hotspots;
- route extraction;
- persisted breakage/co-change edges;
- graph filters in grep.

### Repository intelligence

`src/repository/` adds workspace snapshots, semantic deltas, ADR storage, lineage, relationship evidence, ranking signals, and snapshot retention.

MCP resources expose several of these repository views directly.

---

## Configuration

`pi-smartread.config.json` is discovered by walking upward from the current directory.

### Safe minimal config

```json
{
  "model":"nomic-embed-text",
  "chunkSizeChars":4096,
  "chunkOverlapChars":512,
  "maxChunksPerFile":12,
  "probeEnabled":false,
  "rerankEnabled":false,
  "hydeEnabled":false
}
```

Network endpoints and API keys are intentionally **not trusted from repository config**.

Set embedding connectivity in the environment:

```bash
export PI_SMARTREAD_EMBEDDING_BASE_URL="http://localhost:11434/v1"
export PI_SMARTREAD_EMBEDDING_MODEL="nomic-embed-text"
# optional
export PI_SMARTREAD_EMBEDDING_API_KEY="..."
```

Public non-local endpoints must use HTTPS.

### Embedding knobs

| Config/env | Meaning |
|---|---|
| `model` / `PI_SMARTREAD_EMBEDDING_MODEL` | Embedding model |
| `PI_SMARTREAD_EMBEDDING_BASE_URL` | Trusted endpoint, env only |
| `PI_SMARTREAD_EMBEDDING_API_KEY` | API key, env only |
| `chunkSizeChars` / `PI_SMARTREAD_CHUNK_SIZE` | Target chunk size |
| `chunkOverlapChars` / `PI_SMARTREAD_CHUNK_OVERLAP` | Chunk overlap |
| `maxChunksPerFile` / `PI_SMARTREAD_MAX_CHUNKS` | Chunk cap per file |
| `probeEnabled` | Symbol/query probing |
| `hydeEnabled` | Deterministic HyDE expansion |
| `rerankEnabled` | Enable reranking stage |

Legacy `EMBEDDING_BASE_URL` and `EMBEDDING_MODEL` are accepted as fallbacks.

### External reranker

When `rerankEnabled` is true and `PI_SMARTREAD_RERANKER_BASE_URL` is set, the ranking stage calls the external reranker. If the call fails, it falls back to the structural reranker.

Repository config may provide non-network settings:

```json
{
  "rerankEnabled":true,
  "externalReranker":{
    "model":"rerank-english-v3.0",
    "timeoutMs":10000,
    "maxDocuments":20
  }
}
```

Endpoint and secret stay in the environment:

```bash
export PI_SMARTREAD_RERANKER_BASE_URL="https://reranker.example/v1"
export PI_SMARTREAD_RERANKER_API_KEY="..."
```

### Git context

Git enrichment is enabled by default. Example:

```json
{
  "gitContext":{
    "enabled":true,
    "readEnrichmentCommits":3,
    "coCommitMinCorrelation":0.15,
    "tokenBudget":{
      "gitLog":800,
      "coCommitHotspots":400,
      "gitNotes":600
    }
  }
}
```

### File watching

The default watcher favors descriptor-safe polling. Relevant environment controls include:

```bash
FILE_WATCHER_POLL_INTERVAL_MS=1000
FILE_WATCHER_MODE=non-recursive
FILE_WATCHER_MAX_COUNT=16
```

Native/chokidar modes can use more file descriptors. Generated dependency/build/cache/subagent trees are excluded.

### Retrieval scope

`PI_SMARTREAD_ALLOWED_ROOT` (legacy alias `CBM_ALLOWED_ROOT`) limits automatic semantic-index/retrieval scope. It is not a direct-read authorization boundary.

---

## Cross-cutting runtime behavior

### Context hygiene

SmartRead records read context and observes mutations. Reads that became stale can be marked/replaced so the model does not silently reason from pre-edit source.

### Doom-loop detection

Repeated identical retrieval calls are detected and surfaced with tool-specific suggestions.

### Bash context guard

Oversized shell output is bounded to a useful preview; full output can be redirected to temporary storage rather than consuming the model context window.

### Bash misuse hints

Bash misuse hints are on by default. They are hint-only advisories and never block bash. Opt out via `"experimental":{"bashMisuseHints":false}` in `pi-smartread.config.json` or `PI_SMARTREAD_BASH_MISUSE_HINTS=0` (explicit `0`/`1` overrides config).

### Startup context

The extension starts asynchronous repository/index work and can inject a compact repo map plus tool-selection guidance at the beginning of a session.

### Microagents

SmartRead can load markdown microagents from project locations such as `.pi-smartread/microagents/` and `.openhands/microagents/`, with trigger-based or always-loaded instructions.

---

## MCP server

Run:

```bash
npm run mcp-server
```

The server uses stdio and the official MCP SDK.

### MCP tools

By default:

- `inspect`
- `grep`
- `skill`

Enabled experimental registry tools are also exposed.

The standalone server intentionally does not expose the Pi-wrapped `read` or Pi-registered strict `LSP` tool.

### MCP resources

| URI | Content |
|---|---|
| `smartread://config` | Resolved config with secrets redacted |
| `smartread://repo-map` | Generated compact repository symbol map |
| `smartread://status` | Version, tool count, capability flags |
| `smartread://repo/stats` | File/language statistics |
| `smartread://repo/graph/summary` | Graph counts and coverage |
| `smartread://repo/graph/communities` | Architectural communities |
| `smartread://repo/graph/god-nodes` | Highest-centrality graph nodes |
| `smartread://repo/index/status` | Graph/index/snapshot status |
| `smartread://repo/index/coverage` | Index coverage records |
| `smartread://repo/adrs` | Stored ADR records |
| `smartread://repo/near-clones` | Near-clone report |

### MCP prompts

- `explain-code`
- `review-diff`
- `architectural-analysis`
- `smartread-tool-guide`

See [docs/mcp-quickstart.md](docs/mcp-quickstart.md) for client configuration examples.

---

## Language support

Repository mapping and structural parsing cover a broad multi-language extension map, including TypeScript/JavaScript, Python, Go, Rust, C/C++, C#, Java, Bash, Ruby, PHP, Lua, CSS, HCL, Kotlin, Swift, Solidity, Zig, and others.

Dedicated structural-fact extraction is strongest for TypeScript/JavaScript/TSX and Python.

Call-graph enrichment has dedicated support for TypeScript/JavaScript/TSX, Python, Go, and Rust.

Files without a dedicated AST grammar still work with normal reads and text/lexical retrieval.

The LSP descriptor catalog is separate from tree-sitter language support; see `src/language-intelligence/language-server-catalog.ts` for the current server list.

---

## Development

```bash
npm ci
npm run typecheck
npm run lint
npm test
```

Focused tests:

```bash
npx vitest run test/unit/search/grep-tool.test.ts
npx vitest run test/unit/lsp
node scripts/validate-skills.mjs
```

Real language-server integration tests are opt-in locally:

```bash
PI_SMARTREAD_LSP_CONFORMANCE=1 npx vitest run test/integration/lsp
```

The dedicated CI workflow installs pinned Pyright, gopls, rust-analyzer, and clangd environments and enforces zero-skip conformance lanes.

Main CI runs `npm ci`, typecheck, and the full test suite on Node 20 across Ubuntu, macOS, and Windows.

### Repository map

| Directory | Responsibility |
|---|---|
| `src/read/` | Batch/intent/read planning, ranking, evidence-aware reading |
| `src/search/` | Grep cascade, structural search, semantic/graph filtering |
| `src/inspect/` | File/directory/navigate inspect orchestration |
| `src/script-mode/` | Bounded QuickJS composition |
| `src/lsp/` | Strict LSP contract, executor, transport, sessions, codecs |
| `src/language-intelligence/` | Server catalog, resolver, trust, installs, SmartEdit provider |
| `src/indexing/` | Semantic index, embeddings, persistence, snapshots/coverage |
| `src/graph/` | Context graph, communities, mutations, graph enrichment |
| `src/repository/` | ADRs, lineage, semantic deltas, repository ranking |
| `src/evidence/` | Workspace evidence production/resolution |
| `src/runtime/` | Skills, hygiene, watcher, guidance, safety hooks |
| `src/mcp/` | MCP prompts/resources |
| `skills/` | Shipped workflow skills |
| `test/unit/` | Default unit/contract tests |
| `test/integration/lsp/` | Opt-in real-server LSP suite |

---

## Troubleshooting

**Semantic retrieval says embeddings are unavailable**

Set both `PI_SMARTREAD_EMBEDDING_BASE_URL` and a model. The system will otherwise continue in lexical/structural mode.

**Repo config contains a baseUrl but it is ignored**

That is intentional. Network endpoints and API keys are environment-only trust decisions.

**`LSP` returns `unavailable`**

Run `/lsp status` and `/lsp doctor <language>`. Check PATH, project-root trust for local binaries, or install a managed candidate.

**Project-local language server is skipped**

Trust the root with `/lsp trust [path]`.

**A rename/code action returned an edit but nothing changed**

Correct behavior. SmartRead returns proposals; SmartEdit owns mutation.

**An inspect navigate example is off by one when copied to `LSP`**

The contracts differ: inspect navigation is 1-based; strict `LSP` is 0-based negotiated encoding.

**A large `read { path }` returned signatures instead of the whole file**

That is the AST-outline guard. Use `offset`/`limit`, `symbol`, or disable/raise the outline threshold.

**Need a fast architecture overview**

Use:

```json
{"mode":"directory","path":".","analysis":{"compact":true}}
```

---

## Migration from older tool surfaces

Older versions exposed tools such as `read_files`, `search`, `repo_map`, `symbol`, `intent_read`, and other helper tools directly.

Current equivalents:

| Older surface | Current surface |
|---|---|
| `read_files` | `read { paths: [...] }` |
| intent/semantic read | `read { query: "..." }` |
| symbol read | `read { symbol: "..." }` |
| `search` | `grep` |
| `repo_map` | `inspect { mode: "directory", path: ... }` |
| old inspect query/symbol | `grep` or `read { symbol }` |
| old auto-detected inspect path | explicit `inspect.mode` |
| ad-hoc LSP helpers | strict `LSP` or inspect `navigate` |

Historical design documents under `docs/archive/` may still use removed tool names.

---

## Further documentation

- [MCP quickstart](docs/mcp-quickstart.md)
- [LSP conformance matrix](docs/lsp-conformance.md)
- [SmartRead ↔ SmartEdit LSP contract](docs/lsp-smartedit-contract.md)
- [Inspect script-mode design](docs/plans/2026-09-13-inspect-script-mode-design.md)
- [LSP semantic substrate plan](docs/plans/2026-09-22-lsp-semantic-substrate-plan.md)
- [Skills convention](skills/README.md)
- [Archived design history](docs/archive/README.md)

## License

MIT © 2026 Rhine Sharar
