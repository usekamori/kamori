export { KamoriClient, ScopedKamoriClient } from "./client.js";
export type { KamoriClientOptions } from "./client.js";

export { createKamoriStream } from "./pino.js";
export { KamoriTransport } from "./winston.js";

import { KamoriClient } from "./client.js";
import type { KamoriClientOptions } from "./client.js";

const METHOD_LEVEL = {
  log: "info",
  warn: "warn",
  error: "error",
  debug: "debug",
} as const;

/**
 * Install a global console shim that forwards all console output to Kamori
 * while still printing to the terminal normally.
 *
 * Call this once at process startup, before any other imports.
 *
 * @example
 * import { installShim } from "@usekamori/sdk";
 * installShim({ url: "https://your-kamori-server.com", token: process.env.INGEST_TOKEN });
 */
export function installShim(opts: KamoriClientOptions): void {
  const client = new KamoriClient(opts);

  for (const [method, level] of Object.entries(METHOD_LEVEL) as [keyof typeof METHOD_LEVEL, string][]) {
    const original = (console[method] as (...args: unknown[]) => void).bind(console);

    console[method] = (...args: unknown[]): void => {
      // Always call the original first — if Kamori throws for any reason the
      // application's console output must not be silenced.
      original(...args);

      const event: Record<string, unknown> = { level };
      const [first, ...rest] = args;

      if (typeof first === "string") {
        event.message = first;
        if (rest.length > 0) event.args = rest;
      } else {
        event.args = args;
      }

      try {
        client.log(event);
      } catch {
        // Kamori errors must never propagate to callers of console.*
      }
    };
  }
}
