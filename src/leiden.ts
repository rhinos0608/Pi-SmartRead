/**
 * Leiden community detection — pure, dependency-free.
 * Moved from graphify-enricher.ts (re-exported there for compatibility).
 */

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
