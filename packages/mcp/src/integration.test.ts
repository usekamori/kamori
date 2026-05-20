/**
 * Integration tests — MCP tools against real DB.
 *
 * Tests multi-tool flows to verify that tools work correctly in combination,
 * sharing the same database and producing consistent results.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { BetterSqliteAdapter, insertLogs, queryLogs } from "@usekamori/core";
import {
  handleListServices,
  handleQueryLogs,
  handleGetLog,
  handleSearchLogs,
  handleTailLogs,
  handleAlertSummary,
  handleAnomalyHint,
  handleSummarizeErrors,
} from "./tools.js";

const originalEnv = { ...process.env };
let dbPath: string;
let adapter: BetterSqliteAdapter;

beforeEach(() => {
  vi.resetModules();
  dbPath = path.join(
    os.tmpdir(),
    `mcp-integration-${randomBytes(8).toString("hex")}.db`,
  );
  process.env.DB_PATH = dbPath;
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

function text(result: { content: { type: string; text: string }[] }): string {
  return result.content[0].text;
}

async function seed(rows: Record<string, unknown>[], ts?: string) {
  return insertLogs(adapter, rows, ts ?? new Date().toISOString());
}

// ---------------------------------------------------------------------------
// Flow: list_services → query_logs → get_log
// ---------------------------------------------------------------------------

describe("flow: list_services → query_logs → get_log", () => {
  it("discovers services, queries logs for one, then fetches a specific log", async () => {
    await seed([
      { service: "api", level: "error", message: "db conn failed", seq: 1 },
      { service: "api", level: "info", message: "server started", seq: 2 },
      { service: "worker", level: "warn", message: "queue slow", seq: 1 },
    ]);

    // 1. Discover available services
    const servicesResult = await handleListServices(adapter);
    const services = text(servicesResult).split("\n");
    expect(services).toContain("api");
    expect(services).toContain("worker");

    // 2. Query logs for the api service
    const queryResult = await handleQueryLogs(adapter, { service: "api" });
    const queryText = text(queryResult);
    expect(queryText).toContain("db conn failed");
    expect(queryText).not.toContain("queue slow");

    // 3. Get a specific log by id
    const apiLogs = await queryLogs(adapter, {
      service: "api",
      level: "error",
    });
    expect(apiLogs).toHaveLength(1);
    const getResult = await handleGetLog(adapter, { id: apiLogs[0].id });
    expect(text(getResult)).toContain("db conn failed");
  });
});

// ---------------------------------------------------------------------------
// Flow: search_logs → tail_logs (cursor continuation)
// ---------------------------------------------------------------------------

describe("flow: search_logs → tail_logs cursor continuation", () => {
  it("searches for logs, then uses tail_logs to get subsequent entries", async () => {
    const ts = "2024-01-01T00:00:00.000Z";
    await seed(
      [
        { message: "timeout on /api/users", seq: 1 },
        { message: "timeout on /api/orders", seq: 2 },
        { message: "success response", seq: 3 },
      ],
      ts,
    );

    // 1. Find timeout logs
    const searchResult = await handleSearchLogs(adapter, { query: "timeout" });
    expect(text(searchResult)).toContain("timeout on /api/users");
    expect(text(searchResult)).toContain("timeout on /api/orders");
    expect(text(searchResult)).not.toContain("success response");

    // 2. Get the last known id from all logs
    const all = await queryLogs(adapter, {});
    const maxId = Math.max(...all.map((r) => r.id));

    // 3. Seed more logs and use tail_logs to get them
    await seed([{ message: "timeout on /api/payments", seq: 4 }]);
    const tailResult = await handleTailLogs(adapter, { after_id: maxId });
    expect(text(tailResult)).toContain("1 new log(s)");
    expect(text(tailResult)).toContain("timeout on /api/payments");
  });
});

// ---------------------------------------------------------------------------
// Flow: alert_summary → anomaly_hint (consistency)
// ---------------------------------------------------------------------------

describe("flow: alert_summary → anomaly_hint consistency", () => {
  it("alert_summary count is consistent with anomaly_hint recent_count", async () => {
    const now = new Date().toISOString();
    await seed(
      [
        { level: "error", seq: 1 },
        { level: "error", seq: 2 },
        { level: "error", seq: 3 },
      ],
      now,
    );

    // 1. Get alert count for last 60 minutes
    const alertResult = await handleAlertSummary(adapter, {
      minutes: 60,
      level: "error",
    });
    const alertText = text(alertResult);
    expect(alertText).toContain("3 matching log entries");

    // 2. Anomaly hint should show the same recent count
    const anomalyResult = await handleAnomalyHint(adapter, {
      window_minutes: 60,
      level: "error",
    });
    const anomalyText = text(anomalyResult);
    expect(anomalyText).toContain("recent_count   : 3");
    // No baseline → spike factor should be ∞
    expect(anomalyText).toContain("spike_factor   : ∞");
  });
});

// ---------------------------------------------------------------------------
// Flow: summarize_errors → query_logs drilling in
// ---------------------------------------------------------------------------

describe("flow: summarize_errors → drill-down with query_logs", () => {
  it("uses summarize to find hotspot, then queries that service/level", async () => {
    await seed([
      { service: "payments", level: "error", seq: 1 },
      { service: "payments", level: "error", seq: 2 },
      { service: "payments", level: "error", seq: 3 },
      { service: "auth", level: "error", seq: 1 },
    ]);

    // 1. Get summary to find the noisiest service+level
    const summaryResult = await handleSummarizeErrors(adapter, {});
    const summaryText = text(summaryResult);
    expect(summaryText).toMatch(/service=payments\s+level=error\s+count=3/);

    // 2. Drill down into payments errors
    const drillResult = await handleQueryLogs(adapter, {
      service: "payments",
      level: "error",
    });
    const drillText = text(drillResult);
    expect(drillText).toContain('"service":"payments"');
    expect(drillText).toContain('"level":"error"');
    expect(drillText.split("\n")).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Flow: FTS search with tail continuation
// ---------------------------------------------------------------------------

describe("flow: tail_logs FTS-scoped continuation", () => {
  it("tails only crash-related logs using FTS query filter", async () => {
    const ts1 = "2024-01-01T00:00:00.000Z";
    await seed(
      [
        { message: "crash in payment handler", seq: 1 },
        { message: "normal request", seq: 2 },
      ],
      ts1,
    );

    // 1. Tail from beginning with FTS filter for "crash"
    const firstTail = await handleTailLogs(adapter, {
      after_id: 0,
      query: "crash",
    });
    const t1 = text(firstTail);
    expect(t1).toContain("1 new log(s)");
    expect(t1).toContain("crash in payment handler");
    expect(t1).not.toContain("normal request");

    // 2. Extract last_id from result
    const lastIdMatch = t1.match(/last_id=(\d+)/);
    expect(lastIdMatch).not.toBeNull();
    const lastId = parseInt(lastIdMatch![1], 10);

    // 3. Seed another crash log
    await seed([{ message: "crash in auth handler", seq: 3 }]);

    // 4. Continue from last_id — should only get the new crash
    const secondTail = await handleTailLogs(adapter, {
      after_id: lastId,
      query: "crash",
    });
    const t2 = text(secondTail);
    expect(t2).toContain("1 new log(s)");
    expect(t2).toContain("crash in auth handler");
  });
});
