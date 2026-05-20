# @usekamori/sdk

Kamori client SDK. Provides a batching HTTP client for shipping log events to a Kamori ingest server, plus a console shim and integrations for popular logging libraries.

## KamoriClient

The core building block — a fire-and-forget HTTP client with internal batching.

```typescript
import { KamoriClient } from "@usekamori/sdk";

const kamori = new KamoriClient({
  url: "https://your-kamori-server.example.com",
  token: process.env.INGEST_TOKEN, // must match INGEST_TOKEN on the server
  batchSize: 50, // flush when buffer reaches this size (default: 50)
  flushInterval: 2000, // flush every N ms even if buffer isn't full (default: 2000)
  flushOnExit: true, // register SIGINT/SIGTERM/exit handlers
  captureSource: "auto", // append _source: "file:line" to every event
  offlineQueue: true, // spool failed batches to localStorage (browser only)
});

// Log a single event (non-blocking)
kamori.log({
  service: "myapp",
  level: "info",
  message: "user signed in",
  userId: "u_123",
});

// Flush immediately (e.g. at process exit)
kamori.flush();
```

### Options

| Option          | Type                | Default  | Description                                                                                                                 |
| --------------- | ------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------- |
| `url`           | string              | required | Base URL of your Kamori server                                                                                              |
| `token`         | string?             | —        | Auth token (sent as `Authorization: Bearer`)                                                                                |
| `batchSize`     | number              | `50`     | Flush when buffer reaches this size                                                                                         |
| `flushInterval` | number              | `2000`   | Flush interval in milliseconds                                                                                              |
| `flushOnExit`   | boolean             | `false`  | Registers `SIGINT`, `SIGTERM`, and `exit` handlers to drain the buffer before the process terminates                        |
| `captureSource` | boolean \| `"auto"` | `false`  | Appends `_source: "file:line"` to every event. `"auto"` enables it only when `NODE_ENV !== "production"`                    |
| `offlineQueue`  | boolean             | `false`  | Spools failed batches to `localStorage` (browser only) and retries automatically on reconnect. Silently ignored in Node.js. |

### Behaviour

- `log()` is synchronous and never throws. Events are buffered in memory.
- `flush()` is fire-and-forget. Network errors are silently dropped — logging must never crash the caller.
- Trailing events at process exit: use `flushOnExit: true` or call `kamori.flush()` in your shutdown handler.

---

## scoped() and ScopedKamoriClient

`scoped()` returns a lightweight child client that shares the parent's buffer and flush cycle. Use it to stamp a fixed set of fields (e.g. `service`, `env`, `requestId`) onto every event without repeating them at each call site.

```typescript
import { KamoriClient, ScopedKamoriClient } from "@usekamori/sdk";

const root = new KamoriClient({ url: "...", token: "..." });

const api = root.scoped({ service: "api", env: "production" });
api.log({ level: "info", message: "request received", path: "/checkout" });
// → { service: "api", env: "production", level: "info", message: "request received", path: "/checkout" }

// Per-request child: nest scopes
const reqScope = api.scoped({ requestId: "req_abc123" });
reqScope.log({ level: "error", message: "payment failed" });
// → { service: "api", env: "production", requestId: "req_abc123", level: "error", message: "payment failed" }
```

`ScopedKamoriClient` is also exported as a named class if you need to type it explicitly:

```typescript
import { ScopedKamoriClient } from "@usekamori/sdk";
```

---

## installShim

Patches the global `console` so every `console.log`, `console.warn`, `console.error`, and `console.debug` call is forwarded to Kamori **automatically**, while still printing to the terminal (or browser devtools) normally.

```typescript
import { installShim } from "@usekamori/sdk";

installShim({
  url: "https://your-kamori-server.example.com",
  token: process.env.INGEST_TOKEN,
});

// From this point on, all console output is captured and shipped to Kamori.
console.log("server started", { port: 3110 });
console.error("payment failed", { orderId: 99 });
```

Call `installShim` **once**, at the very top of your entry point, before any other imports.

### Level mapping

| Console method  | Kamori `level` |
| --------------- | -------------- |
| `console.log`   | `info`         |
| `console.warn`  | `warn`         |
| `console.error` | `error`        |
| `console.debug` | `debug`        |

### Event shape

The shim builds a log event from the arguments passed to the console method:

| Arguments                      | Event shape                                           |
| ------------------------------ | ----------------------------------------------------- |
| `console.log("message")`       | `{ level: "info", message: "message" }`               |
| `console.log("message", a, b)` | `{ level: "info", message: "message", args: [a, b] }` |
| `console.log({ obj })`         | `{ level: "info", args: [{ obj }] }`                  |

When the first argument is a string, it becomes `message`. Any additional arguments are collected into `args[]`. When the first argument is not a string, all arguments go into `args[]`.

### Browser usage

`installShim` works in both Node.js and browser environments — it only uses `fetch` and `console`, which are available everywhere.

**CORS**: When calling Kamori from a browser, the server must respond with appropriate `Access-Control-Allow-Origin` headers. Configure `@fastify/cors` on your Kamori server:

```typescript
// packages/ingest/src/ingest.ts
await server.register(import("@fastify/cors"), {
  origin: "https://your-app.example.com",
});
```

Or allow all origins during development:

```typescript
await server.register(import("@fastify/cors"), { origin: true });
```

### Browser example

```html
<script type="module">
  import { installShim } from "https://cdn.jsdelivr.net/npm/@usekamori/sdk/src/index.js";

  installShim({ url: "https://your-kamori-server.example.com" });

  console.error("JS error", { page: location.pathname });
  // ^ shipped to Kamori and visible in devtools
</script>
```

---

## Pino transport — `@usekamori/sdk/pino`

`createKamoriStream` returns a Node.js `Writable` stream that pino can write to. Each NDJSON line is parsed and forwarded to Kamori via `KamoriClient`.

```typescript
import pino from "pino";
import { createKamoriStream } from "@usekamori/sdk/pino";

const stream = createKamoriStream({
  url: "https://your-kamori-server.example.com",
  token: process.env.INGEST_TOKEN,
});

const logger = pino(stream);
logger.error({ orderId: 99 }, "payment failed");
```

The stream flushes and tears down the underlying `KamoriClient` when destroyed (e.g. `stream.end()` or process exit via `pino.destination().destroy()`).

---

## Winston transport — `@usekamori/sdk/winston`

```typescript
import winston from "winston";
import { KamoriTransport } from "@usekamori/sdk/winston";

const logger = winston.createLogger({
  transports: [
    new winston.transports.Console(),
    new KamoriTransport({
      url: "https://your-kamori-server.example.com",
      token: process.env.INGEST_TOKEN,
    }),
  ],
});

logger.error("payment failed", { orderId: 99 });
```

`KamoriTransport` accepts the same options as `KamoriClient` (`batchSize`, `flushInterval`, etc.).

---

## Browser SDK — `@usekamori/sdk/browser`

A separate entry point optimised for browser environments:

- Uses `navigator.sendBeacon` for reliable delivery on page unload
- Falls back to `fetch` when Beacon is not available
- No Node.js-specific APIs

```typescript
import { KamoriClient, installErrorCapture } from "@usekamori/sdk/browser";

const client = new KamoriClient({
  url: "https://your-kamori-server.example.com",
  token: "...",
});
client.log({
  service: "web",
  level: "error",
  message: "JS error",
  page: location.pathname,
});

// Automatically capture window.onerror and window.onunhandledrejection
const cleanup = installErrorCapture(client);
// cleanup() removes the handlers (useful during hot-module replacement or test teardown)
```

**`installErrorCapture(client, opts)` options**

| Option                       | Type    | Default | Description                                                                   |
| ---------------------------- | ------- | ------- | ----------------------------------------------------------------------------- |
| `captureUnhandledRejections` | boolean | `true`  | Whether to hook `window.onunhandledrejection` in addition to `window.onerror` |

---

## Sensitive data & PII

`@usekamori/sdk` ships events verbatim. **Redaction is your responsibility** — strip sensitive values before calling `client.log()` or before they reach a logger transport, not after.

**Pino users** — use pino's built-in [`redact` option](https://getpino.io/#/docs/redaction). It costs nothing extra and runs before serialisation:

```typescript
const logger = pino({
  redact: ["password", "token", "user.email", "headers.authorization"],
  transport: { target: "@usekamori/sdk/pino", options: { url: "...", token: "..." } },
});
```

**All other transports** — wrap `client.log()` with [bluestreak](https://github.com/martinkr/bluestreak) for GDPR / PCI-DSS / HIPAA coverage:

```typescript
import { compileRecommendedPolicy, redactLine } from "bluestreak";
const policy = compileRecommendedPolicy(); // compile once

function log(event: Record<string, unknown>) {
  kamori.log(JSON.parse(redactLine(JSON.stringify(event), policy)));
}
```

See [`docs/SDK.md`](../../docs/SDK.md#sensitive-data--pii) for Winston, stream pipeline, and custom policy examples.

---

## Next.js middleware — `@usekamori/sdk/next`

Wrap any Next.js API route or Edge handler with `withKamori` to automatically log request errors to Kamori.

```typescript
// middleware.ts  (or app/api/route/route.ts)
import { withKamori } from "@usekamori/sdk/next";
import { NextResponse } from "next/server";

export default withKamori(async (req) => NextResponse.next(), {
  url: process.env.KAMORI_URL!,
  token: process.env.INGEST_TOKEN,
});

export const config = { matcher: "/((?!_next|favicon.ico).*)" };
```

`withKamori` logs one `info` event per request (method, path, status, duration_ms). Thrown errors are logged at `level: "error"` and re-thrown so Next.js error handling continues normally.

**`withKamori(handler, opts)` options**

`opts` is a `KamoriClientOptions` object (`url`, `token`, `batchSize`, `flushInterval`, etc.) — the same options accepted by `KamoriClient`. A single client instance is created per `withKamori` call and shared across all requests.
