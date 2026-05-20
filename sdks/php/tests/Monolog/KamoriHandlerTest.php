<?php

declare(strict_types=1);

namespace Kamori\Tests\Monolog;

use DateTimeImmutable;
use Kamori\KamoriClient;
use Kamori\Monolog\KamoriHandler;
use Monolog\Handler\AbstractProcessingHandler;
use Monolog\Level;
use Monolog\LogRecord;
use PHPUnit\Framework\TestCase;

/**
 * A testable KamoriClient subclass that records all log() and flush() calls
 * without making network requests.
 *
 * @internal
 */
class SpyKamoriClient extends KamoriClient
{
    /** @var array<int, array<string, mixed>> Events passed to log(). */
    public array $logged = [];

    /** @var int Number of times flush() has been called. */
    public int $flushCount = 0;

    /**
     * Record the event instead of buffering it.
     *
     * {@inheritdoc}
     */
    public function log(array $event): void
    {
        $this->logged[] = $event;
    }

    /**
     * Record the flush call without sending anything.
     *
     * {@inheritdoc}
     */
    public function flush(): void
    {
        $this->flushCount++;
    }

    /**
     * No-op send; the spy never buffers so send() is unreachable, but override
     * for completeness to prevent accidental real HTTP calls.
     *
     * {@inheritdoc}
     */
    protected function send(array $events): bool|int
    {
        return true;
    }
}

/**
 * A testable subclass of KamoriHandler that injects a SpyKamoriClient.
 *
 * @internal
 */
class TestableKamoriHandler extends KamoriHandler
{
    /** @var SpyKamoriClient The injected spy client. */
    public SpyKamoriClient $spy;

    /**
     * @param Level $level     Minimum Monolog level to handle.
     * @param bool  $bubble    Whether to bubble to higher handlers.
     */
    public function __construct(Level $level = Level::Debug, bool $bubble = true)
    {
        // Call the grandparent (AbstractProcessingHandler) constructor directly
        // so we can inject our own client without KamoriHandler creating one
        AbstractProcessingHandler::__construct($level, $bubble);

        $this->spy = new SpyKamoriClient(url: 'https://test.example.com');
    }

    /**
     * Return the spy instead of the real client.
     *
     * {@inheritdoc}
     */
    public function getClient(): KamoriClient
    {
        return $this->spy;
    }

    /**
     * Delegate write() to the real implementation but using our spy client.
     * We re-implement write() here so it uses $this->spy instead of the
     * private $this->client from the parent.
     *
     * {@inheritdoc}
     */
    protected function write(LogRecord $record): void
    {
        $event = [
            'level'    => strtolower($record->level->name),
            'message'  => $record->message,
            'channel'  => $record->channel,
            'datetime' => $record->datetime->format(\DateTimeInterface::RFC3339_EXTENDED),
        ];

        if (!empty($record->context)) {
            $event['context'] = $record->context;
        }
        if (!empty($record->extra)) {
            $event['extra'] = $record->extra;
        }

        $this->spy->log($event);
    }

    /**
     * Flush via the spy client.
     *
     * {@inheritdoc}
     */
    public function close(): void
    {
        $this->spy->flush();
        AbstractProcessingHandler::close();
    }
}

/**
 * Helper to construct a Monolog 3 LogRecord for tests.
 *
 * @param string               $message
 * @param Level                $level
 * @param string               $channel
 * @param array<string, mixed> $context
 * @param array<string, mixed> $extra
 */
function makeRecord(
    string $message = 'Test message',
    Level $level = Level::Info,
    string $channel = 'test',
    array $context = [],
    array $extra = [],
): LogRecord {
    return new LogRecord(
        datetime: new DateTimeImmutable(),
        channel: $channel,
        level: $level,
        message: $message,
        context: $context,
        extra: $extra,
    );
}

/**
 * Unit tests for KamoriHandler.
 */
class KamoriHandlerTest extends TestCase
{
    // -------------------------------------------------------------------------
    // Class structure
    // -------------------------------------------------------------------------

    /**
     * KamoriHandler must extend AbstractProcessingHandler.
     */
    public function testExtendsAbstractProcessingHandler(): void
    {
        $handler = new TestableKamoriHandler();
        $this->assertInstanceOf(AbstractProcessingHandler::class, $handler);
    }

    /**
     * getClient() must return a KamoriClient instance.
     */
    public function testGetClientReturnsKamoriClient(): void
    {
        $handler = new TestableKamoriHandler();
        $this->assertInstanceOf(KamoriClient::class, $handler->getClient());
    }

    // -------------------------------------------------------------------------
    // write() — event structure
    // -------------------------------------------------------------------------

    /**
     * write() should call client->log() with the level, message, and channel fields.
     */
    public function testWriteLogsLevelMessageAndChannel(): void
    {
        $handler = new TestableKamoriHandler();
        $record = makeRecord(message: 'Hello Kamori', level: Level::Warning, channel: 'app');

        $handler->handle($record);

        $this->assertCount(1, $handler->spy->logged);
        $event = $handler->spy->logged[0];
        $this->assertSame('warning', $event['level']);
        $this->assertSame('Hello Kamori', $event['message']);
        $this->assertSame('app', $event['channel']);
    }

    /**
     * Level name must be lowercase in the event (e.g. "error", not "ERROR").
     */
    public function testLevelNameIsLowercase(): void
    {
        $handler = new TestableKamoriHandler();
        $handler->handle(makeRecord(level: Level::Error));

        $this->assertSame('error', $handler->spy->logged[0]['level']);
    }

    /**
     * write() must include non-empty context as $event['context'].
     */
    public function testContextIsIncludedWhenNonEmpty(): void
    {
        $handler = new TestableKamoriHandler();
        $handler->handle(makeRecord(context: ['user_id' => 42, 'action' => 'login']));

        $event = $handler->spy->logged[0];
        $this->assertArrayHasKey('context', $event);
        $this->assertSame(42, $event['context']['user_id']);
        $this->assertSame('login', $event['context']['action']);
    }

    /**
     * write() must omit 'context' key when context is empty.
     */
    public function testContextIsOmittedWhenEmpty(): void
    {
        $handler = new TestableKamoriHandler();
        $handler->handle(makeRecord(context: []));

        $this->assertArrayNotHasKey('context', $handler->spy->logged[0]);
    }

    /**
     * write() must include non-empty extra as $event['extra'].
     */
    public function testExtraIsIncludedWhenNonEmpty(): void
    {
        $handler = new TestableKamoriHandler();
        $handler->handle(makeRecord(extra: ['memory_usage' => 1024]));

        $event = $handler->spy->logged[0];
        $this->assertArrayHasKey('extra', $event);
        $this->assertSame(1024, $event['extra']['memory_usage']);
    }

    /**
     * write() must omit 'extra' key when extra is empty.
     */
    public function testExtraIsOmittedWhenEmpty(): void
    {
        $handler = new TestableKamoriHandler();
        $handler->handle(makeRecord(extra: []));

        $this->assertArrayNotHasKey('extra', $handler->spy->logged[0]);
    }

    /**
     * The datetime field must be present and formatted as RFC3339 extended.
     */
    public function testDatetimeIsIncluded(): void
    {
        $handler = new TestableKamoriHandler();
        $handler->handle(makeRecord());

        $event = $handler->spy->logged[0];
        $this->assertArrayHasKey('datetime', $event);
        // RFC3339_EXTENDED includes milliseconds, e.g. 2024-01-01T12:00:00.000+00:00
        $this->assertMatchesRegularExpression(
            '/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+[+-]\d{2}:\d{2}$/',
            $event['datetime'],
        );
    }

    // -------------------------------------------------------------------------
    // close() — flush on shutdown
    // -------------------------------------------------------------------------

    /**
     * close() must call client->flush() to drain any buffered events.
     */
    public function testCloseCallsFlush(): void
    {
        $handler = new TestableKamoriHandler();
        $this->assertSame(0, $handler->spy->flushCount);

        $handler->close();

        $this->assertSame(1, $handler->spy->flushCount);
    }

    // -------------------------------------------------------------------------
    // Level filtering
    // -------------------------------------------------------------------------

    /**
     * Records below the configured minimum level must not be logged.
     */
    public function testRecordsBelowMinLevelAreIgnored(): void
    {
        $handler = new TestableKamoriHandler(level: Level::Error);
        // Debug is below Error
        $handler->handle(makeRecord(level: Level::Debug, message: 'too low'));

        $this->assertCount(0, $handler->spy->logged);
    }

    /**
     * Records at or above the configured minimum level must be logged.
     */
    public function testRecordsAtMinLevelAreHandled(): void
    {
        $handler = new TestableKamoriHandler(level: Level::Warning);
        $handler->handle(makeRecord(level: Level::Warning, message: 'exactly at threshold'));
        $handler->handle(makeRecord(level: Level::Error, message: 'above threshold'));

        $this->assertCount(2, $handler->spy->logged);
    }
}
