---
name: lsp-explore
description: First contact with unfamiliar code via LSP definition, hover, and workspace symbols before reading files.
---

# lsp-explore

Resolve what a symbol is before reading around it.

## WHEN

- Unfamiliar symbol, need def + docs + type fast
- Need jump target (`definition`) before opening file
- Need candidate locations (`workspaceSymbols`) before grep

## WHEN NOT

- Already know file/line — use plain `read`
- Need all usages — use `lsp-impact`
- Need file outline — use `lsp-local-symbols`

## Workflow

1. `lsp workspaceSymbols { query }` for candidate locations
2. `lsp definition { path, line, character }` for jump target
3. `lsp hover { path, line, character }` for type/docs
4. `read` exact jump target only

## Guardrails

- Read-only. No edit/write/patch from this skill.
- Positions are 1-based line, 1-based character per tool contract.

## EXAMPLE

```js
const sym = await lsp.workspaceSymbols({ query: "handleAuth" });
const def = await lsp.definition({ path: "src/auth.ts", line: 42, character: 10 });
const docs = await lsp.hover({ path: "src/auth.ts", line: 42, character: 10 });
return { sym: sym.items, def: def.items, docs };
```

## Budgets

3–5 `lsp.*` calls. Stop at first exact definition hit.
