/**
 * Tests for start-mcp helpers:
 *   - decodeJwtExpiry   pure JWT exp extraction (no signature verification)
 *   - scheduleSessionExpiry  timer-based session close at JWT expiry
 */

import { vi, describe, it, expect, afterEach } from "vitest";
import { decodeJwtExpiry, scheduleSessionExpiry } from "./start-mcp.js";

// ---------------------------------------------------------------------------
// Helpers to build minimal JWTs (unsigned — we only need the payload shape)
// ---------------------------------------------------------------------------

function makeJwt(payload: Record<string, unknown>): string {
  const header  = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT" })).toString("base64url");
  const body    = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig     = "fakesignature";
  return `${header}.${body}.${sig}`;
}

// ---------------------------------------------------------------------------
// decodeJwtExpiry
// ---------------------------------------------------------------------------

describe("decodeJwtExpiry", () => {
  it("returns the exp claim from a valid JWT payload", () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    expect(decodeJwtExpiry(makeJwt({ sub: "k1", exp }))).toBe(exp);
  });

  it("returns null when the JWT has no exp claim", () => {
    expect(decodeJwtExpiry(makeJwt({ sub: "k1" }))).toBeNull();
  });

  it("returns null when exp is not a number", () => {
    expect(decodeJwtExpiry(makeJwt({ exp: "2099-01-01" }))).toBeNull();
  });

  it("returns null for a plain token string (no dots)", () => {
    expect(decodeJwtExpiry("plaintoken")).toBeNull();
  });

  it("returns null for a two-part string", () => {
    expect(decodeJwtExpiry("part1.part2")).toBeNull();
  });

  it("returns null for a malformed base64url payload", () => {
    expect(decodeJwtExpiry("header.!!!.sig")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(decodeJwtExpiry("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// scheduleSessionExpiry
// ---------------------------------------------------------------------------

describe("scheduleSessionExpiry", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not schedule a timer for a non-JWT token", () => {
    vi.useFakeTimers();
    const transport = { close: vi.fn().mockResolvedValue(undefined) };
    const onClose = vi.fn();

    scheduleSessionExpiry(transport, "plain-mcp-token", onClose);

    vi.runAllTimers();
    expect(transport.close).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not schedule a timer when JWT has no exp", () => {
    vi.useFakeTimers();
    const transport = { close: vi.fn().mockResolvedValue(undefined) };
    const onClose = vi.fn();

    scheduleSessionExpiry(transport, makeJwt({ sub: "k1" }), onClose);

    vi.runAllTimers();
    expect(transport.close).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not schedule a timer when JWT is already expired", () => {
    vi.useFakeTimers();
    const transport = { close: vi.fn().mockResolvedValue(undefined) };
    const onClose = vi.fn();
    const expiredExp = Math.floor(Date.now() / 1000) - 60;

    scheduleSessionExpiry(transport, makeJwt({ sub: "k1", exp: expiredExp }), onClose);

    vi.runAllTimers();
    expect(transport.close).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes the transport and calls onClose at JWT expiry", async () => {
    vi.useFakeTimers();
    const transport = { close: vi.fn().mockResolvedValue(undefined) };
    const onClose = vi.fn();

    // Compute exp the same way the implementation does so the delay is exact.
    const nowMs = Date.now();
    const exp = Math.floor(nowMs / 1000) + 3600;
    const msUntilExpiry = exp * 1000 - nowMs;

    scheduleSessionExpiry(transport, makeJwt({ sub: "k1", exp }), onClose);

    // One millisecond before expiry — nothing fires
    await vi.advanceTimersByTimeAsync(msUntilExpiry - 1);
    expect(transport.close).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    // At expiry — both fire
    await vi.advanceTimersByTimeAsync(1);
    expect(transport.close).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("does not schedule a timer when msUntilExpiry exceeds the 32-bit setTimeout limit (~24.8 days)", () => {
    vi.useFakeTimers();
    const transport = { close: vi.fn().mockResolvedValue(undefined) };
    const onClose = vi.fn();
    // 90-day JWT — well beyond the 2^31-1 ms Node.js setTimeout limit
    const exp = Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60;

    scheduleSessionExpiry(transport, makeJwt({ sub: "k1", exp }), onClose);

    vi.runAllTimers();
    expect(transport.close).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("calls onClose even when transport.close() rejects", async () => {
    vi.useFakeTimers();
    const transport = { close: vi.fn().mockRejectedValue(new Error("already closed")) };
    const onClose = vi.fn();
    const exp = Math.floor(Date.now() / 1000) + 1;

    scheduleSessionExpiry(transport, makeJwt({ sub: "k1", exp }), onClose);

    await vi.advanceTimersByTimeAsync(1000);
    // transport.close rejected but onClose should still have been called
    // (the rejection is swallowed by .catch(() => {}))
    expect(transport.close).toHaveBeenCalledOnce();
    // onClose is called synchronously before the rejected promise settles,
    // so it will have been called regardless
    expect(onClose).toHaveBeenCalledOnce();
  });
});
