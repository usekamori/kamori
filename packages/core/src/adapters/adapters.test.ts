import { describe, it, expect } from "vitest";
import { BetterSqliteAdapter, STMT_CACHE_MAX } from "./better-sqlite.js";
import { LocalDbMcpAdapter } from "./mcp-adapter.js";
import { EnvRetentionAdapter } from "./retention-adapter.js";
import { NoBillingAdapter } from "./billing-adapter.js";
import os from "os";
import path from "path";
import { randomBytes } from "crypto";
import fs from "fs";

// ---------------------------------------------------------------------------
// BetterSqliteAdapter — statement cache (LRU)
// ---------------------------------------------------------------------------

describe("BetterSqliteAdapter statement cache", () => {
  function makePath() {
    return path.join(os.tmpdir(), `stmt-cache-test-${randomBytes(8).toString("hex")}.db`);
  }

  it("caches prepared statements and reuses them (size stays at 1 for repeated SQL)", async () => {
    const dbPath = makePath();
    const adapter = new BetterSqliteAdapter(dbPath);
    const cache = (adapter as unknown as { _stmtCache: Map<string, unknown> })._stmtCache;

    await adapter.query("SELECT 1 AS n");
    const sizeAfterFirst = cache.size;
    await adapter.query("SELECT 1 AS n");
    expect(cache.size).toBe(sizeAfterFirst); // no new entry added

    fs.unlinkSync(dbPath);
  });

  it("evicts the LRU entry when the cache exceeds STMT_CACHE_MAX", async () => {
    const dbPath = makePath();
    const adapter = new BetterSqliteAdapter(dbPath);
    const cache = (adapter as unknown as { _stmtCache: Map<string, unknown> })._stmtCache;

    // Insert STMT_CACHE_MAX + 5 distinct SQL strings via the internal _prepare method.
    const prepare = (adapter as unknown as { _prepare: (sql: string) => unknown })._prepare.bind(adapter);
    for (let i = 0; i < STMT_CACHE_MAX + 5; i++) {
      prepare(`SELECT ${i} AS n`);
    }

    expect(cache.size).toBe(STMT_CACHE_MAX);

    fs.unlinkSync(dbPath);
  });

  it("refreshes MRU position on cache hit, keeping hot entries alive through eviction", async () => {
    const dbPath = makePath();
    const adapter = new BetterSqliteAdapter(dbPath);
    const cache = (adapter as unknown as { _stmtCache: Map<string, unknown> })._stmtCache;
    const prepare = (adapter as unknown as { _prepare: (sql: string) => unknown })._prepare.bind(adapter);

    // Fill cache to capacity, with "SELECT 0 AS n" as the first (LRU candidate).
    for (let i = 0; i < STMT_CACHE_MAX; i++) {
      prepare(`SELECT ${i} AS n`);
    }
    // Re-access the first entry to move it to MRU position.
    prepare("SELECT 0 AS n");
    // Add one more entry — should evict "SELECT 1 AS n" (now the true LRU), not "SELECT 0 AS n".
    prepare(`SELECT ${STMT_CACHE_MAX} AS n`);

    expect(cache.has("SELECT 0 AS n")).toBe(true);
    expect(cache.has("SELECT 1 AS n")).toBe(false);

    fs.unlinkSync(dbPath);
  });
});

// ---------------------------------------------------------------------------
// LocalDbMcpAdapter
// ---------------------------------------------------------------------------

describe("LocalDbMcpAdapter", () => {
  let dbPath: string;

  function makePath() {
    dbPath = path.join(os.tmpdir(), `mcp-adapter-test-${randomBytes(8).toString("hex")}.db`);
    return dbPath;
  }

  it("resolveDb returns the injected adapter", async () => {
    const adapter = new BetterSqliteAdapter(makePath());
    const mcp = new LocalDbMcpAdapter(adapter);
    const resolved = await mcp.resolveDb();
    expect(resolved).toBe(adapter);
    fs.unlinkSync(dbPath);
  });

  it("resolveDb ignores context and returns the same adapter", async () => {
    const adapter = new BetterSqliteAdapter(makePath());
    const mcp = new LocalDbMcpAdapter(adapter);
    const resolved = await mcp.resolveDb({ token: "some-token" });
    expect(resolved).toBe(adapter);
    fs.unlinkSync(dbPath);
  });
});

// ---------------------------------------------------------------------------
// EnvRetentionAdapter
// ---------------------------------------------------------------------------

describe("EnvRetentionAdapter", () => {
  it("returns null when retentionDays is 0 (disabled)", () => {
    const adapter = new EnvRetentionAdapter(0);
    expect(adapter.getCutoffDate()).toBeNull();
  });

  it("returns null when retentionDays is negative", () => {
    const adapter = new EnvRetentionAdapter(-1);
    expect(adapter.getCutoffDate()).toBeNull();
  });

  it("returns an ISO date string in the past when retentionDays > 0", () => {
    const adapter = new EnvRetentionAdapter(30);
    const cutoff = adapter.getCutoffDate();
    expect(cutoff).not.toBeNull();
    const cutoffDate = new Date(cutoff!);
    expect(cutoffDate.getTime()).toBeLessThan(Date.now());
    // Cutoff should be approximately 30 days ago (within 1 minute tolerance)
    const expectedMs = Date.now() - 30 * 86_400_000;
    expect(Math.abs(cutoffDate.getTime() - expectedMs)).toBeLessThan(60_000);
  });
});

// ---------------------------------------------------------------------------
// NoBillingAdapter
// ---------------------------------------------------------------------------

describe("NoBillingAdapter", () => {
  it("checkIngestAccess always returns true", async () => {
    const adapter = new NoBillingAdapter();
    expect(await adapter.checkIngestAccess("any-project")).toBe(true);
  });

  it("reportUsage is a no-op", async () => {
    const adapter = new NoBillingAdapter();
    await expect(adapter.reportUsage("any-project", 100, 5)).resolves.toBeUndefined();
  });
});
