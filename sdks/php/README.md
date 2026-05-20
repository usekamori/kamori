# kamori-php

PHP 8.1+ SDK for [Kamori](https://github.com/usekamori/kamori) — self-hosted log ingestion.

Sends structured log events to a Kamori ingest server over HTTP. No curl required — uses PHP's built-in `fopen` stream context for explicit response header access. Supports batching, automatic retry with exponential back-off, and drop callbacks. The client auto-flushes buffered events in `__destruct`.

---

## Installation

```bash
composer require usekamori/kamori-php
```

---

## Direct usage

```php
use Kamori\KamoriClient;

$client = new KamoriClient(
    url: 'https://your-kamori-server.com',
    token: 'your-log-token',   // matches INGEST_TOKEN on the server
    batchSize: 50,             // flush automatically every 50 events
);

$client->log([
    'level'   => 'info',
    'message' => 'User signed in',
    'user_id' => 42,
]);

// Always flush at the end of a request or script
$client->flush();
```

### Flush on shutdown (CLI scripts)

```php
register_shutdown_function([$client, 'flush']);
```

---

## Monolog 3 handler

```bash
composer require monolog/monolog
```

```php
use Kamori\Monolog\KamoriHandler;
use Monolog\Logger;
use Monolog\Level;

$logger = new Logger('app');
$logger->pushHandler(new KamoriHandler(
    url: 'https://your-kamori-server.com',
    token: 'your-log-token',
    batchSize: 50,
    level: Level::Debug,
));

$logger->info('Hello from Monolog', ['user_id' => 7]);
$logger->error('Something went wrong', ['exception' => 'RuntimeException']);

// Flush when the handler is closed (called automatically by Monolog on __destruct)
// Or flush explicitly:
$logger->getHandlers()[0]->getClient()->flush();
```

Context and extra fields are forwarded to Kamori as-is so all structured data is full-text-searchable.

---

## Laravel (zero-config)

Auto-discovery is enabled via `composer.json`. After `composer require usekamori/kamori-php`, add to your `.env`:

```env
KAMORI_URL=https://your-kamori-server.com
INGEST_TOKEN=your-log-token
```

Optionally publish the config file:

```bash
php artisan vendor:publish --tag=kamori-config
```

This creates `config/kamori.php` where you can adjust `batch_size`.

The `KamoriClient` singleton is automatically flushed at the end of every request via `app()->terminating()`. No additional setup is required.

### Resolve the client manually

```php
use Kamori\KamoriClient;

$client = app(KamoriClient::class);
$client->log(['level' => 'debug', 'message' => 'Manual log entry']);
```

---

## Configuration reference

| Option      | Default | Description                                                                                                                     |
| ----------- | ------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `url`       | —       | Base URL of your Kamori server (required)                                                                                       |
| `token`     | `null`  | Auth token (sent as `Authorization: Bearer`). Leave `null` to skip auth.                                                        |
| `batchSize` | `50`    | Number of events buffered before auto-flush                                                                                     |
| `maxBuffer` | `0`     | Max events in the in-memory buffer. `0` = unlimited. New events are passed to `onDrop` and discarded when the limit is reached. |
| `onDrop`    | `null`  | Callable invoked with the batch when all retries fail                                                                           |

---

## Scoped clients

Add default fields to every log call without repeating them:

```php
class ScopedKamoriClient
{
    public function __construct(
        private KamoriClient $client,
        private array $defaults = [],
    ) {}

    public function log(array $event): void
    {
        $this->client->log(array_merge($this->defaults, $event));
    }

    public function flush(): void
    {
        $this->client->flush();
    }
}

$requestLog = new ScopedKamoriClient($client, [
    'service'    => 'api',
    'request_id' => 'abc-123',
    'user_id'    => 42,
]);

$requestLog->log(['level' => 'info', 'message' => 'Request started']);
$requestLog->log(['level' => 'error', 'message' => 'Validation failed', 'field' => 'email']);
```

---

## Retry behaviour

Failed requests are retried up to three times with exponential back-off. PHP has no async I/O, so retries block the current process with `usleep()`:

| Attempt   | Delay  |
| --------- | ------ |
| 1st retry | 0.25 s |
| 2nd retry | 1 s    |
| 3rd retry | 4 s    |

`4xx` responses are **not** retried (client error — bad token, oversized batch). After all retries fail the batch is passed to `onDrop` (if configured) and discarded. The client never throws.

---

## onDrop callback

```php
$client = new KamoriClient(
    url: 'https://your-kamori-server.com',
    token: 'your-log-token',
    onDrop: function (array $events): void {
        error_log('Kamori dropped ' . count($events) . ' events');
    },
);
```

---

## Requirements

- PHP 8.1+
- `openssl` extension (enabled by default) for HTTPS
- Monolog 3.x (optional, only needed for `KamoriHandler`)
- Laravel 10+ (optional, only needed for `KamoriServiceProvider`)

## License

MIT
