/** Stage 4 (option A): applyProposal staging/apply over SmartEdit RPC. Failing-first. */
import { describe, expect, it, vi } from "vitest";
import { validateStrictRequest } from "../../../src/lsp/lsp-strict-contract.js";
import { getOperationDef } from "../../../src/lsp/lsp-operation-registry.js";
import { createLspTool } from "../../../src/lsp/lsp-tool.js";
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

const CTX = {
  cwd: "/tmp/apply-proposal-test",
  sessionManager: { getSessionFile: () => "/tmp/apply-proposal-test-session.jsonl" },
} as never;

const RENAME_EDIT = {
  changes: [
    {
      uri: "file:///tmp/apply-proposal-test/a.ts",
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
      projectRoot: "/tmp/apply-proposal-test",
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
        throw new Error(`unexpected ${req.rpc}`);
      },
    });
    try {
      const tool = createLspTool({
        executorDeps: { acquire: async () => null } as never,
        getBus: () => bus,
      });
      // Bypass executor wiring: inject via executorDeps.acquire is not enough;
      // drive through the real executor seam with a stubbed executeLspOperation.
      const mod = await import("../../../src/lsp/lsp-executor.js");
      const spy = vi.spyOn(mod, "executeLspOperation").mockImplementationOnce(executorReturning(RENAME_EDIT) as never);
      try {
        const res = await (tool.execute as Function)(
          "call-1",
          { operation: "rename", path: "a.ts", position: { line: 0, character: 1 }, newName: "bbb" },
          undefined,
          undefined,
          CTX,
        );
        expect(res.details.proposal.proposalId).toBe("prop-1");
        expect(res.content[0].text).toMatch(/prop-1/);
      } finally {
        spy.mockRestore();
      }
    } finally {
      server.dispose();
      bus.dispose();
    }
  });

  it("rename with no server returns the unchanged read-only result", async () => {
    const mod = await import("../../../src/lsp/lsp-executor.js");
    const spy = vi.spyOn(mod, "executeLspOperation").mockImplementationOnce(executorReturning(RENAME_EDIT) as never);
    try {
      const tool = createLspTool();
      const res = await (tool.execute as Function)(
        "call-1",
        { operation: "rename", path: "a.ts", position: { line: 0, character: 1 }, newName: "bbb" },
        undefined,
        undefined,
        CTX,
      );
      expect(res.details.proposal).toBeUndefined();
      expect(res.content[0].text).not.toMatch(/prop-1/);
    } finally {
      spy.mockRestore();
    }
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
      const tool = createLspTool({
        executorDeps: { acquire: async () => null } as never,
        getBus: () => bus,
      });
      const mod = await import("../../../src/lsp/lsp-executor.js");
      const utf8 = executorReturning(RENAME_EDIT);
      const spy = vi.spyOn(mod, "executeLspOperation").mockImplementationOnce(async () => {
        const env = await (utf8 as () => Promise<Record<string, unknown>>)();
        (env.server as Record<string, unknown>).positionEncoding = "utf-8";
        return env as never;
      });
      try {
        const res = await (tool.execute as Function)(
          "call-1",
          { operation: "rename", path: "a.ts", position: { line: 0, character: 1 }, newName: "bbb" },
          undefined,
          undefined,
          CTX,
        );
        expect(stageCalls).toBe(0);
        expect(res.details.proposal).toBeUndefined();
      } finally {
        spy.mockRestore();
      }
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
          seenFilePath = (req.payload as { workspaceEdit: { fileEdits: { filePath: string }[] } })?.workspaceEdit?.fileEdits?.[0]?.filePath ?? null;
          return { ok: true, proposalId: "prop-abs", files: [seenFilePath ?? ""], diff: "" };
        }
        throw new Error(`unexpected ${req.rpc}`);
      },
    });
    try {
      const tool = createLspTool({
        executorDeps: { acquire: async () => null } as never,
        getBus: () => bus,
      });
      const mod = await import("../../../src/lsp/lsp-executor.js");
      const FORMAT_EDITS = [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "x" }];
      const spy = vi.spyOn(mod, "executeLspOperation").mockImplementationOnce(async () => ({
        status: "ok",
        operation: "formatDocument",
        method: "textDocument/formatting",
        server: {
          descriptorId: "ts",
          name: "ts",
          languageId: "typescript",
          projectRoot: "/tmp/apply-proposal-test",
          positionEncoding: "utf-16",
        },
        result: FORMAT_EDITS,
        meta: { truncated: false },
      }) as never);
      try {
        const res = await (tool.execute as Function)(
          "call-2",
          { operation: "formatDocument", path: "/tmp/apply-proposal-test/b.ts" },
          undefined,
          undefined,
          CTX,
        );
        expect(seenFilePath).toBe("/tmp/apply-proposal-test/b.ts");
        expect(res.details.proposal.proposalId).toBe("prop-abs");
      } finally {
        spy.mockRestore();
      }
    } finally {
      server.dispose();
      bus.dispose();
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
