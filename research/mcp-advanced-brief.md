# Research: MCP SDK v1.29.0 Advanced Features Integration Brief

> **Status (2026-05-21):** All features described below are now implemented in `mcp-server.ts`. The server exposes tools, prompts (`mcp-prompts.ts`), and resources (`mcp-resources.ts`) via the low-level `Server` class with `{ tools: {}, prompts: {}, resources: {} }` capabilities. This research brief served as the implementation reference.
>
> See `mcp-server.ts`, `mcp-prompts.ts`, and `mcp-resources.ts` for the current implementation.

## Summary

The `@modelcontextprotocol/sdk` v1.29.0 supports prompts, resources, resource_link, and completions alongside tools. The project's current low-level `Server` setup (with `ListToolsRequestSchema` / `CallToolRequestSchema` handlers) can be extended to add these capabilities via the same `setRequestHandler` pattern, or upgraded to the high-level `McpServer` class which auto-wires all handlers. Each capability requires declaring it in the `capabilities` constructor object. Prompt arguments can use `completable()` for IDE-style autocompletion without additional handler code.

---

## 1. Prompts — Registration and Handler Schemas

### When to use prompts vs tools

| Aspect | Tools | Prompts |
|--------|-------|---------|
| **Who invokes** | LLM decides (model-controlled) | User invokes explicitly (user-controlled) |
| **Purpose** | Computation, side effects, network calls | Reusable message templates / canned interactions |
| **Output** | `CallToolResult` (content array + optional isError) | `GetPromptResult` (messages array with roles) |
| **Schema** | `inputSchema` (Zod) | `argsSchema` (Zod) |
| **Use case** | "Search code", "Mutate graph" | "Review this code", "Explain this diff" |

### Using low-level `Server` (like current code)

This is the approach your existing server already uses for tools. Extend it with two more handlers:

```typescript
import {
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// ── Declare capability ─────────────────────────────────────────
const server = new Server(
  { name: "pi-smartread", version: "0.1.0" },
  {
    capabilities: {
      tools: {},
      prompts: {},           // <-- add this
    },
  },
);

// ── List prompts handler ──────────────────────────────────────
server.setRequestHandler(ListPromptsRequestSchema, async () => {
  return {
    prompts: [
      {
        name: "explain-code",
        description: "Explain how a piece of code works",
        arguments: [
          {
            name: "code",
            description: "The code to explain",
            required: true,
          },
          {
            name: "language",
            description: "Programming language",
            required: false,
          },
        ],
      },
      {
        name: "review-diff",
        description: "Review a git diff for potential issues",
        arguments: [
          {
            name: "diff",
            description: "The diff content",
            required: true,
          },
        ],
      },
    ],
  };
});

// ── Get prompt handler ────────────────────────────────────────
server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "explain-code") {
    return {
      description: "Explain how code works",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Please explain how this ${args?.language ?? "code"} works:\n\n${args?.code}`,
          },
        },
      ],
    };
  }

  throw new Error(`Prompt not found: ${name}`);
});
```

### Using high-level `McpServer` (cleaner API)

The `McpServer` class (from `@modelcontextprotocol/sdk/server/mcp.js`) auto-registers all handlers. It's the recommended approach for new code:

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod";

const server = new McpServer(
  { name: "pi-smartread", version: "0.1.0" },
  { capabilities: { prompts: {} } },
);

server.registerPrompt(
  "explain-code",
  {
    title: "Code Explainer",
    description: "Explain how a piece of code works",
    argsSchema: z.object({
      code: z.string().describe("The code to explain"),
      language: z.string().optional().describe("Programming language"),
    }),
  },
  ({ code, language }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `Explain how this ${language ?? "code"} works:\n\n${code}`,
        },
      },
    ],
  }),
);
```

**Key types** (`@modelcontextprotocol/sdk/types.js`):
- `ListPromptsRequestSchema` — Zod schema for `prompts/list`
- `GetPromptRequestSchema` — Zod schema for `prompts/get`
- `Prompt` — `{ name, description?, arguments?: [{ name, description?, required? }] }`
- `GetPromptResult` — `{ description?, messages: PromptMessage[] }`
- `PromptMessage` — `{ role: "user" | "assistant", content: TextContent | ResourceContent }`

Source: [MCP Docs - Prompts](https://modelcontextprotocol.info/docs/concepts/prompts/), [TS SDK Server Guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/server.md)

---

## 2. Resources — Registration and Handler Schemas

Resources expose read-only data (files, configs, DB schemas). Unlike tools, the *host application* controls which resources to fetch, not the LLM.

### Static resource

```typescript
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// ── Declare capability ─────────────────────────────────────────
const server = new Server(
  { name: "pi-smartread", version: "0.1.0" },
  {
    capabilities: {
      tools: {},
      resources: {},       // <-- add this
    },
  },
);

// ── List resources handler ────────────────────────────────────
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return {
    resources: [
      {
        uri: "smartread://config",
        name: "SmartRead Config",
        mimeType: "application/json",
        description: "Current SmartRead configuration",
      },
      {
        uri: "smartread://recent-files",
        name: "Recent Files",
        mimeType: "text/plain",
        description: "Recently accessed files in the workspace",
      },
    ],
  };
});

// ── Read resource handler ─────────────────────────────────────
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const uri = request.params.uri;

  if (uri === "smartread://config") {
    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify({ maxFiles: 20, chunkSize: 500 }),
        },
      ],
    };
  }

  throw new Error(`Resource not found: ${uri}`);
});
```

### Dynamic resources with URI templates (McpServer)

```typescript
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";

server.registerResource(
  "user-profile",
  new ResourceTemplate("smartread://users/{userId}/profile", {
    list: async () => ({
      resources: [
        { uri: "smartread://users/123/profile", name: "Alice" },
        { uri: "smartread://users/456/profile", name: "Bob" },
      ],
    }),
  }),
  {
    title: "User Profile",
    description: "User profile data",
    mimeType: "application/json",
  },
  async (uri, { userId }) => ({
    contents: [
      {
        uri: uri.href,
        text: JSON.stringify({ userId, name: "Example User" }),
      },
    ],
  }),
);
```

**Key types**:
- `ListResourcesRequestSchema` — for `resources/list`
- `ReadResourceRequestSchema` — for `resources/read`
- `Resource` — `{ uri, name, description?, mimeType?, size? }`
- `ReadResourceResult` — `{ contents: ResourceContent[] }`
- `ResourceContent` — `{ uri, mimeType?, text? | blob? }`

Source: [TS SDK Server Guide - Resources](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/server.md#resources)

---

## 3. ResourceLink — Returning URI References from Tools

A `resource_link` content item lets a tool return a *reference* to a resource without embedding the full payload. The client can fetch the actual content via `resources/read` on demand.

### Type definition

```typescript
import type { ResourceLink } from "@modelcontextprotocol/sdk/types.js";

// ResourceLink shape:
// {
//   type: "resource_link";
//   uri: string;
//   name?: string;
//   description?: string;
//   mimeType?: string;
// }
```

### Usage in a tool result

```typescript
import type { CallToolResult, ResourceLink } from "@modelcontextprotocol/sdk/types.js";

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name } = request.params;

  if (name === "list-project-files") {
    const links: ResourceLink[] = [
      {
        type: "resource_link",
        uri: "file:///project/README.md",
        name: "README",
        mimeType: "text/markdown",
      },
      {
        type: "resource_link",
        uri: "file:///project/src/index.ts",
        name: "index.ts",
        mimeType: "text/typescript",
      },
    ];

    return {
      content: [
        { type: "text", text: "Found 2 files:" },
        ...links,
      ],
    } as CallToolResult;
  }

  // ...
});
```

**Best practice**: Use `resource_link` when the result set would be large (many files, large content) and let the client selectively read. Use inline `text` content for small, immediately relevant results.

Source: [TS SDK Server Guide - ResourceLink outputs](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/server.md#resourcelink-outputs), [PR #632](https://github.com/modelcontextprotocol/typescript-sdk/pull/632)

---

## 4. completable() — IDE-Style Autocompletion

Wrap a prompt argument (or resource template variable) with `completable()` to enable `completion/complete` requests. Clients call this as the user types to offer suggestions.

### Import and usage

```typescript
import { completable } from "@modelcontextprotocol/sdk/server/completable.js";
import * as z from "zod";

server.registerPrompt(
  "review-code",
  {
    title: "Code Review",
    description: "Review code for best practices",
    argsSchema: z.object({
      language: completable(
        z.string().describe("Programming language"),
        (value) =>
          ["typescript", "javascript", "python", "rust", "go"].filter((lang) =>
            lang.startsWith(value),
          ),
      ),
    }),
  },
  ({ language }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `Review this ${language} code for best practices.`,
        },
      },
    ],
  }),
);
```

### Context-aware completions

The completer callback receives a second `context` parameter with previously set arguments:

```typescript
language: completable(
  z.string(),
  (value, context) => {
    const repo = context?.arguments?.repo;
    if (repo === "frontend") {
      return ["typescript", "javascript"].filter(l => l.startsWith(value));
    }
    return ["python", "go", "rust"].filter(l => l.startsWith(value));
  },
)
```

### Enabling the capability

When using high-level `McpServer`, completions are auto-enabled when any `completable()` is detected. For low-level `Server`, you must declare the capability and set the handler:

```typescript
const server = new Server(
  { name: "pi-smartread", version: "0.1.0" },
  {
    capabilities: {
      tools: {},
      prompts: {},
      completions: {},   // required for low-level Server
    },
  },
);
```

Source: [TS SDK Server Guide - Completions](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/server.md#completions)

---

## 5. How the Existing Server Setup Must Change

### Current state (mcp-server.ts)

```typescript
// Current setup — tools only
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "pi-smartread", version: "0.1.0" },
  { capabilities: { tools: {} } },   // only tools
);

// Only two handlers
server.setRequestHandler(ListToolsRequestSchema, async () => { ... });
server.setRequestHandler(CallToolRequestSchema, async (request) => { ... });
```

### Required changes

**Change 1 — Capabilities object:**
```typescript
// Before
{ capabilities: { tools: {} } }

// After — add prompts + resources
{ capabilities: { tools: {}, prompts: {}, resources: {} } }
// Optional: add completions if using low-level Server with completable()
// { capabilities: { tools: {}, prompts: {}, resources: {}, completions: {} } }
```

**Change 2 — Add handler imports:**
```typescript
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListPromptsRequestSchema,     // new
  GetPromptRequestSchema,       // new
  ListResourcesRequestSchema,   // new
  ReadResourceRequestSchema,    // new
  // type-only imports:
  type CallToolResult,
  type ResourceLink,
  type Prompt,
  type PromptMessage,
  type Resource,
} from "@modelcontextprotocol/sdk/types.js";
```

**Change 3 — Add handler registrations** (after existing tool handlers):
```typescript
// Prompts
server.setRequestHandler(ListPromptsRequestSchema, async () => { /* return prompt list */ });
server.setRequestHandler(GetPromptRequestSchema, async (request) => { /* return prompt messages */ });

// Resources
server.setRequestHandler(ListResourcesRequestSchema, async () => { /* return resource list */ });
server.setRequestHandler(ReadResourceRequestSchema, async (request) => { /* return resource content */ });
```

**Change 4 (optional) — Upgrade to McpServer** for auto-wired handlers, resource templates, and completions:
```typescript
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { completable } from "@modelcontextprotocol/sdk/server/completable.js";
```

---

## 6. Complete Integration Example

This shows a low-level `Server` extended with all capabilities (drop-in compatible with existing `mcp-server.ts`):

```typescript
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// ── Capabilities: tools + prompts + resources ─────────────────
const server = new Server(
  { name: "pi-smartread", version: "0.1.0" },
  { capabilities: { tools: {}, prompts: {}, resources: {} } },
);

// ── Tools (existing) ──────────────────────────────────────────
server.setRequestHandler(ListToolsRequestSchema, async () => {
  /* existing tool list */
});
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  /* existing tool call */
});

// ── Prompts ────────────────────────────────────────────────────
const PROMPTS = {
  "explain-code": {
    name: "explain-code",
    description: "Explain how a piece of code works",
    arguments: [
      { name: "code", description: "The code to explain", required: true },
      { name: "language", description: "Programming language", required: false },
    ],
  },
};

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: Object.values(PROMPTS),
}));

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  if (name === "explain-code") {
    return {
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `Explain how this ${args?.language ?? "code"} works:\n\n${args?.code}`,
        },
      }],
    };
  }
  throw new Error(`Unknown prompt: ${name}`);
});

// ── Resources ──────────────────────────────────────────────────
server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    { uri: "smartread://config", name: "Config", mimeType: "application/json" },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  if (request.params.uri === "smartread://config") {
    return {
      contents: [{
        uri: request.params.uri,
        mimeType: "application/json",
        text: JSON.stringify({ version: "0.1.0" }),
      }],
    };
  }
  throw new Error(`Resource not found: ${request.params.uri}`);
});

// ── Transport & Start (unchanged) ─────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
```

---

## Sources

### Kept
- **MCP TypeScript SDK GitHub (v1.29.0)** — Primary source for SDK APIs, release notes, and changelogs. [GitHub](https://github.com/modelcontextprotocol/typescript-sdk)
- **TS SDK Server Guide (docs/server.md)** — Authoritative guide for tools, resources, prompts, completions, resource_link. [GitHub](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/server.md)
- **MCP Docs — Prompts concept** — Protocol-level explanation of prompts vs tools and prompt structure. [modelcontextprotocol.info](https://modelcontextprotocol.info/docs/concepts/prompts/)
- **MCP Spec — Resource Links (draft)** — Spec-level definition of `resource_link` content type. [spec](https://modelcontextprotocol.io/specification/draft/server/tools)
- **PR #632 — Add resource link support** — Original PR that added ResourceLink to the TypeScript SDK. [GitHub](https://github.com/modelcontextprotocol/typescript-sdk/pull/632)
- **McpServer source (mcp.ts)** — Reference implementation showing how McpServer registers handlers for tools, prompts, resources, and completions. [GitHub](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/packages/server/src/server/mcp.ts)

### Dropped
- **GCP MCP server implementations** — Not relevant to core SDK integration.
- **Stack Overflow threads** — Unofficial; SDK docs are the authoritative source.
- **Community guides** — Redundant with official documentation; skipped in favor of primary sources.
- **V2 SDK docs** — The `main` branch now contains v2 (pre-alpha); v1.x is the stable recommendation. V1 docs at `ts.sdk.modelcontextprotocol.io` are authoritative.

---

## Gaps

1. **Error handling for prompts**: The spec suggests throwing `Error` for unknown prompts, but best practice for `isError`-style error reporting in prompt results is not well-documented. Current SDK behavior wraps thrown errors as protocol-level errors (hidden from the model).

2. **Resource subscription**: The resource protocol supports `subscribe`/`unsubscribe` for change notifications, but the implementation pattern for tracking subscriptions and sending `notifications/resources/updated` is not detailed in the v1 docs. The McpServer class does not expose subscription management directly.

3. **Prompt with `resource` content type**: Prompts can embed inline resources (`type: "resource"` in content) but the exact serialization format for `PromptMessage.content` when using resource references needs testing against client implementations.

4. **completable() on low-level Server**: The `completable()` function is designed for `McpServer.registerPrompt`. To use completions with the low-level `Server` class, you must manually register a `completion/complete` handler and implement argument completion logic from scratch based on your prompt schemas.

**Suggested next step**: Prototype prompts + resources on a branch using the low-level `Server` approach (minimum diff from current code), then evaluate whether upgrading to `McpServer` is worth the refactor for resource template and completions support.
