import { describe, expect, it, vi } from "vitest";

vi.mock("../config.js", () => ({
  config: {
    WEBHOOK_RETRY_BASE_MS: 1_000,
    WEBHOOK_TIMEOUT_MS: 5_000,
    UPSTREAM_SECRET_KEY: "x",
    PROXY_ALLOW_PRIVATE_UPSTREAMS: false,
  },
  upstreamKeyRing: [{ id: "k1", key: Buffer.alloc(32, 1) }],
}));

import {
  chargedCallWebhookEntry,
  signWebhookPayload,
  webhookRetryDelayMs,
  webhookSignatureHeader,
} from "./webhookService.js";

const call = {
  callId: "call-1",
  payerAddress: "GPAYER",
  amount: "0.01",
  method: "GET",
  path: "/weather",
  responseStatus: 200,
  durationMs: 12,
};

const api = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 7,
    webhookUrl: "https://provider.example/hooks",
    webhookSecretEnc: "enc",
    ...overrides,
  }) as never;

describe("charged-call webhook outbox entry", () => {
  it("is undefined when the API has no webhook configured", () => {
    expect(chargedCallWebhookEntry(api({ webhookUrl: null }), call)).toBeUndefined();
    expect(chargedCallWebhookEntry(api({ webhookSecretEnc: null }), call)).toBeUndefined();
  });

  it("carries a stable event id and the event body for the outbox", () => {
    const now = new Date("2026-01-02T03:04:05.000Z");
    const entry = chargedCallWebhookEntry(api(), call, now);
    expect(entry).toMatchObject({
      eventId: "evt_call-1",
      apiId: 7,
      url: "https://provider.example/hooks",
      secretEnc: "enc",
    });
    expect(JSON.parse(entry!.body)).toEqual({
      id: "evt_call-1",
      type: "api.call.charged",
      createdAt: "2026-01-02T03:04:05.000Z",
      data: { apiId: 7, currency: "USDC", ...call },
    });
  });

  it("signs the body as t=<unix>,v1=HMAC-SHA256(secret, `${t}.${body}`)", () => {
    const header = webhookSignatureHeader("s3cret", 1700000000, '{"a":1}');
    expect(header).toBe(`t=1700000000,v1=${signWebhookPayload("s3cret", 1700000000, '{"a":1}')}`);
    expect(header).toMatch(/^t=1700000000,v1=[0-9a-f]{64}$/);
  });

  it("backs off exponentially between attempts", () => {
    expect([1, 2, 3].map(webhookRetryDelayMs)).toEqual([1_000, 4_000, 16_000]);
  });
});
