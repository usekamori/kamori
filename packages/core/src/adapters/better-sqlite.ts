import * as fs from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";
import type { DbAdapter, DbRow, DbRunResult } from "./db-adapter.js";

// ---------------------------------------------------------------------------
// Schema migrations
// Each entry is applied exactly once, in order, guarded by schema_migrations.
// To add a new migration: append a { version, sql } entry to MIGRATIONS.
// ---------------------------------------------------------------------------

const MIGRATIONS: Array<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS logs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        received_at TEXT NOT NULL,
        service     TEXT,
        level       TEXT,
        trace_id    TEXT,
        body        TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_received_at   ON logs(received_at);
      CREATE INDEX IF NOT EXISTS idx_service       ON logs(service);
      CREATE INDEX IF NOT EXISTS idx_level         ON logs(level);
      CREATE INDEX IF NOT EXISTS idx_trace_id      ON logs(trace_id);
      CREATE INDEX IF NOT EXISTS idx_body_received ON logs(body, received_at);

      CREATE VIRTUAL TABLE IF NOT EXISTS logs_fts
        USING fts5(body, content=logs, content_rowid=id);

      CREATE TRIGGER IF NOT EXISTS logs_ai AFTER INSERT ON logs BEGIN
        INSERT INTO logs_fts(rowid, body) VALUES (new.id, new.body);
      END;

      CREATE TRIGGER IF NOT EXISTS logs_ad AFTER DELETE ON logs BEGIN
        INSERT INTO logs_fts(logs_fts, rowid, body) VALUES ('delete', old.id, old.body);
      END;
    `,
  },
  {
    version: 2,
    sql: `
      ALTER TABLE logs ADD COLUMN body_hash TEXT;

      CREATE INDEX IF NOT EXISTS idx_body_hash_received ON logs(body_hash, received_at);

      DROP INDEX IF EXISTS idx_body_received;
    `,
  },
  {
    version: 3,
    sql: `
      CREATE TABLE IF NOT EXISTS log_counts (
        service TEXT NOT NULL DEFAULT '',
        level   TEXT NOT NULL DEFAULT '',
        count   INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (service, level)
      );
    `,
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Yield to the Node.js event loop before executing a blocking synchronous
 * DB call. This gives pending I/O callbacks (e.g. incoming HTTP requests)
 * a chance to run before the SQLite call occupies the thread.
 *
 * Note: for very large transactions (>10 000 rows) the blocking period is
 * unavoidable without moving the DB to a worker_threads Worker. This yield
 * improves responsiveness for typical workloads where individual calls are
 * short but many are queued concurrently.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * Maximum number of prepared statements held in the LRU cache.
 *
 * `insertLogs` generates one SQL string per unique batch size (1–MAX_ROWS
 * placeholders), so without eviction the cache could accumulate up to
 * MAX_ROWS entries. A 64-entry cap covers all realistic batch sizes while
 * bounding memory and open SQLite statement handles.
 */
export const STMT_CACHE_MAX = 64;

/**
 * DbAdapter implementation for self-hosted Kamori using better-sqlite3.
 *
 * Five issues addressed vs. the original implementation:
 *
 * 1. TOCTOU (HIGH): symlinks in the DB directory are resolved with
 *    fs.realpathSync() *after* mkdirSync(), and the DB file is checked with
 *    lstatSync() before open. The resolved path is used for new Database().
 *
 * 2. Event-loop blocking (MEDIUM): every public method awaits yieldToEventLoop()
 *    (setImmediate) before the synchronous work so queued I/O runs first.
 *    A prepared-statement LRU cache avoids redundant prepare() calls.
 *
 * 3. Transaction retry (MEDIUM): busy_timeout = 5000 tells SQLite to wait up
 *    to 5 s for a write lock before throwing SQLITE_BUSY, eliminating the
 *    "database is locked" error under normal write contention.
 *
 * 4. Schema versioning (LOW): a schema_migrations table tracks which
 *    migrations have been applied. Each entry in MIGRATIONS is idempotent and
 *    applied at most once, making it safe to add new migrations in future
 *    releases without breaking existing databases.
 *
 * 5. Bounded statement cache (LOW): the LRU prepared-statement cache is
 *    capped at STMT_CACHE_MAX entries. `insertLogs` generates a distinct SQL
 *    string per batch size; without eviction the cache grows up to MAX_ROWS
 *    entries. LRU evicts the least-recently-used entry when the cap is hit.
 */
export class BetterSqliteAdapter implements DbAdapter {
  private readonly _db: Database.Database;
  private readonly _stmtCache = new Map<string, Database.Statement>();

  constructor(dbPath: string) {
    const absDbPath = path.isAbsolute(dbPath) ? dbPath : path.resolve(dbPath);
    const dir = path.dirname(absDbPath);
    const base = path.basename(absDbPath);

    fs.mkdirSync(dir, { recursive: true });

    // Resolve symlinks in the parent directory AFTER creating it to close the
    // TOCTOU window between the path check and the new Database() call.
    const realDir = fs.realpathSync(dir);

    // Guard against path traversal for relative DB_PATH values.
    // Absolute paths are an explicit admin decision and are allowed.
    if (!path.isAbsolute(dbPath)) {
      const realCwd = fs.realpathSync(process.cwd());
      if (realDir !== realCwd && !realDir.startsWith(realCwd + path.sep)) {
        throw new Error(
          `DB_PATH "${dbPath}" resolves to "${realDir}" which is outside the working directory "${realCwd}"`,
        );
      }
    }

    const safeDbPath = path.join(realDir, base);

    // If the DB file already exists, ensure it is not a symbolic link.
    // lstatSync() returns metadata about the link itself (does not follow it).
    try {
      const stat = fs.lstatSync(safeDbPath);
      if (stat.isSymbolicLink()) {
        throw new Error(
          `DB_PATH "${safeDbPath}" is a symbolic link — refusing to open`,
        );
      }
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      // File does not exist yet; safe to create.
    }

    this._db = new Database(safeDbPath);
    this._db.pragma("journal_mode = WAL");
    this._db.pragma("synchronous = NORMAL");
    this._db.pragma("foreign_keys = ON");
    // Wait up to 5 s when another writer holds the lock before throwing BUSY.
    // This eliminates "database is locked" errors under normal write contention.
    this._db.pragma("busy_timeout = 5000");
    this._runMigrations();
  }

  // ---------------------------------------------------------------------------
  // Schema migrations
  // ---------------------------------------------------------------------------

  private _runMigrations(): void {
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      )
    `);

    const applied = new Set<number>(
      (
        this._db
          .prepare("SELECT version FROM schema_migrations")
          .all() as { version: number }[]
      ).map((r) => r.version),
    );

    const markApplied = this._db.prepare(
      "INSERT INTO schema_migrations (version) VALUES (?)",
    );

    for (const { version, sql } of MIGRATIONS) {
      if (applied.has(version)) continue;
      this._db.transaction(() => {
        this._db.exec(sql);
        markApplied.run(version);
      })();
    }
  }

  // ---------------------------------------------------------------------------
  // Statement cache
  // ---------------------------------------------------------------------------

  private _prepare(sql: string): Database.Statement {
    let stmt = this._stmtCache.get(sql);
    if (stmt) {
      // Refresh insertion order so this entry is the most-recently used.
      this._stmtCache.delete(sql);
      this._stmtCache.set(sql, stmt);
      return stmt;
    }
    if (this._stmtCache.size >= STMT_CACHE_MAX) {
      // Evict the least-recently-used entry (first key in insertion-order Map).
      this._stmtCache.delete(this._stmtCache.keys().next().value as string);
    }
    stmt = this._db.prepare(sql);
    this._stmtCache.set(sql, stmt);
    return stmt;
  }

  // ---------------------------------------------------------------------------
  // DbAdapter interface
  // ---------------------------------------------------------------------------

  async run(sql: string, args: unknown[] = []): Promise<DbRunResult> {
    await yieldToEventLoop();
    const result = this._prepare(sql).run(...args);
    return {
      rowsAffected: result.changes,
      lastInsertRowid: result.lastInsertRowid,
    };
  }

  async query<T = DbRow>(sql: string, args: unknown[] = []): Promise<T[]> {
    await yieldToEventLoop();
    return this._prepare(sql).all(...args) as T[];
  }

  async get<T = DbRow>(sql: string, args: unknown[] = []): Promise<T | null> {
    await yieldToEventLoop();
    const row = this._prepare(sql).get(...args);
    return (row ?? null) as T | null;
  }

  async batch(
    statements: Array<{ sql: string; args?: unknown[] }>,
  ): Promise<void> {
    await yieldToEventLoop();
    const tx = this._db.transaction(() => {
      for (const { sql, args = [] } of statements) {
        this._prepare(sql).run(...args);
      }
    });
    tx();
  }

  async exec(sql: string): Promise<void> {
    await yieldToEventLoop();
    this._db.exec(sql);
  }

  /** Expose the raw Database instance (used by BetterSqliteAdapter consumers that need it). */
  get raw(): Database.Database {
    return this._db;
  }
}
