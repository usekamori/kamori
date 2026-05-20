<?php

declare(strict_types=1);

namespace Kamori;

/**
 * Kamori HTTP client for PHP.
 *
 * Buffers log events and flushes them to a Kamori ingest server using
 * PHP's built-in stream functions (no curl dependency required).
 *
 * Events are batched and sent on flush() or when the buffer reaches
 * $batchSize. Call flush() at the end of each request in a web context,
 * or register a shutdown function for CLI scripts.
 *
 * Usage:
 *   $client = new KamoriClient('https://your-kamori-server.com', token: 'secret');
 *   $client->log(['level' => 'info', 'message' => 'Hello from PHP']);
 *   $client->flush();
 */
class KamoriClient
{
    /** @var array<int, array<string, mixed>> In-memory event buffer */
    private array $buffer = [];

    /** @var callable|null Optional callback invoked when a batch is dropped */
    private $onDrop;

    /** Retry delay schedule in seconds: 0.25s → 1s → 4s */
    private const RETRY_DELAYS = [0.25, 1.0, 4.0];

    /**
     * @param string        $url        Base URL of your Kamori ingest server.
     * @param string|null   $token      Auth token sent as Authorization: Bearer header.
     * @param int           $batchSize  Flush automatically when buffer reaches this size.
     * @param int           $maxBuffer  Maximum events to hold in the buffer. log() drops
     *                                  new events (calling onDrop) once this limit is
     *                                  reached so memory is bounded. Default: 5 * batchSize.
     * @param callable|null $onDrop     Invoked with the dropped event array when all retries
     *                                  fail or when the buffer is full.
     */
    public function __construct(
        private readonly string $url,
        private readonly ?string $token = null,
        private readonly int $batchSize = 50,
        private readonly int $maxBuffer = 250,
        ?callable $onDrop = null,
    ) {
        $this->onDrop = $onDrop;
    }

    /**
     * Flush any remaining buffered events when the object is destroyed.
     *
     * This ensures events logged in a web request are delivered even when
     * flush() is not called explicitly at the end of the request.
     */
    public function __destruct()
    {
        $this->flush();
    }

    /**
     * Queue a log event. Flushes automatically when the buffer is full.
     *
     * @param array<string, mixed> $event Arbitrary JSON-serialisable array.
     */
    public function log(array $event): void
    {
        // Drop new events once the buffer cap is reached to keep memory bounded.
        if (count($this->buffer) >= $this->maxBuffer) {
            $this->drop([$event]);
            return;
        }

        $this->buffer[] = $event;

        if (count($this->buffer) >= $this->batchSize) {
            $this->flush();
        }
    }

    /**
     * Flush all buffered events to the ingest server immediately.
     * Fire-and-forget on success; retries on failure.
     */
    public function flush(): void
    {
        if (empty($this->buffer)) {
            return;
        }

        // Drain the buffer atomically before sending so subsequent log()
        // calls during the send accumulate in a new batch
        $events = $this->buffer;
        $this->buffer = [];

        $this->sendWithRetry($events);
    }

    /**
     * Send $events to the ingest endpoint, retrying on transient failures.
     *
     * Uses an iterative loop rather than recursion to avoid stack growth
     * during multiple retries.
     *
     * @param array<int, array<string, mixed>> $events Batch to send.
     */
    private function sendWithRetry(array $events): void
    {
        $attempt = 0;

        while (true) {
            $result = $this->send($events);

            if ($result === true) {
                return; // success
            }

            // $result is an HTTP status code on HTTP error, false on network/parse error
            if (is_int($result) && $result >= 400 && $result < 500) {
                // 4xx — client error, do not retry
                $this->drop($events);
                return;
            }

            // 5xx or network error — retry if attempts remain
            if ($attempt < count(self::RETRY_DELAYS)) {
                // PHP has no async; sleep blocks the current process/thread
                usleep((int)(self::RETRY_DELAYS[$attempt] * 1_000_000));
                $attempt++;
            } else {
                $this->drop($events);
                return;
            }
        }
    }

    /**
     * Perform a single HTTP POST to /v1/ingest.
     *
     * Uses PHP stream context with fopen + stream_get_meta_data so that
     * response headers are read from a well-defined local variable rather
     * than the $http_response_header magic global, which is only set by
     * file_get_contents and is unreliable in nested or static call contexts.
     *
     * @param  array<int, array<string, mixed>> $events Events to send.
     * @return true|int|false  true on success, HTTP status int on HTTP error,
     *                         false on network/serialisation failure.
     */
    protected function send(array $events): bool|int
    {
        try {
            $body = json_encode($events, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            // Attempt to strip non-serialisable values and retry once
            $body = json_encode($this->sanitiseEvents($events), JSON_THROW_ON_ERROR | JSON_PARTIAL_OUTPUT_ON_ERROR);
            if ($body === false) {
                return false;
            }
        }

        $headers = [
            'Content-Type: application/json',
            'Content-Length: ' . strlen($body),
        ];
        if ($this->token !== null) {
            $headers[] = 'Authorization: Bearer ' . $this->token;
        }

        $context = stream_context_create([
            'http' => [
                'method'        => 'POST',
                'header'        => implode("\r\n", $headers),
                'content'       => $body,
                'timeout'       => 10,
                // Don't throw on non-2xx — we need to read the status code
                'ignore_errors' => true,
            ],
        ]);

        $url = rtrim($this->url, '/') . '/v1/ingest';

        try {
            // Use fopen + stream_get_meta_data so response headers are read
            // from the stream wrapper metadata rather than the $http_response_header
            // magic global (which is unreliable in static/nested call contexts).
            $stream = @fopen($url, 'r', false, $context);

            if ($stream === false) {
                return false; // network error
            }

            $meta = stream_get_meta_data($stream);
            fclose($stream);

            // Response headers are in $meta['wrapper_data'] as an array of strings
            $responseHeaders = $meta['wrapper_data'] ?? [];
            $statusLine = is_array($responseHeaders) ? ($responseHeaders[0] ?? '') : '';

            if (preg_match('/HTTP\/\S+\s+(\d{3})/', (string)$statusLine, $m)) {
                $status = (int)$m[1];
                return $status < 400 ? true : $status;
            }

            return false;
        } catch (\Throwable) {
            return false;
        }
    }

    /**
     * Replace non-JSON-serialisable values with a string placeholder.
     *
     * @param  array<int, array<string, mixed>> $events
     * @return array<int, array<string, mixed>>
     */
    private function sanitiseEvents(array $events): array
    {
        return array_map(
            static function (array $event): array {
                return array_map(static function (mixed $value): mixed {
                    if (is_object($value) || is_resource($value)) {
                        return '[unserializable: ' . get_debug_type($value) . ']';
                    }
                    return $value;
                }, $event);
            },
            $events
        );
    }

    /**
     * Invoke the onDrop callback with the dropped event batch.
     *
     * @param array<int, array<string, mixed>> $events
     */
    private function drop(array $events): void
    {
        if ($this->onDrop !== null) {
            try {
                ($this->onDrop)($events);
            } catch (\Throwable) {
                // Callbacks must never crash the client
            }
        }
    }
}
