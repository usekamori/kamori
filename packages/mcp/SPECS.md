# `@usekamori/mcp` Technical Specification

**Package:** `@usekamori/mcp`  
**Source root:** `packages/mcp/src`  
**Primary role:** expose Kamori log data to MCP-compatible clients over stdio or Streamable HTTP.

## 1. Purpose

`@usekamori/mcp` provides an MCP server that wraps Kamori’s database/query primitives as MCP tools for AI clients (Claude Code, Cursor, etc.).

The package supports:

- **stdio transport** for client-spawned local usage.
- **Streamable HTTP transport** for long-running/containerized usage.

## 2. Entrypoints and Exports

From `package.json`:

- main: `dist/mcp.js`
- exports:
  - `.` -> `dist/mcp.js`
  - `./start-mcp` -> `dist/start-mcp.js`
  - `./build-mcp-server` -> `dist/build-mcp-server.js`
  - `./tools` -> `dist/tools.js`

Runtime scripts:

- `npm run start` -> HTTP mode by default
- `npm run start:stdio` -> passes `--stdio`

## 3. Mental Model: Community vs Cloud MCP

The MCP server code (`build-mcp-server.ts`, `tools.ts`) is **identical** in both editions. The only difference is the `McpAdapter` implementation injected at startup.

```
AI client (Claude Code, Cursor, …)
        │  Authorization: Bearer <token>
        ▼
  /mcp  (same binary)
        │
        │  adapters.mcp.resolveDb({ token })
        │
        ├── Community (OSS)
        │   LocalDbMcpAdapter
        │   └── always returns adapters.db
        │       (BetterSqliteAdapter, same file as ingest server)
        │       token is IGNORED for DB routing
        │
        └── Cloud
            CloudMcpAdapter
            └── verifies JWT → extracts pid → getProjectDbAdapter(pid)
                token REQUIRED; missing/invalid throws immediately
```

In Community mode the bearer token (if any) only gates HTTP access (`MCP_TOKEN` check) but is never used for DB routing. In Cloud mode the same Ed25519 JWT used for ingest also determines which project DB the MCP tools query.

## 3.1 Request flow — Community (OSS)

```
MCP tool call  e.g. query_logs({ service: "api", limit: 20 })
  Authorization: Bearer <MCP_TOKEN, if set>  ← optional gate

HTTP mode:
  1. MCP_TOKEN env non-empty?
     ├── yes: timing-safe compare of sha256(incoming) vs sha256(MCP_TOKEN)
     │         mismatch → 401 { error: "unauthorized" }
     └── no:  allow
  2. first POST /mcp (no Mcp-Session-Id) → create new session
     buildMcpServer(adapters, token=undefined)
     (token is the MCP_TOKEN bearer — not an API key; irrelevant for DB routing)
  3. tool handler: query_logs
     └── db = adapters.mcp.resolveDb({ token: undefined })
         └── LocalDbMcpAdapter.resolveDb() → returns adapters.db
             (BetterSqliteAdapter fixed to DB_PATH — always)
  4. queryLogs(db, args)
  5. { content: [{ type: "text", text: "..." }] }

stdio mode:
  1. no network auth layer
  2. buildMcpServer(adapters, token=STDIO_TOKEN)
     STDIO_TOKEN is passed through to context but LocalDbMcpAdapter ignores it
  3–5. same as above
```

## 3.2 Request flow — Cloud (multi-tenant)

```
MCP tool call  e.g. query_logs({ service: "api", limit: 20 })
  Authorization: Bearer <Ed25519 JWT API key>  ← same key used for ingest

HTTP mode:
  1. MCP_TOKEN env non-empty? → optional global gate (same as OSS)
  2. first POST /mcp (no Mcp-Session-Id) → create new session
     bearer token extracted from Authorization header
     buildMcpServer(adapters, token=<jwt>)
     session is bound to this token for its lifetime
  3. tool handler: query_logs
     └── db = adapters.mcp.resolveDb({ token: <jwt> })
         └── CloudMcpAdapter.resolveDb({ token })
             ├── !token
             │   └── throw "MCP: authentication required"  → MCP error response
             ├── !INGEST_JWT_PUBLIC_KEY
             │   └── throw "MCP: server misconfiguration"  → MCP error response
             ├── verifyIngestToken(token, INGEST_JWT_PUBLIC_KEY)
             │   ├── invalid/expired → throw "MCP: invalid or expired API key"
             │   └── valid → payload { sub (key id), pid (project id), uid }
             ├── revokedKeyIds.has(payload.sub)
             │   └── throw "MCP: API key revoked"
             └── getProjectDbAdapter(payload.pid)
                 ├── not found → throw "MCP: project not found (<pid>)"
                 └── found → LibSqlAdapter (this project's DB)
  4. queryLogs(db, args)  ← reads from this project's DB only
  5. { content: [{ type: "text", text: "..." }] }

Key properties:
- Each HTTP session is isolated: buildMcpServer is called once per session
  with that session's bearer token. Concurrent AI clients with different API
  keys hit completely separate project databases.
- The JWT is verified fresh on every tool call (resolveDb called per invocation).
  If a token expires mid-session, the next tool call throws a clean MCP error
  rather than silently returning stale/wrong data.
- The adapter cache (5-min TTL in entrypoint) prevents Postgres round-trips
  on every tool call within the same session.

stdio mode (cloud):
  1. STDIO_TOKEN env set to the JWT API key
  2. buildMcpServer(adapters, token=STDIO_TOKEN)
  3–5. same CloudMcpAdapter path as HTTP mode above
```

## 4. Runtime Architecture

## 4.1 Bootstrap (`src/mcp.ts`)

- loads `defaultAdapters()` from `/core`.
- logs startup metadata (`DB_PATH`, `MCP_PORT`).
- exits with code 1 on adapter init/start failure.
- delegates transport setup to `startMcp(adapters)`.

## 4.2 Transport and HTTP Server (`src/start-mcp.ts`)

Transport selection:

- if `process.argv` contains `--stdio`:
  - create `StdioServerTransport`,
  - build server with token context from `STDIO_TOKEN`,
  - connect and return.
- otherwise:
  - run Streamable HTTP server on `MCP_PORT`,
  - endpoint contract:
    - `POST /mcp`
    - `GET /mcp`
    - `DELETE /mcp`
  - health endpoint:
    - `GET /health` (checks DB with `SELECT 1`).

## 4.3 Session model (HTTP mode)

- MCP sessions keyed by `Mcp-Session-Id` header.
- each new session gets its **own** `McpServer` + `StreamableHTTPServerTransport`.
- session map stores:
  - transport instance
  - `lastActivityAt` timestamp
- idle session TTL:
  - 1 hour inactivity expiry
  - sweep interval every 5 minutes
- on transport close: session removed from map.

## 4.4 Session expiry at JWT expiry

When a session is created with a JWT bearer token (cloud API key), a timer is
scheduled to close the transport at the exact moment the key expires:

```
scheduleSessionExpiry(transport, bearerToken, onClose)
  └── decodeJwtExpiry(token)        ← decode exp from payload, no sig check
      ├── non-JWT or no exp claim   → no timer set
      ├── already expired           → no timer set (first tool call will throw)
      └── exp in future             → setTimeout(msUntilExpiry).unref()
          └── transport.close()
              onClose()             ← removes session from map
```

This ensures the AI client receives a clean disconnect at key expiry rather
than a confusing `"MCP: invalid or expired API key"` error mid-conversation.
The timer is `unref()`'d so it does not prevent process exit.

**32-bit setTimeout overflow guard:** Node's `setTimeout` uses a 32-bit signed
integer for the delay, which overflows at 2,147,483,647 ms (~24.8 days) and
fires *immediately* for larger values. Current API keys have a 90-day TTL
(~7.8 billion ms), well beyond this limit. When `msUntilExpiry > MAX_TIMER_MS`
no timer is set — the inactivity TTL sweep (1 h) and revocation blocklist
cover long-lived sessions adequately.

For plain `MCP_TOKEN` bearers (OSS) `decodeJwtExpiry` returns null and no
timer is set — the session lives until idle TTL or explicit DELETE.

## 4.5 HTTP request handling constraints

- body limit: `4 MB` (`BODY_LIMIT_BYTES` constant).
- JSON body parsing:
  - invalid JSON -> `400 { error: "invalid JSON body" }`
  - oversized body -> `413 { error: "request body too large" }`
- security headers always set:
  - `X-Content-Type-Options: nosniff`
  - `X-Frame-Options: DENY`
  - `Referrer-Policy: no-referrer`
  - `X-Permitted-Cross-Domain-Policies: none`

## 4. Authentication Model

## 4.1 HTTP mode auth

- if `MCP_TOKEN` env var is non-empty:
  - requires `Authorization: Bearer <token>`,
  - token check uses timing-safe compare (`sha256` hashes + `timingSafeEqual`).
- invalid/missing token when required -> `401 { error: "unauthorized" }`.
- `/health` is not gated by `MCP_TOKEN`.
- `MCP_TOKEN` is independent from `INGEST_TOKEN`; there is no fallback or inheritance.

## 4.2 stdio mode auth context

- no network auth layer.
- token context forwarded from `STDIO_TOKEN` env var into server context for adapter-level DB resolution.

## 5. MCP Server Construction (`src/build-mcp-server.ts`)

`buildMcpServer(adapters, token?)`:

- instantiates `McpServer` with:
  - name: `kamori`
  - version: `1.0.0`
- builds context:
  - `{ token }` when token provided,
  - `undefined` otherwise.
- each tool resolves DB via:
  - `await adapters.mcp.resolveDb(ctx)`.

This enables multi-tenant routing in cloud adapters while preserving OSS/local behavior.

## 5.1 Database usage

- MCP tools never write ingestion rows; they query via core DB APIs (`queryLogs`, `searchLogs`, `countLogs`, etc.).
- DB adapter selection is delegated to `adapters.mcp.resolveDb(ctx)` for every tool call.
- In OSS/default adapters, this resolves to the same SQLite adapter instance used by server ingest (`BetterSqliteAdapter(DB_PATH)`), so MCP queries the same `logs` + `logs_fts` data.

## 6. Tool Surface

Registered tools (13 total):

1. `query_logs`
2. `search_logs`
3. `list_services`
4. `summarize_errors`
5. `tail_logs`
6. `get_log`
7. `alert_summary`
8. `watch_logs`
9. `anomaly_hint`
10. `query_field`
11. `histogram`
12. `trace_logs`
13. `query_sql`

All handlers return MCP text content:

- shape: `{ content: [{ type: "text", text: string }] }`

## 7. Tool Handler Specifications (`src/tools.ts`)

## 7.1 `query_logs`

- passthrough to `queryLogs(adapter, args)`.
- output: newline-joined raw `body` strings.
- empty result message: `"No logs found matching the given filters."`

## 7.2 `search_logs`

- FTS via `searchLogs`.
- supports `query`, optional `service/since/until/limit`.
- empty result message: `"No logs matched the search query."`

## 7.3 `list_services`

- uses `listServices`.
- outputs newline-separated service names.
- empty result message indicates no services/logs.

## 7.4 `summarize_errors`

- uses `summarizeErrors(adapter, since?)`.
- outputs lines:
  - `service=<...>  level=<...>  count=<n>`
- empty result message: `"No log data found."`

## 7.5 `tail_logs`

- cursor polling by `after_id`.
- when `query` provided: uses FTS search path.
- otherwise: uses normal filtered query path.
- returns:
  - `<n> new log(s). last_id=<id>` + bodies, or
  - `No new logs. last_id=<id> ...`

## 7.6 `get_log`

- fetches single row by numeric ID.
- output is row `body` or not-found message:
  - `Log id=<id> not found.`

## 7.7 `alert_summary`

- computes `since = now - minutes` (default 60 min).
- counting logic:
  - with `query`: exact FTS count via `countLogsFts` (not capped by row fetch limits),
  - without `query`: `countLogs`, default `level="error"` unless overridden.
- output:
  - `<count> matching log entries in the last <minutes> minutes.`

## 7.8 `watch_logs`

- long-poll loop until deadline:
  - timeout default: **15s** (handler default),
  - caller may pass `timeout_seconds`.
- query cadence uses exponential backoff on empty polls:
  - 1s -> 2s -> 4s -> capped at 5s.
- success returns new rows and `last_id`.
- timeout returns:
  - `No new logs in <seconds>s. last_id=<id> ...`

## 7.9 `anomaly_hint`

- compares recent window rate vs 7-day baseline.
- defaults:
  - `window_minutes = 60`
  - `level = "error"`
- computes:
  - `recent_count`, `baseline_count`
  - per-minute rates
  - spike factor + natural-language hint classification.
- baseline caching:
  - key: `<service>:<level>:<windowMinutes>`
  - TTL: 1 hour
  - max entries: 500 (evict oldest on overflow)

## 8. HTTP Endpoint Behavior (Streamable mode)

`/mcp`:

- `POST`:
  - without session header -> create new session and ingest/transport.
  - with valid session header -> reuse existing transport.
  - with unknown session header -> `404 session not found`.
- `GET`:
  - requires valid `Mcp-Session-Id`, else `400 missing or invalid session id`.
- `DELETE`:
  - requires valid session, closes/removes it and returns `{ ok: true }`.
  - unknown session -> `404 session not found`.

Unmatched routes -> `404`.

## 9. Operational Guarantees

- graceful shutdown:
  - `SIGINT` / `SIGTERM` close HTTP server then exit.
- session cleanup:
  - stale sessions are periodically closed and removed.
- bounded memory protections:
  - body size limit on incoming requests,
  - session TTL sweeper,
  - anomaly baseline cache cap.

## 7.10 `query_field`

- delegates to `queryByField(adapter, args)`.
- validates `field` against `/^[a-zA-Z_][a-zA-Z0-9_.]*$/` before interpolating into JSONPath — invalid field names return an error text block rather than throwing to the MCP layer.
- validates `op` is one of `= != > >= < <=` — same error-text behaviour on invalid op.
- `value` is always passed as a query parameter, never interpolated.
- output: newline-joined raw `body` strings.
- not-found message: `"No logs found where <field> <op> <value>."`

## 7.11 `histogram`

- delegates to `histogramLogs(adapter, { ...args, since })`.
- `since` defaults to `now - 7 days` when not supplied by the caller. This prevents a full table scan: without a lower bound the `GROUP BY strftime(...)` aggregation must read every row in the table, which blocks the event loop for seconds on large databases. The `received_at` index is only useful when a `WHERE received_at >= ?` clause is present.
- bucket sizes in seconds: `1m`=60, `5m`=300, `15m`=900, `1h`=3600, `6h`=21600, `1d`=86400.
- uses SQLite integer division (`cast(? as integer)`) to snap Unix timestamps to bucket boundaries.
- output lines: `<ISO-bucket>  count=<n>`, ordered ASC.
- empty result message: `"No log data found for the given filters."`

## 7.12 `trace_logs`

- delegates to `queryLogs(adapter, { trace_id, after_id: 0, limit })`.
- `after_id: 0` triggers oldest-first ordering in `queryLogs`, giving chronological trace reconstruction.
- output: newline-joined raw `body` strings.
- not-found message: `"No logs found for trace_id=\"<id>\"."`

## 7.13 `query_sql`

- accepts only `SELECT` statements (validated via `/^\s*select\b/i`).
- rejects queries containing semicolons (prevents statement stacking).
- **table allowlist**: extracts all `FROM`/`JOIN` table references via regex and rejects any name not in `{ "logs", "logs_fts" }`. Subquery parentheses (`FROM (SELECT ...)`) produce no match and pass through cleanly. System tables (`sqlite_master`, `sqlite_sequence`, etc.) are rejected before the query reaches the adapter.
- wraps user SQL in `SELECT * FROM (<sql>) LIMIT <limit>` to enforce the row cap while preserving inner `ORDER BY`.
- limit capped at 500; default 100.
- on SQL error: returns `"SQL error: <message>"` as text — does not throw to the MCP layer.
- output: newline-joined `JSON.stringify(row)` strings.
- empty result message: `"Query returned no rows."`

## 10. Tested Guarantees (from `src/*.test.ts`)

- all 13 tools are registered by `buildMcpServer`.
- each tool resolves DB through `adapters.mcp.resolveDb` with proper token context.
- each tool handler returns expected text formats/empty messages.
- tool composition works against real SQLite adapter (integration tests).
- alert/anomaly counts are internally consistent in integrated flows.
- `decodeJwtExpiry`: returns correct `exp` for valid JWTs; `null` for non-JWTs, missing/wrong-typed `exp`, malformed base64, empty string.
- `scheduleSessionExpiry`: no timer for non-JWT tokens; no timer when `exp` absent or already expired; no timer when delay exceeds 32-bit limit (90-day keys); transport closed and `onClose` called at exact expiry millisecond (fake timers); `onClose` called even when `transport.close()` rejects.

## 11. Non-Goals / Out of Scope

- rich typed MCP content beyond plain text blocks.
- persistent external session store (sessions are in-memory per process).
- custom auth schemes beyond optional bearer token gate in HTTP mode.
