import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

describe("env — parseIntEnv", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("uses the default when the variable is not set", async () => {
    delete process.env.MAX_ROWS;
    const { MAX_ROWS } = await import("./env.js");
    expect(MAX_ROWS).toBe(1000);
  });

  it("parses a valid integer value", async () => {
    process.env.MAX_ROWS = "500";
    const { MAX_ROWS } = await import("./env.js");
    expect(MAX_ROWS).toBe(500);
  });

  it("throws on a non-numeric string", async () => {
    process.env.MAX_ROWS = "abc";
    await expect(import("./env.js")).rejects.toThrow(/MAX_ROWS/);
  });

  it("throws on a negative integer", async () => {
    process.env.PORT = "-1";
    await expect(import("./env.js")).rejects.toThrow(/PORT/);
  });
});
