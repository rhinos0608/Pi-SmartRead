# Enhanced `find` (overrides pi builtin) — design

Status: approved direction (2026-10-05); spec pending final review.
Scope: workstream 2. Consumes the `Judge` interface from
`2026-10-05-grep-judge-design.md` (workstream 1).

## Goal

Replace pi's builtin `find` with a SmartRead `find` that locates **files and directories**
— never line ranges (those stay in `grep`). It stays call-compatible with the builtin
(`pattern`, `path`, `limit`) and adds ranking, fuzzy name matching, natural-language file
finding (judged when the judge is on), and agent-friendly grouped output.

## Decisions (user-approved)

- Option 1: `find` returns files/directories only; line-level localization stays in `grep`.
- Exposed in both the Pi extension and the standalone MCP server.
- `ls` stays removed; `find` is no longer removed at `session_start`.

## Current state (verified)

- Pi builtin `find` (`pi-coding-agent/dist/core/tools/find.js`): `{pattern, path?, limit?=1000}`,
  spawns `fd --glob --hidden`, respects `.gitignore`, unsorted traversal order, flat
  newline list, 50 KB cap.
- SmartRead removes `find` and `ls` at `session_start` (`src/index.ts:119-127`), asserted by
  `test/unit/lifecycle-activation.test.ts:120`. `bash-misuse-hint.ts` points shell `find`
  at `inspect` directory mode.
- Override pattern: `pi.registerTool` with the same name, as `registerReadTool` does for `read`.
- Reusable parts: `discoverFiles` (`src/file-discovery.ts:385`, honours `.gitignore`,
  `.ignore`, `.smartignore`), `scorePathByQuery` (`src/search/resolver.ts:41`), semantic
  index, shared context graph + PageRank, structural tags cache.

## References that shaped this (audited)

- OMP `glob`: default/max 200, sorted by mtime, output grouped by directory
  (`formatGroupedPaths`), 5 s timeout returning partial results with "narrow the pattern"
  steering, refuses `/` as a root.
- OMP `find` Wave 1: judges a lexical shortlist of 128 files rendered as a tagged directory
  tree; **files only are judged**, folders are untagged headers.
- VS Code Quick Open scorer: prefer filename (label) matches unless the query contains a
  path separator; prefix boost `round(query.length / label.length * 100)`.
- fzf path scheme: Smith-Waterman with boundary bonuses after `/`, camelCase, consecutive
  matches; tie-break on the tail path component, then length.
- Note: Claude Code Glob's sort direction is disputed by our audit (source examined was an
  unofficial mirror; it showed `--sort=modified`, i.e. oldest first). We do not cite it.

## Behaviour

### Schema (identical to the builtin — no new parameters)

```
pattern: string            // glob, name fragment, or natural-language description
path?:   string            // search root (default cwd); "/" rejected
limit?:  number            // default 100 (glob/fuzzy), 20 (natural language); max 500
```

Judging is user configuration only (`/judge`, or `PI_SMARTREAD_JUDGE_*` in MCP).

### Mode selection (from `pattern`)

| Mode | Detected when | Matching | Ranking |
|---|---|---|---|
| Glob | contains `*`, `?`, `[`, `{` | `minimatch` over `discoverFiles` output; `/` in pattern matches the full relative path, otherwise basename (builtin-compatible) | git-dirty first → mtime desc → path |
| Fuzzy name | otherwise, and not natural language | fzf-style path scoring with VS Code label preference (no separator → match basename first) | score → shorter tail → mtime desc |
| Natural language | `isNaturalLanguageQuery(pattern)` (shared with grep) | candidate union below | fused score, then judge (if on) |

Directories: in glob and fuzzy modes, directories that contain discovered files are
matchable entries (so `src/**/judge` finds the directory). Ignored directories never appear.

### Natural-language mode

1. Candidates (≤ 128 files), fused by reciprocal rank:
   - `scorePathByQuery` over all discovered paths;
   - semantic index file-level aggregate (when the index is available — never triggers a build);
   - top symbol names per file from the structural tags cache matched against query terms;
   - PageRank as a weak prior (only if the shared graph is already built).
2. Judge off: return the fused top `limit`, labelled `ranked (unjudged)`.
3. Judge on (Wave-1 style, SmartRead twist): render the shortlist as a directory tree in
   the judge state, each file tagged with size **and up to 8 top-level symbol names** (OMP
   judges names only). One `noul` per file:
   `Is the file tagged <key> ("<path>") likely to contain what this search is looking for: "<query>"? Judge by its path, symbols, and place in \`tree\`; apply \`criteria.file\`.`
   - true: `A file at this path plausibly contains code, text, or data matching the search.`
   - false: `The file is unrelated by name, symbols, and location.`
   Keep p ≥ 0.40, order by p desc. Directory entries are reported when ≥ 2 kept files share
   a directory (score = max of children); directories are not judged directly (v1).
4. Backend batching and failure handling reuse workstream 1: errors/timeouts/missing key →
   unjudged ranking plus `degraded: judge_<code>`. Never fails the call.

### Output

Grouped by directory, one header per directory, paths relative to the search root:

```
12 file(s) for "files that configure the embedding endpoint" (natural language, judged cloud jev, 0.9s)

# src/
  config.ts  0.93
# src/indexing/
  embedding.ts  0.81
  embedding-profile.ts  0.62
# docs/
  configuration.md  0.55
```

- Glob/fuzzy: no probabilities; `*` suffix marks git-dirty files.
- Hard cap = `limit`; on truncation: `(showing N of M — narrow the pattern or set path)`.
- 5 s traversal budget; on timeout return partial results sorted by the mode's ranking plus
  a steering notice. `path: "/"` is rejected.
- `details`: `{ mode, root, total, shown, truncated, entries: [{ path, type, score?, judgeP?, dirty? }], judge?: {...same shape as grep} }`.

### Evidence

`find` reveals paths, not content: it emits discovery-only evidence (no line ranges, no
patch authority), using the same envelope family `inspect` directory mode uses. Agents must
still `read` before editing. Canonical paths via the existing realpath helpers.

## Integration changes

- `src/search/find-tool.ts` (+ `find-modes.ts`, `fuzzy-path-score.ts`, `find-format.ts`).
- `src/extension-registration.ts`: register `find` (overrides builtin).
- `src/index.ts`: stop filtering `find`; keep filtering `ls`.
- `src/mcp-registry.ts`: `reg("find", ...)`.
- `src/runtime/bash-misuse-hint.ts`: shell `find -name`/`-type` hints point to the `find` tool.
- Tool description, `skills/`, README, AGENTS.md "Current model-facing surfaces" updated in
  the same change.

## Tests

- Mode detection table; glob compatibility with builtin semantics (basename vs full path,
  hidden files, `.gitignore`); `/` rejected; schema identical to the builtin.
- Fuzzy scorer: label preference, separator switch, boundary/camelCase bonuses, tie-breaks.
- NL: candidate fusion without index/graph (pure path + tags) is deterministic; judge on →
  threshold/order; judge failure → unjudged + degradation code; never triggers index/graph builds.
- Output grouping, truncation steering, timeout partial results (fake clock / injected walker).
- Lifecycle: `find` stays active, `ls` removed (update `lifecycle-activation.test.ts`).
- Registration + MCP schema parity tests include `find`.

## Build order and dependency on workstream 1

1. Phase A (independent): glob + fuzzy + NL-unjudged, output, registration, MCP, docs.
2. Phase B (after WS1 lands `src/judge/types.ts`, resolver, client): NL judge wave.

## Open risks

- NL-intent heuristic shared with grep; misclassified fuzzy fragments with spaces.
- Large monorepos: `discoverFiles` cost; rely on the existing fs-scan cache and the 5 s budget.
- Behaviour change for agents used to the builtin: default limit drops from 1000 to 100.
