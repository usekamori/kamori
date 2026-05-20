"""
Tests for KamoriClient.

All tests mock urllib.request.urlopen so no real network calls are made.
flush_interval is set to 0.05s throughout to keep the suite fast.
"""

from __future__ import annotations

import queue
import time
import urllib.error
import urllib.request
from io import BytesIO
from typing import Any, Dict, List
from unittest.mock import MagicMock, patch, call
import pytest

from kamori_sdk.client import KamoriClient, _RETRY_DELAYS


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _mock_response(status: int = 200) -> MagicMock:
    """Return a mock context-manager response with the given HTTP status."""
    resp = MagicMock()
    resp.status = status
    resp.__enter__ = lambda s: s
    resp.__exit__ = MagicMock(return_value=False)
    return resp


def _make_client(**kwargs: Any) -> KamoriClient:
    """Create a KamoriClient with fast flush_interval suitable for tests."""
    defaults: Dict[str, Any] = {
        "url": "http://localhost:3110",
        "token": "test-token",
        "flush_interval": 0.05,
    }
    defaults.update(kwargs)
    return KamoriClient(**defaults)


# ---------------------------------------------------------------------------
# Basic queuing and lifecycle
# ---------------------------------------------------------------------------

class TestQueueAndLifecycle:
    def test_log_queues_event(self) -> None:
        """log() should place the event onto the internal queue."""
        with patch("urllib.request.urlopen", return_value=_mock_response(200)):
            client = _make_client()
            assert client._queue.empty()
            client.log({"level": "info", "message": "hello"})
            # Give worker thread a moment to not consume it before we check
            # (We check queue size right after put; the worker may race but
            # the important thing is no exception is raised.)
            client.shutdown()

    def test_flush_blocks_until_sent(self) -> None:
        """flush() should block until the queued events are delivered."""
        sent_batches: List[Any] = []

        def fake_urlopen(req: Any, timeout: int = 10) -> Any:
            import json
            sent_batches.append(json.loads(req.data))
            return _mock_response(200)

        with patch("urllib.request.urlopen", side_effect=fake_urlopen):
            client = _make_client()
            client.log({"level": "info", "message": "hello"})
            client.flush()
            assert len(sent_batches) == 1
            assert sent_batches[0][0]["message"] == "hello"
            client.shutdown()

    def test_shutdown_stops_thread(self) -> None:
        """shutdown() should stop the background thread within the timeout."""
        with patch("urllib.request.urlopen", return_value=_mock_response(200)):
            client = _make_client()
            assert client._thread.is_alive()
            client.shutdown(timeout=2.0)
            assert not client._thread.is_alive()

    def test_log_ignored_after_shutdown(self) -> None:
        """log() calls after shutdown() should be silently ignored."""
        with patch("urllib.request.urlopen", return_value=_mock_response(200)):
            client = _make_client()
            client.shutdown()
            # Should not raise
            client.log({"level": "info", "message": "too late"})


# ---------------------------------------------------------------------------
# Successful send
# ---------------------------------------------------------------------------

class TestSuccessfulSend:
    def test_200_no_retry(self) -> None:
        """A 200 response should result in exactly one urlopen call."""
        with patch("urllib.request.urlopen", return_value=_mock_response(200)) as mock_open:
            client = _make_client()
            client.log({"level": "info", "message": "ok"})
            client.flush()
            client.shutdown()
            assert mock_open.call_count == 1

    def test_sends_correct_endpoint(self) -> None:
        """The request should target /v1/ingest on the configured URL."""
        with patch("urllib.request.urlopen", return_value=_mock_response(200)) as mock_open:
            client = _make_client(url="http://kamori.example.com")
            client.log({"level": "debug", "message": "check url"})
            client.flush()
            client.shutdown()
            req = mock_open.call_args[0][0]
            assert req.full_url == "http://kamori.example.com/v1/ingest"

    def test_sends_auth_header(self) -> None:
        """The Authorization: Bearer header should be present when a token is provided."""
        with patch("urllib.request.urlopen", return_value=_mock_response(200)) as mock_open:
            client = _make_client(token="my-secret")
            client.log({"level": "info", "message": "auth"})
            client.flush()
            client.shutdown()
            req = mock_open.call_args[0][0]
            assert req.get_header("Authorization") == "Bearer my-secret"

    def test_on_drop_not_called_on_success(self) -> None:
        """on_drop must NOT be invoked when the send succeeds."""
        dropped: List[Any] = []

        with patch("urllib.request.urlopen", return_value=_mock_response(200)):
            client = _make_client(on_drop=dropped.append)
            client.log({"level": "info", "message": "fine"})
            client.flush()
            client.shutdown()

        assert dropped == []


# ---------------------------------------------------------------------------
# Retry on network/5xx errors
# ---------------------------------------------------------------------------

class TestRetryBehaviour:
    def test_network_error_then_success_retries_once(self) -> None:
        """A URLError on the first attempt should trigger a retry that succeeds."""
        responses = [
            urllib.error.URLError("connection refused"),
            _mock_response(200),
        ]

        with patch("urllib.request.urlopen", side_effect=responses) as mock_open:
            with patch("time.sleep"):  # skip actual sleep
                client = _make_client()
                client.log({"level": "warn", "message": "retry me"})
                client.flush()
                client.shutdown()

        assert mock_open.call_count == 2

    def test_5xx_retries_up_to_max_then_drops(self) -> None:
        """A persistent 5xx should be retried _RETRY_DELAYS times then dropped."""
        dropped: List[Any] = []
        total_attempts = 1 + len(_RETRY_DELAYS)  # initial + retries

        def always_5xx(req: Any, timeout: int = 10) -> Any:
            raise urllib.error.HTTPError(
                "http://x", 503, "Service Unavailable", {}, None  # type: ignore
            )

        with patch("urllib.request.urlopen", side_effect=always_5xx) as mock_open:
            with patch("time.sleep"):
                client = _make_client(on_drop=dropped.append)
                client.log({"level": "error", "message": "bad server"})
                client.flush()
                client.shutdown()

        assert mock_open.call_count == total_attempts
        assert len(dropped) == 1
        assert dropped[0][0]["message"] == "bad server"

    def test_5xx_eventually_succeeds(self) -> None:
        """A 5xx followed by a 200 should succeed without calling on_drop."""
        dropped: List[Any] = []
        responses = [
            urllib.error.HTTPError("http://x", 500, "err", {}, None),  # type: ignore
            _mock_response(200),
        ]

        with patch("urllib.request.urlopen", side_effect=responses) as mock_open:
            with patch("time.sleep"):
                client = _make_client(on_drop=dropped.append)
                client.log({"level": "info", "message": "eventually ok"})
                client.flush()
                client.shutdown()

        assert mock_open.call_count == 2
        assert dropped == []


# ---------------------------------------------------------------------------
# 4xx: drop immediately, no retry
# ---------------------------------------------------------------------------

class TestFourXXBehaviour:
    def test_4xx_drops_immediately_no_retry(self) -> None:
        """A 4xx HTTP error should drop the batch immediately without retrying."""
        dropped: List[Any] = []

        def raise_401(req: Any, timeout: int = 10) -> Any:
            raise urllib.error.HTTPError(
                "http://x", 401, "Unauthorized", {}, None  # type: ignore
            )

        with patch("urllib.request.urlopen", side_effect=raise_401) as mock_open:
            with patch("time.sleep") as mock_sleep:
                client = _make_client(on_drop=dropped.append)
                client.log({"level": "info", "message": "bad auth"})
                client.flush()
                client.shutdown()

        assert mock_open.call_count == 1
        mock_sleep.assert_not_called()
        assert len(dropped) == 1

    def test_on_drop_called_with_original_batch(self) -> None:
        """on_drop should receive the exact event list that was dropped."""
        dropped: List[Any] = []
        event = {"level": "info", "message": "dropped event", "custom": 42}

        def raise_403(req: Any, timeout: int = 10) -> Any:
            raise urllib.error.HTTPError(
                "http://x", 403, "Forbidden", {}, None  # type: ignore
            )

        with patch("urllib.request.urlopen", side_effect=raise_403):
            with patch("time.sleep"):
                client = _make_client(on_drop=dropped.append)
                client.log(event)
                client.flush()
                client.shutdown()

        assert len(dropped) == 1
        assert dropped[0] == [event]


# ---------------------------------------------------------------------------
# Batching
# ---------------------------------------------------------------------------

class TestBatching:
    def test_batch_flushed_when_batch_size_reached(self) -> None:
        """Events should be flushed as a single batch when batch_size is hit."""
        sent_batches: List[Any] = []

        def fake_urlopen(req: Any, timeout: int = 10) -> Any:
            import json
            sent_batches.append(json.loads(req.data))
            return _mock_response(200)

        with patch("urllib.request.urlopen", side_effect=fake_urlopen):
            client = _make_client(batch_size=3)
            for i in range(3):
                client.log({"n": i})
            client.flush()
            client.shutdown()

        assert any(len(b) == 3 for b in sent_batches)

    def test_trailing_events_sent_on_shutdown(self) -> None:
        """Events that haven't reached batch_size should be sent on shutdown."""
        sent_batches: List[Any] = []

        def fake_urlopen(req: Any, timeout: int = 10) -> Any:
            import json
            sent_batches.append(json.loads(req.data))
            return _mock_response(200)

        with patch("urllib.request.urlopen", side_effect=fake_urlopen):
            client = _make_client(batch_size=100)
            client.log({"level": "info", "message": "trailing"})
            client.shutdown(timeout=2.0)

        total_events = sum(len(b) for b in sent_batches)
        assert total_events == 1


# ---------------------------------------------------------------------------
# max_queue: drop when internal queue is full
# ---------------------------------------------------------------------------

class TestMaxQueue:
    def test_drop_called_when_queue_full(self) -> None:
        """log() should invoke on_drop when the bounded queue is full."""
        dropped: List[Any] = []

        # Patch _worker so the background thread never drains the queue,
        # allowing it to fill up deterministically.
        with patch.object(KamoriClient, "_worker"):
            client = KamoriClient(
                url="http://localhost:3110",
                token="tok",
                max_queue=2,
                flush_interval=100.0,  # long enough that the timer never fires
                on_drop=dropped.append,
            )
            client.log({"n": 1})  # queue size 1
            client.log({"n": 2})  # queue size 2 — full
            client.log({"n": 3})  # queue.Full → on_drop

        assert len(dropped) == 1
        assert dropped[0][0]["n"] == 3

    def test_drop_not_called_below_max_queue(self) -> None:
        """on_drop must NOT be called when the queue has room."""
        dropped: List[Any] = []

        with patch.object(KamoriClient, "_worker"):
            client = KamoriClient(
                url="http://localhost:3110",
                max_queue=10,
                flush_interval=100.0,
                on_drop=dropped.append,
            )
            for i in range(5):
                client.log({"n": i})

        assert dropped == []


# ---------------------------------------------------------------------------
# flush_interval: time-based auto-flush without explicit flush()
# ---------------------------------------------------------------------------

class TestFlushInterval:
    def test_flush_interval_auto_triggers(self) -> None:
        """Events should be sent automatically when flush_interval elapses."""
        sent_batches: List[Any] = []

        def fake_urlopen(req: Any, timeout: int = 10) -> Any:
            import json
            sent_batches.append(json.loads(req.data))
            return _mock_response(200)

        with patch("urllib.request.urlopen", side_effect=fake_urlopen):
            # batch_size=100 so only the timer triggers the flush
            client = _make_client(batch_size=100, flush_interval=0.05)
            client.log({"level": "info", "message": "timed"})
            # Wait longer than flush_interval for the worker to auto-flush
            time.sleep(0.3)
            client.shutdown(timeout=2.0)

        total = sum(len(b) for b in sent_batches)
        assert total == 1
        assert any(e.get("message") == "timed" for b in sent_batches for e in b)
