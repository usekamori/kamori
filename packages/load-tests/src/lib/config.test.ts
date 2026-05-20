import { describe, expect, it } from "vitest";
import { getAuthHeaders, getBaseUrl, getProfileConfig, getTargetTag } from "./config.js";

describe("config helpers", () => {
  it("throws when BASE_URL is missing", () => {
    expect(() => getBaseUrl({})).toThrow(/BASE_URL/);
  });

  it("normalizes BASE_URL by trimming trailing slash", () => {
    expect(getBaseUrl({ BASE_URL: "http://localhost:3110/" })).toBe("http://localhost:3110");
  });

  it("returns Authorization Bearer header when token exists", () => {
    const headers = getAuthHeaders({ INGEST_TOKEN: "secret" });

    expect(headers.Authorization).toBe("Bearer secret");
  });

  it("returns no auth headers when token is empty", () => {
    const headers = getAuthHeaders({ INGEST_TOKEN: "" });

    expect(Object.keys(headers).length).toBe(0);
  });

  it("defaults to stress profile when TEST_PROFILE is unknown", () => {
    expect(getProfileConfig({ TEST_PROFILE: "unknown" }).name).toBe("stress");
  });

  it("returns target tag from env", () => {
    expect(getTargetTag({ TARGET_NAME: "cloud" })).toBe("cloud");
  });
});
