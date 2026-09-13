import { describe, it, expectTypeOf } from "vitest";
import type {
  IntelligenceError,
  RepositoryIntelligenceService,
  RankRequest,
  RankResult,
  SemanticDelta,
  SnapshotId,
  ArtifactRef,
  ISO8601,
} from "../../../src/repository/repository-intelligence-types.js";

// Compile-time structural checks: these verify the types exist and have the
// expected shape. Runtime assertions are minimal — the point is that tsc
// accepts these without errors.

describe("repository-intelligence-types", () => {
  it("branded types are assignable from plain strings (nominal branding)", () => {
    const sid: SnapshotId = "abc" as SnapshotId;
    const aref: ArtifactRef = "def" as ArtifactRef;
    const iso: ISO8601 = "2025-01-01T00:00:00Z" as ISO8601;
    expectTypeOf(sid).toEqualTypeOf<SnapshotId>();
    expectTypeOf(aref).toEqualTypeOf<ArtifactRef>();
    expectTypeOf(iso).toEqualTypeOf<ISO8601>();
  });

  it("IntelligenceError discriminant unions typecheck", () => {
    const err: IntelligenceError = {
      code: "STALE_REVISION",
      message: "stale",
      retryable: true,
      currentRevision: 5,
    };
    expectTypeOf(err.code).toEqualTypeOf<"STALE_REVISION">();
  });

  it("RepositoryIntelligenceService has all 7 methods", () => {
    type Methods = keyof RepositoryIntelligenceService;
    expectTypeOf<Methods>().toEqualTypeOf<
      | "getWorkspaceSnapshot"
      | "compareSnapshots"
      | "rankWorkspace"
      | "renderWorkspaceView"
      | "getImpactCone"
      | "getRelationshipEvidence"
      | "getCapabilities"
    >();
  });

  it("RankRequest/RankResult carry no phase marker", () => {
    const req: RankRequest = { snapshotId: "x" as SnapshotId, maxEntities: 100 };
    const res: RankResult = {
      snapshotId: "x" as SnapshotId,
      rankedEntityIds: [],
      rankedScores: [],
      assessment: "complete",
    };
    expectTypeOf(req.snapshotId).toEqualTypeOf<SnapshotId>();
    expectTypeOf(res.rankedScores).toEqualTypeOf<number[]>();
    expectTypeOf(res.assessment).toEqualTypeOf<"complete" | "partial">();
  });

  it("SemanticDelta is the lineage-owned single truth", () => {
    const delta: SemanticDelta = {
      before: "a",
      after: "b",
      algorithmVersion: "lineage-v1",
      fileChanges: [],
      symbolChanges: [],
      relationshipChanges: [],
      diagnosticChanges: [],
      capabilityChange: {
        before: {
          filesObserved: 0,
          byLanguage: [],
          graphAssessment: "complete",
          coverageReasons: [],
          omittedEdgeCount: 0,
        },
        after: {
          filesObserved: 0,
          byLanguage: [],
          graphAssessment: "complete",
          coverageReasons: [],
          omittedEdgeCount: 0,
        },
        changedKeys: [],
      },
      assessment: "complete",
      coverageReasons: [],
      truncated: false,
    };
    expectTypeOf(delta.algorithmVersion).toEqualTypeOf<"lineage-v1">();
  });
});
