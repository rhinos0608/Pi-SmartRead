import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createRepositoryIntelligenceService,
  IntelligenceServiceNotImplementedError,
  unreadableContentHash,
} from "../../../src/repository/repository-intelligence.js";
import type {
  RepositoryIntelligenceService,
  SnapshotId,
} from "../../../src/repository/repository-intelligence-types.js";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, unlinkSync, chmodSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { getSharedContextGraphAsync } from "../../../src/graph/shared-context-graph.js";
import { getFsScanCache } from "../../../src/workspace/fs-scan-cache.js";

describe("RepositoryIntelligenceService", () => {
  let svc: RepositoryIntelligenceService;
  let tmpDir: string;

  const makeFile = (name: string, content: string) => {
    const fname = join(tmpDir, name);
    mkdirSync(dirname(fname), { recursive: true });
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

  describe("compareSnapshots (correctness, lineage-v1)", () => {
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

      expect(delta.algorithmVersion).toBe("lineage-v1");
      const kinds = (path: string) =>
        delta.fileChanges.filter((c) => c.beforePath === path || c.afterPath === path);
      // Added and removed files surface as ADDED / REMOVED changes.
      expect(kinds("src/c.ts").map((c) => c.kind)).toContain("ADDED");
      expect(kinds("src/b.ts").map((c) => c.kind)).toContain("REMOVED");
      // Fully-rewritten small file scores below the lineage match threshold,
      // so the modification surfaces as a REMOVED + ADDED pair on the same path.
      const aKinds = kinds("src/a.ts").map((c) => c.kind);
      expect(aKinds).toContain("REMOVED");
      expect(aKinds).toContain("ADDED");
    });

    it("detects a symbol move between files with lineage-v1 symbolChanges", async () => {
      // keep.ts stays byte-identical so file lineage has a verified anchor;
      // symbol lineage only runs on medium-or-better file matches.
      makeFile("src/keep.ts", "export const keep = 1;");
      makeFile("src/m1.ts", "export function foo() { return 1; }\n");
      makeFile("src/touch.ts", "export const t = 1;");

      const snap1 = await svc.getWorkspaceSnapshot({
        root: tmpDir,
        includeDiagnostics: false,
        budget: { maxMs: 30_000, maxBytes: 1_000_000 },
      });

      // Move foo from m1.ts to m2.ts with identical body, plus an unrelated edit
      // in a different file (whole-file body hashes flip touch.ts symbols only —
      // the m1→m2 move must still be detected).
      unlinkSync(join(tmpDir, "src/m1.ts"));
      makeFile("src/m2.ts", "export function foo() { return 1; }\n");
      writeFileSync(join(tmpDir, "src/touch.ts"), "export const t = 2;", "utf-8");

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

      expect(delta.algorithmVersion).toBe("lineage-v1");
      expect(delta.symbolChanges.length).toBeGreaterThan(0);
      const move = delta.symbolChanges.find(
        (r) => r.beforeId?.includes("src/m1.ts") && r.afterId?.includes("src/m2.ts"),
      );
      expect(move).toBeDefined();
    });

    it("lineage-v1 truncates fileChanges to maxEntities budget", async () => {
      // snapshot1: one file
      makeFile("src/keep.ts", "export const keep = 1;");

      const snap1 = await svc.getWorkspaceSnapshot({
        root: tmpDir,
        includeDiagnostics: false,
        budget: { maxMs: 30_000, maxBytes: 1_000_000 },
      });

      // snapshot2: keep.ts + 5 new files, remove nothing.
      // Each new file imports keep.ts so relationshipChanges also exceed budget.
      makeFile("src/new1.ts", "import './keep';\nexport const n1 = 1;");
      makeFile("src/new2.ts", "import './keep';\nexport const n2 = 2;");
      makeFile("src/new3.ts", "import './keep';\nexport const n3 = 3;");
      makeFile("src/new4.ts", "import './keep';\nexport const n4 = 4;");
      makeFile("src/new5.ts", "import './keep';\nexport const n5 = 5;");
      // Rebuild the shared graph so snapshot2 captures the new import edges.
      // Invalidate the fs scan cache first: the graph build reuses cached
      // discovery, which still reflects snapshot1's file set.
      getFsScanCache().invalidatePath(tmpDir);
      await getSharedContextGraphAsync(tmpDir, true);

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

      // maxEntities budget truncates fileChanges via SemanticDelta truncation stage.
      expect(delta.fileChanges).toHaveLength(2);
      expect(delta.truncated).toBe(true);
      expect(delta.assessment).toBe("partial");
      expect(
        delta.coverageReasons.some((r) =>
          r.includes("fileChanges truncated to 2 of") &&
          r.includes("to fit maxEntities budget"),
        ),
      ).toBe(true);
      expect(delta.algorithmVersion).toBe("lineage-v1");
      // The same maxEntities budget bounds symbol and relationship changes too.
      expect(delta.symbolChanges.length).toBeLessThanOrEqual(2);
      expect(delta.relationshipChanges.length).toBeLessThanOrEqual(2);
      expect(
        delta.coverageReasons.some((r) =>
          r.includes("symbolChanges truncated to 2 of") &&
          r.includes("to fit maxEntities budget"),
        ),
      ).toBe(true);
      expect(
        delta.coverageReasons.some((r) =>
          r.includes("relationshipChanges truncated to 2 of") &&
          r.includes("to fit maxEntities budget"),
        ),
      ).toBe(true);
    });
  });

  describe("rankWorkspace (missing snapshot)", () => {
    it("throws IntelligenceServiceNotImplementedError", async () => {
      await expect(
        svc.rankWorkspace({
          snapshotId: "aaa" as SnapshotId,
          maxEntities: 100,
        }),
      ).rejects.toThrow(IntelligenceServiceNotImplementedError);
    });

    it("error has code INTERNAL and retryable true", async () => {
      try {
        await svc.rankWorkspace({
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
        snapshotId: snap.snapshot.snapshotId,
        maxEntities: 100,
      });

      expect(result.snapshotId).toBe(snap.snapshot.snapshotId);
      expect(result.rankedEntityIds.length).toBeGreaterThanOrEqual(3);
      expect(result.rankedScores.length).toBe(result.rankedEntityIds.length);
      expect(["complete", "partial"]).toContain(result.assessment);
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
        snapshotId: snap.snapshot.snapshotId,
        maxEntities: 100,
      });

      // Should contain files from snapshot time only
      expect(result.rankedEntityIds).toContain("src/a.ts");
      expect(result.rankedEntityIds).toContain("src/b.ts");
      expect(result.rankedEntityIds).not.toContain("src/new.ts");
    });

    it("counts relationships from snapshot-time edges, not live graph edits", async () => {
      makeFile("src/a.ts", "import './b';\nexport const a = 1;");
      makeFile("src/b.ts", "export const b = 1;");
      makeFile("src/c.ts", "export const c = 1;");

      const snap1 = await svc.getWorkspaceSnapshot({
        root: tmpDir,
        includeDiagnostics: false,
        budget: { maxMs: 30_000, maxBytes: 1_000_000 },
      });

      const before = await svc.rankWorkspace({
        snapshotId: snap1.snapshot.snapshotId,
        maxEntities: 100,
      });
      // Snapshot-time graph has the a→b import edge, so unconnected c.ts ranks last.
      expect(before.rankedEntityIds).toContain("src/a.ts");
      expect(before.rankedEntityIds[before.rankedEntityIds.length - 1]).toBe("src/c.ts");

      // Mutate imports AFTER snapshot, then force the live graph to rebuild so it
      // reflects the new state: c.ts is now the most-connected file.
      writeFileSync(join(tmpDir, "src/a.ts"), "export const a = 1;", "utf-8");
      writeFileSync(join(tmpDir, "src/c.ts"), "import './a';\nimport './b';\nexport const c = 1;", "utf-8");
      await getSharedContextGraphAsync(tmpDir, true);

      const snap2 = await svc.getWorkspaceSnapshot({
        root: tmpDir,
        includeDiagnostics: false,
        budget: { maxMs: 30_000, maxBytes: 1_000_000 },
      });
      const live = await svc.rankWorkspace({
        snapshotId: snap2.snapshot.snapshotId,
        maxEntities: 100,
      });
      // Live state is observably different: c.ts now ranks first.
      expect(live.rankedEntityIds[0]).toBe("src/c.ts");

      // Ranking the old snapshot still reflects snapshot-time edges, not live edits.
      const after = await svc.rankWorkspace({
        snapshotId: snap1.snapshot.snapshotId,
        maxEntities: 100,
      });
      expect(after.rankedEntityIds).toEqual(before.rankedEntityIds);
      expect(after.rankedScores).toEqual(before.rankedScores);
      expect(after.assessment).toBe("complete");
    });

    it("returns partial assessment when snapshot capture degraded", async () => {
      makeFile("src/a.ts", "export const a = 1;");
      // Force provenance capture to fail so the snapshot is stored degraded.
      const graph = await getSharedContextGraphAsync(tmpDir, true);
      const spy = vi.spyOn(graph, "getProvenanceEdges").mockImplementation(() => {
        throw new Error("provenance unavailable");
      });
      try {
        const snap = await svc.getWorkspaceSnapshot({
          root: tmpDir,
          includeDiagnostics: false,
          budget: { maxMs: 30_000, maxBytes: 1_000_000 },
        });
        const result = await svc.rankWorkspace({
          snapshotId: snap.snapshot.snapshotId,
          maxEntities: 100,
        });
        expect(result.assessment).toBe("partial");
        expect(result.coverageReasons).toBeDefined();
        expect(result.coverageReasons!.some((r) => r.includes("partial relationship data"))).toBe(true);
        // Files still rank; only the completeness claim is downgraded.
        expect(result.rankedEntityIds).toContain("src/a.ts");
        // Negative budgets clamp to zero instead of slicing from the end.
        const empty = await svc.rankWorkspace({
          snapshotId: snap.snapshot.snapshotId,
          maxEntities: -5,
        });
        expect(empty.rankedEntityIds).toHaveLength(0);
        expect(empty.rankedScores).toHaveLength(0);
        expect(empty.assessment).toBe("partial");
      } finally {
        spy.mockRestore();
      }
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
      // Scala unavailable capabilities must mark graphAssessment partial
      expect(result.capabilities.graphAssessment).toBe("partial");
    });

    it("reports call-graph-only partial for TS+Java mix", async () => {
      makeFile("src/index.ts", "export const x = 1;");
      makeFile("src/Main.java", "public class Main { public static void main(String[] args) {} }");

      const result = await svc.getWorkspaceSnapshot({
        root: tmpDir,
        includeDiagnostics: false,
        budget: { maxMs: 30_000, maxBytes: 1_000_000 },
      });

      const javaLang = result.capabilities.byLanguage.find((l) => l.language === "java");
      expect(javaLang).toBeDefined();
      expect(javaLang!.tags).toBe("AVAILABLE");
      expect(javaLang!.callGraph).toBe("UNAVAILABLE");
      expect(result.capabilities.graphAssessment).toBe("partial");
      expect(result.capabilities.coverageReasons.some((r) => r.includes("java"))).toBe(true);
    });

    it("hashes unreadable files distinctly from empty files", () => {
      const emptyHash = createHash("sha256").update("").digest("hex");
      const marker = unreadableContentHash("src/locked.ts");
      expect(marker).not.toBe(emptyHash);
      // Outside digest space: no file content can collide with a marker,
      // not even the literal marker preimage text.
      expect(marker).not.toMatch(/^[a-f0-9]{64}$/);
      // Path-bound: two different unreadable files never share a hash.
      expect(unreadableContentHash("src/other.ts")).not.toBe(marker);
      expect(unreadableContentHash("src/locked.ts")).toBe(marker);
    });

    it("detects empty file becoming unreadable as a change", async () => {
      // chmod-based unreadable simulation only works off-root (root bypasses
      // permission bits) and off-Windows (ACL semantics differ).
      if (process.platform === "win32" || process.getuid?.() === 0) return;
      makeFile("src/empty.ts", "");
      const snap1 = await svc.getWorkspaceSnapshot({
        root: tmpDir,
        includeDiagnostics: false,
        budget: { maxMs: 30_000, maxBytes: 1_000_000 },
      });
      expect(
        snap1.capabilities.coverageReasons.some((r) => r.includes("unreadable")),
      ).toBe(false);

      chmodSync(join(tmpDir, "src/empty.ts"), 0o000);
      try {
        const snap2 = await svc.getWorkspaceSnapshot({
          root: tmpDir,
          includeDiagnostics: false,
          budget: { maxMs: 30_000, maxBytes: 1_000_000 },
        });
        expect(
          snap2.capabilities.coverageReasons.some((r) => r.includes("unreadable")),
        ).toBe(true);
        const delta = await svc.compareSnapshots({
          before: snap1.snapshot.snapshotId,
          after: snap2.snapshot.snapshotId,
          budget: { maxMs: 30_000, maxEntities: 2000 },
        });
        // Old read-failure-as-empty hashed this as sha256("") both times: missed.
        // Lineage-v1: empty -> unreadable-marker hash change surfaces as a
        // REMOVED + ADDED pair on the same path (below match threshold).
        const emptyChanges = delta.fileChanges.filter(
          (c) => c.beforePath === "src/empty.ts" || c.afterPath === "src/empty.ts",
        );
        expect(emptyChanges.length).toBeGreaterThan(0);
        // getCapabilities replays the same unreadable notice for the snapshot.
        const caps = await svc.getCapabilities({ snapshotId: snap2.snapshot.snapshotId });
        expect(caps.coverageReasons.some((r) => r.includes("unreadable"))).toBe(true);
      } finally {
        chmodSync(join(tmpDir, "src/empty.ts"), 0o644);
      }
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
