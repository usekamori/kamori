<?php

declare(strict_types=1);

namespace Kamori\Laravel;

use Kamori\KamoriClient;
use Kamori\Monolog\KamoriHandler;
use Illuminate\Log\LogManager;
use Illuminate\Support\ServiceProvider;
use InvalidArgumentException;
use Monolog\Logger as MonologLogger;

/**
 * Laravel service provider for Kamori.
 *
 * Registers the KamoriClient as a singleton and (optionally) attaches a
 * Monolog handler to the default Laravel logger.
 *
 * Publishes config to config/kamori.php.
 *
 * To enable, add to config/app.php providers array:
 *   Kamori\Laravel\KamoriServiceProvider::class,
 *
 * Or use auto-discovery (already in composer.json extra.laravel).
 *
 * To use Kamori as a named Laravel logging channel, add to config/logging.php:
 *   'channels' => [
 *       'kamori' => [
 *           'driver' => 'monolog',
 *           'handler' => \Kamori\Monolog\KamoriHandler::class,
 *           'with' => [
 *               'url'   => env('KAMORI_URL'),
 *               'token' => env('INGEST_TOKEN'),
 *           ],
 *       ],
 *   ],
 */
class KamoriServiceProvider extends ServiceProvider
{
    /**
     * Register the KamoriClient singleton into the service container.
     */
    public function register(): void
    {
        // Merge package defaults with the application config
        $this->mergeConfigFrom(__DIR__ . '/config/kamori.php', 'kamori');

        // Register KamoriClient as a singleton so the whole app shares one buffer.
        // Validate the URL at bind time so misconfiguration surfaces immediately
        // during container warm-up rather than at the first log write.
        $this->app->singleton(KamoriClient::class, function ($app) {
            $url = (string)($app['config']['kamori.url'] ?? '');

            if ($url === '') {
                throw new InvalidArgumentException(
                    'Kamori: kamori.url is not configured. Set KAMORI_URL in your .env file.'
                );
            }

            $parsed = filter_var($url, FILTER_VALIDATE_URL);
            if ($parsed === false) {
                throw new InvalidArgumentException(
                    "Kamori: kamori.url \"$url\" is not a valid URL."
                );
            }

            $scheme = strtolower((string)parse_url($url, PHP_URL_SCHEME));
            if (!in_array($scheme, ['http', 'https'], true)) {
                throw new InvalidArgumentException(
                    "Kamori: kamori.url must use http or https, got \"$scheme\"."
                );
            }

            return new KamoriClient(
                url: $url,
                token: $app['config']['kamori.token'] ?: null,
                batchSize: $app['config']['kamori.batch_size'] ?? 50,
            );
        });

        // Register a custom Monolog channel driver so the app can use
        // 'driver' => 'kamori' in config/logging.php without extra boilerplate.
        $this->app->resolving(LogManager::class, function (LogManager $manager) {
            $manager->extend('kamori', function ($app, array $config) {
                $url   = $config['url'] ?? $app['config']['kamori.url'] ?? '';
                $token = $config['token'] ?? $app['config']['kamori.token'] ?? null;

                $handler = new KamoriHandler(
                    url: (string)$url,
                    token: $token ?: null,
                    batchSize: (int)($config['batch_size'] ?? $app['config']['kamori.batch_size'] ?? 50),
                );

                return new MonologLogger($config['name'] ?? 'kamori', [$handler]);
            });
        });
    }

    /**
     * Bootstrap package services: publish config and register shutdown flush.
     */
    public function boot(): void
    {
        // Publish the config file
        $this->publishes([
            __DIR__ . '/config/kamori.php' => $this->app->configPath('kamori.php'),
        ], 'kamori-config');

        // Flush the buffer at the end of every HTTP request lifecycle.
        // terminating() is only fired for HTTP requests handled through the
        // kernel; it is NOT called for Artisan commands or queue workers.
        $this->app->terminating(function () {
            $this->app->make(KamoriClient::class)->flush();
        });

        // For CLI contexts (Artisan, queue workers) terminating() is never
        // fired, so register a PHP shutdown function as a safety net.
        // Both may fire in the same process (e.g. HTTP + shutdown); flush()
        // is idempotent, so double-calling it is harmless.
        register_shutdown_function(function () {
            // Only flush if the container has already resolved the client —
            // avoid resolving (and therefore constructing) it just for shutdown.
            if ($this->app->resolved(KamoriClient::class)) {
                $this->app->make(KamoriClient::class)->flush();
            }
        });
    }
}
