import { createHash } from "node:crypto";
import { getEventListeners } from "node:events";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { revalidateBoundActionOrigin, runBoundActionOperation, type BoundActionSession } from "../../../src/lsp/lsp-action-origin.js";
import type { ExecutorConnection } from "../../../src/lsp/lsp-executor.js";
import type { PreparedDocumentReceipt } from "../../../src/lsp/lsp-document-store.js";
import { snapshotActionSource } from "../../../src/lsp/lsp-action-source.js";
import { LSPConnection } from "../../../src/lsp/lsp-connection.js";
import { acquireBoundSession, cachedManager, evictManagerForRoot, sessionStore } from "../../../src/lsp/lsp-manager.js";
import { canonicalProjectRoot } from "../../../src/lsp/lsp-session-key.js";

const directories: string[] = [];
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "action-origin-verification-")));
  directories.push(root);
  const namedPath = join(root, "source.ts");
  const bytes = Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from("const value = 1;", "utf8")]);
  await writeFile(namedPath, bytes);
  const canonicalPath = await realpath(namedPath);
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  const server = { descriptorId: "typescript", name: "tsserver", languageId: "typescript", projectRoot: root, positionEncoding: "utf-16" as const };
  const receipt: PreparedDocumentReceipt = Object.freeze({
    canonicalPath, uri: pathToFileURL(canonicalPath).href, version: 1, textHash: hash(text), mutationGeneration: 1, submissionStamp: 1,
    syncConfig: Object.freeze({ openClose: true, change: "full" }), connectionId: "connection-1", transportId: "transport-1",
    storeId: "store-1", stateId: "state-1", descriptorId: server.descriptorId, projectRoot: root, positionEncoding: "utf-16",
  });
  let liveReceipt: PreparedDocumentReceipt | null = receipt;
  const calls: string[] = [];
  const conn: ExecutorConnection = {
    descriptorId: server.descriptorId, name: server.name, languageId: server.languageId, projectRoot: root,
    getNegotiatedEncoding: () => "utf-16",
    prepareDocument: async () => receipt,
    getDocumentReceipt: () => liveReceipt,
    request: async (method) => { calls.push(method); return method === "textDocument/codeAction"
      ? [{ title: "Fix", kind: "quickfix", data: { opaque: "origin" } }]
      : { title: "Fix", kind: "quickfix", data: { opaque: "origin" }, edit: { changes: { [pathToFileURL(canonicalPath).href]: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, newText: "fixed" }] } } }; },
  };
  const session: BoundActionSession = { conn, server, registered: (candidate) => candidate === conn, deadlineMs: Date.now() + 5_000 };
  const request = { operation: "codeActions" as const, path: namedPath, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } } };
  const found = await runBoundActionOperation(request, session);
  const selection = (found.envelope.result as Array<{ actionId: string; sourceSha256: string }>)[0]!;
  const resolved = await runBoundActionOperation({ ...request, operation: "resolveCodeAction", selection }, session);
  if (!resolved.origin) throw new Error("engine did not produce private origin fixture");
  return { root, namedPath, canonicalPath, bytes, text, receipt, server, conn, session, origin: resolved.origin, calls, setReceipt: (value: PreparedDocumentReceipt | null) => { liveReceipt = value; } };
}

describe("revalidateBoundActionOrigin", () => {
  it("removes the caller-abort listener from the originally captured signal after session replacement", async () => {
    const f = await fixture();
    const original = new AbortController();
    const replacement = new AbortController();
    const session = { ...f.session, signal: original.signal, now: () => Date.now() };
    const listenerCountBefore = getEventListeners(original.signal, "abort").length;
    let readerCompleted = false;
    session.now = () => {
      if (readerCompleted) session.signal = replacement.signal;
      return Date.now();
    };
    const snapshot: typeof snapshotActionSource = async (...args) => {
      const result = await snapshotActionSource(...args);
      readerCompleted = true;
      return result;
    };
    expect(await revalidateBoundActionOrigin(f.origin, session, { snapshot })).toEqual({ kind: "current" });
    expect(session.signal).toBe(replacement.signal);
    expect(getEventListeners(original.signal, "abort")).toHaveLength(listenerCountBefore);
  });

  it("cannot extend the captured deadline by mutating the runtime session", async () => {
    const f = await fixture();
    const start = Date.now();
    const deadlineMs = start + 5_000;
    let readerCompleted = false;
    let extensionObserved = false;
    let sourceDeadlineMs: number | undefined;
    const session = { ...f.session, deadlineMs, now: () => start };
    session.now = () => {
      if (readerCompleted) {
        extensionObserved = true;
        session.deadlineMs = deadlineMs + 5_000;
        return deadlineMs;
      }
      return start;
    };
    const snapshot: typeof snapshotActionSource = async (...args) => {
      sourceDeadlineMs = args[1].deadlineMs;
      const result = await snapshotActionSource(...args);
      expect(result.ok).toBe(true);
      readerCompleted = true;
      return result;
    };
    const result = await revalidateBoundActionOrigin(f.origin, session, { snapshot });
    expect(extensionObserved).toBe(true);
    expect(sourceDeadlineMs).toBe(deadlineMs);
    expect(result).toEqual({ kind: "refusal", status: "timeout" });
  });

  it("retains known expiration when the owned abort callback makes the clock unavailable", async () => {
    const f = await fixture();
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const caller = new AbortController();
    let clockFailed = false;
    let releaseReader!: () => void;
    const gate = new Promise<void>((resolve) => { releaseReader = resolve; });
    let reader: ReturnType<typeof snapshotActionSource> | undefined;
    const snapshot: typeof snapshotActionSource = (...args) => {
      const signal = args[1]?.signal;
      const onAbort = () => { clockFailed = true; releaseReader(); };
      signal?.addEventListener("abort", onAbort, { once: true });
      reader = (async () => {
        try { await gate; return await snapshotActionSource(...args); }
        finally { signal?.removeEventListener("abort", onAbort); }
      })();
      return reader;
    };
    const now = () => { if (clockFailed) throw new Error("injected post-expiry clock failure"); return Date.now(); };
    const result = revalidateBoundActionOrigin(f.origin, { ...f.session, deadlineMs: 1, now, signal: caller.signal }, { snapshot });
    try {
      await vi.advanceTimersByTimeAsync(2);
      expect(clockFailed).toBe(true);
      expect(await result).toEqual({ kind: "refusal", status: "timeout" });
      expect(caller.signal.aborted).toBe(false);
    } finally {
      releaseReader();
      caller.abort();
      await result.then(() => undefined, () => undefined);
      if (reader) await reader.then(() => undefined, () => undefined);
      vi.useRealTimers();
    }
  });
  it.each(["rollback", "caller-abort"] as const)("preserves expiration priority over %s from the owned abort callback", async (stop) => {
    const f = await fixture();
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const caller = new AbortController();
    let clockRolledBack = false;
    let releaseReader!: () => void;
    const gate = new Promise<void>((resolve) => { releaseReader = resolve; });
    let reader: ReturnType<typeof snapshotActionSource> | undefined;
    const snapshot: typeof snapshotActionSource = (...args) => {
      const signal = args[1]?.signal;
      const onAbort = () => {
        if (stop === "rollback") clockRolledBack = true;
        else caller.abort();
        releaseReader();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      reader = (async () => {
        try { await gate; return await snapshotActionSource(...args); }
        finally { signal?.removeEventListener("abort", onAbort); }
      })();
      return reader;
    };
    const now = () => clockRolledBack ? 0 : Date.now();
    const result = revalidateBoundActionOrigin(f.origin, { ...f.session, deadlineMs: 1, now, signal: caller.signal }, { snapshot });
    try {
      await vi.advanceTimersByTimeAsync(2);
      expect(await result).toEqual({ kind: "refusal", status: stop === "rollback" ? "timeout" : "cancelled" });
      expect(caller.signal.aborted).toBe(stop === "caller-abort");
    } finally {
      releaseReader();
      caller.abort();
      await result.then(() => undefined, () => undefined);
      if (reader) await reader.then(() => undefined, () => undefined);
      vi.useRealTimers();
    }
  });

  it.each([NaN, Infinity, -Infinity])("refuses invalid deadline %s before invoking the source snapshot", async (deadlineMs) => {
    const f = await fixture();
    let reads = 0;
    const snapshot: typeof snapshotActionSource = async (...args) => {
      reads++;
      return snapshotActionSource(...args);
    };
    expect(await revalidateBoundActionOrigin(f.origin, { ...f.session, deadlineMs }, { snapshot })).toMatchObject({ kind: "refusal" });
    expect(reads).toBe(0);
  });

  it.each(["nan", "throw"] as const)("retains an owned %s clock failure when the following clock read recovers", async (failure) => {
    const f = await fixture();
    const start = Date.now();
    let clockReads = 0;
    let failureObserved = false;
    const now = () => {
      clockReads++;
      if (clockReads === 2) {
        failureObserved = true;
        if (failure === "throw") throw new Error("injected clock failure");
        return NaN;
      }
      return start;
    };
    expect(await revalidateBoundActionOrigin(f.origin, { ...f.session, deadlineMs: start + 5_000, now })).toEqual({ kind: "refusal", status: "unavailable" });
    expect(failureObserved).toBe(true);
  });

  it("gives original cancellation priority when the publication clock callback also expires the deadline", async () => {
    const f = await fixture();
    const caller = new AbortController();
    const start = Date.now();
    const deadlineMs = start + 5_000;
    let readerCompleted = false;
    let callbackTriggered = false;
    const now = () => {
      if (readerCompleted) { callbackTriggered = true; caller.abort(); return deadlineMs; }
      return start;
    };
    const snapshot: typeof snapshotActionSource = async (...args) => {
      const result = await snapshotActionSource(...args);
      expect(result.ok).toBe(true);
      readerCompleted = true;
      return result;
    };
    expect(await revalidateBoundActionOrigin(f.origin, { ...f.session, signal: caller.signal, deadlineMs, now }, { snapshot })).toEqual({ kind: "refusal", status: "cancelled" });
    expect(callbackTriggered).toBe(true);
    expect(caller.signal.aborted).toBe(true);
  });
  it.each(["source-raw", "source-text", "selection-raw", "selection-action", "server"] as const)("refuses changed origin %s binding before source I/O", async (field) => {
    const f = await fixture();
    const altered = field === "source-raw" ? { ...f.origin, source: { ...f.origin.source, rawSha256: "a".repeat(64) } }
      : field === "source-text" ? { ...f.origin, source: { ...f.origin.source, textSha256: "b".repeat(64) } }
        : field === "selection-raw" ? { ...f.origin, selection: { ...f.origin.selection, rawSha256: "c".repeat(64) } }
          : field === "selection-action" ? { ...f.origin, selection: { ...f.origin.selection, actionId: "d".repeat(64) } }
            : { ...f.origin, server: { ...f.origin.server, name: "replacement" } };
    let snapshots = 0;
    const snapshot: typeof snapshotActionSource = async (...args) => {
      snapshots++;
      return snapshotActionSource(...args);
    };
    expect(await revalidateBoundActionOrigin(altered, f.session, { snapshot })).toMatchObject({ kind: "refusal" });
    expect(snapshots).toBe(0);
  });

  it("refuses past-deadline work before source I/O and prioritizes caller pre-abort", async () => {
    const f = await fixture();
    let snapshots = 0;
    const snapshot: typeof snapshotActionSource = async (...args) => {
      snapshots++;
      return snapshotActionSource(...args);
    };
    expect(await revalidateBoundActionOrigin(f.origin, { ...f.session, deadlineMs: Date.now() - 1 }, { snapshot })).toMatchObject({ kind: "refusal", status: "timeout" });
    const caller = new AbortController();
    caller.abort();
    expect(await revalidateBoundActionOrigin(f.origin, { ...f.session, signal: caller.signal, deadlineMs: NaN }, { snapshot })).toMatchObject({ kind: "refusal", status: "cancelled" });
    expect(snapshots).toBe(0);
  });

  it.each(["cancelled", "timeout"] as const)("prioritizes %s introduced by the final receipt callback over stale receipt", async (stop) => {
    const f = await fixture();
    const caller = new AbortController();
    let now = 0;
    let receiptReads = 0;
    const conn: ExecutorConnection = {
      ...f.conn,
      getDocumentReceipt: () => {
        receiptReads++;
        if (receiptReads === 2) {
          if (stop === "cancelled") caller.abort(); else now = 10_000;
          return null;
        }
        return f.receipt;
      },
    };
    const session = { ...f.session, conn, registered: (candidate: ExecutorConnection) => candidate === conn, signal: caller.signal, deadlineMs: 10_000, now: () => now };
    expect(await revalidateBoundActionOrigin(f.origin, session)).toEqual({ kind: "refusal", status: stop });
    expect(receiptReads).toBe(2);
  });

  it("accepts the exact BOM source, submitted receipt, and registered session", async () => {
    const f = await fixture();
    expect(await revalidateBoundActionOrigin(f.origin, f.session)).toEqual({ kind: "current" });
  });

  it("refuses changed raw bytes before treating an identical decoded text as current", async () => {
    const f = await fixture();
    await writeFile(f.namedPath, Buffer.from("const value = 1;", "utf8"));
    expect(await revalidateBoundActionOrigin(f.origin, f.session)).toEqual({ kind: "refusal", status: "not_ready" });
  });

  it("refuses source content drift", async () => {
    const f = await fixture();
    await writeFile(f.namedPath, "const value = 2;");
    expect(await revalidateBoundActionOrigin(f.origin, f.session)).toMatchObject({ kind: "refusal", status: "not_ready" });
  });

  it("refuses a deleted original named alias", async () => {
    const f = await fixture();
    await rm(f.namedPath);
    expect(await revalidateBoundActionOrigin(f.origin, f.session)).toMatchObject({ kind: "refusal", status: "not_ready" });
  });

  it("refuses an alias rebound to a different canonical file with identical bytes", async (test) => {
    const f = await fixture();
    const other = join(f.root, "other.ts");
    await writeFile(other, f.bytes);
    await rm(f.namedPath);
    try { await symlink(other, f.namedPath); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") { test.skip(true, `symlink creation not permitted (${code})`); return; }
      throw error;
    }
    expect(await revalidateBoundActionOrigin(f.origin, f.session)).toMatchObject({ kind: "refusal", status: "not_ready" });
  });

  it("requires the current submitted receipt instead of falling back to the captured one", async () => {
    const f = await fixture();
    f.setReceipt(null);
    expect(await revalidateBoundActionOrigin(f.origin, f.session)).toMatchObject({ kind: "refusal", status: "not_ready" });
  });

  it.each(["version", "textHash", "mutationGeneration", "submissionStamp", "connectionId", "transportId", "storeId", "stateId", "descriptorId", "projectRoot", "positionEncoding"] as const)("refuses drift in receipt field %s", async (field) => {
    const f = await fixture();
    const altered = { ...f.receipt, [field]: field === "version" || field === "mutationGeneration" || field === "submissionStamp" ? 2 : `changed-${field}` } as PreparedDocumentReceipt;
    f.setReceipt(altered);
    expect(await revalidateBoundActionOrigin(f.origin, f.session)).toMatchObject({ kind: "refusal", status: "not_ready" });
  });

  it.each(["canonicalPath", "uri"] as const)("refuses receipt %s drift", async (field) => {
    const f = await fixture();
    f.setReceipt({ ...f.receipt, [field]: `${f.receipt[field]}-changed` });
    expect(await revalidateBoundActionOrigin(f.origin, f.session)).toMatchObject({ kind: "refusal", status: "not_ready" });
  });

  it.each(["openClose", "change"] as const)("refuses synchronization configuration %s drift", async (field) => {
    const f = await fixture();
    const syncConfig = field === "openClose"
      ? { ...f.receipt.syncConfig, openClose: false }
      : { ...f.receipt.syncConfig, change: "incremental" as const };
    f.setReceipt({ ...f.receipt, syncConfig });
    expect(await revalidateBoundActionOrigin(f.origin, f.session)).toMatchObject({ kind: "refusal", status: "not_ready" });
  });

  it("requires positive receipt versions and supported synchronization configuration", async () => {
    const f = await fixture();
    f.setReceipt({ ...f.receipt, version: 0 });
    expect(await revalidateBoundActionOrigin(f.origin, f.session)).toMatchObject({ kind: "refusal" });
    f.setReceipt({ ...f.receipt, syncConfig: { openClose: true, change: "none" } });
    expect(await revalidateBoundActionOrigin(f.origin, f.session)).toMatchObject({ kind: "refusal" });
  });

  it.each(["descriptorId", "name", "projectRoot", "encoding"] as const)("refuses live connection %s replacement", async (field) => {
    const f = await fixture();
    const conn = { ...f.conn };
    if (field === "descriptorId") conn.descriptorId = "replacement";
    if (field === "name") conn.name = "replacement";
    if (field === "projectRoot") conn.projectRoot = join(f.root, "elsewhere");
    if (field === "encoding") conn.getNegotiatedEncoding = () => "utf-8";
    const session = { ...f.session, conn };
    expect(await revalidateBoundActionOrigin(f.origin, session)).toMatchObject({ kind: "refusal" });
  });

  it("composes the engine and revalidation on the same real manager lease, then refuses after release", async () => {
    const f = await fixture();
    const key = `${canonicalProjectRoot(f.root)}::typescript::origin-verification`;
    const conn = new LSPConnection();
    Reflect.set(conn, "sessionKey", key);
    conn.descriptorId = f.server.descriptorId;
    conn.name = f.server.name;
    conn.projectRoot = canonicalProjectRoot(f.root);
    conn.languageIds = [f.server.languageId];
    vi.spyOn(conn, "getNegotiatedEncoding").mockReturnValue("utf-16");
    vi.spyOn(conn, "shutdown").mockImplementation(() => {});
    vi.spyOn(conn, "prepareDocument").mockResolvedValue(f.receipt);
    vi.spyOn(conn, "getDocumentReceipt").mockReturnValue(f.receipt);
    vi.spyOn(conn, "request").mockImplementation(async (method) => method === "textDocument/codeAction"
      ? [{ title: "Fix", kind: "quickfix", data: { opaque: "lease-origin" } }]
      : { title: "Fix", kind: "quickfix", data: { opaque: "lease-origin" }, edit: { changes: {
        [pathToFileURL(f.canonicalPath).href]: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, newText: "fixed" }],
      } } });
    sessionStore.set(key, { conn, fingerprint: "fingerprint", descriptorId: f.server.descriptorId, root: canonicalProjectRoot(f.root), leases: 0, lastUsed: Date.now() });
    const manager = cachedManager(f.root);
    vi.spyOn(manager, "getServer").mockResolvedValue(conn);
    let lease: Awaited<ReturnType<typeof acquireBoundSession>> = null;
    try {
      lease = await acquireBoundSession(f.root, f.server.languageId);
      expect(lease).not.toBeNull();
      const session: BoundActionSession = {
        conn: lease!.conn, server: f.server, deadlineMs: Date.now() + 5_000,
        registered: (candidate) => candidate === lease!.conn && lease!.isCurrent(),
      };
      const request = { operation: "codeActions" as const, path: f.namedPath, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } } };
      const found = await runBoundActionOperation(request, session);
      const selection = (found.envelope.result as Array<{ actionId: string; sourceSha256: string }>)[0]!;
      const resolved = await runBoundActionOperation({ ...request, operation: "resolveCodeAction", selection }, session);
      expect(resolved.origin).toBeDefined();
      expect(await revalidateBoundActionOrigin(resolved.origin!, session)).toEqual({ kind: "current" });
      lease!.release();
      let reads = 0;
      const snapshot = async (...args: Parameters<typeof snapshotActionSource>) => {
        reads++;
        return snapshotActionSource(...args);
      };
      expect(await revalidateBoundActionOrigin(resolved.origin!, session, { snapshot })).toMatchObject({ kind: "refusal" });
      expect(reads).toBe(0);
    } finally {
      lease?.release();
      sessionStore.delete(key);
      await evictManagerForRoot(f.root);
    }
  });

  it("refuses a released or unregistered lease before source I/O", async () => {
    const f = await fixture();
    let reads = 0;
    const snapshot = async (...args: Parameters<typeof import("../../../src/lsp/lsp-action-source.js").snapshotActionSource>) => {
      reads++;
      const { snapshotActionSource } = await import("../../../src/lsp/lsp-action-source.js");
      return snapshotActionSource(...args);
    };
    expect(await revalidateBoundActionOrigin(f.origin, { ...f.session, registered: () => false }, { snapshot })).toMatchObject({ kind: "refusal" });
    expect(reads).toBe(0);
  });

  it("checks cancellation before source I/O and preserves cancellation over stale metadata", async () => {
    const f = await fixture();
    const controller = new AbortController();
    controller.abort();
    let reads = 0;
    const snapshot = async (...args: Parameters<typeof import("../../../src/lsp/lsp-action-source.js").snapshotActionSource>) => {
      reads++;
      const { snapshotActionSource } = await import("../../../src/lsp/lsp-action-source.js");
      return snapshotActionSource(...args);
    };
    f.setReceipt(null);
    expect(await revalidateBoundActionOrigin(f.origin, { ...f.session, signal: controller.signal }, { snapshot })).toEqual({ kind: "refusal", status: "cancelled" });
    expect(reads).toBe(0);
  });

  it.each([1, 1.5])("withdraws and drains the actual source reader at a %sms absolute deadline", async (budgetMs) => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const caller = new AbortController();
    let resultPromise: Promise<Awaited<ReturnType<typeof revalidateBoundActionOrigin>>> | undefined;
    let readerStarted = false;
    let readerCompleted = false;
    let ownedSignal: AbortSignal | undefined;
    let finishReader!: () => void;
    const readerSettled = new Promise<void>((resolve) => { finishReader = resolve; });
    const snapshot = async (path: string, options: Parameters<typeof snapshotActionSource>[1]) => {
      readerStarted = true;
      ownedSignal = options.signal;
      await new Promise<void>((resolve) => ownedSignal!.addEventListener("abort", () => resolve(), { once: true }));
      try { return await snapshotActionSource(path, options); }
      finally { readerCompleted = true; finishReader(); }
    };
    try {
      const f = await fixture();
      resultPromise = revalidateBoundActionOrigin(f.origin, {
        ...f.session, signal: caller.signal, deadlineMs: Date.now() + budgetMs,
      }, { snapshot });
      await vi.advanceTimersByTimeAsync(Math.ceil(budgetMs));
      const observedOwnedAbort = ownedSignal?.aborted === true;
      expect(observedOwnedAbort).toBe(true);
      const result = await resultPromise;
      await readerSettled;
      const readerSettledBeforeCleanup = readerCompleted;
      expect(readerSettledBeforeCleanup).toBe(true);
      expect(result).toEqual({ kind: "refusal", status: "timeout" });
      expect(caller.signal.aborted).toBe(false);
    } finally {
      caller.abort();
      await resultPromise?.then(() => undefined, () => undefined);
      if (readerStarted) await readerSettled;
      vi.useRealTimers();
    }
  });

  it("caps long timer chunks and reschedules against the original absolute deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const caller = new AbortController();
    let resultPromise: Promise<Awaited<ReturnType<typeof revalidateBoundActionOrigin>>> | undefined;
    let readerStarted = false;
    let readerCompleted = false;
    let ownedSignal: AbortSignal | undefined;
    let finishReader!: () => void;
    const readerSettled = new Promise<void>((resolve) => { finishReader = resolve; });
    const snapshot = async (path: string, options: Parameters<typeof snapshotActionSource>[1]) => {
      readerStarted = true;
      ownedSignal = options.signal;
      await new Promise<void>((resolve) => ownedSignal!.addEventListener("abort", () => resolve(), { once: true }));
      try { return await snapshotActionSource(path, options); }
      finally { readerCompleted = true; finishReader(); }
    };
    try {
      const f = await fixture();
      const deadlineMs = Date.now() + 2_147_483_648;
      resultPromise = revalidateBoundActionOrigin(f.origin, { ...f.session, signal: caller.signal, deadlineMs }, { snapshot });
      await vi.advanceTimersByTimeAsync(2_147_483_647);
      expect(ownedSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(ownedSignal?.aborted).toBe(true);
      expect(await resultPromise).toEqual({ kind: "refusal", status: "timeout" });
      await readerSettled;
      expect(readerCompleted).toBe(true);
      expect(caller.signal.aborted).toBe(false);
    } finally {
      caller.abort();
      await resultPromise?.then(() => undefined, () => undefined);
      if (readerStarted) await readerSettled;
      vi.useRealTimers();
    }
  });

  it("never replays preparation, query, resolution, staging, or apply during revalidation", async () => {
    const f = await fixture();
    const callsBefore = [...f.calls];
    expect(await revalidateBoundActionOrigin(f.origin, f.session)).toEqual({ kind: "current" });
    expect(f.calls).toEqual(callsBefore);
    expect(callsBefore).toEqual(["textDocument/codeAction", "textDocument/codeAction", "codeAction/resolve"]);
  });
});
