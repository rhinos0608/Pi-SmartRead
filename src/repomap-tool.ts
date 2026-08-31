/**
 * Pi tool wrappers for the repo-map system.
 *
 * Exposes:
 * - `repo_map` — generate a PageRank-ranked map of the repo
 * - `search` — consolidated search (symbols, callers, resolve, code)
 */
import { Type, type Static } from "@sinclair/typebox";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { RepoMap } from "./repomap.js";
import createSearchTool from "./search-tool.js";
import { getGraphifyEnricher } from "./graphify-enricher.js";
import { resolve as pathResolve } from "node:path";

// ── Tool: repo_map ────────────────────────────────────────────────

const RepoMapSchema = Type.Object({
  directory: Type.Optional(
    Type.String({
      description:
        "Root directory to map (default: extension working directory)",
      default: ".",
    }),
  ),
  mapTokens: Type.Optional(
    Type.Number({
      description:
        "Token budget for the map output (default: 4096, clamped to 256-32768).",
    }),
  ),
  focus: Type.Optional(
    Type.Array(Type.String(), {
      description: "Files or symbol names to boost in ranking. E.g. ['Database', 'src/models/user.ts']",
    }),
  ),
  compact: Type.Optional(
    Type.Boolean({
      description:
        "Compact output format — single-line file summaries with symbol counts instead of full code context (default: false). Compact is more token-efficient for LLM consumption.",
    }),
  ),
  delta: Type.Optional(
    Type.Boolean({
      description:
        "Return only the diff (new/changed entries) since the last call instead of the full map. Useful for iterative re-ranking. (default: false).",
    }),
  ),
  allowLspFallback: Type.Optional(
    Type.Boolean({
      description: "When true, allow LSP symbol fallback for sparse files (lazy-start gate).",
    }),
  ),
});

type RepoMapInput = Static<typeof RepoMapSchema>;

export function clampMapTokens(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 4096;
  return Math.max(256, Math.min(32768, Math.trunc(value)));
}

export function createRepoTool(): ToolDefinition {
  const repoMapInstances = new Map<string, RepoMap>();

  function getRepoMap(cwd: string): RepoMap {
    let instance = repoMapInstances.get(cwd);
    if (!instance) {
      instance = new RepoMap(cwd);
      repoMapInstances.set(cwd, instance);
    }
    return instance;
  }

  return {
    name: "repo_map",
    label: "repo_map",
    description: `Create a compact, ranked repository map from AST symbols and dependency structure. Use for first-pass orientation, architecture questions, or choosing files to inspect. Prefer search for exact text/code lookup (depth: "deep" for evidence on a specific question), symbol for symbol navigation, and read/read_files once target files are known.`,
    parameters: RepoMapSchema,

    async execute(
      _toolCallId: string,
      params: RepoMapInput,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      const cwd = resolveDirParam(ctx.cwd, params.directory);
      const rm = getRepoMap(cwd);

      if (signal?.aborted) throw new Error("Operation aborted");

      const focus = params.focus ?? [];
      const focusIdents = focus.filter(f => !f.includes('/') && !f.includes('.'));
      const focusPaths = focus.filter(f => f.includes('/') || f.includes('.'));

      const mapTokens = clampMapTokens(params.mapTokens);

      const result = await rm.getRepoMap({
        mapTokens,
        focusFiles: focusPaths,
        priorityIdentifiers: focusIdents,
        mentionedIdents: focusIdents,
        mentionedFnames: focusPaths,
        excludeUnranked: false,
        forceRefresh: false,
        useImportBased: false,
        autoFallback: true,
        compact: params.compact ?? false,
        verbose: false,
        delta: params.delta ?? false,
        allowLspFallback: (params as any).allowLspFallback ?? false,
      });

      if (!result.map) {
        return {
          content: [
            {
              type: "text" as const,
              text: "[No source files found to map, or all files focused. Try without focus.]",
            },
          ],
          details: result.stats,
        };
      }

      // Enrich with graphify knowledge graph data (when available)
      let enrichedMap = result.map;

      // M4: prepend corpus stats header so the caller knows coverage
      const statsHeader = `# Repo Map — ${result.stats.totalFiles} files, ${result.stats.definitions} definitions (budget ${mapTokens} tokens, ~${result.tokenCount} used)`;
      enrichedMap = statsHeader + "\n\n" + enrichedMap;

      if (!params.delta) {
      try {
        const enricher = getGraphifyEnricher(cwd);
        if (enricher.isAvailable) {
          const s = enricher.stats;
          const sections: string[] = [
            "",
            "## Graph Knowledge",
            `The knowledge graph contains ${s?.nodeCount ?? "?"} concepts across ${s?.fileCount ?? "?"} files ` +
            `with ${s?.edgeCount ?? "?"} relationships in ${s?.communityCount ?? "?"} architectural clusters.`,
            "",
          ];

          const gods = enricher.getGodNodes(6);
          if (gods.length > 0) {
            sections.push("Core abstractions:");
            for (const g of gods) {
              sections.push(`  • ${g.label} — ${g.degree} connections`);
            }
            sections.push("");
          }

          if ((s?.communityCount ?? 0) > 1) {
            sections.push("Clusters:");
            for (let cid = 0; cid < Math.min(s?.communityCount ?? 0, 6); cid++) {
              const files = enricher.getCommunityFiles(cid);
              if (files.length === 0) continue;
              const stems = files
                .map((f) => f.split("/").pop() ?? f)
                .slice(0, 3);
              sections.push(`  • Cluster ${cid}: ${stems.join(", ")}${files.length > 3 ? ` (+${files.length - 3})` : ""}`);
            }
          }

          enrichedMap = result.map + "\n" + sections.join("\n");
        }
      } catch {
        // Graphify enrichment is best-effort
      }
      }

      return {
        content: [{ type: "text" as const, text: enrichedMap }],
        details: result.stats,
      };
    },
  } as unknown as ToolDefinition;
}

function resolveDirParam(cwd: string, directory: string | undefined): string {
  // Direct resolve — explicit directories are allowed outside cwd and
  // outside PI_SMARTREAD_ALLOWED_ROOT (external permission system).
  return pathResolve(cwd, directory ?? ".");
}

// ── Registration ──────────────────────────────────────────────────

/**
 * Register repo-map and search tools with the Pi extension API.
 */
export default function registerRepoTools(pi: ExtensionAPI): void {
  pi.registerTool(createRepoTool());
  pi.registerTool(createSearchTool());
}
