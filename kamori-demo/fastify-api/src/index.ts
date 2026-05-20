/**
 * fastify-api — Product Search
 *
 * ──────────────────────────────────────────────────────────────────────────
 * SDK Integration: direct client  (/sdk — KamoriClient + scoped())
 *
 * KamoriClient gives full control over the event structure. scoped() creates
 * a child client that merges default fields into every event — ideal for
 * binding service name, version, or environment once and reusing everywhere.
 *
 * Integration:
 *
 *   import { KamoriClient } from "@usekamori/sdk";
 *
 *   // Create once per process (singleton)
 *   const kamori = new KamoriClient({ url, token, flushOnExit: true })
 *     .scoped({ service: "my-service", env: process.env.NODE_ENV });
 *
 *   // Log anywhere — default fields are merged automatically
 *   kamori.log({ level: "info", event: "search", query });
 *
 * Best for: new services or when you want fully structured, flat events.
 * ──────────────────────────────────────────────────────────────────────────
 */

import Fastify from "fastify";
import { KamoriClient } from "@usekamori/sdk";

const PORT = Number(process.env.PORT ?? 4001);

// ── KamoriClient setup ─────────────────────────────────────────────────────
//
// Create one KamoriClient per process and use .scoped() to attach default
// fields that appear on every event without repeating them at call sites.
// The scoped client shares the same buffer and HTTP transport as the parent.
//
const kamori = new KamoriClient({
  url: process.env.KAMORI_URL ?? "http://localhost:3110",
  ...(process.env.INGEST_TOKEN && { token: process.env.INGEST_TOKEN }),
  flushOnExit: true,
}).scoped({
  service: "fastify-api",
  sdk: "KamoriClient+scoped",
});
// ─────────────────────────────────────────────────────────────────────────

const fastify = Fastify({ logger: false });

fastify.get("/health", async () => ({
  ok: true,
  service: "fastify-api",
  sdk: "KamoriClient+scoped",
}));

fastify.get<{ Querystring: { q?: string } }>("/api/search", async (request) => {
  const { q = "" } = request.query;

  // service + sdk fields are prepended by .scoped() — no need to repeat them
  kamori.log({ level: "info", event: "search", query: q });

  const results = q
    ? [
        { id: 1, title: `Result for "${q}"`, score: 0.95 },
        { id: 2, title: `Related to "${q}"`, score: 0.82 },
        { id: 3, title: `Also matching "${q}"`, score: 0.71 },
      ]
    : [];

  return { results, query: q, count: results.length };
});

fastify.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
  if (err) {
    kamori.log({ level: "error", event: "startup_failed", error: err.message });
    process.exit(1);
  }
  kamori.log({ level: "info", event: "server_started", port: PORT });
  console.log(`fastify-api listening on :${PORT}`);
});
