/**
 * E2E tests — full SDK → server → MCP pipeline.
 *
 * Starts a real Fastify server on a random port, sends log events over real
 * HTTP (as any SDK would), then queries them back via MCP tool handlers that
 * read from the same SQLite database. No mocks anywhere in the stack.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import os from "os";
import path from "path";
import { randomBytes, createHmac } from "crypto";
import fs from "fs";
import http from "http";
import {
  BetterSqliteAdapter,
  queryLogs,
  EnvTokenAuth,
  NoBillingAdapter,
  NoopEmailAdapter,
  EnvRetentionAdapter,
  LocalDbMcpAdapter,
} from "@usekamori/core";
import type { KamoriAdapters } from "@usekamori/core";

const originalEnv = { ...process.env };
let dbPath: string;
let adapter: BetterSqliteAdapter;
let app: FastifyInstance;
let baseUrl: string;

const TOKEN = "e2e-test-secret";

const buildAndListen = async (): Promise<{
  app: FastifyInstance;
  url: string;
}> => {
  const { default: v1Routes } = await import("./routes/v1.js");
  const adapters: KamoriAdapters = {
    db: adapter,
    auth: new EnvTokenAuth(TOKEN),
    billing: new NoBillingAdapter(),
    email: new NoopEmailAdapter(),
    retention: new EnvRetentionAdapter(0),
    mcp: new LocalDbMcpAdapter(adapter),
  };
  const server = Fastify({ logger: false });
  await server.register(v1Routes(adapters), { prefix: "/v1" });
  const address = await server.listen({ port: 0, host: "127.0.0.1" });
  return { app: server, url: address };
};

beforeEach(async () => {
  vi.resetModules();
  dbPath = path.join(
    os.tmpdir(),
    `e2e-test-${randomBytes(8).toString("hex")}.db`,
  );
  process.env.DB_PATH = dbPath;
  process.env.INGEST_TOKEN = TOKEN;
  process.env.MAX_ROWS = "500";
  process.env.MCP_PORT = "0";

  adapter = new BetterSqliteAdapter(dbPath);
  const server = await buildAndListen();
  app = server.app;
  baseUrl = server.url;
});

afterEach(async () => {
  await app.close();
  process.env = { ...originalEnv };
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(dbPath + suffix);
    } catch {}
  }
});

// ---------------------------------------------------------------------------
// Helper: send events to the real server over HTTP
// ---------------------------------------------------------------------------

async function ingestHTTP(
  events: Record<string, unknown> | Record<string, unknown>[],
): Promise<{ ok: boolean; written?: number }> {
  const res = await fetch(`${baseUrl}/v1/ingest`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify(events),
  });
  return res.json() as Promise<{ ok: boolean; written?: number }>;
}

// ---------------------------------------------------------------------------
// E2E: Auth rejection
// ---------------------------------------------------------------------------

describe("E2E: Auth rejection", () => {
  it("returns 401 when Authorization header is missing", async () => {
    const res = await fetch(`${baseUrl}/v1/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([{ message: "no token", seq: 1 }]),
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 when Authorization token is wrong", async () => {
    const res = await fetch(`${baseUrl}/v1/ingest`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer wrong-token",
      },
      body: JSON.stringify([{ message: "bad token", seq: 1 }]),
    });
    expect(res.status).toBe(401);
  });

  it("accepts a single event object (not array)", async () => {
    const result = await ingestHTTP({
      service: "single",
      level: "info",
      message: "single event",
    });
    expect(result.ok).toBe(true);
    expect(result.written).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// E2E: Health check
// ---------------------------------------------------------------------------

describe("E2E: Health check", () => {
  it("GET /v1/health returns 200 with ok:true", async () => {
    const res = await fetch(`${baseUrl}/v1/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// E2E: SDK ingest → MCP query (tools read directly from the shared adapter)
// ---------------------------------------------------------------------------

describe("E2E: HTTP ingest → MCP query_logs", () => {
  it("logs ingested over HTTP are visible via MCP query_logs", async () => {
    const result = await ingestHTTP([
      {
        service: "payments",
        level: "error",
        message: "stripe timeout",
        seq: 1,
      },
      {
        service: "payments",
        level: "info",
        message: "webhook received",
        seq: 2,
      },
    ]);
    expect(result.ok).toBe(true);
    expect(result.written).toBe(2);

    const { handleQueryLogs } = await import("/mcp/tools");
    const mcpResult = await handleQueryLogs(adapter, { service: "payments" });
    const text = mcpResult.content[0].text;

    expect(text).toContain("stripe timeout");
    expect(text).toContain("webhook received");
  });
});

describe("E2E: HTTP ingest → MCP search_logs", () => {
  it("FTS search via MCP finds logs ingested over HTTP", async () => {
    await ingestHTTP([
      { message: "connection refused to postgres", seq: 1 },
      { message: "all systems operational", seq: 2 },
    ]);

    const { handleSearchLogs } = await import("/mcp/tools");
    const result = await handleSearchLogs(adapter, { query: "connection" });
    const text = result.content[0].text;

    expect(text).toContain("connection refused");
    expect(text).not.toContain("all systems operational");
  });
});

describe("E2E: HTTP ingest → MCP list_services + summarize_errors", () => {
  it("service names and error counts reflect HTTP-ingested logs", async () => {
    await ingestHTTP([
      { service: "auth", level: "error", message: "jwt expired", seq: 1 },
      { service: "auth", level: "error", message: "jwt invalid", seq: 2 },
      { service: "api", level: "info", message: "ready", seq: 1 },
    ]);

    const { handleListServices, handleSummarizeErrors } =
      await import("/mcp/tools");

    const services = await handleListServices(adapter);
    const serviceList = services.content[0].text.split("\n");
    expect(serviceList).toContain("auth");
    expect(serviceList).toContain("api");

    const summary = await handleSummarizeErrors(adapter, {});
    expect(summary.content[0].text).toMatch(
      /service=auth\s+level=error\s+count=2/,
    );
  });
});

describe("E2E: HTTP ingest → cursor tail → HTTP ingest more → tail continues", () => {
  it("tail_logs cursor advances correctly across two HTTP ingest batches", async () => {
    await ingestHTTP([
      { batch: 1, seq: 1 },
      { batch: 1, seq: 2 },
    ]);

    const { handleTailLogs } = await import("/mcp/tools");

    const firstBatch = await queryLogs(adapter, {});
    const cursor = Math.max(...firstBatch.map((r) => r.id));

    await ingestHTTP([
      { batch: 2, seq: 1 },
      { batch: 2, seq: 2 },
    ]);

    const tailResult = await handleTailLogs(adapter, { after_id: cursor });
    const text = tailResult.content[0].text;
    expect(text).toContain("2 new log(s)");

    const newLogs = await queryLogs(adapter, { after_id: cursor });
    newLogs.forEach((log) => {
      expect(JSON.parse(log.body)).toMatchObject({ batch: 2 });
    });
  });
});

describe("E2E: HTTP ingest → MCP alert_summary threshold check", () => {
  it("alert_summary counts recent errors ingested via HTTP", async () => {
    await ingestHTTP([
      { level: "error", service: "checkout", seq: 1 },
      { level: "error", service: "checkout", seq: 2 },
      { level: "error", service: "checkout", seq: 3 },
    ]);

    const { handleAlertSummary } = await import("/mcp/tools");
    const result = await handleAlertSummary(adapter, {
      minutes: 60,
      service: "checkout",
      level: "error",
    });

    expect(result.content[0].text).toContain("3 matching log entries");
  });
});

describe("E2E: HTTP ingest → server DELETE → MCP sees empty", () => {
  it("logs deleted via HTTP are no longer visible via MCP", async () => {
    await ingestHTTP([{ service: "old-svc", message: "going away", seq: 1 }]);

    const deleteRes = await fetch(`${baseUrl}/v1/logs?service=old-svc`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const deleteJson = (await deleteRes.json()) as {
      ok: boolean;
      deleted: number;
    };
    expect(deleteJson.deleted).toBe(1);

    const { handleQueryLogs } = await import("/mcp/tools");
    const result = await handleQueryLogs(adapter, { service: "old-svc" });
    expect(result.content[0].text).toBe(
      "No logs found matching the given filters.",
    );
  });
});

describe("E2E: HTTP ingest → GET /v1/export", () => {
  it("exports ingested logs as NDJSON", async () => {
    await ingestHTTP([
      { service: "exporter", level: "info", message: "export me", seq: 1 },
      { service: "exporter", level: "warn", message: "also export", seq: 2 },
    ]);

    const res = await fetch(`${baseUrl}/v1/export?service=exporter`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);

    const text = await res.text();
    const lines = text.trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(2);

    const first = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(typeof first.received_at).toBe("string");
    expect(typeof first.body).toBe("string");
  });
});

describe("E2E: GET /v1/summary reflects ingested data", () => {
  it("summary counts match the ingested batch", async () => {
    await ingestHTTP([
      { service: "summary-svc", level: "error", message: "e1", seq: 1 },
      { service: "summary-svc", level: "error", message: "e2", seq: 2 },
      { service: "summary-svc", level: "info", message: "i1", seq: 3 },
    ]);

    const res = await fetch(`${baseUrl}/v1/summary`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);

    const rows = (await res.json()) as {
      service: string;
      level: string;
      count: number;
    }[];
    const errors = rows.find(
      (r) => r.service === "summary-svc" && r.level === "error",
    );
    const infos = rows.find(
      (r) => r.service === "summary-svc" && r.level === "info",
    );
    expect(errors?.count).toBeGreaterThanOrEqual(2);
    expect(infos?.count).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// E2E: JS SDK KamoriClient → server → MCP (real SDK, real HTTP, real DB)
// ---------------------------------------------------------------------------

describe("E2E: JS KamoriClient SDK → server → MCP query", () => {
  it("events buffered and flushed via KamoriClient reach the server and are queryable", async () => {
    const { KamoriClient } = await import("@usekamori/sdk");

    const client = new KamoriClient({
      url: baseUrl,
      token: TOKEN,
      flushInterval: 99999, // disable auto-flush; we call flush() explicitly
    });

    client.log({ service: "sdk-e2e", level: "info", message: "from sdk" });
    client.log({ service: "sdk-e2e", level: "error", message: "sdk error" });
    client.flush(); // fire-and-forget — wait for the HTTP round-trip to complete
    await new Promise<void>((r) => setTimeout(r, 300));

    const { handleQueryLogs } = await import("/mcp/tools");
    const result = await handleQueryLogs(adapter, { service: "sdk-e2e" });
    const text = result.content[0].text;
    expect(text).toContain("from sdk");
    expect(text).toContain("sdk error");
  });

  it("scoped KamoriClient merges default fields into every event", async () => {
    const { KamoriClient } = await import("@usekamori/sdk");

    const client = new KamoriClient({
      url: baseUrl,
      token: TOKEN,
      flushInterval: 99999,
    });
    const scoped = client.scoped({ service: "scoped-e2e", env: "test" });

    scoped.log({ level: "warn", message: "scoped message" });
    client.flush(); // fire-and-forget
    await new Promise<void>((r) => setTimeout(r, 300));

    const { handleQueryLogs } = await import("/mcp/tools");
    const result = await handleQueryLogs(adapter, { service: "scoped-e2e" });
    expect(result.content[0].text).toContain("scoped message");
  });
});

// ---------------------------------------------------------------------------
// E2E: Webhook ingest → MCP query
// ---------------------------------------------------------------------------

describe("E2E: webhook ingest → MCP query", () => {
  it("returns 400 for an unknown webhook provider", async () => {
    const payload = {
      event: "deploy.succeeded",
      project: "my-app",
      env: "production",
    };
    const res = await fetch(`${baseUrl}/v1/webhook/custom-ci`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain("unknown webhook provider");
  });

  it("accepts Vercel webhook without a configured secret (signature check skipped)", async () => {
    const payload = {
      type: "deployment.succeeded",
      url: "https://my-app.vercel.app",
    };
    const res = await fetch(`${baseUrl}/v1/webhook/vercel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; written: number };
    expect(json.ok).toBe(true);
    expect(json.written).toBe(1);
  });

  it("accepts GitHub webhook with a valid HMAC-SHA256 signature", async () => {
    // The server reads WEBHOOK_SECRET_GITHUB from /core, which is
    // evaluated at module import time. vi.resetModules() + a fresh buildAndListen()
    // here picks up the env var set below.
    const secret = "gh-e2e-secret";
    process.env.WEBHOOK_SECRET_GITHUB = secret;

    // Build a fresh server that sees the secret
    await app.close();
    vi.resetModules();
    const fresh = await buildAndListen();
    app = fresh.app;
    baseUrl = fresh.url;

    const body = JSON.stringify({ action: "push", ref: "refs/heads/main" });
    const sig =
      "sha256=" + createHmac("sha256", secret).update(body).digest("hex");

    const res = await fetch(`${baseUrl}/v1/webhook/github`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": sig,
      },
      body,
    });
    expect(res.status).toBe(200);

    delete process.env.WEBHOOK_SECRET_GITHUB;
  });

  it("rejects a GitHub webhook with a wrong HMAC signature when secret is configured", async () => {
    process.env.WEBHOOK_SECRET_GITHUB = "correct-secret";

    await app.close();
    vi.resetModules();
    const fresh = await buildAndListen();
    app = fresh.app;
    baseUrl = fresh.url;

    const res = await fetch(`${baseUrl}/v1/webhook/github`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": "sha256=deadbeef",
      },
      body: JSON.stringify({ action: "push" }),
    });
    expect(res.status).toBe(401);

    delete process.env.WEBHOOK_SECRET_GITHUB;
  });
});

// ---------------------------------------------------------------------------
// E2E: NDJSON live stream — GET /v1/stream
// ---------------------------------------------------------------------------

describe("E2E: NDJSON live stream", () => {
  it("delivers pre-ingested events as NDJSON lines within the first poll cycle", async () => {
    // Ingest before opening the stream so the first 500 ms poll cycle returns data
    await ingestHTTP([
      { service: "streamer", level: "info", seq: 1 },
      { service: "streamer", level: "warn", seq: 2 },
    ]);

    // Use node:http directly — native fetch does not reliably stream
    // chunked responses in all Node.js versions.
    const parsed = new URL(`${baseUrl}/v1/stream`);
    const collectedLines = await new Promise<string[]>((resolve, reject) => {
      const lines: string[] = [];
      let buf = "";

      const req = http.get(
        {
          hostname: parsed.hostname,
          port: parsed.port,
          path: "/v1/stream",
          headers: { authorization: `Bearer ${TOKEN}` },
        },
        (res) => {
          expect(res.statusCode).toBe(200);
          expect(res.headers["content-type"]).toContain("application/x-ndjson");

          res.on("data", (chunk: Buffer) => {
            buf += chunk.toString();
            const parts = buf.split("\n");
            buf = parts.pop()!;
            lines.push(...parts.filter(Boolean));
            if (lines.length >= 2) {
              req.destroy();
            }
          });
          res.on("end", () => resolve(lines));
          res.on("error", (err) => {
            // ECONNRESET is expected when we destroy the request
            if ((err as NodeJS.ErrnoException).code !== "ECONNRESET")
              reject(err);
            else resolve(lines);
          });
        },
      );

      req.on("error", (err) => {
        if ((err as NodeJS.ErrnoException).code !== "ECONNRESET") reject(err);
        else resolve(lines);
      });

      // Safety valve: give up after 2 s (covers the initial poll + heartbeat window)
      setTimeout(() => {
        req.destroy();
        resolve(lines);
      }, 2000);
    });

    expect(collectedLines.length).toBeGreaterThanOrEqual(2);
    const row = JSON.parse(collectedLines[0]) as Record<string, unknown>;
    expect(typeof row.id).toBe("number");
    expect(typeof row.received_at).toBe("string");
    expect(typeof row.body).toBe("string");
  }, 5000);

  it("delivers a log event-driven (EventEmitter wakeup) without waiting for the heartbeat", async () => {
    // Open the stream first with no pre-existing data.
    // The log is ingested AFTER the connection is established, so it must be
    // delivered via the in-process EventEmitter — not the 5-second heartbeat.
    //
    // Note: with no pre-existing rows the PassThrough writes nothing on the
    // initial poll, so the server never flushes HTTP headers until data arrives.
    // We cannot wait for the http.get callback before ingesting — instead we
    // ingest after a short delay to ensure the server's EventEmitter listener
    // is registered, then the first stream.write() flushes headers + data.
    const parsed = new URL(`${baseUrl}/v1/stream`);

    const collectedLines = await new Promise<string[]>((resolve, reject) => {
      const lines: string[] = [];
      let buf = "";

      const req = http.get(
        {
          hostname: parsed.hostname,
          port: parsed.port,
          path: "/v1/stream",
          headers: { authorization: `Bearer ${TOKEN}` },
        },
        (res) => {
          // Headers arrive only after the EventEmitter fires and stream.write()
          // flushes the response. Status must still be 200.
          if (res.statusCode !== 200) {
            reject(new Error(`expected 200, got ${res.statusCode}`));
            req.destroy();
            return;
          }

          res.on("data", (chunk: Buffer) => {
            buf += chunk.toString();
            const parts = buf.split("\n");
            buf = parts.pop()!;
            lines.push(...parts.filter(Boolean));
            if (lines.length >= 1) req.destroy();
          });
          res.on("end", () => resolve(lines));
          res.on("error", (err) => {
            if ((err as NodeJS.ErrnoException).code !== "ECONNRESET")
              reject(err);
            else resolve(lines);
          });
        },
      );

      req.on("error", (err) => {
        if ((err as NodeJS.ErrnoException).code !== "ECONNRESET") reject(err);
        else resolve(lines);
      });

      // After 50 ms the server's stream handler has registered its EventEmitter
      // listener (the entire async setup takes < 5 ms on loopback). Ingesting
      // after that delay guarantees the emit finds a live listener.
      setTimeout(() => {
        ingestHTTP([
          { service: "event-stream", level: "info", message: "wakeup", seq: 1 },
        ]).catch(reject);
      }, 50);

      // Safety valve: 1.5 s — fast enough to distinguish event-driven from
      // heartbeat (5 s) while still well within the Vitest 5 s timeout.
      setTimeout(() => {
        req.destroy();
        resolve(lines);
      }, 1500);
    });

    expect(collectedLines.length).toBeGreaterThanOrEqual(1);
    const row = JSON.parse(collectedLines[0]) as Record<string, unknown>;
    const body = JSON.parse(row.body as string) as Record<string, unknown>;
    expect(body.message).toBe("wakeup");
  }, 5000);
});
