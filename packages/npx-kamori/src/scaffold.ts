/**
 * Pure scaffold helpers and content generators for `kamori` CLI.
 */

/** Clone / build Kamori from GitHub (non-Docker path). */
export const KAMORI_GIT_URL = "https://github.com/usekamori/kamori.git";
export const KAMORI_GIT_REF = "main";
export const KAMORI_SUBDIR = "kamori";

/** Community Edition env reference (matches docs site). */
export const DOCS_CONFIGURATION_URL = "https://docs.kamori.io/configuration";

export const DEFAULT_DIR = "kamori-ai";
export const DEFAULT_LOG_PORT = 3110;
export const DEFAULT_MCP_PORT = 3111;
export const ALLOW_ALL_ORIGINS = "*";

export interface CliFlags {
  dirName?: string;
  logToken?: string;
  mcpToken?: string;
  allowedOrigins?: string;
  logPort?: number;
  mcpPort?: number;
  noMcp?: boolean;
  /** When true, scaffold Docker Compose + image-based run docs. */
  docker?: boolean;
  yes: boolean;
}

export function validateDirName(name: string): string | null {
  if (name.length === 0) return "directory name must not be empty";
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    return `directory name "${name}" contains invalid characters (allowed: A-Z a-z 0-9 . _ -)`;
  }
  return null;
}

export function validatePort(n: number): string | null {
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    return `port must be an integer between 1 and 65535 (got ${n})`;
  }
  return null;
}

export function parseArgsFrom(argv: string[]): CliFlags {
  const result: CliFlags = { yes: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--yes" || arg === "-y") {
      result.yes = true;
    } else if (arg === "--no-mcp") {
      result.noMcp = true;
    } else if (arg === "--docker") {
      result.docker = true;
    } else if (arg === "--log-token" && argv[i + 1]) {
      result.logToken = argv[++i];
    } else if (arg === "--mcp-token" && argv[i + 1]) {
      result.mcpToken = argv[++i];
    } else if (arg === "--allowed-origins" && argv[i + 1]) {
      result.allowedOrigins = argv[++i];
    } else if (arg === "--log-port" && argv[i + 1]) {
      result.logPort = Number.parseInt(argv[++i], 10);
    } else if (arg === "--mcp-port" && argv[i + 1]) {
      result.mcpPort = Number.parseInt(argv[++i], 10);
    } else if (!arg.startsWith("--") && result.dirName === undefined) {
      result.dirName = arg;
    }
  }
  return result;
}

export function resolveLogToken(
  flags: CliFlags,
  interactiveLogTokenSet = false,
  interactiveLogToken?: string,
): string {
  if (flags.logToken !== undefined) return flags.logToken.trim();
  if (!interactiveLogTokenSet) return "";
  return interactiveLogToken?.trim() ?? "";
}

export function resolveMcpToken(
  mcp: boolean,
  flags: CliFlags,
  interactiveMcpTokenSet = false,
  interactiveMcpToken: string | undefined,
): string {
  if (!mcp) return "";
  if (flags.mcpToken !== undefined) return flags.mcpToken.trim();
  if (!interactiveMcpTokenSet) return "";
  return interactiveMcpToken?.trim() ?? "";
}

export function resolveAllowedOrigins(
  flags: CliFlags,
  interactiveAllowedOrigins?: string,
): string {
  if (flags.allowedOrigins !== undefined) return flags.allowedOrigins.trim();
  if (interactiveAllowedOrigins !== undefined) {
    const trimmed = interactiveAllowedOrigins.trim();
    return trimmed || ALLOW_ALL_ORIGINS;
  }
  return ALLOW_ALL_ORIGINS;
}

/**
 * Full `.env` aligned with `@usekamori/core` env.ts. User-tuned values come from
 * existing prompts/flags; everything else gets safe self-hosted defaults.
 */
export function dotenv(
  mcp: boolean,
  logToken: string,
  mcpToken: string,
  allowedOrigins: string,
  logPort: number,
  mcpPort: number,
): string {
  const lines: string[] = [
    "# Kamori — self-hosted (Community Edition)",
    `# Full reference: ${DOCS_CONFIGURATION_URL}`,
    "",
    "# Server",
    "HOST=0.0.0.0",
    `PORT=${logPort}`,
    "LOG_LEVEL=info",
    "NODE_ENV=development",
    "",
    "# Authentication — Bearer token on /v1/* (empty = disabled; dev only)",
    `INGEST_TOKEN=${logToken}`,
    "",
    "# Database",
    "DB_PATH=./data/logs/ingress.db",
    "RETENTION_DAYS=30",
    "",
    "# Ingest limits",
    "BODY_LIMIT_BYTES=1000000",
    "MAX_ROWS=1000",
    "RATE_LIMIT_MAX=100",
    "",
    "# CORS — comma-separated origins for browser SDK / fetch from web apps",
    `ALLOWED_ORIGINS=${allowedOrigins}`,
    "",
    "# Syslog UDP/TCP (0 = disabled)",
    "SYSLOG_PORT=0",
    "",
    "# Webhook HMAC secrets (empty = disabled for that provider)",
    "WEBHOOK_SECRET_VERCEL=",
    "WEBHOOK_SECRET_GITHUB=",
    "WEBHOOK_SECRET_RENDER=",
    "",
    "# Kamori Cloud — leave false/unset for self-hosted",
    "CLOUD_MODE=false",
    "",
    "# MCP HTTP (MCP_PORT=0 disables listener in @usekamori/ingest)",
  ];
  if (mcp) {
    lines.push(`MCP_PORT=${mcpPort}`);
    lines.push(`MCP_TOKEN=${mcpToken}`);
  } else {
    lines.push("MCP_PORT=0");
    lines.push("MCP_TOKEN=");
  }
  lines.push("");
  lines.push("# MCP stdio only — used when running @usekamori/mcp with --stdio");
  lines.push("# STDIO_TOKEN=");
  lines.push("");
  return lines.join("\n");
}

export function dockerCompose(
  mcp: boolean,
  logPort: number,
  mcpPort: number,
): string {
  const lines = [
    "services:",
    "  kamori:",
    "    image: ghcr.io/usekamori/kamori:latest",
    "    env_file:",
    "      - .env",
    "    environment:",
    "      # Overrides host-relative DB_PATH from .env for the container",
    "      DB_PATH: /app/data/logs/ingress.db",
    "    ports:",
    `      - "${logPort}:${logPort}"`,
  ];

  if (mcp) {
    lines.push(`      - "${mcpPort}:${mcpPort}"`);
  }

  lines.push(
    "    volumes:",
    "      - kamori-data:/app/data",
    "    restart: unless-stopped",
    "    healthcheck:",
    `      test: ["CMD", "wget", "-qO-", "http://localhost:${logPort}/v1/health"]`,
    "      interval: 30s",
    "      timeout: 5s",
    "      retries: 3",
    "      start_period: 10s",
    "",
    "volumes:",
    "  kamori-data:",
    "",
  );

  return lines.join("\n");
}

/** Single-container run (no compose) — for README / console output. */
export function dockerPlainRun(
  mcp: boolean,
  logPort: number,
  mcpPort: number,
): string {
  const portArgs = mcp
    ? `-p ${logPort}:${logPort} -p ${mcpPort}:${mcpPort}`
    : `-p ${logPort}:${logPort}`;
  return [
    "docker run -d --name kamori",
    portArgs,
    "-v kamori-data:/app/data",
    "--env-file .env",
    "-e DB_PATH=/app/data/logs/ingress.db",
    "ghcr.io/usekamori/kamori:latest",
  ].join(" ");
}

export function mcpConfig(mcpToken: string, mcpPort: number): string {
  const kamori: Record<string, unknown> = {
    url: `http://localhost:${mcpPort}/mcp`,
  };
  if (mcpToken) {
    kamori.headers = { Authorization: `Bearer ${mcpToken}` };
  }
  return JSON.stringify({ mcpServers: { kamori } }, null, 2) + "\n";
}

export function gitignore(): string {
  return [
    "# Environment — contains secrets, never commit",
    ".env",
    "",
    "# Cloned Kamori monorepo (Node path)",
    `${KAMORI_SUBDIR}/`,
    "",
    "# SQLite database files",
    "data/logs/*.db",
    "data/logs/*.db-shm",
    "data/logs/*.db-wal",
    "",
  ].join("\n");
}

export function packageJsonDocker(npmPackageName: string): string {
  return (
    JSON.stringify(
      {
        name: npmPackageName,
        private: true,
        scripts: {
          start: "docker compose up -d",
        },
      },
      null,
      2,
    ) + "\n"
  );
}

export function packageJsonNode(npmPackageName: string, mcp: boolean): string {
  const scripts: Record<string, string> = {
    "start:ingest": `node -r dotenv/config --enable-source-maps ${KAMORI_SUBDIR}/packages/ingest/dist/ingest.js`,
  };
  if (mcp) {
    scripts["start:mcp"] =
      `node -r dotenv/config --enable-source-maps ${KAMORI_SUBDIR}/packages/mcp/dist/mcp.js`;
    scripts.start =
      'concurrently -n ingest,mcp -c blue,magenta "npm run start:ingest" "npm run start:mcp"';
  } else {
    scripts.start = "npm run start:ingest";
  }
  const devDependencies: Record<string, string> = {
    dotenv: "^16.4.5",
  };
  if (mcp) {
    devDependencies.concurrently = "^9.1.0";
  }
  return (
    JSON.stringify(
      {
        name: npmPackageName,
        private: true,
        scripts,
        devDependencies,
      },
      null,
      2,
    ) + "\n"
  );
}

export function readmeDocker(
  dirName: string,
  logToken: string,
  mcp: boolean,
  mcpToken: string,
  allowedOrigins: string,
  logPort: number,
  mcpPort: number,
  dockerRunLine: string,
): string {
  const tokenFlag = logToken
    ? `  -H "Authorization: Bearer ${logToken}" \\\n  `
    : "  ";
  const mcpSection = mcp
    ? [
        "## MCP (Claude Code / Cursor)",
        "",
        "This stack runs [@usekamori/mcp](https://github.com/usekamori/kamori/tree/main/packages/mcp) in **Streamable HTTP** mode (same container as the ingest API).",
        "",
        "- **`INGEST_TOKEN`** — `Authorization: Bearer` on `/v1/*` ingest and query routes.",
        "- **`MCP_TOKEN`** — optional `Authorization: Bearer` for MCP HTTP; if unset, MCP has no auth (fine for local-only).",
        "",
        "Project **`.mcp.json`** matches the [HTTP example in the MCP package](https://github.com/usekamori/kamori/tree/main/packages/mcp#streamable-http-docker): `url` and optional `headers.Authorization`.",
        "",
        "Claude Code can load `.mcp.json` automatically, or register manually:",
        "",
        "```bash",
        mcpToken
          ? `claude mcp add kamori --transport http http://localhost:${mcpPort}/mcp \\\n  --header "Authorization: Bearer ${mcpToken}"`
          : `claude mcp add kamori --transport http http://localhost:${mcpPort}/mcp`,
        "```",
        "",
        'Then ask Claude: _"Show me errors from the last hour"_',
        "",
      ].join("\n")
    : "";

  return [
    `# ${dirName} — Kamori log ingestion (Docker)`,
    "",
    "Self-hosted log ingestion powered by [Kamori](https://github.com/usekamori/kamori).",
    "",
    "## Quick start",
    "",
    "```bash",
    "# Start (Compose — loads .env via env_file)",
    "npm start",
    "# or: docker compose up -d",
    "",
    "# Same image, plain Docker (from project dir; uses .env + DB_PATH override)",
    dockerRunLine,
    "",
    "# Send a test log",
    `curl -X POST http://localhost:${logPort}/v1/ingest \\`,
    `${tokenFlag}-H "content-type: application/json" \\`,
    `  -d '{"service":"test","level":"info","message":"hello kamori"}'`,
    "```",
    "",
    mcpSection,
    "## Endpoints",
    "",
    "| Method | Path | Description |",
    "|--------|------|-------------|",
    "| POST | /v1/ingest | Ingest log events (JSON array or object) |",
    "| GET | /v1/health | Health check |",
    "| GET | /v1/stream | NDJSON live tail |",
    "| GET | /v1/export | Bulk export (NDJSON / CSV) |",
    "| GET | /metrics | Prometheus metrics |",
    "",
    "## Configuration",
    "",
    `Edit **\`.env\`** for all settings (full list: [${DOCS_CONFIGURATION_URL}](${DOCS_CONFIGURATION_URL})).`,
    `Compose overrides \`DB_PATH\` to \`/app/data/logs/ingress.db\` in the container; other values come from \`.env\`.`,
    allowedOrigins
      ? `**\`ALLOWED_ORIGINS\`** is set to \`${allowedOrigins}\`${allowedOrigins === ALLOW_ALL_ORIGINS ? " (all origins — restrict this in production)" : ""}.`
      : `**\`ALLOWED_ORIGINS\`** is empty — CORS is disabled. Set it in \`.env\` if you need browser SDK or cross-origin fetch access.`,
    "",
  ].join("\n");
}

export function readmeNode(
  dirName: string,
  logToken: string,
  mcp: boolean,
  mcpToken: string,
  allowedOrigins: string,
  logPort: number,
  mcpPort: number,
): string {
  const tokenFlag = logToken
    ? `  -H "Authorization: Bearer ${logToken}" \\\n  `
    : "  ";
  const mcpSection = mcp
    ? [
        "## MCP (Claude Code / Cursor)",
        "",
        "MCP runs as a second Node process (Streamable HTTP) from the cloned monorepo. **`MCP_TOKEN`** is optional Bearer auth for MCP HTTP.",
        "",
        "Project **`.mcp.json`** matches [@usekamori/mcp HTTP config](https://github.com/usekamori/kamori/tree/main/packages/mcp#streamable-http-docker).",
        "",
        "```bash",
        mcpToken
          ? `claude mcp add kamori --transport http http://localhost:${mcpPort}/mcp \\\n  --header "Authorization: Bearer ${mcpToken}"`
          : `claude mcp add kamori --transport http http://localhost:${mcpPort}/mcp`,
        "```",
        "",
      ].join("\n")
    : "";

  return [
    `# ${dirName} — Kamori log ingestion (Node from source)`,
    "",
    "This folder was generated by `npx kamori` **without Docker**. The Kamori monorepo is cloned into `./kamori/`, and only `@usekamori/ingest` + `@usekamori/mcp` were built.",
    "",
    "## Quick start",
    "",
    "```bash",
    "# From this directory (loads .env via dotenv)",
    "npm start",
    "",
    "# Or run processes separately",
    "npm run start:ingest",
    ...(mcp ? ["npm run start:mcp"] : []),
    "",
    "# Send a test log",
    `curl -X POST http://localhost:${logPort}/v1/ingest \\`,
    `${tokenFlag}-H "content-type: application/json" \\`,
    `  -d '{"service":"test","level":"info","message":"hello kamori"}'`,
    "```",
    "",
    mcpSection,
    "## CORS for browser SDKs",
    "",
    allowedOrigins
      ? allowedOrigins === ALLOW_ALL_ORIGINS
        ? `\`.env\` has \`ALLOWED_ORIGINS=*\` (all origins). **Restrict this to your app's URL(s) before going to production.**`
        : `\`.env\` has \`ALLOWED_ORIGINS=${allowedOrigins}\` — only those origins may send browser requests.`
      : `\`.env\` has \`ALLOWED_ORIGINS=\` (empty) — CORS is disabled. Set it to your app's URL(s) if you use the browser SDK or cross-origin fetch.`,
    "",
    "Update `ALLOWED_ORIGINS` to match your app URL(s) when needed.",
    "",
    "## Layout",
    "",
    `- **\`.env\`** — all [\`@usekamori/core\`](https://github.com/usekamori/kamori/tree/main/packages/core) environment variables; see [${DOCS_CONFIGURATION_URL}](${DOCS_CONFIGURATION_URL}).`,
    `- **\`${KAMORI_SUBDIR}/\`** — git clone of [kamori-io/kamori](${KAMORI_GIT_URL}) at branch **${KAMORI_GIT_REF}**.`,
    "",
    "## Endpoints",
    "",
    "| Method | Path | Description |",
    "|--------|------|-------------|",
    "| POST | /v1/ingest | Ingest log events (JSON array or object) |",
    "| GET | /v1/health | Health check |",
    "| GET | /v1/stream | NDJSON live tail |",
    "| GET | /v1/export | Bulk export (NDJSON / CSV) |",
    "| GET | /metrics | Prometheus metrics |",
    "",
    `See [${DOCS_CONFIGURATION_URL}](${DOCS_CONFIGURATION_URL}) for the full reference.`,
    "",
  ].join("\n");
}

export function npmSafeName(dirName: string): string {
  return (
    dirName
      .toLowerCase()
      .replaceAll(/[^a-z0-9-]/g, "-")
      .replaceAll(/^-+|-+$/g, "") || "kamori-local"
  );
}

/**
 * One-line curl examples for completion output (§10 Completion Output Contract).
 * Health uses `skipAuth` in @usekamori/ingest — no Authorization header required. Ingest and stream
 * include the header when `INGEST_TOKEN` is set.
 */
export function formatCurlIngestExample(
  logPort: number,
  logToken: string,
): string {
  const tokenLine = logToken
    ? `  -H "Authorization: Bearer ${logToken}" \\\n`
    : "";
  return [
    `curl -X POST http://localhost:${logPort}/v1/ingest \\`,
    tokenLine + `  -H "content-type: application/json" \\`,
    `  -d '{"service":"test","level":"info","message":"hello kamori"}'`,
  ].join("\n");
}

export function formatCurlHealthExample(logPort: number): string {
  return `curl http://localhost:${logPort}/v1/health`;
}

export function formatCurlStreamExample(
  logPort: number,
  logToken: string,
): string {
  if (!logToken) {
    return `curl -N http://localhost:${logPort}/v1/stream`;
  }
  return [
    `curl -N http://localhost:${logPort}/v1/stream \\`,
    `  -H "Authorization: Bearer ${logToken}"`,
  ].join("\n");
}
