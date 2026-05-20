"use strict";
var __importDefault =
  (this && this.__importDefault) ||
  function (mod) {
    return mod && mod.__esModule ? mod : { default: mod };
  };
Object.defineProperty(exports, "__esModule", { value: true });
const fastify_1 = __importDefault(require("fastify"));
const kamori_js_1 = require("./lib/kamori.js");
const fastify = (0, fastify_1.default)({ logger: false });
const PORT = Number(process.env.PORT ?? 4001);
fastify.get("/health", async () => ({ ok: true, service: "fastify-api" }));
fastify.get("/api/search", async (request) => {
  const { q = "" } = request.query;
  (0, kamori_js_1.logToKamori)({ level: "info", event: "search", query: q });
  // Mock search results
  const results = q
    ? [
        { id: 1, title: `Result for "${q}"`, score: 0.95 },
        { id: 2, title: `Related to "${q}"`, score: 0.82 },
        { id: 3, title: `Also matching "${q}"`, score: 0.71 },
      ]
    : [];
  return { results, query: q, count: results.length };
});
fastify.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`fastify-api listening on :${PORT}`);
});
//# sourceMappingURL=index.js.map
