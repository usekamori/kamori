/**
 * Syslog ingest for Kamori.
 *
 * Accepts RFC 3164 (BSD syslog) and RFC 5424 (IETF syslog) messages over
 * both UDP (dgram) and TCP (net). Parsed messages are batched and inserted
 * into the Kamori database using insertLogs().
 *
 * Enable by setting SYSLOG_PORT > 0 in your environment.
 *
 * Protocol details:
 *   RFC 3164: <PRI>TIMESTAMP HOSTNAME TAG: MSG
 *   RFC 5424: <PRI>VERSION TIMESTAMP HOSTNAME APP-NAME PROCID MSGID SD MSG
 */

import * as dgram from "dgram";
import * as net from "net";
import { insertLogs } from "@usekamori/core";
import type { DbAdapter } from "@usekamori/core";

const SEVERITY_MAP: Record<number, string> = {
  0: "emergency",
  1: "alert",
  2: "critical",
  3: "error",
  4: "warning",
  5: "notice",
  6: "info",
  7: "debug",
};

// RFC 3164 month abbreviations for timestamp parsing
const MONTHS: Record<string, string> = {
  Jan: "01", Feb: "02", Mar: "03", Apr: "04",
  May: "05", Jun: "06", Jul: "07", Aug: "08",
  Sep: "09", Oct: "10", Nov: "11", Dec: "12",
};

/**
 * Parses a raw syslog message string into a structured log event object.
 *
 * Supports both RFC 5424 (IETF syslog, version field = 1) and RFC 3164
 * (BSD syslog, legacy format). If parsing fails entirely the raw string is
 * returned as the message body with level "info".
 *
 * @param raw - The raw syslog message string (without trailing newline).
 * @returns A log event object suitable for passing to insertLogs().
 */
export function parseSyslog(raw: string): Record<string, unknown> {
  // Extract <PRI> from the start of the message
  const priMatch = raw.match(/^<(\d{1,3})>(.*)/s);
  if (!priMatch) {
    return { level: "info", message: raw, raw };
  }

  const pri = parseInt(priMatch[1], 10);
  // RFC 3164/5424: valid PRI range is 0–191 (facility 0–23, severity 0–7).
  // Values outside this range indicate a malformed header; fall back to info.
  if (pri < 0 || pri > 191) {
    return { level: "info", message: raw, raw };
  }
  const facility = Math.floor(pri / 8);
  const severity = pri % 8;
  const level = SEVERITY_MAP[severity] ?? "info";
  const rest = priMatch[2];

  // --- RFC 5424 ---
  // Format: VERSION TIMESTAMP HOSTNAME APP-NAME PROCID MSGID SD MSG
  // The version field is "1"
  const rfc5424Match = rest.match(
    /^1 (\S+) (\S+) (\S+) (\S+) (\S+) (\S+|(?:\[.*?\])*|-) ?(.*)/s
  );
  if (rfc5424Match) {
    const [, timestamp, hostname, appName, , , , msgBody] = rfc5424Match;
    return {
      level,
      service: appName === "-" ? undefined : appName,
      message: msgBody.trim(),
      facility,
      severity,
      hostname: hostname === "-" ? undefined : hostname,
      timestamp: timestamp === "-" ? undefined : timestamp,
      raw,
    };
  }

  // --- RFC 3164 ---
  // Format: MMM DD HH:MM:SS HOSTNAME TAG[PID]: MSG  (or TAG: MSG without PID)
  const rfc3164Match = rest.match(
    /^([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}:\d{2}:\d{2})\s+(\S+)\s+([A-Za-z0-9_/.-]{1,32})(?:\[\d+\])?:\s*(.*)/s
  );
  if (rfc3164Match) {
    const [, month, day, time, hostname, tag, msgBody] = rfc3164Match;
    const mon = MONTHS[month] ?? "01";
    const msgMonthIdx = parseInt(mon, 10) - 1; // 0-indexed
    const now = new Date();
    // Infer year: if the message month is more than ~6 months ahead of the
    // current month it was almost certainly sent in the previous year
    // (e.g. a Dec 31 message arriving on Jan 1 should not get the new year).
    const monthDistance = (msgMonthIdx - now.getMonth() + 12) % 12;
    const year = monthDistance > 6 ? now.getFullYear() - 1 : now.getFullYear();
    const timestamp = `${year}-${mon}-${day.padStart(2, "0")}T${time}`;
    return {
      level,
      service: tag,
      message: msgBody.trim(),
      facility,
      severity,
      hostname,
      timestamp,
      raw,
    };
  }

  // Fall back: return raw string as message
  return { level, message: rest.trim() || raw, facility, severity, raw };
}

/**
 * Starts UDP and TCP syslog servers on the given port and host.
 *
 * Both servers parse incoming messages with parseSyslog() and write them
 * to the Kamori database via insertLogs(). TCP framing uses newline-delimited
 * messages (the most common convention). Individual socket errors are caught
 * so a misbehaving client cannot crash the server.
 *
 * @param port - The UDP/TCP port to listen on (must be > 0).
 * @param adapter - DbAdapter to use for database operations.
 * @param host - Bind address. Defaults to "127.0.0.1" (loopback only).
 *               Pass "0.0.0.0" to accept from all interfaces.
 * @returns An object containing the bound UDP socket and TCP server so the
 *          caller can close them during graceful shutdown.
 */
export function startSyslogServer(
  port: number,
  adapter: DbAdapter,
  host = "127.0.0.1",
): { udp: dgram.Socket; tcp: net.Server } {
  // ---------------------------------------------------------------------------
  // Event batching — collect events and flush every 100 ms or every 100 events.
  // Replaces the previous one-transaction-per-message pattern which created a
  // DB transaction for every syslog line under high-volume senders.
  // ---------------------------------------------------------------------------
  const BATCH_SIZE = 100;
  const BATCH_FLUSH_MS = 100;
  let pending: Record<string, unknown>[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  function enqueue(event: Record<string, unknown>): void {
    pending.push(event);
    if (pending.length >= BATCH_SIZE) {
      flush();
    } else if (!flushTimer) {
      flushTimer = setTimeout(flush, BATCH_FLUSH_MS);
    }
  }

  function flush(): void {
    if (flushTimer !== null) { clearTimeout(flushTimer); flushTimer = null; }
    if (pending.length === 0) return;
    const events = pending.splice(0);
    insertLogs(adapter, events, new Date().toISOString()).catch(() => {});
  }

  // ---------------------------------------------------------------------------
  // UDP server
  // ---------------------------------------------------------------------------
  const udp = dgram.createSocket("udp4");

  // Rate-limit UDP error logging to at most one line per 5 s to prevent a
  // flood of malformed datagrams from spamming stderr.
  let lastUdpErrorMs = 0;
  const UDP_ERROR_THROTTLE_MS = 5_000;

  udp.on("message", (msg) => {
    const raw = msg.toString("utf8").trim();
    if (!raw) return;
    enqueue(parseSyslog(raw));
  });

  udp.on("error", (err) => {
    const now = Date.now();
    if (now - lastUdpErrorMs >= UDP_ERROR_THROTTLE_MS) {
      lastUdpErrorMs = now;
      console.error("Syslog UDP error:", err.message);
    }
  });

  udp.bind(port, host);

  // ---------------------------------------------------------------------------
  // TCP server
  // ---------------------------------------------------------------------------
  // Syslog messages may be framed with newlines (RFC 6587 non-transparent
  // framing) or octet-count prefixes. We handle the newline case which covers
  // the vast majority of real-world senders.

  // 64 KB per connection — well above the RFC 5424 recommended maximum of
  // 8 KB and prevents a stalled connection from holding megabytes of RAM.
  const TCP_BUFFER_LIMIT = 64 * 1024;
  const TCP_SOCKET_TIMEOUT_MS = 30_000;
  const TCP_MAX_CONNECTIONS = 100;
  let tcpConnections = 0;

  const tcp = net.createServer((socket) => {
    // Reject new connections once the limit is reached to prevent resource
    // exhaustion. Unlike HTTP streams there is no 503 response mechanism for
    // raw TCP — just close the socket immediately.
    if (tcpConnections >= TCP_MAX_CONNECTIONS) {
      socket.destroy();
      return;
    }
    tcpConnections++;

    let buffer = "";
    socket.setEncoding("utf8");
    socket.setTimeout(TCP_SOCKET_TIMEOUT_MS);

    socket.on("close", () => {
      tcpConnections = Math.max(0, tcpConnections - 1);
    });

    socket.on("timeout", () => socket.destroy());

    socket.on("data", (chunk) => {
      buffer += chunk;

      // Destroy the socket if a client sends data without newlines to
      // prevent unbounded buffer growth.
      if (Buffer.byteLength(buffer) > TCP_BUFFER_LIMIT) {
        socket.destroy();
        return;
      }

      // Split on newlines — handles newline-framed syslog (most common)
      const lines = buffer.split("\n");
      // Keep the last (possibly partial) line in the buffer
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const raw = line.trim();
        if (!raw) continue;
        enqueue(parseSyslog(raw));
      }
    });

    socket.on("error", () => {
      // Individual socket errors should not crash the server
    });
  });

  tcp.on("error", (err) => {
    console.error("Syslog TCP error:", err.message);
  });

  tcp.listen(port, host);

  console.log(`Syslog server listening on UDP/TCP ${host}:${port}`);
  return { udp, tcp };
}
