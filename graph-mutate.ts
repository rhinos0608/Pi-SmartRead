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

const BreakageEdgeSchema = Type.Object({
  from: Type.String({ description: "Path to the file or symbol that was modified" }),
  to: Type.String({ description: "Path to the file or symbol that broke" }),
  context: Type.Optional(Type.String({ description: "Human-readable context" })),
  confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1, description: "Confidence (0-1)" })),
});

const CoChangeEdgeSchema = Type.Object({
  from: Type.String({ description: "Path to the file that was edited" }),
  to: Type.String({ description: "Path to the file that co-changed" }),
  context: Type.Optional(Type.String({ description: "Commit hash or description" })),
  confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1, description: "Confidence (0-1)" })),
});

const GraphMutateInputSchema = Type.Object({
  breakage: Type.Optional(Type.Array(BreakageEdgeSchema, { description: "Breakage edges from post-edit diagnostics" })),
  coChange: Type.Optional(Type.Array(CoChangeEdgeSchema, { description: "Co-change edges from git history" })),
  root: Type.Optional(Type.String({ description: "Project root directory" })),
});

interface BreakageEdge { from: string; to: string; context?: string; confidence?: number; }
interface CoChangeEdge { from: string; to: string; context?: string; confidence?: number; }
interface GraphMutateInput { breakage?: BreakageEdge[]; coChange?: CoChangeEdge[]; root?: string; }

// ── Tool Definition ─────────────────────────────────────────────────

export function createGraphMutateTool(): ToolDefinition {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const def: any = {
    name: "graph_mutate",
    label: "graph_mutate",
    description: `Record semantic coupling observations (breakage, co-change) into Pi-SmartRead's context graph.

Breakage edges: when editing file A causes type-checking errors in file B,
call this tool to record the edge. The next intent_read touching A includes B.

Co-change edges: when files A and B consistently change together in git
history, record temporal coupling. Edge weight decays with time.

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

      const recorded: string[] = [];
      const errors: string[] = [];

      if (input.breakage) {
        for (const edge of input.breakage) {
          try {
            const fromPath = isAbsolute(edge.from) ? edge.from : resolve(resolvedRoot, edge.from);
            const toPath = isAbsolute(edge.to) ? edge.to : resolve(resolvedRoot, edge.to);
            if (!isPathInside(resolvedRoot, fromPath) || !isPathInside(resolvedRoot, toPath)) {
              errors.push(`Paths must be inside project root: ${edge.from} → ${edge.to}`);
              continue;
            }
            EdgeStore.recordBreakage(resolvedRoot, edge.from, edge.to, edge.context, edge.confidence);
            recorded.push(`breakage: ${edge.from} → ${edge.to}${edge.context ? ` (${edge.context})` : ""}`);
          } catch (err) {
            errors.push(`Failed breakage ${edge.from} → ${edge.to}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }

      if (input.coChange) {
        for (const edge of input.coChange) {
          try {
            const fromPath = isAbsolute(edge.from) ? edge.from : resolve(resolvedRoot, edge.from);
            const toPath = isAbsolute(edge.to) ? edge.to : resolve(resolvedRoot, edge.to);
            if (!isPathInside(resolvedRoot, fromPath) || !isPathInside(resolvedRoot, toPath)) {
              errors.push(`Paths must be inside project root: ${edge.from} → ${edge.to}`);
              continue;
            }
            EdgeStore.recordCoChange(resolvedRoot, edge.from, edge.to, edge.context, edge.confidence);
            recorded.push(`co-change: ${edge.from} → ${edge.to}${edge.context ? ` (${edge.context})` : ""}`);
          } catch (err) {
            errors.push(`Failed co-change ${edge.from} → ${edge.to}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }

      const parts: string[] = [];
      if (recorded.length > 0) parts.push(`✅ Recorded ${recorded.length} edge(s):\n${recorded.map((r) => `  • ${r}`).join("\n")}`);
      if (errors.length > 0) parts.push(`⚠ ${errors.length} error(s):\n${errors.map((e) => `  • ${e}`).join("\n")}`);
      if (recorded.length === 0 && errors.length === 0) parts.push("ℹ No edges provided.");

      return { content: [{ type: "text", text: parts.join("\n\n") }] };
    },
  };
  return def as ToolDefinition;
}
