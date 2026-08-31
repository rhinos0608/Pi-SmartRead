# pi-lens Parity — Oracle Decisions + V1 Wave Plan

> Produced by `oracle` subagent (2026-08-30) after reviewing
> `pi-lens-capability-matrix.md`, `AGENTS.md`, and direct source in both repos.
> Corrects two stale matrix claims: SmartEdit already runs post-write/edit LSP
> + compiler + ESLint diagnostics, and already supports ast-grep structural
> replace via `edit.edits[].target.{pattern,replacement}`. Spot-verified
> against source by the orchestrator before this doc was accepted.

## Inherited decisions (non-negotiable per AGENTS.md)

- No new tool names. Extend `read`, `grep`, `inspect`, `edit`.
- SmartRead owns analysis/read evidence. SmartEdit owns authorized mutation.
- Strong edit authority requires `full-file` or `line-range` evidence plus valid `fullFileSha256`.
- Direct read/grep/inspect stays cross-root unrestricted.
- Evidence `canonicalPath` remains `realpathSync`-canonical.
- No `@rhinos0608/pi-workspace-protocol` change unless serialized shared evidence types change.
- Existing static `inspect.callDepth/callDirection` stays as-is.
- Existing `edit.edits[].target.{pattern,replacement}` already provides structural replacement — do not build a parallel engine.

## 1. LSP navigation → `inspect.navigation` (SmartRead)

Add to SmartRead `inspect`, not `read` (navigation returns locations/metadata,
not source bodies; `read` stays source-returning/strong-evidence).

```ts
inspect({
  path: string,
  navigation: {
    operation: "definition" | "references" | "implementation" | "hover"
             | "documentSymbols" | "workspaceSymbols",
    line?: number, character?: number,   // 1-based; file-target ops
    query?: string,                       // workspaceSymbols only
    maxResults?: number,                  // default 20, max 100
  },
})
```

| Operation | Target | Requires | Forbids |
|---|---|---|---|
| definition/references/implementation/hover | file | line, character | query |
| documentSymbols | file | — | line, character, query |
| workspaceSymbols | directory | query | line, character |

`details.navigation = { schemaVersion:1, operation, status: "ok"|"empty"|"unavailable"|"degraded", source:"lsp", items: LocationItem[]|SymbolItem[]|HoverItem[], truncated }`.
`empty` ≠ clean/complete — never render it as proof of absence.

**Deferred (not V1):** rename, rename_file, signatureHelp, prepareCallHierarchy,
incomingCalls/outgoingCalls, executeCommand, raw capabilities. Existing static
`callDepth`/`callDirection` (tree-sitter) remains the caller/callee answer for
now. Rename belongs in `edit` eventually (multi-file strong authority, preview,
atomic transaction) — no schema reserved yet.

**Invariants:** no workspace-boundary gating added; every result path goes
through `tryCanonical(realpathSync(...))`; navigation stays `coverage:
"search-match"`; directory `workspaceSymbols` stays `mode:"map"`, zero resources.

## 2. Diagnostics ownership — preserve existing split, add on-demand to SmartRead, fix honesty in SmartEdit

- **SmartEdit** keeps owning post-write/edit diagnostics (unchanged).
- **SmartRead** adds fresh on-demand diagnostics via `inspect.diagnostics` (new
  capability — no prior on-demand path existed).
- **No shared persistent diagnostic cache, no triage/dispositions in V1** —
  triage needs stable IDs + storage that don't exist yet; building it now would
  create unusable state.

```ts
inspect({
  path: string,
  diagnostics: { waitMs?: number /*1500*/, maxPerFile?: number /*12*/, maxFiles?: number /*20, dir only*/ },
})
```

`details.diagnostics = { schemaVersion:1, status: "findings"|"unconfirmed"|"unavailable"|"partial", source:"lsp", files: FileDiagnostics[], truncated }`.
Directory target = sorted supported files capped by `maxFiles`. LSP only —
compiler/linter subprocesses stay SmartEdit-owned.

**SmartEdit honesty fix (real defect, found by oracle):**
`src/lsp/diagnostics.ts` can return an empty diagnostic list on timeout/no-pull
support with `source:"lsp"`, and `src/index.ts:963-976` then marks the LSP
check `pass` — an unconfirmed empty result renders as clean. Fix: add
`status: "confirmed"|"unconfirmed"|"unavailable"|"failed"` to the internal
`DiagnosticResult`. Only a confirmed `publishDiagnostics` match (including
`[]`) or a successful pull response (including empty `items`) is `confirmed`.
Unconfirmed/unavailable/failed → LSP check `skipped`, fall through to compiler
fallback (already exists). No protocol/schema change — internal correctness fix.

## 3. Structural search → `grep.structural` (SmartRead); replace stays as-is (SmartEdit)

Search is the real gap; replace already exists (see matrix correction above —
do not re-build it).

```ts
grep({
  pattern: string,
  structural: { language?: SupportedLang, skip?: number, groupByFile?: boolean },
  path?, glob?, limit?, contextLines?, graphFilter?,
})
```

Invalid combos: `structural` + `literal`, `structural` + `ignoreCase`,
unsupported explicit language, uninferable language with no explicit
`language`. `graphFilter` still applies as a post-filter.

V1 excludes: raw YAML rules, strictness modes, `insideKind`/`hasKind`/
`hasDescendantKind`/`follows`/`precedes`, AST dump — these need real ast-grep
rule compilation, not a plain `findAll(pattern)`.

`details.structuralSearch = { schemaVersion:1, status:"ok"|"unavailable", skip, groupByFile, totalMatches, shownMatches, truncated, matches: [{path, line, character, endLine, endCharacter, text, read:{path,offset,limit}}] }`.
Missing optional `@ast-grep/napi` → explicit `status:"unavailable"`, never a
silent zero-match result. Reuses grep's existing evidence builder — hits stay
weak `search-match`.

SmartEdit's existing `edit.edits[].target.{pattern,replacement}` is unchanged
by this decision — only its test coverage gets hardened in WP-SE2 (freshness/
authority edge cases), no new API.

## 4. Autofix/format vs evidence authority — **no mutating autofix in V1**

Real, unresolved architecture conflict, not a convention question:

- Post-commit formatter mutation (pi-lens's model) bypasses the read coverage
  the agent actually had at edit time.
- A formatter self-minting fresh evidence for its own output makes the
  mutation producer its own authorizer — a real security-relevant precedent.
- Native `write` can't be staged inside SmartEdit's transaction without either
  replacing the host `write` tool or approving self-authorized mutation.

**Decision:** keep the existing advisory-only format-equivalence check (no
mutation). No new `format`/`fix` schema field. Any future mutating
autofix must (spec for later, not V1): be explicitly requested through `edit`
(never implicit), require `full-file` strong evidence for every existing file,
run pre-commit inside the transaction, show the delta in preview, commit
atomically, never self-mint/auto-refresh preimage authority, and return fresh
postimage evidence that invalidates the old one.

**Escalation:** full pi-lens-style automatic formatting of native `write`
requires either replacing host `write` or approving self-authorized
post-write mutation — neither is authorized by current contracts. This is a
product decision, not an oracle call.

## 5. Security/scanner scope — **none in V1**

Opengrep/gitleaks/trivy/govulncheck, auto-install, commit/push guard, source
suppression comments, disposition persistence — all deferred. Reasons:
external-binary trust/supply-chain boundary, commit interception fits neither
repo's current authority model, scanner triage needs diagnostic IDs that don't
exist yet, no approved scanner/rule catalog (choosing one now would be
product guesswork requiring its own threat model). V1 keeps existing SmartEdit
advisory lanes (compiler/LSP/ESLint/structural/fake-logic/format-equivalence)
as-is. No interface, no work package.

## 6. MCP scope — ride existing registry, no new surface

`inspect.navigation`, `inspect.diagnostics`, `grep.structural` flow through the
existing `ToolRegistry` → MCP mirror automatically (same schemas, no
`pilens_*` names, no lifecycle tools, no MCP `edit`/`read`, no SmartEdit MCP
server). Since the MCP adapter returns content-only (`{content, isError}`,
drops Pi `details`), rendered text for all three new capabilities must be
fully self-sufficient — never rely on `details` alone for essential info.

---

## Drift found during this review (fix, don't rebuild)

1. **SmartEdit diagnostic honesty defect** — `src/lsp/diagnostics.ts:138-164` /
   `src/index.ts:963-976`: an unconfirmed empty LSP result can render as
   `pass`. Real bug, fixed in WP-SE1.
2. Matrix's diagnostics/structural-replace GAP claims were stale — corrected
   in `pi-lens-capability-matrix.md` (this session, verified against source).

---

## V1 Wave Plan

### Wave 0 — done this session
Matrix correction (`pi-lens-capability-matrix.md`) — completed by orchestrator.

### Wave 1 — parallel, 4 work packages, disjoint files, 2 per repo

| WP | Repo | Scope | Create | Modify |
|---|---|---|---|---|
| **WP-SR1** | SmartRead | LSP inspection outcome engine (navigation + fresh diagnostics, honesty-labeled) | `src/lsp-inspection.ts`, `test/unit/lsp-inspection.test.ts` | `src/lsp-bridge.ts` (additive outcome methods only — preserve existing `goToDefinition` etc.), `test/unit/lsp-bridge-diagnostics.test.ts` |
| **WP-SR2** | SmartRead | ast-grep structural search engine (no tool wiring yet) | `src/structural-search.ts`, `test/unit/structural-search.test.ts` | `package.json`/`package-lock.json` (`optionalDependencies: "@ast-grep/napi": "^0.45.1"`) |
| **WP-SE1** | SmartEdit | Diagnostic honesty fix | — | `src/lsp/diagnostics.ts`, `src/index.ts`, `test/lsp.test.ts`, `test/extension-init.test.ts` |
| **WP-SE2** | SmartEdit | Structural-replace test hardening (verify existing capability; fix only defects the tests expose) | — | `test/edit-contract.test.ts`, `test/edit-planner.test.ts`, `test/edit-tool-capabilities.test.ts`, `test/patch.test.ts` (freshness coverage if missing) |

### Wave 2 — depends on Wave 1, 2 parallel work packages (disjoint files)

| WP | Repo | Scope | Modify | Depends on |
|---|---|---|---|---|
| **WP-SR3** | SmartRead | Wire `inspect.navigation` + `inspect.diagnostics` schemas/validation/rendering | `src/inspect-tool.ts`, `src/inspect-types.ts`, `src/inspect.ts`, `test/unit/inspect-v4.test.ts`, `test/unit/inspect-enrichment.test.ts` | WP-SR1 |
| **WP-SR4** | SmartRead | Wire `grep.structural` schema/validation/rendering | `src/grep-tool.ts`, `test/unit/grep-tool.test.ts`, `test/unit/read-evidence.test.ts`, `test/unit/tool-compatibility-contract.test.ts` | WP-SR2 |

### Wave 3 — depends on Wave 2, serial

| WP | Repo | Scope | Modify | Depends on |
|---|---|---|---|---|
| **WP-SR5** | SmartRead | Provider wiring: inject one shared LSP inspection provider into inspect; Pi + MCP share definitions; no eager LSP startup from plain inspect | `src/index.ts`, `src/mcp-registry.ts`, `src/tool-guidance.ts` | WP-SR3, WP-SR4 |
| **WP-SR6** | SmartRead | MCP parity verification (tests only unless a defect surfaces) | MCP schema round-trip tests for all 3 new capabilities | WP-SR5 |

### Wave 4 — verification (both repos, independent)

```bash
# Pi-SmartRead
npm run typecheck && npm test
# Pi-SmartEdit
npm run typecheck && npm test && npm run lint
```

Manual smoke set:
```text
inspect { path:"src/index.ts", navigation:{operation:"documentSymbols"} }
inspect { path:"src/index.ts", navigation:{operation:"references",line:1,character:1} }
inspect { path:"src/index.ts", diagnostics:{} }
inspect { path:"src", diagnostics:{maxFiles:5} }
grep { pattern:"console.log($ARG)", structural:{} }
edit { path:"x.ts", edits:[{target:{pattern:"console.log($ARG)",replacement:"logger.info($ARG)"}}] }
```
Confirm no new tool names, no `@rhinos0608/pi-workspace-protocol` delta.

## Risks / explicitly out of V1
- SmartRead's LSP bridge covers far fewer languages than pi-lens's 45-server catalog.
- `@ast-grep/napi` is a platform/install-dependent optional dep.
- Directory diagnostics can still cost multiple seconds despite `maxFiles` caps.
- No diagnostic recall, dispositions, or stable finding IDs in V1.
- No mutating autofix/format, no external security scanners in V1 — both need separate product/threat-model approval before any future phase.
