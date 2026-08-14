# Quality / Hygiene Audit — Pi-SmartRead

Scope: `package.json` packaging, `tsconfig`/`eslint` mismatch, runtime imports, optional deps, generated/cache artifacts, slow/flaky tests.

**Baseline (run 2026-06-18)**
- `tsc --noEmit` (npm typecheck): **PASS** (strict + noUncheckedIndexedAccess)
- `vitest run` (npm test): **PASS** — 47 files / 615 tests / 4 skipped / 114.6s
- `eslint .`: **FAIL** — 2 errors, 29 warnings
- Uncommitted modifications: 16 files; 4 untracked (incl. `deep-search-tool.ts`, `docs/tool-consolidation-plan.md`)

---

## P0 — Release blockers

### 1. `package.json` `files[]` is missing 21 tracked source files; extension entry is broken on publish
- **File:** `package.json:9-61` (the `files` array)
- **Symptom:** Many root `.ts` files imported by `index.ts` (the Pi extension entry) are NOT listed in `package.json` `files[]`. Publishing via `npm pack` / `npm publish` will omit them, and `pi` will fail to load the extension at runtime.
- **Missing from `files[]` (tracked on disk, imported transitively from `index.ts`):**
  - `fs-scan-cache.ts` (imported by `index.ts:8`)
  - `file-read-cache.ts` (imported by `index.ts:33`)
  - `internal-url-router.ts` (imported by `index.ts:22-23`)
  - `git-notes-tool.ts` (imported by `index.ts:4`)
  - `bash-context-guard.ts` (imported by `index.ts:64`)
  - `context-hygiene.ts` (imported by `index.ts:45`)
  - `context-application.ts` (imported by `index.ts:46`)
  - `doom-loop.ts` (imported by `index.ts:54`)
  - `code-summary.ts` (imported by `index.ts:9, 375`)
  - `find-symbol-tool.ts` (imported by `index.ts:12`)
  - Plus not (yet) imported by `index.ts` but tracked: `git-context.ts`, `git-history.ts`, `git-notes.ts`, `graph-protocol.ts`, `local-embedding-provider.ts`, `mcp-prompts.ts`, `mcp-resources.ts`, `memory-protocol.ts`, `orama-search.ts`, `skill-protocol.ts`, `sqlite-vec-store.ts`, `deep-search-constants.ts`, `doom-loop-suggestions.ts`, `bun-types.d.ts`, `dump.ts`
- **Also listed in `files[]` but missing on disk:** `graphify-connector.ts`, `advanced-retrieval-baseline.ts` — `npm pack` will warn or fail.
- **Fix:** replace the hand-maintained `files[]` with a build-derived list. Recommended: drop the explicit list and add `"files": ["index.ts", "*.ts", "queries/**", "README.md", "LICENSE", "package.json"]` — or better, move build to `tsc --build` and `files: ["dist/**"]`. The current list is provably drifting from `git ls-files` (audit found 21 missing, 2 phantom).

### 2. ESLint has hard errors that will fail CI / commit hooks
- **File:** `bun-types.d.ts:15` — `declare var Bun: any;` → `no-var`. Fix: `declare const Bun: any;`
- **File:** `code-summary.test.ts:0` (whole file) — ESLint `@typescript-eslint` parser error: file is **not in `tsconfig.json` `include`**. This means the test file is excluded from type-checking AND from lint type-aware rules. Fix one of:
  1. Add `code-summary.test.ts` to `tsconfig.json` `include`, **or**
  2. Move it to `test/unit/code-summary.test.ts` (it already runs from there in vitest — the root copy is a duplicate).
- **Verification:** `npm run typecheck` passes because tsc is run with no explicit files, and the `include` pattern list does not match `code-summary.test.ts` either; it is silently skipped. **This is a type-safety hole**: the test file is not type-checked.

### 3. Test files with hard dependencies on optional packages run in CI by default
- **File:** `test/unit/sqlite-vec-store.test.ts:60, 84` uses `require("better-sqlite3")` synchronously (not dynamic). `better-sqlite3` is `optionalDependencies`, so install can fail (e.g., on systems without build toolchain) and the test file crashes at import time.
- **File:** `test/unit/local-embedding-provider.test.ts:96` documents that integration tests "only run when `@huggingface/transformers` is present" but does not gate them — they will throw at runtime if the package is absent.
- **Fix:** in `vitest.config.ts` (currently **absent** — there is no `vitest.config`), add test-file filters or `setupFiles` to skip when optional deps are missing, OR use `it.runIf(canImport(...))` per `@huggingface/transformers` block. The sqlite-vec test should use a dynamic import matching the runtime pattern in `sqlite-vec-store.ts:106`.

---

## P1 — Drift and maintenance

### 4. `tsconfig.json` `include` is an explicit, hand-maintained denylist-style allowlist
- **File:** `tsconfig.json:17-36` — 57 explicit file globs. Each new file requires a tsconfig edit or it gets silently skipped from type-checking (this is how `code-summary.test.ts` slipped through).
- **Fix:** replace with `"include": ["*.ts", "*.d.ts", "test/**/*.ts"]`. The explicit list will only diverge further.

### 5. `dump.ts` is a tracked Aider debug helper that is not imported anywhere
- **File:** `dump.ts` (77 lines, last touched 2026-05) — contains `function dump(...)` modeled on Aider's Python helper.
- **Verdict:** not imported by any `.ts` file in the repo, and not in `package.json` `files[]`. Either remove it (preferred) or move it under `scripts/` and explicitly mark dev-only.

### 6. `config.enc` is a tracked opaque binary
- **File:** `config.enc` — 3.6 KB encrypted blob. Search shows it is not referenced by any `.ts` source.
- **Recommendation:** either move to `.gitignore` and ship unencrypted config defaults, or document the key-rotation story. As-is it adds noise to the published tarball if `files[]` ever gets fixed to publish everything.

### 7. `test/unit/CLAUDE.md` is a tracked Claude memory tag file
- **File:** `test/unit/CLAUDE.md` — content is literally `<claude-mem-context>\n</claude-mem-context>`. This is a process artifact leaking into the published repo.
- **Fix:** add to `.gitignore` (`test/unit/CLAUDE.md` and any other `**/CLAUDE.md`); `git rm --cached`.

### 8. `.subagent-work/` and `research/` are tracked but are working scratch
- **Files:** `.subagent-work/*.md` (8 files, 38 KB), `research/*.md` (8 files).
- **Verdict:** not in `package.json` `files[]`, so they would not be published, but they ARE committed to history, bloating the repo. Add both paths to `.gitignore` (or use `git rm -r --cached` once).

### 9. `docs/` and `meta-prompt.md` / `context.md` / `progress.md` are tracked docs
- Verdict: these are intentional project documentation, not release-blockers. Acceptable to keep, but consider excluding `progress.md` (per workspace convention it's scratch) and `docs/plans/**` / `docs/superpowers/**` from publish if `files[]` ever moves away from explicit lists.

---

## P2 — Test performance and reliability

### 10. MCP tests are slow (65.6s + 114s aggregate across the two suites; dominant wall-clock contributor)
- **Files:**
  - `test/unit/mcp-server.test.ts` (266 lines) — 6 tests, **65.6s**
  - `test/unit/mcp-advanced.test.ts` (448 lines) — 14 tests, **114s**
- **Cause:** both suites spawn a fresh `node --import tsx mcp-server.ts` subprocess **per test**, with a 30s per-test timeout. tsx + esbuild cold boot is ~8–10s; 20 tests × ~9s ≈ 180s aggregate across the two files, matching the observed per-file durations. (Vitest runs files in parallel, so the aggregate per-file time exceeds the 114.6s wall-clock total.)
- **Fix options (in order of effort):**
  1. Add `test.mcpServer.keepAlive` mode and a single shared server reused across tests (cut ~150s).
  2. Mark these `describe` blocks with `test.mcpServer.serial` and gate them behind `process.env.RUN_MCP_INTEGRATION=1` so PRs run a fast smoke set.
  3. Pre-bundle `mcp-server.ts` with `tsc` (skip tsx cold start).

### 11. `test/unit/hook.test.ts` is slow for its size (12s for 3 tests, 7s of which is on a single test)
- **File:** `test/unit/hook.test.ts` — `before_agent_start returns system prompt with repo map on first turn` takes 7s.
- **Cause:** the test runs the real `generateCompactMap` against a synthesized temp project (tree-sitter, repo map, git probes). Acceptable for a single integration test, but worth a `@vitest/spy`-based unit test alongside.

### 12. `test/unit/deep-search.test.ts` mutates `process.env` across parallel vitest workers
- **File:** `test/unit/deep-search.test.ts:20-22, 48-50` — sets/unsets `PI_SMARTREAD_EMBEDDING_BASE_URL`, `PI_SMARTREAD_EMBEDDING_MODEL`.
- **Risk:** vitest runs test files in parallel by default; env mutation in one file races another if any test elsewhere depends on these vars (e.g. `test/unit/intent-read.test.ts` reads them). The current test run passes, but flake risk is real.
- **Fix:** use `vi.stubEnv(...)` / `vi.unstubAllEnvs()` which vitest scopes per test, or gate the deep-search tests to run serially.

### 13. `test/unit/mcp-advanced.test.ts` and `mcp-server.test.ts` use `spawn("node", ...)` with no retry and a fixed 30s timeout
- **Risk:** CI cold-cache / shared runners can exceed 30s on the first test in each file (`responses to initialize request` is 11.5s; warm is ~9s; the upper bound is thin).
- **Fix:** bump per-test timeout to 45s, or pre-warm tsx via a parent fixture.

---

## P3 — Other observations

### 14. No `vitest.config.ts` (or `vitest.config.js`)
- Vitest currently runs with all defaults: parallel workers, default reporters, no path aliases, no setup file. Combined with items 10–13 above, adding a single config file would let you address all of them at once.

### 15. No `prepublishOnly` script
- `package.json` has `typecheck`, `test`, `mcp-server` — no `prepublishOnly` / `prepack` / `preversion`. With `files[]` drift (item 1), there is nothing stopping a bad publish. Recommended: add `"prepublishOnly": "npm run typecheck && npm test"`.

### 16. Unused eslint-disable directives (8 files)
- `ast-chunker.ts:218, 221, 223, 236`; `code-summary.ts:295`; `graph-mutate.ts:36`; `orama-search.ts:142, 197`; `sqlite-vec-store.ts:105, 118`; `test/unit/sqlite-vec-store.test.ts:60, 84`. All trigger `Unused eslint-disable directive` warnings.
- **Fix:** run `npx eslint . --fix` (auto-removes 12 of these) and manually clean the rest.

### 17. `test/unit/retrieval-benchmark.test.ts` and `tags-verify.test.ts` use `console.log` despite the `no-console` warn rule
- 16 `console` warnings in the test suite. Acceptable for benchmark/debug output, but consider switching to `process.stderr.write` to silence the lint noise (the rule allows `warn`/`error`).

### 18. `bun.lock` is committed but project is Node-targeted
- `package.json` `engines.node >= 20`, but `bun.lock` is 150 KB committed. Either drop `bun.lock` (Node convention) or commit a `package-lock.json` for the Node flow. As-is, both lock files exist; one is stale.

### 19. `pi` extension entry: `package.json#pi.extensions` points to `./index.ts`
- With the current `files[]` missing modules that `index.ts` imports, `pi` will fail at runtime. Item 1 is the root cause; this is the symptom.

---

## Recommended fix order (effort / impact)

1. **P0 #1** — regenerate `package.json#files` from `git ls-files` (or use `["dist/**"]` after a tsc build) and verify `npm pack` contents. 5 min, release-critical.
2. **P0 #2** — replace `declare var` with `declare const` in `bun-types.d.ts:15`; move/add `code-summary.test.ts` to `tsconfig.include` or to `test/unit/`. 2 min.
3. **P0 #3** — add a `vitest.config.ts` with `setupFiles` that skip optional-dep integration blocks, or convert sqlite-vec test to dynamic import. 30 min.
4. **P1 #4** — collapse `tsconfig.json` `include` to `["*.ts", "*.d.ts", "test/**/*.ts"]`. 1 min.
5. **P1 #5–#8** — `.gitignore` + `git rm --cached` for `dump.ts`, `config.enc` (debatable), `test/unit/CLAUDE.md`, `.subagent-work/`, `research/`. 10 min.
6. **P1 #15** — add `prepublishOnly` script. 1 min.
7. **P2 #10** — share one MCP server across tests in the mcp-advanced/mcp-server suites. 1–2 hr.
8. **P2 #12** — switch to `vi.stubEnv`. 15 min.
9. **P3 #16–#18** — cleanup pass. 15 min.
