<?php
/**
 * php-service — Payment Processing
 *
 * ──────────────────────────────────────────────────────────────────────────
 * SDK Integration: PHP KamoriClient  (kamori/kamori-php)
 *
 * KamoriClient buffers events and flushes them to the Kamori ingest server.
 * __destruct() flushes automatically — no explicit call needed in most cases.
 *
 * Integration (3 lines):
 *   require __DIR__ . '/vendor/autoload.php';
 *   use Kamori\KamoriClient;
 *   $kamori = new KamoriClient($url, token: $token ?: null);
 *   $kamori->log(['level' => 'info', 'event' => 'payment_processed', ...]);
 *
 * Best for: any PHP service — drop-in replacement for ad-hoc HTTP logging.
 * ──────────────────────────────────────────────────────────────────────────
 */

declare(strict_types=1);

require __DIR__ . '/vendor/autoload.php';

use Kamori\KamoriClient;

$KAMORI_URL    = getenv('KAMORI_URL')    ?: 'http://localhost:3110';
$INGEST_TOKEN = getenv('INGEST_TOKEN') ?: '';

// ── Kamori PHP SDK ──────────────────────────────────────────────────────────
// KamoriClient buffers events; __destruct() flushes at end of request.
$kamori = new KamoriClient($KAMORI_URL, token: $INGEST_TOKEN ?: null);
// ──────────────────────────────────────────────────────────────────────────

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$path   = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);

header('Content-Type: application/json');

// GET /health
if ($method === 'GET' && $path === '/health') {
    echo json_encode(['ok' => true, 'service' => 'php-service', 'sdk' => 'KamoriClient']);
    exit;
}

// POST /process-payment
if ($method === 'POST' && $path === '/process-payment') {
    $GLOBALS['paymentCount'] = ($GLOBALS['paymentCount'] ?? 0) + 1;

    $body    = json_decode(file_get_contents('php://input'), true) ?? [];
    $amount  = (float)($body['amount'] ?? 0);
    $orderId = $body['orderId'] ?? uniqid('ord-');

    // Fault: orders over $5 000 trigger a simulated memory exhaustion error
    if ($amount > 5000) {
        $kamori->log([
            'level'   => 'error',
            'event'   => 'payment_memory_exhausted',
            'service' => 'php-service',
            'orderId' => $orderId,
            'amount'  => $amount,
            'message' => "Fatal: Allowed memory size exhausted while processing order {$orderId} (amount={$amount})",
        ]);
        $kamori->flush();

        http_response_code(500);
        echo json_encode(['ok' => false, 'error' => 'processing_failed', 'orderId' => $orderId]);
        exit;
    }

    $transactionId = 'txn-' . bin2hex(random_bytes(8));
    $kamori->log([
        'level'         => 'info',
        'event'         => 'payment_processed',
        'service'       => 'php-service',
        'orderId'       => $orderId,
        'amount'        => $amount,
        'transactionId' => $transactionId,
    ]);

    echo json_encode([
        'ok'            => true,
        'orderId'       => $orderId,
        'amount'        => $amount,
        'transactionId' => $transactionId,
    ]);
    exit;
}

http_response_code(404);
echo json_encode(['ok' => false, 'error' => 'not found']);
