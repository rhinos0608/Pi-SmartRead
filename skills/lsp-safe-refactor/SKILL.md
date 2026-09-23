---
name: lsp-safe-refactor
description: Refactor triage via LSP codeAction and prepareRename; proposal only, SmartEdit applies the edit.
---

# lsp-safe-refactor

Triage server-offered refactors, propose, stop before mutating.

## WHEN

- Extract/inline/move refactor requested
- Need server-offered actions (`codeAction`) at a range
- Need renameability pre-check (`prepareRename`) before proposing

## WHEN NOT

- Simple rename — use `lsp-rename`
- Diagnostic fix — use `lsp-fix`
- Manual rewrite with no server action — skip LSP, hand to SmartEdit

## Workflow

1. `lsp prepareRename { path, line, character }` where rename-shaped
2. `lsp codeAction { path, line, character }` for offered refactors
3. `lsp references { path, line, character }` to scope proposal
4. Return proposal: `{ action, range, scope }`. Stop. SmartEdit owns mutation.

## Guardrails

- SmartRead obtains semantic proposals; SmartEdit owns mutation. This skill MUST NOT emit edit/write/patch calls.
- Prefer server-offered action over hand-rolled rewrite; if server offers nothing, say so — don't invent an action.

## EXAMPLE

```js
const actions = await lsp.codeAction({ path: "src/auth.ts", line: 42, character: 10 });
const refs = await lsp.references({ path: "src/auth.ts", line: 42, character: 10 });
return { offered: actions.items.map((a) => a.title), scope: refs.items.length };
```

## Budgets

3–5 `lsp.*` calls. Proposal object out, zero mutations.
