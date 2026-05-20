# @usekamori/load-tests

k6 load tests for the Kamori ingress API (`/v1/*`). The same scripts work for OSS and Kamori Cloud — only environment variables change.

## Prerequisites

- [k6](https://k6.io/docs/) installed locally (`k6 version`).

## Configuration

Copy `.env.example` to `.env` and fill values, or export variables inline.

| Variable | Required | Description |
| --- | --- | --- |
| `BASE_URL` | yes | Ingest base URL (example: `http://localhost:3110`) |
| `INGEST_TOKEN` | usually | OSS `INGEST_TOKEN` value or Kamori Cloud project API key JWT |
| `TARGET_NAME` | no | Tag for results (`oss`, `cloud`, etc.) |
| `TEST_PROFILE` | no | `smoke` (short/low) or `stress` (long/high). Defaults to `stress`. |
| `ROWS_PER_REQUEST` | no | Override rows per ingest batch |
| `PAYLOAD_BYTES` | no | Approximate JSON size per row (includes overhead) |
| `DISABLE_THRESHOLDS` | no | Set `1` to disable k6 thresholds (dry-run / compile check) |

## Scenarios

| Script | Intent |
| --- | --- |
| `scripts/ramp-ingest.js` | Ramp VUs while hammering `POST /v1/ingest` |
| `scripts/mixed-under-load.js` | Concurrent ingest + reads (`/metrics`, `/v1/logs`, `/v1/search`, `/v1/summary`) |
| `scripts/spike-recovery.js` | Spike traffic then taper to observe recovery |

## Running

From repo root (`kamori/`):

```bash
npm run k6:stress --workspace=packages/load-tests
```

With explicit env:

```bash
cd packages/load-tests
BASE_URL=http://localhost:3110 \
INGEST_TOKEN=your-token \
TARGET_NAME=oss \
TEST_PROFILE=stress \
k6 run scripts/ramp-ingest.js
```

JSON summary (for CI artifacts):

```bash
k6 run scripts/ramp-ingest.js \
  --summary-export summary-ramp.json
```

## Unit tests

Helpers used by scenarios have Vitest coverage:

```bash
npm run test --workspace=packages/load-tests
```

## Notes

- Do not pass `--duration` / `--vus` CLI flags to the multi-scenario scripts — k6 treats them as global overrides and will drop scenario definitions.
- Stress thresholds are intentionally strict; tune `ROWS_PER_REQUEST`, payload size, or stages if you need to compare OSS vs Cloud without false negatives.
