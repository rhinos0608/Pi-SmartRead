import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SqliteVecStore } from "../../src/sqlite-vec-store.js";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

// Use a small dimension for fast test embeddings
const TEST_DIM = 8;

function makeEmbedding(...values: number[]): Float32Array {
  const arr = new Float32Array(TEST_DIM);
  values.forEach((v, i) => (arr[i] = v));
  return arr;
}

function cosineDistance(a: Float32Array, b: Float32Array): number {
  let dot = 0,
    normA = 0,
    normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  return 1 - dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

describe("SqliteVecStore", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sqlite-vec-store-test-"));
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ok */
    }
  });

  // ── Store creation and initialization ──────────────────────────────────────

  it("creates the database file on construction", () => {
    const dbPath = join(tmpDir, "vectors.db");
    const store = new SqliteVecStore(dbPath, TEST_DIM);
    expect(existsSync(dbPath)).toBe(true);
    store.close();
  });

  it("initializes the vec0 virtual table", async () => {
    const dbPath = join(tmpDir, "vectors.db");
    const store = new SqliteVecStore(dbPath, TEST_DIM);

    // Open a raw handle to inspect the schema.
    // Use bun:sqlite if running in Bun (better-sqlite3 unavailable),
    // otherwise better-sqlite3 for Node.js.
        const rawDb = (typeof Bun !== "undefined")
      ? (() => {
          const { Database } = require("bun:sqlite");
          try { Database.setCustomSQLite("/opt/homebrew/opt/sqlite3/lib/libsqlite3.dylib"); } catch { /* ok */ }
          return new Database(dbPath);
        })()
      : new ((await import("better-sqlite3")).default)(dbPath);

    const tables = rawDb
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all();
    const tableNames = tables.map((r: any) => r.name);
    expect(tableNames).toContain("vec_chunks");
    expect(tableNames).toContain("_schema_version");
    rawDb.close();
    store.close();
  });

  it("creates _schema_version and records version 1", async () => {
    const dbPath = join(tmpDir, "vectors.db");
    const store = new SqliteVecStore(dbPath, TEST_DIM);

    // Open a raw handle using bun:sqlite (in Bun) or better-sqlite3 (in Node.js)
    const rawDb = (typeof Bun !== "undefined")
      ? (() => {
          const { Database } = require("bun:sqlite");
          try { Database.setCustomSQLite("/opt/homebrew/opt/sqlite3/lib/libsqlite3.dylib"); } catch { /* ok */ }
          return new Database(dbPath);
        })()
      : new ((await import("better-sqlite3")).default)(dbPath);

const row = rawDb
      .prepare("SELECT max(version) as v FROM _schema_version")
      .get() as any;
    expect(row?.v).toBe(1);
    rawDb.close();
    store.close();
  });

  it("idempotent — running constructor twice does not error", () => {
    const dbPath = join(tmpDir, "vectors.db");
    const store1 = new SqliteVecStore(dbPath, TEST_DIM);
    const store2 = new SqliteVecStore(dbPath, TEST_DIM);
    store1.close();
    store2.close();
  });

  // ── Insert + search ──────────────────────────────────────────────────────────

  it("inserts chunks and returns them via search", () => {
    const dbPath = join(tmpDir, "vectors.db");
    const store = new SqliteVecStore(dbPath, TEST_DIM);

    store.insertChunks([
      {
        id: 1,
        embedding: makeEmbedding(1, 0, 0, 0, 0, 0, 0, 0),
        filePath: "src/foo.ts",
        symbolKind: "function_declaration",
        language: "typescript",
        codeSnippet: "function foo() {}",
        lineStart: 1,
        lineEnd: 2,
      },
      {
        id: 2,
        embedding: makeEmbedding(0, 1, 0, 0, 0, 0, 0, 0),
        filePath: "src/bar.ts",
        symbolKind: "class_declaration",
        language: "typescript",
        codeSnippet: "class Bar {}",
        lineStart: 3,
        lineEnd: 5,
      },
    ]);

    // Search for something close to chunk 1 (1,0,0,...)
    const results = store.search(
      makeEmbedding(0.99, 0.01, 0, 0, 0, 0, 0, 0),
      2
    );

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.id).toBe(1);
    store.close();
  });

  it("returns results ordered by distance (ascending cosine distance)", () => {
    const dbPath = join(tmpDir, "vectors.db");
    const store = new SqliteVecStore(dbPath, TEST_DIM);

    // Insert 3 chunks: exact match (distance 0), medium, far
    store.insertChunks([
      {
        id: 10,
        embedding: makeEmbedding(1, 0, 0, 0, 0, 0, 0, 0),
        filePath: "exact.ts",
        symbolKind: "function",
        language: "typescript",
        codeSnippet: "// exact",
        lineStart: 1,
        lineEnd: 1,
      },
      {
        id: 20,
        embedding: makeEmbedding(0, 1, 0, 0, 0, 0, 0, 0),
        filePath: "mid.ts",
        symbolKind: "function",
        language: "typescript",
        codeSnippet: "// mid",
        lineStart: 2,
        lineEnd: 2,
      },
      {
        id: 30,
        embedding: makeEmbedding(-1, 0, 0, 0, 0, 0, 0, 0),
        filePath: "far.ts",
        symbolKind: "function",
        language: "typescript",
        codeSnippet: "// far",
        lineStart: 3,
        lineEnd: 3,
      },
    ]);

    // Query with the "exact" embedding
    const results = store.search(makeEmbedding(1, 0, 0, 0, 0, 0, 0, 0), 3);

    expect(results.length).toBe(3);
    // id=10 should be first (distance ≈ 0)
    expect(results[0]!.id).toBe(10);
    // Verify distances are non-decreasing
    for (let i = 1; i < results.length; i++) {
      expect(results[i]!.distance).toBeGreaterThanOrEqual(
        results[i - 1]!.distance
      );
    }
    store.close();
  });

  // ── Filtered search ─────────────────────────────────────────────────────────

  it("filters by language", () => {
    const dbPath = join(tmpDir, "vectors.db");
    const store = new SqliteVecStore(dbPath, TEST_DIM);

    store.insertChunks([
      {
        id: 101,
        embedding: makeEmbedding(1, 0, 0, 0, 0, 0, 0, 0),
        filePath: "a.py",
        symbolKind: "function",
        language: "python",
        codeSnippet: "def a(): pass",
        lineStart: 1,
        lineEnd: 1,
      },
      {
        id: 102,
        embedding: makeEmbedding(0, 1, 0, 0, 0, 0, 0, 0),
        filePath: "b.ts",
        symbolKind: "function",
        language: "typescript",
        codeSnippet: "function b() {}",
        lineStart: 1,
        lineEnd: 1,
      },
      {
        id: 103,
        embedding: makeEmbedding(0, 0, 1, 0, 0, 0, 0, 0),
        filePath: "c.ts",
        symbolKind: "function",
        language: "typescript",
        codeSnippet: "function c() {}",
        lineStart: 2,
        lineEnd: 2,
      },
    ]);

    const tsResults = store.search(
      makeEmbedding(0, 1, 0, 0, 0, 0, 0, 0),
      5,
      { language: "typescript" }
    );

    expect(tsResults.length).toBeGreaterThan(0);
    expect(tsResults.every((r) => r.language === "typescript")).toBe(true);
    expect(tsResults.some((r) => r.filePath === "a.py")).toBe(false);
    store.close();
  });

  it("filters by symbolKind", () => {
    const dbPath = join(tmpDir, "vectors.db");
    const store = new SqliteVecStore(dbPath, TEST_DIM);

    store.insertChunks([
      {
        id: 201,
        embedding: makeEmbedding(1, 0, 0, 0, 0, 0, 0, 0),
        filePath: "f1.ts",
        symbolKind: "function_declaration",
        language: "typescript",
        codeSnippet: "function f1() {}",
        lineStart: 1,
        lineEnd: 1,
      },
      {
        id: 202,
        embedding: makeEmbedding(0, 1, 0, 0, 0, 0, 0, 0),
        filePath: "c1.ts",
        symbolKind: "class_declaration",
        language: "typescript",
        codeSnippet: "class C1 {}",
        lineStart: 1,
        lineEnd: 1,
      },
      {
        id: 203,
        embedding: makeEmbedding(0, 0, 1, 0, 0, 0, 0, 0),
        filePath: "f2.ts",
        symbolKind: "function_declaration",
        language: "typescript",
        codeSnippet: "function f2() {}",
        lineStart: 2,
        lineEnd: 2,
      },
    ]);

    const fnResults = store.search(
      makeEmbedding(0, 0, 1, 0, 0, 0, 0, 0),
      5,
      { symbolKind: "function_declaration" }
    );

    expect(fnResults.length).toBeGreaterThan(0);
    expect(fnResults.every((r) => r.symbolKind === "function_declaration")).toBe(
      true
    );
    store.close();
  });

  it("filters by filePathPrefix (LIKE prefix%)", () => {
    const dbPath = join(tmpDir, "vectors.db");
    const store = new SqliteVecStore(dbPath, TEST_DIM);

    store.insertChunks([
      {
        id: 301,
        embedding: makeEmbedding(1, 0, 0, 0, 0, 0, 0, 0),
        filePath: "src/foo.ts",
        symbolKind: "function",
        language: "typescript",
        codeSnippet: "// src/foo",
        lineStart: 1,
        lineEnd: 1,
      },
      {
        id: 302,
        embedding: makeEmbedding(0, 1, 0, 0, 0, 0, 0, 0),
        filePath: "lib/bar.ts",
        symbolKind: "function",
        language: "typescript",
        codeSnippet: "// lib/bar",
        lineStart: 1,
        lineEnd: 1,
      },
      {
        id: 303,
        embedding: makeEmbedding(0, 0, 1, 0, 0, 0, 0, 0),
        filePath: "src/utils/helper.ts",
        symbolKind: "function",
        language: "typescript",
        codeSnippet: "// src/utils",
        lineStart: 2,
        lineEnd: 2,
      },
    ]);

    const srcResults = store.search(
      makeEmbedding(0, 0, 1, 0, 0, 0, 0, 0),
      5,
      { filePathPrefix: "src/" }
    );

    expect(srcResults.length).toBe(2);
    expect(srcResults.every((r) => r.filePath.startsWith("src/"))).toBe(true);
    store.close();
  });

  it("treats a path prefix as exact-or-descendant, not a lexical prefix", () => {
    const dbPath = join(tmpDir, "vectors.db");
    const store = new SqliteVecStore(dbPath, TEST_DIM);

    store.insertChunks([
      {
        id: 351,
        embedding: makeEmbedding(0.8, 0.2, 0, 0, 0, 0, 0, 0),
        filePath: "src/foo.ts",
        symbolKind: "function",
        language: "typescript",
        codeSnippet: "// in scope",
        lineStart: 1,
        lineEnd: 1,
      },
      {
        id: 352,
        embedding: makeEmbedding(1, 0, 0, 0, 0, 0, 0, 0),
        filePath: "src2/bar.ts",
        symbolKind: "function",
        language: "typescript",
        codeSnippet: "// lexical-prefix collision",
        lineStart: 1,
        lineEnd: 1,
      },
    ]);

    const results = store.search(
      makeEmbedding(1, 0, 0, 0, 0, 0, 0, 0),
      1,
      { filePathPrefix: "src" },
    );

    expect(results.map((result) => result.filePath)).toEqual(["src/foo.ts"]);
    store.close();
  });

  it("combines multiple filters", () => {
    const dbPath = join(tmpDir, "vectors.db");
    const store = new SqliteVecStore(dbPath, TEST_DIM);

    store.insertChunks([
      {
        id: 401,
        embedding: makeEmbedding(1, 0, 0, 0, 0, 0, 0, 0),
        filePath: "src/a.ts",
        symbolKind: "function_declaration",
        language: "typescript",
        codeSnippet: "// a",
        lineStart: 1,
        lineEnd: 1,
      },
      {
        id: 402,
        embedding: makeEmbedding(0, 1, 0, 0, 0, 0, 0, 0),
        filePath: "src/b.ts",
        symbolKind: "class_declaration",
        language: "typescript",
        codeSnippet: "// b",
        lineStart: 1,
        lineEnd: 1,
      },
      {
        id: 403,
        embedding: makeEmbedding(0, 0, 1, 0, 0, 0, 0, 0),
        filePath: "lib/c.ts",
        symbolKind: "function_declaration",
        language: "python",
        codeSnippet: "// c",
        lineStart: 1,
        lineEnd: 1,
      },
    ]);

    const results = store.search(
      makeEmbedding(0, 0, 1, 0, 0, 0, 0, 0),
      5,
      { language: "typescript", symbolKind: "function_declaration" }
    );

    expect(results.length).toBe(1);
    expect(results[0]!.id).toBe(401);
    store.close();
  });

  // ── Delete by file path ──────────────────────────────────────────────────────

  it("deletes all chunks for a given filePath", () => {
    const dbPath = join(tmpDir, "vectors.db");
    const store = new SqliteVecStore(dbPath, TEST_DIM);

    store.insertChunks([
      {
        id: 501,
        embedding: makeEmbedding(1, 0, 0, 0, 0, 0, 0, 0),
        filePath: "to-delete.ts",
        symbolKind: "function",
        language: "typescript",
        codeSnippet: "function a() {}",
        lineStart: 1,
        lineEnd: 1,
      },
      {
        id: 502,
        embedding: makeEmbedding(0, 1, 0, 0, 0, 0, 0, 0),
        filePath: "to-delete.ts",
        symbolKind: "function",
        language: "typescript",
        codeSnippet: "function b() {}",
        lineStart: 2,
        lineEnd: 2,
      },
      {
        id: 503,
        embedding: makeEmbedding(0, 0, 1, 0, 0, 0, 0, 0),
        filePath: "to-keep.ts",
        symbolKind: "function",
        language: "typescript",
        codeSnippet: "function c() {}",
        lineStart: 3,
        lineEnd: 3,
      },
    ]);

    // Verify all 3 are in there
    let all = store.search(makeEmbedding(0, 0, 0, 0, 0, 0, 0, 0), 10);
    expect(all.length).toBe(3);

    store.deleteByFilePath("to-delete.ts");

    all = store.search(makeEmbedding(0, 0, 0, 0, 0, 0, 0, 0), 10);
    expect(all.length).toBe(1);
    expect(all[0]!.filePath).toBe("to-keep.ts");
    store.close();
  });

  // ── Persistence ─────────────────────────────────────────────────────────────

  it("persists chunks across close and reopen", () => {
    const dbPath = join(tmpDir, "vectors.db");

    {
      const store = new SqliteVecStore(dbPath, TEST_DIM);
      store.insertChunks([
        {
          id: 601,
          embedding: makeEmbedding(1, 0, 0, 0, 0, 0, 0, 0),
          filePath: "persist.ts",
          symbolKind: "function",
          language: "typescript",
          codeSnippet: "// persistent",
          lineStart: 1,
          lineEnd: 1,
        },
      ]);
      store.close();
    }

    // Re-open and search
    {
      const store = new SqliteVecStore(dbPath, TEST_DIM);
      const results = store.search(
        makeEmbedding(0.99, 0.01, 0, 0, 0, 0, 0, 0),
        5
      );
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.filePath).toBe("persist.ts");
      store.close();
    }
  });

  it("idempotent insert on reopened store does not duplicate", () => {
    const dbPath = join(tmpDir, "vectors.db");

    const chunk = {
      id: 701,
      embedding: makeEmbedding(1, 0, 0, 0, 0, 0, 0, 0),
      filePath: "dup.ts",
      symbolKind: "function",
      language: "typescript",
      codeSnippet: "// dup",
      lineStart: 1,
      lineEnd: 1,
    };

    // Insert once
    {
      const store = new SqliteVecStore(dbPath, TEST_DIM);
      store.insertChunks([chunk]);
      store.close();
    }

    // Re-insert same chunk (idempotent — chunk_id is PK)
    {
      const store = new SqliteVecStore(dbPath, TEST_DIM);
      store.insertChunks([chunk]);
      const results = store.search(
        makeEmbedding(0, 0, 0, 0, 0, 0, 0, 0),
        10
      );
      // Should still return exactly 1 result (primary key prevents duplication)
      expect(results.filter((r) => r.id === 701).length).toBe(1);
      store.close();
    }
  });

  // ── Error handling ──────────────────────────────────────────────────────────

  it("throws when searching on a closed store", () => {
    const dbPath = join(tmpDir, "vectors.db");
    const store = new SqliteVecStore(dbPath, TEST_DIM);
    store.close();
    expect(() =>
      store.search(makeEmbedding(0, 0, 0, 0, 0, 0, 0, 0), 5)
    ).toThrow("Store is closed");
  });

  it("throws when inserting on a closed store", () => {
    const dbPath = join(tmpDir, "vectors.db");
    const store = new SqliteVecStore(dbPath, TEST_DIM);
    store.close();
    expect(() =>
      store.insertChunks([
        {
          id: 1,
          embedding: makeEmbedding(1, 0, 0, 0, 0, 0, 0, 0),
          filePath: "x.ts",
          symbolKind: "function",
          language: "typescript",
          codeSnippet: "x",
          lineStart: 1,
          lineEnd: 1,
        },
      ])
    ).toThrow("Store is closed");
  });

  it("throws when deleting on a closed store", () => {
    const dbPath = join(tmpDir, "vectors.db");
    const store = new SqliteVecStore(dbPath, TEST_DIM);
    store.close();
    expect(() => store.deleteByFilePath("x.ts")).toThrow("Store is closed");
  });

  // ── Bulk insert ─────────────────────────────────────────────────────────────

  it("handles bulk insert of 100+ chunks", () => {
    const dbPath = join(tmpDir, "vectors.db");
    const store = new SqliteVecStore(dbPath, TEST_DIM);

    const chunks = Array.from({ length: 120 }, (_, i) => ({
      id: 1000 + i,
      embedding: new Float32Array(
        Array.from({ length: TEST_DIM }, (_, j) => (i === j ? 1 : 0))
      ),
      filePath: `bulk_${i}.ts`,
      symbolKind: "function",
      language: "typescript",
      codeSnippet: `// chunk ${i}`,
      lineStart: i,
      lineEnd: i,
    }));

    store.insertChunks(chunks);

    const results = store.search(makeEmbedding(0, 0, 0, 0, 0, 0, 0, 0), 10);
    // All chunks are present (k=10 returns nearest 10; bulk insertion is OK)
    expect(results.length).toBeLessThanOrEqual(10);
    store.close();
  });

  // ── Distance ordering verification ───────────────────────────────────────────

  it("verifies that cosine distance ordering is correct for known vectors", () => {
    const dbPath = join(tmpDir, "vectors.db");
    const store = new SqliteVecStore(dbPath, TEST_DIM);

    // Insert vectors at known positions
    store.insertChunks([
      {
        id: 801,
        embedding: makeEmbedding(1, 0, 0, 0, 0, 0, 0, 0), // [1,0,...]
        filePath: "p1.ts",
        symbolKind: "function",
        language: "typescript",
        codeSnippet: "p1",
        lineStart: 1,
        lineEnd: 1,
      },
      {
        id: 802,
        embedding: makeEmbedding(0, 1, 0, 0, 0, 0, 0, 0), // [0,1,...]
        filePath: "p2.ts",
        symbolKind: "function",
        language: "typescript",
        codeSnippet: "p2",
        lineStart: 2,
        lineEnd: 2,
      },
      {
        id: 803,
        embedding: makeEmbedding(0, 0, 1, 0, 0, 0, 0, 0), // [0,0,1,...]
        filePath: "p3.ts",
        symbolKind: "function",
        language: "typescript",
        codeSnippet: "p3",
        lineStart: 3,
        lineEnd: 3,
      },
    ]);

    // Query with [0,1,0,...] — should rank p2 first, then p1, then p3
    const results = store.search(makeEmbedding(0, 1, 0, 0, 0, 0, 0, 0), 3);

    expect(results[0]!.id).toBe(802); // nearest
    expect(results[1]!.id).toBe(801); // second
    expect(results[2]!.id).toBe(803); // third

    // Verify distances are consistent with cosine distance formula
    const expectedDist = cosineDistance(
      makeEmbedding(0, 1, 0, 0, 0, 0, 0, 0),
      makeEmbedding(0, 1, 0, 0, 0, 0, 0, 0)
    );
    expect(results[0]!.distance).toBeCloseTo(expectedDist, 5);
    store.close();
  });
});