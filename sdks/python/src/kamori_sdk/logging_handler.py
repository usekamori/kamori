"""
Python ``logging`` integration for Kamori.

Drop-in handler that forwards Python log records to a Kamori ingest server.

Usage -- explicit handler::

    import logging
    from kamori_sdk.logging_handler import KamoriHandler

    handler = KamoriHandler(url="https://your-kamori-server.com", token="secret")
    logging.getLogger().addHandler(handler)

Usage -- one-liner::

    from kamori_sdk import install_logging_handler
    install_logging_handler(url="https://your-kamori-server.com", token="secret")

Django -- add to ``settings.py``::

    LOGGING = {
        "handlers": {
            "kamori": {
                "class": "kamori_sdk.logging_handler.KamoriHandler",
                "url": "https://your-kamori-server.com",
                "token": env("INGEST_TOKEN", default=""),
            },
        },
        "root": {"handlers": ["kamori"], "level": "INFO"},
    }

FastAPI -- call at startup::

    from contextlib import asynccontextmanager
    from kamori_sdk import install_logging_handler

    @asynccontextmanager
    async def lifespan(app):
        handler = install_logging_handler(url=settings.KAMORI_URL, token=settings.INGEST_TOKEN)
        yield
        handler.client.shutdown()
"""

from __future__ import annotations

import logging
import traceback
from typing import Any, Dict, Optional

from .client import KamoriClient

# Maximum bytes to include in the exc_text field. Long tracebacks are truncated
# to avoid sending multi-megabyte payloads for deeply nested exceptions.
_MAX_EXC_TEXT_BYTES = 8 * 1024  # 8 KB


class KamoriHandler(logging.Handler):
    """
    Python ``logging.Handler`` that ships log records to a Kamori server.

    Each record is converted to a dict and forwarded through a ``KamoriClient``
    (which handles batching, retries, and background delivery).

    Call ``close()`` (or let the logging framework call it during shutdown) to
    flush buffered events and stop the background thread cleanly.
    """

    def __init__(
        self,
        url: str,
        token: Optional[str] = None,
        batch_size: int = 50,
        flush_interval: float = 2.0,
        level: int = logging.NOTSET,
    ) -> None:
        """
        Initialise the handler and create an underlying KamoriClient.

        :param url:            Base URL of the Kamori ingest server.
        :param token:          Optional auth token.
        :param batch_size:     Passed through to KamoriClient.
        :param flush_interval: Passed through to KamoriClient.
        :param level:          Minimum log level (default: NOTSET = all levels).
        """
        super().__init__(level)
        self.client = KamoriClient(
            url=url,
            token=token,
            batch_size=batch_size,
            flush_interval=flush_interval,
        )

    def emit(self, record: logging.LogRecord) -> None:
        """
        Forward a log record to Kamori.

        Converts the record to a plain dict.  Exception info (if any) is
        serialised as a ``exc_text`` string (capped at 8 KB) so it is
        searchable in FTS without producing excessively large payloads.

        :param record: The log record emitted by the logging framework.
        """
        try:
            event: Dict[str, Any] = {
                "level": record.levelname.lower(),
                "message": self.format(record) if self.formatter else record.getMessage(),
                "logger": record.name,
                "module": record.module,
                "funcName": record.funcName,
                "lineno": record.lineno,
            }
            # Attach exception text when present, capped to avoid huge payloads.
            if record.exc_info:
                exc_text = "".join(traceback.format_exception(*record.exc_info))
                if len(exc_text) > _MAX_EXC_TEXT_BYTES:
                    exc_text = exc_text[:_MAX_EXC_TEXT_BYTES] + "\n[truncated]"
                event["exc_text"] = exc_text
            self.client.log(event)
        except Exception:
            # Handler errors must never propagate -- use handleError for logging
            self.handleError(record)

    def close(self) -> None:
        """
        Flush buffered events and shut down the background thread.

        Called automatically by the logging framework during interpreter
        shutdown. Waits up to 5 seconds for in-flight events to be delivered.
        """
        try:
            self.client.shutdown(timeout=5.0)
        finally:
            super().close()
