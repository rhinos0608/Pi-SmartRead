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

/** Controllable proc: holds initialize response until released; auto-replies to nothing else. */
function makeHoldingProc(opts?: { failInit?: boolean }): { proc: FakeProc; releaseInit: () => void } {
  const proc = new EventEmitter() as FakeProc;
  proc.stdout = new EventEmitter();
  proc.kill = vi.fn();
  let initMsg: any = null;
  const releaseInit = () => {
    if (initMsg) {
      const m = initMsg;
      initMsg = null;
      if (opts?.failInit) {
        queueMicrotask(() => sendToStdout(proc, { jsonrpc: "2.0", id: m.id, error: { code: -32603, message: "boom" } }));
      } else {
        queueMicrotask(() => sendToStdout(proc, { jsonrpc: "2.0", id: m.id, result: { capabilities: {} } }));
      }
    }
  };
  proc.stdin = {
    write: vi.fn((data: string) => {
      const match = String(data).match(/^Content-Length: (\d+)\r\n\r\n/);
      if (match) {
        const len = parseInt(match[1]!, 10);
        const content = String(data).slice(match[0].length, match[0].length + len);
        try {
          const msg = JSON.parse(content);
          if (msg.method === "initialize" && msg.id !== undefined) initMsg = msg;
        } catch { /* ignore */ }
      }
      return true;
    }),
  };
  return { proc, releaseInit };
}

let holding: { proc: FakeProc; releaseInit: () => void } | null = null;

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => {
    holding = makeHoldingProc((globalThis as any).__failInit ? { failInit: true } : undefined);
    return holding.proc;
  }),
  execFileSync: vi.fn(() => Buffer.from("")),
}));

const { spawn } = await import("node:child_process");
const { LSPConnection, shutdownAllManagers, resetLSPBridge, invalidateResolvedServerCacheForRoot } = await import("../../../src/lsp/lsp-bridge.js");

function lastProc(): FakeProc {
  return (spawn as unknown as ReturnType<typeof vi.fn>).mock.results.at(-1)!.value as FakeProc;
}

describe("LSPConnection handshake barrier (T12)", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "lsp-conn-hs-")); (globalThis as any).__failInit = false; });
  afterEach(async () => {
    invalidateResolvedServerCacheForRoot(root);
    rmSync(root, { recursive: true, force: true });
    vi.clearAllMocks();
    delete (globalThis as any).__failInit;
    await shutdownAllManagers();
    resetLSPBridge();
  });

  it("(1) queued hover sends no frame while initialize held", async () => {
    const conn = new LSPConnection();
    const startP = conn.start("fake", ["--stdio"], root);
    await vi.waitFor(() => {
      expect(writtenMessages(lastProc()).some((m) => m.method === "initialize")).toBe(true);
    });
    const hoverP = conn.request("textDocument/hover", { a: 1 });
    void hoverP.catch(() => {});
    await new Promise((r) => setTimeout(r, 200));
    const methods = writtenMessages(lastProc()).map((m) => m.method);
    expect(methods).toEqual(["initialize"]);
    expect((conn as unknown as { getLifecycleState: () => string }).getLifecycleState()).toBe("initializing");
    holding!.releaseInit();
    await startP;
    // Hover still queued until initialized; answer it now.
    await vi.waitFor(() => {
      expect(writtenMessages(lastProc()).some((m) => m.method === "textDocument/hover")).toBe(true);
    });
    const hover = writtenMessages(lastProc()).find((m) => m.method === "textDocument/hover");
    sendToStdout(lastProc(), { jsonrpc: "2.0", id: hover.id, result: null });
    await expect(hoverP).resolves.toBeNull();
  });

  it("(2) initialized precedes queued hover on wire", async () => {
    const conn = new LSPConnection();
    const startP = conn.start("fake", ["--stdio"], root);
    await vi.waitFor(() => {
      expect(writtenMessages(lastProc()).some((m) => m.method === "initialize")).toBe(true);
    });
    const hoverP = conn.request("textDocument/hover", { a: 1 });
    void hoverP.catch(() => {});
    holding!.releaseInit();
    await startP;
    await vi.waitFor(() => {
      expect(writtenMessages(lastProc()).some((m) => m.method === "textDocument/hover")).toBe(true);
    });
    const methods = writtenMessages(lastProc()).map((m) => m.method);
    expect(methods.indexOf("initialized")).toBeGreaterThanOrEqual(0);
    expect(methods.indexOf("initialized")).toBeLessThan(methods.indexOf("textDocument/hover"));
    const hover = writtenMessages(lastProc()).find((m) => m.method === "textDocument/hover");
    sendToStdout(lastProc(), { jsonrpc: "2.0", id: hover.id, result: null });
    await expect(hoverP).resolves.toBeNull();
  });

  it("(3) abort queued sends no hover frame and no $/cancelRequest", async () => {
    const conn = new LSPConnection();
    const startP = conn.start("fake", ["--stdio"], root);
    await vi.waitFor(() => {
      expect(writtenMessages(lastProc()).some((m) => m.method === "initialize")).toBe(true);
    });
    const ac = new AbortController();
    const hoverP = conn.request("textDocument/hover", { a: 1 }, { signal: ac.signal });
    const assertion = expect(hoverP).rejects.toThrow(/cancel/i);
    ac.abort();
    await assertion;
    holding!.releaseInit();
    await startP;
    await new Promise((r) => setTimeout(r, 200));
    const methods = writtenMessages(lastProc()).map((m) => m.method);
    expect(methods).not.toContain("textDocument/hover");
    expect(methods).not.toContain("$/cancelRequest");
  });

  it("(4) init failure rejects queued requests", async () => {
    (globalThis as any).__failInit = true;
    const conn = new LSPConnection();
    const startP = conn.start("fake", ["--stdio"], root);
    await vi.waitFor(() => {
      expect(writtenMessages(lastProc()).some((m) => m.method === "initialize")).toBe(true);
    });
    const hoverP = conn.request("textDocument/hover", { a: 1 });
    const assertion = expect(hoverP).rejects.toThrow();
    holding!.releaseInit();
    await expect(startP).rejects.toThrow();
    await assertion;
  });

  it("(5) server workspace/configuration during init answered immediately", async () => {
    const conn = new LSPConnection();
    const startP = conn.start("fake", ["--stdio"], root);
    await vi.waitFor(() => {
      expect(writtenMessages(lastProc()).some((m) => m.method === "initialize")).toBe(true);
    });
    // Server-originated request while init barrier held.
    sendToStdout(lastProc(), { jsonrpc: "2.0", id: 999, method: "workspace/configuration", params: { items: [] } });
    await vi.waitFor(() => {
      const responses = writtenMessages(lastProc()).filter((m) => m.id === 999);
      expect(responses.length).toBeGreaterThan(0);
    }, { timeout: 5000 });
    // Init still held: no initialized yet, connection still initializing.
    expect((conn as unknown as { getLifecycleState: () => string }).getLifecycleState()).toBe("initializing");
    holding!.releaseInit();
    await startP;
  });
});
