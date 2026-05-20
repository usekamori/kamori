import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { KamoriClient, ScopedKamoriClient } from "./client.js";

const EVENTS = [{ service: "api", level: "error", message: "boom" }];
const URL = "http://localhost:3110";

function makeClient() {
  return new KamoriClient({ url: URL, batchSize: 1, flushInterval: 9999 });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Success path
// ---------------------------------------------------------------------------

describe("successful send", () => {
  it("POSTs to /v1/ingest with the event batch", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetch);

    makeClient().log(EVENTS[0]);
    await vi.runAllTimersAsync();

    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${URL}/v1/ingest`);
    expect(JSON.parse(init.body as string)).toEqual(EVENTS);
  });

  it("sends Authorization header when token is set", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetch);

    new KamoriClient({ url: URL, token: "secret", batchSize: 1 }).log(EVENTS[0]);
    await vi.runAllTimersAsync();

    const [, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer secret",
    );
  });

  it("does not retry on success", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetch);

    makeClient().log(EVENTS[0]);
    await vi.runAllTimersAsync();

    expect(fetch).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Retry on network error
// ---------------------------------------------------------------------------

describe("retry on network error", () => {
  it("retries after 250ms on first failure", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetch);

    makeClient().log(EVENTS[0]);
    await vi.advanceTimersByTimeAsync(0); // initial attempt
    expect(fetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(250); // retry 1 fires
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("retries after 1000ms on second failure", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("net"))
      .mockRejectedValueOnce(new Error("net"))
      .mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetch);

    makeClient().log(EVENTS[0]);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(250); // retry 1
    expect(fetch).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1000); // retry 2 fires
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("retries after 4000ms on third failure", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("net"))
      .mockRejectedValueOnce(new Error("net"))
      .mockRejectedValueOnce(new Error("net"))
      .mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetch);

    makeClient().log(EVENTS[0]);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(250);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetch).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(4000); // retry 3 fires
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("drops and emits 'drop' after 3 retries are exhausted", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("net"));
    vi.stubGlobal("fetch", fetch);

    const client = makeClient();
    const dropped = vi.fn();
    client.on("drop", dropped);
    client.log(EVENTS[0]);

    await vi.advanceTimersByTimeAsync(0); // attempt 1
    await vi.advanceTimersByTimeAsync(250); // attempt 2
    await vi.advanceTimersByTimeAsync(1000); // attempt 3
    await vi.advanceTimersByTimeAsync(4000); // attempt 4 — final

    expect(fetch).toHaveBeenCalledTimes(4);
    expect(dropped).toHaveBeenCalledOnce();
    expect(dropped).toHaveBeenCalledWith(EVENTS);
  });

  it("does not call drop handler if no retries are registered", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("net"));
    vi.stubGlobal("fetch", fetch);

    // Should not throw even with no handler registered
    const client = makeClient();
    client.log(EVENTS[0]);
    await vi.runAllTimersAsync();
    expect(fetch).toHaveBeenCalledTimes(4);
  });
});

// ---------------------------------------------------------------------------
// Retry on 5xx
// ---------------------------------------------------------------------------

describe("retry on 5xx", () => {
  it("retries on 503", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetch);

    makeClient().log(EVENTS[0]);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(250);

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("drops after 3 retries on persistent 500", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    vi.stubGlobal("fetch", fetch);

    const client = makeClient();
    const dropped = vi.fn();
    client.on("drop", dropped);
    client.log(EVENTS[0]);

    await vi.runAllTimersAsync();

    expect(fetch).toHaveBeenCalledTimes(4);
    expect(dropped).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// No retry on 4xx
// ---------------------------------------------------------------------------

describe("no retry on 4xx", () => {
  it("drops immediately on 401 without retrying", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    vi.stubGlobal("fetch", fetch);

    const client = makeClient();
    const dropped = vi.fn();
    client.on("drop", dropped);
    client.log(EVENTS[0]);

    await vi.runAllTimersAsync();

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(dropped).toHaveBeenCalledOnce();
  });

  it("drops immediately on 400", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: false, status: 400 });
    vi.stubGlobal("fetch", fetch);

    const client = makeClient();
    const dropped = vi.fn();
    client.on("drop", dropped);
    client.log(EVENTS[0]);

    await vi.runAllTimersAsync();

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(dropped).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// 'drop' event — multiple handlers
// ---------------------------------------------------------------------------

describe("drop event", () => {
  it("calls all registered drop handlers", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("net"));
    vi.stubGlobal("fetch", fetch);

    const client = makeClient();
    const h1 = vi.fn();
    const h2 = vi.fn();
    client.on("drop", h1).on("drop", h2);
    client.log(EVENTS[0]);

    await vi.runAllTimersAsync();

    expect(h1).toHaveBeenCalledOnce();
    expect(h2).toHaveBeenCalledOnce();
  });

  it("passes the original event batch to the drop handler", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("net"));
    vi.stubGlobal("fetch", fetch);

    const batch = [{ a: 1 }, { b: 2 }];
    const client = new KamoriClient({ url: URL, batchSize: 2 });
    const dropped = vi.fn();
    client.on("drop", dropped);
    client.log(batch[0]);
    client.log(batch[1]); // triggers flush at batchSize

    await vi.runAllTimersAsync();

    expect(dropped).toHaveBeenCalledWith(batch);
  });

  it("on() returns this for chaining", () => {
    const client = makeClient();
    expect(client.on("drop", () => {})).toBe(client);
  });
});

// ---------------------------------------------------------------------------
// flushOnExit (MKR-56)
// ---------------------------------------------------------------------------

describe("flushOnExit", () => {
  it("flushOnExit defaults to false — does not register process handlers", () => {
    const onSpy = vi.spyOn(process, "on");
    // Create a client without flushOnExit (default false)
    new KamoriClient({ url: URL });
    // process.on should not have been called for exit/SIGINT/SIGTERM
    const exitCalls = onSpy.mock.calls.filter(([event]) =>
      ["exit", "SIGINT", "SIGTERM"].includes(event as string),
    );
    expect(exitCalls).toHaveLength(0);
  });

  it("flush() sends buffered events when called before exit", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetch);

    const client = new KamoriClient({ url: URL, flushOnExit: true });
    client.log({ message: "about to exit" });
    client.flush();
    await vi.runAllTimersAsync();

    expect(fetch).toHaveBeenCalledOnce();
    const [, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual([
      { message: "about to exit" },
    ]);
  });

  it("flushOnExit option is stored on the instance", () => {
    const client = new KamoriClient({ url: URL, flushOnExit: true });
    // Access via bracket notation to test private field indirectly
    expect((client as unknown as Record<string, unknown>)["flushOnExit"]).toBe(
      true,
    );
  });

  it("flush() is a no-op when the buffer is empty", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetch);

    const client = new KamoriClient({ url: URL });
    client.flush(); // buffer is empty
    await vi.runAllTimersAsync();

    expect(fetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// captureSource (MKR-69)
// ---------------------------------------------------------------------------

describe("captureSource", () => {
  it("captureSource: false (default) does not add _source field", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetch);

    const client = new KamoriClient({ url: URL, batchSize: 1 });
    client.log({ message: "hello" });
    await vi.runAllTimersAsync();

    const body = JSON.parse(
      (fetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as Record<string, unknown>[];
    expect(body[0]).not.toHaveProperty("_source");
  });

  it("captureSource: true always adds _source field", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetch);

    const client = new KamoriClient({
      url: URL,
      batchSize: 1,
      captureSource: true,
    });
    client.log({ message: "hello" });
    await vi.runAllTimersAsync();

    const body = JSON.parse(
      (fetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as Record<string, unknown>[];
    expect(body[0]).toHaveProperty("_source");
  });

  it("_source format is 'file:line' (contains a colon followed by a number)", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetch);

    const client = new KamoriClient({
      url: URL,
      batchSize: 1,
      captureSource: true,
    });
    client.log({ message: "trace me" });
    await vi.runAllTimersAsync();

    const body = JSON.parse(
      (fetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as Record<string, unknown>[];
    const source = body[0]["_source"] as string | null;
    // source may be null if the environment doesn't expose a usable stack frame,
    // but when present it must match "file:line"
    if (source !== null) {
      expect(source).toMatch(/:.+\d+$/);
    }
  });

  it("captureSource: 'auto' adds _source when NODE_ENV !== 'production'", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetch);

    const originalEnv = process.env["NODE_ENV"];
    process.env["NODE_ENV"] = "development";

    try {
      const client = new KamoriClient({
        url: URL,
        batchSize: 1,
        captureSource: "auto",
      });
      client.log({ message: "dev log" });
      await vi.runAllTimersAsync();

      const body = JSON.parse(
        (fetch.mock.calls[0] as [string, RequestInit])[1].body as string,
      ) as Record<string, unknown>[];
      expect(body[0]).toHaveProperty("_source");
    } finally {
      process.env["NODE_ENV"] = originalEnv;
    }
  });

  it("captureSource: 'auto' does NOT add _source in production", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetch);

    const originalEnv = process.env["NODE_ENV"];
    process.env["NODE_ENV"] = "production";

    try {
      const client = new KamoriClient({
        url: URL,
        batchSize: 1,
        captureSource: "auto",
      });
      client.log({ message: "prod log" });
      await vi.runAllTimersAsync();

      const body = JSON.parse(
        (fetch.mock.calls[0] as [string, RequestInit])[1].body as string,
      ) as Record<string, unknown>[];
      expect(body[0]).not.toHaveProperty("_source");
    } finally {
      process.env["NODE_ENV"] = originalEnv;
    }
  });
});

// ---------------------------------------------------------------------------
// scoped() helper + ScopedKamoriClient (MKR-89)
// ---------------------------------------------------------------------------

describe("scoped()", () => {
  it("returns a ScopedKamoriClient instance", () => {
    const client = makeClient();
    const scoped = client.scoped({ service: "api" });
    expect(scoped).toBeInstanceOf(ScopedKamoriClient);
  });

  it("merges defaults into every logged event", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetch);

    const client = new KamoriClient({ url: URL, batchSize: 1 });
    const scoped = client.scoped({ service: "api", env: "prod" });
    scoped.log({ message: "request handled" });
    await vi.runAllTimersAsync();

    const body = JSON.parse(
      (fetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as Record<string, unknown>[];
    expect(body[0]).toMatchObject({
      service: "api",
      env: "prod",
      message: "request handled",
    });
  });

  it("passed fields override defaults", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetch);

    const client = new KamoriClient({ url: URL, batchSize: 1 });
    const scoped = client.scoped({ service: "api", level: "info" });
    scoped.log({ level: "error", message: "override" });
    await vi.runAllTimersAsync();

    const body = JSON.parse(
      (fetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as Record<string, unknown>[];
    expect(body[0]["level"]).toBe("error");
    expect(body[0]["service"]).toBe("api");
  });

  it("scoped client shares the parent buffer (events appear in the same batch)", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetch);

    // batchSize:2 so both events flush together
    const client = new KamoriClient({ url: URL, batchSize: 2 });
    const scoped = client.scoped({ service: "api" });

    client.log({ message: "direct" });
    scoped.log({ message: "scoped" }); // triggers flush at batchSize 2
    await vi.runAllTimersAsync();

    expect(fetch).toHaveBeenCalledOnce(); // single batch
    const body = JSON.parse(
      (fetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as Record<string, unknown>[];
    expect(body).toHaveLength(2);
  });

  it("nested scoped() merges both levels of defaults", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetch);

    const client = new KamoriClient({ url: URL, batchSize: 1 });
    const level1 = client.scoped({ service: "api" });
    const level2 = level1.scoped({ region: "us-east-1" });
    level2.log({ message: "nested" });
    await vi.runAllTimersAsync();

    const body = JSON.parse(
      (fetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as Record<string, unknown>[];
    expect(body[0]).toMatchObject({
      service: "api",
      region: "us-east-1",
      message: "nested",
    });
  });

  it("nested scoped() also returns a ScopedKamoriClient", () => {
    const client = makeClient();
    const level1 = client.scoped({ service: "api" });
    const level2 = level1.scoped({ region: "us-east-1" });
    expect(level2).toBeInstanceOf(ScopedKamoriClient);
  });
});
