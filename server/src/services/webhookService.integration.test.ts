import { describe, it, expect, vi } from "vitest";
import { createHmac } from "node:crypto";

vi.mock("../config.js", () => ({
  config: { WEBHOOK_RETRY_BASE_MS: 1000 },
}));

import {
  signWebhookPayload,
  webhookSignatureHeader,
  webhookRetryDelayMs,
  WEBHOOK_EVENT_CHARGED,
} from "./webhookService.js";

describe("provider webhooks: signed charged-call events", () => {
  it("signs timestamp.body with HMAC-SHA256 so providers can verify delivery", () => {
    const secret = "whsec_test";
    const body = JSON.stringify({ type: WEBHOOK_EVENT_CHARGED, id: "evt_1" });
    const expected = createHmac("sha256", secret).update(`1700000000.${body}`).digest("hex");

    expect(signWebhookPayload(secret, 1700000000, body)).toBe(expected);
    expect(webhookSignatureHeader(secret, 1700000000, body)).toBe(`t=1700000000,v1=${expected}`);
  });

  it("changes the signature when the body is tampered with", () => {
    const a = signWebhookPayload("s", 1, '{"amount":"1"}');
    const b = signWebhookPayload("s", 1, '{"amount":"100"}');
    expect(a).not.toBe(b);
  });

  it("backs off exponentially between failed delivery attempts", () => {
    expect(webhookRetryDelayMs(1)).toBe(1000);
    expect(webhookRetryDelayMs(2)).toBe(4000);
    expect(webhookRetryDelayMs(3)).toBe(16000);
  });
});
