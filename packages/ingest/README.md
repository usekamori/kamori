# @usekamori/ingest

Fastify HTTP ingest server for Kamori. Accepts log events as JSON, validates them, and persists them to the shared SQLite database via `@usekamori/core`.

## What it does

- Accepts `POST /v1/ingest` with a single JSON object or an array of objects
- Authenticates requests with a static bearer token (`Authorization: Bearer` header)
- Rate-limits by IP (100 req/min by default)
- Applies security headers via `@fastify/helmet`
- Exposes `GET /v1/health` for container health checks (no auth required)
- Gracefully shuts down on SIGINT/SIGTERM with a 10-second timeout

## Install and run

```bash
# From the monorepo root
npm install

# Development (ts-node-dev, auto-restart on changes)
npm run dev:server

# Production
npm run build
npm run start:server
```

## API Reference

### GET /v1/health

Health probe. Returns 200 if the database is reachable.

**Response 200:**

```json
{
  "ok": true,
  "checks": {
    "db": true,
    "mcp": true
  }
}
```

The `mcp` field is only included when `MCP_PORT` is set. MCP being unreachable does not set `ok` to `false` — ingest continues to work.

**Response 503:**

```json
{
  "ok": false,
  "checks": { "db": false }
}
```

### POST /v1/ingest

Ingest one or more log events.

**Headers:**

- `Content-Type: application/json`
- `Authorization: Bearer <token>` — required when `INGEST_TOKEN` is set

**Body** — single event:

```json
{
  "service": "myapp",
  "level": "error",
  "message": "something broke",
  "code": 500
}
```

**Body** — batch:

```json
[
  {
    "service": "myapp",
    "level": "info",
    "message": "request complete",
    "duration_ms": 42
  },
  { "service": "myapp", "level": "error", "message": "downstream timeout" }
]
```

Any JSON object shape is accepted. Kamori extracts `service` (also tries `app`, `source`, `name`) and `level` (also tries `severity`, `log_level`) for indexed filtering. All other fields are stored verbatim in the `body` column.

**Response 200:**

```json
{ "ok": true, "written": 2 }
```

**Response 400** — empty body or invalid JSON.

**Response 401** — missing or invalid token.

**Response 413** — more than `MAX_ROWS` events in a single request, or a row exceeds `MAX_ROW_BYTES`.

## Environment variables

| Variable                | Default                  | Description                                                                        |
| ----------------------- | ------------------------ | ---------------------------------------------------------------------------------- |
| `PORT`                  | `3110`                   | Listen port                                                                        |
| `HOST`                  | `0.0.0.0`                | Bind address                                                                       |
| `INGEST_TOKEN`          | ``                       | Auth token. Empty = no auth                                                        |
| `LOG_LEVEL`             | `info`                   | Pino log level                                                                     |
| `NODE_ENV`              | `development`            | `production` disables pino-pretty                                                  |
| `BODY_LIMIT_BYTES`      | `1000000`                | Max request body (bytes)                                                           |
| `MAX_ROWS`              | `1000`                   | Max events per ingest call                                                         |
| `MAX_ROW_BYTES`         | `0`                      | Max serialised byte size per row (`0` = disabled)                                  |
| `RATE_LIMIT_MAX`        | `100`                    | Max requests/minute/IP                                                             |
| `DB_PATH`               | `./data/logs/ingress.db` | SQLite file path (log data)                                                        |
| `MCP_PORT`              | `3111`                   | MCP HTTP server listen port. Set to `0` to disable the cross-service health check. |
| `SYSLOG_PORT`           | —                        | UDP/TCP syslog ingestion port                                                      |
| `WEBHOOK_SECRET_VERCEL` | —                        | HMAC secret for Vercel webhook signature verification                              |
| `WEBHOOK_SECRET_GITHUB` | —                        | HMAC secret for GitHub webhook signature verification                              |
| `WEBHOOK_SECRET_RENDER` | —                        | HMAC secret for Render webhook signature verification                              |
| `RETENTION_DAYS`        | —                        | Auto-purge logs older than N days                                                  |
| `ALLOWED_ORIGINS`       | —                        | Comma-separated CORS origins. `*` = allow all origins, empty = CORS disabled       |

## Docker

The root `docker-compose.yml` runs this service as the `ingest` container on port 3110. Data is persisted in a named `data` volume (`/app/data/logs/` for the log database).

```bash
docker compose up ingest
```
