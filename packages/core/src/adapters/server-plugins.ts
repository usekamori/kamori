import type { DbAdapter } from "./db-adapter.js";

/**
 * Optional extension hooks injected into buildServer alongside KamoriAdapters.
 *
 * These allow Cloud deployments to override per-request behaviour without
 * modifying the OSS server core. Self-hosted deployments pass undefined and
 * get the default single-tenant behaviour.
 */
export interface ServerPlugins {
  /**
   * Resolve a per-project database adapter given a project ID.
   *
   * Called on every authenticated request when the AuthAdapter returns a
   * project ID (multi-tenant mode). Return null to fall back to the shared
   * KamoriAdapters.db for this request.
   *
   * Implementations should cache adapters by projectId — each call does NOT
   * need to create a new connection (TTL cache lives here).
   */
  getDbAdapter?: (projectId: string) => Promise<DbAdapter | null>;

  /**
   * Verify a raw ingest token and return the associated identity, or null
   * if the token is invalid / not recognised by this plugin.
   *
   * Called by the auth preHandler BEFORE the built-in AuthAdapter check so
   * that Cloud deployments can authenticate per-project API keys (e.g. tokens
   * prefixed with "kamori_") without the OSS server importing anything from the
   * auth package directly.
   *
   * `context.origin` is the value of the HTTP `Origin` request header, if
   * present. Implementations that support per-key origin allowlists should
   * reject requests whose origin is present but not in the key's allowlist.
   * Requests without an Origin header (server-to-server) must always be allowed
   * regardless of the allowlist.
   *
   * Return value:
   *   { userId, projectId } — token is valid; both IDs are stored on the request
   *                           for per-tenant DB routing.
   *   null                  — token not handled by this plugin; fall through to
   *                           the built-in AuthAdapter.
   */
  verifyToken?: (
    rawToken: string,
    context?: { origin?: string },
  ) => Promise<{ userId: string; projectId: string } | null>;

  /**
   * Check whether a project is allowed to ingest more logs (e.g. plan limits,
   * suspension, billing state). Called after verifyToken succeeds.
   *
   * Return true  — request proceeds normally.
   * Return false — server replies 403 with { ok: false, error: "ingest disabled" }.
   *
   * Omitting this hook (self-hosted default) always allows ingest.
   */
  checkIngestAccess?: (projectId: string) => Promise<boolean>;

  /**
   * Run per-project retention purge (cloud multi-tenant).
   *
   * When present, the retention cron calls this instead of the single-tenant
   * purgeLogs path. The implementation is responsible for iterating all projects,
   * determining the per-project cutoff (plan-based), and purging each project's
   * own DB adapter.
   *
   * Omitting this hook uses the default single-tenant purgeLogs path.
   */
  runRetention?: () => Promise<void>;

  /**
   * Return the maximum allowed serialised byte size for a single ingest row,
   * given a project ID. Cloud implementations look up the project's billing plan.
   *
   * Return 0 to disable the per-row size check for this project.
   * Omitting this hook falls back to the MAX_ROW_BYTES env var (default 0).
   */
  getMaxRowBytes?: (projectId: string) => Promise<number>;

  /**
   * Notify that new logs have been written for a project.
   *
   * Called by the ingest route after a successful insertLogs (written > 0).
   * Cloud implementations send a Postgres NOTIFY on the project's channel so
   * that stream connections on other instances wake up immediately.
   * OSS deployments omit this hook — the in-process EventEmitter handles it.
   */
  notifyNewLogs?: (projectId: string) => Promise<void>;

  /**
   * Subscribe to new-log notifications for a project.
   *
   * Called by the stream route when a client connects. The returned function
   * must be called (awaited) on client disconnect to release resources.
   * Cloud implementations issue a Postgres LISTEN on the project's channel.
   * OSS deployments omit this hook — the in-process EventEmitter handles it.
   */
  subscribeToLogs?: (
    projectId: string,
    cb: () => void,
  ) => Promise<() => Promise<void>>;
}
