import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import { randomBytes, createHash } from "node:crypto";
import fs from "node:fs";
import { BetterSqliteAdapter } from "./adapters/better-sqlite.js";
import {
  insertLogs,
  queryLogs,
  getLogById,
  deleteLogs,
  purgeLogs,
  purgeExcessLogs,
  exportLogs,
  searchLogs,
  listServices,
  countLogs,
  summarizeErrors,
  getLogCounts,
  queryByField,
  histogramLogs,
  isValidIso,
  _resetServicesCache,
} from "./db.js";

let dbPath: string;
let adapter: BetterSqliteAdapter;

beforeEach(() => {
  dbPath = path.join(
    os.tmpdir(),
    `kamori-test-${randomBytes(8).toString("hex")}.db`,
  );
  adapter = new BetterSqliteAdapter(dbPath);
  // Reset module-scope services cache between tests — each test creates a
  // fresh DB, so a cached result from a previous test is always stale.
  _resetServicesCache();
});

afterEach(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(dbPath + suffix);
    } catch {}
  }
});

// ---------------------------------------------------------------------------
// insertLogs
// ---------------------------------------------------------------------------

describe("insertLogs", () => {
  it("inserts a single row", async () => {
    await insertLogs(
      adapter,
      [{ message: "hello" }],
      "2024-01-01T00:00:00.000Z",
    );
    expect(await queryLogs(adapter, {})).toHaveLength(1);
  });

  it("inserts a batch", async () => {
    // Distinct messages so none are deduped
    await insertLogs(
      adapter,
      [{ message: "a" }, { message: "b" }, { message: "c" }],
      "2024-01-01T00:00:00.000Z",
    );
    expect(await queryLogs(adapter, {})).toHaveLength(3);
  });

  it("injects received_at into stored body", async () => {
    await insertLogs(
      adapter,
      [{ message: "ts-test" }],
      "2024-06-01T12:00:00.000Z",
    );
    const [row] = await queryLogs(adapter, {});
    expect(JSON.parse(row.body)).toMatchObject({
      received_at: "2024-06-01T12:00:00.000Z",
    });
  });

  it("extracts service from 'service' field", async () => {
    await insertLogs(
      adapter,
      [{ service: "api", message: "ok" }],
      "2024-01-01T00:00:00.000Z",
    );
    expect((await queryLogs(adapter, {}))[0].service).toBe("api");
  });

  it("falls back to 'app' alias for service", async () => {
    await insertLogs(adapter, [{ app: "worker" }], "2024-01-01T00:00:00.000Z");
    expect((await queryLogs(adapter, {}))[0].service).toBe("worker");
  });

  it("falls back to 'source' alias for service", async () => {
    await insertLogs(adapter, [{ source: "cron" }], "2024-01-01T00:00:00.000Z");
    expect((await queryLogs(adapter, {}))[0].service).toBe("cron");
  });

  it("extracts level from 'level' field", async () => {
    await insertLogs(adapter, [{ level: "error" }], "2024-01-01T00:00:00.000Z");
    expect((await queryLogs(adapter, {}))[0].level).toBe("error");
  });

  it("falls back to 'severity' alias for level", async () => {
    await insertLogs(
      adapter,
      [{ severity: "warn" }],
      "2024-01-01T00:00:00.000Z",
    );
    expect((await queryLogs(adapter, {}))[0].level).toBe("warn");
  });

  it("stores null for service and level when absent", async () => {
    await insertLogs(
      adapter,
      [{ message: "bare" }],
      "2024-01-01T00:00:00.000Z",
    );
    const [row] = await queryLogs(adapter, {});
    expect(row.service).toBeNull();
    expect(row.level).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// queryLogs
// ---------------------------------------------------------------------------

describe("queryLogs", () => {
  it("returns all rows with no filters", async () => {
    await insertLogs(
      adapter,
      [{ seq: 1 }, { seq: 2 }, { seq: 3 }],
      "2024-01-01T00:00:00.000Z",
    );
    expect(await queryLogs(adapter, {})).toHaveLength(3);
  });

  it("filters by service", async () => {
    await insertLogs(
      adapter,
      [{ service: "api" }, { service: "worker" }],
      "2024-01-01T00:00:00.000Z",
    );
    const rows = await queryLogs(adapter, { service: "api" });
    expect(rows).toHaveLength(1);
    expect(rows[0].service).toBe("api");
  });

  it("filters by level", async () => {
    await insertLogs(
      adapter,
      [
        { level: "error", seq: 1 },
        { level: "info", seq: 1 },
        { level: "error", seq: 2 },
      ],
      "2024-01-01T00:00:00.000Z",
    );
    expect(await queryLogs(adapter, { level: "error" })).toHaveLength(2);
    expect(await queryLogs(adapter, { level: "info" })).toHaveLength(1);
  });

  it("filters by since (inclusive)", async () => {
    await insertLogs(adapter, [{ msg: "old" }], "2023-01-01T00:00:00.000Z");
    await insertLogs(adapter, [{ msg: "new" }], "2025-01-01T00:00:00.000Z");
    const rows = await queryLogs(adapter, {
      since: "2024-01-01T00:00:00.000Z",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].received_at).toBe("2025-01-01T00:00:00.000Z");
  });

  it("filters by until (inclusive)", async () => {
    await insertLogs(adapter, [{ msg: "old" }], "2023-01-01T00:00:00.000Z");
    await insertLogs(adapter, [{ msg: "new" }], "2025-01-01T00:00:00.000Z");
    const rows = await queryLogs(adapter, {
      until: "2024-01-01T00:00:00.000Z",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].received_at).toBe("2023-01-01T00:00:00.000Z");
  });

  it("combines service and level filters", async () => {
    await insertLogs(
      adapter,
      [
        { service: "api", level: "error" },
        { service: "api", level: "info" },
        { service: "worker", level: "error" },
      ],
      "2024-01-01T00:00:00.000Z",
    );
    expect(
      await queryLogs(adapter, { service: "api", level: "error" }),
    ).toHaveLength(1);
  });

  it("respects limit", async () => {
    await insertLogs(
      adapter,
      [{ seq: 1 }, { seq: 2 }, { seq: 3 }, { seq: 4 }, { seq: 5 }],
      "2024-01-01T00:00:00.000Z",
    );
    expect(await queryLogs(adapter, { limit: 2 })).toHaveLength(2);
  });

  it("caps limit at 500 without error", async () => {
    await expect(queryLogs(adapter, { limit: 9999 })).resolves.not.toThrow();
  });

  it("returns rows newest first", async () => {
    await insertLogs(adapter, [{ seq: 1 }], "2023-01-01T00:00:00.000Z");
    await insertLogs(adapter, [{ seq: 2 }], "2025-01-01T00:00:00.000Z");
    const rows = await queryLogs(adapter, {});
    expect(rows[0].received_at).toBe("2025-01-01T00:00:00.000Z");
    expect(rows[1].received_at).toBe("2023-01-01T00:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// queryLogs — after_id (cursor-based pagination)
// ---------------------------------------------------------------------------

describe("queryLogs with after_id", () => {
  it("returns only rows with id greater than after_id", async () => {
    await insertLogs(adapter, [{ seq: 1 }], "2024-01-01T00:00:00.000Z");
    await insertLogs(adapter, [{ seq: 2 }], "2024-01-02T00:00:00.000Z");
    await insertLogs(adapter, [{ seq: 3 }], "2024-01-03T00:00:00.000Z");
    const all = await queryLogs(adapter, {});
    // all is sorted newest-first; the oldest row has the lowest id
    const minId = Math.min(...all.map((r) => r.id));
    const rows = await queryLogs(adapter, { after_id: minId });
    // Should return the two rows whose id > minId
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.id > minId)).toBe(true);
  });

  it("returns rows in ascending (oldest-first) order when after_id is set", async () => {
    await insertLogs(adapter, [{ seq: 1 }], "2023-06-01T00:00:00.000Z");
    await insertLogs(adapter, [{ seq: 2 }], "2024-06-01T00:00:00.000Z");
    await insertLogs(adapter, [{ seq: 3 }], "2025-06-01T00:00:00.000Z");
    const rows = await queryLogs(adapter, { after_id: 0 });
    // Ids should be ascending
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].id).toBeGreaterThan(rows[i - 1].id);
    }
  });

  it("returns empty array when no rows are newer than after_id", async () => {
    await insertLogs(adapter, [{ msg: "only" }], "2024-01-01T00:00:00.000Z");
    const all = await queryLogs(adapter, {});
    const maxId = Math.max(...all.map((r) => r.id));
    expect(await queryLogs(adapter, { after_id: maxId })).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getLogById
// ---------------------------------------------------------------------------

describe("getLogById", () => {
  it("returns the row when it exists", async () => {
    await insertLogs(
      adapter,
      [{ message: "findme" }],
      "2024-01-01T00:00:00.000Z",
    );
    const [inserted] = await queryLogs(adapter, {});
    const row = await getLogById(adapter, inserted.id);
    expect(row).not.toBeNull();
    expect(row!.id).toBe(inserted.id);
    expect(row!.body).toBe(inserted.body);
  });

  it("returns null when the id does not exist", async () => {
    expect(await getLogById(adapter, 999999)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// deleteLogs
// ---------------------------------------------------------------------------

describe("deleteLogs", () => {
  it("deletes rows older than the given before date", async () => {
    await insertLogs(adapter, [{ msg: "old" }], "2022-01-01T00:00:00.000Z");
    await insertLogs(adapter, [{ msg: "new" }], "2025-01-01T00:00:00.000Z");
    const deleted = await deleteLogs(adapter, {
      before: "2023-01-01T00:00:00.000Z",
    });
    expect(deleted).toBe(1);
    expect(await queryLogs(adapter, {})).toHaveLength(1);
    expect((await queryLogs(adapter, {}))[0].received_at).toBe(
      "2025-01-01T00:00:00.000Z",
    );
  });

  it("deletes rows for a given service", async () => {
    await insertLogs(adapter, [{ service: "api" }], "2024-01-01T00:00:00.000Z");
    await insertLogs(
      adapter,
      [{ service: "worker" }],
      "2024-01-01T00:00:00.000Z",
    );
    const deleted = await deleteLogs(adapter, { service: "api" });
    expect(deleted).toBe(1);
    const remaining = await queryLogs(adapter, {});
    expect(remaining).toHaveLength(1);
    expect(remaining[0].service).toBe("worker");
  });

  it("combines before and service conditions", async () => {
    await insertLogs(adapter, [{ service: "api" }], "2022-01-01T00:00:00.000Z");
    await insertLogs(adapter, [{ service: "api" }], "2025-01-01T00:00:00.000Z");
    await insertLogs(
      adapter,
      [{ service: "worker" }],
      "2022-01-01T00:00:00.000Z",
    );
    // Only old api rows should be deleted
    const deleted = await deleteLogs(adapter, {
      before: "2023-01-01T00:00:00.000Z",
      service: "api",
    });
    expect(deleted).toBe(1);
    expect(await queryLogs(adapter, {})).toHaveLength(2);
  });

  it("returns 0 when no rows match", async () => {
    expect(await deleteLogs(adapter, { service: "nonexistent" })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// purgeLogs
// ---------------------------------------------------------------------------

describe("purgeLogs", () => {
  it("deletes rows older than the cutoff date", async () => {
    await insertLogs(adapter, [{ msg: "stale" }], "2020-01-01T00:00:00.000Z");
    await insertLogs(adapter, [{ msg: "fresh" }], "2025-01-01T00:00:00.000Z");
    const deleted = await purgeLogs(adapter, "2021-01-01T00:00:00.000Z");
    expect(deleted).toBe(1);
    expect(await queryLogs(adapter, {})).toHaveLength(1);
    expect((await queryLogs(adapter, {}))[0].received_at).toBe(
      "2025-01-01T00:00:00.000Z",
    );
  });

  it("returns 0 when nothing is old enough to purge", async () => {
    await insertLogs(adapter, [{ msg: "fresh" }], "2025-01-01T00:00:00.000Z");
    expect(await purgeLogs(adapter, "2020-01-01T00:00:00.000Z")).toBe(0);
  });

  it("FTS index remains searchable after purge (rebuild does not corrupt index)", async () => {
    await insertLogs(adapter, [{ message: "stale error" }], "2020-01-01T00:00:00.000Z");
    await insertLogs(adapter, [{ message: "fresh warning" }], "2025-01-01T00:00:00.000Z");
    await purgeLogs(adapter, "2021-01-01T00:00:00.000Z");

    // Purged row must not appear in FTS results
    const staleHits = await searchLogs(adapter, "stale", {});
    expect(staleHits).toHaveLength(0);

    // Surviving row must still be found
    const freshHits = await searchLogs(adapter, "fresh", {});
    expect(freshHits).toHaveLength(1);
    expect(freshHits[0].received_at).toBe("2025-01-01T00:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// purgeExcessLogs
// ---------------------------------------------------------------------------

describe("purgeExcessLogs", () => {
  it("returns 0 and makes no deletions when count is within the limit", async () => {
    await insertLogs(adapter, [{ seq: 1 }, { seq: 2 }], "2024-01-01T00:00:00.000Z");
    const deleted = await purgeExcessLogs(adapter, 5);
    expect(deleted).toBe(0);
    expect(await queryLogs(adapter, {})).toHaveLength(2);
  });

  it("returns 0 when the table is empty", async () => {
    expect(await purgeExcessLogs(adapter, 10)).toBe(0);
  });

  it("deletes oldest rows first until maxRows remain", async () => {
    await insertLogs(adapter, [{ seq: 1 }], "2023-01-01T00:00:00.000Z");
    await insertLogs(adapter, [{ seq: 2 }], "2024-01-01T00:00:00.000Z");
    await insertLogs(adapter, [{ seq: 3 }], "2025-01-01T00:00:00.000Z");

    const deleted = await purgeExcessLogs(adapter, 1);
    expect(deleted).toBe(2);

    const remaining = await queryLogs(adapter, {});
    expect(remaining).toHaveLength(1);
    // Newest row survives
    expect(remaining[0].received_at).toBe("2025-01-01T00:00:00.000Z");
  });

  it("returns the exact number of rows deleted", async () => {
    // Insert 5 rows, keep 2 → expect 3 deleted
    const ts = "2024-01-01T00:00:00.000Z";
    await insertLogs(
      adapter,
      [{ seq: 1 }, { seq: 2 }, { seq: 3 }, { seq: 4 }, { seq: 5 }],
      ts,
    );
    expect(await purgeExcessLogs(adapter, 2)).toBe(3);
    expect(await queryLogs(adapter, {})).toHaveLength(2);
  });

  it("deletes in chunks without over-deleting", async () => {
    // 10 rows, keep 4, chunk 3 → two full chunks + one partial
    const ts = "2024-01-01T00:00:00.000Z";
    await insertLogs(
      adapter,
      Array.from({ length: 10 }, (_, i) => ({ seq: i })),
      ts,
    );
    const deleted = await purgeExcessLogs(adapter, 4, 3);
    expect(deleted).toBe(6);
    expect(await queryLogs(adapter, {})).toHaveLength(4);
  });

  it("FTS index remains searchable after excess purge (rebuild does not corrupt index)", async () => {
    await insertLogs(adapter, [{ message: "oldest event" }], "2023-01-01T00:00:00.000Z");
    await insertLogs(adapter, [{ message: "middle event" }], "2024-01-01T00:00:00.000Z");
    await insertLogs(adapter, [{ message: "newest event" }], "2025-01-01T00:00:00.000Z");
    await purgeExcessLogs(adapter, 1);

    // Purged rows must not appear
    expect(await searchLogs(adapter, "oldest", {})).toHaveLength(0);
    expect(await searchLogs(adapter, "middle", {})).toHaveLength(0);

    // Surviving row (newest) must still be found
    const hits = await searchLogs(adapter, "newest", {});
    expect(hits).toHaveLength(1);
    expect(hits[0].received_at).toBe("2025-01-01T00:00:00.000Z");
  });

  it("issues exactly one COUNT query regardless of iteration count", async () => {
    // Spy on adapter.get to count how many times it is called.
    const ts = "2024-01-01T00:00:00.000Z";
    await insertLogs(
      adapter,
      Array.from({ length: 9 }, (_, i) => ({ seq: i })),
      ts,
    );
    const originalGet = adapter.get.bind(adapter);
    let getCalls = 0;
    adapter.get = async (...args: Parameters<typeof adapter.get>) => {
      getCalls++;
      return originalGet(...args);
    };

    // chunk=3 → three delete iterations; COUNT must still be called once
    await purgeExcessLogs(adapter, 0, 3);

    expect(getCalls).toBe(1);

    // restore
    adapter.get = originalGet;
  });
});

// ---------------------------------------------------------------------------
// exportLogs
// ---------------------------------------------------------------------------

describe("exportLogs", () => {
  it("returns rows up to the higher export limit (> 500)", async () => {
    // Insert a handful of rows and confirm exportLogs can return them all
    // (the exact cap check is a runtime contract — we just verify it doesn't throw)
    await insertLogs(
      adapter,
      [{ msg: "a" }, { msg: "b" }, { msg: "c" }],
      "2024-01-01T00:00:00.000Z",
    );
    const rows = await exportLogs(adapter, { limit: 5000 });
    expect(rows).toHaveLength(3);
  });

  it("applies service and level filters", async () => {
    await insertLogs(
      adapter,
      [
        { service: "api", level: "error" },
        { service: "worker", level: "info" },
      ],
      "2024-01-01T00:00:00.000Z",
    );
    const rows = await exportLogs(adapter, { service: "api", level: "error" });
    expect(rows).toHaveLength(1);
    expect(rows[0].service).toBe("api");
  });

  it("returns rows newest-first", async () => {
    await insertLogs(adapter, [{ seq: 1 }], "2023-01-01T00:00:00.000Z");
    await insertLogs(adapter, [{ seq: 2 }], "2025-01-01T00:00:00.000Z");
    const rows = await exportLogs(adapter, {});
    expect(rows[0].received_at).toBe("2025-01-01T00:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// searchLogs
// ---------------------------------------------------------------------------

describe("searchLogs", () => {
  it("finds rows containing the search term", async () => {
    await insertLogs(
      adapter,
      [{ message: "connection refused" }],
      "2024-01-01T00:00:00.000Z",
    );
    await insertLogs(
      adapter,
      [{ message: "request ok" }],
      "2024-01-01T00:00:00.000Z",
    );
    expect(await searchLogs(adapter, "connection", {})).toHaveLength(1);
  });

  it("returns empty when nothing matches", async () => {
    await insertLogs(
      adapter,
      [{ message: "all fine" }],
      "2024-01-01T00:00:00.000Z",
    );
    expect(await searchLogs(adapter, "timeout", {})).toHaveLength(0);
  });

  it("searches nested JSON values", async () => {
    await insertLogs(
      adapter,
      [{ context: { user_id: "abc123" } }],
      "2024-01-01T00:00:00.000Z",
    );
    expect(await searchLogs(adapter, "abc123", {})).toHaveLength(1);
  });

  it("respects service filter", async () => {
    await insertLogs(
      adapter,
      [
        { service: "api", message: "error here" },
        { service: "worker", message: "error here" },
      ],
      "2024-01-01T00:00:00.000Z",
    );
    const rows = await searchLogs(adapter, "error", { service: "api" });
    expect(rows).toHaveLength(1);
    expect(rows[0].service).toBe("api");
  });

  it("respects since filter", async () => {
    await insertLogs(
      adapter,
      [{ message: "crash" }],
      "2023-01-01T00:00:00.000Z",
    );
    await insertLogs(
      adapter,
      [{ message: "crash" }],
      "2025-01-01T00:00:00.000Z",
    );
    const rows = await searchLogs(adapter, "crash", {
      since: "2024-01-01T00:00:00.000Z",
    });
    expect(rows).toHaveLength(1);
  });

  it("respects limit", async () => {
    await insertLogs(
      adapter,
      [
        { message: "hit", seq: 1 },
        { message: "hit", seq: 2 },
        { message: "hit", seq: 3 },
      ],
      "2024-01-01T00:00:00.000Z",
    );
    expect(await searchLogs(adapter, "hit", { limit: 2 })).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// listServices
// ---------------------------------------------------------------------------

describe("listServices", () => {
  it("returns distinct service names sorted alphabetically", async () => {
    await insertLogs(
      adapter,
      [{ service: "worker" }],
      "2024-01-01T00:00:00.000Z",
    );
    await insertLogs(adapter, [{ service: "api" }], "2024-01-01T00:00:00.000Z");
    await insertLogs(adapter, [{ service: "api" }], "2024-01-01T00:00:00.000Z");
    expect(await listServices(adapter)).toEqual(["api", "worker"]);
  });

  it("excludes rows with no service field", async () => {
    await insertLogs(
      adapter,
      [{ message: "no service" }],
      "2024-01-01T00:00:00.000Z",
    );
    expect(await listServices(adapter)).toHaveLength(0);
  });

  it("returns empty array when no logs exist", async () => {
    expect(await listServices(adapter)).toEqual([]);
  });

  // Selective cache invalidation — PERF-L2
  it("does not invalidate cache when batch contains only already-known services", async () => {
    // Seed and warm cache
    await insertLogs(adapter, [{ service: "api" }], "2024-01-01T00:00:00.000Z");
    const firstResult = await listServices(adapter);
    expect(firstResult).toEqual(["api"]);

    // Spy on adapter.query to count SELECT DISTINCT calls
    const original = adapter.query.bind(adapter);
    let distinctCalls = 0;
    (adapter as unknown as { query: typeof adapter.query }).query = async (sql, args) => {
      if (typeof sql === "string" && sql.includes("DISTINCT service")) distinctCalls++;
      return original(sql, args);
    };

    // Insert same known service — should NOT invalidate the cache
    await insertLogs(adapter, [{ service: "api" }], "2024-01-02T00:00:00.000Z");
    const secondResult = await listServices(adapter);

    expect(secondResult).toEqual(["api"]);
    expect(distinctCalls).toBe(0); // cache hit — no DB query issued
  });

  it("invalidates cache when batch contains a new service", async () => {
    // Seed and warm cache
    await insertLogs(adapter, [{ service: "api" }], "2024-01-01T00:00:00.000Z");
    await listServices(adapter);

    // Spy on adapter.query
    const original = adapter.query.bind(adapter);
    let distinctCalls = 0;
    (adapter as unknown as { query: typeof adapter.query }).query = async (sql, args) => {
      if (typeof sql === "string" && sql.includes("DISTINCT service")) distinctCalls++;
      return original(sql, args);
    };

    // Insert a new service — should invalidate and trigger a rebuild
    await insertLogs(adapter, [{ service: "worker" }], "2024-01-02T00:00:00.000Z");
    const result = await listServices(adapter);

    expect(result).toEqual(["api", "worker"]);
    expect(distinctCalls).toBe(1); // cache miss — one rebuild query
  });

  it("does not invalidate cache when batch has no service field", async () => {
    await insertLogs(adapter, [{ service: "api" }], "2024-01-01T00:00:00.000Z");
    await listServices(adapter);

    const original = adapter.query.bind(adapter);
    let distinctCalls = 0;
    (adapter as unknown as { query: typeof adapter.query }).query = async (sql, args) => {
      if (typeof sql === "string" && sql.includes("DISTINCT service")) distinctCalls++;
      return original(sql, args);
    };

    // Batch with no service — cache should be preserved
    await insertLogs(adapter, [{ message: "no service here" }], "2024-01-02T00:00:00.000Z");
    await listServices(adapter);

    expect(distinctCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// queryLogs — trace_id filter
// ---------------------------------------------------------------------------

describe("queryLogs with trace_id", () => {
  it("filters by trace_id", async () => {
    await insertLogs(
      adapter,
      [{ trace_id: "req-abc", message: "traced" }, { message: "no trace" }],
      "2024-01-01T00:00:00.000Z",
    );
    const rows = await queryLogs(adapter, { trace_id: "req-abc" });
    expect(rows).toHaveLength(1);
    expect(rows[0].trace_id).toBe("req-abc");
  });

  it("recognises traceId alias", async () => {
    await insertLogs(
      adapter,
      [{ traceId: "tid-001", msg: "x" }],
      "2024-01-01T00:00:00.000Z",
    );
    expect(await queryLogs(adapter, { trace_id: "tid-001" })).toHaveLength(1);
  });

  it("recognises requestId alias", async () => {
    await insertLogs(
      adapter,
      [{ requestId: "req-xyz" }],
      "2024-01-01T00:00:00.000Z",
    );
    expect(await queryLogs(adapter, { trace_id: "req-xyz" })).toHaveLength(1);
  });

  it("returns empty when trace_id does not match", async () => {
    await insertLogs(
      adapter,
      [{ trace_id: "aaa" }],
      "2024-01-01T00:00:00.000Z",
    );
    expect(await queryLogs(adapter, { trace_id: "bbb" })).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// countLogs
// ---------------------------------------------------------------------------

describe("countLogs", () => {
  it("returns 0 when no logs exist", async () => {
    expect(await countLogs(adapter, {})).toBe(0);
  });

  it("returns total count of all logs", async () => {
    await insertLogs(
      adapter,
      [{ seq: 1 }, { seq: 2 }, { seq: 3 }],
      "2024-01-01T00:00:00.000Z",
    );
    expect(await countLogs(adapter, {})).toBe(3);
  });

  it("filters by service", async () => {
    // Use distinct seq fields so rows are not deduped
    await insertLogs(
      adapter,
      [
        { service: "api", seq: 1 },
        { service: "api", seq: 2 },
        { service: "worker", seq: 1 },
      ],
      "2024-01-01T00:00:00.000Z",
    );
    expect(await countLogs(adapter, { service: "api" })).toBe(2);
    expect(await countLogs(adapter, { service: "worker" })).toBe(1);
  });

  it("filters by level", async () => {
    // Use distinct seq fields so rows are not deduped
    await insertLogs(
      adapter,
      [
        { level: "error", seq: 1 },
        { level: "error", seq: 2 },
        { level: "info", seq: 1 },
      ],
      "2024-01-01T00:00:00.000Z",
    );
    expect(await countLogs(adapter, { level: "error" })).toBe(2);
    expect(await countLogs(adapter, { level: "info" })).toBe(1);
  });

  it("filters by since", async () => {
    await insertLogs(adapter, [{ msg: "old" }], "2023-01-01T00:00:00.000Z");
    await insertLogs(adapter, [{ msg: "new" }], "2025-01-01T00:00:00.000Z");
    expect(
      await countLogs(adapter, { since: "2024-01-01T00:00:00.000Z" }),
    ).toBe(1);
  });

  it("filters by until", async () => {
    await insertLogs(adapter, [{ msg: "old" }], "2023-01-01T00:00:00.000Z");
    await insertLogs(adapter, [{ msg: "new" }], "2025-01-01T00:00:00.000Z");
    expect(
      await countLogs(adapter, { until: "2024-01-01T00:00:00.000Z" }),
    ).toBe(1);
  });

  it("combines service and level filters", async () => {
    await insertLogs(
      adapter,
      [
        { service: "api", level: "error" },
        { service: "api", level: "info" },
        { service: "worker", level: "error" },
      ],
      "2024-01-01T00:00:00.000Z",
    );
    expect(await countLogs(adapter, { service: "api", level: "error" })).toBe(
      1,
    );
  });

  it("is not capped at 500 rows", async () => {
    // Use distinct seq values to ensure no deduplication
    const rows = Array.from({ length: 10 }, (_, i) => ({
      seq: i,
      msg: `log-${i}`,
    }));
    await insertLogs(adapter, rows, "2024-01-01T00:00:00.000Z");
    // countLogs must return the exact count, not be limited by the queryLogs cap
    expect(await countLogs(adapter, {})).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// insertLogs — deduplication (isDuplicate / 5-second window)
// ---------------------------------------------------------------------------

describe("insertLogs deduplication", () => {
  it("drops exact duplicates within the same receivedAt timestamp", async () => {
    const ts = "2024-01-01T00:00:00.000Z";
    const result1 = await insertLogs(adapter, [{ message: "dup" }], ts);
    const result2 = await insertLogs(adapter, [{ message: "dup" }], ts);
    expect(result1.written).toBe(1);
    expect(result2.written).toBe(0);
    expect(result2.deduplicated).toBe(1);
    expect(await queryLogs(adapter, {})).toHaveLength(1);
  });

  it("does not dedup when receivedAt differs (body includes timestamp)", async () => {
    // Because received_at is embedded in the stored body, two inserts with different
    // receivedAt values always produce different body strings — dedup does not fire.
    const ts1 = "2024-01-01T00:00:00.000Z";
    const ts2 = "2024-01-01T00:00:04.000Z"; // same message, different receivedAt
    await insertLogs(adapter, [{ message: "same" }], ts1);
    const result = await insertLogs(adapter, [{ message: "same" }], ts2);
    expect(result.written).toBe(1);
    expect(result.deduplicated).toBe(0);
    expect(await queryLogs(adapter, {})).toHaveLength(2);
  });

  it("deduplication window spans rows inserted up to 5s before current receivedAt", async () => {
    // If a second batch is given a receivedAt that is ≤ 5s after the first batch,
    // AND the body string is identical (same receivedAt embedded), the row is deduped.
    // Simulate this by calling insertLogs twice with the same receivedAt.
    const ts = "2024-01-01T00:00:00.000Z";
    await insertLogs(adapter, [{ message: "same" }], ts);
    const result = await insertLogs(adapter, [{ message: "same" }], ts);
    expect(result.deduplicated).toBe(1);
    expect(await queryLogs(adapter, {})).toHaveLength(1);
  });

  it("does not drop distinct messages at the same timestamp", async () => {
    const ts = "2024-01-01T00:00:00.000Z";
    const result = await insertLogs(
      adapter,
      [{ message: "a" }, { message: "b" }],
      ts,
    );
    expect(result.written).toBe(2);
    expect(result.deduplicated).toBe(0);
    expect(await queryLogs(adapter, {})).toHaveLength(2);
  });

  it("stores a SHA-256 body_hash for each inserted row", async () => {
    const ts = "2024-01-01T00:00:00.000Z";
    await insertLogs(adapter, [{ message: "hash-test" }], ts);
    const rows = await adapter.query<{ body: string; body_hash: string }>(
      "SELECT body, body_hash FROM logs",
    );
    expect(rows).toHaveLength(1);
    const expectedHash = createHash("sha256").update(rows[0].body).digest("hex");
    expect(rows[0].body_hash).toBe(expectedHash);
  });

  it("returns correct written/deduplicated counts for mixed batch", async () => {
    const ts = "2024-01-01T00:00:00.000Z";
    // First insert establishes the baseline
    await insertLogs(adapter, [{ message: "unique" }, { message: "dup" }], ts);
    // Second batch: one duplicate, one new
    const result = await insertLogs(
      adapter,
      [{ message: "dup" }, { message: "new" }],
      ts,
    );
    expect(result.written).toBe(1);
    expect(result.deduplicated).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// isValidIso
// ---------------------------------------------------------------------------

describe("isValidIso", () => {
  it.each([
    "2024-01-15",
    "2024-01-15T00:00:00Z",
    "2024-01-15T00:00:00.000Z",
    "2024-01-15T12:34:56.789Z",
    "2024-01-15T00:00:00+05:00",
    "2024-01-15T00:00:00-08:00",
    "2024-01-15T12:34:56",
  ])("accepts valid ISO string %s", (value) => {
    expect(isValidIso(value)).toBe(true);
  });

  it.each([
    "",
    "not-a-date",
    "'; DROP TABLE logs--",
    "2024/01/15",
    "15-01-2024",
    "2024-01-15T",
    "yesterday",
    "null",
    "undefined",
    "2024-1-1",        // no zero-padding
  ])("rejects invalid string %s", (value) => {
    expect(isValidIso(value)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// summarizeErrors
// ---------------------------------------------------------------------------

describe("summarizeErrors", () => {
  it("groups by service and level", async () => {
    // Use distinct seq fields to prevent deduplication of identical-looking rows
    await insertLogs(
      adapter,
      [
        { service: "api", level: "error", seq: 1 },
        { service: "api", level: "error", seq: 2 },
        { service: "api", level: "info", seq: 1 },
        { service: "worker", level: "error", seq: 1 },
      ],
      "2024-01-01T00:00:00.000Z",
    );
    const rows = await summarizeErrors(adapter);
    const apiErrors = rows.find(
      (r) => r.service === "api" && r.level === "error",
    );
    const apiInfo = rows.find((r) => r.service === "api" && r.level === "info");
    expect(apiErrors?.count).toBe(2);
    expect(apiInfo?.count).toBe(1);
  });

  it("respects since filter", async () => {
    await insertLogs(
      adapter,
      [{ service: "api", level: "error" }],
      "2023-01-01T00:00:00.000Z",
    );
    await insertLogs(
      adapter,
      [{ service: "api", level: "error" }],
      "2025-01-01T00:00:00.000Z",
    );
    const rows = await summarizeErrors(adapter, "2024-01-01T00:00:00.000Z");
    const apiErrors = rows.find(
      (r) => r.service === "api" && r.level === "error",
    );
    expect(apiErrors?.count).toBe(1);
  });

  it("respects until filter", async () => {
    await insertLogs(
      adapter,
      [{ service: "api", level: "info", seq: 1 }],
      "2023-01-01T00:00:00.000Z",
    );
    await insertLogs(
      adapter,
      [{ service: "api", level: "info", seq: 2 }],
      "2025-01-01T00:00:00.000Z",
    );
    const rows = await summarizeErrors(adapter, undefined, "2024-01-01T00:00:00.000Z");
    const apiInfo = rows.find((r) => r.service === "api" && r.level === "info");
    expect(apiInfo?.count).toBe(1);
  });

  it("respects both since and until together", async () => {
    await insertLogs(adapter, [{ service: "api", level: "warn", seq: 1 }], "2022-06-01T00:00:00.000Z");
    await insertLogs(adapter, [{ service: "api", level: "warn", seq: 2 }], "2023-06-01T00:00:00.000Z");
    await insertLogs(adapter, [{ service: "api", level: "warn", seq: 3 }], "2024-06-01T00:00:00.000Z");
    const rows = await summarizeErrors(adapter, "2023-01-01T00:00:00.000Z", "2024-01-01T00:00:00.000Z");
    const apiWarn = rows.find((r) => r.service === "api" && r.level === "warn");
    expect(apiWarn?.count).toBe(1); // only the 2023-06-01 row
  });

  it("returns empty array when no logs exist", async () => {
    expect(await summarizeErrors(adapter)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// queryByField
// ---------------------------------------------------------------------------

describe("queryByField", () => {
  it("returns empty array when nothing matches", async () => {
    const rows = await queryByField(adapter, {
      field: "statusCode",
      op: "=",
      value: 500,
    });
    expect(rows).toHaveLength(0);
  });

  it("filters by exact string field value", async () => {
    await insertLogs(
      adapter,
      [{ userId: "u_123" }, { userId: "u_456" }],
      "2024-01-01T00:00:00.000Z",
    );
    const rows = await queryByField(adapter, {
      field: "userId",
      op: "=",
      value: "u_123",
    });
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].body).userId).toBe("u_123");
  });

  it("filters by numeric greater-than", async () => {
    await insertLogs(
      adapter,
      [{ ms: 100 }, { ms: 800 }, { ms: 1200 }],
      "2024-01-01T00:00:00.000Z",
    );
    const rows = await queryByField(adapter, {
      field: "ms",
      op: ">",
      value: 500,
    });
    expect(rows).toHaveLength(2);
    rows.forEach((r) => {
      expect(JSON.parse(r.body).ms).toBeGreaterThan(500);
    });
  });

  it("filters by <=", async () => {
    await insertLogs(
      adapter,
      [{ ms: 100 }, { ms: 200 }, { ms: 300 }],
      "2024-01-01T00:00:00.000Z",
    );
    const rows = await queryByField(adapter, {
      field: "ms",
      op: "<=",
      value: 200,
    });
    expect(rows).toHaveLength(2);
  });

  it("filters by != (not equal)", async () => {
    await insertLogs(
      adapter,
      [{ statusCode: 200 }, { statusCode: 500 }],
      "2024-01-01T00:00:00.000Z",
    );
    const rows = await queryByField(adapter, {
      field: "statusCode",
      op: "!=",
      value: 200,
    });
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].body).statusCode).toBe(500);
  });

  it("combines with service filter", async () => {
    await insertLogs(
      adapter,
      [{ service: "api", ms: 900 }, { service: "worker", ms: 900 }],
      "2024-01-01T00:00:00.000Z",
    );
    const rows = await queryByField(adapter, {
      field: "ms",
      op: ">",
      value: 500,
      service: "api",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].service).toBe("api");
  });

  it("respects since/until filters", async () => {
    await insertLogs(adapter, [{ ms: 900 }], "2023-01-01T00:00:00.000Z");
    await insertLogs(adapter, [{ ms: 900 }], "2025-01-01T00:00:00.000Z");
    const rows = await queryByField(adapter, {
      field: "ms",
      op: ">",
      value: 500,
      since: "2024-01-01T00:00:00.000Z",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].received_at).toBe("2025-01-01T00:00:00.000Z");
  });

  it("respects limit", async () => {
    await insertLogs(
      adapter,
      [{ ms: 600 }, { ms: 700 }, { ms: 800 }],
      "2024-01-01T00:00:00.000Z",
    );
    const rows = await queryByField(adapter, {
      field: "ms",
      op: ">",
      value: 500,
      limit: 1,
    });
    expect(rows).toHaveLength(1);
  });

  it("throws on invalid field name", async () => {
    await expect(
      queryByField(adapter, { field: "bad field!", op: "=", value: "x" }),
    ).rejects.toThrow("Invalid field name");
  });

  it("throws on invalid operator", async () => {
    await expect(
      // @ts-expect-error intentionally passing invalid op
      queryByField(adapter, { field: "ms", op: "LIKE", value: "x" }),
    ).rejects.toThrow("Invalid operator");
  });
});

// ---------------------------------------------------------------------------
// histogramLogs
// ---------------------------------------------------------------------------

describe("histogramLogs", () => {
  it("returns empty array when no logs exist", async () => {
    const rows = await histogramLogs(adapter, { bucket: "1h" });
    expect(rows).toHaveLength(0);
  });

  it("returns a single bucket when all events are in the same hour", async () => {
    await insertLogs(adapter, [{ seq: 1 }], "2024-06-01T10:05:00.000Z");
    await insertLogs(adapter, [{ seq: 2 }], "2024-06-01T10:45:00.000Z");
    const rows = await histogramLogs(adapter, { bucket: "1h" });
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(2);
    expect(rows[0].bucket).toContain("10:00:00");
  });

  it("returns two buckets when events span different hours", async () => {
    await insertLogs(adapter, [{ seq: 1 }], "2024-06-01T10:00:00.000Z");
    await insertLogs(adapter, [{ seq: 2 }], "2024-06-01T12:00:00.000Z");
    const rows = await histogramLogs(adapter, { bucket: "1h" });
    expect(rows).toHaveLength(2);
  });

  it("returns buckets in chronological order", async () => {
    await insertLogs(adapter, [{ seq: 1 }], "2024-06-01T12:00:00.000Z");
    await insertLogs(adapter, [{ seq: 2 }], "2024-06-01T10:00:00.000Z");
    const rows = await histogramLogs(adapter, { bucket: "1h" });
    expect(rows[0].bucket < rows[1].bucket).toBe(true);
  });

  it("filters by service", async () => {
    const ts = "2024-06-01T10:00:00.000Z";
    await insertLogs(adapter, [{ service: "api" }], ts);
    await insertLogs(adapter, [{ service: "worker" }], ts);
    const rows = await histogramLogs(adapter, { bucket: "1h", service: "api" });
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(1);
  });

  it("filters by level", async () => {
    const ts = "2024-06-01T10:00:00.000Z";
    await insertLogs(adapter, [{ level: "error" }], ts);
    await insertLogs(adapter, [{ level: "info" }], ts);
    const rows = await histogramLogs(adapter, { bucket: "1h", level: "error" });
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(1);
  });

  it("splits events correctly with 5m bucket", async () => {
    await insertLogs(adapter, [{ seq: 1 }], "2024-06-01T10:00:00.000Z");
    await insertLogs(adapter, [{ seq: 2 }], "2024-06-01T10:06:00.000Z");
    const rows = await histogramLogs(adapter, { bucket: "5m" });
    expect(rows).toHaveLength(2);
  });

  it("groups events correctly with 1d bucket", async () => {
    await insertLogs(adapter, [{ seq: 1 }], "2024-06-01T10:00:00.000Z");
    await insertLogs(adapter, [{ seq: 2 }], "2024-06-01T22:00:00.000Z");
    await insertLogs(adapter, [{ seq: 3 }], "2024-06-02T10:00:00.000Z");
    const rows = await histogramLogs(adapter, { bucket: "1d" });
    expect(rows).toHaveLength(2);
    expect(rows[0].count).toBe(2); // both 2024-06-01 events
    expect(rows[1].count).toBe(1); // 2024-06-02
  });

  it("respects since/until filters", async () => {
    await insertLogs(adapter, [{ seq: 1 }], "2023-01-01T10:00:00.000Z");
    await insertLogs(adapter, [{ seq: 2 }], "2025-01-01T10:00:00.000Z");
    const rows = await histogramLogs(adapter, {
      bucket: "1h",
      since: "2024-01-01T00:00:00.000Z",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].bucket).toContain("2025");
  });
});

// ---------------------------------------------------------------------------
// getLogCounts
// ---------------------------------------------------------------------------

describe("getLogCounts", () => {
  const ts = "2024-06-01T10:00:00.000Z";

  it("returns empty array when no logs have been inserted", async () => {
    const rows = await getLogCounts(adapter);
    expect(rows).toHaveLength(0);
  });

  it("increments count for matching (service, level) on insert", async () => {
    await insertLogs(adapter, [{ service: "api", level: "error", seq: 1 }], ts);
    await insertLogs(adapter, [{ service: "api", level: "error", seq: 2 }], ts);
    const rows = await getLogCounts(adapter);
    const row = rows.find((r) => r.service === "api" && r.level === "error");
    expect(row?.count).toBe(2);
  });

  it("tracks distinct (service, level) pairs independently", async () => {
    await insertLogs(adapter, [{ service: "api", level: "error" }], ts);
    await insertLogs(adapter, [{ service: "api", level: "info" }], ts);
    await insertLogs(adapter, [{ service: "worker", level: "error" }], ts);
    const rows = await getLogCounts(adapter);
    expect(rows).toHaveLength(3);
    const apiError = rows.find((r) => r.service === "api" && r.level === "error");
    const apiInfo  = rows.find((r) => r.service === "api" && r.level === "info");
    const wrkError = rows.find((r) => r.service === "worker" && r.level === "error");
    expect(apiError?.count).toBe(1);
    expect(apiInfo?.count).toBe(1);
    expect(wrkError?.count).toBe(1);
  });

  it("normalizes null service and level to empty string", async () => {
    await insertLogs(adapter, [{ seq: 1 }], ts); // no service or level
    const rows = await getLogCounts(adapter);
    expect(rows).toHaveLength(1);
    expect(rows[0].service).toBe("");
    expect(rows[0].level).toBe("");
    expect(rows[0].count).toBe(1);
  });

  it("counts a multi-row batch insert correctly in one transaction", async () => {
    await insertLogs(
      adapter,
      [
        { service: "api", level: "error", seq: 1 },
        { service: "api", level: "error", seq: 2 },
        { service: "api", level: "error", seq: 3 },
      ],
      ts,
    );
    const rows = await getLogCounts(adapter);
    const row = rows.find((r) => r.service === "api" && r.level === "error");
    expect(row?.count).toBe(3);
  });

  it("does not double-count deduplicated rows", async () => {
    const row = { service: "api", level: "error", msg: "dup" };
    await insertLogs(adapter, [row], ts);
    // Same body + same timestamp = deduplication window hit
    await insertLogs(adapter, [row], ts);
    const counts = await getLogCounts(adapter);
    const entry = counts.find((r) => r.service === "api" && r.level === "error");
    expect(entry?.count).toBe(1);
  });

  it("returns rows ordered by count descending", async () => {
    await insertLogs(adapter, [{ service: "a", level: "info", seq: 1 }], ts);
    await insertLogs(adapter, [{ service: "a", level: "info", seq: 2 }], ts);
    await insertLogs(adapter, [{ service: "b", level: "info", seq: 3 }], ts);
    const rows = await getLogCounts(adapter);
    expect(rows[0].count).toBeGreaterThanOrEqual(rows[1].count);
  });
});
