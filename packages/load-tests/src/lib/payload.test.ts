import { describe, expect, it } from "vitest";
import { buildIngestPayload } from "./payload.js";

describe("payload generator", () => {
  it("builds a batch payload with requested row count", () => {
    expect(buildIngestPayload({ rows: 3, payloadBytes: 256 }).length).toBe(3);
  });

  it("includes service and level for indexed fields", () => {
    const row = buildIngestPayload({ rows: 1, payloadBytes: 256 })[0];

    expect(row.service).toBe("load-test");
    expect(row.level).toBe("info");
  });

  it("roughly meets requested payload size", () => {
    const size = JSON.stringify(buildIngestPayload({ rows: 1, payloadBytes: 1024 })[0]).length;

    expect(size >= 900).toBe(true);
  });
});
