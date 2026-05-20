export interface EnvLike {
  BASE_URL?: string;
  INGEST_TOKEN?: string;
  TARGET_NAME?: string;
  TEST_PROFILE?: string;
  ROWS_PER_REQUEST?: string;
  PAYLOAD_BYTES?: string;
}

export interface ProfileConfig {
  name: "smoke" | "stress";
  rowsPerRequest: number;
  payloadBytes: number;
}

export function getBaseUrl(env: EnvLike): string {
  const baseUrl = env.BASE_URL?.trim();
  if (!baseUrl) throw new Error("BASE_URL is required");
  return baseUrl.replace(/\/+$/, "");
}

export function getAuthHeaders(env: EnvLike): Record<string, string> {
  const token = env.INGEST_TOKEN?.trim();
  if (!token) return {};
  return {
    Authorization: `Bearer ${token}`,
  };
}

export function getTargetTag(env: EnvLike): string {
  return env.TARGET_NAME?.trim() || "unknown";
}

export function getProfileConfig(env: EnvLike): ProfileConfig {
  const requested = env.TEST_PROFILE?.trim().toLowerCase();
  const profile: ProfileConfig =
    requested === "smoke"
      ? { name: "smoke", rowsPerRequest: 1, payloadBytes: 256 }
      : { name: "stress", rowsPerRequest: 25, payloadBytes: 1024 };

  const rowsPerRequest = Number.parseInt(env.ROWS_PER_REQUEST || "", 10);
  const payloadBytes = Number.parseInt(env.PAYLOAD_BYTES || "", 10);

  return {
    ...profile,
    rowsPerRequest:
      Number.isFinite(rowsPerRequest) && rowsPerRequest > 0 ? rowsPerRequest : profile.rowsPerRequest,
    payloadBytes:
      Number.isFinite(payloadBytes) && payloadBytes > 0 ? payloadBytes : profile.payloadBytes,
  };
}
