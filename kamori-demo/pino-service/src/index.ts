/**
 * pino-service — Inventory Check
 *
 * ──────────────────────────────────────────────────────────────────────────
 * SDK Integration: pino transport  (/sdk — createKamoriStream)
 *
 * createKamoriStream() returns a standard Node.js Writable stream. Pass it
 * to pino as the destination and every log line is automatically forwarded
 * to Kamori — no changes to existing pino call sites.
 *
 * Integration (3 lines):
 *
 *   import pino from "pino";
 *   import { createKamoriStream } from "@usekamori/sdk/pino";
 *
 *   const stream = createKamoriStream({ url, token });
 *   const logger  = pino({ base: { service: "my-service" } },
 *                         pino.multistream([{ stream: process.stdout }, { stream }]));
 *
 * Best for: teams already using pino who want zero changes to log call sites.
 * ──────────────────────────────────────────────────────────────────────────
 */

import Fastify from "fastify";
import pino from "pino";
import { createKamoriStream } from "@usekamori/sdk/pino";

const KAMORI_URL = process.env.KAMORI_URL ?? "http://localhost:3110";
const INGEST_TOKEN = process.env.INGEST_TOKEN ?? "";
const PORT = Number(process.env.PORT ?? 3500);

// ── Pino + Kamori setup ────────────────────────────────────────────────────
//
// createKamoriStream wraps a KamoriClient in a Writable stream so pino can
// write directly to it. multistream fans pino output to both stdout (so
// docker compose logs still works) and Kamori.
//
const kamoriStream = createKamoriStream({
  url: KAMORI_URL,
  ...(INGEST_TOKEN && { token: INGEST_TOKEN }),
  flushOnExit: true,
});

const logger = pino(
  {
    // Every log line will carry service + sdk fields — visible in Kamori queries
    base: { service: "pino-service", sdk: "pino+createKamoriStream" },
  },
  pino.multistream([
    { stream: process.stdout }, // keep docker compose logs working
    { stream: kamoriStream }, // forward structured JSON to Kamori
  ]),
);
// ─────────────────────────────────────────────────────────────────────────

const app = Fastify({ logger: false });

// In-memory stock ledger — resets on restart (demo only)
const STOCK: Record<string, number> = {
  "Wireless Headphones": 42,
  "Mechanical Keyboard": 15,
  "USB-C Hub": 8,
  "4K Monitor": 3,
  "Standing Desk Mat": 27,
  "Webcam HD": 19,
  "Stream Deck": 11,
  "NVMe SSD": 35,
  "RGB Mouse Pad": 50,
  "Laptop Stand": 22,
};

let requestCount = 0;

app.get("/health", async () => ({
  ok: true,
  service: "pino-service",
  sdk: "pino+createKamoriStream",
}));

app.get<{ Querystring: { item?: string; qty?: string } }>(
  "/check-inventory",
  async (request, reply) => {
    const { item = "Unknown", qty = "1" } = request.query;
    const quantity = parseInt(qty, 10) || 1;
    requestCount++;

    // Fault: every 8th request simulates an inventory-sync failure
    if (requestCount % 8 === 0) {
      logger.error({
        event: "inventory_sync_failed",
        item,
        message: "Inventory DB unreachable — serving stale cache",
      });
      return reply
        .code(503)
        .send({ ok: false, error: "inventory_sync_failed", item });
    }

    const available = STOCK[item] ?? 0;
    const inStock = available >= quantity;

    if (!inStock) {
      logger.warn({
        event: "out_of_stock",
        item,
        requested: quantity,
        available,
        message: `Insufficient stock for "${item}"`,
      });
    } else {
      logger.info({
        event: "inventory_checked",
        item,
        requested: quantity,
        available,
        inStock,
      });
    }

    return { ok: true, inStock, item, available, requested: quantity };
  },
);

app.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
  if (err) {
    logger.error({ event: "startup_failed", error: err.message });
    process.exit(1);
  }
  logger.info({ event: "server_started", port: PORT });
  console.error(`pino-service listening on :${PORT}`);
});
