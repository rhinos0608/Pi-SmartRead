import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RPC_CHANNELS,
  WORKSPACE_EDIT_RPC_METHODS,
  createRpcServer,
  validateEventMessage,
} from "@rhinos0608/pi-workspace-protocol";
import type { BusLike } from "../../../src/lsp/lsp-workspace-edit.js";
import { createBoundActionStageRequester } from "../../../src/lsp/lsp-action-stage-rpc.js";
import { STAGEABLE_SEMANTIC_OPERATIONS } from "../../../src/lsp/lsp-action-continuation.js";
import { createBoundActionBudget } from "../../../src/lsp/lsp-action-origin.js";
import type { BoundActionContinuationPacket } from "../../../src/lsp/lsp-action-continuation.js";

class EventBus implements BusLike {
  readonly listeners = new Map<string, Set<(value: unknown) => void>>();
  emit(channel: string, data: unknown): void { for (const listener of [...(this.listeners.get(channel) ?? [])]) listener(data); }
  on(channel: string, handler: (data: unknown) => void): () => void {
    const listeners = this.listeners.get(channel) ?? new Set();
    this.listeners.set(channel, listeners);
    listeners.add(handler);
    return () => { listeners.delete(handler); };
  }
  count(channel: string): number { return this.listeners.get(channel)?.size ?? 0; }
}

const edit = Object.freeze({ positionEncoding: "utf-16" as const, fileEdits: Object.freeze([Object.freeze({
  filePath: "/outside/project/source.ts", edits: Object.freeze([{ filePath: "/outside/project/source.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "x" }]),
})]) });
function packet(now: () => number, originalSignal?: AbortSignal, ownedSignal = new AbortController().signal): BoundActionContinuationPacket {
  return Object.freeze({ prepared: edit, document: Object.freeze({ canonicalPath: "/outside/project/source.ts", sha256: "a".repeat(64) }),
    serverDescriptor: Object.freeze({ descriptorId: "descriptor", name: "server", languageId: "typescript", projectRoot: "/project", positionEncoding: "utf-16" as const }),
    operation: "resolveCodeAction" as const, deadlineMs: 100, now, ...(originalSignal ? { originalSignal } : {}), ownedSignal });
}
afterEach(() => { vi.useRealTimers(); });

describe("createBoundActionStageRequester", () => {
  it("does not accept hidden malformed file entries through a volatile array length", async () => {
    const bus = new EventBus();
    const files = new Proxy([42], {
      get(target, key, receiver) { return key === "length" ? 0 : Reflect.get(target, key, receiver); },
    });
    const server = createRpcServer({ bus, channel: RPC_CHANNELS.workspaceEdit, handler: async () => ({ ok: true, proposalId: "p", files, diff: "d" }) });
    const pending = createBoundActionStageRequester({ bus, sessionFilePath: "/session", cwd: "/project" })(packet(() => 1));
    try {
      expect(await pending).toEqual({ kind: "refused", reason: "unavailable" });
    } finally {
      await pending;
      server.dispose();
    }
  });
  it("classifies a linked owned deadline as timeout and awaits actual late reply delivery", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const bus = new EventBus();
    let enter!: () => void;
    let release!: () => void;
    let deliver!: () => void;
    let handlerWork: Promise<unknown> | undefined;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const delivered = new Promise<void>((resolve) => { deliver = resolve; });
    const observe = bus.on(RPC_CHANNELS.workspaceEdit, (raw) => {
      const parsed = validateEventMessage(raw);
      if (parsed.ok && parsed.value.kind === "reply") deliver();
    });
    const server = createRpcServer({ bus, channel: RPC_CHANNELS.workspaceEdit, handler: () => {
      handlerWork = (async () => { enter(); await gate; return { ok: true, proposalId: "late", files: [], diff: "late" }; })();
      return handlerWork;
    } });
    const budget = createBoundActionBudget(100, undefined, Date.now);
    const requester = createBoundActionStageRequester({ bus, sessionFilePath: "/session", cwd: "/project" });
    const pending = requester(packet(Date.now, undefined, budget.signal));
    try {
      await Promise.race([entered, pending.then(() => { throw new Error("request settled before handler entry"); })]);
      await vi.advanceTimersByTimeAsync(100);
      expect(budget.signal.aborted).toBe(true);
      expect(await pending).toEqual({ kind: "refused", reason: "timeout" });
      expect(bus.count(RPC_CHANNELS.workspaceEdit)).toBe(2);
    } finally {
      release();
      await gate;
      if (handlerWork) { await handlerWork; await delivered; }
      await pending;
      budget.dispose();
      server.dispose();
      observe();
      vi.useRealTimers();
    }
    expect(bus.count(RPC_CHANNELS.workspaceEdit)).toBe(0);
  });
  it("prioritizes original cancellation raised by the first clock callback", async () => {
    const bus = new EventBus();
    const emit = vi.spyOn(bus, "emit");
    const original = new AbortController();
    const requester = createBoundActionStageRequester({ bus, sessionFilePath: "/session", cwd: "/project" });
    const result = await requester(packet(() => { original.abort(); return 100; }, original.signal));
    expect(result).toEqual({ kind: "refused", reason: "cancelled" });
    expect(emit).not.toHaveBeenCalled();
  });

  it("prioritizes original cancellation raised by the remaining-budget clock callback", async () => {
    const bus = new EventBus();
    const emit = vi.spyOn(bus, "emit");
    const original = new AbortController();
    let clockReads = 0;
    const now = () => {
      if (++clockReads === 2) { original.abort(); throw new Error("clock unavailable"); }
      return 1;
    };
    const requester = createBoundActionStageRequester({ bus, sessionFilePath: "/session", cwd: "/project" });
    const result = await requester(packet(now, original.signal));
    expect(result).toEqual({ kind: "refused", reason: "cancelled" });
    expect(emit).not.toHaveBeenCalled();
  });

  it.each(["cancelled", "timeout"] as const)("rechecks %s after reply descriptor projection", async (reason) => {
    const bus = new EventBus();
    const original = new AbortController();
    let current = 1;
    const payload = new Proxy({ ok: true, proposalId: "p", files: [], diff: "d" }, {
      getOwnPropertyDescriptor(target, key) {
        if (key === "diff") {
          if (reason === "cancelled") original.abort();
          else current = 100;
        }
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    const server = createRpcServer({ bus, channel: RPC_CHANNELS.workspaceEdit, handler: async () => payload });
    const requester = createBoundActionStageRequester({ bus, sessionFilePath: "/session", cwd: "/project" });
    const pending = requester(packet(() => current, original.signal));
    try {
      expect(await pending).toEqual({ kind: "refused", reason });
    } finally {
      await pending;
      server.dispose();
    }
  });

  it("rechecks original cancellation after RPC client disposal", async () => {
    const bus = new EventBus();
    const original = new AbortController();
    const server = createRpcServer({ bus, channel: RPC_CHANNELS.workspaceEdit, handler: async () => ({ ok: true, proposalId: "p", files: [], diff: "d" }) });
    const subscribe = bus.on.bind(bus);
    vi.spyOn(bus, "on").mockImplementation((channel, handler) => {
      const unsubscribe = subscribe(channel, handler);
      return () => { original.abort(); unsubscribe(); };
    });
    const requester = createBoundActionStageRequester({ bus, sessionFilePath: "/session", cwd: "/project" });
    const pending = requester(packet(() => 1, original.signal));
    try {
      expect(await pending).toEqual({ kind: "refused", reason: "cancelled" });
    } finally {
      await pending;
      server.dispose();
      vi.restoreAllMocks();
    }
  });
  it("sends only the exact stage payload with captured identity and preserves the prepared edit", async () => {
    const bus = new EventBus();
    const captured: unknown[] = [];
    const server = createRpcServer({ bus, channel: RPC_CHANNELS.workspaceEdit, handler: async (request) => {
      captured.push(request);
      return { ok: true, proposalId: "p1", files: ["/outside/project/source.ts"], diff: "diff" };
    } });
    const context = { bus, sessionFilePath: "/session/captured.jsonl", cwd: "/project" };
    const requester = createBoundActionStageRequester(context);
    context.sessionFilePath = "/session/changed.jsonl";
    context.cwd = "/changed";
    const result = await requester(packet(() => 1));
    expect(result).toEqual({ kind: "staged", proposal: { proposalId: "p1", files: ["/outside/project/source.ts"], diff: "diff" } });
    expect(Object.isFrozen(result)).toBe(true);
    const request = captured[0] as { rpc: string; payload: Record<string, unknown> };
    expect(request.rpc).toBe(WORKSPACE_EDIT_RPC_METHODS.stage);
    expect(request.payload).toEqual({ workspaceEdit: edit, source: { operation: "resolveCodeAction", serverDescriptorId: "descriptor", document: { canonicalPath: "/outside/project/source.ts", sha256: "a".repeat(64) } }, sessionFilePath: "/session/captured.jsonl", cwd: "/project" });
    expect(Object.keys(request.payload).sort()).toEqual(["cwd", "sessionFilePath", "source", "workspaceEdit"]);
    expect(bus.count(RPC_CHANNELS.workspaceEdit)).toBe(1);
    server.dispose();
    expect(bus.count(RPC_CHANNELS.workspaceEdit)).toBe(0);
  });

  it("refuses without emitting on invalid packet or expired, cancelled, or invalid clock", async () => {
    const bus = new EventBus();
    const requester = createBoundActionStageRequester({ bus, sessionFilePath: "/session", cwd: "/project" });
    const cancelled = new AbortController(); cancelled.abort();
    expect(await requester(packet(() => 1, cancelled.signal))).toEqual({ kind: "refused", reason: "cancelled" });
    expect(await requester(packet(() => 100))).toEqual({ kind: "refused", reason: "timeout" });
    expect(await requester(packet(() => Number.NaN))).toEqual({ kind: "refused", reason: "unavailable" });
    expect(await requester({ ...packet(() => 1), operation: "codeActions" } as unknown as BoundActionContinuationPacket)).toEqual({ kind: "refused", reason: "unavailable" });
    expect(bus.count(RPC_CHANNELS.workspaceEdit)).toBe(0);
  });

  it("detaches projection and treats malformed and accessor-backed replies as unavailable", async () => {
    const bus = new EventBus();
    let mode = "valid";
    const files = ["f"];
    const server = createRpcServer({ bus, channel: RPC_CHANNELS.workspaceEdit, handler: async () => {
      if (mode === "getter") return Object.defineProperty({}, "ok", { enumerable: true, get: () => { throw new Error("untrusted"); } });
      if (mode === "malformed") return { ok: true, proposalId: "p", files: ["f", 1], diff: "d", unexpected: "ignored" };
      return { ok: true, proposalId: "p", files, diff: "d", unexpected: "ignored" };
    } });
    const requester = createBoundActionStageRequester({ bus, sessionFilePath: "/session", cwd: "/project" });
    const first = await requester(packet(() => 1));
    files.push("later");
    expect(first).toEqual({ kind: "staged", proposal: { proposalId: "p", files: ["f"], diff: "d" } });
    expect(Object.isFrozen((first as { proposal: object }).proposal)).toBe(true);
    mode = "malformed";
    expect(await requester(packet(() => 1))).toEqual({ kind: "refused", reason: "unavailable" });
    mode = "getter";
    expect(await requester(packet(() => 1))).toEqual({ kind: "refused", reason: "unavailable" });
    server.dispose();
  });

  it("settles local callback after caller abort while remote handler remains pending", async () => {
    const bus = new EventBus();
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const remote = new Promise<void>((resolve) => { release = resolve; });
    let remoteSettled = false;
    let handlerWork: Promise<unknown> | undefined;
    let deliver!: () => void;
    const delivered = new Promise<void>((resolve) => { deliver = resolve; });
    const observe = bus.on(RPC_CHANNELS.workspaceEdit, (raw) => {
      const parsed = validateEventMessage(raw);
      if (parsed.ok && parsed.value.kind === "reply") deliver();
    });
    const server = createRpcServer({ bus, channel: RPC_CHANNELS.workspaceEdit, handler: () => {
      handlerWork = (async () => {
        enter(); await remote; remoteSettled = true; return { ok: true, proposalId: "late", files: [], diff: "late" };
      })();
      return handlerWork;
    } });
    const requester = createBoundActionStageRequester({ bus, sessionFilePath: "/session", cwd: "/project" });
    const original = new AbortController();
    let current = 1;
    const budget = createBoundActionBudget(100, original.signal, () => current);
    let callback: Promise<unknown> | undefined;
    try {
      callback = requester(Object.freeze({ ...packet(() => current, original.signal, budget.signal), deadlineMs: 100 }));
      await entered;
      original.abort();
      await expect(callback).resolves.toEqual({ kind: "refused", reason: "cancelled" });
      expect(remoteSettled).toBe(false);
      current = 2;
    } finally {
      release();
      await remote;
      if (callback) await callback;
      if (handlerWork) { await handlerWork; await delivered; }
      budget.dispose();
      server.dispose();
      observe();
    }
    expect(bus.count(RPC_CHANNELS.workspaceEdit)).toBe(0);
  });

  it("binds the stage payload to canonical raw BOM source identity, not edited target", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "stage-rpc-origin-")));
    const source = join(root, "origin.ts");
    const cwd = join(root, "project");
    const target = join(cwd, "edited.ts");
    await mkdir(cwd);
    const raw = Buffer.from("\uFEFFconst origin = 1;\n", "utf8");
    await writeFile(source, raw);
    const canonicalSource = await realpath(source);
    const rawSha256 = createHash("sha256").update(await readFile(canonicalSource)).digest("hex");
    const textSha256 = createHash("sha256").update(raw.toString("utf8").replace(/^\uFEFF/, ""), "utf8").digest("hex");
    expect(rawSha256).not.toBe(textSha256);
    const sourceEdit = Object.freeze({ positionEncoding: "utf-16" as const, fileEdits: Object.freeze([Object.freeze({
      filePath: target, edits: Object.freeze([{ filePath: target, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "x" }]),
    })]) });
    const bus = new EventBus();
    const observed: unknown[] = [];
    const server = createRpcServer({ bus, channel: RPC_CHANNELS.workspaceEdit, handler: async (request) => {
      observed.push(request);
      return { ok: true, proposalId: "origin-bound", files: [target], diff: "diff" };
    } });
    const requestor = createBoundActionStageRequester({ bus, sessionFilePath: join(root, "separate-session.jsonl"), cwd });
    let pending: Promise<unknown> | undefined;
    try {
      pending = requestor(Object.freeze({ ...packet(() => 1), prepared: sourceEdit, document: Object.freeze({ canonicalPath: canonicalSource, sha256: rawSha256 }) }));
      await expect(pending).resolves.toEqual({ kind: "staged", proposal: { proposalId: "origin-bound", files: [target], diff: "diff" } });
      expect(observed).toHaveLength(1);
      const request = observed[0] as { rpc: string; payload: Record<string, unknown> };
      expect(request.rpc).toBe(WORKSPACE_EDIT_RPC_METHODS.stage);
      expect(request.payload).toEqual({ workspaceEdit: sourceEdit, source: { operation: "resolveCodeAction", serverDescriptorId: "descriptor", document: { canonicalPath: canonicalSource, sha256: rawSha256 } }, sessionFilePath: join(root, "separate-session.jsonl"), cwd });
      expect(Object.keys(request.payload).sort()).toEqual(["cwd", "sessionFilePath", "source", "workspaceEdit"]);
    } finally {
      if (pending) await pending;
      server.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("honors fractional same-clock deadlines without premature timeout", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const bus = new EventBus();
    let enter!: () => void; let release!: () => void; let deliver!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const delivered = new Promise<void>((resolve) => { deliver = resolve; });
    let handlerWork: Promise<unknown> | undefined;
    const observe = bus.on(RPC_CHANNELS.workspaceEdit, (raw) => { const parsed = validateEventMessage(raw); if (parsed.ok && parsed.value.kind === "reply") deliver(); });
    const server = createRpcServer({ bus, channel: RPC_CHANNELS.workspaceEdit, handler: () => { handlerWork = (async () => { enter(); await gate; return { ok: true, proposalId: "fraction", files: [], diff: "d" }; })(); return handlerWork; } });
    const original = new AbortController(); const budget = createBoundActionBudget(1.5, original.signal, Date.now);
    const pending = createBoundActionStageRequester({ bus, sessionFilePath: "/session", cwd: "/project" })(Object.freeze({ ...packet(Date.now, original.signal, budget.signal), deadlineMs: 1.5 }));
    try {
      await Promise.race([entered, pending.then(() => { throw new Error("settled before handler entry"); })]);
      await vi.advanceTimersByTimeAsync(1);
      expect(pending).toBeInstanceOf(Promise);
      expect(budget.signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toEqual({ kind: "refused", reason: "timeout" });
    } finally { release(); await gate; await pending; if (handlerWork) { await handlerWork; await delivered; } observe(); server.dispose(); budget.dispose(); vi.useRealTimers(); }
  });

  it("caps long deadlines without overflow and promptly honors original cancellation", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const bus = new EventBus(); let enter!: () => void; let release!: () => void; let deliver!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; }); const gate = new Promise<void>((resolve) => { release = resolve; }); const delivered = new Promise<void>((resolve) => { deliver = resolve; });
    let handlerWork: Promise<unknown> | undefined;
    const observe = bus.on(RPC_CHANNELS.workspaceEdit, (raw) => { const parsed = validateEventMessage(raw); if (parsed.ok && parsed.value.kind === "reply") deliver(); });
    const server = createRpcServer({ bus, channel: RPC_CHANNELS.workspaceEdit, handler: () => { handlerWork = (async () => { enter(); await gate; return { ok: true, proposalId: "late", files: [], diff: "d" }; })(); return handlerWork; } });
    const original = new AbortController(); const deadlineMs = 2_147_483_647 + 100; const budget = createBoundActionBudget(deadlineMs, original.signal, Date.now);
    const pending = createBoundActionStageRequester({ bus, sessionFilePath: "/session", cwd: "/project" })(Object.freeze({ ...packet(Date.now, original.signal, budget.signal), deadlineMs }));
    try {
      await Promise.race([entered, pending.then(() => { throw new Error("settled before handler entry"); })]);
      await vi.advanceTimersByTimeAsync(1);
      expect(budget.signal.aborted).toBe(false);
      original.abort();
      await expect(pending).resolves.toEqual({ kind: "refused", reason: "cancelled" });
    } finally { original.abort(); release(); await gate; await pending; if (handlerWork) { await handlerWork; await delivered; } observe(); server.dispose(); budget.dispose(); vi.useRealTimers(); }
  });

  it.each([
    ["empty proposal id", { ok: true, proposalId: "", files: [], diff: "d" }],
    ["non-string file", { ok: true, proposalId: "p", files: [1], diff: "d" }],
    ["getter property", Object.defineProperty({}, "ok", { enumerable: true, get: () => { throw new Error("hostile getter"); } })],
    ["non-plain record", Object.assign(Object.create({ inherited: true }), { ok: true, proposalId: "p", files: [], diff: "d" })],
  ])("rejects malformed RPC reply: %s", async (_label, response) => {
    const bus = new EventBus(); const server = createRpcServer({ bus, channel: RPC_CHANNELS.workspaceEdit, handler: async () => response });
    const requester = createBoundActionStageRequester({ bus, sessionFilePath: "/session", cwd: "/project" });
    try { await expect(requester(packet(() => 1))).resolves.toEqual({ kind: "refused", reason: "unavailable" }); }
    finally { server.dispose(); }
    expect(bus.count(RPC_CHANNELS.workspaceEdit)).toBe(0);
  });

  it.each([
    ["pre-aborted caller", (original: AbortController) => { original.abort(); }, () => 1],
    ["expired deadline", (_original: AbortController) => undefined, () => 100],
    ["non-finite clock", (_original: AbortController) => undefined, () => Number.NaN],
  ])("does not emit before send for %s", async (_label, setup, now) => {
    const bus = new EventBus(); const emit = vi.spyOn(bus, "emit"); const original = new AbortController(); setup(original);
    const requester = createBoundActionStageRequester({ bus, sessionFilePath: "/session", cwd: "/project" });
    await requester(packet(now, original.signal));
    expect(emit).not.toHaveBeenCalled();
  });

  it.each(STAGEABLE_SEMANTIC_OPERATIONS)("stages %s verbatim as source.operation end-to-end", async (operation) => {
    const bus = new EventBus();
    const captured: unknown[] = [];
    const server = createRpcServer({ bus, channel: RPC_CHANNELS.workspaceEdit, handler: async (request) => {
      captured.push(request);
      return { ok: true, proposalId: "p1", files: ["/outside/project/source.ts"], diff: "diff" };
    } });
    try {
      const requester = createBoundActionStageRequester({ bus, sessionFilePath: "/session", cwd: "/project" });
      const result = await requester({ ...packet(() => 1), operation });
      expect(result).toEqual({ kind: "staged", proposal: { proposalId: "p1", files: ["/outside/project/source.ts"], diff: "diff" } });
      const request = captured[0] as { rpc: string; payload: Record<string, unknown> };
      expect(request.rpc).toBe(WORKSPACE_EDIT_RPC_METHODS.stage);
      expect(request.payload).toEqual({ workspaceEdit: edit, source: { operation, serverDescriptorId: "descriptor", document: { canonicalPath: "/outside/project/source.ts", sha256: "a".repeat(64) } }, sessionFilePath: "/session", cwd: "/project" });
    } finally { server.dispose(); }
    expect(bus.count(RPC_CHANNELS.workspaceEdit)).toBe(0);
  });

  it.each(["codeActions", "definition", "", "Rename", "formatting"])("refuses unknown operation %j with zero RPC emission", async (operation) => {
    const bus = new EventBus(); const emit = vi.spyOn(bus, "emit");
    const requester = createBoundActionStageRequester({ bus, sessionFilePath: "/session", cwd: "/project" });
    expect(await requester({ ...packet(() => 1), operation } as unknown as BoundActionContinuationPacket)).toEqual({ kind: "refused", reason: "unavailable" });
    expect(emit).not.toHaveBeenCalled();
    expect(bus.count(RPC_CHANNELS.workspaceEdit)).toBe(0);
  });

  it("does not emit or retain an RPC subscription when caller aborts during client construction", async () => {
    const bus = new EventBus(); const emit = vi.spyOn(bus, "emit"); const original = new AbortController();
    const subscribe = bus.on.bind(bus);
    vi.spyOn(bus, "on").mockImplementation((channel, handler) => { const unsubscribe = subscribe(channel, handler); original.abort(); return unsubscribe; });
    try {
      await createBoundActionStageRequester({ bus, sessionFilePath: "/session", cwd: "/project" })(packet(() => 1, original.signal));
      expect(emit).not.toHaveBeenCalled();
      expect(bus.count(RPC_CHANNELS.workspaceEdit)).toBe(0);
    } finally { vi.restoreAllMocks(); }
  });
});
