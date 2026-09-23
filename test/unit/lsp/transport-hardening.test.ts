/**
 * Transport hardening regressions for LSPConnection (lsp-connection.ts only):
 * - R1: CL-less garbage header is discarded past headerEnd (no buffer pin).
 * - R2: sendFrame throw (circular payload) rejects with pending cleanup.
 * - R3: tombstone-consumed late response clears re-registered pending.
 */
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
const { LSPConnection, LspRequestCancelledError } = await import("../../../src/lsp/lsp-connection.js");

async function makeConnection(root: string): Promise<{ conn: InstanceType<typeof LSPConnection>; proc: FakeProc }> {
  const conn = new LSPConnection();
  const startPromise = conn.start("fake-lsp-server", ["--stdio"], root);
  const proc = (spawn as unknown as ReturnType<typeof vi.fn>).mock.results.at(-1)!.value as FakeProc;
  await startPromise;
  proc.stdin.write.mockClear();
  return { conn, proc };
}

function pendingMap(conn: InstanceType<typeof LSPConnection>): Map<number, unknown> {
  return (conn as unknown as { pending: Map<number, unknown> }).pending;
}

function tombstoneSet(conn: InstanceType<typeof LSPConnection>): Set<number> {
  return (conn as unknown as { cancelledTombstones: Set<number> }).cancelledTombstones;
}

describe("transport hardening regressions", () => {
  let root: string;

  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "lsp-hardening-")); });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("R1: garbage header without Content-Length is skipped so a later valid frame still settles", async () => {
    const { conn, proc } = await makeConnection(root);
    const pending = conn.request("workspace/symbol", { query: "x" });
    const id = writtenMessages(proc).find((m) => m.method === "workspace/symbol").id;

    // CL-less garbage: must not pin the buffer.
    proc.stdout.emit("data", Buffer.from("X-Garbage: no-length-here\r\n\r\n", "utf-8"));
    sendToStdout(proc, { jsonrpc: "2.0", id, result: ["ok"] });

    await expect(pending).resolves.toEqual(["ok"]);
    expect(pendingMap(conn).size).toBe(0);
  });

  it("R2: sendFrame(circular) rejects without an orphan pending entry", async () => {
    const { conn } = await makeConnection(root);
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    await expect(conn.request("workspace/symbol", { circular })).rejects.toThrow(TypeError);
    expect(pendingMap(conn).size).toBe(0);
  });

  it("R3: cancel id -> reuse id -> late response clears the re-registered pending", async () => {
    const { conn, proc } = await makeConnection(root);
    const ac = new AbortController();

    const first = conn.request("workspace/symbol", { query: "x" }, { signal: ac.signal });
    const id = writtenMessages(proc).find((m) => m.method === "workspace/symbol").id;
    ac.abort();
    await expect(first).rejects.toBeInstanceOf(LspRequestCancelledError);
    expect(tombstoneSet(conn).has(id)).toBe(true);

    // Force id reuse for the next request (simulates a reused id while the tombstone is live).
    (conn as unknown as { reqId: number }).reqId = id;
    const reused = conn.request("workspace/symbol", { query: "reused" });
    const reusedErr = reused.then(() => null, (e: unknown) => e);
    expect(pendingMap(conn).size).toBe(1);

    // Late response for the old (cancelled) request: tombstone consumed AND
    // the re-registered pending cleared (rejected, never left to timeout).
    sendToStdout(proc, { jsonrpc: "2.0", id, result: ["late"] });
    const err = await reusedErr;
    expect(err).toBeInstanceOf(LspRequestCancelledError);
    expect(pendingMap(conn).size).toBe(0);
    expect(tombstoneSet(conn).has(id)).toBe(false);
  });
});
