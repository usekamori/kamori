/**
 * startMcp — wire a KamoriAdapters set into the MCP transport layer.
 *
 * Called by both the OSS entrypoint (mcp.ts) and Cloud entrypoints (private
 * repo). Keeps the transport-level code in one place; callers only differ in
 * which adapters they inject.
 *
 * Transport selection:
 *   --stdio flag  → StdioServerTransport  (Claude Code / Cursor spawns process)
 *   default       → Streamable HTTP       (Docker / remote, POST/GET/DELETE /mcp)
 */

import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { randomUUID, createHash, timingSafeEqual } from "crypto";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { KamoriAdapters } from "@usekamori/core";
import { MCP_TOKEN, MCP_PORT } from "@usekamori/core";
import { buildMcpServer } from "./build-mcp-server.js";

/** Timing-safe string comparison to prevent token oracle attacks. */
function safeCompare(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** Extract a bearer token from an Authorization header value. */
function extractBearer(authHeader: string | string[] | undefined): string {
  const raw = Array.isArray(authHeader) ? authHeader[0] : (authHeader ?? "");
  return raw.startsWith("Bearer ") ? raw.slice(7) : "";
}

/**
 * Decode the `exp` claim from a JWT payload without verifying the signature.
 *
 * Used only to schedule a proactive session close at key expiry — the
 * signature is always verified separately by the McpAdapter on each tool call.
 * Returns null for non-JWTs, malformed tokens, or tokens without an exp claim.
 */
export function decodeJwtExpiry(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    return typeof payload.exp === "number" ? payload.exp : null;
  } catch {
    return null;
  }
}

/**
 * Schedule a proactive close of an MCP session transport at JWT expiry.
 *
 * When a session's API key expires mid-conversation the next tool call would
 * throw a confusing "invalid or expired API key" error. Closing the transport
 * at the moment the key expires lets the AI client reconnect cleanly instead.
 *
 * - Safe to call with non-JWT tokens (plain MCP_TOKEN bearer): decodeJwtExpiry
 *   returns null and no timer is set.
 * - Timer is unref()'d so it does not prevent process exit.
 * - If the token is already expired when the session is created the timer is
 *   skipped; the first tool call will throw immediately anyway.
 *
 * @param transport - The session's StreamableHTTPServerTransport instance.
 * @param token     - Raw bearer token from the Authorization header.
 * @param onClose   - Called after transport.close() to clean up session state.
 */
/**
 * Node's setTimeout uses a 32-bit signed integer for the delay, which
 * overflows (~24.8 days) and fires immediately for larger values.
 * API keys are currently issued with a 90-day TTL, well beyond this limit.
 * We skip scheduling when the delay exceeds the safe threshold — the
 * inactivity TTL sweep (1 h) and revocation blocklist already handle
 * long-lived sessions adequately.
 */
const MAX_TIMER_MS = 2_147_483_647; // 2^31 - 1, ~24.8 days

export function scheduleSessionExpiry(
  transport: { close(): Promise<void> },
  token: string,
  onClose: () => void,
): void {
  const exp = decodeJwtExpiry(token);
  if (exp === null) return;

  const msUntilExpiry = exp * 1000 - Date.now();
  if (msUntilExpiry <= 0 || msUntilExpiry > MAX_TIMER_MS) return;

  setTimeout(() => {
    transport.close().catch(() => {});
    onClose();
  }, msUntilExpiry).unref();
}

export async function startMcp(adapters: KamoriAdapters): Promise<void> {
  const useStdio = process.argv.includes("--stdio");

  if (useStdio) {
    // In stdio mode one process = one user. Read the API key / log token from
    // the environment so the McpAdapter can route to the correct project DB.
    const token = process.env.STDIO_TOKEN ?? "";
    const server = buildMcpServer(adapters, token);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    return;
  }

  // ---------------------------------------------------------------------------
  // Streamable HTTP transport — default mode for Docker / remote deployment.
  // Endpoint: POST/GET/DELETE /mcp   Session tracked via Mcp-Session-Id header.
  // ---------------------------------------------------------------------------

  // Max request body size — prevents a gigabyte POST from OOM-ing the process.
  const BODY_LIMIT_BYTES = 4 * 1024 * 1024; // 4 MB

  // Sessions expire after 1 h of inactivity so the Map does not grow without
  // bound in long-running servers with many short-lived AI clients.
  const SESSION_TTL_MS = 60 * 60 * 1_000;
  const SESSION_SWEEP_MS = 5 * 60 * 1_000;

  interface SessionEntry {
    transport: StreamableHTTPServerTransport;
    lastActivityAt: number;
  }
  const sessions = new Map<string, SessionEntry>();

  setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of sessions) {
      if (now - entry.lastActivityAt > SESSION_TTL_MS) {
        entry.transport.close().catch(() => {});
        sessions.delete(id);
      }
    }
  }, SESSION_SWEEP_MS).unref();

  function readBody(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let raw = "";
      let size = 0;
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => {
        size += Buffer.byteLength(chunk, "utf8");
        if (size > BODY_LIMIT_BYTES) {
          req.destroy();
          reject(
            Object.assign(new Error("request body too large"), { code: 413 }),
          );
          return;
        }
        raw += chunk;
      });
      req.on("end", () => {
        if (!raw) {
          resolve(undefined);
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(Object.assign(new Error("invalid JSON body"), { code: 400 }));
        }
      });
      req.on("error", reject);
    });
  }

  function setSecurityHeaders(res: ServerResponse): void {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Permitted-Cross-Domain-Policies", "none");
  }

  const httpServer = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      setSecurityHeaders(res);

      if (req.method === "GET" && req.url === "/health") {
        try {
          await adapters.db.get("SELECT 1");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false }));
        }
        return;
      }

      // Extract the bearer token once — used for both the MCP_TOKEN gate (OSS)
      // and per-session server construction (cloud API key routing).
      const bearerToken = extractBearer(req.headers["authorization"]);

      if (MCP_TOKEN) {
        if (!bearerToken || !safeCompare(bearerToken, MCP_TOKEN)) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "unauthorized" }));
          return;
        }
      }

      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;

      if (pathname === "/mcp") {
        const sessionId = req.headers["mcp-session-id"] as string | undefined;

        if (req.method === "POST") {
          let transport: StreamableHTTPServerTransport;

          if (sessionId && sessions.has(sessionId)) {
            const entry = sessions.get(sessionId)!;
            entry.lastActivityAt = Date.now();
            transport = entry.transport;
          } else if (!sessionId) {
            // Create a new MCP server per session so each session gets its own
            // token context. The McpAdapter uses the token to resolve the correct
            // project DB (cloud) or ignores it (OSS / LocalDbMcpAdapter).
            const sessionServer = buildMcpServer(adapters, bearerToken);
            transport = new StreamableHTTPServerTransport({
              sessionIdGenerator: () => randomUUID(),
              onsessioninitialized: (id) => {
                sessions.set(id, { transport, lastActivityAt: Date.now() });
              },
            });
            transport.onclose = () => {
              if (transport.sessionId) sessions.delete(transport.sessionId);
            };
            await sessionServer.connect(transport);

            // Proactively close the session when the API key expires so the
            // client gets a clean disconnect instead of a mid-conversation
            // "invalid or expired API key" error on the next tool call.
            if (bearerToken) {
              scheduleSessionExpiry(transport, bearerToken, () => {
                if (transport.sessionId) sessions.delete(transport.sessionId);
              });
            }
          } else {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "session not found" }));
            return;
          }

          let body: unknown;
          try {
            body = await readBody(req);
          } catch (err: unknown) {
            const code = (err as { code?: number }).code ?? 400;
            res.writeHead(code, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: (err as Error).message }));
            return;
          }
          await transport.handleRequest(req, res, body);
          return;
        }

        if (req.method === "GET") {
          if (!sessionId || !sessions.has(sessionId)) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "missing or invalid session id" }));
            return;
          }
          const entry = sessions.get(sessionId)!;
          entry.lastActivityAt = Date.now();
          await entry.transport.handleRequest(req, res);
          return;
        }

        if (req.method === "DELETE") {
          if (!sessionId || !sessions.has(sessionId)) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "session not found" }));
            return;
          }
          const entry = sessions.get(sessionId)!;
          await entry.transport.close();
          sessions.delete(sessionId);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
      }

      res.writeHead(404);
      res.end();
    },
  );

  httpServer.listen(MCP_PORT, () => {
    console.log(`MCP server listening on http://0.0.0.0:${MCP_PORT}/mcp`);
  });

  process.on("SIGINT", () => httpServer.close(() => process.exit(0)));
  process.on("SIGTERM", () => httpServer.close(() => process.exit(0)));
}
