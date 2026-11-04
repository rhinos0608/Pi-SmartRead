# C1 regex-routing fallback — implementation + dev-guard results (2026-10-08)

Decision: E14(a) (`2026-10-07-tool-ergonomics-decision-log.md`). Analysis: #21 and
candidate C1 in `2026-10-08-probe-gap-analysis.md` (routing cause: `grep-tool.ts:693`
in the old numbering — `COMPACT_GREP_REGEX` routes an NL title with a
parenthesised aside such as `(SSR)` into regex mode, where the full title must
match contiguously → 0 hits, BM25 cascade never runs).

## Change (test-first, defect fix — not a ranking knob)

When **auto-detected** regex mode (routing reason `auto_regex`) returns zero
hits and the pattern is plausibly natural language (≥2 whitespace-separated
words), grep now runs the smart cascade and reports one line:
`regex auto-route found nothing; showing smart-cascade results.`
(`GrepRouting.reason = "auto_regex_fallback"`.)

- Explicit `regex:true` (`forced_regex`) and `literal:true` never fall back.
- Single-token compact patterns (e.g. `zzz.*qqq`) never fall back.
- `PATTERN_DESCRIPTION` / `GREP_DESCRIPTION` updated in the same change
  (README/AGENTS contain no routing text, so nothing to update there).

Owned files: `src/search/grep-tool.ts` (+ fallback, `isPlausiblyNaturalLanguage`
helper, description wording), `src/search/grep-cascade.ts` (+
`auto_regex_fallback` reason), `test/unit/search/grep-regex-routing.test.ts`
(+4 tests: fallback fires; `regex:true`/`literal:true` never fall back;
single-token regex never falls back).

## Test evidence (red → green)

New fallback test failed before the fix (`expected 'regex' to be 'smart'`) and
passes after. After the fix: `test/unit/search/` 35 files / 440 tests pass.
`npm run typecheck` is clean for the owned files; the only 2 errors repo-wide
are pre-existing in a sibling worker's untracked `scripts/eval/teb/run.ts`
(`TebInfraFailure` assignment — untouched by this change, no shared symbols).

## Dev-guard results (judge off, dev splits only — holdout never opened)

| Guard | Command | Baseline (branch `ccbb39c`, from guard-baseline doc) | With C1 | Δ |
|---|---|---|---|---|
| D46 dev | `npx tsx scripts/eval/d46/run.ts --split dev --config off` | 24/48, recall .420, MRR .356, false-empty 2 | 25/48, recall .441, MRR .374, false-empty 0 | +1, no losses |
| Internal-44 | `npx tsx scripts/eval/judge/grep-e2e.ts --config off` | file-hit 20/35, goldR 5/78, declared 5/36, evaluable 5/35, abst 0/8 | identical | 0 |
| External dev64 titles+bodies | `npx tsx scripts/eval/external/grep/run.ts --manifest ~/.cache/pi-smartread-bench/manifests/external-grep-dev64-holdout32.json --split dev --accept-license-review --offline` | 35/128, recall .211, MRR .158 | 36/128, recall .219, MRR .163 | +1, no losses |

Report paths (all under `/Users/rhinesharar/.cache/pi-smartread-bench/` unless noted):
- D46 mine: `reports/d46-dev-off-2026-10-07T14-28-39-910Z-f735bfc2.json`
  (baseline: `reports/d46-dev-off-2026-10-07T12-35-17-227Z-835ae147.json`)
- Internal mine: `~/.cache/pi-smartread-judge-spike/bench/grep-e2e/grep-e2e-off-2026-10-07T14-28-45-815Z-p71736.json`
- External mine: `reports/external-grep-dev-2026-10-07T14-35-37-294Z-d35b2c82.json`
  (baseline: `reports/external-grep-dev-2026-10-07T12-42-08-765Z-5fba8550.json`)

## Per-query flips (paired outcome comparison, 128/128 + 56/56 matched)

Gained (3, lost 0):
1. `sveltejs__svelte-11096::title` — 0 cards → 20 cards, gold
   `css-prune.js` null → rank 2, success false → true. Parenthesised-aside NL
   title now served by the cascade.
2. `honojs-hono-dev-024` (D46 exact_ish) — NL question embedding the regex
   literal `/^(GET|HEAD|OPTIONS)$/` previously auto-routed to regex and came
   back empty (one of the 2 exact_ish false-empties); now falls back, gold
   `src/middleware/csrf/index.ts` at #1, success false → true. D46 false-empty
   2 → 0, `absence` class untouched (falseContent 8, abstention 0/8 — same as
   baseline, so the fallback does not convert true empties into noise on this set).
3. `vuejs__core-10141::title` (#21, the motivating case) — routing fixed
   (0 cards `regex/auto_regex` → 20 cards `smart/auto_regex_fallback`) but
   gold `hydration.ts` sits at rank 9, still outside top-5: success stays
   false. This row is now a ranking gap (filename/stemming territory, C2–C4),
   no longer a routing loss — exactly the split the gap analysis predicted.

Lost: none on any guard.

## Residual risks

- The ≥2-word NL heuristic can fire on genuinely-intended regex with spaces
  that matches nothing (e.g. `foo|bar baz` as a real pattern). Such queries
  previously returned empty; now they return cascade results with the fallback
  line shown. Users who mean regex use `regex:true`, which never falls back.
- `absence`-class safety is shown only on D46's 8 tasks; the TEB negative
  controls (E6) remain the stronger gate before any broader claim.
