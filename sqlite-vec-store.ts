/**
 * SqliteVecStore — vector store backed by sqlite-vec.
 *
 * Works in both Bun (bun:sqlite with Homebrew SQLite) and Node.js (better-sqlite3).
 * Schema versioning via _schema_version table.
 *
 * Extension loading strategy:
 *   - Node.js: always use better-sqlite3 (bundles SQLite with extension loading).
 *   - Bun: try better-sqlite3 first; fall back to bun:sqlite + Homebrew SQLite
 *     if better-sqlite3 throws "not yet supported in Bun".
 *   - On every open, sqlite-vec is loaded so that:
 *       (a) vec0 virtual tables are usable, AND
 *       (b) the vec_distance_cosine() SQL function is available in fallback mode.
 *   - The store decides between two data paths at runtime:
 *       - vec0 path: fast KNN via internal index (for workspaces where the extension
 *         loads and vec0 table creation succeeds).
 *       - Fallback path: pure-SQL brute-force cosine distance using BLOB embeddings
 *         (for environments where the extension or vec0 creation is unavailable).
 */

import * as sqliteVec from "sqlite-vec";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// ── Raw DB handle (any-typed; sqlite-vec interacts with it directly) ────────────

type RawDbHandle = {
  loadExtension(path: string): void;
  exec(sql: string): void;
  prepare(sql: string): RawStmtHandle;
  close(): void;
};

type RawStmtHandle = {
  run(...args: any[]): { changes: number; lastInsertRowid: number | bigint };
  all(...args: any[]): any[];
  get(...args: any[]): any;
};

// ── SQLite wrapper (narrow interface used throughout the store) ────────────────

interface SQLiteDatabase {
  /** The raw handle — used only by sqliteVec.load() */
  readonly raw: RawDbHandle;
  exec(sql: string): void;
  prepare(sql: string): SQLiteStatement;
}

interface SQLiteStatement {
  run(...args: any[]): SQLiteRunResult;
  all(...args: any[]): any[];
  get(...args: any[]): any;
}

interface SQLiteRunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

// ── Chunk interface ───────────────────────────────────────────────────────────

export interface Chunk {
  id: number;
  embedding: Float32Array;
  filePath: string;
  symbolKind: string;
  language: string;
  codeSnippet: string;
  lineStart: number;
  lineEnd: number;
}

// ── Search result ─────────────────────────────────────────────────────────────

export interface SearchResult {
  id: number;
  filePath: string;
  symbolKind: string;
  language: string;
  codeSnippet: string;
  lineStart: number;
  lineEnd: number;
  /** Lower is better; 0 = identical vector */
  distance: number;
}

export interface SearchFilters {
  language?: string;
  symbolKind?: string;
  filePathPrefix?: string;
}

// ── DB factory ────────────────────────────────────────────────────────────────

/**
 * Module-level flag to ensure Bun's custom SQLite path is configured at most once.
 * Bun auto-loads SQLite on first Database open, so setCustomSQLite must be called
 * before that happens.
 */
let bunSqliteConfigured = false;

function openDatabase(path: string): SQLiteDatabase {
  // Try better-sqlite3 first — works in both raw node and vitest workers.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const BetterSqlite3 = require("better-sqlite3") as typeof import("better-sqlite3");
    const raw = new BetterSqlite3(path) as RawDbHandle;
    return makeWrapper(raw);
  } catch (err: any) {
    if (typeof Bun !== "undefined" && /not yet supported in Bun/i.test(err?.message)) {
      return openBunDatabase(path);
    }
    throw err;
  }
}

function openBunDatabase(path: string): SQLiteDatabase {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");

  // On macOS, Bun ships Apple's system SQLite which has extension loading disabled.
  // Point it at Homebrew's SQLite (which has it enabled) — but only once.
  if (!bunSqliteConfigured) {
    bunSqliteConfigured = true;
    try {
      Database.setCustomSQLite("/opt/homebrew/opt/sqlite3/lib/libsqlite3.dylib");
    } catch {
      // Already configured by another store in this worker — ignore.
    }
  }

  const raw = new Database(path) as RawDbHandle;
  return makeWrapper(raw);
}

function makeWrapper(raw: RawDbHandle): SQLiteDatabase {
  return {
    raw,
    exec(sql: string) {
      raw.exec(sql);
    },
    prepare(sql: string) {
      const stmt = raw.prepare(sql);
      return {
        run(...args: any[]) {
          return stmt.run(...args) as SQLiteRunResult;
        },
        all(...args: any[]) {
          return stmt.all(...args);
        },
        get(...args: any[]) {
          return stmt.get(...args);
        },
      };
    },
  };
}

// ── SqliteVecStore ────────────────────────────────────────────────────────────

export class SqliteVecStore {
  private db: SQLiteDatabase;
  private closed = false;
  /**
   * True once sqlite-vec extension is loaded AND vec0 table is confirmed created.
   * When false, the store uses a fallback path with BLOB embeddings and
   * vec_distance_cosine() SQL function for brute-force search.
   */
  private vec0Available = false;

  constructor(
    public readonly dbPath: string,
    public readonly dimension: number
  ) {
    // Ensure parent directory exists
    const dir = dirname(this.dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = openDatabase(this.dbPath);
    this.migrate();
  }

  /**
   * Load the sqlite-vec extension into the raw DB handle.
   * Safe to call on every open — extension loading is idempotent.
   * Returns true on success, false on failure (e.g. extension loading disabled).
   */
  private loadVecExtension(): boolean {
    try {
      sqliteVec.load(this.db.raw);
      return true;
    } catch {
      return false;
    }
  }

  private migrate(): void {
    const { db } = this;

    // Schema version tracking
    db.exec("CREATE TABLE IF NOT EXISTS _schema_version (version integer, vec0_used integer)");

    // Fetch the latest version row. Using max(version) alone collapses the result
    // to just the version number, losing the vec0_used column — use a subquery
    // to retrieve the full row that has max(version).
    const row = db
      .prepare(
        "SELECT version, vec0_used FROM _schema_version " +
        "WHERE version = (SELECT MAX(version) FROM _schema_version)"
      )
      .get() as { version: number; vec0_used: number } | undefined;
    const version: number = row?.version ?? 0;
    const vec0UsedPreviously: number = row?.vec0_used ?? 0;

    // Always try to load the extension — it registers the vec_distance_cosine()
    // SQL function needed for fallback search, even when vec0 tables aren't used.
    const extensionLoaded = this.loadVecExtension();

    if (version < 1) {
      // First-time creation: determine the data path.

      if (extensionLoaded) {
        // vec0 path: try to create the virtual table.
        // Wrap in try-catch because even with extension loaded, some SQLite
        // builds (e.g. Homebrew SQLite on macOS in certain configurations) can
        // block virtual table creation while still allowing extension loading.
        try {
          const createVec0 =
            "CREATE VIRTUAL TABLE vec_chunks USING vec0(" +
            "chunk_id integer primary key, " +
            `embedding float[${this.dimension}] distance_metric=cosine, ` +
            "file_path text partition key, " +
            "symbol_kind text, " +
            "language text, " +
            "+code_snippet text, " +
            "+line_start integer, " +
            "+line_end integer)";
          db.exec(createVec0);

          // Verify the table was actually created as a vec0 table.
          // If CREATE VIRTUAL TABLE silently failed, the table won't appear here.
          const tables = db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name='vec_chunks' AND sql LIKE '%USING vec0%'"
            )
            .all() as any[];

          if (tables.length > 0) {
            this.vec0Available = true;
          }
        } catch {
          // vec0 creation failed even though extension loaded — fall through
        }
      }

      if (!this.vec0Available) {
        // Fallback: regular table with BLOB embeddings.
        // The extension was already loaded above (for vec_distance_cosine support),
        // but vec0 creation failed — fall back to BLOB storage + brute-force search.
        db.exec(
          "CREATE TABLE vec_chunks(" +
          "chunk_id integer primary key, " +
          "embedding blob not null, " +
          "file_path text not null, " +
          "symbol_kind text, " +
          "language text, " +
          "code_snippet text, " +
          "line_start integer, " +
          "line_end integer)"
        );
        db.exec(
          "CREATE INDEX idx_vec_chunks_file_path ON vec_chunks(file_path)"
        );
      }

      // Record version and vec0_used flag.
      db.prepare("INSERT INTO _schema_version (version, vec0_used) VALUES (1, ?)").run(
        this.vec0Available ? 1 : 0
      );
    } else {
      // Re-open existing store: trust the vec0_used flag from first creation.
      // The extension was loaded above (for vec_distance_cosine in fallback mode).
      this.vec0Available = vec0UsedPreviously === 1;
    }

    // Future migrations go here (version < 2, etc.)
  }

  insertChunks(chunks: Chunk[]): void {
    if (this.closed) throw new Error("Store is closed");
    if (chunks.length === 0) return;

    const { db } = this;
    db.exec("BEGIN");

    try {
      // Prepared statements for the two paths.
      // The WHERE clause in the check query uses the same column name as the insert
      // (chunk_id) so it works with both vec0 and regular tables.
      const insertStmt = db.prepare(
        "INSERT INTO vec_chunks(" +
        "chunk_id, embedding, file_path, symbol_kind, " +
        "language, code_snippet, line_start, line_end" +
        ") VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      );
      const checkStmt = db.prepare(
        "SELECT 1 FROM vec_chunks WHERE chunk_id = ?"
      );

      for (const chunk of chunks) {
        // Only insert if the chunk_id is not already present.
        // vec0 tables don't support INSERT OR IGNORE or ON CONFLICT DO NOTHING,
        // so we use a pre-check to achieve idempotent insert behavior.
        const existing = checkStmt.get(chunk.id);
        if (existing) continue;

        insertStmt.run(
          chunk.id,
          // vec0 path: store Float32Array directly (sqlite-vec handles the format).
          // Fallback path: store only the Float32Array bytes, not the whole buffer.
          this.vec0Available
            ? chunk.embedding
            : chunk.embedding.buffer.slice(
                chunk.embedding.byteOffset,
                chunk.embedding.byteOffset + chunk.embedding.byteLength
              ),
          chunk.filePath, chunk.symbolKind,
          chunk.language, chunk.codeSnippet,
          chunk.lineStart, chunk.lineEnd
        );
      }
      db.exec("COMMIT");
    } catch (err) {
      try { db.exec("ROLLBACK"); } catch { /* ignore rollback errors */ }
      throw err;
    }
  }

  search(
    queryEmbedding: Float32Array,
    k: number,
    filters?: SearchFilters
  ): SearchResult[] {
    if (this.closed) throw new Error("Store is closed");

    if (this.vec0Available) {
      return this.searchVec0(queryEmbedding, k, filters);
    } else {
      return this.searchFallback(queryEmbedding, k, filters);
    }
  }

  private searchVec0(
    queryEmbedding: Float32Array,
    k: number,
    filters?: SearchFilters
  ): SearchResult[] {
    const { db } = this;
    const predicates: string[] = [];
    const args: any[] = [queryEmbedding, k];

    if (filters?.language) {
      predicates.push("language = ?");
      args.push(filters.language);
    }
    if (filters?.symbolKind) {
      predicates.push("symbol_kind = ?");
      args.push(filters.symbolKind);
    }
    if (filters?.filePathPrefix) {
      predicates.push("file_path LIKE ?");
      args.push(filters.filePathPrefix + "%");
    }

    const filterExpr = predicates.join(" AND ");
    const filterClause = predicates.length > 0 ? "AND " + filterExpr : "";

    const sql = [
      "SELECT chunk_id as id, file_path, symbol_kind, language,",
      "       code_snippet, line_start, line_end, distance",
      "FROM vec_chunks",
      "WHERE embedding MATCH ? AND k = ?",
      filterClause,
      "ORDER BY distance",
    ].join(" ");

    const rows = db.prepare(sql).all(...args) as any[];
    return rows.map((row) => ({
      id: row.id,
      filePath: row.file_path,
      symbolKind: row.symbol_kind,
      language: row.language,
      codeSnippet: row.code_snippet,
      lineStart: row.line_start,
      lineEnd: row.line_end,
      distance: row.distance,
    }));
  }

  /**
   * Fallback search: pure-SQL cosine distance across all rows.
   * Uses sqlite-vec's vec_distance_cosine() SQL function (registered by
   * sqliteVec.load()) against BLOB-stored embeddings. This is a brute-force O(n)
   * scan but works in environments where the vec0 virtual table is unavailable.
   *
   * vec_distance_cosine returns [0..2]: 0 = identical, 2 = opposite.
   */
  private searchFallback(
    queryEmbedding: Float32Array,
    k: number,
    filters?: SearchFilters
  ): SearchResult[] {
    const { db } = this;

    const conditions: string[] = [];
    const args: any[] = [];

    if (filters?.language) {
      conditions.push("language = ?");
      args.push(filters.language);
    }
    if (filters?.symbolKind) {
      conditions.push("symbol_kind = ?");
      args.push(filters.symbolKind);
    }
    if (filters?.filePathPrefix) {
      conditions.push("file_path LIKE ?");
      args.push(filters.filePathPrefix + "%");
    }

    const whereClause = conditions.length > 0
      ? "WHERE " + conditions.join(" AND ")
      : "";

    // vec_distance_cosine(blob, Float32Array) → [0..2]
    const sql = [
      "SELECT chunk_id as id, file_path, symbol_kind, language,",
      "       code_snippet, line_start, line_end,",
      "       vec_distance_cosine(embedding, ?) as distance",
      "FROM vec_chunks",
      whereClause,
      "ORDER BY distance",
      "LIMIT ?",
    ].join(" ");

    const rows = db.prepare(sql).all(queryEmbedding.buffer, k, ...args) as any[];
    return rows.map((row) => ({
      id: row.id,
      filePath: row.file_path,
      symbolKind: row.symbol_kind,
      language: row.language,
      codeSnippet: row.code_snippet,
      lineStart: row.line_start,
      lineEnd: row.line_end,
      // vec_distance_cosine returns null if the function is unavailable
      distance: row.distance ?? 2,
    }));
  }

  deleteByFilePath(filePath: string): void {
    if (this.closed) throw new Error("Store is closed");
    this.db
      .prepare("DELETE FROM vec_chunks WHERE file_path = ?")
      .run(filePath);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.raw.close();
  }
}

// ── Exported factory (convenience) ───────────────────────────────────────────

export function openVectorDb(
  path: string,
  dimension = 1536
): SqliteVecStore {
  return new SqliteVecStore(path, dimension);
}