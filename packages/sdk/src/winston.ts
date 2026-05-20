/**
 * Winston transport for Kamori.
 *
 * Uses duck-typing rather than extending `winston-transport` so that
 * `winston-transport` is not a required dependency of this package.
 * Winston accepts any object with a `log(info, callback)` method as a
 * transport, so this is fully compatible.
 *
 * @example
 * import winston from "winston";
 * import { KamoriTransport } from "/sdk/winston";
 *
 * const logger = winston.createLogger({
 *   transports: [
 *     new winston.transports.Console(),
 *     new KamoriTransport({ url: "https://logs.example.com", token: "..." }),
 *   ],
 * });
 *
 * logger.info("server started", { port: 3110 });
 */

import { EventEmitter } from "node:events";
import { KamoriClient } from "./client.js";
import type { KamoriClientOptions } from "./client.js";

/**
 * Winston transport that forwards log entries to a Kamori ingest server.
 *
 * Extends EventEmitter so Winston's legacy transport wrapper can attach its
 * error handler (`this.transport.on('error', ...)`).
 */
export class KamoriTransport extends EventEmitter {
  /** Transport name — used by Winston for identification. */
  readonly name = "kamori";

  private readonly client: KamoriClient;

  /**
   * @param opts - KamoriClientOptions used to configure the underlying KamoriClient.
   */
  constructor(opts: KamoriClientOptions) {
    super();
    this.client = new KamoriClient(opts);
  }

  /**
   * Called by Winston for each log entry.
   *
   * Forwards the log info object to KamoriClient and immediately invokes the
   * callback to signal Winston that this transport has finished processing.
   *
   * @param info     - The Winston log info object (level, message, metadata…).
   * @param callback - Winston's done callback; must be called to unblock the pipeline.
   */
  log(level: string, message: string, meta: Record<string, unknown>, callback?: () => void): void {
    this.client.log({ ...meta, level, message });
    if (typeof callback === "function") callback();
  }

  /**
   * Called by Winston when the logger is closed (`logger.close()`).
   *
   * Flushes and tears down the underlying KamoriClient so buffered events are
   * delivered and the flush timer is cancelled. Without this, events queued
   * after the last automatic flush would be silently dropped when the process
   * exits before the timer fires.
   */
  close(): void {
    this.client.destroy();
  }
}
