/**
 * express-api — Order Orchestrator
 *
 * ──────────────────────────────────────────────────────────────────────────
 * SDK Integration: Node.js console shim  (/sdk — installShim)
 *
 * installShim() patches console.log / .warn / .error globally on Node.js.
 * Every call from that point on is forwarded to Kamori while still printing
 * to stdout. Existing code needs zero changes — just add the two lines below.
 *
 * ⚠️  Node.js only. For browser projects use /sdk/browser instead
 *    (see next-app/src/components/KamoriProvider.tsx for that pattern).
 *
 * Integration (2 lines):
 *
 *   import { installShim } from "@usekamori/sdk";
 *   installShim({ url: process.env.KAMORI_URL!, token: process.env.INGEST_TOKEN });
 *
 * Trade-off: event shape is { level, message, args } — structured fields
 * land in args[0]. For fully flat events use KamoriClient.scoped() instead
 * (see fastify-api for that pattern).
 *
 * Best for: dropping Kamori into an existing Node.js codebase with no refactoring.
 * ──────────────────────────────────────────────────────────────────────────
 */

// ── Kamori Node.js console shim ───────────────────────────────────────────
// Install before any other imports so even module-load-time logs are captured.
import { installShim } from "@usekamori/sdk";

installShim({
  url: process.env.KAMORI_URL ?? "http://localhost:3110",
  ...(process.env.INGEST_TOKEN && { token: process.env.INGEST_TOKEN }),
  flushOnExit: true, // flush buffered events on SIGTERM / SIGINT
});
// ─────────────────────────────────────────────────────────────────────────

import express from "express";

const app = express();
app.use(express.json());

const PORT             = Number(process.env.PORT             ?? 4000);
const FASTAPI_URL      = process.env.FASTAPI_URL             ?? "http://localhost:5000";
const FLASK_URL        = process.env.FLASK_URL               ?? "http://localhost:5001";
const PHP_URL          = process.env.PHP_URL                 ?? "http://localhost:6100";
const PINO_URL         = process.env.PINO_URL                ?? "http://localhost:3500";
const WINSTON_URL      = process.env.WINSTON_URL             ?? "http://localhost:3501";
const GO_SERVICE_URL   = process.env.GO_SERVICE_URL          ?? "http://localhost:7000";
const PYTHON_SDK_URL   = process.env.PYTHON_SDK_URL          ?? "http://localhost:5002";
const PHP_MONOLOG_URL  = process.env.PHP_MONOLOG_URL         ?? "http://localhost:6001";

// In-memory orders store (demo only — resets on restart)
const orders: Array<Record<string, unknown>> = [];
let orderCounter = 0;

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "express-api", sdk: "installShim" });
});

app.get("/api/orders", (_req, res) => {
  res.json(orders.slice(-20).reverse());
});

app.post("/api/orders", async (req, res) => {
  const { product, amount, userId } = req.body as {
    product: string;
    amount: number;
    userId: string;
  };

  orderCounter++;
  const orderId = `ord-${Date.now()}`;

  // All console.* calls below are forwarded to Kamori by the shim.
  // Shape: { level: "info", message: "...", args: [{ service, orderId, … }] }
  console.log("order_received", { service: "express-api", orderId, product, amount, userId });

  // ── Pino service: inventory check ─────────────────────────────────────
  try {
    const inv = await fetch(
      `${PINO_URL}/check-inventory?item=${encodeURIComponent(product)}&qty=1`,
      { signal: AbortSignal.timeout(3000) },
    );
    const invData = (await inv.json()) as { inStock?: boolean; available?: number };
    if (!invData.inStock) {
      console.warn("inventory_low", { service: "express-api", orderId, product, available: invData.available });
    }
  } catch (err) {
    console.error("inventory_check_failed", { service: "express-api", orderId, error: String(err) });
  }

  // ── FastAPI: product recommendations ──────────────────────────────────
  let recommendations: unknown[] = [];
  try {
    const fastapiRes  = await fetch(
      `${FASTAPI_URL}/recommendations?user_id=${encodeURIComponent(userId)}`,
    );
    const fastapiData = (await fastapiRes.json()) as { recommendations?: unknown[] };
    recommendations   = fastapiData.recommendations ?? [];

    // Fault: every 30th order simulates a 429 from FastAPI
    if (orderCounter % 30 === 0) {
      console.warn("upstream_rate_limited", {
        service: "express-api",
        orderId,
        upstream: "fastapi-service",
        message: "FastAPI returned 429 Too Many Requests (simulated)",
      });
      recommendations = [];
    } else {
      console.log("recommendations_fetched", { service: "express-api", orderId, count: recommendations.length });
    }
  } catch (err) {
    console.error("recommendations_failed", { service: "express-api", orderId, error: String(err) });
  }

  // ── Go service: fraud detection ───────────────────────────────────────
  try {
    const fraudRes  = await fetch(`${GO_SERVICE_URL}/check-fraud`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ orderId, amount, userId }),
      signal:  AbortSignal.timeout(3000),
    });
    const fraudData = (await fraudRes.json()) as { fraud?: boolean; risk?: string };
    if (fraudData.fraud) {
      console.warn("fraud_signal", { service: "express-api", orderId, risk: fraudData.risk });
    } else {
      console.log("fraud_check_passed", { service: "express-api", orderId, risk: fraudData.risk });
    }
  } catch (err) {
    console.error("fraud_check_failed", { service: "express-api", orderId, error: String(err) });
  }

  // ── Flask: send confirmation email ────────────────────────────────────
  try {
    const flaskRes  = await fetch(`${FLASK_URL}/send-confirmation`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ orderId, userId, product }),
    });
    const flaskData = (await flaskRes.json()) as { ok?: boolean };
    console.log("confirmation_sent", { service: "express-api", orderId, ok: flaskData.ok ?? false });
  } catch (err) {
    console.error("confirmation_failed", { service: "express-api", orderId, error: String(err) });
  }

  // ── PHP: process payment ──────────────────────────────────────────────
  try {
    const phpRes  = await fetch(`${PHP_URL}/process-payment`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ orderId, amount }),
    });
    const phpData = (await phpRes.json()) as { ok?: boolean };
    console.log("payment_processed", { service: "express-api", orderId, amount, ok: phpData.ok ?? false });
  } catch (err) {
    console.error("payment_failed", { service: "express-api", orderId, error: String(err) });
  }

  // ── Python SDK service: award loyalty points ──────────────────────────
  try {
    const loyaltyRes  = await fetch(`${PYTHON_SDK_URL}/award-loyalty`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ orderId, amount, userId }),
      signal:  AbortSignal.timeout(3000),
    });
    const loyaltyData = (await loyaltyRes.json()) as { points?: number; ok?: boolean };
    console.log("loyalty_awarded", { service: "express-api", orderId, points: loyaltyData.points ?? 0 });
  } catch (err) {
    console.error("loyalty_failed", { service: "express-api", orderId, error: String(err) });
  }

  // ── Winston service: create shipment ──────────────────────────────────
  try {
    const shipRes  = await fetch(`${WINSTON_URL}/ship`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ orderId, product, userId }),
    });
    const shipData = (await shipRes.json()) as { ok?: boolean; carrier?: string; trackingId?: string };
    console.log("shipment_created", {
      service: "express-api",
      orderId,
      carrier: shipData.carrier,
      trackingId: shipData.trackingId,
    });
  } catch (err) {
    console.error("shipment_failed", { service: "express-api", orderId, error: String(err) });
  }

  // ── PHP Monolog service: push notification ────────────────────────────
  try {
    await fetch(`${PHP_MONOLOG_URL}/notify`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ orderId, userId, event: "order_completed" }),
      signal:  AbortSignal.timeout(3000),
    });
  } catch (err) {
    console.error("notification_failed", { service: "express-api", orderId, error: String(err) });
  }

  const order = { id: orderId, product, amount, userId, status: "completed", recommendations };
  orders.push(order);

  console.log("order_completed", { service: "express-api", orderId, product, amount });

  res.json(order);
});

app.listen(PORT, () => {
  console.log("server_started", { service: "express-api", sdk: "installShim", port: PORT });
});
