import { createHmac, timingSafeEqual } from "crypto";

export type WebhookProvider = "vercel" | "github" | "render" | string;

/**
 * Constant-time string equality that handles inputs of differing lengths.
 *
 * timingSafeEqual() requires same-length buffers and throws otherwise, which
 * means a naive `expected.length !== actual.length` guard leaks the correct
 * signature length in O(1) requests. Instead we hash both strings with a
 * stable zero key so both outputs are always 32 bytes, and compare those.
 *
 * Security note: the zero key provides no secrecy — its only purpose is
 * length normalisation. The actual secret material is already baked into
 * `expected` via HMAC before this function is called.
 */
const _zeroKey = Buffer.alloc(32);
function safeEqual(a: string, b: string): boolean {
  const ha = createHmac("sha256", _zeroKey).update(a).digest();
  const hb = createHmac("sha256", _zeroKey).update(b).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Verifies the webhook signature for a known provider.
 * Returns true when:
 *   - the provider is unknown (no secret configured → skip check)
 *   - the signature is valid
 * Returns false when the secret is configured but the signature is wrong.
 */
export function verifyWebhookSignature(
  provider: WebhookProvider,
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
  secrets: Record<string, string | undefined>
): boolean {
  const getHeader = (name: string): string => {
    const v = headers[name];
    return Array.isArray(v) ? v[0] : v ?? "";
  };

  if (provider === "vercel") {
    const secret = secrets["WEBHOOK_SECRET_VERCEL"];
    if (!secret) return true;
    const expected = createHmac("sha1", secret).update(rawBody).digest("hex");
    const actual = getHeader("x-vercel-signature");
    if (!actual) return false;
    return safeEqual(expected, actual);
  }

  if (provider === "github") {
    const secret = secrets["WEBHOOK_SECRET_GITHUB"];
    if (!secret) return true;
    const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
    const actual = getHeader("x-hub-signature-256");
    if (!actual || !actual.startsWith("sha256=")) return false;
    // Validate that the hex portion is exactly 64 lowercase hex characters
    // (a SHA-256 digest). Non-hex junk after the prefix is rejected here
    // rather than reaching timingSafeEqual with an unexpected format.
    const hexPart = actual.slice(7);
    if (!/^[0-9a-f]{64}$/.test(hexPart)) return false;
    return safeEqual(expected, hexPart);
  }

  if (provider === "render") {
    const secret = secrets["WEBHOOK_SECRET_RENDER"];
    if (!secret) return true;
    // Render format: "t=<timestamp>,v1=<hex>"
    const actual = getHeader("render-signature");
    const tsMatch = actual.match(/t=(\d+)/);
    const sigMatch = actual.match(/v1=([0-9a-f]+)/);
    if (!tsMatch || !sigMatch) return false;
    const timestamp = parseInt(tsMatch[1], 10);
    const now = Math.floor(Date.now() / 1000);
    // Use Math.abs so both far-past AND far-future timestamps are rejected.
    // Without abs, a timestamp in the far future yields a negative difference
    // which is not > 300 and incorrectly passes the replay window check.
    if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > 300) return false;
    const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
    return safeEqual(expected, sigMatch[1]);
  }

  // Unknown provider — reject rather than pass through unsigned data.
  return false;
}
