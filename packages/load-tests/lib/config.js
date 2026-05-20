export function getBaseUrl(env) {
  const baseUrl = env.BASE_URL?.trim();
  if (!baseUrl) throw new Error("BASE_URL is required");
  return baseUrl.replace(/\/+$/, "");
}

export function getAuthHeaders(env) {
  const token = env.INGEST_TOKEN?.trim();
  if (!token) return {};
  return {
    Authorization: `Bearer ${token}`,
  };
}

export function getTargetTag(env) {
  return env.TARGET_NAME?.trim() || "unknown";
}

export function getProfileConfig(env) {
  const requested = env.TEST_PROFILE?.trim().toLowerCase();
  const profile = requested === "smoke"
    ? { name: "smoke", rowsPerRequest: 1, payloadBytes: 256 }
    : { name: "stress", rowsPerRequest: 25, payloadBytes: 1024 };

  const rowsPerRequest = Number.parseInt(env.ROWS_PER_REQUEST || "", 10);
  const payloadBytes = Number.parseInt(env.PAYLOAD_BYTES || "", 10);

  return {
    ...profile,
    rowsPerRequest: Number.isFinite(rowsPerRequest) && rowsPerRequest > 0 ? rowsPerRequest : profile.rowsPerRequest,
    payloadBytes: Number.isFinite(payloadBytes) && payloadBytes > 0 ? payloadBytes : profile.payloadBytes,
  };
}
