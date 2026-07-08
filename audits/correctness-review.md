# Correctness / Regression Review — Uncommitted Changes

**Scope:** Review of uncommitted (working-tree) changes for correctness/regression bugs across tool registration, MCP server, context hygiene/application, bash guard, doom-loop, hook, and intent-read. Per instructions, uncommitted changes are treated as user-owned — **no project/source files were modified.** This is an evidence-only review.

**Note:** `plan.md` and `progress.md` were not present at the requested paths (`/Users/hinesharar/Pi-SmartRead/Pi-SmartRead/plan.md`, `…/progress.md`); the review proceeded against the working-tree diff and HEAD baseline.

---

## Validation baseline

| Check | Command | Result |
|---|---|---|
| Type-check | `npx tsc --noEmit` | passed (no output) |
| Unit tests | `npx vitest run` | 637 passed, 0 failed (47 files) |
| Staged files | `git diff --cached --stat` / `git status --porcelain` | none staged |

Working-tree diff (`git diff --stat`): 17 modified files + 1 untracked (`tool-guidance.ts`). All changes are unstaged/untracked (user-owned).

---

## Findings

### Finding 1 — `repo_map` staleness placeholder is unreachable dead code (Severity: MEDIUM)

**What was added (uncommitted):**
- `context-hygiene.ts:260-262` — new `renderStaleRepoMapPlaceholder()`.
- `context-hygiene.ts:285-286` — new `case "repo_map": return renderStaleRepoMapPlaceholder();` in `renderStaleContextPlaceholder`.
- `context-application.ts:45` — `"repo_map"` added to `MASKABLE_STALE_TOOLS`.
- `test/unit/context-application.test.ts:320-366` — new `it.each` test asserting a synthesized `repo_map` stale record is masked.

**Why it is dead / non-functional in production:**

The context-hygiene staleness pipeline only produces a stale record when (a) a prior *read-context* event and (b) a later *mutation* event share the **same resource key** (`generateReport()`, `context-hygiene.ts:414-471`). Resource extraction is done by `resourcesForTool`:

```
index.ts:88-94  function resourcesForTool(_toolName, input) {
  const path = input.path; if (path) return [buildFileResource(path)];
  if (input.filePath) ...; if (input.relative_path) ...;
  return [];                       // <-- repo_map lands here
}
```

`repo_map`'s parameters are `directory` and `focus` (`repomap-tool.ts:23,36`); it has **no** `path`/`filePath`/`relative_path`. Therefore every `repo_map` result is recorded with `resources: []` (`index.ts:152-157`), is never placed into any resource bucket (`context-hygiene.ts:414-423`), and can **never** appear as a stale candidate. The new placeholder, case branch, and mask-set entry are consequently unreachable at runtime.

There is a second, independent reason it cannot fire even if resources were captured: mutations are recorded as `file:<path>` resources (`mutationResourcesForTool`, `index.ts:96-107` → `buildFileResource`). A repo_map resource keyed on a directory would not match a per-file write/edit mutation key, so a file write would never invalidate a prior repo_map result. Making the feature functional requires modelling a shared "repo-structure" resource on both repo_map reads and write/edit mutations — not just the surface additions in this diff.

**Test gives false confidence:** The added test (`context-application.test.ts:320-366`) hand-builds `staleCandidates` with `buildStaleContextRecord({ originalTool: "repo_map", … })` and only asserts the masking/rendering layer emits text containing "Stale". It bypasses the production `resourcesForTool → record → generateReport` path, so it passes while the end-to-end feature does not work.

**Minimal fix (not applied — user-owned changes):**
- In `resourcesForTool`, capture `directory` (and/or `focus` files) for `repo_map` and emit a repo-structure resource; **and**
- In `mutationResourcesForTool`, have `write`/`edit` (and `graph_mutate`) also emit a repo-structure resource (or the repo root) so structural mutations invalidate prior `repo_map` reads.
- Add an integration test that drives the real `record()` → `generateReport()` path (a `repo_map` result followed by a `write` to a repo file) and asserts a stale `repo_map` placeholder is produced — rather than synthesizing the report.

**Validation:** `tsc --noEmit` clean; `vitest run` 637 pass. The dead code does not break the build or tests; it silently never executes.

---

### Finding 2 — Context-hygiene staleness only reaches tools with a scalar `path` resource; mask set overstates coverage (Severity: LOW / accuracy gap)

**Evidence:**
- `resourcesForTool` (`index.ts:88-94`) extracts **only** top-level scalar `path` / `filePath` / `relative_path`.
- Tools using **array** params record no resources and can never become stale:
  - `read_files` → `files: Type.Array(...)` (`read-many.ts:49-51`) — no top-level `path`.
  - `intent_read` → `query` + `files[]`/`directory` (`intent-read.ts:46-57`) — no top-level `path`.
- Tools using `query`/`directory`/`focus` record no resources: `search`/`deep_search` (`query`, `directory`), `find_symbol` (`query`), `repo_map` (`directory`, `focus`).
- Only `read` (`path`) and `symbol_info` action=`outline` (`path`) actually emit a resource that can match a `file:<path>` mutation.

**What this diff changed:** `context-application.ts:33-47` expanded `MASKABLE_STALE_TOOLS` to include `read_files`, `intent_read`, `semantic_read`, `deep_search`, `find_symbol`, `symbol_info`, `workspace_symbol`, `hover_type`, `repo_map`. Because those tools (except `symbol_info` outline) never produce stale records (Finding 1's root cause), the new entries are **inert** — not a runtime crash, but they overstate the feature's coverage, and the `it.each` test masks the gap by synthesizing reports.

**Severity rationale:** Low. No incorrect behavior is introduced (an empty intersection of stale records and maskable entries is a harmless no-op). The issue is accuracy/confidence: the diff and tests imply broader staleness coverage than the resource model actually delivers.

**Minimal fix (not applied):** Extend `resourcesForTool` to extract per-file resources from `files[]` arrays (read_files, intent_read) and `directory`/`focus` for directory-scoped tools, so multi-file and directory reads can be invalidated by writes to their constituent files.

**Validation:** `tsc --noEmit` clean; `vitest run` 637 pass. No regression in behavior; coverage claim is overstated.

---

### Verified OK (no regression)

- **`intent_read` rename + `semantic_read` alias:** `intent-read.ts:185-186` renamed tool to `intent_read`; `mcp-registry.ts:49-50` registers `intent_read` and aliases `semantic_read → intent_read` (shares execute/inputSchema). Backwards-compatible. All downstream references (bash guard profiles `bash-context-guard.ts:38-39`, mask set `context-application.ts:36-37`, hygiene cases `context-hygiene.ts:278-279`, guard set `index.ts:61-62`, doom-loop suggestions `doom-loop-suggestions.ts`) were updated to canonical `intent_read`. `test/unit/index.test.ts:34-35` confirms both names are registered. ✓
- **Doom-loop `grep` suggestions removal:** `grep` is not a registered tool (registry has `search` with internal `mode:"grep"`, `search-tool.ts:599`); `SUGGESTIONS["grep"]` could never be keyed by a tool call. Removal is correct dead-code cleanup; `doom-loop.test.ts` asserts `SUGGESTIONS["grep"]` is undefined. ✓
- **`alias` description change (`mcp-registry.ts:40-44`):** Aliases now emit a short deprecation redirect instead of copying the canonical description. MCP tests assert only that descriptions are strings (`mcp-server.test.ts:179-180`), so no regression. `semantic_read`/`workspace_symbol`/`hover_type` aliases still dispatch to their targets correctly. ✓
- **README alias note (`README.md:234-235`):** States `workspace_symbol → find_symbol` and `hover_type → symbol_info`, which matches `mcp-registry.ts:57-58`. ✓ (Pre-existing caveat, not introduced here: `symbol_info` has actions `outline`/`declaration`/`references`/`implementations` only — `find-symbol-tool.ts:926-948` — so the `hover_type → symbol_info` alias cannot perform original hover semantics; the alias target was already `symbol_info` at HEAD, so this is a pre-existing limitation, not a new regression.)
- **Bash context guard refactor (`index.ts:213-256`, `bash-context-guard.ts:268-296`):** `SMARTREAD_GUARD_TOOLS` hoisted to module scope and expanded; `toolName` now flows into `applyBashContextGuard` → `renderPreview`, which selects `GUARD_HINT_DEEP_SEARCH` for `deep_search` and `GUARD_HINT_GENERIC` otherwise (`bash-context-guard.ts:218`). The removed `GUARD_HINT_RE` regex replace was a no-op for the previously-guarded `search`/`read` (which already emitted `GUARD_HINT_GENERIC`). New profiles added for all retrieval tools (`bash-context-guard.ts:34-44`); missing profiles fall back to `default`. `test/unit/index.test.ts` "guards large deep_search tool results" validates the deep_search hint path. ✓
- **`recordMutation` `tool` option (`context-hygiene.ts:342,372,386,402` + `index.ts:150`):** `write`/`edit` now record mutations with the correct tool name (`options.tool ?? "graph_mutate"`), validated by `test/unit/index.test.ts` "marks read context stale after write results mutate the same file". ✓
- **Hook unconditional tool-guide injection (`hook.ts:255-257`):** Early-return removed; tool guide is injected on the first turn only (guarded by `repoMapInjectedThisSession`, `hook.ts:242-243`), even when no map/git/microagents exist — matches the documented "Startup tool guidance + repo map injection" behavior. `renderSmartReadToolGuide()` handles `undefined` task (`tool-guidance.ts`). ✓
- **MCP prompt `smartread-tool-guide` (`mcp-prompts.ts:70-80`, `mcp-server.ts:190-202`, `tool-guidance.ts`):** Wired into the prompt handler; `mcp-advanced.test.ts` confirms prompt count is 4 and the prompt returns guidance. Handler is lenient on missing `task`. ✓

---

## Residual risks

1. **`hover_type` alias is functionally a stub (pre-existing):** `hover_type → symbol_info` (`mcp-registry.ts:58`) shares `symbol_info`'s execute/inputSchema, but `symbol_info` has no `hover` action (`find-symbol-tool.ts:926-948`); a legacy caller passing old `hover_type` params will hit `SymbolInfoSchema` validation / "Unknown action". Not introduced by this diff (target was already `symbol_info` at HEAD), but the new deprecation description ("Use symbol_info instead") steers users to a tool that cannot satisfy the original intent. Worth tracking separately.
2. **`git_notes_read` in `SMARTREAD_GUARD_TOOLS` (`index.ts:64`):** experimental/disabled by default; no dedicated guard profile → falls back to `default`. Harmless, but if git-notes is enabled its output will be guarded with the generic profile. No correctness impact.
3. **Stale-detection coverage is narrower than the mask set implies** (Finding 2): multi-file/array/directory-scoped retrieval tools cannot be marked stale under the current resource model. Any future feature relying on stale masking for `read_files`/`intent_read`/`search`/`deep_search`/`repo_map` will silently no-op until `resourcesForTool` is extended.

---

## Acceptance report

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Review-only task completed without widening scope: no project/source files were modified. Only the deliverable audit file (audit/correctness-review.md) was written. Findings are scoped to the requested areas (tool registration, MCP server, context hygiene/application, bash guard, doom-loop, hook, intent-read)."
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "Each finding cites file:line evidence, severity, minimal fix, and validation status (tsc + vitest). Baseline validation commands and outputs are recorded. Verified-OK section documents the non-regressing areas with evidence. Residual risks enumerated."
    }
  ],
  "changedFiles": [
    "audit/correctness-review.md (created — review deliverable only; no project/source files modified)"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "git diff --stat",
      "result": "passed",
      "summary": "17 modified files + 1 untracked (tool-guidance.ts); all unstaged/untracked"
    },
    {
      "command": "git diff --cached --stat && git status --porcelain | grep '^A '",
      "result": "passed",
      "summary": "No staged files"
    },
    {
      "command": "npx tsc --noEmit",
      "result": "passed",
      "summary": "Type-check clean, no output"
    },
    {
      "command": "npx vitest run",
      "result": "passed",
      "summary": "637 tests passed, 0 failed across 47 files (112.4s)"
    },
    {
      "command": "npx vitest run test/unit/index.test.ts -t 'marks read context stale'",
      "result": "passed",
      "summary": "Targeted test passes (confirms write/edit mutation tracking via recordMutation tool option)"
    }
  ],
  "validationOutput": [
    "tsc --noEmit: no diagnostics",
    "vitest: Test Files 47 passed (47); Tests 637 passed (637); Duration 112.41s",
    "Finding 1 (repo_map staleness dead code): confirmed unreachable via index.ts:88-94 + repomap-tool.ts:23,36 + context-hygiene.ts:414-471",
    "Finding 2 (mask set overstates coverage): confirmed via index.ts:88-94 + read-many.ts:49-51 + intent-read.ts:46-57",
    "Verified-OK: intent_read rename/semantic_read alias, doom-loop grep removal, alias description change, bash guard refactor, recordMutation tool option, hook tool-guide injection, MCP smartread-tool-guide prompt"
  ],
  "residualRisks": [
    "hover_type -> symbol_info alias is a functional stub (pre-existing, not introduced here); symbol_info has no hover action (find-symbol-tool.ts:926-948)",
    "git_notes_read guarded with default profile when experimental notes enabled (index.ts:64)",
    "Staleness masking silently no-ops for multi-file/array/directory-scoped tools until resourcesForTool is extended (Finding 2)"
  ],
  "noStagedFiles": true,
  "notes": "plan.md/progress.md were absent at the requested paths; review used the working-tree diff vs HEAD as the source of truth. Two findings raised: (1) MEDIUM — repo_map staleness placeholder/case/mask-entry are unreachable dead code, with a test that bypasses the production detection path and thus gives false confidence; (2) LOW — context-hygiene staleness only reaches scalar-path tools, so the expanded MASKABLE_STALE_TOOLS is mostly inert. No source files were modified per instructions; fixes are described as minimal-fix recommendations for the user to apply."
}
```