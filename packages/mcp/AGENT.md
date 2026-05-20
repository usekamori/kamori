# Kamori MCP — Agent Manual

This document is written for AI agents using the Kamori MCP server. It describes every available tool, when to use each one, the exact arguments accepted, and practical query patterns.

---

## Connection

The MCP server exposes a tool set named `kamori`. All tools are available once connected. You never need to name tools explicitly — use them when the task calls for it.

**Cloud (Kamori.io):** Bearer token is the Ed25519 API key issued from the dashboard. The key must have scope `mcp` or `full`. An `ingest`-only key will be rejected.

**Self-hosted HTTP:** Bearer token is `MCP_TOKEN` from the server's environment.

**Self-hosted stdio:** No token required — trust is inherited from the spawning process.

---

## Database schema

All tools query the `logs` table (SQLite / LibSQL):

| Column       | Type    | Notes                                      |
| ------------ | ------- | ------------------------------------------ |
| `id`         | integer | Auto-incrementing primary key              |
| `received_at`| text    | ISO-8601 UTC, e.g. `2024-06-01T12:00:00Z` |
| `service`    | text    | Service name — nullable                    |
| `level`      | text    | Log level — nullable (e.g. `error`, `warn`, `info`, `debug`) |
| `trace_id`   | text    | Trace / request / correlation id — nullable |
| `body`       | text    | Full event as JSON text                    |
| `body_hash`  | text    | SHA-256 hex of body (dedup) — nullable     |

Indexes: `received_at`, `service`, `level`, `trace_id`, `(body_hash, received_at)`.

FTS5 virtual table `logs_fts` indexes the `body` column. Kept in sync with INSERT/DELETE triggers.

---

## Tools

### `list_services`

**When to use:** Start here when the user hasn't told you which service to look at. Discover what services are logging.

No arguments. Returns a newline-separated list of distinct service names.

---

### `query_logs`

**When to use:** Fetch recent or time-bounded log lines with basic filters. The go-to tool for "show me errors from service X in the last hour".

| Argument  | Type    | Required | Description |
| --------- | ------- | -------- | ----------- |
| `service` | string  | no       | Filter by service name |
| `level`   | string  | no       | Filter by level (`error`, `warn`, `info`, `debug`) |
| `since`   | string  | no       | ISO-8601 start time |
| `until`   | string  | no       | ISO-8601 end time |
| `limit`   | integer | no       | Max rows (1–500, default 100) |

Returns rows **newest first**.

---

### `search_logs`

**When to use:** When the user gives you a keyword, phrase, or error message to look for. Uses SQLite FTS5 — faster and smarter than `query_sql LIKE`.

| Argument  | Type    | Required | Description |
| --------- | ------- | -------- | ----------- |
| `query`   | string  | **yes**  | FTS5 query string |
| `service` | string  | no       | Narrow to a specific service |
| `since`   | string  | no       | ISO-8601 start time |
| `until`   | string  | no       | ISO-8601 end time |
| `limit`   | integer | no       | Max rows (1–500, default 100) |

**FTS5 syntax:**
- Exact phrase: `"connection refused"`
- Boolean: `timeout OR "connection refused"`
- Exclude: `payment NOT refund`
- Prefix: `auth*` (matches `authenticate`, `authorization`, …)

---

### `summarize_errors`

**When to use:** Quick health overview — "how many errors per service?" Opens an incident investigation. Call this before drilling into raw logs.

| Argument | Type   | Required | Description |
| -------- | ------ | -------- | ----------- |
| `since`  | string | no       | ISO-8601 start time. Omit for all-time counts. |

Returns grouped counts: `service=payments  level=error  count=42`.

---

### `get_log`

**When to use:** The user references a specific log id, or you found an interesting row and need to see the full body.

| Argument | Type    | Required | Description |
| -------- | ------- | -------- | ----------- |
| `id`     | integer | **yes**  | The numeric row id |

Returns the full event body as pretty-printed JSON.

---

### `tail_logs`

**When to use:** Incremental live-tail loop — "show me new logs as they arrive". Also useful to page forward through logs without re-reading old rows.

| Argument   | Type    | Required | Description |
| ---------- | ------- | -------- | ----------- |
| `after_id` | integer | **yes**  | Return only rows with `id > after_id`. Pass `0` to start from the beginning. |
| `query`    | string  | no       | FTS5 filter — scope the tail to specific keywords |
| `service`  | string  | no       | Filter by service name |
| `level`    | string  | no       | Filter by log level |
| `limit`    | integer | no       | Max rows (1–500, default 50) |

Returns rows **oldest first**. The response includes `last_id` — pass it as `after_id` on the next call to continue from where you left off.

**Pattern:**
```
after_id = 0
loop:
  rows, last_id = tail_logs(after_id=after_id, ...)
  process rows
  after_id = last_id
  sleep briefly
```

---

### `watch_logs`

**When to use:** When you want to block waiting for new logs to appear rather than polling. More efficient than a tight `tail_logs` loop.

| Argument           | Type    | Required | Description |
| ------------------ | ------- | -------- | ----------- |
| `after_id`         | integer | **yes**  | Wait for rows with `id > after_id`. Use `0` to start from current end. |
| `timeout_seconds`  | integer | no       | How long to wait (1–60, default 30) |
| `service`          | string  | no       | Filter by service name |
| `level`            | string  | no       | Filter by log level |
| `limit`            | integer | no       | Max rows per response (1–500, default 50) |

Polls every 500 ms internally. Returns as soon as new rows arrive or `timeout_seconds` elapses. Returns rows oldest-first with a `last_id` for chaining.

---

### `alert_summary`

**When to use:** Threshold check — "how many errors in the last 30 minutes?" Use to decide whether to escalate an incident.

| Argument  | Type    | Required | Description |
| --------- | ------- | -------- | ----------- |
| `minutes` | integer | no       | Look-back window (1–10080, default 60) |
| `service` | string  | no       | Narrow to a specific service |
| `query`   | string  | no       | FTS5 filter. If omitted, counts `level=error` only. |
| `level`   | string  | no       | Level to count when `query` is not set (default `error`) |

Returns a plain count. Compare it against your threshold to decide the next step.

---

### `anomaly_hint`

**When to use:** "Is the current error rate normal?" Computes a spike factor vs the 7-day baseline. Good first tool for "anything unusual right now?".

| Argument         | Type    | Required | Description |
| ---------------- | ------- | -------- | ----------- |
| `window_minutes` | integer | no       | Recent window to evaluate (1–1440, default 60) |
| `service`        | string  | no       | Narrow to a specific service |
| `level`          | string  | no       | Level to analyse (default `error`) |

Returns a spike factor and a plain-language sentence: `"Current rate is 4.2× the 7-day baseline — possible anomaly."` The baseline is cached for 1 hour per (service, level, window) key.

---

### `query_field`

**When to use:** When the user wants a numeric or structured field comparison that FTS5 cannot express — e.g. `ms > 500`, `statusCode = 429`, `meta.userId = "u_123"`.

| Argument  | Type           | Required | Description |
| --------- | -------------- | -------- | ----------- |
| `field`   | string         | **yes**  | JSON body field. Dot-notation for nested fields: `meta.userId`, `response.status` |
| `op`      | string         | **yes**  | `=` `!=` `>` `>=` `<` `<=` |
| `value`   | string\|number | **yes**  | Value to compare. Use a number for numeric comparisons. |
| `service` | string         | no       | Narrow to a specific service |
| `since`   | string         | no       | ISO-8601 start time |
| `until`   | string         | no       | ISO-8601 end time |
| `limit`   | integer        | no       | Max rows (1–500, default 100) |

Translates to `json_extract(body, '$.field') op value` under the hood.

---

### `histogram`

**When to use:** Visualise log volume over time — find when a spike started, confirm a deploy caused an error increase, check traffic patterns.

| Argument  | Type   | Required | Description |
| --------- | ------ | -------- | ----------- |
| `bucket`  | string | **yes**  | Bucket width: `1m`, `5m`, `15m`, `1h`, `6h`, `1d` |
| `service` | string | no       | Narrow to a specific service |
| `level`   | string | no       | Filter by log level |
| `since`   | string | no       | ISO-8601 start time (defaults to 7 days ago) |
| `until`   | string | no       | ISO-8601 end time |

Returns lines: `2024-06-01T14:00:00Z  count=183`.

---

### `trace_logs`

**When to use:** The user has a request id / trace id and wants to see the full distributed request chain across all services.

| Argument   | Type    | Required | Description |
| ---------- | ------- | -------- | ----------- |
| `trace_id` | string  | **yes**  | Trace / request / correlation id to look up |
| `limit`    | integer | no       | Max rows (1–500, default 200) |

Returns all rows sharing that `trace_id` in **chronological order** (oldest first).

---

### `query_sql`

**When to use:** Last resort when no structured tool can express the query. Window functions, complex `GROUP BY`, multi-field correlations. **Do not use by default** — prefer structured tools for correctness and safety.

| Argument | Type    | Required | Description |
| -------- | ------- | -------- | ----------- |
| `sql`    | string  | **yes**  | A single `SELECT` statement. No semicolons. May only reference `logs` and `logs_fts`. |
| `limit`  | integer | no       | Max rows (1–500, default 100) |

**Constraints enforced by the server:**
- Must start with `SELECT` (case-insensitive)
- Semicolons rejected (prevents statement stacking)
- Only `logs` and `logs_fts` table references allowed — system tables blocked
- Result capped at 500 rows regardless of SQL `LIMIT`

**Useful patterns:**

```sql
-- Requests slower than 500 ms
SELECT service, json_extract(body, '$.ms') AS ms, received_at
FROM logs WHERE json_extract(body, '$.ms') > 500
ORDER BY ms DESC

-- Error rate per service per hour
SELECT service,
       strftime('%Y-%m-%dT%H:00:00Z', received_at) AS hour,
       COUNT(*) AS errors
FROM logs WHERE level = 'error'
GROUP BY service, hour ORDER BY hour DESC

-- All services involved in a trace
SELECT DISTINCT service FROM logs WHERE trace_id = 'abc123'

-- Top 10 most frequent error messages
SELECT json_extract(body, '$.message') AS msg, COUNT(*) AS n
FROM logs WHERE level = 'error'
GROUP BY msg ORDER BY n DESC LIMIT 10

-- P95 latency by service (approximate)
SELECT service,
       COUNT(*) AS requests,
       MAX(json_extract(body, '$.ms')) AS max_ms
FROM logs WHERE json_extract(body, '$.ms') IS NOT NULL
GROUP BY service ORDER BY max_ms DESC
```

---

## Decision guide

```
User asks about...
├── "what services are logging?"           → list_services
├── "show me logs from X"                  → query_logs (service=X)
├── "errors in the last hour"              → query_logs (level=error, since=...)
├── "find logs containing <phrase>"        → search_logs
├── "health overview / error counts"       → summarize_errors
├── "is this normal? / anomaly?"           → anomaly_hint → summarize_errors → query_logs
├── "show log id 4291"                     → get_log
├── "live tail / watch for new logs"       → watch_logs (blocks) or tail_logs (polling)
├── "how many errors in 30 min?"           → alert_summary
├── "error rate over time / spike?"        → histogram → query_logs for the spike window
├── "requests where ms > 500"             → query_field (field=ms, op=>, value=500)
├── "trace abc123 / full request chain"    → trace_logs
└── "complex GROUP BY / window function"   → query_sql (last resort)
```

## Common investigation patterns

**Incident triage:**
1. `anomaly_hint` — is the current rate unusual?
2. `summarize_errors` (since=last hour) — which service / level is spiking?
3. `query_logs` (service=X, level=error, since=last hour) — read the actual lines
4. `get_log` on interesting rows for full body detail

**Deployment impact check:**
1. `histogram` (bucket=5m, level=error, since=30 min before deploy, until=30 min after)
2. `alert_summary` (minutes=15) before and after deploy timestamp
3. `search_logs` for stack traces or new error strings

**Performance investigation:**
1. `query_field` (field=ms, op=`>`, value=1000) — slow requests
2. `query_sql` for P95 / percentile breakdown
3. `trace_logs` on a slow trace_id to find the bottleneck service

**Live monitoring session:**
1. `list_services` — confirm service name
2. `tail_logs` (after_id=0, service=X, level=error) — get current tail position
3. `watch_logs` (after_id=last_id) in a loop — block waiting for new events
