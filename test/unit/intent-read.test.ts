import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createIntentReadTool } from "../../intent-read.js";
import type { EmbedRequest, EmbedResult } from "../../embedding.js";

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
  process.env.PI_SMARTREAD_EMBEDDING_BASE_URL = "http://localhost:11434/v1";
  process.env.PI_SMARTREAD_EMBEDDING_MODEL = "nomic-embed-text";
});

afterEach(() => {
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
    expect(posA).toBeGreaterThanOrEqual(0);
    expect(text).not.toContain("@/b");

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
      makeEmbedder([[1, 0], [1, 0], [1, 0], [1, 0]]),
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

  it("reuses cached embedding results for repeated queries over unchanged content", async () => {
    const embedder = vi.fn(makeEmbedder([[1, 0], [1, 0]]));
    const tool = createIntentReadTool(
      () => makeReadTool({ "/a": "authentication middleware" }) as any,
      embedder,
    );

    const params = { query: "authentication", files: [{ path: "/a" }] };
    await tool.execute("id:1", params, undefined, undefined, { cwd: "/" } as any);
    const result = await tool.execute("id:2", params, undefined, undefined, { cwd: "/" } as any);

    expect(embedder).toHaveBeenCalledTimes(1);
    expect((result.details as any).embeddingCache).toMatchObject({ hit: true, size: 1, maxSize: 64 });
  });

  it("filters unrelated hybrid candidates below the minimum relevance threshold", async () => {
    const tool = createIntentReadTool(
      () => makeReadTool({ "/a": "authentication middleware", "/b": "database schema" }) as any,
      makeEmbedder([[1, 0], [1, 0], [0, 1]]),
    );

    const result = await tool.execute(
      "id",
      { query: "authentication", files: [{ path: "/a" }, { path: "/b" }], topK: 2 },
      undefined,
      undefined,
      { cwd: "/" } as any,
    );

    const details = result.details as any;
    expect(details.effectiveTopK).toBe(1);
    expect(details.filteredBelowThresholdPaths).toEqual(["/b"]);
    expect(details.files.find((f: any) => f.path === "/b").inclusion).toBe("below_threshold");
  });

  it("keeps exact keyword matches even when semantic similarity is below threshold", async () => {
    const tool = createIntentReadTool(
      () => makeReadTool({ "/a": "authentication middleware", "/b": "authentication database schema" }) as any,
      makeEmbedder([[1, 0], [1, 0], [0, 1]]),
    );

    const result = await tool.execute(
      "id",
      { query: "authentication", files: [{ path: "/a" }, { path: "/b" }], topK: 2 },
      undefined,
      undefined,
      { cwd: "/" } as any,
    );

    const details = result.details as any;
    expect(details.filteredBelowThresholdPaths).toEqual([]);
    expect(details.files.find((f: any) => f.path === "/b").inclusion).toBe("full");
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
      () => makeReadTool({ "/a": "auth middleware", "/b": "auth database schema migration" }) as any,
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

describe("intent_read: graph-neighbour augmentation", () => {
  it("adds direct relative import neighbours when file mode leaves candidate slots", async () => {
    const root = mkdtempSync(join(tmpdir(), "intent-read-graph-"));
    try {
      const fileA = join(root, "a.ts");
      const fileB = join(root, "b.ts");
      writeFileSync(fileA, "import { helper } from './b';\nexport const auth = helper();\n");
      writeFileSync(fileB, "export function helper() { return 'authentication helper'; }\n");

      const tool = createIntentReadTool(
        () => makeReadTool({ [fileA]: "authentication entry", [fileB]: "authentication helper" }) as any,
        makeEmbedder([[1, 0], [1, 0], [1, 0]]),
      );

      const result = await tool.execute(
        "id",
        { query: "authentication", files: [{ path: fileA }], topK: 2 },
        undefined,
        undefined,
        { cwd: root } as any,
      );

      const details = result.details as any;
      expect(details.graphAugmentation.addedPaths).toEqual([fileB]);
      expect(details.files.map((f: any) => f.path)).toContain(fileB);
      expect((result.content[0] as any).text).toContain(`@${fileB}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("caps graph neighbours at the remaining 20-file budget", async () => {
    const root = mkdtempSync(join(tmpdir(), "intent-read-graph-cap-"));
    try {
      const files: string[] = [];
      const readMap: Record<string, string> = {};
      for (let i = 0; i < 22; i++) {
        const path = join(root, `${i}.ts`);
        files.push(path);
        readMap[path] = `authentication ${i}`;
      }
      writeFileSync(files[0]!, "import './19';\nimport './20';\nimport './21';\nexport const zero = true;\n");
      for (let i = 1; i < 22; i++) writeFileSync(files[i]!, `export const value${i} = true;\n`);

      const tool = createIntentReadTool(
        () => makeReadTool(readMap) as any,
        async (req: EmbedRequest) => ({ vectors: Array.from({ length: req.inputs.length }, () => [1, 0]) }),
      );

      const result = await tool.execute(
        "id",
        { query: "authentication", files: files.slice(0, 18).map((path) => ({ path })), topK: 20 },
        undefined,
        undefined,
        { cwd: root } as any,
      );

      const details = result.details as any;
      expect(details.processedCount).toBe(20);
      expect(details.graphAugmentation.addedPaths).toEqual([files[19], files[20]]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not add graph neighbours outside the workspace", async () => {
    const parent = mkdtempSync(join(tmpdir(), "intent-read-graph-escape-"));
    const root = join(parent, "repo");
    try {
      mkdirSync(root);
      const fileA = join(root, "a.ts");
      const outside = join(parent, "outside.ts");
      writeFileSync(fileA, "import '../outside';\nexport const auth = true;\n");
      writeFileSync(outside, "export const secret = true;\n");

      const tool = createIntentReadTool(
        () => makeReadTool({ [fileA]: "authentication entry", [outside]: "secret" }) as any,
        makeEmbedder([[1, 0], [1, 0]]),
      );

      const result = await tool.execute(
        "id",
        { query: "authentication", files: [{ path: fileA }], topK: 2 },
        undefined,
        undefined,
        { cwd: root } as any,
      );

      const details = result.details as any;
      expect(details.graphAugmentation.addedPaths).toEqual([]);
      expect(details.files.map((f: any) => f.path)).not.toContain(outside);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("does not add graph neighbours through symlinks that point outside the workspace", async () => {
    const parent = mkdtempSync(join(tmpdir(), "intent-read-graph-symlink-"));
    const root = join(parent, "repo");
    try {
      mkdirSync(root);
      const fileA = join(root, "a.ts");
      const outside = join(parent, "outside.ts");
      const link = join(root, "linked.ts");
      writeFileSync(fileA, "import './linked';\nexport const auth = true;\n");
      writeFileSync(outside, "export const secret = true;\n");
      symlinkSync(outside, link);

      const tool = createIntentReadTool(
        () => makeReadTool({ [fileA]: "authentication entry", [link]: "secret" }) as any,
        makeEmbedder([[1, 0], [1, 0]]),
      );

      const result = await tool.execute(
        "id",
        { query: "authentication", files: [{ path: fileA }], topK: 2 },
        undefined,
        undefined,
        { cwd: root } as any,
      );

      const details = result.details as any;
      expect(details.graphAugmentation.addedPaths).toEqual([]);
      expect(details.files.map((f: any) => f.path)).not.toContain(link);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("does not add graph neighbours through symlinked directories that point outside the workspace", async () => {
    const parent = mkdtempSync(join(tmpdir(), "intent-read-graph-symlink-dir-"));
    const root = join(parent, "repo");
    const outsideDir = join(parent, "outside-dir");
    try {
      mkdirSync(root);
      mkdirSync(outsideDir);
      const fileA = join(root, "a.ts");
      const outside = join(outsideDir, "helper.ts");
      const linkDir = join(root, "linked-dir");
      const linkedFile = join(linkDir, "helper.ts");
      writeFileSync(fileA, "import './linked-dir/helper';\nexport const auth = true;\n");
      writeFileSync(outside, "export const secret = true;\n");
      symlinkSync(outsideDir, linkDir, "dir");

      const tool = createIntentReadTool(
        () => makeReadTool({ [fileA]: "authentication entry", [linkedFile]: "secret" }) as any,
        makeEmbedder([[1, 0], [1, 0]]),
      );

      const result = await tool.execute(
        "id",
        { query: "authentication", files: [{ path: fileA }], topK: 2 },
        undefined,
        undefined,
        { cwd: root } as any,
      );

      const details = result.details as any;
      expect(details.graphAugmentation.addedPaths).toEqual([]);
      expect(details.files.map((f: any) => f.path)).not.toContain(linkedFile);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
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

      const result = await tool.execute(
        "id",
        { query: "auth", files: [{ path: fileA }, { path: fileB }], topK: 2 },
        undefined,
        undefined,
        { cwd: root } as any,
      );

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

    const result = await tool.execute(
      "id",
      { query: "auth", files: [{ path: "/a" }] },
      undefined,
      undefined,
      { cwd: "/" } as any,
    );

    const details = result.details as any;
    expect(details.reranking).toBeUndefined();
  });

  it("reranking falls back to original order on error", async () => {
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

      const result = await tool.execute(
        "id",
        { query: "auth", files: [{ path: fileA }] },
        undefined,
        undefined,
        { cwd: root } as any,
      );

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

describe("intent_read: graph augmentation observability", () => {
  it("reports graphAugmentation metadata with edgesUsed", async () => {
    const root = mkdtempSync(join(tmpdir(), "intent-read-graph-meta-"));
    try {
      const fileA = join(root, "a.ts");
      const fileB = join(root, "b.ts");
      writeFileSync(fileA, "import { helper } from './b';\nexport const auth = helper();\n");
      writeFileSync(fileB, "export function helper() { return 'authentication helper'; }\n");

      const tool = createIntentReadTool(
        () => makeReadTool({ [fileA]: "authentication entry", [fileB]: "authentication helper" }) as any,
        makeEmbedder([[1, 0], [1, 0], [1, 0]]),
      );

      const result = await tool.execute(
        "id",
        { query: "authentication", files: [{ path: fileA }], topK: 2 },
        undefined,
        undefined,
        { cwd: root } as any,
      );

      const details = result.details as any;
      expect(details.graphAugmentation).toBeDefined();
      expect(details.graphAugmentation.addedPaths).toContain(fileB);
      expect(details.graphAugmentation.candidateCountBefore).toBe(1);
      expect(details.graphAugmentation.candidateCountAfter).toBe(2);
      expect(details.graphAugmentation.edgesUsed).toBeDefined();
      expect(details.graphAugmentation.edgesUsed.length).toBeGreaterThan(0);
      expect(details.graphAugmentation.edgesUsed[0].type).toBe("imports");
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

    const result = await tool.execute(
      "id",
      { query: "auth", files: [{ path: "/a" }] },
      undefined,
      undefined,
      { cwd: "/" } as any,
    );

    const details = result.details as any;
    expect(details.rankingSignals).toEqual({ bm25: true, embeddings: true });
  });

  it("reports embeddings=false when embedding fails", async () => {
    const tool = createIntentReadTool(
      () => makeReadTool({ "/a": "auth code" }) as any,
      makeFailingEmbedder("ECONNREFUSED"),
    );

    const result = await tool.execute(
      "id",
      { query: "auth", files: [{ path: "/a" }] },
      undefined,
      undefined,
      { cwd: "/" } as any,
    );

    const details = result.details as any;
    expect(details.rankingSignals).toEqual({ bm25: true, embeddings: false });
    expect(details.embeddingStatus).toBe("failed_fallback_bm25");
  });
});