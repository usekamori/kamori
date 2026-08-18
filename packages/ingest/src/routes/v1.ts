/**
 * v1 route plugin — composition only (D3 split, 2026-07).
 *
 * The route implementations live in resource modules; this file wires the
 * shared auth preHandler + lifecycle hooks and registers them:
 *
 *  - shared.ts — fastify type augmentation, counters, notification bus,
 *                resolveDb + auth-hook factories, small helpers
 *  - ingest.ts — /health, POST /ingest, POST /webhook/:provider
 *  - query.ts  — GET /logs, /search, /services, /summary, /logs/alert
 *  - stream.ts — GET /stream (NDJSON live tail)
 *  - admin.ts  — GET /export, DELETE /logs
 *
 * All paths are relative — register with prefix "/v1" in build-server.ts.
 * Test helpers are re-exported below so existing test imports keep working.
 */
import type { FastifyInstance } from "fastify";
import type { KamoriAdapters, ServerPlugins } from "@usekamori/core";
import {
  type V1Context,
  makeResolveDb,
  registerAuthHook,
  _resetStreamConnections,
  _resetInFlightWrites,
} from "./shared.js";
import { registerIngestRoutes } from "./ingest.js";
import { registerQueryRoutes } from "./query.js";
import { registerStreamRoutes } from "./stream.js";
import { registerAdminRoutes } from "./admin.js";

// Re-export test helpers + notification bus from their new home so existing
// imports of "./v1.js" remain valid.
export {
  _logsEmitter,
  _resetInFlightWrites,
  _getInFlightWrites,
  _setInFlightWritesForTest,
  _resetStreamConnections,
  _getStreamConnectionCount,
  _setStreamConnectionsForTest,
} from "./shared.js";

export default function v1Routes(
  adapters: KamoriAdapters,
  plugins?: ServerPlugins,
) {
  return async function v1Plugin(fastify: FastifyInstance) {
    // Reset the counters when this server instance closes. Guards against them
    // staying elevated across server restarts that reuse the same module
    // instance (no vi.resetModules / hot-reload).
    fastify.addHook("onClose", () => {
      _resetStreamConnections();
      _resetInFlightWrites();
    });

    const ctx: V1Context = {
      adapters,
      plugins,
      resolveDb: makeResolveDb(adapters, plugins),
    };

    registerAuthHook(fastify, adapters, plugins);

    await registerIngestRoutes(fastify, ctx);
    registerQueryRoutes(fastify, ctx);
    registerStreamRoutes(fastify, ctx);
    registerAdminRoutes(fastify, ctx);
  };
}
