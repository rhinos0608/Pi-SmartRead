/**
 * Graph Mutation Tool — receives breakage and co-change edges from
 * external sources (e.g., Smart-Edit's post-edit evidence pipeline)
 * and persists them via the EdgeStore for future graph expansion.
 */

import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { EdgeStore, isPathInside } from "./context-graph.js";
import { resolve, isAbsolute } from "node:path";
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
  root: Type.Optional(Type.String({ description: "Project root directory" })),
});

interface GraphMutateInput { from: string; to: string; relation?: "breakage" | "co-change"; context?: string; confidence?: number; root?: string; }

// ── Tool Definition ─────────────────────────────────────────────────

export function createGraphMutateTool(): ToolDefinition {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const def: any = {
    name: "graph_mutate",
    label: "graph_mutate",
    description: `[EXPERIMENTAL] Record a semantic coupling observation (breakage or co-change) into Pi-SmartRead's context graph.

Breakage (default): when editing file A causes type-checking errors in file B,
call this tool with relation="breakage". The next intent_read touching A includes B.

Co-change: when files A and B consistently change together in git history,
call this tool with relation="co-change". Edge weight decays with time.

Edges are event-sourced to disk and survive session restarts.`,
    parameters: GraphMutateInputSchema,

    async execute(
      _toolCallId: string,
      params: unknown,
      _signal: unknown,
      _onUpdate: unknown,
      _ctx: unknown,
    ): Promise<{ content: Array<{ type: "text"; text: string }> }> {
      const input = params as GraphMutateInput;
      const root = input.root ?? process.cwd();
      const resolvedRoot = isAbsolute(root) ? root : resolve(process.cwd(), root);

      if (!existsSync(resolvedRoot)) {
        return { content: [{ type: "text", text: `❌ Root directory not found: ${resolvedRoot}` }] };
      }

      const fromPath = isAbsolute(input.from) ? input.from : resolve(resolvedRoot, input.from);
      const toPath = isAbsolute(input.to) ? input.to : resolve(resolvedRoot, input.to);

      if (!isPathInside(resolvedRoot, fromPath) || !isPathInside(resolvedRoot, toPath)) {
        return { content: [{ type: "text", text: `❌ Paths must be inside project root: ${input.from} → ${input.to}` }] };
      }

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
        return { content: [{ type: "text", text: `❌ Failed: ${message}` }] };
      }
    },
  };
  return def as ToolDefinition;
}
