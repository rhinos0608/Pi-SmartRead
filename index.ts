import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createIntentReadTool } from "./intent-read.js";
import { createReadManyTool } from "./read-many.js";
import registerRepoTools from "./repomap-tool.js";
import { wrapBuiltinReadTool, registerSessionHooks } from "./hook.js";

export default function (pi: ExtensionAPI) {
  // 1. Session hooks: eager repo-map generation + startup injection
  registerSessionHooks(pi);

  // 2. Override built-in read with contextual enrichment (imports, git recency, graphify)
  pi.registerTool(wrapBuiltinReadTool());

  // 3. Custom tools (no hook wrapping — enrichment flows through the inner read)
  pi.registerTool(createReadManyTool() as never);
  pi.registerTool(createIntentReadTool() as never);

  // 4. Standalone tools
  registerRepoTools(pi);

  // 5. Graphify knowledge graph is consumed internally by intent_read's
  //    neighbor expansion (Phase 2d), hook.ts's contextual enrichment,
  //    and search-tool.ts's centrality boosting. No separate tools needed.
}
