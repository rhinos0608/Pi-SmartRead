/**
 * MCP stdio smoke tests — true subprocess coverage.
 *
 * Only the cases that need a real stdio round-trip live here:
 * initialize handshake + standalone inspect map (real session identity).
 * Stateless protocol assertions are batched in
 * `mcp-server-protocol.test.ts`; schema assertions via the registry
 * (no subprocess) in `mcp-server-schema.test.ts`; the stateful
 * persistence failure in `mcp-server-persistence.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { callMcpServer, mcpInitialize, mcpInitialized } from "./mcp-server-helper.js";

describe("MCP stdio server (smoke)", () => {
  it("responds to initialize request", async () => {
    const response = await callMcpServer(mcpInitialize());

    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe(1);
    expect(response.result).toBeDefined();

    const result = response.result as any;
    expect(result.protocolVersion).toBe("2024-11-05");
    expect(result.capabilities).toBeDefined();
    expect(result.serverInfo.name).toBe("pi-smartread");
    expect(result.serverInfo.version).toBe("0.5.0");
  }, 60_000);

  it("executes standalone inspect map with a real session identity", async () => {
    const response = await callMcpServer(
      [
        mcpInitialize(),
        mcpInitialized(),
        {
          jsonrpc: "2.0",
          id: 8,
          method: "tools/call",
          params: {
            name: "inspect",
            arguments: { path: "src" },
          },
        },
      ],
      60_000,
    );

    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe(8);
    const result = response.result as any;
    expect(result.isError).toBe(false);
    expect(result.content[0].text).not.toMatch(/no real session file|ephemeral identity/i);
    expect(result.content[0].text.length).toBeGreaterThan(0);
  }, 90_000);
});
