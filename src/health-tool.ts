/**
 * SmartRead `health` tool — additive public status reporter (no smartread_ prefix).
 *
 * Reports truthful, non-secret state: graph generation/rebuild count, watcher
 * active+dirty, semantic index freshness/stats, embedding mode/model (never
 * URL/key), LSP availability/stats, and recent degradation codes.
 */
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { getRuntimeHealth, type WatcherHealthState } from "./runtime-health.js";

const HealthSchema = Type.Object({});

export interface HealthToolOptions {
  /** Reads current watcher state from the activation closure. */
  readonly getWatcherState: () => WatcherHealthState;
}

const HEALTH_DESCRIPTION =
  `Report Pi-SmartRead runtime health: graph generation/rebuild state, file watcher ` +
  `activity and dirty flag, semantic index freshness/stats, embedding mode/model ` +
  `(never URLs or keys), LSP availability/stats, and recent retrieval degradation codes.`;

export function createHealthTool(opts: HealthToolOptions): ToolDefinition {
  return {
    name: "health",
    label: "health",
    description: HEALTH_DESCRIPTION,
    parameters: HealthSchema as unknown as Record<string, unknown>,
    async execute(_toolCallId: string, _params: any, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: { cwd: string }) {
      const report = await getRuntimeHealth(ctx.cwd, opts.getWatcherState);
      const lines = [
        `graph: generation=${report.graph.generation}`,
        `watcher: active=${report.watcher.active} dirty=${report.watcher.dirty}`,
        `semanticIndex: available=${report.semanticIndex.available} state=${report.semanticIndex.state}${
          report.semanticIndex.stats
            ? ` ready=${report.semanticIndex.stats.ready} updating=${report.semanticIndex.stats.updating} files=${report.semanticIndex.stats.fileCount} chunks=${report.semanticIndex.stats.chunkCount}`
            : ""
        }`,
        `embedding: enabled=${report.embedding.enabled} model=${report.embedding.model ?? "none"}`,
        `lsp: available=${report.lsp.available}${
          report.lsp.stats ? ` managers=${report.lsp.stats.managerCount} openDocs=${report.lsp.stats.totalOpenDocuments}` : ""
        }`,
        `recentDegradations: ${report.recentDegradations.length === 0 ? "none" : report.recentDegradations.map((d) => `${d.backend}:${d.code}`).join(", ")}`,
      ].join("\n");
      return {
        content: [{ type: "text" as const, text: lines }],
        details: { report },
      };
    },
  };
}
