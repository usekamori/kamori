import { describe, it, expect } from "vitest";
import { checkIngestAuthPosture, type AuthPostureInput } from "./startup-check.js";

function input(overrides: Partial<AuthPostureInput> = {}): AuthPostureInput {
  return {
    ingestToken: "secret",
    metricsToken: "secret",
    nodeEnv: "production",
    host: "0.0.0.0",
    cloudMode: false,
    allowNoAuth: false,
    ...overrides,
  };
}

describe("checkIngestAuthPosture", () => {
  it("is silent when a token is set", () => {
    const r = checkIngestAuthPosture(input());
    expect(r.warnings).toEqual([]);
    expect(r.fatal).toBeNull();
  });

  it("skips all checks in cloud mode (JWT API keys, not INGEST_TOKEN)", () => {
    const r = checkIngestAuthPosture(input({ cloudMode: true, ingestToken: "", metricsToken: "" }));
    expect(r.warnings).toEqual([]);
    expect(r.fatal).toBeNull();
  });

  it("refuses to start when open, networked, and production", () => {
    const r = checkIngestAuthPosture(input({ ingestToken: "", host: "0.0.0.0", nodeEnv: "production" }));
    expect(r.fatal).toMatch(/INGEST_TOKEN is not set/);
    expect(r.fatal).toMatch(/UNAUTHENTICATED/);
  });

  it("warns (not fatal) when open in development", () => {
    const r = checkIngestAuthPosture(input({ ingestToken: "", nodeEnv: "development" }));
    expect(r.fatal).toBeNull();
    expect(r.warnings.some((w) => /INGEST_TOKEN is not set/.test(w))).toBe(true);
  });

  it("warns (not fatal) when open on loopback even in production", () => {
    const r = checkIngestAuthPosture(input({ ingestToken: "", host: "127.0.0.1", nodeEnv: "production" }));
    expect(r.fatal).toBeNull();
    expect(r.warnings.some((w) => /INGEST_TOKEN is not set/.test(w))).toBe(true);
  });

  it("downgrades fatal to a warning when KAMORI_ALLOW_NO_AUTH is set", () => {
    const r = checkIngestAuthPosture(input({ ingestToken: "", host: "0.0.0.0", nodeEnv: "production", allowNoAuth: true }));
    expect(r.fatal).toBeNull();
    expect(r.warnings.some((w) => /INGEST_TOKEN is not set/.test(w))).toBe(true);
  });

  it("warns about an open /metrics on a networked host", () => {
    const r = checkIngestAuthPosture(input({ metricsToken: "", host: "0.0.0.0" }));
    expect(r.warnings.some((w) => /METRICS_TOKEN is not set/.test(w))).toBe(true);
  });

  it("does not warn about /metrics on loopback", () => {
    const r = checkIngestAuthPosture(input({ metricsToken: "", host: "127.0.0.1" }));
    expect(r.warnings.some((w) => /METRICS_TOKEN/.test(w))).toBe(false);
  });
});
