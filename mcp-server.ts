#!/usr/bin/env node
/**
 * MCP (Model Context Protocol) stdio server for Pi-SmartRead.
 *
 * Exposes SmartRead tools via the official @modelcontextprotocol/sdk
 * over stdio transport.
 *
 * Tools exposed:
 *   - graph_mutate:  Record a single breakage or co-change edge
 *   - intent_read:  Hybrid RRF retrieval (BM25 + embeddings)
 *   - read_files:  Multi-file reader with packing
 *   - repo_map:  Repository symbol map (PageRank + tree-sitter)
 *   - search:  Consolidated search (grep, code, deep)
 *
 * Usage:
 *   node --import tsx mcp-server.ts    # Run as MCP stdio server
 */
import { cwd } from "node:process";
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
import { buildToolRegistry } from "./mcp-registry.js";
import { MCP_PROMPTS } from "./mcp-prompts.js";
import { MCP_RESOURCES, resolveResource } from "./mcp-resources.js";
import { coerceText } from "./utils.js";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { toExtensionContext } from "./types.js";

// ── Build Registry ─────────────────────────────────────────────────

const tools: ToolDefinition[] = buildToolRegistry();

// ── MCP Server Setup ───────────────────────────────────────────────

const server = new Server(
  { name: "pi-smartread", version: "0.1.0" },
  { capabilities: { tools: {}, prompts: {}, resources: {} } },
);

// ── Handlers ───────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.parameters as Record<string, unknown>,
    })),
  };
});

let toolCallCounter = 0;

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    return {
      content: [{ type: "text" as const, text: `Error: Unknown tool: ${name}` }],
      isError: true,
    };
  }

  try {
    const toolCallId = `mcp-${++toolCallCounter}`;
    const ctx = toExtensionContext(cwd());

    const result = await tool.execute(toolCallId, args ?? {}, undefined, undefined, ctx);

    // Convert tool result to MCP content format
    const content: Array<{ type: "text"; text: string }> = (result.content ?? []).map((item: any) => {
      if (item.type === "text") {
        return { type: "text" as const, text: coerceText(item.text) };
      }
      return { type: "text" as const, text: JSON.stringify(item) };
    });

    return {
      content:
        content.length > 0
          ? content
          : [{ type: "text" as const, text: "Tool executed successfully (no output)" }],
      isError: false,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text" as const, text: `Error: ${message}` }],
      isError: true,
    };
  }
});

// ── Prompts ──────────────────────────────────────────────────────────────────

server.setRequestHandler(ListPromptsRequestSchema, async () => {
  return { prompts: MCP_PROMPTS };
});

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;


  if (name === "explain-code") {
    const lang = args?.language ?? "code";
    return {
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Please explain how this ${lang} works:\n\n${args?.code ?? ""}`,
          },
        },
      ],
    };
  }

  if (name === "review-diff") {
    const lang = args?.language ?? "the code";
    return {
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Please review this ${lang} diff for potential issues, bugs, security concerns, and style improvements:\n\n${args?.diff ?? ""}`,
          },
        },
      ],
    };
  }

  if (name === "architectural-analysis") {
    const filePath = args?.filePath ?? "";
    const query = args?.query ? `Focus on: ${args.query}` : "Provide a general architectural overview.";
    return {
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Please perform an architectural analysis of the file \`${filePath}\`.\n\n${query}`,
          },
        },
      ],
    };
  }

  throw new Error(`Prompt not found: ${name}`);
});

// ── Resources ─────────────────────────────────────────────────────────────────
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return { resources: MCP_RESOURCES };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const resolved = resolveResource(request.params.uri);
  return {
    contents: [
      {
        uri: resolved.uri,
        mimeType: resolved.mimeType,
        text: resolved.text,
      },
    ],
  };
});

// ── Graceful Shutdown ──────────────────────────────────────────────

function writeStderr(message: string): void {
  process.stderr.write(message);
}

let shutdownPromise: Promise<void> | undefined;

async function shutdown(reason: string, exitCode: number): Promise<void> {
  if (shutdownPromise) {
    return shutdownPromise;
  }

  shutdownPromise = (async () => {
    process.exitCode = exitCode;
    writeStderr(`[pi-smartread] Received ${reason}, shutting down...\n`);

    try {
      await server.close();
    } catch (closeErr) {
      const message = closeErr instanceof Error ? closeErr.stack || closeErr.message : String(closeErr);
      writeStderr(`[pi-smartread] Error closing server: ${message}\n`);
    }

    // Give stderr a short chance to flush; stdout remains protocol-only.
    await new Promise((resolve) => setTimeout(resolve, 50));
    process.exit(exitCode);
  })();

  return shutdownPromise;
}

process.on("SIGINT", () => {
  shutdown("SIGINT", 0).catch(() => process.exit(1));
});

process.on("SIGTERM", () => {
  shutdown("SIGTERM", 0).catch(() => process.exit(1));
});

process.on("uncaughtException", (error) => {
  writeStderr(`[pi-smartread] Uncaught exception: ${error.stack || error.message}\n`);
  shutdown("uncaughtException", 1).catch(() => process.exit(1));
});

process.on("unhandledRejection", (reason) => {
  const message = reason instanceof Error ? reason.stack || reason.message : String(reason);
  writeStderr(`[pi-smartread] Unhandled rejection: ${message}\n`);
  shutdown("unhandledRejection", 1).catch(() => process.exit(1));
});

// ── Start ──────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
try {
  await server.connect(transport);
  writeStderr("[pi-smartread] MCP server running on stdio\n");
} catch (startErr) {
  const message = startErr instanceof Error ? startErr.stack || startErr.message : String(startErr);
  writeStderr(`[pi-smartread] Failed to start MCP server: ${message}\n`);
  process.exit(1);
}
