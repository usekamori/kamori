/**
 * Next.js / Vercel middleware integration for Kamori.
 *
 * Wraps a Next.js middleware function (or route handler) to automatically
 * log every request — method, path, status code, and duration.
 *
 * Works on both the Edge runtime and Node.js runtime because it only
 * uses the Web Fetch API (Request / Response / NextResponse) and the
 * KamoriClient which has no Node.js-specific imports.
 *
 * Usage — middleware.ts:
 *
 *   import { withKamori } from "/sdk/next";
 *   import { NextResponse } from "next/server";
 *
 *   export default withKamori(
 *     async (req) => NextResponse.next(),
 *     { url: process.env.KAMORI_URL!, token: process.env.INGEST_TOKEN }
 *   );
 *
 *   export const config = { matcher: "/((?!_next|favicon.ico).*)" };
 *
 * Usage — Route Handler:
 *
 *   import { withKamori } from "/sdk/next";
 *   export const GET = withKamori(
 *     async (req) => Response.json({ ok: true }),
 *     { url: process.env.KAMORI_URL!, token: process.env.INGEST_TOKEN }
 *   );
 */

import { KamoriClient } from "./client.js";
import type { KamoriClientOptions } from "./client.js";

/** The shape of a Next.js-compatible request handler or middleware function. */
type NextHandler = (req: Request) => Response | Promise<Response>;

/**
 * Wrap a Next.js middleware or route handler with automatic Kamori request logging.
 *
 * Logs one event per request with:
 *   { level: "info", service: "next", method, path, status, duration_ms }
 *
 * Errors thrown by the inner handler are re-thrown after logging a level="error" event,
 * so Next.js error boundaries and default error handling continue to work correctly.
 *
 * A single KamoriClient is created per `withKamori` call and shared across all
 * invocations of the returned handler. On the Edge runtime, where isolates are
 * short-lived, this effectively means one client per isolate.
 *
 * **Important — use a module-level singleton in Node.js.**
 * In long-running Node.js processes each `withKamori()` call allocates its own
 * buffer and flush timer. Calling it inside a route factory or per-request
 * code creates a new client on every invocation, which wastes memory and
 * prevents effective batching. Always call `withKamori` once at module level:
 *
 * ```ts
 * // ✅ correct — one client shared across all requests
 * export const GET = withKamori(handler, { url: process.env.KAMORI_URL! });
 *
 * // ❌ wrong — new client (and flush timer) on every request
 * export async function GET(req: Request) {
 *   const wrapped = withKamori(handler, { url: process.env.KAMORI_URL! });
 *   return wrapped(req);
 * }
 * ```
 *
 * @param handler - The original Next.js handler or middleware function.
 * @param opts    - KamoriClientOptions for the underlying KamoriClient.
 * @returns A wrapped handler with the same signature.
 *
 * @example
 * export default withKamori(
 *   async (req) => NextResponse.next(),
 *   { url: process.env.KAMORI_URL!, token: process.env.INGEST_TOKEN }
 * );
 */
export function withKamori(
  handler: NextHandler,
  opts: KamoriClientOptions,
): NextHandler {
  // Create a single KamoriClient shared across all invocations of this handler.
  // In Edge runtime instances are short-lived, so this acts as a per-isolate client.
  const client = new KamoriClient(opts);

  return async (req: Request): Promise<Response> => {
    // Record wall-clock time at the start of the request.
    const start = Date.now();
    const method = req.method;

    // Extract just the pathname from the URL — avoid logging query strings that
    // may contain secrets, tokens, or PII.
    const path = new URL(req.url).pathname;

    try {
      const response = await handler(req);

      // Log the successfully completed request with timing information.
      client.log({
        level: "info",
        service: "next",
        method,
        path,
        status: response.status,
        duration_ms: Date.now() - start,
      });

      return response;
    } catch (err) {
      // Log the error with whatever diagnostic information is available, then
      // re-throw so Next.js error boundaries still fire as expected.
      client.log({
        level: "error",
        service: "next",
        method,
        path,
        error: err instanceof Error ? err.message : String(err),
        duration_ms: Date.now() - start,
      });
      throw err;
    }
  };
}
