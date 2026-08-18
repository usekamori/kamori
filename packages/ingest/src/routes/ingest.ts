import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import {
  MAX_ROWS,
  MAX_ROW_BYTES,
  MCP_PORT,
  INGEST_CONCURRENCY_LIMIT,
  WEBHOOK_SECRET_VERCEL,
  WEBHOOK_SECRET_GITHUB,
  WEBHOOK_SECRET_RENDER,
} from "@usekamori/core";
import { insertLogs } from "@usekamori/core";
import { verifyWebhookSignature } from "../lib/webhook.js";
import {
  type IngestBody,
  type V1Context,
  tryAcquireWriteSlot,
  releaseWriteSlot,
  _logsEmitter,
} from "./shared.js";

/** /health, POST /ingest, POST /webhook/:provider */
export async function registerIngestRoutes(
  fastify: FastifyInstance,
  { adapters, plugins, resolveDb }: V1Context,
): Promise<void> {
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
      if (!tryAcquireWriteSlot(INGEST_CONCURRENCY_LIMIT)) {
        return reply
          .code(503)
          .send({ ok: false, error: "server busy, retry" });
      }

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
        releaseWriteSlot();
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
   *   render  — HMAC-SHA256 over `<t>.<body>`, header: render-signature (format: t=<ts>,v1=<hex>)
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
}
