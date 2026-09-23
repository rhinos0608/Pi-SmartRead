---
name: lsp-fix
description: Diagnostics-driven fix proposal via LSP diagnostics, hover, and codeAction; proposal only, SmartEdit applies the edit.
---

# lsp-fix

From squiggle to fix proposal, no mutation.

## WHEN

- Compiler/linter diagnostic on a range
- Need `hover` for type context + `codeAction` for server quickfixes

## WHEN NOT

- No diagnostic — use `lsp-explore` first
- Refactor without diagnostic — use `lsp-safe-refactor`
- Post-fix check — use `lsp-verify`

## Workflow

1. `lsp diagnostics { path }` (or file diagnostics) for the error range
2. `lsp hover { path, line, character }` for type context at range
3. `lsp codeAction { path, line, character }` for server quickfixes
4. Return proposal: `{ diagnostic, quickfix, range }`. Stop. SmartEdit owns mutation.

## Guardrails

- SmartRead obtains semantic proposals; SmartEdit owns mutation. This skill MUST NOT emit edit/write/patch calls.
- Quote diagnostic verbatim; never silently broaden the fix range beyond the diagnostic.

## EXAMPLE

```js
const diags = await lsp.diagnostics({ path: "src/auth.ts" });
const at = diags.items[0];
const fix = await lsp.codeAction({ path: "src/auth.ts", line: at.line, character: at.character });
return { diagnostic: at.message, quickfixes: fix.items.map((a) => a.title) };
```

## Budgets

3–5 `lsp.*` calls. Proposal object out, zero mutations.
