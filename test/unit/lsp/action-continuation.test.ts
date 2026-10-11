import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LSPConnection } from "../../../src/lsp/lsp-connection.js";
import { acquireBoundSession, cachedManager, sessionStore, _clearSessionStore, type SessionEntry } from "../../../src/lsp/lsp-manager.js";
import { canonicalProjectRoot } from "../../../src/lsp/lsp-session-key.js";
import { runBoundActionOperation, type BoundActionSession } from "../../../src/lsp/lsp-action-origin.js";
import { STAGEABLE_SEMANTIC_OPERATIONS, startBoundActionContinuation, type BoundActionStageResult, type StageableSemanticOperation } from "../../../src/lsp/lsp-action-continuation.js";
import type { PreparedDocumentReceipt } from "../../../src/lsp/lsp-document-store.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  _clearSessionStore();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

async function fixture(kind = "quickfix") {
  const root = canonicalProjectRoot(await mkdtemp(join(tmpdir(), "action-continuation-")));
  roots.push(root);
  const named = join(root, "source.ts");
  const bytes = Buffer.from("\uFEFFconst value = 1;\n", "utf8");
  await writeFile(named, bytes);
  const path = await realpath(named);
  const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
  const conn = new LSPConnection();
  const key = `${root}::typescript-server::continuation`;
  Reflect.set(conn, "sessionKey", key);
  conn.descriptorId = "typescript-server";
  conn.name = "TypeScript Server";
  conn.projectRoot = root;
  conn.languageIds = ["typescript"];
  vi.spyOn(conn, "getNegotiatedEncoding").mockReturnValue("utf-16");
  vi.spyOn(conn, "shutdown").mockImplementation(() => {});
  const receipt: PreparedDocumentReceipt = {
    canonicalPath: path, uri: pathToFileURL(path).href, version: 1, textHash: sha(text), mutationGeneration: 1, submissionStamp: 1,
    syncConfig: { openClose: true, change: "full" }, connectionId: "connection", transportId: "transport", storeId: "store", stateId: "state",
    descriptorId: conn.descriptorId, projectRoot: root, positionEncoding: "utf-16",
  };
  vi.spyOn(conn, "prepareDocument").mockResolvedValue(receipt);
  vi.spyOn(conn, "getDocumentReceipt").mockReturnValue(receipt);
  vi.spyOn(conn, "request").mockImplementation(async (method) => method === "textDocument/codeAction"
    ? [{ title: "Fix", kind, edit: { changes: { [pathToFileURL(path).href]: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "// fixed\n" }] } } }]
    : ({ title: "Fix", kind, edit: { changes: { [pathToFileURL(path).href]: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "// fixed\n" }] } } }));
  const entry: SessionEntry = { conn, fingerprint: "fp", descriptorId: conn.descriptorId, root, leases: 0, lastUsed: Date.now() };
  sessionStore.set(key, entry);
  const manager = cachedManager(root);
  vi.spyOn(manager, "getServer").mockResolvedValue(conn);
  const lease = await acquireBoundSession(root, "typescript");
  if (!lease) throw new Error("test lease unavailable");
  try {
    const server = { descriptorId: conn.descriptorId, name: conn.name, projectRoot: root, languageId: "typescript", positionEncoding: "utf-16" as const };
    const session: BoundActionSession = {
      conn, server, registered: (candidate) => candidate === conn && lease.isCurrent(), deadlineMs: Date.now() + 10_000,
    };
    const requestInput = { operation: "codeActions" as const, path, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, context: { diagnostics: [] } };
    const found = await runBoundActionOperation(requestInput, session);
    const selection = (found.envelope.result as Array<{ actionId: string; sourceSha256: string }>)[0]!;
    const resolved = await runBoundActionOperation({ ...requestInput, operation: "resolveCodeAction", selection }, session);
    if (!resolved.origin) throw new Error("test origin unavailable");
    return { root, path, bytes, conn, receipt, entry, key, lease, session, origin: resolved.origin };
  } catch (error) {
    lease.release();
    throw error;
  }
}

const staged = (): BoundActionStageResult => ({ kind: "staged", proposal: { proposalId: "proposal", files: ["source.ts"], diff: "diff" } });

describe("private bound-action continuation", () => {
  it("rechecks original cancellation at the bounded caller publisher", async () => {
    const f = await fixture();
    const caller = new AbortController();
    const start = Date.now();
    const lifecycle: { handle?: ReturnType<typeof startBoundActionContinuation> } = {};
    let cancellationQueued = false;
    const now = () => {
      if (lifecycle.handle?.isSettled() && !cancellationQueued) {
        cancellationQueued = true;
        queueMicrotask(() => caller.abort());
      }
      return start;
    };
    const handle = startBoundActionContinuation(f.origin, { ...f.session, signal: caller.signal, deadlineMs: start + 5_000, now }, async () => staged());
    lifecycle.handle = handle;
    try {
      const result = await handle.result;
      expect(cancellationQueued).toBe(true);
      expect(caller.signal.aborted).toBe(true);
      expect(result).toEqual({ kind: "refused", reason: "cancelled" });
    } finally { await handle.workSettled; f.lease.release(); }
  });
  it("does not publish a later proposal id than the one it validated", async () => {
    const f = await fixture();
    let reads = 0;
    const proposal = {
      get proposalId() { reads++; return reads <= 2 ? "validated" : ""; },
      files: ["source.ts"],
      diff: "diff",
    };
    const handle = startBoundActionContinuation(f.origin, f.session, async () => ({ kind: "staged", proposal }));
    try {
      const result = await handle.result;
      expect(reads).toBe(0);
      if (result.kind === "staged") expect(result.proposal.proposalId).toBe("validated");
      else expect(result.kind).toBe("refused");
    } finally { await handle.workSettled; f.lease.release(); }
  });

  it("does not publish staged data after proposal projection expires the budget", async () => {
    const f = await fixture();
    let time = Date.now();
    const deadlineMs = time + 5_000;
    let projectionObserved = false;
    const proposal = {
      proposalId: "proposal",
      files: ["source.ts"],
      get diff() { projectionObserved = true; time = deadlineMs; return "diff"; },
    };
    const handle = startBoundActionContinuation(f.origin, { ...f.session, deadlineMs, now: () => time }, async () => ({ kind: "staged", proposal }));
    try {
      const result = await handle.result;
      expect(result.kind).toBe("refused");
      expect(projectionObserved).toBe(false);
      if (projectionObserved) expect(result).toEqual({ kind: "refused", reason: "timeout" });
    } finally { await handle.workSettled; f.lease.release(); }
  });
});

describe("private bound-action continuation projection", () => {
  it("uses the live origin and same held lease, then publishes only the whitelisted projection", async () => {
    const f = await fixture("refactor.extract");
    let packet: Parameters<Parameters<typeof startBoundActionContinuation>[2]>[0] | undefined;
    const sourceFiles = ["source.ts"];
    const callbackResult: BoundActionStageResult = { kind: "staged", proposal: { proposalId: "proposal", files: sourceFiles, diff: "diff" } };
    const handle = startBoundActionContinuation(f.origin, f.session, async (input) => { packet = input; return callbackResult; });
    try {
      const result = await handle.result;
      expect(result).toEqual({ kind: "staged", proposal: { proposalId: "proposal", files: ["source.ts"], diff: "diff" } });
      expect(Object.isFrozen(packet)).toBe(true);
      expect(packet?.document.sha256).toBe(sha(f.bytes.toString("utf8")));
      expect(f.lease.isCurrent()).toBe(true);
      if (result.kind === "staged") expect(Reflect.set(result.proposal, "proposalId", "changed")).toBe(false);
      Reflect.set(callbackResult.proposal, "proposalId", "changed");
      sourceFiles[0] = "changed.ts";
      expect(result).toEqual({ kind: "staged", proposal: { proposalId: "proposal", files: ["source.ts"], diff: "diff" } });
    } finally { await Promise.all([handle.result, handle.workSettled]); f.lease.release(); }
    expect(f.lease.isCurrent()).toBe(false);
    expect(f.entry.leases).toBe(0);
  });

  it("uses captured budget and signal bindings while checking live lease currentness", async () => {
    const f = await fixture();
    const controller = new AbortController();
    const replacement = new AbortController();
    const now = () => Date.now();
    const deadlineMs = Date.now() + 10_000;
    const supplied: BoundActionSession = { ...f.session, signal: controller.signal, deadlineMs, now };
    let packet: Parameters<Parameters<typeof startBoundActionContinuation>[2]>[0] | undefined;
    const handle = startBoundActionContinuation(f.origin, supplied, async (input) => {
      packet = input;
      Reflect.set(supplied, "signal", replacement.signal);
      replacement.abort();
      Reflect.set(supplied, "deadlineMs", 0);
      Reflect.set(supplied, "now", () => Number.NaN);
      return staged();
    });
    try {
      expect(await handle.result).toMatchObject({ kind: "staged" });
      expect(packet?.deadlineMs).toBe(deadlineMs);
      expect(packet?.now).toBe(now);
      expect(packet?.originalSignal).toBe(controller.signal);
      expect(packet?.ownedSignal).not.toBe(controller.signal);
      expect(controller.signal.aborted).toBe(false);
    } finally { await Promise.all([handle.result, handle.workSettled]); f.lease.release(); }
  });

  it("refuses unsupported edits before invoking the stage callback", async () => {
    const f = await fixture();
    const origin = { ...f.origin, server: { ...f.origin.server, positionEncoding: "utf-8" as const } };
    const stage = vi.fn(async () => staged());
    const handle = startBoundActionContinuation(origin, f.session, stage);
    try {
      expect((await handle.result).kind).toBe("refused");
      expect(stage).not.toHaveBeenCalled();
    } finally { await handle.workSettled; f.lease.release(); }
  });

});

describe("private bound-action continuation revalidation", () => {
  it.each([
    { target: "source", when: "before" }, { target: "source", when: "during" },
    { target: "receipt", when: "before" }, { target: "receipt", when: "during" },
    { target: "entry", when: "before" }, { target: "entry", when: "during" },
  ] as const)("refuses a changed $target $when staging", async ({ target, when }) => {
    const f = await fixture();
    const mutate = async () => {
      if (target === "source") await writeFile(f.path, "changed source\n");
      else if (target === "receipt") Reflect.set(f.receipt, "mutationGeneration", f.receipt.mutationGeneration + 1);
      else sessionStore.set(f.key, { ...f.entry, leases: f.entry.leases });
    };
    if (when === "before") await mutate();
    let stageCalls = 0;
    const handle = startBoundActionContinuation(f.origin, f.session, async () => {
      stageCalls++;
      if (when === "during") await mutate();
      return staged();
    });
    try {
      expect((await handle.result).kind).toBe("refused");
      expect(stageCalls).toBe(when === "during" ? 1 : 0);
      if (when === "during") expect(f.lease.isCurrent()).toBe(target !== "entry");
    } finally {
      await Promise.all([handle.result, handle.workSettled]);
      f.lease.release();
    }
  });

  it("refuses command, disabled, no-edit, and unsupported document-version actions before staging", async () => {
    const f = await fixture();
    const commandOrigin = { ...f.origin, originalAction: { title: "Fix", kind: "quickfix", command: { title: "Run", command: "run" } } };
    const disabledOrigin = { ...f.origin, originalAction: { title: "Fix", kind: "quickfix", disabled: { reason: "disabled" } } };
    const noEditOrigin = { ...f.origin, resolvedAction: { title: "Fix", kind: "quickfix" } };
    const versionOrigin = {
      ...f.origin,
      resolvedAction: {
        title: "Fix", kind: "quickfix",
        edit: { documentChanges: [{
          textDocument: { uri: pathToFileURL(f.path).href, version: f.receipt.version + 1 },
          edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "changed" }],
        }] },
      },
    };
    const stage = vi.fn(async () => staged());
    try {
      for (const origin of [commandOrigin, disabledOrigin, noEditOrigin, versionOrigin]) {
        const handle = startBoundActionContinuation(origin, f.session, stage);
        try { expect((await handle.result).kind).toBe("refused"); }
        finally { await Promise.all([handle.result, handle.workSettled]); }
      }
      expect(stage).not.toHaveBeenCalled();
    } finally { f.lease.release(); }
  });

  it.each(["staged", "refused", "throw", "malformed"] as const)("controls callback outcome: %s", async (mode) => {
    const f = await fixture();
    const handle = startBoundActionContinuation(f.origin, f.session, async () => {
      if (mode === "throw") throw new Error("private failure");
      if (mode === "malformed") return { kind: "staged", proposal: { proposalId: "", files: ["source.ts"], diff: "" } };
      return mode === "staged" ? staged() : { kind: "refused", reason: "unsupported" };
    });
    try {
      const outcome = await handle.result;
      expect(outcome.kind).toBe(mode === "staged" ? "staged" : "refused");
    } finally { await handle.workSettled; f.lease.release(); }
  });

  it("refuses pre-aborted and expired budgets before invoking the callback", async () => {
    const f = await fixture();
    const stage = vi.fn(async () => staged());
    const controller = new AbortController();
    controller.abort();
    const cancelled = startBoundActionContinuation(f.origin, { ...f.session, signal: controller.signal }, stage);
    const expired = startBoundActionContinuation(f.origin, { ...f.session, deadlineMs: 0, now: () => 0 }, stage);
    try {
      expect(await cancelled.result).toEqual({ kind: "refused", reason: "cancelled" });
      expect(await expired.result).toEqual({ kind: "refused", reason: "timeout" });
      expect(stage).not.toHaveBeenCalled();
    } finally {
      await Promise.all([cancelled.workSettled, expired.workSettled]);
      f.lease.release();
    }
  });

  it("refuses an unusable clock before invoking the callback", async () => {
    const f = await fixture();
    const stage = vi.fn(async () => staged());
    const handle = startBoundActionContinuation(f.origin, { ...f.session, now: () => Number.NaN }, stage);
    try {
      expect((await handle.result).kind).toBe("refused");
      expect(stage).not.toHaveBeenCalled();
    } finally { await handle.workSettled; f.lease.release(); }
  });

});

describe("private bound-action continuation lifetime", () => {
  it("bounds the caller on original cancellation but retains work and lease until callback settles", async () => {
    const f = await fixture();
    const controller = new AbortController();
    let finish!: (value: BoundActionStageResult) => void;
    let enter!: () => void;
    let stageCalls = 0;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const callback = new Promise<BoundActionStageResult>((resolve) => { finish = resolve; });
    const handle = startBoundActionContinuation(f.origin, { ...f.session, signal: controller.signal }, () => {
      stageCalls++;
      enter();
      return callback;
    });
    let callbackSettled = false;
    try {
      await entered;
      expect(stageCalls).toBe(1);
      expect(f.lease.isCurrent()).toBe(true);
      expect(handle.isSettled()).toBe(false);
      controller.abort();
      expect(await handle.result).toEqual({ kind: "refused", reason: "cancelled" });
      expect(handle.isSettled()).toBe(false);
      expect(f.lease.isCurrent()).toBe(true);
    } finally {
      if (!callbackSettled) { finish(staged()); callbackSettled = true; }
      await Promise.all([handle.result, handle.workSettled]);
      f.lease.release();
    }
    expect(handle.isSettled()).toBe(true);
    expect(f.lease.isCurrent()).toBe(false);
  });

  it("bounds on deadline without aborting the original signal and observes late callback rejection", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let f: Awaited<ReturnType<typeof fixture>> | undefined;
    let handle: ReturnType<typeof startBoundActionContinuation> | undefined;
    let reject: ((reason: Error) => void) | undefined;
    let callbackSettled = false;
    try {
      f = await fixture();
      const controller = new AbortController();
      let started!: () => void;
      const entered = new Promise<void>((resolve) => { started = resolve; });
      const callback = new Promise<BoundActionStageResult>((_resolve, fail) => { reject = fail; });
      handle = startBoundActionContinuation(f.origin, { ...f.session, signal: controller.signal, deadlineMs: 10, now: Date.now }, () => { started(); return callback; });
      await entered;
      expect(f.lease.isCurrent()).toBe(true);
      expect(handle.isSettled()).toBe(false);
      await vi.advanceTimersByTimeAsync(10);
      expect((await handle.result).kind).toBe("refused");
      expect(controller.signal.aborted).toBe(false);
      expect(handle.isSettled()).toBe(false);
      reject?.(new Error("late private failure"));
      callbackSettled = true;
    } finally {
      if (!callbackSettled) { reject?.(new Error("test cleanup")); callbackSettled = true; }
      if (handle) await Promise.all([handle.result, handle.workSettled]);
      f?.lease.release();
      vi.useRealTimers();
    }
  });
});

describe("private bound-action continuation stageable operations", () => {
  it.each(STAGEABLE_SEMANTIC_OPERATIONS)("carries %s on the packet handed to the stage callback", async (operation) => {
    const f = await fixture();
    const seen: string[] = [];
    const handle = startBoundActionContinuation(f.origin, f.session, async (packet) => { seen.push(packet.operation); return staged(); }, operation);
    try {
      expect(await handle.result).toEqual({ kind: "staged", proposal: { proposalId: "proposal", files: ["source.ts"], diff: "diff" } });
      expect(seen).toEqual([operation]);
    } finally { await handle.workSettled; f.lease.release(); }
  });

  it("defaults to resolveCodeAction when no operation is supplied", async () => {
    const f = await fixture();
    const seen: string[] = [];
    const handle = startBoundActionContinuation(f.origin, f.session, async (packet) => { seen.push(packet.operation); return staged(); });
    try {
      await handle.result;
      expect(seen).toEqual(["resolveCodeAction"]);
    } finally { await handle.workSettled; f.lease.release(); }
  });

  it.each(["codeActions", "definition", ""])("refuses unknown operation %j as unsupported without calling stage", async (operation) => {
    const f = await fixture();
    const stage = vi.fn(async () => staged());
    const handle = startBoundActionContinuation(f.origin, f.session, stage, operation as unknown as StageableSemanticOperation);
    try {
      expect(await handle.result).toEqual({ kind: "refused", reason: "unsupported" });
      expect(stage).not.toHaveBeenCalled();
    } finally { await handle.workSettled; f.lease.release(); }
  });
});
