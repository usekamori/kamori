import type { FastifyInstance } from "fastify";
import {
  queryLogs,
  searchLogs,
  listServices,
  summarizeErrors,
  countLogs,
  histogramLogs,
  isValidIso,
  type HistogramBucket,
} from "@usekamori/core";
import { type V1Context, parseSafeInt } from "./shared.js";

const HISTOGRAM_BUCKETS: HistogramBucket[] = ["1m", "5m", "15m", "1h", "6h", "1d"];

/** GET /logs, /search, /services, /summary, /logs/alert */
export function registerQueryRoutes(
  fastify: FastifyInstance,
  { resolveDb }: V1Context,
): void {
  // ---------------------------------------------------------------------------
  // GET /v1/logs — query log rows with optional filters
  // ---------------------------------------------------------------------------

  /**
   * Returns log rows filtered by service, level, time range, trace_id, and/or
   * cursor. Results are newest-first by default; when `after_id` is set they
   * are oldest-first (live-tail mode).
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
   * operators (AND, OR, NOT). `level` is an exact match on the indexed column.
   */
  fastify.get<{
    Querystring: {
      q?: string;
      service?: string;
      level?: string;
      since?: string;
      until?: string;
      after_id?: string;
      limit?: string;
    };
  }>("/search", async (request, reply) => {
    const { q, service, level, since, until } = request.query;

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
      level,
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

  fastify.get("/services", async (request, reply) => {
    const db = await resolveDb(request.projectId);
    const services = await listServices(db);
    return reply.send({ services });
  });

  // ---------------------------------------------------------------------------
  // GET /v1/summary — log-count summary grouped by service + level
  // ---------------------------------------------------------------------------

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
  // GET /v1/count — exact log count with optional filters
  // ---------------------------------------------------------------------------

  fastify.get<{
    Querystring: { service?: string; level?: string; since?: string; until?: string };
  }>("/count", async (request, reply) => {
    const { service, level, since, until } = request.query;
    if (since && !isValidIso(since)) return reply.code(400).send({ error: "invalid since: must be ISO-8601" });
    if (until && !isValidIso(until)) return reply.code(400).send({ error: "invalid until: must be ISO-8601" });
    const db = await resolveDb(request.projectId);
    const count = await countLogs(db, { service, level, since, until });
    return reply.send({ count });
  });

  // ---------------------------------------------------------------------------
  // GET /v1/histogram — time-bucketed log counts
  // ---------------------------------------------------------------------------

  fastify.get<{
    Querystring: {
      bucket?: string;
      service?: string;
      level?: string;
      since?: string;
      until?: string;
    };
  }>("/histogram", async (request, reply) => {
    const { service, level, since, until } = request.query;
    if (since && !isValidIso(since)) return reply.code(400).send({ error: "invalid since: must be ISO-8601" });
    if (until && !isValidIso(until)) return reply.code(400).send({ error: "invalid until: must be ISO-8601" });
    const bucket = (request.query.bucket ?? "1h") as HistogramBucket;
    if (!HISTOGRAM_BUCKETS.includes(bucket)) {
      return reply.code(400).send({
        error: `invalid bucket: must be one of ${HISTOGRAM_BUCKETS.join(", ")}`,
      });
    }
    const db = await resolveDb(request.projectId);
    const rows = await histogramLogs(db, { bucket, service, level, since, until });
    return reply.send({ histogram: rows });
  });

  // ---------------------------------------------------------------------------
  // GET /v1/logs/alert — count logs in a time window for alert evaluation
  // ---------------------------------------------------------------------------

  /**
   * Returns the count of log entries matching the given filters within the
   * specified time window. Used for pull-based threshold alerting.
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
}
