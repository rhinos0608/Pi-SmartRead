import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createRepositoryIntelligenceService,
  IntelligenceServiceNotImplementedError,
} from "../../src/repository-intelligence.js";
import type {
  RepositoryIntelligenceService,
  SnapshotId,
} from "../../src/repository-intelligence-types.js";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("RepositoryIntelligenceService", () => {
  let svc: RepositoryIntelligenceService;
  let tmpDir: string;

  const makeFile = (name: string, content: string) => {
    const fname = join(tmpDir, name);
    const dir = fname.substring(0, fname.lastIndexOf("/"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(fname, content, "utf-8");
    return fname;
  };

  beforeEach(() => {
    svc = createRepositoryIntelligenceService();
    tmpDir = mkdtempSync(join(tmpdir(), "ri-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Stub methods: must throw, never return fake data ──────────

  describe("compareSnapshots (missing snapshot)", () => {
    it("throws IntelligenceServiceNotImplementedError", async () => {
      await expect(
        svc.compareSnapshots({
          before: "aaa" as SnapshotId,
          after: "bbb" as SnapshotId,
          budget: { maxMs: 1000, maxEntities: 100 },
        }),
      ).rejects.toThrow(IntelligenceServiceNotImplementedError);
    });

    it("error has code INTERNAL and retryable true", async () => {
      try {
        await svc.compareSnapshots({
          before: "aaa" as SnapshotId,
          after: "bbb" as SnapshotId,
          budget: { maxMs: 1000, maxEntities: 100 },
        });
        expect.fail("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(IntelligenceServiceNotImplementedError);
        const err = e as IntelligenceServiceNotImplementedError;
        expect(err.code).toBe("INTERNAL");
        expect(err.retryable).toBe(true);
        expect(err.message).toContain("snapshot not found");
      }
    });
  });

  describe("compareSnapshots (correctness)", () => {
    it("detects changed, added, and removed files between snapshots", async () => {
      // Initial workspace: two files
      makeFile("src/a.ts", "export const a = 1;");
      makeFile("src/b.ts", "export const b = 2;");

      const snap1 = await svc.getWorkspaceSnapshot({
        root: tmpDir,
        includeDiagnostics: false,
        budget: { maxMs: 30_000, maxBytes: 1_000_000 },
      });

      // Mutate: modify a.ts, add c.ts, remove b.ts
      writeFileSync(join(tmpDir, "src/a.ts"), "export const a = 999;", "utf-8");
      makeFile("src/c.ts", "export const c = 3;");
      unlinkSync(join(tmpDir, "src/b.ts"));

      const snap2 = await svc.getWorkspaceSnapshot({
        root: tmpDir,
        includeDiagnostics: false,
        budget: { maxMs: 30_000, maxBytes: 1_000_000 },
      });

      const delta = await svc.compareSnapshots({
        before: snap1.snapshot.snapshotId,
        after: snap2.snapshot.snapshotId,
        budget: { maxMs: 30_000, maxEntities: 2000 },
      });

      expect(delta.changedEntities).toContain("src/a.ts");
      expect(delta.addedEntities).toContain("src/c.ts");
      expect(delta.removedEntities).toContain("src/b.ts");
    });

    it("caps added and removed arrays to maxEntities budget", async () => {
      // snapshot1: one file
      makeFile("src/keep.ts", "export const keep = 1;");

      const snap1 = await svc.getWorkspaceSnapshot({
        root: tmpDir,
        includeDiagnostics: false,
        budget: { maxMs: 30_000, maxBytes: 1_000_000 },
      });

      // snapshot2: keep.ts + 5 new files, remove nothing
      makeFile("src/new1.ts", "export const n1 = 1;");
      makeFile("src/new2.ts", "export const n2 = 2;");
      makeFile("src/new3.ts", "export const n3 = 3;");
      makeFile("src/new4.ts", "export const n4 = 4;");
      makeFile("src/new5.ts", "export const n5 = 5;");

      const snap2 = await svc.getWorkspaceSnapshot({
        root: tmpDir,
        includeDiagnostics: false,
        budget: { maxMs: 30_000, maxBytes: 1_000_000 },
      });

      const delta = await svc.compareSnapshots({
        before: snap1.snapshot.snapshotId,
        after: snap2.snapshot.snapshotId,
        budget: { maxMs: 30_000, maxEntities: 2 },
      });

      // All three arrays should be bounded by maxEntities=2
      expect(delta.addedEntities.length).toBeLessThanOrEqual(2);
      expect(delta.removedEntities.length).toBeLessThanOrEqual(2);
      expect(delta.changedEntities.length).toBeLessThanOrEqual(2);
    });
  });

  describe("rankWorkspace (missing snapshot)", () => {
    it("throws IntelligenceServiceNotImplementedError", async () => {
      await expect(
        svc.rankWorkspace({
          __phasePlaceholder: "RankRequest" as const,
          snapshotId: "aaa" as SnapshotId,
          maxEntities: 100,
        }),
      ).rejects.toThrow(IntelligenceServiceNotImplementedError);
    });

    it("error has code INTERNAL and retryable true", async () => {
      try {
        await svc.rankWorkspace({
          __phasePlaceholder: "RankRequest" as const,
          snapshotId: "aaa" as SnapshotId,
          maxEntities: 100,
        });
        expect.fail("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(IntelligenceServiceNotImplementedError);
        const err = e as IntelligenceServiceNotImplementedError;
        expect(err.code).toBe("INTERNAL");
        expect(err.retryable).toBe(true);
        expect(err.message).toContain("snapshot not found");
      }
    });
  });

  describe("rankWorkspace (happy path)", () => {
    it("ranks files and returns snapshot-consistent results", async () => {
      makeFile("src/a.ts", "import './b';\nimport './c';\nexport const a = 1;");
      makeFile("src/b.ts", "import './c';\nexport const b = 1;");
      makeFile("src/c.ts", "export const c = 1;");

      const snap = await svc.getWorkspaceSnapshot({
        root: tmpDir,
        includeDiagnostics: false,
        budget: { maxMs: 30_000, maxBytes: 1_000_000 },
      });

      const result = await svc.rankWorkspace({
        __phasePlaceholder: "RankRequest" as const,
        snapshotId: snap.snapshot.snapshotId,
        maxEntities: 100,
      });

      expect(result.snapshotId).toBe(snap.snapshot.snapshotId);
      expect(result.rankedEntityIds.length).toBeGreaterThanOrEqual(3);
      // All three files should be present in the ranking
      expect(result.rankedEntityIds).toContain("src/a.ts");
      expect(result.rankedEntityIds).toContain("src/b.ts");
      expect(result.rankedEntityIds).toContain("src/c.ts");
    });

    it("returns snapshot-time file list, not live workspace state", async () => {
      makeFile("src/a.ts", "export const a = 1;");
      makeFile("src/b.ts", "export const b = 2;");

      const snap = await svc.getWorkspaceSnapshot({
        root: tmpDir,
        includeDiagnostics: false,
        budget: { maxMs: 30_000, maxBytes: 1_000_000 },
      });

      // Mutate workspace AFTER snapshot
      makeFile("src/new.ts", "export const n = 1;");
      unlinkSync(join(tmpDir, "src/b.ts"));

      const result = await svc.rankWorkspace({
        __phasePlaceholder: "RankRequest" as const,
        snapshotId: snap.snapshot.snapshotId,
        maxEntities: 100,
      });

      // Should contain files from snapshot time only
      expect(result.rankedEntityIds).toContain("src/a.ts");
      expect(result.rankedEntityIds).toContain("src/b.ts");
      expect(result.rankedEntityIds).not.toContain("src/new.ts");
    });
  });

  // ── Capability report ─────────────────────────────────────────

  describe("getWorkspaceSnapshot + capabilities", () => {
    it("returns snapshot and capability report for a TypeScript workspace", async () => {
      makeFile("src/index.ts", "export const x = 1;");
      makeFile("src/util.ts", "export function util() {}");

      const result = await svc.getWorkspaceSnapshot({
        root: tmpDir,
        includeDiagnostics: false,
        budget: { maxMs: 30_000, maxBytes: 1_000_000 },
      });

      expect(result.snapshot.snapshotId).toBeTruthy();
      expect(result.snapshot.sourceHash).toBeTruthy();
      expect(result.snapshot.graphRevision).toBeGreaterThanOrEqual(0);
      expect(result.snapshot.createdAt).toBeTruthy();
      expect(result.snapshot.capabilityDigest).toBeTruthy();

      expect(result.capabilities.filesObserved).toBeGreaterThanOrEqual(2);
      const tsLang = result.capabilities.byLanguage.find(
        (l) => l.language === "typescript",
      );
      expect(tsLang).toBeDefined();
      expect(tsLang!.files).toBeGreaterThanOrEqual(2);
      expect(tsLang!.tags).toBe("AVAILABLE");
      expect(tsLang!.structuralFacts).toBe("AVAILABLE");
      expect(tsLang!.callGraph).toBe("AVAILABLE");
      expect(tsLang!.lsp).toBe("UNAVAILABLE");
    });

    it("reports genuinely-unsupported-language case (scala: no tags, no call graph)", async () => {
      makeFile("src/index.ts", "export const x = 1;");
      // .scala IS in SupportedLanguage so findSrcFiles discovers it,
      // but is NOT in TAG_LANGUAGES or CALLGRAPH_LANGUAGES.
      makeFile("src/App.scala", 'object App { def main(args: Array[String]): Unit = println("hi") }');

      const result = await svc.getWorkspaceSnapshot({
        root: tmpDir,
        includeDiagnostics: false,
        budget: { maxMs: 30_000, maxBytes: 1_000_000 },
      });

      // scala should appear as a language with no tag/callgraph support
      const scalaLang = result.capabilities.byLanguage.find(
        (l) => l.language === "scala",
      );
      expect(scalaLang).toBeDefined();
      expect(scalaLang!.files).toBeGreaterThanOrEqual(1);
      expect(scalaLang!.tags).toBe("UNAVAILABLE");
      expect(scalaLang!.structuralFacts).toBe("UNAVAILABLE");
      expect(scalaLang!.callGraph).toBe("UNAVAILABLE");
      expect(scalaLang!.reasons.length).toBeGreaterThan(0);

      // Coverage reasons should mention scala as having no call graph
      expect(
        result.capabilities.coverageReasons.some((r) =>
          r.includes("scala"),
        ),
      ).toBe(true);
    });

    it("reports empty workspace honestly", async () => {
      const result = await svc.getWorkspaceSnapshot({
        root: tmpDir,
        includeDiagnostics: false,
        budget: { maxMs: 30_000, maxBytes: 1_000_000 },
      });

      expect(result.capabilities.filesObserved).toBe(0);
      expect(result.capabilities.graphAssessment).toBe("unavailable");
      expect(
        result.capabilities.coverageReasons.some((r) =>
          r.includes("no source files"),
        ),
      ).toBe(true);
    });
  });

  describe("getCapabilities", () => {
    it("returns same capability report after snapshot", async () => {
      makeFile("src/main.ts", "export const main = 1;");

      const snap = await svc.getWorkspaceSnapshot({
        root: tmpDir,
        includeDiagnostics: false,
        budget: { maxMs: 30_000, maxBytes: 1_000_000 },
      });

      const caps = await svc.getCapabilities({
        snapshotId: snap.snapshot.snapshotId,
      });

      expect(caps.filesObserved).toBe(snap.capabilities.filesObserved);
      expect(caps.byLanguage.length).toBe(snap.capabilities.byLanguage.length);
    });

    it("returns snapshot-time capabilities, not live workspace state", async () => {
      makeFile("src/main.ts", "export const main = 1;");
      makeFile("src/other.ts", "export const other = 2;");

      const snap = await svc.getWorkspaceSnapshot({
        root: tmpDir,
        includeDiagnostics: false,
        budget: { maxMs: 30_000, maxBytes: 1_000_000 },
      });

      const originalFilesObserved = snap.capabilities.filesObserved;

      // Mutate workspace AFTER snapshot
      makeFile("src/newfile.ts", "export const n = 1;");

      const caps = await svc.getCapabilities({
        snapshotId: snap.snapshot.snapshotId,
      });

      // Capabilities should reflect snapshot-time file count, not the new live state
      expect(caps.filesObserved).toBe(originalFilesObserved);
    });

    it("returns unavailable for unknown snapshotId", async () => {
      const caps = await svc.getCapabilities({
        snapshotId: "nonexistent" as SnapshotId,
      });
      expect(caps.graphAssessment).toBe("unavailable");
      expect(
        caps.coverageReasons.some((r) => r.includes("snapshot not found")),
      ).toBe(true);
    });
  });

  // ── renderWorkspaceView budget enforcement ─────────────────────

  describe("renderWorkspaceView", () => {
    it("truncates entities when byte budget exceeded", async () => {
      const entityIds = Array.from({ length: 100 }, (_, i) => `entity-${i}`);
      const result = await svc.renderWorkspaceView({
        snapshotId: "snap" as SnapshotId,
        rankedEntityIds: entityIds,
        format: "OUTLINE",
        hardBudget: { maxBytes: 200, maxLines: 1000 },
      });

      expect(result.truncated).toBe(true);
      expect(result.omittedEntityCount).toBeGreaterThan(0);
      expect(result.entities.length).toBeLessThan(100);
      expect(result.assessment).toBe("partial");
      // Verify byte budget is actually respected
      expect(result.byteLength).toBeLessThanOrEqual(200);
    });

    it("truncates entities when line budget exceeded", async () => {
      const entityIds = Array.from({ length: 50 }, (_, i) => `entity-${i}`);
      const result = await svc.renderWorkspaceView({
        snapshotId: "snap" as SnapshotId,
        rankedEntityIds: entityIds,
        format: "OUTLINE",
        hardBudget: { maxBytes: 100_000, maxLines: 5 },
      });

      expect(result.truncated).toBe(true);
      expect(result.omittedEntityCount).toBe(45);
      expect(result.entities.length).toBe(5);
    });

    it("returns complete assessment when all entities fit", async () => {
      const entityIds = ["a.ts", "b.ts"];
      const result = await svc.renderWorkspaceView({
        snapshotId: "snap" as SnapshotId,
        rankedEntityIds: entityIds,
        format: "OUTLINE",
        hardBudget: { maxBytes: 100_000, maxLines: 1000 },
      });

      expect(result.truncated).toBe(false);
      expect(result.omittedEntityCount).toBe(0);
      expect(result.entities.length).toBe(2);
      expect(result.assessment).toBe("complete");
    });

    it("respects EVIDENCE format rendering", async () => {
      const result = await svc.renderWorkspaceView({
        snapshotId: "snap" as SnapshotId,
        rankedEntityIds: ["src/main.ts"],
        format: "EVIDENCE",
        hardBudget: { maxBytes: 100_000, maxLines: 1000 },
      });

      expect(result.entities[0]!.renderedText).toBe("[EVIDENCE] src/main.ts");
    });
  });

  // ── getImpactCone ─────────────────────────────────────────────

  describe("getImpactCone", () => {
    it("returns unavailable when snapshot not found", async () => {
      const result = await svc.getImpactCone({
        snapshotId: "nonexistent" as SnapshotId,
        seeds: ["src/index.ts"],
        direction: "BOTH",
        maxDepth: 3,
        maxEntities: 100,
      });

      expect(result.assessment).toBe("unavailable");
      expect(result.entities.length).toBe(0);
      expect(
        result.coverageReasons.some((r) => r.includes("snapshot not found")),
      ).toBe(true);
    });

    it("clamps maxDepth to 0..8 and maxEntities to 2000", async () => {
      makeFile("src/index.ts", "export const x = 1;");
      const snap = await svc.getWorkspaceSnapshot({
        root: tmpDir,
        includeDiagnostics: false,
        budget: { maxMs: 30_000, maxBytes: 1_000_000 },
      });

      const result = await svc.getImpactCone({
        snapshotId: snap.snapshot.snapshotId,
        seeds: ["src/index.ts"],
        direction: "BOTH",
        maxDepth: 99,
        maxEntities: 9999,
      });

      // Should have been clamped; still valid result
      expect(result.maxDepth).toBeLessThanOrEqual(8);
      expect(result.entities.length).toBeLessThanOrEqual(2000);
    });

    it("returns complete for empty seeds", async () => {
      const result = await svc.getImpactCone({
        snapshotId: "snap" as SnapshotId,
        seeds: [],
        direction: "CALLERS",
        maxDepth: 3,
        maxEntities: 100,
      });

      expect(result.assessment).toBe("complete");
      expect(result.entities.length).toBe(0);
      expect(result.truncated).toBe(false);
    });
  });

  // ── getRelationshipEvidence ───────────────────────────────────

  describe("getRelationshipEvidence", () => {
    it("returns partial when snapshot not found", async () => {
      const result = await svc.getRelationshipEvidence({
        snapshotId: "nonexistent" as SnapshotId,
        limit: 10,
      });

      expect(result.assessment).toBe("partial");
      expect(result.edges.length).toBe(0);
    });

    it("enforces limit cap of 500", async () => {
      makeFile("src/a.ts", "import './b';");
      makeFile("src/b.ts", "export const b = 1;");

      const snap = await svc.getWorkspaceSnapshot({
        root: tmpDir,
        includeDiagnostics: false,
        budget: { maxMs: 30_000, maxBytes: 1_000_000 },
      });

      const result = await svc.getRelationshipEvidence({
        snapshotId: snap.snapshot.snapshotId,
        limit: 1,
      });

      expect(result.edges.length).toBeLessThanOrEqual(1);
    });
  });
});
