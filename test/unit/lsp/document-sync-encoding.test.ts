import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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

/** Parse every complete JSON-RPC message written to the fake proc's stdin. */
function writtenMessages(proc: FakeProc): Array<{ method?: string; id?: number; params?: any }> {
  const messages: Array<{ method?: string; id?: number; params?: any }> = [];
  for (const call of proc.stdin.write.mock.calls) {
    const raw = String(call[0]);
    const match = raw.match(/^Content-Length: (\d+)\r\n\r\n/);
    if (!match) continue;
    const len = parseInt(match[1]!, 10);
    const content = raw.slice(match[0].length, match[0].length + len);
    try {
      messages.push(JSON.parse(content));
    } catch {
      /* ignore */
    }
  }
  return messages;
}

/** Fake proc whose initialize response carries caller-supplied capabilities. */
function makeFakeProc(caps: Record<string, unknown>): FakeProc {
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
            queueMicrotask(() =>
              sendToStdout(proc, { jsonrpc: "2.0", id: msg.id, result: { capabilities: caps } }),
            );
          }
        } catch {
          /* ignore */
        }
      }
      return true;
    }),
  };
  return proc;
}

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
  execFileSync: vi.fn(() => Buffer.from("")),
}));

const { spawn } = await import("node:child_process");
const { LSPConnection } = await import("../../../src/lsp/lsp-connection.js");

async function makeConnection(
  caps: Record<string, unknown>,
  root: string,
): Promise<{ conn: InstanceType<typeof LSPConnection>; proc: FakeProc }> {
  (spawn as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => makeFakeProc(caps));
  const conn = new LSPConnection();
  const startPromise = conn.start("fake-lsp-server", ["--stdio"], root);
  const proc = (spawn as unknown as ReturnType<typeof vi.fn>).mock.results.at(-1)!.value as FakeProc;
  await startPromise;
  proc.stdin.write.mockClear();
  return { conn, proc };
}

describe("document sync encoding (multibyte incremental ranges)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "lsp-sync-enc-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("utf-8: incremental range end derives from OLD line (4, not naive 2)", async () => {
    const { conn, proc } = await makeConnection(
      { textDocumentSync: 2, positionEncoding: "utf-8" },
      root,
    );
    const filePath = join(root, "a.ts");

    await conn.prepareDocument(filePath, "😀hello");
    proc.stdin.write.mockClear();
    await conn.prepareDocument(filePath, "Xhello");

    const msgs = writtenMessages(proc);
    const change = msgs.find((m) => m.method === "textDocument/didChange");
    expect(change).toBeTruthy();
    const range = change!.params.contentChanges[0].range;
    expect(range.start).toEqual({ line: 0, character: 0 });
    // OLD line "😀hello": 😀 is 4 UTF-8 bytes, so end-char 4. A converter fed
    // the NEW line "Xhello" would wrongly emit 2.
    expect(range.end).toEqual({ line: 0, character: 4 });
    expect(range.end.character).not.toBe(2);
  });

  it("utf-32: incremental range end derives from OLD line (1, not naive 2)", async () => {
    const { conn, proc } = await makeConnection(
      { textDocumentSync: 2, general: { positionEncodings: ["utf-32"] } },
      root,
    );
    const filePath = join(root, "b.ts");

    await conn.prepareDocument(filePath, "😀hello");
    proc.stdin.write.mockClear();
    await conn.prepareDocument(filePath, "Xhello");

    const msgs = writtenMessages(proc);
    const change = msgs.find((m) => m.method === "textDocument/didChange");
    expect(change).toBeTruthy();
    const range = change!.params.contentChanges[0].range;
    expect(range.start).toEqual({ line: 0, character: 0 });
    // OLD line "😀hello": 😀 is 1 code point, so end-char 1. A converter fed
    // the NEW line "Xhello" would wrongly emit 2.
    expect(range.end).toEqual({ line: 0, character: 1 });
    expect(range.end.character).not.toBe(2);
  });
});

describe("document sync openClose/change dimensions", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "lsp-sync-oc-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("openClose true + change none: first touch still sends didOpen", async () => {
    const { conn, proc } = await makeConnection({ textDocumentSync: { openClose: true } }, root);
    const filePath = join(root, "c.ts");

    await conn.prepareDocument(filePath, "export const c = 1;");

    const msgs = writtenMessages(proc);
    expect(msgs.find((m) => m.method === "textDocument/didOpen")).toBeTruthy();
    expect(msgs.find((m) => m.method === "textDocument/didChange")).toBeFalsy();
  });

  it("openClose false: no didOpen/didChange wire at all", async () => {
    const { conn, proc } = await makeConnection({ textDocumentSync: 0 }, root);
    const filePath = join(root, "d.ts");

    await conn.prepareDocument(filePath, "export const d = 1;");
    await conn.prepareDocument(filePath, "export const d = 2;");

    const msgs = writtenMessages(proc);
    expect(msgs.find((m) => m.method === "textDocument/didOpen")).toBeFalsy();
    expect(msgs.find((m) => m.method === "textDocument/didChange")).toBeFalsy();
  });

  it("none-with-change still invalidates cached + broker diagnostics without wire", async () => {
    const { conn, proc } = await makeConnection({ textDocumentSync: { openClose: true } }, root);
    const filePath = join(root, "e.ts");

    await conn.prepareDocument(filePath, "export const e = 1;");
    const uri = pathToFileURL(filePath).href;
    sendToStdout(proc, {
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: { uri, diagnostics: [{ message: "stale", severity: 1 }] },
    });
    expect(conn.getDiagnostics(filePath)).toHaveLength(1);

    proc.stdin.write.mockClear();
    await conn.prepareDocument(filePath, "export const e = 2;");

    const msgs = writtenMessages(proc);
    expect(msgs.find((m) => m.method === "textDocument/didChange")).toBeFalsy();
    expect(conn.getDiagnostics(filePath)).toHaveLength(0);
    expect(conn.hasDiagnostics(filePath)).toBe(false);
  });
});
