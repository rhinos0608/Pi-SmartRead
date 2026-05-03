/**
 * Graphify enricher — transparently improves existing tools with graphify
 * knowledge graph data when graphify-out/graph.json is available.
 *
 * Design principle: NO new tools. Graphify data is consumed internally to
 * enrich intent_read, search, repo_map, and the built-in read hook.
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

// ── Module-level cache ────────────────────────────────────────────

const enricherInstances = new Map<string, GraphifyEnricher>();

/**
 * Get or create a GraphifyEnricher for a working directory.
 * Cached per resolved path to avoid re-parsing graph.json on every call.
 */
export function getGraphifyEnricher(cwd: string): GraphifyEnricher {
  const resolved = resolve(cwd);
  let instance = enricherInstances.get(resolved);
  if (!instance) {
    instance = new GraphifyEnricher(resolved);
    enricherInstances.set(resolved, instance);
  }
  return instance;
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
   */
  getFileCommunity(filePath: string): number | undefined {
    if (!this.isAvailable) return undefined;
    this.ensureLoaded();

    const normalized = this.normalizePath(filePath);
    const nodeIds = this.fileToNodes!.get(normalized);
    if (!nodeIds || nodeIds.length === 0) return undefined;

    const communities = new Map<number, number>();
    for (const nodeId of nodeIds) {
      const attrs = this.nodeAttrs!.get(nodeId);
      const comm = attrs?.community;
      if (comm !== undefined && comm !== null) {
        communities.set(comm, (communities.get(comm) ?? 0) + 1);
      }
    }

    if (communities.size === 0) return undefined;

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

  /**
   * Get all files that belong to a graph community.
   */
  getCommunityFiles(communityId: number): string[] {
    if (!this.isAvailable) return [];
    this.ensureLoaded();

    const fileSet = new Set<string>();
    for (const [, attrs] of this.nodeAttrs!) {
      if (
        attrs.community === communityId &&
        attrs.source_file
      ) {
        fileSet.add(resolve(this.cwd, attrs.source_file));
      }
    }
    return [...fileSet].sort();
  }

  /**
   * Number of communities in the graph.
   */
  get communityCount(): number {
    if (!this.isAvailable) return 0;
    this.ensureLoaded();
    return this._stats?.communityCount ?? 0;
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

  private normalizePath(filePath: string): string {
    return resolve(this.cwd, filePath);
  }
}
