# `kamori` Technical Specification

**Package:** `kamori`  
**Entry point:** `src/index.ts`  
**Runtime:** Node.js >= 18  
**Invocation:** `npx kamori [dir] [options]`

## 1) Purpose

`kamori` scaffolds a ready-to-run, self-hosted Kamori setup in a new project directory.

It supports two execution modes:

- **Node-from-source mode (default):** clones `kamori-io/kamori`, installs dependencies, builds `/ingest` and `/mcp`, and creates root scripts to run both with `.env`.
- **Docker mode (`--docker`):** generates a Docker Compose-based setup using `ghcr.io/usekamori/kamori:latest` without cloning the monorepo.

## 2) Goals and Non-Goals

### Goals

- Generate a working project with minimal required files and sane defaults.
- Support both interactive and non-interactive (CI-friendly) usage.
- Configure ingest auth (`INGEST_TOKEN`) and optional MCP auth (`MCP_TOKEN`).
- Scaffold CORS settings through `ALLOWED_ORIGINS` with explicit production guidance.
- Optionally enable/disable MCP endpoint and token independently.

### Non-Goals

- Validate origin URLs in `--allowed-origins`.
- Modify existing directories (fails if target exists).
- Provide incremental updates to previously scaffolded projects.

## 3) Command Interface

## Positional argument

- `dir` (optional): target directory name; default `kamori-ai`.

## Supported flags

- `--docker`  
  Use Docker Compose/image path instead of cloning and building Kamori source.
- `--log-token <secret>`  
  Explicitly set `INGEST_TOKEN`.
- `--mcp-token <secret>`  
  Explicitly set `MCP_TOKEN`.
- `--allowed-origins <csv>`  
  Set `ALLOWED_ORIGINS` (comma-separated string as provided).
- `--log-port <n>`  
  Ingest server port (default `3110`).
- `--mcp-port <n>`  
  MCP HTTP port (default `3111`).
- `--no-mcp`  
  Disable MCP server and `.mcp.json` generation.
- `--yes`, `-y`  
  Non-interactive mode.

## Parsing behavior

- Unknown flags are ignored.
- The first non-flag token becomes `dir`.
- Flag values are read from the immediate next token (if present).

## 4) Interactive vs Non-Interactive Flow

## Interactive mode is used when all are true

- `--yes` is **not** set
- `CI` env var is not set
- `stdin` is a TTY

## Interactive prompts

- Project directory (default `kamori-ai`)
- Docker usage (`y/N`) unless `--docker` passed
- Set `INGEST_TOKEN`? (`y/N`)
- If opted in: prompt for `INGEST_TOKEN` value (blank -> disabled)
- Disable MCP (`y/N`) unless `--no-mcp` passed
- Set `MCP_TOKEN`? (`y/N`, only when MCP enabled and no explicit value)
- If opted in: prompt for `MCP_TOKEN` value (blank -> disabled)
- Allowed origins prompt:
  - blank input -> `ALLOWED_ORIGINS=*` (allow all origins)

## Non-interactive defaults

- `dir = kamori-ai` unless provided
- `docker = false` unless `--docker`
- `mcp = true` unless `--no-mcp`
- `INGEST_TOKEN` disabled unless explicitly provided by `--log-token`
- `MCP_TOKEN` disabled unless explicitly provided by `--mcp-token`
- `ALLOWED_ORIGINS=*` unless `--allowed-origins` provided

## 5) CORS Specification

## Scaffold-level behavior

- If user **does not** provide `--allowed-origins` and leaves prompt blank, `.env` gets:
  - `ALLOWED_ORIGINS=*`
- CLI completion output warns when `ALLOWED_ORIGINS=*` and instructs user to set whitelist in `<project>/.env`.

## Runtime interpretation (server package integration)

- `/ingest` resolves CORS as:
  - `ALLOWED_ORIGINS` empty -> CORS disabled (`origin: false`)
  - `ALLOWED_ORIGINS` contains `*` -> allow all (`origin: true`)
  - otherwise -> allow listed origins

## 6) Token Resolution Rules

## `INGEST_TOKEN`

Order of precedence:

1. `--log-token <secret>`
2. interactive opt-in + value (blank -> empty)
3. empty (disabled)

## `MCP_TOKEN` (when MCP enabled)

Order of precedence:

1. `--mcp-token <secret>`
2. interactive opt-in + value (blank -> empty)
3. empty (disabled)

If MCP is disabled, `MCP_TOKEN` is always empty and `MCP_PORT=0` in `.env`.

## 7) Validation and Error Handling

- Directory name must match `^[A-Za-z0-9._-]+$` and be non-empty.
- Ports must be integers in range `1..65535`.
- Existing target directory causes hard failure.
- Command execution failures (`git clone`, `npm install`, `npm run build`) exit with code `1`.

## 8) Generated Artifacts

## Always generated

- `.env` (mode `0600`)
- `.gitignore`
- `package.json`
- `README.md`
- `data/logs/.gitkeep`

## Conditionally generated

- `.mcp.json` (mode `0600`) when MCP enabled
- `docker-compose.yml` when `--docker`
- `kamori/` clone when **not** using Docker

## `.env` content scope

Generated `.env` includes full Community Edition variable set used by Kamori, including:

- server (`HOST`, `PORT`, `LOG_LEVEL`, `NODE_ENV`)
- auth (`INGEST_TOKEN`, `MCP_TOKEN`)
- DB (`DB_PATH`, `RETENTION_DAYS`)
- limits (`BODY_LIMIT_BYTES`, `MAX_ROWS`, `RATE_LIMIT_MAX`)
- CORS (`ALLOWED_ORIGINS`)
- syslog/webhooks/cloud toggles

## 9) Mode-Specific Behavior

## Docker mode

- `package.json` contains `start: "docker compose up -d"`
- `docker-compose.yml` uses:
  - image `ghcr.io/usekamori/kamori:latest`
  - `env_file: .env`
  - `DB_PATH` override for container path
  - exposed ports for ingest and optional MCP
  - named volume `kamori-data`
  - healthcheck on `/v1/health`

## Node-from-source mode

- Clones `https://github.com/usekamori/kamori.git` (`main`) into `./kamori`
- Runs:
  - `npm install` in clone
  - `npm run build -w /ingest -w /mcp`
  - `npm install` in generated project root
- Generated scripts:
  - `start:ingest`
  - optional `start:mcp`
  - `start` as concurrent ingest+MCP or ingest-only

## 10) Completion Output Contract

After successful scaffold:

- Prints next steps (`cd`, `npm start`, Docker alternatives)
- Prints `claude mcp add ...` command if MCP enabled
- Prints curl command to send a log ingress including correct port and token if set
- Prints curl command to test health (ingest port; `/v1/health` does not use `Authorization: Bearer`)
- Prints curl command to tail logs (`GET /v1/stream`) including `Authorization: Bearer` when `INGEST_TOKEN` is set
- Prints warnings when:
  - `INGEST_TOKEN` disabled
  - `MCP_TOKEN` disabled while MCP enabled
  - `ALLOWED_ORIGINS=*` (wide-open CORS), including guidance to set whitelist in `<project>/.env`
- Prints configuration reference URL:
  - `https://docs.kamori.io/configuration`

## 11) Security Notes

- Secret-bearing files `.env` and `.mcp.json` are generated with mode `0600`.
- CORS default in scaffold (`*`) is convenience-oriented; CLI warns to tighten for production.
- Auth can be intentionally disabled via flags; CLI explicitly warns at the end.

## 12) Out of Scope / Future Enhancements

- URL validation for `--allowed-origins`
- Interactive confirmation before writing insecure defaults in production-like environments
- Project update mode (re-run on existing directory)
- Template version pinning and migration workflow
