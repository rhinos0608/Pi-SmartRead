/**
 * Strict transport classification for LSPConnection:
 * - method-first frame classification (id+method = server request, id-only =
 *   response, method-only = notification)
 * - server-request dispatch isolated from client pending ids, including
 *   injected client/server id collisions
 * - unknown server requests answered -32601
 * - ordered workspace/configuration null replies and workspace/workspaceFolders
 * - unsolicited workspace/applyEdit declined with zero disk writes
 * - AbortSignal cancel: cancelled settlement, $/cancelRequest, bounded tombstone
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
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
const { LSPConnection, CANCELLED_TOMBSTONE_LIMIT, APPLY_EDIT_PROPOSAL_LIMIT, APPLY_EDIT_PROPOSAL_BYTES, LspRequestCancelledError } = await import("../../../src/lsp/lsp-connection.js");

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

describe("method-first transport classification with colliding client/server ids", () => {
  let root: string;

  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "lsp-transport-")); });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("id+method is a server request: dispatched and replied, never settling the colliding client pending", async () => {
    const { conn, proc } = await makeConnection(root);

    const clientPending = conn.request("workspace/symbol", { query: "x" });
    const clientReq = writtenMessages(proc).find((m) => m.method === "workspace/symbol");
    const collideId = clientReq.id;
    expect(pendingMap(conn).size).toBe(1);

    // Server request carrying the SAME id as the in-flight client request.
    sendToStdout(proc, { jsonrpc: "2.0", id: collideId, method: "workspace/workspaceFolders", params: {} });

    const reply = writtenMessages(proc).find((f) => f.id === collideId && f.method === undefined && "result" in f);
    expect(reply).toBeTruthy();
    expect(reply.result).toEqual([{ uri: pathToFileURL(resolve(root)).href, name: basename(resolve(root)) }]);
    // Client pending must be untouched by the server-side id collision.
    expect(pendingMap(conn).size).toBe(1);

    // The genuine id-only response settles the client request.
    sendToStdout(proc, { jsonrpc: "2.0", id: collideId, result: ["ok"] });
    await expect(clientPending).resolves.toEqual(["ok"]);
    expect(pendingMap(conn).size).toBe(0);
  });

  it("id-only frame settles the matching pending request and nothing else", async () => {
    const { conn, proc } = await makeConnection(root);

    const first = conn.request("workspace/symbol", { query: "a" });
    const second = conn.request("workspace/symbol", { query: "b" });
    const reqs = writtenMessages(proc).filter((m) => m.method === "workspace/symbol");
    expect(reqs).toHaveLength(2);
    expect(pendingMap(conn).size).toBe(2);

    sendToStdout(proc, { jsonrpc: "2.0", id: reqs[1].id, result: ["second"] });
    await expect(second).resolves.toEqual(["second"]);
    expect(pendingMap(conn).size).toBe(1);

    sendToStdout(proc, { jsonrpc: "2.0", id: reqs[0].id, result: ["first"] });
    await expect(first).resolves.toEqual(["first"]);
    expect(pendingMap(conn).size).toBe(0);
  });

  it("method-only frame is a notification: handler fires, pending untouched", async () => {
    const { conn, proc } = await makeConnection(root);
    const seen: unknown[] = [];
    conn.onNotification("window/logMessage", (p) => seen.push(p));

    const pending = conn.request("workspace/symbol", { query: "x" });
    // Notification id-collides conceptually (no id at all) while a request is live.
    sendToStdout(proc, { jsonrpc: "2.0", method: "window/logMessage", params: { message: "hi" } });

    expect(seen).toEqual([{ message: "hi" }]);
    expect(pendingMap(conn).size).toBe(1);

    const id = writtenMessages(proc).find((m) => m.method === "workspace/symbol").id;
    sendToStdout(proc, { jsonrpc: "2.0", id, result: ["ok"] });
    await expect(pending).resolves.toEqual(["ok"]);
  });

  it("unknown server request replies -32601 without touching colliding client pending", async () => {
    const { conn, proc } = await makeConnection(root);

    const pending = conn.request("workspace/symbol", { query: "x" });
    const collideId = writtenMessages(proc).find((m) => m.method === "workspace/symbol").id;

    sendToStdout(proc, { jsonrpc: "2.0", id: collideId, method: "no/such/method", params: {} });

    const errFrame = writtenMessages(proc).find((f) => f.id === collideId && f.error !== undefined && f.method === undefined);
    expect(errFrame).toBeTruthy();
    expect(errFrame.error.code).toBe(-32601);
    expect(errFrame.error.message).toContain("no/such/method");
    expect(errFrame.result).toBeUndefined();
    expect(pendingMap(conn).size).toBe(1);

    sendToStdout(proc, { jsonrpc: "2.0", id: collideId, result: ["ok"] });
    await expect(pending).resolves.toEqual(["ok"]);
  });

  it("workspace/configuration replies one ordered null per requested item", async () => {
    const { conn, proc } = await makeConnection(root);

    sendToStdout(proc, {
      jsonrpc: "2.0",
      id: 91,
      method: "workspace/configuration",
      params: { items: [{ section: "a" }, { section: "b" }, { section: "c" }] },
    });

    const reply = writtenMessages(proc).find((f) => f.id === 91 && f.method === undefined && "result" in f);
    expect(reply.result).toEqual([null, null, null]);
    expect(reply.error).toBeUndefined();
    expect(pendingMap(conn).size).toBe(0);
  });

  it("workspace/configuration serves session fingerprint settings per item", async () => {
    const { conn, proc } = await makeConnection(root);
    conn.sessionSettings = { python: { analysis: { typeCheckingMode: "strict" } } };
    sendToStdout(proc, {
      jsonrpc: "2.0",
      id: 92,
      method: "workspace/configuration",
      params: { items: [{ section: "a" }, { section: "b" }] },
    });
    const reply = writtenMessages(proc).find((f) => f.id === 92 && f.method === undefined && "result" in f);
    expect(reply.result).toEqual([conn.sessionSettings, conn.sessionSettings]);
  });

  it("client/registerCapability feeds the registry; unregister stops issuance; unknown still -32601", async () => {
    const { conn, proc } = await makeConnection(root);
    expect(conn.getCapabilityRegistry()?.can("definition")).toBe(false);
    sendToStdout(proc, {
      jsonrpc: "2.0",
      id: 93,
      method: "client/registerCapability",
      params: { registrations: [{ id: "d1", method: "textDocument/definition" }] },
    });
    const regReply = writtenMessages(proc).find((f) => f.id === 93 && f.method === undefined && "result" in f);
    expect(regReply.result).toBeNull();
    expect(conn.getCapabilityRegistry()?.can("definition")).toBe(true);
    sendToStdout(proc, {
      jsonrpc: "2.0",
      id: 94,
      method: "client/unregisterCapability",
      params: { unregisterations: [{ id: "d1", method: "textDocument/definition" }] },
    });
    const unregReply = writtenMessages(proc).find((f) => f.id === 94 && f.method === undefined && "result" in f);
    expect(unregReply.result).toBeNull();
    expect(conn.getCapabilityRegistry()?.can("definition")).toBe(false);
    sendToStdout(proc, { jsonrpc: "2.0", id: 95, method: "no/such/method", params: {} });
    const errFrame = writtenMessages(proc).find((f) => f.id === 95 && f.error !== undefined);
    expect(errFrame.error.code).toBe(-32601);
  });

  it("start passes validated env overlay to spawn without logging values", async () => {
    const { proc } = await makeConnection(root);
    const conn2 = new LSPConnection();
    const startPromise = conn2.start("fake-lsp-server", ["--stdio"], root, { env: { LSP_TEST_OVERLAY: "overlay-value" } });
    await startPromise;
    const calls = (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const lastOpts = calls.at(-1)![2] as { env?: Record<string, string> };
    expect(lastOpts.env?.LSP_TEST_OVERLAY).toBe("overlay-value");
    expect(proc).toBeTruthy();
  });
});

describe("unsolicited workspace/applyEdit", () => {
  let root: string;

  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "lsp-applyedit-")); });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("replies applied:false, retains proposal in memory only, leaves fixture files byte-identical", async () => {
    const { conn, proc } = await makeConnection(root);

    const fileA = join(root, "a.ts");
    const fileB = join(root, "b.ts");
    writeFileSync(fileA, "export const a = 1;\n// keep me\n");
    writeFileSync(fileB, "export const b = 2;\n// keep me too\n");
    const beforeA = readFileSync(fileA);
    const beforeB = readFileSync(fileB);
    expect(conn.getRetainedApplyEditProposals()).toHaveLength(0);

    const params = {
      label: "server-initiated edit",
      edit: {
        changes: {
          [pathToFileURL(fileA).href]: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } }, newText: "DELETE" }],
          [pathToFileURL(fileB).href]: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } }, newText: "DELETE" }],
        },
      },
    };
    sendToStdout(proc, { jsonrpc: "2.0", id: 77, method: "workspace/applyEdit", params });

    const reply = writtenMessages(proc).find((f) => f.id === 77 && f.method === undefined);
    expect(reply.result).toEqual({ applied: false });
    expect(reply.error).toBeUndefined();

    // Proposal retained in memory only.
    const retained = conn.getRetainedApplyEditProposals();
    expect(retained).toHaveLength(1);
    expect(retained[0]).toEqual(params);

    // Zero disk writes: fixture files byte-identical after the declined edit.
    const afterA = readFileSync(fileA);
    const afterB = readFileSync(fileB);
    expect(afterA.equals(beforeA)).toBe(true);
    expect(afterB.equals(beforeB)).toBe(true);
    expect(pendingMap(conn).size).toBe(0);
  });

  it("bounds retained proposals FIFO at APPLY_EDIT_PROPOSAL_LIMIT (evicts oldest)", async () => {
    const { conn, proc } = await makeConnection(root);
    const extra = 10;
    const total = APPLY_EDIT_PROPOSAL_LIMIT + extra;
    for (let i = 0; i < total; i++) {
      sendToStdout(proc, { jsonrpc: "2.0", id: 1000 + i, method: "workspace/applyEdit", params: { edit: { seq: i } } });
    }
    const retained = conn.getRetainedApplyEditProposals();
    expect(retained).toHaveLength(APPLY_EDIT_PROPOSAL_LIMIT);
    // Oldest `extra` proposals evicted: first retained is seq=extra, newest is seq=total-1.
    expect(retained[0]).toEqual({ edit: { seq: extra } });
    expect(retained[retained.length - 1]).toEqual({ edit: { seq: total - 1 } });
  });

  it("byte cap evicts oldest proposals while count cap stays (total <= 1MB)", async () => {
    const { conn, proc } = await makeConnection(root);
    expect(APPLY_EDIT_PROPOSAL_BYTES).toBe(1024 * 1024);
    const big = "x".repeat(100 * 1024);
    for (let i = 0; i < 20; i++) {
      sendToStdout(proc, { jsonrpc: "2.0", id: 2000 + i, method: "workspace/applyEdit", params: { edit: { seq: i, blob: big } } });
    }
    const retained = conn.getRetainedApplyEditProposals() as any[];
    expect(conn.getRetainedApplyEditBytes()).toBeLessThanOrEqual(APPLY_EDIT_PROPOSAL_BYTES);
    expect(retained.length).toBeLessThan(20);
    expect(retained[retained.length - 1].edit.seq).toBe(19);
    expect(retained[0].edit.seq).toBeGreaterThan(0);
    expect(APPLY_EDIT_PROPOSAL_LIMIT).toBe(256);
  });
});

describe("AbortSignal cancel with bounded tombstone", () => {
  let root: string;

  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "lsp-cancel-")); });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("abort settles cancelled, sends $/cancelRequest, and the tombstone absorbs the late response", async () => {
    const { conn, proc } = await makeConnection(root);
    const ac = new AbortController();

    const pending = conn.request("workspace/symbol", { query: "x" }, { signal: ac.signal });
    const id = writtenMessages(proc).find((m) => m.method === "workspace/symbol").id;
    expect(pendingMap(conn).size).toBe(1);

    ac.abort();
    const err = await pending.then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(LspRequestCancelledError);
    expect((err as Error).name).toBe("AbortError");
    expect((err as Error).message).toContain("cancelled");
    expect(pendingMap(conn).size).toBe(0);

    const cancelFrame = writtenMessages(proc).find((m) => m.method === "$/cancelRequest");
    expect(cancelFrame).toBeTruthy();
    expect(cancelFrame.params).toEqual({ id });
    expect(tombstoneSet(conn).has(id)).toBe(true);

    // Late response to the cancelled id is absorbed — no settle, no throw.
    sendToStdout(proc, { jsonrpc: "2.0", id, result: ["late"] });
    expect(pendingMap(conn).size).toBe(0);
    expect(tombstoneSet(conn).has(id)).toBe(false);

    // Connection remains usable afterwards.
    const next = conn.request("workspace/symbol", { query: "next" });
    const nextId = writtenMessages(proc).find((m) => m.method === "workspace/symbol" && m.id !== id).id;
    sendToStdout(proc, { jsonrpc: "2.0", id: nextId, result: ["fresh"] });
    await expect(next).resolves.toEqual(["fresh"]);
  });

  it("pre-aborted signal rejects cancelled before anything is written to the wire", async () => {
    const { conn, proc } = await makeConnection(root);
    const ac = new AbortController();
    ac.abort();

    await expect(conn.request("workspace/symbol", { query: "x" }, { signal: ac.signal })).rejects.toBeInstanceOf(LspRequestCancelledError);
    expect(writtenMessages(proc).some((m) => m.method === "workspace/symbol")).toBe(false);
    expect(writtenMessages(proc).some((m) => m.method === "$/cancelRequest")).toBe(false);
    expect(pendingMap(conn).size).toBe(0);
  });

  it("cancelled-id tombstones stay bounded and evict oldest first", async () => {
    const { conn } = await makeConnection(root);

    for (let i = 0; i < CANCELLED_TOMBSTONE_LIMIT + 10; i++) {
      const ac = new AbortController();
      const p = conn.request("workspace/symbol", { query: `q${i}` }, { signal: ac.signal });
      p.catch(() => {});
      ac.abort();
      await p.catch(() => {});
    }

    const tombs = tombstoneSet(conn);
    expect(tombs.size).toBeLessThanOrEqual(CANCELLED_TOMBSTONE_LIMIT);
    // First cancelled id (2 — initialize consumed 1) was evicted; newest survives.
    expect(tombs.has(2)).toBe(false);
    expect(tombs.has(CANCELLED_TOMBSTONE_LIMIT + 11)).toBe(true);
    expect(pendingMap(conn).size).toBe(0);
  });

  it("closed connection request() rejects with LspServerExitError (never resolves null)", async () => {
    const { conn } = await makeConnection(root);
    conn.shutdown();
    const err = await conn.request("workspace/symbol", { query: "x" }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe("LspServerExitError");
    expect((err as Error).message).toContain("LSP server exited");
  });
});
