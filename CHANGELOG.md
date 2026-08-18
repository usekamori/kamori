# Changelog

Notable, user-visible changes to the Kamori OSS server, MCP server, and SDKs.
Format: [Keep a Changelog](https://keepachangelog.com); no releases have been
cut yet, so everything lives under Unreleased.

## [Unreleased]

### Added

- `GET /v1/count` — exact log count with optional `service` / `level` /
  `since` / `until` filters. Returns `{ count }`.
- `GET /v1/histogram` — time-bucketed log counts for charts (`bucket` =
  `1m|5m|15m|1h|6h|1d`, default `1h`, same filters). Returns
  `{ histogram: [{ bucket, count }] }`.
- `GET /v1/search` accepts a `level` parameter (exact match on the indexed
  column, identical semantics to `GET /v1/logs`), so full-text search and the
  level filter finally combine.
- MCP: the `search_logs` and `tail_logs` tools accept an optional `level`
  argument with the same semantics.

### Fixed

- Combining full-text search with a level filter previously **ignored the
  level silently** — searching "timeout" with `level=error` returned matches
  of every level. Search + level now filters correctly across the HTTP API,
  the MCP tools, and the cloud dashboard.
- `GET /v1/search` documentation previously claimed a default `limit` of 50;
  the actual default is 500 (capped at 500). Docs now match the behavior.

### Security

- The MCP `query_sql` tool executes under a **database-level read-only
  guarantee** (`PRAGMA query_only` on SQLite, a read-only transaction on
  libSQL) in addition to its lexical SELECT-only checks.
- Go/Python/PHP SDKs refuse plaintext `http://` URLs to non-localhost hosts
  (opt-out via `AllowInsecure` / `allow_insecure` / `allowInsecure`), so
  ingest tokens are never sent in cleartext by default.
- The PHP SDK's destructor flush is best-effort (single 2 s attempt, no
  retries) so a slow ingest server cannot hang request teardown.
