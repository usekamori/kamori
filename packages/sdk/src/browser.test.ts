/**
 * Tests for packages/sdk/src/browser.ts (MKR-66).
 *
 * Because vitest runs in Node.js, browser globals (window, ErrorEvent,
 * PromiseRejectionEvent) are not present by default. Where needed we
 * use vi.stubGlobal to inject minimal fakes. Tests are kept simple and
 * focused on observable behaviour rather than DOM simulation.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  KamoriClient,
  ScopedKamoriClient,
  installErrorCapture,
} from "./browser.js";
import type { ErrorCaptureOptions } from "./browser.js";

// ---------------------------------------------------------------------------
// Re-exports from client.ts
// ---------------------------------------------------------------------------

describe("browser re-exports", () => {
  it("exports KamoriClient", () => {
    expect(KamoriClient).toBeDefined();
  });

  it("exports ScopedKamoriClient", () => {
    expect(ScopedKamoriClient).toBeDefined();
  });

  it("KamoriClient is a constructor", () => {
    expect(typeof KamoriClient).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// installErrorCapture — shape and return value
// ---------------------------------------------------------------------------

describe("installErrorCapture", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is a function", () => {
    expect(typeof installErrorCapture).toBe("function");
  });

  it("returns a cleanup function when called with a mock window", () => {
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });

    const client = new KamoriClient({ url: "http://localhost:3110" });
    const cleanup = installErrorCapture(client);

    expect(typeof cleanup).toBe("function");
  });

  it("registers error and unhandledrejection listeners by default", () => {
    const addEventListener = vi.fn();
    vi.stubGlobal("window", { addEventListener, removeEventListener: vi.fn() });

    const client = new KamoriClient({ url: "http://localhost:3110" });
    installErrorCapture(client);

    const registeredEvents = addEventListener.mock.calls.map(
      ([event]) => event as string,
    );
    expect(registeredEvents).toContain("error");
    expect(registeredEvents).toContain("unhandledrejection");
  });

  it("skips unhandledrejection listener when captureUnhandledRejections is false", () => {
    const addEventListener = vi.fn();
    vi.stubGlobal("window", { addEventListener, removeEventListener: vi.fn() });

    const client = new KamoriClient({ url: "http://localhost:3110" });
    const opts: ErrorCaptureOptions = { captureUnhandledRejections: false };
    installErrorCapture(client, opts);

    const registeredEvents = addEventListener.mock.calls.map(
      ([event]) => event as string,
    );
    expect(registeredEvents).toContain("error");
    expect(registeredEvents).not.toContain("unhandledrejection");
  });

  it("cleanup function removes the same number of listeners it added", () => {
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    vi.stubGlobal("window", { addEventListener, removeEventListener });

    const client = new KamoriClient({ url: "http://localhost:3110" });
    const cleanup = installErrorCapture(client);
    cleanup();

    // Both addEventListener and removeEventListener should be called with the same events.
    const added = addEventListener.mock.calls
      .map(([event]) => event as string)
      .sort();
    const removed = removeEventListener.mock.calls
      .map(([event]) => event as string)
      .sort();
    expect(added).toEqual(removed);
  });

  it("cleanup removes only unhandledrejection when captureUnhandledRejections is false", () => {
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    vi.stubGlobal("window", { addEventListener, removeEventListener });

    const client = new KamoriClient({ url: "http://localhost:3110" });
    const cleanup = installErrorCapture(client, {
      captureUnhandledRejections: false,
    });
    cleanup();

    const removed = removeEventListener.mock.calls.map(
      ([event]) => event as string,
    );
    expect(removed).toContain("error");
    expect(removed).not.toContain("unhandledrejection");
  });
});

// ---------------------------------------------------------------------------
// installErrorCapture — error listener calls client.log
// ---------------------------------------------------------------------------

describe("installErrorCapture — error events call client.log", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("calls client.log with level=error and type=uncaught_error when error event fires", () => {
    // Capture the registered listener so we can invoke it directly.
    let capturedErrorListener: ((e: unknown) => void) | undefined;

    vi.stubGlobal("window", {
      addEventListener: vi.fn(
        (event: string, listener: (e: unknown) => void) => {
          if (event === "error") capturedErrorListener = listener;
        },
      ),
      removeEventListener: vi.fn(),
    });

    const client = new KamoriClient({ url: "http://localhost:3110" });
    const logSpy = vi.spyOn(client, "log");
    installErrorCapture(client);

    // Simulate an ErrorEvent-like object.
    capturedErrorListener!({
      message: "Something broke",
      filename: "app.js",
      lineno: 42,
      colno: 1,
      error: new Error("Something broke"),
    });

    expect(logSpy).toHaveBeenCalledOnce();
    const logged = logSpy.mock.calls[0]![0];
    expect(logged["level"]).toBe("error");
    expect(logged["type"]).toBe("uncaught_error");
    expect(logged["message"]).toBe("Something broke");
    expect(logged["_source"]).toBe("app.js:42");
  });

  it("calls client.log with level=error and type=unhandled_rejection when rejection fires", () => {
    let capturedRejectionListener: ((e: unknown) => void) | undefined;

    vi.stubGlobal("window", {
      addEventListener: vi.fn(
        (event: string, listener: (e: unknown) => void) => {
          if (event === "unhandledrejection")
            capturedRejectionListener = listener;
        },
      ),
      removeEventListener: vi.fn(),
    });

    const client = new KamoriClient({ url: "http://localhost:3110" });
    const logSpy = vi.spyOn(client, "log");
    installErrorCapture(client);

    const rejectionError = new Error("promise rejected");
    capturedRejectionListener!({ reason: rejectionError });

    expect(logSpy).toHaveBeenCalledOnce();
    const logged = logSpy.mock.calls[0]![0];
    expect(logged["level"]).toBe("error");
    expect(logged["type"]).toBe("unhandled_rejection");
    expect(logged["message"]).toBe("promise rejected");
    expect(logged["stack"]).toBe(rejectionError.stack);
  });

  it("handles non-Error rejection reasons as strings", () => {
    let capturedRejectionListener: ((e: unknown) => void) | undefined;

    vi.stubGlobal("window", {
      addEventListener: vi.fn(
        (event: string, listener: (e: unknown) => void) => {
          if (event === "unhandledrejection")
            capturedRejectionListener = listener;
        },
      ),
      removeEventListener: vi.fn(),
    });

    const client = new KamoriClient({ url: "http://localhost:3110" });
    const logSpy = vi.spyOn(client, "log");
    installErrorCapture(client);

    capturedRejectionListener!({ reason: "string reason" });

    const logged = logSpy.mock.calls[0]![0];
    expect(logged["message"]).toBe("string reason");
    expect(logged["stack"]).toBeUndefined();
  });

  it("omits _source when filename is missing from error event", () => {
    let capturedErrorListener: ((e: unknown) => void) | undefined;

    vi.stubGlobal("window", {
      addEventListener: vi.fn(
        (event: string, listener: (e: unknown) => void) => {
          if (event === "error") capturedErrorListener = listener;
        },
      ),
      removeEventListener: vi.fn(),
    });

    const client = new KamoriClient({ url: "http://localhost:3110" });
    const logSpy = vi.spyOn(client, "log");
    installErrorCapture(client);

    capturedErrorListener!({
      message: "no source",
      filename: "",
      lineno: 0,
      colno: 0,
      error: null,
    });

    const logged = logSpy.mock.calls[0]![0];
    // When filename is falsy, _source should be undefined
    expect(logged["_source"]).toBeUndefined();
  });
});
