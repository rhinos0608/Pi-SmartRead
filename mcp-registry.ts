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
import { registerFindSymbolTool } from "./find-symbol-tool.js";
import { createReadTool, createReadFilesTool, createIntentReadTool } from "./unified-read.js";
import createSearchTool from "./search-tool.js";
import createDeepSearchTool from "./deep-search-tool.js";
import { createRepoTool } from "./repomap-tool.js";
import { createGraphMutateTool } from "./graph-mutate.js";
import { createGitNotesTools } from "./git-notes-tool.js";
import { loadExperimentalConfig } from "./config.js";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { toToolDefinition, toToolDefinitions } from "./types.js";

// ── Register all tools with the central registry ───────────────────

// Explicitly initialize registry before calling registerFindSymbolTool()
// (it depends on ToolRegistry.getInstance() being available)
const registry = ToolRegistry.getInstance();

registerFindSymbolTool();

function reg(name: string, factory: () => ToolDefinition, category: ToolCategory, experimental = false): void {
  if (registry.has(name)) return;
  const def = factory();
  registry.register({ name, description: def.description, inputSchema: def.parameters as Record<string, unknown>, execute: def.execute, category, experimental });
}

/** Register an alias for an existing tool (same execute/params, different name). */
function alias(name: string, target: string): void {
  if (registry.has(name)) return;
  const existing = registry.get(target);
  if (!existing) throw new Error(`Cannot alias "${name}" — target tool "${target}" not registered`);
  registry.register({ name, description: existing.description, inputSchema: existing.inputSchema, execute: existing.execute, category: existing.category, experimental: existing.experimental });
}

reg("read", () => toToolDefinition(createReadTool()), ToolCategory.READ);
reg("read_files", () => toToolDefinition(createReadFilesTool()), ToolCategory.READ);
reg("intent_read", () => toToolDefinition(createIntentReadTool()), ToolCategory.READ);
alias("semantic_read", "intent_read");

reg("search", () => toToolDefinition(createSearchTool()), ToolCategory.SEARCH);
reg("deep_search", () => toToolDefinition(createDeepSearchTool()), ToolCategory.SEARCH);
reg("repo_map", () => toToolDefinition(createRepoTool()), ToolCategory.MAP);

// Aliases for backwards compatibility
alias("workspace_symbol", "find_symbol");
alias("hover_type", "symbol_info");

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

// ── Build ──────────────────────────────────────────────────────────

/**
 * Build and return the full MCP tool list for the stdio server.
 */
export function buildToolRegistry(): ToolDefinition[] {
  return ToolRegistry.getInstance().getToolDefinitions();
}
