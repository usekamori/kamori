import {
  PORT,
  HOST,
  DB_PATH,
  INGEST_TOKEN,
  METRICS_TOKEN,
  NODE_ENV,
  CLOUD_MODE,
  ALLOW_NO_AUTH,
  defaultAdapters,
} from "@usekamori/core";
import { buildServer } from "./build-server.js";
import { checkIngestAuthPosture } from "./lib/startup-check.js";

console.log(`[kamori] starting — db=${DB_PATH} port=${PORT} host=${HOST}`);

// Authentication posture: warn when the server is open, and refuse to start when
// it would be open AND network-reachable in production (unless explicitly allowed).
const posture = checkIngestAuthPosture({
  ingestToken: INGEST_TOKEN,
  metricsToken: METRICS_TOKEN,
  nodeEnv: NODE_ENV,
  host: HOST,
  cloudMode: CLOUD_MODE,
  allowNoAuth: ALLOW_NO_AUTH,
});
for (const w of posture.warnings) console.warn(`[kamori] ⚠️  ${w}`);
if (posture.fatal) {
  console.error(`[kamori] FATAL: ${posture.fatal}`);
  process.exit(1);
}

let adapters;
try {
  adapters = defaultAdapters();
} catch (err) {
  console.error(`[kamori] failed to initialise adapters:`, err);
  process.exit(1);
}

const fastify = await buildServer(adapters);

try {
  const address = await fastify.listen({ port: PORT, host: HOST });
  fastify.log.info(
    { address },
    `Kamori ingress listening on port: ${PORT}, host: ${HOST}`,
  );
} catch (err: unknown) {
  fastify.log.error(
    { message: err instanceof Error ? err.message : String(err) },
    `Kamori ingress server listen failed`,
  );
  process.exit(1);
}
