import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const toUri = (p: string): string => pathToFileURL(resolve(p)).href;
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
            queueMicrotask(() => sendToStdout(proc, { jsonrpc: "2.0", id: msg.id, result: { capabilities: { renameProvider: { prepareProvider: true } } } }));
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
// Adapter-delegation seam: mock the canonical executor with a controllable
// override (default = passthrough to the real implementation, so the
// conn-level tests above are unaffected — LSPConnection never uses it).
const execOverride = vi.hoisted(() => ({ impl: null as null | ((req: Record<string, unknown>) => Promise<unknown>) }));
vi.mock("../../../src/lsp/lsp-executor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/lsp/lsp-executor.js")>();
  return {
    ...actual,
    executeLspOperation: vi.fn((req: unknown, deps?: unknown) => {
      if (execOverride.impl) return execOverride.impl(req as Record<string, unknown>);
      return (actual.executeLspOperation as (r: unknown, d?: unknown) => Promise<unknown>)(req, deps);
    }),
  };
});
const { spawn } = await import("node:child_process");
const { LSPConnection, shutdownAllManagers, resetLSPBridge } = await import("../../../src/lsp/lsp-bridge.js");

async function makeConnection(root: string): Promise<{ conn: InstanceType<typeof LSPConnection>; proc: FakeProc }> {
  const conn = new LSPConnection();
  const startPromise = conn.start("fake-lsp-server", ["--stdio"], root);
  const proc = (spawn as unknown as ReturnType<typeof vi.fn>).mock.results.at(-1)!.value as FakeProc;
  await startPromise;
  proc.stdin.write.mockClear();
  return { conn, proc };
}

describe("LSPConnection rename", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "lsp-rename-")); });
  afterEach(async () => { rmSync(root, { recursive: true, force: true }); vi.clearAllMocks(); await shutdownAllManagers(); resetLSPBridge(); });

  it("rename converts documentChanges format", async () => {
    const { conn, proc } = await makeConnection(root);
    const filePath = join(root, "a.ts");
    const targetPath = join(root, "b.ts");
    const targetUri = toUri(targetPath);
    const fileUri = toUri(filePath);
    // Intercept rename request and respond with documentChanges
    const origWrite = proc.stdin.write as unknown as ReturnType<typeof vi.fn>;
    (proc.stdin.write as unknown as ReturnType<typeof vi.fn>) = vi.fn((data: string) => {
      (origWrite as unknown as (d: string) => boolean)(data);
      const m = String(data).match(/^Content-Length: (\d+)\r\n\r\n/);
      if (!m) return true;
      const len = parseInt(m[1]!, 10);
      const body = String(data).slice(m[0].length, m[0].length + len);
      try {
        const msg = JSON.parse(body);
        if (msg.method === "textDocument/rename") {
          expect(msg.params.textDocument.uri).toBe(fileUri);
          expect(msg.params.position).toEqual({ line: 1, character: 2 });
          expect(msg.params.newName).toBe("newFoo");
          queueMicrotask(() =>
            sendToStdout(proc, {
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                documentChanges: [
                  { textDocument: { uri: fileUri, version: 1 }, edits: [{ range: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } }, newText: "newFoo" }] },
                  { textDocument: { uri: targetUri, version: 1 }, edits: [{ range: { start: { line: 3, character: 0 }, end: { line: 3, character: 3 } }, newText: "newFoo" }] },
                ],
              },
            }),
          );
        }
      } catch {}
      return true;
    });
    const result = await conn.rename(filePath, 1, 2, "newFoo");
    expect(result).not.toBeNull();
    expect(result!.fileEdits).toHaveLength(2);
    expect(result!.fileEdits[0]!.edits[0]!.newText).toBe("newFoo");
  });

  it("rename converts changes format", async () => {
    const { conn, proc } = await makeConnection(root);
    const filePath = join(root, "a.ts");
    const fileUri = toUri(filePath);
    const origWrite = proc.stdin.write as unknown as ReturnType<typeof vi.fn>;
    (proc.stdin.write as unknown as ReturnType<typeof vi.fn>) = vi.fn((data: string) => {
      (origWrite as unknown as (d: string) => boolean)(data);
      const m = String(data).match(/^Content-Length: (\d+)\r\n\r\n/);
      if (!m) return true;
      const len = parseInt(m[1]!, 10);
      const body = String(data).slice(m[0].length, m[0].length + len);
      try {
        const msg = JSON.parse(body);
        if (msg.method === "textDocument/rename") {
          queueMicrotask(() =>
            sendToStdout(proc, {
              jsonrpc: "2.0",
              id: msg.id,
              result: { changes: { [fileUri]: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: "renamed" }] } },
            }),
          );
        }
      } catch {}
      return true;
    });
    const result = await conn.rename(filePath, 0, 0, "renamed");
    expect(result).not.toBeNull();
    expect(result!.fileEdits[0]!.edits[0]!.newText).toBe("renamed");
  });

  it("rename returns null when server returns null", async () => {
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
        if (msg.method === "textDocument/rename") queueMicrotask(() => sendToStdout(proc, { jsonrpc: "2.0", id: msg.id, result: null }));
      } catch {}
      return true;
    });
    const result = await conn.rename(join(root, "a.ts"), 0, 0, "x");
    expect(result).toBeNull();
  });

  it("prepareRename returns null when server returns null", async () => {
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
        if (msg.method === "textDocument/prepareRename") queueMicrotask(() => sendToStdout(proc, { jsonrpc: "2.0", id: msg.id, result: null }));
      } catch {}
      return true;
    });
    const r = await conn.prepareRename(join(root, "a.ts"), 0, 0);
    expect(r).toBeNull();
  });

  it("prepareRename returns range when server supports it", async () => {
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
        if (msg.method === "textDocument/prepareRename")
          queueMicrotask(() =>
            sendToStdout(proc, {
              jsonrpc: "2.0",
              id: msg.id,
              result: { range: { start: { line: 0, character: 1 }, end: { line: 0, character: 4 } }, placeholder: "foo" },
            }),
          );
      } catch {}
      return true;
    });
    const r = await conn.prepareRename(join(root, "a.ts"), 0, 1);
    expect(r).not.toBeNull();
    expect(r!.range).toEqual({ start: { line: 0, character: 1 }, end: { line: 0, character: 4 } });
    expect(r!.placeholder).toBe("foo");
  });

  it("prepareRename handles Range directly", async () => {
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
        if (msg.method === "textDocument/prepareRename")
          queueMicrotask(() => sendToStdout(proc, { jsonrpc: "2.0", id: msg.id, result: { start: { line: 2, character: 0 }, end: { line: 2, character: 5 } } }));
      } catch {}
      return true;
    });
    const r = await conn.prepareRename(join(root, "a.ts"), 2, 0);
    expect(r!.range).toEqual({ start: { line: 2, character: 0 }, end: { line: 2, character: 5 } });
  });

  it("prepareRename returns null on bare renameProvider without prepare support", async () => {
    const { conn, proc } = await makeConnection(root);
    (conn as any).serverCapabilities = { renameProvider: true };
    const before = (proc.stdin.write as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(await conn.prepareRename(join(root, "a.ts"), 0, 0)).toBeNull();
    expect((proc.stdin.write as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(before);
  });
});

describe("LSPBridge executor delegation (thin adapter)", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "lsp-bridge-adapter-")); });
  afterEach(async () => {
    execOverride.impl = null;
    rmSync(root, { recursive: true, force: true });
    vi.clearAllMocks();
    await shutdownAllManagers();
    resetLSPBridge();
  });

  function okEnvelope(op: string, result: unknown, extraMeta: Record<string, unknown> = {}) {
    return { status: "ok", operation: op, method: `test/${op}`, server: {}, result, meta: { truncated: false, ...extraMeta } };
  }
  function statusEnvelope(op: string, status: string) {
    return { status, operation: op, method: `test/${op}`, server: {}, result: null, meta: { truncated: false } };
  }

  it("unsupported envelope maps to legacy null/[] shapes, never throws", async () => {
    execOverride.impl = async (req) => statusEnvelope(String(req.operation), "unsupported");
    const { getLSPBridge } = await import("../../../src/lsp/lsp-bridge.js");
    const bridge = await getLSPBridge();
    const fp = join(root, "a.ts");
    expect(await bridge!.goToDefinition(fp, 0, 0, root)).toBeNull();
    expect(await bridge!.findReferences(fp, 0, 0, root)).toEqual([]);
    expect(await bridge!.hover(fp, 0, 0, root)).toBeNull();
    expect(await bridge!.getDocumentSymbols(fp, root)).toEqual([]);
    expect(await bridge!.rename(fp, 1, 1, "b", root)).toBeNull();
    expect(await bridge!.codeActions(fp, { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, {}, root)).toEqual([]);
    expect(await bridge!.incomingCalls({ name: "f", kind: 12, uri: `file://${fp}`, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }, root)).toEqual([]);
  });

  it("translates 1-based Outcome positions to 0-based StrictRequests", async () => {
    const seen: Record<string, unknown>[] = [];
    const loc = { uri: `file://${join(root, "a.ts")}`, range: { start: { line: 4, character: 9 }, end: { line: 4, character: 12 } } };
    execOverride.impl = async (req) => { seen.push(req); return okEnvelope(String(req.operation), [loc]); };
    const { getLSPBridge } = await import("../../../src/lsp/lsp-bridge.js");
    const bridge = await getLSPBridge();
    const fp = join(root, "a.ts");
    const r = await bridge!.goToDefinitionOutcome(fp, 5, 10, root);
    expect(r).toEqual({ status: "confirmed", location: loc });
    expect(seen[0]!.operation).toBe("goToDefinition");
    expect(seen[0]!.position).toEqual({ line: 4, character: 9 });
    expect(seen[0]).not.toHaveProperty("includeDeclaration");
  });

  it("ok location array maps to first element; empty maps to legacy empty shape", async () => {
    const locs = [
      { uri: `file://${join(root, "a.ts")}`, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } },
      { uri: `file://${join(root, "b.ts")}`, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 2 } } },
    ];
    execOverride.impl = async (req) => okEnvelope(String(req.operation), locs);
    const { getLSPBridge } = await import("../../../src/lsp/lsp-bridge.js");
    const bridge = await getLSPBridge();
    const fp = join(root, "a.ts");
    expect(await bridge!.goToDefinition(fp, 0, 0, root)).toEqual(locs[0]);
    execOverride.impl = async (req) => statusEnvelope(String(req.operation), "empty");
    expect(await bridge!.goToDefinition(fp, 0, 0, root)).toBeNull();
    expect(await bridge!.findReferences(fp, 0, 0, root)).toEqual([]);
  });

  it("rename converts executor NormalizedWorkspaceEdit URIs to legacy filePaths", async () => {
    const { pathToFileURL } = await import("node:url");
    const fp = join(root, "a.ts");
    const uri = pathToFileURL(resolve(fp)).href;
    const seen: Record<string, unknown>[] = [];
    execOverride.impl = async (req) => {
      seen.push(req);
      return okEnvelope(String(req.operation), { changes: [{ uri, edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "b" }] }] });
    };
    const { getLSPBridge } = await import("../../../src/lsp/lsp-bridge.js");
    const bridge = await getLSPBridge();
    const r = await bridge!.rename(fp, 1, 1, "b", root);
    // 1-based (1,1) → 0-based (0,0) at the seam
    expect(seen[0]!.position).toEqual({ line: 0, character: 0 });
    expect(seen[0]!.newName).toBe("b");
    expect(r).toEqual({ positionEncoding: "utf-16", fileEdits: [{ filePath: resolve(fp), edits: [{ filePath: resolve(fp), range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "b" }] }] });
  });

  it("rename returns null for non-file URIs (untitled:/https: never resolve-fabricated)", async () => {
    const { getLSPBridge } = await import("../../../src/lsp/lsp-bridge.js");
    const bridge = await getLSPBridge();
    const fp = join(root, "a.ts");
    const badUris = ["untitled:Untitled-1", "https://example.com/a.ts"];
    for (const uri of badUris) {
      execOverride.impl = async (req) =>
        okEnvelope(String(req.operation), { changes: [{ uri, edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "b" }] }] });
      expect(await bridge!.rename(fp, 1, 1, "b", root), uri).toBeNull();
    }
    // Null URI must fail closed (never resolve-fabricated).
    execOverride.impl = async (req) =>
      okEnvelope(String(req.operation), { changes: [{ uri: null as unknown as string, edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "b" }] }] });
    expect(await bridge!.rename(fp, 1, 1, "b", root), "null-uri").toBeNull();
  });

  it("rename returns null for malformed file URIs", async () => {
    const { getLSPBridge } = await import("../../../src/lsp/lsp-bridge.js");
    const bridge = await getLSPBridge();
    const fp = join(root, "a.ts");
    execOverride.impl = async (req) =>
      okEnvelope(String(req.operation), { changes: [{ uri: "file://%zz", edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "b" }] }] });
    expect(await bridge!.rename(fp, 1, 1, "b", root)).toBeNull();
  });

  it("diagnostics map freshness: fresh ok→confirmed, unknown→degraded, unavailable→unavailable", async () => {
    const diags = [{ message: "x", severity: 1 }];
    const cases: Array<[string, Record<string, unknown>, { status: string }]> = [
      ["fresh-ok", okEnvelope("diagnostics", diags, { freshness: { state: "fresh" } }), { status: "confirmed" }],
      ["fresh-empty", { ...okEnvelope("diagnostics", [], { freshness: { state: "fresh" } }), status: "empty" }, { status: "empty" }],
      ["stale", okEnvelope("diagnostics", diags, { freshness: { state: "unknown" } }), { status: "degraded" }],
      ["no-session", statusEnvelope("diagnostics", "unavailable"), { status: "unavailable" }],
      ["timeout", statusEnvelope("diagnostics", "timeout"), { status: "degraded" }],
    ];
    const { getLSPBridge } = await import("../../../src/lsp/lsp-bridge.js");
    const bridge = await getLSPBridge();
    const fp = join(root, "a.ts");
    for (const [name, env, expected] of cases) {
      execOverride.impl = async () => env;
      const r = await bridge!.getFreshDiagnosticsOutcome(fp, root, { timeoutMs: 500 });
      expect(r.status, name).toBe(expected.status);
    }
  });
});
