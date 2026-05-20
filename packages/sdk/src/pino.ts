/**
 * Pino transport for Kamori.
 *
 * Usage — as a writable stream passed directly to pino:
 *
 * @example
 * import pino from "pino";
 * import { createKamoriStream } from "/sdk/pino";
 *
 * const stream = createKamoriStream({ url: "https://logs.example.com", token: "..." });
 * const logger = pino(stream);
 * logger.info({ userId: 42 }, "user signed in");
 */

import { KamoriClient } from "./client.js";
import type { KamoriClientOptions } from "./client.js";
import { Writable } from "stream";

/**
 * Create a Node.js Writable stream that forwards pino log lines to a Kamori
 * ingest server. Each newline-delimited JSON string written to the stream is
 * parsed and forwarded via KamoriClient.
 *
 * @param opts - KamoriClientOptions passed directly to the underlying KamoriClient.
 * @returns A Writable stream compatible with pino's stream argument.
 */
export function createKamoriStream(opts: KamoriClientOptions): Writable {
  const client = new KamoriClient(opts);

  return new Writable({
    // pino writes newline-delimited JSON strings, not objects.
    objectMode: false,

    write(chunk: Buffer | string, _encoding: string, callback: () => void): void {
      try {
        // A single write() call may contain multiple newline-delimited lines
        // (e.g. when pino batches output), so split before parsing.
        const text = chunk.toString();
        for (const line of text.split("\n")) {
          const trimmed = line.trim();
          if (trimmed) {
            // Each line should be a complete JSON object; skip silently if not.
            const event = JSON.parse(trimmed) as Record<string, unknown>;
            client.log(event);
          }
        }
      } catch {
        // Silently ignore malformed lines — never throw from a log transport.
      }
      callback();
    },

    // Flush and tear down the KamoriClient when the stream is destroyed
    // (e.g. process exit, pino.destination().destroy(), or explicit .end()).
    // Without this, events buffered after the last automatic flush are lost
    // because the KamoriClient's internal timer is still pending.
    final(callback: () => void): void {
      client.destroy();
      callback();
    },
  });
}
