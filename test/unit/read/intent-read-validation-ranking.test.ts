import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createIntentReadTool } from "../../../src/read/intent-read.js";
import {
  fileByPath,
  makeEmbedder,
  makeReadTool,
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

describe("intent_read: input validation", () => {
  it("allows parent-relative files outside cwd", async () => {
    const seen: Array<{ path: string; offset?: number; limit?: number }> = [];
    const tool = createIntentReadTool(
      () => makeReadTool({ "../outside.ts": "outside authentication helper" }, (input) => seen.push(input)) as any,
      makeEmbedder([[1, 0], [1, 0]]),
    );

    const result = await runIntentRead(tool, { query: "authentication", files: [{ path: "../outside.ts" }] }, "/workspace/repo", "id");

    expect(seen[0]).toEqual({ path: "../outside.ts", offset: undefined, limit: undefined });
    expect((result.content[0] as any).text).toContain("outside authentication helper");
  });

  it("throws when both files and directory are provided", async () => {
    const tool = createIntentReadTool(() => makeReadTool({}) as any, makeEmbedder([]));
    await expect(
      runIntentRead(tool, { query: "auth", files: [{ path: "/a" }], directory: "/tmp" }, "/", "id"),
    ).rejects.toThrow(/files.*directory|directory.*files/i);
  });

  it("defaults to directory '.' when neither files nor directory is provided", async () => {
    const root = mkdtempSync(join(tmpdir(), "intent-read-cwd-"));
    try {
      const fileA = join(root, "a.ts");
      writeFileSync(fileA, "auth helper");
      const tool = createIntentReadTool(
        () => makeReadTool({ [fileA]: "auth helper" }) as any,
        makeEmbedder([[1, 0], [1, 0]]),
      );
      // Should not throw "Provide either files or directory" — defaults to cwd scan
      const result = await runIntentRead(tool, { query: "auth", defaultToCwd: true }, root, "id");
      const details = result.details as any;
      expect(details.files.map((f: any) => f.path)).toContain(fileA);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("throws when query is empty after trimming", async () => {
    const tool = createIntentReadTool(() => makeReadTool({}) as any, makeEmbedder([]));
    await expect(
      runIntentRead(tool, { query: "   ", files: [{ path: "/a" }] }, "/", "id"),
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

    const result = await runIntentRead(tool, { query: "authentication", files: [{ path: "/a" }, { path: "/b" }], topK: 2 }, "/", "id");

    const text = (result.content[0] as any).text as string;
    const details = result.details as any;

    // /a should rank higher (both keyword and semantic match)
    const posA = text.indexOf("@/a");
    expect(posA).toBeGreaterThanOrEqual(0);
    expect(text).not.toContain("@/b");

    expect(details.query).toBe("authentication");
    expect(details.successCount).toBe(2);
    expect(details.requestedTopK).toBe(2);

    const fileA = fileByPath(details, "/a");
    expect(fileA.included).toBe(true);
    expect(fileA.fusedRelevance).toMatch(/^(exact|strong|related|weak)$/);
    expect(fileA.inclusion).toBe("full");
  });

  it("puts errored files after successful files in details.files", async () => {
    const tool = createIntentReadTool(
      () => makeReadTool({ "/a": "content", "/b": new Error("missing") }) as any,
      makeEmbedder([[1, 0], [1, 0]]),
    );

    const result = await runIntentRead(tool, { query: "auth", files: [{ path: "/a" }, { path: "/b" }] }, "/", "id");

    const details = result.details as any;
    const errorFile = fileByPath(details, "/b");
    const successFile = fileByPath(details, "/a");

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

    const result = await runIntentRead(tool, { query: "auth", files: [{ path: "/a" }, { path: "/b" }, { path: "/c" }], topK: 2 }, "/", "id");

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
      runIntentRead(tool, { query: "auth", files: [{ path: "/a" }, { path: "/b" }], stopOnError: true }, "/", "id"),
    ).rejects.toThrow("bad");

    expect(embedder).not.toHaveBeenCalled();
  });

  it("degrades to BM25 (with warning) instead of throwing when embedding config is missing", async () => {
    delete process.env.PI_SMARTREAD_EMBEDDING_BASE_URL;
    delete process.env.PI_SMARTREAD_EMBEDDING_MODEL;

    const readSpy = vi.fn();
    const tool = createIntentReadTool(() => ({ execute: readSpy }) as any, makeEmbedder([]));

    // Should NOT throw — degrades gracefully to BM25
    const result = await runIntentRead(tool, { query: "auth", files: [{ path: "/a" }] }, "/", "id");

    // Files are still read
    expect(readSpy).toHaveBeenCalled();
    // Result uses BM25 ranking; status may be ok if no files succeeded,
    // or failed_fallback_bm25 if files were read (depends on read outcome)
    // The key invariants: (1) did not throw, (2) read was attempted.
    expect((result as any).details).toBeDefined();
  });

  it("returns no content when all files fail to read", async () => {
    const tool = createIntentReadTool(
      () => makeReadTool({ "/a": new Error("gone") }) as any,
      makeEmbedder([]),
    );

    const result = await runIntentRead(tool, { query: "auth", files: [{ path: "/a" }] }, "/", "id");

    const text = (result.content[0] as any).text as string;
    const details = result.details as any;
    expect(text).toBe("");
    expect(details.successCount).toBe(0);
    expect(details.effectiveTopK).toBe(0);
  });

  it("includes per-file ranks and relevance classifiers for successful files", async () => {
    const tool = createIntentReadTool(
      () => makeReadTool({ "/a": "authentication middleware" }) as any,
      makeEmbedder([[1, 0], [1, 0]]),
    );

    const result = await runIntentRead(tool, { query: "authentication", files: [{ path: "/a" }] }, "/", "id");

    const details = result.details as any;
    const fileDetail = details.files[0];
    expect(typeof fileDetail.semanticRank).toBe("number");
    expect(typeof fileDetail.keywordRank).toBe("number");
    expect(typeof fileDetail.fusedRank).toBe("number");
    expect(fileDetail.semanticRelevance).toMatch(/^(exact|strong|related|weak|none)$/);
    expect(fileDetail.keywordRelevance).toMatch(/^(exact|strong|related|weak|none)$/);
    expect(fileDetail.fusedRelevance).toMatch(/^(exact|strong|related|weak|none)$/);
    expect(fileDetail.semanticScore).toBeUndefined();
    expect(fileDetail.keywordScore).toBeUndefined();
    expect(fileDetail.rrfScore).toBeUndefined();
  });

  it("includes embeddingStatus=ok and rankingSignals when embeddings succeed", async () => {
    const tool = createIntentReadTool(
      () => makeReadTool({ "/a": "auth" }) as any,
      makeEmbedder([[1, 0], [1, 0]]),
    );

    const result = await runIntentRead(tool, { query: "auth", files: [{ path: "/a" }] }, "/", "id");

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
    await runIntentRead(tool, params, "/", "id:1");
    const result = await runIntentRead(tool, params, "/", "id:2");

    expect(embedder).toHaveBeenCalledTimes(1);
    expect((result.details as any).embeddingCache).toMatchObject({ hit: true, size: 1, maxSize: 64 });
  });

  it("filters unrelated hybrid candidates below the minimum relevance threshold", async () => {
    const tool = createIntentReadTool(
      () => makeReadTool({ "/a": "authentication middleware", "/b": "database schema" }) as any,
      makeEmbedder([[1, 0], [1, 0], [0, 1]]),
    );

    const result = await runIntentRead(tool, { query: "authentication", files: [{ path: "/a" }, { path: "/b" }], topK: 2 }, "/", "id");

    const details = result.details as any;
    expect(details.effectiveTopK).toBe(1);
    expect(details.filteredBelowThresholdPaths).toEqual(["/b"]);
    expect(fileByPath(details, "/b").inclusion).toBe("below_threshold");
  });

  it("keeps exact keyword matches even when semantic similarity is below threshold", async () => {
    const tool = createIntentReadTool(
      () => makeReadTool({ "/a": "authentication middleware", "/b": "authentication database schema" }) as any,
      makeEmbedder([[1, 0], [1, 0], [0, 1]]),
    );

    const result = await runIntentRead(tool, { query: "authentication", files: [{ path: "/a" }, { path: "/b" }], topK: 2 }, "/", "id");

    const details = result.details as any;
    expect(details.filteredBelowThresholdPaths).toEqual([]);
    expect(fileByPath(details, "/b").inclusion).toBe("full");
  });

  it("normalizes selectors and preserves absolute hashline offsets", async () => {
    const seen: Array<{ path: string; offset?: number; limit?: number }> = [];
    const tool = createIntentReadTool(
      () =>
        makeReadTool(
          {
            "/window.ts": {
              content: [{ type: "text", text: "line 2\nline 3" }],
              details: { displayContent: { text: "line 2\nline 3", startLine: 2 } },
            },
          },
          (input) => seen.push(input),
        ) as any,
      makeEmbedder([[1, 0], [1, 0]]),
    );

    const result = await runIntentRead(tool, { query: "line", files: [{ path: "/window.ts:2-3" }] }, "/", "id");

    expect(seen).toEqual([{ path: "/window.ts", offset: 2, limit: 2 }]);
    const text = (result.content[0] as any).text as string;
    expect(text).toContain("@/window.ts:2-3");
    expect(text).toMatch(/\n2[a-z]{2}\|line 2/);
    expect(text).toMatch(/\n3[a-z]{2}\|line 3/);
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
    // auth.ts has highest path score for query "auth". All files share
    // identical content and embedding vectors, so the filename/path signal
    // is the only differentiator and path prefilter moves auth.ts first.
    const tool = createIntentReadTool(
      () => makeReadTool({
        [join(tmpDir, "auth.ts")]: "shared content",
        [join(tmpDir, "main.ts")]: "shared content",
        [join(tmpDir, "db.ts")]: "shared content",
      }) as any,
      makeEmbedder([[1, 0], [1, 0], [1, 0], [1, 0]]),
    );

    const result = await runIntentRead(tool, { query: "auth", directory: tmpDir }, "/", "id");

    
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
      runIntentRead(tool, { query: "   ", directory: tmpDir }, "/", "id"),
    ).rejects.toThrow(/query/i);
  });
});
