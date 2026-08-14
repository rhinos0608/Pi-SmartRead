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

/** Simple seeded PRNG: xorshift32. */
function createRng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >> 17;
    s ^= s << 5;
    // Use 0x100000000 (2^32) as denominator so max output is strictly < 1.
    return (s >>> 0) / 0x100000000;
  };
}

/** Deterministic seed from graph structure via djb2 hash. */
function seedFrom(
  nodes: string[],
  edges: Array<{ from: string; to: string }>,
): number {
  // Sort copies of inputs for canonical determinism.
  const sortedNodes = [...nodes].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  const sortedEdges = [...edges].sort((a, b) => {
    const cmp = a.from < b.from ? -1 : a.from > b.from ? 1 : 0;
    return cmp !== 0 ? cmp : a.to < b.to ? -1 : a.to > b.to ? 1 : 0;
  });

  let h = 5381;
  for (const n of sortedNodes) {
    // Length-delimited encoding: length prefix before content
    h = ((h << 5) + h + n.length) >>> 0;
    for (let i = 0; i < n.length; i++) {
      h = ((h << 5) + h + n.charCodeAt(i)) >>> 0;
    }
  }
  h = ((h << 5) + h + sortedNodes.length) >>> 0;
  h = ((h << 5) + h + sortedEdges.length) >>> 0;
  for (const e of sortedEdges) {
    // Length-delimited from field
    h = ((h << 5) + h + e.from.length) >>> 0;
    for (const ch of e.from) {
      h = ((h << 5) + h + ch.charCodeAt(0)) >>> 0;
    }
    // Separator between from and to to prevent concatenation collisions.
    h = ((h << 5) + h + 0) >>> 0;
    // Length-delimited to field
    h = ((h << 5) + h + e.to.length) >>> 0;
    for (const ch of e.to) {
      h = ((h << 5) + h + ch.charCodeAt(0)) >>> 0;
    }
  }
  return h;
}

/** Seeded Fisher-Yates shuffle — unbiased, transitive, reproducible. */
function seededShuffle<T>(arr: T[], rng: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = a[i]!;
    a[i] = a[j]!;
    a[j] = tmp;
  }
  return a;
}

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

/**
 * Collapse a graph according to community assignments: each community becomes
 * a super-node, inter-community edge weights are summed.
 * Returns { graph, originalMap } where originalMap maps super-node string IDs
 * back to arrays of node IDs from the input graph.
 */
function collapseGraph(
  g: LouvainGraph,
  comm: Map<string, number>,
): {
  graph: LouvainGraph;
  originalMap: Map<string, string[]>;
} {
  // Group nodes by community
  const groups = new Map<number, string[]>();
  for (const n of g.nodes) {
    const c = comm.get(n)!;
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c)!.push(n);
  }

  const superNodes: string[] = [];
  const superAdj = new Map<string, Map<string, number>>();
  const superDegree = new Map<string, number>();
  const originalMap = new Map<string, string[]>();
  // Map from original community id to the super-node string id
  const commToSuper = new Map<number, string>();

  let idx = 0;
  for (const [c, members] of groups) {
    const sid = `__sup${idx++}`;
    commToSuper.set(c, sid);
    superNodes.push(sid);
    superAdj.set(sid, new Map());
    originalMap.set(sid, [...members]);
  }

  // Accumulate inter-community edge weights
  let superM = 0;
  for (const n of g.nodes) {
    const cN = comm.get(n)!;
    const sidN = commToSuper.get(cN)!;
    for (const [nbr, w] of g.adj.get(n)!) {
      const cNbr = comm.get(nbr)!;
      if (cN === cNbr) {
        const sidSelf = commToSuper.get(cN)!;
        const adjMap = superAdj.get(sidN)!;
        adjMap.set(sidSelf, (adjMap.get(sidSelf) ?? 0) + w);
        continue;
      }
      const sidNbr = commToSuper.get(cNbr)!;
      const adjMap = superAdj.get(sidN)!;
      adjMap.set(sidNbr, (adjMap.get(sidNbr) ?? 0) + w);
    }
  }

  // Recompute degrees from completed adjacency, including self-edges.
  for (const sid of superNodes) {
    let degree = 0;
    for (const w of superAdj.get(sid)!.values()) degree += w;
    superDegree.set(sid, degree);
    superM += degree;
  }
  // Each undirected edge is represented in both endpoint adjacency lists.
  superM /= 2;

  return {
    graph: { nodes: superNodes, adj: superAdj, degree: superDegree, m: superM },
    originalMap,
  };
}

function louvain(g: LouvainGraph): ClusterResult {
  // Track mapping from super-node IDs back to original node names.
  // Initially each node maps to itself.
  let currentMap = new Map<string, string[]>(
    g.nodes.map((n) => [n, [n]]),
  );
  let workGraph: LouvainGraph = {
    nodes: [...g.nodes],
    adj: new Map([...g.adj.entries()].map(([k, v]) => [k, new Map(v)])),
    degree: new Map(g.degree),
    m: g.m,
  };

  for (let round = 0; round < 10; round++) {
    const phase1Comm = louvainPhase1(workGraph);

    // Check if any merging happened
    const commGroups = new Map<number, string[]>();
    for (const n of workGraph.nodes) {
      const c = phase1Comm.get(n)!;
      if (!commGroups.has(c)) commGroups.set(c, []);
      commGroups.get(c)!.push(n);
    }

    // No merging → stop
    if (commGroups.size === workGraph.nodes.length) break;

    // Collapse graph
    const { graph: collapsed, originalMap: collapsedMap } = collapseGraph(
      workGraph,
      phase1Comm,
    );

    // Merge original maps: collapsedMap gives super-node → nodes of workGraph;
    // currentMap gives workGraph-node → original nodes
    const mergedMap = new Map<string, string[]>();
    for (const [sid, members] of collapsedMap) {
      const originals: string[] = [];
      for (const m of members) {
        originals.push(...(currentMap.get(m) ?? [m]));
      }
      mergedMap.set(sid, originals);
    }

    workGraph = collapsed;
    currentMap = mergedMap;
  }

  // Final phase1 on the last working graph
  const finalComm =
    workGraph.nodes.length > 0
      ? louvainPhase1(workGraph)
      : new Map<string, number>();

  // Expand super-node assignments back to original node IDs
  const rawClusters = new Map<number, string[]>();
  for (const sid of workGraph.nodes) {
    const c = finalComm.get(sid)!;
    if (!rawClusters.has(c)) rawClusters.set(c, []);
    rawClusters.get(c)!.push(...(currentMap.get(sid) ?? [sid]));
  }

  // Re-index to contiguous IDs
  const reindexed = new Map<number, string[]>();
  let rid = 0;
  for (const [, members] of rawClusters) {
    reindexed.set(rid++, members);
  }

  const modularity = computeModularity(reindexed, g);
  return { clusters: reindexed, modularity, algorithm: "louvain" };
}

/**
 * Compute Newman modularity Q for the given clustering.
 * O(sum of adjacency-list lengths) per community — not O(n²).
 */
function computeModularity(
  clusters: Map<number, string[]>,
  g: LouvainGraph,
): number {
  const m = g.m;
  if (m === 0) return 0;

  let Q = 0;
  for (const [, members] of clusters) {
    const memberSet = new Set(members);
    let sigmaIn = 0;
    let sigmaTot = 0;
    for (const node of members) {
      const deg = g.degree.get(node)!;
      sigmaTot += deg;
      // Accumulate internal edge weight: only neighbors in same community
      for (const [nbr, w] of g.adj.get(node)!) {
        if (memberSet.has(nbr)) {
          sigmaIn += w;
        }
      }
    }
    // sigmaIn double-counts each internal edge (once per endpoint)
    Q += sigmaIn / (2 * m) - (sigmaTot / (2 * m)) * (sigmaTot / (2 * m));
  }
  return Q;
}

// ── Label Propagation Fallback ────────────────────────────────────

function labelPropagation(
  g: LouvainGraph,
  edges: Array<{ from: string; to: string }>,
): ClusterResult {
  const comm = new Map<string, number>();
  g.nodes.forEach((n, i) => comm.set(n, i));

  // Seeded shuffle for reproducibility
  const rng = createRng(seedFrom(g.nodes, edges));

  for (let iter = 0; iter < 30; iter++) {
    let changed = false;
    // Seeded Fisher-Yates shuffle
    const shuffled = seededShuffle(g.nodes, rng);

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
    return labelPropagation(g, importEdges);
  }

  return louvain(g);
}
