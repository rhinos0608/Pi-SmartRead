/**
 * Graph filter for grep results.
 *
 * Async functions that filter grep hits by graph relationship.
 * Parses "EDGE_TYPE->target" format and checks if each hit file
 * has the specified graph edge to the target.
 *
 * Used by WP-5 wiring in grep-tool.ts when graphFilter param is present.
 */

import type { ContextGraph, GraphNeighbour } from "./context-graph.js";

// ── Types ─────────────────────────────────────────────────────────

export interface GrepHit {
  file: string;
  relFile: string;
  line: number;
  endLine: number;
  name: string;
  kind: string;
  snippet: string;
  engines: string[];
  score: number;
}

/** Result of applyGraphFilter. */
export interface GraphFilterResult {
  hits: GrepHit[];
  notes: string[];
}

/** Valid edge types for graph filtering. */
export type FilterEdgeType =
  | "IMPORTS"
  | "IMPORTED_BY"
  | "CALLS"
  | "CALLED_BY"
  | "DEFINES"
  | "DEFINED_IN"
  | "REFERENCES"
  | "REFERENCED_BY"
  | "BREAKAGE"
  | "CO_CHANGE";

// ── Constants ─────────────────────────────────────────────────────

const EDGE_TYPE_MAP: Record<string, string> = {
  IMPORTS: "imports",
  IMPORTED_BY: "imported_by",
  CALLS: "calls",
  CALLED_BY: "called_by",
  DEFINES: "defines",
  DEFINED_IN: "defined_in",
  REFERENCES: "references",
  REFERENCED_BY: "referenced_by",
  BREAKAGE: "breakage",
  CO_CHANGE: "co_change",
};

/** Recognised source-file extensions — used to distinguish paths from symbols. */
const SOURCE_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".java", ".go", ".rs", ".rb", ".vue",
  ".svelte", ".css", ".scss", ".less", ".html", ".json",
]);

/** Inverse edge types (ones ending in _BY plus mutation edges). */
const INVERSE_EDGE_TYPES = new Set([
  "imported_by", "called_by", "defined_in", "referenced_by",
  "breakage", "co_change",
]);

// ── Helpers ───────────────────────────────────────────────────────

/**
 * Decide whether `target` looks like a file path vs a symbol name.
 * Paths contain "/" or end with a recognised source extension.
 * Symbols (e.g. "auth.login") are resolved via findSymbolFiles.
 */
export function isFilePath(target: string): boolean {
  if (target.includes("/")) return true;
  const dot = target.lastIndexOf(".");
  if (dot > 0) {
    const ext = target.slice(dot).toLowerCase();
    if (SOURCE_EXTS.has(ext)) return true;
  }
  return false;
}

// ── Filter parsing ────────────────────────────────────────────────

/**
 * Parse a graph filter string in "EDGE_TYPE->target" format.
 *
 * @param filter - Filter string, e.g. "CALLS->auth.login" or "IMPORTED_BY->src/core"
 * @returns Parsed edge type and target, or null if format is invalid.
 */
export function parseGraphFilter(
  filter: string,
): { edgeType: string; target: string } | null {
  if (!filter || typeof filter !== "string") return null;

  const separatorIndex = filter.indexOf("->");
  if (separatorIndex < 1) return null;

  const rawEdgeType = filter.slice(0, separatorIndex).trim().toUpperCase();
  const target = filter.slice(separatorIndex + 2).trim();

  if (!target) return null;

  const edgeType = EDGE_TYPE_MAP[rawEdgeType];
  if (!edgeType) return null;

  return { edgeType, target };
}

// ── Graph filtering ───────────────────────────────────────────────

/**
 * Filter grep hits by graph relationship.
 *
 * For each hit, checks if a graph edge exists from the hit file to the
 * target (or vice versa for inverse edge types).
 *
 * Throws if the filter string does not match the required format.
 *
 * @param hits - Array of grep hits to filter.
 * @param filter - Filter string in "EDGE_TYPE->target" format.
 * @param contextGraph - The context graph to query for edges.
 * @returns Filtered hits + diagnostic notes.
 */
export async function applyGraphFilter(
  hits: GrepHit[],
  filter: string,
  contextGraph: ContextGraph,
): Promise<GraphFilterResult> {
  const parsed = parseGraphFilter(filter);
  if (!parsed) {
    throw new Error('Invalid graphFilter: expected "EDGE_TYPE->target" format');
  }

  const { edgeType, target } = parsed;
  const isInverse = INVERSE_EDGE_TYPES.has(edgeType);
  const notes: string[] = [];

  // Resolve target to file paths
  const targetFiles = await resolveTargetFiles(contextGraph, target, edgeType, notes);

  if (targetFiles.length === 0) {
    // No target files to match against — return empty with notes.
    // (The symbol-resolve case already pushed a note.)
    return { hits: [], notes };
  }

  const filtered: GrepHit[] = [];

  for (const hit of hits) {
    for (const targetFile of targetFiles) {
      let hasEdge = false;

      if (isInverse) {
        // Inverse: targetFile should have edge TO hit.file
        hasEdge = await checkFileEdge(contextGraph, targetFile, hit.file, edgeType, notes);
      } else {
        // Forward: hit.file should have edge TO targetFile
        hasEdge = await checkFileEdge(contextGraph, hit.file, targetFile, edgeType, notes);
      }

      if (hasEdge) {
        filtered.push(hit);
        break;
      }
    }
  }

  return { hits: filtered, notes };
}

// ── Target resolution ──────────────────────────────────────────────

/**
 * Resolve a filter target to one or more file paths.
 * Returns `[target]` (as-is) for path-like targets.
 * Uses findSymbolFiles for symbol targets.
 */
async function resolveTargetFiles(
  graph: ContextGraph,
  target: string,
  _edgeType: string,
  notes: string[],
): Promise<string[]> {
  if (isFilePath(target)) {
    return [target];
  }

  // Symbol target
  try {
    const resolved: GraphNeighbour[] = await graph.findSymbolFiles(target);
    const paths = resolved.map((n) => n.path);
    if (paths.length === 0) {
      notes.push(`graphFilter: symbol "${target}" not found in workspace`);
    }
    return paths;
  } catch {
    notes.push(`graphFilter: could not resolve symbol "${target}"`);
    return [];
  }
}

// ── Edge checking helpers ─────────────────────────────────────────

/**
 * Check if `fromFile` has an edge of the given type to `toFile`.
 *
 * Supports:
 *   imports / imported_by  — via getFileNeighbours
 *   calls  / called_by     — via getFileNeighbours({ includeCalls: true })
 *   breakage / co_change   — via getMutationNeighbours
 */
async function checkFileEdge(
  graph: ContextGraph,
  fromFile: string,
  toFile: string,
  edgeType: string,
  notes: string[],
): Promise<boolean> {
  switch (edgeType) {
    case "imports": {
      const neighbours = await graph.getFileNeighbours(fromFile);
      return neighbours.some(
        (n) => n.provenance.type === "imports" && isPathMatch(n.path, toFile),
      );
    }
    case "imported_by": {
      // imported_by: A imported_by B  ⇔  B imports A
      // Check if toFile imports fromFile
      const neighbours = await graph.getFileNeighbours(toFile);
      return neighbours.some(
        (n) => n.provenance.type === "imports" && isPathMatch(n.path, fromFile),
      );
    }
    case "calls": {
      const neighbours = await graph.getFileNeighbours(fromFile, { includeCalls: true });
      return neighbours.some(
        (n) => n.provenance.type === "calls" && isPathMatch(n.path, toFile),
      );
    }
    case "called_by": {
      // called_by: A called_by B  ⇔  B calls A
      // Check if toFile calls fromFile
      const neighbours = await graph.getFileNeighbours(toFile, { includeCalls: true });
      return neighbours.some(
        (n) => n.provenance.type === "calls" && isPathMatch(n.path, fromFile),
      );
    }
    case "defines":
      // defines edge: fromFile defines target (symbol → file). With a file-level
      // target we check if fromFile has any symbol that resolves to toFile.
      // This is a best-effort check using getFileNeighbours with includeSymbols.
      try {
        const neighbours = await graph.getFileNeighbours(fromFile, { includeSymbols: true });
        return neighbours.some(
          (n) => n.provenance.type === "defines" && isPathMatch(n.path, toFile),
        );
      } catch {
        notes.push("graphFilter: defines edge requires symbol-enabled context graph");
        return false;
      }
    case "defined_in": {
      // defined_in: A defined_in B ⇔ B defines A. Check if toFile defines fromFile.
      try {
        const neighbours = await graph.getFileNeighbours(toFile, { includeSymbols: true });
        return neighbours.some(
          (n) => n.provenance.type === "defines" && isPathMatch(n.path, fromFile),
        );
      } catch {
        notes.push("graphFilter: defined_in edge requires symbol-enabled context graph");
        return false;
      }
    }
    case "references":
      try {
        const neighbours = await graph.getFileNeighbours(fromFile, { includeSymbols: true });
        return neighbours.some(
          (n) => n.provenance.type === "references" && isPathMatch(n.path, toFile),
        );
      } catch {
        notes.push("graphFilter: references edge requires symbol-enabled context graph");
        return false;
      }
    case "referenced_by": {
      try {
        const neighbours = await graph.getFileNeighbours(toFile, { includeSymbols: true });
        return neighbours.some(
          (n) => n.provenance.type === "references" && isPathMatch(n.path, fromFile),
        );
      } catch {
        notes.push("graphFilter: referenced_by edge requires symbol-enabled context graph");
        return false;
      }
    }
    case "breakage":
    case "co_change": {
      const neighbours = graph.getMutationNeighbours(fromFile);
      return neighbours.some((n) => isPathMatch(n.path, toFile));
    }
    default:
      notes.push(`graphFilter: edge type "${edgeType}" not supported`);
      return false;
  }
}

// ── Path matching ─────────────────────────────────────────────────

/**
 * Loose path matching: match by suffix or relative path.
 * Handles absolute vs relative path comparison.
 */
function isPathMatch(a: string, b: string): boolean {
  if (a === b) return true;
  // Check if one is a suffix of the other
  const aNorm = a.replace(/\\/g, "/");
  const bNorm = b.replace(/\\/g, "/");
  if (aNorm.endsWith(bNorm) || bNorm.endsWith(aNorm)) return true;
  // Check relative matching
  const aParts = aNorm.split("/").filter(Boolean);
  const bParts = bNorm.split("/").filter(Boolean);
  if (aParts.length > 0 && bParts.length > 0) {
    const aTail = aParts.slice(-Math.min(3, aParts.length)).join("/");
    const bTail = bParts.slice(-Math.min(3, bParts.length)).join("/");
    return aTail === bTail;
  }
  return false;
}
