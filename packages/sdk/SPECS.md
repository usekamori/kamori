# `/sdk` Technical Specification

**Package:** `/sdk`  
**Source root:** `packages/sdk/src`  
**Module type:** ESM (`"type": "module"`)  
**Primary contract:** client-side log shipping to Kamori ingest endpoint (`POST /v1/ingest`)

## 1. Purpose

`/sdk` provides a TypeScript-first logging SDK that:

- batches and sends arbitrary JSON log events to a Kamori server,
- offers framework/runtime adapters (console shim, Pino, Winston, browser error capture, Next.js wrapper),
- is safe-by-default for application stability (logging failures do not throw into caller code).

## 2. Package Entry Points

From `package.json` exports:

- `/sdk` -> `src/index.ts`
- `/sdk/client` -> `src/client.ts`
- `/sdk/pino` -> `src/pino.ts`
- `/sdk/winston` -> `src/winston.ts`
- `/sdk/browser` -> `src/browser.ts`
- `/sdk/next` -> `src/next.ts`

## 3. Core API (`client.ts`)

## 3.1 `KamoriClientOptions`

- `url: string` (required)
  - must be an absolute `http://` or `https://` URL.
  - invalid/relative/non-http protocol throws at construction.
- `token?: string`
  - if set, sent as `Authorization: Bearer <token>`.
- `batchSize?: number` (default `50`)
- `flushInterval?: number` (default `2000` ms)
- `flushOnExit?: boolean` (default `false`)
- `captureSource?: boolean | "auto"` (default `false`)
  - `"auto"` enables capture when `NODE_ENV !== "production"`.
- `offlineQueue?: boolean` (default `false`)
  - browser-only `localStorage` spool for permanently failed batches.

## 3.2 `KamoriClient` behavior

- `log(event)`
  - buffers event in memory.
  - optional `_source` (file:line) enrichment when source capture active.
  - flushes when:
    - buffer length reaches `batchSize`, or
    - debounce timer hits `flushInterval`.
- `flush()`
  - no-op when buffer empty.
  - fire-and-forget; does not throw.
  - sends buffered batch to `${url}/v1/ingest` as JSON array.
- `on("drop", handler)`
  - subscribes to permanent-drop event.
  - chainable (`returns this`).
- `scoped(defaults)`
  - returns `ScopedKamoriClient`, sharing the same parent transport/buffer.
- `destroy()`
  - flushes pending data, clears timer, removes client from global exit registry.

## 3.3 Retry policy

Applied in `sendWithRetry`:

- Retry delays: `250ms`, `1000ms`, `4000ms` (3 retries after first attempt).
- Total attempts max: `4`.
- Retry on:
  - network/fetch rejection,
  - non-OK `5xx` responses.
- Do **not** retry on `4xx`; drop immediately.

## 3.4 Drop semantics

When a batch is permanently abandoned:

- if `offlineQueue=false`: invoke all registered `drop` handlers with original batch.
- if `offlineQueue=true`: spool to browser `localStorage` queue (`kamori_offline_queue`) and do not emit drop handlers.

## 3.5 Offline queue semantics (browser)

- Queue storage key: `kamori_offline_queue`.
- Max retained batches by count: `100` (keeps latest).
- Max retained payload by size: `2 MB` serialized JSON.
- On successful send, SDK attempts to flush queued batches.
- On queue parse corruption, queue is cleared.
- If `localStorage` unavailable/full, errors are swallowed.

## 3.6 Flush on shutdown

When `flushOnExit=true`:

- client is registered in module-level `exitClients` set.
- one-time global handlers are installed:
  - Node: `exit`, `SIGINT`, `SIGTERM`
  - Browser: `beforeunload`
- `SIGINT/SIGTERM`: async flush all clients, then `process.exit(0)` after 2s grace.
- `exit` / `beforeunload`: uses `flushSync()` best effort.
  - browser uses `navigator.sendBeacon` when available.
  - Node has no true synchronous HTTP flush guarantee.

## 3.7 Source capture

- disabled by default.
- adds `_source` as `"file:line"` (or `null` if parse fails) by stack parsing.
- capture rules:
  - `true` => always
  - `false` => never
  - `"auto"` => active outside production

## 3.8 `ScopedKamoriClient`

- `log(event)` merges defaults first, event fields override defaults.
- `scoped(extraDefaults)` nests defaults cumulatively.
- all scopes share parent `KamoriClient` queue/retry/timers (no new transport).

## 4. Root SDK Entry (`index.ts`)

Exports:

- `KamoriClient`, `ScopedKamoriClient`, `KamoriClientOptions`
- `createKamoriStream`
- `KamoriTransport`
- `installShim(opts)`

## 4.1 `installShim`

Patches global console methods:

- `console.log` -> `level: "info"`
- `console.warn` -> `level: "warn"`
- `console.error` -> `level: "error"`
- `console.debug` -> `level: "debug"`

Event shape:

- if first arg is string:
  - `message = firstArg`
  - `args = rest` (only if rest exists)
- else:
  - `args = allArgs`

Safety guarantees:

- original console method is always called first.
- any logging error is swallowed; console behavior remains intact.

## 5. Browser Entry (`browser.ts`)

Re-exports `KamoriClient`, `ScopedKamoriClient`, `KamoriClientOptions`.

Adds:

- `installErrorCapture(client, opts?) => cleanupFn`

Behavior:

- registers `window` listeners:
  - `error` (always),
  - `unhandledrejection` (default on; disable with `captureUnhandledRejections=false`).
- logs structured error events:
  - uncaught: `{ level: "error", type: "uncaught_error", message, _source?, stack? }`
  - rejection: `{ level: "error", type: "unhandled_rejection", message, stack? }`
- cleanup function removes installed listeners.

Security note:

- payload construction uses explicit fields, avoids object spread from event/reason objects to reduce prototype-pollution risk.

## 6. Pino Integration (`pino.ts`)

- `createKamoriStream(opts): Writable`

Behavior:

- accepts newline-delimited JSON chunks (`objectMode: false`).
- splits chunk by newline; parses each non-empty line as JSON object.
- forwards parsed object(s) to `KamoriClient.log`.
- malformed lines are ignored silently.
- `final()` calls `client.destroy()` to flush/teardown.

## 7. Winston Integration (`winston.ts`)

- `KamoriTransport` class (duck-typed transport, no hard dependency on `winston-transport`).

Contract:

- `name = "kamori"`
- `log(info, callback)` forwards `info` to client and invokes callback immediately.
- `close()` calls client `destroy()`.

## 8. Next.js Integration (`next.ts`)

- `withKamori(handler, opts) => wrappedHandler`

Wrapped request behavior:

- captures start time.
- extracts and logs pathname only (`new URL(req.url).pathname`), excluding query string.
- success log:
  - `{ level: "info", service: "next", method, path, status, duration_ms }`
- error log then rethrow:
  - `{ level: "error", service: "next", method, path, error, duration_ms }`
  - preserves original Next.js error handling by rethrowing.

Operational recommendation (from inline docs):

- call `withKamori` once at module level to avoid per-request client/timer allocation in long-lived Node runtimes.

## 9. Network Contract

All SDK pathways converge on ingest API:

- `POST {url}/v1/ingest`
- `Content-Type: application/json`
- body: JSON array of event objects
- optional header: `Authorization: Bearer <token>`

No response payload is required by SDK; only status class drives retry/drop behavior.

## 10. Error and Stability Guarantees

- Logging paths are best-effort and non-throwing in normal use:
  - shim and transport layers swallow parse/send errors.
  - network failures trigger retry/drop instead of bubbling.
- URL validation is strict and fail-fast at `KamoriClient` construction.

## 11. Tested Behavioral Guarantees (from `src/*.test.ts`)

- retries and delays are exact (`250/1000/4000`, max 4 attempts total).
- 4xx does not retry; 5xx/network does retry.
- drop handlers receive original event batch; multiple handlers all fire.
- `captureSource` mode matrix (`false`/`true`/`"auto"`) is verified.
- scoped clients share parent batching and merge semantics.
- shim level mapping and event-shape mapping are verified.
- browser error capture registration/cleanup and event payload fields are verified.
- pino multi-line chunk parsing and malformed-line tolerance are verified.
- winston callback invocation and naming contract are verified.
- next wrapper logs path without query and rethrows handler errors.

## 12. Non-Goals / Out of Scope

- guaranteed delivery under abrupt Node `process.exit` without signal grace.
- schema validation/normalization of user event payloads.
- guaranteed ordering across retries/offline replay beyond per-batch send attempts.
