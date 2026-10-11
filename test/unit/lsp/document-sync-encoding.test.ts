import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type FakeStdin = Omit<Writable, "write"> & {
  write: ReturnType<typeof vi.fn>;
  holdNextWrite?: (complete: (error?: Error | null) => void) => void;
};

interface FakeProc extends EventEmitter {
  stdin: FakeStdin;
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

/** Parse every complete JSON-RPC message submitted to the real writable stdin fixture. */
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
function makeFakeProc(caps: Record<string, unknown>, opts?: { autoInit?: boolean }): FakeProc {
  const proc = new EventEmitter() as FakeProc;
  proc.stdout = new EventEmitter();
  proc.kill = vi.fn();
  const autoInit = opts?.autoInit ?? true;
  proc.stdin = new Writable({
    write(chunk, _encoding, callback) {
      const raw = String(chunk);
      const match = raw.match(/^Content-Length: (\d+)\r\n\r\n/);
      if (match) {
        const len = parseInt(match[1]!, 10);
        const content = raw.slice(match[0].length, match[0].length + len);
        try {
          const msg = JSON.parse(content);
          if (msg.method === "initialize" && msg.id !== undefined && autoInit) {
            queueMicrotask(() => sendToStdout(proc, { jsonrpc: "2.0", id: msg.id, result: { capabilities: caps } }));
          }
        } catch { /* ignore malformed test frames */ }
      }
      const held = proc.stdin.holdNextWrite;
      proc.stdin.holdNextWrite = undefined;
      if (held) held(callback);
      else callback();
    },
  }) as unknown as FakeStdin;
  vi.spyOn(proc.stdin, "write");
  return proc;
}

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
  execFileSync: vi.fn(() => Buffer.from("")),
}));

const { spawn } = await import("node:child_process");
const { LSPConnection, LspRequestTimeoutError, LspRequestCancelledError } = await import("../../../src/lsp/lsp-connection.js");

async function makeConnection(
  caps: Record<string, unknown>,
  root: string,
  opts?: { autoInit?: boolean },
): Promise<{ conn: InstanceType<typeof LSPConnection>; proc: FakeProc; startPromise: Promise<void> }> {
  (spawn as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => makeFakeProc(caps, opts));
  const conn = new LSPConnection();
  const startPromise = conn.start("fake-lsp-server", ["--stdio"], root);
  const proc = (spawn as unknown as ReturnType<typeof vi.fn>).mock.results.at(-1)!.value as FakeProc;
  if (opts?.autoInit !== false) {
    await startPromise;
    proc.stdin.write.mockClear();
  }
  return { conn, proc, startPromise };
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

  it("no-sync or openClose:false cannot produce valid receipt and throws", async () => {
    const { conn: conn1 } = await makeConnection({ textDocumentSync: { openClose: true, change: 0 } }, root);
    const filePath1 = join(root, "c.ts");
    await expect(conn1.prepareDocument(filePath1, "export const c = 1;")).rejects.toThrow(
      /does not support document synchronization/,
    );
    expect(conn1.getDocumentReceipt(filePath1)).toBeNull();

    const { conn: conn2 } = await makeConnection({ textDocumentSync: 0 }, root);
    const filePath2 = join(root, "d.ts");
    await expect(conn2.prepareDocument(filePath2, "export const d = 1;")).rejects.toThrow(
      /does not support document synchronization/,
    );
    expect(conn2.getDocumentReceipt(filePath2)).toBeNull();
  });

  it("unsent change does not advance hash and uncertain state is refused until close", async () => {
    const { conn, proc } = await makeConnection({ textDocumentSync: 1 }, root);
    const filePath = join(root, "unsent.ts");
    const r1 = await conn.prepareDocument(filePath, "v1");
    expect(r1.version).toBe(1);
    expect(r1.textHash).toBeTruthy();
    expect(conn.getDocumentReceipt(filePath)).toEqual(r1);

    proc.stdin.write.mockClear();

    // Simulate write failure during v2 sync
    proc.stdin.write.mockImplementationOnce((_data: string, ...rest: unknown[]) => {
      const cb = rest.find((r) => typeof r === "function") as ((err?: Error | null) => void) | undefined;
      if (cb) queueMicrotask(() => cb(new Error("write failed")));
      return true;
    });
    await expect(conn.prepareDocument(filePath, "v2")).rejects.toThrow("write failed");

    // After failure, receipt is cleared/uncertain
    expect(conn.getDocumentReceipt(filePath)).toBeNull();

    // Subsequent preparation is refused without established new lifecycle
    await expect(conn.prepareDocument(filePath, "v2")).rejects.toThrow(/uncertain/);

    // Establishing new lifecycle via didClose resets uncertain state and permits fresh didOpen
    await conn.didClose(filePath);
    proc.stdin.write.mockClear();
    const r2 = await conn.prepareDocument(filePath, "v2");
    expect(r2.version).toBe(1);
    expect(conn.getDocumentReceipt(filePath)).toEqual(r2);

    const msgs = writtenMessages(proc);
    const open = msgs.find((m) => m.method === "textDocument/didOpen");
    expect(open).toBeDefined();
    expect(open?.params.textDocument.text).toBe("v2");
  });

  it("callback deferred success: resolves when callback fires with valid receipt", async () => {
    const { conn, proc } = await makeConnection({ textDocumentSync: 1 }, root);
    const filePath = join(root, "defer.ts");

    proc.stdin.write.mockImplementationOnce((_data: string, ...rest: unknown[]) => {
      const cb = rest.find((r) => typeof r === "function") as ((err?: Error | null) => void) | undefined;
      setTimeout(() => cb?.(null), 30);
      return true;
    });

    const receipt = await conn.prepareDocument(filePath, "deferred content");
    expect(receipt).toBeDefined();
    expect(receipt.version).toBe(1);
    expect(conn.getDocumentReceipt(filePath)).toEqual(receipt);
  });

  it("callback failure: rejects and invalidates document receipt", async () => {
    const { conn, proc } = await makeConnection({ textDocumentSync: 1 }, root);
    const filePath = join(root, "cb-fail.ts");

    proc.stdin.write.mockImplementationOnce((_data: string, ...rest: unknown[]) => {
      const cb = rest.find((r) => typeof r === "function") as ((err?: Error | null) => void) | undefined;
      queueMicrotask(() => cb?.(new Error("EPIPE: broken pipe")));
      return true;
    });

    await expect(conn.prepareDocument(filePath, "content")).rejects.toThrow("EPIPE: broken pipe");
    expect(conn.getDocumentReceipt(filePath)).toBeNull();
  });

  it("backpressure: write returning false with delayed callback succeeds", async () => {
    const { conn, proc } = await makeConnection({ textDocumentSync: 1 }, root);
    const filePath = join(root, "backpressure.ts");

    proc.stdin.write.mockImplementationOnce((_data: string, ...rest: unknown[]) => {
      const cb = rest.find((r) => typeof r === "function") as ((err?: Error | null) => void) | undefined;
      // return false to simulate backpressure buffer full, but flush later
      setTimeout(() => cb?.(null), 25);
      return false;
    });

    const receipt = await conn.prepareDocument(filePath, "bp content");
    expect(receipt.version).toBe(1);
    expect(conn.getDocumentReceipt(filePath)).toEqual(receipt);
  });

  it("closed / missing transport rejects and cannot mark prepared", async () => {
    const { conn } = await makeConnection({ textDocumentSync: 1 }, root);
    const filePath = join(root, "closed.ts");
    await conn.shutdown();

    await expect(conn.prepareDocument(filePath, "content")).rejects.toThrow();
    expect(conn.getDocumentReceipt(filePath)).toBeNull();
  });

  it("ABA / close / config invalidation clears receipt", async () => {
    const { conn } = await makeConnection({ textDocumentSync: 1 }, root);
    const filePath = join(root, "aba.ts");
    const r1 = await conn.prepareDocument(filePath, "initial");
    expect(conn.getDocumentReceipt(filePath)).toEqual(r1);

    await conn.didClose(filePath);
    expect(conn.getDocumentReceipt(filePath)).toBeNull();
  });

  it("RED: absent callback remains pending until bounded timeout, not falsely resolved via microtask", async () => {
    const { conn, proc } = await makeConnection({ textDocumentSync: 1 }, root);
    const filePath = join(root, "absent-cb.ts");

    let lateCb: ((err?: Error | null) => void) | undefined;
    // proc.stdin has NO _deferCallback or _writableState.
    // It captures cb but does NOT call it.
    proc.stdin.write.mockImplementationOnce((_data: string, ...rest: unknown[]) => {
      lateCb = rest.find((r) => typeof r === "function") as ((err?: Error | null) => void) | undefined;
      return true;
    });

    const deadlineMs = Date.now() + 40;
    // With the old microtask fallback, this falsely resolves on queueMicrotask!
    // The correct contract requires it to reject on deadline!
    await expect(conn.prepareDocument(filePath, "content", { deadlineMs })).rejects.toThrow();
    expect(conn.getDocumentReceipt(filePath)).toBeNull();

    // Late callback cannot publish a receipt
    lateCb?.(null);
    expect(conn.getDocumentReceipt(filePath)).toBeNull();
  });

  it("cancellation during queue aborts before sending frame", async () => {
    const { conn, proc } = await makeConnection({ textDocumentSync: 1 }, root);
    const filePath = join(root, "cancel-queue.ts");

    // Block the queue with a slow operation
    let unblockFirst!: () => void;
    proc.stdin.write.mockImplementationOnce((_d: string, ...rest: unknown[]) => {
      const cb = rest.find((r) => typeof r === "function") as ((err?: Error | null) => void) | undefined;
      unblockFirst = () => {
        cb?.(null);
      };
      return true;
    });

    const slowPrep = conn.prepareDocument(filePath, "v1");
    const ac = new AbortController();
    const queuedPromise = conn.prepareDocument(filePath, "v2", { signal: ac.signal });

    // Allow slowPrep to enter write and assign unblockFirst
    await new Promise((r) => setTimeout(r, 10));

    // Abort queued task while it waits behind slowPrep
    ac.abort();
    unblockFirst();
    await slowPrep;

    await expect(queuedPromise).rejects.toThrow(/cancelled/);

    // v2 must not have been sent
    const msgs = writtenMessages(proc);
    const v2msg = msgs.find((m) => m.params?.textDocument?.text === "v2" || m.params?.contentChanges?.[0]?.text === "v2");
    expect(v2msg).toBeUndefined();
  });

  it("RED: cancellation while queue slot is STILL occupied settles boundedly", async () => {
    const { conn, proc } = await makeConnection({ textDocumentSync: 1 }, root);
    const filePath = join(root, "cancel-occupied-queue.ts");

    let unblockFirst!: () => void;
    proc.stdin.write.mockImplementationOnce((_d: string, ...rest: unknown[]) => {
      const cb = rest.find((r) => typeof r === "function") as ((err?: Error | null) => void) | undefined;
      unblockFirst = () => cb?.(null);
      return true;
    });

    const slowPrep = conn.prepareDocument(filePath, "v1");
    const ac = new AbortController();
    const queuedPromise = conn.prepareDocument(filePath, "v2", { signal: ac.signal });

    await new Promise((r) => setTimeout(r, 10));

    // Abort queued task WHILE slowPrep is STILL in flight (unblockFirst NOT called yet!)
    ac.abort();

    // The queued promise must settle (reject) boundedly WITHOUT releasing slot first!
    const watchdog = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("watchdog: queued promise did not settle while slot occupied")), 80),
    );
    try {
      await expect(Promise.race([queuedPromise, watchdog])).rejects.toThrow(LspRequestCancelledError);
    } finally {
      unblockFirst();
      await slowPrep;
    }

    const msgs = writtenMessages(proc);
    const v2msg = msgs.find((m) => m.params?.textDocument?.text === "v2" || m.params?.contentChanges?.[0]?.text === "v2");
    expect(v2msg).toBeUndefined();
    expect(conn.getDocumentReceipt(filePath)?.version).toBe(1);
  });

  it("RED: deadline expiry while queue slot is STILL occupied settles boundedly", async () => {
    const { conn, proc } = await makeConnection({ textDocumentSync: 1 }, root);
    const filePath = join(root, "deadline-occupied-queue.ts");

    let unblockFirst!: () => void;
    proc.stdin.write.mockImplementationOnce((_d: string, ...rest: unknown[]) => {
      const cb = rest.find((r) => typeof r === "function") as ((err?: Error | null) => void) | undefined;
      unblockFirst = () => cb?.(null);
      return true;
    });

    const slowPrep = conn.prepareDocument(filePath, "v1");
    const deadlineMs = Date.now() + 30;
    const queuedPromise = conn.prepareDocument(filePath, "v2", { deadlineMs });

    await new Promise((r) => setTimeout(r, 10));

    // The queued promise must settle on deadline WHILE slowPrep is STILL in flight!
    const watchdog = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("watchdog: queued promise did not settle on deadline while slot occupied")), 100),
    );
    try {
      await expect(Promise.race([queuedPromise, watchdog])).rejects.toThrow(LspRequestTimeoutError);
    } finally {
      unblockFirst();
      await slowPrep;
    }

    const msgs = writtenMessages(proc);
    const v2msg = msgs.find((m) => m.params?.textDocument?.text === "v2" || m.params?.contentChanges?.[0]?.text === "v2");
    expect(v2msg).toBeUndefined();
    expect(conn.getDocumentReceipt(filePath)?.version).toBe(1);
  });

  it("RED: init barrier deadline expiry while init promise remains unfulfilled settles boundedly", async () => {
    const { conn, startPromise } = await makeConnection({ textDocumentSync: 1 }, root, { autoInit: false });
    const filePath = join(root, "init-barrier-deadline.ts");

    const deadlineMs = Date.now() + 30;
    const prepPromise = conn.prepareDocument(filePath, "init-content", { deadlineMs });

    const watchdog = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("watchdog: init barrier did not timeout on deadline")), 100),
    );

    try {
      await expect(Promise.race([prepPromise, watchdog])).rejects.toThrow(LspRequestTimeoutError);
    } finally {
      conn.shutdown();
      await startPromise.catch(() => {});
    }
  });

  it("RED: getter-null yet unchanged-content prepare must refuse and NOT return plan.receipt fallback", async () => {
    const { conn } = await makeConnection({ textDocumentSync: 1 }, root);
    const filePath = join(root, "fallback-refusal.ts");

    // 1. Initial preparation produces valid receipt with negotiatedEncoding = "utf-16"
    const r1 = await conn.prepareDocument(filePath, "unchanged");
    expect(r1).toBeDefined();
    expect(r1.positionEncoding).toBe("utf-16");
    expect(conn.getDocumentReceipt(filePath)).toEqual(r1);

    // 2. Negotiated encoding drifts on connection so live getter rejects (returns null)
    (conn as any).negotiatedEncoding = "utf-8";
    expect(conn.getDocumentReceipt(filePath)).toBeNull();

    // 3. Calling prepareDocument with unchanged content reaches lines 607-612.
    // In current code: getDocumentReceipt is null, but line 611 returns plan.receipt fallback anyway!
    // The correct contract requires: live getter is sole proof; invalid receipt must be refused!
    await expect(conn.prepareDocument(filePath, "unchanged")).rejects.toThrow();
  });

  it("deadline during write rejects and marks document uncertain without publishing receipt", async () => {
    const { conn, proc } = await makeConnection({ textDocumentSync: 1 }, root);
    const filePath = join(root, "deadline-write.ts");

    let lateCb: ((err?: Error | null) => void) | undefined;
    proc.stdin.write.mockImplementationOnce((_data: string, ...rest: unknown[]) => {
      lateCb = rest.find((r) => typeof r === "function") as ((err?: Error | null) => void) | undefined;
      // Do not call callback immediately - let deadline fire
      return true;
    });

    const deadlineMs = Date.now() + 30;
    await expect(conn.prepareDocument(filePath, "v1", { deadlineMs })).rejects.toThrow(LspRequestTimeoutError);

    expect(conn.getDocumentReceipt(filePath)).toBeNull();

    // Late callback invocation cannot publish a receipt
    lateCb?.(null);
    expect(conn.getDocumentReceipt(filePath)).toBeNull();
  });

  it("RED: abort/deadline occurring at write-completion boundary prevents publication", async () => {
    const { conn, proc } = await makeConnection({ textDocumentSync: 1 }, root);
    const filePath = join(root, "abort-at-boundary.ts");

    const ac = new AbortController();
    proc.stdin.write.mockImplementationOnce((_data: string, ...rest: unknown[]) => {
      const cb = rest.find((r) => typeof r === "function") as ((err?: Error | null) => void) | undefined;
      // Simultaneously abort caller as the write callback finishes
      ac.abort();
      cb?.(null);
      return true;
    });

    // In old code, sendFrameWithCallback resolves, and without post-await check,
    // prepareDocument proceeds to commit and return receipt!
    // With proper boundary check, caller abort must precede publication!
    await expect(conn.prepareDocument(filePath, "boundary", { signal: ac.signal })).rejects.toThrow();
    expect(conn.getDocumentReceipt(filePath)).toBeNull();
  });

  it("RED: exact-boundary Date.now >= deadlineMs prevents publication after write callback settles", async () => {
    const { conn, proc } = await makeConnection({ textDocumentSync: 1 }, root);
    const filePath = join(root, "deadline-boundary.ts");

    let deadlineMs = 0;
    proc.stdin.write.mockImplementationOnce((_data: string, ...rest: unknown[]) => {
      const cb = rest.find((r) => typeof r === "function") as ((err?: Error | null) => void) | undefined;
      setTimeout(() => {
        cb?.(null);
      }, 35);
      return true;
    });

    deadlineMs = Date.now() + 20;
    await expect(conn.prepareDocument(filePath, "content", { deadlineMs })).rejects.toThrow(LspRequestTimeoutError);
    expect(conn.getDocumentReceipt(filePath)).toBeNull();
  });

  it("RED: signal aborted during microtask turn after write resolves prevents publication", async () => {
    const { conn, proc } = await makeConnection({ textDocumentSync: 1 }, root);
    const filePath = join(root, "microtask-abort.ts");

    const ac = new AbortController();
    proc.stdin.write.mockImplementationOnce((_data: string, ...rest: unknown[]) => {
      const cb = rest.find((r) => typeof r === "function") as ((err?: Error | null) => void) | undefined;
      cb?.(null);
      // Abort in microtask before commit
      queueMicrotask(() => {
        ac.abort();
      });
      return true;
    });

    await expect(conn.prepareDocument(filePath, "content", { signal: ac.signal })).rejects.toThrow(LspRequestCancelledError);
    expect(conn.getDocumentReceipt(filePath)).toBeNull();
  });

  it("cancellation followed by late callback and subsequent prep has NO wire recovery and no receipt", async () => {
    const { conn, proc } = await makeConnection({ textDocumentSync: 1 }, root);
    const filePath = join(root, "no-recovery.ts");

    await conn.prepareDocument(filePath, "v1");
    proc.stdin.write.mockClear();

    // Cancel in-flight v2 write
    let lateCb: ((err?: Error | null) => void) | undefined;
    let writeCalled = false;
    proc.stdin.write.mockImplementationOnce((_data: string, ...rest: unknown[]) => {
      writeCalled = true;
      lateCb = rest.find((r) => typeof r === "function") as ((err?: Error | null) => void) | undefined;
      return true;
    });

    const ac = new AbortController();
    const p2 = conn.prepareDocument(filePath, "v2", { signal: ac.signal });

    // Allow p2 to enter sendFrameWithCallback and call stdin.write
    await new Promise((r) => setTimeout(r, 10));
    expect(writeCalled).toBe(true);

    ac.abort();
    await expect(p2).rejects.toThrow(LspRequestCancelledError);

    // Late callback arrives
    lateCb?.(null);
    expect(conn.getDocumentReceipt(filePath)).toBeNull();

    // Subsequent preparation on the uncertain document MUST be refused without wire recovery!
    proc.stdin.write.mockClear();
    await expect(conn.prepareDocument(filePath, "v3")).rejects.toThrow(/uncertain/);
    expect(conn.getDocumentReceipt(filePath)).toBeNull();
    const msgs = writtenMessages(proc);
    expect(msgs.length).toBe(0);
  });

  it("real writable rejects commitment when destroyed during deferred _write", async () => {
    const { conn, proc } = await makeConnection({ textDocumentSync: 1 }, root);
    const filePath = join(root, "real-writable-destroy.ts");
    let release: ((error?: Error | null) => void) | undefined;
    let entered!: () => void;
    const enteredWrite = new Promise<void>((resolve) => { entered = resolve; });
    proc.stdin.holdNextWrite = (complete) => { release = complete; entered(); };

    const prep = conn.prepareDocument(filePath, "content");
    try {
      await enteredWrite;
      proc.stdin.destroy();
      release?.(null);
      release = undefined;
      await expect(prep).rejects.toThrow();
      expect(conn.getDocumentReceipt(filePath)).toBeNull();
    } finally {
      proc.stdin.destroy();
      if (release) release(null);
      await prep.catch(() => {});
    }
  });

  it("replacement stdin during deferred write prevents committing its receipt", async () => {
    const { conn, proc } = await makeConnection({ textDocumentSync: 1 }, root);
    const filePath = join(root, "replaced-stdin.ts");
    let release: ((error?: Error | null) => void) | undefined;
    let entered!: () => void;
    const enteredWrite = new Promise<void>((resolve) => { entered = resolve; });
    proc.stdin.holdNextWrite = (complete) => { release = complete; entered(); };
    const prep = conn.prepareDocument(filePath, "content");
    try {
      await enteredWrite;
      const replacementProc = makeFakeProc({ textDocumentSync: 1 });
      proc.stdin = replacementProc.stdin;
      release?.(null);
      release = undefined;
      await expect(prep).rejects.toThrow();
      expect(conn.getDocumentReceipt(filePath)).toBeNull();
    } finally {
      if (release) release(null);
      proc.stdin.destroy();
      await prep.catch(() => {});
    }
  });

  it("refuses repeated start on a connection instance", async () => {
    const { conn } = await makeConnection({ textDocumentSync: 1 }, root);
    await expect(conn.start("another-server", [], root)).rejects.toThrow(/started once/);
  });

  it("cancelled middle caller cannot let third caller overtake a held first write", async () => {
    const { conn, proc } = await makeConnection({ textDocumentSync: 1 }, root);
    const filePath = join(root, "three-callers.ts");
    let release: ((error?: Error | null) => void) | undefined;
    let entered!: () => void;
    const enteredWrite = new Promise<void>((resolve) => { entered = resolve; });
    proc.stdin.holdNextWrite = (complete) => { release = complete; entered(); };
    const first = conn.prepareDocument(filePath, "first");
    const abortMiddle = new AbortController();
    const middle = conn.prepareDocument(filePath, "middle", { signal: abortMiddle.signal });
    const third = conn.prepareDocument(filePath, "third");
    try {
      await enteredWrite;
      abortMiddle.abort();
      await expect(middle).rejects.toThrow(LspRequestCancelledError);
      expect(proc.stdin.write.mock.calls).toHaveLength(1); // first write only; third remains queued
      release?.(null);
      release = undefined;
      const [firstReceipt, thirdReceipt] = await Promise.all([first, third]);
      expect(firstReceipt.version).toBe(1);
      expect(thirdReceipt.version).toBe(2);
      expect(writtenMessages(proc).filter((m) => m.method === "textDocument/didOpen" || m.method === "textDocument/didChange").map((m) => m.params?.contentChanges?.[0]?.text ?? m.params?.textDocument?.text)).toEqual(["first", "third"]);
    } finally {
      if (release) release(null);
      await Promise.all([first.catch(() => {}), middle.catch(() => {}), third.catch(() => {})]);
    }
  });

  it("late error from a replaced stdin cannot fail the current connection", async () => {
    const { conn, proc } = await makeConnection({ textDocumentSync: 1 }, root);
    const filePath = join(root, "stale-stdin-error.ts");
    const receipt = await conn.prepareDocument(filePath, "submitted");
    const originalStdin = proc.stdin;
    const replacement = makeFakeProc({ textDocumentSync: 1 }).stdin;
    proc.stdin = replacement;
    originalStdin.emit("error", new Error("stale transport error"));
    expect(conn.getLifecycleState()).toBe("ready");
    proc.stdin = originalStdin;
    expect(conn.getDocumentReceipt(filePath)).toEqual(receipt);
    replacement.destroy();
  });

  it("real stdin write error fails connection, invalidates receipts, and rejects pending requests", async () => {
    const { conn, proc } = await makeConnection({ textDocumentSync: 1 }, root);
    const filePath = join(root, "stdin-write-error.ts");
    await conn.prepareDocument(filePath, "submitted");
    expect(conn.getDocumentReceipt(filePath)).not.toBeNull();

    let failWrite!: (error: Error) => void;
    let entered!: () => void;
    const enteredWrite = new Promise<void>((resolve) => { entered = resolve; });
    const observedError = new Promise<Error>((resolve) => {
      // Observe the real stream error on baseline without masking lifecycle assertions.
      proc.stdin.on("error", resolve);
    });
    proc.stdin.holdNextWrite = (complete) => {
      failWrite = (error) => complete(error);
      entered();
    };

    const pendingRequests = [
      conn.request("workspace/symbol", { query: "one" }),
      conn.request("workspace/symbol", { query: "two" }),
    ];
    const pendingSettled = Promise.allSettled(pendingRequests);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await enteredWrite;
      failWrite(new Error("controlled stdin write failure"));
      expect(await observedError).toBeInstanceOf(Error);
      expect(conn.getLifecycleState()).toBe("failed");
      expect(conn.getDocumentReceipt(filePath)).toBeNull();
      const watchdog = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("pending requests did not settle promptly")), 100);
      });
      const outcomes = await Promise.race([pendingSettled, watchdog]);
      expect(outcomes).toHaveLength(2);
      expect(outcomes.every((outcome) => outcome.status === "rejected")).toBe(true);
    } finally {
      if (timer) clearTimeout(timer);
      proc.emit("exit");
      await pendingSettled;
    }
  });

  it("receipt snapshots cannot mutate stored sync authority", async () => {
    const { conn } = await makeConnection({ textDocumentSync: 1 }, root);
    const filePath = join(root, "immutable-receipt.ts");
    const receipt = await conn.prepareDocument(filePath, "same");
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.syncConfig)).toBe(true);
    expect(Reflect.set(receipt.syncConfig, "change", "none")).toBe(false);
    expect(conn.getDocumentReceipt(filePath)?.syncConfig.change).toBe("full");
  });

  it("canonical path with symlinks resolves correctly without workspace jail", async () => {
    const { conn } = await makeConnection({ textDocumentSync: 1 }, root);
    // Path outside root (e.g. tmpdir)
    const outsideDir = mkdtempSync(join(tmpdir(), "outside-jail-"));
    try {
      const filePath = join(outsideDir, "outside.ts");
      const r = await conn.prepareDocument(filePath, "outside content");
      expect(r).toBeDefined();
      expect(r.canonicalPath).toBe(filePath);
      expect(conn.getDocumentReceipt(filePath)).toEqual(r);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});
