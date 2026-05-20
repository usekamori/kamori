import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "os";
import path from "path";
import { randomBytes } from "crypto";
import fs from "fs";
import { BetterSqliteAdapter } from "@usekamori/core";
import { insertLogs, queryLogs } from "@usekamori/core";
import {
  handleQueryLogs,
  handleSearchLogs,
  handleListServices,
  handleSummarizeErrors,
  handleTailLogs,
  handleGetLog,
  handleAlertSummary,
  handleWatchLogs,
  handleAnomalyHint,
  handleQueryField,
  handleHistogram,
  handleTraceLogs,
  handleQuerySql,
} from "./tools.js";

const originalEnv = { ...process.env };
let dbPath: string;
let adapter: BetterSqliteAdapter;

beforeEach(() => {
  vi.resetModules();
  dbPath = path.join(
    os.tmpdir(),
    `mcp-test-${randomBytes(8).toString("hex")}.db`
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Inserts rows directly via the adapter. */
async function seed(rows: Record<string, unknown>[], ts = "2024-01-01T00:00:00.000Z") {
  return insertLogs(adapter, rows, ts);
}

/** Returns the text content from the first content block of a tool result. */
function text(result: { content: { type: string; text: string }[] }): string {
  return result.content[0].text;
}

// ---------------------------------------------------------------------------
// query_logs
// ---------------------------------------------------------------------------

describe("handleQueryLogs", () => {
  it("returns 'no logs' message when DB is empty", async () => {
    const result = await handleQueryLogs(adapter, {});
    expect(text(result)).toBe("No logs found matching the given filters.");
  });

  it("returns log bodies when logs exist", async () => {
    await seed([{ message: "hello world", seq: 1 }]);
    const result = await handleQueryLogs(adapter, {});
    expect(text(result)).toContain("hello world");
  });

  it("filters by service", async () => {
    await seed([{ service: "api", msg: "a", seq: 1 }, { service: "worker", msg: "b", seq: 1 }]);
    const result = await handleQueryLogs(adapter, { service: "api" });
    expect(text(result)).toContain('"service":"api"');
    expect(text(result)).not.toContain('"service":"worker"');
  });

  it("filters by level", async () => {
    await seed([{ level: "error", seq: 1 }, { level: "info", seq: 1 }]);
    const result = await handleQueryLogs(adapter, { level: "error" });
    expect(text(result)).toContain('"level":"error"');
    expect(text(result)).not.toContain('"level":"info"');
  });

  it("respects limit", async () => {
    await seed([{ seq: 1 }, { seq: 2 }, { seq: 3 }]);
    const result = await handleQueryLogs(adapter, { limit: 1 });
    // Should have exactly one JSON body in the result
    expect(text(result).split("\n")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// search_logs
// ---------------------------------------------------------------------------

describe("handleSearchLogs", () => {
  it("returns 'no matches' message when nothing matches", async () => {
    const result = await handleSearchLogs(adapter, { query: "nonexistent" });
    expect(text(result)).toBe("No logs matched the search query.");
  });

  it("finds matching logs via FTS5", async () => {
    await seed([{ message: "connection refused", seq: 1 }]);
    const result = await handleSearchLogs(adapter, { query: "connection" });
    expect(text(result)).toContain("connection refused");
  });

  it("narrows results with service filter", async () => {
    await seed([
      { service: "api", message: "error", seq: 1 },
      { service: "worker", message: "error", seq: 2 },
    ]);
    const result = await handleSearchLogs(adapter, { query: "error", service: "api" });
    expect(text(result)).toContain('"service":"api"');
    expect(text(result)).not.toContain('"service":"worker"');
  });
});

// ---------------------------------------------------------------------------
// list_services
// ---------------------------------------------------------------------------

describe("handleListServices", () => {
  it("returns 'no services' message when DB is empty", async () => {
    const result = await handleListServices(adapter);
    expect(text(result)).toContain("No services found");
  });

  it("lists distinct service names", async () => {
    await seed([{ service: "api", seq: 1 }, { service: "worker", seq: 1 }]);
    const result = await handleListServices(adapter);
    expect(text(result)).toContain("api");
    expect(text(result)).toContain("worker");
  });
});

// ---------------------------------------------------------------------------
// summarize_errors
// ---------------------------------------------------------------------------

describe("handleSummarizeErrors", () => {
  it("returns 'no data' message when DB is empty", async () => {
    const result = await handleSummarizeErrors(adapter, {});
    expect(text(result)).toBe("No log data found.");
  });

  it("formats service/level/count rows", async () => {
    await seed([
      { service: "api", level: "error", seq: 1 },
      { service: "api", level: "error", seq: 2 },
    ]);
    const result = await handleSummarizeErrors(adapter, {});
    expect(text(result)).toMatch(/service=api\s+level=error\s+count=2/);
  });

  it("respects since filter", async () => {
    await seed([{ service: "api", level: "error", seq: 1 }], "2022-01-01T00:00:00.000Z");
    await seed([{ service: "api", level: "error", seq: 2 }], "2025-01-01T00:00:00.000Z");
    const result = await handleSummarizeErrors(adapter, { since: "2024-01-01T00:00:00.000Z" });
    expect(text(result)).toMatch(/count=1/);
  });
});

// ---------------------------------------------------------------------------
// tail_logs
// ---------------------------------------------------------------------------

describe("handleTailLogs", () => {
  it("returns 'no new logs' when nothing newer than after_id", async () => {
    await seed([{ seq: 1 }]);
    // Find max id
    const rows = await queryLogs(adapter, {});
    const maxId = Math.max(...rows.map((r) => r.id));
    const result = await handleTailLogs(adapter, { after_id: maxId });
    expect(text(result)).toContain("No new logs");
    expect(text(result)).toContain(`last_id=${maxId}`);
  });

  it("returns newer rows oldest-first with last_id", async () => {
    await seed([{ seq: 1 }, { seq: 2 }, { seq: 3 }]);
    const rows = await queryLogs(adapter, {});
    const minId = Math.min(...rows.map((r) => r.id));
    const result = await handleTailLogs(adapter, { after_id: minId });
    const t = text(result);
    expect(t).toContain("2 new log(s)");
    expect(t).toContain("last_id=");
  });

  it("uses FTS search when query is provided", async () => {
    await seed([{ message: "timeout error", seq: 1 }, { message: "all good", seq: 2 }]);
    const result = await handleTailLogs(adapter, { after_id: 0, query: "timeout" });
    expect(text(result)).toContain("timeout error");
    expect(text(result)).not.toContain("all good");
  });
});

// ---------------------------------------------------------------------------
// get_log
// ---------------------------------------------------------------------------

describe("handleGetLog", () => {
  it("returns the log body for a valid id", async () => {
    await seed([{ message: "findme", seq: 1 }]);
    const [row] = await queryLogs(adapter, {});
    const result = await handleGetLog(adapter, { id: row.id });
    expect(text(result)).toContain("findme");
  });

  it("returns not-found message for a missing id", async () => {
    const result = await handleGetLog(adapter, { id: 999999 });
    expect(text(result)).toContain("Log id=999999 not found.");
  });
});

// ---------------------------------------------------------------------------
// alert_summary
// ---------------------------------------------------------------------------

describe("handleAlertSummary", () => {
  it("returns 0 when no matching logs in the window", async () => {
    const result = await handleAlertSummary(adapter, { minutes: 60 });
    expect(text(result)).toContain("0 matching log entries");
  });

  it("counts error-level logs in recent window", async () => {
    // Insert logs with a recent timestamp (now)
    const now = new Date().toISOString();
    await seed([{ level: "error", seq: 1 }, { level: "error", seq: 2 }], now);
    const result = await handleAlertSummary(adapter, { minutes: 60 });
    expect(text(result)).toContain("2 matching log entries");
  });

  it("uses FTS search when query is provided", async () => {
    const now = new Date().toISOString();
    await seed([{ message: "crash detected", seq: 1 }], now);
    const result = await handleAlertSummary(adapter, { minutes: 60, query: "crash" });
    expect(text(result)).toContain("1 matching log entries");
  });

  it("uses level filter when no query", async () => {
    const now = new Date().toISOString();
    await seed([{ level: "warn", seq: 1 }, { level: "error", seq: 2 }], now);
    const warnResult = await handleAlertSummary(adapter, { minutes: 60, level: "warn" });
    expect(text(warnResult)).toContain("1 matching log entries");
  });
});

// ---------------------------------------------------------------------------
// watch_logs
// ---------------------------------------------------------------------------

describe("handleWatchLogs", () => {
  it("returns immediately when logs exist after after_id", async () => {
    await seed([{ seq: 1 }]);
    const result = await handleWatchLogs(adapter, { after_id: 0, timeout_seconds: 1 });
    expect(text(result)).toContain("1 new log(s)");
  });

  it("times out and returns last_id when no new logs arrive", async () => {
    await seed([{ seq: 1 }]);
    const [row] = await queryLogs(adapter, {});
    const result = await handleWatchLogs(adapter, {
      after_id: row.id,
      timeout_seconds: 1, // fast timeout for tests
    });
    const t = text(result);
    expect(t).toContain("No new logs");
    expect(t).toContain(`last_id=${row.id}`);
  }, 5000); // allow up to 5s for the 1s timeout
});

// ---------------------------------------------------------------------------
// query_field
// ---------------------------------------------------------------------------

describe("handleQueryField", () => {
  it("returns 'no logs' message when nothing matches", async () => {
    const result = await handleQueryField(adapter, {
      field: "statusCode",
      op: "=",
      value: 500,
    });
    expect(text(result)).toContain("No logs found");
  });

  it("filters by exact field value (string)", async () => {
    await seed([{ userId: "u_123", level: "error", seq: 1 }]);
    await seed([{ userId: "u_456", level: "error", seq: 2 }]);
    const result = await handleQueryField(adapter, {
      field: "userId",
      op: "=",
      value: "u_123",
    });
    expect(text(result)).toContain("u_123");
    expect(text(result)).not.toContain("u_456");
  });

  it("filters by numeric comparison (>)", async () => {
    await seed([{ ms: 100, seq: 1 }]);
    await seed([{ ms: 800, seq: 2 }]);
    const result = await handleQueryField(adapter, {
      field: "ms",
      op: ">",
      value: 500,
    });
    expect(text(result)).toContain('"ms":800');
    expect(text(result)).not.toContain('"ms":100');
  });

  it("filters by != operator", async () => {
    await seed([{ statusCode: 200, seq: 1 }]);
    await seed([{ statusCode: 500, seq: 2 }]);
    const result = await handleQueryField(adapter, {
      field: "statusCode",
      op: "!=",
      value: 200,
    });
    expect(text(result)).toContain('"statusCode":500');
    expect(text(result)).not.toContain('"statusCode":200');
  });

  it("returns error message for invalid field name", async () => {
    const result = await handleQueryField(adapter, {
      field: "bad field!",
      op: "=",
      value: "x",
    });
    expect(text(result)).toContain("Error:");
  });

  it("respects service filter", async () => {
    await seed([{ service: "api", ms: 900, seq: 1 }]);
    await seed([{ service: "worker", ms: 900, seq: 2 }]);
    const result = await handleQueryField(adapter, {
      field: "ms",
      op: ">",
      value: 500,
      service: "api",
    });
    expect(text(result)).toContain('"service":"api"');
    expect(text(result)).not.toContain('"service":"worker"');
  });

  it("respects limit", async () => {
    await seed([{ ms: 600, seq: 1 }, { ms: 700, seq: 2 }, { ms: 800, seq: 3 }]);
    const result = await handleQueryField(adapter, {
      field: "ms",
      op: ">",
      value: 500,
      limit: 1,
    });
    expect(text(result).split("\n")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// histogram
// ---------------------------------------------------------------------------

describe("handleHistogram", () => {
  it("returns 'no data' message when DB is empty", async () => {
    const result = await handleHistogram(adapter, { bucket: "1h" });
    expect(text(result)).toContain("No log data found");
  });

  it("returns bucket lines with counts", async () => {
    const ts = "2024-06-01T10:00:00.000Z";
    await seed([{ seq: 1 }, { seq: 2 }], ts);
    const result = await handleHistogram(adapter, { bucket: "1h", since: "2024-01-01T00:00:00Z" });
    const t = text(result);
    expect(t).toContain("count=2");
    expect(t).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/);
  });

  it("separates events into distinct buckets", async () => {
    await seed([{ seq: 1 }], "2024-06-01T10:00:00.000Z");
    await seed([{ seq: 2 }], "2024-06-01T12:00:00.000Z");
    const result = await handleHistogram(adapter, { bucket: "1h", since: "2024-01-01T00:00:00Z" });
    const lines = text(result).split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("count=1");
    expect(lines[1]).toContain("count=1");
  });

  it("groups events in the same bucket", async () => {
    await seed([{ seq: 1 }], "2024-06-01T10:05:00.000Z");
    await seed([{ seq: 2 }], "2024-06-01T10:45:00.000Z");
    const result = await handleHistogram(adapter, { bucket: "1h", since: "2024-01-01T00:00:00Z" });
    // Both events fall in the 10:00 bucket
    const lines = text(result).split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("count=2");
  });

  it("returns buckets in chronological order", async () => {
    await seed([{ seq: 1 }], "2024-06-01T12:00:00.000Z");
    await seed([{ seq: 2 }], "2024-06-01T10:00:00.000Z");
    const result = await handleHistogram(adapter, { bucket: "1h", since: "2024-01-01T00:00:00Z" });
    const lines = text(result).split("\n");
    expect(lines[0] < lines[1]).toBe(true); // ISO timestamps sort lexicographically
  });

  it("respects service filter", async () => {
    const ts = "2024-06-01T10:00:00.000Z";
    await seed([{ service: "api", seq: 1 }], ts);
    await seed([{ service: "worker", seq: 2 }], ts);
    const result = await handleHistogram(adapter, { bucket: "1h", since: "2024-01-01T00:00:00Z", service: "api" });
    expect(text(result)).toContain("count=1");
  });

  it("respects level filter", async () => {
    const ts = "2024-06-01T10:00:00.000Z";
    await seed([{ level: "error", seq: 1 }], ts);
    await seed([{ level: "info", seq: 2 }], ts);
    const result = await handleHistogram(adapter, { bucket: "1h", since: "2024-01-01T00:00:00Z", level: "error" });
    expect(text(result)).toContain("count=1");
  });

  it("supports 5m bucket", async () => {
    await seed([{ seq: 1 }], "2024-06-01T10:00:00.000Z");
    await seed([{ seq: 2 }], "2024-06-01T10:06:00.000Z");
    const result = await handleHistogram(adapter, { bucket: "5m", since: "2024-01-01T00:00:00Z" });
    const lines = text(result).split("\n");
    expect(lines).toHaveLength(2);
  });

  it("defaults since to 7 days ago — excludes data older than 7 days", async () => {
    // Old event: 8 days ago — must be excluded by the default window
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    // Recent event: 1 hour ago — must be included
    const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await seed([{ seq: 1 }], old);
    await seed([{ seq: 2 }], recent);
    // No explicit since — default 7-day window applies
    const result = await handleHistogram(adapter, { bucket: "1h" });
    const t = text(result);
    expect(t).toContain("count=1"); // only the recent event
    expect(t).not.toContain("count=2");
  });

  it("explicit since overrides the 7-day default", async () => {
    // Both events are older than 7 days
    const old1 = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const old2 = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000).toISOString();
    await seed([{ seq: 1 }], old1);
    await seed([{ seq: 2 }], old2);
    // Pass an explicit since that covers both events
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const result = await handleHistogram(adapter, { bucket: "1d", since });
    expect(text(result)).not.toContain("No log data found");
  });
});

// ---------------------------------------------------------------------------
// trace_logs
// ---------------------------------------------------------------------------

describe("handleTraceLogs", () => {
  it("returns 'no logs' message when trace not found", async () => {
    const result = await handleTraceLogs(adapter, { trace_id: "nonexistent" });
    expect(text(result)).toContain('No logs found for trace_id="nonexistent"');
  });

  it("returns all events for a trace_id", async () => {
    await seed([
      { trace_id: "trace-abc", service: "api", message: "request received", seq: 1 },
      { trace_id: "trace-abc", service: "db", message: "query executed", seq: 2 },
      { trace_id: "trace-xyz", service: "api", message: "other trace", seq: 3 },
    ]);
    const result = await handleTraceLogs(adapter, { trace_id: "trace-abc" });
    const t = text(result);
    expect(t).toContain("request received");
    expect(t).toContain("query executed");
    expect(t).not.toContain("other trace");
  });

  it("returns events in chronological order", async () => {
    await seed([{ trace_id: "t1", step: 1, seq: 1 }], "2024-01-01T10:00:00.000Z");
    await seed([{ trace_id: "t1", step: 2, seq: 2 }], "2024-01-01T10:01:00.000Z");
    const result = await handleTraceLogs(adapter, { trace_id: "t1" });
    const lines = text(result).split("\n");
    const first = JSON.parse(lines[0]);
    const second = JSON.parse(lines[1]);
    expect(first.step).toBe(1);
    expect(second.step).toBe(2);
  });

  it("respects limit", async () => {
    await seed([
      { trace_id: "t2", seq: 1 },
      { trace_id: "t2", seq: 2 },
      { trace_id: "t2", seq: 3 },
    ]);
    const result = await handleTraceLogs(adapter, { trace_id: "t2", limit: 2 });
    expect(text(result).split("\n")).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// query_sql
// ---------------------------------------------------------------------------

describe("handleQuerySql", () => {
  it("rejects non-SELECT statements", async () => {
    const result = await handleQuerySql(adapter, { sql: "DELETE FROM logs" });
    expect(text(result)).toContain("Error: only SELECT statements are allowed.");
  });

  it("rejects statements with semicolons", async () => {
    const result = await handleQuerySql(adapter, {
      sql: "SELECT 1; SELECT 2",
    });
    expect(text(result)).toContain("Error: semicolons are not allowed");
  });

  it("returns 'no rows' when query matches nothing", async () => {
    const result = await handleQuerySql(adapter, {
      sql: "SELECT * FROM logs WHERE 1=0",
    });
    expect(text(result)).toBe("Query returned no rows.");
  });

  it("executes a valid SELECT and returns JSON rows", async () => {
    await seed([{ service: "api", level: "error", seq: 1 }]);
    const result = await handleQuerySql(adapter, {
      sql: "SELECT service, level FROM logs",
    });
    const t = text(result);
    expect(t).toContain('"service":"api"');
    expect(t).toContain('"level":"error"');
  });

  it("supports aggregation queries", async () => {
    await seed([
      { service: "api", level: "error", seq: 1 },
      { service: "api", level: "error", seq: 2 },
      { service: "worker", level: "error", seq: 3 },
    ]);
    const result = await handleQuerySql(adapter, {
      sql: "SELECT service, COUNT(*) as n FROM logs GROUP BY service ORDER BY n DESC",
    });
    const lines = text(result).split("\n");
    const first = JSON.parse(lines[0]);
    expect(first.service).toBe("api");
    expect(first.n).toBe(2);
  });

  it("rejects queries referencing tables outside the allowlist", async () => {
    const result = await handleQuerySql(adapter, {
      sql: "SELECT * FROM sqlite_master",
    });
    expect(text(result)).toContain("Error: query references disallowed table(s): sqlite_master");
  });

  it("rejects queries referencing multiple disallowed tables", async () => {
    const result = await handleQuerySql(adapter, {
      sql: "SELECT * FROM logs JOIN sqlite_sequence ON 1=1",
    });
    expect(text(result)).toContain("sqlite_sequence");
  });

  it("allows queries joining logs_fts", async () => {
    await seed([{ service: "api", level: "info", seq: 1 }]);
    const result = await handleQuerySql(adapter, {
      sql: "SELECT l.service FROM logs l JOIN logs_fts ON logs_fts.rowid = l.id WHERE logs_fts MATCH 'api'",
    });
    expect(text(result)).not.toContain("Error:");
  });

  it("returns SQL error message on invalid query", async () => {
    const result = await handleQuerySql(adapter, {
      sql: "SELECT nosuchfunc() FROM logs",
    });
    expect(text(result)).toContain("SQL error:");
  });

  it("respects limit parameter", async () => {
    await seed([{ seq: 1 }, { seq: 2 }, { seq: 3 }, { seq: 4 }, { seq: 5 }]);
    const result = await handleQuerySql(adapter, {
      sql: "SELECT * FROM logs",
      limit: 2,
    });
    expect(text(result).split("\n")).toHaveLength(2);
  });

  it("accepts SELECT with leading whitespace", async () => {
    await seed([{ seq: 1 }]);
    const result = await handleQuerySql(adapter, {
      sql: "  SELECT id FROM logs",
    });
    expect(text(result)).not.toContain("Error:");
  });
});

// ---------------------------------------------------------------------------
// anomaly_hint
// ---------------------------------------------------------------------------

describe("handleAnomalyHint", () => {
  it("returns all-clear when no logs exist", async () => {
    const result = await handleAnomalyHint(adapter, {});
    expect(text(result)).toContain("All clear.");
    expect(text(result)).toContain("spike_factor   : 1.0");
  });

  it("reports ∞ spike when recent errors exist but no baseline", async () => {
    const now = new Date().toISOString();
    await seed([{ level: "error", seq: 1 }], now);
    const result = await handleAnomalyHint(adapter, { window_minutes: 60 });
    const t = text(result);
    expect(t).toContain("spike_factor   : ∞");
    expect(t).toContain("No baseline data");
  });

  it("includes counts and rates in output", async () => {
    const result = await handleAnomalyHint(adapter, { window_minutes: 60 });
    const t = text(result);
    expect(t).toContain("recent_count");
    expect(t).toContain("baseline_count");
    expect(t).toContain("recent_rate");
    expect(t).toContain("baseline_rate");
    expect(t).toContain("spike_factor");
  });

  it("respects service and level parameters", async () => {
    const result = await handleAnomalyHint(adapter, {
      window_minutes: 60,
      service: "api",
      level: "warn",
    });
    const t = text(result);
    expect(t).toContain("service=api");
    expect(t).toContain("level=warn");
  });
});
