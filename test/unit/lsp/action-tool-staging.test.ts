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

async function fixture() {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "action-tool-staging-")));
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
  const descriptorId = "action-tool-typescript";
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
  const original = { title: "Fix", kind: "quickfix", data: { retained: true } };
  const resolved = { ...original, edit: { documentChanges: [{ textDocument: { uri: pathToFileURL(target).href, version: null }, edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "edited\n" }] }] } };
  const methods: string[] = [];
  vi.spyOn(conn, "request").mockImplementation(async (method) => {
    methods.push(method);
    if (method === "textDocument/codeAction") return [original];
    if (method === "codeAction/resolve") return resolved;
    throw new Error(`unexpected method ${method}`);
  });
  const manager = cachedManager(root);
  const config = { command: "action-tool-fixture-command", args: [], languageIds: ["typescript"], descriptorId };
  manager.getAvailableConfigs().splice(0, Infinity, config);
  const fingerprintInputs = Reflect.get(manager, "fingerprintFor").call(manager, "typescript", config, { descriptorId, allowInstall: false, purpose: "request" });
  const key = buildSessionKey(root, fingerprintInputs);
  const fingerprint = computeConfigFingerprint(fingerprintInputs);
  keys.push(key); Reflect.set(conn, "sessionKey", key);
  const entry: SessionEntry = { conn, fingerprint, descriptorId, root, leases: 0, lastUsed: Date.now() };
  sessionStore.set(key, entry);
  return { parent, root, source, target, raw, targetBefore, entry, methods };
}

describe("LSP tool action staging facade", () => {
  it("stages the explicitly selected discovered action through the trusted stage RPC", async () => {
    const f = await fixture(); const bus = new EventBus(); const frames: unknown[] = [];
    let entered!: () => void;
    const handlerEntered = new Promise<void>((resolve) => { entered = resolve; });
    let handlerWork: Promise<unknown> | undefined;
    const server = createRpcServer({ bus, channel: RPC_CHANNELS.workspaceEdit, handler: (request) => {
      handlerWork = (async () => {
        frames.push(request);
        expect(validateStageWorkspaceEditRequest(request.payload).ok).toBe(true);
        entered();
        return { ok: true, proposalId: "facade-proposal", files: [f.target], diff: "preview only" };
      })();
      return handlerWork;
    } });
    const tool = createLspTool({ getBus: () => bus, getSessionFilePath: () => join(f.root, "session.jsonl"), getCwd: () => f.root });
    const ctx = { cwd: f.root } as ExtensionContext;
    const common = { path: f.source, workspace: f.root, server: "action-tool-typescript", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } }, context: { diagnostics: [] } };
    let local: Promise<Awaited<ReturnType<typeof tool.execute>>> | undefined;
    try {
      const discovery = await tool.execute("discover", { operation: "codeActions", ...common }, undefined, undefined, ctx);
      const discoveryDetails: unknown = discovery.details;
      if (!discoveryDetails || typeof discoveryDetails !== "object" || !("envelope" in discoveryDetails)) {
        throw new Error("discovery envelope missing from tool details");
      }
      const discoveryEnvelope: unknown = discoveryDetails.envelope;
      expect(discoveryEnvelope).toBeDefined();
      const resultValue = discoveryEnvelope && typeof discoveryEnvelope === "object" && "result" in discoveryEnvelope
        ? discoveryEnvelope.result
        : undefined;
      expect(Array.isArray(resultValue)).toBe(true);
      if (!Array.isArray(resultValue) || resultValue.length !== 1) throw new Error("expected exactly one discovered action");
      const selectedValue: unknown = resultValue[0];
      if (!selectedValue || typeof selectedValue !== "object" || !("actionId" in selectedValue) || !("sourceSha256" in selectedValue) || typeof selectedValue.actionId !== "string" || typeof selectedValue.sourceSha256 !== "string") {
        throw new Error("discovered action identity is malformed");
      }
      const selected = { actionId: selectedValue.actionId, sourceSha256: selectedValue.sourceSha256 };
      local = tool.execute("resolve", { operation: "resolveCodeAction", ...common, selection: { actionId: selected.actionId, sourceSha256: selected.sourceSha256 } }, undefined, undefined, ctx);
      const result = await local;
      const resultDetails: unknown = result.details;
      if (!resultDetails || typeof resultDetails !== "object" || !("proposal" in resultDetails)) {
        throw new Error("staged proposal missing from tool details");
      }
      expect(resultDetails.proposal).toEqual({ proposalId: "facade-proposal", files: [f.target], diff: "preview only" });
      await handlerEntered;
      const frame = validateEventMessage(frames[0]);
      expect(frame.ok).toBe(true);
      if (!frame.ok || frame.value.kind !== "request") throw new Error("stage frame missing");
      expect(frame.value.schemaVersion).toBe(PROTOCOL_SCHEMA_VERSION);
      expect(frame.value.rpc).toBe(WORKSPACE_EDIT_RPC_METHODS.stage);
      expect(frame.value.payload).toMatchObject({ source: { operation: "resolveCodeAction", serverDescriptorId: "action-tool-typescript", document: { canonicalPath: f.source, sha256: sha(f.raw) } } });
      expect(result).not.toHaveProperty("origin");
      expect(f.entry.leases).toBe(0);
      expect(f.methods).toEqual(["textDocument/codeAction", "textDocument/codeAction", "codeAction/resolve"]);
      expect(await readFile(f.target)).toEqual(f.targetBefore);
    } finally {
      try { if (local) await local; }
      finally { try { if (handlerWork) await Promise.allSettled([handlerWork]); } finally { server.dispose(); } }
    }
  });
});
