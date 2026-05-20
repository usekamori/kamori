#!/usr/bin/env npx tsx
/**
 * Kamori demo load generator.
 *
 * Simulates real user sessions through the next-app UI — each session visits
 * the homepage, optionally searches for a product, then checks out. This
 * exercises every logging layer in one realistic flow:
 *
 *   GET  /                 → withKamori middleware (next-app)
 *   GET  /api/search       → KamoriClient.scoped() (fastify-api)
 *   POST /api/checkout     → withKamori + KamoriClient business events (next-app)
 *                          → installShim (express-api)
 *                          → Go KamoriClient fraud check
 *                          → pino+createKamoriStream inventory check
 *                          → raw HTTP recommendations (fastapi)
 *                          → Python logging+KamoriHandler email (flask)
 *                          → PHP KamoriClient payment
 *                          → Python KamoriClient loyalty points
 *                          → winston+KamoriTransport shipping
 *                          → PHP Monolog+KamoriHandler notification
 *
 * Usage:
 *   npx tsx load-gen.ts                   # 40 sessions, ~1 per second
 *   npx tsx load-gen.ts --orders 80       # more volume
 *   npx tsx load-gen.ts --delay 200       # faster (200 ms between sessions)
 *   npx tsx load-gen.ts --scenario chaos  # rapid burst, all fault types
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const NEXT_APP_URL    = process.env.NEXT_APP_URL    ?? "http://localhost:3000";
const FASTIFY_URL     = process.env.FASTIFY_URL     ?? "http://localhost:3201";

// Direct URLs used only for health checks — traffic goes through next-app
const EXPRESS_URL     = process.env.EXPRESS_URL     ?? "http://localhost:3200";
const FASTAPI_URL     = process.env.FASTAPI_URL     ?? "http://localhost:3300";
const FLASK_URL       = process.env.FLASK_URL       ?? "http://localhost:3301";
const PYTHON_SDK_URL  = process.env.PYTHON_SDK_URL  ?? "http://localhost:3302";
const PHP_URL         = process.env.PHP_URL         ?? "http://localhost:3400";
const PHP_MONOLOG_URL = process.env.PHP_MONOLOG_URL ?? "http://localhost:3401";
const PINO_URL        = process.env.PINO_URL        ?? "http://localhost:3500";
const WINSTON_URL     = process.env.WINSTON_URL     ?? "http://localhost:3501";
const GO_URL          = process.env.GO_URL          ?? "http://localhost:3600";

const args = process.argv.slice(2);
const get = (flag: string, def: string) => {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
};

const TOTAL_ORDERS = parseInt(get("--orders", "40"), 10);
const DELAY_MS     = parseInt(get("--delay",  "900"), 10);
const SCENARIO     = get("--scenario", "default");

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

const PRODUCTS = [
  "Wireless Headphones",
  "Mechanical Keyboard",
  "USB-C Hub",
  "4K Monitor",
  "Standing Desk Mat",
  "Webcam HD",
  "Stream Deck",
  "NVMe SSD",
  "RGB Mouse Pad",
  "Laptop Stand",
];

const USERS = [
  "alice",
  "bob",
  "carol",
  "dave",
  "eve",
  "frank",
  "grace",
  "heidi",
  "ivan",
  "judy",
];

const SEARCH_QUERIES = [
  "keyboard",
  "monitor",
  "headphones",
  "desk",
  "mouse",
  "camera",
  "hub",
  "ssd",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const RESET  = "\x1b[0m";
const BOLD   = "\x1b[1m";
const DIM    = "\x1b[2m";
const GREEN  = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED    = "\x1b[31m";
const CYAN   = "\x1b[36m";
const BLUE   = "\x1b[34m";

function icon(l: string) {
  if (l === "ok")    return `${GREEN}✓${RESET}`;
  if (l === "warn")  return `${YELLOW}⚠${RESET}`;
  if (l === "error") return `${RED}✗${RESET}`;
  return l;
}

function log(i: string, msg: string, detail = "") {
  const ts = new Date().toTimeString().slice(0, 8);
  console.log(
    `${DIM}${ts}${RESET}  ${i}  ${msg}${detail ? `  ${DIM}${detail}${RESET}` : ""}`,
  );
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

async function checkHealth() {
  console.log(`\n${BOLD}Checking services…${RESET}\n`);
  const services = [
    { name: "next-app            (withKamori+KamoriClient+browser)",  url: `${NEXT_APP_URL}/` },
    { name: "express-api         (installShim)",                    url: `${EXPRESS_URL}/health` },
    { name: "fastify-api         (KamoriClient+scoped)",             url: `${FASTIFY_URL}/health` },
    { name: "fastapi-service     (raw HTTP)",                       url: `${FASTAPI_URL}/health` },
    { name: "flask-service       (python-logging+KamoriHandler)",    url: `${FLASK_URL}/health` },
    { name: "python-sdk-service  (Python KamoriClient)",             url: `${PYTHON_SDK_URL}/health` },
    { name: "php-service         (PHP KamoriClient)",                url: `${PHP_URL}/health` },
    { name: "php-monolog-service (Monolog+KamoriHandler)",           url: `${PHP_MONOLOG_URL}/health` },
    { name: "pino-service        (pino+createKamoriStream)",         url: `${PINO_URL}/health` },
    { name: "winston-service     (winston+KamoriTransport)",         url: `${WINSTON_URL}/health` },
    { name: "go-service          (Go KamoriClient+Scoped)",          url: `${GO_URL}/health` },
  ];
  let ok = true;
  for (const s of services) {
    try {
      const r = await fetch(s.url, { signal: AbortSignal.timeout(3000) });
      if (r.ok || r.status === 307 || r.status === 200) {
        log(icon("ok"), s.name, s.url);
      } else {
        log(icon("error"), s.name, `HTTP ${r.status}`);
        ok = false;
      }
    } catch {
      log(icon("error"), s.name, "unreachable — is docker compose running?");
      ok = false;
    }
  }
  console.log();
  return ok;
}

// ---------------------------------------------------------------------------
// User session steps
// ---------------------------------------------------------------------------

/** Simulate visiting the homepage — fires withKamori middleware on next-app. */
async function visitHomepage() {
  try {
    await fetch(`${NEXT_APP_URL}/`, { signal: AbortSignal.timeout(5000) });
  } catch {
    // page visit is best-effort; don't abort the session
  }
}

/** Product search via fastify-api. */
async function search(q: string) {
  try {
    const r    = await fetch(`${FASTIFY_URL}/api/search?q=${encodeURIComponent(q)}`, {
      signal: AbortSignal.timeout(3000),
    });
    const data = (await r.json()) as { count?: number };
    log(icon("ok"), `search "${q}"`, `${data.count ?? 0} results`);
  } catch {
    log(icon("warn"), `search "${q}"`, "failed");
  }
}

/**
 * Checkout via next-app — submits the form exactly as a browser would.
 *
 * Fires: withKamori middleware → KamoriClient business events → express-api
 * → all 8 downstream services in one request.
 */
async function checkout(
  n:       number,
  userId:  string,
  product: string,
  amount:  number,
): Promise<{ ok: boolean }> {
  const isBig  = amount > 5000;
  const badge  = isBig ? `${RED}$${amount}${RESET}` : `${GREEN}$${amount}${RESET}`;
  process.stdout.write(
    `  ${DIM}#${String(n).padStart(3)}${RESET}  ${DIM}${userId.padEnd(6)}${RESET}  ${badge}  ${product}`,
  );

  // URLSearchParams mimics a browser form POST (application/x-www-form-urlencoded)
  const body = new URLSearchParams({ product, amount: String(amount), userId });

  try {
    const r = await fetch(`${NEXT_APP_URL}/api/checkout`, {
      method:   "POST",
      headers:  { "Content-Type": "application/x-www-form-urlencoded" },
      body:     body.toString(),
      redirect: "manual",             // don't follow Next.js redirect
      signal:   AbortSignal.timeout(15_000), // all downstream services in series
    });

    // Next.js redirects to /?success=1 (307) on success, /?error=… on failure
    const ok = r.status >= 300 && r.status < 400;
    const redirectTo = r.headers.get("location") ?? "";
    const failed = redirectTo.includes("error=");
    console.log(`  →  ${(ok && !failed) ? GREEN + "ok" + RESET : RED + (failed ? "checkout_failed" : `HTTP ${r.status}`) + RESET}`);
    return { ok: ok && !failed };
  } catch (err) {
    console.log(`  →  ${RED}failed: ${String(err)}${RESET}`);
    return { ok: false };
  }
}

// ---------------------------------------------------------------------------
// Session: visit → maybe search → checkout
// ---------------------------------------------------------------------------

async function runSession(n: number, amount?: number): Promise<{ ok: boolean }> {
  const userId  = pick(USERS);
  const product = pick(PRODUCTS);
  const amt     = amount ?? Math.floor(Math.random() * 1200) + 50;

  // Simulate browsing: always visit homepage, search ~60% of the time
  await visitHomepage();
  if (Math.random() > 0.4) {
    await search(pick(SEARCH_QUERIES));
    await sleep(150);
  }

  return checkout(n, userId, product, amt);
}

// ---------------------------------------------------------------------------
// Build session list for each scenario
// ---------------------------------------------------------------------------

type SessionSpec = { n: number; amount?: number; label?: string };

function buildSessionList(): SessionSpec[] {
  const sessions: SessionSpec[] = [];

  if (SCENARIO === "chaos") {
    // Rapid burst that hits every fault threshold immediately
    for (let i = 1; i <= 30; i++) sessions.push({ n: i });
    for (let i = 31; i <= 35; i++)
      sessions.push({ n: i, amount: 6000 + i * 100, label: "big-ticket" });
    sessions.push({ n: 36 }); // push past order #30 for FastAPI rate limit
    return sessions;
  }

  // default: scatter big-ticket orders to reliably hit every fault
  for (let i = 0; i < TOTAL_ORDERS; i++) {
    const n = i + 1;
    if ([5, 15, 22, 29, 38].includes(i)) {
      sessions.push({ n, amount: 5500 + Math.floor(Math.random() * 3000), label: "big-ticket" });
    } else {
      sessions.push({ n });
    }
  }

  return sessions;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`\n${BOLD}${BLUE}Kamori demo — load generator${RESET}`);
  console.log(`${DIM}scenario: ${SCENARIO}  sessions: ${TOTAL_ORDERS}  delay: ${DELAY_MS}ms${RESET}`);
  console.log(`${DIM}traffic flows through next-app → express-api → all downstream services${RESET}`);

  const healthy = await checkHealth();
  if (!healthy) {
    console.error(`${RED}One or more services are down. Run: docker compose up --build${RESET}\n`);
    process.exit(1);
  }

  const sessionList = buildSessionList();
  let errorCount = 0;

  console.log(`${BOLD}Simulating ${sessionList.length} user sessions…${RESET}`);
  console.log(
    `${DIM}Faults: PHP >$5000 · Flask SMTP #20 · FastAPI rate-limit #30 · Go fraud #15 · Python loyalty #10 · PHP notify #12${RESET}\n`,
  );

  for (const spec of sessionList) {
    if (spec.label) process.stdout.write(`${YELLOW}[${spec.label}]${RESET} `);

    const result = await runSession(spec.n, spec.amount);
    if (!result.ok) errorCount++;

    await sleep(DELAY_MS);
  }

  // Final burst of searches
  console.log(`\n${BOLD}Running final searches…${RESET}\n`);
  for (const q of SEARCH_QUERIES.slice(0, 4)) {
    await search(q);
    await sleep(200);
  }

  console.log(
    `\n${BOLD}Done.${RESET}  ${errorCount} session errors out of ${sessionList.length} total.`,
  );
  console.log(`\n${DIM}Tail live logs:${RESET}`);
  console.log(
    `  ${CYAN}curl -sN http://localhost:3110/v1/stream | jq -rc '"\\(.ts[11:19]) [\\(.level)] \\(.service) \\(.event // .message // "")"'${RESET}`,
  );
  console.log(`\n${DIM}Ask Claude:${RESET}`);
  console.log(`  "Summarise all errors from the last 10 minutes across every service"`);
  console.log(`  "Which service has the most errors and why?"`);
  console.log(`  "Find all orders that failed payment processing"\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
