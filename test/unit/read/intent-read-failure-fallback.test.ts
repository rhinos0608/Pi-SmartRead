import { describe, expect, it, vi } from "vitest";
import { createIntentReadTool } from "../../../src/read/intent-read.js";
import {
  fileByPath,
  makeFailingEmbedder,
  makeReadTool,
  makeWrongCountEmbedder,
  runIntentRead,
  setupIntentReadEnv,
} from "./intent-read-helpers.js";

vi.mock("../../../src/mcp-registry.js", () => ({
  getSharedContextGraphAsync: vi.fn().mockResolvedValue({
    getFileNeighbours: vi.fn().mockResolvedValue([]),
    getMutationNeighbours: vi.fn().mockReturnValue([]),
  }),
}));

setupIntentReadEnv();

describe("intent_read: embedding failure fallback", () => {
  it("falls back to BM25 when embedding throws", async () => {
    const tool = createIntentReadTool(
      () => makeReadTool({ "/a": "authentication logic", "/b": "database schema" }) as any,
      makeFailingEmbedder("ECONNREFUSED"),
    );

    const result = await runIntentRead(tool, { query: "authentication", files: [{ path: "/a" }, { path: "/b" }] }, "/", "id");

    // Tool does not throw — returns BM25-ranked results
    const text = (result.content[0] as any).text as string;
    expect(text).toContain("@/a");
    const details = result.details as any;
    expect(details.embeddingStatus).toBe("failed_fallback_bm25");
    expect(details.embeddingError).toContain("ECONNREFUSED");
    expect(details.rankingSignals).toEqual({ bm25: true, embeddings: false });
    expect(details.successCount).toBe(2);
  });

  it("no semantic scores when embedding fails", async () => {
    const tool = createIntentReadTool(
      () => makeReadTool({ "/a": "authentication" }) as any,
      makeFailingEmbedder("timeout"),
    );

    const result = await runIntentRead(tool, { query: "auth", files: [{ path: "/a" }] }, "/", "id");

    const details = result.details as any;
    const fileDetail = details.files[0];
    expect(fileDetail.keywordRank).toEqual(expect.any(Number));
    expect(fileDetail.keywordRelevance).toMatch(/^(exact|strong|related|weak|none)$/);
    expect(fileDetail.fusedRank).toEqual(expect.any(Number));
    expect(fileDetail.fusedRelevance).toMatch(/^(exact|strong|related|weak|none)$/);
    expect(fileDetail.semanticRank).toBeUndefined();
    expect(fileDetail.semanticRelevance).toBeUndefined();
    expect(fileDetail.keywordScore).toBeUndefined();
    expect(fileDetail.rrfScore).toBeUndefined();
  });

  it("falls back to BM25 when embedding returns wrong vector count", async () => {
    // With chunking: 2 files × 1 chunk = 2 chunks → need query + 2 = 3 vectors
    // Stub returns only 1 → triggers wrong-count fallback
    const tool = createIntentReadTool(
      () => makeReadTool({ "/a": "auth", "/b": "db" }) as any,
      makeWrongCountEmbedder(1),
    );

    const result = await runIntentRead(tool, { query: "auth", files: [{ path: "/a" }, { path: "/b" }] }, "/", "id");

    const details = result.details as any;
    expect(details.embeddingStatus).toBe("failed_fallback_bm25");
    expect(details.embeddingError).toContain("Expected 3 vectors, got 1");
    expect(details.rankingSignals.embeddings).toBe(false);
    const text = (result.content[0] as any).text as string;
    expect(text).toContain("@/a");
  });

  it("returns empty content and ok status when no successful files (even with failing embedder)", async () => {
    const tool = createIntentReadTool(
      () => makeReadTool({ "/a": new Error("gone") }) as any,
      makeFailingEmbedder("down"),
    );

    const result = await runIntentRead(tool, { query: "auth", files: [{ path: "/a" }] }, "/", "id");

    const text = (result.content[0] as any).text as string;
    expect(text).toBe("");
    const details = result.details as any;
    expect(details.successCount).toBe(0);
    expect(details.embeddingStatus).toBe("ok");
  });

  it("ranks by keyword relevance when embedding fails", async () => {
    const tool = createIntentReadTool(
      () => makeReadTool({ "/a": "auth middleware", "/b": "auth database schema migration" }) as any,
      makeFailingEmbedder("rate limited"),
    );

    const result = await runIntentRead(tool, { query: "auth", files: [{ path: "/a" }, { path: "/b" }] }, "/", "id");

    const text = (result.content[0] as any).text as string;
    const posA = text.indexOf("@/a");
    const posB = text.indexOf("@/b");
    expect(posA).toBeGreaterThanOrEqual(0);
    expect(posB).toBeGreaterThan(posA);

    const details = result.details as any;
    const fileA = fileByPath(details, "/a");
    const fileB = fileByPath(details, "/b");
    expect(fileA.keywordRank).toBeLessThan(fileB.keywordRank);
  });
});
