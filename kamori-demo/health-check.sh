#!/usr/bin/env bash
# Health check for all kamori-demo services.
# Usage: ./health-check.sh [wait_seconds]
# Run after: docker compose up --build

WAIT=${1:-10}   # seconds to wait before checking (default 10)

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
RESET='\033[0m'
BOLD='\033[1m'

SERVICES=(
  "kamori (ingest)|http://localhost:3110/v1/health"
  "kamori (mcp)   |http://localhost:3111/health"
  "express-api    |http://localhost:3200/health"
  "fastify-api    |http://localhost:3201/health"
  "next-app       |http://localhost:3000"
  "pino-service   |http://localhost:3500/health"
  "winston-service|http://localhost:3501/health"
  "fastapi-service|http://localhost:3300/health"
  "flask-service  |http://localhost:3301/health"
  "python-sdk     |http://localhost:3302/health"
  "php-service    |http://localhost:3400/health"
  "php-monolog    |http://localhost:3401/health"
  "go-service     |http://localhost:3600/health"
)

echo ""
echo -e "${BOLD}Waiting ${WAIT}s for services to start…${RESET}"
sleep "$WAIT"

echo ""
printf "${BOLD}%-21s %-8s %s${RESET}\n" "Service" "Status" "Response"
printf '%0.s─' {1..70}; echo ""

PASS=0
FAIL=0

for entry in "${SERVICES[@]}"; do
  name="${entry%%|*}"
  url="${entry##*|}"

  http_code=$(curl -s -o /tmp/_hc_body -w "%{http_code}" --max-time 5 "$url" 2>/dev/null)
  curl_exit=$?
  body=$(cat /tmp/_hc_body 2>/dev/null | tr -d '\r\n' | cut -c1-45)

  if [ $curl_exit -ne 0 ] || [ "$http_code" = "000" ] || [ -z "$http_code" ]; then
    label="${RED}✘ down   ${RESET}"
    body="connection refused / timeout"
    FAIL=$((FAIL+1))
  elif echo "$http_code" | grep -q "^2"; then
    label="${GREEN}✔ ${http_code}    ${RESET}"
    PASS=$((PASS+1))
  else
    label="${YELLOW}! ${http_code}    ${RESET}"
    FAIL=$((FAIL+1))
  fi

  printf "%-21s " "$name"
  echo -en "$label"
  printf "%s\n" "$body"
done

echo ""
printf '%0.s─' {1..70}; echo ""

if [ $FAIL -eq 0 ]; then
  echo -e "${GREEN}${BOLD}All ${PASS} services healthy.${RESET}"
else
  echo -e "${RED}${BOLD}${FAIL} unhealthy${RESET}  ${GREEN}${BOLD}${PASS} healthy${RESET}"
fi
echo ""
