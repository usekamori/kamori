/**
 * Web-safe trace helpers — W3C `traceparent` parsing/formatting and id
 * generation. Zero dependencies; safe to import in any runtime (browser, edge,
 * Node). The ambient AsyncLocalStorage context and the OpenTelemetry bridge
 * live in the Node-only `./trace` module.
 */

const ZERO_TRACE = "00000000000000000000000000000000";
const ZERO_SPAN = "0000000000000000";

/** Parsed W3C trace context. */
export interface TraceContext {
  trace_id?: string;
  span_id?: string;
}

/** `n` random bytes as a lowercase hex string. */
function hex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  // globalThis.crypto is present in browsers, edge runtimes, and Node >= 18.
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(arr);
  } else {
    for (let i = 0; i < bytes; i++) arr[i] = Math.floor(Math.random() * 256);
  }
  let s = "";
  for (const b of arr) s += b.toString(16).padStart(2, "0");
  return s;
}

/** Generate a random 32-hex-char trace id. */
export function generateTraceId(): string {
  return hex(16);
}

/** Generate a random 16-hex-char span id. */
export function generateSpanId(): string {
  return hex(8);
}

/**
 * Parse a W3C `traceparent` header (`<version>-<trace>-<span>-<flags>`).
 * Returns undefined for malformed input or an all-zero trace id.
 */
export function parseTraceparent(
  header: string | null | undefined,
): TraceContext | undefined {
  if (!header) return undefined;
  const parts = header.trim().split("-");
  if (parts.length < 4) return undefined;
  const [version, traceId, spanId] = parts;
  if (!/^[0-9a-f]{2}$/.test(version)) return undefined;
  if (!/^[0-9a-f]{32}$/.test(traceId) || traceId === ZERO_TRACE) return undefined;
  const ctx: TraceContext = { trace_id: traceId };
  if (/^[0-9a-f]{16}$/.test(spanId) && spanId !== ZERO_SPAN) ctx.span_id = spanId;
  return ctx;
}

/** Format a `traceparent` header value from a trace id (+ optional span id). */
export function toTraceparent(traceId: string, spanId?: string): string {
  return `00-${traceId}-${spanId ?? generateSpanId()}-01`;
}

/**
 * Resolve an inbound trace id from common headers, in priority order:
 * W3C `traceparent` → `x-request-id` → `x-correlation-id`. Returns undefined if
 * none are present. `get` is any header accessor (Fetch `Headers.get`, a Node
 * `req.headers` lookup, etc.).
 */
export function traceFromHeaders(
  get: (name: string) => string | null | undefined,
): TraceContext | undefined {
  const tp = parseTraceparent(get("traceparent"));
  if (tp) return tp;
  const rid = get("x-request-id") || get("x-correlation-id");
  if (rid) return { trace_id: rid };
  return undefined;
}
