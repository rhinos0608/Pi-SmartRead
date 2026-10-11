---
name: lsp-safe-refactor
description: Triage strict LSP code actions and refactor proposals while leaving all file mutation to SmartEdit.
---

# lsp-safe-refactor

Ask the language server what refactors it can prove.

## WHEN

- You want server-offered refactors or source actions for a known range.
- You may need to resolve a deferred code action before handing it to SmartEdit.

## WHEN NOT

- It is a simple rename. Use `lsp-rename`.
- A diagnostic is driving the fix. Use `lsp-fix`.
- The server offers no relevant action. Do not invent one.

## Workflow

1. Build the exact 0-based `range` to refactor, using the server's negotiated position encoding.
2. Discover with `codeActions`, providing `path`, `range`, and the desired `context` (or omit it to use the discovery default).
3. Choose from the returned actions. Copy the returned `actionId` and `sourceSha256` exactly; do not derive either from the action payload.
4. Resolve with `path`, the same `range`, and `selection: { actionId, sourceSha256 }`. Repeat the same routing and context as discovery. If context was omitted during discovery, omit it again; the default applies. Never send a raw action or guess an identifier, digest, or target.
5. Treat the result as a readonly preview unless trusted SmartEdit staging is available. Return any staged proposal and provenance to SmartEdit; applying it remains an explicit `applyProposal` call.

## Guardrails

- `codeActions` requires a range. `resolveCodeAction` requires that range and a selection containing the exact returned `actionId` and lowercase SHA-256 `sourceSha256`.
- Action identifiers and digests are query/source-bound. Re-discovery must match the submitted path, range, context (including defaults), routing, source and action payload; stale or mismatched selections are refused.
- A refusal with `status: "unavailable"` may omit `server`; never infer one. `server` is otherwise the exact routed descriptor, not a value to guess.
- Resolution does not automatically select or apply an action. Without trusted SmartEdit staging, its result is a readonly preview; no edit/write/patch calls from SmartRead.

## EXAMPLE

The placeholders below stand for values copied from the live discovery response; they are not executable identifiers or targets.

```json
{"operation":"codeActions","path":"src/auth.ts","range":{"start":{"line":41,"character":0},"end":{"line":44,"character":1}},"context":{"only":["refactor"]}}
```

From `result`, copy one action's returned `actionId` and `sourceSha256`. Resolve that choice with the same path, range, routing, and context:

```json
{"operation":"resolveCodeAction","path":"src/auth.ts","range":{"start":{"line":41,"character":0},"end":{"line":44,"character":1}},"context":{"only":["refactor"]},"selection":{"actionId":"<copy returned actionId>","sourceSha256":"<copy returned sourceSha256>"}}
```

If discovery omitted `context`, omit it during resolution too.

## Budgets

One code-action request, plus at most one resolve and one impact check.
