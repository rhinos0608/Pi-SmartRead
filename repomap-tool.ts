/**
 * Pi tool wrappers for the repo-map system.
 *
 * Exposes two tools:
 * - `repo_map` — generate a PageRank-ranked map of the repo
 * - `search_symbols` — search for symbols by name across the repo
 */
import { Type, type Static } from "typebox";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { RepoMap, type RepoMapOptions, type SearchResult } from "./repomap.js";
import { markRepoMapExplicitlyCalled } from "./hook.js";

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
        "Auto-fallback to import-based mapping when tree-sitter WASM fails (default: true). Set false to surface WASM errors.",
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
      toolCallId: string,
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

      // Mark as explicitly called so the hook doesn't regenerate
      markRepoMapExplicitlyCalled(cwd);

      return {
        content: [{ type: "text" as const, text: result.map }],
        details: result.stats,
      };
    },
  } as unknown as ToolDefinition;
}

// ── Tool: search_symbols ──────────────────────────────────────────

const SearchSymbolsSchema = Type.Object({
  query: Type.String({
    description: "Identifier name or substring to search for",
    minLength: 1,
  }),
  directory: Type.Optional(
    Type.String({
      description:
        "Root directory to search (default: extension working directory)",
    }),
  ),
  maxResults: Type.Optional(
    Type.Number({
      description: "Maximum results to return (default: 50)",
      minimum: 1,
      maximum: 200,
    }),
  ),
  includeDefinitions: Type.Optional(
    Type.Boolean({
      description: "Include definition matches (default: true)",
    }),
  ),
  includeReferences: Type.Optional(
    Type.Boolean({
      description: "Include reference matches (default: true)",
    }),
  ),
});

type SearchSymbolsInput = Static<typeof SearchSymbolsSchema>;

function createSearchSymbolsTool(): ToolDefinition {
  return {
    name: "search_symbols",
    label: "search_symbols",
    description: `Search for symbols (functions, classes, variables) by name across the repository using tree-sitter AST analysis. Returns matching definitions and references with surrounding code context. Use this to find where symbols are defined and where they're used.`,
    parameters: SearchSymbolsSchema,

    async execute(
      toolCallId: string,
      params: SearchSymbolsInput,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      const cwd = params.directory ? params.directory : ctx.cwd;
      const rm = new RepoMap(cwd);

      if (signal?.aborted) throw new Error("Operation aborted");

      const results: SearchResult[] = await rm.searchIdentifiers(
        params.query,
        {
          maxResults: params.maxResults ?? 50,
          includeDefinitions: params.includeDefinitions ?? true,
          includeReferences: params.includeReferences ?? true,
        },
      );

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `[No symbols found matching "${params.query}"]`,
            },
          ],
          details: { total: 0 },
        };
      }

      // Format results into a structured text output
      const lines: string[] = [
        `Found ${results.length} symbol(s) matching "${params.query}":`,
        "",
      ];

      for (const r of results) {
        const kind = r.kind === "def" ? "def" : "ref";
        const contextStr = r.context
          ? `\n${r.context.split("\n").map((l) => `  ${l}`).join("\n")}`
          : "";
        lines.push(`  ${r.file}:${r.line}  [${kind}]  ${r.name}${contextStr}`);
        lines.push("");
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: { total: results.length },
      };
    },
  } as unknown as ToolDefinition;
}

// ── Registration ──────────────────────────────────────────────────

/**
 * Register both repo-map tools with the Pi extension API.
 */
export default function registerRepoTools(pi: ExtensionAPI): void {
  pi.registerTool(createRepoTool());
  pi.registerTool(createSearchSymbolsTool());
}
