/**
 * MCP Resources for Pi-SmartRead.
 *
 * Defines resource URIs and a resolver that returns the resource content.
 */
import type { Resource } from "@modelcontextprotocol/sdk/types.js";
import { validateEmbeddingConfig, loadSearchConfig, loadGitContextConfig, loadExperimentalConfig } from "./config.js";
import { buildToolRegistry } from "./mcp-registry.js";

// ── Constants ────────────────────────────────────────────────────────────────

const VERSION = "0.1.0";

/** Threshold in bytes beyond which a tool result should be offered as a resource link. */
export const LARGE_RESULT_THRESHOLD = 8 * 1024; // 8 KB

// ── Resource Definitions ─────────────────────────────────────────────────────

/**
 * All resources exposed by the Pi-SmartRead MCP server.
 */
export const MCP_RESOURCES: Resource[] = [
  {
    uri: "smartread://config",
    name: "SmartRead Config",
    mimeType: "application/json",
    description: "Current SmartRead configuration (embedding, search, git context, experimental features)",
  },
  {
    uri: "smartread://repo-map",
    name: "Repo Map",
    mimeType: "text/plain",
    description: "Latest repository symbol map (PageRank + tree-sitter)",
  },
  {
    uri: "smartread://status",
    name: "Server Status",
    mimeType: "application/json",
    description: "Server version, tool count, and runtime status",
  },
];

// ── Config helpers ────────────────────────────────────────────────────────────

function getResolvedConfig(): Record<string, unknown> {
  const embedding = validateEmbeddingConfig();
  const search = loadSearchConfig();
  const gitContext = loadGitContextConfig();
  const experimental = loadExperimentalConfig();

  return {
    version: VERSION,
    embedding: embedding ?? { _note: "No embedding config found — BM25-only mode active" },
    search,
    gitContext,
    experimental,
  };
}

function getServerStatus(): Record<string, unknown> {
  const tools = buildToolRegistry();
  const experimental = loadExperimentalConfig();

  return {
    version: VERSION,
    toolCount: tools.length,
    experimentalTools: {
      graphMutate: experimental.graphMutate ?? false,
      gitNotes: experimental.gitNotes ?? false,
    },
    capabilities: {
      tools: true,
      prompts: true,
      resources: true,
    },
  };
}

// ── Resource resolver ────────────────────────────────────────────────────────

/**
 * Resolve a smartread:// URI to its content.
 *
 * @param uri - A smartread:// URI string
 * @returns The resource contents, or throws if the URI is not recognized.
 */
export function resolveResource(uri: string): { uri: string; mimeType: string; text: string } {
  if (uri === "smartread://config") {
    return {
      uri,
      mimeType: "application/json",
      text: JSON.stringify(getResolvedConfig(), null, 2),
    };
  }

  if (uri === "smartread://repo-map") {
    return {
      uri,
      mimeType: "text/plain",
      text: "<repo-map-placeholder>Run the repo_map tool to generate the full repository symbol map.</repo-map-placeholder>",
    };
  }

  if (uri === "smartread://status") {
    return {
      uri,
      mimeType: "application/json",
      text: JSON.stringify(getServerStatus(), null, 2),
    };
  }

  throw new Error(`Resource not found: ${uri}`);
}

// ── maybeResourceLink helper ───────────────────────────────────────────────────

export type ContentItem = { type: "text"; text: string } | { type: "resource_link"; uri: string; name?: string; description?: string; mimeType?: string };

/**
 * If `content` exceeds the `LARGE_RESULT_THRESHOLD`, return a resource_link item
 * instead of embedding it inline. Otherwise, return the inline text item.
 *
 * Use this helper in tool result handlers for large-content tools like
 * `repo_map`, `search` (mode=deep), and `search`.
 *
 * @param name  - Resource name used for the URI (`smartread://result/{name}`)
 * @param content - Raw content string
 * @returns A content array: either a single `resource_link` or a single `text` item.
 */
export function maybeResourceLink(name: string, content: string): ContentItem[] {
  if (content.length > LARGE_RESULT_THRESHOLD) {
    return [
      {
        type: "resource_link" as const,
        uri: `smartread://result/${encodeURIComponent(name)}`,
        name,
        mimeType: "text/plain",
      },
    ];
  }
  return [{ type: "text" as const, text: content }];
}