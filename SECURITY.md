# Security Policy

## Supported versions

| Version         | Supported           |
| --------------- | ------------------- |
| `main` (latest) | Yes                 |
| Older releases  | No — please upgrade |

---

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Report security issues by emailing **security@kamori.io**. Include:

- A description of the vulnerability
- Steps to reproduce (proof-of-concept code is welcome)
- The version of Kamori you are using
- Any relevant environment details

You will receive an acknowledgement within **2 business days** and a resolution timeline within **7 business days**.

We follow responsible disclosure: we will coordinate a fix and release before any public disclosure, and we will credit you in the release notes unless you prefer to remain anonymous.

---

## Scope

The following are in scope:

- Authentication bypass in the ingest server (`packages/ingest`)
- SQL injection or data exfiltration via the MCP tools (`packages/mcp`)
- Path traversal or arbitrary file read/write via `DB_PATH`
- Token leakage in logs, error messages, or API responses
- Webhook signature verification bypass

The following are **out of scope**:

- Vulnerabilities in the host operating system or infrastructure
- Issues requiring physical access to the server
- Social engineering attacks

---

## Security design notes

- **Token auth** — `INGEST_TOKEN` comparison uses SHA-256 hashing + `timingSafeEqual` to prevent timing attacks.
- **Webhook signatures** — all supported providers (Vercel, GitHub, Render) use HMAC-based verification with timing-safe comparison. Render signatures include a 5-minute replay protection window.
- **Input limits** — request body is capped at `BODY_LIMIT_BYTES` (default 1 MB), per-request row count at `MAX_ROWS` (default 1000), and optionally individual row size at `MAX_ROW_BYTES` (default 0 = disabled). Cloud deployments enforce per-plan row byte limits automatically.
- **Rate limiting** — `@fastify/rate-limit` limits requests per IP to `RATE_LIMIT_MAX` per minute (default 100). DELETE is limited to 10/minute.
- **Security headers** — `@fastify/helmet` sets `X-Frame-Options`, `X-Content-Type-Options`, `Strict-Transport-Security`, and related headers on all responses.
- **CORS** — disabled by default; opt-in via `ALLOWED_ORIGINS`.
- **DB path traversal** — `BetterSqliteAdapter` rejects paths that escape the project root via `..` components.
- **Syslog buffer limit** — TCP syslog connections are destroyed if they send more than 1 MB without a newline delimiter, preventing unbounded memory growth.
