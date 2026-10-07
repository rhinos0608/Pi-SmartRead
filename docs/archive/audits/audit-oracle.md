# Audit Oracle — Design Review

Inherited decisions:
- Baseline: `npm run typecheck` pass, `npm test` pass. `eslint` already fails on config/no-var/test-project issues.
- Existing public API heavily names `intent_read`; docs, tests, Smart-Edit notes, research specs depend on it.
- Earlier design consolidated deep search into `search mode="deep"`; current diff reverses to first-class `deep_search`.
- Tool-consolidation goal: reduce tool-choice overhead without losing capabilities.
- Context hygiene goal: stale read/search context gets masked after mutations. Doom-loop goal: warn + suggest valid escape tools.
- MCP resources exist, but `smartread://result/*` has no resolver/storage yet.

Diagnosis:
- Direction partly sound: `deep_search` as first-class tool can improve discoverability for complex multi-channel search.
- Current diff mixes three API decisions: `search mode=deep` removal, `intent_read` rename to `semantic_read`, symbol-tool consolidation. These need separate compatibility choices.
- `docs/tool-consolidation-plan.md` has false premise: `workspace_symbol` and `hover_type` are not ghost tools; `find-symbol-tool.ts` currently defines/registers them in HEAD. Diff deletes real capabilities while tests only stop expecting them.
- MCP shape not fully updated: tests do not assert `deep_search`; `mcp-server.ts` comments still say `intent_read` and `search ... deep`; package `files` omits `deep-search-tool.ts`.
- Resource-link helper remains aspirational. MCP server stringifies non-text items and `resolveResource()` cannot read `smartread://result/*`.
- Hygiene/doom-loop drift: new tool names not fully wired. `semantic_read` placeholder added, but stale masking excludes it. `deep_search` excluded too. Doom suggestions still keyed by `intent_read`; `deep_search` suggests invalid `search mode 'resolve'`.

Drift / contradiction check:
- `intent_read` → `semantic_read`: CHANGE. This is API-breaking and not backed by inherited decision. Keep `intent_read` or register `semantic_read` as alias with deprecation plan.
- `search mode=deep` removal: CHANGE. If first-class `deep_search` proceeds, keep `search mode=deep` compatibility for at least one release or emit clear deprecation error. Current removal silently breaks callers/docs.
- Symbol consolidation: DEFER/CHANGE. Do not delete `workspace_symbol`/`hover_type` as "ghost". Either add `symbol_info` actions for `workspace` and `hover`, or keep old tools as aliases during measurement.
- MCP resources: DEFER result-resource expansion. Do not start returning `resource_link` from tools until MCP server preserves resource_link content and resolver stores/serves `smartread://result/*`.
- Context hygiene: CHANGE before claiming coverage. Add `read_files`, `semantic_read`/`intent_read`, `deep_search` to maskable tools; classify search/deep_search as `search-context`; design result-file resource extraction.
- Doom-loop: CHANGE. Rename suggestion key to actual registered tool(s), keep alias if both exist, replace invalid `search mode 'resolve'` with `find_symbol` or `symbol_info`.

Recommendation:
- Verdict: CHANGE before workers make broad edits.
- Proceed only with narrow, compatibility-safe path:
  1. Register `deep_search`, but keep `search mode=deep` as wrapper/deprecated alias.
  2. Keep `intent_read` public name, or register both `intent_read` and `semantic_read` aliases. Prefer no rename in this audit.
  3. Preserve `workspace_symbol` and `hover_type` capability via aliases or `symbol_info` actions before deleting old names.
  4. Add `deep-search-tool.ts` to `package.json files`; add tests asserting `deep_search` appears in Pi + MCP registries.
  5. Do not use `maybeResourceLink` for large tool results until result-resource backing store exists.
  6. Patch hygiene/doom-loop tables after tool-name decision, not before.

Verdicts:
- `deep_search` first-class tool: PROCEED WITH COMPAT. Good UX, but keep `search mode=deep` bridge.
- `search` modes reduced to `grep|code`: CHANGE. Needs compatibility/deprecation.
- `semantic_read` rename: DEFER/REJECT for now. Public API churn too high; use alias only if wanted.
- `symbol_info` dispatcher: PROCEED ONLY AFTER preserving `workspace_symbol`/`hover_type`. Current plan loses features.
- MCP registry tool count/shape: CHANGE. Tests/package/docs need update; experimental double-registration risk remains if config enabled.
- MCP resource links: DEFER. Helper shape incomplete server-side.
- Hygiene mechanisms: CHANGE. Current name updates incomplete; search-result resource tracking still weak.
- Doom-loop suggestions: CHANGE. Several suggestions point at renamed or nonexistent modes.

Risks:
- External callers using `intent_read`, `search mode=deep`, `workspace_symbol`, or `hover_type` break silently.
- Published package lacks `deep-search-tool.ts`; MCP import can fail after publish.
- Tests pass while missing actual API regression because expectations were weakened.
- Stale-context system gives false confidence for `deep_search`/semantic reads because records lack result-file resources.
- Resource links can become unreadable JSON blobs if tools start using `maybeResourceLink` now.

Need from main agent:
- Decide public API policy: no breaking renames, aliases with deprecation, or hard break.
- Decide whether `workspace_symbol` and `hover_type` remain public capabilities.
- Decide whether `deep_search` is additive alias or replacement for `search mode=deep`.

Suggested execution prompt:
Worker warranted after decisions above. Prompt:
"Make compatibility-safe consolidation fixes only. Add first-class `deep_search` while preserving `search mode=deep` wrapper. Keep/register `intent_read` alias unless supervisor explicitly approves rename. Preserve `workspace_symbol` and `hover_type` via aliases or `symbol_info` actions. Update package files, MCP/Pi registry tests to assert `deep_search`, docs/comments. Do not enable `resource_link` for tool results. Update hygiene/doom-loop tool-name tables after aliases exist. Run typecheck + targeted tests."
