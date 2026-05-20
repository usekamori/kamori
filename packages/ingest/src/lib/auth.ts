import { timingSafeEqual, createHash } from "crypto";

/**
 * Timing-safe string comparison.
 * Both inputs are hashed first to guarantee equal-length buffers,
 * preventing length-based timing leaks.
 */
export function safeCompare(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}
