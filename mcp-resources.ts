/**
 * MCP Resources for Pi-SmartRead.
 *
 * Defines resource URIs and a resolver that returns the resource content.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { Resource } from "@modelcontextprotocol/sdk/types.js";
import { validateEmbeddingConfig, loadSearchConfig, loadGitContextConfig, loadExperimentalConfig } from "./config.js";
import { buildToolRegistry } from "./mcp-registry.js";
import { getGraphifyEnricher } from "./graphify-enricher.js";
import { readCoverage, summarizeCoverage } from "./index-coverage.js";
import { readAdrs } from "./adr-store.js";
import { findNearClones } from "./near-clone.js";
import { discoverFiles } from "./file-discovery.js";
import { getIndexLockStatus } from "./index-lock.js";
import { verifySnapshot } from "./index-snapshot.js";

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
  {
    uri: "smartread://repo/stats",
    name: "Repository Statistics",
    mimeType: "application/json",
    description: "Repository file count, language breakdown, and source-file statistics",
  },
  {
    uri: "smartread://repo/graph/summary",
    name: "Context Graph Summary",
    mimeType: "text/plain",
    description: "Knowledge graph summary — nodes, edges, communities, and file coverage",
  },
  {
    uri: "smartread://repo/graph/communities",
    name: "Graph Communities",
    mimeType: "text/plain",
    description: "Detected architectural clusters with file counts and sample filenames",
  },
  {
    uri: "smartread://repo/graph/god-nodes",
    name: "Graph God Nodes",
    mimeType: "text/plain",
    description: "Highest-centrality graph nodes (core abstractions), sorted by connection count",
  },
  {
    uri: "smartread://repo/index/status",
    name: "Index Status",
    mimeType: "application/json",
    description: "Knowledge graph index — file count, last modified, and pending changes",
  },
  {
    uri: "smartread://repo/index/coverage",
    name: "Index Coverage",
    mimeType: "application/json",
    description: "Index coverage records: indexed, ignored, unsupported, binary, partial, parse/read errors",
  },
  {
    uri: "smartread://repo/adrs",
    name: "Architecture Decision Records",
    mimeType: "application/json",
    description: "Project ADRs stored under .pi-smartread/adrs",
  },
  {
    uri: "smartread://repo/near-clones",
    name: "Near Clone Report",
    mimeType: "application/json",
    description: "MinHash+LSH near-clone pairs for source files",
  },
];

// ── Config helpers ────────────────────────────────────────────────────────────

function getResolvedConfig(): Record<string, unknown> {
  const embedding = validateEmbeddingConfig();
  const search = loadSearchConfig();
  const gitContext = loadGitContextConfig();
  const experimental = loadExperimentalConfig();

  // Redact secrets: never expose raw API keys in config resource
  const safeEmbedding = embedding
    ? {
        baseUrl: embedding.baseUrl,
        model: embedding.model,
        apiKeyConfigured: !!embedding.apiKey,
        chunkSizeChars: embedding.chunkSizeChars,
        chunkOverlapChars: embedding.chunkOverlapChars,
        maxChunksPerFile: embedding.maxChunksPerFile,
        probeEnabled: embedding.probeEnabled,
        rerankEnabled: embedding.rerankEnabled,
        hydeEnabled: embedding.hydeEnabled,
        externalRerankerConfigured: !!embedding.externalReranker,
      }
    : { _note: "No embedding config found — BM25-only mode active" };

  return {
    version: VERSION,
    embedding: safeEmbedding,
    search,
    gitContext,
    experimental,
  };
}

function getRepoStats(): Record<string, unknown> {
  const cwd = process.cwd();

  // Walk source files (non-recursive top-level scan is too shallow; do shallow scan of src/ and lib/)
  const dirsToScan = [
    resolve(cwd, "src"),
    resolve(cwd, "lib"),
    resolve(cwd, "packages"),
  ].filter((d) => existsSync(d));

  if (dirsToScan.length === 0) {
    // Fallback: scan cwd non-recursively
    dirsToScan.push(cwd);
  }

  const extensions = new Map<string, number>();
  let totalFiles = 0;

  for (const dir of dirsToScan) {
    try {
      const entries = readdirSync(dir, { withFileTypes: true, recursive: true });
      for (const entry of entries) {
        if (entry.isFile()) {
          totalFiles++;
          const ext = entry.name.includes(".") ? entry.name.split(".").pop()?.toLowerCase() ?? "(none)" : "(none)";
          extensions.set(ext, (extensions.get(ext) ?? 0) + 1);
        }
      }
    } catch {
      // Directory may not exist or may be inaccessible
    }
  }

  // Sort by count descending
  const sortedLangBreakdown = [...extensions.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([ext, count]) => ({ ext, count }));

  return {
    cwd,
    scannedDirectories: dirsToScan,
    totalFiles,
    languageBreakdown: sortedLangBreakdown,
    languages: sortedLangBreakdown.length,
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
export async function resolveResource(uri: string): Promise<{ uri: string; mimeType: string; text: string }> {
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

  if (uri === "smartread://repo/stats") {
    return {
      uri,
      mimeType: "application/json",
      text: JSON.stringify(getRepoStats(), null, 2),
    };
  }

  if (uri === "smartread://repo/index/status") {
    const cwd = process.cwd();
    const enricher = getGraphifyEnricher(cwd);
    const graphPath = enricher.path;

    let lastModified: string | null = null;
    let fileSize: number | null = null;
    if (graphPath) {
      try {
        const st = statSync(graphPath);
        lastModified = st.mtime.toISOString();
        fileSize = st.size;
      } catch {
        // stat failed
      }
    }

    const status = {
      hasGraph: enricher.isAvailable,
      graphPath: graphPath ?? "(not found)",
      nodes: enricher.stats?.nodeCount ?? 0,
      edges: enricher.stats?.edgeCount ?? 0,
      communities: enricher.stats?.communityCount ?? 0,
      sourceFiles: enricher.stats?.fileCount ?? 0,
      lastModified,
      fileSize,
      loadError: enricher.loadErrorMessage ?? null,
      locks: {
        fileHashes: getIndexLockStatus(cwd, "file-hashes"),
      },
      snapshots: {
        graph: verifySnapshot(cwd, "graph"),
      },
    };

    return {
      uri,
      mimeType: "application/json",
      text: JSON.stringify(status, null, 2),
    };
  }

  if (uri === "smartread://repo/index/coverage") {
    const records = readCoverage(process.cwd());
    return {
      uri,
      mimeType: "application/json",
      text: JSON.stringify({ summary: summarizeCoverage(records), records: records.slice(0, 500) }, null, 2),
    };
  }

  if (uri === "smartread://repo/adrs") {
    return {
      uri,
      mimeType: "application/json",
      text: JSON.stringify({ records: readAdrs(process.cwd()) }, null, 2),
    };
  }

  if (uri === "smartread://repo/near-clones") {
    const cwd = process.cwd();
    const result = await discoverFiles(cwd, "code", 1000);
    const clones = findNearClones(result.files, { threshold: 0.9, maxPairs: 100 });
    return {
      uri,
      mimeType: "application/json",
      text: JSON.stringify({ fileCount: result.files.length, clones }, null, 2),
    };
  }

  if (uri === "smartread://repo/graph/summary") {
    const cwd = process.cwd();
    const enricher = getGraphifyEnricher(cwd);

    if (!enricher.isAvailable) {
      return {
        uri,
        mimeType: "text/plain",
        text: "No graphify knowledge graph found. Run graphify pipeline to generate graphify-out/graph.json.",
      };
    }

    const s = enricher.stats;
    const lines = [
      `Nodes:  ${s?.nodeCount ?? "?"}`,
      `Edges:  ${s?.edgeCount ?? "?"}`,
      `Communities:  ${s?.communityCount ?? "?"}`,
      `Source files:  ${s?.fileCount ?? "?"}`,
      `Graph file:  ${enricher.path ?? "unknown"}`,
    ];

    return {
      uri,
      mimeType: "text/plain",
      text: lines.join("\n"),
    };
  }

  if (uri === "smartread://repo/graph/communities") {
    const cwd = process.cwd();
    const enricher = getGraphifyEnricher(cwd);

    if (!enricher.isAvailable) {
      return {
        uri,
        mimeType: "text/plain",
        text: "No graphify knowledge graph found. Run graphify pipeline to generate graphify-out/graph.json.",
      };
    }

    const cc = enricher.communityCount;
    const lines: string[] = [
      `Total communities: ${cc}`,
      "",
    ];

    // Collect actual community IDs (may be non-contiguous from graph.json)
    const communityIds = new Set<number>();
    for (let cid = 0; cid < cc + 100 && communityIds.size < 50; cid++) {
      const files = enricher.getCommunityFiles(cid);
      if (files.length > 0) communityIds.add(cid);
    }
    for (const cid of [...communityIds].sort((a, b) => a - b).slice(0, 50)) {
      const files = enricher.getCommunityFiles(cid);
      if (files.length === 0) continue;
      const stems = files
        .map((f) => f.split("/").pop() ?? f)
        .slice(0, 6)
        .join(", ");
      lines.push(`  Cluster ${cid} (${files.length} files):  ${stems}${files.length > 6 ? ` (+${files.length - 6})` : ""}`);
    }

    return {
      uri,
      mimeType: "text/plain",
      text: lines.join("\n"),
    };
  }

  if (uri === "smartread://repo/graph/god-nodes") {
    const cwd = process.cwd();
    const enricher = getGraphifyEnricher(cwd);

    if (!enricher.isAvailable) {
      return {
        uri,
        mimeType: "text/plain",
        text: "No graphify knowledge graph found. Run graphify pipeline to generate graphify-out/graph.json.",
      };
    }

    const gods = enricher.getGodNodes(20);
    const lines = [
      `Top ${gods.length} most connected graph nodes:`,
      "",
      ...gods.map((g, i) => `  ${i + 1}. ${g.label}  (degree: ${g.degree})`),
    ];

    return {
      uri,
      mimeType: "text/plain",
      text: lines.join("\n"),
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
 * `repo_map` and `search`.
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