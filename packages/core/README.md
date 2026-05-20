# @usekamori/core

Internal shared package for Kamori. Provides the SQLite database layer and environment configuration used by `@usekamori/ingest` and `@usekamori/mcp`.

This package is not intended for external consumption. If you are looking to ship logs to Kamori, see [`@usekamori/sdk`](../sdk/README.md).
Hexagonal architecture with an open-core model. The basic community edition is free; adapters add billing, auth, API key management, and isolated project databases. All admin/system data is stored in a PostgreSQL database.

## Exports

### From `env.ts`

| Export             | Type     | Description                                                                          |
| ------------------ | -------- | ------------------------------------------------------------------------------------ |
| `PORT`             | `number` | Ingest server port (default: 3110)                                                   |
| `HOST`             | `string` | Bind address (default: `0.0.0.0`)                                                    |
| `INGEST_TOKEN`     | `string` | Ingest auth token                                                                    |
| `LOG_LEVEL`        | `string` | Pino log level for kamori related logs. It is independent from the ingest log-level. |
| `NODE_ENV`         | `string` | Node environment                                                                     |
| `BODY_LIMIT_BYTES` | `number` | Max request body size                                                                |
| `MAX_ROWS`         | `number` | Max events per ingest request                                                        |
| `MAX_ROW_BYTES`    | `number` | Max serialised byte size per row (`0` = disabled)                                    |
| `RATE_LIMIT_MAX`   | `number` | Max requests/minute/IP                                                               |
| `DB_PATH`          | `string` | SQLite database file path                                                            |
| `MCP_TOKEN`        | `string` | MCP HTTP auth token                                                                  |
| `MCP_PORT`         | `number` | MCP HTTP server port                                                                 |

### From `db.ts`

All functions are async and take a `DbAdapter` as their first argument (injected by the server and MCP packages). `LogRow` and `QueryOptions` are the shared data types.

| Export            | Signature                                                           | Description                                                           |
| ----------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `insertLogs`      | `(adapter, rows, receivedAt) => Promise<{ written, deduplicated }>` | Batch-insert log events; deduplicates within a 5-second burst window  |
| `queryLogs`       | `(adapter, opts: QueryOptions) => Promise<LogRow[]>`                | Filtered query, newest-first (or oldest-first when `after_id` is set) |
| `getLogById`      | `(adapter, id: number) => Promise<LogRow \| null>`                  | Fetch a single row by primary key                                     |
| `searchLogs`      | `(adapter, query: string, opts) => Promise<LogRow[]>`               | FTS5 full-text search, up to 500 rows                                 |
| `countLogs`       | `(adapter, opts) => Promise<number>`                                | Exact row count with filters — no row-limit cap                       |
| `countLogsFts`    | `(adapter, query: string, opts) => Promise<number>`                 | Exact FTS5 match count — no row-limit cap                             |
| `listServices`    | `(adapter) => Promise<string[]>`                                    | Distinct service names (cached 5 min, invalidated on insert)          |
| `summarizeErrors` | `(adapter, since?) => Promise<{ service, level, count }[]>`         | Grouped counts by service + level                                     |
| `deleteLogs`      | `(adapter, { before?, service? }) => Promise<number>`               | Delete rows by time/service; returns deleted count                    |
| `purgeLogs`       | `(adapter, beforeDate, chunkSize?) => Promise<number>`              | Chunked retention purge; keeps ingest latency unaffected              |
| `exportLogs`      | `(adapter, opts) => Promise<LogRow[]>`                              | Bulk export up to 10 000 rows (higher cap than `queryLogs`)           |
| `LogRow`          | interface                                                           | `{ id, received_at, service, level, trace_id, body }`                 |
| `QueryOptions`    | interface                                                           | `{ service?, level?, since?, until?, limit?, after_id?, trace_id? }`  |

## Database schema

```sql
CREATE TABLE logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at TEXT NOT NULL,    -- ISO8601 timestamp
  service     TEXT,             -- extracted from event fields
  level       TEXT,             -- extracted from event fields
  trace_id    TEXT,             -- extracted from trace/request/correlation id fields
  body        TEXT NOT NULL     -- full JSON blob of the original event
);

-- Standard indexes for filtered queries
CREATE INDEX idx_received_at ON logs(received_at);
CREATE INDEX idx_service     ON logs(service);
CREATE INDEX idx_level       ON logs(level);

-- FTS5 virtual table for full-text search
CREATE VIRTUAL TABLE logs_fts
  USING fts5(body, content=logs, content_rowid=id);

-- Triggers to keep FTS index in sync
CREATE TRIGGER logs_ai AFTER INSERT ON logs BEGIN
  INSERT INTO logs_fts(rowid, body) VALUES (new.id, new.body);
END;
CREATE TRIGGER logs_ad AFTER DELETE ON logs BEGIN
  INSERT INTO logs_fts(logs_fts, rowid, body) VALUES ('delete', old.id, old.body);
END;
```
