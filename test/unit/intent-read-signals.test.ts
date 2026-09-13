import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createIntentReadTool } from "../../src/intent-read.js";
import { writeAdr } from "../../src/adr-store.js";
import {
  fileByPath,
  makeEmbedder,
  makeFailingEmbedder,
  makeReadTool,
  runIntentRead,
  setupIntentReadEnv,
} from "./intent-read-helpers.js";

vi.mock("../../src/mcp-registry.js", () => ({
  getSharedContextGraphAsync: vi.fn().mockResolvedValue({
    getFileNeighbours: vi.fn().mockResolvedValue([]),
    getMutationNeighbours: vi.fn().mockReturnValue([]),
  }),
}));

setupIntentReadEnv();

describe("intent_read: Phase 2 ranking observability", () => {
  it("includes chunkIndex, chunkRelevance, and rankedBy for successful files with embeddings", async () => {
    // 2 files × 1 chunk = 2 chunks → need query + 2 = 3 vectors
    const tool = createIntentReadTool(
      () => makeReadTool({ "/a": "auth logic", "/b": "db schema" }) as any,
      makeEmbedder([[1, 0], [1, 0], [0, 1]]),
    );

    const result = await runIntentRead(tool, { query: "auth", files: [{ path: "/a" }, { path: "/b" }] }, "/", "id");


    const details = result.details as any;
    const fileA = fileByPath(details, "/a");
    const fileB = fileByPath(details, "/b");

    expect(fileA.chunkIndex).toBe(0);
    expect(fileA.chunkRelevance).toMatch(/^(exact|strong|related|weak|none)$/);
    expect(fileA.chunkScore).toBeUndefined();
    expect(fileA.rankedBy).toBe("hybrid");

    // fileB got -Infinity semantic score, still hybrid (embeddings succeeded)
    expect(fileB.rankedBy).toBe("hybrid");
  });

  it("includes chunkingEnabled and chunkInfo when embeddings succeed", async () => {
    const tool = createIntentReadTool(
      () => makeReadTool({ "/a": "test content" }) as any,
      makeEmbedder([[1, 0], [1, 0]]),
    );

    const result = await runIntentRead(tool, { query: "test", files: [{ path: "/a" }] }, "/", "id");

    const details = result.details as any;
    expect(details.chunkingEnabled).toBe(true);
    expect(details.chunkInfo).toBeDefined();
    expect(details.chunkInfo.totalChunks).toBeGreaterThanOrEqual(0);
    expect(details.chunkInfo.filesChunked).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(details.chunkInfo.bestChunkByFile)).toBe(true);
    if (details.chunkInfo.bestChunkByFile.length > 0) {
      const best = details.chunkInfo.bestChunkByFile[0];
      expect(typeof best.path).toBe("string");
      expect(typeof best.chunkIndex).toBe("number");
      expect(best.relevance).toMatch(/^(exact|strong|related|weak|none)$/);
      expect(typeof best.startChar).toBe("number");
      expect(typeof best.endChar).toBe("number");
      expect(typeof best.preview).toBe("string");
    }
  });


  it("includes rankedBy=bm25 when embeddings fail", async () => {
    const tool = createIntentReadTool(
      () => makeReadTool({ "/a": "auth" }) as any,
      makeFailingEmbedder("timeout"),
    );

    const result = await runIntentRead(tool, { query: "auth", files: [{ path: "/a" }] }, "/", "id");

    const details = result.details as any;
    expect(details.chunkingEnabled).toBe(false);
    expect(details.chunkInfo).toBeUndefined();
    const fileA = fileByPath(details, "/a");
    expect(fileA.rankedBy).toBe("bm25");
  });
});

describe("intent_read: structural reranker integration", () => {
  it("includes reranking metadata in details when rerankEnabled is true", async () => {
    const root = mkdtempSync(join(tmpdir(), "intent-read-rerank-"));
    try {
      writeFileSync(join(root, "pi-smartread.config.json"), JSON.stringify({
        baseUrl: "http://localhost:11434/v1",
        model: "test",
        rerankEnabled: true,
      }));

      const fileA = join(root, "a.ts");
      const fileB = join(root, "b.ts");
      writeFileSync(fileA, "export function auth() { return true; }");
      writeFileSync(fileB, "export function database() { return true; }");

      const tool = createIntentReadTool(
        () => makeReadTool({ [fileA]: readFileSync(fileA, "utf-8"), [fileB]: readFileSync(fileB, "utf-8") }) as any,
        makeEmbedder([[1, 0], [1, 0], [1, 0]]),
      );

      const result = await runIntentRead(tool, { query: "auth", files: [{ path: fileA }, { path: fileB }], topK: 2 }, root, "id");

      const details = result.details as any;
      expect(details.reranking).toBeDefined();
      expect(details.reranking.status).toBe("ok");
      expect(details.reranking.candidateCount).toBe(2);
      expect(typeof details.reranking.changedOrder).toBe("boolean");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not include reranking metadata when rerankEnabled is false", async () => {
    const tool = createIntentReadTool(
      () => makeReadTool({ "/a": "auth code" }) as any,
      makeEmbedder([[1, 0], [1, 0]]),
    );

    const result = await runIntentRead(tool, { query: "auth", files: [{ path: "/a" }] }, "/", "id");

    const details = result.details as any;
    expect(details.reranking).toBeUndefined();
  });

  it("reranking single candidate succeeds with order unchanged", async () => {
    const root = mkdtempSync(join(tmpdir(), "intent-read-rerank-fail-"));
    try {
      writeFileSync(join(root, "pi-smartread.config.json"), JSON.stringify({
        baseUrl: "http://localhost:11434/v1",
        model: "test",
        rerankEnabled: true,
      }));

      const fileA = join(root, "a.ts");
      writeFileSync(fileA, "auth code");

      // Only 1 file, reranker should still work (single candidate)
      const tool = createIntentReadTool(
        () => makeReadTool({ [fileA]: readFileSync(fileA, "utf-8") }) as any,
        makeEmbedder([[1, 0], [1, 0]]),
      );

      const result = await runIntentRead(tool, { query: "auth", files: [{ path: fileA }] }, root, "id");

      const details = result.details as any;
      expect(details.reranking).toBeDefined();
      expect(details.reranking.status).toBe("ok");
      // Single candidate: no reordering possible
      expect(details.reranking.changedOrder).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("intent_read: ranking signals metadata", () => {
  it("reports rankingSignals with bm25 and embeddings flags", async () => {
    const tool = createIntentReadTool(
      () => makeReadTool({ "/a": "auth code" }) as any,
      makeEmbedder([[1, 0], [1, 0]]),
    );

    const result = await runIntentRead(tool, { query: "auth", files: [{ path: "/a" }] }, "/", "id");

    const details = result.details as any;
    expect(details.rankingSignals).toEqual({ bm25: true, embeddings: true });
  });

  it("reports embeddings=false when embedding fails", async () => {
    const tool = createIntentReadTool(
      () => makeReadTool({ "/a": "auth code" }) as any,
      makeFailingEmbedder("ECONNREFUSED"),
    );

    const result = await runIntentRead(tool, { query: "auth", files: [{ path: "/a" }] }, "/", "id");

    const details = result.details as any;
    expect(details.rankingSignals).toEqual({ bm25: true, embeddings: false });
    expect(details.embeddingStatus).toBe("failed_fallback_bm25");
  });
});

describe("intent_read: ADR boost (WP-8)", () => {
  it("no ADRs produces identical ranking to baseline (adrBoostedCount=0)", async () => {
    const root = mkdtempSync(join(tmpdir(), "intent-read-adr-empty-"));
    try {
      const tool = createIntentReadTool(
        () => makeReadTool({ "/a": "auth code", "/b": "db code" }) as any,
        makeEmbedder([[1, 0], [1, 0], [0, 1]]),
      );

      const result = await runIntentRead(tool, { query: "auth", files: [{ path: "/a" }, { path: "/b" }], topK: 2 }, root, "id");

      const details = result.details as any;
      expect(details.adrBoostedCount).toBe(0);
      const fileA = fileByPath(details, "/a");
      expect(fileA.adrBoost).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepted ADR matching file path boosts ranking", async () => {
    const root = mkdtempSync(join(tmpdir(), "intent-read-adr-boost-"));
    try {
      // Create an accepted ADR referencing "db" tag
      writeAdr(root, {
        id: "2026-01-01-use-db",
        title: "Use db module",
        status: "accepted",
        tags: ["db"],
        context: "Need db",
        decision: "Use db",
        consequences: "Depend on db",
      });

      const tool = createIntentReadTool(
        () => makeReadTool({ "/a": "auth code", "/src/db.ts": "db code" }) as any,
        makeEmbedder([[1, 0], [1, 0], [0, 1]]),
      );

      const result = await runIntentRead(tool, { query: "auth", files: [{ path: "/a" }, { path: "/src/db.ts" }], topK: 2 }, root, "id");

      const details = result.details as any;
      expect(details.adrBoostedCount).toBe(1);
      const fileB = fileByPath(details, "/src/db.ts");
      expect(fileB.adrBoost).toBe(0.3);
      const fileA = fileByPath(details, "/a");
      expect(fileA.adrBoost).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("only accepted ADRs produce boost; proposed/rejected do not", async () => {
    const root = mkdtempSync(join(tmpdir(), "intent-read-adr-status-"));
    try {
      // proposed ADR with matching tag — should NOT boost
      writeAdr(root, {
        id: "2026-01-01-proposed-db",
        title: "Proposed db",
        status: "proposed",
        tags: ["db"],
        context: "c",
        decision: "d",
        consequences: "x",
      });
      // rejected ADR with matching tag — should NOT boost
      writeAdr(root, {
        id: "2026-01-02-rejected-db",
        title: "Rejected db",
        status: "rejected",
        tags: ["db"],
        context: "c",
        decision: "d",
        consequences: "x",
      });

      const tool = createIntentReadTool(
        () => makeReadTool({ "/a": "auth code", "/src/db.ts": "db code" }) as any,
        makeEmbedder([[1, 0], [1, 0], [0, 1]]),
      );

      const result = await runIntentRead(tool, { query: "auth", files: [{ path: "/a" }, { path: "/src/db.ts" }], topK: 2 }, root, "id");

      const details = result.details as any;
      expect(details.adrBoostedCount).toBe(0);
      const fileB = fileByPath(details, "/src/db.ts");
      expect(fileB.adrBoost).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("corrupt ADR store fails safe — ranking unchanged", async () => {
    const root = mkdtempSync(join(tmpdir(), "intent-read-adr-corrupt-"));
    try {
      // Write a corrupt ADR file that parseAdr will fail on
      const adrsDir = join(root, ".pi-smartread", "adrs");
      mkdirSync(adrsDir, { recursive: true });
      writeFileSync(join(adrsDir, "corrupt.md"), "NOT AN ADR");

      const tool = createIntentReadTool(
        () => makeReadTool({ "/a": "auth code" }) as any,
        makeEmbedder([[1, 0], [1, 0]]),
      );

      const result = await runIntentRead(tool, { query: "auth", files: [{ path: "/a" }] }, root, "id");

      // Should not throw; ranking proceeds normally
      const details = result.details as any;
      expect(details.adrBoostedCount).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
