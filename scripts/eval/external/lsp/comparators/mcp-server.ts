/**
 * mcp-language-server (isaacphi, BSD-3-Clause, v0.1.1) comparator adapter —
 * benchmark harness only.
 *
 * The pinned release binary lives under
 * ~/.cache/pi-smartread-bench/tools/mcp-language-server-bin/ (built from the
 * v0.1.1 tag, commit 46e2950). The runner points it at the same pinned
 * typescript-language-server, so differences reflect the MCP tool layer.
 * Driven over MCP stdio with a minimal dependency-free JSON-RPC client
 * (newline-delimited frames, initialize + tools/call only — verified
 * empirically: the server scans stdin lines and emits line-delimited JSON).
 *
 * Operation support: definition(symbolName), references(symbolName),
 * hover(filePath, 1-indexed line/column). Both definition and references
 * resolve by SYMBOL NAME, not by position — the sampled position contributes
 * only its identifier text (and the hover call). There is no workspace/symbol
 * MCP tool, so workspaceSymbols is `unsupported`. references output carries
 * start positions only (parsed as point locations).
 */
import { type ChildProcess, spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { estimateTokens } from "../metrics.js";
import type { SampledPosition } from "../sample.js";
import {
  parseMcpDefinition,
  parseMcpHover,
  parseMcpReferences,
} from "./parse-mcp-output.js";
import type { Comparator, ComparatorCall } from "./types.js";

export const MCP_BIN = join(
  homedir(),
  ".cache",
  "pi-smartread-bench",
  "tools",
  "mcp-language-server-bin",
  "mcp-language-server",
);

const PROTOCOL_VERSION = "2024-11-05";
const CALL_TIMEOUT_MS = 60000;

interface McpTextContent {
  type: string;
  text?: string;
}

/** Minimal MCP stdio client: newline-delimited JSON-RPC. */
class McpStdioClient {
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private buffer = "";
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();

  start(command: string, args: string[], env: NodeJS.ProcessEnv): void {
    this.proc = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stdout?.on("data", (chunk: Buffer) => this.onData(chunk));
    this.proc.stderr?.on("data", () => {
      /* server logs to stderr; ignore */
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf-8");
    for (;;) {
      const nl = this.buffer.indexOf("\n");
      if (nl < 0) return;
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line.length === 0) continue;
      try {
        const msg = JSON.parse(line) as {
          id?: number;
          result?: unknown;
          error?: { message?: string };
        };
        if (typeof msg.id === "number") {
          const entry = this.pending.get(msg.id);
          if (entry) {
            this.pending.delete(msg.id);
            clearTimeout(entry.timer);
            if (msg.error) entry.reject(new Error(String(msg.error.message ?? "unknown error")));
            else entry.resolve(msg.result);
          }
        }
      } catch {
        /* malformed line: drop */
      }
    }
  }

  request(method: string, params: unknown): Promise<unknown> {
    const proc = this.proc;
    if (!proc?.stdin) return Promise.reject(new Error("mcp client not started"));
    const id = this.nextId;
    this.nextId += 1;
    const payload = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`mcp request timed out: ${method}`));
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      proc.stdin?.write(payload, (err) => {
        if (err) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  notify(method: string, params: unknown): void {
    this.proc?.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async stop(): Promise<void> {
    for (const [id, entry] of this.pending) {
      this.pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(new Error("mcp client stopped"));
    }
    const proc = this.proc;
    this.proc = null;
    if (!proc) return;
    proc.stdin?.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* already gone */
        }
        resolve();
      }, 5000);
      proc.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

function canonicalize(file: string): string | null {
  try {
    return realpathSync(file);
  } catch {
    return null;
  }
}

function contentText(result: unknown): string {
  if (result !== null && typeof result === "object") {
    const o = result as { content?: McpTextContent[]; isError?: boolean };
    if (Array.isArray(o.content)) {
      return o.content
        .filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => String(c.text))
        .join("\n");
    }
  }
  return "";
}

function resultIsError(result: unknown): boolean {
  return (
    result !== null &&
    typeof result === "object" &&
    (result as { isError?: boolean }).isError === true
  );
}

export function createMcpComparator(
  tlsBin: string,
  pinnedBinDir: string,
): Comparator {
  const mcp = new McpStdioClient();

  const toolCall = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ status: "ok-tool" | "error"; raw: string; ms: number }> => {
    const t0 = Date.now();
    try {
      const result = await mcp.request("tools/call", { name, arguments: args });
      const raw = resultIsError(result)
        ? `error: ${contentText(result)}`
        : contentText(result);
      return {
        status: resultIsError(result) ? "error" : "ok-tool",
        raw,
        ms: Date.now() - t0,
      };
    } catch (err) {
      const raw = `error: ${String((err as Error)?.message ?? err)}`;
      return { status: "error", raw, ms: Date.now() - t0 };
    }
  };

  return {
    id: "mcp-language-server",
    caveats: [
      "definition/references resolve by symbol NAME (workspace/symbol + exact-name filter), not by position; the sampled position contributes only its identifier text.",
      "references output carries start positions only; parsed as point locations (end == start).",
      "workspaceSymbols unsupported (no such MCP tool; definition uses workspace/symbol internally).",
      "hover takes 1-indexed line/column; adapter adds 1 to the 0-based sampled position.",
      "Framing verified empirically: newline-delimited JSON-RPC over stdio.",
    ],
    open: async (root: string): Promise<void> => {
      mcp.start(
        MCP_BIN,
        ["--workspace", root, "--lsp", tlsBin, "--", "--stdio"],
        { ...process.env, PATH: `${pinnedBinDir}:${process.env.PATH ?? ""}` },
      );
      await mcp.request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "pi-smartread-bench", version: "1.0.0" },
      });
      mcp.notify("notifications/initialized", {});
    },
    close: async (): Promise<void> => {
      await mcp.stop();
    },
    definition: async (pos: SampledPosition): Promise<ComparatorCall> => {
      const r = await toolCall("definition", { symbolName: pos.name });
      if (r.status === "error") {
        return { status: "error", ms: r.ms, tokens: estimateTokens(r.raw), raw: r.raw, locations: [] };
      }
      const parsed = parseMcpDefinition(r.raw, canonicalize);
      return { status: parsed.status, ms: r.ms, tokens: estimateTokens(r.raw), raw: r.raw, locations: parsed.locations };
    },
    references: async (pos: SampledPosition): Promise<ComparatorCall> => {
      const r = await toolCall("references", { symbolName: pos.name });
      if (r.status === "error") {
        return { status: "error", ms: r.ms, tokens: estimateTokens(r.raw), raw: r.raw, locations: [] };
      }
      const parsed = parseMcpReferences(r.raw, canonicalize);
      return { status: parsed.status, ms: r.ms, tokens: estimateTokens(r.raw), raw: r.raw, locations: parsed.locations };
    },
    hover: async (pos: SampledPosition): Promise<ComparatorCall> => {
      const r = await toolCall("hover", {
        filePath: pos.file,
        line: pos.line + 1,
        column: pos.character + 1,
      });
      if (r.status === "error") {
        return { status: "error", ms: r.ms, tokens: estimateTokens(r.raw), raw: r.raw, locations: [] };
      }
      const parsed = parseMcpHover(r.raw);
      return {
        status: parsed.status,
        ms: r.ms,
        tokens: estimateTokens(r.raw),
        raw: r.raw,
        locations: [],
        hoverText: parsed.text,
      };
    },
  };
}
