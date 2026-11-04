import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type KillBehavior = "exit" | "ignore-term" | "never";

interface ProcBehavior {
  /** Answer the `shutdown` request with `{ result: null }`. */
  respondShutdown: boolean;
  /** Emit `exit` when the `exit` notification is written. */
  exitOnExitNotify: boolean;
  killBehavior: KillBehavior;
}

interface FakeProc extends EventEmitter {
  stdin: { write: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  stdout: EventEmitter & { destroy: ReturnType<typeof vi.fn> };
  stderr: EventEmitter & { destroy: ReturnType<typeof vi.fn> };
  kill: ReturnType<typeof vi.fn>;
  unref: ReturnType<typeof vi.fn>;
  exitCode: number | null;
}

let nextBehavior: ProcBehavior = { respondShutdown: true, exitOnExitNotify: true, killBehavior: "exit" };
const liveProcs: FakeProc[] = [];

function encodeMessage(obj: unknown): string {
  const body = JSON.stringify(obj);
  return `Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n\r\n${body}`;
}

function emitExit(proc: FakeProc, code: number | null = 0): void {
  if (proc.exitCode !== null) return;
  proc.exitCode = code;
  proc.emit("exit", code, null);
}

function makeFakeProc(behavior: ProcBehavior): FakeProc {
  const proc = new EventEmitter() as FakeProc;
  proc.exitCode = null;
  proc.kill = vi.fn((signal?: string) => {
    if (proc.exitCode !== null) return false;
    if (behavior.killBehavior === "never") return true;
    if (behavior.killBehavior === "ignore-term" && signal === "SIGTERM") return true;
    queueMicrotask(() => emitExit(proc));
    return true;
  });
  proc.unref = vi.fn(() => undefined);
  const stdout = new EventEmitter() as FakeProc["stdout"];
  stdout.destroy = vi.fn(() => stdout);
  proc.stdout = stdout;
  const stderr = new EventEmitter() as FakeProc["stderr"];
  stderr.destroy = vi.fn(() => stderr);
  proc.stderr = stderr;
  proc.stdin = {
    write: vi.fn((data: string) => {
      const match = String(data).match(/^Content-Length: (\d+)\r\n\r\n/);
      if (!match) return true;
      const len = parseInt(match[1]!, 10);
      const content = String(data).slice(match[0].length, match[0].length + len);
      let msg: any;
      try { msg = JSON.parse(content); } catch { return true; }
      if (msg.method === "initialize" && msg.id !== undefined) {
        queueMicrotask(() => {
          proc.stdout.emit("data", Buffer.from(encodeMessage({ jsonrpc: "2.0", id: msg.id, result: { capabilities: {} } }), "utf-8"));
        });
      } else if (msg.method === "shutdown" && msg.id !== undefined) {
        if (behavior.respondShutdown) {
          queueMicrotask(() => {
            proc.stdout.emit("data", Buffer.from(encodeMessage({ jsonrpc: "2.0", id: msg.id, result: null }), "utf-8"));
          });
        }
      } else if (msg.method === "exit" && msg.id === undefined) {
        if (behavior.exitOnExitNotify) queueMicrotask(() => emitExit(proc));
      }
      return true;
    }),
    destroy: vi.fn(),
    end: vi.fn(),
  };
  liveProcs.push(proc);
  return proc;
}

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => makeFakeProc(nextBehavior)),
  execFileSync: vi.fn(() => Buffer.from("")),
}));

const { spawn } = await import("node:child_process");
const { LSPConnection } = await import("../../../src/lsp/lsp-connection.js");
const {
  LSP_SHUTDOWN_EXIT_GRACE_MS,
  LSP_SHUTDOWN_SETTLE_MS,
  LSP_SHUTDOWN_TERM_GRACE_MS,
} = await import("../../../src/lsp/lsp-connection.js");
const {
  LSPManager,
  LSP_MANAGER_SHUTDOWN_CAP_MS,
  LSP_SHUTDOWN_ALL_CAP_MS,
  _clearSessionStore,
  cachedManager,
  shutdownAllManagers,
} = await import("../../../src/lsp/lsp-manager.js");

function lastProc(): FakeProc {
  return (spawn as unknown as ReturnType<typeof vi.fn>).mock.results.at(-1)!.value as FakeProc;
}

function writtenMessages(proc: FakeProc): any[] {
  const messages: any[] = [];
  for (const call of proc.stdin.write.mock.calls) {
    const raw = String(call[0]);
    const match = raw.match(/^Content-Length: (\d+)\r\n\r\n/);
    if (!match) continue;
    const len = parseInt(match[1]!, 10);
    try { messages.push(JSON.parse(raw.slice(match[0].length, match[0].length + len))); } catch { /* ignore */ }
  }
  return messages;
}

async function startConn(root: string): Promise<InstanceType<typeof LSPConnection>> {
  const conn = new LSPConnection();
  await conn.start("fake-lsp-server", ["--stdio"], root);
  return conn;
}

describe("LSPConnection bounded shutdown escalation", () => {
  let root: string;
  beforeEach(() => {
    vi.useFakeTimers();
    root = mkdtempSync(join(tmpdir(), "lsp-shutdown-"));
    nextBehavior = { respondShutdown: true, exitOnExitNotify: true, killBehavior: "exit" };
  });
  afterEach(async () => {
    vi.clearAllMocks();
    vi.useRealTimers();
    liveProcs.length = 0;
    _clearSessionStore();
    await shutdownAllManagers();
  });

  it("a server that exits on `exit` resolves promptly with no signals sent", async () => {
    const conn = await startConn(root);
    const proc = lastProc();
    const p = conn.shutdown();
    expect(p).toBeInstanceOf(Promise);
    await p;
    expect(proc.kill).not.toHaveBeenCalled();
    expect(proc.unref).toHaveBeenCalled();
    expect(proc.stdin.destroy).toHaveBeenCalled();
    expect((proc.stdout.destroy as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    expect((proc.stderr.destroy as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    expect((conn as unknown as { closed: boolean }).closed).toBe(true);
  });

  it("a server that ignores SIGTERM gets SIGKILL after the grace and resolves", async () => {
    nextBehavior = { respondShutdown: true, exitOnExitNotify: false, killBehavior: "ignore-term" };
    const conn = await startConn(root);
    const proc = lastProc();
    const p = conn.shutdown();
    await vi.advanceTimersByTimeAsync(0);
    // Shutdown answered promptly: exit sent without waiting out the settle bound.
    expect(writtenMessages(proc).some((m) => m.method === "exit")).toBe(true);
    expect(proc.kill).not.toHaveBeenCalled();
    // Server still alive -> wait out the exit grace -> SIGTERM.
    await vi.advanceTimersByTimeAsync(LSP_SHUTDOWN_EXIT_GRACE_MS);
    expect(proc.kill).toHaveBeenCalledTimes(1);
    expect(proc.kill.mock.calls[0]![0]).toBe("SIGTERM");
    // SIGTERM ignored -> wait out the term grace -> SIGKILL
    await vi.advanceTimersByTimeAsync(LSP_SHUTDOWN_TERM_GRACE_MS);
    expect(proc.kill).toHaveBeenCalledTimes(2);
    expect(proc.kill.mock.calls[1]![0]).toBe("SIGKILL");
    await p;
    expect(proc.unref).toHaveBeenCalled();
    expect(proc.stdin.destroy).toHaveBeenCalled();
  });

  it("a server that never answers `shutdown` still proceeds through the settle bound", async () => {
    nextBehavior = { respondShutdown: false, exitOnExitNotify: true, killBehavior: "exit" };
    const conn = await startConn(root);
    const proc = lastProc();
    let settled = false;
    const p = conn.shutdown().then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    // Settle bound not yet reached: no exit notification sent.
    expect(writtenMessages(proc).some((m) => m.method === "exit")).toBe(false);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(LSP_SHUTDOWN_SETTLE_MS);
    await p;
    expect(settled).toBe(true);
    expect(writtenMessages(proc).some((m) => m.method === "exit")).toBe(true);
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it("concurrent shutdowns share one promise and send one shutdown request", async () => {
    const conn = await startConn(root);
    const proc = lastProc();
    const p1 = conn.shutdown();
    const p2 = conn.shutdown();
    expect(p1).toBe(p2);
    await p1;
    await p2;
    const shutdowns = writtenMessages(proc).filter((m) => m.method === "shutdown");
    expect(shutdowns).toHaveLength(1);
  });

  it("an already-exited process resolves immediately without signals", async () => {
    const conn = await startConn(root);
    const proc = lastProc();
    emitExit(proc);
    await vi.advanceTimersByTimeAsync(0);
    await conn.shutdown();
    expect(proc.kill).not.toHaveBeenCalled();
    expect(proc.unref).toHaveBeenCalled();
  });

  it("pending requests are still rejected on shutdown", async () => {
    nextBehavior = { respondShutdown: false, exitOnExitNotify: false, killBehavior: "never" };
    const conn = await startConn(root);
    const pending = conn.request("textDocument/hover", { textDocument: { uri: "file:///x.ts" }, position: { line: 0, character: 0 } });
    const assertion = expect(pending).rejects.toThrow();
    const p = conn.shutdown();
    await vi.advanceTimersByTimeAsync(
      LSP_SHUTDOWN_SETTLE_MS + LSP_SHUTDOWN_EXIT_GRACE_MS + LSP_SHUTDOWN_TERM_GRACE_MS,
    );
    await p;
    await assertion;
  });
});

describe("LSPManager bounded shutdown", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(async () => {
    vi.clearAllMocks();
    vi.useRealTimers();
    _clearSessionStore();
    await shutdownAllManagers();
  });

  it("manager shutdown awaits all connections concurrently", async () => {
    const root = mkdtempSync(join(tmpdir(), "lsp-mgr-shutdown-"));
    const mgr = new LSPManager(root);
    const order: string[] = [];
    const mk = (name: string, ms: number) => ({
      shutdown: vi.fn(() => new Promise<void>((resolve) => {
        setTimeout(() => { order.push(name); resolve(); }, ms);
      })),
    });
    (mgr as unknown as { connections: Map<string, unknown> }).connections.set("ts", mk("a", 1000));
    (mgr as unknown as { connections: Map<string, unknown> }).connections.set("py", mk("b", 1000));
    const p = mgr.shutdown();
    await vi.advanceTimersByTimeAsync(1000);
    await p;
    // Concurrent: both finished after ~1s, not ~2s sequentially.
    expect(order).toEqual(expect.arrayContaining(["a", "b"]));
    expect((mgr as unknown as { connections: Map<string, unknown> }).connections.size).toBe(0);
  });

  it("one stuck connection is capped and does not block the others", async () => {
    const root = mkdtempSync(join(tmpdir(), "lsp-mgr-stuck-"));
    const mgr = new LSPManager(root);
    const fast = { shutdown: vi.fn(() => Promise.resolve()) };
    const stuck = { shutdown: vi.fn(() => new Promise<void>(() => {})) };
    (mgr as unknown as { connections: Map<string, unknown> }).connections.set("ts", fast);
    (mgr as unknown as { connections: Map<string, unknown> }).connections.set("py", stuck);
    let settled = false;
    const p = mgr.shutdown().then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    // Both shutdowns invoked immediately: the stuck one never delays the fast one.
    expect(fast.shutdown).toHaveBeenCalled();
    expect(stuck.shutdown).toHaveBeenCalled();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(LSP_MANAGER_SHUTDOWN_CAP_MS);
    await p;
    expect(settled).toBe(true);
  });

  it("shutdownAllManagers awaits every manager and caps a stuck one", async () => {
    const rootA = mkdtempSync(join(tmpdir(), "lsp-all-a-"));
    const rootB = mkdtempSync(join(tmpdir(), "lsp-all-b-"));
    const mgrA = cachedManager(rootA);
    const mgrB = cachedManager(rootB);
    const fast = { shutdown: vi.fn(() => Promise.resolve()) };
    const stuck = { shutdown: vi.fn(() => new Promise<void>(() => {})) };
    (mgrA as unknown as { connections: Map<string, unknown> }).connections.set("ts", fast);
    (mgrB as unknown as { connections: Map<string, unknown> }).connections.set("ts", stuck);
    let settled = false;
    const p = shutdownAllManagers().then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(fast.shutdown).toHaveBeenCalled();
    expect(stuck.shutdown).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(LSP_SHUTDOWN_ALL_CAP_MS);
    await p;
    expect(settled).toBe(true);
  });
});
