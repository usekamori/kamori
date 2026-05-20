"""
kamori-sdk -- Python client for Kamori log ingestion.

Quick start::

    from kamori_sdk import KamoriClient, install_logging_handler

    # Direct client
    client = KamoriClient(url="https://your-kamori-server.com", token="secret")
    client.log({"level": "info", "message": "hello"})

    # Console shim (patches Python's logging module)
    install_logging_handler(url="https://your-kamori-server.com", token="secret")
"""

import atexit

from .client import KamoriClient
from .logging_handler import KamoriHandler


def install_logging_handler(
    url: str,
    token: "str | None" = None,
    level: int = 0,  # logging.NOTSET
    logger_name: "str | None" = None,
) -> "KamoriHandler":
    """
    One-liner: attach a KamoriHandler to the root logger (or a named logger).

    Registers ``handler.client.shutdown`` with ``atexit`` so buffered events
    are flushed when the interpreter exits normally.  Returns the handler so
    callers can also call ``handler.client.shutdown()`` explicitly.

    :param url:         Base URL of the Kamori ingest server.
    :param token:       Optional auth token.
    :param level:       Minimum level (default: NOTSET -- forwards everything).
    :param logger_name: Logger to attach to; None attaches to the root logger.
    :returns:           The installed KamoriHandler instance.
    """
    import logging
    handler = KamoriHandler(url=url, token=token, level=level)
    target = logging.getLogger(logger_name)
    target.addHandler(handler)
    # Ensure buffered events are delivered even when shutdown() is not called
    # explicitly (e.g. scripts that just call install_logging_handler and exit).
    atexit.register(handler.client.shutdown)
    return handler


__all__ = ["KamoriClient", "KamoriHandler", "install_logging_handler"]
