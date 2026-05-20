/**
 * winston-service — Shipping & Fulfillment
 *
 * ──────────────────────────────────────────────────────────────────────────
 * SDK Integration: winston transport  (/sdk — KamoriTransport)
 *
 * KamoriTransport is a drop-in winston transport. Add it to any existing
 * winston logger and every log entry is forwarded to Kamori automatically.
 * No changes to existing logging call sites.
 *
 * Integration (4 lines):
 *
 *   import winston from "winston";
 *   import { KamoriTransport } from "@usekamori/sdk/winston";
 *
 *   const logger = winston.createLogger({
 *     transports: [
 *       new winston.transports.Console(),   // keep existing transports
 *       new KamoriTransport({ url, token }), // add Kamori alongside them
 *     ],
 *   });
 *
 * Best for: teams already using winston who want zero changes to log call sites.
 * ──────────────────────────────────────────────────────────────────────────
 */

import express from "express";
import winston from "winston";
import { KamoriTransport } from "@usekamori/sdk/winston";

const KAMORI_URL    = process.env.KAMORI_URL    ?? "http://localhost:3110";
const INGEST_TOKEN = process.env.INGEST_TOKEN ?? "";
const PORT         = Number(process.env.PORT  ?? 3501);

// ── Winston + Kamori setup ─────────────────────────────────────────────────
//
// KamoriTransport is added alongside the existing Console transport.
// defaultMeta injects service + sdk into every log entry automatically.
//
const logger = winston.createLogger({
  level: "info",
  defaultMeta: { service: "winston-service", sdk: "winston+KamoriTransport" },
  transports: [
    // Existing transport — keep for docker compose logs output
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple(),
      ),
    }),
    // Kamori transport — receives every entry with full structured metadata
    new KamoriTransport({
      url: KAMORI_URL,
      ...(INGEST_TOKEN && { token: INGEST_TOKEN }),
      flushOnExit: true,
    }),
  ],
});
// ─────────────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

const CARRIERS = ["FedEx", "UPS", "DHL", "USPS"];
let shipmentCounter = 0;

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "winston-service", sdk: "winston+KamoriTransport" });
});

app.post("/ship", (req, res) => {
  const { orderId, product, userId } = req.body as {
    orderId: string;
    product: string;
    userId: string;
  };

  shipmentCounter++;
  const carrier    = CARRIERS[shipmentCounter % CARRIERS.length];
  const trackingId = `TRK-${Date.now().toString(36).toUpperCase()}`;

  // Fault: every 25th shipment simulates a carrier API timeout
  if (shipmentCounter % 25 === 0) {
    logger.error("carrier_timeout", {
      event:   "carrier_timeout",
      orderId,
      carrier,
      message: `Carrier API timeout after 30s — shipment queued for retry`,
    });
    return res.status(503).json({
      ok: false,
      error: "carrier_timeout",
      orderId,
      carrier,
    });
  }

  logger.info("shipment_created", {
    event: "shipment_created",
    orderId,
    product,
    userId,
    carrier,
    trackingId,
  });

  res.json({ ok: true, orderId, carrier, trackingId });
});

app.listen(PORT, () => {
  logger.info("server_started", { event: "server_started", port: PORT });
  console.log(`winston-service listening on port ${PORT}`);
});
