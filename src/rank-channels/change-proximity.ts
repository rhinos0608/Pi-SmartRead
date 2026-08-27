/**
 * Change-proximity ranking channel.
 *
 * Ranks source files by proximity to recently changed files using graph
 * import edges. Changed files get the highest score, then direct importers,
 * then transitive importers up to depth 3.
 *
 * Bounded to 500 candidates. Returns unavailable when no changes provided.
 */

import type { Provenance } from "../context-graph.js";

// ── Types ────────────────────────────────────────────────────────

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

export interface ChangeProximityOptions {
  /** Recently changed file paths (from snapshot delta). */
  changedPaths: string[];
  /** Graph edges from the current snapshot. */
  provenances: Provenance[];
  /** Maximum candidates to return (default 500). */
  max?: number;
}

// ── Constants ────────────────────────────────────────────────────

const MAX_CANDIDATES = 500;
const MAX_DEPTH = 3;

/** Score decays by depth: depth 0 = 1.0, depth 1 = 0.8, depth 2 = 0.6, depth 3 = 0.4 */
const scoreForDepth = (depth: number): number => Math.round((1.0 - depth * 0.2) * 10) / 10;

// ── Core ─────────────────────────────────────────────────────────

/**
 * Build a reverse adjacency map: for each file, which files import it.
 * Uses "imports" edges (A imports B → importerMap[B].push(A)).
 */
function buildImporterMap(provenances: Provenance[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const p of provenances) {
    if (p.type !== "imports") continue;
    const { from, to } = p;
    let importers = map.get(to);
    if (!importers) {
      importers = new Set();
      map.set(to, importers);
    }
    importers.add(from);
  }
  return map;
}

/**
 * BFS from changed files through the importer graph, up to MAX_DEPTH.
 * Returns Map<filePath, depth>.
 */
function bfsImporters(
  changedPaths: string[],
  importerMap: Map<string, Set<string>>,
): Map<string, number> {
  const visited = new Map<string, number>();
  const queue: Array<{ file: string; depth: number }> = [];

  for (const file of changedPaths) {
    if (!visited.has(file)) {
      visited.set(file, 0);
      queue.push({ file, depth: 0 });
    }
  }

  while (queue.length > 0) {
    const { file, depth } = queue.shift()!;
    if (depth >= MAX_DEPTH) continue;

    const importers = importerMap.get(file);
    if (!importers) continue;

    for (const importer of importers) {
      if (visited.has(importer)) continue;
      visited.set(importer, depth + 1);
      queue.push({ file: importer, depth: depth + 1 });
    }
  }

  return visited;
}

/**
 * Run the change-proximity channel.
 *
 * Scores files by their BFS distance from changed files through the
 * import graph. Changed files themselves score 1.0; direct importers 0.8;
 * transitive importers 0.6 (depth 2) or 0.4 (depth 3).
 */
export function runChangeProximity(options: ChangeProximityOptions): ChannelResult {
  const { changedPaths, provenances, max = MAX_CANDIDATES } = options;

  if (changedPaths.length === 0) {
    return {
      channel: "change-proximity",
      candidates: [],
      unavailable: { reason: "no changed files provided" },
    };
  }

  const importerMap = buildImporterMap(provenances);
  const proximityMap = bfsImporters(changedPaths, importerMap);

  const candidates: ChannelCandidate[] = [];
  for (const [file, depth] of proximityMap) {
    candidates.push({
      file,
      name: file,
      kind: depth === 0 ? "changed" : "importer",
      snippet: "",
      rawScore: scoreForDepth(depth),
    });
  }

  // Sort by rawScore descending, then file path for stability
  candidates.sort((a, b) => b.rawScore - a.rawScore || a.file.localeCompare(b.file));

  return {
    channel: "change-proximity",
    candidates: candidates.slice(0, max),
    metadata: {
      totalProximityHits: proximityMap.size,
      maxDepth: MAX_DEPTH,
      changedCount: changedPaths.length,
    },
  };
}
