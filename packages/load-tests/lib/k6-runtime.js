import http from "k6/http";
import { check } from "k6";
import { getAuthHeaders, getBaseUrl, getProfileConfig, getTargetTag } from "./config.js";
import { buildIngestPayload } from "./payload.js";

export function getCommonContext() {
  const baseUrl = getBaseUrl(__ENV);
  const authHeaders = getAuthHeaders(__ENV);
  const profile = getProfileConfig(__ENV);
  const target = getTargetTag(__ENV);
  return { baseUrl, authHeaders, profile, target };
}

export function commonThresholds() {
  if (__ENV.DISABLE_THRESHOLDS === "1" || __ENV.DISABLE_THRESHOLDS === "true") {
    return {};
  }
  return {
    http_req_failed: ["rate<0.2"],
    http_req_duration: ["p(95)<3000", "p(99)<6000"],
    checks: ["rate>0.95"],
  };
}

export function ingestOnce(context) {
  const payload = buildIngestPayload({
    rows: context.profile.rowsPerRequest,
    payloadBytes: context.profile.payloadBytes,
  });
  const response = http.post(`${context.baseUrl}/v1/ingest`, JSON.stringify(payload), {
    headers: {
      "content-type": "application/json",
      ...context.authHeaders,
    },
    tags: { target: context.target, endpoint: "ingest" },
  });

  check(response, {
    "ingest status is accepted": (r) => [200, 202, 402, 429, 503].includes(r.status),
  });
  return response;
}

export function readChecks(context) {
  const headers = context.authHeaders;
  const metrics = http.get(`${context.baseUrl}/metrics`, { tags: { target: context.target, endpoint: "metrics" } });
  check(metrics, { "metrics status is 200": (r) => r.status === 200 });

  const logs = http.get(`${context.baseUrl}/v1/logs?limit=50`, {
    headers,
    tags: { target: context.target, endpoint: "logs" },
  });
  check(logs, { "logs status accepted": (r) => [200, 401, 429, 503].includes(r.status) });

  const search = http.get(`${context.baseUrl}/v1/search?q=load-test&limit=50`, {
    headers,
    tags: { target: context.target, endpoint: "search" },
  });
  check(search, { "search status accepted": (r) => [200, 400, 401, 429, 503].includes(r.status) });

  const summary = http.get(`${context.baseUrl}/v1/summary`, {
    headers,
    tags: { target: context.target, endpoint: "summary" },
  });
  check(summary, { "summary status accepted": (r) => [200, 401, 429, 503].includes(r.status) });
}
