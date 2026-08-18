/**
 * Tier 2 — OpenTelemetry bridge. Proves that when an OTel span is active,
 * KamoriClient.log auto-attaches the span's trace_id/span_id, and that the SDK
 * still behaves correctly when no span is active.
 *
 * OTel is a devDependency here; in production it is an optional peer that the
 * SDK loads via a guarded createRequire (see src/trace.ts).
 */
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import {
  context,
  trace,
  TraceFlags,
  type SpanContext,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { KamoriClient } from "./client.js";
// Importing ./trace registers the ambient/OTel resolver on KamoriClient.
import "./trace.js";

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN_ID = "00f067aa0ba902b7";

/** Capture the events a client would POST, without touching the network. */
function captureClient(): { client: KamoriClient; sent: Record<string, unknown>[] } {
  const sent: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", async (_url: string, opts: { body: string }) => {
    sent.push(...(JSON.parse(opts.body) as Record<string, unknown>[]));
    return { ok: true, status: 200 } as Response;
  });
  return { client: new KamoriClient({ url: "https://x.example.com", token: "t" }), sent };
}

beforeAll(() => {
  // A real context manager is required for context.with(...) to propagate the
  // active span to trace.getActiveSpan() inside the SDK.
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenTelemetry bridge (Tier 2)", () => {
  it("attaches trace_id and span_id from the active span", () => {
    const { client, sent } = captureClient();
    const sc: SpanContext = {
      traceId: TRACE_ID,
      spanId: SPAN_ID,
      traceFlags: TraceFlags.SAMPLED,
      isRemote: false,
    };
    const span = trace.wrapSpanContext(sc);

    context.with(trace.setSpan(context.active(), span), () => {
      client.log({ level: "info", message: "in span" });
    });
    client.flush();

    expect(sent[0].trace_id).toBe(TRACE_ID);
    expect(sent[0].span_id).toBe(SPAN_ID);
  });

  it("does not attach a trace_id when no span is active", () => {
    const { client, sent } = captureClient();
    client.log({ level: "info", message: "no span" });
    client.flush();
    expect(sent[0].trace_id).toBeUndefined();
  });

  it("never overrides a user-provided trace_id", () => {
    const { client, sent } = captureClient();
    const span = trace.wrapSpanContext({
      traceId: TRACE_ID,
      spanId: SPAN_ID,
      traceFlags: TraceFlags.SAMPLED,
      isRemote: false,
    });
    context.with(trace.setSpan(context.active(), span), () => {
      client.log({ level: "info", message: "explicit", trace_id: "user-wins" });
    });
    client.flush();
    expect(sent[0].trace_id).toBe("user-wins");
  });
});
