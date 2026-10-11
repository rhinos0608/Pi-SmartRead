import { describe, expect, it, vi } from "vitest";
import { executeLspActionDetailed, executeLspOperation, type ExecutorDeps } from "../../../src/lsp/lsp-executor.js";
import type { BoundActionOutcome } from "../../../src/lsp/lsp-action-adapter.js";
import type { StrictEnvelope } from "../../../src/lsp/lsp-strict-contract.js";

const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
const request = { operation: "codeActions", path: "a.ts", range } as const;
const okEnvelope: StrictEnvelope = {
  status: "ok", operation: "codeActions", method: "textDocument/codeAction",
  server: { descriptorId: "ts", name: "ts", languageId: "typescript", projectRoot: "/repo", positionEncoding: "utf-16" },
  result: [], meta: { truncated: false },
};

function result(cleanup: Promise<{ state: "released" }>, envelope: StrictEnvelope = okEnvelope, proposal?: { proposalId: string; files: readonly string[]; diff: string }): BoundActionOutcome {
  return { kind: "result", envelope, ...(proposal ? { proposal } : {}), cleanup };
}
function deps(executeBoundAction: NonNullable<ExecutorDeps["executeBoundAction"]>, overrides: Partial<ExecutorDeps> = {}): ExecutorDeps {
  return { cwd: "/repo", executeBoundAction, ...overrides };
}

describe("action executor publication boundary", () => {
  it("dispatches both action operations through the bound adapter with captured query and routing", async () => {
    const calls: unknown[][] = [];
    const cleanup = Promise.resolve({ state: "released" as const });
    const executeBoundAction: NonNullable<ExecutorDeps["executeBoundAction"]> = vi.fn(async (...args) => {
      calls.push(args);
      return result(cleanup);
    });
    const signal = new AbortController().signal;
    const getManager = vi.fn();
    const acquire = vi.fn();
    const sharedDeps = deps(executeBoundAction, { cwd: "/repo", signal, getManager, acquire, now: () => 100 });
    await executeLspActionDetailed({ ...request, server: "ts", context: { only: ["quickfix"] } }, sharedDeps);
    await executeLspOperation({ operation: "resolveCodeAction", path: "a.ts", range, selection: { actionId: "id", sourceSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, server: "ts" }, sharedDeps);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.[0]).toMatchObject({ operation: "codeActions", path: "/repo/a.ts", range, context: { only: ["quickfix"] } });
    expect(calls[0]?.[1]).toMatchObject({ projectRoot: "/repo", languageId: "typescript", server: "ts" });
    expect(calls[0]?.[2]).toMatchObject({ deadlineMs: 15100, signal, now: sharedDeps.now });
    expect(calls[1]?.[0]).toMatchObject({ operation: "resolveCodeAction", selection: { actionId: "id", sourceSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } });
    expect(getManager).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
  });

  it("uses a trusted absolute action deadline without recapturing a duration", async () => {
    const cleanup = Promise.resolve({ state: "released" as const });
    let adapterDeadline: number | undefined;
    const executeBoundAction: NonNullable<ExecutorDeps["executeBoundAction"]> = async (_request, _route, adapterDeps) => {
      adapterDeadline = adapterDeps.deadlineMs;
      return result(cleanup);
    };
    const now = vi.fn(() => 100);
    const detailed = await executeLspActionDetailed(request, deps(executeBoundAction, {
      now,
      defaultTimeoutMs: 50,
      actionDeadlineMs: 110,
    }));
    expect(detailed.deadlineMs).toBe(110);
    expect(now).toHaveBeenCalled();
    expect(adapterDeadline).toBe(110);
  });

  it("refuses an expired trusted absolute deadline without dispatch", async () => {
    const executeBoundAction: NonNullable<ExecutorDeps["executeBoundAction"]> = vi.fn(async () => result(Promise.resolve({ state: "released" as const })));
    const detailed = await executeLspActionDetailed(request, deps(executeBoundAction, {
      now: () => 110,
      actionDeadlineMs: 110,
    }));
    expect(detailed.outcome.kind).toBe("refusal");
    expect(detailed.outcome.kind === "refusal" && detailed.outcome.status).toBe("timeout");
    expect(executeBoundAction).not.toHaveBeenCalled();
  });

  it("publishes caller cancellation that happens inside its final clock callback", async () => {
    const controller = new AbortController();
    const cleanup = Promise.resolve({ state: "released" as const });
    // Budget phase call counts are intentionally not part of this publication contract.
    let dispatchEntered = false;
    const executeBoundAction: NonNullable<ExecutorDeps["executeBoundAction"]> = vi.fn(async () => { dispatchEntered = true; return result(cleanup); });
    const env = await executeLspOperation(request, deps(executeBoundAction, {
      signal: controller.signal,
      now: () => { if (dispatchEntered) controller.abort(); return 100; },
    }));
    expect(env.status).toBe("cancelled");
    expect(executeBoundAction).toHaveBeenCalledTimes(1);
  });

  it("cancellation raised by a throwing initial clock beats the clock failure", async () => {
    const controller = new AbortController();
    const executeBoundAction: NonNullable<ExecutorDeps["executeBoundAction"]> = vi.fn(async () => result(Promise.resolve({ state: "released" as const })));
    const env = await executeLspOperation(request, deps(executeBoundAction, {
      signal: controller.signal,
      now: () => { controller.abort(); throw new Error("clock failed"); },
    }));
    expect(env.status).toBe("cancelled");
    expect(executeBoundAction).not.toHaveBeenCalled();
  });

  it("refuses unknown-language actions without dispatch or manager lookup", async () => {
    const executeBoundAction: NonNullable<ExecutorDeps["executeBoundAction"]> = vi.fn(async () => result(Promise.resolve({ state: "released" as const })));
    const getManager = vi.fn();
    const detailed = await executeLspActionDetailed({ ...request, path: "a.unknown" }, deps(executeBoundAction, { getManager }));
    expect(detailed.outcome.kind).toBe("refusal");
    expect(detailed.outcome.kind === "refusal" && detailed.outcome.status).toBe("unavailable");
    expect(executeBoundAction).not.toHaveBeenCalled();
    expect(getManager).not.toHaveBeenCalled();
  });

  it("preserves the caller signal identity if the clock callback mutates dependency signal", async () => {
    const controller = new AbortController();
    const cleanup = Promise.resolve({ state: "released" as const });
    const executeBoundAction: NonNullable<ExecutorDeps["executeBoundAction"]> = vi.fn(async () => result(cleanup));
    const mutable = deps(executeBoundAction, { signal: controller.signal, now: () => 100 });
    mutable.now = () => { mutable.signal = new AbortController().signal; return 100; };
    const detailed = await executeLspActionDetailed(request, mutable);
    expect(detailed.signal).toBe(controller.signal);
  });

  it("rejects detailed publication after a captured deadline and retains private proposal", async () => {
    const cleanup = Promise.resolve({ state: "released" as const });
    const proposal = { proposalId: "private", files: ["a.ts"], diff: "secret diff" };
    const envelope: StrictEnvelope = { ...okEnvelope, result: [{ title: "action" }] };
    let dispatchEntered = false;
    const executeBoundAction: NonNullable<ExecutorDeps["executeBoundAction"]> = vi.fn(async () => { dispatchEntered = true; return result(cleanup, envelope, proposal); });
    const detailed = await executeLspActionDetailed({ ...request, timeoutMs: 5 }, deps(executeBoundAction, { now: () => dispatchEntered ? 105 : 100 }));
    expect(detailed.outcome.kind).toBe("refusal");
    expect(detailed.outcome.kind === "refusal" && detailed.outcome.status).toBe("timeout");
    expect(detailed.outcome.cleanup).toBe(cleanup);
  });

  it("lets original cancellation beat invalid initial clock and non-language refusal", async () => {
    const controller = new AbortController();
    controller.abort();
    const executeBoundAction: NonNullable<ExecutorDeps["executeBoundAction"]> = vi.fn(async () => result(Promise.resolve({ state: "released" as const })));
    const env = await executeLspOperation({ ...request, path: "a.unknown" }, deps(executeBoundAction, { signal: controller.signal, now: () => Number.NaN }));
    expect(env.status).toBe("cancelled");
    expect(executeBoundAction).not.toHaveBeenCalled();
  });

  it("guards detailed entry when the original caller signal is already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const executeBoundAction: NonNullable<ExecutorDeps["executeBoundAction"]> = vi.fn(async () => result(Promise.resolve({ state: "released" as const })));
    const detailed = await executeLspActionDetailed(request, deps(executeBoundAction, { signal: controller.signal, now: () => 100 }));
    expect(detailed.outcome.kind).toBe("refusal");
    expect(detailed.outcome.kind === "refusal" && detailed.outcome.status).toBe("cancelled");
    expect(executeBoundAction).not.toHaveBeenCalled();
  });

  it("prioritizes cancellation over throwing or expiring clock callbacks", async () => {
    for (const stopClock of [
      (controller: AbortController) => { controller.abort(); throw new Error("clock"); },
      (controller: AbortController) => { controller.abort(); return 110; },
    ]) {
      const controller = new AbortController();
      let dispatchEntered = false;
      const executeBoundAction: NonNullable<ExecutorDeps["executeBoundAction"]> = vi.fn(async () => {
        dispatchEntered = true;
        return result(Promise.resolve({ state: "released" as const }));
      });
      const env = await executeLspOperation(request, deps(executeBoundAction, {
        signal: controller.signal,
        defaultTimeoutMs: 10,
        now: () => dispatchEntered ? stopClock(controller) : 100,
      }));
      expect(env.status).toBe("cancelled");
    }
  });

  it("keeps known expiration when adapter dispatch rejects", async () => {
    let dispatchEntered = false;
    const executeBoundAction: NonNullable<ExecutorDeps["executeBoundAction"]> = vi.fn(async () => {
      dispatchEntered = true;
      throw new Error("adapter rollback");
    });
    const env = await executeLspOperation({ ...request, timeoutMs: 5 }, deps(executeBoundAction, { now: () => dispatchEntered ? 105 : 100 }));
    expect(env.status).toBe("timeout");
    expect(executeBoundAction).toHaveBeenCalledTimes(1);
  });

  it("keeps an adapter-reported timeout ahead of a later clock failure", async () => {
    const cleanup = Promise.resolve({ state: "released" as const });
    const timeout: StrictEnvelope = { ...okEnvelope, status: "timeout", result: null };
    let dispatchEntered = false;
    const executeBoundAction: NonNullable<ExecutorDeps["executeBoundAction"]> = vi.fn(async () => { dispatchEntered = true; return result(cleanup, timeout); });
    const env = await executeLspOperation(request, deps(executeBoundAction, { now: () => { if (dispatchEntered) throw new Error("clock"); return 100; } }));
    expect(env.status).toBe("timeout");
  });

  it("projects private proposal and does not await pending cleanup; rejection is observed", async () => {
    let rejectCleanup!: (error: Error) => void;
    const cleanup = new Promise<{ state: "released" }>((_resolve, reject) => { rejectCleanup = reject; });
    const proposal = { proposalId: "private", files: ["a.ts"], diff: "private diff" };
    const executeBoundAction: NonNullable<ExecutorDeps["executeBoundAction"]> = vi.fn(async () => result(cleanup, okEnvelope, proposal));
    try {
      const detailed = await executeLspActionDetailed(request, deps(executeBoundAction, { now: () => 100 }));
      expect(detailed.outcome.kind === "result" && detailed.outcome.proposal).toEqual(proposal);
      const publicResult = await executeLspOperation(request, deps(executeBoundAction, { now: () => 100 }));
      expect(publicResult).toEqual(okEnvelope);
      expect(Object.keys(publicResult).some((key) => /proposal|cleanup|deadline|origin|receipt|clock/i.test(key))).toBe(false);
    } finally {
      rejectCleanup(new Error("cleanup failed"));
      await cleanup.catch(() => undefined);
    }
  });

  it.each([
    { mode: "detailed", removal: 1 },
    { mode: "public", removal: 2 },
  ])("guards $mode publication after budget disposal cancels the caller", async ({ mode, removal }) => {
    const controller = new AbortController();
    const cleanup = Promise.resolve({ state: "released" as const });
    const dispatch: NonNullable<ExecutorDeps["executeBoundAction"]> = vi.fn(async () => result(cleanup));
    const remove = controller.signal.removeEventListener.bind(controller.signal);
    let removals = 0;
    const observer = vi.spyOn(controller.signal, "removeEventListener").mockImplementation((type, listener, options) => {
      remove(type, listener, options);
      if (++removals === removal) controller.abort();
    });
    try {
      const options = deps(dispatch, { signal: controller.signal, now: () => 100 });
      if (mode === "detailed") {
        const detailed = await executeLspActionDetailed(request, options);
        expect(detailed.outcome.kind).toBe("refusal");
        expect(detailed.outcome.kind === "refusal" && detailed.outcome.status).toBe("cancelled");
      } else {
        expect((await executeLspOperation(request, options)).status).toBe("cancelled");
      }
      expect(controller.signal.aborted).toBe(true);
    } finally {
      observer.mockRestore();
      await cleanup;
    }
  });

  it.each([
    { mode: "detailed", removal: 1 },
    { mode: "public", removal: 2 },
  ])("guards $mode publication after disposal observes expiration", async ({ mode, removal }) => {
    let removals = 0;
    const cleanup = Promise.resolve({ state: "released" as const });
    const dispatch: NonNullable<ExecutorDeps["executeBoundAction"]> = vi.fn(async () => result(cleanup));
    const signal = new AbortController().signal;
    const remove = signal.removeEventListener.bind(signal);
    let disposed = false;
    const observer = vi.spyOn(signal, "removeEventListener").mockImplementation((type, listener, options) => {
      remove(type, listener, options);
      if (++removals === removal) disposed = true;
    });
    try {
      const options = deps(dispatch, { signal, defaultTimeoutMs: 5, now: () => disposed ? 106 : 100 });
      if (mode === "detailed") {
        const detailed = await executeLspActionDetailed(request, options);
        expect(detailed.outcome.kind).toBe("refusal");
        expect(detailed.outcome.kind === "refusal" && detailed.outcome.status).toBe("timeout");
        expect(detailed.outcome.kind === "result" ? detailed.outcome.proposal : undefined).toBeUndefined();
      } else {
        const envelope = await executeLspOperation(request, options);
        expect(envelope.status).toBe("timeout");
        expect(envelope.result).toBeNull();
        expect(Object.keys(envelope).some((key) => /proposal|cleanup|deadline|origin|receipt|clock/i.test(key))).toBe(false);
      }
    } finally {
      observer.mockRestore();
      await cleanup;
    }
  });

  it.each([
    { mode: "detailed", removal: 1 },
    { mode: "public", removal: 2 },
  ])("guards $mode publication after disposal observes clock failure", async ({ mode, removal }) => {
    let removals = 0;
    const cleanup = Promise.resolve({ state: "released" as const });
    const dispatch: NonNullable<ExecutorDeps["executeBoundAction"]> = vi.fn(async () => result(cleanup));
    const signal = new AbortController().signal;
    const remove = signal.removeEventListener.bind(signal);
    let disposed = false;
    const observer = vi.spyOn(signal, "removeEventListener").mockImplementation((type, listener, options) => {
      remove(type, listener, options);
      if (++removals === removal) disposed = true;
    });
    try {
      const options = deps(dispatch, { signal, now: () => { if (disposed) throw new Error("clock failed"); return 100; } });
      if (mode === "detailed") {
        const detailed = await executeLspActionDetailed(request, options);
        expect(detailed.outcome.kind).toBe("refusal");
        expect(detailed.outcome.kind === "refusal" && detailed.outcome.status).toBe("unavailable");
      } else {
        const envelope = await executeLspOperation(request, options);
        expect(envelope.status).toBe("unavailable");
        expect(envelope.result).toBeNull();
        expect(Object.keys(envelope).some((key) => /proposal|cleanup|deadline|origin|receipt|clock/i.test(key))).toBe(false);
      }
    } finally {
      observer.mockRestore();
      await cleanup;
    }
  });
});
