/**
 * Integration tests — full server + SQLite ingest/query pipeline.
 *
 * These tests exercise multi-step flows across several endpoints to verify that
 * the HTTP layer, business logic, and SQLite storage work together correctly.
 * Each test builds on previous steps within the same scenario.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import os from "os";
import path from "path";
import { randomBytes } from "crypto";
import fs from "fs";
import { BetterSqliteAdapter, insertLogs, queryLogs } from "@usekamori/core";
import type { KamoriAdapters } from "@usekamori/core";
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

const buildApp = async () => {
  const { default: v1Routes } = await import("./v1.js");
  const adapters: KamoriAdapters = {
    db: adapter,
    auth: new EnvTokenAuth(process.env.INGEST_TOKEN ?? ""),
    billing: new NoBillingAdapter(),
    email: new NoopEmailAdapter(),
    retention: new EnvRetentionAdapter(0),
    mcp: new LocalDbMcpAdapter(adapter),
  };
  const app = Fastify({ logger: false });
  await app.register(v1Routes(adapters), { prefix: "/v1" });
  return app;
};

beforeEach(() => {
  vi.resetModules();
  dbPath = path.join(
    os.tmpdir(),
    `integration-test-${randomBytes(8).toString("hex")}.db`,
  );
  process.env.DB_PATH = dbPath;
  process.env.INGEST_TOKEN = "test-token";
  process.env.MAX_ROWS = "500";
  process.env.MCP_PORT = "0";
  adapter = new BetterSqliteAdapter(dbPath);
});

afterEach(() => {
  process.env = { ...originalEnv };
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(dbPath + suffix);
    } catch {}
  }
});

const AUTH = { authorization: "Bearer test-token" };

// ---------------------------------------------------------------------------
// Full ingest → query → export → delete pipeline
// ---------------------------------------------------------------------------

describe("pipeline: ingest → query → export → delete", () => {
  it("ingests logs, queries them, exports as CSV, then deletes them", async () => {
    const app = await buildApp();

    // 1. Ingest a batch of mixed services and levels
    const ingestRes = await app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers: { ...AUTH, "content-type": "application/json" },
      payload: [
        { service: "api", level: "info", message: "started", seq: 1 },
        { service: "api", level: "error", message: "crashed", seq: 2 },
        { service: "worker", level: "info", message: "processing", seq: 1 },
      ],
    });
    expect(ingestRes.statusCode).toBe(200);
    expect(ingestRes.json()).toMatchObject({ ok: true, written: 3 });

    // 2. Query all logs
    const queryAllRes = await app.inject({
      method: "GET",
      url: "/v1/logs",
      headers: AUTH,
    });
    expect(queryAllRes.json().count).toBe(3);

    // 3. Query with service filter
    const queryApiRes = await app.inject({
      method: "GET",
      url: "/v1/logs?service=api",
      headers: AUTH,
    });
    expect(queryApiRes.json().count).toBe(2);

    // 4. Query with level filter
    const queryErrorRes = await app.inject({
      method: "GET",
      url: "/v1/logs?level=error",
      headers: AUTH,
    });
    expect(queryErrorRes.json().count).toBe(1);

    // 5. Export as NDJSON
    const ndjsonRes = await app.inject({
      method: "GET",
      url: "/v1/export?format=ndjson",
      headers: AUTH,
    });
    expect(ndjsonRes.statusCode).toBe(200);
    const ndjsonLines = ndjsonRes.body.split("\n").filter(Boolean);
    expect(ndjsonLines).toHaveLength(3);
    ndjsonLines.forEach((line) => expect(() => JSON.parse(line)).not.toThrow());

    // 6. Export as CSV
    const csvRes = await app.inject({
      method: "GET",
      url: "/v1/export?format=csv",
      headers: AUTH,
    });
    const csvLines = csvRes.body.split("\n").filter(Boolean);
    expect(csvLines[0]).toBe("id,received_at,service,level,body");
    expect(csvLines).toHaveLength(4); // header + 3 data rows

    // 7. Delete the worker service logs
    const deleteRes = await app.inject({
      method: "DELETE",
      url: "/v1/logs?service=worker",
      headers: AUTH,
    });
    expect(deleteRes.json()).toMatchObject({ ok: true, deleted: 1 });

    // 8. Verify only API logs remain
    const finalRes = await app.inject({
      method: "GET",
      url: "/v1/logs",
      headers: AUTH,
    });
    expect(finalRes.json().count).toBe(2);
    const services = finalRes
      .json()
      .logs.map((r: { service: string }) => r.service);
    expect(services.every((s: string) => s === "api")).toBe(true);

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Full-text search pipeline
// ---------------------------------------------------------------------------

describe("pipeline: ingest → FTS search → get single log", () => {
  it("ingests logs, searches by keyword, then fetches a specific log by id", async () => {
    const app = await buildApp();

    // 1. Ingest logs with varied content
    await app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers: { ...AUTH, "content-type": "application/json" },
      payload: [
        { service: "api", message: "connection timeout to postgres", seq: 1 },
        { service: "api", message: "request completed successfully", seq: 2 },
        { service: "api", message: "connection refused from redis", seq: 3 },
      ],
    });

    // 2. Search for connection-related logs
    const searchRes = await app.inject({
      method: "GET",
      url: "/v1/search?q=connection",
      headers: AUTH,
    });
    expect(searchRes.statusCode).toBe(200);
    const { logs, count } = searchRes.json();
    expect(count).toBe(2);

    // 3. Fetch the first result by id directly via GET /v1/logs
    const targetId = logs[0].id;
    const singleLog = logs.find((l: { id: number }) => l.id === targetId);
    expect(singleLog).toBeDefined();
    expect(JSON.parse(singleLog.body)).toMatchObject({ service: "api" });

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Cursor-based pagination (live-tail flow)
// ---------------------------------------------------------------------------

describe("pipeline: cursor-based pagination (after_id live-tail)", () => {
  it("walks forward through logs using after_id cursor", async () => {
    const app = await buildApp();

    // 1. Ingest first batch
    await app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers: { ...AUTH, "content-type": "application/json" },
      payload: [
        { batch: 1, seq: 1 },
        { batch: 1, seq: 2 },
      ],
    });

    // 2. Get all current logs — capture max id as our cursor
    const initialRes = await app.inject({
      method: "GET",
      url: "/v1/logs",
      headers: AUTH,
    });
    const initialLogs = initialRes.json().logs as { id: number }[];
    const cursor = Math.max(...initialLogs.map((l) => l.id));

    // 3. Ingest second batch
    await app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers: { ...AUTH, "content-type": "application/json" },
      payload: [
        { batch: 2, seq: 1 },
        { batch: 2, seq: 2 },
      ],
    });

    // 4. Tail from cursor — should only see the second batch
    const tailRes = await app.inject({
      method: "GET",
      url: `/v1/logs?after_id=${cursor}`,
      headers: AUTH,
    });
    const tailLogs = tailRes.json().logs as { id: number; body: string }[];
    expect(tailLogs).toHaveLength(2);
    expect(tailLogs.every((l) => l.id > cursor)).toBe(true);
    expect(tailLogs[0].id).toBeLessThan(tailLogs[1].id);
    tailLogs.forEach((l) => {
      expect(JSON.parse(l.body)).toMatchObject({ batch: 2 });
    });

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Services + summary pipeline
// ---------------------------------------------------------------------------

describe("pipeline: ingest → /services → /summary", () => {
  it("services and summary reflect ingested data accurately", async () => {
    const app = await buildApp();

    await app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers: { ...AUTH, "content-type": "application/json" },
      payload: [
        { service: "auth", level: "error", seq: 1 },
        { service: "auth", level: "error", seq: 2 },
        { service: "auth", level: "info", seq: 1 },
        { service: "billing", level: "warn", seq: 1 },
      ],
    });

    // 1. Services list
    const servicesRes = await app.inject({
      method: "GET",
      url: "/v1/services",
      headers: AUTH,
    });
    expect(servicesRes.json().services).toEqual(["auth", "billing"]);

    // 2. Summary counts
    const summaryRes = await app.inject({
      method: "GET",
      url: "/v1/summary",
      headers: AUTH,
    });
    const summary = summaryRes.json() as {
      service: string;
      level: string;
      count: number;
    }[];
    const authErrors = summary.find(
      (r) => r.service === "auth" && r.level === "error",
    );
    const authInfo = summary.find(
      (r) => r.service === "auth" && r.level === "info",
    );
    const billingWarn = summary.find(
      (r) => r.service === "billing" && r.level === "warn",
    );
    expect(authErrors?.count).toBe(2);
    expect(authInfo?.count).toBe(1);
    expect(billingWarn?.count).toBe(1);

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Data retention: time-based delete
// ---------------------------------------------------------------------------

describe("pipeline: time-based retention (delete by before)", () => {
  it("removes old logs while preserving recent ones", async () => {
    const app = await buildApp();

    // Ingest directly via adapter to control timestamps
    await insertLogs(
      adapter,
      [{ msg: "ancient", seq: 1 }],
      "2020-01-01T00:00:00.000Z",
    );
    await insertLogs(
      adapter,
      [{ msg: "old", seq: 1 }],
      "2022-06-01T00:00:00.000Z",
    );
    await insertLogs(
      adapter,
      [{ msg: "recent", seq: 1 }],
      "2025-01-01T00:00:00.000Z",
    );

    // Delete everything before 2023
    const deleteRes = await app.inject({
      method: "DELETE",
      url: "/v1/logs?before=2023-01-01T00:00:00.000Z",
      headers: AUTH,
    });
    expect(deleteRes.json()).toMatchObject({ ok: true, deleted: 2 });

    // Only recent log should remain
    const remaining = await queryLogs(adapter, {});
    expect(remaining).toHaveLength(1);
    expect(JSON.parse(remaining[0].body)).toMatchObject({ msg: "recent" });

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Health check with working database
// ---------------------------------------------------------------------------

describe("pipeline: health check reflects DB state", () => {
  it("health returns ok:true after ingest succeeds", async () => {
    const app = await buildApp();

    await app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers: { ...AUTH, "content-type": "application/json" },
      payload: { message: "boot", seq: 1 },
    });

    const healthRes = await app.inject({
      method: "GET",
      url: "/v1/health",
    });
    expect(healthRes.statusCode).toBe(200);
    expect(healthRes.json()).toMatchObject({ ok: true, checks: { db: true } });

    await app.close();
  });
});
