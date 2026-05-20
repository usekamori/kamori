import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import os from "os";
import path from "path";
import { randomBytes, createHmac } from "crypto";
import fs from "fs";
import { BetterSqliteAdapter } from "@usekamori/core";
import type { KamoriAdapters, ServerPlugins } from "@usekamori/core";
import {
  EnvTokenAuth,
  NoBillingAdapter,
  NoopEmailAdapter,
  EnvRetentionAdapter,
  LocalDbMcpAdapter,
} from "@usekamori/core";

const originalEnv = { ...process.env };
let dbPath: string;
let adapter: BetterSqliteAdapter;

const buildApp = async (
  overrideAdapters?: Partial<KamoriAdapters>,
  plugins?: ServerPlugins,
) => {
  // Re-import v1Routes fresh each time so env var changes are picked up
  const { default: v1Routes } = await import("./v1.js");
  const adapters: KamoriAdapters = {
    db: adapter,
    auth: new EnvTokenAuth(process.env.INGEST_TOKEN ?? ""),
    billing: new NoBillingAdapter(),
    email: new NoopEmailAdapter(),
    retention: new EnvRetentionAdapter(0),
    mcp: new LocalDbMcpAdapter(adapter),
    ...overrideAdapters,
  };
  const app = Fastify({ logger: false });
  await app.register(v1Routes(adapters, plugins), { prefix: "/v1" });
  return app;
};

beforeEach(() => {
  vi.resetModules();
  dbPath = path.join(
    os.tmpdir(),
    `v1-test-${randomBytes(8).toString("hex")}.db`,
  );
  process.env.DB_PATH = dbPath;
  process.env.INGEST_TOKEN = "test-secret";
  process.env.MAX_ROWS = "5"; // low limit to make 413 tests easy
  process.env.MCP_PORT = "0"; // disable MCP health ping
  adapter = new BetterSqliteAdapter(dbPath);
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.unstubAllGlobals();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(dbPath + suffix);
    } catch {}
  }
});

// ---------------------------------------------------------------------------
// GET /v1/health
// ---------------------------------------------------------------------------

describe("GET /v1/health", () => {
  it("returns 200 with ok:true and db:true when db is reachable", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/v1/health" });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, checks: { db: true } });
  });

  it("returns 503 with ok:false and db:false when db throws", async () => {
    const brokenDb = {
      run: async () => ({ rowsAffected: 0 }),
      query: async () => [],
      get: async () => {
        throw new Error("db down");
      },
      batch: async () => {},
    };
    const app = await buildApp({ db: brokenDb as any });
    const res = await app.inject({ method: "GET", url: "/v1/health" });
    await app.close();
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ ok: false, checks: { db: false } });
  });

  it("omits mcp key when MCP_PORT is 0", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/v1/health" });
    await app.close();
    expect(res.json().checks).not.toHaveProperty("mcp");
  });

  it("includes mcp:true when MCP health endpoint responds ok", async () => {
    process.env.MCP_PORT = "3111";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/v1/health" });
    await app.close();
    expect(res.json().checks.mcp).toBe(true);
  });

  it("includes mcp:false when MCP health endpoint is unreachable", async () => {
    process.env.MCP_PORT = "3111";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    );
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/v1/health" });
    await app.close();
    expect(res.json().checks.mcp).toBe(false);
  });

  it("keeps ok:true even when MCP is unreachable", async () => {
    process.env.MCP_PORT = "3111";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    );
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/v1/health" });
    await app.close();
    expect(res.json().ok).toBe(true);
  });

  it("requires no auth token", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/v1/health" });
    await app.close();
    expect(res.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// POST /v1/ingest
// ---------------------------------------------------------------------------

describe("POST /v1/ingest", () => {
  it("returns 401 when token header is missing", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers: { "content-type": "application/json" },
      payload: { message: "hello" },
    });
    await app.close();
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ ok: false, error: "unauthorized" });
  });

  it("returns 401 when token is wrong", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer wrong-token",
      },
      payload: { message: "hello" },
    });
    await app.close();
    expect(res.statusCode).toBe(401);
  });

  it("returns 200 for a valid single object", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-secret",
      },
      payload: { service: "api", level: "info", message: "started" },
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, written: 1 });
  });

  it("returns 200 for a valid batch array", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-secret",
      },
      payload: [{ msg: "a" }, { msg: "b" }, { msg: "c" }],
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, written: 3 });
  });

  it("returns 400 for an empty array", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-secret",
      },
      payload: [],
    });
    await app.close();
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ ok: false, error: "empty body" });
  });

  it("returns 413 when batch exceeds MAX_ROWS", async () => {
    // beforeEach sets MAX_ROWS=5; send 6 rows
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-secret",
      },
      payload: [{}, {}, {}, {}, {}, {}],
    });
    await app.close();
    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ ok: false, error: "too many log rows" });
  });

  it("allows ingest with no auth when INGEST_TOKEN is unset", async () => {
    delete process.env.INGEST_TOKEN;
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers: { "content-type": "application/json" },
      payload: { message: "open endpoint" },
    });
    await app.close();
    expect(res.statusCode).toBe(200);
  });

  it("persists rows to the database", async () => {
    const app = await buildApp();
    await app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-secret",
      },
      payload: { service: "test-svc", level: "warn", message: "persisted" },
    });
    await app.close();

    const { queryLogs } = await import("@usekamori/core");
    const rows = await queryLogs(adapter, { service: "test-svc" });
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].body)).toMatchObject({ message: "persisted" });
  });

  it("injects a received_at timestamp into stored body", async () => {
    const app = await buildApp();
    const before = new Date().toISOString();
    await app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-secret",
      },
      payload: { message: "timestamped" },
    });
    const after = new Date().toISOString();
    await app.close();

    const { queryLogs } = await import("@usekamori/core");
    const [row] = await queryLogs(adapter, {});
    expect(row.received_at >= before).toBe(true);
    expect(row.received_at <= after).toBe(true);
  });

  it("returns 503 when db insert fails", async () => {
    const throwingDb = {
      run: async () => {
        throw new Error("disk full");
      },
      query: async () => [],
      get: async () => null,
      batch: async () => {
        throw new Error("disk full");
      },
    };
    const app = await buildApp({ db: throwingDb as any });
    const res = await app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-secret",
      },
      payload: { message: "will fail" },
    });
    await app.close();
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ ok: false, error: "db insert failed" });
  });
});

// ---------------------------------------------------------------------------
// GET /v1/services
// ---------------------------------------------------------------------------

describe("GET /v1/services", () => {
  it("returns 200 with an empty services array when no logs exist", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/v1/services",
      headers: { authorization: "Bearer test-secret" },
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ services: [] });
  });

  it("returns distinct service names after ingesting logs", async () => {
    const app = await buildApp();
    // Ingest two services
    await app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-secret",
      },
      payload: [
        { service: "alpha" },
        { service: "beta" },
        { service: "alpha" },
      ],
    });
    const res = await app.inject({
      method: "GET",
      url: "/v1/services",
      headers: { authorization: "Bearer test-secret" },
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    const { services } = res.json();
    expect(services).toContain("alpha");
    expect(services).toContain("beta");
    // No duplicates
    expect(services.filter((s: string) => s === "alpha")).toHaveLength(1);
  });

  it("returns 401 without auth token", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/v1/services" });
    await app.close();
    expect(res.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/summary
// ---------------------------------------------------------------------------

describe("GET /v1/summary", () => {
  it("returns 200 with an empty array when no logs exist", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/v1/summary",
      headers: { authorization: "Bearer test-secret" },
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it("returns grouped service/level counts", async () => {
    const app = await buildApp();
    await app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-secret",
      },
      payload: [
        { service: "api", level: "error", seq: 1 },
        { service: "api", level: "error", seq: 2 },
        { service: "api", level: "info", seq: 1 },
      ],
    });
    const res = await app.inject({
      method: "GET",
      url: "/v1/summary",
      headers: { authorization: "Bearer test-secret" },
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    const rows = res.json() as {
      service: string;
      level: string;
      count: number;
    }[];
    const apiErrors = rows.find(
      (r) => r.service === "api" && r.level === "error",
    );
    expect(apiErrors?.count).toBe(2);
  });

  it("filters by since", async () => {
    const app = await buildApp();
    await app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers: { "content-type": "application/json", authorization: "Bearer test-secret" },
      payload: [{ service: "time-svc", level: "info", seq: 1 }],
    });
    // since in the future — should return no rows for this service
    const res = await app.inject({
      method: "GET",
      url: "/v1/summary?since=2099-01-01T00:00:00Z",
      headers: { authorization: "Bearer test-secret" },
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    const rows = res.json() as { service: string }[];
    expect(rows.find((r) => r.service === "time-svc")).toBeUndefined();
  });

  it("filters by until", async () => {
    const app = await buildApp();
    await app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers: { "content-type": "application/json", authorization: "Bearer test-secret" },
      payload: [{ service: "until-svc", level: "warn", seq: 1 }],
    });
    // until in the past — should exclude the row just ingested
    const res = await app.inject({
      method: "GET",
      url: "/v1/summary?until=2000-01-01T00:00:00Z",
      headers: { authorization: "Bearer test-secret" },
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    const rows = res.json() as { service: string }[];
    expect(rows.find((r) => r.service === "until-svc")).toBeUndefined();
  });

  it("returns 401 without auth token", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/v1/summary" });
    await app.close();
    expect(res.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// ISO-8601 validation — since/until across /logs, /search, /summary, /export
// ---------------------------------------------------------------------------

describe("ISO-8601 validation for since/until params", () => {
  const auth = { authorization: "Bearer test-secret" };
  const bad = "not-a-date";

  it.each([
    ["GET", "/v1/logs?since=" + bad],
    ["GET", "/v1/logs?until=" + bad],
    ["GET", "/v1/search?q=x&since=" + bad],
    ["GET", "/v1/search?q=x&until=" + bad],
    ["GET", "/v1/summary?since=" + bad],
    ["GET", "/v1/summary?until=" + bad],
    ["GET", "/v1/export?since=" + bad],
    ["GET", "/v1/export?until=" + bad],
  ] as const)("returns 400 for malformed %s %s", async (method, url) => {
    const app = await buildApp();
    const res = await app.inject({ method, url, headers: auth });
    await app.close();
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: expect.stringContaining("ISO-8601") });
  });

  it.each([
    "GET /v1/logs?since=2024-01-15T00:00:00Z",
    "GET /v1/logs?until=2024-01-15",
    "GET /v1/summary?since=2024-01-15T12:34:56.789Z&until=2025-01-01T00:00:00Z",
  ])("accepts valid ISO in %s", async (spec) => {
    const [method, url] = spec.split(" ") as ["GET", string];
    const app = await buildApp();
    const res = await app.inject({ method, url, headers: auth });
    await app.close();
    expect(res.statusCode).not.toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/export
// ---------------------------------------------------------------------------

describe("GET /v1/export", () => {
  /** Helper: ingest a batch of rows through the API. */
  const ingest = (app: Awaited<ReturnType<typeof buildApp>>, rows: object[]) =>
    app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-secret",
      },
      payload: rows,
    });

  it("returns 200 with NDJSON content by default", async () => {
    const app = await buildApp();
    await ingest(app, [{ service: "api", level: "info", message: "hello" }]);
    const res = await app.inject({
      method: "GET",
      url: "/v1/export",
      headers: { authorization: "Bearer test-secret" },
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch("application/x-ndjson");
    // Each line should be valid JSON
    const lines = res.body.split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("returns 200 with CSV content when format=csv", async () => {
    const app = await buildApp();
    await ingest(app, [{ service: "api", level: "error", message: "oops" }]);
    const res = await app.inject({
      method: "GET",
      url: "/v1/export?format=csv",
      headers: { authorization: "Bearer test-secret" },
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch("text/csv");
    const lines = res.body.split("\n");
    // First line is the header
    expect(lines[0]).toBe("id,received_at,service,level,body");
    // At least one data row
    expect(lines.length).toBeGreaterThan(1);
  });

  it("CSV header is present even when there are no rows", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/v1/export?format=csv",
      headers: { authorization: "Bearer test-secret" },
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.body.startsWith("id,received_at,service,level,body")).toBe(true);
  });

  it("streams all rows for a service filter (PassThrough async write)", async () => {
    // Verify that with the PassThrough streaming approach the async write loop
    // completes and all rows are delivered before the inject() response resolves.
    const app = await buildApp();
    const rows = Array.from({ length: 3 }, (_, i) => ({
      service: "pt-stream",
      message: `msg-${i}`,
      seq: i,
    }));
    await ingest(app, rows);

    const res = await app.inject({
      method: "GET",
      url: "/v1/export?service=pt-stream",
      headers: { authorization: "Bearer test-secret" },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    const lines = res.body.split("\n").filter(Boolean);
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("returns 401 without auth token", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/v1/export" });
    await app.close();
    expect(res.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/logs
// ---------------------------------------------------------------------------

describe("GET /v1/logs", () => {
  /** Helper: ingest rows through the API. */
  const ingest = (app: Awaited<ReturnType<typeof buildApp>>, rows: object[]) =>
    app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-secret",
      },
      payload: rows,
    });

  it("returns 401 without auth token", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/v1/logs" });
    await app.close();
    expect(res.statusCode).toBe(401);
  });

  it("returns 200 with logs array and count", async () => {
    const app = await buildApp();
    await ingest(app, [{ message: "hello" }]);
    const res = await app.inject({
      method: "GET",
      url: "/v1/logs",
      headers: { authorization: "Bearer test-secret" },
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty("logs");
    expect(body).toHaveProperty("count");
    expect(body.count).toBe(1);
  });

  it("returns empty logs array when no rows exist", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/v1/logs",
      headers: { authorization: "Bearer test-secret" },
    });
    await app.close();
    expect(res.json()).toMatchObject({ logs: [], count: 0 });
  });

  it("filters by service", async () => {
    const app = await buildApp();
    await ingest(app, [
      { service: "api", msg: "a" },
      { service: "worker", msg: "b" },
    ]);
    const res = await app.inject({
      method: "GET",
      url: "/v1/logs?service=api",
      headers: { authorization: "Bearer test-secret" },
    });
    await app.close();
    const { logs } = res.json();
    expect(logs).toHaveLength(1);
    expect(logs[0].service).toBe("api");
  });

  it("filters by level", async () => {
    const app = await buildApp();
    await ingest(app, [
      { level: "error", msg: "bad" },
      { level: "info", msg: "ok" },
    ]);
    const res = await app.inject({
      method: "GET",
      url: "/v1/logs?level=error",
      headers: { authorization: "Bearer test-secret" },
    });
    await app.close();
    const { logs } = res.json();
    expect(logs).toHaveLength(1);
    expect(logs[0].level).toBe("error");
  });

  it("filters by trace_id", async () => {
    const app = await buildApp();
    await ingest(app, [
      { trace_id: "abc-123", msg: "traced" },
      { msg: "untraced" },
    ]);
    const res = await app.inject({
      method: "GET",
      url: "/v1/logs?trace_id=abc-123",
      headers: { authorization: "Bearer test-secret" },
    });
    await app.close();
    const { logs } = res.json();
    expect(logs).toHaveLength(1);
    expect(logs[0].trace_id).toBe("abc-123");
  });

  it("returns oldest-first and only newer rows when after_id is set", async () => {
    const app = await buildApp();
    await ingest(app, [{ seq: 1 }, { seq: 2 }, { seq: 3 }]);
    // Get all rows to find the first id
    const allRes = await app.inject({
      method: "GET",
      url: "/v1/logs",
      headers: { authorization: "Bearer test-secret" },
    });
    const allLogs = allRes.json().logs as { id: number }[];
    const minId = Math.min(...allLogs.map((r) => r.id));

    const res = await app.inject({
      method: "GET",
      url: `/v1/logs?after_id=${minId}`,
      headers: { authorization: "Bearer test-secret" },
    });
    await app.close();
    const { logs } = res.json();
    expect(logs).toHaveLength(2);
    expect(logs.every((r: { id: number }) => r.id > minId)).toBe(true);
    // Oldest-first when after_id is set
    expect(logs[0].id).toBeLessThan(logs[1].id);
  });

  it("respects the limit param", async () => {
    const app = await buildApp();
    await ingest(app, [{ seq: 1 }, { seq: 2 }, { seq: 3 }, { seq: 4 }]);
    const res = await app.inject({
      method: "GET",
      url: "/v1/logs?limit=2",
      headers: { authorization: "Bearer test-secret" },
    });
    await app.close();
    expect(res.json().logs).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/search
// ---------------------------------------------------------------------------

describe("GET /v1/search", () => {
  /** Helper: ingest rows through the API. */
  const ingest = (app: Awaited<ReturnType<typeof buildApp>>, rows: object[]) =>
    app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-secret",
      },
      payload: rows,
    });

  it("returns 401 without auth token", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/v1/search?q=hello" });
    await app.close();
    expect(res.statusCode).toBe(401);
  });

  it("returns 400 when q param is missing", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/v1/search",
      headers: { authorization: "Bearer test-secret" },
    });
    await app.close();
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      ok: false,
      error: "'q' query parameter is required",
    });
  });

  it("returns matching logs for a full-text query", async () => {
    const app = await buildApp();
    await ingest(app, [
      { message: "connection refused" },
      { message: "request succeeded" },
    ]);
    const res = await app.inject({
      method: "GET",
      url: "/v1/search?q=connection",
      headers: { authorization: "Bearer test-secret" },
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    const { logs, count } = res.json();
    expect(count).toBe(1);
    expect(logs[0].body).toContain("connection");
  });

  it("returns empty results when nothing matches", async () => {
    const app = await buildApp();
    await ingest(app, [{ message: "all good" }]);
    const res = await app.inject({
      method: "GET",
      url: "/v1/search?q=timeout",
      headers: { authorization: "Bearer test-secret" },
    });
    await app.close();
    expect(res.json()).toMatchObject({ logs: [], count: 0 });
  });

  it("narrows results with service filter", async () => {
    const app = await buildApp();
    await ingest(app, [
      { service: "api", message: "error here" },
      { service: "worker", message: "error here" },
    ]);
    const res = await app.inject({
      method: "GET",
      url: "/v1/search?q=error&service=api",
      headers: { authorization: "Bearer test-secret" },
    });
    await app.close();
    const { logs } = res.json();
    expect(logs).toHaveLength(1);
    expect(logs[0].service).toBe("api");
  });

  it("respects the limit param", async () => {
    const app = await buildApp();
    await ingest(app, [
      { message: "hit", seq: 1 },
      { message: "hit", seq: 2 },
      { message: "hit", seq: 3 },
    ]);
    const res = await app.inject({
      method: "GET",
      url: "/v1/search?q=hit&limit=2",
      headers: { authorization: "Bearer test-secret" },
    });
    await app.close();
    expect(res.json().logs).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// DELETE /v1/logs
// ---------------------------------------------------------------------------

describe("DELETE /v1/logs", () => {
  it("returns 400 when neither before nor service is supplied", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "DELETE",
      url: "/v1/logs",
      headers: { authorization: "Bearer test-secret" },
    });
    await app.close();
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ ok: false });
  });

  it("deletes rows older than the given before date", async () => {
    const app = await buildApp();
    // Ingest a row
    await app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-secret",
      },
      payload: { message: "old log" },
    });
    // Delete everything before a future date to ensure our row is caught
    const before = new Date(Date.now() + 60_000).toISOString();
    const res = await app.inject({
      method: "DELETE",
      url: `/v1/logs?before=${encodeURIComponent(before)}`,
      headers: { authorization: "Bearer test-secret" },
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, deleted: 1 });
  });

  it("returns deleted:0 when no rows match", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "DELETE",
      url: "/v1/logs?service=nonexistent",
      headers: { authorization: "Bearer test-secret" },
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, deleted: 0 });
  });

  it("returns 401 without auth token", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "DELETE",
      url: "/v1/logs?service=api",
    });
    await app.close();
    expect(res.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// POST /v1/webhook/:provider
// ---------------------------------------------------------------------------

describe("POST /v1/webhook/:provider", () => {
  const webhookBody = { event: "deploy.succeeded", service: "api" };
  const rawBody = Buffer.from(JSON.stringify(webhookBody));

  /** Sign a body for Vercel (HMAC-SHA1). */
  const signVercel = (secret: string, buf: Buffer) =>
    createHmac("sha1", secret).update(buf).digest("hex");

  /** Sign a body for GitHub (sha256=<hex>). */
  const signGitHub = (secret: string, buf: Buffer) =>
    "sha256=" + createHmac("sha256", secret).update(buf).digest("hex");

  /** Sign a body for Render (t=<ts>,v1=<hex>). */
  const signRender = (secret: string, buf: Buffer) =>
    `t=${Math.floor(Date.now() / 1000)},v1=${createHmac("sha256", secret).update(buf).digest("hex")}`;

  it("returns 400 for an unknown provider", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/webhook/slack",
      headers: { "content-type": "application/json" },
      payload: webhookBody,
    });
    await app.close();
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ ok: false, error: "unknown webhook provider: slack" });
  });

  it("does not require the Authorization header (skipAuth) for known providers", async () => {
    // vercel with no secret configured → passes signature check
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/webhook/vercel",
      headers: { "content-type": "application/json" },
      // No Authorization header, no WEBHOOK_SECRET_VERCEL set → passes
      payload: webhookBody,
    });
    await app.close();
    expect(res.statusCode).toBe(200);
  });

  it("ingests the payload into the database for a known provider", async () => {
    // vercel with no secret configured → signature check passes
    const app = await buildApp();
    await app.inject({
      method: "POST",
      url: "/v1/webhook/vercel",
      headers: { "content-type": "application/json" },
      payload: webhookBody,
    });
    await app.close();
    const { queryLogs } = await import("@usekamori/core");
    const rows = await queryLogs(adapter, {});
    expect(rows.length).toBeGreaterThan(0);
    // _provider field should be added automatically
    expect(JSON.parse(rows[0].body)).toMatchObject({ _provider: "vercel" });
  });

  // Vercel
  it("vercel: accepts a valid HMAC-SHA1 signature", async () => {
    process.env.WEBHOOK_SECRET_VERCEL = "vercel-secret";
    const sig = signVercel("vercel-secret", rawBody);
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/webhook/vercel",
      headers: {
        "content-type": "application/json",
        "x-vercel-signature": sig,
      },
      payload: webhookBody,
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, written: 1 });
  });

  it("vercel: rejects a wrong signature", async () => {
    process.env.WEBHOOK_SECRET_VERCEL = "vercel-secret";
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/webhook/vercel",
      headers: {
        "content-type": "application/json",
        "x-vercel-signature": "badhash",
      },
      payload: webhookBody,
    });
    await app.close();
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ ok: false, error: "invalid signature" });
  });

  // GitHub
  it("github: accepts a valid HMAC-SHA256 signature", async () => {
    process.env.WEBHOOK_SECRET_GITHUB = "github-secret";
    const sig = signGitHub("github-secret", rawBody);
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/webhook/github",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": sig,
      },
      payload: webhookBody,
    });
    await app.close();
    expect(res.statusCode).toBe(200);
  });

  it("github: rejects a missing signature header", async () => {
    process.env.WEBHOOK_SECRET_GITHUB = "github-secret";
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/webhook/github",
      headers: { "content-type": "application/json" },
      payload: webhookBody,
    });
    await app.close();
    expect(res.statusCode).toBe(401);
  });

  // Render
  it("render: accepts a valid v1 signature", async () => {
    process.env.WEBHOOK_SECRET_RENDER = "render-secret";
    const sig = signRender("render-secret", rawBody);
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/webhook/render",
      headers: { "content-type": "application/json", "render-signature": sig },
      payload: webhookBody,
    });
    await app.close();
    expect(res.statusCode).toBe(200);
  });

  it("render: rejects a tampered signature", async () => {
    process.env.WEBHOOK_SECRET_RENDER = "render-secret";
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/webhook/render",
      headers: {
        "content-type": "application/json",
        "render-signature": "t=1712000000,v1=" + "a".repeat(64),
      },
      payload: webhookBody,
    });
    await app.close();
    expect(res.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// ServerPlugins.getDbAdapter — per-project DB routing
// ---------------------------------------------------------------------------

describe("ServerPlugins.getDbAdapter — per-project DB routing", () => {
  /** Helper to create a temporary SQLite adapter and track it for cleanup. */
  const makeProjectDb = () => {
    const p = path.join(
      os.tmpdir(),
      `v1-plugin-test-${randomBytes(8).toString("hex")}.db`,
    );
    const db = new BetterSqliteAdapter(p);
    return { db, path: p };
  };

  it("ingest uses the per-project DB when getDbAdapter resolves one", async () => {
    const { db: projectDb, path: projectPath } = makeProjectDb();
    const plugins: ServerPlugins = {
      verifyToken: vi
        .fn()
        .mockResolvedValue({ userId: "u1", projectId: "proj-1" }),
      getDbAdapter: vi.fn().mockResolvedValue(projectDb),
    };

    const app = await buildApp(undefined, plugins);
    const res = await app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-secret",
      },
      payload: {
        service: "project-api",
        level: "info",
        message: "goes to project db",
      },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, written: 1 });

    // The row must be in the project DB, not the default one
    const { queryLogs } = await import("@usekamori/core");
    const projectRows = await queryLogs(projectDb, {});
    expect(projectRows).toHaveLength(1);
    expect(JSON.parse(projectRows[0].body)).toMatchObject({
      message: "goes to project db",
    });

    // Default adapter must be empty
    const defaultRows = await queryLogs(adapter, {});
    expect(defaultRows).toHaveLength(0);

    // Cleanup extra db
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        fs.unlinkSync(projectPath + suffix);
      } catch {}
    }
  });

  it("GET /v1/logs reads from the per-project DB when projectId is set", async () => {
    const { db: projectDb, path: projectPath } = makeProjectDb();

    // Pre-populate the project DB directly
    const { insertLogs } = await import("@usekamori/core");
    await insertLogs(
      projectDb,
      [{ service: "proj-svc", level: "warn", message: "project log" }],
      new Date().toISOString(),
    );

    const plugins: ServerPlugins = {
      verifyToken: vi
        .fn()
        .mockResolvedValue({ userId: "u2", projectId: "proj-2" }),
      getDbAdapter: vi.fn().mockResolvedValue(projectDb),
    };

    const app = await buildApp(undefined, plugins);
    const res = await app.inject({
      method: "GET",
      url: "/v1/logs",
      headers: { authorization: "Bearer test-secret" },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    const { logs } = res.json();
    expect(logs).toHaveLength(1);
    expect(logs[0].service).toBe("proj-svc");

    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        fs.unlinkSync(projectPath + suffix);
      } catch {}
    }
  });

  it("GET /v1/search reads from the per-project DB when projectId is set", async () => {
    const { db: projectDb, path: projectPath } = makeProjectDb();
    const { insertLogs } = await import("@usekamori/core");
    await insertLogs(
      projectDb,
      [{ service: "search-svc", message: "needle in project db" }],
      new Date().toISOString(),
    );

    const plugins: ServerPlugins = {
      verifyToken: vi
        .fn()
        .mockResolvedValue({ userId: "u3", projectId: "proj-3" }),
      getDbAdapter: vi.fn().mockResolvedValue(projectDb),
    };

    const app = await buildApp(undefined, plugins);
    const res = await app.inject({
      method: "GET",
      url: "/v1/search?q=needle",
      headers: { authorization: "Bearer test-secret" },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    const { logs, count } = res.json();
    expect(count).toBe(1);
    expect(JSON.parse(logs[0].body)).toMatchObject({
      message: "needle in project db",
    });

    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        fs.unlinkSync(projectPath + suffix);
      } catch {}
    }
  });

  it("returns 404 when getDbAdapter returns null (project not found)", async () => {
    const plugins: ServerPlugins = {
      verifyToken: vi
        .fn()
        .mockResolvedValue({ userId: "u4", projectId: "proj-4" }),
      getDbAdapter: vi.fn().mockResolvedValue(null),
    };

    const app = await buildApp(undefined, plugins);
    const res = await app.inject({
      method: "GET",
      url: "/v1/logs",
      headers: { authorization: "Bearer test-secret" },
    });
    await app.close();

    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// ServerPlugins.checkIngestAccess — plan-limit enforcement
// ---------------------------------------------------------------------------

describe("ServerPlugins.checkIngestAccess", () => {
  it("returns 403 when checkIngestAccess returns false", async () => {
    const plugins: ServerPlugins = {
      verifyToken: vi
        .fn()
        .mockResolvedValue({ userId: "u1", projectId: "proj-locked" }),
      checkIngestAccess: vi.fn().mockResolvedValue(false),
    };

    const app = await buildApp(undefined, plugins);
    const res = await app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-secret",
      },
      payload: { message: "blocked" },
    });
    await app.close();

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ ok: false, error: "ingest disabled" });
  });

  it("allows ingest when checkIngestAccess returns true", async () => {
    const plugins: ServerPlugins = {
      verifyToken: vi
        .fn()
        .mockResolvedValue({ userId: "u2", projectId: "proj-open" }),
      checkIngestAccess: vi.fn().mockResolvedValue(true),
    };

    const app = await buildApp(undefined, plugins);
    const res = await app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-secret",
      },
      payload: { message: "allowed" },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, written: 1 });
  });

  it("does not call checkIngestAccess when verifyToken returns null (rejected at auth hook)", async () => {
    const checkIngestAccess = vi.fn();
    const plugins: ServerPlugins = {
      verifyToken: vi.fn().mockResolvedValue(null),
      checkIngestAccess,
    };

    const app = await buildApp(undefined, plugins);
    const res = await app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-secret",
      },
      payload: { message: "blocked" },
    });
    await app.close();

    // verifyToken is authoritative in cloud mode — null returns 401 immediately
    expect(res.statusCode).toBe(401);
    expect(checkIngestAccess).not.toHaveBeenCalled();
  });

  it("403 only affects ingest, not skipAuth routes", async () => {
    const plugins: ServerPlugins = {
      verifyToken: vi
        .fn()
        .mockResolvedValue({ userId: "u3", projectId: "proj-locked" }),
      checkIngestAccess: vi.fn().mockResolvedValue(false),
    };

    const app = await buildApp(undefined, plugins);
    // /health has skipAuth: true — checkIngestAccess should never be reached
    const healthRes = await app.inject({ method: "GET", url: "/v1/health" });
    await app.close();

    expect(healthRes.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// ServerPlugins.verifyToken — token routing and projectId propagation
// ---------------------------------------------------------------------------

describe("ServerPlugins.verifyToken — token routing", () => {
  it("sets request.projectId from verifyToken result for DB routing", async () => {
    const { db: projectDb, path: projectPath } = (() => {
      const p = path.join(
        os.tmpdir(),
        `v1-verify-${randomBytes(8).toString("hex")}.db`,
      );
      return { db: new BetterSqliteAdapter(p), path: p };
    })();

    const plugins: ServerPlugins = {
      verifyToken: vi
        .fn()
        .mockResolvedValue({ userId: "user-abc", projectId: "proj-verify" }),
      getDbAdapter: vi.fn().mockResolvedValue(projectDb),
    };

    const app = await buildApp(undefined, plugins);
    const res = await app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer cloud-api-key",
      },
      payload: { service: "cloud-svc", message: "via cloud key" },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    // getDbAdapter called with the projectId from verifyToken
    expect(plugins.getDbAdapter).toHaveBeenCalledWith("proj-verify");

    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        fs.unlinkSync(projectPath + suffix);
      } catch {}
    }
  });

  it("returns 401 immediately when verifyToken returns null (no fall-through to built-in auth)", async () => {
    const plugins: ServerPlugins = {
      verifyToken: vi.fn().mockResolvedValue(null),
    };

    const app = await buildApp(undefined, plugins);

    // Even a request with a valid built-in INGEST_TOKEN is rejected — verifyToken
    // is authoritative when plugins.verifyToken is present (cloud mode).
    const res = await app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-secret",
      },
      payload: { message: "should be blocked" },
    });
    await app.close();

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ ok: false, error: "unauthorized" });
  });
});

// ---------------------------------------------------------------------------
// GET /v1/stream — connection counter (SEC-L1)
// ---------------------------------------------------------------------------

describe("GET /v1/stream — connection counter", () => {
  it("_getStreamConnectionCount() returns 0 after module reset", async () => {
    const { _getStreamConnectionCount } = await import("./v1.js");
    expect(_getStreamConnectionCount()).toBe(0);
  });

  it("_resetStreamConnections() resets counter to 0", async () => {
    const { _resetStreamConnections, _getStreamConnectionCount } = await import("./v1.js");
    // Confirm baseline
    expect(_getStreamConnectionCount()).toBe(0);
    // Calling reset on an already-zero counter is a no-op
    _resetStreamConnections();
    expect(_getStreamConnectionCount()).toBe(0);
  });

  it("onClose hook resets counter when the server shuts down", async () => {
    const Fastify = (await import("fastify")).default;
    const { default: v1Routes, _getStreamConnectionCount } = await import("./v1.js");
    const app = Fastify({ logger: false });
    await app.register(v1Routes({ db: adapter, auth: { verify: async () => null } } as never), { prefix: "/v1" });
    await app.listen({ port: 0, host: "127.0.0.1" });

    // Manually increment via the stream endpoint (inject opens + closes synchronously,
    // so we test the hook directly: counter starts at 0, close resets it to 0).
    expect(_getStreamConnectionCount()).toBe(0);
    await app.close();
    // onClose hook must have fired — counter still 0 (or reset from any leak)
    expect(_getStreamConnectionCount()).toBe(0);
  });

  it("returns 503 when the connection limit is reached", async () => {
    const {
      _setStreamConnectionsForTest,
      _resetStreamConnections,
      _getStreamConnectionCount,
    } = await import("./v1.js");

    const app = await buildApp();

    // Directly set the counter to the limit (50) to avoid opening 50 real
    // streaming connections — inject() blocks until the stream ends, which
    // never happens for this endpoint. _setStreamConnectionsForTest is a
    // test-only escape hatch that bypasses the real connection lifecycle.
    _setStreamConnectionsForTest(50);
    expect(_getStreamConnectionCount()).toBe(50);

    const overLimit = await app.inject({
      method: "GET",
      url: "/v1/stream",
      headers: { authorization: "Bearer test-secret" },
    });

    await app.close(); // onClose resets the counter
    expect(_getStreamConnectionCount()).toBe(0); // onClose fired

    expect(overLimit.statusCode).toBe(503);
    expect(overLimit.json()).toMatchObject({
      ok: false,
      error: "too many active stream connections",
    });
  });
});

// ---------------------------------------------------------------------------
// DELETE /v1/logs — ownership model (SEC-L5)
// ---------------------------------------------------------------------------

describe("DELETE /v1/logs — cloud tenant isolation (SEC-L5)", () => {
  it("deletes only logs in the authenticated tenant's database", async () => {
    // Two separate adapters simulate two tenants' databases
    const tenantADbPath = path.join(
      os.tmpdir(),
      `tenant-a-${randomBytes(8).toString("hex")}.db`,
    );
    const tenantBDbPath = path.join(
      os.tmpdir(),
      `tenant-b-${randomBytes(8).toString("hex")}.db`,
    );
    const { BetterSqliteAdapter } = await import("@usekamori/core");
    const { insertLogs } = await import("@usekamori/core");
    const dbA = new BetterSqliteAdapter(tenantADbPath);
    const dbB = new BetterSqliteAdapter(tenantBDbPath);
    const ts = new Date().toISOString();
    await insertLogs(dbA, [{ message: "tenant-A log", seq: 1 }], ts);
    await insertLogs(dbB, [{ message: "tenant-B log", seq: 1 }], ts);

    // Cloud plugin: resolveDb routes project-A token to dbA only
    const plugins: import("@usekamori/core").ServerPlugins = {
      verifyToken: async (token) => {
        if (token === "token-a") return { projectId: "proj-a", userId: "u1" };
        return null;
      },
      getDbAdapter: async (projectId) => {
        if (projectId === "proj-a") return dbA;
        return null;
      },
    };

    const app = await buildApp({}, plugins);

    const before = new Date(Date.now() + 60_000).toISOString();
    const res = await app.inject({
      method: "DELETE",
      url: `/v1/logs?before=${encodeURIComponent(before)}`,
      headers: { authorization: "Bearer token-a" },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, deleted: 1 });

    // Tenant B's data must be untouched
    const { queryLogs } = await import("@usekamori/core");
    const bLogs = await queryLogs(dbB, {});
    expect(bLogs).toHaveLength(1);

    for (const p of [tenantADbPath, tenantBDbPath]) {
      for (const s of ["", "-wal", "-shm"]) {
        try { fs.unlinkSync(p + s); } catch {}
      }
    }
  });
});

// ---------------------------------------------------------------------------
// POST /v1/ingest — concurrency cap
// ---------------------------------------------------------------------------

describe("POST /v1/ingest — concurrency cap", () => {
  it("returns 503 when _inFlightWrites is at the limit", async () => {
    process.env.INGEST_CONCURRENCY_LIMIT = "3";
    const { _setInFlightWritesForTest, _resetInFlightWrites } =
      await import("./v1.js");

    const app = await buildApp();
    _setInFlightWritesForTest(3);

    const res = await app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers: {
        authorization: "Bearer test-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify([{ level: "info", body: "x" }]),
    });

    _resetInFlightWrites();
    await app.close();

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ ok: false, error: "server busy, retry" });
  });

  it("allows requests when _inFlightWrites is below the limit", async () => {
    process.env.INGEST_CONCURRENCY_LIMIT = "3";
    const { _setInFlightWritesForTest, _resetInFlightWrites } =
      await import("./v1.js");

    const app = await buildApp();
    _setInFlightWritesForTest(2); // one below cap

    const res = await app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers: {
        authorization: "Bearer test-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify([{ level: "info", body: "x" }]),
    });

    _resetInFlightWrites();
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
  });

  it("does not apply the cap when INGEST_CONCURRENCY_LIMIT is 0", async () => {
    process.env.INGEST_CONCURRENCY_LIMIT = "0";
    const { _setInFlightWritesForTest, _resetInFlightWrites } =
      await import("./v1.js");

    const app = await buildApp();
    // Set counter well above a typical limit — should be ignored when limit=0
    _setInFlightWritesForTest(9999);

    const res = await app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers: {
        authorization: "Bearer test-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify([{ level: "info", body: "x" }]),
    });

    _resetInFlightWrites();
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
  });

  it("onClose hook resets _inFlightWrites to 0", async () => {
    const { _setInFlightWritesForTest, _getInFlightWrites } =
      await import("./v1.js");

    const app = await buildApp();
    _setInFlightWritesForTest(5);
    expect(_getInFlightWrites()).toBe(5);

    await app.close();
    expect(_getInFlightWrites()).toBe(0);
  });
});
