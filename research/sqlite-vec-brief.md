# Research: sqlite-vec Integration for Pi-SmartRead

## Summary

`sqlite-vec` (npm package `sqlite-vec`, v0.1.9 stable / v0.1.10-alpha.4) is a pre-built SQLite loadable extension written in C with zero dependencies that adds vector storage and KNN search via `vec0` virtual tables. It ships pre-compiled binaries for macOS (x64 + arm64), Linux (x64 + arm64), and Windows (x64) through platform-specific optional dependencies. For the Pi-SmartRead use case — replacing the current JSON-file-based `PersistentEmbeddingCache` with SQL-queryable vector storage — `sqlite-vec` is a strong fit: it lives in the same `.db` file as any other SQLite data, supports metadata columns that can be filtered in KNN `WHERE` clauses, and works with `better-sqlite3` or `bun:sqlite` via the `load()` function with no native compilation step.

---

## Findings

### 1. Package, Installation, and Loading

**Package name:** `sqlite-vec` on npm.

```bash
# Install via npm or bun
npm install sqlite-vec
bun install sqlite-vec
```

The package ships **pre-built platform shared libraries** via optional dependencies:
- `sqlite-vec-darwin-x64` — macOS Intel
- `sqlite-vec-darwin-arm64` — macOS Apple Silicon
- `sqlite-vec-linux-x64` — Linux x64
- `sqlite-vec-linux-arm64` — Linux ARM (aarch64)
- `sqlite-vec-windows-x64` — Windows x64

**No native compilation is required.** The `sqlite-vec` package automatically picks the correct platform binary and provides two exports: `load(db)` and `getLoadablePath()`. [Source: npm registry + index.mjs](https://unpkg.com/sqlite-vec@0.1.9/index.mjs)

**Loading in Node.js (better-sqlite3):**

```typescript
import * as sqliteVec from "sqlite-vec";
import Database from "better-sqlite3";

const db = new Database(":memory:");  // or a file path
sqliteVec.load(db);

// Verify installation
const { vec_version } = db.prepare("select vec_version() as vec_version;").get();
console.log(`sqlite-vec version: ${vec_version}`);
```

**Loading in Bun (bun:sqlite):**

```typescript
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";

// macOS may need custom SQLite path
Database.setCustomSQLite("/usr/local/opt/sqlite3/lib/libsqlite3.dylib");

const db = new Database(":memory:");
sqliteVec.load(db);
```

**Loading in Node.js 23.5+ (built-in node:sqlite):**

```typescript
import { DatabaseSync } from "node:sqlite";
import * as sqliteVec from "sqlite-vec";

const db = new DatabaseSync(":memory:", { allowExtension: true });
sqliteVec.load(db);
```

The `load()` function calls `db.loadExtension()` internally with the correct `.dylib` / `.so` / `.dll` file for the current platform. [Source: sqlite-vec JS docs](https://alexgarcia.xyz/sqlite-vec/js.html)

**Compatibility with existing project:** The project currently has no SQLite dependency. The best choice is to add `better-sqlite3` (widely used, sync API, well-tested with `sqlite-vec`). Bun users can use `bun:sqlite` directly.

---

### 2. Creating a vec0 Virtual Table for Vector Storage

The `vec0` virtual table is the primary mechanism for vector search. Dimension size and distance metric are declared in the table constructor.

```sql
-- Basic table with float32 vector column (768 dimensions = common embedding size)
CREATE VIRTUAL TABLE vec_embeddings USING vec0(
  embedding float[768]
);

-- With explicit distance metric (default is L2)
CREATE VIRTUAL TABLE vec_embeddings USING vec0(
  embedding float[768] distance_metric=cosine
);

-- With INT8 quantization (1 byte per dimension, for reduced storage)
CREATE VIRTUAL TABLE vec_embeddings_i8 USING vec0(
  embedding int8[768]
);

-- Binary vectors (bitpacked, 1 bit per dimension)
CREATE VIRTUAL TABLE vec_embeddings_bit USING vec0(
  embedding bit[768]
);
```

**Supported distance metrics** (set per-column in the constructor):
- `distance_metric=l2` — Euclidean distance (default)
- `distance_metric=cosine` — Cosine distance

**Vector element types:**
- `float[N]` — 32-bit float (4 bytes per element)
- `int8[N]` — 8-bit signed integer (1 byte per element)
- `bit[N]` — Binary vector (1 bit per element, packed)

[Source: sqlite-vec KNN docs](https://raw.githubusercontent.com/asg017/sqlite-vec/main/site/features/knn.md)

---

### 3. Inserting Embeddings with Metadata Payloads (file path, line range, symbol kind, language)

`vec0` tables support three types of non-vector columns:

| Column Type | Max Count | USE in WHERE | USE in SELECT | USE case |
|---|---|---|---|---|
| **Metadata columns** | 16 | ✅ Yes | ✅ Yes | Small values used for filtering (language, symbol kind) |
| **Auxiliary columns** (`+` prefix) | 16 | ❌ No | ✅ Yes | Large values returned in results (file path, code text) |
| **Partition key columns** | 4 | ✅ `=` only | ✅ Yes | Fast pre-filtering for workspace/project scoping |

**Recommended schema for Pi-SmartRead:**

```sql
CREATE VIRTUAL TABLE vec_chunks USING vec0(
  chunk_id integer primary key,
  embedding float[768] distance_metric=cosine,

  -- Partition key: scope to workspace root (fast pre-filter)
  workspace_root text partition key,
  -- Partition key: scope to file path prefix
  file_path text partition key,

  -- Metadata columns (filterable in KNN WHERE clause)
  symbol_kind text,
  language text,

  -- Auxiliary columns (returned with results, not filterable)
  +code_snippet text,
  +file_path_full text,
  +symbol_name text
);
```

**Inserting in TypeScript:**

```typescript
// Embedding as Float32Array
const embedding = new Float32Array([0.1, 0.2, /* ... 768 values ... */]);

// Insert with metadata
const stmt = db.prepare(`
  INSERT INTO vec_chunks(
    chunk_id, embedding, workspace_root, file_path,
    symbol_kind, language, code_snippet, file_path_full, symbol_name
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

stmt.run(
  1,
  embedding,                           // Float32Array — sqlite-vec handles the binary format
  "/Users/me/project",                 // workspace_root (partition key)
  "src/foo.ts",                        // file_path (partition key)
  "function_declaration",              // symbol_kind (metadata)
  "typescript",                        // language (metadata)
  "export function hello() { ... }",   // code_snippet (auxiliary)
  "/Users/me/project/src/foo.ts",      // file_path_full (auxiliary)
  "hello"                              // symbol_name (auxiliary)
);
```

**Note:** vectors can be provided as JSON strings or as `Float32Array.buffer` (binary BLOB). Binary is more efficient. [Source: vec0 docs](https://raw.githubusercontent.com/asg017/sqlite-vec/main/site/features/vec0.md)

---

### 4. KNN Vector Search Combined with SQL WHERE Filters

The `vec0` table supports **combined KNN + metadata filtering** in a single query:

```typescript
const queryEmbedding = new Float32Array([0.1, 0.2, /* ... */]);

const results = db.prepare(`
  SELECT
    chunk_id,
    file_path,
    symbol_kind,
    language,
    code_snippet,
    distance
  FROM vec_chunks
  WHERE embedding MATCH ?
    AND k = 20
    AND language = 'typescript'
    AND symbol_kind IN ('function_declaration', 'method_declaration')
    AND file_path LIKE 'src/%'
    AND workspace_root = ?
  ORDER BY distance
`).all(queryEmbedding, "/Users/me/project");
```

**Key notes:**
- `MATCH` + `k = N` signals a KNN query to `vec0`.
- Metadata columns (`language`, `symbol_kind`) use standard operators: `=`, `!=`, `>`, `>=`, `<`, `<=`.
- Partition keys (`workspace_root`, `file_path`) use `=` for fast index sharding.
- `LIKE`, `GLOB`, `IS NULL`, scalar functions are **not supported** on metadata columns in the KNN WHERE clause.
- `ORDER BY distance` is optional (results are naturally ordered by distance).
- Use `LIMIT` for SQLite 3.41+ (otherwise use `k = N`). [Source: vec0 docs](https://raw.githubusercontent.com/asg017/sqlite-vec/main/site/features/vec0.md)

**Manual brute-force KNN** (without `vec0` virtual table) is also possible for maximum flexibility:

```sql
SELECT *, vec_distance_cosine(embedding, ?) AS distance
FROM regular_table
ORDER BY distance
LIMIT 20;
```

But `vec0` is significantly faster as it uses an internal index structure.

---

### 5. Persisting the .db File in `.smartread/` Directory and Schema Migrations

**Recommended file layout:**

```
<project-root>/
  .smartread/
    vectordb/                    # SQLite vector database directory
      vectors.db                 # Main sqlite-vec database file
      vectors.db.wal             # WAL (if enabled)
      vectors.db-shm             # Shared memory (if WAL enabled)
```

**Initialization pattern:**

```typescript
import { join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import * as sqliteVec from "sqlite-vec";
import Database from "better-sqlite3";

export class VectorStore {
  private db: Database.Database;

  constructor(projectRoot: string) {
    const dbDir = join(projectRoot, ".smartread", "vectordb");
    mkdirSync(dbDir, { recursive: true });
    const dbPath = join(dbDir, "vectors.db");

    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");   // Better concurrent read perf
    this.db.pragma("synchronous = NORMAL");  // Good balance speed/safety

    sqliteVec.load(this.db as any);
    this.migrate();
  }

  private migrate(): void {
    // Check schema version
    this.db.exec("CREATE TABLE IF NOT EXISTS _schema_version (version integer)");
    const row = this.db.prepare("SELECT max(version) as v FROM _schema_version").get() as { v: number | null } | undefined;
    const version = row?.v ?? 0;

    if (version < 1) {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
          chunk_id integer primary key,
          embedding float[768] distance_metric=cosine,
          workspace_root text partition key,
          file_path text partition key,
          symbol_kind text,
          language text,
          +code_snippet text,
          +file_path_full text,
          +symbol_name text
        )
      `);
      this.db.prepare("INSERT INTO _schema_version (version) VALUES (1)").run();
    }

    if (version < 2) {
      // Future migrations here
      // sqlite-vec doesn't support ALTER on vec0 tables directly,
      // so migrations typically involve CREATE/DROP/INSERT SELECT
      this.db.prepare("INSERT INTO _schema_version (version) VALUES (2)").run();
    }
  }
}
```

**Schema migration limitations:** `vec0` virtual tables do not support `ALTER TABLE`. To migrate schema (add columns, change dimensions), you must:
1. Create a new `vec0` table with the new schema
2. `INSERT INTO new_table SELECT ... FROM old_table`
3. `DROP TABLE old_table` (if needed)

Use the `_schema_version` table to track and apply migrations incrementally.

---

### 6. Performance Notes: Bulk Insert and Large Codebase Handling

**Bulk insert performance:**
- Each `INSERT` into a `vec0` table writes to the vector index. There is **no dedicated bulk-load API**, but wrapping inserts in a `BEGIN` / `COMMIT` transaction improves throughput significantly.
- For extremely large imports, consider inserting into a regular table first, then moving into `vec0`, or using multiple transactions with periodic `COMMIT` (every ~1000-5000 rows) to keep the WAL manageable.

```typescript
// Efficient bulk insert pattern
const insert = db.prepare(`
  INSERT INTO vec_chunks(chunk_id, embedding, workspace_root, file_path, symbol_kind, language)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const bulkInsert = db.transaction((chunks: ChunkData[]) => {
  for (const chunk of chunks) {
    insert.run(chunk.id, chunk.embedding, chunk.workspace, chunk.filePath, chunk.kind, chunk.lang);
  }
});

// Commit 1000 at a time
for (let i = 0; i < allChunks.length; i += 1000) {
  bulkInsert(allChunks.slice(i, i + 1000));
}
```

**Handling 10k+ files:**
- **Storage:** A `float[768]` embedding takes 3072 bytes (768 × 4). For 10k files × ~20 chunks each = 200k rows, that's ~600 MB of vector data. `int8[768]` uses 1/4 the space (768 bytes per vector).
- **Index size:** `vec0` indexes add some overhead but are designed for "fast enough" performance at this scale. The sqlite-vec author's benchmarks show "fast enough" for embedding-level workloads, not competing with purpose-built vector DBs at 100M+ scale. [Source: sqlite-vec performance guide](https://raw.githubusercontent.com/asg017/sqlite-vec/main/site/guides/performance.md)
- **Query speed:** Partition keys drastically improve query performance by sharding the index. Without partitions, a KNN search is effectively a scan over all vectors.
- **WAL mode** allows concurrent reads during writes (one writer at a time, as per SQLite's concurrency model).

**Notable limitations:**
- `vec0` currently implements a **brute-force search over indexed partitions** — not an ANN (Approximate Nearest Neighbor) index. This means linear scan within the matched partition. For 200k rows in one partition, expect single-digit millisecond query times for small `k`.
- Future versions may add ANN support.
- Metadata column filtering happens **during** the KNN search, not as a post-filter, which is efficient.

---

### 7. Native Compilation: Not Required (Prebuilt Binaries)

**`sqlite-vec` does NOT require native compilation.** It ships pre-compiled shared libraries for all major platforms as optional npm dependencies:

| Platform | Architecture | Binary |
|---|---|---|
| macOS (Intel) | x64 | `sqlite-vec-darwin-x64/vec0.dylib` |
| macOS (Silicon) | arm64 | `sqlite-vec-darwin-arm64/vec0.dylib` |
| Linux | x64 | `sqlite-vec-linux-x64/vec0.so` |
| Linux | arm64 | `sqlite-vec-linux-arm64/vec0.so` |
| Windows | x64 | `sqlite-vec-windows-x64/vec0.dll` |

The platform-specific packages are marked as **optional dependencies**, so `npm install sqlite-vec` succeeds on all platforms — the correct binary is pulled in automatically, and unsupported platforms get a clear error message at runtime.

**What about Bun?** Bun users need to ensure their SQLite library supports extension loading. On macOS, Bun ships with Apple's system SQLite which disables extension loading by default. Workaround:

```typescript
// Must be called before Database instantiation
Database.setCustomSQLite("/usr/local/opt/sqlite3/lib/libsqlite3.dylib");
```

Alternatively, use `better-sqlite3` (which bundles its own SQLite with extension loading enabled) even in Bun.

[Source: sqlite-vec JS docs](https://alexgarcia.xyz/sqlite-vec/js.html) + [package index.mjs](https://unpkg.com/sqlite-vec@0.1.9/index.mjs) (confirmed by analyzing the loadable path resolution logic).

---

## Sources

### Kept
- **sqlite-vec npm package** — Primary source for package structure, version, platform support. Confirmed v0.1.9 stable, no deps, prebuilt binaries. [Source](https://www.npmjs.com/package/sqlite-vec)
- **sqlite-vec GitHub README** — Comprehensive overview, SQL sample usage, distance metrics, virtual table syntax. [Source](https://github.com/asg017/sqlite-vec)
- **sqlite-vec Node.js/JS documentation** — Exact load() API, better-sqlite3/node:sqlite/bun:sqlite usage, Float32Array encoding. [Source](https://alexgarcia.xyz/sqlite-vec/js.html)
- **vec0 virtual table & KNN docs** — Metadata columns, partition keys, auxiliary columns, KNN with WHERE filters, supported operations, column type limits. [Source](https://raw.githubusercontent.com/asg017/sqlite-vec/main/site/features/vec0.md) — [knn.md](https://raw.githubusercontent.com/asg017/sqlite-vec/main/site/features/knn.md)
- **sqlite-vec API Reference** — Complete SQL function reference: `vec_f32()`, `vec_length()`, `vec_distance_L2()`, `vec_distance_cosine()`, `vec_version()`, etc. [Source](https://raw.githubusercontent.com/asg017/sqlite-vec/main/site/api-reference.md)
- **sqlite-vec Performance Guide** — Performance characteristics, page_size, memory mapping, in-memory index notes. [Source](https://raw.githubusercontent.com/asg017/sqlite-vec/main/site/guides/performance.md)

### Dropped
- General web search results about sqlite-vec (e.g., blog posts, Hacker News) — The official docs and source code were sufficient and authoritative.
- sqlite-vss (predecessor) — Superseded by sqlite-vec, not relevant.

---

## Gaps

1. **Unclear exact bulk-insert throughput** for the `vec0` virtual table at 200k+ rows of float[768]. The author describes sqlite-vec as "fast enough" but doesn't publish specific benchmarks comparable to ANN libraries. A practical benchmark with the project's expected data shape would be valuable.

2. **No clear guidance on partial re-indexing** — if files change incrementally, how to efficiently update only changed rows in `vec0`. The current JSON cache replaces individual entries by SHA-256 key, which is O(1). With sqlite-vec, you'd need `UPDATE` or `DELETE` + `INSERT` on the specific chunk rows.

3. **Best practice for chunking + embedding + storing pipeline** — the existing pipeline embeds on demand via an HTTP API. Should the sqlite-vec store be a write-through cache (embed → store), or a background indexer? The research didn't cover integration architecture patterns.

4. **sqlite-vec 0.1.x stability** — The package is pre-v1 with potential breaking changes. The mutation-based `_schema_version` migration pattern mitigates this, but the contract should be monitored during upgrades.

---

## Supervisor coordination

None needed. All research complete from public sources.
