# Probe gap analysis on frozen external-grep dev64 (2026-10-08)

Owner: probe-gap worker. Decision E12 context: on the frozen dev64 split
(128 title+body queries), Probe v0.6.0-rc341 scored 43/128 vs SmartRead
35/128 (E12 numbers are **unaudited**; this analysis does not re-audit them,
it explains the per-query gap). Dev split only; the holdout was never opened
(no `--open-holdout` in any command below; manifest file only read for ids).

**Reports used** (raw JSON under `~/.cache/pi-smartread-bench/reports/`):

- SmartRead: `external-grep-dev-2026-10-07T13-22-41-411Z-03d6427c.json`
- Probe: `external-grep-probe-dev-2026-10-07T13-31-42-602Z-c783b3e7.json`

**Reruns performed for this analysis** (all dev-only, `--offline`, same bare
clones + `materializeInstance` path as `scripts/eval/external/grep/run.ts`):

- `/tmp/probe-gap/diag.mts` (scratch copy at
  `.subagent-work/probe-gap-diag.mts`, gitignored, removed after use): for
  each of the 28 Probe-win queries, rebuilt the SmartRead BM25 corpus via
  `getSearchCorpus` with default ranking knobs and scored the **full**
  corpus, recording each gold file's corpus-wide rank, query-token coverage,
  and corpus membership. Knobs verified at runtime:
  `rankTestDemote=0.7, rankFilename=false, rankBm25k1=1.2, rankBm25b=0.75,
  rankCoverage=false, rankStopwords=false` (matches the comparator doc).
- A few single-shot `probe search` invocations on the same snapshots to
  check empty-result behaviour ( §2.5).

**Measured vs inferred legend:** `[measured]` = directly observed in a report,
rerun output, or source file read during this task. `[inferred]` = best
explanation consistent with the evidence, not directly verified. Counts:
28 Probe-only wins, 20 SmartRead-only wins, 15 both-succeed, 65
neither-succeeds (128 total) `[measured]` from the two report files.

Gold definition (shared by both reports): known-patch production files at
base commit; `rank` = 1-based file rank by first appearance in the system's
ranked list, `null` = absent from that list `[measured]` (`metrics.ts`).

## 1. Per-query tables

`SR` = SmartRead shown rank (top-20 shown cards) + corpus-wide BM25 rank from
the §2 rerun. `PR` = Probe rank within its ≤50 results. Top-5 lists are full
repo-relative paths.

### 1.1 Probe wins / SmartRead losses (28)

| # | Query | Gold file(s) | SR rank (shown / corpus) | SR top-5 | PR rank | Probe top-5 |
|---|---|---|---|---|---|---|
| 1 | `axios__axios-5085::body` — "AxiosHeaders get 'set-cookie' returns string instead of array" | `index.d.ts`; `lib/core/AxiosHeaders.js` | MISS / 38 ; 11 / 11 | parseHeaders, validator, karma.conf.cjs, adapters/xhr, helpers/toFormData | 3 ; null | utils, helpers/formDataToJSON, index.d.ts, adapters/http, helpers/AxiosURLSearchParams |
| 2 | `axios__axios-5919::body` — "Tests No Longer Passing since Upgrading to v1.5.0" | `lib/adapters/adapters.js`; `lib/defaults/index.js` | MISS / 21 ; 11 / 11 | karma.conf.cjs, lib/axios.js, adapters/xhr, core/Axios, adapters/http | null ; 3 | README.md, utils, defaults/index, adapters/http, core/AxiosError |
| 3 | `babel__babel-15445::body` — "[Bug]: generating source maps fails due to `sourcesContent` being undefined" | `packages/babel-generator/src/source-map.ts` | 12 / 12 | parser/util/missing-plugin-helper, config/files/import-meta-resolve, config/files/module-types, babel-eslint-parser worker configuration.cjs, transformation/file/merge-map | 3 | plugin-transform-classes transformClass, helper-create-class-features decorators, **source-map.ts**, proposal-decorators transformer-legacy, config/printer |
| 4 | `facebook__docusaurus-10130::title` — "Broken links checker: inconsistent trailing slash behavior" | `packages/docusaurus/src/server/brokenLinks.ts` | MISS / 23 | commands/build, utils-common/applyTrailingSlash, client/exports/Link.tsx, server/configValidation, client/exports/useBrokenLinks | 3 | utils-common/applyTrailingSlash, ssg, **brokenLinks**, plugin-content-docs/options, utils/i18nUtils |
| 5 | `mrdoob__three.js-25687::title` — "Serialization of PerspectiveCamera" | `src/core/Object3D.js`; `src/loaders/ObjectLoader.js` | MISS / 32 ; MISS / 29 | cameras/ArrayCamera, lights/SpotLightShadow, examples/jsm/utils/CameraUtils, cameras/CubeCamera, cameras/StereoCamera | 11 ; 2 | editor SetMaterialMapCommand, **ObjectLoader**, examples flow.module, textures/Source, editor/History |
| 6 | `mrdoob__three.js-27395::title` — "Class Sphere is missing property isSphere" | `src/math/Sphere.js` | 10 / 10 | core/BufferGeometry, core/UniformsGroup, materials/ShaderMaterial, textures/Source, helpers/Box3Helper | 2 | geometries/SphereGeometry, **math/Sphere**, core/BufferGeometry, manual webxr example ×2 |
| 7 | `preactjs__preact-2757::body` + 8. `::title` — "Setting the value of a progress element to 0 removes the attribute" | `src/diff/index.js` | body 7 / 7 ; title 14 / 14 | body: create-context, debug/check-props, diff/props, compat/render, compat/portals. title: config/codemod-strip-tdz, diff/children, create-context, diff/props, demo/todo | body 3 ; title 3 | body: index.d.ts, jsx.d.ts, **diff/index**, compat/portals, compat/index. title: jsx.d.ts, demo/todo, **diff/index**, index.d.ts, compat/render |
| 9 | `preactjs__preact-3010::body` — "Add support for bigint." | `src/diff/children.js`; `src/index.d.ts` | 7 / 7 ; 18 / 18 | benches/scripts/config, test/polyfills, benches/util, create-element, diff/props | null ; 3 | demo/profiler, hooks/index, **index.d.ts**, diff/index, benches/analyze |
| 10 | `preactjs__preact-3739::title` — "Setting state then undoing it on the same tick …" (111 chars) | `hooks/src/index.js` | 8 / 8 | options, hooks/index.d.ts, test-utils/index, diff/children, debug/debug | 4 | benches/util, hooks/index.d.ts, debug/internal.d.ts, **hooks/index**, benches/tracing.d.ts |
| 11 | `preactjs__preact-3763::body` — "setState callback is not executed when working with subscriptions on behaviorsubjects/observables" | `src/diff/index.js` | MISS / 33 | debug/debug, demo/nested-suspense/index, karma.conf, hooks/index, compat/suspense-list | 5 | scripts/release/create-gh-release, karma.conf, compat/portals, hooks/index, **diff/index** |
| 12 | `preactjs__preact-4182::body` — "useErrorBoundary causes double rendering of list item" | `src/diff/index.js` | 12 / 12 | demo/todo.jsx, demo/stateOrderBug.jsx, demo/reorder.jsx, demo/list.jsx, compat/index | 4 | hooks/index, diff/props, scripts/release/create-gh-release, **diff/index**, compat/index |
| 13 | `preactjs__preact-4316::title` — "onFocusIn and onFocusOut events incorrectly set" | `src/diff/props.js` | 11 / 11 | compat/test/browser/events.test.js, compat/render, diff/children, demo/style.scss, benches/tracing.d.ts | 3 | jsx.d.ts, compat/render, **diff/props**, CODE_OF_CONDUCT.md, demo/style.scss |
| 14 | `sveltejs__svelte-11104::body` — "Svelte 5: Bug - ReferenceError occurs when defining a snippet inside a script along with bind:value in SSR mode." | `…/3-transform/server/transform-server.js` | MISS / 142 | documentation/examples scatterplot data.js, svg-transitions shape.js, legacy/legacy-server, scripts/generate-version, src/version | 5 | compiler/2-analyze/css/css-prune, compiler/errors, internal/client/runtime, 1-parse/acorn, **transform-server** |
| 15 | `sveltejs__svelte-11367::title` — "Svelte 5 onclick error when handler uses store subscription" | `…/3-transform/client/utils.js` | MISS / 61 | store/public.d.ts, 4× tests/compiler-errors store *_config.js | 2 | tutorial/08-stores text.md, **transform/client/utils**, messages/compile-errors/script.md, docs template-syntax, svelte-5-preview event-handlers.md |
| 16 | `sveltejs__svelte-14494::body` + 17. `::title` — "Incorrect `Unused CSS selector` behavior" | `…/2-analyze/css/css-prune.js` | body MISS / 159 ; title MISS / 154 | body: version, internal/client/constants, easing/index, constants, internal/index. title: 5× tests/css/samples *_config.js | body 1 ; title 1 | body: **css-prune**, CHANGELOG-pre-5.md, +layout.svelte, docs faq, types/index.d.ts. title: **css-prune**, reactivity/props, svelte-html.d.ts, messages style.md, compiler/warnings |
| 18 | `sveltejs__svelte-9550::body` + 19. `::title` — "Svelte 5: select binding doesn't work for `null` option value" | `…/visitors/template.js`; `…/internal/client/render.js` | body MISS / 159, MISS / 161 ; title MISS / 153, MISS / 127 | body: version, generate-version, internal/client/block, constants, 1-parse/utils/bracket. title: 2× runtime-legacy binding-select *_config, legacy-server, 1-parse/read/options | body 4, 14 ; title 6, 3 | body: static svelte Selector.js ×2, **template**, bundler worker, … title: tutorial App.svelte ×2, **render**, static render, compiler worker |
| 20 | `vuejs__core-10101::title` — "Providing a computed prop to child breaks the reactivity of the computed" | `reactivity/computed.ts`; `reactivity/constants.ts`; `reactivity/effect.ts` | 11 / 11 ; MISS / 33 ; MISS / 68 | runtime-core/apiSetupHelpers, runtime-core/h, runtime-core/apiWatch, reactivity/effectScope, runtime-test/nodeOps | 2 ; null ; 1 | **effect**, **computed**, compiler-core/babelUtils, runtime-core/componentOptions, compiler-sfc resolveType |
| 21 | `vuejs__core-10141::title` — "Select `<option>` with array as value attribute causes hydration attribute mismatch (SSR)" | `runtime-core/hydration.ts` | MISS-shown / **9-corpus** | (none — 0 shown cards, regex routing) | 3 | components/Teleport, compiler-sfc cssVars, **hydration**, compiler-ssr ssrVModel, runtime-dom/nodeOps |
| 22 | `vuejs__core-11694::title` — "access a ref nested in reactive cause "Maximum call stack size exceeded"" | `reactivity/baseHandlers.ts`; `reactivity/dep.ts` | 10 / 10 ; MISS / 28 | runtime-core/scheduler, compiler-sfc definePropsDestructure, reactivity/__tests__/shallowReactive.spec, dts-test tsx.test-d.tsx, reactivity/collectionHandlers | 1 ; null | **baseHandlers**, runtime-core/compat/global, componentPublicInstance, compiler-ssr ssrCodegenTransform, compiler-core cacheStatic |
| 23 | `vuejs__core-11813::body` — "[3.5.0+] Previous values from computed are always undefined" | `reactivity/effect.ts` | 18 / 18 | shared/patchFlags, vue/__tests__/e2e/commits.mock, shared/shapeFlags, compiler-core/errors, reactivity/computed | 1 | **effect**, scripts/release, runtime-core Suspense, template-explorer index, runtime-dom vModel |
| 24 | `vuejs__core-11854::title` — "CSS nesting inserts attribute selector at every level" | `compiler-sfc/style/pluginScoped.ts` | 6 / 6 | runtime-dom/modules/style, compiler-core/options, template-explorer/theme, runtime-dom/nodeOps, shared/patchFlags | 5 | runtime-dom/apiCustomElement, runtime-core Teleport, vue/index, vue-compat/index, **pluginScoped** |
| 25 | `vuejs__core-8511::title` — "Can't use generic prop type when definition includes intersection with generic params?" | `compiler-sfc/script/resolveType.ts` | 19 / 19 | compiler-sfc defineProps, runtime-core/apiSetupHelpers, dts-test/appUse.test-d, runtime-dom/apiCustomElement, runtime-core/componentOptions | 4 | compiler-sfc importUsageCheck, compiler-sfc defineProps, runtime-core compatConfig, **resolveType**, scripts/build |
| 26 | `vuejs__core-8535::body` — "Vue 3 SFC Compiler function call with semicolon bug." | `compileScript.ts`; `script/context.ts`; `script/defineEmits.ts`; `script/defineProps.ts`; `script/definePropsDestructure.ts` | MISS / 24, 247, 269, 146, 81 | runtime-core/apiSetupHelpers, runtime-core/errorHandling, reactivity/effectScope, reactivity/ref, runtime-core/scheduler | 4, 12, null, 20, null | runtime-core Suspense, runtime-core/errorHandling, runtime-test/nodeOps, **compileScript**, runtime-core/hmr |
| 27 | `vuejs__core-8824::title` — "Unescaped character in CSS variable name when using css v-bind() during SSR dev" | `script/utils.ts`; `style/cssVars.ts` | MISS / 60 ; 6 / 6 | compiler-ssr ssrInjectCssVars, compiler-ssr/index, template-explorer/theme, shared/patchFlags, runtime-core/componentPublicInstance | null ; 1 | **cssVars**, compiler-ssr ssrInjectCssVars, runtime-core compatConfig, componentPublicInstance, compiler-core/utils |
| 28 | `vuejs__core-9532::title` — "Nuxt3 Entry.js tagName.toLowerCase() Error" | `runtime-core/hydration.ts` | 6 / 6 | runtime-dom/modules/props, runtime-core/compat/instanceListeners, runtime-test/patchProp, server-renderer ssrRenderAttrs, shared/makeMap | 1 | **hydration**, runtime-core/errorHandling, compiler-core/errors, compiler-sfc preprocessors, dts-test/defineComponent.test-d |

All ranks, top-5 lists, routings, and token counts in this table are
`[measured]` (report JSON + rerun stdout in `/tmp/probe-gap/diag-out.txt`).

### 1.2 SmartRead wins / Probe losses (20) — the reverse

| # | Query | Gold file(s) | SR rank | PR rank | Probe top-5 / note |
|---|---|---|---|---|---|
| 1 | `axios__axios-4731::body` — "Unexpected default `maxBodyLength` enforcement by `follow-redirects`" | `lib/adapters/http.js` | 1 | null | 4× examples index.html + … (misses) |
| 2 | `facebook__docusaurus-10130::body` (same instance as PW#4, body formulation) | `…/server/brokenLinks.ts` | 5 | null | .mdx guides + CONTRIBUTING (misses) |
| 3 | `facebook__docusaurus-9183::title` — "Allow case-insensitivity for code block language" | `theme-classic/options.ts` 5 ; `CodeBlock/Content/String.tsx` 3 | 5 / 3 | 6 / null | codeBlockUtils, theme-live-codeblock.d.ts, config.d.ts, … |
| 4 | `mrdoob__three.js-25687::body` (same instance as PW#5) | `Object3D.js` 5 ; `ObjectLoader.js` 19 | 5 / 19 | null / null | opentype.module, editor, lottie_canvas.module, FBXLoader, ArcballControls (misses) |
| 5 | `preactjs__preact-2927::body` — "element with `contentEditable=undefined` crashes …" | `src/diff/props.js` | 1 | 16 | index, portals, index.d.ts, component-stack … |
| 6 | `preactjs__preact-3062::title` — ""tabIndex" attribute is set to "0" instead of being removed" | `src/diff/props.js` | 4 | 10 | portals, profile.tsx, todo, jsx.d.ts, index |
| 7 | `preactjs__preact-3454::body` + 8. `::title` — "Incorrect translation of xlink:href attribute -> hhref" | `src/diff/props.js` | body 4 ; title 1 | body 8 ; title 6 | body: index, deopts, config, children, router. title: hydrate1k.html, animations.scss, spiral, index.scss, pythagoras |
| 9 | `preactjs__preact-3562::body` + 10. `::title` — "onInput and onChange doesn't work together since v10.5.0" | `compat/src/render.js` | body 3 ; title 2 | body 7 ; title 14 | portals, children, karma.conf, component-stack … |
| 11 | `preactjs__preact-3739::body` (same instance as PW#10) | `hooks/src/index.js` | 2 | null | CODE_OF_CONDUCT.md, CONTRIBUTING.md, index, index (misses) |
| 12 | `preactjs__preact-4152::body` — "`<div>{ new String('hi') }</div>` renders blank" | `src/diff/children.js` | 3 | null | index.jsx, index, profiler.jsx, tracing.d.ts, index (misses) |
| 13 | `sveltejs__svelte-10259::body` — "Svelte 5: Using `{:else}` with `{#each}` triggers a hydration error" | `internal/client/each.js` 3 (+ 4 null golds) | 3 | all null | **Probe returned 0 units (status ok)** |
| 14 | `sveltejs__svelte-14134::title` — "`#snippet` alter rendering behaviour of `text` inside `svg`" | `visitors/RegularElement.js` 2 (+ 2 null golds) | 2 | 22 | text.md tutorial first, then SvelteElement, utils … |
| 15 | `vuejs__core-10141::body` (same instance as PW#21) | `runtime-core/hydration.ts` | 2 | null | **Probe returned 0 units (status ok)** |
| 16 | `vuejs__core-11515::body` + 17. `::title` — "TransitionGroup hydration mismatch" | `compiler-ssr/…/ssrTransformTransitionGroup.ts` | body 2 ; title 1 | body 29 ; title 6 | body: Suspense, hydration, parser, stringifyStatic, global |
| 18 | `vuejs__core-8511::body` (same instance as PW#25) | `…/script/resolveType.ts` | 1 | null | **Probe returned 0 units (status ok)** |
| 19 | `vuejs__core-9507::title` — "withDefaults object variable results in non-tree-shakable component" | `defineProps.ts` 5 (+ 1 null gold) | 5 | 8 | index, vSlot, component, apiAsyncComponent, transformSlotOutlet |
| 20 | `vuejs__core-9572::title` — "Unexpected reactivity watching shallowReactive array" | `runtime-core/apiWatch.ts` | 4 | 12 | reactiveArray.bench, style, arrayInstrumentations, transformElement, watch.test-d |

`[measured]` from the two report files. Three Probe-zero-unit cases
(#13, #15, #18) feed the >256-token hypothesis in §2.5.

## 2. Why the gold is missed — per-case diagnosis

Headline rerun finding `[measured]`: **shown rank == full-corpus BM25 rank
in 27/28 Probe-win queries** (the exception is #21, a routing failure). The
gold is not lost to top-K truncation or card capping — it genuinely scores
below 5+ other files in SmartRead's file-level BM25. All gold files were
present in the corpus (`inCorpus=true` everywhere, including the
1000-file-capped svelte/docusaurus/babel snapshots).

Routing split `[measured]`: all 11 body queries ran
`smart/auto_declined_newline`; 16/17 title queries ran `smart/auto_literal`
(exact-literal hits prepended, then BM25+symbol RRF); #21 ran
`regex/auto_regex` with 0 hits.

### 2.1 Near-misses: gold at corpus rank 6–14 (12 queries)

#3 (babel, 12), #6 (Sphere, 10), #7-body (7), #9-children (7), #10 (8),
#12 (12), #13 (11), #1-AxiosHeaders (11), #2-defaults (11), #20-computed
(11), #22-baseHandlers (10), #24-pluginScoped (6). In each, 1–9 files
outscore gold; flipping any one mechanism (filename weight, stemming,
stopwords, coverage, test-exclusion) plausibly moves gold into top-5
`[inferred]` — but note the reverse table: SmartRead's own wins #5–#10, #17,
#19–#20 are *also* rank 6–16 gaps in Probe's favour, so near-miss churn cuts
both ways and any change must be validated against regressions, not just
these 12.

### 2.2 Filename signal (no path weight in SmartRead defaults)

SmartRead default: no filename/header tokens in the BM25 doc
(`rankFilename=false` `[measured]`); Probe prepends
`// Filename: <path>` to every ranked document `[measured]`
(`result_ranking.rs`). Cases where the gold filename directly carries query
terms and SmartRead still loses `[measured]`:

- #4 docusaurus: query "Broken links checker…" vs gold `brokenLinks.ts`
  (tokens broken+links), corpus rank 23. Probe rank 3.
- #16/#17 svelte-14494: query "…Unused CSS selector…" vs gold
  `css-prune.js` (token css), corpus rank 154/159 with coverage 0.71 on the
  title. Probe rank 1 both formulations.
- #6 three-27395: query "Class Sphere is missing property isSphere" vs gold
  `Sphere.js`, corpus rank 10 vs Probe 2.
- #27 vue-8824: gold `cssVars.ts` (css) — SmartRead already succeeds at 6,
  Probe ranks it 1; the sibling gold `script/utils.ts` (no filename signal)
  is at corpus 60 and Probe misses it entirely — a clean within-query
  contrast for filename weight `[measured]`.

`[inferred]` filename prepend is the single highest-leverage borrow for the
title-driven part of the gap (titles 24-vs-16; bodies tied 19–19).

### 2.3 Stemming (SmartRead has none; Probe stems everything)

SmartRead `tokenize` (`src/scoring.ts`): underscore/camelCase/numeric splits,
lowercase, dedup — **no stemming, no stopwords** `[measured]`. Probe
`tokenize` (`tokenization.rs` → `ranking::tokenize`): same splitting **plus
English Snowball stemming (`rust_stemmers`), English + programming stopword
removal, and decompound-with-vocabulary splitting** `[measured]` (source
reads; §3). Consequences `[measured]` + `[inferred]`:

- #5 three-25687 "Serialization of PerspectiveCamera": the operative code
  token is `serialize`/`deserialize` (ObjectLoader has 23 case-insensitive
  `serializ*|camera` lines `[measured]`); without stemming, query token
  `serialization` never matches `serialize`. Gold corpus ranks 29/32 vs
  Probe 2/11. Stemming is the most plausible differentiator `[inferred]`.
- #16/#17 svelte-14494: code speaks of `selectors` (plural; css-prune.js has
  156 `unused|selector` lines `[measured]`); query says `selector`. Same
  mechanism `[inferred]`.
- #20 vue-10101: query "reactivity of the computed" vs files built around
  `compute`/`ComputedRef`; Probe ranks effect.ts #1 / computed.ts #2 while
  SmartRead puts effect.ts at corpus 68 `[measured]`; stemming +
  stopword-dilution both point the same way `[inferred]`.

### 2.4 Test/spec/sample pollution (demote ×0.7 vs exclude)

SmartRead default demotes test/spec/fixture/`*.md` paths by 0.7
(`isTestOrDocPath`, `grep-ranking.ts`) `[measured]`; Probe **excludes**
test files and test blocks by default (no `--allow-tests` in the harness
`searchRule` `[measured]`, `allow_tests: bool` + `is_test_file` gating in
`file_processing.rs` `[measured]`). Cases where demoted-but-present
non-production files outrank gold `[measured]`:

- #19 svelte-9550::title: SmartRead top-5 = 2× `tests/runtime-legacy`
  binding-select samples + legacy-server + parse-options; golds at corpus
  153/127 despite coverage 0.82/1.00. Probe (tests excluded) ranks golds 6/3.
- #17 svelte-14494::title: SmartRead top-5 = 5× `tests/css/samples`
  `_config.js`; gold at 154. Probe #1.
- #15 svelte-11367::title: SmartRead top-5 = `store/public.d.ts` + 4×
  compiler-error store samples; gold at 61. Probe #2.
- #13 preact-4316::title: SmartRead #1 = `compat/test/browser/events.test.js`
  (a test file at full demoted weight still wins); gold at 11. Probe #3.
- #22 vue-11694::title: `__tests__/shallowReactive.spec.ts` sits at SR #3
  ahead of gold #10 `[measured]`.

### 2.5 Whole-file vs AST-block units (the far-miss class)

SmartRead BM25 scores **whole files** (`compileBm25Corpus(contents)`,
per-file hit at best-token-overlap line `[measured]`); Probe scores
**tree-sitter AST blocks** (functions/classes/methods get node-type boosts
up to 2.0×; file_processing.rs + result_ranking.rs `[measured]`) with BM25
length-norm `b=0.5` vs SmartRead's `b=0.75` (Probe comment: "moderately
reduced for balanced length normalization" `[measured]`). Far-miss
evidence `[measured]`:

- #14 svelte-11104::body: gold `transform-server.js` at corpus 142; SmartRead
  top-5 are tiny/single-topic files (`generate-version.js`, `version.js`,
  svg-example `data.js`) that match 1–2 frequent body tokens. Classic
  length-norm + whole-file dilution.
- #18 svelte-9550::body: same pattern (`version.js`, `generate-version.js`,
  `constants.js` on top; golds at 159/161).
- Conversely, Probe's block model demonstrably over-retrieves on long
  bodies: SW #13/#15/#18 show Probe returning **0 units with status ok** on
  body queries whose raw unique-token counts are 89–211
  (`[measured]` counts; bodies 2290–4435 chars). Plausible mechanism
  `[inferred]`: after Probe's own sub-token expansion the query exceeds the
  256-unique-token cap in `generate_query_token_map`, and `rank_documents`
  returns empty (`ranking.rs` — "Query exceeds the 256 unique token limit …
  return vec![]" `[measured]`). A rerun of two of those queries with
  title-length text returned results normally `[measured]`, consistent with
  a length/cap failure rather than a snapshot problem.

### 2.6 Routing failure: #21 `vuejs__core-10141::title`

`[measured]` SmartRead shows 0 cards with `regex/auto_regex` while its own
BM25 corpus ranks gold **9th**. Mechanism `[measured]` in
`decideGrepRouting` (`grep-tool.ts:631`): `COMPACT_GREP_REGEX =
/(\||\[|\{\d|\\[bBdDsSwW.]|\(\S+\))/` — the parenthesised aside `(SSR)` (no
inner whitespace, so `hasWhitespaceParenGroup` does not save it) routes the
entire 87-char NL title into regex mode, where the full title must match
contiguously → 0 hits and the BM25 cascade never runs. Probe ranks gold 3rd.
This is the cheapest win in the table (fallback or exemption, §4 C1).

### 2.7 What does NOT explain the gap (ruled out by the rerun)

- **Result truncation / top-K capping** — ruled out `[measured]`: shown rank
  == corpus rank in 27/28; golds at corpus 6–269 genuinely score there.
- **Corpus coverage / 1000-file cap** — ruled out `[measured]`:
  `inCorpus=true` for every gold file; the capped snapshots (1000 files)
  contain all their golds.
- **Test demotion hurting gold** — ruled out `[measured]`:
  `testOrDoc=false` for every gold file in the rerun.
- **Multi-word query handling as parse failure** — SmartRead has no query
  language (whole pattern → tokenizer), so nothing to fail `[measured]`;
  dilution (bodies of 57–423 tokens, coverages 0.24–0.56) is the operative
  effect, not a parsing bug.

## 3. Probe's mechanism (pinned source at v0.6.0-rc341)

All links are `https://github.com/probelabs/probe/blob/v0.6.0-rc341/…`
read during this task (`[measured]` = I fetched and quote the file; deeper
pipeline claims I did not read are marked).

- **Query parsing** — `src/search/elastic_query.rs` (`parse_query`):
  Elasticsearch-style AST (`Expr::{Term, And, Or}` with
  `required/excluded/exact/field`). Bare juxtaposed terms combine as
  **implicit OR** ("True Lucene/Elasticsearch semantics"); `AND` must be
  explicit; `+`/`-` prefixes mark required/excluded; `"quoted"` terms are
  exact (no tokenisation splitting, registered via `add_special_term`);
  `ext:`/`lang:`/`file:`/`dir:` filters and `Class::method` qualification.
  A verbatim issue title/body therefore parses as a big OR of its terms —
  nothing is required, anything matching scores. `[measured]`
- **Tokenisation** — `src/search/tokenization.rs` (~1000 lines) via
  `ranking::tokenize`: lowercase → camelCase/snake_case/numeric splits →
  **English Snowball stemming** (`rust_stemmers`, `get_stemmer`) →
  **ENGLISH_STOP_WORDS + PROGRAMMING_STOP_WORDS removal** → decompound
  against a baked vocabulary (`decompound` crate + precomputed splits) →
  special-case terms (`axios`, `oauth`, `graphql`, …) never split.
  `[measured]` (top-of-file constants and pipeline; full 100KB file
  skimmed via targeted extract).
- **BM25 variant** — `src/ranking.rs` (`rank_documents`,
  `rank_documents_simd` — SIMD is the default path): standard Okapi BM25
  with **`k1=1.5, b=0.5`** (code comments: deliberately moved from 1.2/0.75),
  IDF `ln(1 + (N−df+0.5)/(df+0.5))`, per-document score = boolean-AST
  evaluation over the query Expr (must-clauses exclude, should-clauses add;
  pure-OR queries need ≥1 match). Hard cap: **>256 unique query tokens →
  empty result** (`generate_query_token_map`). `[measured]`
- **Ranked documents = AST blocks + filename**: `src/search/result_ranking.rs`
  builds each doc as `"// Filename: <path>\n<code-block>"`, then applies
  **coverage boost** `1 + cov^1.5 × 2` (max 3× at full coverage) and
  **node-type boosts**: function/method 2.0×, class/struct/interface 1.8×,
  enum/trait 1.6×, module/namespace 1.4×, const/var/property 1.3×,
  multi-line doc comment 1.2×, export 1.1×, test-bearing nodes 0.7×,
  single-line comments 0.5×. Final sort is by boosted score. `[measured]`
  (full 21KB file read).
- **Block extraction** — `src/search/file_processing.rs`
  (`process_file_with_results`; uses
  `language::parse_file_for_code_blocks_with_tree` for tree-sitter AST
  blocks, with ±5-line merged fallback windows for uncovered lines;
  `filter_tokenized_block`/`filter_code_block_with_ast` gate blocks against
  the query AST; `allow_tests=false` skips test files and test functions).
  `[measured]` (signatures + gating logic from a 28KB extract; AST node
  tables per language not enumerated).
- **Result merging / pipeline** — `src/search/block_merging.rs`,
  `src/search/search_runner.rs` (ripgrep prefilter → block extraction →
  BM25 → merge), `src/search/early_ranker.rs`, `src/search/limits.rs`,
  `src/search/filters.rs` (default exclusion globs incl. tests without
  `--allow-tests`).-directory listing verified `[measured]`; internals
  **not** read `[inferred]` — cited only as the location of the merge step.
- **Harness-relevant defaults** (from `comparators/probe.ts` in-repo
  `[measured]`): formulation text verbatim as PATTERN, frequency
  tokenisation + stemming + BM25 at Probe defaults, `--max-results 50`, no
  `--allow-tests`. Binary pin `sha256:fd75278e…`.

**Licence** `[measured]`: the repo's `LICENSE` file at the tag is the full
text of the **Apache License 2.0**; the comparator doc records
"probelabs/probe, Apache-2.0". Discrepancy flagged: `Cargo.toml` at the same
tag declares `license = "MIT"`. Borrowing to date is mechanism-level only
(SmartRead's `grep-ranking.ts` header already attributes Probe's stopword
lists as Apache-2.0-adapted); no Probe code is vendored, so either licence
is satisfied, but any future verbatim port must carry the Apache-2.0 notice
per LICENSE §4. Licence review for this borrowing direction was already
accepted (`--accept-license-review`).

## 4. Ranked candidate changes for SmartRead

Ordered by expected dev64 gain per unit of risk. "Affected queries" names
the PW rows the hypothesis predicts; "risk" names the D46-dev-class and
neighbour-bench exposure to check before promotion. All require dev-only
iteration under the D57-style gates (E12-4); none is approved for
implementation by this analysis.

**C1. Regex-routing fallback for NL patterns (fixes #21 outright).**
Hypothesis: when `auto_regex` (or any regex-mode) run returns zero hits on
a pattern that is also a plausible NL query, fall back to the smart cascade
instead of returning empty. Affected: #21 (gold corpus rank 9 → success),
plus any D46/internal query with parenthesised asides (`(SSR)`, `(e.g. …)`
currently misrouted by `\(\S+\)`. Risk: minimal — fallback only fires on
zero-hit regex runs, so existing `exact_ish` regex successes are untouched;
`absence`-class tasks (correctly-empty answers) need a check that fallback
doesn't convert true empties into noise (it returns ranked results, so the
grader-visible change is bounded to previously-empty responses).

**C2. Filename/path tokens in the BM25 document (existing knob, default off).**
Hypothesis: enabling `PI_SMARTREAD_GREP_RANK_FILENAME` (prepend
`// Filename: <relPath>`, the exact Probe construction) recovers title
queries whose terms name the file (#4 brokenLinks, #6 Sphere.js, #16/#17
css-prune, #27 cssVars-positive-control). Affected: ~6–8 title rows. Risk:
filename terms can swamp content on generic names (`index.js`, `utils.js`,
`options.js` all appear as SR top-5 already); must measure D46 `exact_ish`
(where a distinctive content term currently wins) and `absence` classes for
new false positives, plus internal-44.

**C3. Exclude — not just demote — test/sample/docs from default NL corpora
(or a stronger demotion stage).** Hypothesis: the ×0.7 demotion leaves
test/sample files competitive (#13 events.test.js at SR #1; #15/#17/#19
sample-config sweeps; #22 spec file at #3). Probe excludes them and wins
exactly these rows. Affected: #13, #15, #17, #19, #22 (5 title rows).
Risk: the highest-risk item here — any D46/internal task whose gold is a
test, fixture, or doc file (e.g. a test-location family, if one exists)
goes from demoted to unfindable; requires a gold-path audit of D46 dev56 +
internal-44 before any exclusion, with per-family (not global) gating as
fallback.

**C4. English stemming in the shared tokenizer (query + corpus together).**
Hypothesis: Snowball-English stemming (Probe's choice) closes morphological
gaps — #5 serialization/serialize, #16/#17 selector/selectors, #20
computed/compute. Affected: #5, #16, #17, #20, possibly #11/#12 bodies.
Risk: stemming conflates code identifiers that are semantically distinct
(`test`/`testing`, `render`/`renderer`, short tokens); `exact_ish` D46 tasks
are the canary (precision loss shows there first). Implement behind a knob,
measure D46 dev56 + internal-44 + external dev64 jointly; do not ship on
external-dev64 movement alone.

**C5. Stopword filtering on for NL-shaped queries (existing knob, default
off).** Hypothesis: bodies of 100–423 tokens (#3: 423 tokens, coverage
0.24; #23: 230 tokens, coverage 0.32) are diluted by function words and
programming keywords that Probe drops; filtering concentrates IDF on
discriminative terms. Affected: body rows #1, #2, #3, #11, #14, #23, #26.
Risk: the programming list removes `type`/`class`/`function`/`map`, which
are load-bearing in titles like #6 ("Class Sphere…") and #26 ("function
call with semicolon"); needs the D46 title-heavy `exact_ish` slice as gate,
and interaction testing with C2 (filename terms must not be stopworded).

**C6. Coverage boost + lower length-norm (Probe BM25 profile as one
experimental preset).** Hypothesis: `coverageBoost` (already implemented as
a knob, off) plus `b: 0.75 → 0.5` counters whole-file dilution where gold
has high token coverage but modest TF (#19 render.js coverage 1.00 at rank
127; #14/#18 tiny-file top hits). Affected: far-miss svelte rows #14, #18,
#19-body. Risk: coverage rewards long files matching many common tokens
(the reverse of the intended effect on bodies); `b` changes every score in
every class — broadest blast radius of the six, so gate on the full
dev-only battery (D46 dev56, internal-44, external dev64) and promote only
as a bundle if the bundle (not a single knob) moves the needle.

What is deliberately **not** proposed: AST-block result units (Probe's
biggest architectural difference) — it changes snippets, evidence spans,
and the SmartEdit contract, i.e. a project-scale intervention that E2/E6
gates behind benchmark evidence this analysis does not provide; and
verbatim ports of Probe source (licence §4 notice burden; mechanisms only).

## Appendix: method notes and limits

- Engine drift: the rerun used the current branch's SmartRead sources, not
  the `sha256:5a3e5c28…` engine from the frozen report; ranking knobs are
  identical and the rerun's shown-order matches the report's `rankedFiles`
  exactly where comparable, but per-query scores are not claimed
  bit-identical `[measured: knob equality; inferred: score equality]`.
- Probe's 15 errored queries (mostly svelte snapshots) count as failures in
  both the E12 tally and this analysis; root cause (timeout vs binary
  failure — stderr not captured) remains open per the comparator doc.
- `vuejs__core-10141::title` is counted in the 28 (Probe success vs
  SmartRead regex-zero); the rerun shows SmartRead BM25 alone would have
  ranked gold 9th, i.e. this row is a routing loss, not a ranking loss.
- No holdout data was accessed; all instance ids above are dev-split rows
  from the frozen manifest's dev selection.
