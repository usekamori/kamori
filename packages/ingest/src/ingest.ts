import { PORT, HOST, DB_PATH, defaultAdapters } from "@usekamori/core";
import { buildServer } from "./build-server.js";

console.log(`[kamori] starting — db=${DB_PATH} port=${PORT} host=${HOST}`);

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
