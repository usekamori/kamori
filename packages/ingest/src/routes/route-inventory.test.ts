/**
 * D3 regression — the v1 plugin split (shared/ingest/query/stream/admin) must
 * register exactly the same route inventory as the pre-split monolith.
 * Runs without better-sqlite3 (adapters are stubs), so it guards the split in
 * environments where the integration suite can't compile the native binding.
 */
import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import type { KamoriAdapters } from "@usekamori/core";
import v1Routes from "./v1.js";

const stubAdapters = {
  db: { run: async () => ({ rowsAffected: 0 }), query: async () => [], get: async () => null, batch: async () => {}, exec: async () => {} },
  auth: { verifyIngestToken: () => null },
  billing: { checkIngestAccess: async () => true, reportUsage: async () => {} },
  email: { sendEmail: async () => {} },
  retention: { getCutoffDate: () => null },
  mcp: { resolveDb: async () => { throw new Error("unused"); } },
} as unknown as KamoriAdapters;

describe("v1 route inventory (post-split)", () => {
  it("registers every v1 endpoint", async () => {
    const app = Fastify();
    await app.register(v1Routes(stubAdapters), { prefix: "/v1" });
    await app.ready();

    const expected: Array<[string, string]> = [
      ["GET", "/v1/health"],
      ["POST", "/v1/ingest"],
      ["POST", "/v1/webhook/:provider"],
      ["GET", "/v1/logs"],
      ["GET", "/v1/search"],
      ["GET", "/v1/services"],
      ["GET", "/v1/summary"],
      ["GET", "/v1/logs/alert"],
      ["GET", "/v1/count"],
      ["GET", "/v1/histogram"],
      ["GET", "/v1/stream"],
      ["GET", "/v1/export"],
      ["DELETE", "/v1/logs"],
    ];
    for (const [method, url] of expected) {
      expect(app.hasRoute({ method, url }), `${method} ${url}`).toBe(true);
    }
    await app.close();
  });

  it("exposes GET and DELETE on /v1/logs", async () => {
    const app = Fastify();
    await app.register(v1Routes(stubAdapters), { prefix: "/v1" });
    await app.ready();
    expect(app.hasRoute({ method: "GET", url: "/v1/logs" })).toBe(true);
    expect(app.hasRoute({ method: "DELETE", url: "/v1/logs" })).toBe(true);
    expect(app.hasRoute({ method: "POST", url: "/v1/ingest" })).toBe(true);
    await app.close();
  });
});
