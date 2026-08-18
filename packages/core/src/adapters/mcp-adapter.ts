import type { DbAdapter } from "./db-adapter.js";

/**
 * McpAdapter — resolves the DbAdapter for MCP tool calls.
 *
 * Self-hosted: returns the local BetterSqliteAdapter (already initialised at startup).
 * Cloud stdio: exchanges an API key for Turso credentials once at startup, returns LibSqlAdapter.
 * Cloud HTTP/SSE: resolves the project from the bearer token, returns a pooled LibSqlAdapter.
 */
export interface McpAdapter {
  /**
   * Resolve the DbAdapter for a given request context.
   * For self-hosted, the context is ignored and the singleton adapter is returned.
   * For Cloud, the context contains the bearer token or project id.
   */
  resolveDb(context?: { token?: string }): Promise<DbAdapter>;

  /**
   * Optional: report whether an API key (JWT `sub` = api_keys.id) has been
   * revoked. Cloud implements this against its in-memory revocation blocklist so
   * the MCP transport can proactively close sessions whose key was revoked or
   * rotated, rather than waiting for the next tool call to reject. Self-hosted
   * (single static MCP_TOKEN, no revocation) leaves this undefined.
   *
   * Must be a cheap, synchronous, in-memory check — it runs in the session
   * sweep across all live sessions.
   */
  isRevoked?(sub: string): boolean;
}

/**
 * Self-hosted MCP adapter — always returns the single local DbAdapter.
 * The adapter is injected at construction time from the main entrypoint.
 */
export class LocalDbMcpAdapter implements McpAdapter {
  constructor(private readonly adapter: DbAdapter) {}

  async resolveDb(_context?: { token?: string }): Promise<DbAdapter> {
    return this.adapter;
  }
}
