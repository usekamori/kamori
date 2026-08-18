/**
 * Startup auth-posture check for the self-hosted ingest server.
 *
 * The self-hosted server is single-tenant: one `INGEST_TOKEN` guards the whole
 * instance. When the token is empty, auth is disabled and *anyone* who can reach
 * the server can read, write, and delete logs. This check makes that visible
 * (and, in production on a network interface, fatal) so an open server is never
 * an accidental default.
 *
 * Cloud mode is exempt — there, per-project Ed25519 JWT API keys are the auth
 * mechanism and `INGEST_TOKEN` is intentionally unset.
 */

export interface AuthPostureInput {
  /** INGEST_TOKEN value. Empty string = auth disabled. */
  ingestToken: string;
  /** METRICS_TOKEN value. Empty string = /metrics is public. */
  metricsToken: string;
  /** NODE_ENV. Only "production" escalates an open server to fatal. */
  nodeEnv: string;
  /** Bind address (HOST). Loopback is treated as non-networked. */
  host: string;
  /** CLOUD_MODE — cloud uses JWT API keys; the check is skipped entirely. */
  cloudMode: boolean;
  /** KAMORI_ALLOW_NO_AUTH — explicit opt-in to run open; downgrades fatal to warning. */
  allowNoAuth: boolean;
}

export interface AuthPostureResult {
  /** Non-fatal warnings to log at startup. */
  warnings: string[];
  /** When set, the server must refuse to start and print this message. */
  fatal: string | null;
}

/** Loopback / non-networked bind addresses — an open server here is not exposed. */
function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/**
 * Evaluate the auth posture. Pure — takes the resolved env values and returns
 * warnings plus an optional fatal message. The caller logs and exits.
 */
export function checkIngestAuthPosture(input: AuthPostureInput): AuthPostureResult {
  const warnings: string[] = [];
  let fatal: string | null = null;

  // Cloud deployments authenticate with per-project JWT API keys, not INGEST_TOKEN.
  if (input.cloudMode) return { warnings, fatal };

  const networked = !isLoopbackHost(input.host);

  if (input.ingestToken === "") {
    if (input.nodeEnv === "production" && networked && !input.allowNoAuth) {
      fatal =
        `INGEST_TOKEN is not set and the server is bound to a network interface ` +
        `(HOST=${input.host}) with NODE_ENV=production. The /v1 ingest, query, export, ` +
        `and DELETE API would be UNAUTHENTICATED — anyone who can reach this server ` +
        `could read, write, and delete your logs.\n` +
        `Fix one of the following:\n` +
        `  • set INGEST_TOKEN to a strong secret, or\n` +
        `  • bind HOST=127.0.0.1 (loopback only), or\n` +
        `  • set KAMORI_ALLOW_NO_AUTH=true to explicitly run without auth (trusted networks only).`;
    } else {
      warnings.push(
        `INGEST_TOKEN is not set — the /v1 ingest, query, export, and DELETE API is ` +
          `UNAUTHENTICATED. Anyone who can reach ${input.host}:<port> can read, write, ` +
          `and delete your logs. Set INGEST_TOKEN before exposing this server to any network.`,
      );
    }
  }

  if (input.metricsToken === "" && networked) {
    warnings.push(
      `METRICS_TOKEN is not set — /metrics is publicly readable (exposes service names ` +
        `and log counts). Set METRICS_TOKEN or restrict the endpoint at your reverse proxy.`,
    );
  }

  return { warnings, fatal };
}
