import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import helmet from "@fastify/helmet";
import cors from "@fastify/cors";
import type { FastifyInstance } from "fastify";
import { createHash, timingSafeEqual } from "node:crypto";
import {
  LOG_LEVEL,
  NODE_ENV,
  BODY_LIMIT_BYTES,
  RATE_LIMIT_MAX,
  SYSLOG_PORT,
  SYSLOG_HOST,
  ALLOWED_ORIGINS,
  METRICS_TOKEN,
  CLOUD_MODE,
  getLogCounts,
  purgeLogs,
} from "@usekamori/core";
import type { KamoriAdapters, ServerPlugins } from "@usekamori/core";
import { startSyslogServer } from "./syslog.js";
import v1Routes from "./routes/v1.js";

/**
 * Escapes a Prometheus label value per the text exposition format spec.
 * Backslash, double-quote, and newline are the only characters that require
 * escaping. Without this, DB values containing " or \n break the format and
 * allow label injection into the metrics output.
 */
function sanitizePrometheusLabel(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
}

/**
 * Builds and returns a configured Fastify instance.
 *
 * This function:
 * 1. Creates the Fastify instance
 * 2. Registers plugins (helmet, rate-limit)
 * 3. Registers the /metrics route (uses adapters.db via summarizeErrors)
 * 4. Registers v1Routes(adapters)
 * 5. Sets up the retention cron (uses adapters.retention and adapters.db)
 * 6. Sets up syslog if SYSLOG_PORT > 0
 * 7. Sets up graceful shutdown
 * 8. Returns the fastify instance (does NOT call .listen())
 *
 * Cloud entrypoints call buildServer() with their own adapter set.
 * The OSS entrypoint (server.ts) calls buildServer(defaultAdapters()).
 *
 * @param adapters - The full set of Kamori adapters to inject.
 * @returns Configured Fastify instance (not yet listening).
 */
export async function buildServer(
  adapters: KamoriAdapters,
  plugins?: ServerPlugins,
): Promise<FastifyInstance> {
  const fastify = Fastify({
    logger: {
      level: LOG_LEVEL,
      transport:
        NODE_ENV === "production" ? undefined : { target: "pino-pretty" },
    },
    bodyLimit: BODY_LIMIT_BYTES,
  });

  await fastify.register(helmet, {
    // Content-Security-Policy: this is a JSON API server with no HTML UI.
    // Deny all content loading by default; allow only same-origin fetches.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        scriptSrc: ["'none'"],
        styleSrc: ["'none'"],
        imgSrc: ["'none'"],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    // HTTP Strict Transport Security — 1 year, include subdomains.
    // Only meaningful over HTTPS; harmless over HTTP in dev.
    hsts: {
      maxAge: 31_536_000,
      includeSubDomains: true,
    },
    // Prevent clickjacking (belt-and-suspenders alongside CSP frame-ancestors).
    frameguard: { action: "deny" },
    // Prevent MIME-type sniffing.
    noSniff: true,
    // Do not send X-Powered-By.
    hidePoweredBy: true,
    // Referrer policy: no referrer leakage from API responses.
    referrerPolicy: { policy: "no-referrer" },
  });
  await fastify.register(cors, {
    origin:
      ALLOWED_ORIGINS.length === 0
        ? false
        : ALLOWED_ORIGINS.includes("*")
          ? true
          : ALLOWED_ORIGINS,
    methods: ["GET", "POST", "DELETE"],
  });
  await fastify.register(rateLimit, {
    max: RATE_LIMIT_MAX,
    timeWindow: "1 minute",
    // Key on the ingest/bearer token when present so each project gets its own
    // rate-limit bucket, regardless of originating IP. Without this, tenants
    // sharing a NAT/proxy share the same IP bucket and can starve each other.
    // Falls back to IP for unauthenticated requests (e.g. /health, /metrics).
    //
    // The token is hashed (SHA-256 hex) before use as a key. Raw secrets must
    // never appear in the rate-limit store: if @fastify/rate-limit is backed by
    // Redis the keyspace is readable via KEYS/SCAN/MONITOR, creating a credential
    // leak at the infrastructure layer. The hash preserves per-token bucketing
    // with no change to rate-limiting semantics.
    keyGenerator: (req) => {
      const authHeader = req.headers["authorization"];
      if (authHeader) {
        const raw = Array.isArray(authHeader) ? authHeader[0] : authHeader;
        if (raw.startsWith("Bearer "))
          return createHash("sha256").update(raw.slice(7)).digest("hex");
      }
      return req.ip ?? "unknown";
    },
  });

  // ---------------------------------------------------------------------------
  // Prometheus /metrics — top-level, no auth, no /v1 prefix
  // ---------------------------------------------------------------------------

  /**
   * Exposes Prometheus-compatible metrics for self-hosted Grafana/Prometheus stacks.
   *
   * Metrics exposed:
   *   kamori_logs_total{service, level}  — cumulative log counts from the DB.
   *
   * Auth: open by default. Set METRICS_TOKEN to require a Bearer token — useful
   * when the endpoint is publicly reachable and you don't want to block it at the
   * reverse proxy. Timing-safe comparison prevents token-length oracle attacks.
   *
   * Cloud note: cloud dashboards use the REST API (/v1/summary etc.) directly.
   * This endpoint always reads adapters.db (the default OSS DB); it is not
   * project-aware and is not intended for cloud per-tenant scraping.
   */
  // Hash computed once at construction — not per-request.
  const metricsTokenHash = METRICS_TOKEN
    ? createHash("sha256").update(METRICS_TOKEN).digest()
    : null;

  fastify.get("/metrics", { config: { skipAuth: true } }, async (req, reply) => {
    if (metricsTokenHash) {
      const authHeader = req.headers["authorization"];
      let rawToken = "";
      if (authHeader) {
        const raw = Array.isArray(authHeader) ? authHeader[0] : authHeader;
        if (raw.startsWith("Bearer ")) rawToken = raw.slice(7);
      }
      if (!rawToken || !timingSafeEqual(createHash("sha256").update(rawToken).digest(), metricsTokenHash)) {
        return reply.code(401).send({ error: "unauthorized" });
      }
    }

    const rows = await getLogCounts(adapters.db);
    const lines: string[] = [
      "# HELP kamori_logs_total Total log entries by service and level",
      "# TYPE kamori_logs_total counter",
    ];
    for (const r of rows) {
      const service = sanitizePrometheusLabel(r.service || "unknown");
      const level = sanitizePrometheusLabel(r.level || "unknown");
      lines.push(
        `kamori_logs_total{service="${service}",level="${level}"} ${r.count}`,
      );
    }
    reply.header("Content-Type", "text/plain; version=0.0.4");
    return reply.send(lines.join("\n") + "\n");
  });

  // Versioned route plugins — add future versions here:
  // fastify.register(v2Routes(adapters), { prefix: "/v2" });
  fastify.register(v1Routes(adapters, plugins), { prefix: "/v1" });

  // ---------------------------------------------------------------------------
  // Retention policy cron
  // ---------------------------------------------------------------------------

  /**
   * When the retention adapter returns a cutoff date, purge log rows older than that.
   * Runs once at startup and then every hour so the database stays bounded.
   * The interval is unref()'d so it does not prevent clean process exit.
   */
  const runRetention = async () => {
    // Cloud: delegate to per-project retention (plan-based cutoff per project DB).
    if (plugins?.runRetention) {
      try {
        await plugins.runRetention();
      } catch (err) {
        fastify.log.error(err, "retention: cloud purge failed");
      }
      return;
    }

    // OSS / self-hosted: single global RETENTION_DAYS against the default DB.
    const cutoff = adapters.retention.getCutoffDate();
    if (!cutoff) return;
    try {
      const deleted = await purgeLogs(adapters.db, cutoff);
      if (deleted > 0) {
        fastify.log.info(
          { deleted, before: cutoff },
          "retention: purged old logs",
        );
        // Reclaim freed pages and update query-planner stats (MKR-137).
        // Wrapped in try/catch — these are best-effort on SQLite only;
        // LibSqlAdapter (Turso) will reject PRAGMA statements silently.
        try {
          await adapters.db.run("PRAGMA incremental_vacuum(1000)");
          await adapters.db.run("PRAGMA optimize");
        } catch {
          /* no-op for non-SQLite adapters */
        }
      }
    } catch (err) {
      fastify.log.error(err, "retention: purge failed");
    }
  };

  // Run in the background at startup — do not await, so a slow purge on a
  // large DB does not delay server.listen() / readiness.
  runRetention().catch((err) => fastify.log.error(err, "retention: startup purge failed"));
  // Repeat every hour; store handle so graceful shutdown can cancel it.
  const retentionTimer = setInterval(runRetention, 3_600_000).unref();

  // ---------------------------------------------------------------------------
  // Syslog
  // ---------------------------------------------------------------------------

  // Syslog sockets — populated below if SYSLOG_PORT > 0
  let syslogSockets: {
    udp: import("dgram").Socket;
    tcp: import("net").Server;
  } | null = null;

  // Syslog is OSS-only: it has no authentication and no per-project routing,
  // so it cannot safely ingest into a multi-tenant cloud database. CLOUD_MODE
  // deployments should use the HTTP /v1/ingest endpoint instead.
  if (SYSLOG_PORT > 0 && !CLOUD_MODE) {
    syslogSockets = startSyslogServer(SYSLOG_PORT, adapters.db, SYSLOG_HOST);
  }

  // ---------------------------------------------------------------------------
  // Graceful shutdown
  // ---------------------------------------------------------------------------

  let shuttingDown = false;

  const close = async () => {
    if (shuttingDown) return;
    shuttingDown = true;

    const forceExit = setTimeout(() => {
      console.error("Graceful shutdown timed out — forcing exit");
      process.exit(1);
    }, 10_000);
    forceExit.unref();

    clearInterval(retentionTimer);

    // Close syslog sockets if they were started
    if (syslogSockets) {
      syslogSockets.udp.close();
      syslogSockets.tcp.close();
    }

    try {
      await fastify.close();
    } catch (_) {}

    clearTimeout(forceExit);
    process.exit(0);
  };

  process.on("SIGINT", close);
  process.on("SIGTERM", close);

  process.on("unhandledRejection", (reason) => {
    fastify.log.error({ reason }, "Unhandled promise rejection");
    process.exit(1);
  });

  process.on("uncaughtException", (err) => {
    fastify.log.error({ err }, "Uncaught exception");
    process.exit(1);
  });

  return fastify;
}
