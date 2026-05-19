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
const MCP_SERVER_PATH = join(__dirname, "../../mcp-server.ts");

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
 */
function callMcpServer(
  messageOrMessages: Record<string, unknown> | Array<Record<string, unknown>>,
  timeoutMs = 30_000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("MCP server timeout"));
    }, timeoutMs);

    const child = spawn("npx", ["tsx", MCP_SERVER_PATH], {
      stdio: ["pipe", "pipe", "pipe"],
      // Use the same cwd as mcp-server.test.ts — the repo root, so that
      // __dirname = "." + "../.." correctly resolves to the repo root.
      cwd: join(__dirname, "../.."),
    });

    let stdout = "";
    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.on("close", () => {
      // Wait briefly for stdout to flush after the process exits.
      // The MCP server writes responses to stdout and closes stdin,
      // so the last response should arrive before the process exits.
      let remaining = 500;
      const drain = setInterval(() => {
        remaining -= 50;
        const lines = stdout.trim().split("\n").filter(Boolean);
        if (lines.length > 0 || remaining <= 0) {
          clearInterval(drain);
          clearTimeout(timeout);
          if (lines.length === 0) {
            reject(new Error("No response from MCP server"));
            return;
          }
          try {
            resolve(JSON.parse(lines[lines.length - 1]!));
          } catch {
            reject(new Error(`Invalid JSON response: ${stdout}`));
          }
        }
      }, 50);
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    const messages = Array.isArray(messageOrMessages) ? messageOrMessages : [messageOrMessages];
    for (const message of messages) {
      child.stdin.write(JSON.stringify(message) + "\n");
    }
    child.stdin.end();
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("MCP advanced capabilities", () => {
  // --- Prompts ---

  it("lists all 3 prompts via prompts/list", async () => {
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
    expect(result.prompts.length).toBe(3);

    const names = result.prompts.map((p: any) => p.name);
    expect(names).toContain("explain-code");
    expect(names).toContain("review-diff");
    expect(names).toContain("architectural-analysis");
  });

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
  });

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
  });

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
  });

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
  });

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
  });

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
  });

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
  });

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
  });

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
  });

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
  });

  // --- maybeResourceLink helper ---

  it("maybeResourceLink returns inline text for small content", async () => {
    // Import helper directly to unit-test
    const { maybeResourceLink } = await import("../../mcp-resources.js");

    const small = "Hello, world!";
    const result = maybeResourceLink("test", small);

    expect(result.length).toBe(1);
    const first = result[0]!;
    expect(first).toEqual({ type: "text", text: "Hello, world!" });
    // Should not create a resource_link
    expect(first).not.toHaveProperty("uri");
    expect(first).not.toHaveProperty("type", "resource_link");
  });

  it("maybeResourceLink returns resource_link for large content", async () => {
    const { maybeResourceLink, LARGE_RESULT_THRESHOLD } = await import("../../mcp-resources.js");

    // Build a string larger than 8 KB
    const large = "x".repeat(LARGE_RESULT_THRESHOLD + 1);
    const result = maybeResourceLink("repo_map", large);

    expect(result.length).toBe(1);
    const first = result[0]!;
    expect(first.type).toBe("resource_link");
    expect((first as any).uri).toBe("smartread://result/repo_map");
    expect((first as any).name).toBe("repo_map");
  });

  it("maybeResourceLink is inclusive on the 8KB boundary", async () => {
    const { maybeResourceLink, LARGE_RESULT_THRESHOLD } = await import("../../mcp-resources.js");

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
  });
});