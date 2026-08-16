import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Fake child process used in place of a real LSP server. Captures every
 * JSON-RPC message written to stdin (for assertions) and lets tests push
 * server → client messages via its stdout emitter.
 */
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

/** Parse every complete JSON-RPC message written to the fake proc's stdin. */
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
      // Auto-respond to "initialize" so LSPConnection.start() resolves.
      const match = String(data).match(/^Content-Length: (\d+)\r\n\r\n/);
      if (match) {
        const len = parseInt(match[1]!, 10);
        const content = String(data).slice(match[0].length, match[0].length + len);
        try {
          const msg = JSON.parse(content);
          if (msg.method === "initialize" && msg.id !== undefined) {
            queueMicrotask(() => sendToStdout(proc, { jsonrpc: "2.0", id: msg.id, result: { capabilities: {} } }));
          }
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
const { LSPConnection, getLSPBridge, resetLSPBridge, shutdownAllManagers } = await import("../../src/lsp-bridge.js");

async function makeConnection(root: string): Promise<{ conn: InstanceType<typeof LSPConnection>; proc: FakeProc }> {
  const conn = new LSPConnection();
  const startPromise = conn.start("fake-lsp-server", ["--stdio"], root);
  const proc = (spawn as unknown as ReturnType<typeof vi.fn>).mock.results.at(-1)!.value as FakeProc;
  await startPromise;
  proc.stdin.write.mockClear();
  return { conn, proc };
}

describe("LSPConnection diagnostics plumbing", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "lsp-bridge-diag-"));
  });

  afterEach(async () => {
    rmSync(root, { recursive: true, force: true });
    vi.clearAllMocks();
    await shutdownAllManagers();
    resetLSPBridge();
  });

  it("sends didOpen (not didChange) on first touch of an unopened document", async () => {
    const { conn, proc } = await makeConnection(root);
    const filePath = join(root, "a.ts");

    await conn.didChange(filePath, "export const a = 1;");

    const msgs = writtenMessages(proc);
    expect(msgs.find((m) => m.method === "textDocument/didOpen")).toBeTruthy();
    expect(msgs.find((m) => m.method === "textDocument/didChange")).toBeFalsy();
  });

  it("sends didChange (not didOpen) on a subsequent touch of an already-open document", async () => {
    const { conn, proc } = await makeConnection(root);
    const filePath = join(root, "a.ts");

    await conn.didChange(filePath, "export const a = 1;");
    proc.stdin.write.mockClear();

    await conn.didChange(filePath, "export const a = 2;");

    const msgs = writtenMessages(proc);
    expect(msgs.find((m) => m.method === "textDocument/didChange")).toBeTruthy();
    expect(msgs.find((m) => m.method === "textDocument/didOpen")).toBeFalsy();
  });

  it("didSave sends the correct LSP method/params shape", async () => {
    const { conn, proc } = await makeConnection(root);
    const filePath = join(root, "a.ts");

    await conn.didChange(filePath, "export const a = 1;"); // open the doc first
    proc.stdin.write.mockClear();

    await conn.didSave(filePath);

    const msgs = writtenMessages(proc);
    const didSave = msgs.find((m) => m.method === "textDocument/didSave");
    expect(didSave).toBeTruthy();
    expect(didSave.params).toEqual({ textDocument: { uri: `file://${resolve(filePath)}` } });
  });

  it("didSave is a no-op for a file never opened on this connection", async () => {
    const { conn, proc } = await makeConnection(root);
    const filePath = join(root, "never-opened.ts");

    await conn.didSave(filePath);

    const msgs = writtenMessages(proc);
    expect(msgs.find((m) => m.method === "textDocument/didSave")).toBeFalsy();
  });

  it("onNotification: two handlers for the same method both fire", async () => {
    const { conn, proc } = await makeConnection(root);
    const calls1: unknown[] = [];
    const calls2: unknown[] = [];
    conn.onNotification("window/logMessage", (p) => calls1.push(p));
    conn.onNotification("window/logMessage", (p) => calls2.push(p));

    sendToStdout(proc, { jsonrpc: "2.0", method: "window/logMessage", params: { message: "hi" } });

    expect(calls1).toEqual([{ message: "hi" }]);
    expect(calls2).toEqual([{ message: "hi" }]);
  });

  it("onNotification: unsubscribing one handler leaves the other active", async () => {
    const { conn, proc } = await makeConnection(root);
    const calls1: unknown[] = [];
    const calls2: unknown[] = [];
    const unsub1 = conn.onNotification("window/logMessage", (p) => calls1.push(p));
    conn.onNotification("window/logMessage", (p) => calls2.push(p));

    unsub1();
    sendToStdout(proc, { jsonrpc: "2.0", method: "window/logMessage", params: { message: "hi" } });

    expect(calls1).toEqual([]);
    expect(calls2).toEqual([{ message: "hi" }]);
  });

  it("onNotification: a notification for an unregistered method is silently ignored", async () => {
    const { conn, proc } = await makeConnection(root);
    conn.onNotification("window/logMessage", () => { throw new Error("should not fire"); });

    expect(() => {
      sendToStdout(proc, { jsonrpc: "2.0", method: "$/some/unknown/notification", params: {} });
    }).not.toThrow();
  });

  it("caps the accumulated stdout buffer and force-closes the connection on overflow", async () => {
    const { conn, proc } = await makeConnection(root);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Feed chunks with no complete "Content-Length" message so they keep
    // accumulating in the internal buffer, well past the 50MB cap.
    const chunk = "x".repeat(1024 * 1024); // 1MB
    for (let i = 0; i < 51; i++) {
      expect(() => proc.stdout.emit("data", Buffer.from(chunk, "utf-8"))).not.toThrow();
    }

    expect(errorSpy).toHaveBeenCalled();
    expect(proc.kill).toHaveBeenCalled();

    // Connection should now be closed: further requests resolve to null
    // immediately instead of hanging or throwing.
    const result = await conn.request("workspace/symbol", { query: "x" });
    expect(result).toBeNull();

    errorSpy.mockRestore();
  });

  it("isAvailable reflects actual cached managers, not the dead __default__ sentinel", async () => {
    resetLSPBridge();
    const bridge = await getLSPBridge();
    expect(bridge).not.toBeNull();

    // Opening a file in a fresh root creates a manager with a live connection.
    const filePath = join(root, "a.ts");
    writeFileSync(filePath, "export const a = 1;");
    await bridge!.openFile(filePath, root);

    expect(bridge!.isAvailable()).toBe(true);
  });

  it("frames multibyte diagnostic messages using byte offsets", async () => {
    const { conn, proc } = await makeConnection(root);
    const filePath = join(root, "a.ts");
    await conn.didChange(filePath, "export const a = 1;");

    const message = "café ☕ 診断";
    const body = JSON.stringify({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: { uri: `file://${resolve(filePath)}`, diagnostics: [{ message, severity: 1 }] },
    });
    const framed = Buffer.from(`Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n\r\n${body}`, "utf-8");

    // Split inside the 3-byte ☕ character to prove byte-based framing.
    const marker = Buffer.from("☕", "utf-8");
    const markerIdx = framed.indexOf(marker);
    expect(markerIdx).toBeGreaterThan(0);
    const splitAt = markerIdx + 1;
    proc.stdout.emit("data", framed.subarray(0, splitAt));
    proc.stdout.emit("data", framed.subarray(splitAt));

    expect(conn.getDiagnostics(filePath)).toEqual([{ message, severity: 1 }]);
  });

  it("clears cached diagnostics on didChange so stale results are not returned", async () => {
    const { conn, proc } = await makeConnection(root);
    const filePath = join(root, "a.ts");
    await conn.didChange(filePath, "export const a = 1;");

    sendToStdout(proc, {
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: { uri: `file://${resolve(filePath)}`, diagnostics: [{ message: "stale", severity: 1 }] },
    });
    expect(conn.getDiagnostics(filePath)).toHaveLength(1);

    await conn.didChange(filePath, "export const a = 2;");
    expect(conn.getDiagnostics(filePath)).toHaveLength(0);
  });
});
