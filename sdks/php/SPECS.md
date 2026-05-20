# `usekamori/kamori-php` Technical Specification

**Package:** `usekamori/kamori-php`  
**Path:** `kamori/sdks/php`  
**Language target:** PHP 8.1+  
**Primary role:** buffered HTTP log client for Kamori ingest (`/v1/ingest`) with optional Monolog and Laravel integrations.

## 1. Purpose

The PHP SDK provides:

- a core `KamoriClient` for structured event logging,
- a Monolog 3 handler (`Kamori\Monolog\KamoriHandler`),
- a Laravel service provider (`Kamori\Laravel\KamoriServiceProvider`) with auto-discovery support.

Design intent:

- keep app code resilient (logging failures should not crash the app),
- batch requests for efficiency,
- support retry with bounded backoff,
- flush buffered logs on shutdown/destruction.

## 2. Package Metadata and Dependencies

From `composer.json`:

- package name: `usekamori/kamori-php`
- license: MIT
- required runtime:
  - `php >= 8.1`
- dev dependencies:
  - `phpunit/phpunit ^10`
  - `monolog/monolog ^3`
- suggested optional integrations:
  - `monolog/monolog`
  - `illuminate/support` (Laravel)
- PSR-4 namespace:
  - `Kamori\` -> `src/`

## 3. Core Client (`src/KamoriClient.php`)

## 3.1 Constructor contract

`new KamoriClient(string $url, ?string $token = null, int $batchSize = 50, int $maxBuffer = 250, ?callable $onDrop = null)`

- `url`: base Kamori server URL.
- `token`: sent as `Authorization: Bearer` when not null.
- `batchSize`: auto-flush threshold.
- `maxBuffer`: hard cap on in-memory buffered events; new events are dropped when reached.
- `onDrop`: optional callback invoked with dropped events.

## 3.2 Buffering and flush semantics

- `log(array $event)`:
  - appends to in-memory buffer unless `maxBuffer` reached.
  - if buffer reaches `batchSize`, calls `flush()`.
- `flush()`:
  - no-op when buffer is empty.
  - atomically drains current buffer and sends drained batch.
  - new logs during send go into a new buffer.
- `__destruct()`:
  - calls `flush()` (best-effort final delivery).

## 3.3 Retry policy

Retries are implemented iteratively in `sendWithRetry()` with schedule:

- 1st retry after 0.25s
- 2nd retry after 1.0s
- 3rd retry after 4.0s

Total attempts max:

- initial attempt + 3 retries = 4 sends.

Decision rules:

- `send() === true` -> success, stop.
- `send()` returns HTTP `4xx` int -> no retry, drop immediately.
- `send()` returns `5xx` int or `false` -> retry until exhausted, then drop.

Retries are blocking (`usleep`), since PHP runtime is synchronous.

## 3.4 HTTP send implementation

Single send is performed by `send(array $events)`:

- endpoint: `rtrim($url, '/') . '/v1/ingest'`
- method: `POST`
- headers:
  - `Content-Type: application/json`
  - `Content-Length`
  - optional `Authorization: Bearer`
- timeout: 10 seconds
- transport: PHP stream context + `fopen` (no curl requirement)
- `ignore_errors = true` to capture non-2xx status line.

Return contract:

- `true` on HTTP status < 400
- `int` status code on HTTP error (>= 400)
- `false` on network/parse/serialization failure

## 3.5 JSON serialization and sanitization

- first attempt: `json_encode(..., JSON_THROW_ON_ERROR)`.
- on `JsonException`, client sanitizes events:
  - object/resource values replaced with `[unserializable: <type>]`.
- retries serialization with:
  - `JSON_THROW_ON_ERROR | JSON_PARTIAL_OUTPUT_ON_ERROR`.
- if still not serializable: returns `false` (treated as transient failure path).

## 3.6 Drop behavior

Dropped batches occur in two cases:

1. buffer overflow in `log()` when `count(buffer) >= maxBuffer` (drops incoming event),
2. send failure after retry exhaustion / immediate 4xx.

If `onDrop` is configured:

- callback invoked with dropped events array.
- callback exceptions are swallowed.

## 4. Monolog Integration (`src/Monolog/KamoriHandler.php`)

`KamoriHandler` extends `Monolog\Handler\AbstractProcessingHandler`.

## 4.1 Construction

`new KamoriHandler(string $url, ?string $token = null, int $batchSize = 50, Level $level = Level::Debug, bool $bubble = true)`

- internally creates a `KamoriClient`.

## 4.2 Record mapping

`write(LogRecord $record)` sends event with:

- `level` -> lowercase Monolog level name
- `message`
- `channel`
- `datetime` -> RFC3339_EXTENDED string
- optional `context` and `extra` (sanitized)

Context/extra sanitization:

- object/resource values replaced with `[<type>]`.
- supports one-level nested array sanitization.

## 4.3 Shutdown semantics

- `close()` flushes client, then calls parent `close()`.
- `getClient()` exposes underlying client for explicit flushing/testing.

## 5. Laravel Integration (`src/Laravel/KamoriServiceProvider.php`)

## 5.1 Registration behavior

- merges package config from `src/Laravel/config/kamori.php` under `kamori`.
- registers singleton `KamoriClient`.

Validation at binding time:

- `kamori.url` required (non-empty) -> else `InvalidArgumentException`.
- must be valid URL.
- scheme must be `http` or `https`.

Client config wiring:

- `url` <- `config('kamori.url')`
- `token` <- `config('kamori.token')` (empty -> null)
- `batchSize` <- `config('kamori.batch_size', 50)`

## 5.2 Logging channel extension

Adds custom LogManager driver `kamori` via `LogManager::extend`.

Driver behavior:

- builds Monolog logger with a `KamoriHandler`.
- channel config can override `url`, `token`, `batch_size`.
- falls back to package config when not overridden.

## 5.3 Boot behavior

- publishes config file with tag `kamori-config`.
- registers `app()->terminating()` flush hook (HTTP lifecycle).
- registers `register_shutdown_function()` fallback for CLI/worker contexts.
  - only flushes if client has already been resolved from container.

## 5.4 Default Laravel config (`src/Laravel/config/kamori.php`)

- `url` <- `env('KAMORI_URL', '')`
- `token` <- `env('INGEST_TOKEN', '')`
- `batch_size` <- `50`

## 6. Tested Guarantees (from `tests/*`)

`KamoriClientTest` verifies:

- buffering vs flush behavior,
- auto-flush on batch threshold,
- no-op flush on empty buffer,
- retry semantics:
  - 4xx no retry,
  - 5xx/network retry up to 3 retries,
  - stop retry on success,
- `onDrop` callback receives original batch,
- buffer isolation between flushes,
- token/url storage behavior.

`KamoriHandlerTest` verifies:

- handler inheritance and structure,
- log event mapping (level/message/channel/datetime),
- context/extra inclusion/omission rules,
- flush on close,
- Monolog level filtering behavior.

## 7. Operational Characteristics

- fire-and-forget style logging API (`log()` returns void, does not throw).
- retries block current execution thread/process during backoff.
- final flush is best-effort via destructor/shutdown hooks.
- integration-friendly with frameworks that own request lifecycle (Laravel).

## 8. Non-Goals / Out of Scope

- async/non-blocking transport (no event loop integration).
- guaranteed exactly-once delivery.
- in-process persistent offline queue.
- complex client-side sampling/rate limiting.
