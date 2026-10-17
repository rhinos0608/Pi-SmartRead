import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
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
const { shutdownAllManagers, resetLSPBridge } = await import("../../../src/lsp/lsp-bridge.js");
const { LSPManager, _clearSessionStore } = await import("../../../src/lsp/lsp-manager.js");
const { canonicalProjectRoot } = await import("../../../src/lsp/lsp-session-key.js");

function lastProc(): FakeProc {
  return (spawn as unknown as ReturnType<typeof vi.fn>).mock.results.at(-1)!.value as FakeProc;
}

describe("session initialize delivery (manager startSession path)", () => {
  let root: string;
  let extra: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "lsp-init-opts-"));
    extra = join(root, "extra");
    mkdirSync(extra, { recursive: true });
    _clearSessionStore();
  });
  afterEach(async () => {
    rmSync(root, { recursive: true, force: true });
    vi.clearAllMocks();
    (spawn as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => makeFakeProc());
    _clearSessionStore();
    await shutdownAllManagers();
    resetLSPBridge();
  });

  it("carries configured initializationOptions and workspaceFolders into initialize", async () => {
    const mgr = new LSPManager(root);
    (mgr as any).availableConfigs = [
      { command: "fake-lsp", args: ["--stdio"], languageIds: ["python"], descriptorId: "fake-py" },
    ];
    const initOptions = { pyright: { disableOrganizeImports: true } };
    const conn = await mgr.getServer("python", {
      descriptorId: "fake-py",
      initializationOptions: initOptions,
      workspaceFolders: [root, extra],
      allowInstall: false,
    } as any);
    expect(conn).toBeTruthy();
    const init = writtenMessages(lastProc()).find((m) => m.method === "initialize");
    expect(init).toBeTruthy();
    expect(init.params.initializationOptions).toEqual(initOptions);
    const uris = (init.params.workspaceFolders ?? []).map((f: any) => f.uri).sort();
    // Explicit session folders travel verbatim (resolve only, no realpath —
    // same mapping the old wrapper used); defaults are canonicalized by the manager.
    expect(uris).toEqual([pathToFileURL(root).href, pathToFileURL(extra).href].sort());
  });

  it("defaults to a single workspace folder for the project root", async () => {
    const mgr = new LSPManager(root);
    (mgr as any).availableConfigs = [
      { command: "fake-lsp", args: ["--stdio"], languageIds: ["python"], descriptorId: "fake-py" },
    ];
    const conn = await mgr.getServer("python", { descriptorId: "fake-py", allowInstall: false } as any);
    expect(conn).toBeTruthy();
    const init = writtenMessages(lastProc()).find((m) => m.method === "initialize");
    expect(init).toBeTruthy();
    expect(init.params.workspaceFolders).toHaveLength(1);
    expect(init.params.workspaceFolders[0].uri).toBe(pathToFileURL(canonicalProjectRoot(root)).href);
  });

  it("still sends didChangeConfiguration for configured settings", async () => {
    const mgr = new LSPManager(root);
    (mgr as any).availableConfigs = [
      { command: "fake-lsp", args: ["--stdio"], languageIds: ["python"], descriptorId: "fake-py" },
    ];
    const settings = { python: { analysis: { typeCheckingMode: "strict" } } };
    const conn = await mgr.getServer("python", {
      descriptorId: "fake-py",
      settings,
      allowInstall: false,
    } as any);
    expect(conn).toBeTruthy();
    const didChange = writtenMessages(lastProc()).find((m) => m.method === "workspace/didChangeConfiguration");
    expect(didChange).toBeTruthy();
    expect(didChange.params.settings).toEqual(settings);
  });
});
