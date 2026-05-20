/**
 * This file is no longer used.
 *
 * fastify-api now integrates Kamori via the direct client:
 *   import { KamoriClient } from "@usekamori/sdk";
 *   const kamori = new KamoriClient({ url, token }).scoped({ service: "fastify-api" });
 *
 * See src/index.ts for the full integration pattern.
 */
