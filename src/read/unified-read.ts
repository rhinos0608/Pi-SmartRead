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
import { getSmartReadToolGuidance } from "../runtime/tool-guidance.js";

export function createReadTool(opts?: WrapReadToolOptions): ToolDefinition {
  const base = createExtendedReadTool(opts);
  const guidance = getSmartReadToolGuidance("read");
  if (guidance === undefined) return base;
  return {
    ...base,
    promptSnippet: guidance.snippet,
    promptGuidelines: [...guidance.guidelines],
  } as unknown as ToolDefinition;
}
