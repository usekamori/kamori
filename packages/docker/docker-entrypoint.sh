#!/bin/sh
set -e

DATA_DIR="${DATA_DIR:-/app/data}"

# ---------------------------------------------------------------------------
# First-run auth bootstrap — secure by default
#
# The self-hosted server is single-tenant: one token guards the whole instance.
# If no token is provided, generate a strong one and persist it to the data
# volume so it stays stable across restarts. This keeps a bare `docker run`
# authenticated out of the box, with no config.
#
# Escape hatch: set KAMORI_ALLOW_NO_AUTH=true to run WITHOUT auth (only safe on
# a trusted / loopback-only network).
# ---------------------------------------------------------------------------
gen_token() {
  node -e "process.stdout.write(require('crypto').randomBytes(24).toString('base64url'))"
}

ensure_token() {
  var_name="$1"   # env var to populate (e.g. INGEST_TOKEN)
  token_file="$2" # where to persist it

  eval "cur=\${$var_name:-}"
  if [ -n "$cur" ]; then
    return 0 # operator supplied one — respect it
  fi

  if [ "${KAMORI_ALLOW_NO_AUTH:-}" = "true" ]; then
    echo "[kamori] WARNING: $var_name is empty and KAMORI_ALLOW_NO_AUTH=true — running WITHOUT auth."
    return 0
  fi

  mkdir -p "$DATA_DIR"
  if [ -f "$token_file" ]; then
    val="$(cat "$token_file")"
  else
    val="$(gen_token)"
    printf '%s' "$val" > "$token_file"
    chmod 600 "$token_file" 2>/dev/null || true
    echo "[kamori] No $var_name provided — generated one and saved it to $token_file"
    echo "[kamori] $var_name=$val"
    echo "[kamori] Send it as:  Authorization: Bearer $val"
    echo "[kamori] To run without auth (trusted networks only): -e KAMORI_ALLOW_NO_AUTH=true"
  fi
  export "$var_name=$val"
}

ensure_token INGEST_TOKEN "$DATA_DIR/.ingest-token"

if [ "${MCP_PORT:-3111}" != "0" ]; then
  ensure_token MCP_TOKEN "$DATA_DIR/.mcp-token"
fi

node --enable-source-maps packages/ingest/dist/ingest.js &
INGEST_PID=$!

if [ "${MCP_PORT:-3111}" != "0" ]; then
  node --enable-source-maps packages/mcp/dist/mcp.js &
  MCP_PID=$!
fi

# Forward SIGTERM/SIGINT to child processes for graceful shutdown
trap 'kill $INGEST_PID $MCP_PID 2>/dev/null; wait' TERM INT

wait
