import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerSessionHooks } from "./hook.js";
import { coerceText, ensureHashlineReady } from "./utils.js";
import { initHandlers } from "./read-many.js";
import { invalidateFsScanCache } from "./fs-scan-cache.js";
import { startWatching } from "./file-watcher.js";
import { ToolRegistry, ToolCategory } from "./tool-registry.js";
import { toToolDefinition } from "./types.js";
import "./mcp-registry.js"; // registers skill, graph_mutate, git_notes with ToolRegistry
import type { ContextGraph } from "./context-graph.js";
import { buildInspectToolForExtension as buildInspectTool, installInspectAndResolver, getSharedEvidenceResolver, getSharedContextGraph, getSharedContextGraphAsync, invalidateSharedGraph, resetSharedContextGraph, getWorkspaceRevision, getSharedContextGraphIfBuilt } from "./mcp-registry.js";
import { createGrepTool, GREP_DESCRIPTION } from "./grep-tool.js";
import { createReadTool } from "./unified-read.js";
import { fileURLToPath } from "node:url";
import { getLSPBridge, resetLSPBridge, shutdownAllManagers } from "./lsp-bridge.js";
import { runPostEditDiagnosticsFallback } from "./post-edit-fallback.js";
import { isDiagnosticsClaimed } from "./mutation-ownership.js";
import { getSemanticIndex } from "./semantic-index-registry.js";
import { registerRepositoryIntelligence } from "./repository-intelligence-registry.js";
import { createRepositoryIntelligenceService } from "./repository-intelligence.js";
import { getIncrementalIndex } from "./incremental-index.js";
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

// ── Symbol resolution for read { symbol } (WP-5) ────────────────
/**
 * Resolve a qualified symbol name to a file path and optional line number.
 * Resolution order: LSP workspace/symbol first, then ContextGraph.findSymbolFiles() fallback.
 * `graphGetter` supplies the dirty-aware lazy ContextGraph (resets the dirty flag once).
 */
/**
 * Convert an LSP location URI to a filesystem path.
 *
 * Handles both `file://` URIs (via fileURLToPath) and raw filesystem paths.
 * Windows drive-letter paths like `D:\src\a.ts` are NOT file URIs and must
 * not be passed to fileURLToPath (which throws on them) — they are returned
 * as-is. Malformed file URIs fall back to the raw string rather than throwing.
 */
export function lspUriToPath(uri: string): string {
  if (typeof uri !== "string" || uri.length === 0) return uri;
  if (uri.startsWith("file:")) {
    try {
      return fileURLToPath(uri);
    } catch {
      return uri;
    }
  }
  // Raw filesystem path (POSIX or Windows drive-letter like D:\...).
  return uri;
}

async function resolveSymbolForReadTool(symbol: string, cwd = process.cwd(), graphGetter?: (root: string) => ContextGraph | Promise<ContextGraph>): Promise<{ path: string; line?: number } | null> {
  const root = cwd;
  try {
    const bridge = await getLSPBridge();
    if (bridge?.isAvailable()) {
      const syms = await bridge.workspaceSymbol(symbol, root);
      if (syms.length > 0) {
        const best = syms.find((s) => s.name === symbol) ?? syms[0];
        if (best) {
          const { uri, range } = best.location;
          return { path: lspUriToPath(uri), line: range.start.line + 1 };
        }
      }
    }
  } catch {
    // LSP not available
  }
  try {
    const graph = graphGetter ? await graphGetter(root) : getSharedContextGraph(root);
    const files = await graph.findSymbolFiles(symbol);
    if (files.length > 0) {
      return { path: files[0]!.path };
    }
  } catch {
    // graph not built
  }
  return null;
}

export default async function (pi: ExtensionAPI) {
  // ── Initialise internal URL handlers (skill://, memory://, graph://) ──
  initHandlers();

  // ── Shared state ────────────────────────────────────────────────
  const hygieneTracker = resetContextHygieneTracker();
  const doomLoopState = createDoomLoopState();
  const bashContextGuardConfig = resolveBashContextGuardConfig();

  // ── File watcher: real-time FS change detection ──
  /** WP-1 writes dirty flag; WP-5 reads it to trigger lazy ContextGraph rebuild. */
  const watchState = {
    stop: undefined as (() => void) | undefined,
  };

  // WP-5: single lazy ContextGraph getter used by inspect, grep, and
  // read-symbol fallback so a graph-dependent call never receives an unbuilt
  // graph. Invalidation is revision-based inside mcp-registry
  // (invalidateSharedGraph) rather than a boolean that could be cleared by a
  // build that did not include the change; the getter just ensures a build
  // covering the latest revision. Concurrent calls coalesce; a mutation during
  // a build queues a rebuild instead of losing the dirty signal.
  const freshGraphGetter = async (root = process.cwd()) => getSharedContextGraphAsync(root);

  // Bind the live evidence resolver synchronously when a bus is present,
  // BEFORE any tool can execute. The async installInspectAndResolver call
  // below reuses this same bus (no rebind) and installs the RPC handler.
  if (pi.events && typeof pi.events.on === "function") {
    try {
      getSharedEvidenceResolver(pi.events as {
        emit: (c: string, d: unknown) => void;
        on: (c: string, h: (d: unknown) => void) => () => void;
      });
    } catch { /* best-effort */ }
  }

  try {
    watchState.stop = startWatching(process.cwd(), (dirtyPaths) => {
      for (const p of dirtyPaths) {
        invalidateFsScanCache(p);
      }
      // WP-5: invalidate semantic index file states for affected paths
      try {
        const semIdx = getSemanticIndex(process.cwd());
        if (semIdx && typeof semIdx.markFilesStale === "function") {
          semIdx.markFilesStale(dirtyPaths);
        }
      } catch { /* semantic index may not exist */ }
      // WP-5: invalidate incremental index cache entries
      try {
        const incIdx = getIncrementalIndex(process.cwd());
        incIdx.invalidate();
      } catch { /* incremental index may not exist */ }
      // WP-5: the workspace changed — the shared graph is stale until rebuilt.
      invalidateSharedGraph();
    });
  } catch (err) {
    console.warn(`[SmartRead] File watcher failed to start: ${(err as Error).message}`);
  }

  // Language servers are long-lived during an interactive session, but must
  // be stopped when Pi closes (especially in --print mode) or their child
  // processes keep the harness alive after the tool result has returned.
  pi.on("session_shutdown", async () => {
    watchState.stop?.();
    watchState.stop = undefined;
    try { resetSharedContextGraph(); } catch { /* may not be loaded */ }
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

  /**
   * Extract authoritative mutation paths from a tool result's
   * `details.changedResources[*].canonicalPath`. ChangedResources is untrusted
   * runtime data, so shape and string-ness are validated; malformed entries are
   * dropped. Returns [] when absent or empty.
   */
  function changedPathsFromDetails(details: unknown): string[] {
    if (!details || typeof details !== "object") return [];
    const changedResources = (details as Record<string, unknown>).changedResources;
    if (!Array.isArray(changedResources)) return [];
    const paths: string[] = [];
    for (const res of changedResources) {
      if (!res || typeof res !== "object") continue;
      const cp = (res as Record<string, unknown>).canonicalPath;
      if (typeof cp === "string" && cp.length > 0) paths.push(cp);
    }
    return paths;
  }

  function mutationResourcesForTool(toolName: string, input: Record<string, unknown>, changedPaths: string[]): ContextHygieneResource[] {
    if (toolName === "graph_mutate") {
      const resources: ContextHygieneResource[] = [];
      if (typeof input.from === "string") resources.push(buildFileResource(input.from));
      if (typeof input.to === "string") resources.push(buildFileResource(input.to));
      return resources;
    }
    if (toolName === "write" || toolName === "edit") {
      // changedResources.canonicalPath is authoritative for edit results when present.
      if (changedPaths.length > 0) return changedPaths.map((p) => buildFileResource(p));
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

    recordToolCall(
      doomLoopState,
      toolName,
      event.toolCallId,
      (event.input ?? {}) as Record<string, unknown>,
    );
    return undefined;
  });

  // 2. tool_result: record context hygiene, inject doom-loop warnings, apply bash guard
  pi.on("tool_result", async (event: any): Promise<any> => {
    const toolName = event.toolName as string;
    const toolCallId = event.toolCallId as string;
    let outputEvent = event;
    let outputChanged = false;
    const input = (event.input ?? {}) as Record<string, unknown>;
    const details = (event.details ?? {}) as Record<string, unknown>;
    // changedResources.canonicalPath is authoritative for edit results when present.
    const changedPaths = toolName === "edit" && !event.isError ? changedPathsFromDetails(details) : [];

    // ── Context hygiene: record every tool result ──
    if (toolCallId) {
      const failedMutation = event.isError && (toolName === "write" || toolName === "edit" || toolName === "graph_mutate");
      const mutationResources = failedMutation
        ? []
        : mutationResourcesForTool(toolName, input, changedPaths);
      if (mutationResources.length > 0) {
        hygieneTracker.recordMutation(mutationResources, { resultId: toolCallId, tool: toolName });
      } else {
        const metadata = buildContextHygieneMetadata({
          tool: toolName,
          classification: failedMutation ? "read-context" : classificationForTool(toolName),
          resources: failedMutation ? [] : resourcesForTool(toolName, input),
        });
        hygieneTracker.record(metadata, { resultId: toolCallId });
      }

      // ── Anchor hygiene: consume anchor delta from edit results ──
      if (toolName === "edit" && details.anchorDelta) {
        const ad = details.anchorDelta as {
          summary: string;
          shifted: number;
          deleted: number;
          changed: number;
        };
        const totalChanges = (ad.shifted || 0) + (ad.deleted || 0) + (ad.changed || 0);
        if (totalChanges > 0) {
          const anchorPaths = changedPaths.length > 0
            ? changedPaths
            : (typeof input.path === "string" ? [input.path] : []);
          for (const filePath of anchorPaths) {
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
      } else if (toolName === "edit" && !event.isError) {
        const editPaths = changedPaths.length > 0
          ? changedPaths
          : (typeof lspInput.path === "string" ? [lspInput.path] : []);
        if (editPaths.length > 0) {
          getLSPBridge()
            .then((bridge) => {
              if (!bridge) return;
              const root = process.cwd();
              for (const p of editPaths) {
                bridge.closeFile(p, root).catch(() => {});
              }
            })
            .catch(() => {});
        }
      }
    }

    // ── Centralized successful mutation invalidation ──
    // Only successful write/edit/graph_mutate results invalidate caches.
    // Failed tool results must NOT mutate state. The watcher remains
    // supplemental (it also invalidates on fs events); this is the authoritative
    // path for tool-driven mutations.
    if (toolName === "write" || toolName === "edit" || toolName === "graph_mutate") {
      if (!event.isError) {
        if (toolName === "graph_mutate") {
          // Graph mutation must cause a graph rebuild on next use.
          invalidateSharedGraph();
        } else {
          const targets = toolName === "edit" && changedPaths.length > 0
            ? changedPaths
            : [input.path, input.filePath, input.relative_path].filter((p): p is string => typeof p === "string");
          for (const target of targets) {
            invalidateFsScanCache(target);
            try {
              const semIdx = getSemanticIndex(process.cwd());
              if (semIdx && typeof semIdx.markFilesStale === "function") {
                semIdx.markFilesStale([target]);
              }
            } catch {
              // semantic invalidation is advisory
            }
          }
          try {
            getIncrementalIndex(process.cwd()).invalidate();
          } catch {
            // incremental-index invalidation is advisory
          }
          // A successful write/edit invalidates the graph: it must be rebuilt
          // on next graph-dependent use (revision-based, not a boolean flag).
          invalidateSharedGraph();
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

    // ── Grep low-result hint: suggest broadening the current query. ──
    if (toolName === "grep" && !event.isError && grepRegistered) {
      const textContent = (outputEvent.content ?? [])
        .filter((c: any): c is { type: "text"; text?: unknown } => c.type === "text")
        .map((c: any) => coerceText(c.text))
        .join("\n");
      const isNoMatch = textContent.trim() === "No matches found";
      const lineCount = textContent.split("\n").filter((l: string) => l.trim()).length;
      const lowMatches = isNoMatch || (lineCount > 0 && lineCount < 4);
      if (lowMatches) {
        const hint = `\n[hint] Low result count. Broaden or rephrase the pattern, or relax the path/glob scope for more matches.`;
        const content = [...(outputEvent.content ?? [])];
        const textIdx = content.findIndex((c: any) => c.type === "text");
        if (textIdx >= 0) {
          content[textIdx] = { ...content[textIdx], text: coerceText((content[textIdx] as any).text) + hint };
        } else {
          content.push({ type: "text", text: hint });
        }
        outputEvent = { ...outputEvent, content };
        outputChanged = true;
      }
    }

    // ── Post-edit LSP diagnostics fallback ──
    // Pi-SmartEdit owns post-mutation diagnostics for write/edit; only step
    // in when it did not claim this toolCallId (not installed, or claimed
    // nothing) so the model still sees LSP-detected issues.
    if (
      (toolName === "write" || toolName === "edit") &&
      !event.isError &&
      toolCallId &&
      !isDiagnosticsClaimed(toolCallId)
    ) {
      try {
        const fallback = await runPostEditDiagnosticsFallback({
          toolName,
          toolCallId,
          isError: event.isError,
          input: event.input as Record<string, unknown> | undefined,
          content: outputEvent.content,
          cwd: process.cwd(),
        });
        if (fallback) {
          outputEvent = { ...outputEvent, content: fallback.content };
          outputChanged = true;
        }
      } catch {
        // Fallback diagnostics are best-effort; never block the tool result.
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

  // 2. Inspect v4: directory → map, file → structural facts + signals
  //    Query mode removed — use grep for code search.
  //    WP-5: pass ContextGraph for graph-dependent params.
  // 2. Inspect: unconditionally replace the eager MCP fallback with a
  //    Pi-runtime definition wired to the dirty-aware freshGraphGetter.
  const inspectDef = buildInspectTool(() => null, freshGraphGetter);
  ToolRegistry.getInstance().registerOrReplace({
    name: "inspect",
    description: inspectDef.description,
    inputSchema: inspectDef.parameters as Record<string, unknown>,
    execute: inspectDef.execute,
    category: ToolCategory.READ,
  });

  // 2.5 Grep: unconditionally replace the eager MCP fallback. WP-5:
  //    pass freshGraphGetter for graphFilter + wire the live evidence
  //    resolver and session-file fallback so grep evidence reaches patch.
  const grepRegistered = true;
  const grepDef = createGrepTool({
    contextGraph: freshGraphGetter,
    resolver: {
      publishInspection: (envelope, sessionFilePath, workspaceRoot) => {
        getSharedEvidenceResolver().publishInspection(envelope as any, sessionFilePath, workspaceRoot);
      },
    },
    // getSessionFilePath returns null so grep falls back to ctx at execute time.
    getSessionFilePath: () => null,
    getWorkspaceRevision,
    getSharedContextGraphIfBuilt,
  });
  ToolRegistry.getInstance().registerOrReplace({
    name: "grep",
    description: GREP_DESCRIPTION,
    inputSchema: grepDef.parameters as Record<string, unknown>,
    execute: grepDef.execute,
    category: ToolCategory.READ,
  });

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
  // WP-5: inject LSP bridge symbol resolution for read { symbol: "..." }.
  pi.registerTool(createReadTool({
    publishInspection: (envelope, sessionFilePath, workspaceRoot) => {
      getSharedEvidenceResolver().publishInspection(envelope as any, sessionFilePath, workspaceRoot);
    },
    resolveSymbol: (s, cwd) => resolveSymbolForReadTool(s, cwd, freshGraphGetter),
  }));


  // 3.8 RepositoryIntelligenceService: register the singleton
  //     so downstream consumers can access it via getRepositoryIntelligence().
  try {
    registerRepositoryIntelligence(createRepositoryIntelligenceService());
  } catch { /* already registered or module init issue — non-fatal */ }
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
