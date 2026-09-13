import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { ensureHashlineReady } from "./utils.js";
import "./mcp-registry.js"; // registers skill, graph_mutate, git_notes with ToolRegistry
import {
  bindEvidenceResolverSync,
  createActivationState,
  registerShutdownHandler,
  startFileWatcher,
} from "./extension-lifecycle.js";
import {
  handleContext,
  handleToolCall,
  handleToolResult,
} from "./extension-result-pipeline.js";
import {
  initInternalUrlHandlers,
  installResolverAndProviderBestEffort,
  registerCoreTools,
  registerGrepTool,
  registerInspectTool,
  registerLanguageIntelligenceCommandStep,
  registerReadTool,
  registerRepositoryIntelligenceBestEffort,
  registerSessionHooksWithDoomReset,
} from "./extension-registration.js";

// Internal URL router re-exports (enables external consumers to use skill://, memory://, graph:// URLs)
export {
  isInternalUrl,
  resolveUrl,
  parseInternalUrl,
  registerHandler,
  getHandler,
} from "./protocols/internal-url-router.js";
export { resolveSkillUrl, resolveMemoryUrl, resolveGraphUrl } from "./protocols/internal-url-router.js";

// Workspace evidence resolver
export { createEvidenceResolver } from "./evidence/workspace-evidence-resolver.js";
export {
  buildInspectToolForExtension,
  registerInspectToolWithBus,
  getSharedEvidenceResolver,
} from "./mcp-registry.js";

// ── File-read cache API (re-exported for external use) ───────────────────
export {
  recordContiguous,
  recordSparse,
  getSnapshot,
  invalidate,
  clearSession,
  resolveSessionKey,
} from "./read/file-read-cache.js";
export type { FileSnapshot, SearchMatchEntry } from "./read/file-read-cache.js";

// ── Code summary API ───────────────────────────────────────────────
export { summarizeCode, renderSummary, canSummarize } from "./structural/code-summary.js";
export type { SummaryOptions, SummarySegment, SummaryResult } from "./structural/code-summary.js";

// Preserve the public helper path: tests import lspUriToPath from src/index.js.
export { lspUriToPath } from "./extension-registration.js";

// Fire-and-forget hashline init at module load time
ensureHashlineReady().catch((err) => console.error("[SmartRead] hashline init failed:", err));

export default async function (pi: ExtensionAPI) {
  // ── Initialise internal URL handlers (skill://, memory://, graph://) ──
  initInternalUrlHandlers();

  // ── Shared activation state ──────────────────────────────────────
  const state = createActivationState();

  // Bind the live evidence resolver synchronously when a bus is present,
  // BEFORE any tool can execute.
  bindEvidenceResolverSync(pi);

  // ── File watcher: real-time FS change detection ──
  startFileWatcher(state);

  // Language servers are long-lived; stop them on session_shutdown.
  registerShutdownHandler(pi, state);

  // ── Event hooks (ordered result pipeline) ────────────────────────

  // 1. tool_call: feed doom-loop detector (returns undefined).
  pi.on("tool_call", (event: any) => handleToolCall(state, event));

  // 2. tool_result: ordered named transforms (undefined when unchanged).
  pi.on("tool_result", (event: any): Promise<any> => handleToolResult(state, event));

  // 3. context: apply stale markers (undefined when unchanged).
  pi.on("context", (event: any): any => handleContext(state, event));

  // ── Tool registration (ordered bootstrap) ────────────────────────

  // 1. Session hooks: eager repo-map generation + startup injection
  registerSessionHooksWithDoomReset(pi, state);

  // 2. Inspect: unconditionally replace the eager MCP fallback.
  registerInspectTool(state);

  // 2.5 Grep: unconditionally replace the eager MCP fallback.
  registerGrepTool(state);

  // 3. Core tools: the loop iterates all tools from ToolRegistry.getAll().
  registerCoreTools(pi);

  // 3.5 Read: override the builtin read with the enriched wrapper.
  registerReadTool(pi, state);

  // 3.8 RepositoryIntelligenceService singleton (best-effort).
  registerRepositoryIntelligenceBestEffort();

  // 4. Versioned evidence RPC resolver install (best-effort, background).
  registerLanguageIntelligenceCommandStep(pi);
  installResolverAndProviderBestEffort(pi, state);
}
