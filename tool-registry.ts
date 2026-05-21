/**
 * Tool Registry — central registry for all Pi-SmartRead tools.
 *
 * Each tool registration carries a name, description, schema, execute function,
 * and a category. The registry provides lookup by name/category and produces
 * consistent ToolDefinition arrays for both the pi extension API and the MCP server.
 */
import type { ExtensionAPI, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { toToolDefinition, toToolDefinitions } from "./types.js";

// ── Categories ─────────────────────────────────────────────────────

export enum ToolCategory {
  /** Symbol-level retrieval tools */
  SYMBOL = "symbol",
  /** Code search (grep, code, deep) */
  SEARCH = "search",
  /** File reading with contextual enrichment */
  READ = "read",
  /** Repository map / structural overview */
  MAP = "map",
  /** Mutations (experimental) */
  MUTATE = "mutate",
  /** Git-backed annotations (experimental) */
  NOTES = "notes",
  /** Health checks and status reporting */
  STATUS = "status",
}

// ── Registration shape ─────────────────────────────────────────────

export interface ToolRegistration {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: ToolDefinition["execute"];
  category: ToolCategory;
  experimental?: boolean;
}

// ── Registry ───────────────────────────────────────────────────────

export class ToolRegistry {
  private static instance: ToolRegistry;
  private tools = new Map<string, ToolRegistration>();

  static getInstance(): ToolRegistry {
    if (!ToolRegistry.instance) {
      ToolRegistry.instance = new ToolRegistry();
    }
    return ToolRegistry.instance;
  }

  register(registration: ToolRegistration): void {
    if (this.tools.has(registration.name)) {
      throw new Error(`Tool "${registration.name}" is already registered`);
    }
    this.tools.set(registration.name, registration);
  }

  get(name: string): ToolRegistration | undefined {
    return this.tools.get(name);
  }

  getAll(category?: ToolCategory): ToolRegistration[] {
    const all = [...this.tools.values()];
    if (category === undefined) return all;
    return all.filter((t) => t.category === category);
  }

  /** Build ToolDefinition[] suitable for mcp-registry / server. */
  getToolDefinitions(): ToolDefinition[] {
    return toToolDefinitions([...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
      execute: t.execute,
    })));
  }

  /** Register all non-experimental tools with pi's ExtensionAPI. */
  registerAllWithPi(pi: ExtensionAPI): void {
    for (const tool of this.tools.values()) {
      if (tool.experimental) continue;
      pi.registerTool(toToolDefinition({
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
        execute: tool.execute,
      }));
    }
  }
}
