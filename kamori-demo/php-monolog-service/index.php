<?php
/**
 * php-monolog-service — Push Notifications
 *
 * ──────────────────────────────────────────────────────────────────────────
 * SDK Integration: Monolog + KamoriHandler  (kamori/kamori-php)
 *
 * KamoriHandler is a Monolog 3 handler. Push it onto any existing Monolog
 * Logger alongside your current handlers — zero changes to log call sites.
 *
 * Integration (4 lines):
 *   use Kamori\Monolog\KamoriHandler;
 *   use Monolog\Logger;
 *   $logger = new Logger('my-service');
 *   $logger->pushHandler(new KamoriHandler(url: $url, token: $token));
 *   $logger->info('something happened', ['orderId' => $orderId]);
 *
 * Best for: PHP services already using Monolog (Laravel, Symfony, etc.).
 * ──────────────────────────────────────────────────────────────────────────
 */

declare(strict_types=1);

require __DIR__ . '/vendor/autoload.php';

use Kamori\Monolog\KamoriHandler;
use Monolog\Handler\StreamHandler;
use Monolog\Level;
use Monolog\Logger;

$KAMORI_URL    = getenv('KAMORI_URL')    ?: 'http://localhost:3110';
$INGEST_TOKEN = getenv('INGEST_TOKEN') ?: '';

// ── Kamori: Monolog + KamoriHandler ─────────────────────────────────────────
// Push KamoriHandler alongside StreamHandler so logs go to stdout AND Kamori.
$logger = new Logger('php-monolog-service');
$logger->pushHandler(new StreamHandler('php://stdout', Level::Debug));
$logger->pushHandler(new KamoriHandler(url: $KAMORI_URL, token: $INGEST_TOKEN ?: null));
// ──────────────────────────────────────────────────────────────────────────

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$path   = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);

header('Content-Type: application/json');

// GET /health
if ($method === 'GET' && $path === '/health') {
    $logger->info('health_check', ['service' => 'php-monolog-service']);
    echo json_encode(['ok' => true, 'service' => 'php-monolog-service', 'sdk' => 'Monolog+KamoriHandler']);
    exit;
}

// POST /notify
if ($method === 'POST' && $path === '/notify') {
    $GLOBALS['notifyCount'] = ($GLOBALS['notifyCount'] ?? 0) + 1;

    $body    = json_decode(file_get_contents('php://input'), true) ?? [];
    $orderId = $body['orderId'] ?? 'unknown';
    $userId  = $body['userId']  ?? 'anonymous';
    $event   = $body['event']   ?? 'order_update';

    // Fault: every 12th notification fails delivery
    if ($GLOBALS['notifyCount'] % 12 === 0) {
        $logger->error('notification_delivery_failed', [
            'service' => 'php-monolog-service',
            'orderId' => $orderId,
            'userId'  => $userId,
            'reason'  => 'Push gateway timeout after 3s',
        ]);
        http_response_code(503);
        echo json_encode(['ok' => false, 'error' => 'gateway_timeout', 'orderId' => $orderId]);
        exit;
    }

    $logger->info('notification_sent', [
        'service' => 'php-monolog-service',
        'orderId' => $orderId,
        'userId'  => $userId,
        'event'   => $event,
    ]);
    echo json_encode(['ok' => true, 'orderId' => $orderId, 'channel' => 'push']);
    exit;
}

http_response_code(404);
echo json_encode(['ok' => false, 'error' => 'not found']);
