# sqlite-vec Integration: Implementation Report

## Created Files

| File | Lines | Description |
|------|-------|-------------|
| `sqlite-vec-store.ts` | 475 | Vector store backed by sqlite-vec |
| `test/unit/sqlite-vec-store.test.ts` | 626 | 18 tests covering all requirements |

## Test Results

```
bun test v1.3.8
18 pass · 0 fail · 18 tests
Ran 18 tests across 1 file. [97ms]
```

All 18 tests pass. The implementation is complete and verified.

## sqlite-vec-store.ts — Key Design Decisions

### SQLite adapter layer

A narrow `SQLiteDatabase` interface wraps either better-sqlite3 (Node.js/vitest workers) or bun:sqlite (Bun fallback). The raw handle is exposed as `db.raw` so `sqliteVec.load()` works on both:

```typescript
function openDatabase(path: string): SQLiteDatabase {
  try {
    const BetterSqlite3 = require("better-sqlite3");
    return makeWrapper(new BetterSqlite3(path));
  } catch (err) {
    if (typeof Bun !== "undefined" && /not yet supported in Bun/i.test(err?.message)) {
      return openBunDatabase(path);
    }
    throw err;
  }
}
```

### Bun + Homebrew SQLite

Bun ships Apple's system SQLite (extension loading disabled on macOS). The factory configures `Database.setCustomSQLite("/opt/homebrew/opt/sqlite3/lib/libsqlite3.dylib")` once per worker via a `bunSqliteConfigured` module-level flag. Tests use the same pattern for their inspection handles.

### Dual data paths

The store probes both `sqliteVec.load()` and `CREATE VIRTUAL TABLE ... USING vec0(...)` on every open. The `_schema_version` table records `vec0_used` to maintain the correct path across reopens:

```typescript
// First open: detect and record
if (version < 1) {
  const loaded = loadVecExtension(); // always try
  if (loaded) {
    try { db.exec("CREATE VIRTUAL TABLE ..."); this.vec0Available = true; }
    catch { /* fall through */ }
  }
  if (!this.vec0Available) { /* regular table + BLOB storage */ }
  db.prepare("INSERT INTO _schema_version (version, vec0_used) VALUES (1, ?)").run(
    this.vec0Available ? 1 : 0
  );
} else {
  // Re-open: trust the flag
  this.vec0Available = vec0UsedPreviously === 1;
}
```

### vec0 path (vec0Available = true)
- Stored as `Float32Array` (sqlite-vec handles the binary format)
- KNN search: `WHERE embedding MATCH ? AND k = N` with optional filter predicates
- Distance: 0 = identical, 2 = opposite

### Fallback path (vec0Available = false)
- Stored as `ArrayBuffer` (BLOB)
- Search: `SELECT ..., vec_distance_cosine(embedding, ?) as distance FROM vec_chunks WHERE ... ORDER BY distance LIMIT ?`
- `sqliteVec.load()` always runs to register `vec_distance_cosine()` even in fallback mode

### Idempotent insert

`vec0` tables don't support `INSERT OR IGNORE` or `ON CONFLICT DO NOTHING` (confirmed experimentally). The store uses a pre-check for idempotency:

```typescript
const checkStmt = db.prepare("SELECT 1 FROM vec_chunks WHERE chunk_id = ?");
const insertStmt = db.prepare("INSERT INTO vec_chunks(...) VALUES (?, ...)");

for (const chunk of chunks) {
  if (checkStmt.get(chunk.id)) continue; // skip existing
  insertStmt.run(chunk.id, embedding, ...);
}
```

### Schema

```sql
-- vec0 path:
CREATE VIRTUAL TABLE vec_chunks USING vec0(
  chunk_id integer primary key,
  embedding float[N] distance_metric=cosine,
  file_path text partition key,
  symbol_kind text,
  language text,
  +code_snippet text,
  +line_start integer,
  +line_end integer
)

-- Fallback path (regular table):
CREATE TABLE vec_chunks(
  chunk_id integer primary key,
  embedding blob not null,
  file_path text not null,
  symbol_kind text, language text,
  code_snippet text, line_start integer, line_end integer
)
CREATE INDEX idx_vec_chunks_file_path ON vec_chunks(file_path)

-- Schema tracking:
CREATE TABLE _schema_version (version integer, vec0_used integer)
```

## Tests Passing (18/18)

| # | Test | Status |
|---|------|--------|
| 1 | creates the database file on construction | ✅ |
| 2 | initializes the vec0 virtual table | ✅ |
| 3 | creates _schema_version and records version 1 | ✅ |
| 4 | idempotent — running constructor twice does not error | ✅ |
| 5 | inserts chunks and returns them via search | ✅ |
| 6 | returns results ordered by distance (ascending cosine distance) | ✅ |
| 7 | filters by language | ✅ |
| 8 | filters by symbolKind | ✅ |
| 9 | filters by filePathPrefix (LIKE prefix%) | ✅ |
| 10 | combines multiple filters | ✅ |
| 11 | deletes all chunks for a given filePath | ✅ |
| 12 | persists chunks across close and reopen | ✅ |
| 13 | idempotent insert on reopened store does not duplicate | ✅ |
| 14 | throws when searching on a closed store | ✅ |
| 15 | throws when inserting on a closed store | ✅ |
| 16 | throws when deleting on a closed store | ✅ |
| 17 | handles bulk insert of 100+ chunks | ✅ |
| 18 | verifies cosine distance ordering for known vectors | ✅ |

## Open Risks / Notes

1. **`INSERT OR IGNORE` doesn't work on vec0** — mitigated with pre-check idempotency (one extra SELECT per chunk on insert).
2. **Homebrew SQLite path hardcoded for Bun on macOS** — the `/opt/homebrew/opt/sqlite3/lib/libsqlite3.dylib` path is macOS-specific. On Linux or other platforms, this would need to be parameterized.
3. **`vec0` virtual tables don't support `ALTER TABLE`** — migrations require creating new tables and migrating data. The `_schema_version` pattern supports this.
4. **`bun:sqlite` + Homebrew SQLite path** — the `setCustomSQLite` call is module-level (called once per worker via `bunSqliteConfigured` flag), which is correct.

## Recommended Next Step

The implementation is complete and all 18 tests pass. No further fixes needed for the core implementation. The store is ready to be integrated into the Pi-SmartRead embedding pipeline, replacing or supplementing the existing `PersistentEmbeddingCache`.