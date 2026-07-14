/**
 * Graph Mutation Tool — receives breakage and co-change edges from
 * external sources (e.g., Smart-Edit's post-edit evidence pipeline)
 * and persists them via the EdgeStore for future graph expansion.
 */

import { Type } from "@sinclair/typebox";
import type { ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { EdgeStore } from "./context-graph.js";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

// ── Schema ──────────────────────────────────────────────────────────

const GraphMutateInputSchema = Type.Object({
  from: Type.String({ description: "Path to the file or symbol that was modified / edited" }),
  to: Type.String({ description: "Path to the file or symbol that broke or co-changed" }),
  relation: Type.Optional(
    Type.Unsafe<"breakage" | "co-change">({
      type: "string",
      enum: ["breakage", "co-change"],
      description: "'breakage' (default): editing 'from' causes errors in 'to'. 'co-change': 'from' and 'to' change together in git history.",
      default: "breakage",
    }),
  ),
  context: Type.Optional(Type.String({ description: "Human-readable context or commit hash description" })),
  confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1, description: "Confidence (0-1)" })),
  directory: Type.Optional(Type.String({ description: "Project root directory (default: cwd)" })),
});

interface GraphMutateInput { from: string; to: string; relation?: "breakage" | "co-change"; context?: string; confidence?: number; directory?: string; }

// ── Tool Definition ─────────────────────────────────────────────────

export function createGraphMutateTool(): ToolDefinition {
   
  const def: any = {
    name: "graph_mutate",
    label: "graph_mutate",
    description: `[EXPERIMENTAL] Record a verified breakage or co-change relationship between two files/symbols for future graph-aware retrieval. Use only after evidence proves coupling, e.g. { from: "src/auth.ts", to: "test/auth.test.ts", relation: "breakage", context: "auth edit broke token expiry test" }. Prefer search/repo_map to discover relationships before recording; do not use for speculative notes or ordinary reads.`,
    parameters: GraphMutateInputSchema,

    async execute(
      _toolCallId: string,
      params: unknown,
      _signal: unknown,
      _onUpdate: unknown,
      ctx: ExtensionContext | undefined,
    ): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
      const input = params as GraphMutateInput;
      const baseCwd = ctx?.cwd ?? process.cwd();
      const resolvedRoot = input.directory ? resolve(baseCwd, input.directory) : resolve(baseCwd);

      if (!existsSync(resolvedRoot)) {
        return { content: [{ type: "text", text: `❌ Root directory not found: ${resolvedRoot}` }], isError: true };
      }

      const fromPath = resolve(resolvedRoot, input.from);
      const toPath = resolve(resolvedRoot, input.to);

      try {
        const relation = input.relation ?? "breakage";
        if (relation === "breakage") {
          EdgeStore.recordBreakage(resolvedRoot, fromPath, toPath, input.context, input.confidence);
        } else {
          EdgeStore.recordCoChange(resolvedRoot, fromPath, toPath, input.context, input.confidence);
        }
        const label = relation === "breakage" ? "breakage" : "co-change";
        return {
          content: [{ type: "text", text: `✅ Recorded ${label}: ${input.from} → ${input.to}${input.context ? ` (${input.context})` : ""}` }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `❌ Failed: ${message}` }], isError: true };
      }
    },
  };
  return def as ToolDefinition;
}
