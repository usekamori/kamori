# @usekamori/mcp

MCP (Model Context Protocol) server for Kamori. Exposes your ingested logs to Claude Code, Claude Desktop, Cursor, and any other MCP-compatible AI assistant.

## What it does

Provides 13 MCP tools over the shared SQLite database:

- `query_logs` — filter logs by service, level, time range
- `search_logs` — full-text search using SQLite FTS5
- `list_services` — discover what services have logged
- `summarize_errors` — grouped counts by service + level
- `tail_logs` — cursor-based incremental polling (`after_id`), optional FTS query filter
- `get_log` — fetch a single log row by `id`
- `alert_summary` — count errors in the last N minutes
- `watch_logs` — long-poll up to 60s for new logs
- `anomaly_hint` — compare recent error rate to 7-day baseline
- `query_field` — filter by a JSON body field with `=`, `!=`, `>`, `>=`, `<`, `<=`
- `histogram` — time-bucketed event counts (`1m` / `5m` / `15m` / `1h` / `6h` / `1d`)
- `trace_logs` — all events for a `trace_id` in chronological order
- `query_sql` — read-only SQL escape hatch for arbitrary SELECT queries

Two transport modes:

- **stdio** — spawned as a subprocess by your AI client (default, recommended for local use)
- **Streamable HTTP** — runs as a persistent HTTP server for Docker/remote use

## Start

### Build the mcp package

npm run build --workspace=@usekamori/mcp

### Then run it

MCP_PORT=3111 node packages/mcp/dist/mcp.js

## stdio vs Streamable HTTP

|               | stdio                             | Streamable HTTP                    |
| ------------- | --------------------------------- | ---------------------------------- |
| Started by    | AI client (on demand)             | You (always running)               |
| Use case      | Local dev, Claude Code, Cursor    | Docker, remote, shared team server |
| Auth          | Process-level (trust the spawner) | Bearer token via `MCP_TOKEN`       |
| Start command | `node dist/mcp.js`                | `node dist/mcp.js`                 |

## Configuration

| Variable    | Default                  | Description                     |
| ----------- | ------------------------ | ------------------------------- |
| `DB_PATH`   | `./data/logs/ingress.db` | Path to the SQLite log database |
| `MCP_PORT`  | `3111`                   | Streamable HTTP listen port     |
| `MCP_TOKEN` | —                        | Bearer token for HTTP mode auth |

## Authentication

### stdio

Reads `DB_PATH` directly. No network auth — process-level trust.

```json
{
  "mcpServers": {
    "kamori": {
      "command": "node",
      "args": ["packages/mcp/dist/mcp.js"],
      "env": { "DB_PATH": "/absolute/path/to/data/logs/ingress.db" }
    }
  }
}
```

### Streamable HTTP (Docker)

```json
{
  "mcpServers": {
    "kamori": {
      "url": "http://localhost:3111/mcp",
      "headers": { "Authorization": "Bearer your-mcp-token" }
    }
  }
}
```

## Tool Reference

### query_logs

Fetch log entries with optional filters. Returns up to 500 rows, most recent first.

| Argument  | Type    | Description                                        |
| --------- | ------- | -------------------------------------------------- |
| `service` | string? | Filter by service name                             |
| `level`   | string? | Filter by log level (e.g. `error`, `warn`, `info`) |
| `since`   | string? | ISO8601 start time                                 |
| `until`   | string? | ISO8601 end time                                   |
| `limit`   | number? | Max rows to return (1–500, default 100)            |

### search_logs

Full-text search across all log bodies. Uses SQLite FTS5 — supports quoted phrases and boolean operators.

| Argument  | Type    | Description                                        |
| --------- | ------- | -------------------------------------------------- |
| `query`   | string  | FTS5 query, e.g. `"connection refused" OR timeout` |
| `service` | string? | Narrow to a specific service                       |
| `since`   | string? | ISO8601 start time                                 |
| `until`   | string? | ISO8601 end time                                   |
| `limit`   | number? | Max rows to return (default 100)                   |

### list_services

No arguments. Returns a newline-separated list of distinct service names seen in the logs.

### summarize_errors

| Argument | Type    | Description                                    |
| -------- | ------- | ---------------------------------------------- |
| `since`  | string? | ISO8601 start time — omit for all-time summary |

Returns grouped counts: `service=myapp  level=error  count=42`

### tail_logs

Cursor-based incremental polling. Returns new rows with `id` greater than `after_id`. Supports an optional FTS query filter. Designed for repeated polling — store the highest `id` from each response and pass it as `after_id` on the next call.

| Argument   | Type    | Description                                        |
| ---------- | ------- | -------------------------------------------------- |
| `after_id` | number? | Return only rows with `id` greater than this value |
| `query`    | string? | FTS5 query to filter results                       |
| `limit`    | number? | Max rows to return (default 100)                   |

### get_log

Fetch a single log row by its `id`. Returns the full event body as pretty-printed JSON.

| Argument | Type   | Description     |
| -------- | ------ | --------------- |
| `id`     | number | Row ID to fetch |

### alert_summary

Count log events matching filters in the last N minutes. Useful for quickly surfacing active incidents.

| Argument  | Type    | Description                           |
| --------- | ------- | ------------------------------------- |
| `minutes` | number  | Look-back window in minutes           |
| `service` | string? | Filter by service name                |
| `query`   | string? | FTS5 query filter                     |
| `level`   | string? | Log level to count (default: `error`) |

### watch_logs

Long-poll for new logs. Blocks for up to `timeout_seconds` (max 60) and returns as soon as new rows appear after `after_id`. Useful for streaming-style monitoring without a persistent SSE connection.

| Argument          | Type    | Description                                     |
| ----------------- | ------- | ----------------------------------------------- |
| `after_id`        | number? | Wait for rows with `id` greater than this value |
| `timeout_seconds` | number? | Max seconds to wait (1–60, default 30)          |
| `service`         | string? | Filter by service name                          |
| `level`           | string? | Filter by log level                             |
| `limit`           | number? | Max rows to return (default 50)                 |

### anomaly_hint

Compare the error rate in the last `window_minutes` against the 7-day baseline for the same service and level. Returns a plain-English summary indicating whether the current rate looks anomalous.

| Argument         | Type    | Description                             |
| ---------------- | ------- | --------------------------------------- |
| `window_minutes` | number? | Recent window to evaluate (default 15)  |
| `service`        | string? | Filter by service name                  |
| `level`          | string? | Log level to analyse (default: `error`) |

### query_field

Filter logs by a named JSON body field using a comparison operator. Handles numeric and string comparisons that FTS5 cannot express (e.g. `ms > 500`, `statusCode != 200`).

| Argument  | Type           | Description                                                              |
| --------- | -------------- | ------------------------------------------------------------------------ |
| `field`   | string         | JSON body field, e.g. `statusCode`, `ms`, `meta.userId` (dot notation)  |
| `op`      | string         | Operator: `=` `!=` `>` `>=` `<` `<=`                                    |
| `value`   | string\|number | Value to compare against                                                 |
| `service` | string?        | Narrow to a specific service                                             |
| `since`   | string?        | ISO8601 start time                                                       |
| `until`   | string?        | ISO8601 end time                                                         |
| `limit`   | number?        | Max rows to return (1–500, default 100)                                  |

### histogram

Time-bucketed count of log entries. Returns a series of `<ISO-timestamp>  count=<n>` lines showing how log volume changes over time. Useful for finding error rate spikes or visualising the impact of a deployment.

| Argument  | Type    | Description                                                |
| --------- | ------- | ---------------------------------------------------------- |
| `bucket`  | string  | Bucket width: `1m`, `5m`, `15m`, `1h`, `6h`, or `1d`      |
| `service` | string? | Narrow to a specific service                               |
| `level`   | string? | Filter by log level                                        |
| `since`   | string? | ISO8601 start time                                         |
| `until`   | string? | ISO8601 end time                                           |

### trace_logs

Fetch all log entries for a given `trace_id` in chronological order. Use this to reconstruct the full request chain across services in a single call.

| Argument   | Type    | Description                                      |
| ---------- | ------- | ------------------------------------------------ |
| `trace_id` | string  | Trace / request / correlation id to look up      |
| `limit`    | number? | Max rows to return (1–500, default 200)          |

### query_sql

Read-only SQL escape hatch. Runs a single `SELECT` statement directly against the `logs` table. Use this when the structured tools cannot express the query you need (e.g. window functions, complex `GROUP BY`, multi-field correlations). Semicolons are rejected to prevent statement stacking. Queries may only reference the `logs` and `logs_fts` tables — system tables (`sqlite_master`, etc.) are blocked.

The `logs` table schema:

| Column       | Type    | Description                         |
| ------------ | ------- | ----------------------------------- |
| `id`         | integer | Auto-incrementing primary key        |
| `received_at`| text    | ISO-8601 UTC timestamp              |
| `service`    | text    | Service name (nullable)             |
| `level`      | text    | Log level (nullable)                |
| `trace_id`   | text    | Trace/correlation id (nullable)     |
| `body`       | text    | Full JSON event body                |

| Argument | Type    | Description                                |
| -------- | ------- | ------------------------------------------ |
| `sql`    | string  | A single SELECT statement (no semicolons)  |
| `limit`  | number? | Max rows to return (1–500, default 100)    |

**Example queries:**

```sql
-- Requests slower than 500 ms
SELECT service, json_extract(body, '$.ms') as ms, body
FROM logs WHERE json_extract(body, '$.ms') > 500

-- Error rate by service per hour
SELECT service,
       strftime('%Y-%m-%dT%H:00:00Z', received_at) as hour,
       COUNT(*) as errors
FROM logs WHERE level = 'error'
GROUP BY service, hour ORDER BY hour DESC

-- All services involved in a trace
SELECT DISTINCT service FROM logs WHERE trace_id = 'abc123'
```

## Configuration

### Claude Code (local stdio)

Add to `~/.claude/settings.json` or `.claude/settings.json`:

```json
{
  "mcpServers": {
    "kamori": {
      "command": "node",
      "args": [
        "--enable-source-maps",
        "/path/to/kamori/packages/mcp/dist/mcp.js"
      ],
      "env": {
        "DB_PATH": "/path/to/kamori/data/logs/ingress.db"
      }
    }
  }
}
```

### Claude Desktop (local stdio)

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "kamori": {
      "command": "node",
      "args": [
        "--enable-source-maps",
        "/path/to/kamori/packages/mcp/dist/mcp.js"
      ],
      "env": {
        "DB_PATH": "/path/to/kamori/data/logs/ingress.db",
        "MCP_TOKEN": "optional-token"
      }
    }
  }
}
```

### Cursor (local stdio)

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "kamori": {
      "command": "node",
      "args": [
        "--enable-source-maps",
        "/path/to/kamori/packages/mcp/dist/mcp.js"
      ],
      "env": {
        "DB_PATH": "/path/to/kamori/data/logs/ingress.db"
      }
    }
  }
}
```

### Remote Streamable HTTP

Point your client at the running HTTP server:

```json
{
  "mcpServers": {
    "kamori": {
      "url": "http://your-server:3111/mcp",
      "headers": {
        "Authorization": "Bearer your-mcp-token"
      }
    }
  }
}
```

## Auth

- **stdio mode**: no token required — trust is inherited from the spawning process.
- **Streamable HTTP mode**: set `MCP_TOKEN` env var. All requests must include `Authorization: Bearer <token>`. The `/health` endpoint is exempt.

## Community vs Cloud behaviour

### Community (self-hosted)

The MCP server always queries the **single shared SQLite database** at `DB_PATH`. The bearer token (if any) is used only for the HTTP gate (`MCP_TOKEN`) — it has no effect on which database is queried. Every AI client session reads the same data.

### Cloud (multi-tenant)

Each session's `Authorization: Bearer <api-key>` is an Ed25519 JWT. Every MCP tool call verifies the JWT and routes to the **correct per-project database** for that key. A missing or invalid token returns an explicit error — there is no silent fallback to a shared database.

**Session expiry**: When a cloud session is created, the server decodes the `exp` claim from the JWT and schedules a `transport.close()` at that exact moment. When the key expires the AI client receives a clean disconnect rather than a confusing mid-conversation error. The client can then reconnect with a new key.

> **Note on key TTL:** API keys currently have a 90-day lifetime. Node's `setTimeout` has a ~24.8-day maximum delay (32-bit integer limit), so for 90-day keys the proactive expiry timer is not set — those sessions are cleaned up by the 1-hour inactivity sweep instead. The timer fires for any key with less than ~24.8 days remaining.

```
AI client session lifetime
──────────────────────────
  session created              JWT expires
  │                            │
  ├── tool calls (all routed   ├── transport.close() fires
  │   to project DB)           │   client receives disconnect
  │                            │
  │                            └── client reconnects with new API key
```
