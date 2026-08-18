import { PassThrough } from "stream";
import type { FastifyInstance } from "fastify";
import { queryLogs, resolveCursorForTime } from "@usekamori/core";
import {
  type V1Context,
  parseSafeInt,
  tryAcquireStreamSlot,
  releaseStreamSlot,
  STREAM_HEARTBEAT_MS,
  _logsEmitter,
} from "./shared.js";

/** GET /stream — NDJSON HTTP live tail. */
export function registerStreamRoutes(
  fastify: FastifyInstance,
  { plugins, resolveDb }: V1Context,
): void {
  /**
   * Live-tails log entries as a chunked NDJSON HTTP stream.
   * Runs one poll right away, then polls the database every 500 ms and writes
   * new rows as JSON lines.
   * The response is kept open until the client disconnects.
   *
   * Each chunk is a JSON-serialised LogRow followed by \n.
   * Clients consume via fetch() + response.body.getReader(), not EventSource.
   */
  fastify.get<{
    Querystring: {
      service?: string;
      level?: string;
      after_id?: string;
      since?: string;
    };
  }>("/stream", async (request, reply) => {
    // Claim a slot synchronously — before any await — to close the TOCTOU
    // window where two concurrent requests both pass the >= limit check and
    // both increment past it.
    if (!tryAcquireStreamSlot()) {
      return reply
        .code(503)
        .send({ ok: false, error: "too many active stream connections" });
    }

    const { service, level } = request.query;

    const db = await resolveDb(request.projectId);

    // Starting cursor. Precedence: explicit after_id wins; else resolve `since`
    // once to a starting cursor; else start from the beginning (0). `since`
    // anchors on received_at (server ingest time) and is inclusive.
    let current_id = parseSafeInt(request.query.after_id ?? "0", 0);
    if (request.query.after_id === undefined && request.query.since) {
      current_id = await resolveCursorForTime(db, request.query.since);
    }

    const stream = new PassThrough();
    reply
      .code(200)
      .header("Content-Type", "application/x-ndjson")
      .header("Cache-Control", "no-cache")
      .header("Connection", "keep-alive")
      .header("X-Accel-Buffering", "no") // disable Nginx proxy buffering
      // Echo the resolved starting cursor so clients can observe where the
      // tail began (useful when anchoring by `since`).
      .header("X-Kamori-Start-Id", String(current_id))
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
      releaseStreamSlot();
      if (!stream.destroyed) stream.end();
    };
    reply.raw.on("close", cleanup);

    // Async handlers must return `reply` after reply.send(stream) or Fastify
    // can close the response when the handler promise settles (no NDJSON).
    return reply;
  });
}
