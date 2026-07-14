// deep-search-graph.ts
// Context-graph traversal, EdgeStore queries, Graphify enricher

import { resolve, relative } from "node:path";
import { EdgeStore, findDirectImportNeighbours, isReadableWorkspaceFile } from "./context-graph.js";

import { RRF_K } from "./deep-search-constants.js";
import type { DeepSearchCandidate } from "./deep-search.js";

export const MAX_GRAPH_SEEDS = 10;
export const MAX_GRAPH_CANDIDATES = 30;
export const MAX_GRAPH_REVERSE_IMPORT_SCAN = 500;

// ── Helpers ─────────────────────────────────────────────────────────────────

function toRelativePath(cwd: string, path: string): string {
  const rel = relative(cwd, resolve(cwd, path));
  return rel && !rel.startsWith("..") ? rel.replace(/\\/g, "/") : path.replace(/\\/g, "/");
}

export function resolveWorkspaceFile(cwd: string, pathOrSymbol: string): string | undefined {
  const resolved = resolve(cwd, pathOrSymbol);
  if (isReadableWorkspaceFile(cwd, resolved)) return resolved;

  // graph_mutate accepts "file.ts:symbol" handles
  const normalized = pathOrSymbol.replace(/\\/g, "/");
  const colonIndex = normalized.lastIndexOf(":");
  const slashIndex = normalized.lastIndexOf("/");
  if (colonIndex > slashIndex) {
    const withoutSymbol = pathOrSymbol.slice(0, colonIndex);
    const resolvedWithoutSymbol = resolve(cwd, withoutSymbol);
    if (isReadableWorkspaceFile(cwd, resolvedWithoutSymbol)) return resolvedWithoutSymbol;
  }

  return undefined;
}

function sameResolvedFile(a: string, b: string, cwd = process.cwd()): boolean {
  return resolve(cwd, a) === resolve(cwd, b);
}

function toDisplayName(path: string): string {
  return path.split("/").pop() ?? path;
}

// ── Graph channel ───────────────────────────────────────────────────────────

function graphCandidate(
  cwd: string,
  file: string,
  kind: string,
  from: string,
  rawScore: number,
  rank: number,
): DeepSearchCandidate | undefined {
  const resolved = resolveWorkspaceFile(cwd, file);
  if (!resolved || sameResolvedFile(resolve(cwd, from), resolved)) return undefined;

  const rel = toRelativePath(cwd, resolved);
  const fromRel = toRelativePath(cwd, from);
  return {
    file: rel,
    kind,
    name: toDisplayName(rel),
    rawScore,
    rank,
    snippet: `${kind}: ${fromRel} → ${rel}`,
    channel: "graph",
  };
}

export function selectGraphSeedFiles(
  cwd: string,
  candidates: DeepSearchCandidate[],
  focusFiles: string[],
): string[] {
  const seeds = new Map<string, number>();
  for (const focusFile of focusFiles) {
    const resolved = resolveWorkspaceFile(cwd, focusFile);
    if (resolved) seeds.set(resolved, Number.POSITIVE_INFINITY);
  }

  for (const candidate of candidates) {
    const resolved = resolveWorkspaceFile(cwd, candidate.file);
    if (!resolved) continue;
    const score = candidate.rawScore + 1 / (RRF_K + candidate.rank);
    seeds.set(resolved, Math.max(seeds.get(resolved) ?? 0, score));
  }

  return [...seeds.entries()]
    .sort((a, b) => b[1] - a[1] || toRelativePath(cwd, a[0]).localeCompare(toRelativePath(cwd, b[0])))
    .slice(0, MAX_GRAPH_SEEDS)
    .map(([file]) => file);
}

function addGraphCandidate(
  candidates: DeepSearchCandidate[],
  seen: Set<string>,
  cwd: string,
  file: string,
  kind: string,
  from: string,
  rawScore: number,
  maxCandidates: number,
): void {
  if (candidates.length >= maxCandidates) return;
  const candidate = graphCandidate(cwd, file, kind, from, rawScore, candidates.length + 1);
  if (!candidate) return;
  const key = `${candidate.file}:${candidate.kind}:${toRelativePath(cwd, from)}`;
  if (seen.has(key)) return;
  seen.add(key);
  candidates.push(candidate);
}

/**
 * Run the graph channel for context-aware neighbour expansion.
 */
export async function runGraphChannel(
  cwd: string,
  seedFiles: string[],
  discoveredFiles: string[],
  maxCandidates: number,
  signal: AbortSignal | undefined,
): Promise<DeepSearchCandidate[]> {
  if (seedFiles.length === 0 || maxCandidates <= 0) return [];

  const candidates: DeepSearchCandidate[] = [];
  const seen = new Set<string>();
  const resolvedSeeds = seedFiles.map((file) => resolve(cwd, file));
  const seedSet = new Set(resolvedSeeds);

  for (const seedFile of resolvedSeeds) {
    if (signal?.aborted) throw new Error("Operation aborted");
    const importNeighbours = findDirectImportNeighbours(cwd, [seedFile], maxCandidates);
    for (const neighbour of importNeighbours) {
      addGraphCandidate(candidates, seen, cwd, neighbour, "imports", seedFile, 0.9, maxCandidates);
    }
  }

  // Reverse import adjacency
  for (const file of discoveredFiles.slice(0, MAX_GRAPH_REVERSE_IMPORT_SCAN)) {
    if (signal?.aborted) throw new Error("Operation aborted");
    if (candidates.length >= maxCandidates) break;
    const importer = resolve(cwd, file);
    const importedFiles = findDirectImportNeighbours(cwd, [importer], maxCandidates);
    for (const imported of importedFiles) {
      const importedResolved = resolve(cwd, imported);
      if (!seedSet.has(importedResolved)) continue;
      addGraphCandidate(candidates, seen, cwd, importer, "imported_by", importedResolved, 0.85, maxCandidates);
    }
  }

  // EdgeStore edges (breakage, co-change)
  for (const event of EdgeStore.readEdges(cwd)) {
    if (signal?.aborted) throw new Error("Operation aborted");
    if (candidates.length >= maxCandidates) break;
    const fromFile = resolveWorkspaceFile(cwd, event.data.from);
    const toFile = resolveWorkspaceFile(cwd, event.data.to);
    if (!fromFile || !toFile || !seedSet.has(fromFile)) continue;
    const confidence = event.data.confidence ?? (event.type === "breakage" ? 1.0 : 0.7);
    addGraphCandidate(candidates, seen, cwd, toFile, event.type, fromFile, confidence, maxCandidates);
  }

  return candidates;
}