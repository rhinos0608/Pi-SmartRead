/**
 * Tests for the MCP stdio server.
 *
 * Integration-style tests that spawn a subprocess via `node --import tsx`
 * and exercise JSON-RPC 2.0 protocol handling over stdio. Each test sends
 * requests to stdin and validates responses from stdout.
 */
import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MCP_SERVER_PATH = join(__dirname, "../../mcp-server.ts");

function mcpInitialize(): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test-client", version: "1.0.0" },
    },
  };
}

function mcpInitialized(): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    method: "notifications/initialized",
    params: {},
  };
}

/**
 * Send one or more JSON-RPC messages to the MCP server and return the last response.
 *
 * Parses stdout line-by-line; collects all responses and returns the last one
 * when the process closes. This avoids a race where the `close` event fires
 * before the promise is settled — Node.js delivers the callback even to an
 * already-resolved promise.
 *
 * Waits for the server's stderr startup signal before sending any messages,
 * to avoid races during tsx/esbuild cold boot.
 */
function callMcpServer(
  messageOrMessages: Record<string, unknown> | Array<Record<string, unknown>>,
  timeoutMs = 30_000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    // Per-test timeout kills the subprocess and rejects
    const timeout = setTimeout(() => {
      clearInterval(pollStartup);
      child.kill();
      reject(new Error("MCP server timeout"));
    }, timeoutMs);

    const child = spawn("node", ["--import", "tsx", MCP_SERVER_PATH], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: join(__dirname, "../.."),
    });

    let stderr = "";

    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    // Collect all JSON-RPC responses; return the last one when close fires.
    // This handles the race where `close` can fire before the promise is resolved
    // (the Node.js event loop delivers the callback even to a settled promise).
    const responses: Array<Record<string, unknown>> = [];

    child.stdout.on("data", (data: Buffer) => {
      for (const raw of data.toString().split("\n")) {
        const line = raw.trim();
        if (!line) continue;
        try {
          responses.push(JSON.parse(line) as Record<string, unknown>);
        } catch {
          // Skip non-JSON lines (e.g. debug output)
        }
      }
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      clearInterval(pollStartup);
      reject(err);
    });

    // `close` fires after stdin closes AND the process exits.
    // Collect responses as they arrive; return the last one on close.
    // This avoids the race where close fires before the promise is settled —
    // Node.js delivers the callback even to already-resolved/rejected promises.
    child.on("close", () => {
      clearTimeout(timeout);
      clearInterval(pollStartup);
      if (responses.length === 0) {
        reject(new Error("No JSON-RPC response from MCP server"));
        return;
      }
      resolve(responses[responses.length - 1]!);
    });

    const messages = Array.isArray(messageOrMessages) ? messageOrMessages : [messageOrMessages];

    // Wait for server startup signal before sending.
    // tsx cold-boots esbuild; the server signals readiness via stderr.
    const pollStartup = setInterval(() => {
      if (stderr.includes("[pi-smartread] MCP server running on")) {
        clearInterval(pollStartup);
        for (const message of messages) {
          child.stdin.write(JSON.stringify(message) + "\n");
        }
        child.stdin.end();
      }
    }, 100);
  });
}

describe("MCP stdio server", () => {
  it("responds to initialize request", async () => {
    const response = await callMcpServer(mcpInitialize());

    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe(1);
    expect(response.result).toBeDefined();

    const result = response.result as any;
    expect(result.protocolVersion).toBe("2024-11-05");
    expect(result.capabilities).toBeDefined();
    expect(result.serverInfo.name).toBe("pi-smartread");
    expect(result.serverInfo.version).toBe("0.1.0");
  }, 60_000);

  it("responds to tools/list with registered tools", async () => {
    const response = await callMcpServer([
      mcpInitialize(),
      mcpInitialized(),
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      },
    ]);

    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe(2);

    const result = response.result as any;
    expect(result.tools).toBeDefined();
    expect(Array.isArray(result.tools)).toBe(true);
    expect(result.tools.length).toBeGreaterThan(0);

    // Check that known tools are registered
    const toolNames = result.tools.map((t: any) => t.name);
    expect(toolNames).toContain("read");
    expect(toolNames).toContain("read_files");
    expect(toolNames).toContain("search");
    expect(toolNames).toContain("repo_map");
    expect(toolNames).toContain("symbol");
    expect(toolNames).toContain("skill");
    expect(toolNames).not.toContain("intent_read");
    expect(toolNames).not.toContain("find_symbol");
    expect(toolNames).not.toContain("symbol_info");
    expect(toolNames).not.toContain("deep_search");
    expect(toolNames.every((name: string) => !name.startsWith("smartread_"))).toBe(true);
    // context_graph is not exposed as an agent-facing tool
    expect(toolNames).not.toContain("context_graph");
    // graph_mutate and git_notes are experimental — disabled by default
    expect(toolNames).not.toContain("graph_mutate");
    expect(toolNames).not.toContain("git_notes_read");
    expect(toolNames).not.toContain("git_notes_write");

    // Each tool should have required fields
    for (const tool of result.tools) {
      expect(tool.name).toBeDefined();
      expect(typeof tool.name).toBe("string");
      expect(tool.description).toBeDefined();
      expect(typeof tool.description).toBe("string");
      expect(tool.inputSchema).toBeDefined();
    }

    const guidedTools = ["read", "read_files", "search", "repo_map", "symbol", "skill"];
    for (const name of guidedTools) {
      const tool = result.tools.find((candidate: any) => candidate.name === name);
      expect(tool?.description).toMatch(/e\.g\.|Example:/);
      expect(tool?.description).toContain("Prefer");
    }
  }, 60_000);

  it("responds to ping", async () => {
    const response = await callMcpServer([
      mcpInitialize(),
      mcpInitialized(),
      {
        jsonrpc: "2.0",
        id: 3,
        method: "ping",
      },
    ]);

    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe(3);
    expect(response.result).toEqual({});
  }, 60_000);

  it("returns error for unknown method", async () => {
    const response = await callMcpServer({
      jsonrpc: "2.0",
      id: 4,
      method: "unknown/method",
    });

    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe(4);
    expect(response.error).toBeDefined();
    expect((response.error as any).code).toBe(-32601); // METHOD_NOT_FOUND
  }, 60_000);

  it("returns error for unknown tool call", async () => {
    const response = await callMcpServer([
      mcpInitialize(),
      mcpInitialized(),
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "nonexistent_tool",
          arguments: {},
        },
      },
    ]);

    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe(5);
    // The server wraps errors in result.content with isError: true
    const result = response.result as any;
    expect(result).toBeDefined();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Unknown tool");
  }, 60_000);

  it("returns tool list entries have valid JSON Schema for inputSchema", async () => {
    const response = await callMcpServer([
      mcpInitialize(),
      mcpInitialized(),
      {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/list",
        params: {},
      },
    ]);

    const tools = (response.result as any).tools;
    for (const tool of tools) {
      const schema = tool.inputSchema;
      expect(schema).toBeDefined();
      // Type.Union produces oneOf with discriminants
      const hasValidSchema =
        schema.type === "object" ||
        Array.isArray(schema.oneOf) ||
        Array.isArray(schema.anyOf);
      expect(hasValidSchema).toBe(true);
      // Should have properties, required, oneOf, or anyOf at minimum
      const hasContent =
        schema.properties !== undefined ||
        schema.required !== undefined ||
        Array.isArray(schema.oneOf) ||
        Array.isArray(schema.anyOf);
      expect(hasContent).toBe(true);
    }
  }, 60_000);
});