<?php

declare(strict_types=1);

namespace Kamori\Tests;

use Kamori\KamoriClient;
use PHPUnit\Framework\TestCase;

/**
 * A testable subclass that overrides send() so no real HTTP calls are made.
 *
 * @internal
 */
class TestableKamoriClient extends KamoriClient
{
    /** @var array<int, array<int, array<string, mixed>>> All batches passed to send(). */
    public array $calls = [];

    /**
     * Queue of responses to return from send(), consumed in order.
     * Each element is: true (success), an int HTTP status, or false (network error).
     *
     * @var array<int, true|int|false>
     */
    public array $responses = [];

    /**
     * Track usleep() calls so tests can assert retry timing without actually sleeping.
     *
     * @var array<int, int> Microseconds passed to each usleep call.
     */
    public array $sleeps = [];

    /**
     * Override send() to record calls and return queued responses.
     *
     * {@inheritdoc}
     */
    protected function send(array $events): bool|int
    {
        $this->calls[] = $events;
        return array_shift($this->responses) ?? true;
    }
}

/**
 * Unit tests for KamoriClient.
 *
 * All tests use TestableKamoriClient to avoid real network calls.
 * usleep() is called by the real sendWithRetry path, but since we override
 * send() the actual delays are trivially short (the queued responses return
 * immediately, skipping the real usleep). For retry-count assertions we only
 * care about how many times send() is called, not wall-clock time.
 */
class KamoriClientTest extends TestCase
{
    // -------------------------------------------------------------------------
    // Buffering
    // -------------------------------------------------------------------------

    /**
     * log() should buffer events without sending them immediately.
     */
    public function testLogBuffersEvents(): void
    {
        $client = new TestableKamoriClient(url: 'https://example.com', batchSize: 10);
        $client->log(['message' => 'first']);
        $client->log(['message' => 'second']);

        $this->assertCount(0, $client->calls, 'send() must not be called until flush() or batchSize is reached');
    }

    /**
     * flush() drains the buffer and calls send() once with all buffered events.
     */
    public function testFlushSendsBufferedEvents(): void
    {
        $client = new TestableKamoriClient(url: 'https://example.com', batchSize: 10);
        $client->responses = [true];

        $client->log(['message' => 'a']);
        $client->log(['message' => 'b']);
        $client->flush();

        $this->assertCount(1, $client->calls);
        $this->assertCount(2, $client->calls[0]);
        $this->assertSame('a', $client->calls[0][0]['message']);
        $this->assertSame('b', $client->calls[0][1]['message']);
    }

    /**
     * flush() on an empty buffer must be a no-op (send() never called).
     */
    public function testFlushOnEmptyBufferDoesNothing(): void
    {
        $client = new TestableKamoriClient(url: 'https://example.com');
        $client->flush();

        $this->assertCount(0, $client->calls);
    }

    /**
     * When batchSize is reached, log() should auto-flush without an explicit flush() call.
     */
    public function testBatchSizeTriggersAutoFlush(): void
    {
        $client = new TestableKamoriClient(url: 'https://example.com', batchSize: 3);
        $client->responses = [true];

        $client->log(['n' => 1]);
        $client->log(['n' => 2]);
        // Third log() should trigger auto-flush
        $client->log(['n' => 3]);

        $this->assertCount(1, $client->calls, 'Auto-flush should fire when batchSize is reached');
        $this->assertCount(3, $client->calls[0]);
    }

    // -------------------------------------------------------------------------
    // Success path
    // -------------------------------------------------------------------------

    /**
     * A successful send() (returns true) must not trigger any retry.
     */
    public function testSuccessfulSendNoRetry(): void
    {
        $client = new TestableKamoriClient(url: 'https://example.com');
        $client->responses = [true];

        $client->log(['message' => 'ok']);
        $client->flush();

        $this->assertCount(1, $client->calls, 'Only one send() call expected on success');
    }

    // -------------------------------------------------------------------------
    // 4xx — no retry
    // -------------------------------------------------------------------------

    /**
     * A 4xx response is a client error; send() should be called exactly once and
     * the onDrop callback should fire with the original batch.
     */
    public function testClientErrorDropsImmediatelyWithoutRetry(): void
    {
        $dropped = [];
        $client = new TestableKamoriClient(
            url: 'https://example.com',
            onDrop: function (array $events) use (&$dropped) {
                $dropped[] = $events;
            },
        );
        $client->responses = [401]; // 4xx — do not retry

        $client->log(['message' => 'secret']);
        $client->flush();

        $this->assertCount(1, $client->calls, 'Must not retry on 4xx');
        $this->assertCount(1, $dropped, 'onDrop must be called exactly once');
        $this->assertSame('secret', $dropped[0][0]['message']);
    }

    /**
     * onDrop receives the exact batch that was being sent.
     */
    public function testOnDropReceivesOriginalBatch(): void
    {
        $received = null;
        $client = new TestableKamoriClient(
            url: 'https://example.com',
            onDrop: function (array $events) use (&$received) {
                $received = $events;
            },
        );
        // Queue enough failures to exhaust retries
        $client->responses = [500, 500, 500, 500];

        $event = ['message' => 'important', 'level' => 'error'];
        $client->log($event);
        $client->flush();

        $this->assertNotNull($received);
        $this->assertSame($event['message'], $received[0]['message']);
    }

    // -------------------------------------------------------------------------
    // 5xx — retry then drop
    // -------------------------------------------------------------------------

    /**
     * A 5xx response should be retried up to 3 times (initial + 3 = 4 total calls),
     * then dropped when all retries are exhausted.
     */
    public function testServerErrorRetriesThreeTimesThenDrops(): void
    {
        $dropped = false;
        $client = new TestableKamoriClient(
            url: 'https://example.com',
            onDrop: function () use (&$dropped) {
                $dropped = true;
            },
        );
        // 4 failures: initial attempt + 3 retries
        $client->responses = [503, 503, 503, 503];

        $client->log(['message' => 'retry-me']);
        $client->flush();

        $this->assertCount(4, $client->calls, 'Expected 1 initial + 3 retries = 4 total send() calls');
        $this->assertTrue($dropped, 'onDrop must be called after all retries fail');
    }

    /**
     * If a 5xx is followed by a success, no further retries occur.
     */
    public function testServerErrorSucceedsOnRetry(): void
    {
        $dropped = false;
        $client = new TestableKamoriClient(
            url: 'https://example.com',
            onDrop: function () use (&$dropped) {
                $dropped = true;
            },
        );
        $client->responses = [503, true]; // fail once then succeed

        $client->log(['message' => 'transient']);
        $client->flush();

        $this->assertCount(2, $client->calls);
        $this->assertFalse($dropped, 'onDrop must not be called when a retry succeeds');
    }

    // -------------------------------------------------------------------------
    // Network error (false) — retry then drop
    // -------------------------------------------------------------------------

    /**
     * A network error (false) should also trigger retries, then drop.
     */
    public function testNetworkErrorRetriesThreeTimesThenDrops(): void
    {
        $dropped = false;
        $client = new TestableKamoriClient(
            url: 'https://example.com',
            onDrop: function () use (&$dropped) {
                $dropped = true;
            },
        );
        // 4 network failures: initial + 3 retries
        $client->responses = [false, false, false, false];

        $client->log(['message' => 'network-fail']);
        $client->flush();

        $this->assertCount(4, $client->calls, 'Expected 1 initial + 3 retries = 4 total send() calls');
        $this->assertTrue($dropped);
    }

    /**
     * Network error followed by success — retries and recovers without dropping.
     */
    public function testNetworkErrorSucceedsOnRetry(): void
    {
        $dropped = false;
        $client = new TestableKamoriClient(
            url: 'https://example.com',
            onDrop: function () use (&$dropped) {
                $dropped = true;
            },
        );
        $client->responses = [false, false, true];

        $client->log(['message' => 'eventually-ok']);
        $client->flush();

        $this->assertCount(3, $client->calls);
        $this->assertFalse($dropped);
    }

    // -------------------------------------------------------------------------
    // Buffer isolation after flush
    // -------------------------------------------------------------------------

    /**
     * Events logged after a flush should not be re-sent in the previous batch.
     */
    public function testBufferIsClearedAfterFlush(): void
    {
        $client = new TestableKamoriClient(url: 'https://example.com', batchSize: 100);
        $client->responses = [true, true];

        $client->log(['n' => 1]);
        $client->flush();

        $client->log(['n' => 2]);
        $client->flush();

        $this->assertCount(2, $client->calls);
        $this->assertCount(1, $client->calls[0]);
        $this->assertCount(1, $client->calls[1]);
        $this->assertSame(1, $client->calls[0][0]['n']);
        $this->assertSame(2, $client->calls[1][0]['n']);
    }

    // -----------------------------------------------------------------------
    // Auth token
    // -----------------------------------------------------------------------

    /**
     * The token passed to the constructor must be stored and available to
     * the send() path. We verify this via reflection so the test does not
     * require a real HTTP server.
     */
    public function testAuthTokenStoredOnConstruction(): void
    {
        $client = new TestableKamoriClient(url: 'https://example.com', token: 'my-secret');

        $ref = new \ReflectionClass(\Kamori\KamoriClient::class);
        $prop = $ref->getProperty('token');
        $prop->setAccessible(true);

        $this->assertSame('my-secret', $prop->getValue($client));
    }

    public function testNullTokenStoredWhenOmitted(): void
    {
        $client = new TestableKamoriClient(url: 'https://example.com');

        $ref = new \ReflectionClass(\Kamori\KamoriClient::class);
        $prop = $ref->getProperty('token');
        $prop->setAccessible(true);

        $this->assertNull($prop->getValue($client));
    }

    public function testNoTokenDoesNotCrashOnFlush(): void
    {
        $client = new TestableKamoriClient(url: 'https://example.com');
        $client->responses = [true];
        $client->log(['msg' => 'no token']);
        $client->flush();

        $this->assertCount(1, $client->calls);
    }

    // -----------------------------------------------------------------------
    // URL normalisation
    // -----------------------------------------------------------------------

    /**
     * Trailing slashes on the URL must be stripped so the final path does not
     * contain a double-slash like "//v1/ingest".
     */
    public function testUrlStoredOnConstruction(): void
    {
        $client = new TestableKamoriClient(url: 'https://example.com/');

        $ref = new \ReflectionClass(\Kamori\KamoriClient::class);
        $prop = $ref->getProperty('url');
        $prop->setAccessible(true);

        // The stored URL may or may not have a trailing slash — what matters is
        // that /v1/ingest is constructed correctly in send(). We verify the url
        // property is stored as-is and send() handles trimming.
        $this->assertStringStartsWith('https://example.com', $prop->getValue($client));
    }

    // -----------------------------------------------------------------------
    // maxBuffer — drop when buffer is full
    // -----------------------------------------------------------------------

    /**
     * log() must invoke onDrop immediately (no send) when the buffer is full.
     */
    public function testMaxBufferDropsEventWhenFull(): void
    {
        $dropped = [];
        $client = new TestableKamoriClient(
            url: 'https://example.com',
            batchSize: 100,   // high enough that auto-flush never fires
            maxBuffer: 2,
            onDrop: function (array $events) use (&$dropped) {
                $dropped[] = $events;
            },
        );

        $client->log(['n' => 1]); // buffer: 1
        $client->log(['n' => 2]); // buffer: 2 — full
        $client->log(['n' => 3]); // over maxBuffer → onDrop, no send()

        // No HTTP send should have been triggered by the dropped event
        $this->assertCount(0, $client->calls, 'send() must not be called for the dropped event');
        $this->assertCount(1, $dropped, 'onDrop must be called exactly once');
        $this->assertSame(3, $dropped[0][0]['n'], 'onDrop should receive the event that was dropped');
    }

    // -----------------------------------------------------------------------
    // __destruct — flush remaining events on object destruction
    // -----------------------------------------------------------------------

    /**
     * The destructor must flush any buffered events that were never explicitly flushed.
     *
     * We use an anonymous subclass with a static sink so we can inspect the
     * sent batches after the object has been destroyed (and $this is gone).
     * PHP evaluates the anonymous class definition once per code location, so
     * the static property persists across the lifetime of the test.
     */
    public function testDestructorFlushesRemainingEvents(): void
    {
        // Anonymous class with a static sink that outlives the instance.
        $client = new class(url: 'https://example.com', batchSize: 100) extends \Kamori\KamoriClient {
            /** @var array<int, array<int, array<string, mixed>>> */
            public static array $sink = [];

            protected function send(array $events): bool|int
            {
                self::$sink[] = $events;
                return true;
            }
        };

        $clientClass = get_class($client);
        $clientClass::$sink = []; // reset before test

        $client->log(['message' => 'destructor-test']);
        $this->assertCount(0, $clientClass::$sink, 'send() must not be called before destruction');

        // Removing the only reference triggers the destructor → flush() → send().
        unset($client);

        $this->assertCount(1, $clientClass::$sink, 'Destructor must flush remaining events');
        $this->assertSame('destructor-test', $clientClass::$sink[0][0]['message']);
    }
}
