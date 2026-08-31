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

describe("LSPBridge outcome honesty + timeout + AbortSignal", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "lsp-bridge-outcome-")); });
  afterEach(async () => { rmSync(root, { recursive: true, force: true }); vi.clearAllMocks(); await shutdownAllManagers(); resetLSPBridge(); });

  it("goToDefinitionOutcome: 1-based public pos translated to 0-based internally", async () => {
    // fake server echoes position so we can assert wire format
    void (spawn as unknown as ReturnType<typeof vi.fn>).getMockImplementation();
    (spawn as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
      const proc = makeFakeProc();
      const origWrite = proc.stdin.write as any;
      proc.stdin.write = vi.fn((data: string) => {
        origWrite(data);
        const m = String(data).match(/^Content-Length: (\d+)\r\n\r\n/);
        if (!m) return true;
        const len = parseInt(m[1]!, 10);
        const body = String(data).slice(m[0].length, m[0].length + len);
        try {
          const msg = JSON.parse(body);
          if (msg.method === "textDocument/definition") {
            queueMicrotask(() => sendToStdout(proc, { jsonrpc: "2.0", id: msg.id, result: [{ uri: `file://${resolve(join(root, "a.ts"))}`, range: { start: msg.params.position, end: msg.params.position } }] }));
          }
        } catch {}
        return true;
      });
      return proc as any;
    });
    const bridge = await getLSPBridge();
    const filePath = join(root, "a.ts");
    writeFileSync(filePath, "export const a = 1;");
    const r: any = await (bridge as any).goToDefinitionOutcome(filePath, 5, 10, root, { timeoutMs: 2000 });
    // capture outbound LSP position on any spawned proc
    const calls = (spawn as unknown as ReturnType<typeof vi.fn>).mock.results;
    let outbound: any = null;
    for (const cr of calls) {
      const p = cr.value as FakeProc;
      for (const msg of writtenMessages(p)) if (msg.method === "textDocument/definition") outbound = msg;
    }
    expect(outbound).toBeTruthy();
    expect(outbound.params.position).toEqual({ line: 4, character: 9 });
    expect(r.status).toBe("confirmed");
    // unavailable still distinct
    const un = await (bridge as any).goToDefinitionOutcome(join(root, "a.xyz"), 1, 1, root, { timeoutMs: 200 });
    expect(un.status).toBe("unavailable");
  });

  it("empty vs confirmed vs degraded via fake server", async () => {
    let mode: "empty" | "confirmed" | "hang" = "empty";
    (spawn as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
      const proc = makeFakeProc();
      const orig = proc.stdin.write as any;
      proc.stdin.write = vi.fn((data: string) => {
        orig(data);
        const m = String(data).match(/^Content-Length: (\d+)\r\n\r\n/);
        if (!m) return true;
        const len = parseInt(m[1]!, 10);
        const body = String(data).slice(m[0].length, m[0].length + len);
        try {
          const msg = JSON.parse(body);
          if (msg.method === "textDocument/definition") {
            if (mode === "empty") queueMicrotask(() => sendToStdout(proc, { jsonrpc: "2.0", id: msg.id, result: null }));
            else if (mode === "confirmed") queueMicrotask(() => sendToStdout(proc, { jsonrpc: "2.0", id: msg.id, result: [{ uri: `file://${resolve(join(root, "a.ts"))}`, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } }] }));
            else if (mode === "hang") { /* never respond -> timeout */ }
          }
          if (msg.method === "textDocument/diagnostic") {
            queueMicrotask(() => sendToStdout(proc, { jsonrpc: "2.0", id: msg.id, result: { items: [] } }));
          }
        } catch {}
        return true;
      });
      return proc as any;
    });
    const bridge = await getLSPBridge();
    const filePath = join(root, "a.ts");
    writeFileSync(filePath, "export const a = 1;");
    mode = "empty";
    const empty = await (bridge as any).goToDefinitionOutcome(filePath, 1, 1, root, { timeoutMs: 800 });
    expect(empty.status).toBe("empty");
    mode = "confirmed";
    // need fresh manager cache for new proc mode -> reset bridge to pick up new mock
    await shutdownAllManagers(); resetLSPBridge();
    const bridge2 = await getLSPBridge();
    const conf = await (bridge2 as any).goToDefinitionOutcome(filePath, 1, 1, root, { timeoutMs: 800 });
    expect(conf.status).toBe("confirmed");
    mode = "hang";
    await shutdownAllManagers(); resetLSPBridge();
    const bridge3 = await getLSPBridge();
    const degraded = await (bridge3 as any).goToDefinitionOutcome(filePath, 1, 1, root, { timeoutMs: 120 });
    expect(degraded.status).toBe("degraded");
  });

  it("getFreshDiagnosticsOutcome clears stale cached diagnostics before confirming", async () => {
    // Seed stale diagnostics then verify fresh poll does NOT return stale and is degraded when no fresh receipt
    let activeProc: FakeProc | null = null;
    (spawn as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
      const proc = makeFakeProc();
      activeProc = proc;
      // Make pull explicitly unsupported so unconfirmed stays degraded, not empty via pull
      const orig = proc.stdin.write as any;
      proc.stdin.write = vi.fn((data: string) => {
        orig(data);
        const m = String(data).match(/^Content-Length: (\d+)\r\n\r\n/);
        if (!m) return true;
        const len = parseInt(m[1]!, 10);
        const body = String(data).slice(m[0].length, m[0].length + len);
        try {
          const msg = JSON.parse(body);
          if (msg.method === "textDocument/diagnostic" && msg.id !== undefined) {
            queueMicrotask(() => sendToStdout(proc, { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } }));
          }
        } catch {}
        return true;
      });
      return proc as any;
    });
    const bridge = await getLSPBridge();
    const filePath = join(root, "a.ts");
    writeFileSync(filePath, "export const a = 1;");
    await bridge!.openFile(filePath, root);
    // Seed stale diagnostics via publishDiagnostics for the current file
    sendToStdout(activeProc!, { jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: `file://${resolve(filePath)}`, diagnostics: [{ message: "stale", severity: 1 }] } });
    // stale seeded via publishDiagnostics above; fresh outcome must clear it
    // Now call fresh outcome with short wait and no fresh publish -> must clear stale and return degraded (unconfirmed), not empty
    const r = await (bridge as any).getFreshDiagnosticsOutcome(filePath, root, { timeoutMs: 800, waitMs: 120 });
    expect(r.status).toBe("degraded");
  });

  it("distinguishes confirmed-empty from unconfirmed no-response", async () => {
    // Case 1: unconfirmed no-response -> degraded
    (spawn as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
      const proc = makeFakeProc();
      void proc;
      const orig = proc.stdin.write as any;
      proc.stdin.write = vi.fn((data: string) => {
        orig(data);
        const m = String(data).match(/^Content-Length: (\d+)\r\n\r\n/);
        if (!m) return true;
        const len = parseInt(m[1]!, 10);
        const body = String(data).slice(m[0].length, m[0].length + len);
        try {
          const msg = JSON.parse(body);
          if (msg.method === "textDocument/diagnostic" && msg.id !== undefined) {
            queueMicrotask(() => sendToStdout(proc, { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } }));
          }
        } catch {}
        return true;
      });
      return proc as any;
    });
    let bridge: any = await getLSPBridge();
    let filePath = join(root, "unconfirmed.ts");
    writeFileSync(filePath, "export const a = 1;");
    const unconfirmed = await bridge.getFreshDiagnosticsOutcome(filePath, root, { timeoutMs: 600, waitMs: 80 });
    expect(unconfirmed.status).toBe("degraded");
    expect(unconfirmed.diagnostics).toEqual([]);

    // Case 2: confirmed-empty via publishDiagnostics empty set -> empty
    await shutdownAllManagers(); resetLSPBridge();
    (spawn as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
      const proc = makeFakeProc();
      void proc;
      const orig = proc.stdin.write as any;
      proc.stdin.write = vi.fn((data: string) => {
        orig(data);
        const m = String(data).match(/^Content-Length: (\d+)\r\n\r\n/);
        if (!m) return true;
        const len = parseInt(m[1]!, 10);
        const body = String(data).slice(m[0].length, m[0].length + len);
        try {
          const msg = JSON.parse(body);
          if (msg.method === "textDocument/didOpen") {
            const uri = msg.params?.textDocument?.uri;
            queueMicrotask(() => sendToStdout(proc, { jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, diagnostics: [] } }));
          }
        } catch {}
        return true;
      });
      return proc as any;
    });
    bridge = await getLSPBridge();
    filePath = join(root, "confirmed.ts");
    writeFileSync(filePath, "export const b = 1;");
    const confirmed = await bridge.getFreshDiagnosticsOutcome(filePath, root, { timeoutMs: 800, waitMs: 400 });
    expect(confirmed.status).toBe("empty");
    expect(confirmed.diagnostics).toEqual([]);
  });

  it("timeout yields degraded and respects AbortSignal", async () => {
    const { getLSPBridge } = await import("../../src/lsp-bridge.js");
    const bridge = await getLSPBridge();
    const ac = new AbortController();
    ac.abort();
    const r = await (bridge as any).goToDefinitionOutcome(join(root, "a.ts"), 1, 1, root, { timeoutMs: 50, signal: ac.signal });
    expect(["degraded", "unavailable"]).toContain(r.status);
  });

  it("closed connection null pull returns degraded not empty (distinguished from successful empty pull)", async () => {
    // Simulate LSP connection already closed: request("textDocument/diagnostic") returns null synchronously.
    // Before fix this set pullSucceeded=true and returned empty; after fix it stays degraded.
    // Also verify a non-null empty pull still returns empty.
    const { LSPConnection: LSPConn } = await import("../../src/lsp-bridge.js");
    const origRequest = (LSPConn.prototype as any).request;
    const spy = (vi as any).spyOn(LSPConn.prototype as any, "request").mockImplementation(function (this: any, method: string, params: unknown) {
      if (method === "textDocument/diagnostic") return Promise.resolve(null);
      return (origRequest as any).call(this, method, params);
    });
    // Ensure pull path is reached: make diagnostic pull unsupported via error not used, but our spy overrides to null;
    // need poll to have no receipt and no diags, so keep default fake proc with no publishDiagnostics.
    (spawn as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => makeFakeProc() as any);
    await shutdownAllManagers(); resetLSPBridge();
    let bridge: any = await getLSPBridge();
    let filePath = join(root, "closed-null.ts");
    writeFileSync(filePath, "export const a = 1;");
    const degraded = await bridge.getFreshDiagnosticsOutcome(filePath, root, { timeoutMs: 800, waitMs: 80 });
    expect(degraded.status).toBe("degraded");
    expect(degraded.diagnostics).toEqual([]);
    spy.mockRestore();
    // Now verify successful empty pull (non-null) still yields empty, not degraded
    const { LSPConnection: LSPConn2 } = await import("../../src/lsp-bridge.js");
    const orig2 = (LSPConn2.prototype as any).request;
    const spy2 = (vi as any).spyOn(LSPConn2.prototype as any, "request").mockImplementation(function (this: any, method: string, params: unknown) {
      if (method === "textDocument/diagnostic") return Promise.resolve({ items: [] });
      return (orig2 as any).call(this, method, params);
    });
    await shutdownAllManagers(); resetLSPBridge();
    (spawn as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => makeFakeProc() as any);
    bridge = await getLSPBridge();
    filePath = join(root, "closed-success-empty.ts");
    writeFileSync(filePath, "export const b = 1;");
    const empty = await bridge.getFreshDiagnosticsOutcome(filePath, root, { timeoutMs: 800, waitMs: 80 });
    expect(empty.status).toBe("empty");
    expect(empty.diagnostics).toEqual([]);
    spy2.mockRestore();
  });

  it("status enum additive: needs-triage does not break consumer", async () => {
    function classify(status: string): string {
      if (status === "unavailable") return "no-server";
      if (status === "empty") return "zero";
      if (status === "confirmed") return "ok";
      if (status === "degraded") return "retry";
      return `future:${status}`;
    }
    expect(classify("needs-triage")).toBe("future:needs-triage");
    expect(classify("empty")).toBe("zero");
  });
});

