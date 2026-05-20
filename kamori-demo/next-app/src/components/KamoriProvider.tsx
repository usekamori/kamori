"use client";

/**
 * KamoriProvider — browser-side Kamori integration
 *
 * ──────────────────────────────────────────────────────────────────────────
 * SDK Integration: browser client  (/sdk/browser)
 *
 * /sdk/browser is browser-safe: no Node.js imports, uses only
 * fetch + sendBeacon + localStorage. It exports:
 *   - KamoriClient        — same batched client as the server SDK
 *   - installErrorCapture — hooks window.onerror + onunhandledrejection
 *
 * Integration:
 *
 *   "use client";
 *   import { KamoriClient, installErrorCapture } from "@usekamori/sdk/browser";
 *
 *   const client = new KamoriClient({
 *     url: process.env.NEXT_PUBLIC_KAMORI_URL!,
 *     flushOnExit: true,   // sendBeacon on beforeunload
 *     offlineQueue: true,  // retry failed batches from localStorage
 *   });
 *   installErrorCapture(client); // auto-capture all uncaught errors
 *
 * Note: use NEXT_PUBLIC_ prefix so the URL is inlined into the browser bundle.
 * The server-side KAMORI_URL (http://kamori:3110) is Docker-internal and
 * unreachable from the browser — NEXT_PUBLIC_KAMORI_URL must be the
 * host-accessible URL (http://localhost:3110).
 *
 * Best for: capturing frontend errors, user interactions, and page views
 *           from any React / Next.js client component.
 * ──────────────────────────────────────────────────────────────────────────
 */

import { useEffect } from "react";
import { KamoriClient, installErrorCapture } from "@usekamori/sdk/browser";

// Module-level singleton — created once, shared across all renders.
// NEXT_PUBLIC_KAMORI_URL is the host-accessible URL (set in docker-compose).
const client = new KamoriClient({
  url: process.env.NEXT_PUBLIC_KAMORI_URL ?? "http://localhost:3110",
  flushOnExit: true,   // flush via sendBeacon on tab close / navigation
  offlineQueue: true,  // spool failed batches to localStorage for retry
});

/**
 * Mount this once in the root layout to activate browser-side Kamori logging.
 *
 * On mount:
 *   1. Installs global error capture (window.onerror + onunhandledrejection)
 *   2. Logs a page_view event
 *
 * On unmount: removes the error handlers (important for HMR / test cleanup).
 */
export function KamoriProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    // Capture all unhandled JS errors and promise rejections automatically
    const cleanup = installErrorCapture(client);

    // Log that the page loaded — useful for basic engagement tracking
    client.log({
      level:   "info",
      event:   "page_view",
      service: "next-app",
      sdk:     "browser+installErrorCapture",
      path:    typeof window !== "undefined" ? window.location.pathname : "/",
    });

    return cleanup; // remove handlers on unmount
  }, []);

  return <>{children}</>;
}

/**
 * Export the client so other client components can log events directly.
 *
 * @example
 * import { kamoriClient } from "@/components/KamoriProvider";
 * kamoriClient.log({ level: "info", event: "button_clicked", label: "checkout" });
 */
export { client as kamoriClient };
