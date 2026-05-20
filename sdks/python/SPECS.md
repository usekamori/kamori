# `kamori-sdk` (Python) Technical Specification

**Project:** `kamori-sdk`  
**Source root:** `sdks/python/src/kamori_sdk`  
**Package name:** `kamori_sdk`  
**Primary role:** buffered, background-thread Python client for Kamori ingest (`POST /v1/ingest`) with `logging` integration.

## 1. Purpose

`kamori-sdk` provides:

- a thread-safe buffered HTTP client (`KamoriClient`) that queues events and flushes asynchronously,
- retry/drop handling for transient transport failures,
- a stdlib `logging.Handler` (`KamoriHandler`) for drop-in integration,
- one-liner logger installation helper (`install_logging_handler`).

The design goal is to avoid blocking or crashing application logging paths.

## 2. Packaging and Runtime Contract

- Build backend: `hatchling` (`pyproject.toml`).
- Python requirement: `>=3.9`.
- Runtime dependencies: none (standard library only).
- Optional dev dependency: `pytest>=7.0`.

## 3. Public API Surface

From `kamori_sdk.__init__`:

- `KamoriClient`
- `KamoriHandler`
- `install_logging_handler(url, token=None, level=0, logger_name=None) -> KamoriHandler`

## 4. `KamoriClient` Contract (`client.py`)

## 4.1 Constructor

`KamoriClient(...)` parameters:

- `url: str` (required)
- `token: Optional[str] = None`
- `batch_size: int = 50`
- `flush_interval: float = 2.0`
- `max_queue: int = 10000` (`_DEFAULT_MAX_QUEUE`)
- `on_drop: Optional[Callable[[List[Dict[str, Any]]], None]] = None`

Initialization behavior:

- normalizes URL by removing trailing slash (`rstrip("/")`),
- creates bounded `queue.Queue(maxsize=max_queue)`,
- starts one daemon worker thread immediately.

## 4.2 Event ingestion (`log`)

- accepts `Dict[str, Any]` events.
- no-op after shutdown is initiated (`_stop_event` set).
- enqueues non-blocking via `put_nowait`.
- if queue full:
  - drops event immediately,
  - invokes `on_drop` with single-event batch.

## 4.3 Flush semantics (`flush`)

- synchronous barrier for queued work:
  - enqueues `_FlushSentinel`,
  - waits on sentinel event until worker flushes current buffer.
- returns when all events queued before sentinel are sent or dropped.

## 4.4 Shutdown semantics (`shutdown`)

- sets stop event, enqueues `None` stop sentinel, joins worker.
- return value:
  - `True` if worker stopped before timeout,
  - `False` if thread still alive after timeout.
- default timeout: `5.0` seconds.

## 4.5 Worker loop behavior

Worker (`_worker`) batching logic:

- maintains local buffer list.
- queue poll timeout equals `flush_interval`.
- flush triggers:
  - timeout with non-empty buffer,
  - buffer length reaching `batch_size`,
  - flush sentinel received.
- on stop sentinel (`None`): exits loop, then drains remaining buffer once.

## 4.6 Send/retry behavior

HTTP send path (`_send_with_retry`):

- endpoint: `POST <url>/v1/ingest`
- request body: UTF-8 JSON array of events
- headers:
  - `Content-Type: application/json`
  - optional `Authorization: Bearer <token>` when token provided
- timeout: 10 seconds via `urllib.request.urlopen(..., timeout=10)`

Retry policy:

- delay schedule (`_RETRY_DELAYS`): `0.25s`, `1.0s`, `4.0s`
- retries for:
  - `5xx` HTTP errors
  - network/transport exceptions
- no retry for `4xx` errors (drop immediately)
- after all attempts exhausted: drop batch

## 4.7 Drop callback behavior

`_drop(events)`:

- invokes `on_drop(events)` if configured,
- swallows callback exceptions so callback failures cannot break worker/client.

## 5. Logging Integration (`logging_handler.py`)

## 5.1 `KamoriHandler`

Subclass of `logging.Handler`.

Constructor:

- `url`, `token`, `batch_size`, `flush_interval`, `level=logging.NOTSET`
- internally creates a `KamoriClient`.

Record mapping in `emit(record)`:

- `level`: lowercase `record.levelname`
- `message`: formatted message if formatter exists; else `record.getMessage()`
- `logger`: `record.name`
- `module`: `record.module`
- `funcName`: `record.funcName`
- `lineno`: `record.lineno`
- optional `exc_text` when `record.exc_info` present

Exception text behavior:

- built using `traceback.format_exception`,
- capped at 8KB (`_MAX_EXC_TEXT_BYTES`),
- adds `\n[truncated]` suffix when truncated.

Error handling:

- `emit` catches all exceptions and delegates to `self.handleError(record)`.

Shutdown behavior:

- `close()` calls `self.client.shutdown(timeout=5.0)`, then `super().close()`.

## 5.2 One-liner installer (`install_logging_handler`)

Function behavior:

- creates `KamoriHandler`,
- attaches to target logger (`logging.getLogger(logger_name)`; root when `None`),
- registers `handler.client.shutdown` via `atexit`,
- returns handler instance.

## 6. Concurrency and Reliability Characteristics

- single background daemon thread handles queue draining and network I/O.
- logging call path (`log`) is non-blocking unless external caller explicitly calls `flush`.
- queue is bounded; overflow causes controlled drop rather than backpressure blocking.
- daemon thread does not keep process alive; explicit `shutdown`/`atexit` is required for stronger delivery guarantees at exit.

## 7. HTTP Contract

Target server contract expected by SDK:

- accepts `POST /v1/ingest` with JSON array body.
- token auth via optional `Authorization: Bearer`.
- HTTP status class semantics used by client:
  - `<400`: success
  - `4xx`: permanent failure
  - `5xx`: transient failure (retryable)

## 8. Error Handling Policy

- client and handler are fail-safe by design:
  - network/serialization failures do not raise into caller logging path,
  - failed batches are dropped with optional callback notification,
  - callback errors are suppressed.

## 9. Non-Goals / Out of Scope

- durable disk-backed queueing/offline persistence,
- schema validation for event payloads beyond JSON serializability,
- guaranteed delivery on hard process kill (`SIGKILL`) or abrupt interpreter termination,
- async/await-native transport APIs (thread + stdlib urllib model only).
