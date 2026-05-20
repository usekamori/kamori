import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Writable } from "stream";
import { createKamoriStream } from "./pino.js";
import { KamoriClient } from "./client.js";

const URL = "http://localhost:3110";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("createKamoriStream", () => {
  it("returns a Writable stream", () => {
    const stream = createKamoriStream({ url: URL });
    expect(stream).toBeInstanceOf(Writable);
  });

  it("writing a JSON line calls KamoriClient.log with the parsed object", async () => {
    const logSpy = vi
      .spyOn(KamoriClient.prototype, "log")
      .mockImplementation(() => {});
    const stream = createKamoriStream({ url: URL });

    await new Promise<void>((resolve) => {
      stream.write('{"level":"info","message":"hello"}\n', () => resolve());
    });

    expect(logSpy).toHaveBeenCalledOnce();
    expect(logSpy).toHaveBeenCalledWith({ level: "info", message: "hello" });
  });

  it("writing malformed JSON does not throw and does not call log", async () => {
    const logSpy = vi
      .spyOn(KamoriClient.prototype, "log")
      .mockImplementation(() => {});
    const stream = createKamoriStream({ url: URL });

    // Should resolve without throwing
    await new Promise<void>((resolve) => {
      stream.write("not valid json\n", () => resolve());
    });

    expect(logSpy).not.toHaveBeenCalled();
  });

  it("writing multiple JSON lines in one chunk handles each line", async () => {
    const logSpy = vi
      .spyOn(KamoriClient.prototype, "log")
      .mockImplementation(() => {});
    const stream = createKamoriStream({ url: URL });

    const chunk =
      [
        '{"level":"info","message":"first"}',
        '{"level":"warn","message":"second"}',
        '{"level":"error","message":"third"}',
      ].join("\n") + "\n";

    await new Promise<void>((resolve) => {
      stream.write(chunk, () => resolve());
    });

    expect(logSpy).toHaveBeenCalledTimes(3);
    expect(logSpy).toHaveBeenNthCalledWith(1, {
      level: "info",
      message: "first",
    });
    expect(logSpy).toHaveBeenNthCalledWith(2, {
      level: "warn",
      message: "second",
    });
    expect(logSpy).toHaveBeenNthCalledWith(3, {
      level: "error",
      message: "third",
    });
  });

  it("empty lines within a chunk are skipped without error", async () => {
    const logSpy = vi
      .spyOn(KamoriClient.prototype, "log")
      .mockImplementation(() => {});
    const stream = createKamoriStream({ url: URL });

    // Leading/trailing newlines produce empty lines when split
    const chunk = '\n{"level":"debug","message":"only"}\n\n';

    await new Promise<void>((resolve) => {
      stream.write(chunk, () => resolve());
    });

    expect(logSpy).toHaveBeenCalledOnce();
    expect(logSpy).toHaveBeenCalledWith({ level: "debug", message: "only" });
  });
});
