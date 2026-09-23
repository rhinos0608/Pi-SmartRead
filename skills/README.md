# Skills convention

Lane skills for Pi-SmartRead. Thin wrappers over `lsp` tool + `read`/`grep`/`inspect`. No new runtime code.

## Layout

- Path: `skills/<kebab-case>/SKILL.md`
- Directory name MUST equal frontmatter `name`
- Names unique repo-wide, `lsp-*` reserved for LSP lane family

## Required frontmatter

```yaml
---
name: <kebab-case-same-as-dir>
description: <one line, verb + what + when>
---
```

Rules:
- `name`: kebab-case, matches parent dir exactly
- `description`: single line, states trigger condition
- Loader (`src/runtime/skill-tool.ts`) drops skills missing `description`; `name` falls back to dir basename — set both explicit

## Recommended body

1. One-line purpose
2. `WHEN` — trigger conditions (bullets)
3. `WHEN NOT` — cheaper alternative (bullets)
4. `Workflow` — numbered `lsp`/`read`/`grep` steps with exact ops
5. `Guardrails` — read-only boundary; mutation skills MUST state: SmartRead obtains semantic proposals; SmartEdit owns mutation
6. `EXAMPLE` — fenced `lsp`-shaped call block
7. `Budgets`/`Output` — call caps, degraded-result note where relevant

Seed convention: `skills/inspect-script-mode/SKILL.md`.

## Lane family (Criterion 15)

| Skill | Job |
|---|---|
| `lsp-explore` | definition/hover/symbols first contact |
| `lsp-impact` | references + call hierarchy blast radius |
| `lsp-local-symbols` | documentSymbols outline before read slices |
| `lsp-rename` | rename proposal only (SmartEdit applies) |
| `lsp-safe-refactor` | codeAction/prepareRename triage (SmartEdit applies) |
| `lsp-fix` | diagnostics → hover → fix proposal (SmartEdit applies) |
| `lsp-cross-root` | explicit workspace/server routing, no invented restrictions |
| `lsp-verify` | post-edit definition/references/diagnostics check |

## Validation

```bash
node scripts/validate-skills.mjs
```

Checks: frontmatter `name`+`description`, dir/name equality, uniqueness, `WHEN`/`WHEN NOT`/`EXAMPLE` sections present. No runtime registry — `skill-tool.ts:discoverSkills` scans `skills/` automatically; verify, don't register.
