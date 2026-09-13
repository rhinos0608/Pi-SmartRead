/**
 * Structural PageRank channel.
 *
 * Ranks files by PageRank centrality derived from graph edges
 * (import, mutation, co-change) supplied as a ContextGraph snapshot.
 *
 * Reuses the existing pagerank() from src/pagerank.ts for the
 * iterative computation, but presents results through the channel
 * contract used by the ranking pipeline.
 */

import { pagerank, type GraphEdge } from "../pagerank.js";

// ── Channel contract (duplicated here to stay self-contained) ──────────

export interface ChannelCandidate {
  file: string;
  line?: number;
  endLine?: number;
  name: string;
  kind: string;
  snippet: string;
  rawScore: number;
}

export interface ChannelResult {
  channel: string;
  candidates: ChannelCandidate[];
  unavailable?: { reason: string };
  metadata?: Record<string, unknown>;
}

// ── Public API ─────────────────────────────────────────────────────────

const MAX_CANDIDATES = 500;

export interface StructuralPageRankOptions {
  /** Damping factor (default 0.85). */
  dampingFactor?: number;
  /** Max candidates to return (default 500). */
  maxCandidates?: number;
}

/**
 * Run structural PageRank over a set of graph edges and return the top
 * files ranked by centrality.
 *
 * @param edges   Directed graph edges (from → to). Nodes are derived
 *                automatically from the edge set.
 * @param options Tuning knobs (damping, cap).
 */
export function structuralPageRank(
  edges: GraphEdge[],
  options: StructuralPageRankOptions = {},
): ChannelResult {
  const { dampingFactor = 0.85, maxCandidates = MAX_CANDIDATES } = options;

  if (edges.length === 0) {
    return {
      channel: "structural-pagerank",
      candidates: [],
      unavailable: { reason: "empty graph — no edges provided" },
    };
  }

  // Collect unique nodes from edges
  const nodes = new Set<string>();
  for (const e of edges) {
    nodes.add(e.from);
    nodes.add(e.to);
  }

  const scores = pagerank(nodes, edges, undefined, {
    alpha: dampingFactor,
    maxIter: 100,
    tol: 1e-6,
  });

  // Sort descending by score
  const ranked = Array.from(scores.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxCandidates);

  const candidates: ChannelCandidate[] = ranked.map(([file, score]) => ({
    file,
    name: file.split("/").pop() ?? file,
    kind: "file",
    snippet: "",
    rawScore: score,
  }));

  return {
    channel: "structural-pagerank",
    candidates,
    metadata: {
      nodeCount: nodes.size,
      edgeCount: edges.length,
      dampingFactor,
    },
  };
}
