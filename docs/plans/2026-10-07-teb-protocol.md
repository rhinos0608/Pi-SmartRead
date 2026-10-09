# Tool Ergonomics Bench (TEB) — preregistration protocol

Status: preregistered 2026-10-07, revised 2026-10-07 (oracle review —
all 10 REQUIRED items applied; see Revision log §15).
Pilot-calibrated gates (marked `[FROZEN]`) are filled after the pilot and
frozen before any dev run; they are never relaxed after the holdout is
opened. One sealed-holdout opening for one predeclared champion (E6).

Binding inputs: E6 + E7 in `2026-10-07-tool-ergonomics-decision-log.md`;
oracle plan `335b14b6`; oracle review `546a8391` (required items R1–R10).
Reusable bootstrap/metrics: `scripts/eval/d46/{schema,score}.ts`
(quota/validator pattern, pure per-query scorer + aggregates),
`scripts/eval/judge/{ir-metrics,grep-e2e-metrics}.ts` (recallAtK, ndcgAtK,
reciprocalRank, read-ready predicates — import, do not copy).
Harness lessons: `2026-10-05-agent-evaluation-harness-notes.md`
(isolation flags, paired alternation, `message_end` usage accounting,
transcript streaming, infra-failure exclusion).
Pi CLI contract: `@earendil-works/pi-coding-agent/docs/{cli,json}.md`
(flag spellings verified against installed `pi --help` on 2026-10-07).
Pi message contract: `docs/message-types.md` (AssistantMessage fields,
usage semantics). Pi docs contain no `--seed` flag (`cli.md:53–75`
covers model/session options without seeding) — replicates are
independently launched processes (§9.3).

## 1. Corpus (verified 2026-10-07, results recorded here)

Manifest: `~/.cache/pi-smartread-bench/teb/repos.json` (version 1).
Checkouts: `~/.cache/pi-smartread-bench/teb/repos/<owner>__<name>`
(shallow, grafted, detached HEAD carrying the tag).

| Repo | Tag → commit (full sha in repos.json) | Licence (file sha in repos.json) | .ts files / LOC | Size |
|---|---|---|---|---|
| reactivex/rxjs | 7.8.2 → `e5351d0…` | Apache-2.0 | 759 / 101,783 | 23M |
| prettier/prettier | 3.9.9 → `cdd17f2…` | MIT | 665 / 14,638 (src is 528 .js + 7 .ts) | 62M |
| withastro/astro | astro@7.3.6 → `e4f8f46…` | MIT | 2,236 / 252,605 | 92M |
| TanStack/query | v5.90.3 → `4d8da1e…` | MIT | 500 / 40,451 | 47M |
| egoist/tsup | v8.5.1 → `1ecb6a5…` | MIT | 46 / 6,616 | 964K |
| drizzle-team/drizzle-orm | 0.44.7 → `11ff664…` | Apache-2.0 | 937 / 440,657 | 30M |

Disjointness: all six are disjoint from the 10 D46 repos (zod, vite,
fastify, p-queue, TypeScript, eslint, redux, vitest, hono, commander.js)
and the external-grep repo groups (axios, express, dayjs, insomnia,
svelte, darkreader, material-ui, vue core, preact, three.js, babel,
docusaurus, immutable-js). Full lists in `repos.json` under `disjointFrom`.

Repository snapshot provenance (R10): `repos.json` stores per repo the
full commit sha, tag, licence file + sha256, ts-file count, LOC, working
size, `nodeModulesInstalled: false`, corpus notes, and probe records.
Label-time snapshot hash (`git rev-parse HEAD` + `git status --porcelain`,
must be clean) is recorded in each split's sealing manifest. Licence
terms permit benchmark artifact retention (MIT ×4, Apache-2.0 ×2; no
redistribution of repo contents — only derived gold locations).
Six repository clusters make the repo-cluster bootstrap a sensitivity
analysis only, not a generalisation claim (§11).

Resolution verification (pinned typescript-language-server 6.0.0 + TS 5.9.2
from `~/.cache/pi-smartread-bench/tools/lsp-pinned/`, driven directly over
stdio — initialize/rootUri, initialized, didOpen-with-disk-content sent as a
*notification*; probe script kept at `teb/lsp-probe.py`,
`TEB_SLEEP` sets the project-load wait). No `npm install` in any repo.

Prior probes (definition + references, `includeDeclaration:false`):

- rxjs `Observable` re-export (src/index.ts:16) → `src/internal/Observable.ts:15`, 874 refs. Checkout includes `docs_app/` + `spec/`; semantic gold scopes to `src/` or records the scope filter per task.
- tsup `build` (src/cli-main.ts:154) → `src/index.ts:167` (+ local import site); refs resolve.
- TanStack `QueryClient` intra-package (queryCache.ts:106 → queryClient.ts:61), 203 refs. Cross-package workspace-alias import (`@tanstack/query-core` from react-query) does NOT resolve without install — definition falls back to the import site itself.
- drizzle `pgTable` (table.ts:244), view.ts usage resolves. Column sensitivity confirmed: off-by-one column hits the neighboring symbol.
- astro `resolveConfig` (restart.ts:12) resolves *through* the `config/index.ts` re-export to `core/config/config.ts:134` (server returns the ultimate target).
- prettier JS `format` (cli/file-info.js:3) resolves to `src/index.d.ts:597` (the type declaration), not the JS implementation.

### 1.1. Full semantic-family probes (2026-10-07, R3)

Extended probe (`/tmp/teb-semprobe.py`: definition, declaration,
references, implementation, prepareCallHierarchy + incoming/outgoing,
hover in one server session; `TEB_SLEEP` 8–12s) run against the pinned
server on cached checkouts. Results:

| # | Repo / query (1-based) | definition | references | implementation | call hierarchy | hover |
|---|---|---|---|---|---|---|
| P1 | tsup `src/cli-main.ts:154:13` (use site of `build`) | `[cli-main.ts:104:15, index.ts:167:23]` | 2 | `[]` (concrete fn) | prepare `[]` at use site | ``const build: (_options: Options) => Promise<void>`` |
| P2 | tsup `src/index.ts:167:23` (def site of `build`) | self | 1 | self | 1 item (`build`, kind 12); incoming 0; outgoing 10 | ``function build(_options: Options): Promise<void>`` |
| P3 | drizzle `view.ts:89:34` (use site of `pgTable`) | `[table.ts:244:14, table.ts:140:2]` | 4 | `[table.ts:244:14]` | 1 item (`pgTable`, kind 12); incoming 2 (`ManualViewBuilder`:89, `ManualMaterializedViewBuilder`:247); outgoing 1 | alias signature `pgTable<TName,TColumns>(…)…` (truncated) |
| P4 | query `queryCache.ts:106:13` (use site of `QueryClient`) | `queryClient.ts:61:14` | 203 (incl. test files) | self (concrete class) | 1 item (`QueryClient`, kind 5); incoming 18; outgoing 2 | `(alias) class QueryClient` |
| P5 | query `types.ts:1351:18` (`interface QueryClientConfig`) | self | 2 | `[queryClient.ts:71:43]` (implementor use) | prepare `[]` | `interface QueryClientConfig` |

Binding consequences (all enforced by the §3 validator + §6 rules):

1. `textDocument/declaration` is UNSUPPORTED (error `-32601, Unhandled
   method`) on the pinned server. TEB never tasks declaration; the
   runner allowlist (§9.2) excludes it, and "any LSP navigation call"
   in §2 means definition / references / implementation / call-hierarchy
   / hover only.
2. `implementation` on concrete functions/classes returns self or `[]`
   (P1, P2, P4). `implementations` tasks use interface/abstract-class
   symbols ONLY (P5 pattern); gold is the server's implementor set.
3. `prepareCallHierarchy` at a *use site* may return `[]` (P1) but
   succeeds at the definition site (P2, P3, P4). `callers` tasks anchor
hierarchy preparation at the gold definition site with
`anchorKind: "definition"` (§2 Anchor column, E10.1); gold is
   (caller-name, caller-range-start) pairs from `incomingCalls`
   `from`/`fromRanges` (P3 pattern). "Callers" means caller
   *declarations* (one entry per calling function, deduplicated), NOT
   call sites — a function calling X three times contributes one entry.
4. Reference-set size is unbounded in the wild (rxjs 874, query 203,
   and P4 incoming includes test files). Set-valued semantic tasks are
   admitted ONLY for symbols with **≤ 40 in-scope references**
   (in-scope = inside `subpath` + task `scope` filter, counted with
   `includeDeclaration:false` at label time). Larger sets are rejected
   before sealing, or split by an explicit scope filter recorded in the
   task. This bound is a validity rule, not a difficulty tweak.
5. Hover returns a markdown code block, not a canonical type (P1–P5:
   `const` vs `function` renderings, `(alias)` wrappers, truncation).
   Type-string gold is the §5 normaliser output, never the raw hover.

Corpus rules derived from the above (binding on labelers and task authors):

1. No-install default. Semantic tasks MUST use symbols verified resolvable
   without install by the label-time server check (§6.1). Cross-package
   workspace aliases are excluded unless a pinned install step (exact
   command with `--ignore-scripts` + lockfile sha) is recorded per repo.
2. prettier/prettier is scoped to discovery + negative-control families
   ONLY (JS-heavy corpus; semantic gold would systematically land in
   `.d.ts` shims). No semantic-family tasks on prettier.
3. Monorepo tasks pin the package subpath (astro → `packages/astro`,
   query → `packages/query-core` default, drizzle → `drizzle-orm/`).
   `repo` field uses `<owner>__<name>`; `subpath` gives the task root.
4. rxjs tasks default to `subpath: "src"` (or record an explicit scope
   filter) so `docs_app/`/`spec/` reference volume does not leak into gold.
5. Set-valued semantic tasks require ≤ 40 in-scope references (§1.1.4).
6. `implementations` tasks require interface/abstract symbols (§1.1.2).

## 2. Task families and opportunity semantics

Every task carries `opportunity: { tools, rationale }` where `tools` names
the specialist tool(s) expected to improve evidence quality or cost, and
`rationale` says how (in one sentence). Opportunity is NEVER a mandate:
the agent is free to use any allowed tool; grading (§4) is on the final
answer only. Opportunity labels exist solely to compute opportunity recall
and specialist precision (§9).

Specialist mapping (which tools count as `specialist: true` for opportunity
recall depends on the family). Frozen family→`answerType`→gold table (E10.1):

| Family | Prompt shape (example) | answerType | Gold | Anchor | Opportunity tools (real calls) | Counts as specialist use |
|---|---|---|---|---|---|---|
| `definition` | "Where is symbol X, used at <path>:<line>:<col>, defined?" | `single-location` | `single-location.location` | `useSite` + `anchorKind: "use"` | `LSP` (`goToDefinition`) | `LSP` call with `args.operation == "goToDefinition"` |
| `all-references` | "List every in-scope reference to X (used at P, scope S)." | `location-set` | `location-set.locations`, ≤40 | `useSite` + `anchorKind: "use"` | `LSP` (`findReferences`) | `args.operation == "findReferences"` |
| `implementations` | "List implementations of interface/abstract X (declared at P)." | `location-set` | `location-set.locations` (interface/abstract only) | `useSite` + `anchorKind: "definition"` | `LSP` (`goToImplementation`) | `args.operation == "goToImplementation"` |
| `callers` | "Which functions call X (declared at P)? One entry per calling function." | `caller-set` | `caller-set.callers` {name,path,line} | `useSite` + `anchorKind: "definition"` (definition-site anchor; `prepareCallHierarchy` is empty at use sites, §1.1.3) | `LSP` (`prepareCallHierarchy` + `incomingCalls`) | `args.operation` in {`prepareCallHierarchy`, `incomingCalls`} |
| `type-of-symbol` | "What is the type of X at P?" | `type-string` | `type-string.normalized` + flags | `useSite` + `anchorKind: "use"` | `LSP` (`hover`) | `args.operation == "hover"` |
| `direct-importers` | "Which files directly import module M?" | `file-set` | `file-set.files` (exhaustive depth-1) | no `useSite` | structural `grep` import-specifier search, or `LSP findReferences` on the module specifier where the server supports it (R5: NO exhaustive `inspect` importer list exists — `inspect` file mode has no `dependents` analysis key, `callDirection:"callers"` enumerates function callers not import edges, and `graphSchema`/`impact` render bounded top-N samples, so they cannot evidence an exhaustive file set) | `grep` with `args.structural` present, or `LSP findReferences` |
| `package-exports` | "List the package entry files of package P (package.json exports/main/types)." | `file-set` | `file-set.files` (entry FILES only; the symbol half is dropped per E10.2) | no `useSite` | `inspect {mode:"directory", path}` or `read` | `inspect` directory-mode call |
| `http-routes` | "List the HTTP routes registered in <dir>." (only repos with supported frameworks) | `route-set` | `route-set.routes` | no `useSite` | `inspect {mode:"file", path, analysis:{routes:true}}` or `inspect {mode:"directory", path, analysis:{routes:true}}` or `grep` | `inspect` call with `args.analysis.routes == true`, or pattern `grep` |
| `literal-location` (−) | "Where does exact string S appear?" | `location-set` | `location-set.locations` | no `useSite` | none (`grep` literal) | N/A (negative control) |
| `file-by-name` (−) | "Which file defines the X config / Y test?" | `file` | `file.path` | no `useSite` | none (`find`) | N/A (negative control) |
| `config-value` (−) | "What value does key K have in config C?" | `scalar` | `scalar.value` | no `useSite` | none (`read`) | N/A (negative control) |

`useSite` is OPTIONAL and ABSENT for non-semantic families (E10.1); the
validator rejects a present `useSite` on non-semantic tasks. Semantic
tasks carry `anchorKind: "use" | "definition"` per the Anchor column.
`callers` tasks anchor at the definition site (E10.1; §1.1.3 probe).
Bounded-render rule (E10.3): where `inspect` renders a bounded top-N list
(impact top-15 files, hotspots, dead-code slices), task gold MUST NOT
exceed that rendered bound, otherwise the task is not an inspect
opportunity (opportunity lists the first-line route instead).

`(−)` = negative control: the correct behavior is to NOT use a specialist.
`opportunity.tools` is `[]` with rationale "solvable with first-line
retrieval; specialist use is over-routing". Families may be extended only
by protocol amendment before labeling that split.

Prompt unambiguity rules (R3 — semantic rules 1–2 and 5 apply to semantic families ONLY; rules 3–4 apply to the named family; non-semantic families carry NO use-site anchor):

1. Exact query-site anchor (SEMANTIC families `definition`, `all-references`, `implementations`, `callers`, `type-of-symbol` ONLY): `<repo-relative path>:<1-based line>:<1-based
   column>` plus the symbol's source spelling at that site (e.g. "symbol
   `pgTable` as spelled at `drizzle-orm/src/pg-core/view.ts:89:34`").
   `definition`, `all-references`, and `type-of-symbol` anchor the symbol
   AT A USE SITE chosen by the labeler; `callers` and `implementations`
   anchor the symbol AT ITS DEFINITION/INTERFACE SITE
   (`prepareCallHierarchy` is empty at use sites, §1.1.3 — E13.2).
   Column-duplicate names (drizzle `getTableColumns` vs `pgTable`,
   §1) are disambiguated by this anchor; tasks whose anchor does not
   resolve to exactly one symbol at label time are REJECTED before sealing.
   Non-semantic families (`direct-importers`, `package-exports`,
   `http-routes`, all `(−)` families) MUST NOT carry a use-site anchor —
   the validator rejects a present `useSite` on them (E10.1).
2. Explicit scope (ALL families): the directory/file scope the answer ranges over
   (defaults to task `subpath`; rxjs defaults to `src`). Out-of-scope
   hits (docs, specs, tests, `.d.ts` unless `dtsTarget`) never count.
3. `callers` = caller declarations (`callers` family ONLY): "one entry per calling function
   (name + first line of the calling function); multiple call sites in
   one function count once". Gold entries are `{name, path, line}`
   triples graded by path+line point-match (§5).
4. "Package entry files" (`package-exports`) means: FILES ONLY — the
   entry files named by the package's `package.json`
   `exports`/`main`/`types` fields (resolved to repo-relative paths).
   No symbol enumeration, no barrel re-export symbols; prompts never
   ask for symbols in this family (E10.2).
5. Re-exports and duplicates (`definition`, `all-references`,
   `type-of-symbol` ONLY): through re-export chains, gold is the
   server's ultimate target (astro pattern §1), and the prompt anchors
   at a use site, never at an intermediate barrel, so barrel-hopping is
   graded as wrong-file. A bare re-export line counts as a reference;
   `export *` barrels do NOT (unresolvable to a point). Duplicate
   symbol names in scope without a unique anchor are rejected, never
   guessed.

 Structural-family repair note (R5): the former `impact` family asked an
exhaustive transitive-dependence question the inspect view cannot answer
— `computeImpact` BFS-traverses import+call+mutation neighbours to depth 3
(`src/inspect/impact-analysis.ts:401–417,515–546`) but renders only the
top 15 files by risk (`src/inspect/inspect-file-sections.ts:115–129`;
file-mode impact authorises only the displayed slice `:150–155`). It is
a ranked risk summary, not an exhaustive set oracle. The former
`entry-points` family conflated package exports with HTTP routes. Both
are replaced above by questions with independently enumerable gold:
`direct-importers` (depth-1 reverse imports, exhaustive via import scan),
`package-exports` (package.json + barrel enumeration from source),
`http-routes` (regex-pattern enumeration matching `extractRoutes`'s
documented frameworks: Express/Fastify `app|fastify|router|server|api`
`.get/post/…`, Next.js App/Pages routers, tRPC — `src/inspect/route-extraction.ts:1–60`;
repos without those frameworks get no `http-routes` tasks).
`inspect`'s impact view remains an *allowed* tool but is never its own
gold, and literal `grep`/`find`/`read` controls are retained where those
are genuinely optimal (see family matrix §2.1).

### 2.1. Task-family matrix (plausible specialist edge vs first-line route)

| Family | Plausible specialist advantage | Equally capable first-line route (control) |
|---|---|---|
| `definition` | exact jump incl. re-export chains, d.ts | `grep` symbol spelling + `read` candidates |
| `all-references` (≤40) | exhaustive, scope-exact set | structural `grep` + manual filter |
| `implementations` | interface→implementor mapping | `grep` `implements X` / `extends X` |
| `callers` | declaration-level caller list | `grep` name + `read` each site |
| `type-of-symbol` | rendered inferred type | `read` annotation at definition |
| `direct-importers` | reverse-import view in one call | structural `grep` import pattern |
| `package-exports` | directory summary | `read` package.json + index barrel |
| `http-routes` | routes section in one call | `grep` route-registration patterns |
| `(−) negatives` | none expected — first-line optimal | `grep` literal / `find` / `read` |

## 3. JSONL task schema

One JSON object per line, UTF-8, LF-terminated. Stored outside the repo
(`~/.cache/pi-smartread-bench/teb/{pilot,dev,holdout}.jsonl`, mode 0600).
Validator lives in-repo at `scripts/eval/teb/schema.ts` (mirrors the
D46 schema/validator pattern) and rejects unknown families, bad splits,
and gold that fails the §6 conventions check.

```ts
interface TebTask {
  id: string;               // "teb-<split>-<family>-<nnn>", unique
  split: "pilot" | "dev" | "holdout";
  repo: string;             // "<owner>__<name>" from repos.json
  commit: string;           // pinned full sha, must match repos.json
  subpath: string;          // task root inside the checkout, e.g. "packages/astro"
  family: string;           // §2 family name
  prompt: string;           // verbatim agent prompt (frozen per split)
  useSite?: Location;      // REQUIRED on semantic families, ABSENT otherwise (E10.1; validator enforces)
  anchorKind?: "use" | "definition"; // REQUIRED alongside useSite; value per §2 Anchor column
  scope: string;            // subpath-relative scope filter, "" = whole subpath
  answerType: "single-location" | "location-set" | "caller-set" | "file-set" | "file" | "scalar" | "type-string" | "route-set";
  gold: GoldAnswer;         // §6; normalized canonical form
  opportunity: { tools: string[]; rationale: string };
  negativeControl: boolean; // true iff family is a (−) family
  extensionForgiveness?: boolean; // default false; ".js→.ts forgiveness" — set true ONLY on prettier discovery tasks
  caseSensitive?: boolean;  // scalar answers only; default false (trim + case-insensitive)
  dtsTarget?: boolean;      // default false; true iff gold target is a .d.ts (semantic tasks only outside prettier)
  derivation: string;       // exact gold-derivation commands/script+version (§6)
  agreement: "agree" | "server-only" | "compiler-only" | "adjudicated";
  labelers: [string, string]; // two independent source-first labelers
  adjudication: string;     // "agree" | "adjudicated:<note>"; holdout requires non-empty note on disagreement
  note?: string;            // OPTIONAL free-text labeler note (e.g. threshold-relaxation reason); never shown to the agent
}
type Location = { path: string; line: number; character: number }; // 1-based, repo-relative to subpath
type GoldAnswer =
  | { kind: "single-location"; location: Location }
  | { kind: "location-set"; locations: Location[]; minRecall: number; minPrecision: number }
  | { kind: "caller-set"; callers: Array<{ name: string; path: string; line: number }>; minRecall: number; minPrecision: number }
  | { kind: "file-set"; files: string[]; minRecall: number; minPrecision: number }
  | { kind: "route-set"; routes: Array<{ method: string; path: string; file: string; line: number }>; minRecall: number; minPrecision: number }
  | { kind: "file"; path: string }
  | { kind: "scalar"; value: string }
  | { kind: "type-string"; normalized: string; normalization: { arrayRewrite: boolean; dropUndefined: boolean } };
```

Field locations, defaults, and validation (R4):

Top-level audit/grading fields are authoritative (E13.1): there is
no `task.grading` nest — `derivation`, `agreement`, `labelers`,
`adjudication`, and the optional free-text `note` live at task top
level as sketched above, and the validator enforces that layout.
`minRecall`/`minPrecision` live on each set-kind gold variant as
sketched above (always explicit, never defaulted). `note` is accepted
by the validator and never shown to the agent.

- `extensionForgiveness`, `caseSensitive`, `dtsTarget` live on the TASK
  (grader-only switches, never shown to the agent). Defaults: all false.
  The validator rejects `extensionForgiveness:true` outside prettier,
  `dtsTarget:true` on prettier tasks, and `caseSensitive` outside scalar.
- `derivation` (gold provenance) and `agreement` (cross-check class) are
  grader/audit-only. The validator requires a non-empty `derivation` and
  a valid `agreement`; `server-only`/`compiler-only` force a non-empty
  `adjudication` note in every split.
- `minRecall`/`minPrecision` are per-task thresholds REQUIRED on every
  set-kind gold (`location-set`, `caller-set`, `file-set`, `route-set`).
  The validator REJECTS a set-kind gold missing either threshold — no
  default is ever silently applied. The single defaults statement lives
  in §5 (labeling-UI pre-fill values, always written explicitly into
  the task by the labeler); the freeze checklist asserts every
  set-kind task carries explicit labeler-authored values (a deliberate
  relaxation below the §5 defaults must be justified in the task
  `note`). The task passes iff both are met; the
  §5 matching rules define how each is computed.
- Runner isolation: `run.ts` builds the agent prompt from `prompt` plus
  the §4 answer-shape block ONLY. Gold, opportunity, thresholds,
  adjudication, derivation, and agreement never enter the prompt
  builder; a unit test asserts no gold path/line/value string from the
  task appears in any user-role transcript message.

## 4. Final-answer contract (binding on the runner prompt)

The agent MUST end its run with exactly one fenced `json` block as the
last substantive output. The runner extracts the LAST fenced json block;
anything else is ignored for grading (but retained for audit).

Shapes per answerType (no extra keys; unknown keys fail closed):

- `single-location`: `{"answer": {"path": "...", "line": N, "character": M}}`
- `location-set`: `{"answer": [{"path": "...", "line": N, "character": M}, ...]}`
- `caller-set`: `{"answer": [{"name": "...", "path": "...", "line": N}, ...]}`
- `file-set`: `{"answer": {"files": ["...", ...]}}`
- `route-set`: `{"answer": [{"method": "...", "path": "...", "file": "...", "line": N}, ...]}`
- `file`: `{"answer": {"path": "..."}}`
- `scalar`: `{"answer": {"value": "..."}}`
- `type-string`: `{"answer": {"type": "..."}}`

Path normalisation (grader): strip leading `./`, `/`, and any
`<repo>/` or `<subpath>/` prefix the agent echoes; resolve to the path
relative to `subpath`; case-sensitive; `.js`→`.ts` extension forgiveness
is OFF except where the task sets `extensionForgiveness: true`
(prettier discovery tasks only). `character` is required but graded
leniently (start-of-symbol tolerance ±2 columns; see §5).

Missing block, unparseable JSON, or wrong shape → task scored 0 with
reason `malformed` (distinct from wrong-answer 0; reported separately).

## 5. Grading rules and thresholds

Grader: `scripts/eval/teb/grade.ts` (pure functions; unit-tested per E6 on
correct / near-miss / ambiguous-symbol / stale-location / malformed
fixtures BEFORE the pilot). Reuse `unitCoversGold`-style line predicates
from `grep-e2e-metrics.ts` where applicable; do not duplicate metric
primitives — import from `scripts/eval/judge/ir-metrics.ts`.

Line-level vs range matching: gold locations are points (symbol start).
A predicted location MATCHES a gold location iff same normalized path
AND same `line` AND `|character − gold.character| ≤ 2`. (Rationale:
columns are brittle across tool renderings; lines are the load-bearing
signal. Range overlap is NOT used — TEB answers are symbol starts, not
spans; this differs deliberately from D46 span scoring.)

Per-answerType success (binary, primary metric input):

- `single-location`: exact point-match on the gold location. Threshold: 1/1.
- `location-set` / `file-set` / `caller-set` / `route-set`: let P =
  predicted set, G = gold set. `recall = |P∩G|/|G|`,
  `precision = |P∩G|/|P|` (empty P → precision 0, recall 0). Pass iff
  `recall ≥ minRecall AND precision ≥ minPrecision`. Caller entries
  match on path+line (name must also match exactly after trim;
  a name mismatch with path+line match = no match). Route entries
  match on method+path+file+line (method upper-cased).
  Defaults — the SINGLE defaults statement for set thresholds (E13.2;
  §3 carries no separate values): labeling-UI pre-fill values, always written explicitly into
  the task by the labeler — never silently applied): `minRecall = 1.0`
  for |G| ≤ 5, `0.8` for |G| > 5; `minPrecision = 0.5` (labelers may
  tighten per task with reason recorded in the task `note`).
- `file`: exact normalized path match.
- `scalar`: exact match after trim + case-insensitive compare, unless
  the task sets `caseSensitive: true`.
- `type-string`: normalise BOTH sides with the pinned normaliser
  (implemented once in `grade.ts`, unit-tested): extract the first
  fenced code block with language `typescript`/`ts` (else the first
  fenced block, else the raw string); strip the fence; drop a leading
  `(alias …)` / `(property …)` qualifier line if present; collapse all
  whitespace runs to a single space and trim. Then, iff the task's
  `normalization.arrayRewrite` is true, rewrite `Array<X>` ≡ `X[]`;
  iff `normalization.dropUndefined` is true, drop `| undefined`
  disjuncts (set only when the prompt says nullable-explicit). Compare
  exact. A hover rendering is NOT a canonical type until normalised —
  the labelers pin `normalized` + both flags per task.

Continuous secondary scores (recorded per task regardless of pass/fail):
set-F1 for set types, reciprocal-rank-style credit for single-location
(1.0 match / 0.5 right-file-wrong-line / 0.0 otherwise), and normalized
Levenshtein similarity for scalar/type-string.

## 6. Gold derivation

6.1. Semantic families (`definition`, `all-references`, `implementations`,
`callers`, `type-of-symbol`): gold is authored by TWO independent
source-first, tool-output-blind labelers working from the pinned
checkout (they read source; they never see SmartRead, LSP, or inspect
output). The pinned server (typescript-language-server 6.0.0 + TS 5.9.2,
`teb/lsp-probe.py` flow with the §1.1 family operations) and the TS
compiler API on the pinned TS 5.9.2 build are driven DIRECTLY, never
through SmartRead's `LSP`/`inspect` tools, as a *mistake detector*,
not an independent source — both share pinned-TS 5.9.2 semantic
assumptions, so their agreement detects adapter mistakes, not shared
TypeScript-semantics errors (R2). Per task the runner records:
labeler-A label, labeler-B label, server result, compiler result, the
exact use-site symbol spelling, and the resolution scope. Any
server/compiler disagreement, or any deviation from both labelers, goes
to the third adjudicator; the `agreement` class
(`agree` | `server-only` | `compiler-only` | `adjudicated`) is stored
per task and the last three force a non-empty adjudication note.
`inspect` output is NEVER its own gold.

Independent (non-TS-semantics) checks per family:

- `definition` / `all-references`: compiler
  `ts.LanguageService getDefinitionAtPosition /
  getReferencesAtPosition` on the pinned build.
- `implementations`: compiler `getImplementationAtPosition`
  (interface/abstract symbols only, §1.1.2).
- `callers`: textual enumeration — `rg` for the symbol spelling
  within the task scope, manually filtered to true call sites and
  grouped by enclosing function (labelers, no LSP). Call-hierarchy
  has no compiler-API equivalent; this textual pass is the independent
  check.
- `type-of-symbol`: the labeler reads the declared/inferred type from
  source at the definition site (annotation, initializer, or
  unambiguous alias target). Hover has no compiler-API equivalent;
  this source read is the independent check, and the normaliser (§5)
  output is verified against it by hand.

6.2. Conventions (applied identically by both labelers, enforced by the
schema validator):
(a) declaration inclusion: the declaration site counts as a reference iff
the prompt says "including the definition/declaration"; otherwise gold
`location-set`s exclude it (matches `includeDeclaration:false` default);
(b) import specifiers: a bare re-export line (`export { X } from '...'`)
counts as a reference to X; a `export *` barrel does NOT (unresolvable to
a point); (c) `.d.ts` hits: included in gold iff they are the server's
returned target — tasks with `dtsTarget:true` record it explicitly
(prettier carries no semantic tasks per §1 rule 2, so this bites only
if a future repo shows the same pattern);
(d) ultimate-target rule (`definition`, `all-references`,
`type-of-symbol` ONLY): through re-export chains, gold is the server's
ultimate target (astro pattern), and the task prompt MUST anchor the
query at a use site (per rule 1 above), never at an intermediate barrel, so barrel-hopping
is graded as wrong-file. `callers`/`implementations` tasks anchor at
the definition/interface site instead. Structural/discovery/negative families carry NO use-site anchor.

6.3. Structural families (`direct-importers`, `package-exports`,
`http-routes`): gold is authored from source — edges enumerated by
script over the pinned tree (import-scan resolving relative specifiers
plus per-repo-recorded workspace aliases; route-pattern scan matching
exactly the `extractRoutes` framework patterns) + manual labeler review
— independently verifiable without running `inspect`. The enumeration
script, its version, and its output diff are sealed with the split
(recorded in each task's `derivation`).

6.4. Discovery/negative families: gold by exhaustive `rg` file enumeration
(commands recorded in the task's `derivation` note); absence-style
negatives are NOT used in TEB (negatives here mean "specialist not
needed", not "answer is empty").

## 7. Labeling and adjudication

Two independent source-first, tool-output-blind labelers on ALL tasks in
every split (no sampling — D60's incomplete second labels rule out
sampling here). Labelers work from the pinned checkout only; they never
see SmartRead tool output. The server/compiler cross-check (§6.1) runs
AFTER both labels are recorded and cannot silently overwrite them —
every divergence is adjudicated. Disagreements go to a third
adjudicator; holdout tasks require a non-empty adjudication note.
Labeler agreement rate per family is reported with the split. Grader unit
tests (correct/near-miss/ambiguous/stale/malformed) must pass before
labeling for a split begins.

## 8. Splits, sizes, stratification

| Split | n | Purpose | Sealing |
|---|---|---|---|
| pilot | ~24 (≥8 negative) | variance calibration, cost metering, gate calibration | unsealed; prompts may change after |
| dev | ~64 (≥40% negative) | intervention iteration | frozen prompts/gold; visible to experimenters |
| holdout | ~120 (≥40 negative) | ONE opening, ONE predeclared champion | sealed §13 |

Stratification: each split is stratified by repo × family. Every repo
appears in every split (prettier contributes discovery/negatives only,
§1 rule 2); every family appears in dev/holdout with ≥2 tasks (pilot:
≥1 per family attempted; families that cannot meet the §1.1 bounds on
any repo are recorded as absent, not filled with ambiguous tasks).
Negative controls are ≥20% of pilot, ≥40 tasks in holdout (R9: at n=24,
one task is 4.17pp — above the 3pp veto — so the holdout veto is
paired-tested, §11, and negatives are enlarged). Task IDs encode split
and family for audit.

## 9. Arms, launch flags, budgets, replicates

9.1. Arms (8 total: B + 6 isolated + D). Baseline B: post-E1 tools, E1
guidance ON (per-tool guidance + repo-map sections are the delivered
baseline, kept on in every arm). One arm per isolated intervention in E6
order — (1) description examples, (2) stateless `{path,symbol}` anchors,
(3) inspect named views, (4) nextActions/doom-loop guard, (5) LSP
presets, (6) opaque handles iff anchors fail — each tested singly
against B under natural choice (dev may ADD one predeclared additive
combination arm ONLY if ≥2 single arms each show a positive dev effect;
§9.4 selects the single champion — no "isolated yet additive"
ambiguity). Diagnostic arm D (upper bound only, never a product claim):
instructed-specialist (frozen instruction below naming the opportunity
tool). Skill delivery is evaluated separately with skills enabled; all
TEB arms run with skill sync disabled.

Frozen D instruction (verbatim; the ONLY addition to the B prompt):

> For this task you MUST call the `TOOL` tool at least once before
> giving your final answer. `TOOL` is ONE-LINE-DESCRIPTION. If the task
> turns out to be solvable without it, still call it once, then answer
> normally.

Frozen D substitution table (E10.6 — one line per family, TOOL NAME ONLY;
no operation, no arguments, no call sequence; never applied to negative
controls, which have no entry here):

| Family | Substituted `TOOL` / ONE-LINE-DESCRIPTION |
|---|---|
| `definition` | `LSP` — "a language server that resolves exact definitions and references" |
| `all-references` | `LSP` — "a language server that resolves exact definitions and references" |
| `implementations` | `LSP` — "a language server that resolves exact definitions and references" |
| `callers` | `LSP` — "a language server that resolves exact definitions and references" |
| `type-of-symbol` | `LSP` — "a language server that resolves exact definitions and references" |
| `direct-importers` | `grep` — "a text search that finds import statements referencing a module path" (E13.5: no exhaustive inspect importer view exists, so the instructed line names grep; LSP `findReferences` at the module specifier is the equivalent alternative) |
| `package-exports` | `inspect` — "a structural map of a package's files" |
| `http-routes` | `inspect` — "a structural scan of HTTP route registrations" |
D runs on non-negative tasks only (negative controls have no
opportunity tool; instructing specialist use there would manufacture
the over-routing it is meant to diagnose). D results are reported as a
diagnostic upper bound and NEVER mixed into natural-choice promotion —
the champion gates (§12) use natural-choice arms only.

9.2. Exact launch (verified against installed pi 2026-10-07):

```
pi -ne -e <worktree>/src/index.ts --mode json --no-session \
   --no-skills --no-context-files --no-prompt-templates \
   --model <exact-model-id> --thinking <level> --tools read,bash,grep,find,inspect,LSP \
   -- "<frozen prompt + final-answer contract>"
```

plus env `PI_SMARTREAD_SKILL_SYNC=0`. The runner records provider,
requested model, `--thinking` level, and the resolved `responseModel`
+ `providerThinkingLevel` from the session header / first assistant
`message_end` (`message-types.md` AssistantMessage) and FAILS the pair
on mismatch (wrong-extension-loaded or wrong-model-resolved is infra
failure, not a model failure). Prompt-section exposure (guidance
present/absent) is captured per run from tool-result metadata where
available. The runner prompt contains the task `prompt` + the §4
answer-shape block ONLY (§3 isolation rule). Exact tool allowlist for
every arm (E10.6): `read,bash,grep,find,inspect,LSP` — `bash` is
included because it is the real-world substitute for specialist tools
(agents route around specialists through shell); no `edit`/`write`
because tasks are read-only. Tool allowlist excludes
`textDocument/declaration`-equivalent operations (unsupported §1.1.1);
allowed LSP operations: definition, references, implementation,
call-hierarchy, hover, diagnostics.

9.3. Budgets: per-task wall timeout `[FROZEN: pilot default 240s]`,
max turns `[FROZEN: pilot default 25]`; exceeding either is recorded as
`timeout` with task graded 0/0 in the PRIMARY denominator (E10.5:
every ordinary timeout counts, INCLUDING double timeouts where both
replicates of a pair time out — 0/0, never excluded). Infrastructure
exclusions are PREDECLARED and narrow — a session is excluded (with
artifacts logged: run dir, last 50 events, provider error) ONLY for:
(a) provider/auth failure BEFORE the first assistant token;
(b) extension load failure (`src/index.ts` fails to register tools);
(c) runner crash (nonzero exit / lost stream before grading).
Anything after the first assistant token — timeouts, tool errors, empty
or malformed answers — is graded, never excluded. Identity mismatch
(provider, model, or thinking mode missing or different from the
frozen record) is NOT graded: the session is EXCLUDED from paired
analysis, listed in the report, and RERUN (E13.3). Predeclared
infrastructure failures ((a)–(c) above) are likewise excluded, listed,
and rerun. Exclusion rate is
reported; >5% excluded sessions invalidates the run batch.
agent outcomes, not infra. Alternation: paired order alternates by task
(AB/BA) within each replicate. Replicates: `[FROZEN: pilot 3 runs]`
per task×arm as INDEPENDENTLY LAUNCHED fresh `--no-session`
(ephemeral) processes — Pi's CLI exposes no seed flag, so "distinct
seeds" is replaced by independent launches; the runner records run IDs
and the B-vs-arm pairing per replicate. Pairing is by shared logical
task + replicate AFTER attempt resolution and exclusion filtering: each
side votes by majority over the replicates present on BOTH sides only
(pairId is runId-dependent and may change on rerun, so it is never the
pairing key). A task with no common included replicate is not paired.
Rerun attempts contribute one vote (latest non-excluded attempt wins).
Main outcomes, gates, and per-family base rates all use the SAME
comparison-specific matched baseline votes — never the standalone
baseline descriptive rate, which may cover different tasks/replicates. PID-suffixed run dirs;
transcripts streamed to disk during the run (never buffered-only).

9.4. Champion selection (preregistered): the holdout champion is ONE
single-intervention arm, chosen on DEV results by highest primary gain
over B subject to no dev gate-violation (negative deterioration,
precision collapse); the additive-combination arm, if tested, is a
separate candidate only if it beats the best single arm on dev by
≥2pp. The champion id and gate values are recorded at sealing.

## 10. Metrics (all computed from JSONL events + grader output)

Event-authoritative field reference (`docs/json.md:64–107`,
`message-types.md`): `tool_execution_start` carries
`toolCallId/toolName/args`; `tool_execution_end` carries
`toolCallId/toolName/result/isError`; NEITHER carries a timestamp —
the RUNNER stamps wall-clock receipt milliseconds (`rt`) on every
record at capture. `message_end.message` carries the completed
assistant message INCLUDING authoritative `usage`
(`input/output/cacheRead/cacheWrite/totalTokens`, `cost`) and
`timestamp`; per-message usage is the cost source (tool-result blocks
alone prove nothing — harness-notes rule). `ToolResultMessage`
carries `content/details/usage?/isError/timestamp`.

Primary: paired script-graded task success (§5 binary pass, task-level
aggregation §11), arm difference per task.

Secondary (per task×arm×replicate, then aggregated):

- `opportunity_recall`: over non-negative tasks, fraction where a
  §2-specialist tool for the family was CALLED (a `tool_execution_start`
  whose `toolName`+`args` matches the family map: `LSP` with
  `args.operation` ∈ {definition→goToDefinition set…} per the §2
  "counts as specialist use" column; `inspect` with `args.mode` =
  file/directory as mapped; structural `grep` with `args.structural`
  present). Matcher pinned in `metrics.ts` with unit tests.
- `specialist_precision`: over all specialist calls, fraction on tasks
  whose opportunity lists that tool (1 − over-routing rate).
- `invalid_call_rate`: `tool_execution_end` with `isError:true` /
  tool requests. `unavailable` is an LSP-ONLY classification: the
  strict LSP envelope `details.envelope.status == "unavailable"` per
  `src/lsp/lsp-strict-contract.ts:144–151`. Non-LSP result text NEVER
  classifies as `unavailable`, even if it contains the word
  "unavailable". Non-`ok` LSP envelopes (`error | timeout | not_ready
  | unsupported | cancelled`) count as ERRORS, not successes, and feed
  the error rate and post-error accounting. `unavailable` is counted
  SEPARATELY from tool errors — never merged into either numerator.
  `post_error_success_rate` (NOT "recovery"): fraction of runs with
  ≥1 error/`unavailable` that later record a successful call of any
  tool. The name asserts only temporal succession, NOT recovery of the
  failed intent.
- `calls_to_first_correct`: number of tool requests before the first
  qualifying `tool_execution_end` whose RENDERED text contains a
gold-matching location/file — matched with the §5 matcher against
  `result.content[0].text` (read/grep/find/inspect) or the strict LSP
  envelope. LSP results qualify ONLY when
  `details.envelope.status == "ok"` (matched against
  `JSON.stringify(details.envelope.result)`; envelope shape
  `src/lsp/lsp-tool.ts:199–203`, `src/lsp/lsp-strict-contract.ts:144–151`;
  non-`ok` envelopes never qualify — E13.4). Text `path:line`
  locations match with NUMERIC boundaries (a trailing digit boundary
  after the line number, so `src/index.ts:10` does NOT match
  `src/index.ts:100`). Route/caller-name strings alone do NOT qualify:
  `route-set`/`caller-set` evidence requires a path+line context for
  the name, not the bare name. ARG-ECHO EXCLUSION:
  a gold string already present in that call's `start.args` (queried
  path, pattern, symbol) does NOT count — the agent echoing the prompt
  back is not evidence. `null` if never.
- `tokens_to_first_correct`, `time_to_first_correct_ms`: same
  cut-point using summed `message_end.message.usage` BEFORE the
  cut-point record and runner `rt` deltas (`message_end` provides
  completed-message usage, not token timing inside a tool result).
- `negative_overuse`: over negative-control tasks, fraction with ≥1
  specialist call; and `negative_success` (graded pass — must NOT drop).
- Cost: model tokens from `message_end` usage × actual provider pricing;
  tool-nested usage (`details.judge.costUsd`, tool-result `usage`)
  summed SEPARATELY from model tokens, never merged.
- Failure transparency (reported by family alongside successes, never
  collapsed into answer failures): provider errors/rate-limits,
  cold-start/index time, truncation flags, unsupported-operation
  attempts, `unavailable` counts, `malformed` counts.

A score-neutral uptake rise is not success (E6): opportunity recall
without task-success gain fails the gate.

## 11. Statistics

Unit of analysis: the TASK. Per task×arm, replicates aggregate by
majority over the replicates common to both arms (matched-replicate
voting — §9.3): pass fraction > 0.5 → task-pass; ties fail —
predeclared. Arm difference per task ∈ {−1, 0, 1} on task-passes.

Paired task bootstrap 95% CIs on the arm difference (resample tasks,
keep task outcomes intact; `[FROZEN: B=10000]`); repo-clustered
sensitivity (leave-one-repo-out + cluster bootstrap by repo, reported
alongside — a champion that depends on one repo does not promote;
with six repos this is sensitivity only, §1). Seeds fixed and recorded
where randomness exists (bootstrap seed); repeated runs stay within
task clusters. Pairs excluded ONLY under the three predeclared
infrastructure causes (§9.3) are dropped from the paired test with
artifacts retained; every ordinary timeout — including double timeouts
— stays in the denominator as 0/0. Family-level and repo-level
breakdowns, full per-task outcome tables, and the lost-prior-successes
list (tasks B passed at task level but champion failed; denominator =
B-passed tasks) are always reported.

Gate-feasibility power check (R9): three replicates do NOT create 360
independent tasks — n = task count. At 120 tasks, a +5pp effect with
20% discordant paired outcomes has SE ≈ 4pp, so a positive 95% CI is
unlikely WITHOUT higher discordance-adjusted power. After the pilot,
compute the discordant-pair rate and the holdout n needed for 80%
power at the frozen effect size; if it exceeds 120, ENLARGE THE
STILL-UNOPENED holdout before any dev run (growing an unopened sealed
set changes no outcome). The 3pp negative veto is paired-tested
(McNemar exact p < 0.05 AND point deterioration > 3pp), so single-task
noise at n=24 (4.17pp/task) cannot veto alone. Task-vs-replicate
aggregation (majority rule above) and the lost-prior-successes
denominator (B-passed tasks) are fixed here, before the pilot.

## 12. Gates

Promotion requires ALL of the following on the sealed holdout
(calibrated on pilot, frozen before dev results, never relaxed):

- holdout success +`[FROZEN: 5pp]` with a positive paired 95% CI;
- opportunity recall +`[FROZEN: 15pp]`;
- specialist precision ≥ `[FROZEN: 80%]`;
- loss vetoes: negative-control deterioration > `[FROZEN: 3pp]` AND
  McNemar p < 0.05 (paired task outcomes), AND lost prior successes
  ≤ `[FROZEN: 5%]` of B-passed tasks.

`[FROZEN]` placeholders are filled from pilot variance with the owner,
shown to the owner with the pilot cost extrapolation, and sealed before
the first dev run.

## 13. Cost metering, audit, holdout sealing

Model freeze (E7, R1 — supersedes E6 model choice; `pi -ne` disables
extension-provided `claude-bridge`, so D71 comparability is not a goal):
primary `opencode-go/deepseek-v4-flash` (provider `opencode-go`);
transfer slice `openai-codex/gpt-6-luna` (provider `openai-codex`).
Frozen per run and recorded from session events: provider, requested
model id, `--thinking` level, resolved `responseModel` +
`providerThinkingLevel` (mismatch = infra failure, §9.2). Model,
provider, thinking level, and resolved-response-model capture are
frozen after the pilot; any change invalidates cross-split comparison.

Session budget (R10 — CONDITIONAL CAP, not an exact total: the maxima below apply to the listed
task counts and the arm roster as frozen; the D (`instructed`) arm is EXCLUDED on every `(−)`
negative-control task per §7, so actuals run below the cap wherever negatives are present.
All planned arms on non-negative tasks: B + 6 isolated + D = 8):

| Stage | Tasks × arms × replicates | Sessions |
|---|---|---|
| pilot | 24 × 8 × 3 | 576 |
| dev | 64 × 8 × 3 | 1,536 |
| holdout (B vs champion) | 120 × 2 × 3 | 720 |
| transfer slice (B vs champion, gpt-6-luna) | 24 × 2 × 3 | 144 |
| TOTAL | | 2,976 |

At the 240s sequential cap: 2,976 × 240s = 198.4 wall-hours sequential
(parallel task shards + early finishes reduce this; report both).
Cost: the pilot meters `message_end` usage × actual provider pricing
for ≥20 pairs (model tokens separate from tool-nested/judge costs,
§10); extrapolate to the table above + setup/index time, set an
explicit OWNER SPENDING CEILING (E6-required), and obtain owner
authorization BEFORE any large paid run (pilot → ceiling sign-off →
dev → holdout). Representative pilot wall-times calibrate the 198.4h
bound.

Audit: evidence auditors check load-bearing exposure (which guidance
each arm actually saw), gold isolation (no SmartRead-tool-derived gold;
runner prompt contains no gold per §3 unit test), grader-test passage,
cost accounting, and paired-claim validity before any promotion claim.
Sealed gold stays owner-readable `0600` + sha256 manifest AND SHOULD use
an independent custodian (human holder outside the experiment loop)
where available; a transcript test asserts no task metadata reaches the
model (§3). Raw traces + failures retained outside the repo; only
reviewed summaries in durable docs.

Sealing: holdout tasks + gold + enumeration diffs hashed into a
`sha256` manifest (`teb/holdout-manifest.json`) including per-repo
snapshot hashes (§1); single opening for the predeclared champion
(§9.4), recorded with date, champion id, and gate values.
Dev-only regression guards (never reopening sealed sets): D46 dev56,
internal 44, external-grep dev64 title/body, pinned direct-server LSP
fidelity; comparators (ripgrep/Probe/Codanna; pi-lsp/mcp-language-server;
pinned Serena where genuinely equivalent) get the same source, commit,
budgets, and grader with setup/index time separated, and each
comparator mechanism/pin/hypothesis/borrow logged BEFORE implementation.

## 13.5 Contamination control and pinned runner binary (E11)

1. **Holdout isolation.** The benchmark worktree, gold files, and grading
   scripts MUST NOT be committed to, imported by, or readable from the
   repositories under test. Labelers work from a pinned-commit read-only
   checkout; graders and runners never mount the gold directory. The
   agent runs with `bash` and the same HOME as the bench cache/task
   files, so the runner scans every tool call's arguments and bash
   commands for references to the bench cache/task files; a
   contaminated session is GRADED AS A FAILURE and listed in the
   report (E11a — predeclared). Contaminated sessions are never merely
   quarantined/excluded: they stay in the primary denominator as
   failures.
2. **No training/recording.** Runs MUST NOT be submitted to model
   training, human review queues, or analytics endpoints. Provider calls
   use the enterprise zero-retention endpoint where available; otherwise
   the run is documented as retention-exposed and excluded from the
   sealed-holdout claim.
3. **Pinned `pi` binary (E13.6).** All runs use ONE pinned `pi`
   release. The freeze manifest records exactly three fields: binary
   PATH, VERSION, and SHA256. The holdout opening record is keyed to
   the sealed task-file sha256 (not the freeze filename), and only
   baseline + the frozen champion arm may run at opening. The
   extension under test is loaded from the frozen worktree
   (`pi -e <worktree>/src/index.ts`). A `pi` version different from
   the frozen one is REJECTED AT HOLDOUT OPENING before launch
   (§9.2 identity check). Manual operator steps (NOT runner-enforced,
   recorded by the operator in the freeze record where performed):
   verifying `pi --help` output against a saved digest, disabling
   auto-update for the benchmark duration, and freezing/recording the
   surrounding environment (Node major, OS/arch, network allowlist
   state, MCP server revisions — a mid-benchmark environment change
   opens a new freeze revision, never a silent continuation).

## 14. Implementer checklist (script authors)

1. `scripts/eval/teb/schema.ts` — TebTask types + validator (reject
   unknown families, bad splits, convention violations, §1.1 bounds:
   set-size ≤40, interface-only implementations, frozen-field defaults).
2. `scripts/eval/teb/grade.ts` — pure grader (§4–§5) incl. pinned
   type-string normaliser + unit tests
   (correct/near-miss/ambiguous/stale/malformed) — BEFORE pilot labeling.
3. `scripts/eval/teb/run.ts` — durable runner: §9.2 launch, JSON-event
   capture with runner receipt timestamps, prompt built from prompt +
   answer-shape only (§3 test), timeout vs infra-failure separation,
   PID-suffixed streaming run dirs, extension/model/thinking/resolved-
   model identity check, alternation + independent-launch replicates
   with run IDs and pairing.
4. `scripts/eval/teb/metrics.ts` — §10 extractors from events (family
   tool-use matcher, rendered-text/envelope first-correct with arg-echo
   exclusion, `unavailable` classifier, usage/timestamp accounting); import primitives from
   `scripts/eval/judge/ir-metrics.ts` (no local copies); unit-tested.
5. `scripts/eval/teb/stats.ts` — task-level majority aggregation, paired
   bootstrap + repo-clustered sensitivity + McNemar veto + gate
   evaluation against frozen values; pilot power check for holdout n.
6. Labeling UI/output format emitting TebTask JSONL + adjudication
   notes; sealing script producing the sha256 manifest incl. snapshot
   hashes.

## 15. Revision log (oracle review `546a8391`, 2026-10-07)

| # | Oracle REQUIRED item | Resolution in this revision |
|---|---|---|
| R1 | Apply E7 model override; freeze provider/model/thinking/resolved response model | §13 rewritten: primary `opencode-go/deepseek-v4-flash`, transfer `openai-codex/gpt-6-luna`; §9.2 freezes + verifies provider, model, `--thinking`, `responseModel`/`providerThinkingLevel` per run |
| R2 | Semantic cross-check is not independent (shared TS 5.9.2); adjudicate disagreement; cover hover + call hierarchy | §6.1 rewritten: source-first labels primary; server+compiler are mistake detectors; four-way record + adjudication; `agreement` field; textual independent checks for callers (rg enumeration) and hover (source type read) |
| R3 | Unambiguous prompts/gold; bound reference sets; probe every semantic family | §1.1 new: 5-probe results table (definition/declaration/references/implementation/call-hierarchy/hover) with binding consequences; §2 five prompt-unambiguity rules; set tasks bounded to ≤40 in-scope refs (§1 rules 5–6, §3 validator, §8) |
| R4 | One enforceable task/answer schema; runner sees prompt + shape only | §3 rewritten: `useSite/scope/extensionForgiveness/caseSensitive/dtsTarget/derivation/agreement` located with defaults + validator rules; runner-isolation unit test; §5 pins the type-string normaliser (hover ≠ canonical type) |
| R5 | Repair structural families (impact top-15 ≠ exhaustive; entry-points conflated) | §2 rewritten: `impact`→`direct-importers` (depth-1, exhaustive), `entry-points`→`package-exports` + `http-routes` (framework-gated, pattern-enumerated); impact view allowed but never gold; §2.1 family matrix (OPTIONAL-1, adopted) |
| R6 | Specify instructed arm without changing the task | §9.1: frozen verbatim D instruction naming TOOL ALONE (no operation/args); D on non-negative tasks only; D never enters promotion gates |
| R7 | Observable/auditable event metrics | §10 rewritten against `docs/json.md` + `message-types.md`: runner receipt timestamps; `message_end` usage semantics; structured-payload first-correct (no text scan); `unavailable` classifier; `post_error_success_rate` rename with caveat |
| R8 | Failure/replication rules (0/0 timeouts; no seed flag) | §9.3: ordinary timeouts stay 0/0 in primary denominator; infra exclusions predeclared + narrow; independent-launch replicates with run IDs (no seed flag in `cli.md`) |
| R9 | Gate feasibility (SE math; 24 negatives; task-vs-replicate aggregation) | §8: ≥40 holdout negatives; §11: task-level majority aggregation, McNemar-paired veto, lost-successes denominator, pilot power check with unopened-holdout enlargement |
| R10 | Corpus + spending provenance (hashes, licences, all-arms sessions) | §1: full-sha/licence-sha/snapshot-hash provenance + six-repo sensitivity caveat; §13: 8-arm session table (576 + 1,536 + 720 + 144 = 2,976; 198.4h cap) + owner ceiling gate |
| O1–O4 | OPTIONAL items | Adopted O1 (family matrix §2.1), O2 (champion rule §9.4), O4 (failure transparency §10); O3 recorded as SHOULD (custodian §13) |
| E10.1–6 | Orchestrator resolutions of remaining open items (decision log E10; oracle recheck `6786fb57`, 2026-10-08) | §2: frozen family→answerType→gold table with Anchor column (`useSite` required on semantic families only, `anchorKind: "use"/"definition"`, callers anchored at definition site); `package-exports` files-only (`file-set`, symbol half dropped); structural opportunities name real calls (`inspect {mode,path,analysis}` / `grep`), bounded-render rule for top-N views. §3: `useSite?`/`anchorKind?` optional, validator-enforced. §9.1: frozen per-family D substitution table (tool name only, no negatives). §9.2: exact allowlist `read,bash,grep,find,inspect,LSP`. §9.3: every ordinary timeout incl. double timeouts stays 0/0 in the primary denominator; infra exclusions predeclared and narrow (pre-first-token provider/auth failure, extension load failure, runner crash). §10: extractors against real shapes (`details.envelope.status/result` for LSP, rendered `content[0].text` otherwise, arg-echo exclusion, `unavailable` separate, `post-error success rate`). §13: session table is a MAXIMUM (D eligible-task counts) |
| E11 | Contamination control + pinned runner binary (new; E13.6 restatement) | §13.5: holdout/gold isolation; a contaminated session is GRADED AS A FAILURE and listed in the report (E11a — never quarantine/exclusion); zero-retention-or-documented training policy; pinned `pi` binary recorded as exactly PATH + VERSION + SHA256 with version-mismatch REJECTION AT HOLDOUT OPENING, opening keyed to the sealed task-file sha256 (baseline + frozen champion only); `pi --help` digest, auto-update disabling, and environment freeze are MANUAL OPERATOR STEPS recorded in the freeze record, not runner-enforced |
| F1 (oracle `6bc1d265`, 2026-10-08; superseded by E13 row below) | Re-opened R3/R4/R5/R10 + blockers 1–6 | R3: §2 anchors (E13.2 restatement — `definition`/`all-references`/`type-of-symbol` at a USE site; `callers`/`implementations` AT THE DEFINITION/INTERFACE SITE; non-semantic families carry NO `useSite` — validator rejects it). R4: `minRecall`/`minPrecision` REQUIRED on every set-kind gold; the §5 value list is the SINGLE defaults statement (labeling-UI pre-fill values, never silently applied); freeze checklist asserts explicit labeler-authored values. R5: `direct-importers` is a grep/LSP opportunity (no exhaustive inspect importer view exists); the instructed-arm line names grep (or LSP), not inspect. R10: §13 session table labeled CONDITIONAL CAP with D excluded on all `(−)` negatives. Blocker 1 (schema layout): TOP-LEVEL audit/grading fields are authoritative — there is NO `task.grading` nest — with an optional free-text `note` (see the §3 note). Blockers 2–6 are script-implementation gaps outside this file's ownership — recorded as pre-pilot exit criteria in §§9–10/13, NOT claimed resolved |

| E13 (decision log E13; oracle re-review `8d7881fb`, 2026-10-08) | Protocol ↔ code agreement round 2 | Top-level fields authoritative, optional `note` (§3; no `task.grading` nest). Anchors per E13.2 (§2 rules 1/5, §6.2(d)). ONE thresholds-defaults statement (§5; §3 references it). Metric contract per E13.4 (§10: LSP-only `unavailable`, non-`ok` LSP envelopes are errors, `ok`-only first-correct, numeric-boundary `path:line` matching, path+line context required for route/caller names). Contamination = graded failure; identity mismatch + predeclared infra = excluded, listed, rerun (§§9.3/11/13.5). `pi` pinning = path+version+sha256 with mismatch rejection at holdout opening; help digest / auto-update disabling / env freeze = manual operator steps (§13.5). `direct-importers` instructed line names grep (E13.5, §9.1) |

Residual risk (accepted): six repos + TS-centric gold limit
generalisation; the holdout evidences these pinned tasks and this
pinned model, not universal specialist superiority.
