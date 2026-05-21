import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerSessionHooks } from "./hook.js";
import { createGraphMutateTool } from "./graph-mutate.js";
import { createGitNotesTools } from "./git-notes-tool.js";
import { loadExperimentalConfig } from "./config.js";
import { coerceText, ensureHashlineReady } from "./utils.js";
import { initHandlers } from "./read-many.js";
import { invalidateFsScanCache } from "./fs-scan-cache.js";
import { summarizeCode, renderSummary, canSummarize } from "./code-summary.js";
import { ToolRegistry } from "./tool-registry.js";
import { toToolDefinition } from "./types.js";
import { registerFindSymbolTool } from "./find-symbol-tool.js";
import "./mcp-registry.js"; // registers read, search, repo_map with ToolRegistry
import { getLSPBridge } from "./lsp-bridge.js";
// Internal URL router re-exports (enables external consumers to use skill://, memory://, graph:// URLs)
export {
	isInternalUrl,
	resolveUrl,
	parseInternalUrl,
	registerHandler,
	getHandler,
} from "./internal-url-router.js";
export { resolveSkillUrl, resolveMemoryUrl, resolveGraphUrl } from "./internal-url-router.js";
import {
  recordContiguous,
  recordSparse,
  getSnapshot,
  invalidate,
  clearSession,
  resolveSessionKey,
  type FileSnapshot,
  type SearchMatchEntry,
} from "./file-read-cache.js";

// Ensure all tools are registered with the central registry
registerFindSymbolTool();

// Context hygiene — tracks tool results and marks stale reads after mutations
import {
  resetContextHygieneTracker,
  buildContextHygieneMetadata,
  buildFileResource,
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
} from "./doom-loop.js";

// Bash context guard — caps oversized bash output with head/tail preview
import {
  applyBashContextGuard,
  resolveBashContextGuardConfig,
  resolveGuardProfile,
  GUARD_HINT_GENERIC,
  GUARD_HINT_RE,
  suggestShellCommands,
} from "./bash-context-guard.js";

// Fire-and-forget hashline init at module load time
ensureHashlineReady().catch((err) =>
  console.error("[SmartRead] hashline init failed:", err)
);

export default function (pi: ExtensionAPI) {
  // ── Initialise internal URL handlers (skill://, memory://, graph://) ──
  initHandlers();

  // ── Shared state ────────────────────────────────────────────────
  const hygieneTracker = resetContextHygieneTracker();
  const doomLoopState = createDoomLoopState();
  const bashContextGuardConfig = resolveBashContextGuardConfig();

  // ── Helper: extract resources from tool params for context hygiene ──
  function resourcesForTool(_toolName: string, input: Record<string, unknown>): ContextHygieneResource[] {
    const path = typeof input.path === "string" ? input.path : undefined;
    if (path) return [buildFileResource(path)];
    if (typeof input.filePath === "string") return [buildFileResource(input.filePath)];
    if (typeof input.relative_path === "string") return [buildFileResource(input.relative_path)];
    return [];
  }

  function classificationForTool(toolName: string): ContextHygieneMetadata["classification"] {
    if (toolName === "graph_mutate") return "mutation";
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

    // ── Context hygiene: record every tool result ──
    if (toolCallId) {
      const input = (event.input ?? {}) as Record<string, unknown>;
      const metadata = buildContextHygieneMetadata({
        tool: toolName,
        classification: classificationForTool(toolName),
        resources: resourcesForTool(toolName, input),
      });
      hygieneTracker.record(metadata, { resultId: toolCallId });

      // ── Auto-invalidation: record graph_mutate mutations for stale detection ──
      if (toolName === "graph_mutate") {
        const mutationResources: ContextHygieneResource[] = [];
        if (typeof input.from === "string") mutationResources.push(buildFileResource(input.from));
        if (typeof input.to === "string") mutationResources.push(buildFileResource(input.to));
        if (mutationResources.length > 0) {
          hygieneTracker.recordMutation(mutationResources, { resultId: toolCallId });
        }
      }
    }

    // ── LSP incremental document tracking ──
    // After a read, open the file on the LSP server so subsequent LSP queries
    // don't re-open it. After a mutation via graph_mutate, close mutated files
    // so the next read re-opens them with fresh content.
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
        // Close mutated files so LSP re-opens them with fresh content
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
      return { ...event, content };
    }

    // ── Bash context guard: cap oversized output for SmartRead tools ──
    const SMARTREAD_GUARD_TOOLS = new Set(["search", "read"]);
    if (SMARTREAD_GUARD_TOOLS.has(toolName) && Array.isArray(event.content)) {
      const textContent = event.content
        .filter((c: any): c is { type: "text"; text?: unknown } => c.type === "text")
        .map((c: any) => coerceText(c.text))
        .join("\n");

      if (textContent) {
        // Use tool-specific profile; pass base config for env var overrides
        const profile = resolveGuardProfile(toolName, bashContextGuardConfig);
        const lineCount = textContent === "" ? 0 : textContent.split("\n").length;
        const byteCount = Buffer.byteLength(textContent, "utf8");
        const trimWanted = profile.maxLines > 0 && profile.maxBytes > 0 &&
          (lineCount > profile.maxLines || byteCount > profile.maxBytes);

        if (trimWanted) {
          const result = applyBashContextGuard({
            text: textContent,
            command: undefined,
            config: {
              enabled: true,
              maxLines: profile.maxLines,
              maxBytes: profile.maxBytes,
              headLines: profile.headLines,
              tailLines: profile.tailLines,
            },
          });

          if (result.text !== textContent) {
            const nonTextContent = event.content.filter(
              (c: any) => c.type !== "text",
            );
            // Replace default hint with tool-specific hint
            const toolHint = GUARD_HINT_GENERIC;
            const guardedText = result.text.replace(
              GUARD_HINT_RE,
              toolHint + "\n",
            );
            return {
              ...event,
              content: [{ type: "text", text: guardedText }, ...nonTextContent],
              details: {
                ...(event.details && typeof event.details === "object" ? event.details : {}),
                bashContextGuard: { ...result.metadata, toolName },
              },
            };
          }
        }
      }
    }

    // ── Bash context guard: cap oversized bash output ──
    if (toolName === "bash" && bashContextGuardConfig.enabled && Array.isArray(event.content)) {
      const textContent = event.content
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
          const nonTextContent = event.content.filter(
            (c: any) => c.type !== "text",
          );
          return {
            ...event,
            content: [{ type: "text", text: guarded.text }, ...nonTextContent],
            details: {
              ...(event.details && typeof event.details === "object" ? event.details : {}),
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
      const outputText = Array.isArray(event.content)
        ? event.content.filter((c: any) => c.type === "text").map((c: any) => coerceText(c.text)).join("\n")
        : "";
      if (cmd && exit !== undefined && exit !== 0) {
        const suggestions = suggestShellCommands(cmd, outputText, exit);
        if (suggestions.length > 0) {
          const suggestionBlock = "\n\nCommand suggestions:\n" + suggestions.map(s => `  • ${s}`).join("\n");
          const content = Array.isArray(event.content) ? [...event.content] : [];
          let textIndex = -1;
          for (let i = 0; i < content.length; i++) {
            const item = content[i] as any;
            if (item.type === "text") { textIndex = i; break; }
          }
          if (textIndex >= 0) {
            const item = content[textIndex] as { type: "text"; text?: unknown };
            content[textIndex] = { ...item, text: coerceText(item.text) + suggestionBlock };
            return { ...event, content };
          }
        }
      }
    }

    return undefined;
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

  const experimental = loadExperimentalConfig();

  // 1. Session hooks: eager repo-map generation + startup injection
  registerSessionHooks(pi);

  // 2. Core tools: registered via the ToolRegistry loop below

  // 3. Additional tools: the loop iterates all tools from ToolRegistry.getAll()
  //    and registers each via pi.registerTool (covers unified read, search, repo_map,
  //    find_symbol, and any other registered tools).
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

  // 6. Graph mutation tool [EXPERIMENTAL] — receives breakage/co-change edges from Smart-Edit
  if (experimental.graphMutate) {
    pi.registerTool(toToolDefinition(createGraphMutateTool()));
  }

  // 7. Git notes tool [EXPERIMENTAL] — read/write annotations on git objects
  if (experimental.gitNotes) {
    for (const tool of createGitNotesTools()) {
      pi.registerTool(toToolDefinition(tool));
    }
  }

  // 8. Graphify knowledge graph is consumed internally by read's intent mode,
  //    hook.ts's contextual enrichment, and search-tool.ts's centrality boosting.
  //    No separate tools needed.
}

// ── File-read cache API (re-exported for external use) ───────────────────
export {
  recordContiguous,
  recordSparse,
  getSnapshot,
  invalidate,
  clearSession,
  resolveSessionKey,
};
export type { FileSnapshot, SearchMatchEntry };

// ── Code summary API ───────────────────────────────────────────────
export { summarizeCode, renderSummary, canSummarize };
export type { SummaryOptions, SummarySegment, SummaryResult } from "./code-summary.js";

