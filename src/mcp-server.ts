#!/usr/bin/env node
/**
 * MCP (Model Context Protocol) stdio server for Pi-SmartRead.
 *
 * Exposes SmartRead tools via the official @modelcontextprotocol/sdk
 * over stdio transport.
 *
 * Tools exposed by default:
 *   - inspect: Directory (repo map) and file (structural facts + signals) retrieval
 *   - grep:   Primary code search with BM25+symbol+semantic cascade
 *   - skill:   Run named SmartRead skills
 * Experimental tools may be enabled through configuration.
 *
 * Usage:
 *   node --import tsx mcp-server.ts    # Run as MCP stdio server
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  RequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { Value } from "@sinclair/typebox/value";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildToolRegistry } from "./mcp-registry.js";
import { MCP_PROMPTS } from "./mcp-prompts.js";
import { MCP_RESOURCES, resolveResource } from "./mcp-resources.js";
import { coerceText } from "./utils.js";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { toExtensionContext } from "./types.js";
import { renderSmartReadToolGuide } from "./tool-guidance.js";

// Capture cwd once at server start.
const SERVER_CWD = process.cwd();

// Standalone MCP has no Pi session manager, but inspect envelopes require an
// actual session-file identity. Keep that identity private to this process and
// outside the repository; it contains no user or tool content.
const MCP_SESSION_DIR = mkdtempSync(join(tmpdir(), "pi-smartread-mcp-"));
const MCP_SESSION_FILE = join(MCP_SESSION_DIR, "session.jsonl");
writeFileSync(MCP_SESSION_FILE, "", { encoding: "utf8", mode: 0o600, flag: "wx" });
let mcpSessionCleaned = false;
function cleanupMcpSession(): void {
  if (mcpSessionCleaned) return;
  mcpSessionCleaned = true;
  try { rmSync(MCP_SESSION_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
}
process.once("exit", cleanupMcpSession);

// ── Build Registry ─────────────────────────────────────────────────

const tools: ToolDefinition[] = buildToolRegistry();

// ── MCP Server Setup ───────────────────────────────────────────────

const server = new Server(
  { name: "pi-smartread", version: "0.5.0" },
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

// Lenient call-tool schema: allows `arguments` to be omitted/undefined so the
// handler can normalize it to {} before TypeBox schema validation. `null` is
// rejected explicitly in the handler (below) — the MCP SDK silently drops
// schema-rejected requests without a JSON-RPC error response, so rejecting
// null at the schema boundary would break the error contract.
const LenientCallToolRequestSchema = RequestSchema.extend({
  method: z.literal("tools/call"),
  params: z.object({
    name: z.string(),
    arguments: z.record(z.string(), z.unknown()).optional().nullable(),
  }),
});

server.setRequestHandler(LenientCallToolRequestSchema, async (request, extra) => {
  const { name, arguments: rawArgs } = request.params;
  // Reject null arguments at the request boundary — never silently accepted.
  if (rawArgs === null) {
    throw new McpError(ErrorCode.InvalidParams, "arguments must be an object, not null");
  }
  // Normalize missing/omitted arguments to {} so TypeBox schema validation runs
  // uniformly (e.g. a missing required field is rejected as Invalid params).
  const args = rawArgs ?? {};

  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    return {
      content: [{ type: "text" as const, text: `Error: Unknown tool: ${name}` }],
      isError: true,
    };
  }

  try {
    // Validate tool args against inputSchema
    if (tool.parameters) {
      try {
        // Simple type-based validation using Value.Check
        const valid = (Value as any).Check(tool.parameters, args);
        if (!valid) {
          const errors = [...(Value as any).Errors(tool.parameters, args)];
          return {
            content: [{ type: "text" as const, text: `Invalid params: ${errors.map((e: { message: string }) => e.message).join("; ")}` }],
            isError: true,
          };
        }
      } catch {
        // Validation not supported for this schema type — skip
      }
    }

    const toolCallId = `mcp-${++toolCallCounter}`;
    const ctx = toExtensionContext(SERVER_CWD);
    (ctx.sessionManager as unknown as { getSessionFile: () => string }).getSessionFile = () => MCP_SESSION_FILE;

    const result = await tool.execute(toolCallId, args, extra.signal ?? undefined, undefined, ctx);

    if (result === undefined) {
      return {
        content: [{ type: "text" as const, text: "Tool executed successfully (no output)" }],
        isError: false,
      };
    }

    // Convert tool result to MCP content format
    const content: Array<{ type: "text"; text: string }> = (result.content ?? []).map((item: any) => {
      if (item.type === "text") {
        return { type: "text" as const, text: coerceText(item.text) };
      }
      return { type: "text" as const, text: JSON.stringify(item) };
    });

    return {
      content,
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

  // Validate required prompt arguments
  const promptDef = MCP_PROMPTS.find(p => p.name === name);
  if (promptDef?.arguments) {
    for (const arg of promptDef.arguments) {
      if (arg.required && (args === undefined || args === null || !(arg.name in args))) {
        throw Object.assign(new Error(`Missing required argument: ${arg.name}`), { code: -32602 });
      }
    }
  }

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

  if (name === "smartread-tool-guide") {
    return {
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: renderSmartReadToolGuide(typeof args?.task === "string" ? args.task : undefined),
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
  const resolved = await resolveResource(request.params.uri);
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
