/** A single result row from a SELECT query. */
export type DbRow = Record<string, unknown>;

/** Return value from a run() call. */
export interface DbRunResult {
  rowsAffected: number;
  lastInsertRowid?: number | bigint;
}

/**
 * Minimal async database abstraction shared by all Kamori packages.
 *
 * The self-hosted implementation wraps better-sqlite3 (sync, wrapped in Promise.resolve).
 * The Cloud implementation wraps @libsql/client (native async Turso).
 */
export interface DbAdapter {
  /** Execute a DML statement (INSERT/UPDATE/DELETE). */
  run(sql: string, args?: unknown[]): Promise<DbRunResult>;
  /** Execute a SELECT, return all matching rows. */
  query<T = DbRow>(sql: string, args?: unknown[]): Promise<T[]>;
  /** Execute a SELECT, return the first row or null. */
  get<T = DbRow>(sql: string, args?: unknown[]): Promise<T | null>;
  /**
   * Execute an untrusted SELECT under a hard read-only guarantee.
   *
   * Unlike `query`, which will happily run any statement, this MUST prevent the
   * statement from performing any write at the database level — not by parsing
   * the SQL, but structurally:
   * - BetterSqliteAdapter wraps the call in `PRAGMA query_only`.
   * - LibSqlAdapter runs it inside a read-only transaction.
   *
   * Used by the MCP `query_sql` escape hatch so a crafted statement cannot
   * mutate data even if it slips past the tool's lexical checks. Optional so
   * older adapters keep working; callers fall back to `query` when it is absent
   * (with the lexical checks as their only guard).
   */
  readonlyQuery?<T = DbRow>(sql: string, args?: unknown[]): Promise<T[]>;
  /**
   * Execute multiple DML statements as a single atomic transaction.
   *
   * **Contract (MUST be honoured by all implementations):**
   * - All statements succeed together or none are applied (all-or-nothing).
   * - A partial failure MUST roll back any already-applied statements and
   *   re-throw the error; silently swallowing a partial write is a violation.
   * - Implementations that cannot guarantee atomicity MUST throw rather than
   *   execute statements non-atomically.
   *
   * For BetterSqliteAdapter this wraps statements in `db.transaction()`.
   * For LibSqlAdapter this uses an explicit `client.transaction("write")` with
   * `commit()` / `rollback()` so the transactional boundary is visible in code.
   */
  batch(statements: Array<{ sql: string; args?: unknown[] }>): Promise<void>;
  /**
   * Execute a raw DDL or PRAGMA statement (no result returned).
   * Use for CREATE TABLE, CREATE INDEX, PRAGMA, and other non-parameterised SQL.
   * For BetterSqliteAdapter this calls db.exec(); for LibSqlAdapter it calls client.execute().
   */
  exec(sql: string): Promise<void>;
}
