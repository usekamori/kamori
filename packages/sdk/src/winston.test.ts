import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { KamoriTransport } from "./winston.js";
import { KamoriClient } from "./client.js";

const URL = "http://localhost:3110";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("KamoriTransport", () => {
  it("has a log method", () => {
    const transport = new KamoriTransport({ url: URL });
    expect(typeof transport.log).toBe("function");
  });

  // Winston's LegacyTransportStream calls log(level, message, meta, callback) with 4 args.
  it("log(level, message, meta, callback) forwards merged event to KamoriClient.log", () => {
    const logSpy = vi
      .spyOn(KamoriClient.prototype, "log")
      .mockImplementation(() => {});
    const transport = new KamoriTransport({ url: URL });

    const meta = { level: "info", message: "server started", port: 3110 };
    transport.log("info", "server started", meta, () => {});

    expect(logSpy).toHaveBeenCalledOnce();
    // handler spreads meta then overlays level + message
    expect(logSpy).toHaveBeenCalledWith({ ...meta, level: "info", message: "server started" });
  });

  it("log(level, message, meta, callback) calls the callback", () => {
    vi.spyOn(KamoriClient.prototype, "log").mockImplementation(() => {});
    const transport = new KamoriTransport({ url: URL });

    const callback = vi.fn();
    transport.log("warn", "disk full", { level: "warn", message: "disk full" }, callback);

    expect(callback).toHaveBeenCalledOnce();
  });

  it("does not throw when constructed without optional fields", () => {
    expect(() => new KamoriTransport({ url: URL })).not.toThrow();
  });

  it("does not throw when log is called with an empty meta object", () => {
    vi.spyOn(KamoriClient.prototype, "log").mockImplementation(() => {});
    const transport = new KamoriTransport({ url: URL });
    expect(() => transport.log("info", "msg", {}, () => {})).not.toThrow();
  });

  it("has the name 'kamori'", () => {
    const transport = new KamoriTransport({ url: URL });
    expect(transport.name).toBe("kamori");
  });

  it("passes token to the underlying KamoriClient", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetch);

    // batchSize:1 so the event flushes immediately
    const transport = new KamoriTransport({
      url: URL,
      token: "tok123",
      batchSize: 1,
    });
    transport.log("info", "test", { level: "info", message: "test" }, () => {});
    await vi.runAllTimersAsync();

    const [, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer tok123",
    );
  });
});
