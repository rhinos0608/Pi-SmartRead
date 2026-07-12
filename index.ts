import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerSessionHooks } from "./hook.js";
import { coerceText, ensureHashlineReady } from "./utils.js";
import { initHandlers } from "./read-many.js";
import { invalidateFsScanCache } from "./fs-scan-cache.js";
import { ToolRegistry, ToolCategory } from "./tool-registry.js";
import { toToolDefinition } from "./types.js";
import "./mcp-registry.js"; // registers skill, graph_mutate, git_notes with ToolRegistry
import { buildInspectToolForExtension as buildInspectTool, installInspectAndResolver, getSharedEvidenceResolver } from "./mcp-registry.js";
import { createReadTool } from "./unified-read.js";
import { getLSPBridge, resetLSPBridge, shutdownAllManagers } from "./lsp-bridge.js";
// Internal URL router re-exports (enables external consumers to use skill://, memory://, graph:// URLs)
export {
  isInternalUrl,
  resolveUrl,
  parseInternalUrl,
  registerHandler,
  getHandler,
} from "./internal-url-router.js";
export { resolveSkillUrl, resolveMemoryUrl, resolveGraphUrl } from "./internal-url-router.js";

// Workspace evidence resolver
export {
  createEvidenceResolver,
} from "./workspace-evidence-resolver.js";
export {
  buildInspectToolForExtension,
  registerInspectToolWithBus,
  getSharedEvidenceResolver,
} from "./mcp-registry.js";

// ── File-read cache API (re-exported for external use) ───────────────────
export { recordContiguous, recordSparse, getSnapshot, invalidate, clearSession, resolveSessionKey } from "./file-read-cache.js";
export type { FileSnapshot, SearchMatchEntry } from "./file-read-cache.js";

// ── Code summary API ───────────────────────────────────────────────
export { summarizeCode, renderSummary, canSummarize } from "./code-summary.js";
export type { SummaryOptions, SummarySegment, SummaryResult } from "./code-summary.js";

// Context hygiene — tracks tool results and marks stale reads after mutations
import {
  resetContextHygieneTracker,
  buildContextHygieneMetadata,
  buildFileResource,
  recordAnchorDelta,
  type AnchorHygieneEvent,
  type AnchorDeltaEntry,
  type ContextHygieneMetadata,
  type ContextHygieneResource,
} from "./context-hygiene.js";
import { applyContextHygieneStaleContext } from "./context-application.js";

// Doom-loop detection — warns when the LLM repeats identical tool calls
import {
  createDoomLoopState,
  consumeDoomLoopWarning,
  formatDoomLoopMessage,
  recordToolCall,
  recordToolResult,
  resetDoomLoopState,
} from "./doom-loop.js";

// Bash context guard — caps oversized bash output with head/tail preview
import {
  applyBashContextGuard,
  resolveBashContextGuardConfig,
  resolveGuardProfile,
  suggestShellCommands,
} from "./bash-context-guard.js";

const SMARTREAD_GUARD_TOOLS = new Set([
  "inspect",
  "git_notes_read",
]);

// Fire-and-forget hashline init at module load time
ensureHashlineReady().catch((err) =>
  console.error("[SmartRead] hashline init failed:", err)
);

export default async function (pi: ExtensionAPI) {
  // ── Initialise internal URL handlers (skill://, memory://, graph://) ──
  initHandlers();

  // ── Shared state ────────────────────────────────────────────────
  const hygieneTracker = resetContextHygieneTracker();
  const doomLoopState = createDoomLoopState();
  const bashContextGuardConfig = resolveBashContextGuardConfig();

  // Language servers are long-lived during an interactive session, but must
  // be stopped when Pi closes (especially in --print mode) or their child
  // processes keep the harness alive after the tool result has returned.
  pi.on("session_shutdown", async () => {
    await shutdownAllManagers();
    resetLSPBridge();
  });

  // ── Helper: extract resources from tool params for context hygiene ──
  function resourcesForTool(_toolName: string, input: Record<string, unknown>): ContextHygieneResource[] {
    const path = typeof input.path === "string" ? input.path : undefined;
    if (path) return [buildFileResource(path)];
    if (typeof input.filePath === "string") return [buildFileResource(input.filePath)];
    if (typeof input.relative_path === "string") return [buildFileResource(input.relative_path)];
    return [];
  }

  function mutationResourcesForTool(toolName: string, input: Record<string, unknown>): ContextHygieneResource[] {
    if (toolName === "graph_mutate") {
      const resources: ContextHygieneResource[] = [];
      if (typeof input.from === "string") resources.push(buildFileResource(input.from));
      if (typeof input.to === "string") resources.push(buildFileResource(input.to));
      return resources;
    }
    if (toolName === "write" || toolName === "edit") {
      return resourcesForTool(toolName, input);
    }
    return [];
  }

  function classificationForTool(toolName: string): ContextHygieneMetadata["classification"] {
    if (toolName === "graph_mutate" || toolName === "write" || toolName === "edit") return "mutation";
    if (toolName === "bash") return "command-output";
    return "read-context";
  }

  // ── Event hooks ─────────────────────────────────────────────────

  // 1. tool_call: feed doom-loop detector
  pi.on("tool_call", (event: any) => {
    const toolName = event.toolName as string;
    // Invalidate FS scan cache for write/edit mutations so subsequent scans see fresh state
    if (toolName === "write" || toolName === "edit" || toolName === "graph_mutate") {
      const input = (event.input ?? {}) as Record<string, unknown>;
      const target = typeof input.path === "string" ? input.path :
        typeof input.filePath === "string" ? input.filePath :
        typeof input.relative_path === "string" ? input.relative_path : undefined;
      if (target) {
        invalidateFsScanCache(target);
      }
    }

    recordToolCall(
      doomLoopState,
      toolName,
      event.toolCallId,
      (event.input ?? {}) as Record<string, unknown>,
    );
    return undefined;
  });

  // 2. tool_result: record context hygiene, inject doom-loop warnings, apply bash guard
  pi.on("tool_result", (event: any): any => {
    const toolName = event.toolName as string;
    const toolCallId = event.toolCallId as string;
    let outputEvent = event;
    let outputChanged = false;

    // ── Context hygiene: record every tool result ──
    if (toolCallId) {
      const input = (event.input ?? {}) as Record<string, unknown>;
      const mutationResources = mutationResourcesForTool(toolName, input);
      if (mutationResources.length > 0) {
        hygieneTracker.recordMutation(mutationResources, { resultId: toolCallId, tool: toolName });
      } else {
        const metadata = buildContextHygieneMetadata({
          tool: toolName,
          classification: classificationForTool(toolName),
          resources: resourcesForTool(toolName, input),
        });
        hygieneTracker.record(metadata, { resultId: toolCallId });
      }

      // ── Anchor hygiene: consume anchor delta from edit results ──
      if (toolName === "edit" && (event.details as Record<string, unknown>)?.anchorDelta) {
        const ad = (event.details as Record<string, unknown>).anchorDelta as {
          summary: string;
          shifted: number;
          deleted: number;
          changed: number;
        };
        const totalChanges = (ad.shifted || 0) + (ad.deleted || 0) + (ad.changed || 0);
        if (totalChanges > 0) {
          const input = (event.input ?? {}) as Record<string, unknown>;
          const filePath = typeof input.path === "string" ? input.path : undefined;
          if (filePath) {
            const entries: AnchorDeltaEntry[] = [];
            const event_: AnchorHygieneEvent = {
              file: filePath,
              timestamp: Date.now(),
              deltas: entries,
              churnExceeded: totalChanges > 20,
            };
            try {
              recordAnchorDelta(hygieneTracker, event_);
            } catch {
              // Anchor delta recording is advisory
            }
          }
        }
      }
    }

    // ── LSP incremental document tracking ──
    if (toolCallId && event.input) {
      const lspInput = event.input as Record<string, unknown>;
      if (toolName === "read") {
        const readPath =
          (typeof lspInput.path === "string" && lspInput.path) ||
          (typeof lspInput.filePath === "string" && lspInput.filePath);
        if (readPath) {
          getLSPBridge()
            .then((bridge) => bridge?.openFile(readPath, process.cwd()))
            .catch(() => {});
        }
      } else if (toolName === "graph_mutate") {
        const closePaths: string[] = [];
        if (typeof lspInput.from === "string") closePaths.push(lspInput.from);
        if (typeof lspInput.to === "string") closePaths.push(lspInput.to);
        if (closePaths.length > 0) {
          getLSPBridge()
            .then((bridge) => {
              if (!bridge) return;
              const root = (typeof lspInput.root === "string" && lspInput.root) || process.cwd();
              for (const p of closePaths) {
                bridge.closeFile(p, root).catch(() => {});
              }
            })
            .catch(() => {});
        }
      }
    }

    // ── Content chanting: record result text for pattern detection ──
    if (toolCallId) {
      const resultText = Array.isArray(event.content)
        ? event.content
            .filter((c: any): c is { type: "text"; text?: unknown } => c.type === "text")
            .map((c: any) => (typeof c.text === "string" ? c.text : ""))
            .join("\n")
        : "";
      recordToolResult(doomLoopState, toolCallId, resultText);
    }

    // ── Doom-loop: inject warning if this call triggered a loop ──
    const doomLoop = consumeDoomLoopWarning(doomLoopState, toolCallId);
    if (doomLoop && Array.isArray(event.content)) {
      const content = [...event.content];
      const prefix = `${formatDoomLoopMessage(doomLoop)}\n\n---\n`;
      let textIndex = -1;
      for (let i = 0; i < content.length; i++) {
        const item = content[i] as { type?: unknown; text?: unknown };
        if (item.type === "text") {
          textIndex = i;
          break;
        }
      }
      if (textIndex >= 0) {
        const item = content[textIndex] as { type: "text"; text?: unknown };
        content[textIndex] = { ...item, text: `${prefix}${coerceText(item.text)}` };
      } else {
        content.unshift({ type: "text" as const, text: prefix });
      }
      outputEvent = { ...event, content };
      outputChanged = true;
    }

    // ── Bash context guard: cap oversized output for SmartRead tools ──
    if (SMARTREAD_GUARD_TOOLS.has(toolName) && Array.isArray(outputEvent.content)) {
      const textContent = outputEvent.content
        .filter((c: any): c is { type: "text"; text?: unknown } => c.type === "text")
        .map((c: any) => coerceText(c.text))
        .join("\n");

      if (textContent) {
        const profile = resolveGuardProfile(toolName, bashContextGuardConfig);
        const lineCount = textContent === "" ? 0 : textContent.split("\n").length;
        const byteCount = Buffer.byteLength(textContent, "utf8");
        const trimWanted = profile.maxLines > 0 && profile.maxBytes > 0 &&
          (lineCount > profile.maxLines || byteCount > profile.maxBytes);

        if (trimWanted) {
          const result = applyBashContextGuard({
            text: textContent,
            command: undefined,
            toolName,
            details: outputEvent.details,
            config: {
              enabled: true,
              maxLines: profile.maxLines,
              maxBytes: profile.maxBytes,
              headLines: profile.headLines,
              tailLines: profile.tailLines,
            },
          });

          if (result.text !== textContent) {
            const nonTextContent = outputEvent.content.filter(
              (c: any) => c.type !== "text",
            );
            return {
              ...outputEvent,
              content: [{ type: "text", text: result.text }, ...nonTextContent],
              details: {
                ...(outputEvent.details && typeof outputEvent.details === "object" ? outputEvent.details : {}),
                bashContextGuard: { ...result.metadata, toolName },
              },
            };
          }
        }
      }
    }

    // ── Bash context guard: cap oversized bash output ──
    if (toolName === "bash" && bashContextGuardConfig.enabled && Array.isArray(outputEvent.content)) {
      const textContent = outputEvent.content
        .filter((c: any): c is { type: "text"; text?: unknown } => c.type === "text")
        .map((c: any) => coerceText(c.text))
        .join("\n");

      if (textContent) {
        const guarded = applyBashContextGuard({
          text: textContent,
          command: typeof event.input?.command === "string" ? event.input.command : undefined,
          config: bashContextGuardConfig,
        });

        if (guarded.text !== textContent) {
          const nonTextContent = outputEvent.content.filter(
            (c: any) => c.type !== "text",
          );
          return {
            ...outputEvent,
            content: [{ type: "text", text: guarded.text }, ...nonTextContent],
            details: {
              ...(outputEvent.details && typeof outputEvent.details === "object" ? outputEvent.details : {}),
              bashContextGuard: guarded.metadata,
            },
          };
        }
      }
    }

    if (toolName === "bash") {
      const typedInput = event.input as Record<string, unknown> | undefined;
      const cmd = typeof typedInput?.command === "string" ? typedInput.command : undefined;
      const exit = typeof typedInput?.exitCode === "number" ? typedInput.exitCode : undefined;
      const outputText = Array.isArray(outputEvent.content)
        ? outputEvent.content.filter((c: any) => c.type === "text").map((c: any) => coerceText(c.text)).join("\n")
        : "";
      if (cmd && exit !== undefined && exit !== 0) {
        const suggestions = suggestShellCommands(cmd, outputText, exit);
        if (suggestions.length > 0) {
          const suggestionBlock = "\n\nCommand suggestions:\n" + suggestions.map(s => `  • ${s}`).join("\n");
          const content = Array.isArray(outputEvent.content) ? [...outputEvent.content] : [];
          let textIndex = -1;
          for (let i = 0; i < content.length; i++) {
            const item = content[i] as any;
            if (item.type === "text") { textIndex = i; break; }
          }
          if (textIndex >= 0) {
            const item = content[textIndex] as { type: "text"; text?: unknown };
            content[textIndex] = { ...item, text: coerceText(item.text) + suggestionBlock };
            return { ...outputEvent, content };
          }
        }
      }
    }

    return outputChanged ? outputEvent : undefined;
  });

  // 3. context: apply stale markers before messages are sent to the model
  pi.on("context", (event: any): any => {
    if (!Array.isArray(event.messages)) return undefined;
    const report = hygieneTracker.generateReport();
    const messages = applyContextHygieneStaleContext(event.messages, report);
    if (messages === event.messages) return undefined;
    return { messages };
  });

  // ── Tool registration ──────────────────────────────────────────

  // 1. Session hooks: eager repo-map generation + startup injection
  registerSessionHooks({
    ...pi,
    on: ((eventName: string, handler: (...args: any[]) => any) => {
      if (eventName === "session_start" || eventName === "before_agent_start") {
        return (pi.on as any)(eventName, (...args: any[]) => {
          resetDoomLoopState(doomLoopState);
          return handler(...args);
        });
      }
      return (pi.on as any)(eventName, handler);
    }) as ExtensionAPI["on"],
  } as ExtensionAPI);

  // 2. Inspect tool: registered synchronously into the central registry before
  //    the tool-registration loop so it's included in pi.registerTool calls.
  if (!ToolRegistry.getInstance().has("inspect")) {
    const def = buildInspectTool(() => {
      // Default resolver: extension has no live bus, return null.
      // The publish path is wired only when installInspectAndResolver is
      // called from the events bus.
      return null;
    });
    ToolRegistry.getInstance().register({
      name: "inspect",
      description: def.description,
      inputSchema: def.parameters as Record<string, unknown>,
      execute: def.execute,
      category: ToolCategory.READ,
    });
  }

  // 3. Core tools: the loop iterates all tools from ToolRegistry.getAll()
  //    and registers each via pi.registerTool (covers inspect, skill, and any
  //    other registered tools).
  const reg = ToolRegistry.getInstance();
  for (const tool of reg.getAll()) {
    pi.registerTool(toToolDefinition({
      name: tool.name,
      label: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      execute: tool.execute,
    }));
  }

  // 3.5 Read: override the builtin read with the enriched, evidence-emitting
  // wrapper. Publishes envelopes into the shared resolver so patch can
  // resolve an evidenceRef produced by a plain read.
  pi.registerTool(createReadTool({
    publishInspection: (envelope, sessionFilePath, workspaceRoot) => {
      getSharedEvidenceResolver().publishInspection(envelope as any, sessionFilePath, workspaceRoot);
    },
  }));

  // 4. Versioned evidence RPC resolver install: best-effort, runs in the
  //    background. The extension still works without it — inspect just
  //    doesn't publish envelopes for patch to resolve.
  if (pi.events && typeof pi.events.on === "function") {
    void (async () => {
      try {
        const bus = pi.events as { emit: (c: string, d: unknown) => void; on: (c: string, h: (d: unknown) => void) => () => void };
        await installInspectAndResolver(bus);
      } catch (err) {
        try { (pi as any).ui?.notify?.(`pi-workspace-protocol resolver unavailable: ${(err as Error).message}`); } catch { /* ignore */ }
      }
    })();
  }
}
