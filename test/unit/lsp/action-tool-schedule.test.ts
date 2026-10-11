import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createLspTool } from "../../../src/lsp/lsp-tool.js";
import type { BoundActionOutcome, BoundActionAdapterDependencies } from "../../../src/lsp/lsp-action-adapter.js";
import type { ExecutorDeps } from "../../../src/lsp/lsp-executor.js";

const context = { cwd: "/tmp/action-tool-schedule" } as ExtensionContext;
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

function result(proposal?: { proposalId: string; files: readonly string[]; diff: string }): BoundActionOutcome {
  return {
    kind: "result",
    envelope,
    ...(proposal ? { proposal } : {}),
    cleanup: Promise.resolve({ state: "released" }),
  };
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

describe("LSP action tool schedule controls", () => {
  it.each([Number.NaN, Number.POSITIVE_INFINITY])("reports unsupported for invalid entry clock %s without dispatch", async (time) => {
    const dispatch = vi.fn(async (): Promise<BoundActionOutcome> => result());
    const tool = createLspTool({ executorDeps: { executeBoundAction: dispatch, now: () => time } });
    const response = await tool.execute("call", { ...request, timeoutMs: 10 }, undefined, undefined, context);
    expect(readEnvelope(response).status).toBe("unsupported");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("returns cancelled for an already-aborted caller without dispatch", async () => {
    const controller = new AbortController();
    controller.abort();
    const dispatch = vi.fn(async (): Promise<BoundActionOutcome> => result());
    const tool = createLspTool({ executorDeps: { executeBoundAction: dispatch, now: () => 100 } });
    const response = await tool.execute("call", request, controller.signal, undefined, context);
    expect(readEnvelope(response).status).toBe("cancelled");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("uses the invocation deadline when cwd resolution consumes the budget", async () => {
    let clock = 0;
    let callbackReached = false;
    const dispatch = vi.fn(async (_request: unknown, _route: unknown, _deps: BoundActionAdapterDependencies): Promise<BoundActionOutcome> => result());
    const tool = createLspTool({
      executorDeps: { now: () => clock, executeBoundAction: dispatch },
      getCwd: () => {
        callbackReached = true;
        clock = 20;
        return "/tmp/action-tool-schedule";
      },
    });

    const response = await tool.execute("call", { ...request, timeoutMs: 10 }, undefined, undefined, context);

    expect(callbackReached).toBe(true);
    expect(readEnvelope(response).status).toBe("timeout");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("passes the original absolute deadline and clock through context callbacks", async () => {
    let clock = 0;
    let callbackReached = false;
    const originalNow = () => clock;
    const controller = new AbortController();
    let adapterDeps: BoundActionAdapterDependencies | undefined;
    const dispatch = vi.fn(async (_request: unknown, _route: unknown, deps: BoundActionAdapterDependencies): Promise<BoundActionOutcome> => {
      adapterDeps = deps;
      return result();
    });
    const tool = createLspTool({
      executorDeps: { now: originalNow, executeBoundAction: dispatch },
      getCwd: () => {
        callbackReached = true;
        clock = 5;
        return "/tmp/action-tool-schedule";
      },
    });

    await tool.execute("call", { ...request, timeoutMs: 10 }, controller.signal, undefined, context);

    expect(callbackReached).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(adapterDeps?.deadlineMs).toBe(10);
    expect(adapterDeps?.now).toBe(originalNow);
    expect(adapterDeps?.signal).toBe(controller.signal);
  });

  it("retains executor dependencies captured before context callbacks", async () => {
    const clock = 0;
    let callbackReached = false;
    const originalNow = () => clock;
    const originalDispatch = vi.fn(async (_request: unknown, _route: unknown, _deps: BoundActionAdapterDependencies): Promise<BoundActionOutcome> => result());
    const replacementDispatch = vi.fn(async (_request: unknown, _route: unknown, _deps: BoundActionAdapterDependencies): Promise<BoundActionOutcome> => result());
    const executorDeps: ExecutorDeps = { now: originalNow, defaultTimeoutMs: 10, executeBoundAction: originalDispatch };
    const tool = createLspTool({
      executorDeps,
      getCwd: () => {
        callbackReached = true;
        executorDeps.now = () => 100;
        executorDeps.defaultTimeoutMs = 1000;
        executorDeps.executeBoundAction = replacementDispatch;
        return "/tmp/action-tool-schedule";
      },
    });

    await tool.execute("call", request, undefined, undefined, context);

    expect(callbackReached).toBe(true);
    expect(originalDispatch).toHaveBeenCalledTimes(1);
    expect(replacementDispatch).not.toHaveBeenCalled();
    expect(originalDispatch.mock.calls[0]?.[2].now).toBe(originalNow);
    expect(originalDispatch.mock.calls[0]?.[2].deadlineMs).toBe(10);
  });

  it("keeps caller cancellation ahead of facade projection when the clock callback aborts", async () => {
    const controller = new AbortController();
    let projectionReached = false;
    let abortedByCallback = false;
    const now = vi.fn(() => {
      if (projectionReached && !abortedByCallback) {
        abortedByCallback = true;
        controller.abort();
      }
      return 100;
    });
    const proposal = {
      proposalId: "private-proposal",
      files: ["/tmp/action-tool-schedule/target.ts"],
      get diff(): string {
        projectionReached = true;
        return "private diff";
      },
    };
    const dispatch = vi.fn(async (): Promise<BoundActionOutcome> => result(proposal));
    const tool = createLspTool({ executorDeps: { executeBoundAction: dispatch, now } });
    const response = await tool.execute("call", request, controller.signal, undefined, context);
    expect(projectionReached).toBe(true);
    expect(abortedByCallback).toBe(true);
    expect(readEnvelope(response).status).toBe("cancelled");
    expect(response.details).not.toHaveProperty("proposal");
    expect(JSON.stringify(response)).not.toContain("private-proposal");
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("preserves an adapter timeout over a later clock failure and publishes no proposal", async () => {
    let dispatchReturned = false;
    const timeoutEnvelope = { ...envelope, status: "timeout" as const, result: null };
    const dispatch = vi.fn(async (): Promise<BoundActionOutcome> => {
      dispatchReturned = true;
      return {
        kind: "result",
        envelope: timeoutEnvelope,
        proposal: { proposalId: "private-proposal", files: ["target.ts"], diff: "private diff" },
        cleanup: Promise.resolve({ state: "released" }),
      };
    });
    const now = vi.fn(() => {
      if (dispatchReturned) throw new Error("controlled clock failure");
      return 100;
    });
    const tool = createLspTool({ executorDeps: { executeBoundAction: dispatch, now } });
    const response = await tool.execute("call", request, undefined, undefined, context);
    expect(readEnvelope(response).status).toBe("timeout");
    expect(readEnvelope(response).result).toBeNull();
    expect(response.details).not.toHaveProperty("proposal");
    expect(JSON.stringify(response)).not.toContain("private-proposal");
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
