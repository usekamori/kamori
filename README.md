# Kamori

**Self-hosted log ingestion with an AI-queryable MCP interface.**

Kamori is a lightweight, self-hosted log aggregation system built for AI-assisted debugging. Ship logs from any service to a single HTTP endpoint; Kamori stores them in SQLite and exposes them to Claude, Cursor, and other MCP-compatible AI assistants via a built-in MCP server.

Ask your AI _"what errors happened in the payment service in the last hour?"_ and get real answers from your actual logs — no context-pasting, no dashboard required.

Kamori is not a SaaS product, not a monitoring platform, and not a replacement for Datadog. It is a personal or team-scale tool designed to make AI agents genuinely useful for debugging production issues.

---

## Architecture

```
Your services
     │
     │  POST /v1/ingest              (JSON or array)
     │  POST /v1/webhook/:provider   (Vercel / GitHub / Render)
     │  Syslog UDP/TCP               (SYSLOG_PORT)
     ▼
┌─────────────────────┐
│  @usekamori/ingest     │  Fastify — port 3110
│                     │  GET  /v1/health
│                     │  GET  /v1/logs
│                     │  GET  /v1/search
│                     │  GET  /v1/services
│                     │  GET  /v1/summary
│                     │  GET  /v1/export
│                     │  GET  /v1/stream    (NDJSON live tail)
│                     │  GET  /v1/logs/alert
│                     │  DELETE /v1/logs
│                     │  GET  /metrics      (Prometheus)
└────────┬────────────┘
         │  better-sqlite3 (WAL mode)
         ▼
┌─────────────────────┐
│   SQLite database   │  logs + FTS5 virtual table
│  data/logs/         │  (id, received_at, service, level, trace_id, body)
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│  @usekamori/mcp        │  MCP server — port 3111 (HTTP) or stdio
│                     │  query_logs / search_logs / list_services
│                     │  summarize_errors / tail_logs / get_log
│                     │  alert_summary / watch_logs / anomaly_hint
└─────────────────────┘
         │
         ▼
  Claude Code · Claude Desktop · Cursor
```

Both the ingest server and the MCP server run inside **one container** (one Dockerfile, two processes managed by the `docker-entrypoint.sh` shell script). Set `MCP_PORT=0` to disable the MCP process.

---

## Quickstart

### Option 1 — `npx kamori` (fastest)

**Default (no Docker):** clones the Kamori repo into `./kamori/`, installs deps, builds `@usekamori/ingest` + `@usekamori/mcp`, and writes a root `package.json` with `npm start` (ingest + MCP via `dotenv` + `.env`).

```bash
npx kamori my-logs --yes
cd my-logs
npm start
```

**Docker:** pass `--docker` to generate `docker-compose.yml` and Docker-focused docs instead (no git clone).

```bash
npx kamori my-logs --docker --yes
cd my-logs
npm start   # docker compose up -d
```

Interactive mode asks **"Use Docker?"** (default **N**). Default ingest/MCP ports are **3110** / **3111**. If you do not set `--allowed-origins` (or leave the CORS prompt blank), scaffolding sets `ALLOWED_ORIGINS=*` (allow all origins), then warns you to replace it in `.env` for production. See [CLI reference](#npx-kamori-cli) and [`packages/kamori/README.md`](packages/kamori/README.md).

### Option 2 — Docker directly

```bash
docker run -d \
  --name kamori \
  -p 3110:3110 \
  -p 3111:3111 \
  -v kamori-data:/app/data \
  -e INGEST_TOKEN=your-secret \
  -e MCP_PORT=3111 \
  ghcr.io/usekamori/kamori:latest
```

### Option 3 — Docker Compose (from this repo)

```bash
docker compose up -d
```

### Option 4 — Local dev (from source)

```bash
npm install
npm run dev --workspace=@usekamori/ingest   # ingest on :3110
```

In a second terminal:

```bash
DB_PATH=./data/logs/ingress.db MCP_PORT=3111 \
  node --enable-source-maps packages/mcp/dist/mcp.js
```

---

## `npx kamori` CLI

Scaffolds a self-hosted Kamori setup in a new directory.

```
npx kamori [dir] [options]

Arguments:
  dir                     Directory to create (default: kamori-ai)

Options:
  --docker                Use Docker (compose + docs). Without this, scaffolder clones GitHub,
                          builds server + MCP, and wires Node/npm start (see packages/kamori).
  --log-token <secret>    Set INGEST_TOKEN — authenticates ingest and query requests.
  --mcp-token <secret>    Set MCP_TOKEN for MCP HTTP Bearer auth (@usekamori/mcp).
  --log-port <n>          Ingest HTTP port (default: 3110).
  --mcp-port <n>          MCP HTTP port when MCP is enabled (default: 3111).
  --no-mcp                Disable Streamable HTTP MCP. Sets MCP_PORT=0; no .mcp.json.
  --yes, -y               Non-interactive — skip prompts (Node path + MCP on unless --no-mcp).
                          Token defaults are disabled unless explicitly provided by flags.
                          Also triggered when CI=true or stdin is not a TTY.
```

**Examples:**

```bash
# Interactive — prompts for directory name, token, and MCP
npx kamori

# Node from source (default)
npx kamori my-logs --yes

# Docker compose + images
npx kamori my-logs --docker --yes

# Explicit tokens
npx kamori my-logs --log-token s3cr3t --mcp-token mcp-only --yes

# Ingest only — no MCP
npx kamori my-logs --no-mcp --yes
```

**Files generated** (varies by `--docker`; see [`packages/kamori/README.md`](packages/kamori/README.md)):

```
my-logs/
├── .env                  # full Community Edition env template (mode 0600); see docs.kamori.io/configuration
├── .gitignore            # excludes .env, kamori/, *.db files
├── docker-compose.yml    # only with --docker (env_file: .env)
├── kamori/               # git clone when not using Docker
├── package.json          # npm start (Node or docker compose)
├── .mcp.json             # unless --no-mcp
├── README.md
└── data/logs/.gitkeep
```

> `.env` and `.mcp.json` are written with mode `0600` (owner read/write only) because they contain secrets.

---

## Sending logs

### curl

```bash
# Single event
curl -X POST http://localhost:3110/v1/ingest \
  -H "Authorization: Bearer your-secret" \
  -H "content-type: application/json" \
  -d '{"service":"api","level":"error","message":"DB connection failed","userId":"u_123"}'

# Batch (array)
curl -X POST http://localhost:3110/v1/ingest \
  -H "Authorization: Bearer your-secret" \
  -H "content-type: application/json" \
  -d '[{"service":"api","level":"info","message":"started"},{"service":"api","level":"warn","message":"slow query","ms":850}]'
```

Any JSON fields are accepted. These are extracted automatically if present:

| Field                       | Description                                           |
| --------------------------- | ----------------------------------------------------- |
| `level`                     | Log level — `debug`, `info`, `warn`, `error`, `fatal` |
| `service`                   | Service or application name                           |
| `message` / `msg`           | Log message body                                      |
| `ts` / `time` / `timestamp` | Event timestamp (ISO8601 or Unix ms)                  |
| `trace_id`                  | Distributed trace / correlation ID                    |

### JavaScript / TypeScript SDK

```bash
npm install @usekamori/sdk
```

```typescript
import { KamoriClient } from "@usekamori/sdk";

const kamori = new KamoriClient({
  url: "http://localhost:3110",
  token: process.env.INGEST_TOKEN,
  flushOnExit: true, // flush buffer on SIGTERM / process.exit()
  captureSource: "auto", // append file:line in non-production
});

kamori.log({
  level: "info",
  service: "api",
  message: "Server started",
  port: 3110,
});
kamori.log({
  level: "error",
  service: "api",
  message: "Payment failed",
  userId: "u_123",
});
```

**One-liner shim** — forwards all `console.*` calls to Kamori:

```typescript
import { installShim } from "@usekamori/sdk";
installShim({
  url: "http://localhost:3110",
  token: process.env.INGEST_TOKEN,
  flushOnExit: true,
});

// From here on, console.error / .warn / .log all go to Kamori
console.error("Unhandled exception", { err });
```

**Pino transport:**

```typescript
import pino from "pino";
import { createKamoriStream } from "@usekamori/sdk";

const logger = pino(
  createKamoriStream({
    url: "http://localhost:3110",
    token: process.env.INGEST_TOKEN,
  }),
);
logger.error({ userId: "u_123" }, "Payment failed");
```

**Winston transport:**

```typescript
import winston from "winston";
import { KamoriTransport } from "@usekamori/sdk";

const logger = winston.createLogger({
  transports: [
    new winston.transports.Console(),
    new KamoriTransport({
      url: "http://localhost:3110",
      token: process.env.INGEST_TOKEN,
    }),
  ],
});
```

---

## Sensitive data & PII

**Kamori does not redact data.** Everything you send is stored as-is in SQLite and surfaced to your AI assistant. If your logs can contain passwords, tokens, email addresses, payment card numbers, or other sensitive values, you are responsible for stripping them **before** they leave your application — not at the server.

Redacting after transmission is too late: the data has already crossed the wire and landed in the database.

### Pino — built-in `redact` option

If you use the Kamori Pino transport, pino's native [`redact`](https://getpino.io/#/docs/redaction) option is the lowest-friction choice — zero extra dependencies, applied before the log line is serialised:

```typescript
import pino from "pino";

const logger = pino({
  redact: {
    paths: [
      "password",
      "token",
      "user.email",
      "*.creditCard",
      "headers.authorization",
    ],
    censor: "[REDACTED]",
  },
  transport: {
    target: "@usekamori/sdk/pino",
    options: {
      url: "https://your-kamori-server.com",
      token: process.env.INGEST_TOKEN,
    },
  },
});

logger.info(
  { user: { email: "alice@example.com" }, token: "sk-secret" },
  "signed in",
);
// shipped to Kamori as: { user: { email: "[REDACTED]" }, token: "[REDACTED]" }
```

### Any transport — bluestreak

For Winston, the console shim, or direct `client.log()` calls — or when you need compliance profiles (GDPR, PCI-DSS, HIPAA) that cover a wide set of field names automatically — use [bluestreak](https://github.com/martinkr/bluestreak):

```bash
npm install bluestreak
```

```typescript
import { compileRecommendedPolicy, redactLine } from "bluestreak";
import { KamoriClient } from "@usekamori/sdk";

// Compile once at startup — not per log line
const policy = compileRecommendedPolicy();
const kamori = new KamoriClient({
  url: "...",
  token: process.env.INGEST_TOKEN,
});

function log(event: Record<string, unknown>) {
  kamori.log(JSON.parse(redactLine(JSON.stringify(event), policy)));
}

log({ service: "api", level: "error", message: "failed", password: "hunter2" });
// password → "[**REDACTED**]" before reaching Kamori
```

See [`docs/SDK.md`](docs/SDK.md#sensitive-data--pii) for Winston and stream pipeline examples.

---

## Querying logs

```bash
# Recent logs (newest first)
curl -sS "http://localhost:3110/v1/logs?limit=50" \
  -H "Authorization: Bearer your-secret" | jq

# Filter by service and level
curl -sS "http://localhost:3110/v1/logs?service=api&level=error&limit=20" \
  -H "Authorization: Bearer your-secret" | jq

# Time range
curl -sS "http://localhost:3110/v1/logs?since=2024-01-01T00:00:00Z&until=2024-01-01T06:00:00Z" \
  -H "Authorization: Bearer your-secret" | jq

# Full-text search (FTS5 — supports quoted phrases, AND / OR / NOT)
curl -sS "http://localhost:3110/v1/search?q=connection+refused&service=api" \
  -H "Authorization: Bearer your-secret" | jq

# Live tail as NDJSON (Ctrl+C to stop; -N disables curl buffering)
curl -N "http://localhost:3110/v1/stream?service=api&level=error" \
  -H "Authorization: Bearer your-secret"

# Error count in the last 30 minutes (for alerting)
curl -sS "http://localhost:3110/v1/logs/alert?minutes=30&level=error" \
  -H "Authorization: Bearer your-secret"

# Bulk export as CSV
curl -sS "http://localhost:3110/v1/export?format=csv&service=api" \
  -H "Authorization: Bearer your-secret" > logs.csv

# Prometheus metrics (no auth)
curl -sS http://localhost:3110/metrics
```

---

## MCP Setup

The MCP server lets Claude, Cursor, and other AI assistants query your logs in natural language.

### Claude Code (HTTP transport — Docker / remote)

When the container is running with `MCP_PORT` set (e.g. `3111` from [`npx kamori`](packages/kamori/README.md) defaults):

```bash
claude mcp add kamori --transport http http://localhost:3111/mcp
```

If `MCP_TOKEN` is set (Bearer auth for MCP HTTP — see [@usekamori/mcp](packages/mcp/README.md)):

```bash
claude mcp add kamori --transport http http://localhost:3111/mcp \
  --header "Authorization: Bearer <your-mcp-token>"
```

If you used `npx kamori` without `--no-mcp`, a `.mcp.json` with `url` and optional `headers` is already written — Claude Code picks it up automatically.

### Claude Code (stdio — local dev)

```bash
claude mcp add kamori --stdio -- \
  node --enable-source-maps /path/to/kamori/packages/mcp/dist/mcp.js --stdio
```

Or add to `~/.claude/settings.json` / `.claude/settings.json`:

```json
{
  "mcpServers": {
    "kamori": {
      "command": "node",
      "args": [
        "--enable-source-maps",
        "/path/to/kamori/packages/mcp/dist/mcp.js",
        "--stdio"
      ],
      "env": {
        "DB_PATH": "/path/to/kamori/data/logs/ingress.db"
      }
    }
  }
}
```

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "kamori": {
      "command": "node",
      "args": [
        "--enable-source-maps",
        "/path/to/kamori/packages/mcp/dist/mcp.js",
        "--stdio"
      ],
      "env": {
        "DB_PATH": "/path/to/kamori/data/logs/ingress.db"
      }
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json` in your project root:

```json
{
  "mcpServers": {
    "kamori": {
      "command": "node",
      "args": [
        "--enable-source-maps",
        "/path/to/kamori/packages/mcp/dist/mcp.js",
        "--stdio"
      ],
      "env": {
        "DB_PATH": "/path/to/kamori/data/logs/ingress.db"
      }
    }
  }
}
```

### stdio vs HTTP transport

|                | stdio                             | Streamable HTTP                    |
| -------------- | --------------------------------- | ---------------------------------- |
| Started by     | AI client (on demand)             | You (always running)               |
| Use case       | Local dev, Claude Code, Cursor    | Docker, remote, shared team server |
| Auth           | Process-level — trust the spawner | Bearer token via `MCP_TOKEN`       |
| `--stdio` flag | Required                          | Not used                           |

---

## MCP Tools

| Tool               | What it does                                                            |
| ------------------ | ----------------------------------------------------------------------- |
| `query_logs`       | Fetch logs filtered by service, level, time range, trace_id             |
| `search_logs`      | Full-text search (FTS5) — supports quoted phrases, AND / OR / NOT       |
| `list_services`    | List all distinct service names in the database                         |
| `summarize_errors` | Log counts grouped by service + level                                   |
| `tail_logs`        | Fetch entries newer than a cursor id (pass `after_id=0` to start)       |
| `get_log`          | Fetch a single log entry by numeric id                                  |
| `alert_summary`    | Count matching logs in the last N minutes — for threshold alerts        |
| `watch_logs`       | Long-poll up to 60s waiting for new logs to arrive                      |
| `anomaly_hint`     | Compare recent error rate to 7-day baseline; returns spike factor       |
| `query_field`      | Filter by any JSON body field with `=` `!=` `>` `>=` `<` `<=` operators |
| `histogram`        | Time-bucketed event counts — `1m` / `5m` / `15m` / `1h` / `6h` / `1d`   |
| `trace_logs`       | All events for a `trace_id` in chronological order                      |
| `query_sql`        | Read-only SQL escape hatch — run any `SELECT` against the logs table    |

### Example prompts

Once the MCP server is connected, you can ask in plain English:

```
"What were the most common errors in the last hour?"
"Show me all logs from the payment service since midnight"
"Search for logs containing 'connection refused'"
"Is the error rate higher than usual right now?"
"Watch for new errors in the auth service"
"Show me log id 4291"
"How many errors in the last 30 minutes compared to yesterday?"
```

Claude picks the right tool automatically. A single question often chains multiple tools — for example, _"anything unusual about errors right now?"_ will typically call `anomaly_hint` then `summarize_errors` then `query_logs` to pull the actual lines.

### Agentic debugging

With the MCP server connected, Claude can go beyond answering questions — it can watch for errors and fix them in the same session.

**In a Claude Code session** — ask Claude to investigate and patch:

```
"Check for new errors in the last 5 minutes, find the root cause in the code, and fix it"
"Watch the payments service for errors and apply a fix"
"Tail the logs, and if you see anything broken open the relevant file and patch it"
```

Claude will call `watch_logs` or `tail_logs` to read the live stream, read the source files, and apply edits — no copy-pasting required. The `watch_logs` tool blocks up to 60 seconds waiting for new entries, which lets Claude sit in a tight loop without burning tokens on empty polls.

**Headless monitoring via the stream endpoint** — pipe errors from the NDJSON stream into the `claude` CLI:

```bash
curl -sN "http://localhost:3110/v1/stream?level=error" \
  -H "Authorization: Bearer $INGEST_TOKEN" \
  | jq -c 'select(.level == "error")' \
  | while IFS= read -r line; do
      echo "A new error appeared in the logs. Investigate the source and fix it: $line" \
        | claude --print
    done
```

This invokes Claude headlessly on each error event, outside of any interactive session. Scope what Claude is allowed to touch with `--allowedTools "Edit,Write,Read,Bash"`.

**Patterns summary**

| Pattern         | How                                        | Best for                  |
| --------------- | ------------------------------------------ | ------------------------- |
| In-session ask  | "Watch logs and fix errors" in Claude Code | Interactive debugging     |
| Headless stream | Pipe `/v1/stream` into `claude --print`    | Unattended overnight runs |
| Scheduled check | Cron + `claude --print` + MCP query        | Periodic anomaly review   |

---

## Environment Variables

| Variable                | Default                  | Description                                                                  |
| ----------------------- | ------------------------ | ---------------------------------------------------------------------------- |
| `PORT`                  | `3110`                   | Ingest server port                                                           |
| `HOST`                  | `0.0.0.0`                | Ingest server bind address                                                   |
| `INGEST_TOKEN`          | (disabled)               | Bearer token auth. Empty = no auth                                           |
| `LOG_LEVEL`             | `info`                   | Pino log level (`debug` / `info` / `warn` / `error`)                         |
| `NODE_ENV`              | `development`            | Set to `production` to disable pino-pretty                                   |
| `DB_PATH`               | `./data/logs/ingress.db` | SQLite database file path                                                    |
| `BODY_LIMIT_BYTES`      | `1000000`                | Max ingest request body size (1 MB)                                          |
| `MAX_ROWS`              | `1000`                   | Max log rows per ingest request                                              |
| `MAX_ROW_BYTES`         | `0`                      | Max serialised byte size per row. `0` = disabled                             |
| `RATE_LIMIT_MAX`        | `100`                    | Max requests per minute per token / IP                                       |
| `RETENTION_DAYS`        | (disabled)               | Auto-purge logs older than N days. `0` = keep forever                        |
| `MCP_PORT`              | `3111`                   | MCP HTTP server port. `0` = disabled                                         |
| `MCP_TOKEN`             | (disabled)               | Bearer token for MCP HTTP auth. Empty = no auth                              |
| `SYSLOG_PORT`           | (disabled)               | UDP + TCP syslog ingestion port. `0` = disabled                              |
| `WEBHOOK_SECRET_VERCEL` | —                        | HMAC secret for Vercel webhook signature verification                        |
| `WEBHOOK_SECRET_GITHUB` | —                        | HMAC secret for GitHub webhook signature verification                        |
| `WEBHOOK_SECRET_RENDER` | —                        | HMAC secret for Render webhook signature verification                        |
| `ALLOWED_ORIGINS`       | (none)                   | Comma-separated CORS origins. `*` = allow all origins, empty = CORS disabled |

---

## Database and Tokens

- Ingest (`@usekamori/ingest`) and MCP (`@usekamori/mcp`) both use the SQLite database at `DB_PATH` (default `./data/logs/ingress.db`), so MCP tools query the same log data written by `/v1/ingest`.
- `INGEST_TOKEN` only gates server `/v1/*` HTTP routes (ingest/query endpoints) via `Authorization: Bearer`.
- `MCP_TOKEN` only gates MCP HTTP (`/mcp`) via `Authorization: Bearer`.
- `MCP_TOKEN` does not inherit from `INGEST_TOKEN`; they are independent.
- `npx kamori` defaults both tokens to disabled (`INGEST_TOKEN=` and `MCP_TOKEN=`) unless explicitly set.

---

## Deploy

### Docker Compose (self-hosted)

```bash
cp .env.example .env   # edit INGEST_TOKEN, MCP_TOKEN, etc.
docker compose up -d
docker compose logs -f
```

### Expose locally with localtunnel

```bash
npm run start:lt
```

Starts the server and opens a tunnel on `https://kamori-ingest.loca.lt`. Useful for testing webhooks from Vercel, GitHub, etc.

---

## Packages

| Package                                          | Description                                                                   |
| ------------------------------------------------ | ----------------------------------------------------------------------------- |
| [`@usekamori/core`](packages/core/README.md)     | Shared SQLite layer, env config, DB adapter interface                         |
| [`@usekamori/ingest`](packages/ingest/README.md) | Fastify HTTP ingest server                                                    |
| [`@usekamori/mcp`](packages/mcp/README.md)       | MCP server — exposes logs to Claude / Cursor                                  |
| [`@usekamori/sdk`](packages/sdk/README.md)       | HTTP client, console shim, Pino / Winston transports                          |
| [`kamori`](packages/kamori/README.md)            | `npx kamori` scaffolder — generates `.env`, `docker-compose.yml`, `.mcp.json` |

---

## Contributing & security

- [CONTRIBUTING.md](CONTRIBUTING.md) — dev setup, running tests, PR guidelines
- [SECURITY.md](SECURITY.md) — how to report vulnerabilities
- [LICENSE](LICENSE) — MIT (SDK + scaffolder) / Elastic License 2.0 (server + MCP)
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) — common issues, capacity notes, performance tuning
