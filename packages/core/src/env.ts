import * as path from "path";

function parseIntEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return defaultValue;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(
      `Invalid environment variable ${name}="${raw}": expected a non-negative integer`,
    );
  }
  return n;
}

export const PORT = parseIntEnv("PORT", 3110);
export const HOST = process.env.HOST ?? "0.0.0.0";
export const INGEST_TOKEN = process.env.INGEST_TOKEN ?? "";
export const LOG_LEVEL = process.env.LOG_LEVEL ?? "info";
export const NODE_ENV = process.env.NODE_ENV ?? "development";
export const BODY_LIMIT_BYTES = parseIntEnv("BODY_LIMIT_BYTES", 1_000_000);
export const MAX_ROWS = parseIntEnv("MAX_ROWS", 1000);
/** Maximum serialised byte size of a single ingest row. 0 disables the check. */
export const MAX_ROW_BYTES = parseIntEnv("MAX_ROW_BYTES", 0);
export const RATE_LIMIT_MAX = parseIntEnv("RATE_LIMIT_MAX", 100);
/**
 * Maximum number of concurrent in-flight ingest DB writes allowed before the
 * server returns 503. Limits event-loop blocking under burst write load on the
 * OSS SQLite path (better-sqlite3 is synchronous). Set to 0 to disable.
 * Has no meaningful effect on the Cloud path (LibSQL is async).
 */
export const INGEST_CONCURRENCY_LIMIT = parseIntEnv(
  "INGEST_CONCURRENCY_LIMIT",
  20,
);
export const DB_PATH =
  process.env.DB_PATH ?? path.join(process.cwd(), "data", "logs", "ingress.db");
export const MCP_TOKEN = process.env.MCP_TOKEN ?? "";
export const MCP_PORT = parseIntEnv("MCP_PORT", 3111);
/**
 * When set, the /metrics endpoint requires `Authorization: Bearer <METRICS_TOKEN>`.
 * Requests with a missing or non-matching token receive 401.
 * Leave empty to allow unauthenticated scraping (self-hosted default).
 */
export const METRICS_TOKEN = process.env.METRICS_TOKEN ?? "";
/** Number of days to retain logs. 0 means retention is disabled (logs are kept forever). */
export const RETENTION_DAYS = parseIntEnv("RETENTION_DAYS", 0);
/** UDP/TCP port for syslog ingestion. 0 means disabled. */
export const SYSLOG_PORT = parseIntEnv("SYSLOG_PORT", 0);
/**
 * Bind address for the syslog UDP/TCP listeners.
 * Defaults to 127.0.0.1 (loopback only) so the port is not exposed to the
 * network unless explicitly configured. Set to 0.0.0.0 to accept from any
 * interface (only do this behind a firewall or on a trusted network).
 */
export const SYSLOG_HOST = process.env.SYSLOG_HOST ?? "127.0.0.1";

export const WEBHOOK_SECRET_VERCEL = process.env.WEBHOOK_SECRET_VERCEL ?? "";
export const WEBHOOK_SECRET_GITHUB = process.env.WEBHOOK_SECRET_GITHUB ?? "";
export const WEBHOOK_SECRET_RENDER = process.env.WEBHOOK_SECRET_RENDER ?? "";

/**
 * Comma-separated list of allowed CORS origins.
 * Example: ALLOWED_ORIGINS=https://app.kamori.io,https://localhost:3002
 * When empty, CORS is disabled (default for self-hosted).
 */
export const ALLOWED_ORIGINS: string[] = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  : [];

/**
 * Set to "true" to enable Kamori Cloud mode.
 * In cloud mode the server expects per-project API keys and a Turso database;
 * the default single-tenant behaviour (INGEST_TOKEN + local SQLite) is bypassed
 * by cloud-injected ServerPlugins. Self-hosted deployments leave this unset.
 */
export const CLOUD_MODE = process.env.CLOUD_MODE === "true";
