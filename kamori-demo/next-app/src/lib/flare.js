"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.logToKamori = logToKamori;
const KAMORI_URL = process.env.KAMORI_URL ?? "http://localhost:7000";
const INGEST_TOKEN = process.env.INGEST_TOKEN ?? "";
function logToKamori(event) {
  // Fire-and-forget: do not await
  fetch(`${KAMORI_URL}/v1/ingest`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(INGEST_TOKEN && { Authorization: `Bearer ${INGEST_TOKEN}` }),
    },
    body: JSON.stringify({
      ...event,
      service: "next-app",
      ts: new Date().toISOString(),
    }),
  }).catch(() => {
    // Swallow errors — Kamori logging must never break the app
  });
}
//# sourceMappingURL=kamori.js.map
