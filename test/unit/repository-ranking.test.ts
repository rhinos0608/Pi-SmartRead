import { describe, expect, it } from "vitest";
import {
  RepositoryRankingService,
  type WorkspaceContext,
} from "../../src/repository-ranking.js";
import type { ChannelCandidate } from "../../src/rank-fusion.js";

// ── Helpers ────────────────────────────────────────────────────

function makeEntries(n: number, prefix = "file"): WorkspaceContext["semanticEntries"] {
  return Array.from({ length: n }, (_, i) => ({
    file: `${prefix}-${i}.ts`,
    name: `symbol${i}`,
    kind: "function",
    snippet: `function ${prefix}${i}() { /* implementation ${i} */ }`,
  }));
}

function baseContext(overrides?: Partial<WorkspaceContext>): WorkspaceContext {
  return {
    query: "function",
    snapshotId: "snap-1",
    ...overrides,
  };
}

/** Generate diagnostic inputs with unique file paths. */
function makeDiagnostics(n: number, prefix = "diag"): WorkspaceContext["diagnostics"] {
  return Array.from({ length: n }, (_, i) => ({
    file: `${prefix}-${i}.ts`,
    lineCount: 100,
    errors: 1,
    warnings: 0,
  }));
}

/** Generate graph edges connecting unique file pairs. */
function makeEdges(n: number, prefix = "edge"): WorkspaceContext["graphEdges"] {
  return Array.from({ length: n }, (_, i) => ({
    from: `${prefix}-from-${i}.ts`,
    to: `${prefix}-to-${i}.ts`,
  }));
}

// ── Tests ──────────────────────────────────────────────────────

describe("RepositoryRankingService", () => {
  describe("rankWorkspace — full pipeline", () => {
    it("runs all channels, fuses, and returns RankResult", async () => {
      const entries = makeEntries(5);
      const svc = new RepositoryRankingService(
        baseContext({ semanticEntries: entries }),
      );

      const result = await svc.rankWorkspace({
        query: "function",
        snapshotId: "snap-1",
      });

      expect(["complete", "partial"]).toContain(result.assessment);
      expect(Array.isArray(result.channelResults)).toBe(true);
      expect(Array.isArray(result.candidates)).toBe(true);

      // At least semantic channel ran
      const semanticResult = result.channelResults.find(
        (r) => r.channel === "semantic",
      );
      expect(semanticResult).toBeDefined();
      expect(semanticResult!.candidates.length).toBeGreaterThan(0);
    });

    it("semantic candidates appear in fused output with rrfOrigins metadata", async () => {
      const entries = makeEntries(3);
      const svc = new RepositoryRankingService(
        baseContext({ semanticEntries: entries }),
      );

      const result = await svc.rankWorkspace({
        query: "function",
        snapshotId: "snap-1",
      });

      expect(result.candidates.length).toBeGreaterThan(0);

      // Fused candidates carry rrfOrigins at runtime
      const first = result.candidates[0]!;
      const meta = (first as ChannelCandidate & { metadata?: { rrfOrigins?: Array<{ channel: string; rank: number }> } }).metadata;
      expect(meta).toBeDefined();
      expect(meta!.rrfOrigins).toBeDefined();
      expect(meta!.rrfOrigins!.length).toBeGreaterThan(0);
      expect(meta!.rrfOrigins![0]!.channel).toBe("semantic");
    });
  });

  describe("rankWorkspace — partial assessment", () => {
    it("returns 'partial' when a selected channel is unavailable", async () => {
      const svc = new RepositoryRankingService(
        baseContext({ semanticEntries: [] }),
      );

      const result = await svc.rankWorkspace({
        query: "function",
        snapshotId: "snap-1",
        channels: ["annotation-proximity", "change-proximity"],
      });

      expect(result.assessment).toBe("partial");
      for (const cr of result.channelResults) {
        expect(cr.unavailable).toBeDefined();
      }
    });

    it("returns 'complete' when no channel is unavailable", async () => {
      const entries = makeEntries(3);
      const svc = new RepositoryRankingService(
        baseContext({
          semanticEntries: entries,
          candidateFiles: ["a.ts", "b.ts"],
          seeds: ["a.ts"],
        }),
      );

      const result = await svc.rankWorkspace({
        query: "function",
        snapshotId: "snap-1",
        channels: ["semantic", "explicit-seed"],
      });

      expect(result.assessment).toBe("complete");
      for (const cr of result.channelResults) {
        expect(cr.unavailable).toBeUndefined();
      }
    });
  });

  describe("rankWorkspace — max 2000 cap", () => {
    it("returns at most 2000 candidates even with many entries", async () => {
      const entries = makeEntries(500, "sem");
      const svc = new RepositoryRankingService(
        baseContext({ semanticEntries: entries }),
      );

      const result = await svc.rankWorkspace({
        query: "function",
        snapshotId: "snap-1",
      });

      expect(result.candidates.length).toBeLessThanOrEqual(2000);
    });

    it("truncated is true when unique candidates exceed 2000 across channels", async () => {
      // Each channel caps at 500. Use 5 channels to exceed 2000 unique.
      const entries = makeEntries(500, "sem");
      const diagnostics = makeDiagnostics(500, "diag");
      const graphEdges = makeEdges(500, "ge");
      // explicit-seed: seeds=["x"] matches any file containing "x"
      const seedFiles = Array.from({ length: 500 }, (_, i) => `x-file-${i}.ts`);
      // test-failure-proximity: failures pointing to unique files
      const failures = Array.from({ length: 500 }, (_, i) => ({
        testFile: `tf-${i}.test.ts`,
        stackTrace: [`at fn (src/tf-${i}.ts:1:1)`],
      }));
      const allFiles = Array.from({ length: 500 }, (_, i) => `src/tf-${i}.ts`);

      const svc = new RepositoryRankingService(
        baseContext({
          semanticEntries: entries,
          diagnostics,
          graphEdges,
          candidateFiles: seedFiles,
          seeds: ["x"],
          failures,
          allFiles,
        }),
      );

      const result = await svc.rankWorkspace({
        query: "function",
        snapshotId: "snap-1",
        // Run channels that produce unique candidates:
        // semantic(500) + diagnostic(500) + pagerank(500) + explicit-seed(500) + test-failure(500) = 2500
        channels: [
          "semantic",
          "diagnostic-proximity",
          "structural-pagerank",
          "explicit-seed",
          "test-failure-proximity",
        ],
      });

      expect(result.candidates.length).toBeLessThanOrEqual(2000);
      expect(result.truncated).toBe(true);
    });

    it("truncated is false when under 2000", async () => {
      const entries = makeEntries(10);
      const svc = new RepositoryRankingService(
        baseContext({ semanticEntries: entries }),
      );

      const result = await svc.rankWorkspace({
        query: "function",
        snapshotId: "snap-1",
      });

      expect(result.truncated).toBe(false);
      expect(result.candidates.length).toBeLessThanOrEqual(2000);
    });
  });

  describe("rankWorkspace — channel metadata preserved", () => {
    it("includes all selected channels in channelResults", async () => {
      const entries = makeEntries(3);
      const svc = new RepositoryRankingService(
        baseContext({ semanticEntries: entries }),
      );

      const result = await svc.rankWorkspace({
        query: "function",
        snapshotId: "snap-1",
        channels: ["semantic", "annotation-proximity"],
      });

      expect(result.channelResults.length).toBe(2);
      const names = result.channelResults.map((r) => r.channel);
      expect(names).toContain("semantic");
      expect(names).toContain("annotation-proximity");
    });

    it("preserves per-channel metadata objects", async () => {
      const entries = makeEntries(5);
      const svc = new RepositoryRankingService(
        baseContext({ semanticEntries: entries }),
      );

      const result = await svc.rankWorkspace({
        query: "function",
        snapshotId: "snap-1",
        channels: ["semantic"],
      });

      const semantic = result.channelResults.find((r) => r.channel === "semantic")!;
      expect(semantic.metadata).toBeDefined();
      expect(semantic.metadata!.corpusSize).toBe(5);
    });
  });

  describe("rankWorkspace — weight injection blocked", () => {
    it("rejects unknown channel names in constructor weights", () => {
      expect(
        () =>
          new RepositoryRankingService(baseContext(), {
            "evil-channel": 999,
          }),
      ).toThrow('Unknown channel "evil-channel"');
    });

    it("rejects unknown channel names in channel filter", async () => {
      const svc = new RepositoryRankingService(baseContext());

      await expect(
        svc.rankWorkspace({
          query: "function",
          snapshotId: "snap-1",
          channels: ["semantic", "injected"],
        }),
      ).rejects.toThrow('Unknown channel "injected"');
    });

    it("accepts valid channel names in weights", () => {
      expect(
        () =>
          new RepositoryRankingService(baseContext(), {
            semantic: 2.0,
            "annotation-proximity": 0.5,
          }),
      ).not.toThrow();
    });
  });

  describe("renderView — delegation", () => {
    it("delegates to renderWorkspaceView", () => {
      const svc = new RepositoryRankingService(baseContext());

      const candidates: ChannelCandidate[] = [
        {
          file: "src/app.ts",
          line: 10,
          name: "main",
          kind: "function",
          snippet: "export function main() {}",
          rawScore: 0.9,
        },
      ];

      const view = svc.renderView({
        rankedCandidates: candidates,
        format: "OUTLINE",
        hardBudget: { maxBytes: 10000, maxLines: 500 },
      });

      expect(view.entities.length).toBe(1);
      expect(view.entities[0]!.path).toBe("src/app.ts");
      expect(view.truncated).toBe(false);
    });
  });

  describe("getRelationshipEvidence — delegation", () => {
    it("delegates to getRelationshipEvidence", () => {
      const svc = new RepositoryRankingService(baseContext());

      const result = svc.getRelationshipEvidence({
        edges: [
          { from: "a.ts", to: "b.ts", type: "imports", confidence: 0.9 },
          { from: "b.ts", to: "c.ts", type: "imports", confidence: 0.7 },
        ],
        limit: 10,
      });

      expect(result.edges.length).toBe(2);
      expect(result.assessment).toBe("complete");
    });
  });
});
