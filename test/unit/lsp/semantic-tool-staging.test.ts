import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_SCHEMA_VERSION, RPC_CHANNELS, WORKSPACE_EDIT_RPC_METHODS, createRpcServer, validateEventMessage, validateStageWorkspaceEditRequest } from "@rhinos0608/pi-workspace-protocol";
import { createLspTool } from "../../../src/lsp/lsp-tool.js";
import { LSPConnection } from "../../../src/lsp/lsp-connection.js";
import type { PreparedDocumentReceipt } from "../../../src/lsp/lsp-document-store.js";
import { cachedManager, evictManagerForRoot, sessionStore, type SessionEntry } from "../../../src/lsp/lsp-manager.js";
import { buildSessionKey, computeConfigFingerprint } from "../../../src/lsp/lsp-session-key.js";
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

type ReplyMode = "rename" | "format";

async function fixture(mode: ReplyMode = "rename") {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "semantic-tool-staging-")));
  roots.push(parent);
  const root = join(parent, "workspace");
  await mkdir(root);
  const sourceNamed = join(parent, "origin.ts");
  const raw = Buffer.from("﻿const origin = 1;\n", "utf8");
  await writeFile(sourceNamed, raw);
  const source = await realpath(sourceNamed);
  const sourceUri = pathToFileURL(source).href;
  const target = join(root, "edited-target.ts");
  await writeFile(target, "target remains unchanged\n");
  const targetBefore = await readFile(target);
  const descriptorId = "semantic-tool-typescript";
  const conn = new LSPConnection();
  conn.descriptorId = descriptorId; conn.name = "TypeScript"; conn.projectRoot = root; conn.languageIds = ["typescript"];
  vi.spyOn(conn, "getNegotiatedEncoding").mockReturnValue("utf-16");
  vi.spyOn(conn, "shutdown").mockImplementation(() => {});
  const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
  const receipt: PreparedDocumentReceipt = {
    canonicalPath: source, uri: sourceUri, version: 4, textHash: sha(decoded), mutationGeneration: 2, submissionStamp: 3,
    syncConfig: { openClose: true, change: "full" }, connectionId: conn.connectionId,
    transportId: "fixture-transport", storeId: "fixture-store", stateId: "fixture-state", descriptorId,
    projectRoot: root, positionEncoding: "utf-16",
  };
  vi.spyOn(conn, "prepareDocument").mockResolvedValue(receipt);
  vi.spyOn(conn, "getDocumentReceipt").mockReturnValue(receipt);
  const renameReply = { changes: { [sourceUri]: [{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 12 } }, newText: "renamed" }] } };
  const formatReply = [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 17 } }, newText: "const origin = 1;\n" }];
  const methods: string[] = [];
  const wireParams: unknown[] = [];
  vi.spyOn(conn, "request").mockImplementation(async (method, params) => {
    methods.push(method);
    wireParams.push(params);
    if (method === "textDocument/rename") return renameReply;
    if (method === "textDocument/formatting") return formatReply;
    throw new Error(`unexpected method ${method}`);
  });
  const manager = cachedManager(root);
  const config = { command: "semantic-tool-fixture-command", args: [], languageIds: ["typescript"], descriptorId };
  manager.getAvailableConfigs().splice(0, Infinity, config);
  const fingerprintInputs = Reflect.get(manager, "fingerprintFor").call(manager, "typescript", config, { descriptorId, allowInstall: false, purpose: "request" });
  const key = buildSessionKey(root, fingerprintInputs);
  const fingerprint = computeConfigFingerprint(fingerprintInputs);
  keys.push(key); Reflect.set(conn, "sessionKey", key);
  const entry: SessionEntry = { conn, fingerprint, descriptorId, root, leases: 0, lastUsed: Date.now() };
  sessionStore.set(key, entry);
  return { parent, root, source, sourceUri, target, raw, targetBefore, entry, methods, wireParams, descriptorId, mode };
}

function stagedServer(bus: EventBus, onStage: (request: unknown) => unknown) {
  const frames: unknown[] = [];
  let entered!: () => void;
  const handlerEntered = new Promise<void>((resolve) => { entered = resolve; });
  let handlerWork: Promise<unknown> | undefined;
  const server = createRpcServer({ bus, channel: RPC_CHANNELS.workspaceEdit, handler: (request) => {
    handlerWork = (async () => {
      frames.push(request);
      expect(validateStageWorkspaceEditRequest(request.payload).ok).toBe(true);
      entered();
      return onStage(request);
    })();
    return handlerWork;
  } });
  return { frames, handlerEntered, dispose: async () => { try { if (handlerWork) await Promise.allSettled([handlerWork]); } finally { server.dispose(); } } };
}

describe("LSP tool semantic staging facade", () => {
  it("stages a rename with the raw-bytes document SHA and operation 'rename' after exactly one wire request", async () => {
    const f = await fixture("rename"); const bus = new EventBus();
    const staged = stagedServer(bus, () => ({ ok: true, proposalId: "semantic-proposal", files: [f.target], diff: "preview only" }));
    const tool = createLspTool({ getBus: () => bus, getSessionFilePath: () => join(f.root, "session.jsonl"), getCwd: () => f.root });
    const ctx = { cwd: f.root } as ExtensionContext;
    try {
      const result = await tool.execute("rename-1", { operation: "rename", path: f.source, workspace: f.root, server: f.descriptorId, position: { line: 0, character: 6 }, newName: "renamed" }, undefined, undefined, ctx);
      const resultDetails: unknown = result.details;
      if (!resultDetails || typeof resultDetails !== "object" || !("proposal" in resultDetails)) {
        throw new Error("staged proposal missing from tool details");
      }
      expect(resultDetails.proposal).toEqual({ proposalId: "semantic-proposal", files: [f.target], diff: "preview only" });
      expect(JSON.stringify(result.content)).toMatch(/semantic-proposal/);
      expect(JSON.stringify(result.content)).toMatch(/applyProposal/);
      await staged.handlerEntered;
      const frame = validateEventMessage(staged.frames[0]);
      expect(frame.ok).toBe(true);
      if (!frame.ok || frame.value.kind !== "request") throw new Error("stage frame missing");
      expect(frame.value.schemaVersion).toBe(PROTOCOL_SCHEMA_VERSION);
      expect(frame.value.rpc).toBe(WORKSPACE_EDIT_RPC_METHODS.stage);
      expect(frame.value.payload).toMatchObject({ source: { operation: "rename", serverDescriptorId: f.descriptorId, document: { canonicalPath: f.source, sha256: sha(f.raw) } } });
      expect(result).not.toHaveProperty("origin");
      expect(f.entry.leases).toBe(0);
      expect(f.methods).toEqual(["textDocument/rename"]);
      expect(f.wireParams[0]).toMatchObject({ textDocument: { uri: f.sourceUri }, position: { line: 0, character: 6 }, newName: "renamed" });
      expect(await readFile(f.target)).toEqual(f.targetBefore);
    } finally {
      await staged.dispose();
    }
  });

  it("stages a formatDocument with operation 'formatDocument' after exactly one wire request", async () => {
    const f = await fixture("format"); const bus = new EventBus();
    const staged = stagedServer(bus, () => ({ ok: true, proposalId: "format-proposal", files: [f.source], diff: "" }));
    const tool = createLspTool({ getBus: () => bus, getSessionFilePath: () => join(f.root, "session.jsonl"), getCwd: () => f.root });
    const ctx = { cwd: f.root } as ExtensionContext;
    try {
      const result = await tool.execute("format-1", { operation: "formatDocument", path: f.source, workspace: f.root, server: f.descriptorId }, undefined, undefined, ctx);
      const resultDetails: unknown = result.details;
      if (!resultDetails || typeof resultDetails !== "object" || !("proposal" in resultDetails)) {
        throw new Error("staged proposal missing from tool details");
      }
      expect(resultDetails.proposal).toEqual({ proposalId: "format-proposal", files: [f.source], diff: "" });
      await staged.handlerEntered;
      const frame = validateEventMessage(staged.frames[0]);
      expect(frame.ok).toBe(true);
      if (!frame.ok || frame.value.kind !== "request") throw new Error("stage frame missing");
      expect(frame.value.payload).toMatchObject({ source: { operation: "formatDocument", serverDescriptorId: f.descriptorId, document: { canonicalPath: f.source, sha256: sha(f.raw) } } });
      expect(f.entry.leases).toBe(0);
      expect(f.methods).toEqual(["textDocument/formatting"]);
      expect(f.wireParams[0]).toMatchObject({ textDocument: { uri: f.sourceUri }, options: { tabSize: 2, insertSpaces: true } });
    } finally {
      await staged.dispose();
    }
  });

  it("without a bus keeps the read-only preview with no proposal", async () => {
    const f = await fixture("rename");
    const tool = createLspTool({ getBus: () => null, getSessionFilePath: () => join(f.root, "session.jsonl"), getCwd: () => f.root });
    const ctx = { cwd: f.root } as ExtensionContext;
    const result = await tool.execute("rename-preview", { operation: "rename", path: f.source, workspace: f.root, server: f.descriptorId, position: { line: 0, character: 6 }, newName: "renamed" }, undefined, undefined, ctx);
    const resultDetails: unknown = result.details;
    if (!resultDetails || typeof resultDetails !== "object" || !("envelope" in resultDetails)) {
      throw new Error("preview envelope missing from tool details");
    }
    expect(resultDetails.envelope).toMatchObject({ status: "ok", operation: "rename", method: "textDocument/rename" });
    expect(resultDetails).not.toHaveProperty("proposal");
    expect(f.methods).toEqual(["textDocument/rename"]);
    expect(f.entry.leases).toBe(0);
  });

  it("cancelled before dispatch publishes a cancelled envelope with no wire traffic", async () => {
    const f = await fixture("rename"); const bus = new EventBus();
    let stageCalls = 0;
    const staged = stagedServer(bus, () => { stageCalls += 1; return { ok: true, proposalId: "never", files: [], diff: "" }; });
    const tool = createLspTool({ getBus: () => bus, getSessionFilePath: () => join(f.root, "session.jsonl"), getCwd: () => f.root });
    const ctx = { cwd: f.root } as ExtensionContext;
    const controller = new AbortController();
    controller.abort();
    try {
      const result = await tool.execute("rename-cancelled", { operation: "rename", path: f.source, workspace: f.root, server: f.descriptorId, position: { line: 0, character: 6 }, newName: "renamed" }, controller.signal, undefined, ctx);
      const resultDetails: unknown = result.details;
      if (!resultDetails || typeof resultDetails !== "object" || !("envelope" in resultDetails)) {
        throw new Error("cancelled envelope missing from tool details");
      }
      expect(resultDetails.envelope).toMatchObject({ status: "cancelled", operation: "rename", result: null });
      expect(resultDetails).not.toHaveProperty("proposal");
      expect(f.methods).toEqual([]);
      expect(stageCalls).toBe(0);
    } finally {
      await staged.dispose();
    }
  });
});
