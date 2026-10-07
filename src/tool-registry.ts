/**
 * Tool Registry — central registry for all Pi-SmartRead tools.
 *
 * Each tool registration carries a name, description, schema, execute function,
 * and a category. The registry provides lookup by name/category and produces
 * consistent ToolDefinition arrays for both the pi extension API and the MCP server.
 */
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { toToolDefinitions } from "./types.js";

// ── Categories ─────────────────────────────────────────────────────

export enum ToolCategory {
  /** Symbol-level retrieval tools */
  SYMBOL = "symbol",
  /** Unified text + code search */
  SEARCH = "search",
  /** File reading with contextual enrichment */
  READ = "read",
  /** Repository map / structural overview */
  MAP = "map",
  /** Mutations (experimental) */
  MUTATE = "mutate",
  /** Git-backed annotations (experimental) */
  NOTES = "notes",
  /** Agent skill discovery and loading */
  SKILL = "skill",
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

  /**
   * Replace (or add) a registration by name. Used by the Pi extension
   * activation path to override eager MCP fallback registrations with
   * runtime-aware definitions. Strict duplicate `register()` behavior is
   * preserved for all other callers.
   */
  registerOrReplace(registration: ToolRegistration): void {
    this.tools.delete(registration.name);
    this.tools.set(registration.name, registration);
  }

  has(name: string): boolean {
    return this.tools.has(name);
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
}
