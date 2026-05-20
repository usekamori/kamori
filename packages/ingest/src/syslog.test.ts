import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import dgram from "dgram";
import net from "net";
import os from "os";
import path from "path";
import { randomBytes } from "crypto";
import fs from "fs";
import { BetterSqliteAdapter, queryLogs } from "@usekamori/core";
import { parseSyslog, startSyslogServer } from "./syslog.js";

// ---------------------------------------------------------------------------
// Helper: ask the OS for a free TCP/UDP port by binding to :0 and reading back.
// ---------------------------------------------------------------------------
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

// Send a UDP datagram and wait for it to be delivered.
function sendUdp(port: number, msg: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket("udp4");
    const buf = Buffer.from(msg);
    sock.send(buf, 0, buf.length, port, "127.0.0.1", (err) => {
      sock.close();
      if (err) reject(err);
      else resolve();
    });
  });
}

// Open a TCP connection, write data, then end it.
function sendTcp(port: number, data: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1", () => {
      sock.write(data, () => sock.end());
    });
    sock.on("close", resolve);
    sock.on("error", reject);
  });
}

describe("parseSyslog", () => {
  it("parses RFC 3164 message", () => {
    const raw =
      "<34>Oct 11 22:14:15 mymachine su: 'su root' failed for lonvick on /dev/pts/8";
    const result = parseSyslog(raw);
    // PRI=34: facility=4 (auth), severity=2 (critical)
    expect(result.level).toBe("critical");
    expect(result.service).toBe("su");
    expect(typeof result.message).toBe("string");
    expect(result.message).toContain("su root");
  });

  it("parses RFC 5424 message", () => {
    const raw =
      "<165>1 2003-10-11T22:14:15.003Z mymachine evntslog - ID47 - An application event logged.";
    const result = parseSyslog(raw);
    // PRI=165: facility=20, severity=5 (notice)
    expect(result.level).toBe("notice");
    expect(result.service).toBe("evntslog");
    expect(result.message).toContain("application event");
  });

  it("maps severity to level correctly", () => {
    // severity 0 = emergency (PRI=0 → facility 0, severity 0)
    expect(parseSyslog("<0>Jan  1 00:00:00 host tag: msg").level).toBe("emergency");
    // severity 3 = error (PRI=3 → facility 0, severity 3)
    expect(parseSyslog("<3>Jan  1 00:00:00 host tag: msg").level).toBe("error");
    // severity 6 = info (PRI=6 → facility 0, severity 6)
    expect(parseSyslog("<6>Jan  1 00:00:00 host tag: msg").level).toBe("info");
    // severity 7 = debug (PRI=7 → facility 0, severity 7)
    expect(parseSyslog("<7>Jan  1 00:00:00 host tag: msg").level).toBe("debug");
  });

  it("falls back gracefully on malformed input", () => {
    const result = parseSyslog("totally invalid syslog message");
    expect(result.level).toBe("info");
    expect(result.message).toBe("totally invalid syslog message");
  });

  it("includes raw field", () => {
    const raw = "<34>Oct 11 22:14:15 host su: msg";
    expect(parseSyslog(raw).raw).toBe(raw);
  });

  it("returns hostname when present in RFC 5424", () => {
    const raw =
      "<165>1 2003-10-11T22:14:15.003Z mymachine evntslog - - - msg";
    expect(parseSyslog(raw).hostname).toBe("mymachine");
  });

  it("returns undefined hostname when hostname is nil (-) in RFC 5424", () => {
    const raw = "<165>1 2003-10-11T22:14:15.003Z - evntslog - - - msg";
    expect(parseSyslog(raw).hostname).toBeUndefined();
  });

  it("returns facility and severity as numbers", () => {
    // PRI=34: facility=4, severity=2
    const result = parseSyslog(
      "<34>Oct 11 22:14:15 mymachine su: msg"
    );
    expect(result.facility).toBe(4);
    expect(result.severity).toBe(2);
  });

  it("sets raw field on RFC 5424 message", () => {
    const raw =
      "<165>1 2003-10-11T22:14:15.003Z mymachine evntslog - ID47 - msg";
    expect(parseSyslog(raw).raw).toBe(raw);
  });

  it("falls back with level from pri when no timestamp/host pattern matches", () => {
    // Has valid PRI but no recognisable timestamp — falls through to the catch-all
    const raw = "<22>some unstructured content here";
    const result = parseSyslog(raw);
    // PRI=22: facility=2, severity=6 → info
    expect(result.level).toBe("info");
    expect(result.severity).toBe(6);
    expect(result.raw).toBe(raw);
  });
});

// ---------------------------------------------------------------------------
// startSyslogServer
// ---------------------------------------------------------------------------

describe("startSyslogServer", () => {
  let dbPath: string;
  let adapter: BetterSqliteAdapter;
  let sockets: { udp: dgram.Socket; tcp: net.Server } | null = null;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `syslog-srv-test-${randomBytes(8).toString("hex")}.db`);
    adapter = new BetterSqliteAdapter(dbPath);
  });

  afterEach(async () => {
    if (sockets) {
      await new Promise<void>((r) => sockets!.udp.close(() => r()));
      await new Promise<void>((r) => sockets!.tcp.close(() => r()));
      sockets = null;
    }
    for (const suffix of ["", "-wal", "-shm"]) {
      try { fs.unlinkSync(dbPath + suffix); } catch {}
    }
  });

  it("accepts a UDP syslog message and inserts it into the DB", async () => {
    const port = await freePort();
    sockets = startSyslogServer(port, adapter);

    await sendUdp(port, "<34>Oct 11 22:14:15 host su: udp-test-message");
    // Wait for the 100 ms batch flush
    await new Promise((r) => setTimeout(r, 250));

    const rows = await queryLogs(adapter, {});
    expect(rows.some((r) => r.body.includes("udp-test-message"))).toBe(true);
  });

  it("accepts a TCP syslog message and inserts it into the DB", async () => {
    const port = await freePort();
    sockets = startSyslogServer(port, adapter);

    await sendTcp(port, "<34>Oct 11 22:14:15 host su: tcp-test-message\n");
    await new Promise((r) => setTimeout(r, 250));

    const rows = await queryLogs(adapter, {});
    expect(rows.some((r) => r.body.includes("tcp-test-message"))).toBe(true);
  });

  it("parses multiple newline-delimited TCP messages in one chunk", async () => {
    const port = await freePort();
    sockets = startSyslogServer(port, adapter);

    await sendTcp(
      port,
      "<34>Oct 11 22:14:15 host app: first-msg\n<35>Oct 11 22:14:16 host app: second-msg\n"
    );
    await new Promise((r) => setTimeout(r, 250));

    const rows = await queryLogs(adapter, {});
    const bodies = rows.map((r) => r.body);
    expect(bodies.some((b) => b.includes("first-msg"))).toBe(true);
    expect(bodies.some((b) => b.includes("second-msg"))).toBe(true);
  });

  it("ignores empty UDP messages", async () => {
    const port = await freePort();
    sockets = startSyslogServer(port, adapter);

    await sendUdp(port, "   ");
    await new Promise((r) => setTimeout(r, 250));

    const rows = await queryLogs(adapter, {});
    expect(rows).toHaveLength(0);
  });

  it("flushes immediately when batch size reaches 100", async () => {
    vi.useFakeTimers();
    const port = await freePort();
    sockets = startSyslogServer(port, adapter);

    // Send 100 UDP messages — should trigger an immediate flush without needing the timer
    const sends = Array.from({ length: 100 }, (_, i) =>
      sendUdp(port, `<34>Oct 11 22:14:15 host app: batch-msg-${i}`)
    );
    await Promise.all(sends);

    // Advance time slightly to allow UDP event loop callbacks to fire
    await vi.runAllTimersAsync();
    vi.useRealTimers();

    // Give the real event loop a tick to process
    await new Promise((r) => setTimeout(r, 100));

    const rows = await queryLogs(adapter, {});
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it("destroys TCP socket when buffer exceeds 64 KB", async () => {
    const port = await freePort();
    sockets = startSyslogServer(port, adapter);

    const sock = net.connect(port, "127.0.0.1");
    await new Promise<void>((r) => sock.on("connect", r));

    // Write >64 KB without any newline to overflow the buffer limit
    const chunk = "x".repeat(65 * 1024);
    sock.write(chunk);

    // Server should destroy the socket; client will see close
    await new Promise<void>((r) => sock.on("close", r));
    // Assertion: socket closed — no throw means the server handled it gracefully
  });

  it("handles a TCP socket error without crashing the server", async () => {
    const port = await freePort();
    sockets = startSyslogServer(port, adapter);

    const sock = net.connect(port, "127.0.0.1");
    sock.on("error", () => {}); // prevent uncaught-exception on client side
    await new Promise<void>((r) => sock.on("connect", r));
    // Abruptly destroy to trigger socket error on server side
    sock.destroy();
    // Give server a tick to handle
    await new Promise((r) => setTimeout(r, 50));
    // Server is still listening if no throw occurred
    expect(sockets.tcp.listening).toBe(true);
  });

  it("handles TCP server-level errors without crashing", async () => {
    const port = await freePort();
    sockets = startSyslogServer(port, adapter);

    // Wait for the server to finish binding before emitting a synthetic error.
    // With an explicit host argument the bind is async; emitting before listening
    // fires would observe listening=false regardless of error handling.
    await new Promise<void>((resolve) => {
      if (sockets!.tcp.listening) return resolve();
      sockets!.tcp.once("listening", resolve);
    });

    // Emit a synthetic error directly on the TCP server instance.
    // The server's 'error' handler should swallow it and stay listening.
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    sockets.tcp.emit("error", new Error("synthetic tcp server error"));
    consoleSpy.mockRestore();

    expect(sockets.tcp.listening).toBe(true);
  });

  it("binds to 127.0.0.1 by default (loopback only)", async () => {
    const port = await freePort();
    sockets = startSyslogServer(port, adapter);

    // TCP server should be bound to 127.0.0.1
    await new Promise<void>((resolve) => {
      if (sockets!.tcp.listening) return resolve();
      sockets!.tcp.once("listening", resolve);
    });
    const addr = sockets.tcp.address();
    expect(typeof addr === "object" && addr !== null && addr.address).toBe("127.0.0.1");
  });

  it("binds to a custom host when specified", async () => {
    const port = await freePort();
    sockets = startSyslogServer(port, adapter, "0.0.0.0");

    await new Promise<void>((resolve) => {
      if (sockets!.tcp.listening) return resolve();
      sockets!.tcp.once("listening", resolve);
    });
    const addr = sockets.tcp.address();
    expect(typeof addr === "object" && addr !== null && addr.address).toBe("0.0.0.0");
  });

  it("rejects TCP connections beyond the 100-connection limit", async () => {
    const port = await freePort();
    sockets = startSyslogServer(port, adapter);

    // Open 100 connections and keep them open
    const openSockets: net.Socket[] = [];
    for (let i = 0; i < 100; i++) {
      const s = net.connect(port, "127.0.0.1");
      openSockets.push(s);
      await new Promise<void>((r) => s.on("connect", r));
    }

    // The 101st connection should be destroyed by the server
    const extra = net.connect(port, "127.0.0.1");
    const closed = await new Promise<boolean>((r) => {
      extra.on("close", () => r(true));
      extra.on("error", () => r(true));
      setTimeout(() => r(false), 500);
    });
    expect(closed).toBe(true);

    // Clean up
    openSockets.forEach((s) => s.destroy());
  });
});
