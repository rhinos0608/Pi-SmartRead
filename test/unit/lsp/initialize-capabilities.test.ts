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
const { LSPConnection, shutdownAllManagers, resetLSPBridge, invalidateResolvedServerCacheForRoot } = await import("../../../src/lsp/lsp-bridge.js");

async function makeConnectionKeepLog(root: string): Promise<{ conn: InstanceType<typeof LSPConnection>; proc: FakeProc }> {
  const conn = new LSPConnection();
  const startPromise = conn.start("fake-lsp-server", ["--stdio"], root);
  const proc = (spawn as unknown as ReturnType<typeof vi.fn>).mock.results.at(-1)!.value as FakeProc;
  await startPromise;
  return { conn, proc };
}

describe("LSPConnection initialize capabilities honesty", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "lsp-init-caps-")); });
  afterEach(async () => {
    invalidateResolvedServerCacheForRoot(root);
    rmSync(root, { recursive: true, force: true });
    vi.clearAllMocks();
    await shutdownAllManagers();
    resetLSPBridge();
  });

  it("advertises dynamicRegistration on every handled textDocument feature", async () => {
    const { proc } = await makeConnectionKeepLog(root);
    const init = writtenMessages(proc).find((m) => m.method === "initialize");
    expect(init).toBeTruthy();
    const td = init.params.capabilities.textDocument;
    for (const feature of [
      "definition", "references", "documentSymbol", "implementation", "hover",
      "callHierarchy", "rename", "codeAction", "formatting", "declaration",
      "typeDefinition", "diagnostic",
    ]) {
      expect(td[feature]?.dynamicRegistration, feature).toBe(true);
    }
    expect(td.documentSymbol.hierarchicalDocumentSymbolSupport).toBe(true);
  });

  it("advertises window.workDoneProgress", async () => {
    const { proc } = await makeConnectionKeepLog(root);
    const init = writtenMessages(proc).find((m) => m.method === "initialize");
    expect(init.params.capabilities.window?.workDoneProgress).toBe(true);
  });

  it("advertises workspace folders + configuration", async () => {
    const { proc } = await makeConnectionKeepLog(root);
    const init = writtenMessages(proc).find((m) => m.method === "initialize");
    expect(init.params.capabilities.workspace?.workspaceFolders).toBe(true);
    expect(init.params.capabilities.workspace?.configuration).toBe(true);
    expect(init.params.capabilities.workspace?.symbol?.dynamicRegistration).toBe(true);
  });

  it("advertises positionEncodings", async () => {
    const { proc } = await makeConnectionKeepLog(root);
    const init = writtenMessages(proc).find((m) => m.method === "initialize");
    const enc = init.params.capabilities.general?.positionEncodings;
    expect(Array.isArray(enc)).toBe(true);
    expect(enc).toContain("utf-16");
  });

  it("advertises publishDiagnostics versionSupport", async () => {
    const { proc } = await makeConnectionKeepLog(root);
    const init = writtenMessages(proc).find((m) => m.method === "initialize");
    expect(init.params.capabilities.textDocument?.publishDiagnostics?.versionSupport).toBe(true);
  });
});

describe("LSPConnection workDoneProgress create → progress → readiness", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "lsp-workdone-")); });
  afterEach(async () => {
    invalidateResolvedServerCacheForRoot(root);
    rmSync(root, { recursive: true, force: true });
    vi.clearAllMocks();
    await shutdownAllManagers();
    resetLSPBridge();
  });

  it("server request create(token) → success reply → $/progress begin/report/end → readiness settling→confirmed", async () => {
    const { conn, proc } = await makeConnectionKeepLog(root);
    const token = "test-token-1";

    // Server sends window/workDoneProgress/create as id+method server request.
    sendToStdout(proc, { jsonrpc: "2.0", id: 9001, method: "window/workDoneProgress/create", params: { token } });
    // Let the microtask-driven reply flush.
    await new Promise((r) => setTimeout(r, 20));

    // Client must reply success (result null) on the server's id.
    const replies = writtenMessages(proc).filter((m) => m.id === 9001 && m.method === undefined);
    expect(replies).toHaveLength(1);
    expect(replies[0].result).toBeNull();
    expect(replies[0].error).toBeUndefined();

    // Token tracked: $/progress begin → settling with basis progress.
    sendToStdout(proc, { jsonrpc: "2.0", method: "$/progress", params: { token, value: { kind: "begin", title: "Indexing" } } });
    expect(conn.readiness(token)).toEqual({ state: "settling", basis: "progress" });

    sendToStdout(proc, { jsonrpc: "2.0", method: "$/progress", params: { token, value: { kind: "report", message: "half" } } });
    expect(conn.readiness(token)).toEqual({ state: "settling", basis: "progress" });

    sendToStdout(proc, { jsonrpc: "2.0", method: "$/progress", params: { token, value: { kind: "end", message: "done" } } });
    expect(conn.readiness(token)).toEqual({ state: "confirmed", basis: "progress" });
    expect(conn.getReadinessTracker().isWorkDoneToken(token)).toBe(true);
  });
});
