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
      let score = 0;
      for (const term of terms) {
        if (label.includes(term)) score += 1;
        if (sourceFile.includes(term)) score += 0.5;
        // Exact match bonus
        const stripped = label.replace(/\(\)$/, "");
        if (term === label || term === stripped) score += 100;
      }
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
        let bestComm: number | undefined;
        let bestCount = 0;
        for (const [comm, count] of communities) {
          if (count > bestCount) {
            bestCount = count;
            bestComm = comm;
          }
        }
        return bestComm;
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

    let bestComm: number | undefined;
    let bestCount = 0;
    for (const [comm, count] of commCounts) {
      if (count > bestCount) {
        bestCount = count;
        bestComm = comm;
      }
    }
    return bestComm;
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

      // Source → target
      let srcNeighbors = this.adjacency.get(src);
      if (!srcNeighbors) {
        srcNeighbors = new Map();
        this.adjacency.set(src, srcNeighbors);
      }
      let srcEdges = srcNeighbors.get(tgt);
      if (!srcEdges) {
        srcEdges = [];
        srcNeighbors.set(tgt, srcEdges);
      }
      srcEdges.push(e);

      // Target → source (undirected)
      let tgtNeighbors = this.adjacency.get(tgt);
      if (!tgtNeighbors) {
        tgtNeighbors = new Map();
        this.adjacency.set(tgt, tgtNeighbors);
      }
      let tgtEdges = tgtNeighbors.get(src);
      if (!tgtEdges) {
        tgtEdges = [];
        tgtNeighbors.set(src, tgtEdges);
      }
      tgtEdges.push({ ...e, source: tgt, target: src } as GraphEdge);

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

// ── Leiden Community Detection ──────────────────────────────────

/**
 * Seedable PRNG (Mulberry32).
 */
function seedRandom(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Fisher-Yates shuffle with provided RNG.
 */
function shuffleArray<T>(arr: T[], rng: () => number): T[] {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [result[i]!, result[j]!] = [result[j]!, result[i]!];
  }
  return result;
}

/**
 * Modularity gain from moving a node to a target community.
 * ΔQ = k_i_in / 2m - γ * Σtot * k_i / (2m)²
 */
function modGain(
  k_i_in: number,
  k_i: number,
  Σtot: number,
  twoM: number,
  γ: number,
): number {
  return (2 * k_i_in) / twoM - γ * Σtot * k_i / (twoM * twoM);
}

/**
 * Leiden community detection algorithm.
 *
 * Pure function, no external dependencies. Implements the Leiden algorithm
 * with local moving, refinement, and aggregation phases. Leiden improves
 * on Louvain by adding a refinement step that guarantees well-connected
 * communities: each community is internally connected and cannot be further
 * subdivided for better modularity.
 *
 * @param adjacency - Map from node ID to array of neighbor node IDs (undirected)
 * @param options - Resolution (γ, default 1.0; higher = more communities) and RNG seed
 * @returns Map from node ID to community ID (0-indexed, sequential)
 */
export function leidenCommunities(
  adjacency: Map<string, string[]>,
  options: { resolution?: number; seed?: number } = {},
): Map<string, number> {
  const resolution = options.resolution ?? 1.0;
  const allNodes = [...adjacency.keys()];
  if (allNodes.length === 0) return new Map();
  if (allNodes.length === 1) return new Map([[allNodes[0]!, 0]]);

  // ── Build weighted adjacency (deduplicate parallel edges, skip self-loops) ──
  const weighted = new Map<string, Map<string, number>>();
  for (const [node, neighbors] of adjacency) {
    const map = new Map<string, number>();
    for (const n of neighbors) {
      if (n !== node) map.set(n, (map.get(n) ?? 0) + 1);
    }
    if (map.size > 0) weighted.set(node, map);
  }

  const connected = allNodes.filter((n) => weighted.has(n));
  const isolated = allNodes.filter((n) => !weighted.has(n));
  if (connected.length === 0) {
    return new Map(allNodes.map((n, i) => [n, i]));
  }

  // ── Degrees and total edge weight ──
  const degrees = new Map<string, number>();
  let totalEdgeWeight = 0;
  for (const [node, neighbors] of weighted) {
    let d = 0;
    for (const w of neighbors.values()) d += w;
    degrees.set(node, d);
    totalEdgeWeight += d;
  }
  const twoM = totalEdgeWeight; // = 2m
  if (twoM <= 0) return new Map(allNodes.map((n, i) => [n, i]));

  // ── Community state initialisation ──
  const community = new Map<string, number>();
  const communityTotals = new Map<number, number>();
  connected.forEach((n, i) => {
    community.set(n, i);
    communityTotals.set(i, degrees.get(n) ?? 0);
  });

  const rng = seedRandom(options.seed ?? 42);
  let nextId = connected.length;

  function deg(n: string): number {
    return degrees.get(n) ?? 0;
  }

  function Σtot(c: number): number {
    return communityTotals.get(c) ?? 0;
  }

  function moveNode(node: string, from: number, to: number): void {
    const k = deg(node);
    community.set(node, to);
    communityTotals.set(from, Σtot(from) - k);
    communityTotals.set(to, Σtot(to) + k);
  }

  // ── Phase 1: Local moving ──

  function localPass(): boolean {
    let anyChange = false;
    for (let pass = 0; pass < 20; pass++) {
      let changed = false;
      const shuffled = shuffleArray(connected, rng);
      for (const node of shuffled) {
        const cur = community.get(node)!;
        const neigh = weighted.get(node);
        if (!neigh) continue;
        const k = deg(node);
        if (k === 0) continue;

        const candidates = new Map<number, number>();
        for (const nbr of neigh.keys()) {
          const nc = community.get(nbr);
          if (nc !== undefined && nc !== cur) {
            candidates.set(nc, (candidates.get(nc) ?? 0) + (neigh.get(nbr) ?? 0));
          }
        }
        if (candidates.size === 0) continue;

        let best = cur;
        let bestGain = 0;
        for (const [cand] of candidates) {
          const k_i_in = candidates.get(cand) ?? 0;
          const g = modGain(k_i_in, k, Σtot(cand), twoM, resolution);
          if (g > bestGain) {
            bestGain = g;
            best = cand;
          }
        }
        if (best !== cur && bestGain > 0) {
          moveNode(node, cur, best);
          changed = true;
          anyChange = true;
        }
      }
      if (!changed) break;
    }
    return anyChange;
  }

  // ── Phase 2: Refinement ──
  // Splits each community into well-connected sub-communities by
  // running local-moving constrained to the original community.

  function refinePhase(): void {
    const comms = [...new Set(community.values())];
    for (const c of comms) {
      const members = connected.filter((n) => community.get(n) === c);
      if (members.length <= 1) continue;

      const sub = new Map<string, number>();
      const subTotals = new Map<number, number>();
      for (const n of members) {
        const sid = nextId++;
        sub.set(n, sid);
        subTotals.set(sid, deg(n));
      }

      for (let iter = 0; iter < 10; iter++) {
        let changed = false;
        const shuffled = shuffleArray(members, rng);
        for (const node of shuffled) {
          const curSC = sub.get(node)!;
          const neigh = weighted.get(node);
          if (!neigh) continue;
          const k = deg(node);

          const candidates = new Map<number, number>();
          for (const [nbr, wt] of neigh) {
            if (community.get(nbr) !== c) continue;
            const nsc = sub.get(nbr);
            if (nsc !== undefined && nsc !== curSC) {
              candidates.set(nsc, (candidates.get(nsc) ?? 0) + wt);
            }
          }
          if (candidates.size === 0) continue;

          let best = curSC;
          let bestGain = 0;
          for (const [sc, edgeWt] of candidates) {
            const g = modGain(edgeWt, k, subTotals.get(sc) ?? 0, twoM, resolution);
            if (g > bestGain) {
              bestGain = g;
              best = sc;
            }
          }
          if (best !== curSC && bestGain > 0) {
            sub.set(node, best);
            subTotals.set(curSC, (subTotals.get(curSC) ?? 0) - k);
            subTotals.set(best, (subTotals.get(best) ?? 0) + k);
            changed = true;
          }
        }
        if (!changed) break;
      }

      for (const n of members) {
        community.set(n, sub.get(n)!);
      }
      for (const [sid, tot] of subTotals) {
        communityTotals.set(sid, tot);
      }
    }
    nextId = communityTotals.size > 0 ? Math.max(...communityTotals.keys()) + 1 : 0;
  }

  // ── Phase 3: Aggregation ──
  // Build reduced graph where each community becomes a super-node.

  function aggregatePhase(): {
    aggAdj: Map<string, string[]>;
    nodeToSuper: Map<string, string>;
  } {
    const nodeToSuper = new Map<string, string>();
    for (const [node, c] of community) {
      nodeToSuper.set(node, `s${c}`);
    }

    const aggAdj = new Map<string, string[]>();
    // Aggregate internal edge mass per super-node. Each undirected edge is
    // encountered once per endpoint (so weight w appears twice across the
    // traversal). Sum then halve to get the undirected internal weight Σ_in
    // for the super-node. The self-loop on the super-node must carry 2·Σ_in
    // entries so that aggTwoM (which sums neighbour-list lengths and so
    // counts each cross-edge twice and each self-loop once) reflects the
    // original 2m of edge mass.
    const internalSum = new Map<string, number>();
    for (const [node, neighbors] of weighted) {
      const mySuper = nodeToSuper.get(node)!;
      for (const [nbr, w] of neighbors) {
        const nbrSuper = nodeToSuper.get(nbr)!;
        if (mySuper === nbrSuper) {
          internalSum.set(mySuper, (internalSum.get(mySuper) ?? 0) + w);
        } else {
          let list = aggAdj.get(mySuper);
          if (!list) {
            list = [];
            aggAdj.set(mySuper, list);
          }
          list.push(nbrSuper);
        }
      }
    }
    for (const [superNode, summed] of internalSum) {
      const undirectedInternal = summed / 2;
      // Self-loop count = 2 * undirectedInternal. This matches how cross-
      // edges appear (one entry per endpoint, totalling 2 per undirected
      // edge) so aggTwoM remains consistent.
      const loopCount = 2 * undirectedInternal;
      let list = aggAdj.get(superNode);
      if (!list) {
        list = [];
        aggAdj.set(superNode, list);
      }
      for (let i = 0; i < loopCount; i++) list.push(superNode);
    }
    return { aggAdj, nodeToSuper };
  }

  // ── Main Leiden loop ──

  for (let mainIter = 0; mainIter < 100; mainIter++) {
    if (!localPass()) break;
    refinePhase();

    const { aggAdj, nodeToSuper } = aggregatePhase();
    if (aggAdj.size <= 1 || aggAdj.size >= community.size) break;

    // Phase 4: Local moving on aggregated graph
    const aggNodes = [...aggAdj.keys()];
    const aggCommunity = new Map<string, number>();
    const aggTotals = new Map<number, number>();
    aggNodes.forEach((n, i) => {
      aggCommunity.set(n, i);
      aggTotals.set(i, aggAdj.get(n)?.length ?? 0);
    });

    let aggTwoM = 0;
    for (const [, neighs] of aggAdj) {
      aggTwoM += neighs.length;
    }
    if (aggTwoM <= 0) break;

    for (let pass = 0; pass < 10; pass++) {
      let changed = false;
      const aggShuffled = shuffleArray(aggNodes, rng);
      for (const aggNode of aggShuffled) {
        const curComm = aggCommunity.get(aggNode)!;
        const neighbors = aggAdj.get(aggNode);
        if (!neighbors || neighbors.length === 0) continue;
        const k = neighbors.length;
        if (k === 0) continue;

        const candidates = new Map<number, number>();
        for (const nbr of neighbors) {
          const nc = aggCommunity.get(nbr);
          if (nc !== undefined && nc !== curComm) {
            candidates.set(nc, (candidates.get(nc) ?? 0) + 1);
          }
        }
        if (candidates.size === 0) continue;

        let best = curComm;
        let bestGain = 0;
        for (const [cand] of candidates) {
          const edgeWt = candidates.get(cand) ?? 0;
          const g = modGain(edgeWt, k, aggTotals.get(cand) ?? 0, aggTwoM, resolution);
          if (g > bestGain) {
            bestGain = g;
            best = cand;
          }
        }
        if (best !== curComm && bestGain > 0) {
          aggCommunity.set(aggNode, best);
          aggTotals.set(curComm, (aggTotals.get(curComm) ?? 0) - k);
          aggTotals.set(best, (aggTotals.get(best) ?? 0) + k);
          changed = true;
        }
      }
      if (!changed) break;
    }

    // Lift aggregated communities back to original nodes
    for (const [node] of community) {
      const sn = nodeToSuper.get(node)!;
      community.set(node, aggCommunity.get(sn) ?? community.get(node)!);
    }

    // Recompute community totals
    communityTotals.clear();
    for (const [node, c] of community) {
      communityTotals.set(c, (communityTotals.get(c) ?? 0) + (degrees.get(node) ?? 0));
    }
    nextId = communityTotals.size > 0 ? Math.max(...communityTotals.keys()) + 1 : 0;
  }

  // ── Normalise community IDs to 0-indexed sequential ──
  const unique = [...new Set(community.values())].sort((a, b) => a - b);
  const normalise = new Map<number, number>();
  unique.forEach((id, i) => normalise.set(id, i));

  const result = new Map<string, number>();
  for (const [node, c] of community) {
    result.set(node, normalise.get(c)!);
  }
  let isoId = result.size > 0 ? Math.max(...result.values()) + 1 : 0;
  for (const node of isolated) {
    result.set(node, isoId++);
  }
  return result;
}
