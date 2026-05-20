/**
 * Read tool factories — each exported separately for registration.
 *
 * Previously a single unified-read tool with mode dispatch; now split
 * into three independent tools for simpler schemas.
 */
import { wrapBuiltinReadTool } from "./hook.js";
import { createReadManyTool } from "./read-many.js";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";

export function createReadTool(): ToolDefinition {
  return wrapBuiltinReadTool();
}

export function createReadFilesTool(): ToolDefinition {
  return createReadManyTool();
}

export { createIntentReadTool } from "./intent-read.js";
