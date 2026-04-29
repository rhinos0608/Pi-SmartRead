import type { ExtensionAPI, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { createIntentReadTool } from "./intent-read.js";
import { createReadManyTool } from "./read-many.js";
import registerRepoTools from "./repomap-tool.js";
import { wrapReadManyTool, wrapIntentReadTool } from "./hook.js";

export default function (pi: ExtensionAPI) {
  // Wrap with repo-map hook interceptor
  const readManyDef = createReadManyTool() as unknown as ToolDefinition;
  const intentReadDef = createIntentReadTool() as unknown as ToolDefinition;

  pi.registerTool(wrapReadManyTool(readManyDef));
  pi.registerTool(wrapIntentReadTool(intentReadDef));

  // Register repo_map and search_symbols (no hook needed)
  registerRepoTools(pi);
}
