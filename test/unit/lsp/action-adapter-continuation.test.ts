import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeBoundAction } from "../../../src/lsp/lsp-action-adapter.js";
import type { BoundActionRequest } from "../../../src/lsp/lsp-action-origin.js";
import { LSPConnection } from "../../../src/lsp/lsp-connection.js";
import type { PreparedDocumentReceipt } from "../../../src/lsp/lsp-document-store.js";
import { cachedManager, sessionStore, type SessionEntry } from "../../../src/lsp/lsp-manager.js";
import type { BoundActionStageResult } from "../../../src/lsp/lsp-action-continuation.js";

const roots: string[] = [];
const keys: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const key of keys.splice(0)) sessionStore.delete(key);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const action = (path: string) => ({ title: "Fix", kind: "quickfix", data: { retained: true }, edit: { changes: { [pathToFileURL(path).href]: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "// fixed\n" }] } } });
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "adapter-continuation-")));
  roots.push(root);
  const namedPath = join(root, "source.ts");
  const bytes = Buffer.from("\uFEFFconst value = 1;\n", "utf8");
  await writeFile(namedPath, bytes);
  const path = await realpath(namedPath);
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  const descriptorId = "adapter-continuation-typescript";
  const conn = new LSPConnection();
  conn.descriptorId = descriptorId;
  conn.name = "TypeScript";
  conn.projectRoot = root;
  conn.languageIds = ["typescript"];
  vi.spyOn(conn, "getNegotiatedEncoding").mockReturnValue("utf-16");
  vi.spyOn(conn, "shutdown").mockImplementation(() => {});
  const receipt: PreparedDocumentReceipt = {
    canonicalPath: path, uri: pathToFileURL(path).href, version: 1, textHash: sha(text), mutationGeneration: 1, submissionStamp: 1,
    syncConfig: { openClose: true, change: "full" }, connectionId: "conn", transportId: "transport", storeId: "store", stateId: "state",
    descriptorId, projectRoot: root, positionEncoding: "utf-16",
  };
  vi.spyOn(conn, "prepareDocument").mockResolvedValue(receipt);
  vi.spyOn(conn, "getDocumentReceipt").mockReturnValue(receipt);
  const rawAction = action(path);
  const wires: string[] = [];
  vi.spyOn(conn, "request").mockImplementation(async (method) => {
    wires.push(method);
    return method === "textDocument/codeAction" ? [rawAction] : rawAction;
  });
  const key = `${root}::${descriptorId}::continuation-test`;
  keys.push(key);
  Reflect.set(conn, "sessionKey", key);
  const entry: SessionEntry = { conn, fingerprint: "adapter-continuation-test", descriptorId, root, leases: 0, lastUsed: Date.now() };
  sessionStore.set(key, entry);
  const manager = cachedManager(root);
  vi.spyOn(manager, "getServer").mockResolvedValue(conn);
  const route = { projectRoot: root, languageId: "typescript", server: descriptorId };
  const request: BoundActionRequest = { operation: "codeActions", path, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, context: { diagnostics: [] } };
  const deadlineMs = Date.now() + 30_000;
  const found = await executeBoundAction(request, route, { deadlineMs });
  if (found.kind !== "result") throw new Error("discovery failed");
  const selected = (found.envelope.result as Array<{ actionId: string; sourceSha256: string }>)[0]!;
  await found.cleanup;
  return { root, path, bytes, text, conn, receipt, entry, route, request, selected, wires, deadlineMs };
}
function selectedRequest(f: Fixture): BoundActionRequest {
  return { ...f.request, operation: "resolveCodeAction", selection: f.selected };
}
const staged = (): BoundActionStageResult => ({ kind: "staged", proposal: { proposalId: "proposal-1", files: ["source.ts"], diff: "diff" } });

const integrations = [
  ["leaves discovery as an engine result without staging", async () => {
    const f = await fixture();
    const result = await executeBoundAction(f.request, f.route, { deadlineMs: f.deadlineMs, stage: async () => staged() });
    expect(result).toMatchObject({ kind: "result", envelope: { status: "ok" } });
    expect(result).not.toHaveProperty("proposal");
    expect(f.wires).toEqual(["textDocument/codeAction", "textDocument/codeAction"]);
    await expect(result.cleanup).resolves.toEqual({ state: "released" });
  }],
  ["stages only an explicitly selected successful resolve and publishes a frozen projection", async () => {
    const f = await fixture();
    let enteredPacket: Parameters<NonNullable<Parameters<typeof executeBoundAction>[2]["stage"]>>[0] | undefined;
    const result = await executeBoundAction(selectedRequest(f), f.route, { deadlineMs: f.deadlineMs, stage: async (packet) => { enteredPacket = packet; expect(f.entry.leases).toBe(1); return staged(); } });
    expect(result).toMatchObject({ kind: "result", proposal: { proposalId: "proposal-1", files: ["source.ts"], diff: "diff" } });
    expect(Object.isFrozen(enteredPacket)).toBe(true);
    expect(enteredPacket?.document.sha256).toBe(sha(f.bytes));
    expect(enteredPacket?.serverDescriptor).toMatchObject({ descriptorId: "adapter-continuation-typescript" });
    expect(result).not.toHaveProperty("origin");
    expect(f.wires.at(-1)).toBe("codeAction/resolve");
    await expect(result.cleanup).resolves.toEqual({ state: "released" });
    expect(f.entry.leases).toBe(0);
  }],
  ["keeps a resolve without a configured stage as an accepted engine result", async () => {
    const f = await fixture();
    const result = await executeBoundAction(selectedRequest(f), f.route, { deadlineMs: f.deadlineMs });
    expect(result).toMatchObject({ kind: "result", envelope: { status: "ok" } });
    expect(result).not.toHaveProperty("proposal");
    await result.cleanup;
  }],
  ["maps a stage callback refusal to unsupported", async () => {
    const f = await fixture();
    const result = await executeBoundAction(selectedRequest(f), f.route, { deadlineMs: f.deadlineMs, stage: async () => ({ kind: "refused", reason: "unsupported" }) });
    expect(result).toMatchObject({ kind: "refusal", status: "unsupported" });
    await result.cleanup;
  }],
  ["contains a stage callback rejection as a controlled refusal", async () => {
    const f = await fixture();
    const result = await executeBoundAction(selectedRequest(f), f.route, { deadlineMs: f.deadlineMs, stage: async () => { throw new Error("private callback failure"); } });
    expect(result).toMatchObject({ kind: "refusal", status: "unavailable" });
    await result.cleanup;
  }],
  ["refuses a source changed before stage and does not call stage", async () => {
    const f = await fixture();
    await writeFile(f.path, "changed\n");
    const stage = vi.fn(async () => staged());
    const result = await executeBoundAction(selectedRequest(f), f.route, { deadlineMs: f.deadlineMs, stage });
    expect(result).toMatchObject({ kind: "result", envelope: { status: "not_ready", result: null } });
    expect(stage).not.toHaveBeenCalled();
    await result.cleanup;
  }],
  ["refuses source changes made during stage before publishing a proposal", async () => {
    const f = await fixture();
    const result = await executeBoundAction(selectedRequest(f), f.route, { deadlineMs: f.deadlineMs, stage: async () => { await writeFile(f.path, "changed during stage\\n"); return staged(); } });
    expect(result).toMatchObject({ kind: "refusal", status: "not_ready" });
    await result.cleanup;
  }],
  ["refuses receipt replacement during stage before publishing a proposal", async () => {
    const f = await fixture();
    const result = await executeBoundAction(selectedRequest(f), f.route, { deadlineMs: f.deadlineMs, stage: async () => { Reflect.set(f.receipt, "mutationGeneration", 2); return staged(); } });
    expect(result).toMatchObject({ kind: "refusal", status: "not_ready" });
    await result.cleanup;
  }],
  ["refuses manager-entry replacement during stage before publishing a proposal", async () => {
    const f = await fixture();
    const result = await executeBoundAction(selectedRequest(f), f.route, { deadlineMs: f.deadlineMs, stage: async () => { sessionStore.set(`${f.root}::adapter-continuation-typescript::continuation-test`, { ...f.entry }); return staged(); } });
    expect(result).toMatchObject({ kind: "refusal", status: "not_ready" });
    await result.cleanup;
  }],
  ["holds the exact lease and pending cleanup after cancellation until stage settles", async () => {
    const f = await fixture();
    const caller = new AbortController();
    let finish!: (value: BoundActionStageResult) => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const callback = new Promise<BoundActionStageResult>((resolve) => { finish = resolve; });
    const outcomePromise = executeBoundAction(selectedRequest(f), f.route, { deadlineMs: f.deadlineMs, signal: caller.signal, stage: () => { entered(); return callback; } });
    let outcome: Awaited<typeof outcomePromise> | undefined;
    try {
      await enteredPromise;
      caller.abort();
      outcome = await outcomePromise;
      expect(outcome).toMatchObject({ kind: "refusal", status: "cancelled" });
      expect(f.entry.leases).toBe(1);
      let cleanupSettled = false;
      void outcome.cleanup.then(() => { cleanupSettled = true; });
      await Promise.resolve();
      expect(cleanupSettled).toBe(false);
      finish(staged());
      await expect(outcome.cleanup).resolves.toEqual({ state: "released" });
      expect(f.entry.leases).toBe(0);
    } finally {
      if (finish) finish(staged());
      const settledOutcome = outcome ?? await outcomePromise;
      await settledOutcome.cleanup;
    }
  }],
  ["releases normally settled work once before publishing the proposal", async () => {
    const f = await fixture();
    const release = vi.spyOn(f.conn, "shutdown");
    const result = await executeBoundAction(selectedRequest(f), f.route, { deadlineMs: f.deadlineMs, stage: async () => staged() });
    expect(result).toMatchObject({ kind: "result", proposal: { proposalId: "proposal-1" } });
    expect(f.entry.leases).toBe(0);
    expect(release).not.toHaveBeenCalled();
    await expect(result.cleanup).resolves.toEqual({ state: "released" });
  }],
  ["reports a synchronous lease-release failure after settled stage work", async () => {
    const f = await fixture();
    const result = await executeBoundAction(selectedRequest(f), f.route, { deadlineMs: f.deadlineMs, now: () => 1, stage: async () => { vi.spyOn(Date, "now").mockImplementation(() => { throw new Error("lease release failed"); }); return staged(); } });
    expect(result).toMatchObject({ kind: "refusal", status: "unavailable" });
    await expect(result.cleanup).resolves.toEqual({ state: "failed" });
    f.entry.leases = 0;
  }],
  ["contains a late lease-release exception after cancelled pending stage work", async () => {
    const f = await fixture();
    const caller = new AbortController();
    let finish!: (value: BoundActionStageResult) => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const callback = new Promise<BoundActionStageResult>((resolve) => { finish = resolve; });
    const outcomePromise = executeBoundAction(selectedRequest(f), f.route, { deadlineMs: f.deadlineMs, now: () => 1, signal: caller.signal, stage: () => { entered(); return callback; } });
    let outcome: Awaited<typeof outcomePromise> | undefined;
    try {
      await enteredPromise;
      vi.spyOn(Date, "now").mockImplementation(() => { throw new Error("late lease release failed"); });
      caller.abort();
      outcome = await outcomePromise;
      expect(outcome).toMatchObject({ kind: "refusal", status: "cancelled" });
      finish(staged());
      await expect(outcome.cleanup).resolves.toEqual({ state: "failed" });
      expect(f.entry.leases).toBe(0);
    } finally {
      if (finish) finish(staged());
      const settledOutcome = outcome ?? await outcomePromise;
      await settledOutcome.cleanup;
      vi.restoreAllMocks();
    }
  }],
  ["times out promptly while stage remains pending and cleans up only after it settles", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const f = await fixture();
    const deadlineMs = 10;
    let finish!: (value: BoundActionStageResult) => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const callback = new Promise<BoundActionStageResult>((resolve) => { finish = resolve; });
    const outcomePromise = executeBoundAction(selectedRequest(f), f.route, { deadlineMs, now: Date.now, stage: () => { entered(); return callback; } });
    let outcome: Awaited<typeof outcomePromise> | undefined;
    try {
      await enteredPromise;
      await vi.advanceTimersByTimeAsync(deadlineMs);
      outcome = await outcomePromise;
      expect(outcome).toMatchObject({ kind: "refusal", status: "timeout" });
      expect(f.entry.leases).toBe(1);
      finish(staged());
      await expect(outcome.cleanup).resolves.toEqual({ state: "released" });
      expect(f.entry.leases).toBe(0);
    } finally {
      if (finish) finish(staged());
      const settledOutcome = outcome ?? await outcomePromise;
      await settledOutcome.cleanup;
      vi.useRealTimers();
    }
  }],
  ["preserves caller cancellation priority when publication callback aborts", async () => {
    const f = await fixture();
    const caller = new AbortController();
    let once = false;
    const result = await executeBoundAction(selectedRequest(f), f.route, { deadlineMs: f.deadlineMs, signal: caller.signal, now: () => { if (!once) { once = true; queueMicrotask(() => caller.abort()); } return Date.now(); }, stage: async () => staged() });
    expect(result).toMatchObject({ kind: "refusal", status: "cancelled" });
    await result.cleanup;
  }],
  ["classifies an admitted invocation clock failure as unavailable without acquisition", async () => {
    const f = await fixture();
    let reads = 0;
    const acquire = vi.fn();
    const result = await executeBoundAction(selectedRequest(f), f.route, { deadlineMs: f.deadlineMs, now: () => ++reads === 1 ? Date.now() : Number.NaN, acquire });
    expect(result).toMatchObject({ kind: "refusal", status: "unavailable" });
    expect(acquire).not.toHaveBeenCalled();
    await result.cleanup;
  }],
  ["rejects pre-aborted invocations without acquiring or staging", async () => {
    const f = await fixture();
    const caller = new AbortController(); caller.abort();
    const acquire = vi.fn();
    const stage = vi.fn(async () => staged());
    const result = await executeBoundAction(selectedRequest(f), f.route, { deadlineMs: f.deadlineMs, signal: caller.signal, acquire, stage });
    expect(result).toMatchObject({ kind: "refusal", status: "cancelled" });
    expect(acquire).not.toHaveBeenCalled();
    expect(stage).not.toHaveBeenCalled();
    await result.cleanup;
  }],
] as const;

describe("executeBoundAction private continuation integration", () => {
  it("prioritizes original cancellation introduced by an invalid entry clock", async () => {
    const f = await fixture();
    const caller = new AbortController();
    const acquire = vi.fn();
    const result = await executeBoundAction(selectedRequest(f), f.route, {
      deadlineMs: f.deadlineMs, signal: caller.signal, acquire,
      now: () => { caller.abort(); return Infinity; },
    });
    expect(result).toMatchObject({ kind: "refusal", status: "cancelled" });
    expect(acquire).not.toHaveBeenCalled();
    await result.cleanup;
  });

  it("retains a continuation's known timeout over an outer clock failure", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const f = await fixture();
    let armed = false;
    let armedClockReads = 0;
    let enter!: () => void;
    let finish!: (value: BoundActionStageResult) => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const callback = new Promise<BoundActionStageResult>((resolve) => { finish = resolve; });
    const now = () => {
      if (armed && ++armedClockReads === 1) return NaN;
      return Date.now();
    };
    const pending = executeBoundAction(selectedRequest(f), f.route, {
      deadlineMs: 10, now, stage: () => { enter(); return callback; },
    });
    try {
      await entered;
      armed = true;
      await vi.advanceTimersByTimeAsync(10);
      const result = await pending;
      expect(armedClockReads).toBeGreaterThan(1);
      expect(result).toMatchObject({ kind: "refusal", status: "timeout" });
      expect(f.entry.leases).toBe(1);
    } finally {
      finish(staged());
      const result = await pending;
      await callback;
      await result.cleanup;
      vi.useRealTimers();
    }
  });
  it("retains an engine's known timeout over an outer clock failure", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const f = await fixture();
    let armed = false;
    let clockReads = 0;
    let enter!: () => void;
    let rejectRequest!: (error: Error) => void;
    let requestSignal: AbortSignal | undefined;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const requestWork = new Promise<never>((_resolve, reject) => { rejectRequest = reject; });
    const requestSettled = requestWork.catch(() => undefined);
    const onAbort = () => rejectRequest(new Error("local request withdrawn"));
    vi.mocked(f.conn.request).mockImplementation(async (_method, _params, options) => {
      requestSignal = options?.signal;
      requestSignal?.addEventListener("abort", onAbort, { once: true });
      enter();
      return requestWork;
    });
    const pending = executeBoundAction(selectedRequest(f), f.route, {
      deadlineMs: 10,
      now: () => armed && ++clockReads === 1 ? NaN : Date.now(),
    });
    try {
      await entered;
      armed = true;
      await vi.advanceTimersByTimeAsync(10);
      const result = await pending;
      expect(requestSignal?.aborted).toBe(true);
      expect(clockReads).toBeGreaterThan(1);
      expect(result).toMatchObject({ kind: "refusal", status: "timeout" });
    } finally {
      rejectRequest(new Error("test cleanup"));
      await requestSettled;
      requestSignal?.removeEventListener("abort", onAbort);
      const result = await pending;
      await result.cleanup;
      vi.useRealTimers();
    }
  });

  it("refuses raw edit annotation semantics before invoking the stage callback", async () => {
    const f = await fixture();
    const raw = action(f.path);
    const annotated = { ...raw, edit: { ...raw.edit, changeAnnotations: { confirm: { label: "Confirm", needsConfirmation: true } } } };
    vi.mocked(f.conn.request).mockImplementation(async (method) => method === "textDocument/codeAction" ? [annotated] : annotated);
    const found = await executeBoundAction(f.request, f.route, { deadlineMs: f.deadlineMs });
    try {
      expect(found).toMatchObject({ kind: "result", envelope: { status: "ok" } });
      if (found.kind !== "result") throw new Error("annotated action discovery failed");
      expect(found.envelope.result).toEqual([expect.objectContaining({ actionId: expect.any(String), sourceSha256: expect.any(String) })]);
      const selection = (found.envelope.result as Array<{ actionId: string; sourceSha256: string }>)[0]!;
      const stage = vi.fn(async () => staged());
      const result = await executeBoundAction({ ...selectedRequest(f), selection }, f.route, { deadlineMs: f.deadlineMs, stage });
      try {
        expect(result).toMatchObject({ kind: "refusal", status: "unsupported" });
        expect(stage).not.toHaveBeenCalled();
      } finally {
        await result.cleanup;
      }
    } finally {
      await found.cleanup;
    }
  });
  it.each(integrations)("%s", async (_name, run) => { await run(); });
});
