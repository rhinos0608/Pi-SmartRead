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
import { createEvidenceResolver } from "./workspace-evidence-resolver.js";
import { RPC_CHANNELS } from "@rhinos0608/pi-workspace-protocol";

// ── Register all tools with the central registry ───────────────────

// Explicitly initialize registry before declaring tools.
// Inspect is registered at extension activation time via installInspectAndResolver.
const registry = ToolRegistry.getInstance();

// Shared evidence resolver. Created lazily because the event bus
// is only available at extension runtime. The factory is stored on
// the registry and consumed by the extension at activation time.
let sharedResolver: ReturnType<typeof createEvidenceResolver> | null = null;

/**
 * Install the inspect tool and the versioned evidence RPC resolver on the
 * extension's event bus. Called by the extension at activation time.
 *
 * - Registers `inspect` (additive, single-file, line-range optional).
 * - Subscribes to RPC `resolve_evidence` requests on `RPC_CHANNELS.inspectPatch`.
 * - Rebuilds the resolver cache from any `inspect` tool_result details seen
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
    const offRpc = await resolver.install();
    return () => {
        offInspect();
        offRead();
        offRpc();
        resolver.dispose();
    };
}

export function getSharedEvidenceResolver(bus?: { emit: (c: string, d: unknown) => void; on: (c: string, h: (d: unknown) => void) => () => void }): ReturnType<typeof createEvidenceResolver> {
    if (!sharedResolver && bus) {
        sharedResolver = createEvidenceResolver({
            bus,
            channel: RPC_CHANNELS.inspectPatch,
        });
    }
    if (!sharedResolver) {
        // Placeholder without bus — used only in MCP-server-only context
        // where no event bus is wired. The MCP server does not run patch.
        sharedResolver = createEvidenceResolver({
            bus: { emit: () => {}, on: () => () => {} },
            channel: RPC_CHANNELS.inspectPatch,
        });
    }
    return sharedResolver;
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
export function buildInspectToolForExtension(getSessionFilePath: () => string | null): ToolDefinition {
    return createInspectTool({
        resolver: {
            publishInspection: (envelope, sessionFilePath, workspaceRoot) => {
                getSharedEvidenceResolver().publishInspection(envelope as any, sessionFilePath, workspaceRoot);
            },
        },
        getSessionFilePath,
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
