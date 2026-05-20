# `@usekamori/core` Technical Specification

**Package:** `@usekamori/core`  
**Source root:** `packages/core/src`  
**Primary role:** shared env parsing, adapter contracts, and SQLite query/data primitives for `@usekamori/ingest` and `@usekamori/mcp`.

## 1. Mental Model: Community vs Cloud

Kamori ships one ingest server (`@usekamori/ingest`) and one MCP server (`@usekamori/mcp`). Both editions — Community (self-hosted, single-tenant) and Cloud (multi-tenant, Postgres-backed) — run the **same server code**. Behaviour diverges entirely through the adapter/plugin pattern defined here in `@usekamori/core`.

```
                         ┌──────────────────────────────────┐
                         │         Same server code         │
                         │  @usekamori/ingest  @usekamori/mcp     │
                         └────────────┬─────────────────────┘
                                      │ uses
                    ┌─────────────────┴──────────────────┐
                    │      @usekamori/core interfaces        │
                    │  AuthAdapter  BillingAdapter        │
                    │  DbAdapter    McpAdapter            │
                    │  RetentionAdapter  ServerPlugins    │
                    └──────┬──────────────────┬──────────┘
                           │                  │
          Community (OSS)  │                  │  Cloud
          defaultAdapters()│                  │  cloudAdapters() + cloudServerPlugins
                           ▼                  ▼
          ┌────────────────────┐   ┌─────────────────────────┐
          │ EnvTokenAuth       │   │ ApiKeyAuthAdapter        │
          │ NoBillingAdapter   │   │ CloudBillingAdapter      │
          │ BetterSqliteAdapter│   │ LibSqlAdapter (per proj) │
          │ LocalDbMcpAdapter  │   │ CloudMcpAdapter          │
          │ EnvRetentionAdapter│   │ EnvRetentionAdapter      │
          └────────────────────┘   └─────────────────────────┘
```

**Community** is single-tenant: one fixed SQLite database, one optional shared secret (`INGEST_TOKEN`), no projects, no billing, no Postgres.

**Cloud** is multi-tenant: every request carries an Ed25519 JWT API key. The JWT's `pid` claim routes each request to the correct per-project libSQL/Turso database. Billing, usage, and project metadata live in Postgres.

The adapter interfaces in `@usekamori/core` are the seam — all cloud-specific logic stays in `kamori-cloud/packages/entrypoint` and is never imported by this package.

## 2. Purpose

`@usekamori/core` defines stable interfaces and default self-hosted implementations used by Kamori runtime packages:

- environment variable parsing and defaults (`env.ts`),
- adapter contracts (`adapters/*`),
- default self-hosted adapter composition (`adapters/index.ts`),
- DB-backed log operations and retention helpers (`db.ts`).

## 2. Adapter Contracts

Core adapter interfaces:

- `DbAdapter`: async contract for `run`, `query`, `get`, `batch` (atomic), and `exec`.
- `AuthAdapter`: `verifyIngestToken(token)` returns `null | false | true | projectId`.
- `BillingAdapter`: ingest access and usage reporting hooks.
- `RetentionAdapter`: `getCutoffDate()` for retention cutoff or disabled mode.
- `McpAdapter`: `resolveDb(context?)` for MCP tool DB routing.
- `EmailAdapter`: optional notification hooks.
- `ServerPlugins`: optional cloud hooks (`getDbAdapter`, `verifyToken`, `checkIngestAccess`, `runRetention`).

Default self-hosted composition (`defaultAdapters()`):

- `db`: `BetterSqliteAdapter(DB_PATH)`
- `auth`: `EnvTokenAuth(INGEST_TOKEN)`
- `billing`: `NoBillingAdapter`
- `email`: `NoopEmailAdapter`
- `retention`: `EnvRetentionAdapter(RETENTION_DAYS)`
- `mcp`: `LocalDbMcpAdapter(db)`

## 3. Environment Parsing Contract

Env values are parsed once at module load in `env.ts`.

- Integer envs use `parseIntEnv(name, default)` and must be non-negative integers; invalid values throw.
- Key defaults:
  - `PORT=3110`, `HOST=0.0.0.0`
  - `INGEST_TOKEN=""`
  - `MCP_TOKEN=""`, `MCP_PORT=3111`
  - `DB_PATH=./data/logs/ingress.db` (resolved from cwd)
  - `RETENTION_DAYS=0` (disabled)
  - `ALLOWED_ORIGINS=[]` unless comma-separated env provided
- `ALLOWED_ORIGINS` parsing trims and filters empty entries; `"*"` is preserved as a normal entry and interpreted by `@usekamori/ingest`.

## 4. Database Schema and Storage

Default adapter is SQLite (`better-sqlite3`) with:

- `WAL` journal mode, `synchronous=NORMAL`, `foreign_keys=ON`, `busy_timeout=5000`.
- Migration tracking via `schema_migrations`.

### Statement cache (LRU, `STMT_CACHE_MAX = 64`)

`BetterSqliteAdapter._prepare(sql)` caches `better-sqlite3` `Statement` objects keyed by SQL string. Without eviction, `insertLogs` would accumulate up to `MAX_ROWS` (1,000) entries because it generates one unique SQL string per distinct batch size. The cache is bounded to `STMT_CACHE_MAX = 64` entries using a Map-based LRU policy:

- **Cache hit:** delete the entry and re-insert it (moves it to the most-recently-used position in insertion-order iteration).
- **Cache miss, at capacity:** delete the first Map key (oldest / least-recently-used) before inserting the new entry.
- **Cache miss, under capacity:** insert directly.

64 entries cover all realistic batch sizes (the SDK typically flushes at a fixed threshold) with room for static query strings; eviction only fires during adversarial or highly varied batch-size workloads.

### Event-loop blocking characteristic

`better-sqlite3` executes all SQL synchronously in the Node.js main thread. This blocks the event loop for the full duration of each call. A `setImmediate` yield before each DB method call (`run`, `query`, `get`, `batch`) gives already-queued callbacks a chance to run, but does not shorten the blocking period itself.

Approximate blocking durations:

| Operation | Typical |
|---|---|
| Single-row insert | < 1 ms |
| 1 000-row batch insert | 5–20 ms |
| FTS5 search on 1 M rows | 20–100 ms |
| Retention `DELETE` (large DB) | 100 ms – seconds |

Concurrency ceiling is roughly 100–200 simultaneous clients before tail latency becomes noticeable. The documented ~20 000 events/s batch throughput is a peak number measured without concurrent query load.

The cloud path (`LibSqlAdapter`) is unaffected — it issues HTTP requests to a remote libSQL/Turso server and awaits a real async network response.

### Tables and indexes

- Main table:
  - `logs(id, received_at, service, level, trace_id, body, body_hash)`
  - `body_hash` is the SHA-256 hex digest of `body`, used as the dedup key (migration 2).
- Materialized counter table:
  - `log_counts(service TEXT NOT NULL, level TEXT NOT NULL, count INTEGER)` with `PRIMARY KEY (service, level)` (migration 3).
  - `NULL` service/level values are normalized to `''` at insert time.
  - Updated transactionally inside `insertLogs` — always consistent with the `logs` table.
  - Counters only ever increase (deletes do not decrement) — correct Prometheus `counter` semantics.
  - Read by `getLogCounts()`, used by `/metrics` as an O(1) point-read instead of a full-table `GROUP BY`.
- Indexes:
  - `received_at`, `service`, `level`, `trace_id`, `(body_hash, received_at)`
- Full text index:
  - `logs_fts` (FTS5, content-linked to `logs`)
- Triggers keep FTS in sync on insert/delete.

## 5. Query Semantics

Core query functions in `db.ts` enforce these semantics:

- `insertLogs`:
  - normalizes `service`/`level`/`trace_id` from alias lists,
  - stores full JSON body with `received_at`,
  - deduplicates exact body matches in a 5-second window via `body_hash` IN-query (fixed 64-byte key, not full JSON blob),
  - updates `log_counts` in the same transaction: groups inserted rows by `(service, level)` and upserts the delta into `log_counts` using `ON CONFLICT DO UPDATE SET count = count + excluded.count`,
  - invalidates `listServices` cache on writes.
- `getLogCounts`:
  - point-read on `log_counts` — O(1) regardless of `logs` table size,
  - used by `/metrics` for Prometheus scraping; replaces the former full-table `GROUP BY` scan in `summarizeErrors`.
  - returns `{ service: string, level: string, count: number }[]` ordered by count DESC.
- `queryLogs`:
  - default ordering: newest first (`received_at DESC`),
  - with `after_id`: cursor mode (`id ASC`),
  - limit capped at 500.
- `searchLogs`:
  - FTS5 search with optional filters,
  - same ordering split as `queryLogs`,
  - limit capped at 500.
- `countLogs` / `countLogsFts`:
  - exact counts (not capped by row fetch limits),
  - bigint-safe conversion clamped to `Number.MAX_SAFE_INTEGER`.
- `exportLogs`:
  - higher cap (10,000) for export routes.
- `listServices`:
  - distinct service names, 5-minute TTL cache, coalesced in-flight rebuild.
  - Cache is **selectively invalidated** by `insertLogs`: only cleared when the batch contains a service name not already present in the cached list. Under sustained write load from a fixed set of services, the cache is never invalidated and the TTL functions as designed. A batch with only null-service rows never invalidates the cache. A `_resetServicesCache()` helper is exported for test isolation (each test creates a fresh DB, so module-scope cache state from the previous test is stale).

### FTS5 index maintenance after bulk delete

The `logs_ad` trigger writes one FTS5 soft-delete tombstone per deleted row. For normal user-initiated `deleteLogs` calls (small row counts) this is fine. For large purges via `purgeLogs`/`purgeExcessLogs` (thousands of rows across many chunks), the accumulated tombstones degrade `MATCH` query performance — every search must skip ghost entries proportional to the deleted/live row ratio.

After either purge function deletes at least one row, a full FTS5 index rebuild is triggered:

```sql
INSERT INTO logs_fts(logs_fts) VALUES('rebuild')
```

This rewrites the FTS index from scratch using the current `logs` table contents, producing a compact, tombstone-free index in a single O(N\_remaining) pass. This is strictly cheaper than N\_deleted individual trigger writes for large purges, and the cost is paid once at the end of a background cron rather than spread across ingest-critical transaction time.

The rebuild does not affect the `logs_ad` trigger — it remains active for all other deletes.

## 6. Retention Behavior

Retention behavior is adapter-driven:

- `EnvRetentionAdapter(RETENTION_DAYS)`:
  - `RETENTION_DAYS <= 0` => disabled (`null` cutoff),
  - otherwise cutoff is `now - retentionDays`.
- `purgeLogs(adapter, beforeDate, chunkSize=5000)`:
  - deletes in chunks by subselect to reduce long lock windows.
- `purgeExcessLogs(adapter, maxRows, chunkSize=5000)`:
  - row-count based trim (oldest rows first), chunked.
  - counts once before the loop; decrements by `rowsAffected` each iteration — O(n) not O(n²/chunk).

`@usekamori/ingest` invokes retention hourly, delegating to `plugins.runRetention` when supplied, otherwise using core purge logic.

## 7. DB Usage Across Server and MCP

- In default OSS mode, both server and MCP share the same `DbAdapter` instance created from `DB_PATH`.
- Server writes and queries this DB through core APIs.
- MCP tools resolve DB via `mcp.resolveDb(context)` and read/query the same dataset (including FTS views).
- Token usage is separate from DB path:
  - `INGEST_TOKEN` gates server `/v1/*`,
  - `MCP_TOKEN` gates MCP HTTP,
  - no fallback is defined between them in core.

## 8. Non-Goals

- `@usekamori/core` does not expose HTTP routes or transport behavior.
- It does not define UI/CLI flows.
- It does not implement cloud provider-specific SDKs directly; cloud behavior is injected via adapter/plugin contracts.
