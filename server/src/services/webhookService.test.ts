import { describe, expect, it, vi } from "vitest";

vi.mock("../config.js", () => ({
  config: {
    WEBHOOK_RETRY_BASE_MS: 1000,
    WEBHOOK_TIMEOUT_MS: 5000,
    PROXY_ALLOW_PRIVATE_UPSTREAMS: false,
  },
  upstreamKeyRing: [],
}));

import {
  signWebhookPayload,
  verifyWebhookSignature,
  webhookSignatureHeader,
  WEBHOOK_TOLERANCE_SECONDS,
} from "./webhookService.js";

// Sample event as the test suite sends it (see deliverChargedCallWebhook).
const SECRET = "whsec_test_value";
const BODY = JSON.stringify({ id: "evt_1", type: "api.call.charged", data: { apiId: 1 } });
const T = 1_700_000_000;

describe("verifyWebhookSignature", () => {
  it("accepts a header produced by the sender", () => {
    const header = webhookSignatureHeader(SECRET, T, BODY);
    expect(verifyWebhookSignature(SECRET, header, BODY, T + 10)).toEqual({ ok: true });
  });

  it("matches a known HMAC-SHA256 value over `${t}.${body}`", () => {
    expect(signWebhookPayload(SECRET, T, BODY)).toBe(
      webhookSignatureHeader(SECRET, T, BODY).split("v1=")[1],
    );
  });

  it("rejects a tampered body", () => {
    const header = webhookSignatureHeader(SECRET, T, BODY);
    expect(verifyWebhookSignature(SECRET, header, BODY.replace("evt_1", "evt_2"), T)).toEqual({
      ok: false,
      reason: "mismatch",
    });
  });

  it("rejects the wrong secret", () => {
    const header = webhookSignatureHeader("other", T, BODY);
    expect(verifyWebhookSignature(SECRET, header, BODY, T)).toEqual({
      ok: false,
      reason: "mismatch",
    });
  });

  it("rejects timestamps outside the 5-minute window in either direction", () => {
    const header = webhookSignatureHeader(SECRET, T, BODY);
    const edge = T + WEBHOOK_TOLERANCE_SECONDS;
    expect(verifyWebhookSignature(SECRET, header, BODY, edge)).toEqual({ ok: true });
    expect(verifyWebhookSignature(SECRET, header, BODY, edge + 1)).toEqual({
      ok: false,
      reason: "stale",
    });
    expect(verifyWebhookSignature(SECRET, header, BODY, T - WEBHOOK_TOLERANCE_SECONDS - 1)).toEqual(
      {
        ok: false,
        reason: "stale",
      },
    );
  });

  it("accepts when any of several v1 values matches", () => {
    const good = webhookSignatureHeader(SECRET, T, BODY);
    const bad = webhookSignatureHeader("old", T, BODY);
    expect(verifyWebhookSignature(SECRET, `${bad},${good.split(",")[1]}`, BODY, T)).toEqual({
      ok: true,
    });
  });

  it("reports missing and malformed headers", () => {
    expect(verifyWebhookSignature(SECRET, undefined, BODY, T)).toEqual({
      ok: false,
      reason: "missing_header",
    });
    expect(verifyWebhookSignature(SECRET, "v1=abc", BODY, T)).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(verifyWebhookSignature(SECRET, "t=abc,v1=zz", BODY, T)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });
});
