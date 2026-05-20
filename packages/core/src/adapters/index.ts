export type { DbAdapter, DbRow, DbRunResult } from "./db-adapter.js";
export { BetterSqliteAdapter } from "./better-sqlite.js";
export type { AuthAdapter } from "./auth-adapter.js";
export { EnvTokenAuth } from "./auth-adapter.js";
export type { BillingAdapter } from "./billing-adapter.js";
export { NoBillingAdapter } from "./billing-adapter.js";
export type { EmailAdapter, EmailOptions } from "./email-adapter.js";
export { NoopEmailAdapter } from "./email-adapter.js";
export type { RetentionAdapter } from "./retention-adapter.js";
export { EnvRetentionAdapter } from "./retention-adapter.js";
export type { McpAdapter } from "./mcp-adapter.js";
export { LocalDbMcpAdapter } from "./mcp-adapter.js";
export type { ServerPlugins } from "./server-plugins.js";

import { BetterSqliteAdapter } from "./better-sqlite.js";
import { EnvTokenAuth } from "./auth-adapter.js";
import { NoBillingAdapter } from "./billing-adapter.js";
import { NoopEmailAdapter } from "./email-adapter.js";
import { EnvRetentionAdapter } from "./retention-adapter.js";
import { LocalDbMcpAdapter } from "./mcp-adapter.js";
import type { DbAdapter } from "./db-adapter.js";
import type { AuthAdapter } from "./auth-adapter.js";
import type { BillingAdapter } from "./billing-adapter.js";
import type { EmailAdapter } from "./email-adapter.js";
import type { RetentionAdapter } from "./retention-adapter.js";
import type { McpAdapter } from "./mcp-adapter.js";
import { DB_PATH, INGEST_TOKEN, RETENTION_DAYS } from "../env.js";

/**
 * The full set of adapters injected into the server and MCP processes.
 * OSS packages define this interface; Cloud packages provide a full implementation.
 */
export interface KamoriAdapters {
  db: DbAdapter;
  auth: AuthAdapter;
  billing: BillingAdapter;
  email: EmailAdapter;
  retention: RetentionAdapter;
  mcp: McpAdapter;
}

/**
 * Returns the default self-hosted adapter set, sourced entirely from environment variables.
 * Called by the OSS entrypoints (server.ts, mcp.ts) at startup.
 *
 * Cloud entrypoints (private repo) call buildServer() / startMcp() with their own adapter set.
 */
export function defaultAdapters(): KamoriAdapters {
  const db = new BetterSqliteAdapter(DB_PATH);
  return {
    db,
    auth: new EnvTokenAuth(INGEST_TOKEN),
    billing: new NoBillingAdapter(),
    email: new NoopEmailAdapter(),
    retention: new EnvRetentionAdapter(RETENTION_DAYS),
    mcp: new LocalDbMcpAdapter(db),
  };
}
