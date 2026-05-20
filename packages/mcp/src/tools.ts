/**
 * MCP tool handler functions — extracted for testability.
 * Each function mirrors the async handler registered in mcp.ts.
 */

import type { DbAdapter, FieldOp, HistogramBucket, LogRow } from "@usekamori/core";
import {
  queryLogs,
  searchLogs,
  listServices,
  summarizeErrors,
  countLogs,
  countLogsFts,
  getLogById,
  queryByField,
  histogramLogs,
} from "@usekamori/core";

export type ToolResult = { content: { type: "text"; text: string }[] };

// ---------------------------------------------------------------------------
// anomaly_hint baseline cache
// Key: "<service>:<level>:<windowMinutes>", TTL: 1 hour.
// Caches the 7-day baseline count so repeated calls don't scan millions of rows.
// ---------------------------------------------------------------------------

interface BaselineEntry {
  count: number;
  expiresAt: number;
}
const _baselineCache = new Map<string, BaselineEntry>();
const BASELINE_TTL_MS = 60 * 60 * 1_000;
// Cap the cache to prevent unbounded growth under high-cardinality inputs.
// When the limit is reached the oldest entry (Map insertion order) is evicted.
const BASELINE_CACHE_MAX = 500;

// ---------------------------------------------------------------------------
// query_logs
// ---------------------------------------------------------------------------

export async function handleQueryLogs(
  adapter: DbAdapter,
  args: {
    service?: string;
    level?: string;
    since?: string;
    until?: string;
    limit?: number;
  },
): Promise<ToolResult> {
  const rows = await queryLogs(adapter, args);
  return {
    content: [
      {
        type: "text",
        text: rows.length
          ? rows.map((r) => r.body).join("\n")
          : "No logs found matching the given filters.",
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// search_logs
// ---------------------------------------------------------------------------

export async function handleSearchLogs(
  adapter: DbAdapter,
  args: {
    query: string;
    service?: string;
    since?: string;
    until?: string;
    limit?: number;
  },
): Promise<ToolResult> {
  const rows = await searchLogs(adapter, args.query, {
    service: args.service,
    since: args.since,
    until: args.until,
    limit: args.limit,
  });
  return {
    content: [
      {
        type: "text",
        text: rows.length
          ? rows.map((r) => r.body).join("\n")
          : "No logs matched the search query.",
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// list_services
// ---------------------------------------------------------------------------

export async function handleListServices(
  adapter: DbAdapter,
): Promise<ToolResult> {
  const services = await listServices(adapter);
  return {
    content: [
      {
        type: "text",
        text: services.length
          ? services.join("\n")
          : "No services found (no logs ingested yet, or no service field present).",
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// summarize_errors
// ---------------------------------------------------------------------------

export async function handleSummarizeErrors(
  adapter: DbAdapter,
  args: {
    since?: string;
  },
): Promise<ToolResult> {
  const rows = await summarizeErrors(adapter, args.since);
  if (!rows.length) {
    return { content: [{ type: "text", text: "No log data found." }] };
  }
  const lines = rows.map(
    (r) =>
      `service=${r.service ?? "(unknown)"}  level=${r.level ?? "(unknown)"}  count=${r.count}`,
  );
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

// ---------------------------------------------------------------------------
// tail_logs
// ---------------------------------------------------------------------------

export async function handleTailLogs(
  adapter: DbAdapter,
  args: {
    after_id: number;
    query?: string;
    service?: string;
    level?: string;
    limit?: number;
  },
): Promise<ToolResult> {
  const rows = args.query
    ? await searchLogs(adapter, args.query, {
        after_id: args.after_id,
        service: args.service,
        limit: args.limit ?? 50,
      })
    : await queryLogs(adapter, {
        after_id: args.after_id,
        service: args.service,
        level: args.level,
        limit: args.limit ?? 50,
      });

  const last_id = rows.length ? rows[rows.length - 1].id : args.after_id;

  const text = rows.length
    ? `${rows.length} new log(s). last_id=${last_id}\n\n${rows.map((r) => r.body).join("\n")}`
    : `No new logs. last_id=${last_id} (pass as after_id on next call)`;

  return { content: [{ type: "text", text }] };
}

// ---------------------------------------------------------------------------
// get_log
// ---------------------------------------------------------------------------

export async function handleGetLog(
  adapter: DbAdapter,
  args: { id: number },
): Promise<ToolResult> {
  const row = await getLogById(adapter, args.id);
  const text = row ? row.body : `Log id=${args.id} not found.`;
  return { content: [{ type: "text", text }] };
}

// ---------------------------------------------------------------------------
// alert_summary
// ---------------------------------------------------------------------------

export async function handleAlertSummary(
  adapter: DbAdapter,
  args: {
    minutes?: number;
    service?: string;
    query?: string;
    level?: string;
  },
): Promise<ToolResult> {
  const since = new Date(
    Date.now() - (args.minutes ?? 60) * 60_000,
  ).toISOString();

  let count: number;
  if (args.query) {
    // Use countLogsFts for an exact count — searchLogs is capped at 500 rows
    // and would silently undercount any window with more than 500 matches.
    count = await countLogsFts(adapter, args.query, {
      since,
      service: args.service,
    });
  } else {
    count = await countLogs(adapter, {
      since,
      service: args.service,
      level: args.level ?? "error",
    });
  }

  const text = `${count} matching log entries in the last ${args.minutes ?? 60} minutes.`;
  return { content: [{ type: "text", text }] };
}

// ---------------------------------------------------------------------------
// watch_logs
// ---------------------------------------------------------------------------

export async function handleWatchLogs(
  adapter: DbAdapter,
  args: {
    after_id: number;
    timeout_seconds?: number;
    service?: string;
    level?: string;
    limit?: number;
  },
): Promise<ToolResult> {
  const deadline = Date.now() + (args.timeout_seconds ?? 15) * 1000;
  let current_id = args.after_id;

  // Exponential backoff when no logs arrive: 1 s → 2 s → 4 s → 5 s (capped).
  // Resets to 1 s when new logs are found. Avoids hammering SQLite on idle watches.
  let pollMs = 1_000;
  const MAX_POLL_MS = 5_000;

  while (Date.now() < deadline) {
    const rows = await queryLogs(adapter, {
      after_id: current_id,
      service: args.service,
      level: args.level,
      limit: args.limit ?? 50,
    });

    if (rows.length > 0) {
      const last_id = rows[rows.length - 1].id;
      const text = `${rows.length} new log(s). last_id=${last_id}\n\n${rows
        .map((r) => r.body)
        .join("\n")}`;
      return { content: [{ type: "text", text }] };
    }

    const wait = Math.min(pollMs, deadline - Date.now());
    if (wait <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, wait));
    pollMs = Math.min(pollMs * 2, MAX_POLL_MS);
  }

  const elapsed = Math.round(args.timeout_seconds ?? 15);
  const text = `No new logs in ${elapsed}s. last_id=${current_id} (pass as after_id to continue)`;
  return { content: [{ type: "text", text }] };
}

// ---------------------------------------------------------------------------
// query_field
// ---------------------------------------------------------------------------

export async function handleQueryField(
  adapter: DbAdapter,
  args: {
    field: string;
    op: FieldOp;
    value: string | number;
    service?: string;
    since?: string;
    until?: string;
    limit?: number;
  },
): Promise<ToolResult> {
  try {
    const rows = await queryByField(adapter, args);
    return {
      content: [
        {
          type: "text",
          text: rows.length
            ? rows.map((r) => r.body).join("\n")
            : `No logs found where ${args.field} ${args.op} ${JSON.stringify(args.value)}.`,
        },
      ],
    };
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text: `Error: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }
}

// ---------------------------------------------------------------------------
// histogram
// ---------------------------------------------------------------------------

export async function handleHistogram(
  adapter: DbAdapter,
  args: {
    bucket: HistogramBucket;
    service?: string;
    level?: string;
    since?: string;
    until?: string;
  },
): Promise<ToolResult> {
  // Default to the last 7 days when no since is supplied. Without a lower
  // bound, histogramLogs performs a full table scan (GROUP BY strftime(...)
  // cannot use the received_at index without a WHERE clause). On large tables
  // this is a multi-second blocking call. 7 days is the right default: wide
  // enough to show weekly patterns, narrow enough to keep the scan bounded.
  const since = args.since ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const rows = await histogramLogs(adapter, { ...args, since });
  if (!rows.length) {
    return { content: [{ type: "text", text: "No log data found for the given filters." }] };
  }
  const lines = rows.map((r) => `${r.bucket}  count=${r.count}`);
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

// ---------------------------------------------------------------------------
// trace_logs
// ---------------------------------------------------------------------------

export async function handleTraceLogs(
  adapter: DbAdapter,
  args: { trace_id: string; limit?: number },
): Promise<ToolResult> {
  // after_id: 0 triggers oldest-first ordering in queryLogs (id > 0 = all rows)
  // which gives chronological order for trace reconstruction.
  const rows = await queryLogs(adapter, {
    trace_id: args.trace_id,
    after_id: 0,
    limit: args.limit ?? 200,
  });
  return {
    content: [
      {
        type: "text",
        text: rows.length
          ? rows.map((r) => r.body).join("\n")
          : `No logs found for trace_id="${args.trace_id}".`,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// query_sql
// ---------------------------------------------------------------------------

const READ_ONLY_RE = /^\s*select\b/i;
// Tables the AI is allowed to read. Subquery parentheses are handled because
// the regex requires an identifier character immediately after FROM/JOIN —
// `FROM (SELECT ...)` produces no match and passes through cleanly.
const ALLOWED_TABLES = new Set(["logs", "logs_fts"]);
const TABLE_REF_RE = /(?:from|join)\s+([a-zA-Z_][a-zA-Z0-9_]*)/gi;

function extractTableNames(sql: string): string[] {
  const names: string[] = [];
  let m: RegExpExecArray | null;
  TABLE_REF_RE.lastIndex = 0;
  while ((m = TABLE_REF_RE.exec(sql)) !== null) {
    names.push(m[1].toLowerCase());
  }
  return names;
}

export async function handleQuerySql(
  adapter: DbAdapter,
  args: { sql: string; limit?: number },
): Promise<ToolResult> {
  const sql = args.sql.trim();

  if (!READ_ONLY_RE.test(sql)) {
    return {
      content: [{ type: "text", text: "Error: only SELECT statements are allowed." }],
    };
  }
  if (sql.includes(";")) {
    return {
      content: [
        {
          type: "text",
          text: "Error: semicolons are not allowed — use a single SELECT statement.",
        },
      ],
    };
  }

  // Restrict table access to the logs schema only. This prevents the AI from
  // reading sqlite_master, sqlite_sequence, or any other internal/system tables.
  const tables = extractTableNames(sql);
  const disallowed = tables.filter((t) => !ALLOWED_TABLES.has(t));
  if (disallowed.length > 0) {
    return {
      content: [
        {
          type: "text",
          text: `Error: query references disallowed table(s): ${disallowed.join(", ")}. Only the 'logs' table is available.`,
        },
      ],
    };
  }

  const limit = Math.min(args.limit ?? 100, 500);

  try {
    // Wrap in a subquery so any inner ORDER BY is preserved while still
    // enforcing the row cap without requiring the user to add LIMIT themselves.
    const rows = await adapter.query<Record<string, unknown>>(
      `SELECT * FROM (${sql}) LIMIT ${limit}`,
    );
    return {
      content: [
        {
          type: "text",
          text: rows.length
            ? rows.map((r) => JSON.stringify(r)).join("\n")
            : "Query returned no rows.",
        },
      ],
    };
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text: `SQL error: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }
}

// ---------------------------------------------------------------------------
// anomaly_hint
// ---------------------------------------------------------------------------

export async function handleAnomalyHint(
  adapter: DbAdapter,
  args: {
    window_minutes?: number;
    service?: string;
    level?: string;
  },
): Promise<ToolResult> {
  const windowMs = (args.window_minutes ?? 60) * 60_000;
  const now = Date.now();

  const recentSince = new Date(now - windowMs).toISOString();
  const recentCount = await countLogs(adapter, {
    since: recentSince,
    service: args.service,
    level: args.level ?? "error",
  });

  const baselineDays = 7;
  const baselineSince = new Date(
    now - windowMs - baselineDays * 86_400_000,
  ).toISOString();

  const cacheKey = `${args.service ?? ""}:${args.level ?? "error"}:${args.window_minutes ?? 60}`;
  const cached = _baselineCache.get(cacheKey);
  let baselineCount: number;
  if (cached && Date.now() < cached.expiresAt) {
    baselineCount = cached.count;
  } else {
    baselineCount = await countLogs(adapter, {
      since: baselineSince,
      until: recentSince,
      service: args.service,
      level: args.level ?? "error",
    });
    if (_baselineCache.size >= BASELINE_CACHE_MAX) {
      // Evict the oldest entry (Map preserves insertion order)
      const oldest = _baselineCache.keys().next().value;
      if (oldest !== undefined) _baselineCache.delete(oldest);
    }
    _baselineCache.set(cacheKey, {
      count: baselineCount,
      expiresAt: Date.now() + BASELINE_TTL_MS,
    });
  }

  const recentRate = recentCount / (args.window_minutes ?? 60);
  const baselineRate = baselineCount / (baselineDays * 24 * 60);

  let spike: string;
  let hint: string;

  if (baselineRate === 0) {
    spike = recentCount > 0 ? "∞" : "1.0";
    hint =
      recentCount > 0
        ? `No baseline data — ${recentCount} ${args.level ?? "error"}(s) in the last ${args.window_minutes ?? 60} min with no prior history.`
        : `No ${args.level ?? "error"} logs in the recent window or 7-day baseline. All clear.`;
  } else {
    const factor = recentRate / baselineRate;
    spike = factor.toFixed(1) + "x";
    const expected = (baselineRate * (args.window_minutes ?? 60)).toFixed(1);
    if (factor < 1.5) {
      hint = `Rate is normal (${spike} of baseline). ${recentCount} event(s) in window vs ${expected} expected.`;
    } else if (factor < 5) {
      hint = `Mild spike detected (${spike} above baseline). Worth monitoring. ${recentCount} event(s) vs ${expected} expected.`;
    } else {
      hint = `Significant spike (${spike} above baseline)! ${recentCount} event(s) in the last ${args.window_minutes ?? 60} min vs ${expected} expected. Investigate immediately.`;
    }
  }

  const text = [
    `anomaly_hint${args.service ? ` service=${args.service}` : ""} level=${args.level ?? "error"} window=${args.window_minutes ?? 60}min`,
    ``,
    `recent_count   : ${recentCount}`,
    `baseline_count : ${baselineCount} (over ${baselineDays} days)`,
    `recent_rate    : ${recentRate.toFixed(3)} events/min`,
    `baseline_rate  : ${baselineRate.toFixed(3)} events/min`,
    `spike_factor   : ${spike}`,
    ``,
    hint,
  ].join("\n");

  return { content: [{ type: "text", text }] };
}
