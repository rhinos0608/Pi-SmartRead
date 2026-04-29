import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createIntentReadTool } from "../../intent-read.js";
import type { EmbedRequest, EmbedResult } from "../../embedding.js";
import { resetConfigCache } from "../../config.js";

// Stub fetchEmbeddings: returns unit vectors for easy scoring
function makeEmbedder(vectors: number[][]): (req: EmbedRequest) => Promise<EmbedResult> {
  return async () => ({ vectors });
}

// Stub fetchEmbeddings: always throws
function makeFailingEmbedder(errorMsg: string): (req: EmbedRequest) => Promise<EmbedResult> {
  return async () => { throw new Error(errorMsg); };
}

// Stub fetchEmbeddings: returns fewer vectors than requested
function makeWrongCountEmbedder(count: number): (req: EmbedRequest) => Promise<EmbedResult> {
  return async () => ({ vectors: Array.from({ length: count }, () => [1, 0]) });
}

// Stub readTool: returns text content by path
function makeReadTool(map: Record<string, string | Error>) {
  return {
    execute: async (_id: string, input: { path: string }) => {
      const val = map[input.path];
      if (!val) throw new Error(`No stub for: ${input.path}`);
      if (val instanceof Error) throw val;
      return { content: [{ type: "text" as const, text: val }] };
    },
  };
}

beforeEach(() => {
  resetConfigCache();
  process.env.PI_SMARTREAD_EMBEDDING_BASE_URL = "http://localhost:11434/v1";
  process.env.PI_SMARTREAD_EMBEDDING_MODEL = "nomic-embed-text";
});

afterEach(() => {
  resetConfigCache();
  delete process.env.PI_SMARTREAD_EMBEDDING_BASE_URL;
  delete process.env.PI_SMARTREAD_EMBEDDING_MODEL;
});

describe("intent_read: input validation", () => {
  it("throws when both files and directory are provided", async () => {
    const tool = createIntentReadTool(() => makeReadTool({}) as any, makeEmbedder([]));
    await expect(
      tool.execute("id", { query: "auth", files: [{ path: "/a" }], directory: "/tmp" }, undefined, undefined, { cwd: "/" } as any),
    ).rejects.toThrow(/files.*directory|directory.*files/i);
  });

  it("throws when neither files nor directory is provided", async () => {
    const tool = createIntentReadTool(() => makeReadTool({}) as any, makeEmbedder([]));
    await expect(
      tool.execute("id", { query: "auth" } as any, undefined, undefined, { cwd: "/" } as any),
    ).rejects.toThrow(/files.*directory|directory.*files/i);
  });

  it("throws when query is empty after trimming", async () => {
    const tool = createIntentReadTool(() => makeReadTool({}) as any, makeEmbedder([]));
    await expect(
      tool.execute("id", { query: "   ", files: [{ path: "/a" }] }, undefined, undefined, { cwd: "/" } as any),
    ).rejects.toThrow(/query/i);
  });
});

describe("intent_read: ranking and output", () => {
  it("returns top-K files by RRF score in relevance order", async () => {
    // query vector: [1,0,0]
    // file a chunk vector: [1,0,0] -> high cosine similarity (best chunk)
    // file b chunk vector: [0,1,0] -> low cosine similarity
    // With chunking: 2 files × 1 chunk each = 3 vectors (query + 2 chunks)
    const queryVec = [1, 0, 0];
    const fileAChunk = [1, 0, 0];
    const fileBChunk = [0, 1, 0];

    const tool = createIntentReadTool(
      () => makeReadTool({ "/a": "authentication logic here", "/b": "database schema" }) as any,
      makeEmbedder([queryVec, fileAChunk, fileBChunk]),
    );

    const result = await tool.execute(
      "id",
      { query: "authentication", files: [{ path: "/a" }, { path: "/b" }], topK: 2 },
      undefined,
      undefined,
      { cwd: "/" } as any,
    );

    const text = (result.content[0] as any).text as string;
    const details = result.details as any;

    // /a should rank higher (both keyword and semantic match)
    const posA = text.indexOf("@/a");
    const posB = text.indexOf("@/b");
    expect(posA).toBeGreaterThanOrEqual(0);
    expect(posB).toBeGreaterThan(posA);

    expect(details.query).toBe("authentication");
    expect(details.successCount).toBe(2);
    expect(details.requestedTopK).toBe(2);

    const fileA = details.files.find((f: any) => f.path === "/a");
    expect(fileA.included).toBe(true);
    expect(fileA.rrfScore).toBeGreaterThan(0);
    expect(fileA.inclusion).toBe("full");
  });

  it("puts errored files after successful files in details.files", async () => {
    const tool = createIntentReadTool(
      () => makeReadTool({ "/a": "content", "/b": new Error("missing") }) as any,
      makeEmbedder([[1, 0], [1, 0]]),
    );

    const result = await tool.execute(
      "id",
      { query: "auth", files: [{ path: "/a" }, { path: "/b" }] },
      undefined,
      undefined,
      { cwd: "/" } as any,
    );

    const details = result.details as any;
    const errorFile = details.files.find((f: any) => f.path === "/b");
    const successFile = details.files.find((f: any) => f.path === "/a");

    expect(errorFile.ok).toBe(false);
    expect(errorFile.inclusion).toBe("error");
    expect(errorFile.included).toBe(false);

    // Successful file should appear before errored file
    const successIdx = details.files.indexOf(successFile);
    const errorIdx = details.files.indexOf(errorFile);
    expect(successIdx).toBeLessThan(errorIdx);
  });

  it("marks files outside topK as not_top_k", async () => {
    // 3 files × 1 chunk each = 4 vectors (query + 3 chunks)
    const tool = createIntentReadTool(
      () => makeReadTool({ "/a": "auth", "/b": "db", "/c": "cache" }) as any,
      makeEmbedder([[1, 0], [1, 0], [0, 1], [0, 1]]),
    );

    const result = await tool.execute(
      "id",
      { query: "auth", files: [{ path: "/a" }, { path: "/b" }, { path: "/c" }], topK: 2 },
      undefined,
      undefined,
      { cwd: "/" } as any,
    );

    const details = result.details as any;
    const notTopK = details.files.filter((f: any) => f.inclusion === "not_top_k");
    expect(notTopK).toHaveLength(1);
  });

  it("stops on first error when stopOnError is true and does not embed", async () => {
    const embedder = vi.fn(makeEmbedder([]));
    const tool = createIntentReadTool(
      () => makeReadTool({ "/a": new Error("bad"), "/b": "ok" }) as any,
      embedder,
    );

    await expect(
      tool.execute(
        "id",
        { query: "auth", files: [{ path: "/a" }, { path: "/b" }], stopOnError: true },
        undefined,
        undefined,
        { cwd: "/" } as any,
      ),
    ).rejects.toThrow("bad");

    expect(embedder).not.toHaveBeenCalled();
  });

  it("throws before reading when embedding config is missing", async () => {
    resetConfigCache();
    delete process.env.PI_SMARTREAD_EMBEDDING_BASE_URL;
    delete process.env.PI_SMARTREAD_EMBEDDING_MODEL;

    const readSpy = vi.fn();
    const tool = createIntentReadTool(() => ({ execute: readSpy }) as any, makeEmbedder([]));

    await expect(
      tool.execute("id", { query: "auth", files: [{ path: "/a" }] }, undefined, undefined, { cwd: "/" } as any),
    ).rejects.toThrow(/baseUrl|model/i);

    expect(readSpy).not.toHaveBeenCalled();
  });

  it("returns no content when all files fail to read", async () => {
    const tool = createIntentReadTool(
      () => makeReadTool({ "/a": new Error("gone") }) as any,
      makeEmbedder([]),
    );

    const result = await tool.execute(
      "id",
      { query: "auth", files: [{ path: "/a" }] },
      undefined,
      undefined,
      { cwd: "/" } as any,
    );

    const text = (result.content[0] as any).text as string;
    const details = result.details as any;
    expect(text).toBe("");
    expect(details.successCount).toBe(0);
    expect(details.effectiveTopK).toBe(0);
  });

  it("includes per-file semanticRank, keywordRank, and rrfScore for successful files", async () => {
    const tool = createIntentReadTool(
      () => makeReadTool({ "/a": "authentication middleware" }) as any,
      makeEmbedder([[1, 0], [1, 0]]),
    );

    const result = await tool.execute(
      "id",
      { query: "authentication", files: [{ path: "/a" }] },
      undefined,
      undefined,
      { cwd: "/" } as any,
    );

    const details = result.details as any;
    const fileDetail = details.files[0];
    expect(typeof fileDetail.semanticRank).toBe("number");
    expect(typeof fileDetail.keywordRank).toBe("number");
    expect(typeof fileDetail.rrfScore).toBe("number");
    expect(typeof fileDetail.semanticScore).toBe("number");
    expect(typeof fileDetail.keywordScore).toBe("number");
  });

  it("includes embeddingStatus=ok and rankingSignals when embeddings succeed", async () => {
    const tool = createIntentReadTool(
      () => makeReadTool({ "/a": "auth" }) as any,
      makeEmbedder([[1, 0], [1, 0]]),
    );

    const result = await tool.execute(
      "id",
      { query: "auth", files: [{ path: "/a" }] },
      undefined,
      undefined,
      { cwd: "/" } as any,
    );

    const details = result.details as any;
    expect(details.embeddingStatus).toBe("ok");
    expect(details.rankingSignals).toEqual({ bm25: true, embeddings: true });
    expect(details.embeddingError).toBeUndefined();
  });
});

describe("intent_read: embedding failure fallback", () => {
  it("falls back to BM25 when embedding throws", async () => {
    const tool = createIntentReadTool(
      () => makeReadTool({ "/a": "authentication logic", "/b": "database schema" }) as any,
      makeFailingEmbedder("ECONNREFUSED"),
    );

    const result = await tool.execute(
      "id",
      { query: "authentication", files: [{ path: "/a" }, { path: "/b" }] },
      undefined,
      undefined,
      { cwd: "/" } as any,
    );

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

    const result = await tool.execute(
      "id",
      { query: "auth", files: [{ path: "/a" }] },
      undefined,
      undefined,
      { cwd: "/" } as any,
    );

    const details = result.details as any;
    const fileDetail = details.files[0];
    expect(fileDetail.keywordRank).toEqual(expect.any(Number));
    expect(fileDetail.keywordScore).toEqual(expect.any(Number));
    expect(fileDetail.rrfScore).toEqual(expect.any(Number));
    expect(fileDetail.semanticRank).toBeUndefined();
    expect(fileDetail.semanticScore).toBeUndefined();
  });

  it("falls back to BM25 when embedding returns wrong vector count", async () => {
    // With chunking: 2 files × 1 chunk = 2 chunks → need query + 2 = 3 vectors
    // Stub returns only 1 → triggers wrong-count fallback
    const tool = createIntentReadTool(
      () => makeReadTool({ "/a": "auth", "/b": "db" }) as any,
      makeWrongCountEmbedder(1),
    );

    const result = await tool.execute(
      "id",
      { query: "auth", files: [{ path: "/a" }, { path: "/b" }] },
      undefined,
      undefined,
      { cwd: "/" } as any,
    );

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

    const result = await tool.execute(
      "id",
      { query: "auth", files: [{ path: "/a" }] },
      undefined,
      undefined,
      { cwd: "/" } as any,
    );

    const text = (result.content[0] as any).text as string;
    expect(text).toBe("");
    const details = result.details as any;
    expect(details.successCount).toBe(0);
    expect(details.embeddingStatus).toBe("ok");
  });

  it("ranks by keyword relevance when embedding fails", async () => {
    const tool = createIntentReadTool(
      () => makeReadTool({ "/a": "auth auth auth middleware", "/b": "database schema migration" }) as any,
      makeFailingEmbedder("rate limited"),
    );

    const result = await tool.execute(
      "id",
      { query: "auth", files: [{ path: "/a" }, { path: "/b" }] },
      undefined,
      undefined,
      { cwd: "/" } as any,
    );

    const text = (result.content[0] as any).text as string;
    const posA = text.indexOf("@/a");
    const posB = text.indexOf("@/b");
    expect(posA).toBeGreaterThanOrEqual(0);
    expect(posB).toBeGreaterThan(posA);

    const details = result.details as any;
    const fileA = details.files.find((f: any) => f.path === "/a");
    const fileB = details.files.find((f: any) => f.path === "/b");
    expect(fileA.keywordScore).toBeGreaterThan(fileB.keywordScore);
  });
});

describe("intent_read: Phase 2 ranking observability", () => {
  it("includes chunkIndex, chunkScore, and rankedBy for successful files with embeddings", async () => {
    // 2 files × 1 chunk = 2 chunks → need query + 2 = 3 vectors
    const tool = createIntentReadTool(
      () => makeReadTool({ "/a": "auth logic", "/b": "db schema" }) as any,
      makeEmbedder([[1, 0], [1, 0], [0, 1]]),
    );

    const result = await tool.execute(
      "id",
      { query: "auth", files: [{ path: "/a" }, { path: "/b" }] },
      undefined,
      undefined,
      { cwd: "/" } as any,
    );


    const details = result.details as any;
    const fileA = details.files.find((f: any) => f.path === "/a");
    const fileB = details.files.find((f: any) => f.path === "/b");

    expect(fileA.chunkIndex).toBe(0);
    expect(typeof fileA.chunkScore).toBe("number");
    expect(fileA.rankedBy).toBe("hybrid");

    // fileB got -Infinity semantic score, still hybrid (embeddings succeeded)
    expect(fileB.rankedBy).toBe("hybrid");
  });

  it("includes chunkingEnabled and chunkInfo when embeddings succeed", async () => {
    const tool = createIntentReadTool(
      () => makeReadTool({ "/a": "test content" }) as any,
      makeEmbedder([[1, 0], [1, 0]]),
    );

    const result = await tool.execute(
      "id",
      { query: "test", files: [{ path: "/a" }] },
      undefined,
      undefined,
      { cwd: "/" } as any,
    );

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
      expect(typeof best.score).toBe("number");
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

    const result = await tool.execute(
      "id",
      { query: "auth", files: [{ path: "/a" }] },
      undefined,
      undefined,
      { cwd: "/" } as any,
    );

    const details = result.details as any;
    expect(details.chunkingEnabled).toBe(false);
    expect(details.chunkInfo).toBeUndefined();
    const fileA = details.files.find((f: any) => f.path === "/a");
    expect(fileA.rankedBy).toBe("bm25");
  });
});

describe("intent_read: Phase 4 filename prefilter in directory mode", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "intent-read-dir-test-"));
    writeFileSync(join(tmpDir, "auth.ts"), "auth code");
    writeFileSync(join(tmpDir, "main.ts"), "main code");
    writeFileSync(join(tmpDir, "db.ts"), "db code");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("presorts directory files by filename match before ranking", async () => {
    // auth.ts has highest path score for query "auth"
    // All files have same BM25 potential, but path prefilter moves auth.ts first
    const tool = createIntentReadTool(
      () => makeReadTool({
        [join(tmpDir, "auth.ts")]: "auth code",
        [join(tmpDir, "main.ts")]: "main code",
        [join(tmpDir, "db.ts")]: "db code",
      }) as any,
      makeEmbedder([[1, 0], [1, 0], [1, 0], [0, 1]]),
    );

    const result = await tool.execute(
      "id",
      { query: "auth", directory: tmpDir },
      undefined,
      undefined,
      { cwd: "/" } as any,
    );

    const details = result.details as any;
    // First file in output should be auth.ts (highest path token overlap)
    const text = (result.content[0] as any).text as string;
    const firstFilePos = text.indexOf("@");
    const authPos = text.indexOf(join(tmpDir, "auth.ts"));
    // auth.ts path should appear right after the first '@' in the output
    expect(authPos).toBe(firstFilePos + 1);
  });

  it("empty query throws validation error in directory mode", async () => {
    const tool = createIntentReadTool(
      () => makeReadTool({
        [join(tmpDir, "auth.ts")]: "auth code",
        [join(tmpDir, "main.ts")]: "main code",
      }) as any,
      makeEmbedder([[1, 0], [1, 0], [1, 0]]),
    );

    await expect(
      tool.execute(
        "id",
        { query: "   ", directory: tmpDir },
        undefined,
        undefined,
        { cwd: "/" } as any,
      ),
    ).rejects.toThrow(/query/i);
  });
});