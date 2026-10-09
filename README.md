# Pi-SmartRead

Code intelligence for the [Pi coding agent][pi]. Pi-SmartRead gives the
model ranked code search, structural and architectural analysis, a strict
language-server tool, and file reads that record exactly what the model has
seen.

It runs two ways:

- **As a Pi extension.** It replaces Pi's `read` and `find`. It adds `grep`,
  `inspect`, `LSP` and `skill`. It also installs runtime hooks that keep the
  model's context accurate.
- **As a standalone MCP server.** Any MCP client gets the same discovery and
  language-server tools over stdio.

Every read records which lines the model actually received. The companion
editor, [Pi-SmartEdit][smartedit], checks those records before it allows an
edit. Search results are only leads. The model has to read a file before it
can change it.

[pi]: https://github.com/earendil-works/pi
[smartedit]: https://github.com/rhinos0608/Pi-SmartEdit

## Contents

- [Install](#install)
- [The tools](#the-tools)
- [A typical investigation](#a-typical-investigation)
- [Tool reference](#tool-reference)
- [Relevance judge](#relevance-judge)
- [Evidence and the SmartEdit boundary](#evidence-and-the-smartedit-boundary)
- [Language servers](#language-servers)
- [Runtime behavior inside Pi](#runtime-behavior-inside-pi)
- [Configuration](#configuration)
- [MCP server](#mcp-server)
- [Troubleshooting](#troubleshooting)
- [Upgrading from older tool names](#upgrading-from-older-tool-names)
- [Development](#development)
- [Further reading](#further-reading)
- [Acknowledgements and license](#acknowledgements-and-license)

## Install

You need Node.js 20 or later and Pi in the `^0.70.2` range.

```bash
pi install github:rhinos0608/Pi-SmartRead
```

If Pi is already running, load the extension with `/reload`.

On session start, the extension syncs its nine `skills/` into
`~/.pi/agent/skills` (or `$PI_CODING_AGENT_DIR/skills`), each carrying a
`.smartread-managed` marker. Directories you edited or that lack the marker
are left untouched. Opt out with `PI_SMARTREAD_SKILL_SYNC=0`.

To work from a local checkout:

```bash
git clone https://github.com/rhinos0608/Pi-SmartRead.git
cd Pi-SmartRead
npm ci
pi -e ./src/index.ts
```

To use the tools from Claude Code or another MCP client instead, see
[MCP server](#mcp-server). MCP-only users get no automatic skill sync;
run `npm run install-skills [-- --dry-run|--target dir]` to install the
skills manually.

Nothing else is required. Embeddings, the relevance judge and managed
language servers are all optional. Without them, search falls back to
lexical and structural ranking.

## The tools

| Tool      | Use it to                                                    | Pi | MCP |
| --------- | ------------------------------------------------------------ | -- | --- |
| `read`    | Read files, line ranges or named symbols you already know    | ✓  | —   |
| `find`    | Locate files and directories by glob, fuzzy name or description | ✓ | ✓  |
| `grep`    | Search inside files for text, symbols, concepts or AST shapes | ✓ | ✓   |
| `inspect` | Analyze structure and architecture, or run multi-step scripts | ✓ | ✓   |
| `LSP`     | Ask a language server for definitions, references, types, diagnostics | ✓ | ✓ |
| `skill`   | Discover and load reusable workflow instructions              | ✓ | ✓   |

Three more tools register only when you enable them: `graph_mutate`,
`git_notes_read` and `git_notes_write`. See
[Experimental tools](#experimental-tools).

The split between the tools is deliberate:

- **Discovery tools** (`find`, `grep`, `inspect`) tell the model where to
  look. Their results never authorize an edit.
- **`read`** shows source. It is the only tool whose output can authorize
  an edit.
- **`LSP`** answers questions that need a compiler, such as which symbol a
  name resolves to. Use it instead of guessing from text matches.

## A typical investigation

The calls below show the order a model usually works in. Each one is a tool
call in JSON.

Find the files that look relevant:

```json
{ "tool": "find", "pattern": "where embedding requests are sent", "path": "src" }
```

Search inside them:

```json
{ "tool": "grep", "pattern": "validateEmbeddingConfig", "path": "src" }
```

Read the code:

```json
{ "tool": "read", "symbol": "validateEmbeddingConfig" }
```

Confirm who calls it, using a 0-based position from the read:

```json
{
  "tool": "LSP",
  "operation": "findReferences",
  "path": "src/config.ts",
  "position": { "line": 324, "character": 16 }
}
```

Check what a change would reach:

```json
{ "tool": "inspect", "mode": "file", "path": "src/config.ts", "analysis": { "impact": true } }
```

The `tool` key only labels each example. In a real call, the tool name is
separate from the arguments.

## Tool reference

### `read`

`read` replaces Pi's built-in read. Each call takes exactly one selector:
`path`, `paths` or `symbol`.

```json
{ "path": "src/auth.ts" }
{ "path": "src/auth.ts", "offset": 120, "limit": 80 }
{ "path": "src/auth.ts:120-199" }
{ "paths": [{ "path": "src/auth.ts" }, { "path": "src/session.ts", "offset": 40, "limit": 90 }] }
{ "symbol": "AuthService.login", "limit": 120 }
```

- `offset` is 1-based. A `path:start-end` suffix is shorthand for
  `offset` and `limit`.
- `paths` accepts up to 100 entries. Output is capped at 2,000 lines or
  50 KB. Files that don't fit are omitted or cut short, with a hint for
  reading the rest. `stopOnError` defaults to `false`.
- `symbol` asks the language server first and falls back to the context
  graph. It starts the read a few lines above the definition.
- A plain `{ path }` read of a large source file (20 KB by default) returns
  an AST outline instead of the whole body. The outline lists declarations,
  signatures and line ranges. Read a range or a symbol to see the body.
- Reads can append a footer with imports, recent commits, git notes, graph
  neighbors and language-server symbols. The footer is context, not source,
  and evidence never covers it.
- Line prefixes follow `PI_EDIT_MODE`, the setting shared with SmartEdit.
  Text mode (the default) prints `12|code`. Hashline mode adds a content
  hash to each line number, so SmartEdit can anchor edits to it.

`read` has no natural-language query mode. Use `grep` or `find` to discover
files, then `read` them.

### `find`

`find` replaces Pi's built-in `find`. Its schema stays `{ pattern, path?,
limit? }`, and the form of `pattern` picks the mode:

| Pattern looks like            | Mode             | Default limit |
| ----------------------------- | ---------------- | ------------- |
| Contains `*`, `?`, `[` or `{` | Glob             | 100           |
| A sentence or description     | Natural language | 20            |
| Anything else                 | Fuzzy name       | 100           |

```json
{ "pattern": "src/**/*.test.ts" }
{ "pattern": "grptool" }
{ "pattern": "files that configure the embedding endpoint", "path": "src" }
```

The maximum limit is 500. A traversal stops after five seconds and says
so. Results are grouped by directory, and `find` never matches file
contents. With the [relevance judge](#relevance-judge) on, natural-language
results come back as a tree. Each file in the tree carries up to eight
top-level symbols and a relevance score.

### `grep`

`grep` is the main search tool. Give it either one `pattern` or a batch of
up to 10 `queries`.

```json
{ "pattern": "handleAuth", "path": "src" }
```

```json
{
  "path": "src",
  "queries": [
    { "pattern": "handleAuth" },
    { "pattern": "DATABASE_URL", "literal": true },
    { "pattern": "await $X.json()", "structural": { "language": "typescript" } }
  ],
  "maxResults": 80
}
```

**How patterns are matched.** By default, a pattern runs through a ranked
cascade:

1. Exact text matches come first.
2. BM25 lexical ranking follows.
3. AST symbol matches are added.
4. The lists are merged by reciprocal-rank fusion and deduplicated.
5. If that finds nothing and an embedding index exists, semantic search
   runs as a last resort.

Compact regex syntax switches a pattern to regex automatically. That
includes `|`, `^` and `$` anchors, `[class]`, `{n}`, `\d`-style escapes,
and groups without spaces such as `foo.*bar`. A lone `.` does not count.
Multi-line patterns, prose with parentheses, and invalid regexes stay on
the cascade, and the output says why.

| Option          | Effect                                                       |
| --------------- | ------------------------------------------------------------ |
| `literal`       | Exact substring only. Skips the cascade and semantic search. |
| `regex`         | Force regex. Zero hits stays zero. Cannot combine with `literal`. |
| `path`, `glob`  | Scope the search. `path` defaults to the working directory.  |
| `ignoreCase`    | Case-insensitive matching.                                   |
| `contextLines`  | Lines around each hit. Default 2, maximum 20.                |
| `perQueryLimit` | Hits per query. Default 20, maximum 50.                      |
| `maxResults`    | Total rendered hits. Default 100, maximum 200.               |
| `graphFilter`   | Keep hits with a graph relation, e.g. `CALLS->auth.login`.   |
| `structural`    | ast-grep search: `language`, `skip`, `groupByFile`.          |
| `skip`          | Pagination for structural search.                            |

`limit` still works as a deprecated alias for `perQueryLimit`.

Ranking ships with one knob on: files under test, spec and fixture paths,
and all Markdown files, score at 0.7 of normal. You can change that and
the other ranking knobs with environment variables. See
[docs/configuration.md](docs/configuration.md#grep-ranking). Active knobs
are listed in `details.rankingKnobs`.

### `inspect`

`inspect` analyzes structure. You must set `mode`, and it is never
inferred from the path.

With `PI_SMARTREAD_INSPECT_AFFORDANCES=1`, opt-in task views select one isolated view (`overview`, `dependencies`, `architecture`, `change-review`, or `routes`); add `gather: true` for bounded source corroboration. Views cannot be combined with `analysis` or script mode, and `change-review` requires `diff`. Results are discovery-only; read cited source for strong evidence. This selector is independent of `PI_SMARTREAD_AFFORDANCES`.

**File mode** reports a file's dependencies, dependents, callers, type
relationships and quality signals.

```json
{
  "mode": "file",
  "path": "src/inspect/inspect.ts",
  "analysis": { "signals": ["complexity", "tests"], "callDepth": 2, "callDirection": "both", "impact": true }
}
```

| Field                        | Values                                                         |
| ---------------------------- | -------------------------------------------------------------- |
| `signals`                    | `complexity`, `public-api`, `reuse`, `recency`, `tests`, `deprecation` |
| `callDepth`, `callDirection` | Depth 1–5 (default 1). Direction `callers`, `callees` or `both`. |
| `impact`                     | Files and symbols a change could reach                         |
| `diff`                       | Map `unstaged`, `staged` or `HEAD` changes to affected symbols |
| `deadCode`, `hotspots`, `routes`, `graphSchema` | Extra reports                               |
| `compact`                    | Shorter output. Default `false`.                               |

**Directory mode** builds a ranked repository map. It can add
architecture views on top.

```json
{ "mode": "directory", "path": "src", "analysis": { "mapTokens": 6000, "clusters": true, "layers": true } }
```

Directory mode accepts `mapTokens` (256–32,768, default 4,096), `focus`,
`clusters`, `layers`, `boundaries`, `routes`, `hotspots`, `deadCode`,
`diff`, `graphSchema` and `compact`. `compact` defaults to `true` here.

**Script mode** runs a read-only JavaScript program in a QuickJS sandbox.
A chain of dependent lookups then fits in one tool call.

```json
{
  "mode": "script",
  "script": "const g = await grep('handleAuth', { literal: true }); const r = await read('src/auth.ts'); return { hits: g.totalHits, lines: r.totalLines };"
}
```

Scripts can call these functions:

- `grep()`, `read()`, `inspectFile()` and `inspectDir()`
- `lsp.definition`, `references`, `implementation`, `hover`,
  `documentSymbols`, `workspaceSymbols`, `prepareCallHierarchy`,
  `incomingCalls` and `outgoingCalls`
- `graph.impact`, `deadCode`, `callGraph`, `hotspots`, `routes`, `diff`,
  `clusters`, `layers` and `boundaries`

Scripts cannot edit, write or evaluate code. Each run is limited by
default to:

- 50 host calls, of which at most 10 are `lsp.*` calls
- 5 calls at a time
- 5 seconds of wall time
- 12 MB of heap
- 200 KB per call or result, and 1 MB in total

A run that exceeds its budget returns partial results, an audit log and any
evidence it gathered.

> The `lsp.*` helpers take **1-based** line and character positions and use
> their own operation names. The strict `LSP` tool takes **0-based**
> positions. Convert both when you move an example from one to the other.

`inspect` has no navigation or diagnostics. Use `LSP` for those.

### `LSP`

`LSP` gives the model strict access to language servers. The tool name is
uppercase, and positions are **0-based** in the server's negotiated
encoding. The response reports that encoding in `server.positionEncoding`.

```json
{ "operation": "goToDefinition", "path": "src/auth.ts", "position": { "line": 41, "character": 9 } }
```

| Family     | Operations                                                         |
| ---------- | ------------------------------------------------------------------ |
| Navigation | `goToDefinition`, `goToDeclaration`, `goToTypeDefinition`, `goToImplementation`, `findReferences`, `hover`, `documentHighlights`, `documentSymbols`, `workspaceSymbols` |
| Hierarchy  | `prepareCallHierarchy`, `incomingCalls`, `outgoingCalls`, `prepareTypeHierarchy`, `supertypes`, `subtypes` |
| Diagnostics and session | `diagnostics`, `workspaceDiagnostics`, `publishedDiagnostics`, `capabilities`, `sessionStatus` |
| Proposals  | `prepareRename`, `rename`, `codeActions`, `resolveCodeAction`, `formatDocument`, `formatRange`, `formatOnType` |
| Apply      | `applyProposal`                                                    |
| Editor     | `completion`, `resolveCompletion`, `signatureHelp`, `inlayHints`, `resolveInlayHint`, `semanticTokens`, `foldingRanges`, `selectionRanges` |
| Raw        | `request`, for an allowlist of read-only LSP methods               |

With `PI_SMARTREAD_AFFORDANCES=1`, LSP also accepts exact declaration-name anchors and the flat `investigate` tasks. A symbol may include `path` to scope a declaration lookup; without a path, it is discovery-only and is never auto-dispatched. This opt-in surface is experimental and disabled by default.

The tool fails closed:

- Unknown operations, extra fields, bad positions and missing required
  fields are rejected.
- `server` routes to that exact descriptor ID or nowhere.
- A request that cannot be routed gets status `unavailable`. The tool
  never falls back to another server.
- The raw `request` operation rejects `workspace/executeCommand`,
  `workspace/applyEdit`, `did*` notifications and `will*` requests.

Every result arrives in an envelope:

- `status` is one of `ok`, `empty`, `unsupported`, `unavailable`,
  `not_ready`, `timeout`, `cancelled`, `error` or `ambiguous`.
- `operation` and `method` name the request.
- `server` records the descriptor, language, project root and position
  encoding.
- `result` holds the server's answer.
- `meta` covers freshness, readiness, document version, truncation and the
  pagination cursor.

**Changing files.** `rename`, `resolveCodeAction` and the format operations
never write to disk. When SmartEdit is loaded, they stage the edit as a
proposal and return a `proposalId` and a diff. `applyProposal` with that ID
is the only operation that changes files. It hands the edit to SmartEdit,
which checks the evidence first. Staging requires a server that uses
UTF-16 positions.

### `skill`

`skill` lists, searches and reads `SKILL.md` workflow files.

```json
{ "action": "search", "query": "safe rename" }
{ "name": "lsp-rename" }
```

It looks for skills in these places:

- `~/.pi/agent/skills` and `~/.agents/skills`
- `.pi/skills` and `.agents/skills` in the current or any parent directory
- package `skills/` directories
- `package.json` → `pi.skills`
- the skill paths in Pi settings

Skills marked `disable-model-invocation: true` are hidden unless you pass
`includeHidden`.

This repository ships nine skills (see [Skills convention](skills/README.md)).
Inside Pi they sync into `~/.pi/agent/skills` automatically; run
`node scripts/validate-skills.mjs` to check them.

| Skill                 | What it does                                                  |
| --------------------- | ------------------------------------------------------------- |
| `inspect-script-mode` | Chains grep → read → LSP → graph in one script call           |
| `lsp-explore`         | Meets unfamiliar code through symbols, definitions and hover  |
| `lsp-local-symbols`   | Outlines a file so reads can target exact ranges              |
| `lsp-impact`          | Measures blast radius with references and call hierarchy      |
| `lsp-rename`          | Requests a rename proposal and applies it through SmartEdit   |
| `lsp-safe-refactor`   | Triages code actions and refactor proposals                   |
| `lsp-fix`             | Turns diagnostics into code-action proposals                  |
| `lsp-cross-root`      | Routes requests across workspaces and exact servers           |
| `lsp-verify`          | Re-checks diagnostics and references after a change           |

### Experimental tools

These tools register only when you enable them in
`pi-smartread.config.json`:

```json
{ "experimental": { "graphMutate": true, "gitNotes": true } }
```

`graph_mutate` records how files are coupled, for example when editing one
file broke another. The model can then use that history in later analysis.

```json
{ "from": "src/types/user.ts", "to": "src/services/auth.ts", "relation": "breakage", "context": "renamed User.id", "confidence": 0.9 }
```

`relation` is `breakage` or `co-change`. `git_notes_read` and
`git_notes_write` store decisions, constraints and rejected approaches as
git notes on commits. All three tools accept an optional `directory` that
overrides the working directory.

## Relevance judge

The judge is an optional model that reranks results. It applies only to
natural-language `grep` queries and natural-language `find` patterns. It is
**off by default**.

| Command         | Effect                                                         |
| --------------- | -------------------------------------------------------------- |
| `/judge cloud`  | Judge through OpenRouter, using the key in Pi's auth store     |
| `/judge local`  | Judge with a local von sidecar. Experimental.                  |
| `/judge install`| Install the local sidecar (about 3 GB, asks before downloading) |
| `/judge status` | Show the mode, backend and cache                               |
| `/judge off`    | Turn judging off                                               |

**Know the trade-off before you turn it on.** On a held-out benchmark of 210
queries across eight repositories, the cloud judge made results more
precise. It also returned nothing far more often for questions that had an
answer: the rate of empty results rose from about 2.4% to 17.3%. Under the
benchmark's scoring, the net effect was harmful. The run used excerpt-based
existence checks, which are not the default; see
[docs/configuration.md](docs/configuration.md#relevance-judge). Use the
judge when a short, precise list matters more than finding everything. The
local judge scored near chance on the same benchmark, so prefer cloud mode.

When the judge rates nothing as confident and doubts that an answer exists,
`grep` returns `no confident match for "<query>"` with no locations. It
does not show weak guesses. If the judge fails, you get the unjudged
results.

Details:

- Cloud requests go only to OpenRouter's origin. The tool never sends
  credentials to any other endpoint.
- The local sidecar listens only on `127.0.0.1`.
- Verdicts are cached in `.pi-smartread/judge-cache/` for 7 days.
- The MCP server reads `PI_SMARTREAD_JUDGE_MODE` and
  `PI_SMARTREAD_JUDGE_API_KEY` from its environment.

All judge settings are listed in
[docs/configuration.md](docs/configuration.md#relevance-judge).

## Evidence and the SmartEdit boundary

Each tool result carries a versioned `WorkspaceEvidenceEnvelope`, defined
in [`@rhinos0608/pi-workspace-protocol`][protocol], in
`details.workspaceEvidence`. SmartEdit uses it to decide what the model is
allowed to change.

- A complete file read gives strong evidence for that file.
- A partial read covers only the lines it rendered.
- An AST outline covers only the declaration lines it rendered.
- In a batch read, files that were omitted or cut short gain no authority.
- `grep`, `find` and `inspect` produce discovery evidence only. That
  includes directory maps.
- Evidence uses real paths, with symlinks resolved.
- The tool results are the record of truth. SmartRead keeps an in-memory
  cache of them and serves it to SmartEdit over RPC.

SmartRead never writes files. It publishes evidence and edit proposals, and
SmartEdit performs every change. The full contract is in
[docs/lsp-smartedit-contract.md](docs/lsp-smartedit-contract.md).

`PI_SMARTREAD_ALLOWED_ROOT` limits automatic indexing and retrieval only.
It does not restrict direct reads.

[protocol]: https://github.com/rhinos0608/Pi-Workspace-Protocol

## Language servers

SmartRead starts and manages language-server processes itself. To pick a
server for a file, it tries these sources in order:

1. Your explicit override
2. A binary inside the project, but only if you have trusted that root
3. A binary on your `PATH`
4. A copy installed and managed by SmartRead
5. Otherwise, a degraded result. No process is started.

The catalog covers TypeScript and JavaScript, Python, Rust, Go, C and C++,
C#, Java, PHP, Bash, JSON, YAML, HTML, CSS, Lua and Ruby. The full list is
in [`language-server-catalog.ts`][catalog]. SmartRead can install these
servers itself, at fixed versions:

| Server                                     | Package                               |
| ------------------------------------------ | ------------------------------------- |
| `typescript`                               | `typescript-language-server@6.0.0`    |
| `python`                                   | `pyright@1.1.413`                     |
| `bash-language-server`                     | `bash-language-server@5.6.0`          |
| `yaml-language-server`                     | `yaml-language-server@1.24.0`         |
| `vscode-json-language-server`, `-html-`, `-css-` | `vscode-langservers-extracted@4.10.0` |

Managed installs live under `~/.pi/agent/language-intelligence/`. They pin
exact versions, skip install scripts, check integrity, swap in atomically
and lock across processes. Trust decisions are stored in `trust.json` in
that directory. Settings are in `~/.pi/agent/language-intelligence.json`.

Manage servers with the `/lsp` command. The command is lowercase, unlike
the tool name.

| Command                                | Effect                                       |
| -------------------------------------- | -------------------------------------------- |
| `/lsp status`                          | Show how each language resolves              |
| `/lsp doctor [lang]`                   | Explain one language's resolution in detail  |
| `/lsp trust [path]`                    | Allow project-local binaries under a root    |
| `/lsp restart [server]`                | Restart servers for the current root         |
| `/lsp install <server>`                | Install one managed server                   |
| `/lsp install auto`                    | Turn on auto-install and install what's missing |
| `/lsp update <server>`, `/lsp update --all` | Reinstall the pinned version            |
| `/lsp uninstall <server>`              | Remove a managed server                      |

[catalog]: src/language-intelligence/language-server-catalog.ts

## Runtime behavior inside Pi

Besides its tools, the extension hooks into the Pi session:

- **Startup context.** At the start of a session, it adds a compact
  repository map and git context as prompt sections on every run, and each
  tool carries its own routing snippet and guidelines (`promptSnippet` /
  `promptGuidelines`). It also removes Pi's
  `ls` tool, so the model uses `find` and `grep` instead.
- **Context hygiene.** After a file changes, earlier reads of that file in
  the context are replaced with a placeholder. The model then stops
  reasoning from old source.
- **Doom-loop detection.** Repeated identical calls, stalled tool streaks
  and excessive re-reads trigger a warning with a suggested next step.
- **Output guard.** Oversized `bash` output is cut to a head and tail
  preview. The guard also bounds large `inspect` and `git_notes_read`
  results.
- **Bash hints.** A failed command gets a fix hint for your platform. When
  `bash` is used where a dedicated tool fits better, an advisory suggests
  the tool. Advisories never block a command.
- **Post-edit checks.** If SmartEdit is not installed, SmartRead adds
  language-server diagnostics and an impact summary after `edit` and
  `write`.
- **File watching.** SmartRead polls file stats so its indexes stay
  current.
- **Microagents.** Markdown instructions in `.pi-smartread/microagents/` or
  `.openhands/microagents/` load on a trigger or on every session.

## Configuration

SmartRead looks for `pi-smartread.config.json` in the current directory,
then in each parent directory. Every field is optional.

```json
{
  "model": "nomic-embed-text",
  "chunkSizeChars": 4096,
  "rerankEnabled": false,
  "hydeEnabled": false,
  "gitContext": { "enabled": true, "readEnrichmentCommits": 3 },
  "experimental": { "graphMutate": false, "gitNotes": false, "bashMisuseHints": true }
}
```

**Network endpoints and API keys come only from your environment.**
SmartRead ignores `baseUrl` and API-key fields in the repository config,
because you may not trust everyone who can edit a repository. To turn on
semantic search:

```bash
export PI_SMARTREAD_EMBEDDING_BASE_URL="http://localhost:11434/v1"
export PI_SMARTREAD_EMBEDDING_MODEL="nomic-embed-text"
export PI_SMARTREAD_EMBEDDING_API_KEY="..."   # if your endpoint needs one
```

Plain HTTP is accepted only for local and private-network hosts. Public
endpoints must use HTTPS. With embeddings configured, SmartRead keeps an
incremental index in `.pi-smartread/`.

Every config key and environment variable is listed in
[docs/configuration.md](docs/configuration.md). That covers reranking, git
context, `grep` ranking, the judge, the output guard, file watching and
diagnostics.

## MCP server

The server speaks MCP over stdio. To add it to Claude Code:

```bash
claude mcp add pi-smartread -- npx tsx /path/to/Pi-SmartRead/src/mcp-server.ts
```

To start it from a checkout, run `npm run mcp-server`.

- **Tools:** `find`, `grep`, `inspect`, `LSP` and `skill`, plus any
  experimental tools you enable. The `read` tool depends on Pi and is not
  included.
- **Prompts:** `explain-code`, `review-diff`, `architectural-analysis` and
  `smartread-tool-guide`.
- **Resources:**
  - `smartread://config`, with secrets redacted
  - `smartread://repo-map`
  - `smartread://status`
  - `smartread://repo/stats`
  - `smartread://repo/graph/summary`, `/communities` and `/god-nodes`
  - `smartread://repo/index/status` and `/coverage`
  - `smartread://repo/adrs`
  - `smartread://repo/near-clones`

The MCP server does not install the Pi hooks. Setup for Claude Desktop,
Cursor and other clients is in [docs/mcp-quickstart.md](docs/mcp-quickstart.md).
It sends the SmartRead Tool Guide as MCP `instructions` at handshake, so
clients get tool-routing guidance without the Pi prompt sections.

## Troubleshooting

**Search says embeddings are unavailable.** Set both
`PI_SMARTREAD_EMBEDDING_BASE_URL` and a model. Without them, search
continues with lexical and structural ranking.

**A `baseUrl` in the repository config is ignored.** That is intended.
Endpoints and keys come from the environment only.

**`LSP` returns `unavailable`.** Run `/lsp status`, then
`/lsp doctor <language>`. Install a managed server, add one to your `PATH`,
or trust the project root for a project-local binary.

**A project-local language server is skipped.** Trust the root with
`/lsp trust [path]`.

**A rename returned an edit, but no file changed.** That is intended.
Proposals change files only through `applyProposal`, and only when
SmartEdit is loaded.

**`read { path }` returned signatures instead of the file.** That is the
AST outline for large files. Read a range or a symbol, raise
`PI_SMARTREAD_AST_OUTLINE_BYTES`, or set `PI_SMARTREAD_AST_OUTLINE=0`.

**`grep` found nothing, and the judge is on.** The judge may have
abstained. Run `/judge off` and search again to see the unjudged results.

**I want a quick architecture overview.** Run
`inspect { "mode": "directory", "path": "." }`.

## Upgrading from older tool names

| Old surface                     | Use now                                           |
| ------------------------------- | ------------------------------------------------- |
| `read_files`                    | `read { paths: [...] }`                           |
| `search`                        | `grep`                                            |
| `repo_map`                      | `inspect { mode: "directory" }`                   |
| `intent_read` and semantic reads | `grep` or `find`, then `read`                    |
| Old `symbol` tool               | `read { symbol }`, or `LSP` for semantics         |
| `inspect` without `mode`        | `inspect` with an explicit `mode`                 |
| `inspect` `navigate` mode       | `LSP` (positions are 0-based)                     |

Design notes in `docs/archive/` may still use the old names.

## Development

```bash
npm ci
npm run lint
npm run typecheck
npm test
```

| Task                         | Command                                                          |
| ---------------------------- | ---------------------------------------------------------------- |
| One test file                | `npx vitest run test/unit/search/grep-tool.test.ts`              |
| LSP unit tests               | `npx vitest run test/unit/lsp`                                   |
| Validate shipped skills      | `node scripts/validate-skills.mjs`                               |
| Real language-server tests   | `PI_SMARTREAD_LSP_CONFORMANCE=1 npx vitest run test/integration/lsp` |

CI runs lint, typecheck and the full suite on Node 20, on Ubuntu, macOS
and Windows. A second Linux workflow runs the real-server conformance
suite against Pyright, gopls, rust-analyzer and clangd, and fails if any
test is skipped.

The search and judge benchmarks are in `scripts/eval/`. They include the
held-out benchmark, comparisons with other search tools, and judge
precision and recall curves. Results and decisions are recorded in
[docs/plans/2026-10-06-decision-log.md](docs/plans/2026-10-06-decision-log.md).

| Directory                    | Contents                                                 |
| ---------------------------- | -------------------------------------------------------- |
| `src/read/`, `src/evidence/` | Reads, enrichment and evidence production                |
| `src/search/`                | `grep` cascade, `find`, structural and graph filtering   |
| `src/judge/`                 | Relevance judge, cache and von sidecar                   |
| `src/inspect/`, `src/script-mode/` | Structural analysis and the QuickJS script host    |
| `src/lsp/`                   | Strict LSP contract, executor and transport              |
| `src/language-intelligence/` | Server catalog, resolution, trust, installs and SmartEdit RPC |
| `src/indexing/`, `src/graph/`, `src/repository/` | Semantic index, context graph and repository intelligence |
| `src/runtime/`               | Hooks, watcher, guards and the `skill` tool               |
| `src/mcp/`                   | MCP prompts and resources                                |
| `skills/`                    | Shipped skills                                           |

Operational rules for coding agents working in this repository are in
[AGENTS.md](AGENTS.md).

## Further reading

- [Configuration reference](docs/configuration.md)
- [MCP quickstart](docs/mcp-quickstart.md)
- [LSP conformance matrix](docs/lsp-conformance.md)
- [SmartRead and SmartEdit LSP contract](docs/lsp-smartedit-contract.md)
- [Script-mode design](docs/plans/2026-09-13-inspect-script-mode-design.md)
- [Relevance judge design](docs/plans/2026-10-05-grep-judge-design.md)
- [Enhanced `find` design](docs/plans/2026-10-05-enhanced-find-design.md)
- [Skills convention](skills/README.md)
- [Archived design history](docs/archive/README.md)

## Acknowledgements and license

Pi-SmartRead began as a fork of pi-read-many by Gurpartap Singh. That tool
let Pi read several files in one call, packing them to fit the context.
Little of that code remains, but the batch `paths` read comes from it.

MIT. See [LICENSE](LICENSE).
