/**
 * Custom PageRank implementation for repo-map ranking.
 * Zero-dependency, uses Float64Array for performance.
 *
 * Implements Aider-style sophisticated edge weighting:
 * - camelCase/snake_case/kebab_case identifiers >= 8 chars: 10x
 * - Identifiers starting with _ (internal): 0.1x
 * - Identifiers defined in >5 files (generic names): 0.1x
 * - User-mentioned identifiers (mentionedIdents): 10x
 * - When referencer is a focus/chat file: 50x
 * - sqrt(num_refs) sub-linear scaling
 * - Self-edges with weight 0.1 for defs without refs
 */

export interface GraphEdge {
  from: string;
  to: string;
  weight?: number;
}

/**
 * PageRank options for sophisticated weighting.
 */
export interface PageRankOptions {
  /** Damping factor (default: 0.85) */
  alpha?: number;

  /** Maximum iterations (default: 100) */
  maxIter?: number;

  /** Convergence tolerance (default: 1e-6) */
  tol?: number;

  /** Identifiers the user mentioned (boosts edges containing them) */
  mentionedIdents?: Set<string>;

  /** Files in the "chat" / focus set (boost edges from these) */
  chatRelFiles?: Set<string>;
}

/**
 * Determine the weight multiplier for an identifier based on its characteristics.
 *
 * Rules (matching Aider's repomap.py):
 * - mentioned_idents → 10x
 * - camelCase/snake_case/kebab_case AND >= 8 chars → 10x (meaningful names)
 * - starts with _ → 0.1x (internal)
 * - defined in >5 files → 0.1x (generic names like "name", "data")
 * - default → 1.0
 */
function identifierMultiplier(
  ident: string,
  defCount: number,
  mentionedIdents?: Set<string>,
): number {
  let mul = 1.0;

  const isSnake = ident.includes("_") && /[a-zA-Z]/.test(ident);
  const isKebab = ident.includes("-") && /[a-zA-Z]/.test(ident);
  const isCamel = /[a-z]/.test(ident) && /[A-Z]/.test(ident);

  if (mentionedIdents?.has(ident)) {
    mul *= 10;
  }
  if ((isSnake || isKebab || isCamel) && ident.length >= 8) {
    mul *= 10;
  }
  if (ident.startsWith("_")) {
    mul *= 0.1;
  }
  if (defCount > 5) {
    mul *= 0.1;
  }

  return mul;
}

/**
 * Rank nodes using the PageRank algorithm with sophisticated edge weighting.
 *
 * Edge weight calculation (per-identifier):
 *   weight = identifierMultiplier * sqrt(numRefs)
 *   If referencer is a chatRelFile, multiply by 50
 *
 * Self-edges with weight 0.1 are added for identifiers that are defined
 * but never referenced (to give them minimal rank).
 *
 * @param nodes - Set of all node identifiers (files)
 * @param edges - Directed edges (from → to = referencing file → defining file)
 * @param personalization - Optional per-node personalization weights
 * @param options - Page ranking options
 * @returns Map of node → PageRank score
 */
export function pagerank(
  nodes: Set<string>,
  edges: GraphEdge[],
  personalization?: Map<string, number>,
  options: PageRankOptions = {},
): Map<string, number> {
  const { alpha = 0.85, maxIter = 100, tol = 1e-6 } = options;
  const nodeList = Array.from(nodes);
  const n = nodeList.length;
  if (n === 0) return new Map();

  const nodeIndex = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    nodeIndex.set(nodeList[i], i);
  }

  const outDegree = new Float64Array(n);
  const adjList: Array<Array<{ to: number; weight: number }>> = Array.from(
    { length: n },
    () => [],
  );

  // Group edges by identifier for weight calculation
  // edges are already (from, to) pairs — weight is computed below
  for (const edge of edges) {
    const fromIdx = nodeIndex.get(edge.from);
    const toIdx = nodeIndex.get(edge.to);
    if (fromIdx === undefined || toIdx === undefined) continue;

    const weight = edge.weight ?? 1.0;
    adjList[fromIdx].push({ to: toIdx, weight });
    outDegree[fromIdx] += weight;
  }

  let ranks = new Float64Array(n).fill(1 / n);

  // Build personalization vector
  const personVec = new Float64Array(n);
  if (personalization && personalization.size > 0) {
    let total = 0;
    for (const [node, val] of personalization) {
      const idx = nodeIndex.get(node);
      if (idx !== undefined) {
        personVec[idx] = val;
        total += val;
      }
    }
    if (total > 0) {
      for (let i = 0; i < n; i++) personVec[i] /= total;
    } else {
      personVec.fill(1 / n);
    }
  } else {
    personVec.fill(1 / n);
  }

  // Also pass personalization as dangling (matching Aider's behavior:
  // nx.pagerank(G, personalization=pers_args, dangling=pers_args))
  // Ensures dangling nodes still get bias toward important files.
  const danglingVec = personVec;

  // Iterate until convergence
  for (let iter = 0; iter < maxIter; iter++) {
    const newRanks = new Float64Array(n);

    // Sum of ranks of dangling nodes (no outgoing edges)
    let danglingSum = 0;
    for (let i = 0; i < n; i++) {
      if (outDegree[i] === 0) danglingSum += ranks[i];
    }

    // Teleport contribution (uses danglingVec for dangling redistribution)
    for (let i = 0; i < n; i++) {
      newRanks[i] = (1 - alpha) * personVec[i] + alpha * danglingSum * danglingVec[i];
    }

    // Edge contributions
    for (let i = 0; i < n; i++) {
      if (outDegree[i] === 0) continue;
      const contribution = (alpha * ranks[i]) / (outDegree[i] || 1);
      for (const { to, weight } of adjList[i]) {
        newRanks[to] += contribution * weight;
      }
    }

    // Check convergence
    let diff = 0;
    for (let i = 0; i < n; i++) {
      diff += Math.abs(newRanks[i] - ranks[i]);
    }

    ranks = newRanks;
    if (diff < tol) break;
  }

  const result = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    result.set(nodeList[i], ranks[i]);
  }
  return result;
}

/**
 * Build a weighted PageRank graph from tags.
 *
 * This is the full Aider-style graph builder that computes:
 * 1. Self-edges (weight=0.1) for defined-but-never-referenced identifiers
 * 2. Weighted edges for shared identifiers with identifier-aware multipliers
 * 3. Sub-linear sqrt(num_refs) scaling
 * 4. Chat file boost (50x) when referencer is a focus file
 *
 * Returns edges ready for pagerank() with the weight embedded via edge multiplicity.
 */
export function buildWeightedEdges(
  defines: Map<string, Set<string>>,
  references: Map<string, string[]>,
  options: {
    mentionedIdents?: Set<string>;
    chatRelFiles?: Set<string>;
  } = {},
): GraphEdge[] {
  const { mentionedIdents, chatRelFiles } = options;
  const edges: GraphEdge[] = [];

  // Self-edges for identifiers that are defined but never referenced
  // Each self-edge has weight 0.1
  for (const [ident, definers] of defines) {
    if (references.has(ident)) continue;
    for (const definer of definers) {
      edges.push({ from: definer, to: definer, weight: 0.1 });
    }
  }

  // Weighted edges for identifiers that are both defined and referenced
  const idents = new Set([
    ...defines.keys(),
  ]);

  for (const ident of idents) {
    const definers = defines.get(ident);
    const referencers = references.get(ident);
    if (!definers || !referencers) continue;

    // Compute identifier multiplier
    const mul = identifierMultiplier(ident, definers.size, mentionedIdents);

    // Count references per referencer file
    const refCounts = new Map<string, number>();
    for (const ref of referencers) {
      refCounts.set(ref, (refCounts.get(ref) ?? 0) + 1);
    }

    for (const [referencer, rawCount] of refCounts) {
      let useMul = mul;
      if (chatRelFiles?.has(referencer)) {
        useMul *= 50;
      }
      const numRefs = Math.sqrt(rawCount);
      const finalWeight = Math.round(useMul * numRefs);

      for (const definer of definers) {
        if (referencer === definer) continue;
        // Add multiple edges to represent weight (since our pagerank uses
        // unweighted edge counting internally)
        for (let w = 0; w < finalWeight; w++) {
          edges.push({ from: referencer, to: definer });
        }
      }
    }
  }

  return edges;
}
