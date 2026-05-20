"use strict";
var __importDefault =
  (this && this.__importDefault) ||
  function (mod) {
    return mod && mod.__esModule ? mod : { default: mod };
  };
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const kamori_js_1 = require("./lib/kamori.js");
const app = (0, express_1.default)();
app.use(express_1.default.json());
const PORT = Number(process.env.PORT ?? 4000);
const FASTAPI_URL = process.env.FASTAPI_URL ?? "http://localhost:5000";
const FLASK_URL = process.env.FLASK_URL ?? "http://localhost:5001";
const PHP_URL = process.env.PHP_URL ?? "http://localhost:6000";
// In-memory orders store (demo only)
const orders = [];
// Counter used to simulate a periodic upstream error
let orderCounter = 0;
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "express-api" });
});
// GET /api/orders — list recent orders
app.get("/api/orders", (_req, res) => {
  res.json(orders.slice(-20).reverse());
});
// POST /api/orders — orchestrate downstream services
app.post("/api/orders", async (req, res) => {
  const { product, amount, userId } = req.body;
  orderCounter += 1;
  const orderId = `ord-${Date.now()}`;
  (0, kamori_js_1.logToKamori)({
    level: "info",
    event: "order_received",
    orderId,
    product,
    amount,
    userId,
  });
  // --- FastAPI: recommendations ---
  let recommendations = [];
  try {
    const fastapiRes = await fetch(
      `${FASTAPI_URL}/recommendations?user_id=${encodeURIComponent(userId)}`,
    );
    const fastapiData = await fastapiRes.json();
    recommendations = fastapiData.recommendations ?? [];
    // Every 30th order, simulate a 429 from FastAPI
    if (orderCounter % 30 === 0) {
      (0, kamori_js_1.logToKamori)({
        level: "warn",
        event: "upstream_rate_limited",
        orderId,
        upstream: "fastapi-service",
        message: "FastAPI returned 429 Too Many Requests (simulated)",
      });
      recommendations = [];
    } else {
      (0, kamori_js_1.logToKamori)({
        level: "info",
        event: "recommendations_fetched",
        orderId,
        count: recommendations.length,
      });
    }
  } catch (err) {
    (0, kamori_js_1.logToKamori)({
      level: "error",
      event: "recommendations_failed",
      orderId,
      error: String(err),
    });
  }
  // --- Flask: send confirmation email ---
  try {
    const flaskRes = await fetch(`${FLASK_URL}/send-confirmation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderId, userId, product }),
    });
    const flaskData = await flaskRes.json();
    (0, kamori_js_1.logToKamori)({
      level: "info",
      event: "confirmation_sent",
      orderId,
      ok: flaskData.ok ?? false,
    });
  } catch (err) {
    (0, kamori_js_1.logToKamori)({
      level: "error",
      event: "confirmation_failed",
      orderId,
      error: String(err),
    });
  }
  // --- PHP: process payment ---
  try {
    const phpRes = await fetch(`${PHP_URL}/process-payment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderId, amount }),
    });
    const phpData = await phpRes.json();
    (0, kamori_js_1.logToKamori)({
      level: "info",
      event: "payment_processed",
      orderId,
      amount,
      ok: phpData.ok ?? false,
    });
  } catch (err) {
    (0, kamori_js_1.logToKamori)({
      level: "error",
      event: "payment_failed",
      orderId,
      error: String(err),
    });
  }
  const order = {
    id: orderId,
    product,
    amount,
    userId,
    status: "completed",
    recommendations,
  };
  orders.push(order);
  (0, kamori_js_1.logToKamori)({
    level: "info",
    event: "order_completed",
    orderId,
    product,
    amount,
  });
  res.json(order);
});
app.listen(PORT, () => {
  console.log(`express-api listening on port ${PORT}`);
  (0, kamori_js_1.logToKamori)({
    level: "info",
    event: "server_started",
    port: PORT,
  });
});
//# sourceMappingURL=index.js.map
