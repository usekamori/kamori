import { PassThrough } from "stream";
import { EventEmitter } from "events";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

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
import type {
  KamoriAdapters,
  LogRow,
  DbAdapter,
  ServerPlugins,
} from "@usekamori/core";
import {
  MAX_ROWS,
  MAX_ROW_BYTES,
  MCP_PORT,
  INGEST_CONCURRENCY_LIMIT,
  WEBHOOK_SECRET_VERCEL,
  WEBHOOK_SECRET_GITHUB,
  WEBHOOK_SECRET_RENDER,
} from "@usekamori/core";
import {
  insertLogs,
  queryLogs,
  searchLogs,
  listServices,
  summarizeErrors,
  deleteLogs,
  countLogs,
  isValidIso,
} from "@usekamori/core";
import { verifyWebhookSignature } from "../lib/webhook.js";

type IngestBody = Record<string, unknown> | Record<string, unknown>[];

/**
 * Escapes a single CSV field value per RFC 4180, with formula-injection defence.
 *
 * Spreadsheet formula injection: cells starting with =, +, -, @, or TAB are
 * interpreted as formulas by Excel and Google Sheets. Prefixing with a single
 * quote disables this — the quote is treated as a text-prefix indicator and is
 * not displayed in the cell.
 *
 * @param value - The field value to escape.
 * @returns A CSV-safe string (quoted only when necessary).
 */
function escapeCsvField(value: string): string {
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
function parseSafeInt(value: string, fallback: number): number {
  const n = parseInt(value, 10);
  if (!Number.isSafeInteger(n) || n < 0) return fallback;
  return n;
}

/**
 * v1 route plugin factory. Accepts KamoriAdapters and returns a Fastify plugin.
 * Register with prefix "/v1" in server.ts / build-server.ts.
 * All paths here are relative — no version string hardcoded.
 */
const STREAM_CONNECTION_LIMIT = 50;
let _streamConnections = 0;

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
const STREAM_HEARTBEAT_MS = 5_000;
/** Exported for test access — do not emit in production code. */
export const _logsEmitter = new EventEmitter();
_logsEmitter.setMaxListeners(0); // one listener per active stream connection

export default function v1Routes(
  adapters: KamoriAdapters,
  plugins?: ServerPlugins,
) {
  return async function v1Plugin(fastify: FastifyInstance) {
    // Reset the stream connection counter when this server instance closes.
    // Guards against the counter staying elevated across server restarts that
    // reuse the same module instance (no vi.resetModules / hot-reload).
    fastify.addHook("onClose", () => {
      _resetStreamConnections();
      _resetInFlightWrites();
    });

    // ---------------------------------------------------------------------------
    // Per-request DB resolver (MKR-198)
    // Falls back to adapters.db for single-tenant / self-hosted deployments.
    // ---------------------------------------------------------------------------
    const resolveDb = async (projectId?: string): Promise<DbAdapter> => {
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

    // Auth hook — skips routes marked { config: { skipAuth: true } }
    fastify.addHook("preHandler", async (request, reply) => {
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

    fastify.get(
      "/health",
      { config: { skipAuth: true, rateLimit: false } },
      async (_, reply) => {
        // DB check — a failed SELECT 1 means the database is not usable
        let dbOk = false;
        try {
          await adapters.db.get("SELECT 1");
          dbOk = true;
        } catch {}

        // MCP check — only attempted in HTTP mode (MCP_PORT is set).
        // MCP being unreachable does not flip ok to false; ingest still works.
        let mcpOk: boolean | null = null;
        if (MCP_PORT) {
          try {
            const res = await fetch(`http://localhost:${MCP_PORT}/health`, {
              signal: AbortSignal.timeout(2000),
            });
            mcpOk = res.ok;
          } catch {
            mcpOk = false;
          }
        }

        const ok = dbOk;
        const status = ok ? 200 : 503;
        return reply.code(status).send({
          ok,
          checks: {
            db: dbOk,
            ...(mcpOk !== null && { mcp: mcpOk }),
          },
        });
      },
    );

    fastify.post<{ Body: IngestBody }>(
      "/ingest",
      {
        schema: {
          body: {
            anyOf: [
              { type: "object", additionalProperties: true },
              {
                type: "array",
                items: { type: "object", additionalProperties: true },
              },
            ],
          },
          response: {
            200: {
              type: "object",
              properties: {
                ok: { type: "boolean" },
                written: { type: "integer" },
                deduplicated: { type: "integer" },
                oversized: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      index: { type: "integer" },
                      bytes: { type: "integer" },
                    },
                    required: ["index", "bytes"],
                  },
                },
              },
              required: ["ok", "written"],
            },
            400: {
              type: "object",
              properties: {
                ok: { type: "boolean" },
                error: { type: "string" },
              },
              required: ["ok", "error"],
            },
            401: {
              type: "object",
              properties: {
                ok: { type: "boolean" },
                error: { type: "string" },
              },
              required: ["ok", "error"],
            },
            402: {
              type: "object",
              properties: {
                ok: { type: "boolean" },
                error: { type: "string" },
              },
              required: ["ok", "error"],
            },
            413: {
              type: "object",
              properties: {
                ok: { type: "boolean" },
                error: { type: "string" },
                bytes: { type: "integer" },
                limit: { type: "integer" },
                oversized: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      index: { type: "integer" },
                      bytes: { type: "integer" },
                    },
                    required: ["index", "bytes"],
                  },
                },
              },
              required: ["ok", "error"],
            },
            500: {
              type: "object",
              properties: {
                ok: { type: "boolean" },
                error: { type: "string" },
              },
              required: ["ok", "error"],
            },
            503: {
              type: "object",
              properties: {
                ok: { type: "boolean" },
                error: { type: "string" },
              },
              required: ["ok", "error"],
            },
          },
        },
      },
      async (
        request: FastifyRequest<{ Body: IngestBody }>,
        reply: FastifyReply,
      ) => {
        const now = new Date().toISOString();
        const rows = Array.isArray(request.body)
          ? request.body
          : [request.body];

        if (rows.length === 0) {
          return reply.code(400).send({ ok: false, error: "empty body" });
        }
        if (rows.length > MAX_ROWS) {
          return reply
            .code(413)
            .send({ ok: false, error: "too many log rows" });
        }

        // Billing check (MKR-178) — NoBillingAdapter is a no-op (always true)
        const allowed = await adapters.billing.checkIngestAccess(
          request.projectId ?? "",
        );
        if (!allowed) {
          return reply
            .code(402)
            .send({ ok: false, error: "monthly ingest limit exceeded" });
        }

        // Resolve per-row byte limit: cloud uses plan-based hook, OSS uses env var.
        let maxRowBytes = MAX_ROW_BYTES;
        if (plugins?.getMaxRowBytes && request.projectId) {
          maxRowBytes = await plugins.getMaxRowBytes(request.projectId);
        }

        // Single-object fast path: reject immediately if oversized.
        if (maxRowBytes > 0 && !Array.isArray(request.body)) {
          const byteLen = Buffer.byteLength(
            JSON.stringify({ ...request.body, received_at: now }),
            "utf8",
          );
          if (byteLen > maxRowBytes) {
            return reply.code(413).send({
              ok: false,
              error: "row too large",
              bytes: byteLen,
              limit: maxRowBytes,
            });
          }
        }

        // Concurrency cap — OSS SQLite path only. Rejects excess writes with a
        // fast 503 so clients get an immediate retryable signal instead of
        // queuing behind blocking DB operations and timing out.
        // 0 = disabled (no cap). Cloud path: counter stays near zero because
        // LibSQL writes are async and return quickly.
        if (
          INGEST_CONCURRENCY_LIMIT > 0 &&
          _inFlightWrites >= INGEST_CONCURRENCY_LIMIT
        ) {
          return reply
            .code(503)
            .send({ ok: false, error: "server busy, retry" });
        }
        _inFlightWrites++;

        const db = await resolveDb(request.projectId);
        let written: number;
        let deduplicated: number;
        let oversized: Array<{ index: number; bytes: number }>;
        try {
          ({ written, deduplicated, oversized } = await insertLogs(db, rows, now, maxRowBytes));
        } catch (err) {
          fastify.log.error(err, "db insert failed");
          return reply.code(503).send({ ok: false, error: "db insert failed" });
        } finally {
          _inFlightWrites--;
        }

        // All rows in a batch were oversized.
        if (oversized.length > 0 && written === 0 && deduplicated === 0) {
          return reply.code(413).send({
            ok: false,
            error: "all rows exceeded size limit",
            oversized,
          });
        }

        // Report usage for metered billing (fire-and-forget, MKR-204).
        // Bytes = raw JSON size of the request body; lines = rows written after dedup.
        // Failures are logged but never block the ingest response.
        const ingestBytes = Buffer.byteLength(JSON.stringify(rows));
        adapters.billing
          .reportUsage(request.projectId ?? "", ingestBytes, written)
          .catch((err: unknown) =>
            fastify.log.warn(err, "billing: reportUsage failed"),
          );

        // Wake up active stream connections for this project (fire-and-forget).
        // Cloud: delegates cross-instance notification to Postgres NOTIFY via the
        // ServerPlugins hook. OSS: emits in-process so all local pollers fire now.
        if (written > 0) {
          if (plugins?.notifyNewLogs) {
            plugins
              .notifyNewLogs(request.projectId ?? "")
              .catch((err: unknown) =>
                fastify.log.warn(err, "stream: notifyNewLogs failed"),
              );
          } else {
            _logsEmitter.emit("logs:" + (request.projectId ?? "_"));
          }
        }

        return reply.send({
          ok: true,
          written,
          ...(deduplicated > 0 && { deduplicated }),
          ...(oversized.length > 0 && { oversized }),
        });
      },
    );

    // ---------------------------------------------------------------------------
    // GET /v1/logs — query log rows with optional filters
    // ---------------------------------------------------------------------------

    /**
     * Returns log rows filtered by service, level, time range, trace_id, and/or
     * cursor. Results are newest-first by default; when `after_id` is set they
     * are oldest-first (live-tail mode).
     *
     * Query params:
     *   service   — filter by service name
     *   level     — filter by log level
     *   since     — ISO-8601 lower bound for received_at
     *   until     — ISO-8601 upper bound for received_at
     *   trace_id  — filter by trace / correlation id
     *   after_id  — cursor: return only rows with id > after_id (oldest-first)
     *   limit     — max rows (default 100, max 500)
     */
    fastify.get<{
      Querystring: {
        service?: string;
        level?: string;
        since?: string;
        until?: string;
        trace_id?: string;
        after_id?: string;
        limit?: string;
      };
    }>("/logs", async (request, reply) => {
      const { service, level, since, until, trace_id } = request.query;
      if (since && !isValidIso(since)) return reply.code(400).send({ error: "invalid since: must be ISO-8601" });
      if (until && !isValidIso(until)) return reply.code(400).send({ error: "invalid until: must be ISO-8601" });
      const after_id =
        request.query.after_id !== undefined
          ? parseSafeInt(request.query.after_id, 0)
          : undefined;
      const limit =
        request.query.limit !== undefined
          ? Math.min(parseSafeInt(request.query.limit, 100), 500)
          : undefined;

      const db = await resolveDb(request.projectId);
      const rows = await queryLogs(db, {
        service,
        level,
        since,
        until,
        trace_id,
        after_id,
        limit,
      });
      return reply.send({ logs: rows, count: rows.length });
    });

    // ---------------------------------------------------------------------------
    // GET /v1/search — full-text search across log bodies
    // ---------------------------------------------------------------------------

    /**
     * Full-text search using SQLite FTS5. Supports quoted phrases and boolean
     * operators (AND, OR, NOT).
     *
     * Query params:
     *   q         — FTS5 search query (required)
     *   service   — narrow to a specific service
     *   since     — ISO-8601 lower bound
     *   until     — ISO-8601 upper bound
     *   after_id  — cursor for live-tail mode
     *   limit     — max rows (default 100, max 500)
     */
    fastify.get<{
      Querystring: {
        q?: string;
        service?: string;
        since?: string;
        until?: string;
        after_id?: string;
        limit?: string;
      };
    }>("/search", async (request, reply) => {
      const { q, service, since, until } = request.query;

      if (since && !isValidIso(since)) return reply.code(400).send({ error: "invalid since: must be ISO-8601" });
      if (until && !isValidIso(until)) return reply.code(400).send({ error: "invalid until: must be ISO-8601" });

      if (!q) {
        return reply
          .code(400)
          .send({ ok: false, error: "'q' query parameter is required" });
      }
      // Cap query length to prevent pathologically complex FTS5 expressions from
      // saturating the SQLite query engine.
      if (q.length > 1_000) {
        return reply
          .code(400)
          .send({
            ok: false,
            error: "search query too long (max 1000 characters)",
          });
      }

      const after_id =
        request.query.after_id !== undefined
          ? parseSafeInt(request.query.after_id, 0)
          : undefined;
      const limit =
        request.query.limit !== undefined
          ? Math.min(parseSafeInt(request.query.limit, 100), 500)
          : undefined;

      const db = await resolveDb(request.projectId);
      const rows = await searchLogs(db, q, {
        service,
        since,
        until,
        after_id,
        limit,
      });
      return reply.send({ logs: rows, count: rows.length });
    });

    // ---------------------------------------------------------------------------
    // GET /v1/services — list all distinct service names
    // ---------------------------------------------------------------------------

    /**
     * Returns a sorted list of all distinct service names seen across all logs.
     * Useful for populating filter dropdowns in a UI or MCP tool.
     */
    fastify.get("/services", async (request, reply) => {
      const db = await resolveDb(request.projectId);
      const services = await listServices(db);
      return reply.send({ services });
    });

    // ---------------------------------------------------------------------------
    // GET /v1/summary — log-count summary grouped by service + level
    // ---------------------------------------------------------------------------

    /**
     * Returns log counts grouped by service and level.
     * Accepts optional `since` and `until` ISO-8601 query parameters to restrict the time window.
     */
    fastify.get<{ Querystring: { since?: string; until?: string } }>(
      "/summary",
      async (request, reply) => {
        const { since, until } = request.query;
        if (since && !isValidIso(since)) return reply.code(400).send({ error: "invalid since: must be ISO-8601" });
        if (until && !isValidIso(until)) return reply.code(400).send({ error: "invalid until: must be ISO-8601" });
        const db = await resolveDb(request.projectId);
        const rows = await summarizeErrors(db, since, until);
        return reply.send(rows);
      },
    );

    // ---------------------------------------------------------------------------
    // GET /v1/export — bulk export in NDJSON or CSV format
    // ---------------------------------------------------------------------------

    /**
     * Exports log rows in NDJSON (`application/x-ndjson`) or CSV (`text/csv`) format.
     *
     * Query params:
     *   format   — "ndjson" (default) | "csv"
     *   service  — filter by service name
     *   level    — filter by log level
     *   since    — ISO-8601 lower bound for received_at
     *   until    — ISO-8601 upper bound for received_at
     *   limit    — max rows to return (default 1000, max 10000)
     */
    fastify.get<{
      Querystring: {
        format?: string;
        service?: string;
        level?: string;
        since?: string;
        until?: string;
        limit?: string;
      };
    }>("/export", async (request, reply) => {
      const {
        format = "ndjson",
        service,
        level,
        since,
        until,
        limit: limitStr,
      } = request.query;
      if (since && !isValidIso(since)) return reply.code(400).send({ error: "invalid since: must be ISO-8601" });
      if (until && !isValidIso(until)) return reply.code(400).send({ error: "invalid until: must be ISO-8601" });
      const limit = Math.min(parseInt(limitStr ?? "1000", 10) || 1000, 10_000);

      const db = await resolveDb(request.projectId);

      const isCsv = format === "csv";

      // True streaming via PassThrough: send headers and start piping immediately,
      // then write each 500-row batch as it arrives from the DB. Only one batch
      // lives in the Node.js heap at a time; each await queryLogs() yields the
      // event loop so the socket can drain before the next batch is fetched.
      const pt = new PassThrough();

      reply
        .code(200)
        .header("Content-Type", isCsv ? "text/csv" : "application/x-ndjson")
        .header("Cache-Control", "no-cache")
        .send(pt);

      try {
        if (isCsv) pt.write("id,received_at,service,level,body\n");

        let after_id = 0;
        let remaining = limit;

        while (remaining > 0) {
          const batchSize = Math.min(500, remaining);
          const rows = await queryLogs(db, {
            service,
            level,
            since,
            until,
            after_id,
            limit: batchSize,
          });
          if (rows.length === 0) break;

          for (const r of rows) {
            if (isCsv) {
              pt.write(
                `${r.id},${escapeCsvField(r.received_at)},${escapeCsvField(r.service ?? "")},${escapeCsvField(r.level ?? "")},${escapeCsvField(r.body)}\n`,
              );
            } else {
              pt.write(JSON.stringify(r) + "\n");
            }
          }

          after_id = rows[rows.length - 1].id;
          remaining -= rows.length;
          if (rows.length < batchSize) break;
        }

        pt.end();
      } catch (err) {
        pt.destroy(err instanceof Error ? err : new Error(String(err)));
      }

      return reply;
    });

    // ---------------------------------------------------------------------------
    // DELETE /v1/logs — delete log rows matching given conditions
    // ---------------------------------------------------------------------------

    /**
     * Deletes log rows matching `before` (ISO date) and/or `service`.
     * Requires at least one parameter to prevent accidental full-table wipes.
     *
     * Ownership model:
     * - OSS / self-hosted: single-tenant by design. One INGEST_TOKEN = one
     *   instance = one database. Any holder of the token has full write access;
     *   no per-resource ownership check is needed or meaningful.
     * - Cloud / multi-tenant: `resolveDb(request.projectId)` returns the
     *   tenant-scoped DbAdapter derived from the JWT's `pid` claim. A valid
     *   token for project A is physically incapable of reaching project B's
     *   database — tenant isolation is structural, not a row-level guard.
     *
     * Additional safeguards: auth-gated (preHandler), rate-limited (10/min),
     * and requires at least one condition (no blind full-table wipes).
     *
     * Query params:
     *   before   — delete rows where received_at < this ISO string
     *   service  — delete rows for a specific service name
     *
     * Returns: { ok: true, deleted: <number> }
     */
    fastify.delete<{
      Querystring: { before?: string; service?: string };
    }>(
      "/logs",
      { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
      async (request, reply) => {
        const { before, service } = request.query;

        // Require at least one condition — refuse a blind full-table delete
        if (!before && !service) {
          return reply.code(400).send({
            ok: false,
            error: "at least one of 'before' or 'service' is required",
          });
        }

        const db = await resolveDb(request.projectId);
        const deleted = await deleteLogs(db, { before, service });
        return reply.send({ ok: true, deleted });
      },
    );

    // ---------------------------------------------------------------------------
    // GET /v1/logs/alert — count logs in a time window for alert evaluation
    // ---------------------------------------------------------------------------

    /**
     * Returns the count of log entries matching the given filters within the
     * specified time window. Used by the Alerts page to evaluate threshold rules.
     *
     * Query params:
     *   minutes  — lookback window in minutes (default 60, max 10080 = 7 days)
     *   level    — filter by log level
     *   service  — filter by service name
     *
     * Returns: { count: number }
     */
    fastify.get<{
      Querystring: { minutes?: string; level?: string; service?: string };
    }>("/logs/alert", async (request, reply) => {
      const minutes = Math.min(
        parseSafeInt(request.query.minutes ?? "60", 60),
        10_080,
      );
      const { level, service } = request.query;
      const since = new Date(Date.now() - minutes * 60_000).toISOString();

      const db = await resolveDb(request.projectId);
      const count = await countLogs(db, { level, service, since });
      return reply.send({ count });
    });

    // ---------------------------------------------------------------------------
    // GET /v1/stream — NDJSON HTTP live tail
    // ---------------------------------------------------------------------------

    /**
     * Live-tails log entries as a chunked NDJSON HTTP stream.
     * Runs one poll right away, then polls the database every 500 ms and writes
     * new rows as JSON lines.
     * The response is kept open until the client disconnects.
     *
     * Query params:
     *   service   — filter by service name
     *   level     — filter by log level
     *   after_id  — start cursor; only rows with id > after_id are returned (default 0)
     *
     * Each chunk is a JSON-serialised LogRow followed by \n.
     * Clients consume via fetch() + response.body.getReader(), not EventSource.
     */
    fastify.get<{
      Querystring: { service?: string; level?: string; after_id?: string };
    }>("/stream", async (request, reply) => {
      // Claim a slot synchronously — before any await — to close the TOCTOU
      // window where two concurrent requests both pass the >= limit check and
      // both increment past it.
      if (_streamConnections >= STREAM_CONNECTION_LIMIT) {
        return reply
          .code(503)
          .send({ ok: false, error: "too many active stream connections" });
      }
      _streamConnections++;

      const { service, level } = request.query;
      let current_id = parseSafeInt(request.query.after_id ?? "0", 0);

      const db = await resolveDb(request.projectId);

      const stream = new PassThrough();
      reply
        .code(200)
        .header("Content-Type", "application/x-ndjson")
        .header("Cache-Control", "no-cache")
        .header("Connection", "keep-alive")
        .header("X-Accel-Buffering", "no") // disable Nginx proxy buffering
        .send(stream);

      // Poll function — queries for rows newer than current cursor.
      const poll = async () => {
        const rows = await queryLogs(db, {
          after_id: current_id,
          service,
          level,
          limit: 50,
        });
        for (const row of rows) {
          stream.write(JSON.stringify(row) + "\n");
          current_id = row.id;
        }
      };

      // 5-second heartbeat: fires regardless of ingest activity.
      // Keeps the TCP connection alive and recovers from any missed notifications.
      const heartbeat = setInterval(() => {
        poll().catch(() => {
          /* retried on next heartbeat tick */
        });
      }, STREAM_HEARTBEAT_MS);
      heartbeat.unref();

      // Event-driven wake-up: poll immediately when new logs arrive for this project.
      // OSS: fires via the in-process _logsEmitter; Cloud: fires via Postgres NOTIFY.
      const channel = "logs:" + (request.projectId ?? "_");
      let unsubscribe: () => Promise<void>;
      if (plugins?.subscribeToLogs) {
        unsubscribe = await plugins.subscribeToLogs(
          request.projectId ?? "",
          () => poll().catch(() => {}),
        );
      } else {
        const onLogs = () => poll().catch(() => {});
        _logsEmitter.on(channel, onLogs);
        unsubscribe = async () => {
          _logsEmitter.off(channel, onLogs);
        };
      }

      // Run one immediate poll so clients see existing data right away.
      void poll().catch(() => {});

      // Listen on the ServerResponse's "close" event, which fires when the
      // client disconnects before the response finishes. Do NOT use
      // request.raw.on("close") — for GET requests with no body Node.js
      // destroys the IncomingMessage readable immediately after parsing
      // headers, causing "close" to fire before any data is streamed.
      const cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe().catch(() => {});
        _streamConnections = Math.max(0, _streamConnections - 1);
        if (!stream.destroyed) stream.end();
      };
      reply.raw.on("close", cleanup);

      // Async handlers must return `reply` after reply.send(stream) or Fastify
      // can close the response when the handler promise settles (no NDJSON).
      return reply;
    });

    // ---------------------------------------------------------------------------
    // POST /v1/webhook/:provider — ingest webhook payloads from external services
    // ---------------------------------------------------------------------------

    /**
     * Accepts webhook POST requests from Vercel, GitHub, Render, or any generic
     * provider.  Each known provider's signature is verified before ingestion;
     * unknown providers with no configured secret are passed through unchanged.
     *
     * Supported providers and their signature schemes:
     *   vercel  — HMAC-SHA1,   header: x-vercel-signature
     *   github  — HMAC-SHA256, header: x-hub-signature-256 (format: sha256=<hex>)
     *   render  — HMAC-SHA256, header: render-signature    (format: t=<ts>,v1=<hex>)
     *   <other> — no signature check
     *
     * Registered in a scoped sub-plugin so that application/json is parsed as a
     * raw Buffer here — giving us the exact bytes the provider signed, which is
     * required for correct HMAC verification.
     */
    await fastify.register(async (scope) => {
      // Parse JSON as raw Buffer so signature verification works on the exact bytes
      scope.addContentTypeParser(
        "application/json",
        { parseAs: "buffer" },
        (_req, body, done) => done(null, body),
      );

      scope.post<{ Params: { provider: string } }>(
        "/webhook/:provider",
        {
          config: {
            skipAuth: true,
            rateLimit: { max: 30, timeWindow: "1 minute" },
          },
          bodyLimit: 1_000_000,
        },
        async (request, reply) => {
          const { provider } = request.params;

          const KNOWN_PROVIDERS = new Set(["vercel", "github", "render"]);
          if (!KNOWN_PROVIDERS.has(provider)) {
            return reply
              .code(400)
              .send({ ok: false, error: `unknown webhook provider: ${provider}` });
          }

          const rawBody = request.body as Buffer;

          const secrets = {
            WEBHOOK_SECRET_VERCEL,
            WEBHOOK_SECRET_GITHUB,
            WEBHOOK_SECRET_RENDER,
          };

          const valid = verifyWebhookSignature(
            provider,
            rawBody,
            request.headers as Record<string, string | string[] | undefined>,
            secrets,
          );

          if (!valid) {
            return reply
              .code(401)
              .send({ ok: false, error: "invalid signature" });
          }

          // Parse the JSON body from the raw buffer
          let body: unknown;
          try {
            body = rawBody.length ? JSON.parse(rawBody.toString()) : null;
          } catch {
            return reply
              .code(400)
              .send({ ok: false, error: "invalid JSON body" });
          }

          // Normalise payload to an array of log events
          const rows: Record<string, unknown>[] = Array.isArray(body)
            ? body
            : [
                {
                  ...((typeof body === "object" && body !== null
                    ? body
                    : { payload: body }) as Record<string, unknown>),
                  _provider: provider,
                },
              ];

          if (rows.length === 0) {
            return reply.code(400).send({ ok: false, error: "empty body" });
          }

          const now = new Date().toISOString();
          let written: number;
          try {
            const db = await resolveDb(request.projectId);
            ({ written } = await insertLogs(db, rows, now));
          } catch (err) {
            fastify.log.error(err, "webhook db insert failed");
            return reply
              .code(500)
              .send({ ok: false, error: "db insert failed" });
          }

          return reply.send({ ok: true, written, provider });
        },
      );
    });
  };
}
