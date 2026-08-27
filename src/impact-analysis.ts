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

import { resolve } from "node:path";
import { type ContextGraph, type GraphNeighbour } from "./context-graph.js";
import type { CallGraphResult, FunctionInfo } from "./callgraph.js";

// ── Types ─────────────────────────────────────────────────────────

export type RiskLevel = "critical" | "high" | "medium" | "low";

export interface ImpactResult {
  /** Target file path that was analyzed. */
  target: string;
  /** Highest risk level across all affected files; absent when evidence is incomplete. */
  risk?: RiskLevel;
  assessment: "complete" | "partial" | "unavailable";
  coverageReasons: string[];
  omittedEdgeCount: number;
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
  /** Optional pre-built call graph for fan-in / public-API / callGraphSummary computation. */
  callGraph?: CallGraphResult;
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
const ENTRY_POINT_PATTERNS = [/^main$/i];
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

function computeFanIn(targetFile: string, callGraph: CallGraphResult | null, workspaceRoot?: string): number {
  if (!callGraph) return 0;
  const normalizedTarget = workspaceRoot ? resolve(workspaceRoot, targetFile) : resolve(targetFile);
  let count = 0;
  for (const fn of callGraph.functions) {
    const normalizedFnFile = workspaceRoot ? resolve(workspaceRoot, fn.file) : resolve(fn.file);
    if (normalizedFnFile === normalizedTarget) {
      count += fn.calledBy.length;
    }
  }
  return count;
}

function isEntryPoint(_filePath: string, functions: FunctionInfo[]): boolean {
  return functions.some((fn) => ENTRY_POINT_PATTERNS.some((re) => re.test(fn.name)));
}

function isPublicApi(filePath: string, callGraph: CallGraphResult | null, workspaceRoot?: string): boolean {
  if (!callGraph) return false;
  const normalized = workspaceRoot ? resolve(workspaceRoot, filePath) : resolve(filePath);
  const fns = callGraph.functions.filter((f) => {
    const nf = workspaceRoot ? resolve(workspaceRoot, f.file) : resolve(f.file);
    return nf === normalized;
  });
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
    workspaceRoot,
  } = params;

  // Normalize target path to absolute for consistent call-graph lookups.
  const normalizedTarget = workspaceRoot ? resolve(workspaceRoot, targetFile) : resolve(targetFile);

  // Helper: normalize any path (call-graph fn.file or graph edge path) against workspaceRoot.
  const normalizePath = (p: string): string => workspaceRoot ? resolve(workspaceRoot, p) : resolve(p);

  // BFS state
  const visited = new Map<string, { depth: number }>(); // path → depth
  visited.set(normalizedTarget, { depth: 0 });

  // When ContextGraph is available, perform real BFS traversal
  if (contextGraph) {
    const bfsResult = await expandBlastRadius(targetFile, contextGraph, maxDepth, workspaceRoot ?? "");
    for (const [path, { depth }] of bfsResult) {
      visited.set(path, { depth });
    }
  }

  const affectedFiles: ImpactResult["affectedFiles"] = [];
  const affectedSymbols: Set<string> = new Set();

  const { callGraph } = params;
  // ponytail: forward-compat bridge — reads skippedFileCount if present on diagnostics.
  // Will become typed once callgraph.ts populates this field (cross-boundary: P1-W4).
  const skippedFileCount = ((callGraph?.diagnostics as unknown as Record<string, unknown>)?.skippedFileCount as number) || 0;
  const edgeDiagnosticCount = callGraph?.diagnostics ? callGraph.diagnostics.unresolved + callGraph.diagnostics.ambiguous + callGraph.diagnostics.receiverUnknown : 0;
  const hasIncompleteCoverage = edgeDiagnosticCount > 0 || skippedFileCount > 0;
  const assessment: ImpactResult["assessment"] = !callGraph ? "unavailable" : callGraph.diagnostics ? (hasIncompleteCoverage ? "partial" : "complete") : "partial";
  const coverageReasons: string[] = !callGraph
    ? ["call graph unavailable"]
    : assessment === "partial"
      ? [
          ...(edgeDiagnosticCount > 0 ? ["call graph contains omitted or unresolved edges"] : []),
          ...(skippedFileCount > 0 ? [`${skippedFileCount} file(s) skipped due to unsupported language(s)`] : []),
        ]
      : [];
  const omittedEdgeCount = edgeDiagnosticCount;
  const targetFanIn = computeFanIn(normalizedTarget, callGraph ?? null, workspaceRoot);
  const targetFns = callGraph?.functions.filter((f) => normalizePath(f.file) === normalizedTarget) ?? [];
  const targetIsEntryPoint = isEntryPoint(normalizedTarget, targetFns);
  const targetIsPublicApi = isPublicApi(normalizedTarget, callGraph ?? null, workspaceRoot);
  const targetPageRank = pageRankScores?.get(normalizedTarget) ?? pageRankScores?.get(targetFile) ?? 0;

  // Pre-compute call graph summary for the target file.
  const callGraphSummary: ImpactResult["callGraphSummary"] = {
    directCallers: 0,
    transitiveCallers: 0,
    directCallees: 0,
    transitiveCallees: 0,
  };
  if (callGraph) {
    const graphTargetFns = callGraph.functions.filter((f) => normalizePath(f.file) === normalizedTarget);
    const directCallerSet = new Set<string>();
    const directCalleeSet = new Set<string>();
    for (const fn of graphTargetFns) {
      for (const caller of fn.calledBy) directCallerSet.add(caller);
      for (const callee of fn.calls) directCalleeSet.add(callee);
    }
    callGraphSummary.directCallers = directCallerSet.size;
    callGraphSummary.directCallees = directCalleeSet.size;
    // Transitive: BFS through call graph from direct callers/callees.
    const transCallerSet = new Set<string>(directCallerSet);
    const transCalleeSet = new Set<string>(directCalleeSet);
    const callerQueue = [...directCallerSet];
    const calleeQueue = [...directCalleeSet];
    while (callerQueue.length > 0) {
      const name = callerQueue.shift()!;
      const fn = callGraph.functions.find((f) => f.name === name);
      if (!fn) continue;
      for (const caller of fn.calledBy) {
        if (!transCallerSet.has(caller)) {
          transCallerSet.add(caller);
          callerQueue.push(caller);
        }
      }
    }
    while (calleeQueue.length > 0) {
      const name = calleeQueue.shift()!;
      const fn = callGraph.functions.find((f) => f.name === name);
      if (!fn) continue;
      for (const callee of fn.calls) {
        if (!transCalleeSet.has(callee)) {
          transCalleeSet.add(callee);
          calleeQueue.push(callee);
        }
      }
    }
    callGraphSummary.transitiveCallers = transCallerSet.size;
    callGraphSummary.transitiveCallees = transCalleeSet.size;
  }

  let maxDepthReached = 0;

  for (const [path, { depth }] of visited) {
    const normalizedPath = normalizePath(path);
    if (normalizedPath === normalizedTarget) continue;
    const fanIn = computeFanIn(normalizedPath, callGraph ?? null, workspaceRoot);
    const risk = classifyRisk({
      pageRank: pageRankScores?.get(normalizedPath) ?? pageRankScores?.get(path) ?? 0,
      fanIn,
      blastRadiusDepth: depth,
      isEntryPoint: isEntryPoint(path, callGraph?.functions.filter((f) => normalizePath(f.file) === normalizePath(path)) ?? []),
      isPublicApi: isPublicApi(path, callGraph ?? null, workspaceRoot),
    });
    affectedFiles.push({ path, risk, fanIn, depth });
    if (depth > maxDepthReached) maxDepthReached = depth;
    // Collect affected symbols from call graph for this file.
    if (callGraph) {
      const normalizedPath2 = normalizePath(path);
      for (const fn of callGraph.functions) {
        if (normalizePath(fn.file) === normalizedPath2) affectedSymbols.add(fn.name);
      }
    }
  }

  affectedFiles.sort((a, b) => {
    const riskDiff = RISK_ORDER[a.risk] - RISK_ORDER[b.risk];
    if (riskDiff !== 0) return riskDiff;
    return b.fanIn - a.fanIn;
  });

  // Reclassify target risk with actual blast-radius depth reached.
  const targetRisk = classifyRisk({
    pageRank: targetPageRank,
    fanIn: targetFanIn,
    blastRadiusDepth: maxDepthReached,
    isEntryPoint: targetIsEntryPoint,
    isPublicApi: targetIsPublicApi,
  });

  // Final risk: highest severity across target and all affected files.
  let finalRisk: RiskLevel | undefined = assessment === "complete" ? targetRisk : undefined;
  for (const af of affectedFiles) {
    if (finalRisk && RISK_ORDER[af.risk] < RISK_ORDER[finalRisk]) {
      finalRisk = af.risk;
    }
  }

  return {
    target: targetFile,
    ...(finalRisk ? { risk: finalRisk } : {}),
    assessment,
    coverageReasons,
    omittedEdgeCount,
    affectedFiles,
    affectedSymbols: [...affectedSymbols],
    blastRadiusDepth: maxDepthReached,
    callGraphSummary,
  };
}

/**
 * Build a reverse import index from the context graph's provenance edges.
 * Maps resolved(to) → resolved(from)[] for files that import a given target.
 * Best-effort: relies on getProvenanceEdges() availability on ContextGraph.
 */
function buildReverseImportIndex(graph: ContextGraph, workspaceRoot: string): Map<string, string[]> {
  const index = new Map<string, string[]>();
  const edges = graph.getProvenanceEdges();
  const _resolve = (p: string) => workspaceRoot ? resolve(workspaceRoot, p) : resolve(p);
  for (const { from, to } of edges) {
    const key = _resolve(to);
    let list = index.get(key);
    if (!list) {
      list = [];
      index.set(key, list);
    }
    list.push(_resolve(from));
  }
  return index;
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
  workspaceRoot: string,
): Promise<Map<string, { depth: number; edgeType: string }>> {
  const visited = new Map<string, { depth: number; edgeType: string }>();
  const queue: Array<{ path: string; depth: number }> = [{ path: targetFile, depth: 0 }];
  visited.set(targetFile, { depth: 0, edgeType: "self" });

  // Lazy-built reverse-import index: resolved(to) → resolved(from)[]
  // Captures files that import a given file (imported_by edges).
  let reverseImportIndex: Map<string, string[]> | null = null;
  const _resolve = (p: string) => workspaceRoot ? resolve(workspaceRoot, p) : resolve(p);

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= maxDepth) continue;

    const nextDepth = current.depth + 1;

    // Forward neighbours (imports/calls/references) via the context graph.
    let forwardNeighbours: GraphNeighbour[] = [];
    try {
      forwardNeighbours = await contextGraph.getFileNeighbours(current.path, {
        includeSymbols: true,
        includeCalls: true,
      });
    } catch {
      // getFileNeighbours may fail for unreadable files — skip
    }

    // Reverse-import neighbours (files that import this file).
    // Best-effort: built lazily from getProvenanceEdges() on first use.
    let reverseImports: string[] = [];
    try {
      if (reverseImportIndex === null) {
        reverseImportIndex = buildReverseImportIndex(contextGraph, workspaceRoot);
      }
      reverseImports = reverseImportIndex.get(_resolve(current.path)) ?? [];
    } catch {
      // getProvenanceEdges may fail — skip reverse imports
    }

    // Combine forward and reverse neighbours
    const allNeighbours: GraphNeighbour[] = [
      ...forwardNeighbours,
      ...reverseImports
        .filter((p) => !visited.has(p) || (visited.get(p)?.depth ?? Infinity) > nextDepth)
        .map((p): GraphNeighbour => ({
          path: p,
          provenance: { from: p, to: current.path, type: "imported_by", confidence: 1.0 },
        })),
    ];

    for (const neighbour of allNeighbours) {
      if (!visited.has(neighbour.path)) {
        visited.set(neighbour.path, {
          depth: nextDepth,
          edgeType: neighbour.provenance.type,
        });
        queue.push({ path: neighbour.path, depth: nextDepth });
      } else if ((visited.get(neighbour.path)?.depth ?? Infinity) > nextDepth) {
        visited.set(neighbour.path, {
          depth: nextDepth,
          edgeType: neighbour.provenance.type,
        });
        queue.push({ path: neighbour.path, depth: nextDepth });
      }
    }

    // Expand via mutation edges (breakage, co-change)
    try {
      const mutationNeighbours = contextGraph.getMutationNeighbours(current.path);
      for (const neighbour of mutationNeighbours) {
        if (!visited.has(neighbour.path)) {
          visited.set(neighbour.path, {
            depth: nextDepth,
            edgeType: neighbour.provenance.type,
          });
          queue.push({ path: neighbour.path, depth: nextDepth });
        } else if ((visited.get(neighbour.path)?.depth ?? Infinity) > nextDepth) {
          visited.set(neighbour.path, {
            depth: nextDepth,
            edgeType: neighbour.provenance.type,
          });
          queue.push({ path: neighbour.path, depth: nextDepth });
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
