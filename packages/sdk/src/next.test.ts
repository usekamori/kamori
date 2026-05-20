/**
 * Tests for packages/sdk/src/next.ts (MKR-79).
 *
 * Uses vi.spyOn(KamoriClient.prototype, "log") to capture log calls without
 * requiring a real Kamori server. All tests use the standard Web Fetch API
 * (Request / Response) which is available in the Node.js 18+ test environment.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { withKamori } from "./next.js";
import { KamoriClient } from "./client.js";

const KAMORI_URL = "http://localhost:3110";

/** Helper: build a minimal Request for a given method + URL. */
function makeRequest(method: string, url: string): Request {
  return new Request(url, { method });
}

/** Helper: build a Response with a given status code. */
function makeResponse(status: number): Response {
  return new Response(null, { status });
}

beforeEach(() => {
  vi.useFakeTimers();
  // Stub fetch so the KamoriClient never actually makes network calls.
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Shape / return type
// ---------------------------------------------------------------------------

describe("withKamori — shape", () => {
  it("returns a function", () => {
    const wrapped = withKamori(async (_req) => makeResponse(200), {
      url: KAMORI_URL,
    });
    expect(typeof wrapped).toBe("function");
  });

  it("the returned function is async (returns a Promise)", async () => {
    const wrapped = withKamori(async (_req) => makeResponse(200), {
      url: KAMORI_URL,
    });
    const result = wrapped(makeRequest("GET", "http://example.com/api"));
    expect(result).toBeInstanceOf(Promise);
    await result; // ensure no unhandled rejection
  });
});

// ---------------------------------------------------------------------------
// Successful request logging
// ---------------------------------------------------------------------------

describe("withKamori — successful request", () => {
  it("logs level=info on success", async () => {
    const logSpy = vi.spyOn(KamoriClient.prototype, "log");

    const wrapped = withKamori(async (_req) => makeResponse(200), {
      url: KAMORI_URL,
    });
    await wrapped(makeRequest("GET", "http://example.com/api/users"));

    expect(logSpy).toHaveBeenCalledOnce();
    const logged = logSpy.mock.calls[0]![0];
    expect(logged["level"]).toBe("info");
  });

  it("logs service=next", async () => {
    const logSpy = vi.spyOn(KamoriClient.prototype, "log");

    const wrapped = withKamori(async (_req) => makeResponse(200), {
      url: KAMORI_URL,
    });
    await wrapped(makeRequest("GET", "http://example.com/api/users"));

    const logged = logSpy.mock.calls[0]![0];
    expect(logged["service"]).toBe("next");
  });

  it("logs the HTTP method", async () => {
    const logSpy = vi.spyOn(KamoriClient.prototype, "log");

    const wrapped = withKamori(async (_req) => makeResponse(200), {
      url: KAMORI_URL,
    });
    await wrapped(makeRequest("POST", "http://example.com/api/events"));

    const logged = logSpy.mock.calls[0]![0];
    expect(logged["method"]).toBe("POST");
  });

  it("logs the response status code", async () => {
    const logSpy = vi.spyOn(KamoriClient.prototype, "log");

    const wrapped = withKamori(async (_req) => makeResponse(201), {
      url: KAMORI_URL,
    });
    await wrapped(makeRequest("POST", "http://example.com/api/events"));

    const logged = logSpy.mock.calls[0]![0];
    expect(logged["status"]).toBe(201);
  });

  it("includes duration_ms as a non-negative number", async () => {
    const logSpy = vi.spyOn(KamoriClient.prototype, "log");

    const wrapped = withKamori(async (_req) => makeResponse(200), {
      url: KAMORI_URL,
    });
    await wrapped(makeRequest("GET", "http://example.com/api/health"));

    const logged = logSpy.mock.calls[0]![0];
    expect(typeof logged["duration_ms"]).toBe("number");
    expect(logged["duration_ms"] as number).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Path extraction — strips query string
// ---------------------------------------------------------------------------

describe("withKamori — path extraction", () => {
  it("logs only the pathname (no query string)", async () => {
    const logSpy = vi.spyOn(KamoriClient.prototype, "log");

    const wrapped = withKamori(async (_req) => makeResponse(200), {
      url: KAMORI_URL,
    });
    await wrapped(
      makeRequest("GET", "http://example.com/api/search?q=secret&token=abc"),
    );

    const logged = logSpy.mock.calls[0]![0];
    expect(logged["path"]).toBe("/api/search");
  });

  it("logs root path correctly", async () => {
    const logSpy = vi.spyOn(KamoriClient.prototype, "log");

    const wrapped = withKamori(async (_req) => makeResponse(200), {
      url: KAMORI_URL,
    });
    await wrapped(makeRequest("GET", "http://example.com/"));

    const logged = logSpy.mock.calls[0]![0];
    expect(logged["path"]).toBe("/");
  });

  it("logs nested path segments correctly", async () => {
    const logSpy = vi.spyOn(KamoriClient.prototype, "log");

    const wrapped = withKamori(async (_req) => makeResponse(200), {
      url: KAMORI_URL,
    });
    await wrapped(makeRequest("DELETE", "http://example.com/api/v2/users/123"));

    const logged = logSpy.mock.calls[0]![0];
    expect(logged["path"]).toBe("/api/v2/users/123");
  });
});

// ---------------------------------------------------------------------------
// Error path — handler throws
// ---------------------------------------------------------------------------

describe("withKamori — handler throws", () => {
  it("re-throws the error after logging", async () => {
    vi.spyOn(KamoriClient.prototype, "log");

    const wrapped = withKamori(
      async (_req) => {
        throw new Error("internal server error");
      },
      { url: KAMORI_URL },
    );

    await expect(
      wrapped(makeRequest("GET", "http://example.com/api/crash")),
    ).rejects.toThrow("internal server error");
  });

  it("logs level=error when the handler throws", async () => {
    const logSpy = vi.spyOn(KamoriClient.prototype, "log");

    const wrapped = withKamori(
      async (_req) => {
        throw new Error("boom");
      },
      { url: KAMORI_URL },
    );

    await expect(
      wrapped(makeRequest("GET", "http://example.com/api/crash")),
    ).rejects.toThrow();

    expect(logSpy).toHaveBeenCalledOnce();
    const logged = logSpy.mock.calls[0]![0];
    expect(logged["level"]).toBe("error");
  });

  it("logs the error message on failure", async () => {
    const logSpy = vi.spyOn(KamoriClient.prototype, "log");

    const wrapped = withKamori(
      async (_req) => {
        throw new Error("database timeout");
      },
      { url: KAMORI_URL },
    );

    await expect(
      wrapped(makeRequest("GET", "http://example.com/api/crash")),
    ).rejects.toThrow();

    const logged = logSpy.mock.calls[0]![0];
    expect(logged["error"]).toBe("database timeout");
  });

  it("logs service=next even on error", async () => {
    const logSpy = vi.spyOn(KamoriClient.prototype, "log");

    const wrapped = withKamori(
      async (_req) => {
        throw new Error("fail");
      },
      { url: KAMORI_URL },
    );

    await expect(
      wrapped(makeRequest("POST", "http://example.com/api/fail")),
    ).rejects.toThrow();

    const logged = logSpy.mock.calls[0]![0];
    expect(logged["service"]).toBe("next");
  });

  it("logs duration_ms on error path", async () => {
    const logSpy = vi.spyOn(KamoriClient.prototype, "log");

    const wrapped = withKamori(
      async (_req) => {
        throw new Error("oops");
      },
      { url: KAMORI_URL },
    );

    await expect(
      wrapped(makeRequest("GET", "http://example.com/api/oops")),
    ).rejects.toThrow();

    const logged = logSpy.mock.calls[0]![0];
    expect(typeof logged["duration_ms"]).toBe("number");
    expect(logged["duration_ms"] as number).toBeGreaterThanOrEqual(0);
  });

  it("handles non-Error thrown values (logs as string)", async () => {
    const logSpy = vi.spyOn(KamoriClient.prototype, "log");

    const wrapped = withKamori(
      async (_req) => {
        throw "string error";
      },
      { url: KAMORI_URL },
    );

    await expect(
      wrapped(makeRequest("GET", "http://example.com/api/str-err")),
    ).rejects.toThrow();

    const logged = logSpy.mock.calls[0]![0];
    expect(logged["error"]).toBe("string error");
  });
});

// ---------------------------------------------------------------------------
// Original handler receives the original request
// ---------------------------------------------------------------------------

describe("withKamori — request passthrough", () => {
  it("passes the original Request object to the inner handler", async () => {
    vi.spyOn(KamoriClient.prototype, "log");

    let receivedRequest: Request | undefined;
    const wrapped = withKamori(
      async (req) => {
        receivedRequest = req;
        return makeResponse(200);
      },
      { url: KAMORI_URL },
    );

    const originalRequest = makeRequest("GET", "http://example.com/api/ping");
    await wrapped(originalRequest);

    expect(receivedRequest).toBe(originalRequest);
  });

  it("returns the response produced by the inner handler unchanged", async () => {
    vi.spyOn(KamoriClient.prototype, "log");

    const innerResponse = makeResponse(204);
    const wrapped = withKamori(async (_req) => innerResponse, {
      url: KAMORI_URL,
    });

    const result = await wrapped(
      makeRequest("DELETE", "http://example.com/api/item/1"),
    );
    expect(result).toBe(innerResponse);
  });
});
