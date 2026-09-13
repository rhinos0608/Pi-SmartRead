/**
 * Shared stdio helpers for mcp-server* tests.
 *
 * Single-response `callMcpServer` is for smoke/isolated tests.
 * `callMcpServerBatch` sends many messages to ONE process and returns
 * responses keyed by id — used to batch stateless protocol assertions
 * without spawning one process per case.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
export const MCP_SERVER_PATH = join(__dirname, "../../src/mcp-server.ts");
const require = createRequire(import.meta.url);
export const TSX_LOADER_PATH = pathToFileURL(require.resolve("tsx")).href;

export function mcpInitialize(): Record<string, unknown> {
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

export function mcpInitialized(): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    method: "notifications/initialized",
    params: {},
  };
}

function spawnMcpServer(childCwd?: string) {
  return spawn("node", ["--import", TSX_LOADER_PATH, MCP_SERVER_PATH], {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: childCwd ?? join(__dirname, "../.."),
  });
}

function collectResponses(
  child: ReturnType<typeof spawn>,
  onStderr: (s: string) => void,
): { responses: Array<Record<string, unknown>>; pending: { line: string } } {
  const responses: Array<Record<string, unknown>> = [];
  const pending = { line: "" };
  let stderr = "";
  child.stderr?.on("data", (data: Buffer) => {
    stderr += data.toString();
    onStderr(stderr);
  });
  child.stdout?.on("data", (data: Buffer) => {
    pending.line += data.toString();
    const lines = pending.line.split("\n");
    pending.line = lines.pop() ?? "";
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      try {
        responses.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // Skip non-JSON lines (e.g. debug output)
      }
    }
  });
  return { responses, pending };
}

export function callMcpServer(
  messageOrMessages: Record<string, unknown> | Array<Record<string, unknown>>,
  timeoutMs = 30_000,
  childCwd?: string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawnMcpServer(childCwd);
    let stderr = "";
    const { responses } = collectResponses(child, (s) => {
      stderr = s;
    });
    const timeout = setTimeout(() => {
      clearInterval(pollStartup);
      child.kill();
      reject(new Error("MCP server timeout"));
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timeout);
      clearInterval(pollStartup);
      reject(err);
    });
    child.on("close", () => {
      clearTimeout(timeout);
      clearInterval(pollStartup);
      if (responses.length === 0) {
        reject(new Error("No JSON-RPC response from MCP server"));
        return;
      }
      const lastId = messages.length > 0 ? (messages[messages.length - 1] as Record<string, unknown>)?.id : undefined;
      const match = responses.find((r) => r.id === lastId);
      if (!match) {
        reject(new Error("No JSON-RPC response matching the final request id from MCP server"));
        return;
      }
      resolve(match);
    });
    const messages = Array.isArray(messageOrMessages) ? messageOrMessages : [messageOrMessages];
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

/**
 * Send many JSON-RPC messages to ONE server process; resolve a map of
 * id -> response once the process exits. Notifications (no id) get no reply.
 */
export function callMcpServerBatch(
  messages: Array<Record<string, unknown>>,
  timeoutMs = 60_000,
  childCwd?: string,
): Promise<Map<unknown, Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const child = spawnMcpServer(childCwd);
    let stderr = "";
    const { responses } = collectResponses(child, (s) => {
      stderr = s;
    });
    const timeout = setTimeout(() => {
      clearInterval(pollStartup);
      child.kill();
      reject(new Error("MCP server timeout"));
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timeout);
      clearInterval(pollStartup);
      reject(err);
    });
    child.on("close", () => {
      clearTimeout(timeout);
      clearInterval(pollStartup);
      if (responses.length === 0) {
        reject(new Error("No JSON-RPC response from MCP server"));
        return;
      }
      const byId = new Map<unknown, Record<string, unknown>>();
      for (const r of responses) {
        if (r.id !== undefined) byId.set(r.id, r);
      }
      resolve(byId);
    });
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
