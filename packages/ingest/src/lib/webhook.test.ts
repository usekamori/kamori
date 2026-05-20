import { describe, it, expect } from "vitest";
import { createHmac } from "crypto";
import { verifyWebhookSignature } from "./webhook.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sign(algo: "sha1" | "sha256", secret: string, body: Buffer): string {
  return createHmac(algo, secret).update(body).digest("hex");
}

const body = Buffer.from(JSON.stringify({ event: "test" }));
const secret = "super-secret";

// ---------------------------------------------------------------------------
// Unknown / generic provider
// ---------------------------------------------------------------------------

describe("verifyWebhookSignature — unknown provider", () => {
  it("returns false for an unknown provider", () => {
    expect(verifyWebhookSignature("stripe", body, {}, {})).toBe(false);
  });

  it("returns false regardless of headers for unknown provider", () => {
    expect(
      verifyWebhookSignature("stripe", body, { "x-random-sig": "bad" }, {})
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Vercel — HMAC-SHA1, header: x-vercel-signature
// ---------------------------------------------------------------------------

describe("verifyWebhookSignature — vercel", () => {
  it("returns true when no secret is configured", () => {
    expect(verifyWebhookSignature("vercel", body, {}, {})).toBe(true);
  });

  it("returns true for a valid SHA-1 signature", () => {
    const sig = sign("sha1", secret, body);
    expect(
      verifyWebhookSignature(
        "vercel",
        body,
        { "x-vercel-signature": sig },
        { WEBHOOK_SECRET_VERCEL: secret }
      )
    ).toBe(true);
  });

  it("returns false for a wrong signature", () => {
    expect(
      verifyWebhookSignature(
        "vercel",
        body,
        { "x-vercel-signature": "deadbeef" },
        { WEBHOOK_SECRET_VERCEL: secret }
      )
    ).toBe(false);
  });

  it("returns false when the signature header is missing", () => {
    expect(
      verifyWebhookSignature("vercel", body, {}, { WEBHOOK_SECRET_VERCEL: secret })
    ).toBe(false);
  });

  it("returns false when the body has been tampered", () => {
    const sig = sign("sha1", secret, body);
    const tampered = Buffer.from(JSON.stringify({ event: "tampered" }));
    expect(
      verifyWebhookSignature(
        "vercel",
        tampered,
        { "x-vercel-signature": sig },
        { WEBHOOK_SECRET_VERCEL: secret }
      )
    ).toBe(false);
  });

  it("accepts the header as an array (Fastify multi-value header)", () => {
    const sig = sign("sha1", secret, body);
    expect(
      verifyWebhookSignature(
        "vercel",
        body,
        { "x-vercel-signature": [sig, "ignored"] },
        { WEBHOOK_SECRET_VERCEL: secret }
      )
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GitHub — HMAC-SHA256, header: x-hub-signature-256 (format: sha256=<hex>)
// ---------------------------------------------------------------------------

describe("verifyWebhookSignature — github", () => {
  it("returns true when no secret is configured", () => {
    expect(verifyWebhookSignature("github", body, {}, {})).toBe(true);
  });

  it("returns true for a valid SHA-256 signature", () => {
    const sig = "sha256=" + sign("sha256", secret, body);
    expect(
      verifyWebhookSignature(
        "github",
        body,
        { "x-hub-signature-256": sig },
        { WEBHOOK_SECRET_GITHUB: secret }
      )
    ).toBe(true);
  });

  it("returns false for a wrong signature", () => {
    expect(
      verifyWebhookSignature(
        "github",
        body,
        { "x-hub-signature-256": "sha256=deadbeef00000000000000000000000000000000000000000000000000000000" },
        { WEBHOOK_SECRET_GITHUB: secret }
      )
    ).toBe(false);
  });

  it("returns false when the signature header is missing", () => {
    expect(
      verifyWebhookSignature("github", body, {}, { WEBHOOK_SECRET_GITHUB: secret })
    ).toBe(false);
  });

  it("returns false when the sha256= prefix is missing", () => {
    const sig = sign("sha256", secret, body); // no prefix
    expect(
      verifyWebhookSignature(
        "github",
        body,
        { "x-hub-signature-256": sig },
        { WEBHOOK_SECRET_GITHUB: secret }
      )
    ).toBe(false);
  });

  it("returns false when the body has been tampered", () => {
    const sig = "sha256=" + sign("sha256", secret, body);
    const tampered = Buffer.from(JSON.stringify({ event: "tampered" }));
    expect(
      verifyWebhookSignature(
        "github",
        tampered,
        { "x-hub-signature-256": sig },
        { WEBHOOK_SECRET_GITHUB: secret }
      )
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Render — HMAC-SHA256, header: render-signature (format: t=<ts>,v1=<hex>)
// ---------------------------------------------------------------------------

describe("verifyWebhookSignature — render", () => {
  it("returns true when no secret is configured", () => {
    expect(verifyWebhookSignature("render", body, {}, {})).toBe(true);
  });

  it("returns true for a valid v1 signature", () => {
    const hex = sign("sha256", secret, body);
    const sig = `t=${Math.floor(Date.now() / 1000)},v1=${hex}`;
    expect(
      verifyWebhookSignature(
        "render",
        body,
        { "render-signature": sig },
        { WEBHOOK_SECRET_RENDER: secret }
      )
    ).toBe(true);
  });

  it("returns false for a wrong v1 value", () => {
    const hex = "a".repeat(64); // wrong but right length
    const sig = `t=1712000000,v1=${hex}`;
    expect(
      verifyWebhookSignature(
        "render",
        body,
        { "render-signature": sig },
        { WEBHOOK_SECRET_RENDER: secret }
      )
    ).toBe(false);
  });

  it("returns false when the render-signature header is missing", () => {
    expect(
      verifyWebhookSignature("render", body, {}, { WEBHOOK_SECRET_RENDER: secret })
    ).toBe(false);
  });

  it("returns false when v1= part is absent from the header", () => {
    const sig = "t=1712000000,v0=something";
    expect(
      verifyWebhookSignature(
        "render",
        body,
        { "render-signature": sig },
        { WEBHOOK_SECRET_RENDER: secret }
      )
    ).toBe(false);
  });

  it("returns false when the body has been tampered", () => {
    const hex = sign("sha256", secret, body);
    const sig = `t=1712000000,v1=${hex}`;
    const tampered = Buffer.from(JSON.stringify({ event: "tampered" }));
    expect(
      verifyWebhookSignature(
        "render",
        tampered,
        { "render-signature": sig },
        { WEBHOOK_SECRET_RENDER: secret }
      )
    ).toBe(false);
  });
});
