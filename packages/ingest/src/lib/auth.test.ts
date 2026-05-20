import { describe, it, expect } from "vitest";
import { safeCompare } from "./auth.js";

describe("safeCompare", () => {
  it("returns true for equal strings", () => {
    expect(safeCompare("secret-token", "secret-token")).toBe(true);
  });

  it("returns false for different strings", () => {
    expect(safeCompare("secret-token", "wrong-token")).toBe(false);
  });

  it("returns true for empty vs empty", () => {
    expect(safeCompare("", "")).toBe(true);
  });

  it("returns false for empty vs non-empty", () => {
    expect(safeCompare("", "abc")).toBe(false);
    expect(safeCompare("abc", "")).toBe(false);
  });

  it("returns false for prefix match", () => {
    expect(safeCompare("abc", "abcd")).toBe(false);
  });

  it("handles long strings", () => {
    const long = "x".repeat(1000);
    expect(safeCompare(long, long)).toBe(true);
    expect(safeCompare(long, long.slice(0, -1) + "y")).toBe(false);
  });
});
