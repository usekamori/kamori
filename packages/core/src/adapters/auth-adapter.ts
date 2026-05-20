/**
 * AuthAdapter — verifies ingest authentication.
 *
 * Self-hosted: checks Authorization: Bearer token against the INGEST_TOKEN env var.
 * Cloud: API key → project lookup via the auth database.
 */
export interface AuthAdapter {
  /**
   * Verify a raw token extracted from the Authorization: Bearer header.
   *
   * Return values:
   *   null   — auth is disabled; all requests are allowed through.
   *   false  — token is invalid; respond 401.
   *   true   — token is valid (single-tenant / self-hosted mode).
   *   string — token is valid AND the string is the project ID (multi-tenant
   *            cloud mode). The server stores this on the request so that the
   *            ServerPlugins.getDbAdapter hook can route to the correct tenant DB.
   */
  verifyIngestToken(token: string): boolean | string | null;
}

import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Self-hosted auth: compares against a single shared INGEST_TOKEN env var.
 * When logToken is empty (""), auth is disabled and verifyIngestToken returns null.
 *
 * The expected token hash is computed once at construction time so that the
 * per-request path only pays for one SHA-256 (the incoming token), not two.
 */
export class EnvTokenAuth implements AuthAdapter {
  private readonly tokenHash: Buffer | null;

  constructor(logToken: string) {
    this.tokenHash = logToken
      ? createHash("sha256").update(logToken).digest()
      : null;
  }

  verifyIngestToken(token: string): boolean | string | null {
    if (!this.tokenHash) return null; // auth disabled
    const incoming = createHash("sha256").update(token).digest();
    return timingSafeEqual(incoming, this.tokenHash);
  }
}
