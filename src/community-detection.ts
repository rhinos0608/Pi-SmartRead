/**
 * Community detection on import graphs.
 *
 * Louvain method: modularity optimization via local moving + aggregation.
 * Falls back to label-propagation for very large graphs (>5000 nodes).
 *
 * Dependency-free — pure algorithm module.
 */

// ── Types ─────────────────────────────────────────────────────────

export interface ClusterResult {
  clusters: Map<number, string[]>;
  modularity: number;
  algorithm: "louvain" | "label-propagation";
}

// ── Helpers ───────────────────────────────────────────────────────

interface LouvainGraph {
  nodes: string[];
  adj: Map<string, Map<string, number>>;
  degree: Map<string, number>;
  m: number; // total edge weight
}

function buildGraph(edges: Array<{ from: string; to: string }>): LouvainGraph {
  const nodeSet = new Set<string>();
  const adj = new Map<string, Map<string, number>>();

  function ensureNode(n: string): void {
    if (!nodeSet.has(n)) {
      nodeSet.add(n);
      adj.set(n, new Map());
    }
  }

  for (const { from, to } of edges) {
    ensureNode(from);
    ensureNode(to);
    adj.get(from)!.set(to, (adj.get(from)!.get(to) ?? 0) + 1);
    adj.get(to)!.set(from, (adj.get(to)!.get(from) ?? 0) + 1);
  }

  const nodes = [...nodeSet];
  const degree = new Map<string, number>();
  let m2 = 0;
  for (const n of nodes) {
    let d = 0;
    for (const w of adj.get(n)!.values()) d += w;
    degree.set(n, d);
    m2 += d;
  }

  return { nodes, adj, degree, m: m2 / 2 };
}

// ── Louvain ───────────────────────────────────────────────────────

function louvainPhase1(g: LouvainGraph): Map<string, number> {
  // Each node starts in its own community
  const comm = new Map<string, number>();
  g.nodes.forEach((n, i) => comm.set(n, i));

  const sigmaIn = new Map<number, number>(); // sum of internal edges per community
  const sigmaTot = new Map<number, number>(); // sum of degrees per community

  for (const n of g.nodes) {
    const c = comm.get(n)!;
    sigmaTot.set(c, (sigmaTot.get(c) ?? 0) + g.degree.get(n)!);
    // Internal edges from n to same community (initially just self-loops = 0)
    sigmaIn.set(c, sigmaIn.get(c) ?? 0);
  }

  const m = g.m;
  if (m === 0) return comm;

  let improved = true;
  let maxIter = 50;

  while (improved && maxIter-- > 0) {
    improved = false;

    for (const node of g.nodes) {
      const oldC = comm.get(node)!;
      const ki = g.degree.get(node)!;

      // Collect neighboring communities and edge weights
      const neighborWeights = new Map<number, number>();
      for (const [nbr, w] of g.adj.get(node)!) {
        const nc = comm.get(nbr)!;
        neighborWeights.set(nc, (neighborWeights.get(nc) ?? 0) + w);
      }

      // Remove node from its community temporarily
      const oldSigmaTot = sigmaTot.get(oldC)!;
      sigmaTot.set(oldC, oldSigmaTot - ki);

      // Remove internal edges from old community
      const kICold = neighborWeights.get(oldC) ?? 0;
      sigmaIn.set(oldC, (sigmaIn.get(oldC) ?? 0) - kICold);

      let bestC = oldC;
      let bestGain = 0;

      // Try each neighboring community (and self)
      const candidates = new Set(neighborWeights.keys());
      candidates.add(oldC);

      for (const c of candidates) {
        const st = sigmaTot.get(c) ?? 0;
        const kIC = neighborWeights.get(c) ?? 0;
        // ΔQ = kIC/m - st*ki/(2m²)
        const gain = kIC / m - (st * ki) / (2 * m * m);
        if (gain > bestGain + 1e-10) {
          bestGain = gain;
          bestC = c;
        }
      }

      // Place node in best community
      comm.set(node, bestC);
      const kICbest = neighborWeights.get(bestC) ?? 0;
      sigmaIn.set(bestC, (sigmaIn.get(bestC) ?? 0) + kICbest);
      sigmaTot.set(bestC, (sigmaTot.get(bestC) ?? 0) + ki);

      if (bestC !== oldC) improved = true;
    }
  }

  return comm;
}

function louvain(g: LouvainGraph): ClusterResult {
  const comm = louvainPhase1(g);

  // Re-index communities to contiguous IDs
  const idMap = new Map<number, number>();
  let nextId = 0;
  for (const n of g.nodes) {
    const c = comm.get(n)!;
    if (!idMap.has(c)) idMap.set(c, nextId++);
  }

  const clusters = new Map<number, string[]>();
  for (const n of g.nodes) {
    const mapped = idMap.get(comm.get(n)!)!;
    if (!clusters.has(mapped)) clusters.set(mapped, []);
    clusters.get(mapped)!.push(n);
  }

  const modularity = computeModularity(clusters, g);
  return { clusters, modularity, algorithm: "louvain" };
}

function computeModularity(clusters: Map<number, string[]>, g: LouvainGraph): number {
  const m = g.m;
  if (m === 0) return 0;

  let Q = 0;
  for (const [, members] of clusters) {
    const memberSet = new Set(members);
    const memberArr = [...memberSet];
    for (const i of memberArr) {
      for (const j of memberArr) {
        const aij = g.adj.get(i)?.get(j) ?? 0;
        Q += aij - (g.degree.get(i)! * g.degree.get(j)!) / (2 * m);
      }
    }
  }
  return Q / (2 * m);
}

// ── Label Propagation Fallback ────────────────────────────────────

function labelPropagation(g: LouvainGraph): ClusterResult {
  const comm = new Map<string, number>();
  g.nodes.forEach((n, i) => comm.set(n, i));

  for (let iter = 0; iter < 30; iter++) {
    let changed = false;
    // Shuffle nodes for convergence
    const shuffled = [...g.nodes].sort(() => Math.random() - 0.5);

    for (const node of shuffled) {
      const weights = new Map<number, number>();
      for (const [nbr, w] of g.adj.get(node)!) {
        const lc = comm.get(nbr)!;
        weights.set(lc, (weights.get(lc) ?? 0) + w);
      }

      if (weights.size === 0) continue;

      // Pick community with highest total weight
      let bestC = comm.get(node)!;
      let bestW = -1;
      for (const [c, w] of weights) {
        if (w > bestW) {
          bestW = w;
          bestC = c;
        }
      }

      if (bestC !== comm.get(node)) {
        comm.set(node, bestC);
        changed = true;
      }
    }

    if (!changed) break;
  }

  // Re-index
  const idMap = new Map<number, number>();
  let nextId = 0;
  for (const n of g.nodes) {
    const c = comm.get(n)!;
    if (!idMap.has(c)) idMap.set(c, nextId++);
  }

  const clusters = new Map<number, string[]>();
  for (const n of g.nodes) {
    const mapped = idMap.get(comm.get(n)!)!;
    if (!clusters.has(mapped)) clusters.set(mapped, []);
    clusters.get(mapped)!.push(n);
  }

  const modularity = computeModularity(clusters, g);
  return { clusters, modularity, algorithm: "label-propagation" };
}

// ── Main API ──────────────────────────────────────────────────────

const LOUVAIN_NODE_THRESHOLD = 5000;

/**
 * Detect communities in an import graph using Louvain (or label-propagation
 * for very large graphs).
 */
export function detectCommunities(
  importEdges: Array<{ from: string; to: string }>,
): ClusterResult {
  if (importEdges.length === 0) {
    return {
      clusters: new Map([[0, []]]),
      modularity: 0,
      algorithm: "louvain",
    };
  }

  const g = buildGraph(importEdges);

  if (g.nodes.length <= 1) {
    return {
      clusters: new Map([[0, g.nodes]]),
      modularity: 0,
      algorithm: "louvain",
    };
  }

  if (g.m === 0) {
    // No edges — each node is its own cluster
    const clusters = new Map<number, string[]>();
    g.nodes.forEach((n, i) => clusters.set(i, [n]));
    return { clusters, modularity: 0, algorithm: "louvain" };
  }

  if (g.nodes.length > LOUVAIN_NODE_THRESHOLD) {
    return labelPropagation(g);
  }

  return louvain(g);
}
