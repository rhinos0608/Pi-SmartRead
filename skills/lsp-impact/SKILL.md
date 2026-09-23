---
name: lsp-impact
description: Blast-radius check via LSP references and call hierarchy before changing a symbol.
---

# lsp-impact

Find every caller before touching shared code.

## WHEN

- Changing shared function/class/method signature
- Need caller/callee chains (`incomingCalls`/`outgoingCalls`)
- Need full usage list (`references`) for safe edit scope

## WHEN NOT

- Single local variable — plain `read` suffices
- Just need definition — use `lsp-explore`
- Post-edit check — use `lsp-verify`

## Workflow

1. `lsp references { path, line, character }` for all usages
2. `lsp prepareCallHierarchy { path, line, character }`, then `incomingCalls`/`outgoingCalls` for chains
3. `lsp implementation { path, line, character }` for interface dispatch targets
4. Summarize scope: files + call depth, hand to edit owner

## Guardrails

- Read-only. No edit/write/patch from this skill.
- Cap hierarchy expansion: depth 1–2 default, depth 3+ only with explicit reason.

## EXAMPLE

```js
const refs = await lsp.references({ path: "src/auth.ts", line: 42, character: 10 });
const hier = await lsp.prepareCallHierarchy({ path: "src/auth.ts", line: 42, character: 10 });
const callers = await lsp.incomingCalls({ path: "src/auth.ts", line: 42, character: 10 });
return { usageCount: refs.items.length, callers: callers.items };
```

## Budgets

5–8 `lsp.*` calls. Degraded result with partial caller list over timeout, never throw.
