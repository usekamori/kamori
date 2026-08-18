import { describe, it, expect, vi } from "vitest";
import { handleQuerySql } from "./tools.js";
import type { DbAdapter } from "@usekamori/core";

/** Minimal DbAdapter mock — no real database. */
function mockAdapter(overrides: Partial<DbAdapter> = {}): DbAdapter {
  return {
    run: vi.fn(),
    query: vi.fn().mockResolvedValue([{ n: 1 }]),
    get: vi.fn(),
    batch: vi.fn(),
    exec: vi.fn(),
    readonlyQuery: vi.fn().mockResolvedValue([{ n: 1 }]),
    ...overrides,
  } as unknown as DbAdapter;
}

describe("handleQuerySql — read-only enforcement", () => {
  it("runs the statement through readonlyQuery, not query", async () => {
    const a = mockAdapter();
    const res = await handleQuerySql(a, { sql: "SELECT COUNT(*) as n FROM logs" });
    expect(a.readonlyQuery).toHaveBeenCalledOnce();
    expect(a.query).not.toHaveBeenCalled();
    expect(res.content[0].text).toContain("n");
  });

  it("wraps the query with a subquery + LIMIT", async () => {
    const a = mockAdapter();
    await handleQuerySql(a, { sql: "SELECT * FROM logs", limit: 50 });
    const wrapped = (a.readonlyQuery as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(wrapped).toBe("SELECT * FROM (SELECT * FROM logs) LIMIT 50");
  });

  it("falls back to query() only when the adapter lacks readonlyQuery", async () => {
    const a = mockAdapter({ readonlyQuery: undefined });
    await handleQuerySql(a, { sql: "SELECT * FROM logs" });
    expect(a.query).toHaveBeenCalledOnce();
  });

  it("rejects writes / semicolons / disallowed tables before touching the adapter", async () => {
    const a = mockAdapter();
    expect((await handleQuerySql(a, { sql: "DELETE FROM logs" })).content[0].text).toMatch(/only SELECT/);
    expect((await handleQuerySql(a, { sql: "SELECT 1; DROP TABLE logs" })).content[0].text).toMatch(/semicolon/);
    expect((await handleQuerySql(a, { sql: "SELECT * FROM sqlite_master" })).content[0].text).toMatch(/disallowed table/);
    expect(a.readonlyQuery).not.toHaveBeenCalled();
  });
});
