/**
 * Browser-optimised Kamori SDK entry point.
 *
 * Safe to import in any browser context — uses only Web Platform APIs
 * (fetch, navigator.sendBeacon, window). No Node.js-specific imports.
 *
 * Usage:
 *   import { KamoriClient, installErrorCapture } from "/sdk/browser";
 *
 *   const client = new KamoriClient({
 *     url: "https://your-kamori-server.com",
 *     token: "your-token",
 *     flushOnExit: true,   // uses sendBeacon on beforeunload
 *   });
 *
 *   // Optional: capture all unhandled JS errors automatically
 *   installErrorCapture(client);
 */

// Re-export the main client and scoped helper — both are browser-safe
export { KamoriClient, ScopedKamoriClient } from "./client.js";
export type { KamoriClientOptions } from "./client.js";

import { KamoriClient } from "./client.js";

/**
 * Options for installErrorCapture.
 */
export interface ErrorCaptureOptions {
  /**
   * Whether to capture unhandled promise rejections via window.onunhandledrejection.
   * Default: true
   */
  captureUnhandledRejections?: boolean;
}

/**
 * Install global error capture handlers on the window object.
 *
 * Hooks into:
 *   - window.onerror            — uncaught synchronous errors
 *   - window.onunhandledrejection — unhandled promise rejections (opt-out via captureUnhandledRejections: false)
 *
 * Each captured error is forwarded to Kamori as a log event with:
 *   { level: "error", message, _source, type: "uncaught_error" | "unhandled_rejection" }
 *
 * @param client  - The KamoriClient instance to log errors to.
 * @param opts    - Optional configuration.
 * @returns A cleanup function that removes the installed handlers.
 *
 * @example
 * const client = new KamoriClient({ url: "...", token: "..." });
 * const cleanup = installErrorCapture(client);
 * // later, to remove handlers:
 * cleanup();
 */
export function installErrorCapture(
  client: KamoriClient,
  opts: ErrorCaptureOptions = {}
): () => void {
  const { captureUnhandledRejections = true } = opts;

  // Handler for synchronous uncaught errors.
  // Bound as a named function reference so removeEventListener can identify it.
  //
  // Prototype-pollution defence: fields are extracted by their literal names,
  // never via spread (`{ ...e }` or `{ ...e.error }`). An adversarial error
  // object with __proto__ or constructor keys in its own properties cannot
  // contaminate this payload because we never dynamically copy key names from
  // the event or its nested objects.
  const onError = (e: ErrorEvent): void => {
    client.log({
      level: "error",
      type: "uncaught_error",
      message: e.message,
      _source: e.filename && e.lineno ? `${e.filename}:${e.lineno}` : undefined,
      stack: e.error instanceof Error ? e.error.stack : undefined,
    });
  };

  // Handler for unhandled promise rejections.
  // Same defensive pattern: only well-known string properties are read;
  // the reason object itself is never spread into the log payload.
  const onUnhandledRejection = (event: PromiseRejectionEvent): void => {
    const reason = event.reason;
    client.log({
      level: "error",
      type: "unhandled_rejection",
      message: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  };

  // Attach handlers — use addEventListener so existing handlers are preserved.
  window.addEventListener("error", onError);

  if (captureUnhandledRejections) {
    window.addEventListener("unhandledrejection", onUnhandledRejection);
  }

  // Return a cleanup function to allow callers to detach handlers when needed
  // (e.g. during hot module replacement or test teardown).
  return () => {
    window.removeEventListener("error", onError);
    if (captureUnhandledRejections) {
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
    }
  };
}
