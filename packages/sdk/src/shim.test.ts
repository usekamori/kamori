import { describe, it, expect, vi, afterEach } from "vitest";
import { KamoriClient } from "./client.js";
import { installShim } from "./index.js";

describe("installShim", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Spy on all four console methods (silencing output) and on
   * KamoriClient.prototype.log, then install the shim so it captures
   * the spies as its "original" methods.
   */
  function setup() {
    const original = {
      log: vi.spyOn(console, "log").mockImplementation(() => {}),
      warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
      error: vi.spyOn(console, "error").mockImplementation(() => {}),
      debug: vi.spyOn(console, "debug").mockImplementation(() => {}),
    };
    const clientLog = vi
      .spyOn(KamoriClient.prototype, "log")
      .mockImplementation(() => {});
    installShim({ url: "http://localhost:3110" });
    return { original, clientLog };
  }

  // --- level mapping ---

  it.each([
    ["log", "info"],
    ["warn", "warn"],
    ["error", "error"],
    ["debug", "debug"],
  ] as const)("maps console.%s → level '%s'", (method, level) => {
    const { clientLog } = setup();
    console[method]("test");
    expect(clientLog).toHaveBeenCalledWith(expect.objectContaining({ level }));
  });

  // --- passthrough to original ---

  it("still calls the original console method with all arguments", () => {
    const { original } = setup();
    console.log("hello", 42, { x: 1 });
    expect(original.log).toHaveBeenCalledWith("hello", 42, { x: 1 });
  });

  it("still calls the original even when no arguments are passed", () => {
    const { original } = setup();
    console.warn();
    expect(original.warn).toHaveBeenCalledWith();
  });

  // --- event shape: string first arg ---

  it("sets message from a string first arg", () => {
    const { clientLog } = setup();
    console.log("my message");
    expect(clientLog).toHaveBeenCalledWith({
      level: "info",
      message: "my message",
    });
  });

  it("omits args when the only argument is a string", () => {
    const { clientLog } = setup();
    console.error("boom");
    const event = clientLog.mock.calls[0][0] as Record<string, unknown>;
    expect(event).not.toHaveProperty("args");
  });

  it("includes extra args alongside message when first arg is a string", () => {
    const { clientLog } = setup();
    console.warn("msg", { userId: 1 }, 42);
    expect(clientLog).toHaveBeenCalledWith({
      level: "warn",
      message: "msg",
      args: [{ userId: 1 }, 42],
    });
  });

  // --- event shape: non-string first arg ---

  it("puts all args in args[] when first arg is not a string", () => {
    const { clientLog } = setup();
    console.error({ code: 500 });
    expect(clientLog).toHaveBeenCalledWith({
      level: "error",
      args: [{ code: 500 }],
    });
  });

  it("puts multiple non-string args in args[]", () => {
    const { clientLog } = setup();
    console.debug(1, 2, 3);
    expect(clientLog).toHaveBeenCalledWith({
      level: "debug",
      args: [1, 2, 3],
    });
  });

  it("omits message when first arg is not a string", () => {
    const { clientLog } = setup();
    console.log({ type: "event" });
    const event = clientLog.mock.calls[0][0] as Record<string, unknown>;
    expect(event).not.toHaveProperty("message");
  });

  // --- isolation: each method is independent ---

  it("patches all four methods independently", () => {
    const { clientLog } = setup();
    console.log("a");
    console.warn("b");
    console.error("c");
    console.debug("d");
    expect(clientLog).toHaveBeenCalledTimes(4);
    expect(
      clientLog.mock.calls.map((c) => (c[0] as Record<string, unknown>).level),
    ).toEqual(["info", "warn", "error", "debug"]);
  });
});
