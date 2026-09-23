# Skills convention

Repository skills are thin procedural guides over Pi-SmartRead's real tool surfaces. They add no runtime registration.

## Layout

- Path: `skills/<kebab-case>/SKILL.md`
- Directory name must equal frontmatter `name`.
- Names are unique repo-wide; `lsp-*` is reserved for the strict LSP workflow family.
- `src/runtime/skill-tool.ts` discovers package skills automatically.

## Required frontmatter

```yaml
---
name: <kebab-case-same-as-dir>
description: <one line describing what the skill does and when to use it>
---
```

Skills without a description are not model-visible. Set `name` explicitly even though the loader can fall back to the directory basename.

## Tool contracts used by skills

The model-facing language-server tool is `LSP`. It uses a flat strict request:

```json
{"operation":"goToDefinition","path":"src/auth.ts","position":{"line":41,"character":9}}
```

Strict `LSP` positions are 0-based in the returned server's negotiated encoding. Cross-root routing uses `workspace`; `server` is an exact descriptor id. Proposal operations such as `rename`, `codeActions`, and formatting never write files.

Script mode is a separate surface: `inspect { mode: "script", script }` exposes a sandboxed `lsp.*` host namespace whose navigation helpers use the inspect-navigation contract. Do not copy that host syntax into the strict `LSP` skills.

## Recommended body

1. Purpose
2. `WHEN`
3. `WHEN NOT`
4. `Workflow` using exact current tool/operation names
5. `Guardrails`
6. `EXAMPLE`
7. `Budgets`

Mutation-oriented skills must state the ownership boundary: SmartRead may return semantic proposals; SmartEdit owns mutation.

## Shipped skills

| Skill | Job |
|---|---|
| `inspect-script-mode` | Bounded multi-hop grep/read/inspect/LSP/graph composition |
| `lsp-explore` | Workspace symbols, definition, hover |
| `lsp-impact` | References, implementations, call hierarchy |
| `lsp-local-symbols` | Document-symbol outline before read slices |
| `lsp-rename` | Fresh semantic rename proposal |
| `lsp-safe-refactor` | Code-action/refactor proposal triage |
| `lsp-fix` | Diagnostics to code-action proposal |
| `lsp-cross-root` | Explicit workspace/server routing |
| `lsp-verify` | Fresh post-edit semantic verification |

## Validation

```bash
node scripts/validate-skills.mjs
```

The validator checks frontmatter, directory/name equality, uniqueness, and required `WHEN` / `WHEN NOT` / `EXAMPLE` sections. Contract correctness still needs normal tests and review.
