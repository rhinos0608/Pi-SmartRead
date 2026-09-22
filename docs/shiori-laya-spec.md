# Spec: Hierarchical Skill Routing with Local Laya + Shiori-Style Progressive Disclosure

## Intent

Build a small skill-routing layer inside Pi-SmartRead for the current skill catalog (~51 global skills plus SmartRead package skills).

The router must **not** classify the raw user request. The main agent first investigates the repository/task, forms an actual work plan/TODO list, and only then asks the router which skill categories are relevant.

The router is deliberately narrow:
- Laya answers **where to look**, not **which skill to execute**.
- Multiple categories may be relevant at once and retain probabilities.
- The main agent chooses which category sections to open.
- A category reveals only skill cards, not full instructions.
- The main agent explicitly loads a skill in compact or full form.
- No skill body is auto-loaded from a probability alone.

This combines Shiori's context-economy ideas with a local ONNX System-One router while keeping SmartRead's existing `skill` tool as the single public surface.

## Core invariant

```text
user request
  -> normal agent investigation (read / grep / inspect / reasoning)
  -> concrete findings + TODOs
  -> skill route(state)
  -> category probabilities
  -> agent opens one or more categories
  -> agent loads compact/full skill
  -> execution
```

There is intentionally no automatic route call in `input` or `before_agent_start`.
## Current-state observations

- `~/.pi/agent/skills` currently contains 51 active skill directories (excluding hidden/cache/backups).
- SmartRead already owns skill discovery and a `skill` tool with `list`, `search`, and `read`.
- Discovery is richer than Shiori's: global roots, ancestor project roots, package `skills/`, `package.json#pi.skills`, and configured settings paths.
- The current frontmatter parser is line-based and mishandles YAML block scalars. Several real skills currently surface descriptions as only `|` or `>`. Routing/cards need a real YAML parser.
- `skill://` currently resolves only `~/.pi/agent/skills/<name>`, while the `skill` tool discovers more roots. These should eventually share one registry.
- SmartRead's startup `before_agent_start` hook is intentionally one-shot for repo-map/tool-guide injection. Shiori-style catalog suppression must be a separate every-turn hook.
- SmartRead's package contains `skills/inspect-script-mode/SKILL.md`, but `package.json#files` does not currently ship `skills/**`; fix this while making package skills first-class.

## Architecture

### Layer 1: Skill registry

Extract discovery/parsing from `src/runtime/skill-tool.ts` into a reusable registry.

The registry owns:
- discovered roots and precedence;
- canonical skill identity and realpath-safe file resolution;
- parsed frontmatter;
- hidden/manual invocation metadata;
- category memberships loaded from a taxonomy manifest;
- compact/full rendering.

The existing `skill` tool becomes an adapter over this registry rather than owning discovery itself.

### Layer 2: Hierarchical taxonomy

Skills are mapped to stable semantic categories. Skills may belong to multiple leaves.

Laya sees category IDs + short category descriptions only. It does **not** see the full skill list or skill bodies.
### Layer 3: Local Laya router

Use the ONNX Laya runtime locally and lazily. Do not initialize or download/load the model at session startup.

One `skill({ action: "route" })` call performs two internal passes:

1. **Root pass**: independently score top-level domains such as `coding`, `security`, `frontend`, `docs`, `media`, `agents`, and `style`.
2. **Leaf pass**: only for plausible roots, independently score their child categories.

This keeps Laya's small context focused and uses the hierarchy for actual pruning instead of decoration.

The output is advisory, for example:

```text
coding 0.94
  debugging 0.91
  testing 0.63
security 0.81
  red-teaming 0.84
  threat-modeling 0.69
```

Do not mathematically pretend root and leaf probabilities are independent/calibrated joint probabilities. Use root scores for pruning/grouping and leaf scores for ranking inside the surviving roots.

### Layer 4: Progressive disclosure

After routing, the agent explicitly opens a category:

```ts
skill({ action: "category", category: "coding.debugging" })
```

That returns only cards such as name + one-line description. The agent then chooses a skill and load depth:

```ts
skill({ action: "read", name: "diagnose", mode: "compact" })
skill({ action: "read", name: "diagnose", mode: "full" })
```

The existing default `read` behavior stays full for backwards compatibility; router guidance should recommend compact-first where sufficient.
## Taxonomy storage

Do not rewrite 51 vendor/user `SKILL.md` files just to add routing metadata. Put taxonomy beside the catalog.

Proposed per-root manifest name: `skill-catalog.json`.

Examples:
- `~/.pi/agent/skills/skill-catalog.json`
- `<project>/.pi/skills/skill-catalog.json`
- `<package>/skills/skill-catalog.json`

Each discovered skill root may provide category definitions and memberships. SmartRead merges manifests using the same precedence as the skills themselves. Unclassified skills remain available through explicit `list/search/read`, but are not automatically surfaced by Laya.

Suggested shape:

```json
{
  "version": 1,
  "categories": {
    "coding": {
      "description": "Software implementation, diagnosis, review, architecture and delivery.",
      "children": {
        "debugging": {
          "description": "Find root causes of incorrect behavior and regressions.",
          "skills": ["diagnose", "codescene-cli", "inspect-script-mode"]
        }
      }
    }
  },
  "manualOnly": ["ponytail-help", "ponytail-gain", "using-superpowers"]
}
```

`manualOnly` means the skill remains directly callable/searchable but is omitted from category routing. This is appropriate for command-reference skills and the old router-style `using-superpowers` skill once Laya routing exists.
## Initial taxonomy for the current catalog

This is a starting map, not sacred ontology. Tune category descriptions before tuning model thresholds.

| Leaf category | Initial skills |
|---|---|
| `coding.planning` | brainstorming, interview-me, writing-plans, executing-plans |
| `coding.debugging` | diagnose, codescene-cli, inspect-script-mode |
| `coding.testing` | tdd, webapp-testing, verification-before-completion |
| `coding.architecture` | api-and-interface-design, backend-patterns, improve-codebase-architecture |
| `coding.refactoring` | code-simplification, improve-codebase-architecture, ponytail |
| `coding.performance` | performance-optimization, diagnose |
| `coding.review` | requesting-code-review, receiving-code-review, codescene-cli, ponytail-review, ponytail-audit |
| `coding.delivery` | finishing-a-development-branch, shipping-and-launch, ci-cd-and-automation |
| `coding.operations` | ci-cd-and-automation, observability-and-instrumentation |
| `coding.migration-source` | deprecation-and-migration, source-driven-development |
| `security.secure-coding` | security-review |
| `security.threat-modeling` | threat-modeling |
| `security.red-teaming` | security-review, threat-modeling |
| `frontend.ui-engineering` | frontend-ui-engineering, frontend-design |
| `frontend.visual-design` | frontend-design, design-review, hallmark, web-design-dna |
| `frontend.testing` | webapp-testing |
| `docs.technical-writing` | technical-writer, documentation-and-adrs |
| `docs.architecture-visuals` | archify |
| `media.presentations` | deck-dna, visualization-expert |
| `media.marketing` | marketing-pipeline, deck-dna |
| `media.data-visualization` | visualization-expert, archify |
| `agents.skills-context` | skill-writer, progressive-disclosure, context-audit, using-superpowers, j-space |
| `agents.orchestration` | pi-subagents, pi-intercom, subagent-driven-development |
| `agents.mcp` | mcp-builder, mcp-scripting |
| `style.minimalism` | ponytail, ponytail-review, ponytail-audit, ponytail-debt |
| `style.ponytail-utility` | ponytail-help, ponytail-gain |

Notes:
- A skill may appear in multiple leaves; this is expected.
- `inspect-script-mode` is a SmartRead package skill, not one of the 51 global directories, but should be included once package-skill shipping is fixed.
- `security.red-teaming` intentionally overlaps with secure review/threat modeling until a dedicated offensive skill exists.
- `using-superpowers` should likely become manual-only because its current purpose is itself skill selection; otherwise the new router can route to an old router.
- `ponytail-help` and `ponytail-gain` should be manual-only command/reference utilities.
- Consider making `j-space` manual-only initially because its broad "complex task" semantics can make it dominate routing.

## Routing input contract

The main agent supplies a concise **actual-task state**, not transcript history and not the untouched user message.

Recommended state format:

```text
Goal: <what the task has become after investigation>
Findings:
- <important evidence>
TODO:
1. <concrete remaining work>
2. <concrete remaining work>
Constraints:
- <only constraints relevant to execution>
```

Keep this bounded. Target roughly 200-300 tokens for v0 so category questions have room in smaller Laya contexts.
## Skill tool API

Extend the current tool rather than adding `shiori_*` tools.

Proposed actions:

```ts
skill({ action: "route", state: "<investigated task + TODOs>" })
skill({ action: "category", category: "coding.debugging" })
skill({ action: "read", name: "diagnose", mode: "compact" })
skill({ action: "read", name: "diagnose", mode: "full" })

// Existing compatibility:
skill({ action: "list" })
skill({ action: "search", query: "debug flaky test" })
skill({ action: "read", name: "diagnose" }) // still full
```

`route` returns category probabilities only. It does not return skill bodies and does not auto-open the highest category.

`category` returns the category description plus cards for currently discovered, visible skills mapped into that category.

`read` remains the only action that injects procedural skill content into the model context.

Explicit skill invocation must continue to work even if routing is disabled, Laya is unavailable, or zero-catalog suppression is active.

## Compact versus full skill loading

Full mode is today's `SKILL.md` read.

Compact mode should be deterministic and require no second LLM:
1. If `COMPACT.md` exists inside the skill directory, use it.
2. Else if frontmatter later gains a `compact` field, use it.
3. Else synthesize a bounded compact view from parsed metadata: description, H2 outline, and a bounded `WHEN` / `When to Use` section when present.
4. Enforce a hard character/token-ish cap and tell the agent that `mode:"full"` is available.

Category cards are smaller still: name + normalized one-line description only.
## What to adopt from Shiori

Adopt the ideas, not the extension wholesale.

### 1. Zero-catalog mode

Port Shiori's conservative system-prompt catalog suppression behavior:
- remove the normal Pi skill catalog only when a known boundary is recognized;
- support XML and Markdown catalog forms with fixtures;
- fail open when a catalog signal exists but its boundary is unknown;
- never delete arbitrary prompt material on a fuzzy match;
- explicit skill invocation remains allowed.

SmartRead should register this as a **separate every-turn prompt hook**. Do not place it behind the existing `repoMapInjectedThisSession` guard.

Rollout:
- first ship routing with normal catalog still visible;
- add `zeroCatalog` as an opt-in config;
- make it the recommended mode only after host-version fixtures are stable.

### 2. Inventory outside the prompt

Keep the full discovered skill inventory in SmartRead's registry. The model should see only:
- the tiny SmartRead skill-routing instruction;
- Laya's routed category probabilities when it explicitly asks;
- cards for categories the agent chooses to open;
- compact/full bodies the agent explicitly loads.

### 3. On-demand loading

Retain Shiori's strongest boundary: discovery is cheap; full procedural instructions enter context only on demand.

### 4. Diagnostics and feedback

Borrow Shiori's session-local counters later, but keep MVP telemetry small:
- route calls;
- category probabilities returned;
- categories opened;
- compact loads;
- full loads;
- model load / inference latency.

Do not persist user task-state text or skill bodies as analytics.
## What not to adopt from Shiori

- No Shiori SQLite FTS index for skill routing. Laya is routing stable categories, not retrieving arbitrary skills.
- No `shiori_recommend` or `shiori_load_skill` duplicate tools.
- No trigger-list policy DSL as the primary semantic router.
- No automatic pre-loading of multiple skill bodies.
- No routing directly from `before_agent_start` prompt text.
- No Shiori-specific query aliases or language heuristics.
- No separate Shiori policy file if SmartRead config plus per-root taxonomy manifests can express the behavior.

## Local Laya runtime

Treat Laya as an optional local capability behind a small interface.

```ts
interface CategoryRouter {
  route(state: string, taxonomy: ResolvedTaxonomy): Promise<RoutingResult>;
}
```

Implementation rules:
- lazy singleton model/session;
- no model work at extension activation or session start;
- one root inference pass, then one leaf inference pass;
- independent boolean/noul-style category questions, not one forced single-choice answer;
- configurable root expansion floor and max roots;
- configurable number of leaf results rendered;
- timeouts/abort where supported;
- graceful error if model/runtime is absent;
- `list/search/category/read` continue working without Laya.

Ship the Node/ONNX runtime integration, not multi-gigabyte model weights inside the SmartRead npm tarball. Let the Laya runtime/model manager use a cache or configured local model path. The first explicit route call is the earliest point model acquisition/loading may happen.
## Configuration

Add a small `skills` section to `pi-smartread.config.json`:

```json
{
  "skills": {
    "routing": {
      "enabled": true,
      "provider": "laya",
      "zeroCatalog": false,
      "rootFloor": 0.25,
      "maxRoots": 4,
      "maxLeafResults": 8
    }
  }
}
```

Do not put the full 51-skill taxonomy in this project config. Taxonomy belongs with skill roots in `skill-catalog.json`.

Any model-path override should preferably come from a user-level/default cache or an environment variable such as `PI_SMARTREAD_LAYA_MODEL_PATH`, rather than trusting arbitrary project configuration to point the runtime at model files.

## Proposed source layout

```text
src/skills/
  types.ts                 SkillEntry, taxonomy and routing types
  frontmatter.ts           real YAML parsing
  discovery.ts             roots + precedence + scanning
  registry.ts              canonical discovered inventory
  taxonomy.ts              manifest loading/merge/validation
  compact.ts               category cards + compact renderer
  router.ts                two-stage category routing policy
  laya-router.ts           lazy ONNX/Laya adapter
  prompt-suppression.ts    conservative Shiori-derived zero-catalog logic
  metrics.ts               small session-local counters (optional first pass)

src/runtime/
  skill-tool.ts            thin public tool adapter
  skill-catalog-hook.ts    every-turn zero-catalog suppression hook
```

Also update `src/protocols/skill-protocol.ts` to resolve through the shared registry instead of assuming the global root only.
## Configuration

Add a small `skills` section to `pi-smartread.config.json`:

```json
{
  "skills": {
    "routing": {
      "enabled": true,
      "provider": "laya",
      "zeroCatalog": false,
      "rootFloor": 0.25,
      "maxRoots": 4,
      "maxLeafResults": 8
    }
  }
}
```

Do not put the full 51-skill taxonomy in this project config. Taxonomy belongs with skill roots in `skill-catalog.json`.

Any model-path override should preferably come from a user-level/default cache or an environment variable such as `PI_SMARTREAD_LAYA_MODEL_PATH`, rather than trusting arbitrary project configuration to point the runtime at model files.

## Proposed source layout

```text
src/skills/
  types.ts                 SkillEntry, taxonomy and routing types
  frontmatter.ts           real YAML parsing
  discovery.ts             roots + precedence + scanning
  registry.ts              canonical discovered inventory
  taxonomy.ts              manifest loading/merge/validation
  compact.ts               category cards + compact renderer
  router.ts                two-stage category routing policy
  laya-router.ts           lazy ONNX/Laya adapter
  prompt-suppression.ts    conservative Shiori-derived zero-catalog logic
  metrics.ts               small session-local counters (optional first pass)

src/runtime/
  skill-tool.ts            thin public tool adapter
  skill-catalog-hook.ts    every-turn zero-catalog suppression hook
```

Also update `src/protocols/skill-protocol.ts` to resolve through the shared registry instead of assuming the global root only.
## Implementation phases

### Phase 1 - Registry and metadata correctness

- Add a real YAML parser (the `yaml` package is sufficient) and fix block-scalar descriptions.
- Extract discovery, entries, and safe file resolution out of `runtime/skill-tool.ts`.
- Preserve existing `list/search/read` behavior.
- Define deterministic root/duplicate precedence and lock it with tests.
- Unify `skill://` lookup with the registry.
- Ship SmartRead's `skills/**` directory in npm and declare package skills correctly.

Exit criterion: current skill commands behave the same, but all 51 global descriptions parse correctly and package/project/global skills share one registry.

### Phase 2 - Taxonomy and progressive disclosure

- Implement per-root `skill-catalog.json` loading and validation.
- Add the initial global taxonomy above.
- Add `action:"category"`.
- Add `mode:"compact"|"full"` to reads.
- Add manual-only routing metadata.
- Keep unclassified skills discoverable manually.

Exit criterion: no Laya dependency yet; an agent can browse the hierarchy and load compact/full skills deterministically.
### Phase 3 - Local Laya routing

- Add the optional Laya/ONNX runtime dependency.
- Implement lazy `LayaCategoryRouter`.
- Add `action:"route"` accepting concise actual-task state.
- Implement root pass then leaf pass.
- Return probabilities without auto-opening categories or auto-loading skills.
- Add a small tool-guide instruction: investigate first, make TODOs, then route.

Exit criterion: raw user input alone causes zero Laya work; an explicit post-investigation route call returns useful multi-label category probabilities.

### Phase 4 - Shiori-style zero catalog

- Port conservative catalog boundary detection with attribution in source comments/tests.
- Register a dedicated every-turn suppression hook.
- Add `skills.routing.zeroCatalog` config, default off initially.
- Preserve explicit `/skill:name` behavior and the SmartRead `skill` tool.

Exit criterion: supported catalog shapes disappear from the system prompt without changing any unrelated prompt text; unknown shapes fail open.

### Phase 5 - Evaluation and tuning

- Add session-local route/open/load counters and latency.
- Exercise representative debugging, architecture, frontend, security, docs, orchestration, and mixed-domain tasks.
- Tune category descriptions before probability thresholds.
- Measure false-negative categories separately from harmless extra categories.
- Only after local routing proves useful consider a hosted router/provider implementation.
## Test plan

Add unit/integration coverage for:
- multiline YAML `|` and `>` frontmatter descriptions;
- root discovery and duplicate precedence;
- taxonomy manifests with overlapping skill memberships;
- invalid category references and unknown skills;
- manual-only skills never appearing in route/category output;
- category cards never including full `SKILL.md` bodies;
- compact fallback behavior and hard size cap;
- full reads retaining current path-traversal/symlink protections;
- `skill://` resolving project/package/global skills through the shared registry;
- Laya adapter lazy initialization (zero loads on startup and raw input);
- root multi-label scoring and leaf expansion;
- mocked probability ordering and pruning;
- route failure leaving manual skill operations usable;
- XML and Markdown skill-catalog suppression;
- suppression fail-open on unknown prompt boundaries;
- explicit skill invocation under zero-catalog mode.

## Success criteria

The design is successful when:
1. A normal first user request does not invoke Laya.
2. The main model can investigate freely before routing.
3. A concise TODO-state route call reduces ~52 available skills to a handful of relevant semantic areas.
4. The agent, not Laya, decides which category to inspect.
5. Opening a category adds only small skill cards.
6. No full skill enters context until the agent explicitly asks for it.
7. Compact mode is materially smaller than full mode.
8. Mixed tasks can surface multiple domains at once.
9. Laya failure does not break existing manual skill discovery/loading.
10. Zero-catalog mode reduces prompt noise without unsafe prompt surgery.

## Explicit non-goals for v0

- Hosted routing service.
- Skill-level Laya ranking.
- Automatic skill loading.
- Automatic routing from the original prompt.
- Training/fine-tuning Laya.
- Embedding search over skills.
- Replacing the main agent's reasoning or TODO planning.
- Forcing every skill into exactly one category.

## Design principle to preserve

**Reason first, route second, disclose progressively.**

The capable agent determines what work actually exists. Laya cheaply identifies the neighborhoods. The agent chooses the street, then decides whether it needs the postcard-sized compact instructions or the full map.
