/**
 * MCP stateless protocol tests — ONE subprocess for the whole file.
 *
 * initialize + initialized + ping + unknown-tool + inputSchema rejections +
 * unknown-method + tools/list framing are sent as a single batch; assertions
 * are grouped per id below. Keeps the same assertion count as the former
 * one-process-per-test layout without the spawn overhead.
 */
import { describe, expect, it } from "vitest";
import { callMcpServerBatch, mcpInitialize, mcpInitialized } from "./mcp-server-helper.js";

describe("MCP stateless protocol (single batched process)", () => {
  it("handles ping, unknown tool/method, validation, and tools/list framing", async () => {
    const byId = await callMcpServerBatch(
      [
        mcpInitialize(),
        mcpInitialized(),
        { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
        { jsonrpc: "2.0", id: 3, method: "ping" },
        { jsonrpc: "2.0", id: 4, method: "unknown/method" },
        {
          jsonrpc: "2.0",
          id: 5,
          method: "tools/call",
          params: { name: "nonexistent_tool", arguments: {} },
        },
        {
          jsonrpc: "2.0",
          id: 7,
          method: "tools/call",
          params: { name: "inspect", arguments: {} },
        },
        {
          jsonrpc: "2.0",
          id: 9,
          method: "tools/call",
          params: { name: "inspect" },
        },
        {
          jsonrpc: "2.0",
          id: 10,
          method: "tools/call",
          params: { name: "inspect", arguments: null },
        },
        { jsonrpc: "2.0", id: 6, method: "tools/list", params: {} },
      ],
      60_000,
    );

    // tools/list framing (id 2)
    {
      const response = byId.get(2)!;
      expect(response).toBeDefined();
      expect(response.jsonrpc).toBe("2.0");
      expect(response.id).toBe(2);
      const result = response.result as any;
      expect(result.tools).toBeDefined();
      expect(Array.isArray(result.tools)).toBe(true);
      expect(result.tools.length).toBeGreaterThan(0);
    }

    // ping (id 3)
    {
      const response = byId.get(3)!;
      expect(response.jsonrpc).toBe("2.0");
      expect(response.id).toBe(3);
      expect(response.result).toEqual({});
    }

    // unknown method (id 4)
    {
      const response = byId.get(4)!;
      expect(response.jsonrpc).toBe("2.0");
      expect(response.id).toBe(4);
      expect(response.error).toBeDefined();
      expect((response.error as any).code).toBe(-32601); // METHOD_NOT_FOUND
    }

    // unknown tool (id 5) — server wraps errors in result.content with isError: true
    {
      const response = byId.get(5)!;
      expect(response.jsonrpc).toBe("2.0");
      expect(response.id).toBe(5);
      const result = response.result as any;
      expect(result).toBeDefined();
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Unknown tool");
    }

    // invalid arguments: missing 'mode' (id 7). The discriminated union
    // requires mode upfront, so this is a runtime rejection with the
    // same isError posture — never silently accepted.
    {
      const response = byId.get(7)!;
      expect(response.jsonrpc).toBe("2.0");
      expect(response.id).toBe(7);
      const result = response.result as any;
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid params');
    }

    // omitted arguments key (id 9) — normalized to {} and rejected the same way
    {
      const response = byId.get(9)!;
      expect(response.jsonrpc).toBe("2.0");
      expect(response.id).toBe(9);
      const result = response.result as any;
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid params');
    }

    // null arguments (id 10) — MCP SDK rejects at protocol boundary,
    // so the response is a JSON-RPC error, not a tool result.
    // Null is still rejected — never silently accepted.
    {
      const response = byId.get(10)!;
      expect(response.jsonrpc).toBe("2.0");
      expect(response.id).toBe(10);
      expect((response as any).error).toBeDefined();
    }

    // tools/list entries carry valid JSON Schema (id 6)
    {
      const response = byId.get(6)!;
      const tools = (response.result as any).tools;
      for (const tool of tools) {
        const schema = tool.inputSchema;
        expect(schema).toBeDefined();
        // Upstream function-calling requires parameters schema type "object";
        // top-level unions (anyOf/oneOf) are rejected with invalid_request_error.
        expect(schema.type).toBe("object");
        expect(schema.anyOf).toBeUndefined();
        expect(schema.oneOf).toBeUndefined();
        // Should have properties at minimum
        expect(schema.properties).toBeDefined();
      }
    }
  }, 60_000);
});
