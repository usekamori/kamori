<?php

declare(strict_types=1);

namespace Kamori\Monolog;

use Kamori\KamoriClient;
use Monolog\Handler\AbstractProcessingHandler;
use Monolog\Level;
use Monolog\LogRecord;

/**
 * Monolog 3 handler that ships log records to a Kamori ingest server.
 *
 * Usage:
 *   use Kamori\Monolog\KamoriHandler;
 *   use Monolog\Logger;
 *
 *   $logger = new Logger('app');
 *   $logger->pushHandler(new KamoriHandler(url: 'https://your-server.com', token: 'secret'));
 *   $logger->info('Hello from Monolog');
 *
 * Closing the handler (or letting it go out of scope) flushes any buffered
 * events to the Kamori server. In long-running processes, call close() or
 * reset the logger at application shutdown to guarantee delivery.
 */
class KamoriHandler extends AbstractProcessingHandler
{
    /** @var KamoriClient The underlying buffered HTTP client. */
    private KamoriClient $client;

    /**
     * @param string      $url       Base URL of the Kamori ingest server.
     * @param string|null $token     Optional auth token.
     * @param int         $batchSize Events per flush (passed to KamoriClient).
     * @param Level       $level     Minimum Monolog level to handle.
     * @param bool        $bubble    Whether to bubble to higher handlers.
     */
    public function __construct(
        string $url,
        ?string $token = null,
        int $batchSize = 50,
        Level $level = Level::Debug,
        bool $bubble = true,
    ) {
        parent::__construct($level, $bubble);
        $this->client = new KamoriClient(url: $url, token: $token, batchSize: $batchSize);
    }

    /**
     * Write a formatted log record to Kamori.
     *
     * Converts the Monolog LogRecord to a plain array, preserving all
     * extra/context fields so they are full-text-searchable in Kamori.
     * Non-JSON-serialisable values in context/extra are replaced with a
     * string placeholder so json_encode never throws.
     */
    protected function write(LogRecord $record): void
    {
        // Build a flat event array from the Monolog record
        $event = [
            'level'    => strtolower($record->level->name),
            'message'  => $record->message,
            'channel'  => $record->channel,
            'datetime' => $record->datetime->format(\DateTimeInterface::RFC3339_EXTENDED),
        ];

        // Merge context and extra into the event so all fields are searchable.
        // Sanitise first to ensure JSON serialisability: objects and resources
        // that would cause json_encode to fail are replaced with a descriptor string.
        if (!empty($record->context)) {
            $event['context'] = $this->sanitise($record->context);
        }
        if (!empty($record->extra)) {
            $event['extra'] = $this->sanitise($record->extra);
        }

        $this->client->log($event);
    }

    /**
     * Flush buffered events when the handler is closed.
     *
     * Called automatically by Monolog during logger reset/shutdown.
     */
    public function close(): void
    {
        $this->client->flush();
        parent::close();
    }

    /**
     * Expose the underlying KamoriClient for testing and shutdown hooks.
     *
     * @return KamoriClient
     */
    public function getClient(): KamoriClient
    {
        return $this->client;
    }

    /**
     * Replace non-JSON-serialisable values with a string descriptor.
     *
     * Monolog context/extra can contain arbitrary PHP values (objects,
     * resources, closures). json_encode silently outputs null for these,
     * losing information. This method replaces them with a descriptive
     * string so the payload remains both valid JSON and informative.
     *
     * @param  array<string, mixed> $data
     * @return array<string, mixed>
     */
    private function sanitise(array $data): array
    {
        return array_map(static function (mixed $value): mixed {
            if (is_array($value)) {
                // Recurse one level to handle nested arrays (e.g. context['exception'])
                return array_map(static function (mixed $v): mixed {
                    if (is_object($v) || is_resource($v)) {
                        return '[' . get_debug_type($v) . ']';
                    }
                    return $v;
                }, $value);
            }
            if (is_object($value) || is_resource($value)) {
                return '[' . get_debug_type($value) . ']';
            }
            return $value;
        }, $data);
    }
}
