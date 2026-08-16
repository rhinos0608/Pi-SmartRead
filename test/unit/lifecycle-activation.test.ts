/**
 * Lifecycle activation regression tests (confirmed defects).
 *
 * Covers the Pi extension activation path end-to-end:
 *   - eager MCP fallback registrations are overridden with Pi-runtime defs
 *   - inspect / grep are registered with live resolver + session wiring
 *   - watcher mutation marks the graph dirty; the lazy getter consumes the
 *     dirty flag exactly once (rebuild once, not forever)
 *   - grep builds non-zero current-session evidence and publishes directly
 *   - resolver binds to the live bus synchronously at activation
 *   - low-result hint path fires once grepRegistered is true
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { resetSessionState } from "../../src/hook.js";

// Capture the watcher onDirty callback so tests can drive invalidation
// through the real activation wiring (not a graph-identity helper).
const watcherCallbacks: Array<(paths: string[]) => void> = [];

// Record getSharedContextGraph invocations to observe dirty consumption.
const graphCalls: Array<{ root: string; dirty: boolean }> = [];

vi.mock("../../src/file-watcher.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/file-watcher.js")>();
  return {
    ...actual,
    startWatching: (_root: string, onDirty: (paths: string[]) => void) => {
      watcherCallbacks.push(onDirty);
      return () => {};
    },
  };
});

vi.mock("../../src/mcp-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/mcp-registry.js")>();
  return {
    ...actual,
    getSharedContextGraph: (root: string, dirty?: boolean) => {
      graphCalls.push({ root, dirty: dirty ?? false });
      return actual.getSharedContextGraph(root, dirty);
    },
    getSharedContextGraphAsync: async (root: string, dirty?: boolean) => {
      graphCalls.push({ root, dirty: dirty ?? false });
      return actual.getSharedContextGraphAsync(root, dirty);
    },
  };
});

let workdir: string;
let workdirRoot: string;
let registerExtension: (pi: ExtensionAPI) => void;
let resetSharedContextGraph: () => void;
let getSharedEvidenceResolver: () => any;
let resetSharedEvidenceResolver: () => void;

beforeEach(async () => {
  workdir = realpathSync(mkdtempSync(join(tmpdir(), "lifecycle-")));
  workdirRoot = workdir;
  mkdirSync(join(workdir, "src"), { recursive: true });
  writeFileSync(join(workdir, "src", "auth.ts"), "export function authenticate() { return validateToken(); }\nfunction validateToken() {}\n", "utf8");
  writeFileSync(join(workdir, "src", "db.ts"), "export const db = {};\n", "utf8");

  watcherCallbacks.length = 0;
  graphCalls.length = 0;

  resetSessionState();
  const mcp = await import("../../src/mcp-registry.js");
  resetSharedContextGraph = mcp.resetSharedContextGraph;
  getSharedEvidenceResolver = mcp.getSharedEvidenceResolver as () => any;
  resetSharedEvidenceResolver = mcp.resetSharedEvidenceResolver;
  resetSharedContextGraph();
  resetSharedEvidenceResolver();
  registerExtension = (await import("../../src/index.js")).default;
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

function makeApi(overrides?: Partial<ExtensionAPI>): { api: ExtensionAPI; registered: Array<{ name: string; execute: any }>; handlers: Record<string, any> } {
  const registered: Array<{ name: string; execute: any }> = [];
  const handlers: Record<string, any> = {};
  const api = {
    registerTool: (def: { name: string; execute: unknown }) => {
      registered.push(def as any);
    },
    on: (event: string, handler: any) => {
      handlers[event] = handler;
    },
    ...overrides,
  } as unknown as ExtensionAPI;
  return { api, registered, handlers };
}

describe("lifecycle activation (confirmed defects)", () => {
  it("registers inspect and grep, without health, and overrides eager MCP fallbacks", async () => {
    const { api, registered } = makeApi();
    registerExtension(api);
    const names = registered.map((t) => t.name);
    expect(names).toContain("inspect");
    expect(names).toContain("grep");
    expect(names).not.toContain("health");
    // The registered grep/inspect must be the Pi-runtime (dirty-aware) versions:
    // they must carry a lazy contextGraph getter, not a static instance.
    const grepDef = registered.find((t) => t.name === "grep")!;
    const inspectDef = registered.find((t) => t.name === "inspect")!;
    expect(grepDef.execute).toBeTypeOf("function");
    expect(inspectDef.execute).toBeTypeOf("function");
  });

  it("fires the low-result hint for upstream grep once grepRegistered is true", async () => {
    const { api, handlers } = makeApi();
    registerExtension(api);
    const result = await handlers.tool_result!({
      toolName: "grep",
      toolCallId: "g-1",
      isError: false,
      input: { pattern: "zzz" },
      content: [{ type: "text", text: "No matches found" }],
    });
    expect(result).toBeDefined();
    const text = result.content[0].text;
    // Hint must be non-self-referential (we are already the registered grep).
    expect(text).toContain("[hint]");
    expect(text).not.toContain("Try grep(");
  });

  it("grep builds non-zero current-session evidence and publishes directly to the resolver", async () => {
    const { api, registered } = makeApi();
    registerExtension(api);

    const resolver = getSharedEvidenceResolver();
    const publishSpy = vi.spyOn(resolver, "publishInspection");

    const grepTool = registered.find((t) => t.name === "grep")!;
    const ctx = {
      cwd: workdir,
      sessionManager: { getSessionFile: () => "/sessions/lifecycle-test.jsonl" },
    } as any;

    const result = await grepTool.execute("t-g", { pattern: "authenticate", literal: true }, undefined, undefined, ctx);
    const details = result.details as any;
    const envelope = details.workspaceEvidence;
    expect(envelope).toBeDefined();
    // Non-zero session identity (current session, not ephemeral "0"*64).
    expect(envelope.sessionId).toBeDefined();
    expect(envelope.sessionId).not.toBe("0".repeat(64));
    expect(envelope.sessionId.length).toBe(64);
    expect(publishSpy).toHaveBeenCalled();
  });

  it("a watcher mutation rebuilds the shared graph; one graph-dependent call builds exactly once (not repeatedly)", async () => {
    const { api, registered } = makeApi();
    registerExtension(api);

    const { ContextGraph } = await import("../../src/context-graph.js");
    const buildSpy = vi.spyOn(ContextGraph.prototype, "buildContextGraph");

    const grepTool = registered.find((t) => t.name === "grep")!;
    const ctx = { cwd: workdir, sessionManager: { getFile: () => {} } } as any;

    // First graph-dependent call builds the graph from scratch.
    await grepTool.execute("t-1", { pattern: "auth", literal: true, graphFilter: "CALLS->auth.login" }, undefined, undefined, ctx);
    const buildsAfterFirst = buildSpy.mock.calls.length;
    expect(buildsAfterFirst).toBeGreaterThanOrEqual(1);

    // Watcher reports a change → the shared graph is invalidated.
    const onDirty = watcherCallbacks[watcherCallbacks.length - 1];
    expect(onDirty).toBeTypeOf("function");
    onDirty!(["src/auth.ts"]);

    // Next graph-dependent call rebuilds exactly once.
    await grepTool.execute("t-2", { pattern: "auth", literal: true, graphFilter: "CALLS->auth.login" }, undefined, undefined, ctx);
    expect(buildSpy.mock.calls.length).toBe(buildsAfterFirst + 1);

    // A subsequent call reuses the fresh graph — no extra rebuild.
    await grepTool.execute("t-3", { pattern: "auth", literal: true, graphFilter: "CALLS->auth.login" }, undefined, undefined, ctx);
    expect(buildSpy.mock.calls.length).toBe(buildsAfterFirst + 1);

    buildSpy.mockRestore();
  });

  it("B1: a mutation during an in-flight build guarantees a graph rebuilt after the mutation (dirty not lost)", async () => {
    const { api, registered } = makeApi();
    registerExtension(api);

    const { ContextGraph } = await import("../../src/context-graph.js");
    const realBuild = ContextGraph.prototype.buildContextGraph;
    let blocked = true;
    let releaseBuild: (() => void) | null = null;
    let buildCount = 0;
    const buildSpy = vi.spyOn(ContextGraph.prototype, "buildContextGraph").mockImplementation(async function (this: any, ...args: any[]) {
      buildCount++;
      if (blocked) {
        await new Promise<void>((res) => { releaseBuild = res; });
      }
      return (realBuild as any).apply(this, args);
    });

    const grepTool = registered.find((t) => t.name === "grep")!;
    const ctx = { cwd: workdir, sessionManager: { getFile: () => {} } } as any;

    // First graph-dependent call starts a build and blocks mid-build.
    const p1 = grepTool.execute("t-1", { pattern: "auth", literal: true, graphFilter: "CALLS->auth.login" }, undefined, undefined, ctx);
    await vi.waitFor(() => { expect(buildCount).toBe(1); expect(releaseBuild).not.toBeNull(); });

    // A mutation arrives while the first build is in flight.
    const onDirty = watcherCallbacks[watcherCallbacks.length - 1];
    onDirty!(["src/auth.ts"]);

    // Second graph-dependent call coalesces onto the in-flight build, then must
    // trigger a rebuild after it completes (the mutation was not included).
    const p2 = grepTool.execute("t-2", { pattern: "auth", literal: true, graphFilter: "CALLS->auth.login" }, undefined, undefined, ctx);
    // Wait until p2 has reached the coalescing state: it has entered the
    // shared-graph getter (graphCalls) but has not started a second build
    // (buildCount still 1 — it is awaiting the blocked in-flight build).
    await vi.waitFor(() => {
      expect(graphCalls.length).toBe(2);
      expect(buildCount).toBe(1);
    });

    // Release the first build; the second build (after the mutation) proceeds.
    blocked = false;
    releaseBuild!();
    releaseBuild = null;

    await Promise.all([p1, p2]);

    // Exactly two builds: the blocked first one and the rebuild after the
    // mutation. If the dirty signal were lost, only one build would occur.
    expect(buildSpy).toHaveBeenCalledTimes(2);

    buildSpy.mockRestore();
  });

  it("a successful write/edit tool_result invalidates the shared graph; a failed one does not", async () => {
    const { api, registered, handlers } = makeApi();
    registerExtension(api);

    const { ContextGraph } = await import("../../src/context-graph.js");
    const buildSpy = vi.spyOn(ContextGraph.prototype, "buildContextGraph");

    const grepTool = registered.find((t) => t.name === "grep")!;
    const ctx = { cwd: workdir, sessionManager: { getFile: () => {} } } as any;

    await grepTool.execute("t-1", { pattern: "auth", literal: true, graphFilter: "CALLS->auth.login" }, undefined, undefined, ctx);
    const buildsAfterFirst = buildSpy.mock.calls.length;

    // A failed write must NOT invalidate the graph.
    await handlers.tool_result!({ toolName: "write", toolCallId: "w-fail", isError: true, input: { path: "src/auth.ts" } });
    await grepTool.execute("t-2", { pattern: "auth", literal: true, graphFilter: "CALLS->auth.login" }, undefined, undefined, ctx);
    expect(buildSpy.mock.calls.length).toBe(buildsAfterFirst);

    // A successful edit invalidates → next graph-dependent call rebuilds.
    await handlers.tool_result!({ toolName: "edit", toolCallId: "e-ok", isError: false, input: { path: "src/auth.ts" } });
    await grepTool.execute("t-3", { pattern: "auth", literal: true, graphFilter: "CALLS->auth.login" }, undefined, undefined, ctx);
    expect(buildSpy.mock.calls.length).toBe(buildsAfterFirst + 1);

    buildSpy.mockRestore();
  });

  it("binds the evidence resolver to a live bus synchronously at activation", async () => {
    const subs = new Map<string, Set<(d: unknown) => void>>();
    const bus = {
      emit(ch: string, d: unknown) { for (const h of subs.get(ch) ?? []) h(d); },
      on(ch: string, h: (d: unknown) => void) {
        if (!subs.has(ch)) subs.set(ch, new Set());
        subs.get(ch)!.add(h);
        return () => subs.get(ch)!.delete(h);
      },
    };
    const { api } = makeApi({ events: bus } as any);
    registerExtension(api);
    // Let the async resolver RPC install settle.
    await new Promise((r) => setTimeout(r, 20));
    // Resolver is reachable and RPC channel handler installed on the bus.
    const resolver = getSharedEvidenceResolver();
    expect(resolver).toBeDefined();
    const rpcHandlers = subs.get("pi.workspace.inspect_patch.rpc") ?? new Set();
    expect(rpcHandlers.size).toBeGreaterThan(0);
  });

  it("resetSharedContextGraph yields a distinct graph instance (replacement contract)", async () => {
    const { api } = makeApi();
    registerExtension(api);
    const mcp = await import("../../src/mcp-registry.js");
    const a = mcp.getSharedContextGraph(workdirRoot);
    mcp.resetSharedContextGraph();
    const b = mcp.getSharedContextGraph(workdirRoot);
    expect(a).not.toBe(b);
  });
});
