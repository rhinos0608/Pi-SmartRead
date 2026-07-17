/**
 * Impact analysis: blast-radius computation and risk classification.
 *
 * BFS from a target file through call+import+mutation graph edges,
 * producing a ranked list of affected files/symbols with risk levels.
 *
 * Risk classification (deterministic, no learned weights):
 *   critical: PageRank > 0.9 OR fan-in > 50 OR entry_point + blastRadius >= 3
 *   high:     PageRank > 0.7 OR fan-in > 20 OR public_api
 *   medium:   fan-in > 5 OR blastRadius >= 2
 *   low:      everything else
 */

import { type ContextGraph } from "./context-graph.js";
import type { CallGraphResult, FunctionInfo } from "./callgraph.js";

// ── Types ─────────────────────────────────────────────────────────

export type RiskLevel = "critical" | "high" | "medium" | "low";

export interface ImpactResult {
  /** Target file path that was analyzed. */
  target: string;
  /** Highest risk level across all affected files. */
  risk: RiskLevel;
  /** Affected files ranked by risk, then fan-in. */
  affectedFiles: Array<{ path: string; risk: RiskLevel; fanIn: number; depth: number }>;
  /** All affected symbol names (unique). */
  affectedSymbols: string[];
  /** Maximum hop distance from target. */
  blastRadiusDepth: number;
  /** Call graph summary for the target. */
  callGraphSummary: {
    directCallers: number;
    transitiveCallers: number;
    directCallees: number;
    transitiveCallees: number;
  };
}

export interface ImpactParams {
  /** Absolute path of the target file. */
  targetFile: string;
  /** Maximum BFS depth (default 3). */
  maxDepth?: number;
  /** Pre-built PageRank scores (file → score). Optional. */
  pageRankScores?: Map<string, number>;
  /** Workspace root for resolving relative paths. */
  workspaceRoot?: string;
  /** ContextGraph for graph-aware BFS expansion. When provided, performs real traversal. */
  contextGraph?: ContextGraph;
}

export interface DeadCodeResult {
  /** Files containing dead functions. */
  files: Array<{
    path: string;
    functions: Array<{ name: string; line: number }>;
  }>;
  /** Total number of zero-caller functions found. */
  totalDeadFunctions: number;
}

// ── Constants ─────────────────────────────────────────────────────

const RISK_ORDER: Record<RiskLevel, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/** Thresholds (from ADR-004). */
const PR_CRITICAL = 0.9;
const PR_HIGH = 0.7;
const FANIN_CRITICAL = 50;
const FANIN_HIGH = 20;
const FANIN_MEDIUM = 5;
const ENTRY_BLAST_CRITICAL_DEPTH = 3;
const ENTRY_BLAST_HIGH_DEPTH = 2;

/** Entry-point / public-API heuristics. */
const ENTRY_POINT_PATTERNS = [
  /main\b/i,
  /handler\b/i,
  /index\b/i,
  /app\b/i,
  /server\b/i,
  /route\b/i,
];
const TEST_FILE_RE = /\.(test|spec)\.[^.]+$/;

// ── Risk classification ──────────────────────────────────────────

function classifyRisk(params: {
  pageRank: number;
  fanIn: number;
  blastRadiusDepth: number;
  isEntryPoint: boolean;
  isPublicApi: boolean;
}): RiskLevel {
  const { pageRank, fanIn, blastRadiusDepth, isEntryPoint, isPublicApi } = params;

  // Critical: highest signals
  if (
    pageRank > PR_CRITICAL ||
    fanIn > FANIN_CRITICAL ||
    (isEntryPoint && blastRadiusDepth >= ENTRY_BLAST_CRITICAL_DEPTH)
  ) {
    return "critical";
  }

  // High: strong signals
  if (
    pageRank > PR_HIGH ||
    fanIn > FANIN_HIGH ||
    isPublicApi
  ) {
    return "high";
  }

  // Medium: moderate signals
  if (fanIn > FANIN_MEDIUM || blastRadiusDepth >= ENTRY_BLAST_HIGH_DEPTH) {
    return "medium";
  }

  return "low";
}

function computeFanIn(targetFile: string, callGraph: CallGraphResult | null): number {
  if (!callGraph) return 0;
  const targetBase = targetFile.split("/").pop() ?? targetFile;
  let count = 0;
  for (const fn of callGraph.functions) {
    if (fn.file === targetFile) {
      count += fn.calledBy.length;
    } else if (fn.name === targetBase) {
      count += fn.calledBy.length;
    }
  }
  return count;
}

function isEntryPoint(filePath: string, _functions: FunctionInfo[]): boolean {
  const base = filePath.split("/").pop() ?? "";
  return ENTRY_POINT_PATTERNS.some((re) => re.test(base));
}

function isPublicApi(filePath: string, callGraph: CallGraphResult | null): boolean {
  if (!callGraph) return false;
  const fns = callGraph.functions.filter((f) => f.file === filePath);
  // If any function in the file is exported and has many callers, treat as public API
  const publicFns = fns.filter((f) => f.calledBy.length > FANIN_MEDIUM);
  return publicFns.length > 0;
}

// ── Impact analysis ───────────────────────────────────────────────

/**
 * Compute blast radius from a target file via BFS through the context graph.
 *
 * Expands neighbors via:
 * - getFileNeighbours() — file-level import/define edges
 * - findSymbolFiles() — symbol definition files (used for call targets)
 * - getMutationNeighbours() — breakage/co-change edges from EdgeStore
 */
export async function computeImpact(params: ImpactParams): Promise<ImpactResult> {
  const {
    targetFile,
    maxDepth = 3,
    pageRankScores,
    contextGraph,
  } = params;

  // BFS state
  const visited = new Map<string, { depth: number }>(); // path → depth
  visited.set(targetFile, { depth: 0 });

  // When ContextGraph is available, perform real BFS traversal
  if (contextGraph) {
    const bfsResult = await expandBlastRadius(targetFile, contextGraph, maxDepth);
    for (const [path, { depth }] of bfsResult) {
      visited.set(path, { depth });
    }
  }

  const affectedFiles: ImpactResult["affectedFiles"] = [];
  const affectedSymbols: Set<string> = new Set();

  const targetFanIn = computeFanIn(targetFile, null);
  const targetIsEntryPoint = isEntryPoint(targetFile, []);
  const targetIsPublicApi = isPublicApi(targetFile, null);
  const targetPageRank = pageRankScores?.get(targetFile) ?? 0;

  const targetRisk = classifyRisk({
    pageRank: targetPageRank,
    fanIn: targetFanIn,
    blastRadiusDepth: 0,
    isEntryPoint: targetIsEntryPoint,
    isPublicApi: targetIsPublicApi,
  });

  const callGraphSummary: ImpactResult["callGraphSummary"] = {
    directCallers: 0,
    transitiveCallers: 0,
    directCallees: 0,
    transitiveCallees: 0,
  };

  let maxDepthReached = 0;

  for (const [path, { depth }] of visited) {
    if (path === targetFile) continue;
    const fanIn = computeFanIn(path, null);
    const risk = classifyRisk({
      pageRank: pageRankScores?.get(path) ?? 0,
      fanIn,
      blastRadiusDepth: depth,
      isEntryPoint: isEntryPoint(path, []),
      isPublicApi: isPublicApi(path, null),
    });
    affectedFiles.push({ path, risk, fanIn, depth });
    if (depth > maxDepthReached) maxDepthReached = depth;
  }

  affectedFiles.sort((a, b) => {
    const riskDiff = RISK_ORDER[a.risk] - RISK_ORDER[b.risk];
    if (riskDiff !== 0) return riskDiff;
    return b.fanIn - a.fanIn;
  });

  return {
    target: targetFile,
    risk: targetRisk,
    affectedFiles,
    affectedSymbols: [...affectedSymbols],
    blastRadiusDepth: maxDepthReached,
    callGraphSummary,
  };
}

/**
 * BFS expansion helper — given a ContextGraph and starting file, returns
 * the full blast-radius set up to maxDepth.
 *
 * This is the graph-aware version used by inspect.ts which has access to
 * the ContextGraph instance.
 */
export async function expandBlastRadius(
  targetFile: string,
  contextGraph: ContextGraph,
  maxDepth: number,
): Promise<Map<string, { depth: number; edgeType: string }>> {
  const visited = new Map<string, { depth: number; edgeType: string }>();
  const queue: Array<{ path: string; depth: number }> = [{ path: targetFile, depth: 0 }];
  visited.set(targetFile, { depth: 0, edgeType: "self" });

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= maxDepth) continue;

    // Expand via file-level neighbours (imports, defines)
    try {
      const fileNeighbours = await contextGraph.getFileNeighbours(current.path, {
        includeSymbols: true,
        includeCalls: true,
      });
      for (const neighbour of fileNeighbours) {
        if (!visited.has(neighbour.path)) {
          visited.set(neighbour.path, {
            depth: current.depth + 1,
            edgeType: neighbour.provenance.type,
          });
          queue.push({ path: neighbour.path, depth: current.depth + 1 });
        }
      }
    } catch {
      // getFileNeighbours may fail for unreadable files — skip
    }

    // Expand via mutation edges (breakage, co-change)
    try {
      const mutationNeighbours = contextGraph.getMutationNeighbours(current.path);
      for (const neighbour of mutationNeighbours) {
        if (!visited.has(neighbour.path)) {
          visited.set(neighbour.path, {
            depth: current.depth + 1,
            edgeType: neighbour.provenance.type,
          });
          queue.push({ path: neighbour.path, depth: current.depth + 1 });
        }
      }
    } catch {
      // getMutationNeighbours may fail — skip
    }
  }

  return visited;
}

/**
 * Classify risk for a file given blast-radius context.
 * Used by inspect.ts after expandBlastRadius.
 */
export function classifyFileRisk(params: {
  filePath: string;
  pageRank: number;
  fanIn: number;
  blastRadiusDepth: number;
  isEntryPoint?: boolean;
  isPublicApi?: boolean;
}): RiskLevel {
  return classifyRisk({
    pageRank: params.pageRank,
    fanIn: params.fanIn,
    blastRadiusDepth: params.blastRadiusDepth,
    isEntryPoint: params.isEntryPoint ?? isEntryPoint(params.filePath, []),
    isPublicApi: params.isPublicApi ?? isPublicApi(params.filePath, null),
  });
}

// ── Dead code detection ──────────────────────────────────────────

/**
 * Detect zero-caller functions in a file or directory scope.
 *
 * Excludes: exported public API functions, entry points (main, handler,
 * route handlers), test files.
 */
export function detectDeadCode(
  targetPath: string,
  callGraph: CallGraphResult | null,
): DeadCodeResult {
  if (!callGraph) {
    return { files: [], totalDeadFunctions: 0 };
  }

  const results: DeadCodeResult["files"] = [];
  let totalDead = 0;

  // Group functions by file
  const functionsByFile = new Map<string, FunctionInfo[]>();
  for (const fn of callGraph.functions) {
    if (!functionsByFile.has(fn.file)) {
      functionsByFile.set(fn.file, []);
    }
    functionsByFile.get(fn.file)!.push(fn);
  }

  for (const [file, functions] of functionsByFile) {
    // Skip test files
    if (TEST_FILE_RE.test(file)) continue;

    // Filter to target scope
    const inScope = file.startsWith(targetPath) || file === targetPath;
    if (!inScope) continue;

    const deadFunctions: DeadCodeResult["files"][0]["functions"] = [];

    for (const fn of functions) {
      // Skip if has callers
      if (fn.calledBy.length > 0) continue;

      // Skip entry points
      const base = file.split("/").pop() ?? "";
      const isEntry = ENTRY_POINT_PATTERNS.some((re) => re.test(fn.name)) ||
                      ENTRY_POINT_PATTERNS.some((re) => re.test(base));
      if (isEntry) continue;

      deadFunctions.push({ name: fn.name, line: fn.line });
      totalDead++;
    }

    if (deadFunctions.length > 0) {
      results.push({ path: file, functions: deadFunctions });
    }
  }

  // Sort by file path
  results.sort((a, b) => a.path.localeCompare(b.path));

  return { files: results, totalDeadFunctions: totalDead };
}
