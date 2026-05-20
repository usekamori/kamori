# kamori-sdk

Python SDK for [Kamori](https://github.com/usekamori/kamori) — self-hosted log ingestion with MCP support.

Events are buffered in memory and flushed to your Kamori server on a background daemon thread, so logging never blocks your application.

---

## Installation

```bash
pip install kamori-sdk
```

---

## Quick start

```python
import atexit
from kamori_sdk import KamoriClient

client = KamoriClient(
    url="https://your-kamori-server.com",
    token="your-log-token",   # matches INGEST_TOKEN on the server
)
atexit.register(client.shutdown)  # flush buffered events on process exit

client.log({"level": "info", "service": "api", "message": "Server started"})
client.log({"level": "error", "service": "payments", "message": "Stripe timeout", "duration_ms": 5001})
```

---

## Python `logging` integration

### One-liner (recommended)

```python
from kamori_sdk import install_logging_handler

handler = install_logging_handler(
    url="https://your-kamori-server.com",
    token="your-log-token",
)

import logging
logging.getLogger("api").info("Server started")
logging.getLogger("payments").error("Stripe timeout")
```

Each `LogRecord` is converted to a structured dict with `level`, `message`, `logger`, `module`, `funcName`, and `lineno` fields. Exception info is serialised as `exc_text` so stack traces are full-text-searchable in Kamori.

### Explicit handler

```python
import logging
from kamori_sdk.logging_handler import KamoriHandler

handler = KamoriHandler(
    url="https://your-kamori-server.com",
    token="your-log-token",
    level=logging.WARNING,   # only WARNING and above
)
logging.getLogger().addHandler(handler)
```

### Django

In `settings.py`:

```python
LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "handlers": {
        "kamori": {
            "class": "kamori_sdk.logging_handler.KamoriHandler",
            "url": "https://your-kamori-server.com",
            "token": env("INGEST_TOKEN", default=""),
        },
    },
    "root": {"handlers": ["kamori"], "level": "INFO"},
}
```

### FastAPI

```python
from contextlib import asynccontextmanager
from fastapi import FastAPI
from kamori_sdk import install_logging_handler

@asynccontextmanager
async def lifespan(app: FastAPI):
    handler = install_logging_handler(
        url=settings.KAMORI_URL,
        token=settings.INGEST_TOKEN,
    )
    yield
    handler.client.shutdown()   # flush before shutdown

app = FastAPI(lifespan=lifespan)
```

### structlog

```python
import structlog
from kamori_sdk import KamoriClient

client = KamoriClient(url="https://your-kamori-server.com", token="your-log-token")

def kamori_sink(logger, method, event_dict):
    client.log(event_dict)
    return event_dict

structlog.configure(
    processors=[
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso"),
        kamori_sink,
        structlog.dev.ConsoleRenderer(),
    ]
)
```

### loguru

```python
from loguru import logger
from kamori_sdk import KamoriClient

client = KamoriClient(url="https://your-kamori-server.com", token="your-log-token")

def kamori_sink(message):
    record = message.record
    client.log({
        "level":    record["level"].name.lower(),
        "message":  record["message"],
        "module":   record["module"],
        "function": record["function"],
        "line":     record["line"],
    })

logger.add(kamori_sink)
```

---

## Scoped clients

Add default fields to every log call without repeating them:

```python
def make_scoped(client: KamoriClient, **defaults):
    """Return a log function that merges defaults into every event."""
    def log(event):
        client.log({**defaults, **event})
    return log

api_log = make_scoped(client, service="api", version="2.1.0")
api_log({"level": "info", "message": "Request started", "path": "/checkout"})
api_log({"level": "error", "message": "DB timeout"})
```

---

## flush_on_exit

The background thread is a **daemon thread** — it dies automatically when the main thread exits. For guaranteed delivery, register `shutdown()` via `atexit`:

```python
import atexit
atexit.register(client.shutdown)   # flush + stop background thread (up to 5s)
```

Or call explicitly:

```python
client.shutdown(timeout=5.0)   # blocks up to 5 seconds
```

For an immediate flush without stopping the thread (useful in request handlers):

```python
client.flush()   # blocks until the queue drains
```

---

## on_drop callback

Called when a batch is permanently dropped after all retry attempts:

```python
import logging

def handle_drop(events):
    logging.warning("Kamori dropped %d events — check server connectivity", len(events))

client = KamoriClient(
    url="https://your-kamori-server.com",
    token="your-log-token",
    on_drop=handle_drop,
)
```

---

## Retry behaviour

Failed requests are retried up to three times with exponential back-off:

| Attempt   | Delay  |
| --------- | ------ |
| 1st retry | 0.25 s |
| 2nd retry | 1 s    |
| 3rd retry | 4 s    |

`4xx` responses are **not** retried (client error — bad token, oversized batch). The client never raises or crashes the calling thread.

---

## Configuration reference

| Parameter        | Default | Description                                                                                                               |
| ---------------- | ------- | ------------------------------------------------------------------------------------------------------------------------- |
| `url`            | —       | Base URL of your Kamori server (required)                                                                                 |
| `token`          | `None`  | Auth token (sent as `Authorization: Bearer`). Omit to skip auth.                                                          |
| `batch_size`     | `50`    | Flush automatically when buffer reaches this size                                                                         |
| `flush_interval` | `2.0`   | Max seconds between background flushes                                                                                    |
| `max_queue`      | `0`     | Max events in the in-memory queue. `0` = unlimited. New events are dropped (calling `on_drop`) when the limit is reached. |
| `on_drop`        | `None`  | `Callable[[list[dict]], None]` — called when a batch is dropped                                                           |

---

## Requirements

- Python 3.9+
- No external dependencies (uses `urllib.request` and `threading` from the standard library)

## License

MIT
