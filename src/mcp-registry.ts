/**
 * MCP Tool Registry for Pi-SmartRead.
 *
 * Consumes from the central ToolRegistry and produces flat tool lists
 * for the MCP stdio server. Keeps the MCP server itself free of
 * registration logic.
 *
 * This module is the single point where all tools are registered with
 * the central registry before being consumed by the MCP server or pi
 * extension API.
 */
import { ToolRegistry, ToolCategory } from "./tool-registry.js";
import { createGraphMutateTool } from "./graph-mutate.js";
import { createGitNotesTools } from "./git-notes-tool.js";
import { createSkillTool } from "./skill-tool.js";
import { loadExperimentalConfig } from "./config.js";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { toToolDefinition, toToolDefinitions } from "./types.js";
import { createInspectTool } from "./inspect-tool.js";
import { createGrepTool } from "./grep-tool.js";
import { createEvidenceResolver } from "./workspace-evidence-resolver.js";
import { RPC_CHANNELS } from "@rhinos0608/pi-workspace-protocol";
import { ContextGraph } from "./context-graph.js";
import { getSharedLspInspectionProvider, type LspInspectionProvider } from "./lsp-inspection.js";

// ── Shared ContextGraph (lazy) ─────────────────────────────────────
// Module-level singleton. Built lazily on first access. Rebuilt when
// the watcher marks it dirty. Passed to inspect/grep via DI — never
// imported into hook.ts to avoid cycles.
//
// Two accessors:
//  - getSharedContextGraph(): synchronous, returns the instance without
//    awaiting a build. Kept for direct/internal tests and non-graph paths.
//  - getSharedContextGraphAsync(): awaits a successful buildContextGraph()
//    (including the call graph) before returning. Registered public runtime
//    tools (grep graphFilter, inspect graph-dependent params) MUST use this
//    so they never receive an unbuilt graph. Concurrent callers coalesce on
//    a single build promise; a failed build stays retryable/dirty and the
//    shared instance is only replaced after a successful rebuild.
let sharedContextGraph: ContextGraph | null = null;
let sharedContextGraphRoot: string | null = null;
let sharedContextGraphBuilt = false;
// Invalidation revision: bumped by invalidateSharedGraph() whenever the
// workspace mutates (watcher event, successful write/edit/graph_mutate).
let graphRevision = 0;
// Revision of the workspace state that the currently shared graph reflects.
// -1 until the first successful build. A graph is only fresh for a caller
// when graphRevision === sharedGraphRevision (the mutation was included).
let sharedGraphRevision = -1;
// In-flight build chain. A single tail promise; a rebuild triggered while a
// build is running is chained after it, so concurrent callers coalesce onto
// identical required builds but a mutation invalidating a mid-flight build
// still produces a graph rebuilt after the mutation.
let buildTail: Promise<void> | null = null;
let buildTailRoot: string | null = null;
// Cap on chained rebuild attempts per getSharedContextGraphAsync call: a
// mutation storm must not rebuild forever. After the cap, the most recently
// built graph is returned even if a newer revision exists.
const MAX_GRAPH_BUILD_ATTEMPTS = 3;

/**
 * Get or create the shared ContextGraph for the given root.
 * When dirty is true, forces a full rebuild.
 *
 * Synchronous — does NOT await buildContextGraph(). Use
 * getSharedContextGraphAsync() from registered runtime tools.
 */

/**
 * Mark the shared graph stale because the workspace changed. Any graph built
 * before this call no longer reflects current state and will be rebuilt on the
 * next graph-dependent request. Safe to call while a build is in flight: the
 * in-flight build is not promoted (its revision is stale) and a rebuild is
 * chained after it.
 */
export function invalidateSharedGraph(): void {
  graphRevision++;
}

/**
 * Read-only access to the monotonic workspace revision. Bumped by every
 * workspace mutation (watcher event, successful write/edit/graph_mutate).
 * Consumed by grep's no-index BM25 corpus cache to decide when a cached
 * corpus is stale. A single global monotonic counter is used (not per-root):
 * a mutation anywhere bumps it for every root, which causes only extra cache
 * misses (never stale corpus data), keeping the graph invalidation semantics
 * unchanged.
 */
export function getWorkspaceRevision(): number {
  return graphRevision;
}

/**
 * Synchronous peek at the shared ContextGraph for a root, returning it only
 * when it has actually been built for that root (never triggering a build).
 * Null when unbuilt or built for a different root. Lets no-index grep reuse
 * the structural symbol index without eagerly building the graph.
 */
export function getSharedContextGraphIfBuilt(root: string): ContextGraph | null {
  return sharedContextGraphBuilt && sharedContextGraphRoot === root ? sharedContextGraph : null;
}
export function getSharedContextGraph(
    root: string,
    dirty?: boolean,
): ContextGraph {
    if (!sharedContextGraph || sharedContextGraphRoot !== root || dirty) {
        sharedContextGraph = new ContextGraph(root);
        sharedContextGraphRoot = root;
        sharedContextGraphBuilt = false;
    }
    return sharedContextGraph;
}

/**
 * Get the shared ContextGraph for the given root, awaiting a successful
 * buildContextGraph({ includeCalls: true }) before returning. Concurrent
 * callers coalesce onto identical required builds. A build invalidated
 * mid-flight (a mutation arrived while it was building) is NOT promoted and a
 * rebuild is chained after it, so callers never receive a graph built before a
 * mutation that is still marked fresh. A failed build throws (caller stays
 * retryable/dirty) and the shared instance is only swapped after success.
 */
export async function getSharedContextGraphAsync(
    root: string,
    dirty?: boolean,
): Promise<ContextGraph> {
    // An explicit dirty request forces a rebuild regardless of current state.
    if (dirty) invalidateSharedGraph();
    const requiredRevision = graphRevision;
    let buildAttempts = 0;
    for (;;) {
        // Fast path: a built graph that already covers the required revision.
        if (sharedContextGraphBuilt && sharedContextGraphRoot === root && sharedGraphRevision >= requiredRevision) {
            return sharedContextGraph!;
        }
        // Coalesce onto an in-flight build for this root, then re-evaluate.
        if (buildTail && buildTailRoot === root) {
            const tail = buildTail;
            try { await tail; } catch { /* retryable: loop schedules a rebuild */ }
            if (buildTail === tail) { buildTail = null; buildTailRoot = null; }
            continue;
        }
        // Cap reached: return the most recently built graph even when a newer
        // revision is pending (a mutation storm must not rebuild forever).
        if (buildAttempts >= MAX_GRAPH_BUILD_ATTEMPTS) {
            if (sharedContextGraph && sharedContextGraphRoot === root) return sharedContextGraph;
            // No graph ever built — fall through to one final build below.
        }
        // Chain a build after any existing tail. It targets the latest
        // revision at the moment it actually starts building.
        buildTailRoot = root;
        const prev = buildTail;
        const tailPromise = (async () => {
            if (prev) { try { await prev; } catch { /* retryable */ } }
            const startRevision = graphRevision;
            const candidate = new ContextGraph(root);
            await candidate.buildContextGraph({ includeCalls: true });
            // Promote only if no mutation invalidated the build mid-flight.
            if (graphRevision === startRevision) {
                sharedContextGraph = candidate;
                sharedContextGraphRoot = root;
                sharedContextGraphBuilt = true;
                sharedGraphRevision = startRevision;
            }
        })();
        buildTail = tailPromise;
        try {
            await tailPromise;
            buildAttempts++;
        } catch (err) {
            // Failed build: keep the previous graph, remain retryable/dirty.
            // Clear the built flag only when the shared graph no longer covers
            // the current revision — an earlier chained build may have already
            // promoted a valid current graph.
            if (sharedGraphRevision < graphRevision) {
                sharedContextGraphBuilt = false;
            }
            throw err;
        }
        // Loop re-evaluates; if invalidated mid-build, a rebuild is chained.
    }
}

/** Dispose the shared ContextGraph (for test isolation / shutdown). */
export function resetSharedContextGraph(): void {
    sharedContextGraph = null;
    sharedContextGraphRoot = null;
    sharedContextGraphBuilt = false;
    graphRevision = 0;
    sharedGraphRevision = -1;
    buildTail = null;
    buildTailRoot = null;
}

// Explicitly initialize registry before declaring tools.
// Inspect is registered at extension activation time via installInspectAndResolver.
const registry = ToolRegistry.getInstance();

// Shared evidence resolver. Created lazily because the event bus
// is only available at extension runtime. The factory is stored on
// the registry and consumed by the extension at activation time.
type EvidenceBus = {
    emit: (c: string, d: unknown) => void;
    on: (c: string, h: (d: unknown) => void) => () => void;
};

let sharedResolver: ReturnType<typeof createEvidenceResolver> | null = null;
let sharedResolverBus: EvidenceBus | null = null;

/**
 * Install the inspect tool and the versioned evidence RPC resolver on the
 * extension's event bus. Called by the extension at activation time.
 *
 * - Registers path-based `inspect` mode.
 * - Subscribes to RPC `resolve_evidence` requests on `RPC_CHANNELS.inspectPatch`.
 * - Rebuilds the resolver cache from any `inspect`/`read` tool_result details seen
 *   on the bus. The tool result details are the durable source of truth.
 */
export async function installInspectAndResolver(bus: {
    emit: (c: string, d: unknown) => void;
    on: (c: string, h: (d: unknown) => void) => () => void;
}): Promise<() => void> {
    const resolver = getSharedEvidenceResolver(bus);
    // Make sure inspect is registered
    if (!registry.has("inspect")) {
        const def = buildInspectToolForExtension(() => null);
        registry.register({
            name: "inspect",
            description: def.description,
            inputSchema: def.parameters as Record<string, unknown>,
            execute: def.execute,
            category: ToolCategory.READ,
        });
    }
    // Listen for inspect/read tool_result events to re-index envelopes
    const reindex = (raw: unknown) => {
        try {
            if (!raw || typeof raw !== "object") return;
            const ev = raw as { details?: { workspaceEvidence?: unknown }; sessionFilePath?: unknown; workspaceRoot?: unknown };
            if (!ev.details || typeof ev.details.workspaceEvidence !== "object") return;
            const sessionFilePath = typeof ev.sessionFilePath === "string" ? ev.sessionFilePath : null;
            const workspaceRoot = typeof ev.workspaceRoot === "string" ? ev.workspaceRoot : null;
            if (!sessionFilePath || !workspaceRoot) return;
            resolver.publishInspection(ev.details.workspaceEvidence as any, sessionFilePath, workspaceRoot);
        } catch {
            /* ignore re-index errors silently */
        }
    };
    const offInspect = bus.on("pi.tool_result.inspect", reindex);
    const offRead = bus.on("pi.tool_result.read", reindex);
    const offGrep = bus.on("pi.tool_result.grep", reindex);
    const offRpc = await resolver.install();
    return () => {
        offInspect();
        offRead();
        offGrep();
        offRpc();
        resolver.dispose();
    };
}

export function getSharedEvidenceResolver(bus?: EvidenceBus): ReturnType<typeof createEvidenceResolver> {
    // Pi can replace its event bus during extension reload/session replacement.
    // A resolver bound to the previous bus is indistinguishable from a dead
    // server to SmartEdit, which then waits for its RPC timeout. Rebind eagerly
    // whenever activation supplies a different live bus; this also replaces a
    // placeholder created by an early tool-registry import.
    if (bus && sharedResolverBus !== bus) {
        sharedResolver?.dispose();
        sharedResolver = createEvidenceResolver({
            bus,
            channel: RPC_CHANNELS.inspectPatch,
        });
        sharedResolverBus = bus;
    }
    if (!sharedResolver) {
        // Placeholder without bus — used only in MCP-server-only context
        // where no event bus is wired. The MCP server does not run patch.
        sharedResolver = createEvidenceResolver({
            bus: { emit: () => {}, on: () => () => {} },
            channel: RPC_CHANNELS.inspectPatch,
        });
        sharedResolverBus = null;
    }
    return sharedResolver;
}

/** Dispose module-global resolver state for explicit teardown and test isolation. */
export function resetSharedEvidenceResolver(): void {
    sharedResolver?.dispose();
    sharedResolver = null;
    sharedResolverBus = null;
}

function reg(name: string, factory: () => ToolDefinition, category: ToolCategory, experimental = false): void {
    if (registry.has(name)) return;
    const def = factory();
    registry.register({ name, description: def.description, inputSchema: def.parameters as Record<string, unknown>, execute: def.execute, category, experimental });
}

reg("skill", () => toToolDefinition(createSkillTool()), ToolCategory.SKILL);

// Standalone MCP stdio server has no live event bus, so `inspect` is
// registered with a null session-file resolver here. The Pi extension
// path (buildInspectToolForExtension / registerInspectToolWithBus) always
// takes precedence when a live bus is available; `reg()` is a no-op if
// the tool is already present in the registry.
reg("inspect", () => buildInspectToolForExtension(() => null), ToolCategory.READ);
reg("grep", () => createGrepTool({
    contextGraph: (root) => getSharedContextGraphAsync(root),
    getWorkspaceRevision,
    getSharedContextGraphIfBuilt,
}), ToolCategory.READ);

// Inspect tool is registered at extension activation time so it can use
// the live event bus. We expose a helper that the extension calls to add
// it to the registry.
export function registerInspectToolWithBus(bus: { emit: (c: string, d: unknown) => void; on: (c: string, h: (d: unknown) => void) => () => void }): void {
    if (registry.has("inspect")) return;
    const resolver = getSharedEvidenceResolver(bus);
    const def = createInspectTool({
        resolver: {
            publishInspection: (envelope, sessionFilePath, workspaceRoot) => {
                resolver.publishInspection(envelope as any, sessionFilePath, workspaceRoot);
            },
        },
        getSessionFilePath: () => null, // Overridden by extension
        contextGraph: (root) => getSharedContextGraphAsync(root),
        lspInspectionProvider: getSharedLspInspectionProvider(),
    });
    // Override the tool factory in the extension path: see registerInspectToolExtension below
    registry.register({
        name: "inspect",
        description: def.description,
        inputSchema: def.parameters as Record<string, unknown>,
        execute: def.execute,
        category: ToolCategory.READ,
    });
}

/**
 * Build a fresh inspect tool definition that uses a real session file accessor.
 * This is the version actually consumed by the pi extension.
 */
export function buildInspectToolForExtension(
    getSessionFilePath: () => string | null,
    contextGraphOverride?: ContextGraph | (() => ContextGraph | Promise<ContextGraph>),
    lspInspectionProviderOverride?: LspInspectionProvider,
): ToolDefinition {
    return createInspectTool({
        resolver: {
            publishInspection: (envelope, sessionFilePath, workspaceRoot) => {
                getSharedEvidenceResolver().publishInspection(envelope as any, sessionFilePath, workspaceRoot);
            },
        },
        getSessionFilePath,
        contextGraph: contextGraphOverride ?? ((root) => getSharedContextGraphAsync(root)),
        lspInspectionProvider: lspInspectionProviderOverride ?? getSharedLspInspectionProvider(),
    });
}

const experimental = loadExperimentalConfig();
if (experimental.graphMutate) {
    reg("graph_mutate", () => toToolDefinition(createGraphMutateTool()), ToolCategory.MUTATE, true);
}
if (experimental.gitNotes) {
    const notesTools = toToolDefinitions(createGitNotesTools());
    for (const def of notesTools) {
        registry.register({ name: def.name, description: def.description, inputSchema: def.parameters as Record<string, unknown>, execute: def.execute, category: ToolCategory.NOTES, experimental: true });
    }
}


// ── Build ───────────────────────────────────────────────────────────

/**
 * Build and return the full MCP tool list for the stdio server.
 */
export function buildToolRegistry(): ToolDefinition[] {
    return ToolRegistry.getInstance().getToolDefinitions();
}
