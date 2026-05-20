"""
Kamori HTTP client for Python.

Buffers log events and flushes them to a Kamori ingest server in the
background on a daemon thread so it never blocks the calling code.

Usage::

    from kamori_sdk import KamoriClient

    client = KamoriClient(url="https://your-kamori-server.com", token="secret")
    client.log({"level": "info", "message": "hello from Python"})
    client.flush()    # optional: flush immediately
    client.shutdown() # flush + stop background thread (call at exit)
"""

from __future__ import annotations

import json
import queue
import time
import threading
import urllib.request
import urllib.error
from typing import Any, Callable, Dict, List, Optional


# Retry delays in seconds between successive attempts: 0.25s -> 1s -> 4s
_RETRY_DELAYS = [0.25, 1.0, 4.0]

# Default maximum number of events to hold in the in-memory queue.
# log() silently drops new events once this limit is reached so the caller
# is never blocked and the process cannot run out of memory.
_DEFAULT_MAX_QUEUE = 10_000


class _FlushSentinel:
    """
    Sentinel placed on the queue to request a synchronous flush.

    Using a dedicated class (rather than a magic tuple) means there is zero
    chance of accidentally matching a legitimate user event, regardless of
    its shape.
    """

    __slots__ = ("done",)

    def __init__(self) -> None:
        self.done = threading.Event()


class KamoriClient:
    """
    Buffered, thread-safe Kamori log client.

    Events are queued in memory and flushed by a background daemon thread
    either when the buffer reaches ``batch_size`` or the ``flush_interval``
    elapses -- whichever comes first.

    The client never raises -- all network and serialisation errors are
    silently dropped (or routed to the ``on_drop`` callback).
    """

    def __init__(
        self,
        url: str,
        token: Optional[str] = None,
        batch_size: int = 50,
        flush_interval: float = 2.0,
        max_queue: int = _DEFAULT_MAX_QUEUE,
        on_drop: Optional[Callable[[List[Dict[str, Any]]], None]] = None,
    ) -> None:
        """
        Initialise the client and start the background flush thread.

        :param url:            Base URL of your Kamori ingest server.
        :param token:          Optional auth token (sent as ``Authorization: Bearer`` header).
        :param batch_size:     Flush when the buffer reaches this many events.
        :param flush_interval: Max seconds to wait before flushing.
        :param max_queue:      Maximum events to hold in the in-memory queue.
                               log() drops new events once this limit is reached
                               so the caller is never blocked.
        :param on_drop:        Optional callback invoked with the dropped event
                               batch when all retry attempts are exhausted.
        """
        self._url = url.rstrip("/")
        self._token = token
        self._batch_size = batch_size
        self._flush_interval = flush_interval
        self._on_drop = on_drop

        # Bounded queue — prevents unbounded memory growth under backpressure.
        # maxsize=0 would be unlimited; use the caller-supplied cap instead.
        self._queue: queue.Queue[Any] = queue.Queue(maxsize=max_queue)
        self._stop_event = threading.Event()

        # Background daemon thread -- dies automatically when the main thread exits
        self._thread = threading.Thread(target=self._worker, daemon=True)
        self._thread.start()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def log(self, event: Dict[str, Any]) -> None:
        """
        Queue a log event for background delivery.

        Silently drops the event if the queue is full (max_queue reached) or
        if the client has been shut down.

        :param event: Arbitrary JSON-serialisable dict.
        """
        if not self._stop_event.is_set():
            try:
                self._queue.put_nowait(event)
            except queue.Full:
                self._drop([event])

    def flush(self) -> None:
        """
        Block until all currently queued events have been sent (or dropped).

        Safe to call from any thread. Returns immediately if the queue is empty.
        """
        sentinel = _FlushSentinel()
        self._queue.put(sentinel)
        sentinel.done.wait()

    def shutdown(self, timeout: float = 5.0) -> bool:
        """
        Flush remaining events and stop the background thread.

        Call this at application exit (e.g. ``atexit.register(client.shutdown)``).

        :param timeout: Max seconds to wait for the worker to finish.
        :returns:       True if the worker finished cleanly within *timeout*,
                        False if the timeout elapsed (some events may be lost).
        """
        self._stop_event.set()
        self._queue.put(None)  # sentinel to unblock worker
        self._thread.join(timeout=timeout)
        return not self._thread.is_alive()

    # ------------------------------------------------------------------
    # Background worker
    # ------------------------------------------------------------------

    def _worker(self) -> None:
        """
        Background thread: drains the queue in batches.

        Collects events until ``batch_size`` is reached or ``flush_interval``
        seconds pass, then sends the batch.  Handles _FlushSentinel and the
        None stop-sentinel.
        """
        buffer: List[Dict[str, Any]] = []

        while not self._stop_event.is_set() or not self._queue.empty():
            try:
                # Block up to flush_interval waiting for the next item
                item = self._queue.get(timeout=self._flush_interval)
            except queue.Empty:
                # Interval elapsed -- flush whatever is buffered
                if buffer:
                    self._send_with_retry(buffer[:])
                    buffer.clear()
                continue

            # Stop sentinel
            if item is None:
                break

            # Flush sentinel: flush buffer then signal the caller
            if isinstance(item, _FlushSentinel):
                if buffer:
                    self._send_with_retry(buffer[:])
                    buffer.clear()
                item.done.set()
                continue

            # Normal event
            buffer.append(item)
            if len(buffer) >= self._batch_size:
                self._send_with_retry(buffer[:])
                buffer.clear()

        # Drain any remaining events before exiting
        if buffer:
            self._send_with_retry(buffer[:])

    # ------------------------------------------------------------------
    # Send / retry
    # ------------------------------------------------------------------

    def _send_with_retry(self, events: List[Dict[str, Any]], attempt: int = 0) -> None:
        """
        Send ``events`` to the ingest endpoint, retrying on failure.

        Retries up to ``len(_RETRY_DELAYS)`` times with exponential backoff.
        4xx responses are dropped immediately (retrying won't help).
        After all retries are exhausted the ``on_drop`` callback is invoked.

        :param events:  Batch of events to send.
        :param attempt: Current attempt index (0-based).
        """
        try:
            body = json.dumps(events).encode("utf-8")
            headers: Dict[str, str] = {"Content-Type": "application/json"}
            if self._token:
                headers["Authorization"] = f"Bearer {self._token}"

            req = urllib.request.Request(
                f"{self._url}/v1/ingest",
                data=body,
                headers=headers,
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=10) as resp:
                if resp.status < 400:
                    return  # success

                # 4xx -- client error, don't retry
                if 400 <= resp.status < 500:
                    self._drop(events)
                    return

                # 5xx -- server error, fall through to retry logic
                raise urllib.error.HTTPError(
                    req.full_url, resp.status, "server error", {}, None  # type: ignore
                )

        except urllib.error.HTTPError as exc:
            # 4xx: drop immediately
            if exc.code is not None and 400 <= exc.code < 500:
                self._drop(events)
                return
            # 5xx or other: retry
            self._retry(events, attempt)

        except Exception:
            # Network error, timeout, etc. -- retry
            self._retry(events, attempt)

    def _retry(self, events: List[Dict[str, Any]], attempt: int) -> None:
        """
        Schedule a retry or drop the batch if retries are exhausted.

        :param events:  Batch of events to retry.
        :param attempt: Current attempt index (0-based).
        """
        if attempt < len(_RETRY_DELAYS):
            time.sleep(_RETRY_DELAYS[attempt])
            self._send_with_retry(events, attempt + 1)
        else:
            self._drop(events)

    def _drop(self, events: List[Dict[str, Any]]) -> None:
        """
        Invoke the on_drop callback if registered.

        :param events: Batch of events that could not be delivered.
        """
        if self._on_drop:
            try:
                self._on_drop(events)
            except Exception:
                pass  # callbacks must never crash the worker
