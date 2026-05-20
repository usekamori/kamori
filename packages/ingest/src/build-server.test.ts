/**
 * Tests for build-server.ts — covers the three additions introduced in recent
 * changes that the unit/integration test suites do not yet reach:
 *
 *  A. /metrics endpoint — per-project DB routing via ServerPlugins
 *  B. Retention cron — delegates to plugins.runRetention() when present
 *  C. Retention cron — falls back to adapters.retention + purgeLogs when absent
 *
 * Pattern mirrors v1.test.ts: BetterSqliteAdapter with per-test temp SQLite
 * files, Fastify inject(), and vi.resetModules() in beforeEach.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// buildServer registers process signal listeners on every call. With many
// tests in the same process the default limit of 10 would be exceeded.
process.setMaxListeners(0);
import os from "os";
import path from "path";
import { randomBytes } from "crypto";
import fs from "fs";
import {
  BetterSqliteAdapter,
  EnvTokenAuth,
  NoBillingAdapter,
  NoopEmailAdapter,
  EnvRetentionAdapter,
  LocalDbMcpAdapter,
  insertLogs,
} from "@usekamori/core";
import type { KamoriAdapters, ServerPlugins } from "@usekamori/core";

// ---------------------------------------------------------------------------
// Per-test state
// ---------------------------------------------------------------------------

const originalEnv = { ...process.env };
let dbPath: string;
let adapter: BetterSqliteAdapter;
let extraPaths: string[] = [];

// Convenience: current ISO timestamp for insertLogs calls.
const now = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// Helper: build a KamoriAdapters with the given db (defaults to module-level
// adapter) and optional overrides.
// ---------------------------------------------------------------------------

const makeAdapters = (overrides?: Partial<KamoriAdapters>): KamoriAdapters => ({
  db: adapter,
  auth: new EnvTokenAuth(process.env.INGEST_TOKEN ?? ""),
  billing: new NoBillingAdapter(),
  email: new NoopEmailAdapter(),
  retention: new EnvRetentionAdapter(0),
  mcp: new LocalDbMcpAdapter(adapter),
  ...overrides,
});

// ---------------------------------------------------------------------------
// Helper: spin up a full buildServer instance and return it.
// ---------------------------------------------------------------------------

const buildApp = async (adapters: KamoriAdapters, plugins?: ServerPlugins) => {
  const { buildServer } = await import("./build-server.js");
  const app = await buildServer(adapters, plugins);
  return app;
};

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetModules();
  dbPath = path.join(
    os.tmpdir(),
    `build-server-test-${randomBytes(8).toString("hex")}.db`,
  );
  process.env.DB_PATH = dbPath;
  process.env.INGEST_TOKEN = "test-secret";
  process.env.MAX_ROWS = "500";
  process.env.MCP_PORT = "0";
  process.env.SYSLOG_PORT = "0";
  process.env.NODE_ENV = "test";
  process.env.ALLOWED_ORIGINS = "";
  extraPaths = [];
  adapter = new BetterSqliteAdapter(dbPath);
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.unstubAllGlobals();
  const pathsToClean = [dbPath, ...extraPaths];
  for (const p of pathsToClean) {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        fs.unlinkSync(p + suffix);
      } catch {
        // ignore
      }
    }
  }
});

// ---------------------------------------------------------------------------
// GET /metrics — no plugins (OSS / single-tenant path)
// ---------------------------------------------------------------------------

describe("GET /metrics — no plugins", () => {
  it("returns 200 with Prometheus text format content-type", async () => {
    const app = await buildApp(makeAdapters());
    const res = await app.inject({ method: "GET", url: "/metrics" });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
  });

  it("returns header lines for kamori_logs_total", async () => {
    const app = await buildApp(makeAdapters());
    const res = await app.inject({ method: "GET", url: "/metrics" });
    await app.close();
    expect(res.body).toContain("# HELP kamori_logs_total");
    expect(res.body).toContain("# TYPE kamori_logs_total counter");
  });

  it("returns data from adapters.db when no plugins are present", async () => {
    await insertLogs(
      adapter,
      [{ service: "api", level: "error", message: "test error" }],
      now(),
    );
    const app = await buildApp(makeAdapters());
    const res = await app.inject({ method: "GET", url: "/metrics" });
    await app.close();
    expect(res.body).toContain('service="api"');
    expect(res.body).toContain('level="error"');
  });

  it("requires no auth token (skipAuth route)", async () => {
    const app = await buildApp(makeAdapters());
    // No Authorization header — must still succeed
    const res = await app.inject({ method: "GET", url: "/metrics" });
    await app.close();
    expect(res.statusCode).toBe(200);
  });

  it("returns empty counter lines when db is empty", async () => {
    const app = await buildApp(makeAdapters());
    const res = await app.inject({ method: "GET", url: "/metrics" });
    await app.close();
    // Only the two comment lines; no data lines
    const lines = res.body.split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^# HELP/);
    expect(lines[1]).toMatch(/^# TYPE/);
  });
});

// ---------------------------------------------------------------------------
// Retention cron — plugins.runRetention() present
// ---------------------------------------------------------------------------

describe("Retention cron — plugins.runRetention present", () => {
  it("calls plugins.runRetention() at startup instead of purgeLogs", async () => {
    const runRetention = vi.fn().mockResolvedValue(undefined);
    const plugins: ServerPlugins = { runRetention };

    const app = await buildApp(makeAdapters(), plugins);
    // Give the background startup call time to complete
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    await app.close();

    expect(runRetention).toHaveBeenCalledTimes(1);
  });

  it("does NOT call adapters.retention.getCutoffDate() when runRetention plugin is present", async () => {
    const getCutoffDate = vi.fn().mockReturnValue("2024-01-01T00:00:00.000Z");
    const retentionAdapter = { getCutoffDate };

    const plugins: ServerPlugins = {
      runRetention: vi.fn().mockResolvedValue(undefined),
    };

    const app = await buildApp(
      makeAdapters({ retention: retentionAdapter }),
      plugins,
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    await app.close();

    expect(getCutoffDate).not.toHaveBeenCalled();
  });

  it("does not throw when plugins.runRetention() rejects — server stays up", async () => {
    const runRetention = vi
      .fn()
      .mockRejectedValue(new Error("cloud retention failed"));
    const plugins: ServerPlugins = { runRetention };

    // buildServer catches errors internally; it should not propagate
    let buildError: unknown = null;
    let app;
    try {
      app = await buildApp(makeAdapters(), plugins);
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    } catch (err) {
      buildError = err;
    } finally {
      if (app) await app.close();
    }

    expect(buildError).toBeNull();
    // runRetention was called and rejected without crashing the server
    expect(runRetention).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Retention cron — no plugins (OSS / single-tenant path)
// ---------------------------------------------------------------------------

describe("Retention cron — no plugins.runRetention (OSS path)", () => {
  it("calls adapters.retention.getCutoffDate() when runRetention plugin is absent", async () => {
    const getCutoffDate = vi.fn().mockReturnValue(null); // null → retention disabled
    const retentionAdapter = { getCutoffDate };

    const app = await buildApp(makeAdapters({ retention: retentionAdapter }));
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    await app.close();

    // getCutoffDate must be called by the OSS retention path
    expect(getCutoffDate).toHaveBeenCalled();
  });

  it("purges rows older than the cutoff date when getCutoffDate returns a value", async () => {
    // Insert an old log and a recent log
    await insertLogs(adapter, [{ msg: "old" }], "2020-01-01T00:00:00.000Z");
    await insertLogs(adapter, [{ msg: "recent" }], "2025-01-01T00:00:00.000Z");

    // Set cutoff to 2022-01-01 — "old" row should be purged, "recent" stays
    const getCutoffDate = vi.fn().mockReturnValue("2022-01-01T00:00:00.000Z");
    const retentionAdapter = { getCutoffDate };

    const app = await buildApp(makeAdapters({ retention: retentionAdapter }));
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    await app.close();

    // Query the DB directly to verify purge happened
    const { queryLogs } = await import("@usekamori/core");
    const remaining = await queryLogs(adapter, {});
    expect(remaining).toHaveLength(1);
    expect(JSON.parse(remaining[0].body)).toMatchObject({ msg: "recent" });
  });

  it("does not purge anything when getCutoffDate returns null (retention disabled)", async () => {
    await insertLogs(adapter, [{ msg: "keep-me" }], "2020-01-01T00:00:00.000Z");

    const retentionAdapter = { getCutoffDate: () => null };
    const app = await buildApp(makeAdapters({ retention: retentionAdapter }));
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    await app.close();

    const { queryLogs } = await import("@usekamori/core");
    const rows = await queryLogs(adapter, {});
    expect(rows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Prometheus label sanitization (via /metrics output)
// ---------------------------------------------------------------------------

describe("GET /metrics — Prometheus label sanitization", () => {
  it("escapes double-quotes in service names to prevent label injection", async () => {
    // Insert a log with a service name containing a double-quote
    await insertLogs(
      adapter,
      [{ service: 'evil"inject', level: "info" }],
      now(),
    );

    const app = await buildApp(makeAdapters());
    const res = await app.inject({ method: "GET", url: "/metrics" });
    await app.close();

    // The raw " must be escaped as \" in the output
    expect(res.body).toContain('service="evil\\"inject"');
  });

  it("escapes backslashes in level names", async () => {
    await insertLogs(
      adapter,
      [{ service: "svc", level: "back\\slash" }],
      now(),
    );

    const app = await buildApp(makeAdapters());
    const res = await app.inject({ method: "GET", url: "/metrics" });
    await app.close();

    expect(res.body).toContain('level="back\\\\slash"');
  });

  it("uses 'unknown' label value for null service and level", async () => {
    // BetterSqliteAdapter will store null when no service/level is given
    await insertLogs(adapter, [{ message: "no service no level" }], now());

    const app = await buildApp(makeAdapters());
    const res = await app.inject({ method: "GET", url: "/metrics" });
    await app.close();

    expect(res.body).toContain('service="unknown"');
    expect(res.body).toContain('level="unknown"');
  });
});

// ---------------------------------------------------------------------------
// GET /metrics — METRICS_TOKEN auth gate
// ---------------------------------------------------------------------------

describe("GET /metrics — METRICS_TOKEN", () => {
  it("returns 200 without auth when METRICS_TOKEN is not set", async () => {
    delete process.env.METRICS_TOKEN;
    const app = await buildApp(makeAdapters());
    const res = await app.inject({ method: "GET", url: "/metrics" });
    await app.close();
    expect(res.statusCode).toBe(200);
  });

  it("returns 401 when METRICS_TOKEN is set and no Authorization header is sent", async () => {
    process.env.METRICS_TOKEN = "super-secret-metrics";
    const app = await buildApp(makeAdapters());
    const res = await app.inject({ method: "GET", url: "/metrics" });
    await app.close();
    expect(res.statusCode).toBe(401);
  });

  it("returns 401 when METRICS_TOKEN is set and Bearer token is wrong", async () => {
    process.env.METRICS_TOKEN = "super-secret-metrics";
    const app = await buildApp(makeAdapters());
    const res = await app.inject({
      method: "GET",
      url: "/metrics",
      headers: { authorization: "Bearer wrong-token" },
    });
    await app.close();
    expect(res.statusCode).toBe(401);
  });

  it("returns 200 and metrics body when METRICS_TOKEN matches", async () => {
    process.env.METRICS_TOKEN = "super-secret-metrics";
    await insertLogs(
      adapter,
      [{ service: "protected-svc", level: "info", message: "test" }],
      now(),
    );
    const app = await buildApp(makeAdapters());
    const res = await app.inject({
      method: "GET",
      url: "/metrics",
      headers: { authorization: "Bearer super-secret-metrics" },
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.body).toContain('service="protected-svc"');
  });

  it("always reads adapters.db regardless of plugins (not project-aware)", async () => {
    process.env.METRICS_TOKEN = "op-token";
    await insertLogs(
      adapter,
      [{ service: "oss-svc", level: "info", message: "in default db" }],
      now(),
    );
    const app = await buildApp(makeAdapters());
    const res = await app.inject({
      method: "GET",
      url: "/metrics",
      headers: { authorization: "Bearer op-token" },
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('service="oss-svc"');
  });
});

// ---------------------------------------------------------------------------
// Rate-limit key — bearer token must be hashed, not stored raw
// ---------------------------------------------------------------------------

describe("rate-limit keyGenerator — token hashing", () => {
  it("does not expose the raw bearer token in X-RateLimit headers", async () => {
    const token = "super-secret-api-key-do-not-leak";
    const app = await buildApp(makeAdapters());
    const res = await app.inject({
      method: "GET",
      url: "/v1/health",
      headers: { authorization: `Bearer ${token}` },
    });
    await app.close();

    // Inspect all response headers — the raw token must not appear in any of them.
    const headerValues = Object.values(res.headers).join(" ");
    expect(headerValues).not.toContain(token);
  });

  it("two requests with the same token share the same rate-limit bucket (counter decrements together)", async () => {
    // Set a high limit so we don't trigger 429 during the test.
    process.env.RATE_LIMIT_MAX = "1000";
    const token = "shared-bucket-token";
    const app = await buildApp(makeAdapters());

    const res1 = await app.inject({
      method: "GET",
      url: "/v1/health",
      headers: { authorization: `Bearer ${token}` },
    });
    const res2 = await app.inject({
      method: "GET",
      url: "/v1/health",
      headers: { authorization: `Bearer ${token}` },
    });
    await app.close();

    const remaining1 = Number(res1.headers["x-ratelimit-remaining"]);
    const remaining2 = Number(res2.headers["x-ratelimit-remaining"]);
    // Second request must have one fewer remaining than the first — same bucket.
    expect(remaining2).toBe(remaining1 - 1);
  });

  it("two requests with different tokens get independent rate-limit buckets", async () => {
    process.env.RATE_LIMIT_MAX = "1000";
    const app = await buildApp(makeAdapters());

    const res1 = await app.inject({
      method: "GET",
      url: "/v1/health",
      headers: { authorization: "Bearer token-alpha" },
    });
    const res2 = await app.inject({
      method: "GET",
      url: "/v1/health",
      headers: { authorization: "Bearer token-beta" },
    });
    await app.close();

    const remaining1 = Number(res1.headers["x-ratelimit-remaining"]);
    const remaining2 = Number(res2.headers["x-ratelimit-remaining"]);
    // Different tokens → independent counters → same remaining count.
    expect(remaining1).toBe(remaining2);
  });
});

// ---------------------------------------------------------------------------
// Syslog — CLOUD_MODE guard and host binding
// ---------------------------------------------------------------------------

describe("Syslog — CLOUD_MODE guard", () => {
  it("does not start syslog when CLOUD_MODE=true even if SYSLOG_PORT is set", async () => {
    process.env.SYSLOG_PORT = "19514";
    process.env.CLOUD_MODE = "true";

    // spy on startSyslogServer to verify it is never called
    const syslogModule = await import("./syslog.js");
    const spy = vi.spyOn(syslogModule, "startSyslogServer");

    const app = await buildApp(makeAdapters());
    await app.close();

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("starts syslog when CLOUD_MODE is not set and SYSLOG_PORT > 0", async () => {
    // Use a random high port to avoid conflicts; close immediately after build
    const port = 19515 + Math.floor(Math.random() * 100);
    process.env.SYSLOG_PORT = String(port);
    delete process.env.CLOUD_MODE;

    const syslogModule = await import("./syslog.js");
    const spy = vi.spyOn(syslogModule, "startSyslogServer").mockReturnValue({
      udp: { close: vi.fn() } as any,
      tcp: { close: vi.fn() } as any,
    });

    const app = await buildApp(makeAdapters());
    await app.close();

    expect(spy).toHaveBeenCalledWith(port, expect.anything(), "127.0.0.1");
    spy.mockRestore();
  });
});
