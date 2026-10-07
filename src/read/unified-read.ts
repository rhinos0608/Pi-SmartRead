/**
 * Public SmartRead read-tool factory.
 *
 * The model-facing read contract accepts already-known file path(s) or a
 * known symbol. Search/intent discovery is deliberately not a read mode:
 * use grep for discovery and LSP for compiler-backed semantic relationships.
 * intent-read.ts remains an internal retrieval engine for non-read workflows.
 */
import { createExtendedReadTool, type WrapReadToolOptions } from "../hook.js";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";

export function createReadTool(opts?: WrapReadToolOptions): ToolDefinition {
  return createExtendedReadTool(opts);
}
