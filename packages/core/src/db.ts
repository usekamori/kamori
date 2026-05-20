import { createHash } from "node:crypto";
import type { DbAdapter } from "./adapters/db-adapter.js";

// ---------------------------------------------------------------------------
// ISO-8601 validation
// ---------------------------------------------------------------------------

/**
 * Returns true if `value` is a plausible ISO-8601 date/datetime string.
 *
 * Accepted forms:
 *   YYYY-MM-DD
 *   YYYY-MM-DDTHH:MM[Z|±HH:MM]
 *   YYYY-MM-DDTHH:MM:SS[.sss][Z|±HH:MM]
 *
 * The regex is intentionally a format check only — it does not validate
 * calendar correctness (e.g. Feb 30). Its job is to reject obvious garbage
 * such as `'; DROP TABLE--` before the value reaches the DB layer.
 *
 * Compiled once at module load; reused on every call (no per-call allocation).
 */
const ISO_RE =
  /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/;

export function isValidIso(value: string): boolean {
  return ISO_RE.test(value);
}

// ---------------------------------------------------------------------------
// listServices TTL cache
// Invalidated by insertLogs only when a new service name is introduced.
// Under steady-state write load (same services writing continuously) the
// cache is never invalidated and the 5-minute TTL works as designed.
// _servicesCacheBuilding coalesces concurrent rebuild requests so only one
// SQL query is in-flight at a time.
// ---------------------------------------------------------------------------

let _servicesCache: string[] | null = null;
let _servicesCacheExpiry = 0;
let _servicesCacheBuilding: Promise<string[]> | null = null;
const SERVICES_CACHE_TTL_MS = 5 * 60 * 1_000;

/**
 * Reset the listServices cache.
 * For use in tests that create a fresh database per test but share the
 * module-scope cache. Not needed in production (single DB per process).
 * @internal
 */
export function _resetServicesCache(): void {
  _servicesCache = null;
  _servicesCacheBuilding = null;
  _servicesCacheExpiry = 0;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single log row as stored in (and returned from) the database. */
export interface LogRow {
  id: number;
  received_at: string;
  service: string | null;
  level: string | null;
  trace_id: string | null;
  body: string;
}

/**
 * Options for filtering and paginating log queries.
 *
 * When `after_id` is set the query uses cursor-based pagination:
 * results are ordered oldest-first (ASC) so the caller can walk
 * forward through new entries by passing back the last id seen.
 * Without `after_id` results are ordered newest-first (DESC) for
 * normal browsing / recent-logs use-cases.
 */
export interface QueryOptions {
  service?: string;
  level?: string;
  since?: string;
  until?: string;
  limit?: number;
  /** Return only rows with id > after_id (cursor-based pagination / live tailing). */
  after_id?: number;
  /** Filter by trace/request/correlation id. */
  trace_id?: string;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Returns the SHA-256 hex digest of a body string.
 * Used as a fixed-width dedup key instead of the full JSON blob so that
 * the dedup IN-query transfers ~32 bytes per event rather than the full body.
 */
function hashBody(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

/**
 * Extracts the first non-empty string value from `obj` for any of the given `keys`.
 * Used to normalise field aliases (e.g. "service" | "app" | "source").
 */
function extractField(
  obj: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const key of keys) {
    const val = obj[key];
    if (typeof val === "string" && val) return val;
  }
  return null;
}

// ---------------------------------------------------------------------------
// insertLogs
// ---------------------------------------------------------------------------

/**
 * Inserts one or more log rows into the database within a single transaction.
 * Service, level, and trace_id are extracted from well-known field aliases
 * so that logs from different frameworks are normalised automatically.
 *
 * Extended alias lists cover more framework-specific field names.
 * Exact duplicates within a 5-second window are silently dropped.
 * Dedup uses a SHA-256 hash of the body (stored in `body_hash`) so the
 * IN-clause sends fixed 64-byte hex strings instead of full JSON blobs,
 * keeping index comparisons cheap regardless of body size.
 *
 * When `maxRowBytes` is greater than zero, rows whose serialised size exceeds
 * that limit are skipped and reported in the returned `oversized` array.
 *
 * @param adapter - DbAdapter to use for database operations.
 * @param rows - Array of arbitrary JSON objects (one per log event).
 * @param receivedAt - ISO-8601 timestamp to stamp all rows with.
 * @param maxRowBytes - Maximum serialised byte size per row. 0 disables the check.
 * @returns Object with counts of written and deduplicated rows, plus any oversized entries.
 */
export async function insertLogs(
  adapter: DbAdapter,
  rows: Record<string, unknown>[],
  receivedAt: string,
  maxRowBytes = 0,
): Promise<{ written: number; deduplicated: number; oversized: Array<{ index: number; bytes: number }> }> {
  if (rows.length === 0) return { written: 0, deduplicated: 0, oversized: [] };

  // Normalise all rows up-front before the dedup query; track oversized ones by index.
  const oversized: Array<{ index: number; bytes: number }> = [];
  const candidates: Array<{ service: string | null; level: string | null; trace_id: string | null; body: string; body_hash: string }> = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const service = extractField(row, [
      "service",
      "app",
      "source",
      "name",
      "application",
      "svc",
      "component",
    ]);
    const level = extractField(row, [
      "level",
      "severity",
      "log_level",
      "lvl",
      "logLevel",
    ]);
    const trace_id = extractField(row, [
      "trace_id",
      "traceId",
      "trace.id",
      "x-trace-id",
      "requestId",
      "request_id",
      "correlationId",
      "correlation_id",
    ]);
    const body = JSON.stringify({ ...row, received_at: receivedAt });

    if (maxRowBytes > 0) {
      const byteLen = Buffer.byteLength(body, "utf8");
      if (byteLen > maxRowBytes) {
        oversized.push({ index: i, bytes: byteLen });
        continue;
      }
    }

    candidates.push({ service, level, trace_id, body, body_hash: hashBody(body) });
  }

  // All rows were oversized — nothing left to dedup or insert.
  if (candidates.length === 0) return { written: 0, deduplicated: 0, oversized };

  // Batch dedup — one query to find all duplicate body_hashes in the burst window.
  // Using the body_hash column (SHA-256 hex, 64 chars) instead of the full JSON
  // body keeps the IN-clause parameters small and index comparisons O(1).
  const since = new Date(new Date(receivedAt).getTime() - 5_000).toISOString();
  const placeholders = candidates.map(() => "?").join(", ");
  const existingRows = await adapter.query<{ body_hash: string }>(
    `SELECT DISTINCT body_hash FROM logs WHERE body_hash IN (${placeholders}) AND received_at >= ?`,
    [...candidates.map((c) => c.body_hash), since],
  );
  const existingHashes = new Set(existingRows.map((r) => r.body_hash));

  const toInsert: Array<{ sql: string; args: unknown[] }> = [];
  // Accumulate per-(service,level) deltas for the log_counts materialized counter.
  // NULL service/level are normalized to '' so the NOT NULL primary key works correctly.
  const countDeltas = new Map<string, { service: string; level: string; delta: number }>();
  let deduplicated = 0;
  // Collect non-null service names that will be written — used below to
  // decide whether the listServices cache needs invalidation.
  const batchServices = new Set<string>();

  for (const { service, level, trace_id, body, body_hash } of candidates) {
    if (existingHashes.has(body_hash)) {
      deduplicated++;
      continue;
    }
    toInsert.push({
      sql: `INSERT INTO logs (received_at, service, level, trace_id, body, body_hash) VALUES (?, ?, ?, ?, ?, ?)`,
      args: [receivedAt, service, level, trace_id, body, body_hash],
    });
    if (service !== null) batchServices.add(service);
    const svc = service ?? "";
    const lvl = level ?? "";
    const key = `${svc}\0${lvl}`;
    const entry = countDeltas.get(key);
    if (entry) entry.delta++;
    else countDeltas.set(key, { service: svc, level: lvl, delta: 1 });
  }

  if (toInsert.length > 0) {
    // Append log_counts upserts to the same transaction so counters are always
    // consistent with the logs table — no separate flush step required.
    const batch = [...toInsert];
    for (const { service, level, delta } of countDeltas.values()) {
      batch.push({
        sql: `INSERT INTO log_counts (service, level, count) VALUES (?, ?, ?)
              ON CONFLICT (service, level) DO UPDATE SET count = count + excluded.count`,
        args: [service, level, delta],
      });
    }
    await adapter.batch(batch);
    // Selectively invalidate the listServices cache: only clear it when the
    // batch introduces at least one service name not already in the cached list.
    // If the cache is cold (null), it is already invalid — nothing to do.
    // If all batch services are known, the cached list is still accurate.
    if (_servicesCache !== null && batchServices.size > 0) {
      const cached = _servicesCache;
      if ([...batchServices].some((s) => !cached.includes(s))) {
        _servicesCache = null;
        _servicesCacheBuilding = null;
      }
    }
  }

  return { written: toInsert.length, deduplicated, oversized };
}

// ---------------------------------------------------------------------------
// queryLogs
// ---------------------------------------------------------------------------

/**
 * Queries log rows with optional filters.
 *
 * Ordering depends on whether `after_id` is supplied:
 * - With `after_id`: ORDER BY id ASC (oldest-first, for tailing)
 * - Without `after_id`: ORDER BY received_at DESC (newest-first, for browsing)
 *
 * The limit is capped at 500 to protect memory; use `exportLogs` for bulk exports.
 *
 * @param adapter - DbAdapter to use for database operations.
 * @param opts - Filter/pagination options.
 * @returns Array of matching LogRow objects.
 */
export async function queryLogs(
  adapter: DbAdapter,
  opts: QueryOptions,
): Promise<LogRow[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (opts.service) {
    conditions.push("service = ?");
    params.push(opts.service);
  }
  if (opts.level) {
    conditions.push("level = ?");
    params.push(opts.level);
  }
  if (opts.since) {
    conditions.push("received_at >= ?");
    params.push(opts.since);
  }
  if (opts.until) {
    conditions.push("received_at <= ?");
    params.push(opts.until);
  }
  // Cursor-based pagination: only return rows newer than the last seen id
  if (opts.after_id !== undefined) {
    conditions.push("id > ?");
    params.push(opts.after_id);
  }
  if (opts.trace_id) {
    conditions.push("trace_id = ?");
    params.push(opts.trace_id);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = Math.min(opts.limit ?? 100, 500);

  // When tailing (after_id set) return oldest-first so the caller can walk
  // forward in time; otherwise return newest-first for browsing.
  const order =
    opts.after_id === undefined
      ? "ORDER BY received_at DESC"
      : "ORDER BY id ASC";

  return adapter.query<LogRow>(
    `SELECT id, received_at, service, level, trace_id, body
     FROM logs ${where}
     ${order}
     LIMIT ?`,
    [...params, limit],
  );
}

// ---------------------------------------------------------------------------
// getLogById
// ---------------------------------------------------------------------------

/**
 * Fetches a single log row by its primary-key id.
 *
 * @param adapter - DbAdapter to use for database operations.
 * @param id - The numeric id of the row to retrieve.
 * @returns The matching LogRow, or null if no row with that id exists.
 */
export async function getLogById(
  adapter: DbAdapter,
  id: number,
): Promise<LogRow | null> {
  return adapter.get<LogRow>(
    `SELECT id, received_at, service, level, trace_id, body FROM logs WHERE id = ?`,
    [id],
  );
}

// ---------------------------------------------------------------------------
// deleteLogs
// ---------------------------------------------------------------------------

/**
 * Deletes log rows matching the supplied conditions.
 * At least one condition should be provided by callers to avoid wiping everything
 * by accident — the HTTP route enforces this; this function itself allows it for
 * administrative use.
 *
 * @param adapter - DbAdapter to use for database operations.
 * @param opts.before  - Delete rows where received_at < before (ISO string).
 * @param opts.service - Delete rows for a specific service.
 * @returns The number of rows deleted.
 */
export async function deleteLogs(
  adapter: DbAdapter,
  opts: { before?: string; service?: string },
): Promise<number> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (opts.before) {
    conditions.push("received_at < ?");
    params.push(opts.before);
  }
  if (opts.service) {
    conditions.push("service = ?");
    params.push(opts.service);
  }

  // Build WHERE clause — empty string means "delete all" (no conditions)
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = await adapter.run(`DELETE FROM logs ${where}`, params);
  return result.rowsAffected;
}

// ---------------------------------------------------------------------------
// purgeLogs
// ---------------------------------------------------------------------------

/**
 * Deletes all log rows older than `beforeDate`.
 * Called by the retention-policy cron to keep the database from growing unbounded.
 *
 * After the chunk loop, if any rows were deleted, a full FTS5 index rebuild is
 * performed. The `logs_ad` trigger writes one FTS5 soft-delete tombstone per
 * deleted row; for large purges (thousands of rows across multiple chunks) this
 * produces thousands of tombstones that must be skipped on every subsequent MATCH
 * query. A single `rebuild` command rewrites the index from the current `logs`
 * table in one pass — cheaper than N individual trigger writes, and produces a
 * compact, tombstone-free index.
 *
 * @param adapter - DbAdapter to use for database operations.
 * @param beforeDate - ISO-8601 date string; rows with received_at < this value are removed.
 * @returns The number of rows deleted.
 */
export async function purgeLogs(
  adapter: DbAdapter,
  beforeDate: string,
  chunkSize = 5_000,
): Promise<number> {
  // Delete in chunks to avoid holding a table-level lock for the duration of
  // a full-table sweep. Each chunk is a separate transaction, keeping ingest
  // latency unaffected during large purges.
  let total = 0;
  for (;;) {
    const result = await adapter.run(
      `DELETE FROM logs WHERE id IN (
         SELECT id FROM logs WHERE received_at < ? LIMIT ?
       )`,
      [beforeDate, chunkSize],
    );
    total += result.rowsAffected;
    if (result.rowsAffected < chunkSize) break; // no more rows to delete
  }
  // Compact FTS5 tombstones accumulated from the logs_ad trigger.
  if (total > 0) {
    await adapter.exec(`INSERT INTO logs_fts(logs_fts) VALUES('rebuild')`);
  }
  return total;
}

// ---------------------------------------------------------------------------
// purgeExcessLogs
// ---------------------------------------------------------------------------

/**
 * Deletes the oldest log rows until at most `maxRows` remain.
 * Called after time-based retention to enforce per-plan stored-size caps.
 *
 * Rows are deleted in chunks to avoid holding a long-running lock.
 * The row count is fetched once before the loop and decremented by
 * `rowsAffected` each iteration — avoiding the O(n²/chunk) cost of
 * re-counting the full table on every pass.
 *
 * @param adapter   - DbAdapter to use for database operations.
 * @param maxRows   - Maximum number of rows to keep.
 * @param chunkSize - Rows to delete per iteration (default 5 000).
 * @returns The total number of rows deleted.
 */
export async function purgeExcessLogs(
  adapter: DbAdapter,
  maxRows: number,
  chunkSize = 5_000,
): Promise<number> {
  const countRow = await adapter.get<{ count: number | bigint }>(
    `SELECT COUNT(*) as count FROM logs`,
    [],
  );
  const raw = countRow?.count ?? 0;
  let remaining = typeof raw === "bigint" ? Number(raw) : raw;

  let toDelete = remaining - maxRows;
  if (toDelete <= 0) return 0;

  let total = 0;
  while (toDelete > 0) {
    const chunk = Math.min(toDelete, chunkSize);
    const result = await adapter.run(
      `DELETE FROM logs WHERE id IN (
         SELECT id FROM logs ORDER BY id ASC LIMIT ?
       )`,
      [chunk],
    );
    total += result.rowsAffected;
    toDelete -= result.rowsAffected;
    if (result.rowsAffected < chunk) break; // table exhausted early
  }
  // Compact FTS5 tombstones accumulated from the logs_ad trigger.
  if (total > 0) {
    await adapter.exec(`INSERT INTO logs_fts(logs_fts) VALUES('rebuild')`);
  }
  return total;
}

// ---------------------------------------------------------------------------
// exportLogs
// ---------------------------------------------------------------------------

/**
 * Exports log rows with a higher limit cap than `queryLogs` (up to 10 000 rows).
 * Intended for bulk-export endpoints (NDJSON / CSV download).
 * Uses the same condition-building logic as `queryLogs` but does not support
 * cursor-based pagination (`after_id`).
 *
 * @param adapter - DbAdapter to use for database operations.
 * @param opts - Standard QueryOptions plus an optional higher limit (default 1000, max 10000).
 * @returns Array of matching LogRow objects.
 */
export async function exportLogs(
  adapter: DbAdapter,
  opts: QueryOptions & { limit?: number },
): Promise<LogRow[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (opts.service) {
    conditions.push("service = ?");
    params.push(opts.service);
  }
  if (opts.level) {
    conditions.push("level = ?");
    params.push(opts.level);
  }
  if (opts.since) {
    conditions.push("received_at >= ?");
    params.push(opts.since);
  }
  if (opts.until) {
    conditions.push("received_at <= ?");
    params.push(opts.until);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  // Higher cap than queryLogs — export can pull up to 10 000 rows in one shot
  const limit = Math.min(opts.limit ?? 1000, 10_000);

  return adapter.query<LogRow>(
    `SELECT id, received_at, service, level, trace_id, body
     FROM logs ${where}
     ORDER BY received_at DESC
     LIMIT ?`,
    [...params, limit],
  );
}

// ---------------------------------------------------------------------------
// searchLogs
// ---------------------------------------------------------------------------

/**
 * Full-text search across log bodies using SQLite FTS5.
 * Supports quoted phrases and boolean operators (AND, OR, NOT).
 *
 * When `after_id` is supplied, results are ordered oldest-first (ASC) for
 * live-tailing; otherwise they are ordered newest-first (DESC) for browsing.
 *
 * @param adapter - DbAdapter to use for database operations.
 * @param query  - FTS5 query string.
 * @param opts   - Optional filters for since, until, service, limit, and after_id.
 * @returns Array of matching LogRow objects.
 */
export async function searchLogs(
  adapter: DbAdapter,
  query: string,
  opts: Pick<
    QueryOptions,
    "since" | "until" | "service" | "limit" | "after_id"
  >,
): Promise<LogRow[]> {
  const conditions: string[] = ["logs_fts MATCH ?"];
  const params: unknown[] = [query];

  if (opts.since) {
    conditions.push("l.received_at >= ?");
    params.push(opts.since);
  }
  if (opts.until) {
    conditions.push("l.received_at <= ?");
    params.push(opts.until);
  }
  if (opts.service) {
    conditions.push("l.service = ?");
    params.push(opts.service);
  }
  // Cursor-based pagination: only return rows newer than the last seen id
  if (opts.after_id !== undefined) {
    conditions.push("l.id > ?");
    params.push(opts.after_id);
  }

  const limit = Math.min(opts.limit ?? 500, 500);

  // When tailing (after_id set) return oldest-first; otherwise newest-first
  const order =
    opts.after_id === undefined
      ? "ORDER BY l.received_at DESC"
      : "ORDER BY l.id ASC";

  return adapter.query<LogRow>(
    `SELECT l.id, l.received_at, l.service, l.level, l.trace_id, l.body
     FROM logs_fts
     JOIN logs l ON l.id = logs_fts.rowid
     WHERE ${conditions.join(" AND ")}
     ${order}
     LIMIT ?`,
    [...params, limit],
  );
}

// ---------------------------------------------------------------------------
// listServices
// ---------------------------------------------------------------------------

/**
 * Returns a distinct, alphabetically sorted list of service names
 * present in the logs table.
 *
 * @param adapter - DbAdapter to use for database operations.
 * @returns Array of service name strings.
 */
export async function listServices(adapter: DbAdapter): Promise<string[]> {
  if (_servicesCache && Date.now() < _servicesCacheExpiry) {
    return _servicesCache;
  }
  // Coalesce concurrent rebuilds: share the in-flight promise instead of
  // firing N identical queries when the cache is cold or has been invalidated.
  _servicesCacheBuilding ??= adapter
    .query<{ service: string }>(
      `SELECT DISTINCT service FROM logs WHERE service IS NOT NULL ORDER BY service`,
    )
    .then((rows) => {
      _servicesCache = rows.map((r) => r.service);
      _servicesCacheExpiry = Date.now() + SERVICES_CACHE_TTL_MS;
      _servicesCacheBuilding = null;
      return _servicesCache;
    })
    .catch((err) => {
      _servicesCacheBuilding = null;
      throw err;
    });
  return _servicesCacheBuilding;
}

// ---------------------------------------------------------------------------
// countLogs
// ---------------------------------------------------------------------------

/**
 * Returns an exact count of log rows matching the given filters.
 * Unlike queryLogs this never hits a row-limit cap, making it suitable for
 * alert thresholds and anomaly detection where accuracy matters.
 *
 * @param adapter - DbAdapter to use for database operations.
 * @param opts - Filter options (service, level, since, until).
 * @returns The exact number of matching rows.
 */
export async function countLogs(
  adapter: DbAdapter,
  opts: Pick<QueryOptions, "service" | "level" | "since" | "until">,
): Promise<number> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (opts.service) {
    conditions.push("service = ?");
    params.push(opts.service);
  }
  if (opts.level) {
    conditions.push("level = ?");
    params.push(opts.level);
  }
  if (opts.since) {
    conditions.push("received_at >= ?");
    params.push(opts.since);
  }
  if (opts.until) {
    conditions.push("received_at <= ?");
    params.push(opts.until);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const row = await adapter.get<{ count: number | bigint }>(
    `SELECT COUNT(*) as count FROM logs ${where}`,
    params,
  );
  const raw = row?.count ?? 0;
  // SQLite COUNT(*) can return a BigInt on very large tables (> Number.MAX_SAFE_INTEGER).
  // Clamp to MAX_SAFE_INTEGER so callers always receive a safe JS number.
  if (typeof raw === "bigint") {
    return raw > BigInt(Number.MAX_SAFE_INTEGER)
      ? Number.MAX_SAFE_INTEGER
      : Number(raw);
  }
  return raw;
}

// ---------------------------------------------------------------------------
// countLogsFts
// ---------------------------------------------------------------------------

/**
 * Returns an exact count of log rows whose body matches the given FTS5 query.
 * Unlike using `searchLogs(..., limit: 500).length`, this never hits a row-limit
 * cap and is therefore suitable for alert thresholds and anomaly detection.
 *
 * @param adapter - DbAdapter to use for database operations.
 * @param query  - FTS5 query string (same syntax as searchLogs).
 * @param opts   - Optional filters for service, since, and until.
 * @returns The exact number of matching rows.
 */
export async function countLogsFts(
  adapter: DbAdapter,
  query: string,
  opts: Pick<QueryOptions, "service" | "since" | "until">,
): Promise<number> {
  const conditions: string[] = ["logs_fts MATCH ?"];
  const params: unknown[] = [query];

  if (opts.since) {
    conditions.push("l.received_at >= ?");
    params.push(opts.since);
  }
  if (opts.until) {
    conditions.push("l.received_at <= ?");
    params.push(opts.until);
  }
  if (opts.service) {
    conditions.push("l.service = ?");
    params.push(opts.service);
  }

  const row = await adapter.get<{ count: number | bigint }>(
    `SELECT COUNT(*) as count
     FROM logs_fts
     JOIN logs l ON l.id = logs_fts.rowid
     WHERE ${conditions.join(" AND ")}`,
    params,
  );
  const raw = row?.count ?? 0;
  if (typeof raw === "bigint") {
    return raw > BigInt(Number.MAX_SAFE_INTEGER)
      ? Number.MAX_SAFE_INTEGER
      : Number(raw);
  }
  return raw;
}

// ---------------------------------------------------------------------------
// queryByField
// ---------------------------------------------------------------------------

/** Comparison operators allowed for JSON body field queries. */
export type FieldOp = "=" | "!=" | ">" | ">=" | "<" | "<=";

const ALLOWED_OPS = new Set<FieldOp>(["=", "!=", ">", ">=", "<", "<="]);

/**
 * Only allow JSONPath keys that are safe to interpolate into SQL.
 * Permits alphanumerics, underscores, hyphens, and dots (for nested paths
 * like `meta.userId`). Rejects anything else to prevent SQLi via the path.
 */
const SAFE_FIELD_RE = /^[a-zA-Z_][a-zA-Z0-9_.]*$/;

/**
 * Filter logs by an arbitrary JSON body field value using `json_extract`.
 * Supports numeric comparisons (e.g. `ms > 500`) and string equality that
 * FTS5 cannot express.
 *
 * Both `field` and `op` are validated before interpolation — `value` is
 * always passed as a query parameter.
 *
 * @param adapter - DbAdapter to use.
 * @param opts.field - JSONPath key to extract, e.g. `statusCode` or `meta.userId`.
 * @param opts.op    - Comparison operator: `=`, `!=`, `>`, `>=`, `<`, `<=`.
 * @param opts.value - Value to compare against (string or number).
 * @throws Error when `field` or `op` fails validation.
 */
export async function queryByField(
  adapter: DbAdapter,
  opts: {
    field: string;
    op: FieldOp;
    value: string | number;
    service?: string;
    since?: string;
    until?: string;
    limit?: number;
  },
): Promise<LogRow[]> {
  if (!SAFE_FIELD_RE.test(opts.field)) {
    throw new Error(
      `Invalid field name "${opts.field}". Use alphanumerics, underscores, or dots only.`,
    );
  }
  if (!ALLOWED_OPS.has(opts.op)) {
    throw new Error(
      `Invalid operator "${opts.op}". Allowed: = != > >= < <=`,
    );
  }

  const conditions: string[] = [
    // field is validated above — safe to interpolate into the JSONPath literal
    `json_extract(body, '$.${opts.field}') ${opts.op} ?`,
  ];
  const params: unknown[] = [opts.value];

  if (opts.service) {
    conditions.push("service = ?");
    params.push(opts.service);
  }
  if (opts.since) {
    conditions.push("received_at >= ?");
    params.push(opts.since);
  }
  if (opts.until) {
    conditions.push("received_at <= ?");
    params.push(opts.until);
  }

  const limit = Math.min(opts.limit ?? 100, 500);

  return adapter.query<LogRow>(
    `SELECT id, received_at, service, level, trace_id, body
     FROM logs
     WHERE ${conditions.join(" AND ")}
     ORDER BY received_at DESC
     LIMIT ?`,
    [...params, limit],
  );
}

// ---------------------------------------------------------------------------
// histogramLogs
// ---------------------------------------------------------------------------

/** Time-bucket sizes supported by histogramLogs. */
export type HistogramBucket = "1m" | "5m" | "15m" | "1h" | "6h" | "1d";

const BUCKET_SECONDS: Record<HistogramBucket, number> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3600,
  "6h": 21600,
  "1d": 86400,
};

/**
 * Returns a time-series count of log entries grouped into equal-width time
 * buckets. Each bucket label is the ISO-8601 UTC start of the interval.
 *
 * Uses SQLite integer arithmetic on Unix timestamps so all bucket sizes
 * (including sub-hour) work uniformly without per-dialect formatting tricks.
 *
 * @param adapter - DbAdapter to use.
 * @param opts.bucket  - Bucket width: `1m`, `5m`, `15m`, `1h`, `6h`, or `1d`.
 * @param opts.service - Optional service filter.
 * @param opts.level   - Optional level filter.
 * @param opts.since   - Optional ISO-8601 start boundary.
 * @param opts.until   - Optional ISO-8601 end boundary.
 * @returns Array of `{ bucket, count }` ordered chronologically.
 */
export async function histogramLogs(
  adapter: DbAdapter,
  opts: {
    bucket: HistogramBucket;
    service?: string;
    level?: string;
    since?: string;
    until?: string;
  },
): Promise<{ bucket: string; count: number }[]> {
  const bucketSecs = BUCKET_SECONDS[opts.bucket];

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (opts.service) {
    conditions.push("service = ?");
    params.push(opts.service);
  }
  if (opts.level) {
    conditions.push("level = ?");
    params.push(opts.level);
  }
  if (opts.since) {
    conditions.push("received_at >= ?");
    params.push(opts.since);
  }
  if (opts.until) {
    conditions.push("received_at <= ?");
    params.push(opts.until);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  // Integer-divide the Unix epoch by bucketSecs then multiply back to snap
  // each timestamp to the start of its bucket, then format as ISO-8601 UTC.
  //
  // Note: JS numbers bound via `?` are typed as REAL in SQLite. We must cast
  // both instances of bucketSecs to INTEGER explicitly so that the division
  // truncates rather than returning a fractional result.
  return adapter.query<{ bucket: string; count: number }>(
    `SELECT
       strftime('%Y-%m-%dT%H:%M:%SZ', datetime(
         cast(strftime('%s', received_at) as integer) / cast(? as integer) * cast(? as integer),
         'unixepoch'
       )) AS bucket,
       COUNT(*) AS count
     FROM logs ${where}
     GROUP BY bucket
     ORDER BY bucket ASC`,
    [bucketSecs, bucketSecs, ...params],
  );
}

// ---------------------------------------------------------------------------
// summarizeErrors
// ---------------------------------------------------------------------------

/**
 * Returns a summary of log counts grouped by service and level.
 * Useful for health dashboards and Prometheus metrics.
 *
 * @param adapter - DbAdapter to use for database operations.
 * @param since - Optional ISO-8601 date string; if provided, only counts logs received at or after this time.
 * @param until - Optional ISO-8601 date string; if provided, only counts logs received before or at this time.
 * @returns Array of { service, level, count } objects ordered by count descending.
 */
export async function summarizeErrors(
  adapter: DbAdapter,
  since?: string,
  until?: string,
): Promise<{ service: string | null; level: string | null; count: number }[]> {
  const conditions: string[] = [];
  const params: string[] = [];
  if (since) { conditions.push("received_at >= ?"); params.push(since); }
  if (until) { conditions.push("received_at <= ?"); params.push(until); }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  return adapter.query<{
    service: string | null;
    level: string | null;
    count: number;
  }>(
    `SELECT service, level, COUNT(*) as count
     FROM logs ${where}
     GROUP BY service, level
     ORDER BY count DESC`,
    params,
  );
}

// ---------------------------------------------------------------------------
// getLogCounts
// ---------------------------------------------------------------------------

/**
 * Returns all-time log counts from the materialized `log_counts` table,
 * grouped by service and level.
 *
 * This is an O(1) point-read on a table that will never have more rows than
 * distinct (service, level) pairs — typically 10–100 rows regardless of how
 * many logs are stored. Use this for the Prometheus /metrics endpoint instead
 * of summarizeErrors(), which performs a full table scan on every call.
 *
 * NULL service/level values are stored as '' in log_counts; callers should
 * treat an empty string as "unknown" when rendering labels.
 *
 * @param adapter - DbAdapter to query.
 * @returns Array of { service, level, count } ordered by count descending.
 */
export async function getLogCounts(
  adapter: DbAdapter,
): Promise<{ service: string; level: string; count: number }[]> {
  return adapter.query<{ service: string; level: string; count: number }>(
    `SELECT service, level, count FROM log_counts ORDER BY count DESC`,
    [],
  );
}
