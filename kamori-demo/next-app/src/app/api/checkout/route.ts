/**
 * Checkout route — business-event logging
 *
 * HTTP-level logging (method, path, status, duration_ms) is handled
 * automatically by the withKamori middleware in src/middleware.ts.
 *
 * This route uses KamoriClient.scoped() for business events that carry
 * richer context: checkout_initiated, checkout_result, checkout_failed.
 *
 * Using both patterns together:
 *   - middleware.ts  → HTTP observability for every route (automatic)
 *   - route handler  → domain events with full business context (manual)
 */

import { NextRequest, NextResponse } from "next/server";
import { KamoriClient } from "@usekamori/sdk";

// Module-level singleton — one KamoriClient shared across all requests.
// Never create KamoriClient inside a request handler; each call would
// allocate a new buffer and flush timer.
const kamori = new KamoriClient({
  url: process.env.KAMORI_URL ?? "http://localhost:3110",
  ...(process.env.INGEST_TOKEN && { token: process.env.INGEST_TOKEN }),
}).scoped({
  service: "next-app",
  sdk: "KamoriClient+withKamori", // using both patterns in this service
});

export async function POST(req: NextRequest) {
  const formData = await req.formData();
  const product = formData.get("product") ?? "Unknown";
  const amount = Number(formData.get("amount") ?? 0);
  const userId = formData.get("userId") ?? "anonymous";

  // Business event — richer than what the HTTP middleware logs
  kamori.log({
    level: "info",
    event: "checkout_initiated",
    product,
    amount,
    userId,
  });

  const expressUrl = process.env.EXPRESS_URL ?? "http://localhost:4000";

  let order: unknown;
  try {
    const res = await fetch(`${expressUrl}/api/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ product, amount, userId }),
    });

    order = await res.json();

    kamori.log({
      level: res.ok ? "info" : "error",
      event: "checkout_result",
      product,
      amount,
      userId,
      status: res.status,
      order,
    });
  } catch (err) {
    kamori.log({
      level: "error",
      event: "checkout_failed",
      product,
      amount,
      userId,
      error: String(err),
    });
    return NextResponse.redirect(new URL("/?error=checkout_failed", req.url));
  }

  return NextResponse.redirect(new URL("/?success=1", req.url));
}
