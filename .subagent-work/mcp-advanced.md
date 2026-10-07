# Implementation Summary: MCP SDK Advanced Features (Prompts, Resources, ResourceLink)

## Overview

Implemented MCP SDK v1.29.0 advanced capabilities for Pi-SmartRead: prompts, resources, and `resource_link` content items. All 14 tests pass with `--timeout 60000` (required due to subprocess spawn overhead).

## Changes Made

### `mcp-server.ts` (modified)

**Imports added:**
```typescript
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListPromptsRequestSchema,     // new
  GetPromptRequestSchema,       // new
  ListResourcesRequestSchema,    // new
  ReadResourceRequestSchema,     // new
} from "@modelcontextprotocol/sdk/types.js";
```

**Server capabilities updated:**
```typescript
{ capabilities: { tools: {}, prompts: {}, resources: {} } }
```

**3 prompt handlers added:**
- `explain-code` — args: `code` (required), `language` (optional). Returns a user message asking to explain the code with the specified language context.
- `review-diff` — args: `diff` (required), `language` (optional). Returns a user message asking for a comprehensive diff review.
- `architectural-analysis` — args: `filePath` (required), `query` (optional). Returns a user message asking for architectural analysis of a file.

**3 resource handlers added:**
- `smartread://config` — returns current config as JSON (embedding, search, gitContext, experimental)
- `smartread://repo-map` — placeholder text directing users to run `repo_map` tool
- `smartread://status` — returns JSON with version, tool count, experimental tools, and capabilities

**Exported helper for tool result large-content handling:**
- `maybeResourceLink` — exported from `mcp-resources.ts` for use in tool result handlers (e.g., `repo_map`, `deep_search`)

**All existing tool handlers preserved** — no changes to existing tool `ListToolsRequestSchema` or `CallToolRequestSchema` handlers.

### `mcp-prompts.ts` (new)

Typed `MCP_PROMPTS` array (`Prompt[]` from `@modelcontextprotocol/sdk/types.js`) with all 3 prompt definitions:
- `explain-code`
- `review-diff`
- `architectural-analysis`

Exported for clean reference from the server handlers.

### `mcp-resources.ts` (new)

- `MCP_RESOURCES` — `Resource[]` with 3 resource definitions
- `resolveResource(uri)` — resolves `smartread://config`, `smartread://repo-map`, `smartread://status` to their content
- `maybeResourceLink(name, content)` — returns either inline text or a `resource_link` for content exceeding 8 KB threshold
- `LARGE_RESULT_THRESHOLD` (8 KB) — exported for test verification

### `test/unit/mcp-advanced.test.ts` (new)

14 integration-style tests spawning the MCP stdio server subprocess:

**Prompts (5 tests):**
- `prompts/list` returns 3 prompts with correct names
- `prompts/get` for `explain-code` with args returns correct message structure
- `prompts/get` for `review-diff` returns user message with diff content
- `prompts/get` for `architectural-analysis` returns user message with file path and query
- `prompts/get` for unknown prompt throws JSON-RPC error

**Resources (5 tests):**
- `resources/list` returns all 3 resources with correct URIs
- `resources/read` for `smartread://config` returns valid JSON with version, embedding, search, gitContext, experimental keys
- `resources/read` for `smartread://status` returns JSON with version, toolCount, capabilities
- `resources/read` for `smartread://repo-map` returns placeholder text
- `resources/read` for unknown URI throws JSON-RPC error

**Server capabilities (1 test):**
- `initialize` response includes `prompts: {}` and `resources: {}` in capabilities

**maybeResourceLink helper (3 tests):**
- Small content (under 8 KB) returns inline `{ type: "text", text }`
- Large content (over 8 KB) returns `{ type: "resource_link", uri: "smartread://result/{name}", name }`
- Boundary behavior: exactly 8 KB → inline; 8 KB + 1 byte → resource_link

**Test execution note:** Tests require `--timeout 60000` due to subprocess spawn overhead (~9s per integration test). Default bun timeout (5s) is insufficient for the stdio protocol round-trip.

## Validation

```
bun test test/unit/mcp-advanced.test.ts --timeout 60000

  14 pass
  0 fail
  82 expect() calls
  Ran 14 tests across 1 file. [101.87s]
```

All existing `mcp-server.test.ts` tests still pass — no regression in existing tool handling.

## Files Created/Modified

| File | Action | Lines |
|------|--------|-------|
| `mcp-server.ts` | Modified | +75 lines (imports, capabilities, 2 prompt handlers, 2 resource handlers) |
| `mcp-prompts.ts` | Created | 70 lines |
| `mcp-resources.ts` | Created | 142 lines |
| `test/unit/mcp-advanced.test.ts` | Created | 439 lines |

## Open Questions

1. **Timeout requirement:** Tests need `--timeout 60000` vs default 5s. This is due to subprocess spawn + stdio protocol overhead. Could consider a vitest config file to set a project-level timeout, but the task specified not to modify existing files beyond the listed ones.
2. **`maybeResourceLink` is exported but not yet wired into any tool handler** — infrastructure is in place; actual tool wiring in `repomap-tool.ts`, `search-tool.ts`, etc. is a follow-up.
3. **`smartread://repo-map` returns a placeholder** — actual repo map content would require building the repo map on-demand or caching it; the infrastructure is ready for this extension.

## Recommended Next Step

Wire `maybeResourceLink` into `repomap-tool.ts` or `search-tool.ts` result handlers for large results (e.g., when `content.text.length > 8192`), then add a corresponding resource handler for `smartread://result/{name}`.