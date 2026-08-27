/**
 * Semantic delta integration — merges file, symbol, relationship,
 * diagnostic, and capability lineages into a single diff report.
 *
 * @module semantic-delta
 */

import { computeFileLineage, type FileChange } from "./lineage-files.js";
import {
  computeSymbolLineage,
  type SymbolTag,
  type SymbolLineageResult,
  type MatchConfidence as SymbolMatchConfidence,
} from "./lineage-symbols.js";
import {
  computeRelationshipChanges,
  type RelationshipChange,
  type MatchConfidenceClass,
} from "./delta-relationships.js";
import {
  computeDiagnosticChanges,
  computeCapabilityChange,
  type Diagnostic,
  type DiagnosticChange,
  type CapabilityChange,
} from "./delta-diagnostics.js";
import type { Provenance } from "./context-graph.js";
import type { CapabilityReport } from "./repository-intelligence-types.js";

// ── Types ─────────────────────────────────────────────────────────

/** All inputs needed beyond the file arrays. */
export type SemanticDeltaOptions = {
  readonly beforeSnapshotId?: string;
  readonly afterSnapshotId?: string;
  readonly beforeSymbols?: readonly SymbolTag[];
  readonly afterSymbols?: readonly SymbolTag[];
  readonly beforeEdges?: Provenance[];
  readonly afterEdges?: Provenance[];
  readonly beforeDiags?: Diagnostic[];
  readonly afterDiags?: Diagnostic[];
  readonly beforeCapabilities?: CapabilityReport;
  readonly afterCapabilities?: CapabilityReport;
};

export type SemanticDelta = {
  readonly before: string;
  readonly after: string;
  readonly algorithmVersion: "lineage-v1";
  readonly fileChanges: readonly FileChange[];
  readonly symbolChanges: readonly SymbolLineageResult[];
  readonly relationshipChanges: readonly RelationshipChange[];
  readonly diagnosticChanges: readonly DiagnosticChange[];
  readonly capabilityChange: CapabilityChange;
  readonly assessment: "complete" | "partial" | "unavailable";
  readonly coverageReasons: readonly string[];
  readonly truncated: boolean;
};

// ── Helpers ───────────────────────────────────────────────────────

/** Best file-match confidence as a symbol-level confidence string. */
function bestFileConfidence(
  changes: readonly FileChange[],
): SymbolMatchConfidence {
  const rank: Record<string, number> = {
    verified: 4,
    high: 3,
    medium: 2,
    POSSIBLE_MATCH: 1,
    added: 0,
    removed: 0,
  };
  let best = 0;
  let bestKey: SymbolMatchConfidence = "POSSIBLE_MATCH";
  for (const c of changes) {
    const r = rank[c.confidence] ?? 0;
    if (r > best) {
      best = r;
      bestKey = c.confidence as SymbolMatchConfidence;
    }
  }
  return bestKey;
}

/** Build the pathMap expected by delta-diagnostics' FileLineageResult. */
function buildPathMap(
  changes: readonly FileChange[],
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const c of changes) {
    if (c.beforePath && c.afterPath) {
      map[c.beforePath] = c.afterPath;
    }
  }
  return map;
}

/** Build the moves array expected by delta-relationships' FileLineageResult. */
function buildMoves(
  changes: readonly FileChange[],
): Array<{
  beforePath: string;
  afterPath: string;
  confidence: { value: number; class: MatchConfidenceClass; algorithmVersion: "lineage-v1"; signals: string[]; ambiguities: string[] };
}> {
  const moves: Array<{
    beforePath: string;
    afterPath: string;
    confidence: { value: number; class: MatchConfidenceClass; algorithmVersion: "lineage-v1"; signals: string[]; ambiguities: string[] };
  }> = [];
  for (const c of changes) {
    if (
      c.beforePath &&
      c.afterPath &&
      (c.kind === "MOVED" || c.kind === "MOVED_AND_MODIFIED" || c.kind === "RENAMED")
    ) {
      const confClass: MatchConfidenceClass =
        c.confidence === "verified"
          ? "verified"
          : c.confidence === "high"
            ? "high"
            : c.confidence === "medium"
              ? "medium"
              : "low";
      moves.push({
        beforePath: c.beforePath,
        afterPath: c.afterPath,
        confidence: {
          value: c.score ?? 1.0,
          class: confClass,
          algorithmVersion: "lineage-v1",
          signals: [],
          ambiguities: [],
        },
      });
    }
  }
  return moves;
}

// ── Public API ────────────────────────────────────────────────────

/**
 * Compute a full semantic delta between two file snapshots.
 *
 * Assembles file lineage, symbol lineage (for medium+ matched files),
 * relationship changes, diagnostic changes, and capability changes
 * into a single SemanticDelta report.
 */
export function computeSemanticDelta(
  beforeFiles: Array<{
    path: string;
    contentHash: string;
    edges?: Array<{ to: string; type: string }>;
  }>,
  afterFiles: Array<{
    path: string;
    contentHash: string;
    edges?: Array<{ to: string; type: string }>;
  }>,
  options?: SemanticDeltaOptions,
): SemanticDelta {
  const beforeSnap = options?.beforeSnapshotId ?? "";
  const afterSnap = options?.afterSnapshotId ?? "";

  // 1. File lineage
  const fileLineage = computeFileLineage(beforeFiles, afterFiles);

  // 2. Symbol lineage — only when file confidence >= medium
  const fileConf = bestFileConfidence(fileLineage.changes);
  const symConfRank: Record<string, number> = {
    verified: 4,
    high: 3,
    medium: 2,
    POSSIBLE_MATCH: 1,
    added: 0,
    removed: 0,
  };
  const hasMediumPlus = (symConfRank[fileConf] ?? 0) >= 2;

  let symbolResults: readonly SymbolLineageResult[] = [];
  const coverageReasons: string[] = [];

  if (
    hasMediumPlus &&
    options?.beforeSymbols &&
    options?.afterSymbols
  ) {
    const symOutput = computeSymbolLineage(
      options.beforeSymbols,
      options.afterSymbols,
      fileConf,
    );
    symbolResults = symOutput.results;
    if (symOutput.results.some((r) => r.partial)) {
      coverageReasons.push("symbol-lineage-partial");
    }
  } else if (!hasMediumPlus && beforeFiles.length > 0 && afterFiles.length > 0) {
    // Only flag when files exist on both sides but none matched at medium+
    coverageReasons.push("no-medium-confidence-file-matches");
  }

  // 3. Relationship changes
  const relChanges = computeRelationshipChanges(
    options?.beforeEdges ?? [],
    options?.afterEdges ?? [],
    { moves: buildMoves(fileLineage.changes) },
  );

  // 4. Diagnostic changes
  const diagChanges = computeDiagnosticChanges(
    options?.beforeDiags ?? [],
    options?.afterDiags ?? [],
    { pathMap: buildPathMap(fileLineage.changes) },
  );

  // 5. Capability change
  const capChange = computeCapabilityChange(
    options?.beforeCapabilities ?? {
      filesObserved: 0,
      byLanguage: [],
      graphAssessment: "complete",
      coverageReasons: [],
      omittedEdgeCount: 0,
    },
    options?.afterCapabilities ?? {
      filesObserved: 0,
      byLanguage: [],
      graphAssessment: "complete",
      coverageReasons: [],
      omittedEdgeCount: 0,
    },
  );

  // 6. Assessment
  let assessment: "complete" | "partial" | "unavailable" = "complete";
  if (coverageReasons.length > 0) {
    assessment = "partial";
  }

  return {
    before: beforeSnap,
    after: afterSnap,
    algorithmVersion: "lineage-v1",
    fileChanges: fileLineage.changes,
    symbolChanges: symbolResults,
    relationshipChanges: relChanges,
    diagnosticChanges: diagChanges,
    capabilityChange: capChange,
    assessment,
    coverageReasons,
    truncated: false,
  };
}
