/**
 * Relationship-change detection between two provenance-edge snapshots.
 *
 * Translates before-edges using file-level lineage (moved/renamed files)
 * before computing the diff. Each change carries the lineage confidence
 * of the underlying file match, or "verified" if the file was unchanged.
 *
 * §3P — ARCHITECTURE.md, P2-W5.
 */

import type { Provenance, EdgeType } from "./context-graph.js";

// ── Types (§3P ARCHITECTURE.md) ──────────────────────────────────

export type MatchConfidenceClass = "verified" | "high" | "medium" | "low";

export type MatchConfidence = {
  value: number; // 0..1
  class: MatchConfidenceClass;
  algorithmVersion: "lineage-v1";
  signals: string[];
  ambiguities: string[];
};

export type RelationshipChange = {
  kind: "ADDED" | "REMOVED" | "MODIFIED";
  relationshipType: string;
  before?: { from: string; to: string; confidence: number };
  after?: { from: string; to: string; confidence: number };
  confidence: MatchConfidence;
};

/** File-level lineage result produced by lineage-v1 (P2-W3). */
export interface FileLineageResult {
  /** Move/rename mappings: before-path → after-path with match confidence. */
  moves: Array<{
    beforePath: string;
    afterPath: string;
    confidence: MatchConfidence;
  }>;
}

// ── Helpers ──────────────────────────────────────────────────────

const VERIFIED: MatchConfidence = {
  value: 1.0,
  class: "verified",
  algorithmVersion: "lineage-v1",
  signals: [],
  ambiguities: [],
};

/** Stable string key for edge comparison: (from, to, type). */
function edgeKey(from: string, to: string, type: EdgeType): string {
  return `${from}\0${to}\0${type}`;
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Compute relationship changes between two provenance-edge snapshots.
 *
 * Before-edges are path-translated using `fileLineage` so that
 * moved/renamed files are compared against their after-snapshot paths.
 * Edge comparison uses the (translated-from, to, type) triple.
 */
export function computeRelationshipChanges(
  beforeEdges: Provenance[],
  afterEdges: Provenance[],
  fileLineage: FileLineageResult,
): RelationshipChange[] {
  // Build forward map: beforePath → { afterPath, confidence }
  const forwardMap = new Map<
    string,
    { afterPath: string; confidence: MatchConfidence }
  >();
  for (const m of fileLineage.moves) {
    forwardMap.set(m.beforePath, {
      afterPath: m.afterPath,
      confidence: m.confidence,
    });
  }

  // Build reverse map: afterPath → confidence (for ADDED edges on moved targets)
  const reverseConfidence = new Map<string, MatchConfidence>();
  for (const m of fileLineage.moves) {
    reverseConfidence.set(m.afterPath, m.confidence);
  }

  // Resolve confidence: forward map (before→after) then reverse (after←before)
  function confidenceFor(path: string): MatchConfidence {
    return (
      forwardMap.get(path)?.confidence ??
      reverseConfidence.get(path) ??
      VERIFIED
    );
  }

  // Translate before-edges and index both sets by (from, to, type)
  type TranslatedEdge = {
    originalFrom: string;
    translatedFrom: string;
    to: string;
    type: EdgeType;
    confidence: number;
  };

  const beforeMap = new Map<string, TranslatedEdge>();
  for (const e of beforeEdges) {
    const tx = forwardMap.get(e.from);
    const translatedFrom = tx?.afterPath ?? e.from;
    const key = edgeKey(translatedFrom, e.to, e.type);
    beforeMap.set(key, {
      originalFrom: e.from,
      translatedFrom,
      to: e.to,
      type: e.type,
      confidence: e.confidence,
    });
  }

  const afterMap = new Map<string, Provenance>();
  for (const e of afterEdges) {
    afterMap.set(edgeKey(e.from, e.to, e.type), e);
  }

  const changes: RelationshipChange[] = [];

  // 1. Before edges not in after → REMOVED
  for (const [key, be] of beforeMap) {
    if (!afterMap.has(key)) {
      changes.push({
        kind: "REMOVED",
        relationshipType: be.type,
        before: {
          from: be.originalFrom,
          to: be.to,
          confidence: be.confidence,
        },
        confidence: confidenceFor(be.originalFrom),
      });
    }
  }

  // 2. After edges not in before (translated) → ADDED
  for (const [key, ae] of afterMap) {
    if (!beforeMap.has(key)) {
      changes.push({
        kind: "ADDED",
        relationshipType: ae.type,
        after: {
          from: ae.from,
          to: ae.to,
          confidence: ae.confidence,
        },
        confidence: confidenceFor(ae.from),
      });
    }
  }

  // 3. Edges in both with different confidence → MODIFIED
  for (const [key, be] of beforeMap) {
    const ae = afterMap.get(key);
    if (ae && ae.confidence !== be.confidence) {
      changes.push({
        kind: "MODIFIED",
        relationshipType: be.type,
        before: {
          from: be.originalFrom,
          to: be.to,
          confidence: be.confidence,
        },
        after: {
          from: ae.from,
          to: ae.to,
          confidence: ae.confidence,
        },
        confidence: confidenceFor(be.originalFrom),
      });
    }
  }

  return changes;
}
