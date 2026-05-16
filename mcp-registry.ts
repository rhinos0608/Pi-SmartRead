/**
 * MCP Tool Registry for Pi-SmartRead.
 *
 * Extracts tool construction from mcp-server.ts into a focused registry module
 * with consistent manifest entries (name, description, inputSchema, execute).
 *
 * Borrows Rhythm Chamber's per-tool module convention while preserving
 * existing Pi extension-API tool factories.
 */
import { cwd } from "node:process";
import { createIntentReadTool } from "./intent-read.js";
import { createReadManyTool } from "./read-many.js";
import { createGraphMutateTool } from "./graph-mutate.js";
import { createDeepSearchTool, createSmartReadStatusTool } from "./deep-search.js";
import registerRepoTools from "./repomap-tool.js";
import type { ExtensionAPI, ToolDefinition } from "@mariozechner/pi-coding-agent";

// ── Types ──────────────────────────────────────────────────────────

export interface RegisteredTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: ToolDefinition["execute"];
}

// ── Registry Builder ───────────────────────────────────────────────

/**
 * Build and return the full MCP tool registry.
 *
 * Each entry has a consistent manifest shape:
 *   - name:        Tool name (used in tools/list and tools/call)
 *   - description: Human-readable description
 *   - inputSchema: JSON Schema object describing accepted parameters
 *   - execute:     Async function (toolCallId, params, signal, onUpdate, ctx) → result
 */
export function buildToolRegistry(): RegisteredTool[] {
  const tools: RegisteredTool[] = [];

  // Minimal extension API stub for Pi tool factories
  const extensionCwd = cwd();

  // ── Graph Mutate Tool ──────────────────────────────────────────
  const graphMutateDef = createGraphMutateTool() as unknown as ToolDefinition;
  tools.push({
    name: graphMutateDef.name,
    description: graphMutateDef.description,
    inputSchema: graphMutateDef.parameters as Record<string, unknown>,
    execute: graphMutateDef.execute,
  });

  // ── Intent Read Tool ───────────────────────────────────────────
  const intentReadDef = createIntentReadTool() as unknown as ToolDefinition;
  tools.push({
    name: intentReadDef.name,
    description: intentReadDef.description,
    inputSchema: intentReadDef.parameters as Record<string, unknown>,
    execute: intentReadDef.execute,
  });

  // ── Read Many Tool ─────────────────────────────────────────────
  const readManyDef = createReadManyTool() as unknown as ToolDefinition;
  tools.push({
    name: readManyDef.name,
    description: readManyDef.description,
    inputSchema: readManyDef.parameters as Record<string, unknown>,
    execute: readManyDef.execute,
  });

  // ── Deep Search Tools ─────────────────────────────────────────
  const deepSearchDef = createDeepSearchTool() as unknown as ToolDefinition;
  tools.push({
    name: deepSearchDef.name,
    description: deepSearchDef.description,
    inputSchema: deepSearchDef.parameters as Record<string, unknown>,
    execute: deepSearchDef.execute,
  });

  const statusDef = createSmartReadStatusTool() as unknown as ToolDefinition;
  tools.push({
    name: statusDef.name,
    description: statusDef.description,
    inputSchema: statusDef.parameters as Record<string, unknown>,
    execute: statusDef.execute,
  });

  // ── Repo Tools (repo_map, search) ──────────────────────────────
  const registeredRepoTools: Array<{
    name: string;
    description: string;
    inputSchema: unknown;
    execute: Function;
  }> = [];
  const mockPi: ExtensionAPI = {
    registerTool(def: ToolDefinition) {
      registeredRepoTools.push({
        name: def.name,
        description: def.description,
        inputSchema: def.parameters as unknown,
        execute: def.execute,
      });
    },
    registerHook: (() => {}) as any,
    getContext: (() => ({ cwd: extensionCwd })) as any,
  } as unknown as ExtensionAPI;

  registerRepoTools(mockPi);

  for (const tool of registeredRepoTools) {
    tools.push({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as Record<string, unknown>,
      execute: tool.execute as ToolDefinition["execute"],
    });
  }

  return tools;
}
