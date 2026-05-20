/**
 * Tests for buildMcpServer — verifies that all 9 tools are registered and
 * that each tool handler calls adapters.mcp.resolveDb(ctx) with the correct
 * token context.
 *
 * @modelcontextprotocol/sdk is mocked so no real MCP transport is needed.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "os";
import path from "path";
import { randomBytes } from "crypto";
import fs from "fs";
import { BetterSqliteAdapter } from "@usekamori/core";
import type { KamoriAdapters } from "@usekamori/core";

// ---------------------------------------------------------------------------
// Capture registered tool handlers so tests can invoke them directly.
// ---------------------------------------------------------------------------

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

const toolHandlers = new Map<string, ToolHandler>();

const mockTool = vi.fn(
  (name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
    toolHandlers.set(name, handler);
  },
);

const mockServerInstance = { tool: mockTool };

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => {
  // Arrow functions can't be used with `new`. A regular function that returns
  // an explicit object causes `new` to return that object instead of `this`.
  function MockMcpServer() {
    return mockServerInstance;
  }
  return { McpServer: MockMcpServer };
});

// ---------------------------------------------------------------------------
// Per-test setup
// ---------------------------------------------------------------------------

let dbPath: string;
let adapter: BetterSqliteAdapter;

beforeEach(() => {
  toolHandlers.clear();
  mockTool.mockClear();

  dbPath = path.join(
    os.tmpdir(),
    `build-mcp-test-${randomBytes(8).toString("hex")}.db`,
  );
  adapter = new BetterSqliteAdapter(dbPath);
});

afterEach(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(dbPath + suffix);
    } catch {}
  }
});

function makeAdapters(mcpOverride?: KamoriAdapters["mcp"]): KamoriAdapters {
  return {
    db: adapter,
    auth: {
      verifyIngestToken: vi.fn().mockReturnValue(null),
    } as KamoriAdapters["auth"],
    billing: {
      checkIngestAccess: vi.fn().mockResolvedValue(true),
      reportUsage: vi.fn().mockResolvedValue(undefined),
    } as KamoriAdapters["billing"],
    email: {
      sendEmail: vi.fn().mockResolvedValue(undefined),
    } as KamoriAdapters["email"],
    retention: {
      getCutoffDate: vi.fn().mockReturnValue(null),
    } as KamoriAdapters["retention"],
    mcp: mcpOverride ?? { resolveDb: vi.fn().mockResolvedValue(adapter) },
  };
}

// All tool names in registration order
const ALL_TOOLS = [
  "query_logs",
  "search_logs",
  "list_services",
  "summarize_errors",
  "tail_logs",
  "get_log",
  "alert_summary",
  "watch_logs",
  "anomaly_hint",
  "query_field",
  "histogram",
  "trace_logs",
  "query_sql",
] as const;

// Tools tested individually in the ctx-propagation suite (long-poll, special args)
const SKIP_IN_EACH = new Set(["watch_logs"]);

// Minimal args required for each tool to not throw before hitting resolveDb
const TOOL_ARGS: Record<string, Record<string, unknown>> = {
  tail_logs: { after_id: 0 },
  get_log: { id: 1 },
  query_field: { field: "level", op: "=", value: "error" },
  histogram: { bucket: "1h" },
  trace_logs: { trace_id: "abc123" },
  query_sql: { sql: "SELECT 1" },
};

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

describe("buildMcpServer — tool registration", () => {
  it("registers exactly 13 tools", async () => {
    const { buildMcpServer } = await import("./build-mcp-server.js");
    buildMcpServer(makeAdapters());
    expect(mockTool).toHaveBeenCalledTimes(13);
  });

  it.each(ALL_TOOLS)("registers the '%s' tool", async (name) => {
    const { buildMcpServer } = await import("./build-mcp-server.js");
    buildMcpServer(makeAdapters());
    expect(toolHandlers.has(name)).toBe(true);
  });

  it("returns the McpServer instance", async () => {
    const { buildMcpServer } = await import("./build-mcp-server.js");
    const result = buildMcpServer(makeAdapters());
    expect(result).toBe(mockServerInstance);
  });
});

// ---------------------------------------------------------------------------
// ctx propagation — token is forwarded to resolveDb
// ---------------------------------------------------------------------------

describe("buildMcpServer — ctx propagation", () => {
  it("passes { token } ctx to resolveDb when token is provided", async () => {
    const { buildMcpServer } = await import("./build-mcp-server.js");
    const resolveDb = vi.fn().mockResolvedValue(adapter);
    buildMcpServer(makeAdapters({ resolveDb }), "test-api-key");

    await toolHandlers.get("list_services")!({});
    expect(resolveDb).toHaveBeenCalledWith({ token: "test-api-key" });
  });

  it("passes undefined ctx to resolveDb when no token is provided", async () => {
    const { buildMcpServer } = await import("./build-mcp-server.js");
    const resolveDb = vi.fn().mockResolvedValue(adapter);
    buildMcpServer(makeAdapters({ resolveDb }));

    await toolHandlers.get("list_services")!({});
    expect(resolveDb).toHaveBeenCalledWith(undefined);
  });

  it.each(ALL_TOOLS.filter((n) => !SKIP_IN_EACH.has(n)))(
    "'%s' calls resolveDb with the token ctx",
    async (name) => {
      const { buildMcpServer } = await import("./build-mcp-server.js");
      const resolveDb = vi.fn().mockResolvedValue(adapter);
      buildMcpServer(makeAdapters({ resolveDb }), "my-key");

      resolveDb.mockClear();
      try {
        await toolHandlers.get(name)!(TOOL_ARGS[name] ?? {});
      } catch {
        // handler may fail after resolveDb — we only care that resolveDb was called
      }
      expect(resolveDb).toHaveBeenCalledWith({ token: "my-key" });
    },
  );

  it("'watch_logs' calls resolveDb with the token ctx", async () => {
    vi.useFakeTimers();
    const { buildMcpServer } = await import("./build-mcp-server.js");
    const resolveDb = vi.fn().mockResolvedValue(adapter);
    buildMcpServer(makeAdapters({ resolveDb }), "my-key");

    resolveDb.mockClear();
    // Start the handler but don't await — advance timers to satisfy the poll loop
    const p = toolHandlers.get("watch_logs")!({
      after_id: 0,
      timeout_seconds: 1,
    });
    await vi.advanceTimersByTimeAsync(1_500);
    await p.catch(() => {});
    vi.useRealTimers();

    expect(resolveDb).toHaveBeenCalledWith({ token: "my-key" });
  });
});
