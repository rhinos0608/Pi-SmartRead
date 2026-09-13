/**
 * Graphify enricher — transparently improves existing tools with graphify
 * knowledge graph data when graphify-out/graph.json is available.
 *
 * Design principle: NO new tools. Graphify data is consumed internally to
 * enrich the intent-read engine, search, repo_map, and the built-in read hook.
 * Graceful degradation when graph.json is absent.
 *
 * Integration points:
 *   - intent-read.ts: graph neighbor expansion (finds related files via
 *     graph edges, not just imports) + centrality as reranking signal
 *   - hook.ts: contextual read enrichment (shows graph-based relationships)
 *   - search-tool.ts: boost results from graph-central nodes
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { leidenCommunities } from "./leiden.js";

// ── Graph JSON types (NetworkX node-link format) ──────────────────

interface GraphNode {
  id: string;
  label?: string;
  source_file?: string;
  source_location?: string;
  file_type?: string;
  community?: number;
  [key: string]: unknown;
}

interface GraphEdge {
  source: string;
  target: string;
  relation?: string;
  confidence?: string;
  confidence_score?: number;
  context?: string;
  weight?: number;
  [key: string]: unknown;
}

interface GraphData {
  nodes?: GraphNode[];
  links?: GraphEdge[];
  directed?: boolean;
  multigraph?: boolean;
  graph?: Record<string, unknown>;
}

// ── Public types ──────────────────────────────────────────────────

export interface RelatedFileInfo {
  /** Absolute path to the related file */
  path: string;
  /** Edge relation type (calls, imports_from, references, conceptually_related_to, etc.) */
  relation: string;
  /** Confidence level */
  confidence: string;
  /** Numeric confidence score (0-1) */
  confidenceScore: number;
  /** Concept label in the source file (e.g. function name) */
  sourceLabel: string;
  /** Concept label in the target file */
  targetLabel: string;
}

export interface GodNodeInfo {
  id: string;
  label: string;
  degree: number;
}

export interface EnricherStats {
  nodeCount: number;
  edgeCount: number;
  communityCount: number;
  fileCount: number;
}

// ── Small shared helpers (pure, no behavior change) ─────────────────

/** Return key with highest count, or undefined when empty. */
function mostCommonCount(counts: Map<number, number>): number | undefined {
  let best: number | undefined;
  let bestCount = 0;
  for (const [key, count] of counts) {
    if (count > bestCount) {
      bestCount = count;
      best = key;
    }
  }
  return best;
}

/** Score a graph node label + source file against query terms. */
function scoreNodeForTerms(label: string, sourceFile: string, terms: string[]): number {
  let score = 0;
  for (const term of terms) {
    if (label.includes(term)) score += 1;
    if (sourceFile.includes(term)) score += 0.5;
    // Exact match bonus
    const stripped = label.replace(/\(\)$/, "");
    if (term === label || term === stripped) score += 100;
  }
  return score;
}

// ── Module-level cache (LRU-style, max 10 instances) ──

const MAX_ENRICHER_INSTANCES = 10;
const enricherInstances = new Map<string, GraphifyEnricher>();

/**
 * Get or create a GraphifyEnricher for a working directory.
 * Cached per resolved path to avoid re-parsing graph.json on every call.
 * Uses LRU-style eviction: removes oldest entry when at capacity.
 */
export function getGraphifyEnricher(cwd: string): GraphifyEnricher {
  const resolved = resolve(cwd);
  const instance = enricherInstances.get(resolved);
  if (instance) {
    // Promote to most-recently-used by re-inserting
    enricherInstances.delete(resolved);
    enricherInstances.set(resolved, instance);
    return instance;
  }

  // Evict oldest (first key = least recently used) if at capacity
  if (enricherInstances.size >= MAX_ENRICHER_INSTANCES) {
    const firstKey = enricherInstances.keys().next().value;
    if (firstKey !== undefined) {
      enricherInstances.delete(firstKey);
    }
  }

  const newInstance = new GraphifyEnricher(resolved);
  enricherInstances.set(resolved, newInstance);
  return newInstance;
}

/** Clear the enricher cache (for testing). */
export function clearEnricherCache(): void {
  enricherInstances.clear();
}

// ── Enricher ──────────────────────────────────────────────────────

export class GraphifyEnricher {
  private cwd: string;
  private graphPath: string | null = null;
  private fileToNodes: Map<string, string[]> | null = null;
  private nodeAttrs: Map<string, GraphNode> | null = null;
  private adjacency: Map<string, Map<string, GraphEdge[]>> | null = null;
  private loaded = false;
  private loadError: string | null = null;
  private _stats: EnricherStats | null = null;
  private _detectedCommunities: Map<string, number> | null = null;
  private _detectedResolution: number = 1.0;

  constructor(cwd: string) {
    this.cwd = resolve(cwd);
  }

  // ── Detection ──────────────────────────────────────────────────

  /**
   * Check if graph.json exists in a directory (without creating an instance).
   */
  static detectDirectory(dir: string): boolean {
    return (
      existsSync(resolve(dir, "graphify-out", "graph.json")) ||
      existsSync(resolve(dir, "graphify", "out", "graph.json")) ||
      existsSync(resolve(dir, "graph.json"))
    );
  }

  /**
   * Whether graph.json was found and loaded successfully.
   */
  get isAvailable(): boolean {
    this.ensureLoaded();
    return this.loaded && !this.loadError;
  }

  /**
   * Summary stats from the graph.
   */
  get stats(): EnricherStats | null {
    this.ensureLoaded();
    return this._stats;
  }

  /**
   * Error message if loading failed.
   */
  get loadErrorMessage(): string | null {
    this.ensureLoaded();
    return this.loadError;
  }

  /**
   * Path to the loaded graph.json (null if not found).
   */
  get path(): string | null {
    this.ensureLoaded();
    return this.graphPath;
  }

  // ── File → related files ──────────────────────────────────────

  /**
   * Get files related to a given file through graph edges.
   *
   * Finds all graph nodes whose source_file matches the given file,
   * then follows edges to neighbor nodes and maps them back to their
   * source_file paths. Uses all edge types: calls, imports_from,
   * references, conceptually_related_to, semantically_similar_to, etc.
   *
   * Returns deduplicated by target file path, sorted by confidenceScore.
   */
  getRelatedFilesForPath(filePath: string): RelatedFileInfo[] {
    if (!this.isAvailable) return [];
    this.ensureLoaded();

    const normalized = this.normalizePath(filePath);
    const nodeIds = this.fileToNodes!.get(normalized);
    if (!nodeIds || nodeIds.length === 0) return [];

    const seen = new Set<string>();
    const results: RelatedFileInfo[] = [];

    for (const nodeId of nodeIds) {
      const sourceAttrs = this.nodeAttrs!.get(nodeId);
      const sourceLabel = sourceAttrs?.label ?? nodeId;
      const neighbors = this.adjacency!.get(nodeId);
      if (!neighbors) continue;

      for (const [targetId, edges] of neighbors) {
        const targetAttrs = this.nodeAttrs!.get(targetId);
        const targetFile = targetAttrs?.source_file;
        if (!targetFile) continue;

        const targetAbs = resolve(this.cwd, targetFile);
        if (seen.has(targetAbs)) continue;

        // Pick the best edge (highest confidence_score)
        const bestEdge = edges.reduce((best, e) =>
          (e.confidence_score ?? 0) > (best.confidence_score ?? 0) ? e : best,
        );

        seen.add(targetAbs);
        // Only include edges to different files
        if (targetAbs === normalized) continue;

        results.push({
          path: targetAbs,
          relation: bestEdge.relation ?? "related",
          confidence: bestEdge.confidence ?? "EXTRACTED",
          confidenceScore: bestEdge.confidence_score ?? 1,
          sourceLabel,
          targetLabel: targetAttrs?.label ?? targetId,
        });
      }
    }

    // Sort by confidenceScore descending
    results.sort((a, b) => b.confidenceScore - a.confidenceScore);
    return results;
  }

  /**
   * Find files related to a natural language query.
   *
   * Scores all nodes by label match against query terms, takes the
   * top-matching seed nodes, then BFS-traverses to collect all
   * reachable files within maxDepth steps.
   */
  getRelatedFilesForQuery(
    query: string,
    maxDepth: number = 1,
  ): RelatedFileInfo[] {
    if (!this.isAvailable || !query.trim()) return [];
    this.ensureLoaded();

    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 2)
      .map((t) => t.replace(/[^a-z0-9_]/g, ""))
      .filter(Boolean);

    if (terms.length === 0) return [];

    // Score nodes by label match
    const scoredNodes: Array<[number, string]> = [];
    for (const [nodeId, attrs] of this.nodeAttrs!) {
      const label = (attrs.label ?? "").toLowerCase();
      const sourceFile = (attrs.source_file ?? "").toLowerCase();
      const score = scoreNodeForTerms(label, sourceFile, terms);
      if (score > 0) scoredNodes.push([score, nodeId]);
    }

    if (scoredNodes.length === 0) return [];

    scoredNodes.sort((a, b) => b[0] - a[0]);
    const seeds = scoredNodes.slice(0, 3).map(([_, id]) => id);

    // BFS to collect reachable files
    const visited = new Set<string>(seeds);
    const frontier = new Set(seeds);
    const resultFiles = new Map<string, RelatedFileInfo>();
    const depth = Math.min(maxDepth, 3);

    for (let d = 0; d < depth; d++) {
      const nextFrontier = new Set<string>();
      for (const nodeId of frontier) {
        const neighbors = this.adjacency!.get(nodeId);
        if (!neighbors) continue;

        for (const [targetId, edges] of neighbors) {
          if (visited.has(targetId)) continue;
          visited.add(targetId);
          nextFrontier.add(targetId);

          const targetAttrs = this.nodeAttrs!.get(targetId);
          const targetFile = targetAttrs?.source_file;
          if (!targetFile) continue;

          const bestEdge = edges[0]!;
          const absPath = resolve(this.cwd, targetFile);
          if (!resultFiles.has(absPath)) {
            resultFiles.set(absPath, {
              path: absPath,
              relation: bestEdge.relation ?? "related",
              confidence: bestEdge.confidence ?? "EXTRACTED",
              confidenceScore: bestEdge.confidence_score ?? 1,
              sourceLabel: this.nodeAttrs!.get(nodeId)?.label ?? nodeId,
              targetLabel: targetAttrs?.label ?? targetId,
            });
          }
        }
      }
      frontier.clear();
      for (const n of nextFrontier) frontier.add(n);
    }

    return [...resultFiles.values()].sort(
      (a, b) => b.confidenceScore - a.confidenceScore,
    );
  }

  // ── File importance ────────────────────────────────────────────

  /**
   * Graph centrality (importance) of a file.
   *
   * Returns the maximum node degree across all of a file's graph nodes.
   * Higher = more connected to other concepts in the graph.
   * Returns 0 when graph is unavailable or file has no nodes.
   */
  getFileCentrality(filePath: string): number {
    if (!this.isAvailable) return 0;
    this.ensureLoaded();

    const normalized = this.normalizePath(filePath);
    const nodeIds = this.fileToNodes!.get(normalized);
    if (!nodeIds || nodeIds.length === 0) return 0;

    let maxDegree = 0;
    for (const nodeId of nodeIds) {
      const neighbors = this.adjacency!.get(nodeId);
      if (neighbors) {
        maxDegree = Math.max(maxDegree, neighbors.size);
      }
    }
    return maxDegree;
  }

  /**
   * Count of unique files connected to this file through graph edges.
   * Measures how many other files reference concepts in this file.
   */
  getFileConnectedFileCount(filePath: string): number {
    if (!this.isAvailable) return 0;
    this.ensureLoaded();

    const related = this.getRelatedFilesForPath(filePath);
    return related.length;
  }

  // ── Community ──────────────────────────────────────────────────

  /**
   * Community membership for a file.
   *
   * Returns the most common community ID among the file's graph nodes.
   * A file's nodes can span multiple communities if it defines concepts
   * from different clusters (e.g. both domain models and HTTP handlers).
   *
   * Falls back to auto-detected communities when graph.json lacks
   * pre-computed community data.
   */
  getFileCommunity(filePath: string): number | undefined {
    if (!this.isAvailable) return undefined;
    this.ensureLoaded();

    const normalized = this.normalizePath(filePath);
    const nodeIds = this.fileToNodes!.get(normalized);
    if (!nodeIds || nodeIds.length === 0) return undefined;

    // Try pre-computed communities from graph.json first
    if (this._stats && this._stats.communityCount > 0) {
      const communities = new Map<number, number>();
      for (const nodeId of nodeIds) {
        const attrs = this.nodeAttrs!.get(nodeId);
        const comm = attrs?.community;
        if (comm !== undefined && comm !== null) {
          communities.set(comm, (communities.get(comm) ?? 0) + 1);
        }
      }
      if (communities.size > 0) {
        return mostCommonCount(communities);
      }
    }

    // Fall back to detected communities
    this.ensureDetectedCommunities();
    if (!this._detectedCommunities) return undefined;

    const commCounts = new Map<number, number>();
    for (const nodeId of nodeIds) {
      const comm = this._detectedCommunities.get(nodeId);
      if (comm !== undefined) {
        commCounts.set(comm, (commCounts.get(comm) ?? 0) + 1);
      }
    }
    if (commCounts.size === 0) return undefined;
    return mostCommonCount(commCounts);
  }

  /**
   * Get all files that belong to a graph community.
   *
   * Falls back to auto-detected communities when graph.json lacks
   * pre-computed community data.
   */
  getCommunityFiles(communityId: number): string[] {
    if (!this.isAvailable) return [];
    this.ensureLoaded();

    const fileSet = new Set<string>();

    // Try pre-computed communities from graph.json first
    if (this._stats && this._stats.communityCount > 0) {
      for (const [, attrs] of this.nodeAttrs!) {
        if (
          attrs.community === communityId &&
          attrs.source_file
        ) {
          fileSet.add(resolve(this.cwd, attrs.source_file));
        }
      }
    } else {
      // Fall back to detected communities
      this.ensureDetectedCommunities();
      if (this._detectedCommunities) {
        for (const [nodeId, comm] of this._detectedCommunities) {
          if (comm === communityId) {
            const attrs = this.nodeAttrs!.get(nodeId);
            if (attrs?.source_file) {
              fileSet.add(resolve(this.cwd, attrs.source_file));
            }
          }
        }
      }
    }

    return [...fileSet].sort();
  }

  /**
   * Number of communities in the graph.
   *
   * Falls back to auto-detected communities when graph.json lacks
   * pre-computed community data.
   */
  get communityCount(): number {
    if (!this.isAvailable) return 0;
    this.ensureLoaded();

    if (this._stats && this._stats.communityCount > 0) {
      return this._stats.communityCount;
    }

    this.ensureDetectedCommunities();
    if (this._detectedCommunities) {
      const unique = new Set(this._detectedCommunities.values());
      return unique.size;
    }

    return 0;
  }

  /**
   * Run Leiden community detection on the loaded graph.
   *
   * Detects communities when graph.json doesn't have pre-computed
   * communities, or re-detects with a different resolution parameter.
   * Results are cached and reused by getFileCommunity(),
   * getCommunityFiles(), and communityCount() when graph.json lacks
   * community data.
   *
   * @param options.resolution - Modularity resolution parameter (default 1.0).
   *   Higher values produce more, smaller communities.
   * @returns Map from node ID to community ID (0-indexed).
   */
  detectCommunities(options: { resolution?: number } = {}): Map<string, number> {
    this.ensureLoaded();
    if (!this.isAvailable) return new Map();
    if (!this.adjacency) return new Map();

    const resolution = options.resolution ?? 1.0;

    if (
      this._detectedCommunities &&
      this._detectedResolution === resolution
    ) {
      return this._detectedCommunities;
    }

    const simple = this.buildSimpleAdjacency();
    this._detectedCommunities = leidenCommunities(simple, {
      resolution,
      seed: 42,
    });
    this._detectedResolution = resolution;

    return this._detectedCommunities!;
  }

  /**
   * Statistics about all communities in the graph.
   *
   * Uses pre-computed communities from graph.json when available,
   * otherwise runs Leiden detection automatically.
   *
   * Returns an array sorted by community ID, with per-community stats:
   * - id: Community ID (0-indexed)
   * - size: Number of nodes in the community
   * - modularity: This community's contribution to the total modularity
   *   Q_c = Σ_in/2m - γ * (Σ_tot/2m)²
   */
  getCommunityStats(): Array<{ id: number; size: number; modularity: number }> {
    if (!this.isAvailable) return [];
    this.ensureLoaded();
    if (!this.nodeAttrs || !this.adjacency) return [];

    // Determine which communities to use
    let communities: Map<string, number>;
    let resolution: number;

    if (this._stats && this._stats.communityCount > 0) {
      communities = new Map();
      for (const [nodeId, attrs] of this.nodeAttrs) {
        if (attrs.community !== undefined && attrs.community !== null) {
          communities.set(nodeId, attrs.community);
        }
      }
      resolution = 1.0;
    } else {
      this.ensureDetectedCommunities();
      communities = this._detectedCommunities ?? new Map();
      resolution = this._detectedResolution;
    }

    if (communities.size === 0) return [];

    // Compute per-community aggregates
    const mMap = new Map<number, number>();
    const totMap = new Map<number, number>();
    const sizeMap = new Map<number, number>();
    const degreeMap = new Map<string, number>();

    // Node degrees from adjacency
    for (const [nodeId, neighbors] of this.adjacency) {
      let degree = 0;
      for (const [, edges] of neighbors) {
        degree += edges.length;
      }
      degreeMap.set(nodeId, degree);
    }

    // Total edge weight
    let totalWeight = 0;
    for (const deg of degreeMap.values()) {
      totalWeight += deg;
    }
    const twoM = totalWeight;
    if (twoM <= 0) return [];

    // Per-community degree total and size
    for (const [nodeId, comm] of communities) {
      totMap.set(comm, (totMap.get(comm) ?? 0) + (degreeMap.get(nodeId) ?? 0));
      sizeMap.set(comm, (sizeMap.get(comm) ?? 0) + 1);
    }

    // Internal edge weight per community
    for (const [nodeId, neighbors] of this.adjacency) {
      const comm = communities.get(nodeId);
      if (comm === undefined) continue;

      for (const [neighborId, edges] of neighbors) {
        const neighborComm = communities.get(neighborId);
        if (neighborComm === comm) {
          mMap.set(comm, (mMap.get(comm) ?? 0) + edges.length);
        }
      }
    }
    // Halve because each undirected edge counted twice
    for (const [comm, internal] of mMap) {
      mMap.set(comm, internal / 2);
    }

    const communityIds = [...new Set(communities.values())].sort((a, b) => a - b);
    const results: Array<{ id: number; size: number; modularity: number }> = [];

    for (const comm of communityIds) {
      const Σ_in = mMap.get(comm) ?? 0;
      const Σ_tot = totMap.get(comm) ?? 0;
      const size = sizeMap.get(comm) ?? 0;
      // Q_c = Σ_in/2m - γ * (Σ_tot/2m)²
      const modularity =
        (2 * Σ_in) / twoM - resolution * (Σ_tot / twoM) * (Σ_tot / twoM);
      results.push({ id: comm, size, modularity });
    }

    return results;
  }

  // ── God nodes (most important concepts) ────────────────────────

  /**
   * Most connected nodes in the graph — the core abstractions.
   *
   * Filters out file-level hub nodes (whose label matches their
   * source filename) since those accumulate edges mechanically
   * rather than representing meaningful conceptual centrality.
   */
  getGodNodes(topN: number = 10): GodNodeInfo[] {
    if (!this.isAvailable) return [];
    this.ensureLoaded();

    const degrees: Array<[string, number]> = [];
    for (const [nodeId, attrs] of this.nodeAttrs!) {
      const label = (attrs.label ?? nodeId).toLowerCase();
      const sourceFile = attrs.source_file ?? "";
      // Skip file-level hub nodes
      if (sourceFile) {
        const fname = sourceFile.split("/").pop()?.toLowerCase();
        if (fname && label === fname) continue;
      }
      // Skip method stubs (anonymous)
      if (label.startsWith(".") && label.endsWith("()")) continue;

      const neighbors = this.adjacency!.get(nodeId);
      if (neighbors && neighbors.size > 0) {
        degrees.push([nodeId, neighbors.size]);
      }
    }

    degrees.sort((a, b) => b[1] - a[1]);
    return degrees.slice(0, topN).map(([id, deg]) => ({
      id,
      label: this.nodeAttrs!.get(id)?.label ?? id,
      degree: deg,
    }));
  }

  // ── File concepts ──────────────────────────────────────────────

  /**
   * Get concept labels for all graph nodes associated with a file.
   * Filters out file-level labels (those ending in .ts, .js, etc.)
   * to return only meaningful code entity names.
   */
  getFileConcepts(filePath: string): string[] {
    if (!this.isAvailable) return [];
    this.ensureLoaded();

    const normalized = this.normalizePath(filePath);
    const nodeIds = this.fileToNodes!.get(normalized);
    if (!nodeIds) return [];

    return nodeIds
      .map((id) => this.nodeAttrs!.get(id)?.label)
      .filter((l): l is string => !!l && !/\.\w+$/.test(l));
  }

  // ── Graph node lookup by label ─────────────────────────────────

  /**
   * Find node IDs whose label contains the given term.
   * Returns node IDs sorted by match quality (exact → substring).
   */
  findNodesByLabel(term: string): Array<{ id: string; label: string }> {
    if (!this.isAvailable) return [];
    this.ensureLoaded();

    const lower = term.toLowerCase();
    const results: Array<{ id: string; label: string; exact: boolean }> = [];

    for (const [nodeId, attrs] of this.nodeAttrs!) {
      const label = (attrs.label ?? "").toLowerCase();
      if (label === lower || label.replace(/\(\)$/, "") === lower) {
        results.push({ id: nodeId, label: attrs.label ?? nodeId, exact: true });
      }
    }

    // Only return substring matches if no exact matches found
    if (results.length === 0) {
      for (const [nodeId, attrs] of this.nodeAttrs!) {
        const label = (attrs.label ?? "").toLowerCase();
        if (label.includes(lower)) {
          results.push({ id: nodeId, label: attrs.label ?? nodeId, exact: false });
        }
      }
    }

    return results.sort((a, b) => {
      if (a.exact !== b.exact) return a.exact ? -1 : 1;
      return a.label.localeCompare(b.label);
    });
  }

  // ── Internal ───────────────────────────────────────────────────

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;

    const candidates = [
      resolve(this.cwd, "graphify-out", "graph.json"),
      resolve(this.cwd, "graphify", "out", "graph.json"),
      resolve(this.cwd, "graph.json"),
    ];

    for (const p of candidates) {
      if (existsSync(p)) {
        this.graphPath = p;
        break;
      }
    }

    if (!this.graphPath) {
      this.loadError = "No graphify graph found";
      return;
    }

    try {
      const raw = readFileSync(this.graphPath, "utf-8");
      const data = JSON.parse(raw) as GraphData;
      this.buildIndex(data);
    } catch (err) {
      this.loadError = `Failed to load graph: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /** Append one directed adjacency entry, creating nested maps on demand. */
  private appendAdjacency(from: string, to: string, edge: GraphEdge): void {
    let neighbors = this.adjacency!.get(from);
    if (!neighbors) {
      neighbors = new Map();
      this.adjacency!.set(from, neighbors);
    }
    let edges = neighbors.get(to);
    if (!edges) {
      edges = [];
      neighbors.set(to, edges);
    }
    edges.push(edge);
  }

  private buildIndex(data: GraphData): void {
    const nodes = data.nodes ?? [];
    const edges = (data.links ?? []) as GraphEdge[];

    this.fileToNodes = new Map();
    this.nodeAttrs = new Map();
    this.adjacency = new Map();

    const edgeSet = new Set<string>();

    // Index nodes: map source_file → node IDs, store attrs
    for (const n of nodes) {
      this.nodeAttrs.set(n.id, n);

      if (n.source_file) {
        const normalized = resolve(this.cwd, n.source_file);
        let list = this.fileToNodes.get(normalized);
        if (!list) {
          list = [];
          this.fileToNodes.set(normalized, list);
        }
        list.push(n.id);
      }
    }

    // Build adjacency (undirected — edges work both ways)
    for (const e of edges) {
      const src = e.source;
      const tgt = e.target;
      if (!src || !tgt) continue;
      if (!this.nodeAttrs.has(src) || !this.nodeAttrs.has(tgt)) continue;

      // Undirected: store both directions
      this.appendAdjacency(src, tgt, e);
      this.appendAdjacency(tgt, src, { ...e, source: tgt, target: src } as GraphEdge);

      edgeSet.add(`${src}→${tgt}`);
    }

    const uniqueFiles = new Set(
      nodes.filter((n) => n.source_file).map((n) => n.source_file!),
    );

    const communitySet = new Set(
      nodes
        .filter((n) => n.community !== undefined && n.community !== null)
        .map((n) => n.community),
    );

    this._stats = {
      nodeCount: nodes.length,
      edgeCount: edgeSet.size,
      communityCount: communitySet.size,
      fileCount: uniqueFiles.size,
    };
  }

  /**
   * Build a simple unweighted adjacency list from the internal adjacency map.
   * Used by community detection.
   */
  private buildSimpleAdjacency(): Map<string, string[]> {
    const adj = new Map<string, string[]>();
    if (!this.adjacency) return adj;

    for (const [node, neighbors] of this.adjacency) {
      const list: string[] = [];
      for (const neighbor of neighbors.keys()) {
        list.push(neighbor);
      }
      adj.set(node, list);
    }
    return adj;
  }

  /**
   * Ensure detected communities exist, computing them if necessary.
   * Only used when graph.json lacks pre-computed community data.
   */
  private ensureDetectedCommunities(resolution?: number): void {
    const requested = resolution ?? 1.0;
    // Only use the cached result if the resolution matches. A previously
    // detected partition was computed for a specific resolution; reusing it
    // under a different resolution would silently return a wrong partition.
    if (this._detectedCommunities && this._detectedResolution === requested) return;
    if (!this.isAvailable) return;
    if (!this.adjacency) return;

    const simple = this.buildSimpleAdjacency();
    this._detectedCommunities = leidenCommunities(simple, {
      resolution: requested,
      seed: 42,
    });
    this._detectedResolution = requested;
  }

  private normalizePath(filePath: string): string {
    return resolve(this.cwd, filePath);
  }
}

export { leidenCommunities } from "./leiden.js";
