# Validation / Test Audit — Pi-SmartRead

**Scope:** Pi-SmartRead repository root (absolute path redacted)
**Mode:** Read-only audit. No project/source files were modified. Only test/typecheck/lint commands were executed, and this report was written.
**Revision:** Reviewed against the working tree (uncommitted changes) on top of HEAD; the reviewed state is captured in the archive commit `b7bc3eb` ("docs: archive superseded audits and plans, document operational invariants").
**Input files requested:** `plan.md` and `progress.md` — **neither exists** at the specified paths (`ENOENT`). The audit proceeded against the working-tree changes instead (`git status` + `git diff HEAD`), since those represent the actual modified behavior to validate.

---

## 1. Working-tree changes under audit (`git diff --stat HEAD`)

```
 README.md                             | 14 +++++++---
 bash-context-guard.ts                 | 15 ++++++++---
 context-application.ts                | 23 ++++++++++++-----
 context-hygiene.ts                    |  6 +++++
 doom-loop-suggestions.ts              | 23 +++++++----------
 hook.ts                               |  5 ++--
 index.ts                              | 26 ++++++++++++-------
 intent-read.ts                        |  4 +--
 mcp-prompts.ts                        | 13 +++++++++-
 mcp-registry.ts                       |  5 ++--
 mcp-server.ts                         | 17 +++++++++++++
 test/unit/bash-context-guard.test.ts  | 23 +++++++++++++++++
 test/unit/context-application.test.ts | 48 +++++++++++++++++++++++++++++++++++
 test/unit/context-hygiene.test.ts     | 15 +++++++++++
 test/unit/doom-loop.test.ts           | 30 ++++++++++++++++++++++
 test/unit/hook.test.ts                |  3 +++
 test/unit/index.test.ts               | 31 +++++++++++++++++++++-
 test/unit/mcp-advanced.test.ts        | 33 ++++++++++++++++++++++--
```

Untracked new file: `tool-guidance.ts` (renderSmartReadToolGuide + SMARTREAD_TOOL_GUIDE_TITLE).
No staged files (`git diff --cached` empty).

---

## 2. Commands run and results

| Command | Result | Summary |
|---|---|---|
| `npm run typecheck` (`tsc --noEmit`) | **passed** | No diagnostics. `strict`, `noUnusedLocals`, `noUnusedParameters`, `noUncheckedIndexedAccess` all enforced. |
| `npm test` (`vitest run`) | **passed** | 636 tests / 47 files, 0 failures. Duration ~112 s. |
| `npx vitest run test/unit/hook.test.ts index.test.ts bash-context-guard.test.ts context-application.test.ts context-hygiene.test.ts doom-loop.test.ts` | **passed** | 128 tests, 0 failures (re-run for flakiness). |
| `npx vitest run test/unit/mcp-advanced.test.ts mcp-server.test.ts` | **passed** | 21 tests, 0 failures (re-run for flakiness). |
| `npx vitest run test/unit/deep-search.test.ts` | **passed** | 15 tests, 0 failures (re-run for flakiness). |
| `npx eslint .` | **0 errors / 17 warnings** | All warnings are pre-existing `no-console` in `test/unit/retrieval-benchmark.test.ts` (16) and `test/unit/tags-verify.test.ts` (1) — neither file was modified in this changeset. |

### `prepublishOnly` script
`package.json` defines `prepublishOnly: "npm run typecheck && npm test"`. Both components are green above, so `npm run prepublishOnly` would pass. Not re-executed end-to-end to avoid redundant ~2 min runtime.

---

## 3. Flaky-test review

No flakiness observed. The slowest, most spawn-heavy suites were re-run in isolation and passed cleanly on both runs:

- **`mcp-advanced.test.ts`**: 15 tests, ~108 s total (~9 s per `callMcpServer` invocation due to `node --import tsx mcp-server.ts` cold boot). Passed twice. Stable but slow.
- **`mcp-server.test.ts`**: 6 tests, ~54 s. Passed twice. Stable but slow.
- **`hook.test.ts`**: 12 tests, ~7.8 s (real repo-map generation via `startupRepoMapCache`). Passed twice.
- **`deep-search.test.ts`**: 15 tests, ~1.7–6.6 s depending on run (real FS scan in temp dirs). Passed twice.

**Flakiness risk (latent, not triggered):** MCP server tests spawn one `tsx` child process per `callMcpServer` call (~9 s cold boot each). This is a performance fragility, not a correctness flake. `vitest.config.ts` already documents a `keepAlive` optimization (lines 24–30): pooling a single long-lived server process would cut per-dispatch time from ~9 s to ~0.1 s and reduce child-process timing variance — the most likely future flakiness source if CI is loaded.

---

## 4. Missing coverage for modified behavior

Each modified source file was cross-checked against its test file. Findings ranked by importance.

### 4.1 `mcp-registry.ts` — alias description rewrite (GAP, concrete fix)
**Change:** `alias()` now registers a short redirect description (`Deprecated alias for <target>. Use <target> instead.`) instead of copying the canonical tool description.

**Coverage:** `test/unit/mcp-server.test.ts:179-180` only asserts `typeof tool.description === "string"` and that it is defined. No test asserts the *content* of the alias description.

**Concrete fix (do not apply — audit only):** add to `test/unit/mcp-server.test.ts` inside the `tools/list` test, after building `toolNames`:
```ts
const byName = Object.fromEntries(result.tools.map((t: any) => [t.name, t]));
expect(byName.semantic_read.description).toMatch(/Deprecated alias for intent_read/i);
expect(byName.workspace_symbol.description).toMatch(/Deprecated alias for find_symbol/i);
expect(byName.hover_type.description).toMatch(/Deprecated alias for symbol_info/i);
```

### 4.2 `intent-read.ts` — tool name/label change (MINOR GAP)
**Change:** `createIntentReadTool` now returns `name: "intent_read"` / `label: "intent_read"` (was `semantic_read`). The `semantic_read` alias is registered separately in `mcp-registry.ts`.

**Coverage:** `index.test.ts:34-35` and `mcp-server.test.ts:163-164` assert both `intent_read` and `semantic_read` are registered (covers the alias), but no test asserts `createIntentReadTool(...).name === "intent_read"` directly. The canonical-name assertion is the one piece of behavior not pinned by a test.

**Concrete fix:** add to `test/unit/intent-read.test.ts`:
```ts
it("exposes the canonical intent_read name (semantic_read is an MCP alias only)", () => {
  const tool = createIntentReadTool(() => makeReadTool({}) as any, makeEmbedder([]));
  expect(tool.name).toBe("intent_read");
  expect(tool.label).toBe("intent_read");
});
```

### 4.3 `index.ts` — removal of `GUARD_HINT_RE` post-processing and expanded guard tool set (MINOR GAP)
**Change:** `SMARTREAD_GUARD_TOOLS` was expanded from `{"search","read"}` to a 12-tool set; the `GUARD_HINT_RE` replacement block was removed so `result.text` is passed through unmodified.

**Coverage:** `index.test.ts:53-79` ("guards large deep_search tool results") asserts the deep_search path emits `GUARD_HINT_DEEP_SEARCH` and `details.bashContextGuard.toolName === "deep_search"`. Good. No test asserts the negative: that a non-SmartRead tool result (e.g. `toolName: "bash"`) is **not** wrapped by the guard. The old code only guarded `search`/`read`; the new set is broader, so a regression that re-adds an over-broad tool (e.g. `write`) would not be caught.

**Concrete fix:** add to `test/unit/index.test.ts`:
```ts
it("does not guard non-SmartRead tool results", () => {
  const handlers: Record<string, (...args: any[]) => any> = {};
  registerExtension({ registerTool: () => {}, on: (e, h) => { handlers[e] = h; } } as any);
  const text = "x".repeat(200_000);
  const result = handlers.tool_result!({ toolName: "write", toolCallId: "w-1", input: { path: "/a" }, content: [{ type: "text", text }] });
  expect(result.content[0].text).toBe(text); // unmodified
  expect(result.details?.bashContextGuard).toBeUndefined();
});
```

### 4.4 `tool-guidance.ts` — new module (covered indirectly, no direct unit test)
**Change:** New file `tool-guidance.ts` exports `renderSmartReadToolGuide(task?)` and `SMARTREAD_TOOL_GUIDE_TITLE`.

**Coverage:** Exercised through two integration paths — `hook.test.ts` asserts the injected system prompt contains `"SmartRead Tool Guide"`, `"intent_read"`, `"deep_search"`; `mcp-advanced.test.ts` asserts the `smartread-tool-guide` prompt returns text containing the task string plus `intent_read`/`deep_search`/`repo_map`. No direct unit test pins the `task` argument handling (empty/undefined task → guide only; non-empty task → `Task: <task>` prefix). Low risk since both branches are simple string concat, but a focused test would lock the contract.

**Concrete fix:** add `test/unit/tool-guidance.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { renderSmartReadToolGuide, SMARTREAD_TOOL_GUIDE_TITLE } from "../../tool-guidance.js";
describe("renderSmartReadToolGuide", () => {
  it("prefixes the task line when a task is provided", () => {
    expect(renderSmartReadToolGuide("find usages of X")).toMatch(/^Task: find usages of X\n/);
  });
  it("omits the task line when no task is given", () => {
    expect(renderSmartReadToolGuide()).not.toMatch(/^Task:/);
  });
  it("lists canonical tools", () => {
    const g = renderSmartReadToolGuide();
    for (const t of ["read", "read_files", "intent_read", "search", "deep_search", "find_symbol", "symbol_info", "repo_map"]) {
      expect(g).toContain(t);
    }
  });
});
```

### 4.5 `context-application.ts` / `context-hygiene.ts` / `bash-context-guard.ts` / `doom-loop-suggestions.ts` / `hook.ts` / `mcp-prompts.ts` / `mcp-server.ts` — well covered
- `bash-context-guard.ts` new profiles + `toolName` hint → `bash-context-guard.test.ts` (44 tests incl. new `GUARD_HINT_DEEP_SEARCH` + per-tool profile assertions). ✅
- `context-application.ts` expanded `MASKABLE_STALE_TOOLS` set → `context-application.test.ts` parameterized `it.each` over all 9 added tools. ✅
- `context-hygiene.ts` `renderStaleRepoMapPlaceholder` → `context-hygiene.test.ts` repo_map placeholder test. ⚠️ rendering-only: the test asserts the masking/rendering layer only; the production `resourcesForTool → record → generateReport` path is not exercised (the repo_map placeholder is unreachable dead code — see correctness-review.md Finding 1).
- `doom-loop-suggestions.ts` `grep` removal + `semantic_read`→`intent_read` rename → `doom-loop.test.ts` 3 new assertions. ✅
- `hook.ts` always-on tool-guide injection → `hook.test.ts` asserts presence of guide/intent_read/deep_search. ✅
- `mcp-prompts.ts` + `mcp-server.ts` new `smartread-tool-guide` prompt → `mcp-advanced.test.ts` prompt count 3→4 and get-prompt body assertions. ✅

---

## 5. Package scripts

`package.json` scripts (verified):

| Script | Command | Status |
|---|---|---|
| `typecheck` | `tsc --noEmit` | ✅ pass |
| `test` | `vitest run` | ✅ pass (636 tests) |
| `mcp-server` | `node --import tsx mcp-server.ts` | exercised by mcp-server/mcp-advanced tests |
| `prepublishOnly` | `npm run typecheck && npm test` | both green → would pass |

`tsconfig.json` `include` is `["*.ts", "*.d.ts", "test/**/*.ts"]` — covers all modified test files and the new `tool-guidance.ts`. `vitest.config.ts` `include` is `["test/**/*.test.ts"]`.

---

## 6. Residual risks

1. **Alias-description content is unasserted** (§4.1). A future refactor could revert the redirect description with no test failing. Low blast radius (cosmetic MCP UX) but the change is currently unguarded.
2. **No negative guard test** (§4.3). An over-broad `SMARTREAD_GUARD_TOOLS` entry would wrap unrelated tool output silently.
3. **MCP server test latency** (~9 s/spawn × 21 calls ≈ 108 s for `mcp-advanced` alone) makes the suite the single largest wall-clock contributor and the most timing-sensitive under load; the documented `keepAlive` optimization in `vitest.config.ts` is the recommended mitigation.
4. **ESLint flat-config ordering bug (pre-existing, not introduced here):** the general `**/*.ts` block (with `no-console: "warn"`) is declared *after* the `test/**/*.ts` block (with `no-console: "off"`), so the general rule wins for test files and produces the 17 warnings. Fix would be to move the test-specific block last or scope the general block via `ignores: ["test/**/*.ts"]`. Unrelated to this changeset but worth noting since it muddies lint output.
5. **`plan.md` / `progress.md` absent** — the requested input files do not exist; audit was performed against the working tree. If those files were expected to be present, that is an upstream discrepancy.

---

## 6. No staged files

`git diff --cached --name-only` is empty. All 18 modifications are unstaged working-tree changes; `tool-guidance.ts` is untracked. This audit added/modified **no** project or source files — only this report under `audit/validation-review.md`.

---

## Acceptance report

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Audit is read-only: no project/source files modified. Only typecheck/test/lint commands executed and audit/validation-review.md written. Scope limited to validation/test audit of the working-tree changes."
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "Full command outputs captured (npm run typecheck pass; npm test 636/636 pass; eslint 0 errors; targeted re-runs of flaky-prone suites pass twice). Changed-files diff stat, per-file coverage gaps with concrete fix snippets, and residual risks all recorded below."
    }
  ],
  "changedFiles": [
    "audit/validation-review.md (this report — only file written by the audit)"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    { "command": "npm run typecheck", "result": "passed", "summary": "tsc --noEmit clean, 0 diagnostics" },
    { "command": "npm test", "result": "passed", "summary": "vitest run: 636 tests / 47 files, 0 failures (~112s)" },
    { "command": "npx vitest run hook index bash-context-guard context-application context-hygiene doom-loop", "result": "passed", "summary": "128 tests, 0 failures (flakiness re-run)" },
    { "command": "npx vitest run mcp-advanced mcp-server", "result": "passed", "summary": "21 tests, 0 failures (flakiness re-run, ~108s)" },
    { "command": "npx vitest run deep-search", "result": "passed", "summary": "15 tests, 0 failures (flakiness re-run)" },
    { "command": "npx eslint .", "result": "passed", "summary": "0 errors, 17 pre-existing no-console warnings in unmodified test files" },
    { "command": "git diff --cached --name-only", "result": "passed", "summary": "empty — no staged files" },
    { "command": "git diff --stat HEAD", "result": "passed", "summary": "18 files modified (11 source + 7 test), tool-guidance.ts untracked" }
  ],
  "validationOutput": [
    "typecheck: pass",
    "vitest: 636 passed / 0 failed / 47 files",
    "eslint: 0 errors / 17 warnings (all pre-existing, unmodified files)",
    "flakiness: no failures across two runs of the slowest suites (mcp-advanced ~108s, mcp-server ~54s, hook ~8s, deep-search ~2-7s)"
  ],
  "residualRisks": [
    "mcp-registry alias redirect description content is unasserted (§4.1) — concrete fix provided",
    "no negative test that non-SmartRead tool results are unguarded (§4.3) — concrete fix provided",
    "createIntentReadTool().name==='intent_read' not directly asserted (§4.2) — concrete fix provided",
    "tool-guidance.ts has no direct unit test (§4.4) — covered indirectly via hook + mcp-advanced; concrete fix provided",
    "MCP server tests ~9s/spawn; latent timing fragility under CI load (§6.3) — keepAlive mitigation documented in vitest.config.ts",
    "ESLint flat-config ordering bug (pre-existing) muddies lint output (§6.4)",
    "plan.md / progress.md do not exist at the requested paths; audit ran against working tree"
  ],
  "noStagedFiles": true,
  "notes": "Requested input files plan.md and progress.md were not found (ENOENT) at /Users/rhinesharar/Pi-SmartRead/Pi-SmartRead/. Audit was performed against the unstaged working-tree diff (git diff HEAD) and the untracked tool-guidance.ts. All proposed fixes are concrete snippets provided for a follow-up change task; none were applied per the read-only constraint."
}
```