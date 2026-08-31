import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
function makeFakeProc(): FakeProc {
  const proc = new EventEmitter() as FakeProc;
  proc.stdout = new EventEmitter();
  proc.kill = vi.fn();
  proc.stdin = {
    write: vi.fn((data: string) => {
      const m = String(data).match(/^Content-Length: (\d+)\r\n\r\n/);
      if (m) {
        const len = parseInt(m[1]!, 10);
        const content = String(data).slice(m[0].length, m[0].length + len);
        try {
          const msg = JSON.parse(content);
          if (msg.method === "initialize" && msg.id !== undefined) {
            queueMicrotask(() => sendToStdout(proc, { jsonrpc: "2.0", id: msg.id, result: { capabilities: {} } }));
          }
        } catch {}
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
const { LSPConnection, shutdownAllManagers, resetLSPBridge } = await import("../../src/lsp-bridge.js");

async function makeConnection(root: string): Promise<{ conn: InstanceType<typeof LSPConnection>; proc: FakeProc }> {
  const conn = new LSPConnection();
  const startPromise = conn.start("fake-lsp-server", ["--stdio"], root);
  const proc = (spawn as unknown as ReturnType<typeof vi.fn>).mock.results.at(-1)!.value as FakeProc;
  await startPromise;
  proc.stdin.write.mockClear();
  return { conn, proc };
}

describe("LSPConnection rename", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "lsp-rename-")); });
  afterEach(async () => { rmSync(root, { recursive: true, force: true }); vi.clearAllMocks(); await shutdownAllManagers(); resetLSPBridge(); });

  it("rename converts documentChanges format", async () => {
    const { conn, proc } = await makeConnection(root);
    const filePath = join(root, "a.ts");
    const targetPath = join(root, "b.ts");
    const targetUri = `file://${resolve(targetPath)}`;
    const fileUri = `file://${resolve(filePath)}`;
    // Intercept rename request and respond with documentChanges
    const origWrite = proc.stdin.write as unknown as ReturnType<typeof vi.fn>;
    (proc.stdin.write as unknown as ReturnType<typeof vi.fn>) = vi.fn((data: string) => {
      (origWrite as unknown as (d: string) => boolean)(data);
      const m = String(data).match(/^Content-Length: (\d+)\r\n\r\n/);
      if (!m) return true;
      const len = parseInt(m[1]!, 10);
      const body = String(data).slice(m[0].length, m[0].length + len);
      try {
        const msg = JSON.parse(body);
        if (msg.method === "textDocument/rename") {
          expect(msg.params.textDocument.uri).toBe(fileUri);
          expect(msg.params.position).toEqual({ line: 1, character: 2 });
          expect(msg.params.newName).toBe("newFoo");
          queueMicrotask(() =>
            sendToStdout(proc, {
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                documentChanges: [
                  { textDocument: { uri: fileUri, version: 1 }, edits: [{ range: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } }, newText: "newFoo" }] },
                  { textDocument: { uri: targetUri, version: 1 }, edits: [{ range: { start: { line: 3, character: 0 }, end: { line: 3, character: 3 } }, newText: "newFoo" }] },
                ],
              },
            }),
          );
        }
      } catch {}
      return true;
    });
    const result = await conn.rename(filePath, 1, 2, "newFoo");
    expect(result).not.toBeNull();
    expect(result!.fileEdits).toHaveLength(2);
    expect(result!.fileEdits[0]!.edits[0]!.newText).toBe("newFoo");
  });

  it("rename converts changes format", async () => {
    const { conn, proc } = await makeConnection(root);
    const filePath = join(root, "a.ts");
    const fileUri = `file://${resolve(filePath)}`;
    const origWrite = proc.stdin.write as unknown as ReturnType<typeof vi.fn>;
    (proc.stdin.write as unknown as ReturnType<typeof vi.fn>) = vi.fn((data: string) => {
      (origWrite as unknown as (d: string) => boolean)(data);
      const m = String(data).match(/^Content-Length: (\d+)\r\n\r\n/);
      if (!m) return true;
      const len = parseInt(m[1]!, 10);
      const body = String(data).slice(m[0].length, m[0].length + len);
      try {
        const msg = JSON.parse(body);
        if (msg.method === "textDocument/rename") {
          queueMicrotask(() =>
            sendToStdout(proc, {
              jsonrpc: "2.0",
              id: msg.id,
              result: { changes: { [fileUri]: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: "renamed" }] } },
            }),
          );
        }
      } catch {}
      return true;
    });
    const result = await conn.rename(filePath, 0, 0, "renamed");
    expect(result).not.toBeNull();
    expect(result!.fileEdits[0]!.edits[0]!.newText).toBe("renamed");
  });

  it("rename returns null when server returns null", async () => {
    const { conn, proc } = await makeConnection(root);
    const origWrite = proc.stdin.write as unknown as ReturnType<typeof vi.fn>;
    (proc.stdin.write as unknown as ReturnType<typeof vi.fn>) = vi.fn((data: string) => {
      (origWrite as unknown as (d: string) => boolean)(data);
      const m = String(data).match(/^Content-Length: (\d+)\r\n\r\n/);
      if (!m) return true;
      const len = parseInt(m[1]!, 10);
      const body = String(data).slice(m[0].length, m[0].length + len);
      try {
        const msg = JSON.parse(body);
        if (msg.method === "textDocument/rename") queueMicrotask(() => sendToStdout(proc, { jsonrpc: "2.0", id: msg.id, result: null }));
      } catch {}
      return true;
    });
    const result = await conn.rename(join(root, "a.ts"), 0, 0, "x");
    expect(result).toBeNull();
  });

  it("prepareRename returns null when server returns null", async () => {
    const { conn, proc } = await makeConnection(root);
    const origWrite = proc.stdin.write as unknown as ReturnType<typeof vi.fn>;
    (proc.stdin.write as unknown as ReturnType<typeof vi.fn>) = vi.fn((data: string) => {
      (origWrite as unknown as (d: string) => boolean)(data);
      const m = String(data).match(/^Content-Length: (\d+)\r\n\r\n/);
      if (!m) return true;
      const len = parseInt(m[1]!, 10);
      const body = String(data).slice(m[0].length, m[0].length + len);
      try {
        const msg = JSON.parse(body);
        if (msg.method === "textDocument/prepareRename") queueMicrotask(() => sendToStdout(proc, { jsonrpc: "2.0", id: msg.id, result: null }));
      } catch {}
      return true;
    });
    const r = await conn.prepareRename(join(root, "a.ts"), 0, 0);
    expect(r).toBeNull();
  });

  it("prepareRename returns range when server supports it", async () => {
    const { conn, proc } = await makeConnection(root);
    const origWrite = proc.stdin.write as unknown as ReturnType<typeof vi.fn>;
    (proc.stdin.write as unknown as ReturnType<typeof vi.fn>) = vi.fn((data: string) => {
      (origWrite as unknown as (d: string) => boolean)(data);
      const m = String(data).match(/^Content-Length: (\d+)\r\n\r\n/);
      if (!m) return true;
      const len = parseInt(m[1]!, 10);
      const body = String(data).slice(m[0].length, m[0].length + len);
      try {
        const msg = JSON.parse(body);
        if (msg.method === "textDocument/prepareRename")
          queueMicrotask(() =>
            sendToStdout(proc, {
              jsonrpc: "2.0",
              id: msg.id,
              result: { range: { start: { line: 0, character: 1 }, end: { line: 0, character: 4 } }, placeholder: "foo" },
            }),
          );
      } catch {}
      return true;
    });
    const r = await conn.prepareRename(join(root, "a.ts"), 0, 1);
    expect(r).not.toBeNull();
    expect(r!.range).toEqual({ start: { line: 0, character: 1 }, end: { line: 0, character: 4 } });
    expect(r!.placeholder).toBe("foo");
  });

  it("prepareRename handles Range directly", async () => {
    const { conn, proc } = await makeConnection(root);
    const origWrite = proc.stdin.write as unknown as ReturnType<typeof vi.fn>;
    (proc.stdin.write as unknown as ReturnType<typeof vi.fn>) = vi.fn((data: string) => {
      (origWrite as unknown as (d: string) => boolean)(data);
      const m = String(data).match(/^Content-Length: (\d+)\r\n\r\n/);
      if (!m) return true;
      const len = parseInt(m[1]!, 10);
      const body = String(data).slice(m[0].length, m[0].length + len);
      try {
        const msg = JSON.parse(body);
        if (msg.method === "textDocument/prepareRename")
          queueMicrotask(() => sendToStdout(proc, { jsonrpc: "2.0", id: msg.id, result: { start: { line: 2, character: 0 }, end: { line: 2, character: 5 } } }));
      } catch {}
      return true;
    });
    const r = await conn.prepareRename(join(root, "a.ts"), 2, 0);
    expect(r!.range).toEqual({ start: { line: 2, character: 0 }, end: { line: 2, character: 5 } });
  });
});
