/**
 * Tests for the MCP stdio server.
 *
 * Integration-style tests that spawn a subprocess via
 * `spawn("npx", ["tsx", MCP_SERVER_PATH])` and exercise JSON-RPC 2.0
 * protocol handling over stdio. Each test sends requests to stdin
 * and validates responses from stdout.
 */
import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MCP_SERVER_PATH = join(__dirname, "../../mcp-server.ts");

/**
 * Helper: send a JSON-RPC message to the MCP server and get the response.
 */
function callMcpServer(
  message: Record<string, unknown>,
  timeoutMs = 10_000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("MCP server timeout"));
    }, timeoutMs);

    const child = spawn("npx", ["tsx", MCP_SERVER_PATH], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: join(__dirname, "../.."),
    });

    let stdout = "";
    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.on("close", () => {
      clearTimeout(timeout);
      const lines = stdout.trim().split("\n").filter(Boolean);
      if (lines.length === 0) {
        reject(new Error("No response from MCP server"));
        return;
      }
      try {
        resolve(JSON.parse(lines[lines.length - 1]!));
      } catch (err) {
        reject(new Error(`Invalid JSON response: ${stdout}`));
      }
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    // Send the message
    child.stdin.write(JSON.stringify(message) + "\n");
    child.stdin.end();
  });
}

describe("MCP stdio server", () => {
  it("responds to initialize request", async () => {
    const response = await callMcpServer({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    });

    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe(1);
    expect(response.result).toBeDefined();

    const result = response.result as any;
    expect(result.protocolVersion).toBe("2024-11-05");
    expect(result.capabilities).toBeDefined();
    expect(result.capabilities.tools).toBeDefined();
    expect(result.serverInfo.name).toBe("pi-smartread");
    expect(result.serverInfo.version).toBe("0.1.0");
  });

  it("responds to tools/list with registered tools", async () => {
    // First initialize
    await callMcpServer({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    });

    const response = await callMcpServer({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });

    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe(2);

    const result = response.result as any;
    expect(result.tools).toBeDefined();
    expect(Array.isArray(result.tools)).toBe(true);
    expect(result.tools.length).toBeGreaterThan(0);

    // Check that known tools are registered
    const toolNames = result.tools.map((t: any) => t.name);
    expect(toolNames).toContain("intent_read");
    expect(toolNames).toContain("read_multiple_files");
    expect(toolNames).toContain("repo_map");
    expect(toolNames).toContain("search");

    // Each tool should have required fields
    for (const tool of result.tools) {
      expect(tool.name).toBeDefined();
      expect(typeof tool.name).toBe("string");
      expect(tool.description).toBeDefined();
      expect(typeof tool.description).toBe("string");
      expect(tool.inputSchema).toBeDefined();
    }
  });

  it("responds to ping", async () => {
    const response = await callMcpServer({
      jsonrpc: "2.0",
      id: 3,
      method: "ping",
    });

    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe(3);
    expect(response.result).toEqual({});
  });

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
  });

  it("returns error for unknown tool call", async () => {
    const response = await callMcpServer({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "nonexistent_tool",
        arguments: {},
      },
    });

    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe(5);
    // The server wraps errors in result.content with isError: true
    const result = response.result as any;
    expect(result).toBeDefined();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Unknown tool");
  });

  it("returns tool list entries have valid JSON Schema for inputSchema", async () => {
    const response = await callMcpServer({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/list",
      params: {},
    });

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
  });
});
