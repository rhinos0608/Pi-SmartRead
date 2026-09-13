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
} from "../../src/repository-intelligence-types.js";

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

  it("RankRequest/RankResult/SemanticDelta are structurally valid placeholders", () => {
    const req: RankRequest = { __phasePlaceholder: "RankRequest", snapshotId: "x" as SnapshotId, maxEntities: 100 };
    const res: RankResult = { __phasePlaceholder: "RankResult", snapshotId: "x" as SnapshotId, rankedEntityIds: [] };
    const delta: SemanticDelta = {
      __phasePlaceholder: "SemanticDelta",
      snapshotId: "x" as SnapshotId,
      addedEntities: [],
      removedEntities: [],
      changedEntities: [],
    };
    expectTypeOf(req.__phasePlaceholder).toEqualTypeOf<"RankRequest">();
    expectTypeOf(res.__phasePlaceholder).toEqualTypeOf<"RankResult">();
    expectTypeOf(delta.__phasePlaceholder).toEqualTypeOf<"SemanticDelta">();
  });
});
