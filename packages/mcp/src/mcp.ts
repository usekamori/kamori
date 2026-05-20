/**
 * MCP server for Kamori — OSS entrypoint.
 *
 * Usage:
 *   node dist/mcp.js           → Streamable HTTP transport (default, Docker / remote)
 *   node dist/mcp.js --stdio   → stdio transport (Claude Code / Cursor spawns this process)
 *
 * Cloud entrypoints (private repo) import startMcp and pass their own
 * KamoriAdapters implementation instead of the default local-SQLite adapters.
 */

import { defaultAdapters, MCP_PORT, DB_PATH } from "@usekamori/core";
import { startMcp } from "./start-mcp.js";

console.log(`[kamori-mcp] starting — db=${DB_PATH} port=${MCP_PORT}`);

let adapters;
try {
  adapters = defaultAdapters();
  console.log(`[kamori-mcp] adapters initialised`);
} catch (err) {
  console.error(`[kamori-mcp] failed to initialise adapters:`, err);
  process.exit(1);
}

try {
  await startMcp(adapters);
} catch (err) {
  console.error(`[kamori-mcp] failed to start:`, err);
  process.exit(1);
}
