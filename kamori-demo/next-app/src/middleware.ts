/**
 * Next.js middleware — automatic request logging
 *
 * ──────────────────────────────────────────────────────────────────────────
 * SDK Integration: Next.js middleware  (/sdk/next — withKamori)
 *
 * withKamori wraps a Next.js middleware function and logs every matched
 * request: method, path, status code, and duration_ms. Works on both
 * the Edge runtime and Node.js runtime.
 *
 * Integration (3 lines):
 *
 *   import { withKamori } from "@usekamori/sdk/next";
 *   import { NextResponse } from "next/server";
 *
 *   export default withKamori(
 *     async (req) => NextResponse.next(),
 *     { url: process.env.KAMORI_URL!, token: process.env.INGEST_TOKEN },
 *   );
 *   export const config = { matcher: "/((?!_next|favicon.ico).*)" };
 *
 * A single KamoriClient is created once and shared across all requests.
 * Business-event logging (checkout_initiated, etc.) lives in the route
 * handlers — see src/app/api/checkout/route.ts for that pattern.
 *
 * Best for: request-level HTTP observability with zero per-route changes.
 * ──────────────────────────────────────────────────────────────────────────
 */

import { withKamori } from "@usekamori/sdk/next";
import { NextResponse } from "next/server";

// withKamori wraps the pass-through middleware and logs every request.
// One KamoriClient is created here, shared across all matched routes.
export default withKamori(async (_req) => NextResponse.next(), {
  url: process.env.KAMORI_URL ?? "http://localhost:3110",
  ...(process.env.INGEST_TOKEN && { token: process.env.INGEST_TOKEN }),
});

// Apply to all routes except Next.js internals and static assets
export const config = {
  matcher: "/((?!_next/static|_next/image|favicon.ico).*)",
};
