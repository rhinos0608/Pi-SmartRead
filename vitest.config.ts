import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Parallel workers
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: false,
      },
    },
    // 45s test timeout
    testTimeout: 45_000,
    // Setup file for optional dependency checks
    setupFiles: [],
    // Environment
    environment: "node",
    // Include test files
    include: ["test/**/*.test.ts"],
  },
});

// 
// OPTIMIZATION NOTE (test.mcpServer.keepAlive):
// For MCP server tests, consider pooling a single long-lived server process
// across tests instead of spawning one per test. This would cut MCP test
// time from ~4s per spawn (tsx cold boot) to ~0.1s per request dispatch.
// Set poolOptions.forks.singleFork = true and share the server instance
// via module-level state when keepAlive mode is enabled.
// 
