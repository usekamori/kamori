/**
 * buildMcpServer — creates and configures a Kamori MCP server instance.
 *
 * Accepts a KamoriAdapters set so Cloud entrypoints (private repo) can inject
 * their own adapter implementations without modifying this package.
 *
 * OSS entrypoint (mcp.ts) calls buildMcpServer(defaultAdapters()).
 * Cloud entrypoint calls buildMcpServer(cloudAdapters).
 *
 * Returns a configured McpServer with all tools registered.
 * The caller is responsible for connecting a transport (stdio or HTTP).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { KamoriAdapters } from "@usekamori/core";
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

export function buildMcpServer(
  adapters: KamoriAdapters,
  token?: string,
): McpServer {
  const server = new McpServer({
    name: "kamori",
    version: "1.0.0",
  });

  const ctx = token ? { token } : undefined;

  server.tool(
    "query_logs",
    "Fetch log entries with optional filters. Returns up to 500 rows ordered by most recent first.",
    {
      service: z.string().optional().describe("Filter by service name"),
      level: z
        .string()
        .optional()
        .describe("Filter by log level (e.g. error, warn, info)"),
      since: z
        .string()
        .optional()
        .describe("ISO8601 start time, e.g. 2024-01-01T00:00:00Z"),
      until: z.string().optional().describe("ISO8601 end time"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe("Max rows to return (default 100)"),
    },
    async (args) => {
      const db = await adapters.mcp.resolveDb(ctx);
      return handleQueryLogs(db, args);
    },
  );

  server.tool(
    "search_logs",
    "Full-text search across all log bodies. Uses SQLite FTS5 — supports quoted phrases and boolean operators (AND, OR, NOT).",
    {
      query: z
        .string()
        .describe(
          'Full-text search query, e.g. "connection refused" OR timeout',
        ),
      service: z.string().optional().describe("Narrow to a specific service"),
      since: z.string().optional().describe("ISO8601 start time"),
      until: z.string().optional().describe("ISO8601 end time"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe("Max rows to return (default 100)"),
    },
    async (args) => {
      const db = await adapters.mcp.resolveDb(ctx);
      return handleSearchLogs(db, args);
    },
  );

  server.tool(
    "list_services",
    "List all distinct service names seen in the logs.",
    {},
    async (_args) => {
      const db = await adapters.mcp.resolveDb(ctx);
      return handleListServices(db);
    },
  );

  server.tool(
    "summarize_errors",
    "Return a count of log entries grouped by service and level. Useful for a quick health overview.",
    {
      since: z
        .string()
        .optional()
        .describe("ISO8601 start time — omit for all-time summary"),
    },
    async (args) => {
      const db = await adapters.mcp.resolveDb(ctx);
      return handleSummarizeErrors(db, args);
    },
  );

  /**
   * tail_logs — fetch entries newer than a given cursor id.
   *
   * Results are ordered oldest-first so callers can walk forward through the
   * log stream. Pass the returned `last_id` as `after_id` on the next call to
   * continue from where you left off.
   *
   * When `query` is provided, FTS5 full-text search is used so Claude can scope
   * the live-tail session to specific keywords or phrases.
   */
  server.tool(
    "tail_logs",
    "Fetch log entries newer than a given id. Returns results oldest-first — ideal for live tailing. Pass the returned last_id as after_id on the next call. Optionally scope results with a full-text query.",
    {
      after_id: z
        .number()
        .int()
        .describe(
          "Return only logs with id greater than this. Pass 0 to start from the beginning.",
        ),
      query: z
        .string()
        .optional()
        .describe(
          'Optional FTS5 full-text query to scope the tail, e.g. "payment AND error" or "aws s3". Omit to receive all entries.',
        ),
      service: z.string().optional().describe("Filter by service name"),
      level: z
        .string()
        .optional()
        .describe("Filter by log level (e.g. error, warn, info)"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe("Max rows to return (default 50)"),
    },
    async (args) => {
      const db = await adapters.mcp.resolveDb(ctx);
      return handleTailLogs(db, args);
    },
  );

  /**
   * get_log — retrieve a single log entry by its primary-key id.
   */
  server.tool(
    "get_log",
    "Fetch a single log entry by its numeric id.",
    {
      id: z.number().int().describe("The numeric id of the log entry"),
    },
    async (args) => {
      const db = await adapters.mcp.resolveDb(ctx);
      return handleGetLog(db, args);
    },
  );

  /**
   * alert_summary — count matching log entries in a recent time window.
   *
   * Intended for threshold alerting: call this tool on a schedule and compare
   * the returned count against your alert threshold.  When `query` is provided
   * a full-text search is performed instead of the default error-level filter.
   */
  server.tool(
    "alert_summary",
    "Return a count of matching log entries in the last N minutes. Use for threshold alerts: if the count exceeds your threshold, alert your team.",
    {
      minutes: z
        .number()
        .int()
        .min(1)
        .max(10080)
        .optional()
        .describe("Time window in minutes (default 60, max 10080 = 1 week)"),
      service: z.string().optional().describe("Narrow to a specific service"),
      query: z
        .string()
        .optional()
        .describe(
          "Full-text search query; if omitted, counts errors only (level=error)",
        ),
      level: z
        .string()
        .optional()
        .describe('Log level filter — default "error" when query is not set'),
    },
    async (args) => {
      const db = await adapters.mcp.resolveDb(ctx);
      return handleAlertSummary(db, args);
    },
  );

  /**
   * watch_logs — long-poll for new log entries.
   *
   * Polls every 500 ms until new logs arrive or `timeout_seconds` elapses.
   * Returns the results oldest-first together with the last seen id so the
   * caller can chain calls to tail the live stream.
   */
  server.tool(
    "watch_logs",
    "Long-poll for new log entries. Polls every 500ms until new logs arrive or timeout_seconds elapses. Pass the returned last_id as after_id on the next call to continue tailing.",
    {
      after_id: z
        .number()
        .int()
        .describe(
          "Return only logs newer than this id. Use 0 to start from current end.",
        ),
      timeout_seconds: z
        .number()
        .min(1)
        .max(60)
        .optional()
        .describe(
          "How long to wait for new logs in seconds (default 30, max 60)",
        ),
      service: z.string().optional().describe("Filter by service name"),
      level: z
        .string()
        .optional()
        .describe("Filter by log level (e.g. error, warn, info)"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe("Max rows to return per poll (default 50)"),
    },
    async (args) => {
      const db = await adapters.mcp.resolveDb(ctx);
      return handleWatchLogs(db, args);
    },
  );

  /**
   * anomaly_hint — compare the recent error rate against the 7-day baseline.
   *
   * Computes:
   *   recent_rate   = matching events in the last `window_minutes` / window_minutes
   *   baseline_rate = matching events in the 7 days before the window / (7×24×60)
   *
   * Returns a spike factor and a plain-language interpretation so Claude can
   * surface anomalies without requiring the caller to do the arithmetic.
   */
  server.tool(
    "anomaly_hint",
    "Compare the recent error rate against the 7-day baseline. Returns a spike factor and a plain-language hint to help identify anomalies.",
    {
      window_minutes: z
        .number()
        .int()
        .min(1)
        .max(1440)
        .optional()
        .describe("Size of the recent window in minutes (default 60)"),
      service: z.string().optional().describe("Narrow to a specific service"),
      level: z
        .string()
        .optional()
        .describe('Log level to count (default "error")'),
    },
    async (args) => {
      const db = await adapters.mcp.resolveDb(ctx);
      return handleAnomalyHint(db, args);
    },
  );

  /**
   * query_field — filter by a JSON body field using a comparison operator.
   *
   * Uses `json_extract(body, '$.field') op value` so structured fields like
   * statusCode, ms, or userId can be queried with numeric comparisons — something
   * FTS5 text search cannot do.
   */
  server.tool(
    "query_field",
    "Filter logs by a named JSON body field using a comparison operator. Use this when you need numeric comparisons (e.g. ms > 500) or exact field matches that full-text search cannot express.",
    {
      field: z
        .string()
        .describe(
          "JSON body field to filter on, e.g. statusCode, ms, or meta.userId. Supports dot-notation for nested fields.",
        ),
      op: z
        .enum(["=", "!=", ">", ">=", "<", "<="])
        .describe("Comparison operator"),
      value: z
        .union([z.string(), z.number()])
        .describe("Value to compare against"),
      service: z.string().optional().describe("Narrow to a specific service"),
      since: z.string().optional().describe("ISO8601 start time"),
      until: z.string().optional().describe("ISO8601 end time"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe("Max rows to return (default 100)"),
    },
    async (args) => {
      const db = await adapters.mcp.resolveDb(ctx);
      return handleQueryField(
        db,
        args as Parameters<typeof handleQueryField>[1],
      );
    },
  );

  /**
   * histogram — time-bucketed count of log entries.
   *
   * Returns a series of (bucket_start, count) pairs that show how log volume
   * changes over time. Useful for finding spikes, idle periods, or visualising
   * a deployment's impact on error rate — without pulling raw rows.
   */
  server.tool(
    "histogram",
    "Return a time-series count of log entries grouped into equal-width time buckets. Use this to visualise log volume over time or find error rate spikes.",
    {
      bucket: z
        .enum(["1m", "5m", "15m", "1h", "6h", "1d"])
        .describe("Bucket width: 1m, 5m, 15m, 1h, 6h, or 1d"),
      service: z.string().optional().describe("Narrow to a specific service"),
      level: z
        .string()
        .optional()
        .describe("Filter by log level (e.g. error, warn, info)"),
      since: z.string().optional().describe("ISO8601 start time"),
      until: z.string().optional().describe("ISO8601 end time"),
    },
    async (args) => {
      const db = await adapters.mcp.resolveDb(ctx);
      return handleHistogram(db, args as Parameters<typeof handleHistogram>[1]);
    },
  );

  /**
   * trace_logs — fetch all events for a distributed trace.
   *
   * Retrieves every log row that shares the given trace_id, ordered
   * chronologically so the full request chain can be reconstructed in one call.
   */
  server.tool(
    "trace_logs",
    "Fetch all log entries for a given trace_id in chronological order. Use this to reconstruct the full request chain across services for a distributed trace.",
    {
      trace_id: z
        .string()
        .describe("The trace/request/correlation id to look up"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe("Max rows to return (default 200)"),
    },
    async (args) => {
      const db = await adapters.mcp.resolveDb(ctx);
      return handleTraceLogs(db, args);
    },
  );

  /**
   * query_sql — raw read-only SQL escape hatch.
   *
   * Runs a user-supplied SELECT statement directly against the logs table.
   * Use this when the structured tools cannot express a query — e.g. complex
   * GROUP BY, window functions, or multi-field correlations. Only SELECT
   * statements are accepted; semicolons are rejected to prevent stacking.
   */
  server.tool(
    "query_sql",
    "Run a read-only SELECT statement directly against the logs database. Use this as an escape hatch when the structured tools cannot express the query you need. Only SELECT statements are allowed; no semicolons.",
    {
      sql: z
        .string()
        .describe(
          "A single SELECT statement. The logs table has columns: id, received_at, service, level, trace_id, body (JSON text). Example: SELECT service, COUNT(*) as n FROM logs WHERE level='error' GROUP BY service ORDER BY n DESC",
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe("Max rows to return (default 100, max 500)"),
    },
    async (args) => {
      const db = await adapters.mcp.resolveDb(ctx);
      return handleQuerySql(db, args);
    },
  );

  return server;
}
