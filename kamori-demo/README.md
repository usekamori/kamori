# kamori-demo

A polyglot microservices demo showing every [`/sdk`](../packages/sdk) integration pattern
across twelve different services — all logs visible through a single Claude Code MCP session.

Each service is a self-contained **implementation reference** for one integration style.
Copy the relevant pattern into your own codebase and you're done.

## SDK integration map

| Service                 | SDK integration                                                                                        | Port | Runtime           |
| ----------------------- | ------------------------------------------------------------------------------------------------------ | ---- | ----------------- |
| **express-api**         | `installShim` — Node.js console shim                                                                   | 3200 | Node.js           |
| **fastify-api**         | `KamoriClient` + `scoped()`                                                                            | 3201 | Node.js           |
| **next-app**            | `withKamori` middleware + `KamoriClient` (server) + `KamoriProvider` / `installErrorCapture` (browser) | 3000 | Node.js + Browser |
| **pino-service**        | `pino` + `createKamoriStream`                                                                          | 3500 | Node.js           |
| **winston-service**     | `winston` + `KamoriTransport`                                                                          | 3501 | Node.js           |
| **flask-service**       | Python `logging` + `KamoriHandler`                                                                     | 3301 | Python            |
| **python-sdk-service**  | `KamoriClient` (Python)                                                                                | 3302 | Python            |
| fastapi-service         | raw HTTP (reference pattern)                                                                           | 3300 | Python            |
| **php-service**         | `KamoriClient` (PHP)                                                                                   | 3400 | PHP               |
| **php-monolog-service** | Monolog + `KamoriHandler`                                                                              | 3401 | PHP               |
| **go-service**          | `KamoriClient` + `Scoped()` (Go)                                                                       | 3600 | Go                |

### Which integration should I use?

| Scenario                                          | Use                                       |
| ------------------------------------------------- | ----------------------------------------- |
| New Node.js service, full control                 | `KamoriClient` + `.scoped()`              |
| Already using pino                                | `createKamoriStream`                      |
| Already using winston                             | `KamoriTransport`                         |
| Drop into existing Node.js code, zero refactoring | `installShim` _(Node.js only)_            |
| Next.js — HTTP request logs for every route       | `withKamori` middleware                   |
| Next.js / Node.js — business events               | `KamoriClient` in handler                 |
| Browser — unhandled error capture                 | `installErrorCapture` from `/sdk/browser` |
| Browser — manual event logging                    | `KamoriClient` from `/sdk/browser`        |
| Python — already using `logging` module           | `KamoriHandler`                           |
| Python — direct structured events                 | `KamoriClient` (Python SDK)               |
| PHP — any project                                 | `KamoriClient` (PHP SDK)                  |
| PHP — already using Monolog                       | `KamoriHandler` (Monolog)                 |
| Go                                                | `KamoriClient` + `Scoped()` (Go SDK)      |
| Any other language                                | raw HTTP POST to `/v1/ingest`             |

## Quick start

### 1. Start everything

```bash
docker compose up --build
```

| Service                   | URL                   |
| ------------------------- | --------------------- |
| Kamori ingest + query API | http://localhost:3110 |
| Kamori MCP HTTP           | http://localhost:3111 |
| next-app (checkout UI)    | http://localhost:3000 |
| express-api               | http://localhost:3200 |
| fastify-api               | http://localhost:3201 |
| fastapi-service           | http://localhost:3300 |
| flask-service             | http://localhost:3301 |
| python-sdk-service        | http://localhost:3302 |
| php-service               | http://localhost:3400 |
| php-monolog-service       | http://localhost:3401 |
| pino-service              | http://localhost:3500 |
| winston-service           | http://localhost:3501 |
| go-service                | http://localhost:3600 |

To enable auth (all services must share the same token):

```bash
INGEST_TOKEN=demo-secret docker compose up
```

Log data is stored in a Docker named volume (`kamori-data`) so it persists across restarts.

### 2. Open the demo

Visit http://localhost:3000 and click **Place Order** to trigger a request across all services.

### 3. Connect Claude Code via MCP

```bash
claude mcp add kamori --transport http http://localhost:3111/mcp
```

## Integration patterns (copy-paste reference)

### `installShim` — Node.js console shim (express-api)

The fastest path to adding Kamori. Two lines, zero changes to existing code.

```typescript
import { installShim } from "/sdk";
installShim({ url: process.env.KAMORI_URL!, token: process.env.INGEST_TOKEN });
// All console.log / .warn / .error calls are now forwarded to Kamori
```

Event shape: `{ level, message, args: [{ ...yourFields }] }`

⚠️ Node.js only. See `/sdk/browser` for browser projects.

See: [express-api/src/index.ts](./express-api/src/index.ts)

---

### `KamoriClient` + `scoped()` — direct client (fastify-api)

Full control over event structure. `.scoped()` binds default fields to every event.

```typescript
import { KamoriClient } from "/sdk";
const kamori = new KamoriClient({ url, token, flushOnExit: true }).scoped({
  service: "my-service",
  env: process.env.NODE_ENV,
});

kamori.log({ level: "info", event: "user_signed_in", userId });
// → { service: "my-service", env: "production", level: "info", event: "user_signed_in", userId }
```

See: [fastify-api/src/index.ts](./fastify-api/src/index.ts)

---

### `withKamori` middleware (next-app)

Automatic HTTP request logging for every Next.js route — zero changes per route.

```typescript
// middleware.ts
import { withKamori } from "/sdk/next";
import { NextResponse } from "next/server";

export default withKamori(async (req) => NextResponse.next(), {
  url: process.env.KAMORI_URL!,
  token: process.env.INGEST_TOKEN,
});
export const config = { matcher: "/((?!_next|favicon.ico).*))" };
```

For business events in route handlers, use `KamoriClient` alongside `withKamori`.
For browser-side logging, wrap your layout with `KamoriProvider` (see below).

See: [next-app/src/middleware.ts](./next-app/src/middleware.ts) · [next-app/src/app/api/checkout/route.ts](./next-app/src/app/api/checkout/route.ts)

---

### `createKamoriStream` — pino transport (pino-service)

Pass a Kamori stream as pino's destination. No changes to existing `logger.*` calls.

```typescript
import pino from "pino";
import { createKamoriStream } from "/sdk/pino";

const stream = createKamoriStream({ url, token });
const logger = pino(
  { base: { service: "my-service" } },
  pino.multistream([{ stream: process.stdout }, { stream }]),
);
// All logger.info / .warn / .error calls → stdout + Kamori
```

See: [pino-service/src/index.ts](./pino-service/src/index.ts)

---

### `KamoriTransport` — winston transport (winston-service)

Add one transport to an existing winston logger. No changes to log call sites.

```typescript
import winston from "winston";
import { KamoriTransport } from "/sdk/winston";

const logger = winston.createLogger({
  defaultMeta: { service: "my-service" },
  transports: [
    new winston.transports.Console(), // keep existing transports
    new KamoriTransport({ url, token }), // add Kamori alongside them
  ],
});
```

See: [winston-service/src/index.ts](./winston-service/src/index.ts)

---

### `KamoriProvider` — browser SDK (next-app)

Client component that installs error capture and logs `page_view` on mount.

```tsx
// components/KamoriProvider.tsx
"use client";
import { KamoriClient, installErrorCapture } from "/sdk/browser";

const client = new KamoriClient({ url: process.env.NEXT_PUBLIC_KAMORI_URL! });

export function KamoriProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const cleanup = installErrorCapture(client); // captures window.onerror
    client.log({
      level: "info",
      event: "page_view",
      path: window.location.pathname,
    });
    return cleanup;
  }, []);
  return <>{children}</>;
}
```

See: [next-app/src/components/KamoriProvider.tsx](./next-app/src/components/KamoriProvider.tsx)

---

### `KamoriHandler` — Python logging (flask-service)

Drop-in `logging.Handler`. Attach to any existing Python logger.

```python
import logging
from kamori_sdk.logging_handler import KamoriHandler

logging.getLogger().addHandler(
    KamoriHandler(url=KAMORI_URL, token=INGEST_TOKEN or None)
)
# All logger.info / .warning / .error calls → stdout + Kamori
```

See: [flask-service/app.py](./flask-service/app.py)

---

### `KamoriClient` — Python SDK direct (python-sdk-service)

Buffered, thread-safe HTTP client with no framework dependency.

```python
from kamori_sdk import KamoriClient

client = KamoriClient(url=KAMORI_URL, token=INGEST_TOKEN or None)
client.log({"level": "info", "event": "order_processed", "orderId": order_id})
```

See: [python-sdk-service/main.py](./python-sdk-service/main.py)

---

### `KamoriClient` — PHP SDK direct (php-service)

Buffered PHP client. `__destruct()` flushes automatically at end of request.

```php
use Kamori\KamoriClient;
require __DIR__ . '/vendor/autoload.php';

$kamori = new KamoriClient($url, token: $token ?: null);
$kamori->log(['level' => 'info', 'event' => 'payment_processed', 'orderId' => $orderId]);
```

See: [php-service/index.php](./php-service/index.php)

---

### `KamoriHandler` — PHP Monolog (php-monolog-service)

Monolog 3 handler. Push alongside existing handlers — no call-site changes.

```php
use Kamori\Monolog\KamoriHandler;
use Monolog\Logger;

$logger = new Logger('my-service');
$logger->pushHandler(new StreamHandler('php://stdout'));
$logger->pushHandler(new KamoriHandler(url: $url, token: $token));
// All $logger->info() / ->error() calls → stdout + Kamori
```

See: [php-monolog-service/index.php](./php-monolog-service/index.php)

---

### `KamoriClient` — Go SDK (go-service)

Buffered goroutine-based client. `Scoped()` binds default fields to every event.

```go
import "github.com/usekamori/kamori-go/kamori"

client := kamori.New(kamori.Options{URL: url, Token: token, Service: "my-service"})
defer client.Shutdown(context.Background())

scoped := client.Scoped(kamori.Event{"env": "production"})
scoped.Log(kamori.Event{"level": "info", "event": "fraud_check_passed", "orderId": orderId})
```

See: [go-service/main.go](./go-service/main.go)

---

### Raw HTTP — reference pattern (fastapi-service)

For languages without an SDK, POST JSON directly to `/v1/ingest`:

```python
import httpx
httpx.post(f"{KAMORI_URL}/v1/ingest",
           json={**event, "service": "my-service"},
           headers={"Authorization": f"Bearer {token}"})
```

See: [fastapi-service/main.py](./fastapi-service/main.py)

## Simulated fault scenarios

Each service has built-in fault injection to give Claude real errors to investigate:

| Service             | Fault                         | Trigger                    |
| ------------------- | ----------------------------- | -------------------------- |
| express-api         | 429 rate limit from FastAPI   | Every 30th order           |
| fastapi-service     | Slow recommendation query >2s | Random 10% of calls        |
| flask-service       | SMTP 550 email bounce         | Every 20th confirmation    |
| php-service         | Memory exhaustion             | Orders with amount > $5000 |
| pino-service        | Inventory sync failure        | Every 8th inventory check  |
| winston-service     | Carrier API timeout           | Every 25th shipment        |
| go-service          | Fraud false positive          | Every 15th fraud check     |
| python-sdk-service  | Loyalty DB timeout            | Every 10th loyalty award   |
| php-monolog-service | Push gateway timeout          | Every 12th notification    |

## Generate logs & investigate with Claude

### Step 1 — Run the load generator

The load generator simulates real user sessions through the next-app UI — each
session visits the homepage, optionally searches for a product, then submits the
checkout form. Traffic flows through the full stack exactly as a browser would.

```bash
# From the kamori repo root — 40 user sessions at ~1 per second
npx tsx kamori-demo/load-gen.ts

# More volume, faster
npx tsx kamori-demo/load-gen.ts --orders 80 --delay 300

# Rapid burst hitting all fault thresholds immediately
npx tsx kamori-demo/load-gen.ts --scenario chaos
```

Each session fires (in order):

1. `GET /` on next-app — `withKamori` middleware logs the HTTP request
2. `GET /api/search` on fastify-api — `KamoriClient.scoped()` logs the search _(~60% of sessions)_
3. `POST /api/checkout` on next-app — `withKamori` + `KamoriClient` business events, then
   express-api fans out to all 8 downstream services

### Step 2 — Tail logs in real time

```bash
# All services — one line per event
curl -sN http://localhost:3110/v1/stream \
  | jq -rc '"\\(.ts[11:19]) [\\(.level)] \\(.service)  \\(.event // .message // "")"'

# Errors only
curl -sN "http://localhost:3110/v1/stream?level=error" | jq .

# Single service
curl -sN "http://localhost:3110/v1/stream?service=go-service" | jq .
```

### Step 3 — Connect Claude Code

```bash
claude mcp add kamori --transport http http://localhost:3111/mcp
```

Then start a Claude session and investigate:

```
Summarise all errors from the last 10 minutes across every service.
```

```
Which service has the highest error rate and what is the root cause?
```

```
Find all orders that failed payment processing and show me the order IDs.
```

```
The pino-service is throwing inventory sync failures — how often and does it correlate with order failures?
```

```
Give me a full cross-service trace for order ord-<id>.
```

## Architecture

```
Browser → next-app (3000)
             ├─→ express-api (3200)
             │       ├─→ go-service          (3600)  [fraud detection]
             │       ├─→ pino-service        (3500)  [inventory check]
             │       ├─→ fastapi-service     (3300)  [recommendations — raw HTTP]
             │       ├─→ flask-service       (3301)  [email confirmation]
             │       ├─→ php-service         (3400)  [payment]
             │       ├─→ python-sdk-service  (3302)  [loyalty points]
             │       ├─→ winston-service     (3501)  [shipping]
             │       └─→ php-monolog-service (3401)  [push notification]
             └─→ fastify-api (3201)                  [product search]

All services → Kamori :3110 → SQLite
Claude Code  → Kamori :3111 (MCP) → SQLite
```
