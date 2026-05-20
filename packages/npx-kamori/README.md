# npx kamori

Scaffold a self-hosted [Kamori](https://github.com/usekamori/kamori) log ingestion setup in seconds.

```bash
npx kamori
```

## Two ways to run

| Mode                 | How                                                                                                                                                                                                                              | Default                                              |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| **Node from source** | Clones [kamori-io/kamori](https://github.com/usekamori/kamori) into `./kamori/`, runs `npm install`, then builds **only** `@usekamori/ingest` and `@usekamori/mcp`. Your `npm start` runs ingest (+ MCP) with `dotenv` loading `.env`. | **Yes** (interactive default)                        |
| **Docker**           | Writes `docker-compose.yml` and image-based docs; no git clone.                                                                                                                                                                  | Pass **`--docker`** or answer **y** to "Use Docker?" |

Repo URL and branch are configured at the top of `packages/kamori/src/index.ts` (`KAMORI_GIT_URL`, `KAMORI_GIT_REF`).

By default, scaffolds are **tokenless** (`INGEST_TOKEN=` and `MCP_TOKEN=`) unless you explicitly set `--log-token` / `--mcp-token` or opt in during interactive prompts. MCP is on unless **`--no-mcp`**.
If you don't provide a CORS allowlist, `ALLOWED_ORIGINS` is set to `*` (allow all origins). For production, set a strict allowlist in `.env`.

The generated **`.env`** lists every Community Edition variable (same set as [`@usekamori/core`](https://github.com/usekamori/kamori/tree/main/packages/core)) with safe self-hosted defaults. Full reference: **[docs.kamori.io/configuration](https://docs.kamori.io/configuration)**.

## What it generates

### Node path (default)

```
kamori-ai/
├── .env                  # Full env template + secrets (mode 0600); see docs.kamori.io/configuration
├── .gitignore            # .env, kamori/, SQLite files
├── package.json          # dotenv + concurrently; npm start → ingest + MCP
├── .mcp.json             # HTTP MCP client (unless --no-mcp; mode 0600)
├── README.md
├── kamori/               # git clone (after scaffold runs)
└── data/logs/.gitkeep
```

### Docker path (`--docker`)

```
kamori-ai/
├── .env
├── docker-compose.yml    # env_file: .env; DB_PATH override for container
├── package.json          # npm start → docker compose up -d
├── .mcp.json             # (unless --no-mcp)
├── README.md             # includes plain `docker run …` one-liner
└── data/logs/.gitkeep
```

Default HTTP ports are **3110** (ingest) and **3111** (MCP). Default CORS policy is:
`ALLOWED_ORIGINS=*`

## Usage

```
npx kamori [dir] [options]

Arguments:
  dir                   Project directory name (default: kamori-ai)

Options:
  --docker              Use Docker (compose + docs). Omit for Node-from-source (clone + build).
  --log-token <secret>  Set INGEST_TOKEN (Authorization: Bearer)
  --mcp-token <secret>  Set MCP_TOKEN (MCP HTTP Bearer)
  --allowed-origins <list>  Comma-separated CORS allowlist for browser-originated logs.
                            Example: http://localhost:5173,http://localhost:3110
  --log-port <n>        Ingest port (default: 3110)
  --mcp-port <n>        MCP port (default: 3111)
  --no-mcp              No MCP server / no .mcp.json
  --yes, -y             Non-interactive (default: Node path, MCP on, tokens disabled)
```

### Interactive (default)

Prompts include: directory name, **Use Docker? (y/N)** → default **N** (Node), **Set INGEST_TOKEN? (y/N)**, disable MCP?, **Set MCP_TOKEN? (y/N)**, and allowed origins (leave blank to allow all origins via `ALLOWED_ORIGINS=*`).

### Non-interactive examples

```bash
# Node from source — clone kamori, build server + mcp, npm install in project root
npx kamori my-logs --yes

# Docker — compose + plain docker run documented in README
npx kamori my-logs --docker --yes

# Explicit tokens + Docker
npx kamori my-logs --docker --log-token s3cr3t --mcp-token mcp-only --yes

# Custom CORS origins
npx kamori my-logs --allowed-origins http://localhost:5173,http://localhost:3110 --yes
```

## After scaffolding

The CLI prints **example `curl` commands** for ingest (`POST /v1/ingest`), health (`GET /v1/health`), and live tail (`GET /v1/stream`), using your chosen ingest port and `Authorization: Bearer` when `INGEST_TOKEN` is set (health never requires the token).

**Node path:** `cd` into the project and run `npm start` (already ran `npm install` in `./kamori/` and the project root during scaffold).

**Docker path:** `npm start` or `docker compose up -d`; see generated `README.md` for the **`docker run`** one-liner.

## Connecting Claude Code

When `.mcp.json` is present, Claude Code can load it. See [@usekamori/mcp — Streamable HTTP](https://github.com/usekamori/kamori/tree/main/packages/mcp#streamable-http-docker).

```bash
claude mcp add kamori --transport http http://localhost:3111/mcp
# with MCP_TOKEN:
claude mcp add kamori --transport http http://localhost:3111/mcp \
  --header "Authorization: Bearer <your-mcp-token>"
```
