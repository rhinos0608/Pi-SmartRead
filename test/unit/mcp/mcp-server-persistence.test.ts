/**
 * MCP persistence-failure test — isolated stateful stdio process.
 *
 * Temp cwd with experimental.graphMutate enabled and a regular file at
 * `.pi-smartread` blocking EdgeStore directory/log creation. The registry
 * reads experimental config from the child's cwd at module init, so this
 * case keeps its own process + cwd and cannot join the stateless batch.
 */
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { callMcpServer, mcpInitialize, mcpInitialized } from "./mcp-server-helper.js";

describe("MCP persistence failure (isolated stateful process)", () => {
  it("graph_mutate surfaces EdgeStore persistence failure as protocol-level isError when enabled", async () => {
    const childCwd = mkdtempSync(join(tmpdir(), "mcp-graphmutate-"));
    try {
      mkdirSync(childCwd, { recursive: true });
      writeFileSync(
        join(childCwd, "pi-smartread.config.json"),
        JSON.stringify({ experimental: { graphMutate: true } }),
        "utf8",
      );
      // Block `.pi-smartread/` directory creation with a regular file.
      writeFileSync(join(childCwd, ".pi-smartread"), "", "utf8");

      const response = await callMcpServer(
        [
          mcpInitialize(),
          mcpInitialized(),
          {
            jsonrpc: "2.0",
            id: 99,
            method: "tools/call",
            params: {
              name: "graph_mutate",
              arguments: { from: "src/a.ts", to: "src/b.ts", relation: "breakage" },
            },
          },
        ],
        60_000,
        childCwd,
      );

      const result = response.result as any;
      // Tool returned isError: true — the server must forward it, not hardcode false.
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Failed to persist");
    } finally {
      rmSync(childCwd, { recursive: true, force: true });
    }
  }, 90_000);
});
