import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeBoundAction } from "../../../src/lsp/lsp-action-adapter.js";
import type { BoundSessionLease } from "../../../src/lsp/lsp-manager.js";
import type { BoundActionRequest } from "../../../src/lsp/lsp-action-origin.js";
import { LSPConnection } from "../../../src/lsp/lsp-connection.js";
import type { PreparedDocumentReceipt } from "../../../src/lsp/lsp-document-store.js";
import { cachedManager, sessionStore, type SessionEntry } from "../../../src/lsp/lsp-manager.js";

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const action = { title: "Fix", kind: "quickfix", data: { opaque: "kept" }, vendor: 7 };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function fixture(response: unknown = [action]) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "action-adapter-"));
  roots.push(temporaryRoot);
  const root = await realpath(temporaryRoot);
  const namedPath = join(root, "source.ts");
  const text = "const value = 1;";
  await writeFile(namedPath, text);
  const path = await realpath(namedPath);
  const descriptorId = "typescript-language-server";
  const registration = Object.freeze({ descriptorId, name: "TypeScript", projectRoot: root, languageIds: Object.freeze(["typescript"]), positionEncoding: "utf-16" as const });
  const receipt: PreparedDocumentReceipt = {
    canonicalPath: path, uri: pathToFileURL(path).href, version: 1, textHash: hash(text), mutationGeneration: 1, submissionStamp: 1,
    syncConfig: { openClose: true, change: "full" }, connectionId: "connection", transportId: "transport", storeId: "store", stateId: "state",
    descriptorId, projectRoot: root, positionEncoding: "utf-16",
  };
  const wires: Array<{ method: string; params: unknown; signal?: AbortSignal }> = [];
  const conn = new LSPConnection();
  conn.descriptorId = descriptorId;
  conn.name = registration.name;
  conn.projectRoot = root;
  conn.languageIds = ["typescript"];
  vi.spyOn(conn, "getNegotiatedEncoding").mockReturnValue("utf-16");
  vi.spyOn(conn, "prepareDocument").mockImplementation(async (_source, submitted, _options) => {
    expect(submitted).toBe(text);
    return receipt;
  });
  vi.spyOn(conn, "getDocumentReceipt").mockReturnValue(receipt);
  vi.spyOn(conn, "request").mockImplementation(async (method, params, options) => {
    wires.push({ method, params, signal: options?.signal });
    return method === "textDocument/codeAction" ? response : action;
  });
  const release = vi.fn();
  const current = vi.fn(() => true);
  const lease: BoundSessionLease = { conn, key: "opaque-key", registration, isCurrent: current, release };
  const route = { projectRoot: root, languageId: "typescript", server: descriptorId };
  const request: BoundActionRequest = { operation: "codeActions", path, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } }, context: { diagnostics: [] } };
  const acquire = vi.fn(async () => lease);
  const deadlineMs = Date.now() + 60_000;
  return { root, path, text, conn, receipt, wires, lease, release, current, route, request, acquire, deadlineMs };
}

function resolveRequest(f: Fixture, selection: { actionId: string; sourceSha256: string }): BoundActionRequest {
  return { ...f.request, operation: "resolveCodeAction", selection };
}

describe("executeBoundAction lifecycle adapter", () => {
  it.each(["cancelled", "timeout"] as const)("rechecks %s after the acquisition helper returns no lease", async (status) => {
    const f = await fixture();
    const caller = new AbortController();
    let time = 1;
    let acquired = false;
    const now = () => {
      if (acquired) {
        acquired = false;
        queueMicrotask(() => { if (status === "cancelled") caller.abort(); else time = 100; });
      }
      return time;
    };
    const outcome = await executeBoundAction(f.request, f.route, {
      deadlineMs: 100, signal: caller.signal, now,
      acquire: async () => { acquired = true; return null; },
    });
    expect(await outcome.cleanup).toEqual({ state: "not-acquired" });
    expect(outcome).toMatchObject({ kind: "refusal", status });
    expect(f.release).not.toHaveBeenCalled();
  });

  it("releases an acquired lease when its registration getter throws", async () => {
    const f = await fixture();
    const getRegistration = vi.fn(() => { throw new Error("injected registration getter failure"); });
    const lease: BoundSessionLease = {
      conn: f.conn, key: f.lease.key, isCurrent: f.current, release: f.release,
      get registration() { return getRegistration(); },
    };
    const acquire = vi.fn(async () => lease);
    const outcome = executeBoundAction(f.request, f.route, { deadlineMs: f.deadlineMs, acquire });
    try {
      const settled = await outcome.catch(() => undefined);
      expect(acquire).toHaveBeenCalledTimes(1);
      expect(getRegistration).toHaveBeenCalledTimes(1);
      expect(f.release).toHaveBeenCalledTimes(1);
      expect(settled).toMatchObject({ kind: "refusal", status: "unavailable" });
      expect(await settled?.cleanup).toEqual({ state: "released" });
    } finally {
      await outcome.catch(() => undefined);
      if (f.release.mock.calls.length === 0) f.release();
    }
  });
  it("prioritizes caller cancellation after the acquisition timer fires but before publication", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const pending = new Promise<BoundSessionLease | null>((resolve) => { finish = () => resolve(null); });
    const caller = new AbortController();
    const acquire = vi.fn(() => pending);
    const outcome = executeBoundAction({ ...emptyRequest(), path: "/tmp/irrelevant.ts" }, emptyRoute(), {
      deadlineMs: Date.now() + 50, signal: caller.signal, acquire,
    });
    let settledOutcome: Awaited<typeof outcome>;
    try {
      await Promise.resolve();
      expect(acquire).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(50);
      caller.abort();
      await expect(outcome).resolves.toMatchObject({ kind: "refusal", status: "cancelled" });
      settledOutcome = await outcome;
    } finally {
      finish();
      await pending;
      await outcome;
      vi.useRealTimers();
    }
    await expect(settledOutcome!.cleanup).resolves.toEqual({ state: "not-acquired" });
  });

  it("does not dispatch acquisition after synchronous cancellation before its microtask starts", async () => {
    const f = await fixture();
    const caller = new AbortController();
    const acquire = vi.fn(f.acquire);
    const outcome = executeBoundAction(f.request, f.route, { deadlineMs: f.deadlineMs, signal: caller.signal, acquire });
    caller.abort();
    await expect(outcome).resolves.toMatchObject({ kind: "refusal", status: "cancelled" });
    expect(acquire).not.toHaveBeenCalled();
    expect(f.release).not.toHaveBeenCalled();
  });

  it("refuses pre-aborted, expired, and non-finite inputs without acquisition", async () => {
    const f = await fixture();
    const acquire = vi.fn(f.acquire);
    const caller = new AbortController(); caller.abort();
    await expect(executeBoundAction(f.request, f.route, { deadlineMs: f.deadlineMs, signal: caller.signal, acquire })).resolves.toMatchObject({ kind: "refusal", status: "cancelled" });
    await expect(executeBoundAction(f.request, f.route, { deadlineMs: 1, now: () => 1, acquire })).resolves.toMatchObject({ kind: "refusal", status: "timeout" });
    await expect(executeBoundAction(f.request, f.route, { deadlineMs: Number.NaN, acquire })).resolves.toMatchObject({ kind: "refusal", status: "unsupported" });
    const invalidClock = await executeBoundAction(f.request, f.route, { deadlineMs: f.deadlineMs, now: () => Number.POSITIVE_INFINITY, acquire });
    expect(invalidClock).toMatchObject({ kind: "refusal", status: "unsupported" });
    await expect(invalidClock.cleanup).resolves.toEqual({ state: "not-acquired" });
    expect(acquire).not.toHaveBeenCalled();
  });

  it("returns successful engine-discovered options with identities and releases once", async () => {
    const f = await fixture();
    const outcome = await executeBoundAction(f.request, f.route, { deadlineMs: f.deadlineMs, acquire: f.acquire });
    expect(outcome.kind).toBe("result");
    if (outcome.kind !== "result") return;
    expect(outcome.envelope.status).toBe("ok");
    expect(outcome.envelope.result).toMatchObject([{ title: "Fix", actionId: expect.stringMatching(/^[a-f0-9]{64}$/), sourceSha256: hash(f.text) }]);
    expect(f.wires.map((wire) => wire.method)).toEqual(["textDocument/codeAction"]);
    expect(f.release).toHaveBeenCalledTimes(1);
    await expect(outcome.cleanup).resolves.toEqual({ state: "released" });
  });

  it("resolves the selected action through the engine and sends the direct private payload", async () => {
    const f = await fixture();
    const found = await executeBoundAction(f.request, f.route, { deadlineMs: f.deadlineMs, acquire: f.acquire });
    expect(found.kind).toBe("result");
    if (found.kind !== "result") return;
    const selected = (found.envelope.result as Array<{ actionId: string; sourceSha256: string }>)[0]!;
    f.release.mockClear();
    const resolved = await executeBoundAction(resolveRequest(f, selected), f.route, { deadlineMs: f.deadlineMs, acquire: f.acquire });
    expect(resolved.kind).toBe("result");
    if (resolved.kind !== "result") return;
    expect(resolved.envelope.status).toBe("ok");
    expect(resolved).not.toHaveProperty("origin");
    expect(resolved.envelope.result).toMatchObject({ title: action.title, data: action.data });
    expect(f.wires.at(-1)).toEqual(expect.objectContaining({ method: "codeAction/resolve", params: action }));
    expect(f.release).toHaveBeenCalledTimes(1);
    await expect(resolved.cleanup).resolves.toEqual({ state: "released" });
  });

  it("passes the same absolute deadline to document preparation", async () => {
    const f = await fixture();
    const prepare = vi.mocked(f.conn.prepareDocument);
    await executeBoundAction(f.request, f.route, { deadlineMs: f.deadlineMs, acquire: f.acquire });
    expect(prepare).toHaveBeenCalledWith(f.path, f.text, expect.objectContaining({ deadlineMs: f.deadlineMs }));
  });

  it("releases after a query failure", async () => {
    const f = await fixture();
    vi.mocked(f.conn.request).mockRejectedValue(new Error("query failed"));
    const result = await executeBoundAction(f.request, f.route, { deadlineMs: f.deadlineMs, acquire: f.acquire });
    expect(result).toMatchObject({ kind: "result", envelope: { status: "unavailable", result: null } });
    expect(f.release).toHaveBeenCalledTimes(1);
    await expect(result.cleanup).resolves.toEqual({ state: "released" });
  });

  it("uses an engine-owned request signal after external caller cancellation", async () => {
    const f = await fixture();
    const caller = new AbortController();
    let settle!: () => void;
    let entered!: () => void;
    let underlying!: Promise<unknown>;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    vi.mocked(f.conn.request).mockImplementation((_method, _params, options) => {
      underlying = new Promise((_resolve, reject) => {
        settle = () => reject(new Error("owned request withdrawn"));
        options?.signal?.addEventListener("abort", settle, { once: true });
      });
      f.wires.push({ method: "textDocument/codeAction", params: {}, signal: options?.signal });
      entered();
      caller.abort();
      return underlying;
    });
    const outcome = executeBoundAction(f.request, f.route, { deadlineMs: f.deadlineMs, signal: caller.signal, acquire: f.acquire });
    try {
      await enteredPromise;
      const result = await outcome;
      expect(result).toMatchObject({ kind: "refusal", status: "cancelled" });
      expect(f.wires.at(-1)?.signal?.aborted).toBe(true);
      expect(caller.signal.aborted).toBe(true);
      expect(f.release).toHaveBeenCalledTimes(1);
    } finally {
      settle?.();
      await underlying?.catch(() => undefined);
      await outcome;
    }
  });

  it("withdraws a deadline-expired in-flight engine request and releases once", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    let now = Date.now();
    const deadlineMs = now + 25;
    let settle!: () => void;
    let entered!: () => void;
    let underlying!: Promise<unknown>;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    vi.mocked(f.conn.request).mockImplementation((_method, _params, options) => {
      underlying = new Promise((_resolve, reject) => {
        settle = () => reject(new Error("owned request withdrawn"));
        options?.signal?.addEventListener("abort", settle, { once: true });
      });
      f.wires.push({ method: "textDocument/codeAction", params: {}, signal: options?.signal });
      entered();
      return underlying;
    });
    const outcome = executeBoundAction(f.request, f.route, { deadlineMs, now: () => now, acquire: f.acquire });
    try {
      await enteredPromise;
      now = deadlineMs;
      await vi.advanceTimersByTimeAsync(25);
      await expect(outcome).resolves.toMatchObject({ kind: "refusal", status: "timeout" });
      expect(f.wires.at(-1)?.signal?.aborted).toBe(true);
      expect(f.release).toHaveBeenCalledTimes(1);
    } finally {
      settle?.();
      await underlying?.catch(() => undefined);
      await outcome;
      vi.useRealTimers();
    }
  });

  it("does not shut down a shared connection when releasing this lease", async () => {
    const f = await fixture();
    const shutdown = vi.spyOn(f.conn, "shutdown").mockImplementation(() => {});
    await executeBoundAction(f.request, f.route, { deadlineMs: f.deadlineMs, acquire: f.acquire });
    expect(f.release).toHaveBeenCalledTimes(1);
    expect(shutdown).not.toHaveBeenCalled();
  });

  it("composes the default bound-session factory, adapter, and real action engine", async () => {
    const f = await fixture();
    const key = `${f.root}::${f.route.server}::action-adapter-composition`;
    Reflect.set(f.conn, "sessionKey", key);
    const entry: SessionEntry = { conn: f.conn, fingerprint: "adapter-test-fingerprint", descriptorId: f.route.server, root: f.root, leases: 0, lastUsed: Date.now() };
    sessionStore.set(key, entry);
    const getServer = vi.spyOn(cachedManager(f.root), "getServer").mockResolvedValue(f.conn);
    try {
      const found = await executeBoundAction(f.request, f.route, { deadlineMs: f.deadlineMs });
      expect(found.kind).toBe("result");
      if (found.kind !== "result") return;
      const selected = (found.envelope.result as Array<{ actionId: string; sourceSha256: string }>)[0]!;
      await expect(found.cleanup).resolves.toEqual({ state: "released" });
      expect(entry.leases).toBe(0);
      const resolved = await executeBoundAction(resolveRequest(f, selected), f.route, { deadlineMs: f.deadlineMs });
      expect(resolved.kind).toBe("result");
      if (resolved.kind !== "result") return;
      expect(resolved.envelope.status).toBe("ok");
      expect(f.wires.at(-1)).toEqual(expect.objectContaining({ method: "codeAction/resolve", params: action }));
      await expect(resolved.cleanup).resolves.toEqual({ state: "released" });
      expect(entry.leases).toBe(0);
      expect(getServer).toHaveBeenCalledTimes(2);
    } finally {
      getServer.mockRestore();
      sessionStore.delete(key);
      Reflect.deleteProperty(f.conn, "sessionKey");
    }
  });

  it.each([
    ["descriptor", { descriptorId: "other" }],
    ["root", { projectRoot: "/wrong-root" }],
    ["language", { languageIds: ["python"] }],
  ] as const)("refuses mismatched captured %s metadata and releases", async (_label, change) => {
    const f = await fixture();
    const registration: BoundSessionLease["registration"] = Object.freeze({ ...f.lease.registration, ...change });
    const lease: BoundSessionLease = { ...f.lease, registration };
    const result = await executeBoundAction(f.request, f.route, { deadlineMs: f.deadlineMs, acquire: async () => lease });
    expect(result).toMatchObject({ kind: "refusal", status: "unavailable" });
    expect(f.release).toHaveBeenCalledTimes(1);
    await expect(result.cleanup).resolves.toEqual({ state: "released" });
  });

  it("refuses replacement before engine entry and releases", async () => {
    const f = await fixture();
    f.current.mockReturnValue(false);
    const outcome = await executeBoundAction(f.request, f.route, { deadlineMs: f.deadlineMs, acquire: f.acquire });
    expect(outcome).toMatchObject({ kind: "refusal", status: "not_ready" });
    expect(f.wires).toHaveLength(0);
    expect(f.release).toHaveBeenCalledTimes(1);
  });

  it("refuses registration replacement during the engine request", async () => {
    const f = await fixture();
    vi.mocked(f.conn.request).mockImplementation(async (method, params, options) => {
      f.wires.push({ method, params, signal: options?.signal });
      f.current.mockReturnValue(false);
      return [action];
    });
    const result = await executeBoundAction(f.request, f.route, { deadlineMs: f.deadlineMs, acquire: f.acquire });
    expect(result).toMatchObject({ kind: "refusal", status: "not_ready" });
    expect(result).not.toHaveProperty("envelope.result");
    expect(f.release).toHaveBeenCalledTimes(1);
  });

  it("prioritizes caller cancellation introduced by the currentness callback", async () => {
    const f = await fixture();
    const caller = new AbortController();
    f.current.mockImplementation(() => { caller.abort(); return false; });
    const result = await executeBoundAction(f.request, f.route, { deadlineMs: f.deadlineMs, signal: caller.signal, acquire: f.acquire });
    expect(result).toMatchObject({ kind: "refusal", status: "cancelled" });
    expect(f.release).toHaveBeenCalledTimes(1);
  });

  it("rechecks stop conditions after a route-refusal lease release", async () => {
    const f = await fixture();
    const caller = new AbortController();
    f.release.mockImplementation(() => caller.abort());
    const registration: BoundSessionLease["registration"] = Object.freeze({ ...f.lease.registration, descriptorId: "mismatch" });
    const lease: BoundSessionLease = { ...f.lease, registration };
    const result = await executeBoundAction(f.request, f.route, { deadlineMs: f.deadlineMs, signal: caller.signal, acquire: async () => lease });
    expect(result).toMatchObject({ kind: "refusal", status: "cancelled" });
    expect(f.release).toHaveBeenCalledTimes(1);
  });

  it("rechecks timeout after a route-refusal lease release", async () => {
    const f = await fixture();
    let now = 10;
    f.release.mockImplementation(() => { now = 20; });
    const registration: BoundSessionLease["registration"] = Object.freeze({ ...f.lease.registration, descriptorId: "mismatch" });
    const lease: BoundSessionLease = { ...f.lease, registration };
    const result = await executeBoundAction(f.request, f.route, { deadlineMs: 20, now: () => now, acquire: async () => lease });
    expect(result).toMatchObject({ kind: "refusal", status: "timeout" });
    expect(f.release).toHaveBeenCalledTimes(1);
  });

  it("settles acquisition cancellation and releases a late lease exactly once", async () => {
    const f = await fixture();
    let finish!: (value: BoundSessionLease) => void;
    let entered!: () => void;
    let underlying!: Promise<BoundSessionLease>;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const acquire = vi.fn(() => { underlying = new Promise((resolve) => { finish = resolve; }); entered(); return underlying; });
    const caller = new AbortController();
    const outcome = executeBoundAction(f.request, f.route, { deadlineMs: f.deadlineMs, signal: caller.signal, acquire });
    try {
      await enteredPromise;
      caller.abort();
      await expect(outcome).resolves.toMatchObject({ kind: "refusal", status: "cancelled" });
      finish(f.lease);
      await underlying;
      await expect(outcome.then((value) => value.cleanup)).resolves.toEqual({ state: "released" });
      expect(f.release).toHaveBeenCalledTimes(1);
    } finally {
      if (finish!) finish(f.lease);
      await underlying;
      await outcome;
    }
  });

  it("settles acquisition deadline and releases a late lease exactly once", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    const caller = new AbortController();
    const deadlineMs = Date.now() + 50;
    let finish!: (value: BoundSessionLease) => void;
    let entered!: () => void;
    let underlying!: Promise<BoundSessionLease>;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const acquire = vi.fn(() => { underlying = new Promise((resolve) => { finish = resolve; }); entered(); return underlying; });
    const outcome = executeBoundAction(f.request, f.route, { deadlineMs, signal: caller.signal, acquire });
    try {
      await enteredPromise;
      await vi.advanceTimersByTimeAsync(50);
      await expect(outcome).resolves.toMatchObject({ kind: "refusal", status: "timeout" });
      expect(caller.signal.aborted).toBe(false);
      finish(f.lease);
      await underlying;
      await expect(outcome.then((value) => value.cleanup)).resolves.toEqual({ state: "released" });
      expect(f.release).toHaveBeenCalledTimes(1);
    } finally {
      if (finish!) finish(f.lease);
      await underlying;
      await outcome;
      vi.useRealTimers();
    }
  });

  it("observes late acquisition rejection after caller cancellation", async () => {
    const f = await fixture();
    let reject!: (reason: Error) => void;
    let entered!: () => void;
    let underlying!: Promise<BoundSessionLease>;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const acquire = vi.fn(() => { underlying = new Promise((_resolve, fail) => { reject = fail; }); entered(); return underlying; });
    const caller = new AbortController();
    const outcome = executeBoundAction(f.request, f.route, { deadlineMs: f.deadlineMs, signal: caller.signal, acquire });
    try {
      await enteredPromise;
      caller.abort();
      await expect(outcome).resolves.toMatchObject({ kind: "refusal", status: "cancelled" });
      reject(new Error("late acquisition rejection"));
      await expect(underlying).rejects.toThrow("late acquisition rejection");
      await expect(outcome.then((value) => value.cleanup)).resolves.toEqual({ state: "not-acquired" });
    } finally {
      if (reject!) reject(new Error("cleanup rejection"));
      await underlying.catch(() => undefined);
      await outcome;
    }
  });

  it("reports a normal release exception as cleanup failure and never succeeds", async () => {
    const f = await fixture();
    f.release.mockImplementation(() => { throw new Error("release failed"); });
    const outcome = await executeBoundAction(f.request, f.route, { deadlineMs: f.deadlineMs, acquire: f.acquire });
    expect(outcome).toMatchObject({ kind: "refusal", status: "unavailable" });
    await expect(outcome.cleanup).resolves.toEqual({ state: "failed" });
    expect(f.release).toHaveBeenCalledTimes(1);
  });

  it("reports late release exceptions through cleanup without an unhandled chain rejection", async () => {
    const f = await fixture();
    let finish!: (value: BoundSessionLease) => void;
    let entered!: () => void;
    let underlying!: Promise<BoundSessionLease>;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const acquire = vi.fn(() => { underlying = new Promise((resolve) => { finish = resolve; }); entered(); return underlying; });
    const caller = new AbortController();
    f.release.mockImplementation(() => { throw new Error("late release failed"); });
    const outcomePromise = executeBoundAction(f.request, f.route, { deadlineMs: f.deadlineMs, signal: caller.signal, acquire });
    let outcome: Awaited<typeof outcomePromise> | undefined;
    try {
      await enteredPromise;
      caller.abort();
      outcome = await outcomePromise;
      expect(outcome).toMatchObject({ kind: "refusal", status: "cancelled" });
      finish(f.lease);
      await underlying;
      await expect(outcome.cleanup).resolves.toEqual({ state: "failed" });
      expect(f.release).toHaveBeenCalledTimes(1);
    } finally {
      if (finish!) finish(f.lease);
      await underlying;
      await outcomePromise;
      if (outcome) await outcome.cleanup;
    }
  });

  it("refuses rejected or null acquisitions", async () => {
    const f = await fixture();
    await expect(executeBoundAction(f.request, f.route, { deadlineMs: f.deadlineMs, acquire: async () => null })).resolves.toMatchObject({ kind: "refusal", status: "unavailable" });
    await expect(executeBoundAction(f.request, f.route, { deadlineMs: f.deadlineMs, acquire: async () => { throw new Error("acquisition failed"); } })).resolves.toMatchObject({ kind: "refusal", status: "unavailable" });
    expect(f.release).not.toHaveBeenCalled();
  });
});

function emptyRequest(): BoundActionRequest {
  return { operation: "codeActions", path: "/tmp/source.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } };
}
function emptyRoute() { return { projectRoot: "/tmp", languageId: "typescript", server: "typescript-language-server" }; }
