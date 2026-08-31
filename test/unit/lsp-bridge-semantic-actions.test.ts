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

describe("LSPConnection semantic actions", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "lsp-semantic-")); });
  afterEach(async () => { rmSync(root, { recursive: true, force: true }); vi.clearAllMocks(); await shutdownAllManagers(); resetLSPBridge(); });

  it("organizeImports sends correct codeAction request with source.organizeImports only", async () => {
    const { conn, proc } = await makeConnection(root);
    const filePath = join(root, "a.ts");
    const fileUri = `file://${resolve(filePath)}`;
    const origWrite = proc.stdin.write as unknown as ReturnType<typeof vi.fn>;
    let captured: unknown = null;
    (proc.stdin.write as unknown as ReturnType<typeof vi.fn>) = vi.fn((data: string) => {
      (origWrite as unknown as (d: string) => boolean)(data);
      const m = String(data).match(/^Content-Length: (\d+)\r\n\r\n/);
      if (!m) return true;
      const len = parseInt(m[1]!, 10);
      const body = String(data).slice(m[0].length, m[0].length + len);
      try {
        const msg = JSON.parse(body);
        if (msg.method === "textDocument/codeAction") {
          captured = msg.params;
          expect(msg.params.textDocument.uri).toBe(fileUri);
          expect(msg.params.range).toEqual({ start: { line: 0, character: 0 }, end: { line: Number.MAX_SAFE_INTEGER, character: 0 } });
          expect(msg.params.context).toEqual({ only: ["source.organizeImports"] });
          queueMicrotask(() => sendToStdout(proc, { jsonrpc: "2.0", id: msg.id, result: [{ title: "org", edit: { documentChanges: [{ textDocument: { uri: fileUri, version: 1 }, edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: "x" }] }] } }] }));
        }
      } catch {}
      return true;
    });
    const result = await conn.organizeImports(filePath);
    expect(captured).not.toBeNull();
    expect(result).not.toBeNull();
  });

  it("organizeImports extracts first action with edit", async () => {
    const { conn, proc } = await makeConnection(root);
    const filePath = join(root, "b.ts");
    const fileUri = `file://${resolve(filePath)}`;
    const otherUri = `file://${resolve(join(root, "c.ts"))}`;
    const origWrite = proc.stdin.write as unknown as ReturnType<typeof vi.fn>;
    (proc.stdin.write as unknown as ReturnType<typeof vi.fn>) = vi.fn((data: string) => {
      (origWrite as unknown as (d: string) => boolean)(data);
      const m = String(data).match(/^Content-Length: (\d+)\r\n\r\n/);
      if (!m) return true;
      const len = parseInt(m[1]!, 10);
      const body = String(data).slice(m[0].length, m[0].length + len);
      try {
        const msg = JSON.parse(body);
        if (msg.method === "textDocument/codeAction") {
          queueMicrotask(() => sendToStdout(proc, {
            jsonrpc: "2.0", id: msg.id, result: [
              { title: "no-edit" },
              { title: "has-edit", edit: { changes: { [fileUri]: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "a" }] } } },
              { title: "also-has-edit", edit: { changes: { [otherUri]: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "b" }] } } },
            ]
          }));
        }
      } catch {}
      return true;
    });
    const result = await conn.organizeImports(filePath);
    expect(result).not.toBeNull();
    expect(result!.fileEdits[0]!.edits[0]!.newText).toBe("a");
    // should be first with edit, not the third
    expect(result!.fileEdits).toHaveLength(1);
  });

  it("organizeImports returns null when no action has edit", async () => {
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
        if (msg.method === "textDocument/codeAction") queueMicrotask(() => sendToStdout(proc, { jsonrpc: "2.0", id: msg.id, result: [{ title: "a" }, { title: "b" }] }));
      } catch {}
      return true;
    });
    const result = await conn.organizeImports(join(root, "a.ts"));
    expect(result).toBeNull();
  });

  it("formatting sends correct formatting request", async () => {
    const { conn, proc } = await makeConnection(root);
    const filePath = join(root, "f.ts");
    const fileUri = `file://${resolve(filePath)}`;
    const origWrite = proc.stdin.write as unknown as ReturnType<typeof vi.fn>;
    let captured: unknown = null;
    (proc.stdin.write as unknown as ReturnType<typeof vi.fn>) = vi.fn((data: string) => {
      (origWrite as unknown as (d: string) => boolean)(data);
      const m = String(data).match(/^Content-Length: (\d+)\r\n\r\n/);
      if (!m) return true;
      const len = parseInt(m[1]!, 10);
      const body = String(data).slice(m[0].length, m[0].length + len);
      try {
        const msg = JSON.parse(body);
        if (msg.method === "textDocument/formatting") {
          captured = msg.params;
          expect(msg.params.textDocument.uri).toBe(fileUri);
          expect(msg.params.options).toEqual({ tabSize: 4, insertSpaces: false });
          queueMicrotask(() => sendToStdout(proc, { jsonrpc: "2.0", id: msg.id, result: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, newText: "hello" }] }));
        }
      } catch {}
      return true;
    });
    const result = await conn.formatting(filePath, 4, false);
    expect(captured).not.toBeNull();
    expect(result).not.toBeNull();
  });

  it("formatting converts TextEdit array to LspWorkspaceEdit", async () => {
    const { conn, proc } = await makeConnection(root);
    const filePath = join(root, "g.ts");
    const origWrite = proc.stdin.write as unknown as ReturnType<typeof vi.fn>;
    (proc.stdin.write as unknown as ReturnType<typeof vi.fn>) = vi.fn((data: string) => {
      (origWrite as unknown as (d: string) => boolean)(data);
      const m = String(data).match(/^Content-Length: (\d+)\r\n\r\n/);
      if (!m) return true;
      const len = parseInt(m[1]!, 10);
      const body = String(data).slice(m[0].length, m[0].length + len);
      try {
        const msg = JSON.parse(body);
        if (msg.method === "textDocument/formatting") {
          queueMicrotask(() => sendToStdout(proc, { jsonrpc: "2.0", id: msg.id, result: [
            { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, newText: "hello" },
            { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } }, newText: "bye" },
          ] }));
        }
      } catch {}
      return true;
    });
    const result = await conn.formatting(filePath);
    expect(result).not.toBeNull();
    expect(result!.fileEdits).toHaveLength(1);
    expect(result!.fileEdits[0]!.filePath).toBe(resolve(filePath));
    expect(result!.fileEdits[0]!.edits).toHaveLength(2);
    expect(result!.fileEdits[0]!.edits[0]!.newText).toBe("hello");
    expect(result!.fileEdits[0]!.edits[1]!.newText).toBe("bye");
  });

  it("formatting returns null for empty response", async () => {
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
        if (msg.method === "textDocument/formatting") queueMicrotask(() => sendToStdout(proc, { jsonrpc: "2.0", id: msg.id, result: [] }));
      } catch {}
      return true;
    });
    expect(await conn.formatting(join(root, "a.ts"))).toBeNull();
    // null response also
    const { conn: conn2, proc: proc2 } = await makeConnection(join(root, "root2"));
    const origWrite2 = proc2.stdin.write as unknown as ReturnType<typeof vi.fn>;
    (proc2.stdin.write as unknown as ReturnType<typeof vi.fn>) = vi.fn((data: string) => {
      (origWrite2 as unknown as (d: string) => boolean)(data);
      const m = String(data).match(/^Content-Length: (\d+)\r\n\r\n/);
      if (!m) return true;
      const len = parseInt(m[1]!, 10);
      const body = String(data).slice(m[0].length, m[0].length + len);
      try {
        const msg = JSON.parse(body);
        if (msg.method === "textDocument/formatting") queueMicrotask(() => sendToStdout(proc2, { jsonrpc: "2.0", id: msg.id, result: null }));
      } catch {}
      return true;
    });
    expect(await conn2.formatting(join(root, "root2", "a.ts"))).toBeNull();
  });

  it("codeActions sends correct codeAction request", async () => {
    const { conn, proc } = await makeConnection(root);
    const filePath = join(root, "h.ts");
    const fileUri = `file://${resolve(filePath)}`;
    const range = { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } };
    const context = { diagnostics: [{ message: "err" }], only: ["quickfix"] };
    const origWrite = proc.stdin.write as unknown as ReturnType<typeof vi.fn>;
    let captured: unknown = null;
    (proc.stdin.write as unknown as ReturnType<typeof vi.fn>) = vi.fn((data: string) => {
      (origWrite as unknown as (d: string) => boolean)(data);
      const m = String(data).match(/^Content-Length: (\d+)\r\n\r\n/);
      if (!m) return true;
      const len = parseInt(m[1]!, 10);
      const body = String(data).slice(m[0].length, m[0].length + len);
      try {
        const msg = JSON.parse(body);
        if (msg.method === "textDocument/codeAction") {
          captured = msg.params;
          expect(msg.params.textDocument.uri).toBe(fileUri);
          expect(msg.params.range).toEqual(range);
          expect(msg.params.context).toEqual(context);
          queueMicrotask(() => sendToStdout(proc, { jsonrpc: "2.0", id: msg.id, result: [] }));
        }
      } catch {}
      return true;
    });
    const result = await conn.codeActions(filePath, range, context);
    expect(captured).not.toBeNull();
    expect(result).toEqual([]);
  });

  it("codeActions maps response to CodeActionItem array", async () => {
    const { conn, proc } = await makeConnection(root);
    const filePath = join(root, "i.ts");
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
        if (msg.method === "textDocument/codeAction") {
          queueMicrotask(() => sendToStdout(proc, {
            jsonrpc: "2.0", id: msg.id, result: [
              { title: "Fix it", kind: "quickfix", isPreferred: true, edit: { changes: { [fileUri]: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "a" }] } } },
              { title: "Refactor" },
            ]
          }));
        }
      } catch {}
      return true;
    });
    const result = await conn.codeActions(filePath, { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, {});
    expect(result).toHaveLength(2);
    expect(result[0]!.title).toBe("Fix it");
    expect(result[0]!.kind).toBe("quickfix");
    expect(result[0]!.isPreferred).toBe(true);
    expect(result[0]!.edit).toBeDefined();
    expect(result[0]!.edit!.fileEdits[0]!.edits[0]!.newText).toBe("a");
    expect(result[1]!.title).toBe("Refactor");
    expect(result[1]!.edit).toBeUndefined();
  });

  it("codeActions returns empty array for null response", async () => {
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
        if (msg.method === "textDocument/codeAction") queueMicrotask(() => sendToStdout(proc, { jsonrpc: "2.0", id: msg.id, result: null }));
      } catch {}
      return true;
    });
    const result = await conn.codeActions(join(root, "a.ts"), { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, {});
    expect(result).toEqual([]);
  });
});
