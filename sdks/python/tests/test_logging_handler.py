"""
Tests for KamoriHandler and install_logging_handler.

KamoriClient.log() is patched on the handler instance so no real network
calls or background threads are exercised here.
"""

from __future__ import annotations

import logging
import sys
from typing import Any, Dict, List
from unittest.mock import MagicMock, patch

import pytest

from kamori_sdk import KamoriHandler, install_logging_handler
from kamori_sdk.logging_handler import KamoriHandler as KamoriHandlerDirect


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_handler(**kwargs: Any) -> KamoriHandler:
    """Return a KamoriHandler with a mocked underlying client."""
    with patch("kamori_sdk.client.KamoriClient._worker"):  # prevent thread work
        handler = KamoriHandler(url="http://localhost:3110", token="tok", **kwargs)
    handler.client.log = MagicMock()  # type: ignore[method-assign]
    return handler


def _make_record(
    msg: str = "test message",
    level: int = logging.INFO,
    exc_info: bool = False,
    name: str = "test.logger",
) -> logging.LogRecord:
    """Create a LogRecord for the given parameters."""
    logger = logging.getLogger(name)
    record = logger.makeRecord(
        name=name,
        level=level,
        fn="test_file.py",
        lno=42,
        msg=msg,
        args=(),
        exc_info=sys.exc_info() if exc_info else None,
    )
    return record


# ---------------------------------------------------------------------------
# KamoriHandler is a logging.Handler
# ---------------------------------------------------------------------------

class TestKamoriHandlerType:
    def test_is_logging_handler(self) -> None:
        """KamoriHandler must be a subclass of logging.Handler."""
        assert issubclass(KamoriHandler, logging.Handler)

    def test_instance_is_logging_handler(self) -> None:
        """A KamoriHandler instance must pass isinstance check."""
        handler = _make_handler()
        assert isinstance(handler, logging.Handler)
        handler.client.shutdown = MagicMock()
        handler.client.shutdown()


# ---------------------------------------------------------------------------
# emit() field mapping
# ---------------------------------------------------------------------------

class TestEmitFields:
    def test_emit_calls_client_log(self) -> None:
        """emit() should call client.log() exactly once per record."""
        handler = _make_handler()
        record = _make_record("hello world")
        handler.emit(record)
        handler.client.log.assert_called_once()

    def test_level_field_is_lowercased(self) -> None:
        """The 'level' field in the forwarded event should be lowercase."""
        handler = _make_handler()
        record = _make_record("msg", level=logging.WARNING)
        handler.emit(record)
        event: Dict[str, Any] = handler.client.log.call_args[0][0]
        assert event["level"] == "warning"

    def test_level_info_lowercased(self) -> None:
        """INFO level should be forwarded as 'info'."""
        handler = _make_handler()
        record = _make_record("msg", level=logging.INFO)
        handler.emit(record)
        event = handler.client.log.call_args[0][0]
        assert event["level"] == "info"

    def test_level_error_lowercased(self) -> None:
        """ERROR level should be forwarded as 'error'."""
        handler = _make_handler()
        record = _make_record("msg", level=logging.ERROR)
        handler.emit(record)
        event = handler.client.log.call_args[0][0]
        assert event["level"] == "error"

    def test_message_field_contains_message(self) -> None:
        """The 'message' field should contain the record's rendered message."""
        handler = _make_handler()
        record = _make_record("hello from test")
        handler.emit(record)
        event = handler.client.log.call_args[0][0]
        assert event["message"] == "hello from test"

    def test_logger_field_is_logger_name(self) -> None:
        """The 'logger' field should match the logger name."""
        handler = _make_handler()
        record = _make_record(name="myapp.views")
        handler.emit(record)
        event = handler.client.log.call_args[0][0]
        assert event["logger"] == "myapp.views"

    def test_lineno_field_is_int(self) -> None:
        """The 'lineno' field should be an integer."""
        handler = _make_handler()
        record = _make_record()
        handler.emit(record)
        event = handler.client.log.call_args[0][0]
        assert isinstance(event["lineno"], int)

    def test_module_and_funcname_present(self) -> None:
        """The 'module' and 'funcName' fields should be present in the event."""
        handler = _make_handler()
        record = _make_record()
        handler.emit(record)
        event = handler.client.log.call_args[0][0]
        assert "module" in event
        assert "funcName" in event

    def test_message_uses_formatter_when_set(self) -> None:
        """When a Formatter is attached, emit() should use the formatted output."""
        handler = _make_handler()
        handler.setFormatter(logging.Formatter("PREFIX: %(message)s"))
        record = _make_record("body text")
        handler.emit(record)
        event = handler.client.log.call_args[0][0]
        assert event["message"] == "PREFIX: body text"


# ---------------------------------------------------------------------------
# Exception info
# ---------------------------------------------------------------------------

class TestExceptionInfo:
    def test_exc_text_present_when_exc_info(self) -> None:
        """emit() should include 'exc_text' when the record has exc_info."""
        handler = _make_handler()
        try:
            raise ValueError("boom")
        except ValueError:
            record = _make_record("something went wrong", exc_info=True)

        handler.emit(record)
        event = handler.client.log.call_args[0][0]
        assert "exc_text" in event
        assert "ValueError" in event["exc_text"]
        assert "boom" in event["exc_text"]

    def test_exc_text_absent_without_exc_info(self) -> None:
        """emit() should NOT include 'exc_text' when there is no exception."""
        handler = _make_handler()
        record = _make_record("clean message")
        handler.emit(record)
        event = handler.client.log.call_args[0][0]
        assert "exc_text" not in event


# ---------------------------------------------------------------------------
# install_logging_handler
# ---------------------------------------------------------------------------

class TestInstallLoggingHandler:
    def test_returns_kamori_handler(self) -> None:
        """install_logging_handler() must return a KamoriHandler instance."""
        with patch("kamori_sdk.client.KamoriClient._worker"):
            handler = install_logging_handler(url="http://localhost:3110")
        assert isinstance(handler, KamoriHandler)
        # Clean up
        logging.getLogger().removeHandler(handler)

    def test_attaches_to_root_logger_by_default(self) -> None:
        """install_logging_handler() with no logger_name attaches to root."""
        root = logging.getLogger()
        original_handlers = root.handlers[:]
        try:
            with patch("kamori_sdk.client.KamoriClient._worker"):
                handler = install_logging_handler(url="http://localhost:3110")
            assert handler in root.handlers
        finally:
            root.handlers = original_handlers

    def test_attaches_to_named_logger(self) -> None:
        """install_logging_handler(logger_name=...) attaches to that logger."""
        target = logging.getLogger("kamori.test.named")
        original_handlers = target.handlers[:]
        try:
            with patch("kamori_sdk.client.KamoriClient._worker"):
                handler = install_logging_handler(
                    url="http://localhost:3110", logger_name="kamori.test.named"
                )
            assert handler in target.handlers
        finally:
            target.handlers = original_handlers

    def test_level_passed_to_handler(self) -> None:
        """The level argument should be forwarded to the KamoriHandler."""
        with patch("kamori_sdk.client.KamoriClient._worker"):
            handler = install_logging_handler(
                url="http://localhost:3110", level=logging.ERROR
            )
        assert handler.level == logging.ERROR
        logging.getLogger().removeHandler(handler)
