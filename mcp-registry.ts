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
import { createUnifiedReadTool } from "./unified-read.js";
import createSearchTool from "./search-tool.js";
import { createRepoTool } from "./repomap-tool.js";
import { createGraphMutateTool } from "./graph-mutate.js";
import { createGitNotesTools } from "./git-notes-tool.js";
import { loadExperimentalConfig } from "./config.js";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";

// ── Register all tools with the central registry ───────────────────

// Explicitly initialize registry before calling registerFindSymbolTool()
// (it depends on ToolRegistry.getInstance() being available)
const registry = ToolRegistry.getInstance();

registerFindSymbolTool();

function reg(name: string, factory: () => ToolDefinition, category: ToolCategory, experimental = false): void {
  const def = factory();
  registry.register({ name, description: def.description, inputSchema: def.parameters as Record<string, unknown>, execute: def.execute, category, experimental });
}

reg("read", () => createUnifiedReadTool() as unknown as ToolDefinition, ToolCategory.READ);
reg("search", () => createSearchTool() as unknown as ToolDefinition, ToolCategory.SEARCH);
reg("repo_map", () => createRepoTool() as unknown as ToolDefinition, ToolCategory.MAP);

const experimental = loadExperimentalConfig();
if (experimental.graphMutate) {
  reg("graph_mutate", () => createGraphMutateTool() as unknown as ToolDefinition, ToolCategory.MUTATE, true);
}
if (experimental.gitNotes) {
  const notesTools = createGitNotesTools() as unknown as ToolDefinition[];
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
