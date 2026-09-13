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
import { type ContextGraph, type GraphNeighbour } from "../context-graph.js";
import type { CallGraphResult, FunctionInfo } from "../structural/callgraph.js";

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

function isCriticalSignal(params: {
  pageRank: number;
  fanIn: number;
  blastRadiusDepth: number;
  isEntryPoint: boolean;
}): boolean {
  return (
    params.pageRank > PR_CRITICAL ||
    params.fanIn > FANIN_CRITICAL ||
    (params.isEntryPoint && params.blastRadiusDepth >= ENTRY_BLAST_CRITICAL_DEPTH)
  );
}

function isHighSignal(params: { pageRank: number; fanIn: number; isPublicApi: boolean }): boolean {
  return params.pageRank > PR_HIGH || params.fanIn > FANIN_HIGH || params.isPublicApi;
}

function isMediumSignal(params: { fanIn: number; blastRadiusDepth: number }): boolean {
  return params.fanIn > FANIN_MEDIUM || params.blastRadiusDepth >= ENTRY_BLAST_HIGH_DEPTH;
}

function classifyRisk(params: {
  pageRank: number;
  fanIn: number;
  blastRadiusDepth: number;
  isEntryPoint: boolean;
  isPublicApi: boolean;
}): RiskLevel {
  if (isCriticalSignal(params)) return "critical";
  if (isHighSignal(params)) return "high";
  if (isMediumSignal(params)) return "medium";
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
interface CoverageInfo {
  assessment: ImpactResult["assessment"];
  coverageReasons: string[];
  omittedEdgeCount: number;
}

function buildCoverage(callGraph: CallGraphResult | undefined): CoverageInfo {
  if (!callGraph) return { assessment: "unavailable", coverageReasons: ["call graph unavailable"], omittedEdgeCount: 0 };
  const skipped = readSkippedFileCount(callGraph);
  const omitted = countEdgeDiagnostics(callGraph);
  if (!callGraph.diagnostics) return { assessment: "partial", coverageReasons: [], omittedEdgeCount: omitted };
  if (omitted === 0 && skipped === 0) return { assessment: "complete", coverageReasons: [], omittedEdgeCount: 0 };
  return { assessment: "partial", coverageReasons: buildPartialReasons(omitted, skipped), omittedEdgeCount: omitted };
}

function readSkippedFileCount(callGraph: CallGraphResult | undefined): number {
  return ((callGraph?.diagnostics as unknown as Record<string, unknown>)?.skippedFileCount as number) || 0;
}

function countEdgeDiagnostics(callGraph: CallGraphResult | undefined): number {
  if (!callGraph?.diagnostics) return 0;
  return callGraph.diagnostics.unresolved + callGraph.diagnostics.ambiguous + callGraph.diagnostics.receiverUnknown;
}

function buildPartialReasons(omitted: number, skipped: number): string[] {
  const reasons: string[] = [];
  if (omitted > 0) reasons.push("call graph contains omitted or unresolved edges");
  if (skipped > 0) reasons.push(`${skipped} file(s) skipped due to unsupported language(s)`);
  return reasons;
}

function collectDirectEdges(fns: FunctionInfo[]): { callers: Set<string>; callees: Set<string> } {
  const callers = new Set<string>();
  const callees = new Set<string>();
  for (const fn of fns) {
    for (const caller of fn.calledBy) callers.add(caller);
    for (const callee of fn.calls) callees.add(callee);
  }
  return { callers, callees };
}

function expandTransitiveSet(seeds: Set<string>, byName: Map<string, FunctionInfo>, dir: "callers" | "callees"): Set<string> {
  const seen = new Set<string>(seeds);
  const queue = [...seeds];
  let cursor = 0;
  while (cursor < queue.length) {
    const name = queue[cursor++]!;
    const fn = byName.get(name);
    if (!fn) continue;
    const next = dir === "callers" ? fn.calledBy : fn.calls;
    for (const n of next) {
      if (!seen.has(n)) {
        seen.add(n);
        queue.push(n);
      }
    }
  }
  return seen;
}

function buildCallGraphSummary(
  callGraph: CallGraphResult | undefined,
  normalizedTarget: string,
  normalizePath: (p: string) => string,
): ImpactResult["callGraphSummary"] {
  const summary: ImpactResult["callGraphSummary"] = {
    directCallers: 0,
    transitiveCallers: 0,
    directCallees: 0,
    transitiveCallees: 0,
  };
  if (!callGraph) return summary;
  const targetFns = callGraph.functions.filter((f) => normalizePath(f.file) === normalizedTarget);
  const { callers, callees } = collectDirectEdges(targetFns);
  summary.directCallers = callers.size;
  summary.directCallees = callees.size;
  const byName = new Map(callGraph.functions.map((f) => [f.name, f]));
  summary.transitiveCallers = expandTransitiveSet(callers, byName, "callers").size;
  summary.transitiveCallees = expandTransitiveSet(callees, byName, "callees").size;
  return summary;
}

function rankAffectedFiles(files: ImpactResult["affectedFiles"]): void {
  files.sort((a, b) => RISK_ORDER[a.risk] - RISK_ORDER[b.risk] || b.fanIn - a.fanIn);
}

function pickFinalRisk(
  assessment: ImpactResult["assessment"],
  targetRisk: RiskLevel,
  affectedFiles: ImpactResult["affectedFiles"],
): RiskLevel | undefined {
  let finalRisk: RiskLevel | undefined = assessment === "complete" ? targetRisk : undefined;
  for (const af of affectedFiles) {
    if (finalRisk && RISK_ORDER[af.risk] < RISK_ORDER[finalRisk]) finalRisk = af.risk;
  }
  return finalRisk;
}

interface TargetSignals {
  fanIn: number;
  fns: FunctionInfo[];
  isEntryPoint: boolean;
  isPublicApi: boolean;
  pageRank: number;
}

function readTargetSignals(
  normalizedTarget: string,
  targetFile: string,
  callGraph: CallGraphResult | undefined,
  pageRankScores: Map<string, number> | undefined,
  normalizePath: (p: string) => string,
  workspaceRoot?: string,
): TargetSignals {
  const fanIn = computeFanIn(normalizedTarget, callGraph ?? null, workspaceRoot);
  const fns = callGraph?.functions.filter((f) => normalizePath(f.file) === normalizedTarget) ?? [];
  return {
    fanIn,
    fns,
    isEntryPoint: isEntryPoint(normalizedTarget, fns),
    isPublicApi: isPublicApi(normalizedTarget, callGraph ?? null, workspaceRoot),
    pageRank: pageRankScores?.get(normalizedTarget) ?? pageRankScores?.get(targetFile) ?? 0,
  };
}

function collectAffectedEntry(
  path: string,
  depth: number,
  ctx: {
    callGraph: CallGraphResult | undefined;
    pageRankScores: Map<string, number> | undefined;
    workspaceRoot?: string;
    normalizePath: (p: string) => string;
    symbols: Set<string>;
  },
): ImpactResult["affectedFiles"][0] {
  const normalizedPath = ctx.normalizePath(path);
  const fanIn = computeFanIn(normalizedPath, ctx.callGraph ?? null, ctx.workspaceRoot);
  const fileFns = ctx.callGraph?.functions.filter((f) => ctx.normalizePath(f.file) === normalizedPath) ?? [];
  const risk = classifyRisk({
    pageRank: ctx.pageRankScores?.get(normalizedPath) ?? ctx.pageRankScores?.get(path) ?? 0,
    fanIn,
    blastRadiusDepth: depth,
    isEntryPoint: isEntryPoint(path, fileFns),
    isPublicApi: isPublicApi(path, ctx.callGraph ?? null, ctx.workspaceRoot),
  });
  collectFileSymbols(ctx.callGraph, ctx.normalizePath, normalizedPath, ctx.symbols);
  return { path, risk, fanIn, depth };
}

function collectFileSymbols(
  callGraph: CallGraphResult | undefined,
  normalizePath: (p: string) => string,
  normalizedPath: string,
  symbols: Set<string>,
): void {
  if (!callGraph) return;
  for (const fn of callGraph.functions) {
    if (normalizePath(fn.file) === normalizedPath) symbols.add(fn.name);
  }
}

export async function computeImpact(params: ImpactParams): Promise<ImpactResult> {
  const { targetFile, maxDepth = 3, pageRankScores, contextGraph, workspaceRoot } = params;
  const normalizedTarget = workspaceRoot ? resolve(workspaceRoot, targetFile) : resolve(targetFile);
  const normalizePath = (p: string): string => (workspaceRoot ? resolve(workspaceRoot, p) : resolve(p));
  const visited = await buildVisitedSet(targetFile, normalizedTarget, contextGraph, maxDepth, workspaceRoot ?? "");
  const { callGraph } = params;
  const { assessment, coverageReasons, omittedEdgeCount } = buildCoverage(callGraph);
  const signals = readTargetSignals(normalizedTarget, targetFile, callGraph, pageRankScores, normalizePath, workspaceRoot);
  const callGraphSummary = buildCallGraphSummary(callGraph, normalizedTarget, normalizePath);
  const { affectedFiles, affectedSymbols, maxDepthReached } = collectAffectedFiles(
    visited,
    normalizedTarget,
    { callGraph, pageRankScores, workspaceRoot, normalizePath },
  );
  rankAffectedFiles(affectedFiles);
  const targetRisk = classifyRisk({
    pageRank: signals.pageRank,
    fanIn: signals.fanIn,
    blastRadiusDepth: maxDepthReached,
    isEntryPoint: signals.isEntryPoint,
    isPublicApi: signals.isPublicApi,
  });
  const finalRisk = pickFinalRisk(assessment, targetRisk, affectedFiles);
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

async function buildVisitedSet(
  targetFile: string,
  normalizedTarget: string,
  contextGraph: ContextGraph | undefined,
  maxDepth: number,
  workspaceRoot: string,
): Promise<Map<string, { depth: number }>> {
  const visited = new Map<string, { depth: number }>();
  visited.set(normalizedTarget, { depth: 0 });
  if (!contextGraph) return visited;
  const bfsResult = await expandBlastRadius(targetFile, contextGraph, maxDepth, workspaceRoot);
  for (const [path, { depth }] of bfsResult) visited.set(path, { depth });
  return visited;
}

function collectAffectedFiles(
  visited: Map<string, { depth: number }>,
  normalizedTarget: string,
  ctx: {
    callGraph: CallGraphResult | undefined;
    pageRankScores: Map<string, number> | undefined;
    workspaceRoot?: string;
    normalizePath: (p: string) => string;
  },
): { affectedFiles: ImpactResult["affectedFiles"]; affectedSymbols: Set<string>; maxDepthReached: number } {
  const affectedFiles: ImpactResult["affectedFiles"] = [];
  const affectedSymbols = new Set<string>();
  let maxDepthReached = 0;
  for (const [path, { depth }] of visited) {
    if (ctx.normalizePath(path) === normalizedTarget) continue;
    affectedFiles.push(collectAffectedEntry(path, depth, { ...ctx, symbols: affectedSymbols }));
    if (depth > maxDepthReached) maxDepthReached = depth;
  }
  return { affectedFiles, affectedSymbols, maxDepthReached };
}

/**
 * Build a reverse import index from the context graph's provenance edges.
 * Maps resolved(to) → resolved(from)[] for files that import a given target.
 * Best-effort: relies on getProvenanceEdges() availability on ContextGraph.
 */
function buildReverseImportIndex(graph: ContextGraph, workspaceRoot: string): Map<string, string[]> {
  const index = new Map<string, string[]>();
  const edges = graph.getProvenanceEdges();
  const resolveEdge = (p: string): string => (workspaceRoot ? resolve(workspaceRoot, p) : resolve(p));
  for (const { from, to } of edges) {
    const key = resolveEdge(to);
    const list = index.get(key);
    if (list) list.push(resolveEdge(from));
    else index.set(key, [resolveEdge(from)]);
  }
  return index;
}

function groupFunctionsByFile(callGraph: CallGraphResult): Map<string, FunctionInfo[]> {
  const byFile = new Map<string, FunctionInfo[]>();
  for (const fn of callGraph.functions) {
    const list = byFile.get(fn.file);
    if (list) list.push(fn);
    else byFile.set(fn.file, [fn]);
  }
  return byFile;
}

function isEntryFunction(fnName: string, file: string): boolean {
  const base = file.split("/").pop() ?? "";
  return ENTRY_POINT_PATTERNS.some((re) => re.test(fnName)) || ENTRY_POINT_PATTERNS.some((re) => re.test(base));
}

function collectDeadInFile(file: string, functions: FunctionInfo[]): DeadCodeResult["files"][0]["functions"] {
  const dead: DeadCodeResult["files"][0]["functions"] = [];
  for (const fn of functions) {
    if (fn.calledBy.length > 0) continue;
    if (isEntryFunction(fn.name, file)) continue;
    dead.push({ name: fn.name, line: fn.line });
  }
  return dead;
}

function isInScope(file: string, targetPath: string): boolean {
  return file.startsWith(targetPath) || file === targetPath;
}

/**
 * BFS expansion helper — given a ContextGraph and starting file, returns
 * the full blast-radius set up to maxDepth.
 *
 * This is the graph-aware version used by inspect.ts which has access to
 * the ContextGraph instance.
 */
type BlastRadiusMap = Map<string, { depth: number; edgeType: string }>;
type BlastQueue = Array<{ path: string; depth: number }>;

async function fetchForwardNeighbours(
  contextGraph: ContextGraph,
  path: string,
): Promise<GraphNeighbour[]> {
  try {
    return await contextGraph.getFileNeighbours(path, { includeSymbols: true, includeCalls: true });
  } catch {
    return [];
  }
}

function fetchReverseImports(
  contextGraph: ContextGraph,
  workspaceRoot: string,
  path: string,
  cache: { index: Map<string, string[]> | null },
): string[] {
  try {
    if (cache.index === null) cache.index = buildReverseImportIndex(contextGraph, workspaceRoot);
    const resolvePath = (p: string): string => (workspaceRoot ? resolve(workspaceRoot, p) : resolve(p));
    return cache.index?.get(resolvePath(path)) ?? [];
  } catch {
    return [];
  }
}

function toImportedByNeighbours(paths: string[], currentPath: string): GraphNeighbour[] {
  return paths.map((p): GraphNeighbour => ({
    path: p,
    provenance: { from: p, to: currentPath, type: "imported_by", confidence: 1.0 },
  }));
}

function offerNeighbour(
  visited: BlastRadiusMap,
  queue: BlastQueue,
  neighbour: GraphNeighbour,
  nextDepth: number,
): void {
  const known = visited.get(neighbour.path);
  if (known && known.depth <= nextDepth) return;
  visited.set(neighbour.path, { depth: nextDepth, edgeType: neighbour.provenance.type });
  queue.push({ path: neighbour.path, depth: nextDepth });
}

function offerNeighbours(visited: BlastRadiusMap, queue: BlastQueue, neighbours: GraphNeighbour[], nextDepth: number): void {
  for (const n of neighbours) offerNeighbour(visited, queue, n, nextDepth);
}

function fetchMutationNeighbours(contextGraph: ContextGraph, path: string): GraphNeighbour[] {
  try {
    return contextGraph.getMutationNeighbours(path);
  } catch {
    return [];
  }
}

async function expandOneNode(
  contextGraph: ContextGraph,
  workspaceRoot: string,
  visited: BlastRadiusMap,
  queue: BlastQueue,
  current: { path: string; depth: number },
  cache: { index: Map<string, string[]> | null },
): Promise<void> {
  const nextDepth = current.depth + 1;
  const forward = await fetchForwardNeighbours(contextGraph, current.path);
  const reverse = fetchReverseImports(contextGraph, workspaceRoot, current.path, cache).filter(
    (p) => !visited.has(p) || (visited.get(p)?.depth ?? Infinity) > nextDepth,
  );
  offerNeighbours(visited, queue, [...forward, ...toImportedByNeighbours(reverse, current.path)], nextDepth);
  offerNeighbours(visited, queue, fetchMutationNeighbours(contextGraph, current.path), nextDepth);
}

export async function expandBlastRadius(
  targetFile: string,
  contextGraph: ContextGraph,
  maxDepth: number,
  workspaceRoot: string,
): Promise<Map<string, { depth: number; edgeType: string }>> {
  const visited: BlastRadiusMap = new Map();
  const queue: BlastQueue = [{ path: targetFile, depth: 0 }];
  visited.set(targetFile, { depth: 0, edgeType: "self" });
  const cache: { index: Map<string, string[]> | null } = { index: null };
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= maxDepth) continue;
    await expandOneNode(contextGraph, workspaceRoot, visited, queue, current, cache);
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
  if (!callGraph) return { files: [], totalDeadFunctions: 0 };
  const results: DeadCodeResult["files"] = [];
  let totalDead = 0;
  const functionsByFile = groupFunctionsByFile(callGraph);
  for (const [file, functions] of functionsByFile) {
    if (TEST_FILE_RE.test(file)) continue;
    if (!isInScope(file, targetPath)) continue;
    const deadFunctions = collectDeadInFile(file, functions);
    if (deadFunctions.length === 0) continue;
    totalDead += deadFunctions.length;
    results.push({ path: file, functions: deadFunctions });
  }
  results.sort((a, b) => a.path.localeCompare(b.path));
  return { files: results, totalDeadFunctions: totalDead };
}
