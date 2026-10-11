/** Stage 4 (option A): applyProposal staging/apply over SmartEdit RPC. Failing-first. */
import { createHash } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { validateStrictRequest } from "../../../src/lsp/lsp-strict-contract.js";
import { getOperationDef } from "../../../src/lsp/lsp-operation-registry.js";
import { createLspTool } from "../../../src/lsp/lsp-tool.js";
import { LSPConnection } from "../../../src/lsp/lsp-connection.js";
import type { PreparedDocumentReceipt } from "../../../src/lsp/lsp-document-store.js";
import { cachedManager, evictManagerForRoot, sessionStore } from "../../../src/lsp/lsp-manager.js";
import { buildSessionKey, computeConfigFingerprint } from "../../../src/lsp/lsp-session-key.js";
import {
  createRpcServer,
  type BusLike,
} from "@rhinos0608/pi-workspace-protocol";
import {
  RPC_CHANNELS,
  WORKSPACE_EDIT_RPC_METHODS,
} from "@rhinos0608/pi-workspace-protocol";
import { __test__clearAll as clearFileReadCache } from "../../../src/read/file-read-cache.js";
import { WORKSPACE_EDIT_APPLY_TIMEOUT_MS } from "../../../src/lsp/lsp-workspace-edit.js";

function memBus(): BusLike & { dispose(): void } {
  const handlers = new Map<string, Set<(d: unknown) => void>>();
  return {
    emit(c: string, d: unknown) {
      for (const h of [...(handlers.get(c) ?? [])]) h(d);
    },
    on(c: string, h: (d: unknown) => void) {
      let s = handlers.get(c);
      if (!s) handlers.set(c, (s = new Set()));
      s.add(h);
      return () => {
        s.delete(h);
      };
    },
    dispose() {
      handlers.clear();
    },
  };
}

// OS-native scratch dir: POSIX-style "/tmp/..." literals are not absolute on
// Windows (resolve() drive-prefixes them), so build every fixture path from
// os.tmpdir() and file URIs via pathToFileURL. Absolute request paths must
// still stage verbatim on every platform.
const TEST_DIR = join(tmpdir(), "apply-proposal-test");
const RENAME_FILE = join(TEST_DIR, "a.ts");

const sha256hex = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

interface SeededBoundSession {
  key: string;
  root: string;
  source: string;
  sourceUri: string;
  methods: string[];
}

/** Seed a live-but-unstarted session so the bound rename/format producer can acquire it. */
async function seedBoundSession(args: {
  fileName: string;
  content: string;
  descriptorId: string;
  reply: (method: string, sourceUri: string) => unknown;
}): Promise<SeededBoundSession> {
  const root = await realpath(await mkdir(TEST_DIR, { recursive: true }).then(() => TEST_DIR));
  const named = join(root, args.fileName);
  await writeFile(named, args.content);
  const source = await realpath(named);
  const sourceUri = pathToFileURL(source).href;
  const conn = new LSPConnection();
  conn.descriptorId = args.descriptorId; conn.name = "TypeScript"; conn.projectRoot = root; conn.languageIds = ["typescript"];
  vi.spyOn(conn, "getNegotiatedEncoding").mockReturnValue("utf-16");
  vi.spyOn(conn, "shutdown").mockImplementation(() => {});
  const receipt: PreparedDocumentReceipt = {
    canonicalPath: source, uri: sourceUri, version: 1, textHash: sha256hex(args.content), mutationGeneration: 1, submissionStamp: 1,
    syncConfig: { openClose: true, change: "full" }, connectionId: conn.connectionId,
    transportId: "seed-transport", storeId: "seed-store", stateId: "seed-state", descriptorId: args.descriptorId,
    projectRoot: root, positionEncoding: "utf-16",
  };
  vi.spyOn(conn, "prepareDocument").mockResolvedValue(receipt);
  vi.spyOn(conn, "getDocumentReceipt").mockReturnValue(receipt);
  const methods: string[] = [];
  vi.spyOn(conn, "request").mockImplementation(async (method: string) => {
    methods.push(method);
    return args.reply(method, sourceUri);
  });
  const manager = cachedManager(root);
  const config = { command: "apply-proposal-bound-command", args: [], languageIds: ["typescript"], descriptorId: args.descriptorId };
  manager.getAvailableConfigs().splice(0, Infinity, config);
  const fingerprintInputs = Reflect.get(manager, "fingerprintFor").call(manager, "typescript", config, { descriptorId: args.descriptorId, allowInstall: false, purpose: "request" });
  const key = buildSessionKey(root, fingerprintInputs);
  const fingerprint = computeConfigFingerprint(fingerprintInputs);
  Reflect.set(conn, "sessionKey", key);
  sessionStore.set(key, { conn, fingerprint, descriptorId: args.descriptorId, root, leases: 0, lastUsed: Date.now() });
  return { key, root, source, sourceUri, methods };
}

async function releaseSeededSession(session: SeededBoundSession): Promise<void> {
  sessionStore.delete(session.key);
  await evictManagerForRoot(session.root);
  vi.restoreAllMocks();
}

const CTX = {
  cwd: TEST_DIR,
  sessionManager: { getSessionFile: () => join(tmpdir(), "apply-proposal-test-session.jsonl") },
} as never;

const RENAME_EDIT = {
  changes: [
    {
      uri: pathToFileURL(RENAME_FILE).href,
      edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: "bbb" }],
    },
  ],
};

function executorReturning(value: unknown, status = "ok") {
  return async () => ({
    status,
    operation: "rename",
    method: "textDocument/rename",
    server: {
      descriptorId: "ts",
      name: "ts",
      languageId: "typescript",
      projectRoot: TEST_DIR,
      positionEncoding: "utf-16",
    },
    result: value,
    meta: { truncated: false },
  });
}

describe("strict contract: applyProposal", () => {
  it("accepts applyProposal {proposalId}", () => {
    expect(validateStrictRequest({ operation: "applyProposal", proposalId: "p-1" }).ok).toBe(true);
  });
  it("rejects missing proposalId", () => {
    const r = validateStrictRequest({ operation: "applyProposal" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/requires field "proposalId"/);
  });
  it("rejects foreign fields on applyProposal", () => {
    const r = validateStrictRequest({ operation: "applyProposal", proposalId: "p-1", path: "a.ts" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/foreign field "path"/);
  });
  it("registry knows applyProposal and never auto-retries it", () => {
    const def = getOperationDef("applyProposal");
    expect(def).not.toBeNull();
    expect(def?.idempotent).toBe(false);
  });
});

describe("rename staging over mock SmartEdit RPC", () => {
  it("rename attaches proposalId with a mock bus server", async () => {
    const bus = memBus();
    const server = createRpcServer({
      bus,
      channel: RPC_CHANNELS.workspaceEdit,
      handler: async (req) => {
        if (req.rpc === WORKSPACE_EDIT_RPC_METHODS.stage) {
          return { ok: true, proposalId: "prop-1", files: ["a.ts"], diff: "diff-text" };
        }
        if (req.rpc === WORKSPACE_EDIT_RPC_METHODS.apply) {
          return { ok: true, status: "applied", text: "applied 1 file", diagnostics: [], changedFiles: ["/tmp/x.ts"] };
        }
        throw new Error(`unexpected ${req.rpc}`);
      },
    });
    const session = await seedBoundSession({
      fileName: "a.ts",
      content: "const alpha = 1;\n",
      descriptorId: "ts",
      reply: (method, sourceUri) => {
        if (method !== "textDocument/rename") throw new Error(`unexpected ${method}`);
        return { changes: { [sourceUri]: [{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } }, newText: "bbb" }] } };
      },
    });
    try {
      const tool = createLspTool({ getBus: () => bus });
      const ctx = { ...(CTX as unknown as Record<string, unknown>), cwd: session.root } as never;
      const res = await (tool.execute as Function)(
        "call-1",
        { operation: "rename", path: "a.ts", position: { line: 0, character: 1 }, newName: "bbb", server: "ts" },
        undefined,
        undefined,
        ctx,
      );
      expect(res.details.proposal.proposalId).toBe("prop-1");
      expect(res.content[0].text).toMatch(/prop-1/);
      expect(session.methods).toEqual(["textDocument/rename"]);
      const applied = await (tool.execute as Function)(
        "call-2",
        { operation: "applyProposal", proposalId: res.details.proposal.proposalId },
        undefined,
        undefined,
        ctx,
      );
      expect(applied.details.apply.status).toBe("applied");
      expect(applied.content[0].text).toMatch(/applied 1 file/);
    } finally {
      server.dispose();
      bus.dispose();
      await releaseSeededSession(session);
    }
  });

  it("rename with no server returns the unchanged read-only result", async () => {
    const tool = createLspTool({ executeOperation: executorReturning(RENAME_EDIT) as never });
    const res = await (tool.execute as Function)(
      "call-1",
      { operation: "rename", path: "a.ts", position: { line: 0, character: 1 }, newName: "bbb" },
      undefined,
      undefined,
      CTX,
    );
    expect(res.details.proposal).toBeUndefined();
    expect(res.content[0].text).not.toMatch(/prop-1/);
  });
});

describe("applyProposal", () => {
  it("returns SmartEdit status/text with a mock server", async () => {
    const bus = memBus();
    const server = createRpcServer({
      bus,
      channel: RPC_CHANNELS.workspaceEdit,
      handler: async (req) => {
        if (req.rpc === WORKSPACE_EDIT_RPC_METHODS.apply) {
          return { ok: true, status: "applied", text: "applied 1 file", diagnostics: [], changedFiles: ["/tmp/x.ts"] };
        }
        throw new Error(`unexpected ${req.rpc}`);
      },
    });
    try {
      const tool = createLspTool({ getBus: () => bus });
      const res = await (tool.execute as Function)("call-9", { operation: "applyProposal", proposalId: "p-1" }, undefined, undefined, CTX);
      expect(res.content[0].text).toMatch(/applied 1 file/);
      expect(res.details.apply.status).toBe("applied");
    } finally {
      server.dispose();
      bus.dispose();
    }
  });

  it("with no server returns unavailable", async () => {
    const tool = createLspTool();
    const res = await (tool.execute as Function)("call-9", { operation: "applyProposal", proposalId: "p-1" }, undefined, undefined, CTX);
    expect(res.details.envelope.status).toBe("unavailable");
    expect(res.details.envelope.operation).toBe("applyProposal");
  });

  // A proposalId only exists if SmartEdit answered at stage time, so once an
  // apply request is sent, a missing or invalid reply means the outcome is
  // unknown (the write may have committed) — never "unavailable".
  it("server error after send reports unknown outcome, not unavailable", async () => {
    const bus = memBus();
    const server = createRpcServer({
      bus,
      channel: RPC_CHANNELS.workspaceEdit,
      handler: async () => {
        throw new Error("finalization exploded");
      },
    });
    try {
      const tool = createLspTool({ getBus: () => bus });
      const res = await (tool.execute as Function)("call-9", { operation: "applyProposal", proposalId: "p-1" }, undefined, undefined, CTX);
      expect(res.details.envelope).toBeUndefined();
      expect(res.details.apply.status).toBe("unknown");
      expect(res.content[0].text).toMatch(/finalization exploded/);
      expect(res.content[0].text).toMatch(/re-read/i);
    } finally {
      server.dispose();
      bus.dispose();
    }
  });

  it("timeout after send reports unknown outcome, not unavailable", async () => {
    vi.useFakeTimers();
    const bus = memBus();
    try {
      const tool = createLspTool({ getBus: () => bus });
      const pending = (tool.execute as Function)("call-9", { operation: "applyProposal", proposalId: "p-1" }, undefined, undefined, CTX);
      await vi.advanceTimersByTimeAsync(WORKSPACE_EDIT_APPLY_TIMEOUT_MS + 1);
      const res = await pending;
      expect(res.details.envelope).toBeUndefined();
      expect(res.details.apply.status).toBe("unknown");
      expect(res.content[0].text).toMatch(/timed out/);
    } finally {
      vi.useRealTimers();
      bus.dispose();
    }
  });

  it("apply timeout is long enough for post-edit lanes", () => {
    expect(WORKSPACE_EDIT_APPLY_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
  });

  it("FAIL-FIRST: non-utf-16 encoding does not stage (fail closed)", async () => {
    const bus = memBus();
    let stageCalls = 0;
    const server = createRpcServer({
      bus,
      channel: RPC_CHANNELS.workspaceEdit,
      handler: async (req) => {
        if (req.rpc === WORKSPACE_EDIT_RPC_METHODS.stage) {
          stageCalls++;
          return { ok: true, proposalId: "prop-utf8", files: ["a.ts"], diff: "" };
        }
        throw new Error(`unexpected ${req.rpc}`);
      },
    });
    try {
      const utf8 = executorReturning(RENAME_EDIT);
      const toolWithUtf8 = createLspTool({
        executeOperation: (async () => {
          const env = await (utf8 as () => Promise<Record<string, unknown>>)();
          (env.server as Record<string, unknown>).positionEncoding = "utf-8";
          return env as never;
        }) as never,
        getBus: () => bus,
      });
      const res = await (toolWithUtf8.execute as Function)(
        "call-1",
        { operation: "rename", path: "a.ts", position: { line: 0, character: 1 }, newName: "bbb" },
        undefined,
        undefined,
        CTX,
      );
      expect(stageCalls).toBe(0);
      expect(res.details.proposal).toBeUndefined();
    } finally {
      server.dispose();
      bus.dispose();
    }
  });

  it("FAIL-FIRST: absolute request path stages with that exact absolute filePath", async () => {
    const bus = memBus();
    let seenFilePath: string | null = null;
    const server = createRpcServer({
      bus,
      channel: RPC_CHANNELS.workspaceEdit,
      handler: async (req) => {
        if (req.rpc === WORKSPACE_EDIT_RPC_METHODS.stage) {
          const payload = req.payload as { workspaceEdit?: { fileEdits?: { filePath?: unknown }[] } };
          const filePath = payload.workspaceEdit?.fileEdits?.[0]?.filePath;
          seenFilePath = typeof filePath === "string" ? filePath : null;
          return { ok: true, proposalId: "prop-abs", files: seenFilePath ? [seenFilePath] : [], diff: "" };
        }
        throw new Error(`unexpected ${req.rpc}`);
      },
    });
    const session = await seedBoundSession({
      fileName: "b.ts",
      content: "const beta = 1;\n",
      descriptorId: "ts",
      reply: (method) => {
        if (method !== "textDocument/formatting") throw new Error(`unexpected ${method}`);
        return [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "x" }];
      },
    });
    try {
      const tool = createLspTool({ getBus: () => bus });
      const ctx = { ...(CTX as unknown as Record<string, unknown>), cwd: session.root } as never;
      const res = await (tool.execute as Function)(
        "call-2",
        { operation: "formatDocument", path: session.source, server: "ts" },
        undefined,
        undefined,
        ctx,
      );
      expect(seenFilePath).toBe(session.source);
      expect(res.details.proposal.proposalId).toBe("prop-abs");
      expect(session.methods).toEqual(["textDocument/formatting"]);
    } finally {
      server.dispose();
      bus.dispose();
      await releaseSeededSession(session);
    }
  });

  it("invalidates caches after an applied result", async () => {
    clearFileReadCache();
    const bus = memBus();
    const server = createRpcServer({
      bus,
      channel: RPC_CHANNELS.workspaceEdit,
      handler: async () => ({ ok: true, status: "applied", text: "ok", diagnostics: [], changedFiles: ["/tmp/y.ts"] }),
    });
    try {
      const fsScan = await import("../../../src/workspace/fs-scan-cache.js");
      const spy = vi.spyOn(fsScan, "invalidateFsScanCache");
      const tool = createLspTool({ getBus: () => bus });
      await (tool.execute as Function)("call-9", { operation: "applyProposal", proposalId: "p-1" }, undefined, undefined, CTX);
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    } finally {
      server.dispose();
      bus.dispose();
    }
  });
});
