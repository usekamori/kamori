# `@usekamori/ingest` Technical Specification

**Package:** `@usekamori/ingest`  
**Source root:** `packages/ingest/src`  
**Primary role:** OSS self-hosted HTTP ingest/query server for Kamori log data, with optional syslog ingest and operational endpoints.

## 1. Purpose

`@usekamori/ingest` exposes versioned REST endpoints for:

- ingesting log events (`/v1/ingest`),
- querying/searching/exporting/deleting logs (`/v1/*`),
- health and metrics (`/v1/health`, `/metrics`),
- webhook ingestion (`/v1/webhook/:provider`),
- optional live tailing (`/v1/stream`),
- optional syslog UDP/TCP ingestion (`SYSLOG_PORT`).

This package spec documents the OSS self-hosted runtime in `kamori/packages/ingest`.

## 2. Entrypoints and Exports

From `package.json`:

- main: `dist/ingest.js`
- exports:
  - `.` -> `dist/ingest.js`
  - `./build-server` -> `dist/build-server.js`

Source entrypoints:

- `src/ingest.ts`: OSS runtime bootstrap (`defaultAdapters()` + listen on `HOST:PORT`)
- `src/build-server.ts`: constructs configured Fastify instance (no listen side effect)

## 3. Runtime Architecture

## 3.1 Bootstrap (`server.ts`)

- loads env-derived `PORT`, `HOST`, `DB_PATH`.
- creates `defaultAdapters()` from `@usekamori/core`.
- builds app via `buildServer(adapters)`.
- calls `fastify.listen`.
- exits process with code 1 on startup failures.

## 3.2 App construction (`build-server.ts`)

Fastify configuration:

- logger level from `LOG_LEVEL`.
- pretty transport enabled when `NODE_ENV !== "production"`.
- request body limit from `BODY_LIMIT_BYTES`.

Registered middleware:

- `@fastify/helmet` with strict CSP, HSTS, frameguard, nosniff, no-referrer policy.
- `@fastify/cors`:
  - `ALLOWED_ORIGINS` empty -> CORS disabled (`origin: false`)
  - contains `"*"` -> allow all (`origin: true`)
  - otherwise -> explicit allowlist
- `@fastify/rate-limit`:
  - global max from `RATE_LIMIT_MAX` per minute
  - key selection priority:
    1. `Authorization: Bearer <token>` — token is SHA-256 hashed before use as the bucket key so raw secrets never appear in the rate-limit store (safe for Redis backends)
    2. `req.ip`

Top-level routes:

- `GET /metrics` (no auth): Prometheus text endpoint from aggregated DB counts.
- `v1` plugin mounted at `/v1`.

Background jobs:

- retention run once at startup and every 1 hour.
- retention source: `adapters.retention.getCutoffDate()` + `purgeLogs`.

Optional subsystems:

- syslog server starts when `SYSLOG_PORT > 0` (`startSyslogServer`).

Graceful shutdown:

- on `SIGINT` / `SIGTERM`: close Fastify, stop timers, close syslog sockets.
- hard timeout: 10s then force exit(1).
- `unhandledRejection` / `uncaughtException` -> log and exit(1).

## 3.3 Ingest request flow — Community (OSS)

```
POST /v1/ingest
  Authorization: Bearer <INGEST_TOKEN value, or omitted>
  Content-Type: application/json
  Body: [{...}, ...]

  1. Rate limiter — keyed by Authorization Bearer token, then IP
  2. auth preHandler
     └── EnvTokenAuth.verifyIngestToken(token)
         ├── no INGEST_TOKEN configured  → null  → allow (auth disabled)
         ├── token matches env var hash  → true  → allow
         └── token mismatch             → false → 401 Unauthorized
     request.projectId = undefined   ← always; no project concept in OSS
  3. NoBillingAdapter.checkIngestAccess(undefined) → always true
  4. db = adapters.db
     └── BetterSqliteAdapter(DB_PATH)  ← single fixed SQLite file, all requests
  5. maxRowBytes = MAX_ROW_BYTES env var (default 0 = disabled)
  6. insertLogs(db, rows, receivedAt, maxRowBytes)
  7. NoBillingAdapter.reportUsage()    → no-op
  8. 200 { ok: true, written, deduplicated?, oversized? }
```

Key properties:

- Token is a plain shared secret compared with timing-safe equality.
- There is one database. Every authenticated request reads/writes the same file.
- Billing and usage tracking do not exist.

## 3.4 Ingest request flow — Cloud (multi-tenant)

```
POST /v1/ingest
  Authorization: Bearer <Ed25519 JWT API key>
  Content-Type: application/json
  Body: [{...}, ...]

  1. Rate limiter — keyed by Authorization Bearer token (the JWT itself)
  2. plugins.verifyToken(token) hook  ← runs BEFORE the AuthAdapter
     └── adapters.verifyToken(token)  (from cloudServerPlugins)
         ├── verify JWT signature with INGEST_JWT_PUBLIC_KEY (stateless, no DB call)
         ├── invalid/expired signature  → throw → 401
         ├── check revokedKeyIds set (in-memory, refreshed from Postgres every 5 min)
         │   └── key id in blocklist    → throw → 401
         └── success → request.projectId = payload.pid
                        request.userId  = payload.uid
  3. ApiKeyAuthAdapter.verifyIngestToken() → always returns false
     (JWT already verified above; this adapter exists only to reject
      plain-text tokens that bypass the plugin hook)
  4. CloudBillingAdapter.checkIngestAccess(projectId)
     ├── resolve plan: getProject(pgPool) → getSubscriptionByUserId(pgPool)
     │   └── non-active/non-trialing status → treat as hobby plan
     ├── check PLAN_BYTE_LIMITS[plan]  — monthly bytes used >= limit → false
     ├── check PLAN_LINE_LIMITS[plan]  — monthly lines used >= limit → false
     └── false → 402 monthly ingest limit exceeded
  5. db = plugins.getDbAdapter(projectId)
     └── getProjectDbAdapter(projectId)
         ├── cache hit (15-min TTL, LRU cap 1000) → return cached LibSqlAdapter
         └── cache miss → getProject(pgPool, projectId)
             ├── project not found              → null → 500
             ├── project.dbUrl set              → LibSqlAdapter(project.dbUrl, TURSO_API_TOKEN)
             ├── SQLD_HOST set                  → LibSqlAdapter(SQLD_HOST,
             │                                      makeProjectToken(SQLD_JWT_KEY, slug),
             │                                      namespace=slug)
             └── neither                        → buildDbAdapter() fallback
  6. maxRowBytes = plugins.getMaxRowBytes(projectId)  ← plan-based limit from CloudBillingAdapter
  7. insertLogs(db, rows, receivedAt, maxRowBytes)  ← writes to THIS project's DB only
  8. CloudBillingAdapter.reportUsage(projectId, bytes, writtenRows)
     └── buffered in-memory; flushed to Postgres usage table every 5 seconds
  9. 200 { ok: true, written, deduplicated?, oversized? }
```

Key properties:

- Auth is stateless at request time (JWT signature verification, no DB round-trip).
- Revocation is near-real-time (blocklist refreshed every 5 min, loaded at startup).
- Each project has its own DB adapter instance; the 15-min LRU adapter cache (cap: 1 000 entries) prevents hammering Postgres on every request. When the cap is exceeded the least-recently-used entry is evicted; the next request for that project pays one Postgres round-trip to re-warm.
- Billing enforcement is also near-real-time: plan cache 5 min, usage cache 1 min.

## 4. Authentication and Authorization Model

Implemented in `v1` preHandler hook (`routes/v1.ts`).

Skip-auth routes:

- routes marked `config.skipAuth` bypass auth (`/v1/health`, `/metrics` top-level, webhook route scope).

Auth path (`adapters.auth.verifyIngestToken`):

- token extracted from `Authorization: Bearer` header.
- `null` -> auth disabled (allow).
- `false` -> `401 unauthorized`.
- `true`/`string` -> authenticated request.

Token scope notes:

- `INGEST_TOKEN` applies to server `/v1/*` auth only.
- `MCP_TOKEN` is not read by `@usekamori/ingest` auth logic (except MCP health probe using `MCP_PORT`).

## 4.1 Database usage

- Default adapter stack (`defaultAdapters`) wires `db = BetterSqliteAdapter(DB_PATH)`.
- All ingest/query/export/delete/summary routes use this DB adapter directly.
- Default DB path is `./data/logs/ingress.db` unless `DB_PATH` overrides it.

## 5. API Surface (`/v1`)

## 5.1 `GET /v1/health`

- skipAuth + rate-limit disabled.
- DB health via `SELECT 1`.
- optional MCP health check when `MCP_PORT` set (`http://localhost:${MCP_PORT}/health`, 2s timeout).
- response:
  - `200 { ok:true, checks:{ db:true, mcp?:boolean } }`
  - `503 { ok:false, checks:{ db:false, mcp?:boolean } }`
- `ok` is based on DB health only (MCP failure does not set `ok=false`).

## 5.2 `POST /v1/ingest`

- accepts JSON object or array of objects.
- validation/limits:
  - empty array -> `400 empty body`
  - rows > `MAX_ROWS` -> `413 too many log rows`
- billing gate:
  - `adapters.billing.checkIngestAccess(projectId)` false -> `402 monthly ingest limit exceeded`
  - default OSS adapter is `NoBillingAdapter` (always allows ingest)
- per-row size limit:
  - `maxRowBytes` resolved as: `plugins.getMaxRowBytes(projectId)` (cloud) or `MAX_ROW_BYTES` env var (OSS, default 0 = disabled).
  - single object whose serialised JSON exceeds `maxRowBytes` -> `413 { ok:false, error:"row too large", bytes, limit }`.
  - batch with some oversized rows: oversized rows skipped; remaining rows written.
  - batch where all rows are oversized -> `413 { ok:false, error:"all rows exceeded size limit", oversized }`.
- **concurrency cap** (OSS path back-pressure):
  - checked after auth, billing, and size validation — immediately before `resolveDb` / `insertLogs`.
  - if `INGEST_CONCURRENCY_LIMIT > 0` and `_inFlightWrites >= INGEST_CONCURRENCY_LIMIT` -> `503 { ok:false, error:"server busy, retry" }`.
  - `_inFlightWrites` is incremented synchronously before `resolveDb`; decremented in a `finally` block after `insertLogs` returns (or throws), so the counter is always consistent.
  - prevents event-loop starvation under burst write load on the `better-sqlite3` synchronous path. Cloud path (LibSQL async) is unaffected — the counter stays near zero.
  - default limit: `20`. Set `INGEST_CONCURRENCY_LIMIT=0` to disable.
  - **counter lifecycle**: module-scope `let _inFlightWrites`. The Fastify `onClose` hook calls `_resetInFlightWrites()` on shutdown. Exported test helpers: `_getInFlightWrites()`, `_resetInFlightWrites()`, `_setInFlightWritesForTest(n)`.
- writes via `insertLogs(db, rows, nowIso, maxRowBytes)`.
- async fire-and-forget usage reporting:
  - `reportUsage(projectId, bytes, written)`, failures logged as warnings.
- responses:
  - full success: `{ ok:true, written, deduplicated? }`
  - partial batch (some rows oversized): `{ ok:true, written, deduplicated?, oversized: [{index, bytes}] }`
  - server busy (cap exceeded): `503 { ok:false, error:"server busy, retry" }`
  - DB failure: `503 { ok:false, error:"db insert failed" }`

## 5.3 `GET /v1/logs`

- filters: `service`, `level`, `since`, `until`, `trace_id`, `after_id`, `limit`.
- parsing:
  - safe integer parsing (`parseSafeInt`) with fallback defaults.
  - `limit` capped at 500.
- response: `{ logs: LogRow[], count }`.

## 5.4 `GET /v1/search`

- requires `q`.
- `q` length max 1000 chars.
- optional filters: `service`, `since`, `until`, `after_id`, `limit`.
- response: `{ logs: LogRow[], count }`.

## 5.5 `GET /v1/services`

- returns distinct services: `{ services: string[] }`.

## 5.6 `GET /v1/summary`

- optional `since` and `until` (ISO-8601) to restrict the time window.
- returns grouped service/level counts.

## 5.7 `GET /v1/export`

- formats:
  - default `ndjson` (`application/x-ndjson`)
  - `csv` (`text/csv`)
- filters: `service`, `level`, `since`, `until`, `limit`.
- export limit max: `10_000`.
- true streaming via `PassThrough`: headers and pipe sent before DB fetch begins; each 500-row batch is written as it arrives so only one batch occupies the heap at a time.
- CSV protections:
  - RFC4180 escaping
  - formula injection guard (prefix `'` for dangerous leading chars).

## 5.8 `DELETE /v1/logs`

- requires at least one of:
  - `before`
  - `service`
- otherwise: `400`.
- route-level stricter rate-limit: `10/min`.
- response: `{ ok:true, deleted }`.

## 5.9 `GET /v1/logs/alert`

- query: `minutes`, `level`, `service`.
- minutes default 60, capped at 10080 (7 days).
- computes `since` and returns `{ count }`.

## 5.10 `GET /v1/stream` (NDJSON live tail)

- returns chunked NDJSON stream.
- connection cap: 50 simultaneous streams; overflow -> `503`.
- query filters: `service`, `level`, `after_id`.
- **event-driven delivery**: after a successful ingest write (`written > 0`), the ingest handler wakes all active stream pollers immediately:
  - OSS: emits on `_logsEmitter` (in-process `EventEmitter`), channel `"logs:<projectId>"` (or `"logs:_"` for single-tenant).
  - Cloud: calls `ServerPlugins.notifyNewLogs(projectId)` which sends a Postgres NOTIFY; pollers subscribe via `ServerPlugins.subscribeToLogs` (Postgres LISTEN on a dedicated `pg.Client`).
- **5-second heartbeat** `setInterval` per connection ensures delivery on quiet streams and guards against missed notifications.
- per poll fetches up to 50 new rows and writes JSON lines.
- cleans up heartbeat, event subscription, and stream on connection close.
- **connection counter (`_streamConnections`)**: module-scope `let` incremented synchronously (before any `await`) to avoid TOCTOU. The Fastify `onClose` hook calls `_resetStreamConnections()` when the server shuts down so the counter is always zero for a restarted server instance reusing the same module cache. Exported test helpers: `_getStreamConnectionCount()`, `_resetStreamConnections()`, `_setStreamConnectionsForTest(n)`.

### `DELETE /v1/logs` — ownership model

- **OSS / self-hosted**: single-tenant by design. One `INGEST_TOKEN`, one process, one database. Any bearer of the token has full write access; no per-resource ownership check is needed.
- **Cloud / multi-tenant**: `resolveDb(request.projectId)` routes each request to the tenant-scoped `DbAdapter` derived from the JWT `pid` claim. A valid token for project A cannot reach project B's database — isolation is structural.
- Additional safeguards: auth-gated (`preHandler`), rate-limited (10 req/min), requires at least one filter condition (`before` or `service`).

## 5.11 `POST /v1/webhook/:provider`

- skipAuth route, route-level rate limit 30/min, body limit 1MB.
- raw-buffer JSON parser for signature verification on exact bytes.
- provider verification (`lib/webhook.ts`):
  - `vercel`: HMAC-SHA1 via `x-vercel-signature`
  - `github`: HMAC-SHA256 via `x-hub-signature-256` (`sha256=<hex>`)
  - `render`: `render-signature` (`t=<ts>,v1=<hex>`) with +/-300s replay window
  - unknown providers: pass-through when no configured secret
- invalid signature -> `401`.
- invalid JSON -> `400`.
- successful ingest writes normalized rows and returns `{ ok:true, written, provider }`.

## 6. Metrics Contract (`GET /metrics`)

Intended for self-hosted Prometheus/Grafana stacks. Cloud dashboards use the REST API (`/v1/summary` etc.) directly and do not rely on this endpoint.

- output content type: `text/plain; version=0.0.4`.
- always reads `adapters.db` (the default OSS DB) — not project-aware.
- metric emitted:
  - `kamori_logs_total{service="<...>",level="<...>"} <count>`
- labels sanitized for Prometheus text format (`\`, `"`, newline escaping).
- data source: `getLogCounts(adapters.db)` — reads from the materialized `log_counts` table, an O(1) point-read on ~10–100 rows regardless of `logs` table size. Previously used `summarizeErrors()` which performed a full table scan on every scrape (every 15 s by default), blocking the event loop for up to seconds on large tables.

Auth (controlled by `METRICS_TOKEN` env var):

- `METRICS_TOKEN` not set (default): no auth required — unauthenticated Prometheus scrapers work out of the box.
  - Self-hosted users who want to restrict access should set `METRICS_TOKEN` or block `/metrics` at the reverse proxy.
- `METRICS_TOKEN` set: requires `Authorization: Bearer <METRICS_TOKEN>`.
  - Missing or non-matching token → `401 { error: "unauthorized" }`.
  - Token comparison is timing-safe (SHA-256 digest).

## 7. Syslog Subsystem (`syslog.ts`)

**OSS / self-hosted only.** Disabled when `CLOUD_MODE=true` — syslog has no authentication and cannot route to per-project databases in a multi-tenant deployment.

Enabled when `SYSLOG_PORT > 0` and `CLOUD_MODE` is not set.

Bind address: `SYSLOG_HOST` env var (default `127.0.0.1`). Both UDP and TCP listeners bind to the same host and port. The loopback default means the port is not reachable from the network unless explicitly overridden.

Protocol support:

- RFC3164 and RFC5424 parsing (best-effort fallback to raw message).
- listens on both UDP and TCP same port + host.

Ingestion behavior:

- internal batching:
  - flush every 100 events or 100ms.
- UDP:
  - error logging throttled to once per 5s.
- TCP:
  - newline-framed parsing,
  - per-connection buffer cap 64KB,
  - socket timeout 30s,
  - connection cap 100.

## 8. Security Characteristics

- strict helmet headers and CSP baseline.
- timing-safe comparisons in auth/webhook utilities.
- CORS controlled by `ALLOWED_ORIGINS` with explicit `*` semantics.
- safe numeric parsing for query params.
- ISO-8601 format validation for `since`/`until` params on `/v1/logs`, `/v1/search`, `/v1/summary`, `/v1/export` — invalid values return `400` before reaching the DB.
- rate-limit bucket keys are SHA-256 hashes of bearer tokens, not the raw secrets, making the store safe for Redis-backed deployments.
- CSV formula injection mitigation in exports.
- webhook signature verification uses raw body bytes.

## 9. Environment Contract (consumed)

Key env vars used by server package:

- `PORT`, `HOST`
- `INGEST_TOKEN`
- `LOG_LEVEL`, `NODE_ENV`
- `BODY_LIMIT_BYTES`, `MAX_ROWS`, `MAX_ROW_BYTES`, `RATE_LIMIT_MAX`, `INGEST_CONCURRENCY_LIMIT`
- `DB_PATH`
- `MCP_PORT`
- `RETENTION_DAYS` (via retention adapter)
- `SYSLOG_PORT`, `SYSLOG_HOST` (default `127.0.0.1`)
- `WEBHOOK_SECRET_VERCEL`, `WEBHOOK_SECRET_GITHUB`, `WEBHOOK_SECRET_RENDER`
- `ALLOWED_ORIGINS`

## 10. Tested Guarantees (from test suite)

- Auth behaviors (missing/wrong token, disabled auth path).
- Ingest success/failure and DB persistence.
- Ingest concurrency cap: 503 when `_inFlightWrites >= INGEST_CONCURRENCY_LIMIT`; counter resets on `app.close()`; disabled when limit is 0.
- Health endpoint status semantics.
- Query/search/services/summary/export/delete flows.
- Webhook signature paths for vercel/github/render and unknown providers.
- Metrics routing/sanitization and retention branch behavior.
- End-to-end server + SDK + MCP integration path.

## 11. Non-Goals / Out of Scope

- Real-time push protocol beyond NDJSON polling stream (no SSE/WebSocket).
- Complex role-based authorization in OSS path (token-based only).
- Guaranteed delivery semantics for syslog/network clients.
