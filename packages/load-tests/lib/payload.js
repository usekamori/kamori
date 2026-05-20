function makeBlob(size) {
  const min = Math.max(0, size);
  return "x".repeat(min);
}

export function buildIngestPayload(options) {
  const rows = Math.max(1, options.rows);
  const payloadBytes = Math.max(64, options.payloadBytes);
  const overhead = 96;
  const blobSize = Math.max(0, payloadBytes - overhead);
  const blob = makeBlob(blobSize);

  return Array.from({ length: rows }, (_, index) => ({
    service: "load-test",
    level: "info",
    message: "k6 ingress benchmark row",
    sequence: index + 1,
    blob,
  }));
}
