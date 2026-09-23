import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface FakeProc extends EventEmitter {
  stdin: { write: ReturnType<typeof vi.fn> };
  stdout: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
}

function encodeMessage(obj: unknown): string {
  const body = JSON.stringify(obj);
  return `Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n\r\n${body}`;
}

function sendToStdout(proc: FakeProc, obj: unknown): void {
  proc.stdout.emit("data", Buffer.from(encodeMessage(obj), "utf-8"));
}

function writtenMessages(proc: FakeProc): any[] {
  const messages: any[] = [];
  for (const call of proc.stdin.write.mock.calls) {
    const raw = String(call[0]);
    const match = raw.match(/^Content-Length: (\d+)\r\n\r\n/);
    if (!match) continue;
    const len = parseInt(match[1]!, 10);
    const content = raw.slice(match[0].length, match[0].length + len);
    try { messages.push(JSON.parse(content)); } catch { /* ignore */ }
  }
  return messages;
}

function makeFakeProc(): FakeProc {
  const proc = new EventEmitter() as FakeProc;
  proc.stdout = new EventEmitter();
  proc.kill = vi.fn();
  proc.stdin = {
    write: vi.fn((data: string) => {
      const match = String(data).match(/^Content-Length: (\d+)\r\n\r\n/);
      if (match) {
        const len = parseInt(match[1]!, 10);
        const content = String(data).slice(match[0].length, match[0].length + len);
        try {
          const msg = JSON.parse(content);
          if (msg.method === "initialize" && msg.id !== undefined) {
            queueMicrotask(() => sendToStdout(proc, { jsonrpc: "2.0", id: msg.id, result: { capabilities: {} } }));
          }
          // NOTE: no shutdown response — exercises timeout-bounded settle path.
        } catch { /* ignore */ }
      }
      return true;
    }),
  };
  return proc;
}

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => makeFakeProc()),
  execFileSync: vi.fn(() => Buffer.from("")),
}));

const { spawn } = await import("node:child_process");
const { LSPConnection, shutdownAllManagers, resetLSPBridge, invalidateResolvedServerCacheForRoot } = await import("../../../src/lsp/lsp-bridge.js");

describe("LSPConnection shutdown ordering", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "lsp-conn-shutdown-")); });
  afterEach(async () => {
    invalidateResolvedServerCacheForRoot(root);
    rmSync(root, { recursive: true, force: true });
    vi.clearAllMocks();
    (spawn as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => makeFakeProc());
    await shutdownAllManagers();
    resetLSPBridge();
  });

  it("sends shutdown request then exit notification in order", async () => {
    const conn = new LSPConnection();
    await conn.start("fake-lsp-server", ["--stdio"], root);
    const proc = (spawn as unknown as ReturnType<typeof vi.fn>).mock.results.at(-1)!.value as FakeProc;
    proc.stdin.write.mockClear();

    conn.shutdown();
    // Timeout-bounded settle (no shutdown response): exit IS sent, closed set, proc killed — none may hang.
    await vi.waitFor(() => {
      const methods = writtenMessages(proc).map((m) => m.method ?? "(response)");
      expect(methods).toContain("shutdown");
      expect(methods).toContain("exit");
    }, { timeout: 8000 });
    expect((conn as unknown as { closed: boolean }).closed).toBe(true);
    await vi.waitFor(() => {
      expect(proc.kill).toHaveBeenCalled();
    }, { timeout: 8000 });
    const msgs = writtenMessages(proc);
    const shutdownIdx = msgs.findIndex((m) => m.method === "shutdown");
    const exitIdx = msgs.findIndex((m) => m.method === "exit");
    expect(shutdownIdx).toBeGreaterThanOrEqual(0);
    expect(exitIdx).toBeGreaterThanOrEqual(0);
    expect(shutdownIdx).toBeLessThan(exitIdx);
    expect(msgs[shutdownIdx].id).toBeDefined();
  });
});
