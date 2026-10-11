import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_SCHEMA_VERSION, RPC_CHANNELS, WORKSPACE_EDIT_RPC_METHODS, createRpcServer, validateEventMessage, validateStageWorkspaceEditRequest } from "@rhinos0608/pi-workspace-protocol";
import { executeBoundAction } from "../../../src/lsp/lsp-action-adapter.js";
import type { BoundActionRequest } from "../../../src/lsp/lsp-action-origin.js";
import { LSPConnection } from "../../../src/lsp/lsp-connection.js";
import type { PreparedDocumentReceipt } from "../../../src/lsp/lsp-document-store.js";
import { cachedManager, evictManagerForRoot, sessionStore, type SessionEntry } from "../../../src/lsp/lsp-manager.js";
import { buildSessionKey, computeConfigFingerprint } from "../../../src/lsp/lsp-session-key.js";
import { createBoundActionStageRequester } from "../../../src/lsp/lsp-action-stage-rpc.js";
import type { BusLike } from "../../../src/lsp/lsp-workspace-edit.js";

const roots: string[] = [];
const keys: string[] = [];
afterEach(async () => {
  for (const key of keys.splice(0)) sessionStore.delete(key);
  for (const root of roots.splice(0)) {
    await evictManagerForRoot(join(root, "workspace"));
    await rm(root, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});
const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

class EventBus implements BusLike {
  listeners = new Map<string, Set<(value: unknown) => void>>();
  emit(channel: string, value: unknown): void { for (const listener of [...(this.listeners.get(channel) ?? [])]) listener(value); }
  on(channel: string, handler: (value: unknown) => void): () => void {
    const set = this.listeners.get(channel) ?? new Set(); this.listeners.set(channel, set); set.add(handler);
    return () => { set.delete(handler); };
  }
}

async function fixture() {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "action-staging-composition-")));
  roots.push(parent);
  const root = join(parent, "workspace");
  await mkdir(root);
  const sourceNamed = join(parent, "origin.ts");
  const raw = Buffer.from("\uFEFFconst origin = 1;\n", "utf8");
  await writeFile(sourceNamed, raw);
  const source = await realpath(sourceNamed);
  const target = join(root, "edited-target.ts");
  await writeFile(target, "target remains unchanged\n");
  const targetBefore = await readFile(target);
  const descriptorId = "composition-typescript";
  const conn = new LSPConnection();
  conn.descriptorId = descriptorId; conn.name = "TypeScript"; conn.projectRoot = root; conn.languageIds = ["typescript"];
  vi.spyOn(conn, "getNegotiatedEncoding").mockReturnValue("utf-16");
  vi.spyOn(conn, "shutdown").mockImplementation(() => {});
  const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
  const receipt: PreparedDocumentReceipt = {
    canonicalPath: source, uri: pathToFileURL(source).href, version: 4, textHash: sha(decoded), mutationGeneration: 2, submissionStamp: 3,
    syncConfig: { openClose: true, change: "full" }, connectionId: conn.connectionId,
    transportId: "fixture-transport", storeId: "fixture-store", stateId: "fixture-state", descriptorId,
    projectRoot: root, positionEncoding: "utf-16",
  };
  vi.spyOn(conn, "prepareDocument").mockResolvedValue(receipt);
  vi.spyOn(conn, "getDocumentReceipt").mockReturnValue(receipt);
  let actions = 0; let resolves = 0;
  const original = { title: "Fix", kind: "quickfix", data: { retained: true } };
  const resolved = { ...original, edit: { documentChanges: [{ textDocument: { uri: pathToFileURL(target).href, version: null }, edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "edited\n" }] }] } };
  vi.spyOn(conn, "request").mockImplementation(async (method) => {
    if (method === "textDocument/codeAction") { actions++; return [original]; }
    if (method === "codeAction/resolve") { resolves++; return resolved; }
    throw new Error(`unexpected method ${method}`);
  });
  const manager = cachedManager(root);
  const config = { command: "composition-fixture-command", args: [], languageIds: ["typescript"], descriptorId };
  manager.getAvailableConfigs().splice(0, Infinity, config);
  const fingerprintInputs = Reflect.get(manager, "fingerprintFor").call(manager, "typescript", config, { descriptorId, allowInstall: false, purpose: "request" });
  const key = buildSessionKey(root, fingerprintInputs);
  const fingerprint = computeConfigFingerprint(fingerprintInputs);
  keys.push(key); Reflect.set(conn, "sessionKey", key);
  const entry: SessionEntry = { conn, fingerprint, descriptorId, root, leases: 0, lastUsed: Date.now() };
  sessionStore.set(key, entry);
  const route = { projectRoot: root, languageId: "typescript", server: descriptorId };
  const request: BoundActionRequest = { operation: "codeActions", path: source, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } }, context: { diagnostics: [] } };
  const deadlineMs = Date.now() + 20_000;
  const found = await executeBoundAction(request, route, { deadlineMs });
  if (found.kind !== "result") throw new Error("action discovery did not return a result");
  const selected = (found.envelope.result as Array<{ actionId: string; sourceSha256: string }>)[0]!;
  await found.cleanup;
  return { root, source, target, raw, targetBefore, conn, entry, route, request, selected, deadlineMs, actions: () => actions, resolves: () => resolves };
}

function selected(f: Awaited<ReturnType<typeof fixture>>): BoundActionRequest {
  return { ...f.request, operation: "resolveCodeAction", selection: f.selected };
}

function observeReply(bus: EventBus) {
  let requestId: string | undefined;
  let resolve!: () => void;
  const delivered = new Promise<void>((done) => { resolve = done; });
  const dispose = bus.on(RPC_CHANNELS.workspaceEdit, (raw) => {
    const parsed = validateEventMessage(raw);
    if (!parsed.ok) return;
    const frame = parsed.value;
    if (frame.kind === "request" && frame.rpc === WORKSPACE_EDIT_RPC_METHODS.stage) requestId = frame.requestId;
    if (frame.kind === "reply" && frame.requestId === requestId) resolve();
  });
  return { delivered, dispose };
}

describe("executeBoundAction action-stage composition", () => {
  it("composes source-origin resolution, held receipt validation, and schema-validated current stage RPC", async () => {
    const f = await fixture(); const bus = new EventBus(); const frames: unknown[] = [];
    const reply = observeReply(bus);
    let handlerWork: Promise<unknown> | undefined;
    const server = createRpcServer({ bus, channel: RPC_CHANNELS.workspaceEdit, handler: (request) => {
      handlerWork = (async () => {
      frames.push(request);
      const validation = validateStageWorkspaceEditRequest(request.payload);
      expect(validation.ok).toBe(true);
        return { ok: true, proposalId: "current-proposal", files: [f.target], diff: "preview" };
      })();
      return handlerWork;
    } });
    const stage = createBoundActionStageRequester({ bus, sessionFilePath: join(f.root, "session.jsonl"), cwd: f.root });
    let packet: Parameters<typeof stage>[0] | undefined;
    const local = executeBoundAction(selected(f), f.route, { deadlineMs: f.deadlineMs, stage: (p) => { packet = p; expect(f.entry.leases).toBe(1); return stage(p); } });
    let outcome: Awaited<typeof local> | undefined;
    try {
      outcome = await local;
      expect(outcome).toMatchObject({ kind: "result", proposal: { proposalId: "current-proposal" }, envelope: { status: "ok" } });
      expect(packet && Object.isFrozen(packet)).toBe(true);
      expect(packet?.prepared.positionEncoding).toBe("utf-16");
      expect(packet?.prepared.fileEdits[0]?.filePath).toBe(f.target);
      expect(packet?.document).toEqual({ canonicalPath: f.source, sha256: sha(f.raw) });
      expect(packet?.document.sha256).not.toBe(sha(Buffer.from(new TextDecoder("utf-8").decode(f.raw))));
      expect(packet?.serverDescriptor.descriptorId).toBe("composition-typescript");
      const parsed = validateEventMessage(frames[0]);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok || parsed.value.kind !== "request") throw new Error("stage request frame missing");
      const frame = parsed.value;
      expect(frame.schemaVersion).toBe(PROTOCOL_SCHEMA_VERSION);
      expect(frame.rpc).toBe(WORKSPACE_EDIT_RPC_METHODS.stage);
      expect(frame.payload).toMatchObject({ source: { operation: "resolveCodeAction", serverDescriptorId: "composition-typescript", document: { canonicalPath: f.source, sha256: sha(f.raw) } } });
      expect(outcome).not.toHaveProperty("origin");
      await expect(outcome.cleanup).resolves.toEqual({ state: "released" });
      expect(f.entry.leases).toBe(0); expect(f.actions()).toBe(2); expect(f.resolves()).toBe(1);
      expect(await readFile(f.target)).toEqual(f.targetBefore);
    } finally {
      try { await (await local).cleanup; }
      finally {
        try { if (handlerWork) await Promise.allSettled([handlerWork, reply.delivered]); }
        finally { reply.dispose(); server.dispose(); }
      }
    }
  });

  it("returns on original cancellation while entered RPC handler remains pending, then settles local work and late delivery", async () => {
    const f = await fixture(); const bus = new EventBus(); const original = new AbortController();
    let enter!: () => void; let release!: () => void; let delivered!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const delivery = new Promise<void>((resolve) => { delivered = resolve; });
    let handlerPending = false; let handlerWork: Promise<unknown> | undefined;
    const observe = bus.on(RPC_CHANNELS.workspaceEdit, (raw) => { const msg = validateEventMessage(raw); if (msg.ok && msg.value.kind === "reply") delivered(); });
    const server = createRpcServer({ bus, channel: RPC_CHANNELS.workspaceEdit, handler: () => {
      handlerPending = true;
      handlerWork = (async () => { enter(); await gate; handlerPending = false; return { ok: true, proposalId: "late-proposal", files: [], diff: "late" }; })();
      return handlerWork;
    } });
    const stage = createBoundActionStageRequester({ bus, sessionFilePath: join(f.root, "session.jsonl"), cwd: f.root });
    const local = executeBoundAction(selected(f), f.route, { deadlineMs: f.deadlineMs, signal: original.signal, stage });
    let outcome: Awaited<typeof local> | undefined;
    try {
      await Promise.race([entered, local.then(() => { throw new Error("caller completed before RPC handler entry"); })]);
      original.abort();
      outcome = await local;
      expect(outcome).toMatchObject({ kind: "refusal", status: "cancelled" });
      await expect(outcome.cleanup).resolves.toEqual({ state: "released" });
      expect(handlerPending).toBe(true); expect(f.entry.leases).toBe(0);
      expect(outcome).not.toHaveProperty("proposal");
    } finally {
      original.abort(); release(); await gate;
      try {
        outcome = await local;
        await outcome.cleanup;
        if (handlerWork) await Promise.allSettled([handlerWork, delivery]);
      } finally { observe(); server.dispose(); }
    }
    expect(handlerPending).toBe(false); expect(outcome).not.toHaveProperty("proposal");
    expect(f.entry.leases).toBe(0); expect(f.actions()).toBe(2); expect(f.resolves()).toBe(1);
  });

  it("rejects the handler proposal when source changes before post-stage origin revalidation", async () => {
    const f = await fixture(); const bus = new EventBus(); let handlerEntered = false;
    const reply = observeReply(bus);
    let handlerWork: Promise<unknown> | undefined;
    const server = createRpcServer({ bus, channel: RPC_CHANNELS.workspaceEdit, handler: (request) => {
      handlerWork = (async () => {
      handlerEntered = true;
      expect(validateStageWorkspaceEditRequest(request.payload).ok).toBe(true);
      await writeFile(f.source, "changed while stage handler is running\n");
        return { ok: true, proposalId: "must-not-publish", files: [f.target], diff: "preview only" };
      })();
      return handlerWork;
    } });
    const stage = createBoundActionStageRequester({ bus, sessionFilePath: join(f.root, "session.jsonl"), cwd: f.root });
    const local = executeBoundAction(selected(f), f.route, { deadlineMs: f.deadlineMs, stage });
    try {
      const outcome = await local;
      expect(handlerEntered).toBe(true);
      expect(outcome).toMatchObject({ kind: "refusal", status: "not_ready" });
      expect(outcome).not.toHaveProperty("proposal");
      await expect(outcome.cleanup).resolves.toEqual({ state: "released" });
      expect(f.entry.leases).toBe(0); expect(f.actions()).toBe(2); expect(f.resolves()).toBe(1);
      expect(await readFile(f.target)).toEqual(f.targetBefore);
    } finally {
      try { await (await local).cleanup; }
      finally {
        try { if (handlerWork) await Promise.allSettled([handlerWork, reply.delivered]); }
        finally { reply.dispose(); server.dispose(); }
      }
    }
  });
});
