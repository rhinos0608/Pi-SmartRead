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

/** A target file resolved from the filter target, optionally carrying provenance type from findSymbolFiles. */
interface ResolvedTarget {
  path: string;
  /** Provenance type from findSymbolFiles ("defines" or "references"), absent for file targets. */
  provenanceType?: string;
}

/** Edge types where symbol provenance type should be used directly instead of re-querying neighbours. */
const SYMBOL_EDGE_TYPES = new Set(["defines", "references", "defined_in", "referenced_by"]);

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

  // Resolve target to file paths (with optional provenance type for symbol targets)
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

      // When target resolved via findSymbolFiles with provenance type,
      // use direct provenance matching for symbol edge types.
      // This avoids re-querying getFileNeighbours which gives wrong semantics.
      if (targetFile.provenanceType && SYMBOL_EDGE_TYPES.has(edgeType)) {
        hasEdge = checkSymbolProvenance(hit.file, targetFile.path, targetFile.provenanceType, edgeType);
      } else if (isInverse) {
        // Inverse: targetFile should have edge TO hit.file
        hasEdge = await checkFileEdge(contextGraph, targetFile.path, hit.file, edgeType, notes);
      } else {
        // Forward: hit.file should have edge TO targetFile
        hasEdge = await checkFileEdge(contextGraph, hit.file, targetFile.path, edgeType, notes);
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
): Promise<ResolvedTarget[]> {
  if (isFilePath(target)) {
    return [{ path: target }];
  }

  // Symbol target — preserve provenance type from findSymbolFiles
  try {
    const resolved: GraphNeighbour[] = await graph.findSymbolFiles(target);
    if (resolved.length === 0) {
      notes.push(`graphFilter: symbol "${target}" not found in workspace`);
    }
    const pairSeen = new Set<string>();
    return resolved.reduce<ResolvedTarget[]>((acc, n) => {
      const key = `${n.path}::${n.provenance.type}`;
      if (!pairSeen.has(key)) {
        pairSeen.add(key);
        acc.push({ path: n.path, provenanceType: n.provenance.type });
      }
      return acc;
    }, []);
  } catch {
    notes.push(`graphFilter: could not resolve symbol "${target}"`);
    return [];
  }
}

// ── Edge checking helpers ─────────────────────────────────────────

/**
 * Directly match a hit file against a symbol-resolved target using provenance type.
 *
 * When findSymbolFiles resolves a symbol, it returns files with provenance type
 * indicating whether the file defines or references the symbol. For symbol edge
 * types (defines/references/defined_in/referenced_by), we match directly against
 * this provenance info instead of re-querying getFileNeighbours.
 */
function checkSymbolProvenance(
  hitFile: string,
  resolvedFile: string,
  provenanceType: string,
  edgeType: string,
): boolean {
  switch (edgeType) {
    case "defines":
      // hit file defines the symbol → hit file must be the file with "defines" provenance
      return provenanceType === "defines" && isPathMatch(hitFile, resolvedFile);
    case "defined_in":
      // hit file is defined_in the symbol → inverse of defines, same directionality for symbol targets
      return provenanceType === "defines" && isPathMatch(hitFile, resolvedFile);
    case "references":
      // hit file references the symbol → hit file must be the file with "references" provenance
      return provenanceType === "references" && isPathMatch(hitFile, resolvedFile);
    case "referenced_by":
      // hit file is referenced_by the symbol → inverse of references, same directionality for symbol targets
      return provenanceType === "references" && isPathMatch(hitFile, resolvedFile);
    default:
      return false;
  }
}

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
 * Path matching with segment-boundary-aware suffix comparison.
 * Handles absolute vs relative path comparison without false-positives
 * on non-boundary substrings (e.g. "src_auth.ts" should NOT match "src/auth.ts").
 */
function isPathMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const aNorm = a.replace(/\\/g, "/");
  const bNorm = b.replace(/\\/g, "/");

  // Segment-boundary-aware suffix match:
  // the shorter path must match at a "/" boundary (or be the full path).
  if (aNorm.endsWith(bNorm)) {
    const prefixLen = aNorm.length - bNorm.length;
    if (prefixLen === 0 || aNorm[prefixLen - 1] === "/") return true;
  }
  if (bNorm.endsWith(aNorm)) {
    const prefixLen = bNorm.length - aNorm.length;
    if (prefixLen === 0 || bNorm[prefixLen - 1] === "/") return true;
  }

  return false;
}
