---
name: lsp-rename
description: Rename scope check via LSP references and prepareRename; proposal only, SmartEdit applies the edit.
---

# lsp-rename

Scope a rename, propose it, stop before mutating.

## WHEN

- Symbol rename requested (variable, function, class, method)
- Need renameability check (`prepareRename`) + usage list (`references`)

## WHEN NOT

- Already scoped — hand proposal to SmartEdit directly
- Text-only rename across non-code files — use `grep`
- Post-rename check — use `lsp-verify`

## Workflow

1. `lsp prepareRename { path, line, character }` — renameable?
2. `lsp references { path, line, character }` — full scope list
3. Return proposal: `{ oldName, newName, anchor, usageCount, files }`
4. Stop. SmartEdit owns mutation.

## Guardrails

- SmartRead obtains semantic proposals; SmartEdit owns mutation. This skill MUST NOT emit edit/write/patch calls.
- Never apply rename file-by-file from SmartRead side; cross-file renames race without single-owner apply.

## EXAMPLE

```js
const ok = await lsp.prepareRename({ path: "src/auth.ts", line: 42, character: 10 });
const refs = await lsp.references({ path: "src/auth.ts", line: 42, character: 10 });
return { oldName: "handleAuth", newName: "authorizeRequest", renameable: !!ok, usages: refs.items };
```

## Budgets

2–4 `lsp.*` calls. Proposal object out, zero mutations.
