#!/usr/bin/env node
/**
 * MCP (Model Context Protocol) stdio server for Pi-SmartRead.
 *
 * Exposes SmartRead tools via the MCP stdio transport protocol.
 * This is a lightweight implementation that speaks JSON-RPC 2.0 over
 * stdin/stdout without requiring the full @modelcontextprotocol/sdk.
 *
 * Tools exposed:
 *   - intent_read:  Hybrid RRF retrieval (BM25 + embeddings)
 *   - read_multiple_files:  Multi-file reader with packing
 *   - repo_map:  Repository symbol map (PageRank + tree-sitter)
 *   - search:  Consolidated search (symbols, callers, resolve, code)
 *
 * Usage:
 *   node mcp-server.js           # Run as MCP stdio server
 *   echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | node mcp-server.js
 */
import { createInterface } from "node:readline";
import { cwd } from "node:process";
import { createIntentReadTool } from "./intent-read.js";
import { createReadManyTool } from "./read-many.js";
import registerRepoTools from "./repomap-tool.js";
import type { ExtensionAPI, ToolDefinition, ToolCallContext } from "@mariozechner/pi-coding-agent";

// ── MCP Protocol Types ────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

// ── MCP Error Codes ───────────────────────────────────────────────

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

// ── Tool Registry ─────────────────────────────────────────────────

interface RegisteredTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: ToolDefinition["execute"];
}

function buildToolRegistry(): RegisteredTool[] {
  const tools: RegisteredTool[] = [];

  // Minimal extension API stub for tool creation
  const extensionCwd = cwd();
  const stubCtx = { cwd: extensionCwd } as any;

  // Intent read tool
  const intentReadDef = createIntentReadTool() as unknown as ToolDefinition;
  tools.push({
    name: intentReadDef.name,
    description: intentReadDef.description,
    inputSchema: intentReadDef.parameters as Record<string, unknown>,
    execute: intentReadDef.execute,
  });

  // Read many tool
  const readManyDef = createReadManyTool() as unknown as ToolDefinition;
  tools.push({
    name: readManyDef.name,
    description: readManyDef.description,
    inputSchema: readManyDef.parameters as Record<string, unknown>,
    execute: readManyDef.execute,
  });

  // Repo tools (repo_map, search_symbols, find_callers)
  const registeredRepoTools: Array<{ name: string; description: string; inputSchema: unknown; execute: Function }> = [];
  const mockPi: ExtensionAPI = {
    registerTool(def: ToolDefinition) {
      registeredRepoTools.push({
        name: def.name,
        description: def.description,
        inputSchema: def.parameters as unknown,
        execute: def.execute,
      });
    },
    registerHook: (() => {}) as any,
    getContext: (() => ({ cwd: extensionCwd })) as any,
  } as unknown as ExtensionAPI;

  registerRepoTools(mockPi);

  for (const tool of registeredRepoTools) {
    tools.push({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as Record<string, unknown>,
      execute: tool.execute as ToolDefinition["execute"],
    });
  }

  return tools;
}

// ── MCP Server ────────────────────────────────────────────────────

class McpStdioServer {
  private tools: RegisteredTool[];
  private initialized = false;
  private toolCallCounter = 0;

  constructor() {
    this.tools = buildToolRegistry();
  }

  async handleRequest(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    const { id, method, params } = request;

    try {
      switch (method) {
        case "initialize":
          return this.handleInitialize(id, params);
        case "tools/list":
          return this.handleToolsList(id);
        case "tools/call":
          return await this.handleToolsCall(id, params);
        case "ping":
          return { jsonrpc: "2.0", id, result: {} };
        default:
          return {
            jsonrpc: "2.0",
            id,
            error: { code: METHOD_NOT_FOUND, message: `Method not found: ${method}` },
          };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        jsonrpc: "2.0",
        id,
        error: { code: INTERNAL_ERROR, message },
      };
    }
  }

  private handleInitialize(id: number | string, params?: Record<string, unknown>): JsonRpcResponse {
    this.initialized = true;
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: "pi-smartread",
          version: "0.1.0",
        },
      },
    };
  }

  private handleToolsList(id: number | string): JsonRpcResponse {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        tools: this.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      },
    };
  }

  private async handleToolsCall(
    id: number | string,
    params?: Record<string, unknown>,
  ): Promise<JsonRpcResponse> {
    if (!params) {
      return { jsonrpc: "2.0", id, error: { code: INVALID_PARAMS, message: "Missing params" } };
    }

    if (typeof params.name !== "string") {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: INVALID_PARAMS, message: "Missing or invalid tool name" },
      };
    }

    const toolName = params.name as string;
    const args = (params.arguments ?? {}) as Record<string, unknown>;

    const tool = this.tools.find((t) => t.name === toolName);
    if (!tool) {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: `Error: Unknown tool: ${toolName}` }],
          isError: true,
        },
      };
    }

    try {
      const toolCallId = `mcp-${++this.toolCallCounter}`;
      const extensionCwd = cwd();
      const ctx = { cwd: extensionCwd } as any;

      const result = await tool.execute(toolCallId, args, undefined, undefined, ctx);

      // Convert tool result to MCP content format
      const content = (result.content ?? []).map((item: any) => {
        if (item.type === "text") {
          return { type: "text", text: item.text };
        }
        return { type: "text", text: JSON.stringify(item) };
      });

      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: content.length > 0 ? content : [{ type: "text", text: "Tool executed successfully (no output)" }],
          isError: false,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: `Error: ${message}` }],
          isError: true,
        },
      };
    }
  }

  start(): void {
    const rl = createInterface({ input: process.stdin });

    rl.on("line", async (line) => {
      if (!line.trim()) return;

      let request: JsonRpcRequest;
      try {
        request = JSON.parse(line) as JsonRpcRequest;
      } catch {
        const errorResponse: JsonRpcResponse = {
          jsonrpc: "2.0",
          id: null,
          error: { code: PARSE_ERROR, message: "Invalid JSON" },
        };
        process.stdout.write(JSON.stringify(errorResponse) + "\n");
        return;
      }

      // Notifications (no id) don't need a response
      if (request.id === undefined || request.id === null) {
        if (request.method === "notifications/initialized") {
          this.initialized = true;
        }
        return;
      }

      const response = await this.handleRequest(request);
      process.stdout.write(JSON.stringify(response) + "\n");
    });

    rl.on("close", () => {
      process.exit(0);
    });
  }
}

// ── Main ──────────────────────────────────────────────────────────

const server = new McpStdioServer();
server.start();
