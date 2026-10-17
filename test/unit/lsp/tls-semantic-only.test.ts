import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface FakeProc extends EventEmitter {
  stdin: { write: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn>; once: ReturnType<typeof vi.fn>; removeListener: ReturnType<typeof vi.fn> };
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
    on: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
  };
  return proc;
}

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: vi.fn((command: string) => {
    if (command === "missing-srv") throw new Error("spawn missing-srv ENOENT");
    return makeFakeProc();
  }),
  execFileSync: vi.fn(() => Buffer.from("")),
}));

vi.mock("../../../src/language-intelligence/language-intelligence-runtime.js", () => ({
  ensureLanguageServerAvailable: vi.fn(),
}));

const { spawn } = await import("node:child_process");
const { ensureLanguageServerAvailable } = await import("../../../src/language-intelligence/language-intelligence-runtime.js");
const { shutdownAllManagers, resetLSPBridge } = await import("../../../src/lsp/lsp-bridge.js");
const { LSPManager, _clearSessionStore, sessionStore } = await import("../../../src/lsp/lsp-manager.js");
const { canonicalProjectRoot, computeConfigFingerprint } = await import("../../../src/lsp/lsp-session-key.js");
const { TlsSemanticOnlyConflictError } = await import("../../../src/language-intelligence/language-server-catalog.js");

function procs(): FakeProc[] {
  return (spawn as unknown as ReturnType<typeof vi.fn>).mock.results
    .filter((r) => r.type === "return" && r.value)
    .map((r) => r.value as FakeProc);
}

function allInitFrames(): any[] {
  return procs().flatMap((p) => writtenMessages(p).filter((m) => m.method === "initialize"));
}

describe("TLS semantic-only initialization policy", () => {
  let root: string;
  let extra: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "lsp-tls-sem-"));
    extra = join(root, "extra");
    mkdirSync(extra, { recursive: true });
    _clearSessionStore();
    vi.mocked(ensureLanguageServerAvailable).mockReset();
  });
  afterEach(async () => {
    rmSync(root, { recursive: true, force: true });
    vi.clearAllMocks();
    _clearSessionStore();
    await shutdownAllManagers();
    resetLSPBridge();
  });

  function tlsManager(): InstanceType<typeof LSPManager> {
    const mgr = new LSPManager(root);
    (mgr as any).availableConfigs = [
      { command: "typescript-language-server", args: ["--stdio"], languageIds: ["typescript"], descriptorId: "typescript" },
    ];
    return mgr;
  }

  it("known TLS profile sends tsserver.useSyntaxServer: never on the initialize wire frame", async () => {
    const mgr = tlsManager();
    const conn = await mgr.getServer("typescript", { descriptorId: "typescript", allowInstall: false } as any);
    expect(conn).toBeTruthy();
    const inits = allInitFrames();
    expect(inits).toHaveLength(1);
    expect(inits[0].params.initializationOptions).toEqual({ tsserver: { useSyntaxServer: "never" } });
  });

  it("unrelated nested initialization settings survive alongside the policy", async () => {
    const mgr = tlsManager();
    const conn = await mgr.getServer("typescript", {
      descriptorId: "typescript",
      initializationOptions: { tsserver: { logVerbosity: "off" }, other: { a: 1 } },
      allowInstall: false,
    } as any);
    expect(conn).toBeTruthy();
    const inits = allInitFrames();
    expect(inits).toHaveLength(1);
    expect(inits[0].params.initializationOptions).toEqual({
      tsserver: { logVerbosity: "off", useSyntaxServer: "never" },
      other: { a: 1 },
    });
  });

  it("workspace folders arrive on the wire for the TLS profile", async () => {
    const mgr = tlsManager();
    const conn = await mgr.getServer("typescript", {
      descriptorId: "typescript",
      workspaceFolders: [root, extra],
      allowInstall: false,
    } as any);
    expect(conn).toBeTruthy();
    const inits = allInitFrames();
    expect(inits).toHaveLength(1);
    const uris = (inits[0].params.workspaceFolders ?? []).map((f: any) => f.uri).sort();
    expect(uris).toEqual([pathToFileURL(root).href, pathToFileURL(extra).href].sort());
    expect(inits[0].params.initializationOptions).toEqual({ tsserver: { useSyntaxServer: "never" } });
  });

  it("explicit conflicting useSyntaxServer fails with a clear session-configuration error", async () => {
    const mgr = tlsManager();
    await expect(mgr.getServer("typescript", {
      descriptorId: "typescript",
      initializationOptions: { tsserver: { useSyntaxServer: "auto" } },
      allowInstall: false,
    } as any)).rejects.toThrow(/useSyntaxServer.*never|semantic-only/i);
    expect(allInitFrames()).toHaveLength(0);
  });

  it("non-TLS profiles are unchanged (no tsserver policy injected)", async () => {
    const mgr = new LSPManager(root);
    (mgr as any).availableConfigs = [
      { command: "fake-py", args: ["--stdio"], languageIds: ["python"], descriptorId: "fake-py" },
    ];
    const initOptions = { pyright: { disableOrganizeImports: true } };
    const conn = await mgr.getServer("python", {
      descriptorId: "fake-py",
      initializationOptions: initOptions,
      allowInstall: false,
    } as any);
    expect(conn).toBeTruthy();
    const inits = allInitFrames();
    expect(inits).toHaveLength(1);
    expect(inits[0].params.initializationOptions).toEqual(initOptions);
  });

  it("legacy descriptor-less TLS launch commands receive the policy; other commands do not", async () => {
    const mgr = new LSPManager(root);
    (mgr as any).availableConfigs = [
      { command: "typescript-language-server", args: ["--stdio"], languageIds: ["typescript"] },
      { command: "pyright", args: ["--stdio"], languageIds: ["python"] },
    ];
    const tsConn = await mgr.getServer("typescript", { allowInstall: false } as any);
    expect(tsConn).toBeTruthy();
    const pyConn = await mgr.getServer("python", { allowInstall: false } as any);
    expect(pyConn).toBeTruthy();
    const inits = allInitFrames();
    expect(inits).toHaveLength(2);
    const tsInit = inits.find((m) => (m.params.initializationOptions as any)?.tsserver?.useSyntaxServer === "never");
    expect(tsInit).toBeTruthy();
    const pyInit = inits.find((m) => m !== tsInit);
    expect(pyInit.params.initializationOptions).toBeUndefined();
  });

  it("effective policy participates in the session fingerprint", async () => {
    const mgr = tlsManager();
    const conn = await mgr.getServer("typescript", { descriptorId: "typescript", allowInstall: false } as any);
    expect(conn).toBeTruthy();
    const entries = [...sessionStore.values()].filter((e) => e.descriptorId === "typescript");
    expect(entries).toHaveLength(1);
    const withoutPolicy = computeConfigFingerprint({
      descriptorId: "typescript",
      executable: "typescript-language-server",
      args: ["--stdio"],
      initializationOptions: undefined,
      settings: undefined,
      workspaceFolders: [canonicalProjectRoot(root)],
      envOverlay: {},
      requiredEnvValues: {},
    });
    expect(entries[0]!.fingerprint).not.toBe(withoutPolicy);
    const withPolicy = computeConfigFingerprint({
      descriptorId: "typescript",
      executable: "typescript-language-server",
      args: ["--stdio"],
      initializationOptions: { tsserver: { useSyntaxServer: "never" } },
      settings: undefined,
      workspaceFolders: [canonicalProjectRoot(root)],
      envOverlay: {},
      requiredEnvValues: {},
    });
    expect(entries[0]!.fingerprint).toBe(withPolicy);
  });

  it("eager startAll path delivers the policy (no legacy partial-semantic fallback)", async () => {
    const mgr = tlsManager();
    await mgr.startAll();
    const inits = allInitFrames();
    expect(inits).toHaveLength(1);
    expect(inits[0].params.initializationOptions).toEqual({ tsserver: { useSyntaxServer: "never" } });
  });

  it("managed-install start path delivers the policy", async () => {
    vi.mocked(ensureLanguageServerAvailable).mockResolvedValue({
      status: "available",
      tier: "managed",
      executable: "/managed/typescript-language-server",
      args: ["--stdio"],
      descriptorId: "typescript",
    } as any);
    const mgr = new LSPManager(root);
    (mgr as any).availableConfigs = [
      { command: "missing-srv", args: [], languageIds: ["typescript"], descriptorId: "typescript" },
    ];
    const conn = await mgr.getServer("typescript", { descriptorId: "typescript" } as any);
    expect(conn).toBeTruthy();
    const inits = allInitFrames();
    expect(inits).toHaveLength(1);
    expect(inits[0].params.initializationOptions).toEqual({ tsserver: { useSyntaxServer: "never" } });
  });

  it("path-qualified TLS launch sends the policy on the initialize wire", async () => {
    const mgr = new LSPManager(root);
    (mgr as any).availableConfigs = [
      { command: "/opt/homebrew/bin/typescript-language-server", args: ["--stdio"], languageIds: ["typescript"] },
    ];
    const conn = await mgr.getServer("typescript");
    expect(conn).toBeTruthy();
    const inits = allInitFrames();
    expect(inits).toHaveLength(1);
    expect(inits[0].params.initializationOptions).toEqual({ tsserver: { useSyntaxServer: "never" } });
  });

  it("Windows-shim (.cmd) TLS launch sends the policy on the initialize wire", async () => {
    const mgr = new LSPManager(root);
    (mgr as any).availableConfigs = [
      { command: "typescript-language-server.cmd", args: ["--stdio"], languageIds: ["typescript"] },
    ];
    const conn = await mgr.getServer("typescript");
    expect(conn).toBeTruthy();
    const inits = allInitFrames();
    expect(inits).toHaveLength(1);
    expect(inits[0].params.initializationOptions).toEqual({ tsserver: { useSyntaxServer: "never" } });
  });

  it("vtsls-style override under the typescript language does NOT receive the policy", async () => {
    const mgr = new LSPManager(root);
    // Simulates a command override for the typescript language whose
    // descriptorId defaulted to "typescript" while the command is not a
    // known TLS launch.
    (mgr as any).availableConfigs = [
      { command: "vtsls", args: ["--stdio"], languageIds: ["typescript"], descriptorId: "typescript" },
    ];
    const conn = await mgr.getServer("typescript");
    expect(conn).toBeTruthy();
    const inits = allInitFrames();
    expect(inits).toHaveLength(1);
    expect(inits[0].params.initializationOptions).toBeUndefined();
  });

  it("managed-install path carries session initializationOptions under the policy", async () => {
    vi.mocked(ensureLanguageServerAvailable).mockResolvedValue({
      status: "available",
      tier: "managed",
      executable: "/managed/typescript-language-server",
      args: ["--stdio"],
      descriptorId: "typescript",
    } as any);
    const mgr = new LSPManager(root);
    (mgr as any).availableConfigs = [
      { command: "missing-srv", args: [], languageIds: ["typescript"] },
    ];
    const conn = await mgr.getServer("typescript", {
      initializationOptions: { tsserver: { logVerbosity: "off" }, other: { a: 1 } },
    });
    expect(conn).toBeTruthy();
    const inits = allInitFrames();
    expect(inits).toHaveLength(1);
    expect(inits[0].params.initializationOptions).toEqual({
      tsserver: { logVerbosity: "off", useSyntaxServer: "never" },
      other: { a: 1 },
    });
  });

  it("conflicting session option on managed-install surfaces TlsSemanticOnlyConflictError", async () => {
    vi.mocked(ensureLanguageServerAvailable).mockResolvedValue({
      status: "available",
      tier: "managed",
      executable: "/managed/typescript-language-server",
      args: ["--stdio"],
      descriptorId: "typescript",
    } as any);
    const mgr = new LSPManager(root);
    (mgr as any).availableConfigs = [
      { command: "missing-srv", args: [], languageIds: ["typescript"] },
    ];
    await expect(
      mgr.getServer("typescript", {
        initializationOptions: { tsserver: { useSyntaxServer: "auto" } },
      }),
    ).rejects.toThrow(TlsSemanticOnlyConflictError);
  });
});
