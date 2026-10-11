import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLspTool } from "../../../src/lsp/lsp-tool.js";
import type { BoundActionOutcome } from "../../../src/lsp/lsp-action-adapter.js";

const context = { cwd: "/tmp/action-tool-lifetime" } as ExtensionContext;
const request = {
  operation: "resolveCodeAction",
  workspace: "/tmp/action-tool-lifetime",
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => vi.restoreAllMocks());

describe("LSP action tool lifetime", () => {
  it("returns cancellation without waiting for adapter-owned cleanup", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const cleanup = deferred<{ readonly state: "released" }>();
    const entered = deferred<void>();
    const controller = new AbortController();
    const dispatch = vi.fn(async (): Promise<BoundActionOutcome> => {
      entered.resolve();
      return { kind: "result", envelope, cleanup: cleanup.promise };
    });
    const tool = createLspTool({
      executorDeps: { executeBoundAction: dispatch, now: Date.now },
      getBus: () => ({ on: () => () => {}, emit: () => {} }),
      getSessionFilePath: () => "/tmp/action-tool-lifetime/session.jsonl",
      getCwd: () => "/tmp/action-tool-lifetime",
    });
    let call: ReturnType<typeof tool.execute> | undefined;
    let observed: Promise<void> | undefined;
    let settled = false;
    let published: Awaited<ReturnType<typeof tool.execute>> | undefined;
    let failure: unknown;
    try {
      call = tool.execute("call", { ...request, timeoutMs: 10 }, controller.signal, undefined, context);
      observed = call.then((value) => { settled = true; published = value; }, (error: unknown) => { settled = true; failure = error; });
      await Promise.race([entered.promise, call.then(() => { throw new Error("bound-action adapter was not invoked"); })]);
      controller.abort();
      await vi.advanceTimersByTimeAsync(10);
      expect(settled).toBe(true);
      expect(failure).toBeUndefined();
      if (!published) throw new Error("caller did not publish within its deadline");
      const result = published;
      expect((result.details as { envelope: { status: string } }).envelope.status).toBe("cancelled");
      expect(result.details).not.toHaveProperty("proposal");
      expect(JSON.stringify(result)).not.toContain("proposalId");
      expect(cleanup.promise).toBeInstanceOf(Promise);
    } finally {
      cleanup.resolve({ state: "released" });
      try {
        await cleanup.promise;
        if (call) await call;
        if (observed) await observed;
      } finally {
        vi.useRealTimers();
      }
    }
  });

  it("lets caller cancellation beat a finite clock callback at facade proposal projection", async () => {
    const controller = new AbortController();
    let facadeProjectionReached = false;
    let callbackAborted = false;
    const now = vi.fn(() => {
      if (facadeProjectionReached && !callbackAborted) {
        callbackAborted = true;
        controller.abort();
      }
      return 10;
    });
    const proposal = {
      proposalId: "private-proposal",
      files: ["/tmp/action-tool-lifetime/target.ts"],
      get diff(): string {
        facadeProjectionReached = true;
        return "private diff";
      },
    };
    const dispatch = vi.fn(async (): Promise<BoundActionOutcome> => ({
      kind: "result",
      envelope,
      proposal,
      cleanup: Promise.resolve({ state: "released" }),
    }));
    const tool = createLspTool({
      executorDeps: { executeBoundAction: dispatch, now },
      getBus: () => ({ on: () => () => {}, emit: () => {} }),
      getSessionFilePath: () => "/tmp/action-tool-lifetime/session.jsonl",
      getCwd: () => "/tmp/action-tool-lifetime",
    });
    const result = await tool.execute("call", request, controller.signal, undefined, context);
    expect(facadeProjectionReached).toBe(true);
    expect(callbackAborted).toBe(true);
    expect((result.details as { envelope: { status: string } }).envelope.status).toBe("cancelled");
    expect(result.details).not.toHaveProperty("proposal");
    expect(JSON.stringify(result)).not.toContain("private-proposal");
    expect(JSON.stringify(result)).not.toContain("private diff");
  });
});
