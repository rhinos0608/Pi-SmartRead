---
name: lsp-local-symbols
description: File outline via LSP documentSymbols to pick exact read slices instead of full-file reads.
---

# lsp-local-symbols

Outline first, read slices second.

## WHEN

- Large file, need symbol list before reading
- Need exact symbol line ranges for `read { offset, limit }`
- Choosing between overloads/members with same name

## WHEN NOT

- Small file — plain `read` is cheaper
- Cross-file search — use `lsp-explore` (`workspaceSymbols`)
- Usage blast radius — use `lsp-impact`

## Workflow

1. `lsp documentSymbols { path }` for outline
2. Pick target symbol range from outline
3. `read { path, offset, limit }` exact range only

## Guardrails

- Read-only. No edit/write/patch from this skill.
- Never paste full outline + full file both — outline then slice.

## EXAMPLE

```js
const outline = await lsp.documentSymbols({ path: "src/auth.ts" });
const fn = outline.items.find((s) => s.name === "handleAuth");
return { range: fn.range };
```

## Budgets

1 `lsp.*` call + 1 sliced `read`. Outline is cheap; full-file follow-up is the failure mode.
