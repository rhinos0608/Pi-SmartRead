import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerSessionHooks } from "./hook.js";
import { createGraphMutateTool } from "./graph-mutate.js";
import { createGitNotesTools } from "./git-notes-tool.js";
import { loadExperimentalConfig } from "./config.js";
import { ensureHashlineReady } from "./utils.js";
import { ToolRegistry } from "./tool-registry.js";
import { registerFindSymbolTool } from "./find-symbol-tool.js";
import "./mcp-registry.js"; // registers read, search, repo_map with ToolRegistry
import { getLSPBridge } from "./lsp-bridge.js";

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
  suggestShellCommands,
} from "./bash-context-guard.js";

// Fire-and-forget hashline init at module load time
ensureHashlineReady().catch((err) =>
  console.error("[SmartRead] hashline init failed:", err)
);

export default function (pi: ExtensionAPI) {
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
    recordToolCall(
      doomLoopState,
      event.toolName,
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
        const breakage = lspInput.breakage as Array<{ from?: string; to?: string }> | undefined;
        if (Array.isArray(breakage)) {
          for (const edge of breakage) {
            if (edge.from) closePaths.push(edge.from);
            if (edge.to) closePaths.push(edge.to);
          }
        }
        const coChange = lspInput.coChange as Array<{ from?: string; to?: string }> | undefined;
        if (Array.isArray(coChange)) {
          for (const edge of coChange) {
            if (edge.from) closePaths.push(edge.from);
            if (edge.to) closePaths.push(edge.to);
          }
        }
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
        if (item.type === "text" && typeof item.text === "string") {
          textIndex = i;
          break;
        }
      }
      if (textIndex >= 0) {
        const item = content[textIndex] as { type: "text"; text: string };
        content[textIndex] = { ...item, text: `${prefix}${item.text}` };
      } else {
        content.unshift({ type: "text" as const, text: prefix });
      }
      return { ...event, content };
    }

    // ── Bash context guard: cap oversized bash output ──
    if (toolName === "bash" && bashContextGuardConfig.enabled && Array.isArray(event.content)) {
      const textContent = event.content
        .filter((c: any): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
        .map((c: any) => c.text)
        .join("\n");

      if (textContent) {
        const guarded = applyBashContextGuard({
          text: textContent,
          command: typeof event.input?.command === "string" ? event.input.command : undefined,
          config: bashContextGuardConfig,
        });

        if (guarded.text !== textContent) {
          const nonTextContent = event.content.filter(
            (c: any) => !(c.type === "text" && typeof c.text === "string"),
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
        ? event.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n")
        : "";
      if (cmd && exit !== undefined && exit !== 0) {
        const suggestions = suggestShellCommands(cmd, outputText, exit);
        if (suggestions.length > 0) {
          const suggestionBlock = "\n\nCommand suggestions:\n" + suggestions.map(s => `  • ${s}`).join("\n");
          const content = Array.isArray(event.content) ? [...event.content] : [];
          let textIndex = -1;
          for (let i = 0; i < content.length; i++) {
            const item = content[i] as any;
            if (item.type === "text" && typeof item.text === "string") { textIndex = i; break; }
          }
          if (textIndex >= 0) {
            const item = content[textIndex] as { type: "text"; text: string };
            content[textIndex] = { ...item, text: item.text + suggestionBlock };
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
    pi.registerTool({
      name: tool.name,
      label: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      execute: tool.execute,
    } as never);
  }

  // 6. Graph mutation tool [EXPERIMENTAL] — receives breakage/co-change edges from Smart-Edit
  if (experimental.graphMutate) {
    pi.registerTool(createGraphMutateTool() as never);
  }

  // 7. Git notes tool [EXPERIMENTAL] — read/write annotations on git objects
  if (experimental.gitNotes) {
    for (const tool of createGitNotesTools()) {
      pi.registerTool(tool as never);
    }
  }

  // 8. Graphify knowledge graph is consumed internally by read's intent mode,
  //    hook.ts's contextual enrichment, and search-tool.ts's centrality boosting.
  //    No separate tools needed.
}
