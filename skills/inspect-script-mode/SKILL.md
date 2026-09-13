---
name: inspect-script-mode
description: Compose multi-hop code investigations (grep to read to LSP to graph) in one inspect({ script }) call instead of N sequential tool calls.
---

# inspect script mode

One `inspect({ script })` call runs a bounded read-only JS program that composes
the calls you would otherwise make one at a time.

## WHEN

- Each call's arguments depend on the previous call's result: grep a symbol,
  then LSP references on the hit, then graph impact on those files.
- The chain would otherwise cost 3+ sequential model/tool round trips.

## WHEN NOT

- One `grep`, `read`, or `inspect` call already answers the question.
- You need raw file prose in context (script mode returns a synthesized JSON
  result, not file text) — use plain `read`.

## Host API (the only names a script can call)

- `grep(pattern, opts)`, `read(path, opts)`
- `inspectFile(path, opts)`, `inspectDir(path, opts)`
- `lsp.definition/references/implementation/hover/documentSymbols/`
  `prepareCallHierarchy/incomingCalls/outgoingCalls({ path, line, character })`
- `lsp.workspaceSymbols({ query, path })` (path must be a directory)
- `graph.impact/deadCode/callGraph/hotspots/routes/diff({ path })`,
  `graph.clusters/layers/boundaries({ path })` (directory only)

No `eval`/`Function`, no `edit`/`write`/`patch` — read-only by construction.

## EXAMPLE

```js
const g = await grep("handleAuth", { literal: true });
const refs = await lsp.references({ path: "src/auth.ts", line: 42, character: 10 });
return { hits: g.totalHits, refs: refs.items.length };
```

## Budgets (defaults)

50 total calls, 10 `lsp.*`, 5 concurrent, ~5s deadline. Over-budget runs
return a degraded result with a partial call log, never a throw. The outer
result's `upstreamDetails.script.callLog` names every op, path, and status.

Full architecture, threat model, and quotas:
`docs/plans/2026-09-13-inspect-script-mode-design.md`.
