/**
 * D-81 three-repo integration: SmartRead language-intelligence provider +
 * SmartEdit REAL stage/apply handlers over a single in-process event bus.
 *
 * Opt-in: `PI_SMARTREAD_SMARTEDIT_INTEGRATION=1` (skip otherwise, same
 * gating pattern as `test/integration/lsp/real-server-harness.ts`).
 * SmartEdit checkout (with installed node_modules): `PI_SMARTEDIT_DIR`.
 *
 * The LSP side is a controlled fake connection exactly as the existing
 * composition fixtures use it (controlled submitted receipts + LSP method
 * responses) — no live language server. Real temp files on disk back a
 * known session file/cwd identity shared by both sides.
 *
 * Run:
 *   PI_SMARTREAD_SMARTEDIT_INTEGRATION=1 PI_SMARTEDIT_DIR=/path/to/Pi-SmartEdit \
 *     npx vitest run test/integration/smartedit-workspace-edit.test.ts
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  LANGUAGE_INTELLIGENCE_RPC_METHODS,
  PROTOCOL_SCHEMA_VERSION,
  RPC_CHANNELS,
  WORKSPACE_EDIT_RPC_METHODS,
  createRpcClient,
  createRpcServer,
  hashSessionFilePath,
  validateCodeActionResponse,
  validateEventMessage,
  validateFormattingResponse,
  validateRenamePreviewResponse,
} from "@rhinos0608/pi-workspace-protocol";
import {
  createLanguageIntelligenceProvider,
  noteLanguageIntelligenceSession,
  __resetLanguageIntelligenceProducersForTests,
} from "../../src/language-intelligence/language-intelligence-provider.js";
import { LSPConnection } from "../../src/lsp/lsp-connection.js";
import type { PreparedDocumentReceipt } from "../../src/lsp/lsp-document-store.js";
import {
  cachedManager,
  evictManagerForRoot,
  sessionStore,
} from "../../src/lsp/lsp-manager.js";
import {
  buildSessionKey,
  computeConfigFingerprint,
} from "../../src/lsp/lsp-session-key.js";

export const SMARTEDIT_INTEGRATION_ENABLED =
  process.env.PI_SMARTREAD_SMARTEDIT_INTEGRATION === "1";

/** Pinned protocol both repos must resolve to (fail, never skip, on mismatch). */
const EXPECTED_PROTOCOL_VERSION = "0.8.0";
const EXPECTED_PROTOCOL_COMMIT = "7861d95d95964f62ca817c96050a5beec86e4ea9";

const sha = (value: Buffer | string): string =>
  createHash("sha256").update(value).digest("hex");

class EventBus {
  private listeners = new Map<string, Set<(value: unknown) => void>>();
  emit(channel: string, value: unknown): void {
    for (const listener of [...(this.listeners.get(channel) ?? [])]) {
      listener(value);
    }
  }
  on(channel: string, handler: (value: unknown) => void): () => void {
    const set = this.listeners.get(channel) ?? new Set<(value: unknown) => void>();
    this.listeners.set(channel, set);
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }
}

interface SmartEditWorld {
  readonly stageWorkspaceEdit: (args: {
    deps: unknown;
    session: unknown;
    payload: unknown;
  }) => Promise<unknown>;
  readonly applyStagedEdit: (args: {
    deps: unknown;
    session: unknown;
    payload: unknown;
  }) => Promise<unknown>;
  readonly cacheGet: (
    proposalId: string,
    opts?: { sessionId?: string; sessionRoot?: string },
  ) => unknown;
  readonly newLoopGuard: () => {
    preflight: (...args: never[]) => unknown;
    observe: (...args: never[]) => unknown;
    reset: () => void;
  };
}

let smartEdit: SmartEditWorld | null = null;

function readProtocolPin(lockPath: string): { version: string; resolved: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(lockPath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(
      `smartedit integration: cannot read lockfile at ${lockPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const packages = (parsed as { packages?: Record<string, { version?: string; resolved?: string }> }).packages;
  const entry = packages?.["node_modules/@rhinos0608/pi-workspace-protocol"];
  if (!entry?.version || !entry?.resolved) {
    throw new Error(`smartedit integration: protocol pin missing in ${lockPath}`);
  }
  return { version: entry.version, resolved: entry.resolved };
}

function assertProtocolPinsMatch(smartEditDir: string): void {
  const smartReadPin = readProtocolPin(join(process.cwd(), "package-lock.json"));
  const smartEditPin = readProtocolPin(join(smartEditDir, "package-lock.json"));
  for (const [side, pin] of [
    ["SmartRead", smartReadPin],
    ["SmartEdit", smartEditPin],
  ] as const) {
    if (pin.version !== EXPECTED_PROTOCOL_VERSION || !pin.resolved.includes(EXPECTED_PROTOCOL_COMMIT)) {
      throw new Error(
        `smartedit integration: ${side} protocol pin is ${pin.version} (${pin.resolved}), ` +
          `expected ${EXPECTED_PROTOCOL_VERSION} from ${EXPECTED_PROTOCOL_COMMIT}`,
      );
    }
  }
  if (smartReadPin.version !== smartEditPin.version || smartReadPin.resolved !== smartEditPin.resolved) {
    throw new Error(
      "smartedit integration: SmartRead and SmartEdit resolve different protocol builds " +
        `(${smartReadPin.resolved} vs ${smartEditPin.resolved})`,
    );
  }
}

type LspResponder = (method: string, params: unknown) => unknown;

interface World {
  readonly root: string;
  readonly origin: string;
  readonly originUri: string;
  readonly sessionFile: string;
  readonly bus: EventBus;
  readonly liClient: ReturnType<typeof createRpcClient>;
  readonly editClient: ReturnType<typeof createRpcClient>;
  readonly provider: { dispose(): void };
  readonly editServer: { dispose(): void };
  readonly sessionKey: string;
  readonly stageCalls: () => number;
  readonly toolCallId: () => string;
}

const worlds: World[] = [];
const roots: string[] = [];
const keys: string[] = [];

async function setupWorld(originContent: string, respond: LspResponder): Promise<World> {
  if (!smartEdit) throw new Error("smartedit integration: SmartEdit handlers not loaded");
  const se = smartEdit;
  const root = await realpath(await mkdtemp(join(tmpdir(), "smartedit-integration-")));
  roots.push(root);
  const origin = join(root, "origin.ts");
  await writeFile(origin, originContent);
  const originUri = pathToFileURL(origin).href;
  const sessionFile = join(root, "session.jsonl");
  await writeFile(sessionFile, "");
  const bus = new EventBus();
  const liBus = new EventBus();

  // Read authority the REAL SmartEdit stage/apply path requires: full-file
  // grants attesting the bytes currently on disk.
  const authorityStore = {
    select: (candidate: string): unknown => {
      try {
        const bytes = readFileSync(candidate);
        return {
          coverage: "full-file",
          fullFileSha256: sha(bytes),
          canonicalPath: candidate,
        };
      } catch {
        return null;
      }
    },
  };
  const deps = {
    getSessionFilePath: () => sessionFile,
    getCanonicalWorkspaceRoot: () => root,
    getPriorAuthority: () => authorityStore,
    getBus: () => bus,
  };
  const session = {
    currentSessionFilePath: sessionFile,
    currentCanonicalWorkspaceRoot: root,
    currentCwd: root,
    mutationLoopGuard: se.newLoopGuard(),
    priorAuthorityStore: null,
    astResolver: null,
    lspManager: null,
    smartReadDiagnosticsClient: null,
  };
  let stageCalls = 0;
  const editServer = createRpcServer({
    bus: bus as never,
    channel: RPC_CHANNELS.workspaceEdit,
    handler: (request) => {
      if (request.rpc === WORKSPACE_EDIT_RPC_METHODS.stage) {
        stageCalls += 1;
        return se.stageWorkspaceEdit({ deps, session, payload: request.payload });
      }
      if (request.rpc === WORKSPACE_EDIT_RPC_METHODS.apply) {
        return se.applyStagedEdit({ deps, session, payload: request.payload });
      }
      throw new Error(`unknown workspace-edit method ${String(request.rpc)}`);
    },
  });
  const provider = createLanguageIntelligenceProvider(liBus as never, {
    getSessionFilePath: () => sessionFile,
    getCwd: () => root,
    getStageBus: () => bus as never,
  });
  const liClient = createRpcClient({
    bus: liBus as never,
    channel: RPC_CHANNELS.languageIntelligence,
    timeoutMs: 8000,
  });
  const editClient = createRpcClient({
    bus: bus as never,
    channel: RPC_CHANNELS.workspaceEdit,
    timeoutMs: 8000,
  });

  // Controlled fake LSP connection (same pattern as the composition fixtures).
  const descriptorId = "smartedit-integration-ts";
  const conn = new LSPConnection();
  conn.descriptorId = descriptorId;
  conn.name = "TypeScript";
  conn.projectRoot = root;
  conn.languageIds = ["typescript"];
  vi.spyOn(conn, "getNegotiatedEncoding").mockReturnValue("utf-16");
  vi.spyOn(conn, "shutdown").mockImplementation(() => undefined);
  const bytes = await readFile(origin);
  const receipt: PreparedDocumentReceipt = {
    canonicalPath: origin,
    uri: originUri,
    version: 4,
    textHash: sha(bytes),
    mutationGeneration: 2,
    submissionStamp: 3,
    syncConfig: { openClose: true, change: "full" },
    connectionId: conn.connectionId,
    transportId: "integration-transport",
    storeId: "integration-store",
    stateId: "integration-state",
    descriptorId,
    projectRoot: root,
    positionEncoding: "utf-16",
  };
  vi.spyOn(conn, "prepareDocument").mockResolvedValue(receipt);
  vi.spyOn(conn, "getDocumentReceipt").mockReturnValue(receipt);
  vi.spyOn(conn, "request").mockImplementation((method: string, params: unknown) => {
    return Promise.resolve(respond(method, params));
  });
  const manager = cachedManager(root);
  const config = {
    command: "smartedit-integration-fixture",
    args: [],
    languageIds: ["typescript"],
    descriptorId,
  };
  manager.getAvailableConfigs().splice(0, Infinity, config);
  const fingerprintInputs = Reflect.get(manager, "fingerprintFor").call(manager, "typescript", config, {
    descriptorId,
    allowInstall: false,
    purpose: "request",
  }) as Parameters<typeof buildSessionKey>[1];
  const key = buildSessionKey(root, fingerprintInputs);
  keys.push(key);
  Reflect.set(conn, "sessionKey", key);
  sessionStore.set(key, {
    conn,
    fingerprint: computeConfigFingerprint(fingerprintInputs),
    descriptorId,
    root,
    leases: 0,
    lastUsed: Date.now(),
  });

  let toolSeq = 0;
  const world: World = {
    root,
    origin,
    originUri,
    sessionFile,
    bus,
    liClient,
    editClient,
    provider,
    editServer,
    sessionKey: key,
    stageCalls: () => stageCalls,
    toolCallId: () => `tool-${(toolSeq += 1)}`,
  };
  worlds.push(world);
  return world;
}

async function teardownWorld(world: World): Promise<void> {
  world.liClient.dispose();
  world.editClient.dispose();
  world.provider.dispose();
  world.editServer.dispose();
  sessionStore.delete(world.sessionKey);
  await evictManagerForRoot(world.root);
  await rm(world.root, { recursive: true, force: true });
}

function payloadOf(reply: unknown): Record<string, unknown> {
  const envelope = reply as { ok: boolean; payload: unknown };
  if (!envelope.ok) throw new Error(`RPC transport failed: ${JSON.stringify(reply).slice(0, 300)}`);
  return envelope.payload as Record<string, unknown>;
}

function okProposalId(payload: Record<string, unknown>): string {
  if (payload.ok !== true) {
    throw new Error(`expected staged proposal, got refusal: ${JSON.stringify(payload).slice(0, 300)}`);
  }
  const proposalId = payload.proposalId;
  if (typeof proposalId !== "string" || proposalId.length === 0) {
    throw new Error("staged proposal reply missing proposalId");
  }
  return proposalId;
}

beforeAll(async () => {
  if (!SMARTEDIT_INTEGRATION_ENABLED) return;
  const dir = process.env.PI_SMARTEDIT_DIR;
  if (!dir || dir.length === 0) {
    throw new Error(
      "PI_SMARTREAD_SMARTEDIT_INTEGRATION=1 requires PI_SMARTEDIT_DIR to point at a SmartEdit checkout with installed node_modules",
    );
  }
  assertProtocolPinsMatch(dir);
  const rpcHref = pathToFileURL(join(dir, "src/extension/register-workspace-edit-rpc.ts")).href;
  const cacheHref = pathToFileURL(join(dir, "src/lsp/refactor-preview-cache.ts")).href;
  const guardHref = pathToFileURL(join(dir, "src/extension/mutation-loop-guard.ts")).href;
  let rpc: Record<string, unknown>;
  let cacheMod: Record<string, unknown>;
  let guardMod: Record<string, unknown>;
  try {
    rpc = (await import(rpcHref)) as Record<string, unknown>;
    cacheMod = (await import(cacheHref)) as Record<string, unknown>;
    guardMod = (await import(guardHref)) as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `smartedit integration: failed to import REAL handlers from ${dir}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const stageWorkspaceEdit = rpc["stageWorkspaceEdit"];
  const applyStagedEdit = rpc["applyStagedEdit"];
  const cache = cacheMod["globalRefactorPreviewCache"] as {
    get: (id: string, opts?: { sessionId?: string; sessionRoot?: string }) => unknown;
  };
  const Guard = guardMod["MutationLoopGuard"] as new () => {
    preflight: (...args: never[]) => unknown;
    observe: (...args: never[]) => unknown;
    reset: () => void;
  };
  if (typeof stageWorkspaceEdit !== "function" || typeof applyStagedEdit !== "function") {
    throw new Error(
      "smartedit integration: stage_workspace_edit / apply_staged_edit handlers not found in register-workspace-edit-rpc.ts",
    );
  }
  if (!cache || typeof cache.get !== "function" || typeof Guard !== "function") {
    throw new Error("smartedit integration: preview cache or loop guard not found in SmartEdit checkout");
  }
  smartEdit = {
    stageWorkspaceEdit: stageWorkspaceEdit as SmartEditWorld["stageWorkspaceEdit"],
    applyStagedEdit: applyStagedEdit as SmartEditWorld["applyStagedEdit"],
    cacheGet: (proposalId, opts) => cache.get(proposalId, opts),
    newLoopGuard: () => new Guard(),
  };
});

afterEach(async () => {
  __resetLanguageIntelligenceProducersForTests();
  noteLanguageIntelligenceSession(null);
  for (const world of worlds.splice(0)) {
    await teardownWorld(world);
  }
  for (const key of keys.splice(0)) sessionStore.delete(key);
  for (const root of roots.splice(0)) {
    await evictManagerForRoot(root).catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
  vi.restoreAllMocks();
});

describe.skipIf(!SMARTEDIT_INTEGRATION_ENABLED)("D-81 SmartRead + SmartEdit workspace-edit integration", () => {
  it("rename_preview stages in SmartEdit and applies the expected bytes", async () => {
    const before = "const origin = 1;\n";
    let originUri = "";
    const world = await setupWorld(before, (method) => {
      if (method === "textDocument/rename") {
        return {
          changes: {
            [originUri]: [
              {
                range: { start: { line: 0, character: 6 }, end: { line: 0, character: 12 } },
                newText: "renamed",
              },
            ],
          },
        };
      }
      throw new Error(`unexpected method ${method}`);
    });
    originUri = world.originUri;
    if (!smartEdit) throw new Error("SmartEdit handlers not loaded");
    const reply = await world.liClient.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.renamePreview, {
      filePath: world.origin,
      line: 1,
      character: 7,
      newName: "renamed",
    });
    const payload = payloadOf(reply);
    expect(payload.ok).toBe(true);
    // The reply never contained a workspaceEdit.
    expect(payload).not.toHaveProperty("workspaceEdit");
    expect(JSON.stringify(payload)).not.toContain("workspaceEdit");
    expect(validateRenamePreviewResponse(payload).ok).toBe(true);
    expect(payload.files).toEqual([world.origin]);
    expect(typeof payload.diff).toBe("string");
    const proposalId = okProposalId(payload);

    // SmartEdit's cache holds the proposal under the session binding.
    const binding = {
      sessionId: hashSessionFilePath(world.sessionFile),
      sessionRoot: world.root,
    };
    expect(smartEdit.cacheGet(proposalId, binding)).not.toBeNull();
    // A different session binding sees nothing.
    expect(
      smartEdit.cacheGet(`${proposalId}-nope`, binding),
    ).toBeNull();

    const applied = await world.editClient.request(WORKSPACE_EDIT_RPC_METHODS.apply, {
      proposalId,
      toolCallId: world.toolCallId(),
      sessionFilePath: world.sessionFile,
      cwd: world.root,
    });
    const body = payloadOf(applied);
    expect(body.ok).toBe(true);
    expect(body.status).toBe("applied");
    expect(await readFile(world.origin, "utf8")).toBe("const renamed = 1;\n");
  });

  it("formatting stages in SmartEdit and applies end to end", async () => {
    const before = "export   const    messy=1;\n";
    const after = "export const messy = 1;\n";
    const world = await setupWorld(before, (method) => {
      if (method === "textDocument/formatting") {
        return [
          {
            // End at the start of the next line to cover the trailing newline.
            range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } },
            newText: after,
          },
        ];
      }
      throw new Error(`unexpected method ${method}`);
    });
    const reply = await world.liClient.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.formatting, {
      filePath: world.origin,
      tabSize: 2,
      insertSpaces: true,
    });
    const payload = payloadOf(reply);
    expect(payload.ok).toBe(true);
    expect(payload).not.toHaveProperty("workspaceEdit");
    expect(validateFormattingResponse(payload).ok).toBe(true);
    const proposalId = okProposalId(payload);

    const applied = await world.editClient.request(WORKSPACE_EDIT_RPC_METHODS.apply, {
      proposalId,
      toolCallId: world.toolCallId(),
      sessionFilePath: world.sessionFile,
      cwd: world.root,
    });
    const body = payloadOf(applied);
    expect(body.ok).toBe(true);
    expect(body.status).toBe("applied");
    expect(body.changedFiles).toEqual([world.origin]);
    expect(await readFile(world.origin, "utf8")).toBe(after);
  });

  it("code_action discovery is edit-free; selection stages and applies; nothing applies without a selection", async () => {
    const before = "const target = 1;\n";
    const rawAction = { title: "Fix it", kind: "quickfix", data: { retained: true } };
    let originUri = "";
    const world = await setupWorld(before, (method) => {
      if (method === "textDocument/codeAction") return [rawAction];
      if (method === "codeAction/resolve") {
        return {
          ...rawAction,
          edit: {
            documentChanges: [
              {
                textDocument: { uri: originUri, version: null },
                edits: [
                  {
                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                    newText: "// fixed\n",
                  },
                ],
              },
            ],
          },
        };
      }
      throw new Error(`unexpected method ${method}`);
    });
    originUri = world.originUri;

    const discovery = await world.liClient.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.codeAction, {
      filePath: world.origin,
      line: 1,
      character: 1,
    });
    const candidates = payloadOf(discovery);
    expect(candidates.ok).toBe(true);
    expect(validateCodeActionResponse(candidates).ok).toBe(true);
    const actions = candidates.actions as Array<Record<string, unknown>>;
    expect(actions).toHaveLength(1);
    const allowed = new Set(["title", "kind", "isPreferred", "actionId", "sourceSha256"]);
    for (const item of actions) {
      for (const key of Object.keys(item)) {
        expect(allowed.has(key)).toBe(true);
      }
    }
    expect(JSON.stringify(candidates)).not.toContain("retained");
    // Discovery never stages and never writes.
    expect(world.stageCalls()).toBe(0);
    expect(await readFile(world.origin, "utf8")).toBe(before);

    const first = actions[0];
    if (!first) throw new Error("discovery returned no candidates");
    const selection = { actionId: first.actionId, sourceSha256: first.sourceSha256 };
    const resolved = await world.liClient.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.codeAction, {
      filePath: world.origin,
      line: 1,
      character: 1,
      selection,
    });
    const staged = payloadOf(resolved);
    expect(staged.ok).toBe(true);
    expect(staged).not.toHaveProperty("workspaceEdit");
    expect(staged).not.toHaveProperty("actions");
    expect(validateCodeActionResponse(staged).ok).toBe(true);
    expect(world.stageCalls()).toBe(1);
    const proposalId = okProposalId(staged);

    const applied = await world.editClient.request(WORKSPACE_EDIT_RPC_METHODS.apply, {
      proposalId,
      toolCallId: world.toolCallId(),
      sessionFilePath: world.sessionFile,
      cwd: world.root,
    });
    const body = payloadOf(applied);
    expect(body.ok).toBe(true);
    expect(await readFile(world.origin, "utf8")).toBe("// fixed\nconst target = 1;\n");
  });

  it("freshness: mutating the origin between stage and apply refuses with zero bytes changed", async () => {
    let originUri = "";
    const world = await setupWorld("const origin = 1;\n", (method) => {
      if (method === "textDocument/rename") {
        return {
          changes: {
            [originUri]: [
              {
                range: { start: { line: 0, character: 6 }, end: { line: 0, character: 12 } },
                newText: "renamed",
              },
            ],
          },
        };
      }
      throw new Error(`unexpected method ${method}`);
    });
    originUri = world.originUri;
    const reply = await world.liClient.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.renamePreview, {
      filePath: world.origin,
      line: 1,
      character: 7,
      newName: "renamed",
    });
    const proposalId = okProposalId(payloadOf(reply));

    const mutated = "const origin = 999;\n";
    await writeFile(world.origin, mutated);
    const applied = await world.editClient.request(WORKSPACE_EDIT_RPC_METHODS.apply, {
      proposalId,
      toolCallId: world.toolCallId(),
      sessionFilePath: world.sessionFile,
      cwd: world.root,
    });
    const body = payloadOf(applied);
    expect(body.ok).toBe(false);
    expect(body.status).toBe("rejected");
    expect(body.changedFiles).toEqual([]);
    expect(await readFile(world.origin, "utf8")).toBe(mutated);
  });

  it("freshness: a selection with the wrong sourceSha256 is refused and stages nothing", async () => {
    const before = "const target = 1;\n";
    const rawAction = { title: "Fix it", kind: "quickfix", data: { retained: true } };
    const world = await setupWorld(before, (method) => {
      if (method === "textDocument/codeAction") return [rawAction];
      if (method === "codeAction/resolve") {
        return { ...rawAction, edit: { documentChanges: [] } };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const discovery = await world.liClient.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.codeAction, {
      filePath: world.origin,
      line: 1,
      character: 1,
    });
    const actions = (payloadOf(discovery).actions ?? []) as Array<Record<string, unknown>>;
    const first = actions[0];
    if (!first) throw new Error("discovery returned no candidates");

    const stagesBefore = world.stageCalls();
    const refused = await world.liClient.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.codeAction, {
      filePath: world.origin,
      line: 1,
      character: 1,
      selection: { actionId: first.actionId, sourceSha256: "0".repeat(64) },
    });
    const payload = payloadOf(refused);
    expect(payload.ok).toBe(false);
    expect(payload).not.toHaveProperty("proposalId");
    expect(validateCodeActionResponse(payload).ok).toBe(true);
    expect(world.stageCalls()).toBe(stagesBefore);
    expect(await readFile(world.origin, "utf8")).toBe(before);
  });

  it("freshness: a proposalId from a different session/cwd is refused", async () => {
    const before = "const origin = 1;\n";
    let originUri = "";
    const world = await setupWorld(before, (method) => {
      if (method === "textDocument/rename") {
        return {
          changes: {
            [originUri]: [
              {
                range: { start: { line: 0, character: 6 }, end: { line: 0, character: 12 } },
                newText: "renamed",
              },
            ],
          },
        };
      }
      throw new Error(`unexpected method ${method}`);
    });
    originUri = world.originUri;
    if (!smartEdit) throw new Error("SmartEdit handlers not loaded");
    const reply = await world.liClient.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.renamePreview, {
      filePath: world.origin,
      line: 1,
      character: 7,
      newName: "renamed",
    });
    const proposalId = okProposalId(payloadOf(reply));

    const otherSession = join(world.root, "other-session.jsonl");
    await writeFile(otherSession, "");
    // Cross-repo check first: the cache itself is bound to the staging session.
    expect(
      smartEdit.cacheGet(proposalId, {
        sessionId: hashSessionFilePath(otherSession),
        sessionRoot: world.root,
      }),
    ).toBeNull();

    const applied = await world.editClient.request(WORKSPACE_EDIT_RPC_METHODS.apply, {
      proposalId,
      toolCallId: world.toolCallId(),
      sessionFilePath: otherSession,
      cwd: world.root,
    });
    const body = payloadOf(applied);
    expect(body.ok).toBe(false);
    expect(body.status).toBe("rejected");
    expect(body.changedFiles).toEqual([]);
    expect(await readFile(world.origin, "utf8")).toBe(before);
  });

  it("organize_imports is not served on either channel", async () => {
    const world = await setupWorld("const x = 1;\n", () => {
      throw new Error("no LSP call expected");
    });
    await expect(
      world.liClient.request("organize_imports" as never, { filePath: world.origin }),
    ).rejects.toThrow();
    await expect(
      world.editClient.request("organize_imports" as never, { filePath: world.origin }),
    ).rejects.toThrow();
    const rejected = validateEventMessage({
      schemaVersion: PROTOCOL_SCHEMA_VERSION,
      kind: "request",
      requestId: "r1",
      rpc: "organize_imports",
      payload: { filePath: world.origin },
    });
    expect(rejected.ok).toBe(false);
  });
});
