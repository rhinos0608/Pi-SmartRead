---
name: lsp-verify
description: Post-edit verification via LSP definition, references, and diagnostics to confirm a change landed clean.
---

# lsp-verify

Confirm the edit, don't assume it.

## WHEN

- After SmartEdit applies rename/refactor/fix
- Need fresh `diagnostics` on touched files
- Need `definition`/`references` re-check that scope matches proposal

## WHEN NOT

- Pre-edit scoping — use `lsp-impact`/`lsp-rename`/`lsp-fix`
- No edit happened — nothing to verify
- Broad repo health — use `inspect` directory mode

## Workflow

1. `lsp diagnostics { path }` on each touched file — zero new errors?
2. `lsp definition { path, line, character }` at new anchor — resolves?
3. `lsp references { path, line, character }` — count matches proposal scope?
4. Report pass/fail with verbatim diagnostics; on fail, new proposal, not a silent retry loop

## Guardrails

- Read-only. No edit/write/patch from this skill — verification only, even on failure.
- Cap at one verify pass per edit; second failure goes back to owner with evidence.

## EXAMPLE

```js
const diags = await lsp.diagnostics({ path: "src/auth.ts" });
const def = await lsp.definition({ path: "src/auth.ts", line: 42, character: 10 });
const refs = await lsp.references({ path: "src/auth.ts", line: 42, character: 10 });
return { clean: diags.items.length === 0, resolves: def.items.length > 0, usages: refs.items.length };
```

## Budgets

3–5 `lsp.*` calls per touched file. Fail loud with evidence.
