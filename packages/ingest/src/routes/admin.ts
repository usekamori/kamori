import { PassThrough } from "stream";
import type { FastifyInstance } from "fastify";
import { queryLogs, deleteLogs, isValidIso } from "@usekamori/core";
import { type V1Context, escapeCsvField } from "./shared.js";

/** GET /export, DELETE /logs — bulk export and destructive operations. */
export function registerAdminRoutes(
  fastify: FastifyInstance,
  { resolveDb }: V1Context,
): void {
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
}
