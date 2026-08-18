import { EventEmitter } from "events";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { KamoriAdapters, DbAdapter, ServerPlugins } from "@usekamori/core";

declare module "fastify" {
  interface FastifyContextConfig {
    skipAuth?: boolean;
  }
  interface FastifyRequest {
    /** Set by the auth preHandler when verifyIngestToken returns a project ID (multi-tenant). */
    projectId?: string;
    /** Set by verifyToken plugin hook alongside projectId (cloud multi-tenant). */
    userId?: string;
  }
}

export type IngestBody = Record<string, unknown> | Record<string, unknown>[];

/** Shared per-registration context passed to each route module. */
export interface V1Context {
  adapters: KamoriAdapters;
  plugins?: ServerPlugins;
  resolveDb: (projectId?: string) => Promise<DbAdapter>;
}

/**
 * Escapes a single CSV field value per RFC 4180, with formula-injection defence.
 *
 * Spreadsheet formula injection: cells starting with =, +, -, @, or TAB are
 * interpreted as formulas by Excel and Google Sheets. Prefixing with a single
 * quote disables this — the quote is treated as a text-prefix indicator and is
 * not displayed in the cell.
 */
export function escapeCsvField(value: string): string {
  // Neutralise formula-trigger prefixes before any other processing
  const safe = /^[=+\-@\t]/.test(value) ? `'${value}` : value;
  if (/[",\n\r]/.test(safe)) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

/**
 * Parses a query-string integer safely.
 * Returns `fallback` for NaN, Infinity, negative values, and anything outside
 * Number.MAX_SAFE_INTEGER — preventing silent overflow or negative cursors.
 */
export function parseSafeInt(value: string, fallback: number): number {
  const n = parseInt(value, 10);
  if (!Number.isSafeInteger(n) || n < 0) return fallback;
  return n;
}

// ---------------------------------------------------------------------------
// Ingest concurrency cap
//
// better-sqlite3 executes all SQL synchronously on the Node.js main thread.
// Each insertLogs call blocks the event loop for the full duration of the
// write (~5-20 ms for a 25-row batch). Without a cap, a burst of concurrent
// ingest requests serialises behind each other's blocking window. At 200
// concurrent writers the event loop can be blocked for 4+ seconds, causing
// read requests to queue up and hit their 60 s timeout before getting any
// event-loop time.
//
// The cap limits how many ingest writes may be in-flight simultaneously. Once
// the cap is reached, new ingest requests return 503 immediately — a fast,
// retryable signal — rather than silently waiting and eventually timing out.
// With cap=20 the worst-case read wait is ~20 × 20 ms = 400 ms, giving read
// traffic consistent interleaving even under heavy write load.
//
// This counter is irrelevant on the Cloud path where LibSQL writes are async
// HTTP requests that do not block the event loop.
// ---------------------------------------------------------------------------
let _inFlightWrites = 0;

/** Synchronous check-and-claim of a write slot. Returns false when the cap is hit. */
export function tryAcquireWriteSlot(limit: number): boolean {
  if (limit > 0 && _inFlightWrites >= limit) return false;
  _inFlightWrites++;
  return true;
}

export function releaseWriteSlot(): void {
  _inFlightWrites--;
}

/**
 * Reset the in-flight write counter. Called by the v1Plugin `onClose` hook so
 * the counter is always zero for a restarted server instance reusing the same
 * module cache. Also exported for test suites that need explicit control.
 * @internal
 */
export function _resetInFlightWrites(): void {
  _inFlightWrites = 0;
}

/** Returns the current in-flight write count. For test assertions only. @internal */
export function _getInFlightWrites(): number {
  return _inFlightWrites;
}

/**
 * Directly set the in-flight write counter. For testing the 503 limit without
 * issuing real concurrent requests. Never call in production code.
 * @internal
 */
export function _setInFlightWritesForTest(n: number): void {
  _inFlightWrites = n;
}

// ---------------------------------------------------------------------------
// Stream connection cap
// ---------------------------------------------------------------------------
export const STREAM_CONNECTION_LIMIT = 50;
let _streamConnections = 0;

/**
 * Synchronous check-and-claim of a stream slot — before any await, closing the
 * TOCTOU window where two concurrent requests both pass the >= limit check.
 */
export function tryAcquireStreamSlot(): boolean {
  if (_streamConnections >= STREAM_CONNECTION_LIMIT) return false;
  _streamConnections++;
  return true;
}

export function releaseStreamSlot(): void {
  _streamConnections = Math.max(0, _streamConnections - 1);
}

/**
 * Reset the stream connection counter.
 *
 * `_streamConnections` is module-scope and persists for the lifetime of the
 * cached module instance. In production this is fine — one process, one server.
 * In tests or hot-reload scenarios where a fresh Fastify instance is created
 * without a full module cache reset (vi.resetModules()), an unclean shutdown
 * (test timeout, abrupt server.close() before all reply.raw "close" events
 * fire) can leave the counter above zero, causing spurious 503s in the next
 * server instance.
 *
 * The v1Plugin's onClose hook calls this automatically. It is also exported
 * for test suites that need explicit control without a full module reload.
 *
 * @internal
 */
export function _resetStreamConnections(): void {
  _streamConnections = 0;
}

/** Returns the current stream connection count. For test assertions only. @internal */
export function _getStreamConnectionCount(): number {
  return _streamConnections;
}

/**
 * Directly set the stream connection counter. For testing the 503 limit
 * without opening 50 real connections. Never call in production code.
 * @internal
 */
export function _setStreamConnectionsForTest(n: number): void {
  _streamConnections = n;
}

// ---------------------------------------------------------------------------
// In-process log notification bus (OSS / single-process deployments)
//
// When a new log is ingested, the ingest handler emits "logs:<projectId>" (or
// "logs:_" for single-tenant OSS with no project ID). Each active stream
// connection listens for its own channel and polls the DB immediately when
// notified — eliminating empty polls on quiet streams.
//
// A 5-second heartbeat SetInterval per connection guards against missed events
// and keeps the TCP connection alive. In cloud multi-instance deployments the
// ServerPlugins.notifyNewLogs / subscribeToLogs hooks replace the EventEmitter
// with Postgres LISTEN/NOTIFY so notifications cross process boundaries.
// ---------------------------------------------------------------------------
export const STREAM_HEARTBEAT_MS = 5_000;
/** Exported for test access — do not emit in production code. */
export const _logsEmitter = new EventEmitter();
_logsEmitter.setMaxListeners(0); // one listener per active stream connection

/**
 * Per-request DB resolver (MKR-198).
 * Falls back to adapters.db for single-tenant / self-hosted deployments.
 */
export function makeResolveDb(
  adapters: KamoriAdapters,
  plugins?: ServerPlugins,
): V1Context["resolveDb"] {
  return async (projectId?: string): Promise<DbAdapter> => {
    if (plugins?.getDbAdapter) {
      // Cloud mode: every authenticated request must carry a projectId from
      // the JWT. A missing projectId means the request bypassed or failed
      // project-level auth — reject immediately rather than fall back to the
      // global DB, which would be a cross-tenant data leak.
      if (!projectId) {
        throw Object.assign(new Error("missing project context"), {
          statusCode: 403,
        });
      }
      const db = await plugins.getDbAdapter(projectId);
      if (db) return db;
      // Project ID was present but the DB adapter could not be resolved
      // (project deleted, wrong region, etc.) — 404 is more accurate than 500.
      throw Object.assign(new Error("project not found"), {
        statusCode: 404,
      });
    }
    return adapters.db;
  };
}

/**
 * Registers the auth preHandler — skips routes marked { config: { skipAuth: true } }.
 */
export function registerAuthHook(
  fastify: FastifyInstance,
  adapters: KamoriAdapters,
  plugins?: ServerPlugins,
): void {
  fastify.addHook("preHandler", async (request: FastifyRequest, reply) => {
    if (request.routeOptions.config?.skipAuth) return;

    const authHeader = request.headers["authorization"];
    const raw = Array.isArray(authHeader) ? authHeader[0] : (authHeader ?? "");
    const token = raw.startsWith("Bearer ") ? raw.slice(7) : raw;

    // 1. Cloud plugin hook: handles per-project API keys (MKR-181/MKR-198).
    //    verifyToken is authoritative in cloud mode — null means the token is
    //    missing, invalid, expired, revoked, or wrong scope. Reject immediately;
    //    never fall through to the built-in INGEST_TOKEN path.
    if (plugins?.verifyToken) {
      const origin = request.headers["origin"] as string | undefined;
      const pluginResult = await plugins.verifyToken(token, { origin });
      if (pluginResult === null) {
        return reply.code(401).send({ ok: false, error: "unauthorized" });
      }
      request.userId = pluginResult.userId;
      request.projectId = pluginResult.projectId;
      if (plugins.checkIngestAccess) {
        const allowed = await plugins.checkIngestAccess(
          pluginResult.projectId,
        );
        if (!allowed) {
          return reply
            .code(403)
            .send({ ok: false, error: "ingest disabled" });
        }
      }
      return;
    }

    // 2. Built-in single-tenant auth (INGEST_TOKEN env var).
    const result = adapters.auth.verifyIngestToken(token);
    if (result === null) return; // auth disabled
    if (result === false) {
      return reply.code(401).send({ ok: false, error: "unauthorized" });
    }
    if (typeof result === "string") {
      request.projectId = result;
    }
  });
}
