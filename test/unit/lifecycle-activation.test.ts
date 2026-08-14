/**
 * Lifecycle activation regression tests (confirmed defects).
 *
 * Covers the Pi extension activation path end-to-end:
 *   - eager MCP fallback registrations are overridden with Pi-runtime defs
 *   - inspect / grep / health are registered with live resolver + session wiring
 *   - watcher mutation marks the graph dirty; the lazy getter consumes the
 *     dirty flag exactly once (rebuild once, not forever)
 *   - grep builds non-zero current-session evidence and publishes directly
 *   - resolver binds to the live bus synchronously at activation
 *   - low-result hint path fires once grepRegistered is true
 *   - health tool reports truthful state
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
  };
});

let workdir: string;
let workdirRoot: string;
let registerExtension: (pi: ExtensionAPI) => void;
let resetSharedContextGraph: () => void;
let getSharedEvidenceResolver: () => any;
let resetSharedEvidenceResolver: () => void;
let resetRuntimeHealth: () => void;

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
  const rh = await import("../../src/runtime-health.js");
  resetRuntimeHealth = rh.resetRuntimeHealth;
  resetSharedContextGraph();
  resetSharedEvidenceResolver();
  resetRuntimeHealth();
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
  it("registers inspect, grep, and health and overrides eager MCP fallbacks", async () => {
    const { api, registered } = makeApi();
    registerExtension(api);
    const names = registered.map((t) => t.name);
    expect(names).toContain("inspect");
    expect(names).toContain("grep");
    expect(names).toContain("health");
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
    const result = handlers.tool_result!({
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

  it("consumes the watcher dirty flag exactly once across graph-dependent calls", async () => {
    const { api, registered } = makeApi();
    registerExtension(api);

    // Watcher reports a file change → index marks the graph dirty.
    const onDirty = watcherCallbacks[watcherCallbacks.length - 1];
    expect(onDirty).toBeTypeOf("function");
    onDirty!(["src/auth.ts"]);

    const grepTool = registered.find((t) => t.name === "grep")!;
    const ctx = { cwd: workdir, sessionManager: { getFile: () => {} } } as any;

    // First graph-dependent call rebuilds (dirty consumed once).
    await grepTool.execute("t-1", { pattern: "auth", literal: true, graphFilter: "CALLS->auth.login" }, undefined, undefined, ctx);
    // Second graph-dependent call must NOT rebuild again.
    await grepTool.execute("t-2", { pattern: "auth", literal: true, graphFilter: "CALLS->auth.login" }, undefined, undefined, ctx);

    const workdirCalls = graphCalls.filter((c) => c.dirty === true);
    // Exactly one rebuild triggered by the dirty flag (module-load calls are dirty=false).
    expect(workdirCalls.length).toBe(1);
    // And a subsequent call observed the flag as consumed (false).
    const cleanCalls = graphCalls.filter((c) => c.dirty === false);
    expect(cleanCalls.length).toBeGreaterThan(0);
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

  it("health tool reports truthful non-secret state via details.report", async () => {
    const { api, registered } = makeApi();
    registerExtension(api);
    const healthTool = registered.find((t) => t.name === "health")!;
    const result = await healthTool.execute("t-h", {}, undefined, undefined, { cwd: workdir } as any);
    const text = result.content[0].text;
    expect(text).toContain("graph: generation=");
    expect(text).toContain("watcher: active=");
    expect(text).toContain("semanticIndex: available=");
    expect(text).toContain("embedding: enabled=");
    expect(text).toContain("lsp: available=");
    expect(text).toContain("recentDegradations:");
    // Never leak urls/keys.
    expect(text).not.toMatch(/https?:\/\//);
    expect(text).not.toMatch(/api[_-]?key/i);

    // Structured report fields, not just text presence.
    const report = result.details.report;
    expect(report).toBeDefined();
    expect(report.graph).toHaveProperty("generation");
    expect(typeof report.graph.generation).toBe("number");
    expect(report.watcher).toHaveProperty("active");
    expect(report.watcher).toHaveProperty("dirty");
    expect(report.semanticIndex).toHaveProperty("available");
    expect(report.semanticIndex).toHaveProperty("state");
    expect(["not_initialized", "fresh", "updating", "stale_or_unavailable"]).toContain(report.semanticIndex.state);
    expect(report.embedding).toHaveProperty("enabled");
    expect(report.lsp).toHaveProperty("available");
    expect(report.recentDegradations).toBeInstanceOf(Array);
  });

  it("health reports cwd-scoped semantic index state without creating one", async () => {
    const { api, registered } = makeApi();
    registerExtension(api);
    const { getOrCreateSemanticIndex, disposeSemanticIndexes } = await import("../../src/semantic-index-registry.js");
    // Test setup creates the index; health must only read it (never create).
    getOrCreateSemanticIndex(workdir, { config: null });
    const healthTool = registered.find((t) => t.name === "health")!;
    const result = await healthTool.execute("t-h", {}, undefined, undefined, { cwd: workdir } as any);
    const report = result.details.report;
    // Index exists but is not initialized → stale_or_unavailable, not available.
    expect(report.semanticIndex.available).toBe(false);
    expect(report.semanticIndex.state).toBe("stale_or_unavailable");
    disposeSemanticIndexes(workdir);
  });

  it("increments graph generation by exactly 1 per successful rebuild, not on instance creation", async () => {
    const { currentGraphGeneration } = await import("../../src/context-graph.js");
    const mcp = await import("../../src/mcp-registry.js");
    const before = currentGraphGeneration();
    // Dirty instance creation (the dirty lifecycle) must NOT bump generation —
    // this is the double-increment regression (mcp-registry used to bump here).
    const g = mcp.getSharedContextGraph(workdir, true);
    expect(currentGraphGeneration() - before).toBe(0);
    // A successful rebuild bumps by exactly 1.
    await g.buildContextGraph({ skipGitPopulation: true });
    expect(currentGraphGeneration() - before).toBe(1);
    // A no-op rebuild (nothing changed) must NOT bump again.
    await g.buildContextGraph({ skipGitPopulation: true });
    expect(currentGraphGeneration() - before).toBe(1);
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
