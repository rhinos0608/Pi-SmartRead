/**
 * Tests for MCP advanced capabilities (prompts, resources, resource_link).
 *
 * Uses the same integration-style subprocess approach as mcp-server.test.ts.
 */
import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MCP_SERVER_PATH = join(__dirname, "../../src/mcp-server.ts");

// ── Test helpers ───────────────────────────────────────────────────────────────

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
 * Send JSON-RPC messages to the MCP server and return the last response.
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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("MCP advanced capabilities", () => {
  // --- Prompts ---

  it("lists all 4 prompts via prompts/list", async () => {
    const response = await callMcpServer([
      mcpInitialize(),
      mcpInitialized(),
      {
        jsonrpc: "2.0",
        id: 10,
        method: "prompts/list",
        params: {},
      },
    ]);

    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe(10);
    const result = response.result as any;
    expect(result.prompts).toBeDefined();
    expect(Array.isArray(result.prompts)).toBe(true);
    expect(result.prompts.length).toBe(4);

    const names = result.prompts.map((p: any) => p.name);
    expect(names).toContain("explain-code");
    expect(names).toContain("review-diff");
    expect(names).toContain("architectural-analysis");
    expect(names).toContain("smartread-tool-guide");
  }, 60_000);

  it("getting explain-code prompt returns correct message structure", async () => {
    const response = await callMcpServer([
      mcpInitialize(),
      mcpInitialized(),
      {
        jsonrpc: "2.0",
        id: 11,
        method: "prompts/get",
        params: {
          name: "explain-code",
          arguments: {
            code: "const x = 1;",
            language: "typescript",
          },
        },
      },
    ]);

    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe(11);
    const result = response.result as any;
    expect(result.messages).toBeDefined();
    expect(Array.isArray(result.messages)).toBe(true);
    expect(result.messages.length).toBeGreaterThan(0);

    const msg = result.messages[0]!;
    expect(msg.role).toBe("user");
    expect(msg.content).toBeDefined();
    expect(msg.content.type).toBe("text");
    expect(msg.content.text).toContain("typescript");
    expect(msg.content.text).toContain("const x = 1;");
  }, 60_000);

  it("getting review-diff prompt returns a user message", async () => {
    const response = await callMcpServer([
      mcpInitialize(),
      mcpInitialized(),
      {
        jsonrpc: "2.0",
        id: 12,
        method: "prompts/get",
        params: {
          name: "review-diff",
          arguments: {
            diff: "+--- a/test.js\n++++ b/test.js\n+const x = 1;",
            language: "javascript",
          },
        },
      },
    ]);

    const result = response.result as any;
    expect(result.messages).toBeDefined();
    const msg = result.messages[0]!;
    expect(msg.role).toBe("user");
    expect(msg.content.type).toBe("text");
    expect(msg.content.text).toContain("javascript");
    expect(msg.content.text).toContain("const x = 1;");
  }, 60_000);

  it("getting architectural-analysis prompt returns a user message", async () => {
    const response = await callMcpServer([
      mcpInitialize(),
      mcpInitialized(),
      {
        jsonrpc: "2.0",
        id: 13,
        method: "prompts/get",
        params: {
          name: "architectural-analysis",
          arguments: {
            filePath: "src/index.ts",
            query: "data flow",
          },
        },
      },
    ]);

    const result = response.result as any;
    expect(result.messages).toBeDefined();
    const msg = result.messages[0]!;
    expect(msg.role).toBe("user");
    expect(msg.content.type).toBe("text");
    expect(msg.content.text).toContain("src/index.ts");
    expect(msg.content.text).toContain("data flow");
  }, 60_000);

  it("getting smartread-tool-guide prompt returns tool selection guidance", async () => {
    const response = await callMcpServer([
      mcpInitialize(),
      mcpInitialized(),
      {
        jsonrpc: "2.0",
        id: 15,
        method: "prompts/get",
        params: {
          name: "smartread-tool-guide",
          arguments: {
            task: "find all usages of Authenticator",
          },
        },
      },
    ]);

    const result = response.result as any;
    expect(result.messages).toBeDefined();
    const msg = result.messages[0]!;
    expect(msg.role).toBe("user");
    expect(msg.content.type).toBe("text");
    expect(msg.content.text).toContain("find all usages of Authenticator");
    expect(msg.content.text).toContain('depth: "deep"');
    expect(msg.content.text).toContain("inspect { symbol }:");
    expect(msg.content.text).toContain('inspect { action: "map" }');
  }, 60_000);

  it("throws for unknown prompt", async () => {
    const response = await callMcpServer([
      mcpInitialize(),
      mcpInitialized(),
      {
        jsonrpc: "2.0",
        id: 14,
        method: "prompts/get",
        params: { name: "nonexistent-prompt" },
      },
    ]);

    // Unknown prompt throws a JSON-RPC error
    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe(14);
    expect(response.error).toBeDefined();
    const error = response.error as any;
    expect(error.message).toContain("Prompt not found");
  }, 60_000);

  // --- Resources ---

  it("lists resources via resources/list", async () => {
    const response = await callMcpServer([
      mcpInitialize(),
      mcpInitialized(),
      {
        jsonrpc: "2.0",
        id: 20,
        method: "resources/list",
        params: {},
      },
    ]);

    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe(20);
    const result = response.result as any;
    expect(result.resources).toBeDefined();
    expect(Array.isArray(result.resources)).toBe(true);
    expect(result.resources.length).toBeGreaterThan(0);

    const uris = result.resources.map((r: any) => r.uri);
    expect(uris).toContain("smartread://config");
    expect(uris).toContain("smartread://repo-map");
    expect(uris).toContain("smartread://status");
  }, 60_000);

  it("reading smartread://config returns JSON", async () => {
    const response = await callMcpServer([
      mcpInitialize(),
      mcpInitialized(),
      {
        jsonrpc: "2.0",
        id: 21,
        method: "resources/read",
        params: { uri: "smartread://config" },
      },
    ]);

    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe(21);
    const result = response.result as any;
    expect(result.contents).toBeDefined();
    expect(result.contents.length).toBeGreaterThan(0);

    const content = result.contents[0]!;
    expect(content.uri).toBe("smartread://config");
    expect(content.mimeType).toBe("application/json");

    // Should be valid JSON
    let parsed: any;
    expect(() => {
      parsed = JSON.parse(content.text);
    }).not.toThrow();

    // Should have expected top-level keys
    expect(parsed).toHaveProperty("version");
    expect(parsed).toHaveProperty("embedding");
    expect(parsed).toHaveProperty("search");
    expect(parsed).toHaveProperty("gitContext");
    expect(parsed).toHaveProperty("experimental");
  }, 60_000);

  it("reading smartread://status returns JSON with server info", async () => {
    const response = await callMcpServer([
      mcpInitialize(),
      mcpInitialized(),
      {
        jsonrpc: "2.0",
        id: 22,
        method: "resources/read",
        params: { uri: "smartread://status" },
      },
    ]);

    const result = response.result as any;
    expect(result.contents).toBeDefined();
    const content = result.contents[0]!;
    expect(content.uri).toBe("smartread://status");
    expect(content.mimeType).toBe("application/json");

    const parsed = JSON.parse(content.text);
    expect(parsed).toHaveProperty("version");
    expect(parsed).toHaveProperty("toolCount");
    expect(typeof parsed.toolCount).toBe("number");
    expect(parsed.toolCount).toBeGreaterThan(0);
    expect(parsed.capabilities).toEqual({
      tools: true,
      prompts: true,
      resources: true,
    });
  }, 60_000);

  it("reading smartread://repo-map returns placeholder text", async () => {
    const response = await callMcpServer([
      mcpInitialize(),
      mcpInitialized(),
      {
        jsonrpc: "2.0",
        id: 23,
        method: "resources/read",
        params: { uri: "smartread://repo-map" },
      },
    ]);

    const result = response.result as any;
    const content = result.contents[0]!;
    expect(content.uri).toBe("smartread://repo-map");
    expect(content.text).toContain("repo-map-placeholder");
  }, 60_000);

  it("throws for unknown resource URI", async () => {
    const response = await callMcpServer([
      mcpInitialize(),
      mcpInitialized(),
      {
        jsonrpc: "2.0",
        id: 24,
        method: "resources/read",
        params: { uri: "smartread://unknown" },
      },
    ]);

    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe(24);
    expect(response.error).toBeDefined();
    const error = response.error as any;
    expect(error.message).toContain("Resource not found");
  }, 60_000);

  // --- Server capabilities ---

  it("server capabilities include prompts and resources", async () => {
    const response = await callMcpServer(mcpInitialize());

    const result = response.result as any;
    expect(result.serverInfo.name).toBe("pi-smartread");
    expect(result.serverInfo.version).toBe("0.1.0");
    expect(result.capabilities).toBeDefined();
    expect(result.capabilities.tools).toBeDefined();
    expect(result.capabilities.prompts).toBeDefined();
    expect(result.capabilities.resources).toBeDefined();
  }, 60_000);

  // --- maybeResourceLink helper ---

  it("maybeResourceLink returns inline text for small content", async () => {
    // Import helper directly to unit-test
    const { maybeResourceLink } = await import("../../src/mcp-resources.js");

    const small = "Hello, world!";
    const result = maybeResourceLink("test", small);

    expect(result.length).toBe(1);
    const first = result[0]!;
    expect(first).toEqual({ type: "text", text: "Hello, world!" });
    // Should not create a resource_link
    expect(first).not.toHaveProperty("uri");
    expect(first).not.toHaveProperty("type", "resource_link");
  }, 60_000);

  it("maybeResourceLink returns resource_link for large content", async () => {
    const { maybeResourceLink, LARGE_RESULT_THRESHOLD } = await import("../../src/mcp-resources.js");

    // Build a string larger than 8 KB
    const large = "x".repeat(LARGE_RESULT_THRESHOLD + 1);
    const result = maybeResourceLink("repo_map", large);

    expect(result.length).toBe(1);
    const first = result[0]!;
    expect(first.type).toBe("resource_link");
    expect((first as any).uri).toBe("smartread://result/repo_map");
    expect((first as any).name).toBe("repo_map");
  }, 60_000);

  it("maybeResourceLink is inclusive on the 8KB boundary", async () => {
    const { maybeResourceLink, LARGE_RESULT_THRESHOLD } = await import("../../src/mcp-resources.js");

    // Exactly at threshold should remain inline
    const exact = "y".repeat(LARGE_RESULT_THRESHOLD);
    const atResult = maybeResourceLink("exact", exact);
    const atFirst = atResult[0]!;
    expect(atFirst.type).toBe("text");

    // Just over threshold should use resource_link
    const over = "y".repeat(LARGE_RESULT_THRESHOLD + 1);
    const overResult = maybeResourceLink("over", over);
    const overFirst = overResult[0]!;
    expect(overFirst.type).toBe("resource_link");
  }, 60_000);
});