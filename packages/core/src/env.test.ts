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

describe("env — MCP allow-lists (DNS-rebinding protection)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("defaults to empty arrays when unset (protection disabled)", async () => {
    delete process.env.MCP_ALLOWED_HOSTS;
    delete process.env.MCP_ALLOWED_ORIGINS;
    const { MCP_ALLOWED_HOSTS, MCP_ALLOWED_ORIGINS } = await import("./env.js");
    expect(MCP_ALLOWED_HOSTS).toEqual([]);
    expect(MCP_ALLOWED_ORIGINS).toEqual([]);
  });

  it("splits a comma-separated list and trims whitespace", async () => {
    process.env.MCP_ALLOWED_HOSTS = "mcp.kamori.io, localhost:3111 ,127.0.0.1:3111";
    const { MCP_ALLOWED_HOSTS } = await import("./env.js");
    expect(MCP_ALLOWED_HOSTS).toEqual([
      "mcp.kamori.io",
      "localhost:3111",
      "127.0.0.1:3111",
    ]);
  });

  it("drops empty entries", async () => {
    process.env.MCP_ALLOWED_ORIGINS = "https://app.kamori.io,,";
    const { MCP_ALLOWED_ORIGINS } = await import("./env.js");
    expect(MCP_ALLOWED_ORIGINS).toEqual(["https://app.kamori.io"]);
  });
});
