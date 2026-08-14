# MCP Protocol and Tool Schema Fixes

## Changes Made

### 1. mcp-server.ts — Plumb `request.signal` to tool calls
- Changed `tool.execute(toolCallId, args ?? {}, undefined, undefined, ctx)` to pass `extra.signal ?? undefined` as third arg (signal).
- Handler signature changed to `async (request, extra)` to access the `RequestHandlerExtra`'s AbortSignal.

### 2. types.ts — `ui.custom` throws Error
- Replaced `throw new Error("UI custom not available in MCP context")` with `async () => undefined as any`.
- Generic `custom<T>()` stub cannot statically type `Promise<T>`, so `as any` cast used.

### 3. graph-mutate.ts — Add `isError: true` to error returns
- Added `isError: true` to all 3 error-path return objects (root not found, path outside project, catch handler).
- Updated execute return type to include `isError?: boolean`.

### 4. git-notes-tool.ts — Add `isError: true` to error returns
- Added `isError: true` to git-root-not-found returns in both read and write tools.
- Already present in handleWrite catch block.
- Updated all return types to include `isError?: boolean`.

### 5. mcp-registry.ts — Dedup guard in `reg()`
- Added `if (registry.has(name)) return;` before `registry.register(...)` to prevent double-registration.

### 6. find-symbol-tool.ts — Replace `Type.Unsafe` with `Type.Union` for action enum
- `action` schema changed from `Type.Unsafe<"outline" | "declaration" | "references" | "implementations">({type:"string",enum:[...]})` to `Type.Union([Type.Literal("outline"), Type.Literal("declaration"), Type.Literal("references"), Type.Literal("implementations")])`.

### 7. deep-search-tool.ts — Replace `Type.Unsafe` with `Type.Union` for depth and scope enums
- `depth` and `scope` schemas changed from `Type.Unsafe` to `Type.Union([Type.Literal(...)])`.

### 8. git-notes-tool.ts — Replace `ToolContext` with `ExtensionContext`
- Removed `ToolContext` interface.
- Changed `ctx` parameter type from `ToolContext` to `ExtensionContext` in both execute functions.
- Added `ExtensionContext` to import from `@mariozechner/pi-coding-agent`.

### 9. git-notes-tool.ts — Add `maxLength` to content schema
- Added `maxLength: 64000` to `content` String schema.

### 10. deep-search-tool.ts — Rename shadowing `cwd` to `searchRoot`
- Renamed local variable `cwd` to `searchRoot` in execute function.

### 11. mcp-server.ts — Validate tool args against inputSchema
- Added `Value.Check(tool.parameters, args)` validation before execute.
- Returns `-32602 Invalid params` with error details on failure.
- Imported `Value` from `@sinclair/typebox/value`.
- Uses `as any` cast to work around TypeBox version incompatibility between `@sinclair/typebox` and `typebox` (peer dep of `@mariozechner/pi-coding-agent`).

### 12. mcp-server.ts — Fix fallback logic
- Changed from `content.length > 0 ? content : fallback` to `result === undefined ? fallback : content`.
- Only adds "no output" fallback when tool result itself is undefined, not just when content array is empty.

### 13. mcp-server.ts — Validate required prompt args
- Added loop checking all required prompt args from `MCP_PROMPTS` definition.
- Throws with `code: -32602` for missing required arguments.

### 14. mcp-server.ts — Capture `process.cwd()` at server start
- Created `SERVER_CWD` const at module level, initialized at startup.
- Replaced `cwd()` calls with `SERVER_CWD`.
- Removed `cwd` import from `node:process`.

## Files Changed

- `mcp-server.ts` — 6 changes (signal plumbing, validation, fallback logic, prompt validation, cwd snapshot, handler signature)
- `types.ts` — 1 change (ui.custom stub)
- `graph-mutate.ts` — 2 changes (isError on error paths, return type update)
- `git-notes-tool.ts` — 6 changes (isError, ExtensionContext, maxLength, missing imports for resolveDirParam)
- `mcp-registry.ts` — 1 change (dedup guard)
- `find-symbol-tool.ts` — 1 change (Type.Unsafe → Type.Union)
- `deep-search-tool.ts` — 2 changes (Type.Unsafe → Type.Union, cwd → searchRoot)

## Validation

- `npm run typecheck` — passes (only pre-existing unused-import warnings remain).
- `npm test` — all MCP-related tests pass.
- Pre-existing failures: 8 test files (config validation, neural/embedding features, retrieval benchmarks) — unrelated to these changes.

## Open Risks

- TypeBox version mismatch: `Value.Check` uses `as any` cast due to `@sinclair/typebox` vs `typebox` (peer dep) schema type incompatibility. Validation may silently skip on schema types not supported by the runtime.
- The `resolveDirParam` function in `git-notes-tool.ts` appeared during edits (from a timed-out mutation). It uses `realpathSync` from `fs` and `relative`/`isAbsolute` from `path`. Imports added to fix typecheck.

## Recommended Next Step

Consider aligning TypeBox dependency — either remove `@sinclair/typebox` in favor of `typebox`, or verify the pi-coding-agent peer dep can be satisfied by the project's dependency.
