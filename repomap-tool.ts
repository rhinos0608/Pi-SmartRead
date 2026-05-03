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

// ── Tool: repo_map ────────────────────────────────────────────────

const RepoMapSchema = Type.Object({
  directory: Type.Optional(
    Type.String({
      description:
        "Root directory to map (default: extension working directory)",
    }),
  ),
  mapTokens: Type.Optional(
    Type.Number({
      description:
        "Token budget for the map output (default: 4096)",
      minimum: 256,
      maximum: 32768,
    }),
  ),
  focusFiles: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Files to personalize PageRank toward (these get higher relevance)",
    }),
  ),
  priorityIdentifiers: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Identifier names to boost in ranking (e.g., function/class names)",
    }),
  ),
  mentionedIdents: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Identifiers mentioned in user query — used for file-path matching and personalization",
    }),
  ),
  mentionedFnames: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "File paths mentioned in user query — used for personalization",
    }),
  ),
  excludeUnranked: Type.Optional(
    Type.Boolean({
      description:
        "Exclude files with zero PageRank from output (default: false)",
    }),
  ),
  forceRefresh: Type.Optional(
    Type.Boolean({
      description:
        "Force re-parsing all files (default: false, uses cache)",
    }),
  ),
  useImportBased: Type.Optional(
    Type.Boolean({
      description:
        "Use import-based dependency mapping instead of tree-sitter + PageRank (default: false). Faster but less precise — ranks files by how many other files import them.",
    }),
  ),
  autoFallback: Type.Optional(
    Type.Boolean({
      description:
        "Auto-fallback to import-based mapping when tree-sitter parsing fails (default: true). Set false to surface parser errors.",
    }),
  ),
  compact: Type.Optional(
    Type.Boolean({
      description:
        "Compact output format — single-line file summaries with symbol counts instead of full code context (default: false). Compact is more token-efficient for LLM consumption.",
    }),
  ),
});

type RepoMapInput = Static<typeof RepoMapSchema>;

function createRepoTool(): ToolDefinition {
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
    description: `Map a repository using tree-sitter AST analysis (default) or import-based dependency mapping (fallback). Scans source files, extracts definitions and references, ranks files by PageRank importance (default) or import in-degree (fallback), and returns a token-budgeted map of the most important symbols with code context. Use the fallback when tree-sitter WASM isn't available or for faster mapping of very large repos.`,
    parameters: RepoMapSchema,

    async execute(
      _toolCallId: string,
      params: RepoMapInput,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      const cwd = params.directory ? params.directory : ctx.cwd;
      const rm = getRepoMap(cwd);

      if (signal?.aborted) throw new Error("Operation aborted");

      const result = await rm.getRepoMap({
        mapTokens: params.mapTokens,
        focusFiles: params.focusFiles ?? [],
        priorityIdentifiers: params.priorityIdentifiers ?? [],
        mentionedIdents: params.mentionedIdents ?? [],
        mentionedFnames: params.mentionedFnames ?? [],
        excludeUnranked: params.excludeUnranked ?? false,
        forceRefresh: params.forceRefresh ?? false,
        useImportBased: params.useImportBased ?? false,
        autoFallback: params.autoFallback ?? true,
        compact: params.compact ?? false,
        verbose: false,
      });

      if (!result.map) {
        return {
          content: [
            {
              type: "text" as const,
              text: "[No source files found to map, or all files focused. Try without focusFiles.]",
            },
          ],
          details: result.stats,
        };
      }

      // Enrich with graphify knowledge graph data (when available)
      let enrichedMap = result.map;
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

      return {
        content: [{ type: "text" as const, text: enrichedMap }],
        details: result.stats,
      };
    },
  } as unknown as ToolDefinition;
}

// ── Registration ──────────────────────────────────────────────────

/**
 * Register repo-map and search tools with the Pi extension API.
 */
export default function registerRepoTools(pi: ExtensionAPI): void {
  pi.registerTool(createRepoTool());
  pi.registerTool(createSearchTool());
}
