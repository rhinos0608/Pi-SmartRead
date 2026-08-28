/**
 * RepositoryIntelligenceService type surface.
 *
 * Frozen contract from ARCHITECTURE.md §3G. Branded types from §3D (lines 148-152).
 */

// ── Branded string types (ARCHITECTURE.md §3D, lines 148-152) ───────

export type SnapshotId = string & { readonly __brand: "SnapshotId" };
export type ArtifactRef = string & { readonly __brand: "ArtifactRef" };
export type ISO8601 = string & { readonly __brand: "ISO8601" };

// ── §3G: Ranking and delta types ────────────────────────────────────

export type RankRequest = {
  readonly __phasePlaceholder: "RankRequest";
  snapshotId: SnapshotId;
  /** Maximum entities to return (capped at 2,000). */
  maxEntities: number;
};

export type RankResult = {
  readonly __phasePlaceholder: "RankResult";
  snapshotId: SnapshotId;
  /** Ranked entity IDs in descending priority order. */
  rankedEntityIds: string[];
};

export type SemanticDelta = {
  readonly __phasePlaceholder: "SemanticDelta";
  snapshotId: SnapshotId;
  addedEntities: string[];
  removedEntities: string[];
  changedEntities: string[];
};

// ── §3G: Error union ─────────────────────────────────────────────────

export type IntelligenceError =
  | { code: "INVALID_ROOT"; message: string; retryable: false }
  | { code: "STALE_REVISION"; message: string; retryable: true; currentRevision: number }
  | { code: "UNSUPPORTED_CAPABILITY"; message: string; retryable: false; capability: string }
  | { code: "BUDGET_EXCEEDED"; message: string; retryable: true; partialRef?: ArtifactRef }
  | { code: "BUILD_UNSTABLE"; message: string; retryable: true; observedRevision: number }
  | { code: "INTERNAL"; message: string; retryable: boolean };

// ── §3G: CapabilityReport ────────────────────────────────────────────

export type CapabilityReport = {
  filesObserved: number;
  byLanguage: Array<{
    language: string;
    files: number;
    tags: "AVAILABLE" | "PARTIAL" | "UNAVAILABLE";
    structuralFacts: "AVAILABLE" | "PARTIAL" | "UNAVAILABLE";
    callGraph: "AVAILABLE" | "PARTIAL" | "UNAVAILABLE";
    lsp: "AVAILABLE" | "UNAVAILABLE";
    reasons: string[];
  }>;
  graphAssessment: "complete" | "partial" | "unavailable";
  coverageReasons: string[];
  omittedEdgeCount: number;
};

// ── §3G: SnapshotRef ─────────────────────────────────────────────────

export type SnapshotRef = {
  snapshotId: SnapshotId;
  parentSnapshotId?: SnapshotId;
  workspaceRootHash: string;
  sourceHash: string; // paths + content hashes
  graphRevision: number;
  createdAt: ISO8601;
  capabilityDigest: string;
};

// ── §3G: ImpactConeRef ───────────────────────────────────────────────

export type ImpactConeRef = ArtifactRef & { readonly __impactCone: unique symbol };

// ── §3G: ImpactCone ──────────────────────────────────────────────────

export type ImpactCone = {
  schemaVersion: 1;
  snapshotId: SnapshotId;
  seeds: string[]; // max 64
  direction: "CALLERS" | "CALLEES" | "BOTH";
  maxDepth: number; // 0..8
  entities: Array<{
    entityId: string;
    distance: number;
    evidenceRefs: ArtifactRef[];
  }>; // max 2,000
  assessment: "complete" | "partial" | "unavailable";
  truncated: boolean;
  coverageReasons: string[]; // max 64
};

// ── §3G: WorkspaceView ───────────────────────────────────────────────

export type WorkspaceView = {
  schemaVersion: 1;
  snapshotId: SnapshotId;
  format: "OUTLINE" | "EVIDENCE" | "DIFF";
  entities: Array<{
    entityId: string;
    path: string;
    startLine?: number;
    endLine?: number;
    renderedText: string;
    evidenceRefs: ArtifactRef[];
  }>;
  assessment: "complete" | "partial";
  omittedEntityCount: number;
  truncated: boolean;
  byteLength: number;
};

// ── §3G: RelationshipEvidencePage ────────────────────────────────────

export type RelationshipEvidencePage = {
  schemaVersion: 1;
  snapshotId: SnapshotId;
  edges: Array<{
    from: string;
    to: string;
    relationshipType: string;
    confidence: number;
    provenanceRefs: ArtifactRef[];
  }>; // max 500, stable order by relationshipType/from/to
  nextCursor?: string;
  assessment: "complete" | "partial";
};

// ── §3G: RepositoryIntelligenceService interface ─────────────────────

export interface RepositoryIntelligenceService {
  getWorkspaceSnapshot(input: {
    root: string;
    expectedGraphRevision?: number;
    includeDiagnostics: boolean;
    pin?: { owner: string; leaseId: string; expiresAt: ISO8601 };
    budget: { maxMs: number; maxBytes: number };
  }): Promise<{ snapshot: SnapshotRef; capabilities: CapabilityReport }>;

  compareSnapshots(input: {
    before: SnapshotId;
    after: SnapshotId;
    budget: { maxMs: number; maxEntities: number };
  }): Promise<SemanticDelta>;

  rankWorkspace(input: RankRequest): Promise<RankResult>;

  renderWorkspaceView(input: {
    snapshotId: SnapshotId;
    rankedEntityIds: string[];
    cone?: ImpactConeRef;
    format: "OUTLINE" | "EVIDENCE" | "DIFF";
    hardBudget: { maxBytes: number; maxLines: number };
  }): Promise<WorkspaceView>;

  getImpactCone(input: {
    snapshotId: SnapshotId;
    seeds: string[];
    direction: "CALLERS" | "CALLEES" | "BOTH";
    maxDepth: number;
    maxEntities: number;
  }): Promise<ImpactCone>;

  getRelationshipEvidence(input: {
    snapshotId: SnapshotId;
    from?: string;
    to?: string;
    relationshipTypes?: string[];
    limit: number;
    cursor?: string;
  }): Promise<RelationshipEvidencePage>;

  getCapabilities(input: { snapshotId: SnapshotId }): Promise<CapabilityReport>;
}
