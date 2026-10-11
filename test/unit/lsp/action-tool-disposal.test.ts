import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createLspTool } from "../../../src/lsp/lsp-tool.js";
import type { BoundActionOutcome } from "../../../src/lsp/lsp-action-adapter.js";

const context = { cwd: "/tmp/action-tool-disposal" } as ExtensionContext;
const request = {
  operation: "resolveCodeAction",
  path: "source.ts",
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
  selection: { actionId: "selected", sourceSha256: "a".repeat(64) },
};
const envelope = {
  status: "ok" as const,
  operation: "resolveCodeAction" as const,
  method: "codeAction/resolve",
  result: { title: "Fix" },
  meta: { truncated: false },
};

function result(): BoundActionOutcome {
  return { kind: "result", envelope, cleanup: Promise.resolve({ state: "released" }) };
}

function readEnvelope(value: unknown): { status: string; result: unknown } {
  if (!value || typeof value !== "object" || !("details" in value)) throw new Error("tool details missing");
  const details: unknown = value.details;
  if (!details || typeof details !== "object" || !("envelope" in details)) throw new Error("tool envelope missing");
  const found: unknown = details.envelope;
  if (!found || typeof found !== "object" || !("status" in found) || !("result" in found) || typeof found.status !== "string") {
    throw new Error("strict envelope malformed");
  }
  return { status: found.status, result: found.result };
}

describe("LSP action tool early-exit disposal", () => {
  it.each(["cwd", "bus"] as const)("publishes caller cancellation raised by budget disposal after %s timeout", async (stopAt) => {
    let clock = 0;
    const controller = new AbortController();
    let removalHookFired = false;
    const remove = controller.signal.removeEventListener.bind(controller.signal);
    const removal = vi.spyOn(controller.signal, "removeEventListener").mockImplementation((type, listener, options) => {
      remove(type, listener, options);
      if (!removalHookFired) {
        removalHookFired = true;
        controller.abort();
      }
    });
    const dispatch = vi.fn(async (): Promise<BoundActionOutcome> => result());
    const tool = createLspTool({
      executorDeps: { executeBoundAction: dispatch, now: () => clock },
      ...(stopAt === "cwd" ? {
        getCwd: () => {
          clock = 20;
          return "/tmp/action-tool-disposal";
        },
      } : {
        getBus: () => {
          clock = 20;
          return { on: () => () => {}, emit: () => {} };
        },
      }),
    });
    let call: ReturnType<typeof tool.execute> | undefined;
    try {
      call = tool.execute("call", { ...request, timeoutMs: 10 }, controller.signal, undefined, context);
      const response = await call;
      expect(removalHookFired).toBe(true);
      expect(controller.signal.aborted).toBe(true);
      expect(readEnvelope(response)).toEqual({ status: "cancelled", result: null });
      expect(response.details).not.toHaveProperty("proposal");
      expect(JSON.stringify(response)).not.toContain("proposalId");
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      removal.mockRestore();
      if (call) await call;
    }
  });

  it("lets expiry at facade disposal override a detailed unsupported refusal", async () => {
    let clock = 0;
    const controller = new AbortController();
    let ownerListener: Parameters<AbortSignal["addEventListener"]>[1] | undefined;
    let ownerRemoved = false;
    const add = controller.signal.addEventListener.bind(controller.signal);
    const remove = controller.signal.removeEventListener.bind(controller.signal);
    const addition = vi.spyOn(controller.signal, "addEventListener").mockImplementation((type, listener, options) => {
      if (type === "abort" && !ownerListener) ownerListener = listener;
      add(type, listener, options);
    });
    const removal = vi.spyOn(controller.signal, "removeEventListener").mockImplementation((type, listener, options) => {
      remove(type, listener, options);
      if (listener === ownerListener) { ownerRemoved = true; clock = 20; }
    });
    const cleanup = Promise.resolve({ state: "not-acquired" as const });
    const dispatch = vi.fn(async (): Promise<BoundActionOutcome> => ({ kind: "refusal", status: "unsupported", cleanup }));
    const tool = createLspTool({
      executorDeps: { now: () => clock, executeBoundAction: dispatch },
      getCwd: () => { expect(ownerListener).toBeDefined(); return context.cwd; },
    });
    let call: ReturnType<typeof tool.execute> | undefined;
    try {
      call = tool.execute("call", { ...request, timeoutMs: 10 }, controller.signal, undefined, context);
      const response = await call;
      expect(ownerRemoved).toBe(true);
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(readEnvelope(response)).toEqual({ status: "timeout", result: null });
      expect(response.details).not.toHaveProperty("proposal");
    } finally {
      addition.mockRestore();
      removal.mockRestore();
      await cleanup;
      if (call) await call;
    }
  });

  it("propagates undefined callback failures after budget disposal", async () => {
    const controller = new AbortController();
    let disposed = false;
    const remove = controller.signal.removeEventListener.bind(controller.signal);
    const removal = vi.spyOn(controller.signal, "removeEventListener").mockImplementation((type, listener, options) => {
      remove(type, listener, options);
      disposed = true;
    });
    const failure: unknown = undefined;
    const tool = createLspTool({ executorDeps: { now: () => 0 }, getCwd: () => { throw failure; } });
    try {
      const outcome = await tool.execute("call", { ...request, timeoutMs: 10 }, controller.signal, undefined, context).then(
        () => ({ kind: "returned" as const }),
        (error: unknown) => ({ kind: "thrown" as const, error }),
      );
      expect(disposed).toBe(true);
      expect(outcome).toEqual({ kind: "thrown", error: undefined });
    } finally {
      removal.mockRestore();
    }
  });

  it("publishes cancellation raised during disposal ahead of a callback exception", async () => {
    let clock = 0;
    const controller = new AbortController();
    let removalHookFired = false;
    const remove = controller.signal.removeEventListener.bind(controller.signal);
    const removal = vi.spyOn(controller.signal, "removeEventListener").mockImplementation((type, listener, options) => {
      remove(type, listener, options);
      if (!removalHookFired) {
        removalHookFired = true;
        controller.abort();
      }
    });
    const tool = createLspTool({
      executorDeps: { now: () => clock },
      getCwd: () => {
        clock = 20;
        throw new Error("callback failed");
      },
    });
    let call: ReturnType<typeof tool.execute> | undefined;
    try {
      call = tool.execute("call", { ...request, timeoutMs: 10 }, controller.signal, undefined, context);
      const response = await call;
      expect(removalHookFired).toBe(true);
      expect(controller.signal.aborted).toBe(true);
      expect(readEnvelope(response)).toEqual({ status: "cancelled", result: null });
      expect(response.details).not.toHaveProperty("proposal");
      expect(JSON.stringify(response)).not.toContain("callback failed");
    } finally {
      removal.mockRestore();
      if (call) await call;
    }
  });

  it("contains an unhandled rejection from cleanup promise on refusal outcomes", async () => {
    let unhandled: unknown = null;
    const onUnhandled = (err: unknown) => { unhandled = err; };
    process.on("unhandledRejection", onUnhandled);
    const cleanupError = new Error("cleanup-failure-in-refusal");
    const cleanup = Promise.reject(cleanupError);
    const dispatch = vi.fn(async (): Promise<BoundActionOutcome> => ({
      kind: "refusal",
      status: "unavailable",
      cleanup,
    }));
    const tool = createLspTool({
      executorDeps: { now: () => 0, executeBoundAction: dispatch },
    });
    try {
      const response = await tool.execute("call", request, undefined, undefined, context);
      expect(readEnvelope(response).status).toBe("unavailable");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toBeNull();
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await cleanup.catch(() => undefined);
    }
  });
});
