---
name: lsp-cross-root
description: Route LSP requests to the explicit workspace root and server when files span multiple roots.
---

# lsp-cross-root

Say which root and which server, every call.

## WHEN

- Files live under different workspace roots / servers
- Ambiguous definition/reference results across roots
- Need to pin `root`/`server` params explicitly

## WHEN NOT

- Single-root session — default routing suffices
- Plain cross-file jump in one root — use `lsp-explore`
- Path access policy question — not decided here (see guardrails)

## Workflow

1. Identify owning root per file from session workspace list
2. Pass explicit `root` (and `server` when multiple servers share a root) on every `lsp.*` call
3. `lsp definition`/`references` per root; merge with root labels, never silently dedupe
4. Report per-root provenance: `{ root, server, items }`

## Guardrails

- Read-only. No edit/write/patch from this skill.
- State explicit workspace/server routing without inventing path restrictions: cross-root reads are permission-external to SmartRead (see AGENTS.md operational contracts). This skill routes requests; it does not gate, allow, or deny paths.

## EXAMPLE

```js
const a = await lsp.definition({ path: "app-a/src/auth.ts", line: 10, character: 5, root: "app-a" });
const b = await lsp.definition({ path: "app-b/src/auth.ts", line: 10, character: 5, root: "app-b" });
return { roots: [{ root: "app-a", items: a.items }, { root: "app-b", items: b.items }] };
```

## Budgets

2× single-root cost. One call chain per root; merge at end.
