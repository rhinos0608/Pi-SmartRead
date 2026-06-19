/**
 * Shared type adapter module for Pi-SmartRead.
 *
 * Provides canonical adapter functions to normalize type bridging between
 * Pi-SmartRead's internal tool representations and the @mariozechner/pi-coding-agent
 * types (ExtensionContext, ToolDefinition).
 *
 * This module replaces scattered `as unknown as` and `as never` casts throughout
 * the codebase with explicit, documented adapter functions.
 */

// Re-export canonical types from the pi-coding-agent for convenience and
// to establish a single import point for external types.
export type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@mariozechner/pi-coding-agent";

import type { ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";

/**
 * Convert an internal tool definition to the canonical ToolDefinition type.
 *
 * This adapter is used throughout Pi-SmartRead where tool factory functions
 * create objects that structurally match ToolDefinition but are typed as
 * internal representations or have incomplete type inference.
 *
 * The adapter performs a type assertion that is:
 * - Explicit and searchable in the codebase
 * - Documented as the intended pattern
 * - Easier to review than scattered `as unknown as` casts
 *
 * @example
 * ```ts
 * // Before: scattered casts
 * pi.registerTool({ ... } as unknown as ToolDefinition);
 *
 * // After: explicit adapter
 * import { toToolDefinition } from "./types.js";
 * pi.registerTool(toToolDefinition({ ... }));
 * ```
 */
export function toToolDefinition<T extends object>(tool: T): ToolDefinition {
  return tool as unknown as ToolDefinition;
}

/**
 * Convert an array of internal tool definitions to ToolDefinition[].
 *
 * @example
 * ```ts
 * const tools = createGitNotesTools();
 * pi.registerTool(toolDefinitions(tools));
 * ```
 */
export function toToolDefinitions<T extends object>(tools: T[]): ToolDefinition[] {
  return tools as unknown as ToolDefinition[];
}


/**
 * Create a minimal ExtensionContext for use cases that only require cwd.
 *
 * The full ExtensionContext requires ui, sessionManager, modelRegistry, and
 * several methods (isIdle, abort, etc.). This adapter creates a minimal
 * context object for situations where only cwd is needed (e.g., MCP server
 * tool execution).
 *
 * @param cwd - The working directory for the context
 * @returns A minimal ExtensionContext with cwd and stub methods
 *
 * @example
 * ```ts
 * // MCP server creates context for tool execution
 * const ctx = createMinimalContext(cwd());
 * await tool.execute(toolCallId, args, signal, undefined, ctx);
 * ```
 */
export function createMinimalContext(cwd: string): ExtensionContext {
  // Create a minimal context object that satisfies the ExtensionContext interface
  // for use cases that only need cwd (e.g., MCP server tool execution).
  // The context object includes all required properties with safe defaults/stubs.
  const ctx: ExtensionContext = {
    // Required fields
    cwd,
    hasUI: false,
    ui: {
      select: async () => undefined,
      confirm: async () => false,
      input: async () => undefined,
      notify: () => {},
      onTerminalInput: () => () => {},
      setStatus: () => {},
      setWorkingMessage: () => {},
      setWorkingVisible: () => {},
      setWorkingIndicator: () => {},
      setHiddenThinkingLabel: () => {},
      setWidget: () => {},
      setFooter: () => {},
      setHeader: () => {},
      setTitle: () => {},
      custom: async () => undefined as any,
      pasteToEditor: () => {},
      setEditorText: () => {},
      getEditorText: () => "",
      editor: async () => undefined,
      addAutocompleteProvider: () => {},
      setEditorComponent: () => {},
      theme: { name: "default", type: "dark" } as any,
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({ success: false, error: "not available" }),
      getToolsExpanded: () => false,
      setToolsExpanded: () => {},
    },
    sessionManager: {
      getSessions: () => [],
      getSession: () => undefined,
      createSession: async () => ({ id: "", path: "" }),
      deleteSession: () => {},
      renameSession: () => {},
      getCurrentSession: () => undefined,
      getSessionTree: async () => ({ entries: [], rootId: "" }),
    } as any,
    modelRegistry: {
      getProviders: () => [],
      getModels: () => [],
      getModel: () => undefined,
      resolveApiKey: async () => undefined,
    } as any,
    model: undefined,
    // Stub methods that throw for operations not available in MCP context
    isIdle: () => true,
    signal: undefined,
    abort: () => {},
    hasPendingMessages: () => false,
    shutdown: () => {}, // no-op: shutdown is handled externally in MCP contexts
    getContextUsage: () => undefined,
    compact: () => {},
    getSystemPrompt: () => "",
  };

  return ctx;
}

/**
 * Adapter alias for createMinimalContext - creates a minimal ExtensionContext.
 * Preferred name when used in MCP server context.
 */
export const toExtensionContext = createMinimalContext;