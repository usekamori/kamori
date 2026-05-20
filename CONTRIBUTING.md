# Contributing to Kamori

Thank you for your interest in contributing. This document covers how to set up a development environment, run the tests, and open a pull request.

---

## Prerequisites

- **Node.js** 20+ and **npm** 10+
- **Go** 1.22+ (for the Go SDK)
- **Python** 3.9+ (for the Python SDK)
- **PHP** 8.1+ and **Composer** (for the PHP SDK)

---

## Local setup

```bash
git clone https://github.com/usekamori/kamori.git
cd kamori
npm install
```

All TypeScript packages are built together:

```bash
npm run build
```

Start the development server with hot-reload:

```bash
npm run dev:server
```

Copy the example environment file and edit as needed:

```bash
cp .env.example .env
```

---

## Running tests

```bash
# All TypeScript tests
npm test

# Single package
npx vitest run packages/ingest

# Go SDK
cd sdks/go && go test ./...

# Python SDK
cd sdks/python && python -m pytest

# PHP SDK
cd sdks/php && composer install && vendor/bin/phpunit
```

Tests use SQLite in-memory databases — no external services required.

---

## Project structure

```
packages/
  core/     — shared DB adapter, env config, auth/billing/retention interfaces
  ingest/   — Fastify HTTP ingest server
  mcp/      — MCP server (9 tools for Claude / Cursor)
  sdk/      — TypeScript/Node.js client + browser/pino/winston/Next.js integrations
  kamori/ — scaffolding CLI

sdks/
  go/       — Go client
  python/   — Python client
  php/      — PHP client + Monolog handler + Laravel provider

docs/       — documentation source files
```

See `docs/STRUCTURE.md` for a full breakdown, and `docs/CODEBOOK.md` for architectural decisions.

---

## Pull request guidelines

- **One concern per PR.** Bug fixes and features should not be mixed.
- **Tests are required.** New behaviour must be covered by a test. The CI pipeline enforces this.
- **No breaking changes** to public APIs without a prior discussion in an issue.
- **Conventional commits** are preferred but not enforced: `fix:`, `feat:`, `chore:`, `docs:`, `test:`.

### Opening a PR

1. Fork the repository and create a feature branch: `git checkout -b feat/my-thing`
2. Make your changes and add tests.
3. Ensure `npm test` passes locally.
4. Push and open a pull request against `main`.

A maintainer will review within a few business days.

---

## Reporting bugs

Open an issue with a **minimal reproduction** — the server version (`npm ls @usekamori/ingest`), the relevant environment variables (without secrets), and the exact error message or unexpected behaviour.

---

## Code of conduct

Be kind and constructive. We follow the [Contributor Covenant](https://www.contributor-covenant.org/).
