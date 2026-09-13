/**
 * Read tool factories — each exported separately for registration.
 *
 * The extended read tool supports single file, multiple files, and
 * semantic search modes. read-many.ts and intent-read.ts are internal
 * engines consumed by the dispatch.
 */
import { createExtendedReadTool, type WrapReadToolOptions } from "./hook.js";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";

export function createReadTool(opts?: WrapReadToolOptions): ToolDefinition {
  return createExtendedReadTool(opts);
}
