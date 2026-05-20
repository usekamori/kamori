#!/bin/sh
set -e

node --enable-source-maps packages/ingest/dist/ingest.js &
INGEST_PID=$!

if [ "${MCP_PORT:-3111}" != "0" ]; then
  node --enable-source-maps packages/mcp/dist/mcp.js &
  MCP_PID=$!
fi

# Forward SIGTERM/SIGINT to child processes for graceful shutdown
trap 'kill $INGEST_PID $MCP_PID 2>/dev/null; wait' TERM INT

wait
