/**
 * Ambient trace context (Node) — an `AsyncLocalStorage`-backed correlation id
 * plus an optional OpenTelemetry bridge. Importing this module registers a
 * resolver on `KamoriClient`, so every event auto-attaches the current
 * `trace_id` when the caller did not set one explicitly.
 *
 * Node-only: imports `node:async_hooks` / `node:module`. The browser entry
 * never imports this file. Pure, runtime-agnostic `traceparent` helpers live in
 * `./trace-context` and are re-exported here for convenience.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import { _setTraceResolver } from "./client.js";
import type { TraceContext } from "./trace-context.js";

export {
  generateTraceId,
  generateSpanId,
  parseTraceparent,
  toTraceparent,
  traceFromHeaders,
} from "./trace-context.js";
export type { TraceContext } from "./trace-context.js";

type Store = Record<string, unknown>;
const als = new AsyncLocalStorage<Store>();

/**
 * Run `fn` with an ambient trace context. Pass a trace id string, or an object
 * of fields (e.g. `{ trace_id, span_id, requestId }`) to merge onto every event
 * logged within the callback — including async continuations.
 *
 * @example
 * withTrace(generateTraceId(), () => {
 *   client.log({ level: "info", message: "handling request" });
 *   // → event carries trace_id automatically
 * });
 */
export function withTrace<T>(idOrFields: string | Store, fn: () => T): T {
  const store: Store =
    typeof idOrFields === "string" ? { trace_id: idOrFields } : { ...idOrFields };
  return als.run(store, fn);
}

/**
 * Merge fields into the current ambient context without wrapping a callback.
 * Effective inside a `withTrace(...)` scope; otherwise it starts a new ambient
 * frame for the remainder of the current async context.
 */
export function setTraceContext(fields: Store): void {
  const store = als.getStore();
  if (store) Object.assign(store, fields);
  else als.enterWith({ ...fields });
}

/** The resolved ambient trace id, if any (ALS first, then the OTel active span). */
export function getTraceId(): string | undefined {
  return resolve()?.trace_id as string | undefined;
}

// --- OpenTelemetry bridge (optional dependency) -----------------------------

const require = createRequire(import.meta.url);
// undefined = not yet attempted; null = unavailable; object = the OTel api.
let otel: unknown;
function loadOtel(): { trace?: unknown } | null {
  if (otel !== undefined) return otel as { trace?: unknown } | null;
  try {
    otel = require("@opentelemetry/api");
  } catch {
    otel = null;
  }
  return otel as { trace?: unknown } | null;
}

const ZERO_TRACE = "00000000000000000000000000000000";
function otelContext(): TraceContext | undefined {
  const api = loadOtel() as
    | { trace?: { getActiveSpan?: () => unknown } }
    | null;
  const span = api?.trace?.getActiveSpan?.() as
    | { spanContext?: () => { traceId?: string; spanId?: string } }
    | undefined;
  const sc = span?.spanContext?.();
  if (!sc?.traceId || sc.traceId === ZERO_TRACE) return undefined;
  return { trace_id: sc.traceId, span_id: sc.spanId };
}

// --- Resolver registration --------------------------------------------------

function resolve(): Store | undefined {
  const store = als.getStore();
  if (store?.trace_id) return store;
  const o = otelContext();
  if (o) return store ? { ...o, ...store } : { ...o };
  return store;
}

// Register with KamoriClient so log() auto-attaches when trace_id is unset.
_setTraceResolver(resolve);
